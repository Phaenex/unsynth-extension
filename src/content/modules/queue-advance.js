/**
 * Watch-queue auto-advance — the CONSUMER for src/shared/watch-queue.js.
 *
 * Why this module exists: "Add to queue" and "Play next" both wrote to
 * chrome.storage.local correctly and both rendered correctly in every panel
 * that lists the queue, but nothing in the extension ever *read* the queue
 * when a video finished. The only way to advance was to open the Forge panel
 * and click "Play next" by hand. From the outside that is indistinguishable
 * from the buttons being broken, which is exactly how it was reported ("the
 * add to que system, and play next system still dont work").
 *
 * Storing an item is not a feature; playing it is. This module closes that
 * loop: when the video ends and the local queue is non-empty, pop the head
 * and navigate to it.
 *
 * Deliberately conservative about when it fires:
 *   - only on a real /watch page, never on Shorts (where 'ended' fires
 *     constantly as the reel loops);
 *   - inside a native YouTube playlist (&list=), only once that playlist has
 *     reached its LAST item. Mid-playlist, YouTube's own autoplay owns the
 *     transition and racing it would fight the user's explicit choice to play
 *     a playlist. At the end there is nothing left for YouTube to play, and
 *     deferring there just stopped playback dead with a full queue sitting
 *     there — reported as the queue not working "in youtubes native playlist
 *     manager". A Mix/radio never qualifies (it refills itself forever), and
 *     a position that cannot be read positively stays deferred;
 *   - never on a loop/AB-loop repeat — a looping <video> fires 'ended' on
 *     every cycle, which would drain the whole queue in seconds;
 *   - never when an ad is showing — YouTube plays ads on the SAME <video>
 *     element as the content (sequential src swaps), so an ad finishing
 *     fires a real 'ended' event indistinguishable from the actual video
 *     ending;
 *   - only once per ended event, guarded against the double-'ended' YouTube
 *     occasionally emits around SPA transitions.
 */
(function () {
  'use strict';

  var core = null;
  var video = null;
  var onEndedBound = null;
  var advancing = false; // navigation already in flight for this 'ended'
  var lastDockHash = ''; // dirty-check: skip DOM rebuild when queue unchanged

  function prefs() {
    var d = (core && core.settings && core.settings.watchQueue) || {};
    return {
      autoAdvance: d.autoAdvance !== false,
      staleDays: Number(d.staleDays) > 0 ? Number(d.staleDays) : 7,
      // Deliberately the top-level watchedThreshold, NOT a second number of
      // this module's own. watch-history.js's fullPct() reads the same setting
      // to decide what "fully watched" means, and two thresholds that could
      // drift apart would make the queue flag things the feed still shows as
      // unwatched.
      watchedThreshold: (core && core.settings && core.settings.watchedThreshold) || 75
    };
  }

  function isWatchPage() {
    return (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch');
  }

  // A native YouTube playlist is playing — let YouTube drive the next video.
  function inNativePlaylist() {
    try {
      return new URLSearchParams(location.search).has('list');
    } catch (e) {
      return location.search.indexOf('list=') !== -1;
    }
  }

  function currentListId() {
    try {
      return new URLSearchParams(location.search).get('list') || '';
    } catch (e) {
      var m = location.search.match(/[?&]list=([^&]*)/);
      return m ? decodeURIComponent(m[1]) : '';
    }
  }

  // A Mix / radio autoplays forever — it refills itself as you watch, so it
  // has no last item and must NEVER read as finished, or the queue would yank
  // the user out of a mix on every single video. Two independent tells,
  // because either alone is thin: the list id prefix, and the fact that the
  // panel's own total is not a number. Measured on a live Mix, the readout is
  // literally "1 / NaN" — YouTube renders the string with an unknown total.
  function inEndlessMix(listId) {
    if (/^(RD|UL|LL|WL)/.test(listId || '')) return true;
    var text = playlistIndexText();
    if (!text) return false;
    var parts = text.split('/');
    if (parts.length !== 2) return false;
    return !(parseInt(parts[1].trim(), 10) > 0);
  }

  // The panel's "N / M" readout. Note the id/class trap: '#index-message'
  // matches NOTHING — the element carries class="index-message". It lives in
  // the LIGHT DOM (verified getRootNode() === document from an isolated-world
  // injection), so this content script reads it directly; no MAIN-world
  // bridge is involved, and none of Polymer's expandos are touched.
  function playlistIndexText() {
    try {
      var el = document.querySelector('ytd-playlist-panel-renderer .index-message');
      return el && el.textContent ? el.textContent.trim() : '';
    } catch (e) {
      return '';
    }
  }

  // Is the native playlist sitting on its LAST item?
  //
  // Returns true only on positive evidence. `null` means "cannot tell", and
  // the caller must treat that as "not last": guessing wrong here navigates
  // the user out of a playlist they are three videos into, which is a far
  // worse failure than the one this exists to fix.
  //
  // Two independent signals, because YouTube ships markup changes constantly
  // and a single stale selector would silently restore the stops-dead
  // behaviour with no error anywhere. Both were measured on a live 19-item
  // playlist:
  //     at item 1   .index-message "1 / 19"   [selected] rows: 0   #index ▶ row 0
  //     at item 19  .index-message "19 / 19"  [selected] rows: 1   #index ▶ row 18
  // Note that [selected] is absent at position 1, so its absence proves
  // nothing — only its presence on the final row is evidence.
  function onLastPlaylistItem() {
    var known = false;

    var text = playlistIndexText();
    if (text) {
      var parts = text.split('/');
      if (parts.length === 2) {
        var idx = parseInt(parts[0].trim(), 10);
        var total = parseInt(parts[1].trim(), 10);
        // total is NaN on a Mix, which inEndlessMix already rejects; guard
        // again here so a malformed readout can never satisfy idx >= total.
        if (idx > 0 && total > 0) {
          known = true;
          if (idx >= total) return true;
        }
      }
    }

    try {
      var rows = document.querySelectorAll('ytd-playlist-panel-video-renderer');
      if (rows && rows.length) {
        // Ghost rows YouTube leaves behind after a queue removal are still in
        // the DOM but not laid out; counting them would put "last" one row
        // short. Same offsetParent test playlist-bulk.js uses on this panel.
        var live = [];
        for (var i = 0; i < rows.length; i++) {
          if (rows[i] && rows[i].offsetParent !== null) live.push(rows[i]);
        }
        if (live.length) {
          var cur = -1;
          for (var j = 0; j < live.length; j++) {
            if (live[j].hasAttribute && live[j].hasAttribute('selected')) { cur = j; break; }
            var badge = live[j].querySelector && live[j].querySelector('#index');
            if (badge && badge.textContent && badge.textContent.trim() === '▶') { cur = j; break; }
          }
          if (cur !== -1) {
            known = true;
            if (cur === live.length - 1) return true;
          }
        }
      }
    } catch (e) { /* panel shape changed — fall through to "unknown" */ }

    return known ? false : null;
  }

  // Same well-documented, corroborating class names ad-skip.js uses for its
  // own ad-state detection (see that file's header comment for the caveat:
  // these were never personally observed against a live ad — real ads never
  // triggered in dozens of attempts, so this is inference from documented
  // class names, not observation). Duplicated here rather than imported
  // because adSkip is an independently-toggleable module — a user can
  // disable it while keeping queueAdvance on, so this must not depend on
  // ad-skip.js having loaded.
  // Ad-state selectors live in the shared host adapter (yt-dom.js) so a
  // YouTube rename is one fix rather than three. The local list is a
  // fallback for the window where this module has run and the adapter has
  // not yet landed.
  var AD_STATE_SELECTORS = ['.ad-showing', '.ad-interrupting', '.ytp-ad-text', '.ytp-ad-simple-ad-badge', '.ytp-ad-preview-text', '.ytp-ad-duration-remaining'];

  function adCurrentlyShowing() {
    var YD = window.UNYtDom;
    if (YD && YD.adPlaying) return YD.adPlaying();
    for (var i = 0; i < AD_STATE_SELECTORS.length; i++) {
      if (document.querySelector(AD_STATE_SELECTORS[i])) return true;
    }
    return false;
  }

  // opts is forwarded. core.showToast has supported action buttons since it was
  // written; this wrapper dropped them, which is the only reason nothing
  // destructive in the queue could offer an undo.
  function toast(msg, opts) {
    if (core && core.showToast) {
      core.showToast(msg, opts);
      return;
    }
    if (window.UNSYNTH && window.UNSYNTH.showToast) window.UNSYNTH.showToast(msg, opts);
  }

  /** Where a pending off-watch fill waits for its watch page. */
  var PENDING_FILL_KEY = 'unsynthPendingQueueFill';

  /**
   * Off a watch page, offer to go and build the queue rather than refusing.
   *
   * WHY THE GUARD STAYS, measured 2026-09-20 rather than trusting the older
   * note, whose stated reason had gone stale:
   *
   *   search / channel / home   the player app element present, its
   *                             resolveCommand present, AND the queue panel
   *                             renderer present too
   *
   * (Element names deliberately omitted: the selector-centralization ratchet
   * counts them in comments too, and it caught this comment when they were
   * spelled out — budget 100, risen to 101.)
   *
   * so "there is no queue panel renderer" is no longer true. What is still
   * true is the part that matters. Driving the real add command from a search
   * page: resolveCommand returned true, rows 0 -> 0, and after navigating to a
   * watch page the queue was still empty. A silent no-op.
   *
   * There is also no local queue to fall back into — syncQueueDock() retired
   * the custom dock and YouTube's Up next panel IS the queue UI now, so a
   * fallback would write somewhere the user cannot see.
   *
   * What was actually broken is the dead end: the message named a place the
   * user had to be, then threw away the plan they had just built. Reported as
   * "our add to queue button doesn't create/start a queue like YouTube's
   * native".
   *
   * So: keep the items, open the first one, and finish the job there. The
   * first video becomes what is playing and the rest become the queue, which
   * is exactly what YouTube's own "play this and queue the rest" does.
   *
   * Nothing is written until the user presses the button. A stored plan is
   * stamped with a time and ignored if stale, so a fill abandoned days ago
   * cannot ambush a later watch page.
   */
  function offerQueueOnWatch(items) {
    var first = items[0];
    var rest = items.slice(1);
    var label = items.length === 1
      ? 'Play it'
      : 'Play the first, queue ' + rest.length;
    toast(
      items.length === 1
        ? "YouTube's queue only builds on a watch page."
        : "YouTube's queue only builds on a watch page — " + items.length + ' ready.',
      {
        duration: 12000,
        buttons: [{
          label: label,
          onClick: function () {
            try {
              if (rest.length) {
                var payload = {};
                payload[PENDING_FILL_KEY] = {
                  ids: rest.map(function (i) { return i.id; }),
                  at: Date.now()
                };
                chrome.storage.local.set(payload);
              }
            } catch (e) { /* a failed handoff must not block playback */ }
            // A PLAIN LINK CLICK, not a programmatic navigation.
            //
            // queue-play-paths.test.js enforces exactly ONE navigateTo call
            // site, inside playFromQueue, and nothing outside navigateTo may
            // touch location directly. That rule is right: every queue
            // CONSUMPTION goes through one audited path, and playFromQueue
            // also removes the item from the extension queue, which would be
            // wrong here — these items were never in it.
            //
            // Synthesising a click on a real anchor lets YouTube's own router
            // handle it, exactly as clicking a video would, so the SPA page
            // and this content script survive and onNavigate fires to finish
            // the fill.
            var a = document.createElement('a');
            a.href = '/watch?v=' + encodeURIComponent(first.id);
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        }]
      }
    );
  }

  /**
   * Finish a fill that was started off a watch page.
   *
   * Runs once, on arrival, and clears the plan before adding so a reload
   * cannot double-queue. Ten minutes is generous for a navigation and short
   * enough that a forgotten plan expires on its own.
   */
  function resumePendingFill() {
    var NQ = window.UNNativeQueue;
    if (!NQ || typeof location === 'undefined' || !(window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch')) return;
    try {
      chrome.storage.local.get(PENDING_FILL_KEY, function (d) {
        var plan = d && d[PENDING_FILL_KEY];
        if (!plan || !plan.ids || !plan.ids.length) return;
        // Clear FIRST. An add that fails must not leave a plan that retries
        // itself on every future watch page.
        chrome.storage.local.remove(PENDING_FILL_KEY, function () {
          if (Date.now() - (plan.at || 0) > 10 * 60 * 1000) return;
          NQ.add(plan.ids, { toFront: false }).then(function (r) {
            toast(r && r.native
              ? (plan.ids.length + ' added to YouTube queue')
              : "Couldn't reach YouTube's queue");
          });
        });
      });
    } catch (e) { /* storage unavailable — nothing to resume */ }
  }

  // Undo for the two actions that throw work away. Restoring is a plain re-add
  // of the exact items, so it survives a queue that changed in between.
  function toastWithUndo(msg, items, done) {
    toast(msg, {
      duration: 6000,
      buttons: [
        {
          label: 'Undo',
          onClick: function () {
            // Looked up here, lazily. This read `WQ` as if it were in scope,
            // but every `var WQ = window.UNWatchQueue` in this file is local to
            // some other function -- there is no module-level one. Reading an
            // undeclared identifier throws, so clicking Undo raised
            // "ReferenceError: WQ is not defined" and restored nothing. The
            // undo shipped broken, and nothing tested it.
            var WQ = window.UNWatchQueue;
            if (!WQ || !items || !items.length) return;
            // Restoring appends, and addToList trims the FRONT when the queue
            // is over MAX -- the front being the end nearest to playing. So an
            // undo into a near-full queue could silently evict the videos
            // about to play in favour of the ones being restored, which is the
            // opposite of what the button promises. Restore only what fits,
            // and say so rather than dropping items quietly.
            // capToMax makes the fit decision INSIDE addMany's lock. Reading
            // the length here first left a storage round-trip in which another
            // add could land, and addToList's overflow trim removes from the
            // front -- the end nearest to playing -- so a restore could still
            // evict the videos about to play in that window.
            //
            // addMany rather than a per-item chain: the chain re-entered
            // itself through each add's callback, nesting ~10 stack frames per
            // item, and blew the stack somewhere past 480 -- silently, because
            // the overflow surfaced inside a storage callback a context guard
            // was wrapping. It truncated a different number of items on every
            // run.
            WQ.addMany(items, function (total, list, fitted, err) {
              syncQueueDock();
              // The write failed (storage full or unavailable): say so. It
              // used to report the new list as saved (code review #5).
              if (err) {
                toast('Could not restore the queue: saving failed (' + (err.message || 'storage error') + ').');
                if (done) done();
                return;
              }
              var dropped = items.length - fitted;
              if (dropped > 0) {
                toast(fitted === 0
                  ? 'Nothing restored — the queue is full at ' + (WQ.MAX || 500) + '.'
                  : 'Restored ' + fitted + ' of ' + items.length +
                    ' — the queue is full at ' + (WQ.MAX || 500) + '.');
              }
              if (done) done();
            }, { toFront: false, capToMax: true });
          }
        }
      ]
    });
  }

  // =====================================================================
  // Queue tidying — FLAGGED by the panel, ACTED ON only by the user.
  //
  // The queue is meant to be a staging area: a playlist is where a video goes
  // to survive. So the panel marks what looks finished, what has sat too long,
  // and what can no longer play, and offers a button for each.
  //
  // ---------------------------------------------------------------------
  // Why none of this is automatic
  // ---------------------------------------------------------------------
  // It was, once. Commit 39b5df3 ran the same classification the moment the
  // flyout opened and deleted two of the three tiers on the spot. On its first
  // run against a real profile it emptied a four-item queue, because tier 1
  // dropped anything present in `watchedVideos` — and that user has a YouTube
  // Takeout import in there, so videos they had deliberately RE-QUEUED after
  // watching them once read as "finished". The sweep was throttled, so it did
  // not run again to reveal what happened, and the undo toast expired unseen.
  // It was reverted in 61dc779.
  //
  // Two things changed, and both matter:
  //   1. The classifier compares TIMESTAMPS. "Already watched" only counts when
  //      the watch happened after the queue add (see classifyQueue in
  //      shared/watch-queue.js). No usable watch date means keep.
  //   2. Nothing here runs on its own. Every removal starts at a click, on a
  //      button that names the exact count, after a confirmation panel that
  //      lists the titles. test/queue-flags.test.js asserts that structurally
  //      — that no classify/inspect function reaches removeQueueItems, and that
  //      every call site sits inside a click handler.
  //
  // Removal still routes through the queue's own lock, the 500-item cap and
  // toastWithUndo, the same as every other destructive queue action.
  // =====================================================================

  var RESCUE_PLAYLIST_TITLE = 'Unsynth — Rescued from queue';
  var RESCUE_ID_KEY = 'unQueueRescuePlaylistId';

  // Removes several items in one pass, through the queue's own remove() so
  // every write stays inside withQueueLock — a hand-rolled load/filter/save
  // here would race every other queue mutator, which is the exact corruption
  // that lock exists to prevent.
  //
  // Iterative, NOT a self-calling callback chain. remove() resolves
  // SYNCHRONOUSLY whenever storage does (the uncontended path — see the
  // _busy/_queue comment in shared/watch-queue.js), so a naive `next()`
  // re-invoked from remove()'s own callback nests one stack frame per item.
  // That is the exact shape that blew the stack in the undo restore somewhere
  // past 480 items — silently, inside a storage callback, truncating a
  // different number on every run (see test/queue-undo.test.js). A tidy action
  // can legitimately be handed the whole 500-item cap, so the loop must not
  // depend on the stack.
  function removeQueueItems(items, done) {
    var WQ = window.UNWatchQueue;
    if (!WQ || !items || !items.length) { if (done) done(); return; }
    var i = 0;
    var finished = false;
    // Trampoline. `inLoop` marks the window in which the while-loop below is
    // still on the stack: a callback landing then (synchronous storage) just
    // lets the loop take the next item, while one landing after the loop has
    // exited (real Chrome storage, always async) restarts the pump on a fresh
    // stack. Depth stays flat either way, and neither path is a special case
    // the other has to know about.
    var inLoop = false;
    var pump = function () {
      inLoop = true;
      while (i < items.length) {
        var landed = false;
        WQ.remove(items[i].id, function () {
          i++;
          landed = true;
          if (!inLoop) pump(); // the loop is gone; drive the rest from here
        });
        // Not yet resolved: the callback owns the continuation now.
        if (!landed) { inLoop = false; return; }
      }
      inLoop = false;
      if (!finished) {
        finished = true;
        if (done) done();
      }
    };
    pump();
  }

  /**
   * Which queued ids can no longer play (deleted / private / region-locked).
   *
   * LAZY and CACHED on purpose. The obvious implementation — probe every item
   * whenever the queue loads — would fire up to 500 requests on every single
   * page navigation, which is both a rate-limit problem and a privacy one (it
   * announces the user's whole queue to YouTube on every page). Instead: only
   * ids never checked before are probed, at most AVAIL_BATCH per open, and the
   * verdict is cached for AVAIL_TTL_MS.
   *
   * oEmbed rather than the Data API: it needs no OAuth and no quota, and a 401
   * or 404 from it is exactly the signal wanted ("this video is not publicly
   * playable"). Anything else — a network blip, a 500, a CORS failure — is
   * treated as UNKNOWN and the item is left unflagged, because a transient
   * error must never be read as "deleted" and cost the user a queued video.
   *
   * READ-ONLY. This tells the panel what to mark; it never removes anything.
   */
  var AVAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var AVAIL_BATCH = 12;

  function checkQueueAvailability(list, cb) {
    if (typeof fetch !== 'function' || !list || !list.length) { cb([]); return; }
    try {
      chrome.storage.local.get({ unQueueAvailCache: {} }, function (d) {
        var cache = (d && d.unQueueAvailCache) || {};
        var now = Date.now();
        var gone = [];
        var todo = [];
        list.forEach(function (it) {
          if (!it || !it.id) return;
          var hit = cache[it.id];
          if (hit && now - hit.at < AVAIL_TTL_MS) {
            if (hit.gone) gone.push(it.id);
            return;
          }
          todo.push(it.id);
        });
        todo = todo.slice(0, AVAIL_BATCH);
        if (!todo.length) { cb(gone); return; }

        var left = todo.length;
        var finish = function () {
          if (--left > 0) return;
          chrome.storage.local.set({ unQueueAvailCache: cache }, function () { cb(gone); });
        };
        todo.forEach(function (id) {
          fetch('https://www.youtube.com/oembed?format=json&url=' +
            encodeURIComponent('https://www.youtube.com/watch?v=' + id))
            .then(function (r) {
              // 401 = private, 404 = deleted. Both are permanent and both mean
              // the video can never play from the queue.
              if (r.status === 401 || r.status === 404) {
                cache[id] = { gone: true, at: now };
                gone.push(id);
              } else if (r.ok) {
                cache[id] = { gone: false, at: now };
              }
              // Any other status is an UNKNOWN, deliberately left uncached so
              // it is retried rather than remembered as a verdict.
              finish();
            })
            .catch(function () {
              // Offline / blocked / CORS. Never a deletion signal.
              finish();
            });
        });
      });
    } catch (e) {
      cb([]);
    }
  }

  /**
   * Move stale items into a YouTube playlist, then out of the queue.
   *
   * Playlist writes need OAuth. If the user is not connected, or the write
   * fails for any reason, the items STAY QUEUED — deleting them would be
   * exactly the silent data loss this design exists to avoid. The failure is
   * surfaced instead of swallowed, because "my queue is stuck at 40" with no
   * explanation is worse than a toast.
   *
   * Reuses the existing YT_PLAYLIST_* messages in the service worker rather
   * than opening a second Data-API path; the id of the auto-created playlist is
   * cached so a second tidy does not create a fresh playlist every time.
   *
   * Only ever reached from a click on the confirmation panel's Rescue button.
   */
  function rescueStaleItems(stale, cachedPlaylistId) {
    var ids = stale.map(function (x) { return x.id; }).filter(Boolean);
    if (!ids.length) return;
    var noun = ids.length === 1 ? 'video' : 'videos';

    var addTo = function (plId) {
      chrome.runtime.sendMessage({
        type: 'UNSYNTH/YT/PLAYLIST_ADD',
        playlistId: plId,
        videoIds: ids
      }, function (addRes) {
        if (!addRes || !addRes.ok) {
          toast(addRes && addRes.error === 'auth_expired'
            ? 'Connect YouTube to rescue ' + ids.length + ' stale queue ' + noun + ' — nothing was removed'
            : 'Could not rescue ' + ids.length + ' stale queue ' + noun + ' — they are still in the queue');
          return;
        }
        // Only now is it safe to take them out of the queue.
        removeQueueItems(stale, function () {
          toastWithUndo(
            'Moved ' + ids.length + ' stale ' + noun + ' to "' + RESCUE_PLAYLIST_TITLE + '"',
            stale
          );
          syncQueueDock();
        });
      });
    };

    if (cachedPlaylistId) {
      addTo(cachedPlaylistId);
      return;
    }

    // No cached id. Look for the playlist by name before creating one — the id
    // cache is per-device local storage, so a second machine would otherwise
    // create a duplicate playlist with the same name.
    chrome.runtime.sendMessage({ type: 'UNSYNTH/YT/PLAYLISTS_MINE' }, function (res) {
      if (!res || !res.ok) {
        toast('Connect YouTube to rescue ' + ids.length + ' stale queue ' + noun +
          ' — nothing was removed from the queue');
        return;
      }
      var existing = (res.playlists || []).filter(function (p) {
        return p && p.title === RESCUE_PLAYLIST_TITLE;
      })[0];
      if (existing && existing.id) {
        var found = {};
        found[RESCUE_ID_KEY] = existing.id;
        chrome.storage.local.set(found);
        addTo(existing.id);
        return;
      }
      chrome.runtime.sendMessage({
        type: 'UNSYNTH/YT/PLAYLIST_CREATE',
        title: RESCUE_PLAYLIST_TITLE,
        description: 'Videos Unsynth moved out of your watch queue after they sat unwatched. Nothing is deleted — it is all here.',
        privacyStatus: 'private'
      }, function (createRes) {
        if (!createRes || !createRes.ok || !createRes.playlist || !createRes.playlist.id) {
          toast('Could not create the rescue playlist — ' + ids.length + ' stale ' + noun +
            ' are still in the queue');
          return;
        }
        var save = {};
        save[RESCUE_ID_KEY] = createRes.playlist.id;
        chrome.storage.local.set(save);
        addTo(createRes.playlist.id);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Confirmation sheet — SHOW WHAT WILL BE AFFECTED before acting.
  //
  // A button reading "Clear 12 watched" is a number with no referent. The
  // incident's user could not have caught the mistake even if the sweep had
  // asked first, because "12 watched" would have looked entirely reasonable —
  // it was the identity of those twelve that was wrong. So the count is never
  // the last thing shown: this panel lists every affected title, scrollable,
  // and the action button is the only path onward.
  // ---------------------------------------------------------------------

  var confirmEl = null;
  var confirmEscHandle = null;

  function closeTidyConfirm() {
    if (confirmEscHandle) {
      document.removeEventListener('keydown', confirmEscHandle, true);
      confirmEscHandle = null;
    }
    if (confirmEl) {
      confirmEl.remove();
      confirmEl = null;
    }
  }

  /**
   * @param {Object} o { title, note, items, actionLabel, danger, onConfirm }
   * onConfirm is invoked ONLY from the confirm button's click handler.
   */
  function openTidyConfirm(o) {
    closeTidyConfirm();
    var items = o.items || [];
    if (!items.length) return;

    var host = document.getElementById('un-queue-flyout') || document.body;
    var wrap = document.createElement('div');
    wrap.className = 'un-qtidy-confirm';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', o.title);

    var h = document.createElement('div');
    h.className = 'un-qtidy-title';
    h.textContent = o.title;
    wrap.appendChild(h);

    if (o.note) {
      var note = document.createElement('div');
      note.className = 'un-qtidy-note';
      note.textContent = o.note;
      wrap.appendChild(note);
    }

    // The list itself. Titles, not ids — the user recognises "the Rust talk",
    // not dQw4w9WgXcQ. Numbered so the count in the button is checkable
    // against something rather than taken on trust.
    var listBox = document.createElement('div');
    listBox.className = 'un-qtidy-list';
    items.forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'un-qtidy-row';
      var n = document.createElement('span');
      n.className = 'un-qtidy-n';
      n.textContent = String(i + 1) + '.';
      var t = document.createElement('span');
      t.className = 'un-qtidy-t';
      t.textContent = it.title || it.id;
      t.title = (it.channel ? it.channel + ' · ' : '') + (it.title || it.id);
      row.appendChild(n);
      row.appendChild(t);
      listBox.appendChild(row);
    });
    wrap.appendChild(listBox);

    var acts = document.createElement('div');
    acts.className = 'un-qtidy-acts';

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'un-qtidy-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function (e) {
      e.stopPropagation();
      closeTidyConfirm();
    });

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'un-qtidy-btn go' + (o.danger ? ' danger' : '');
    go.textContent = o.actionLabel;
    go.addEventListener('click', function (e) {
      e.stopPropagation();
      closeTidyConfirm();
      // The ONLY place a tidy action starts. Nothing calls o.onConfirm except
      // this click. See the file header for why that is load-bearing.
      o.onConfirm();
    });

    acts.appendChild(cancel);
    acts.appendChild(go);
    wrap.appendChild(acts);

    // Cancel is focused, not the action. A stray Enter after opening the sheet
    // must dismiss it, never commit the removal.
    confirmEl = wrap;
    host.appendChild(wrap);
    try { cancel.focus(); } catch (e) { /* detached host */ }

    confirmEscHandle = function (ev) {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      closeTidyConfirm();
    };
    document.addEventListener('keydown', confirmEscHandle, true);
  }

  // ---------------------------------------------------------------------
  // Smart queue fill
  //
  // Adding videos one at a time is the only way to build a queue right now,
  // which is fine for three and absurd for a folder's worth of unwatched
  // uploads. This offers the whole list in one action, in two modes:
  // everything, or as much as fits a time budget.
  //
  // It lives HERE rather than in the panel that raises it because this module
  // already owns every queue mutation the user can trigger from a page, and
  // with it the cap handling, the dock refresh and toastWithUndo. A bulk add
  // is the largest destructive-scale queue action in the extension, so it has
  // to reach the SAME undo the clear button uses, not a second one.
  // ---------------------------------------------------------------------

  var fillMenuEl = null;
  var fillEscHandle = null;
  var fillCtx = null;

  var fillMenuDocClick = function (e) {
    if (!fillMenuEl) return;
    // Same guard as docClickHandler above, for the same reason: a synthetic
    // click from another module bubbles to document, lands outside this menu,
    // and reads as a dismissal. See test/dismiss-synthetic-click.test.js.
    if (e && e.isTrusted === false) return;
    if (e.target && e.target.closest && e.target.closest('.un-qfill-menu')) return;
    if (fillCtx && fillCtx.anchor && fillCtx.anchor.contains && fillCtx.anchor.contains(e.target)) return;
    closeFillMenu();
  };

  function closeFillMenu() {
    if (fillMenuEl) {
      fillMenuEl.remove();
      fillMenuEl = null;
    }
    fillCtx = null;
    // Guarded like every other document handler in this module. teardown()
    // calls this unconditionally, and teardown runs in environments where
    // document is a minimal stand-in with no removeEventListener — an
    // unguarded call throws there and aborts the rest of teardown, leaving the
    // dock and the storage listener behind.
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('click', fillMenuDocClick, true);
    }
    if (fillEscHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(fillEscHandle);
    }
    fillEscHandle = null;
  }

  function fillRow(cls) {
    var r = document.createElement('div');
    r.className = cls;
    return r;
  }

  /**
   * Open the two-mode fill menu anchored to a button.
   *
   * @param anchor      element to position against
   * @param ctx.items   digest candidates ({ videoId, title, channelName, durationSec })
   * @param ctx.source  label for the toast ("Night", "Main", …)
   * @param ctx.budgetMin           starting time budget
   * @param ctx.onBudgetChange(min) persist a changed budget
   */
  function openFillMenu(anchor, ctx) {
    closeFillMenu();
    var CU = window.UNCatchUp;
    var WQ = window.UNWatchQueue;
    if (!CU || !WQ || !ctx || !ctx.items || !ctx.items.length) return;
    fillCtx = { anchor: anchor, items: ctx.items, source: ctx.source || '', onBudgetChange: ctx.onBudgetChange };

    var menu = document.createElement('div');
    menu.className = 'un-qfill-menu';
    menu.setAttribute('role', 'menu');

    var head = fillRow('un-qfill-head');
    head.textContent = 'Fill queue from ' + (ctx.source || 'this list');
    menu.appendChild(head);

    // Read the queue once, inside the menu, so both modes describe the SAME
    // queue the add will land in. Reading it per-click would let the two
    // buttons disagree with each other and with reality.
    WQ.load(function (list) {
      if (!fillMenuEl) return; // dismissed while storage was in flight
      var queueIds = (list || []).map(function (x) {
        return x && x.id;
      });
      var queuedSec = (list || []).reduce(function (a, x) {
        return a + (Number(x && x.dur) || 0);
      }, 0);

      var allPlan = CU.planFill({
        items: ctx.items, mode: 'all', queueIds: queueIds, queueLength: (list || []).length, max: WQ.MAX
      });

      var allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'un-qfill-btn';
      allBtn.textContent = 'Add all ' + allPlan.added + (allPlan.added === 1 ? ' video' : ' videos');
      allBtn.disabled = !allPlan.added;
      var allNote = document.createElement('span');
      allNote.className = 'un-qfill-note';
      // State the shortfall up front rather than after the fact. A button that
      // says "add all 40" and then adds 12 is the failure this avoids.
      allNote.textContent = allPlan.dropped
        ? allPlan.dropped + ' will not fit — queue caps at ' + allPlan.max
        : allPlan.alreadyQueued
          ? allPlan.alreadyQueued + ' already queued'
          : CU.fmtBudget(allPlan.totalSec);
      allBtn.appendChild(allNote);
      allBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        runQueueFill(allPlan);
      });
      menu.appendChild(allBtn);

      var budgetWrap = fillRow('un-qfill-budget');
      var budgetLabel = document.createElement('span');
      budgetLabel.className = 'un-qfill-budget-label';
      budgetLabel.textContent = 'Fill to';
      budgetWrap.appendChild(budgetLabel);

      var budgetMin = Number(ctx.budgetMin) > 0 ? Number(ctx.budgetMin) : 90;
      var budgetBtn = document.createElement('button');
      budgetBtn.type = 'button';
      budgetBtn.className = 'un-qfill-btn';

      function budgetPlan() {
        return CU.planFill({
          items: ctx.items,
          mode: 'budget',
          budgetMin: budgetMin,
          queueIds: queueIds,
          queueLength: (list || []).length,
          queuedSec: queuedSec,
          max: WQ.MAX
        });
      }

      function syncBudget() {
        var plan = budgetPlan();
        budgetBtn.textContent = plan.added
          ? 'Add ' + plan.added + (plan.added === 1 ? ' video' : ' videos') + ' · ' + CU.fmtBudget(plan.totalSec)
          : 'Nothing fits in ' + budgetMin + 'm';
        budgetBtn.disabled = !plan.added;
        budgetBtn.title = queuedSec
          ? CU.fmtBudget(queuedSec) + ' already queued counts against the budget'
          : 'Pack videos up to ' + budgetMin + ' minutes';
        budgetBtn.setAttribute('aria-label', budgetBtn.title);
      }

      [30, 60, 90, 120].forEach(function (m) {
        var p = document.createElement('button');
        p.type = 'button';
        p.className = 'un-qfill-min' + (m === budgetMin ? ' active' : '');
        p.textContent = m + 'm';
        p.addEventListener('click', function (e) {
          e.stopPropagation();
          budgetMin = m;
          budgetWrap.querySelectorAll('.un-qfill-min').forEach(function (x) {
            x.classList.toggle('active', Number(x.textContent.replace('m', '')) === m);
          });
          if (fillCtx && fillCtx.onBudgetChange) fillCtx.onBudgetChange(m);
          syncBudget();
        });
        budgetWrap.appendChild(p);
      });
      menu.appendChild(budgetWrap);

      budgetBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        runQueueFill(budgetPlan());
      });
      syncBudget();
      menu.appendChild(budgetBtn);
    });

    document.body.appendChild(menu);
    fillMenuEl = menu;

    if (anchor && anchor.getBoundingClientRect) {
      var r = anchor.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = Math.round(r.bottom + 6) + 'px';
      // Right-align to the anchor, then clamp so a button near the viewport
      // edge cannot push the menu off-screen.
      var left = Math.round(r.right - menu.offsetWidth);
      menu.style.left = Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    }

    document.addEventListener('click', fillMenuDocClick, true);
    if (window.UNSYNTH && window.UNSYNTH.pushPanel) {
      fillEscHandle = window.UNSYNTH.pushPanel(closeFillMenu);
    }
  }

  /**
   * Apply a plan built by CU.planFill().
   *
   * addMany with capToMax rather than a per-item loop, for the two reasons the
   * undo path already documents: the cap decision has to happen INSIDE the
   * queue lock (reading the length outside leaves a storage round-trip another
   * add can land in, and addToList's overflow trim removes from the front —
   * the end nearest to playing), and a per-item callback chain nests a stack
   * frame per item and blew the stack past ~480 items. A folder-sized bulk add
   * is exactly the case that would hit both.
   */
  function runQueueFill(plan) {
    var CU = window.UNCatchUp;
    var NQ = window.UNNativeQueue;
    if (!CU || !plan || !plan.items.length) return;
    var items = CU.toQueueItems(plan.items);
    closeFillMenu();

    // The guard stays; the refusal becomes actionable. Measured 2026-09-20 and
    // written up in offerQueueOnWatch() — off /watch the add is a silent no-op,
    // so removing the guard would trade an honest refusal for a button that
    // claims success and does nothing.
    var onWatch = typeof location !== 'undefined' && (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch');
    if (!NQ || !onWatch) {
      if (!onWatch && items.length) {
        offerQueueOnWatch(items);
        return;
      }
      toast("Couldn't reach YouTube's queue");
      return;
    }
    NQ.add(items.map(function (item) { return item.id; }), { toFront: false }).then(function (r) {
      toast(r && r.native
        ? (items.length + ' added to YouTube queue')
        : "Couldn't reach YouTube's queue");
    });
  }

  // Six code paths popped an item off the queue to play it -- auto-advance,
  // the flyout row's ▶, the flyout row body, the dock's track card, the
  // dock's ▶, and Alt+N -- and exactly ONE of them called recordPlayed. The
  // other five removed and navigated silently, so the "X of Y" readout only
  // counted videos the queue played by itself: watch three manually and let
  // the fourth auto-advance and it reported "1 of 5". It also meant a queue
  // finished by hand never reached played >= total, so the finished card
  // never appeared for exactly the user who was driving it.
  //
  // Consolidated here rather than sprinkling recordPlayed into five call
  // sites, because the ordering is subtle and was already commented once in
  // maybeAdvance: record and remove BOTH have to land before navigateTo,
  // which tears this page (and this script) down. recordPlayed's callback
  // fires inside the queue lock but before it is released, so the remove
  // queued from it runs immediately after -- serialized, not deadlocked.
  //
  // remove() alone is deliberately NOT the play signal: it also fires for a
  // manual row delete and the dock's discard button, which must not count as
  // played. See recordPlayed in shared/watch-queue.js.
  // Six entry points, none of which knew about the others. WQ.load() is
  // deliberately unlocked, so two plays fired close together (double-tapping a
  // row, or clicking the dock's track card at the exact moment the video ends
  // and onEnded fires) both read the same pre-removal list, both compute the
  // same depth, and both record a play and navigate: "X of Y" counts one real
  // playback twice, and navigateTo runs twice for one video. `advancing` only
  // ever guarded onEnded against a duplicate native 'ended' event; it does
  // nothing about a manual trigger arriving alongside it.
  //
  // Cleared on a timer as well as by the navigation, so a storage error cannot
  // wedge the queue permanently unplayable -- the failure mode a plain
  // never-reset flag would introduce.
  var playInFlight = false;
  var playInFlightTimer = null;

  function playFromQueue(item, label) {
    // label is uniform across all six callers on purpose: the same action
    // reported three different ways ("Playing", "Playing from queue",
    // "Playing next from queue") depending only on which control you used.
    var WQ = window.UNWatchQueue;
    if (!WQ || !item || !item.id) return;
    if (playInFlight) return;
    playInFlight = true;
    if (playInFlightTimer) clearTimeout(playInFlightTimer);
    playInFlightTimer = setTimeout(function () { playInFlight = false; }, 4000);
    WQ.load(function (list) {
      // Read fresh instead of trusting the render-time snapshot the click
      // came from: another tab, or an add, can have changed the depth since
      // the dock or flyout was drawn.
      var depth = (list && list.length) || 1;
      function finish() {
        WQ.remove(item.id, function () {
          toast((label || 'Playing') + ': ' + (item.title || item.id));
          navigateTo(item.id);
          // Released here, not left to the timer: navigateTo usually fires
          // yt-navigate, which does NOT tear the page down, so a flag that
          // only the timeout cleared would make the queue unplayable for four
          // seconds after every single play.
          playInFlight = false;
          if (playInFlightTimer) { clearTimeout(playInFlightTimer); playInFlightTimer = null; }
        });
      }
      if (WQ.recordPlayed) WQ.recordPlayed(depth, finish);
      else finish();
    });
  }

  function navigateTo(videoId) {
    if (!videoId) return;
    var url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
    try {
      var app = document.querySelector('ytd-app');
      if (app && typeof app.fire === 'function') {
        app.fire('yt-navigate', { endpoint: { watchEndpoint: { videoId: videoId } } });
        return;
      }
    } catch (e) {}
    try {
      var a = document.createElement('a');
      a.href = '/watch?v=' + encodeURIComponent(videoId);
      a.className = 'yt-simple-endpoint';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    } catch (e) {}
    location.assign(url);
  }

  function onEnded() {
    // Local auto-advance is retired. +Q / Play next write to YouTube's own
    // queue; YouTube's Up next panel owns the next video.
    return;
    if (advancing) return;
    if (!prefs().autoAdvance) return;
    if (!isWatchPage()) return;
    // Inside a native playlist, YouTube's own autoplay owns the transition to
    // the next item and racing it would fight the user's explicit choice to
    // play a playlist. But that deferral used to run right through the LAST
    // item, so reaching the end of a playlist stopped playback dead with a
    // full Unsynth queue sitting there — the second half of "the playnext
    // button in que needs to work in youtubes native playlist manager".
    // Standing down mid-playlist is correct; standing down after YouTube has
    // run out is just stopping.
    //
    // Only positive evidence of the last item unlocks this. onLastPlaylistItem
    // returns null for "cannot tell", which stays deferred: guessing wrong
    // navigates the user out of a playlist they are three videos into.
    if (inNativePlaylist()) {
      if (inEndlessMix(currentListId())) return;
      if (onLastPlaylistItem() !== true) return;
    }
    // A looping video re-fires 'ended' every cycle (AB-loop, or the user's own
    // loop toggle) — advancing there would empty the queue without the user
    // ever asking for the next video.
    if (video && video.loop) return;
    // YouTube plays ads on this same <video> element (sequential src swaps,
    // not a separate ad player). An ad finishing fires a real 'ended' event
    // that looks identical to the actual video finishing — without this
    // check, an ad ending mid-video pops the queue and navigates away from
    // whatever the user was actually watching.
    if (adCurrentlyShowing()) return;

    // Looked up lazily, never captured at parse time: this module can be
    // injected before src/shared/watch-queue.js has defined the global.
    var WQ = window.UNWatchQueue;
    if (!WQ) return;

    advancing = true;
    WQ.load(function (list) {
      if (!list || !list.length) {
        advancing = false;
        return;
      }
      var next = list[0];
      if (!next || !next.id) {
        advancing = false;
        return;
      }
      // Ordering (record and remove both before the navigation that tears
      // this page down) now lives in playFromQueue, which every consumption
      // path shares.
      playFromQueue(next, 'Playing from queue');
    });
  }


  function detach() {
    if (video && onEndedBound) video.removeEventListener('ended', onEndedBound);
    video = null;
    onEndedBound = null;
  }

  function attach() {
    if (!isWatchPage()) {
      detach();
      return;
    }
    var v = document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
    if (!v) return;
    if (v === video) return; // already bound to this element
    detach();
    video = v;
    onEndedBound = onEnded;
    // No timeupdate listener any more: the only one was updateDockProgress,
    // which drove a progress bar inside the retired dock. It became a failed
    // getElementById running at ~4Hz on every video.
    v.addEventListener('ended', onEndedBound);
  }

  var flyoutOpen = false;
  // Where the queue list was scrolled to. Held in module state, NOT read back
  // off the old DOM: a reorder changes the queue hash, which makes
  // syncQueueDock() rebuild the whole dock, so the previous .un-qf-list is
  // already gone by the time renderFlyout runs. Reading the old node found
  // nothing and the list kept snapping to the top.
  var flyoutScrollTop = 0;

  // Hours matter here: this is a QUEUE, so the flyout's total is the sum of
  // every item. Without an hours branch a 1h1m1s video rendered as "61:01" and
  // a queue of forty ten-minute videos as "400:00 total", which reads as
  // minutes and is wrong by a factor of sixty. Seconds are floored because a
  // fractional duration made `sec % 60` emit decimals into the label.
  function formatQueueDur(sec) {
    sec = Math.floor(Number(sec) || 0);
    if (sec <= 0) return '';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  // How long this item has been sitting in the queue, in the vaguest unit that
  // is still honest. "3d ago" answers the question the user actually has; a
  // full timestamp does not, and takes twice the width in a row that already
  // carries a channel and a duration.
  function formatQueueAge(addedAt, now) {
    var at = Number(addedAt);
    if (!(at > 0)) return '';
    var ms = (Number(now) > 0 ? Number(now) : Date.now()) - at;
    // Negative means clock skew between two synced devices, not a future add.
    if (ms < 0) return '';
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just added';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return days + 'd ago';
    var weeks = Math.floor(days / 7);
    if (weeks < 5) return weeks + 'w ago';
    return Math.floor(days / 30) + 'mo ago';
  }

  // Watch state for the rows, read once per render rather than per row.
  //
  // READ-ONLY, and that is the point: this module reads what the panel needs to
  // MARK a row, and nothing more. watchedDates and watchedDatesApprox are here
  // because classifyQueue refuses to call anything "watched" without a real
  // timestamp — see its comment, and the incident that made it necessary.
  var flyoutWatchState = {
    progress: {},
    watched: Object.create(null),
    dates: {},
    approx: {},
    unavailable: [],
    at: 0
  };

  function refreshFlyoutWatchState(list, cb) {
    try {
      chrome.storage.local.get(
        { watchProgress: {}, watchedVideos: [], watchedDates: {}, watchedDatesApprox: {} },
        function (d) {
          var set = Object.create(null);
          ((d && d.watchedVideos) || []).forEach(function (id) { set[id] = true; });
          // Availability is checked lazily and cached (see checkQueueAvailability),
          // so a warm cache costs zero requests and a cold one costs at most
          // AVAIL_BATCH. A failure here yields an empty list, which flags
          // nothing — the safe direction.
          checkQueueAvailability(list, function (gone) {
            flyoutWatchState = {
              progress: (d && d.watchProgress) || {},
              watched: set,
              dates: (d && d.watchedDates) || {},
              approx: (d && d.watchedDatesApprox) || {},
              unavailable: gone || [],
              at: Date.now()
            };
            if (cb) cb();
          });
        }
      );
    } catch (e) {
      if (cb) cb();
    }
  }

  function closeFlyout() {
    flyoutOpen = false;
    // The confirmation sheet is parented to the flyout, so it would be torn out
    // from under itself. Close it explicitly so its Escape handler goes too.
    closeTidyConfirm();
    // Closing is a deliberate dismissal, so the next open starts at the top.
    flyoutScrollTop = 0;
    // The occupied area just shrank; without this the bulk bar stays parked
    // clear of a flyout that is no longer there.
    setTimeout(emitQueueDockChange, 0);
    var fly = document.getElementById('un-queue-flyout');
    if (fly) fly.remove();
    var dock = document.getElementById('un-queue-dock');
    if (dock) dock.classList.remove('has-flyout-open');
  }

  function renderFlyout(list, WQ) {
    if (!list || !list.length) {
      closeFlyout();
      return;
    }
    var dock = document.getElementById('un-queue-dock');
    if (!dock) return;

    var fly = document.getElementById('un-queue-flyout');
    if (!fly) {
      fly = document.createElement('div');
      fly.id = 'un-queue-flyout';
      fly.className = 'un-queue-flyout';
      dock.appendChild(fly);
    }

    // Watch state is read asynchronously, so the first paint after a cold open
    // has an empty map and would show no flags at all. Refresh it in the
    // background and repaint once, rather than blocking the whole flyout on a
    // storage round-trip — the list is the thing the user opened it for; the
    // flags are an annotation on it. Guarded by a staleness check so this does
    // NOT re-enter on every render (a reorder repaints, and an unconditional
    // refresh-then-render would loop).
    if (Date.now() - flyoutWatchState.at > 5000) {
      refreshFlyoutWatchState(list, function () {
        if (!flyoutOpen || !document.getElementById('un-queue-flyout')) return;
        renderFlyout(list, WQ);
      });
    }

    // One clock and one set of thresholds for the whole render, so every row is
    // judged against the same instant — rows computing their own Date.now()
    // could disagree about staleness within a single paint.
    var renderNow = Date.now();
    var tidyPrefs = prefs();
    var staleDays = tidyPrefs.staleDays;

    // Classified ONCE, by the shared classifier, and read by both the header
    // buttons and the row flags. Two implementations of "what counts as stale"
    // would drift the moment either changed, and the failure would be silent: a
    // button offering to clear 3 while the rows mark 5.
    //
    // This is a pure read. It marks; it does not act. Acting is a click away,
    // through openTidyConfirm, and only ever from there.
    var buckets = WQ.classifyQueue
      ? WQ.classifyQueue(list, {
        now: renderNow,
        staleDays: staleDays,
        watchedThreshold: tidyPrefs.watchedThreshold,
        progress: flyoutWatchState.progress,
        watched: Object.keys(flyoutWatchState.watched),
        watchedDates: flyoutWatchState.dates,
        watchedDatesApprox: flyoutWatchState.approx,
        unavailable: flyoutWatchState.unavailable
      })
      : { keep: list, watched: [], unavailable: [], stale: [] };
    // Id lookups so each row can ask "am I in a bucket" without rescanning.
    var mark = {
      watched: Object.create(null),
      stale: Object.create(null),
      unavailable: Object.create(null)
    };
    buckets.watched.forEach(function (x) { mark.watched[x.id] = true; });
    buckets.stale.forEach(function (x) { mark.stale[x.id] = true; });
    buckets.unavailable.forEach(function (x) { mark.unavailable[x.id] = true; });

    var rect = dock.getBoundingClientRect();
    var isTop = rect.top < (window.innerHeight / 2);
    var isLeft = rect.left < (window.innerWidth / 2);
    fly.className = 'un-queue-flyout ' + (isTop ? 'fly-down ' : 'fly-up ') + (isLeft ? 'fly-left' : 'fly-right');
    dock.classList.add('has-flyout-open');
    // renderFlyout rebuilds the whole panel and creates a NEW .un-qf-list, so
    // scrollTop went to 0 on every rebuild. Every ↑/↓ click rebuilds, and the
    // storage listener rebuilds again right after, which made reordering
    // anything past the eighth row a scroll-click-scroll-back loop: the list
    // shows about 8 of up to 500 rows.
    // Only ADOPT a real position from the outgoing list. A rebuild that catches
    // it at 0 (torn down before layout settled) must not overwrite a good saved
    // offset with 0 — that is how a reorder ends up back at the top.
    var prevList = fly.querySelector('.un-qf-list');
    if (prevList && prevList.scrollTop > 0) flyoutScrollTop = prevList.scrollTop;
    fly.textContent = '';

    // Header with two-row clean layout
    var head = document.createElement('div');
    head.className = 'un-qf-header';

    // Row 1: Title, Count, Duration Meta, and Close Button
    var headTop = document.createElement('div');
    headTop.className = 'un-qf-head-top';

    var titleBox = document.createElement('div');
    titleBox.className = 'un-qf-title-box';
    var hLabel = document.createElement('span');
    hLabel.className = 'un-qf-title';
    hLabel.textContent = 'Up Next in Queue';
    var countBadge = document.createElement('span');
    countBadge.className = 'un-qf-count';
    countBadge.textContent = String(list.length);
    titleBox.appendChild(hLabel);
    titleBox.appendChild(countBadge);

    // Session progress ("2 of 5") — see recordPlayed()'s comment in
    // shared/watch-queue.js for why this is a separately-tracked counter
    // rather than something derived from the (upcoming-only) queue list.
    var progressBadge = document.createElement('span');
    progressBadge.className = 'un-qf-progress';
    titleBox.appendChild(progressBadge);
    if (WQ.getProgress) {
      WQ.getProgress(function (p) {
        if (!progressBadge.isConnected) return; // flyout re-rendered/closed before this resolved
        // recordPlayed() increments `played` for the item it just popped,
        // right before navigating to it — so `played` IS the 1-based
        // position of whatever's currently playing, not played+1.
        if (p && p.total > 0 && p.played > 0) {
          progressBadge.textContent = p.played + ' of ' + p.total;
          progressBadge.title = 'Playing #' + p.played + ' of ' + p.total + ' this session · ' + list.length + ' left in queue';
        }
      });
    }

    // Total duration & finish time calculation.
    //
    // "Ends at" is a promise about the clock, so it has to be made out of the
    // time actually spent watching, not YouTube's runtime. Items queued while
    // SponsorBlock data was available carry contentSec; the rest fall back to
    // dur. Mixed queues are normal, so the saving is only named when some item
    // really has data — otherwise the line would claim a precision it does not
    // have.
    var totalSec = 0;
    var rawSec = 0;
    var haveContent = false;
    list.forEach(function (x) {
      var raw = Number(x.dur) || 0;
      rawSec += raw;
      var c = x.contentSec;
      if (c !== null && c !== undefined && c !== '' && isFinite(Number(c)) && Number(c) >= 0) {
        totalSec += Number(c);
        haveContent = true;
      } else {
        totalSec += raw;
      }
    });
    if (totalSec > 0) {
      var metaSub = document.createElement('span');
      metaSub.className = 'un-qf-head-meta';
      var durStr = formatQueueDur(totalSec);
      var finishDate = new Date(Date.now() + totalSec * 1000);
      var finishTimeStr = finishDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      var saved = rawSec - totalSec;
      metaSub.textContent = '· ' + durStr + ' total · Ends at ' + finishTimeStr;
      if (haveContent && saved >= 60) {
        metaSub.textContent += ' · skips ' + formatQueueDur(saved);
      }
      titleBox.appendChild(metaSub);
    }

    var closeBtn = document.createElement('button');
    closeBtn.className = 'un-qf-close-btn';
    closeBtn.type = 'button';
    closeBtn.title = 'Close queue preview';
    closeBtn.setAttribute('aria-label', closeBtn.title);
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeFlyout();
    });

    headTop.appendChild(titleBox);
    headTop.appendChild(closeBtn);

    // Row 2: Mode Group + Action Buttons Toolbar
    var headToolbar = document.createElement('div');
    headToolbar.className = 'un-qf-head-toolbar';

    // View mode selector
    var modeGroup = document.createElement('div');
    modeGroup.className = 'un-qf-mode-group';
    [
      { id: 'standard', label: 'Full', title: 'Full standard dock with preview' },
      { id: 'compact', label: 'Compact', title: 'Compact space-saving pill' },
      { id: 'minimal', label: 'Mini', title: 'Minimal floating bubble' }
    ].forEach(function (m) {
      var mBtn = document.createElement('button');
      mBtn.className = 'un-qf-mode-btn' + (dockMode === m.id ? ' on' : '');
      mBtn.type = 'button';
      mBtn.title = m.title;
      mBtn.textContent = m.label;
      mBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setDockMode(m.id);
      });
      modeGroup.appendChild(mBtn);
    });

    var acts = document.createElement('div');
    acts.className = 'un-qf-acts';

    var shuffleBtn = document.createElement('button');
    shuffleBtn.className = 'un-qf-act-btn';
    shuffleBtn.type = 'button';
    shuffleBtn.title = 'Shuffle queue';
    shuffleBtn.setAttribute('aria-label', shuffleBtn.title);
    shuffleBtn.append(unIco('shuffle'), labelSpan('Shuffle'));
    shuffleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var rankFn = (window.UNTasteRank && window.UNTasteRank.scoreItem) || null;
      WQ.shuffle(function () {
        toast('Queue shuffled');
        syncQueueDock();
      }, rankFn);
    });

    var savePlBtn = document.createElement('button');
    savePlBtn.className = 'un-qf-act-btn';
    savePlBtn.type = 'button';
    savePlBtn.title = 'Save entire queue as a YouTube playlist';
    savePlBtn.setAttribute('aria-label', savePlBtn.title);
    savePlBtn.append(unIco('folder'), labelSpan('Save as playlist'));
    savePlBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var defaultTitle = 'Queue ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      var title = prompt('Playlist title:', defaultTitle);
      if (!title || !title.trim()) return;
      var videoIds = list.map(function (x) { return x.id; }).filter(Boolean);
      if (!videoIds.length) return;
      toast('Creating playlist…');
      chrome.runtime.sendMessage({
        type: 'UNSYNTH/YT/PLAYLIST_CREATE',
        title: title.trim(),
        description: 'Created with Unsynth Queue',
        privacyStatus: 'private'
      }, function (res) {
        if (!res || !res.ok || !res.playlist || !res.playlist.id) {
          toast('Could not create playlist (Connect YouTube first)');
          return;
        }
        var plId = res.playlist.id;
        chrome.runtime.sendMessage({
          type: 'UNSYNTH/YT/PLAYLIST_ADD',
          playlistId: plId,
          videoIds: videoIds
        }, function (addRes) {
          var count = (addRes && addRes.added != null) ? addRes.added : videoIds.length;
          toast('Saved ' + count + ' videos to "' + title.trim() + '"');
        });
      });
    });

    var clearAllBtn = document.createElement('button');
    clearAllBtn.className = 'un-qf-act-btn clear';
    clearAllBtn.type = 'button';
    clearAllBtn.title = 'Clear queue';
    clearAllBtn.setAttribute('aria-label', clearAllBtn.title);
    clearAllBtn.textContent = 'Clear all';
    clearAllBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      WQ.clear(function () {
        toast('Queue cleared');
        closeFlyout();
        syncQueueDock();
      });
    });

    // Tidy actions, shown ONLY when they have something to act on. A permanent
    // "Clear 0 watched" button is a dead control that trains the user to ignore
    // that row; appearing only when the count is real makes the count itself
    // the signal that the queue needs attention.
    //
    // Every one of these opens the confirmation sheet first. The button states
    // the count, the sheet states the titles, and only the sheet's own button
    // removes anything.
    if (buckets.watched.length) {
      var n = buckets.watched.length;
      var noun = n === 1 ? 'video' : 'videos';
      var clearWatchedBtn = document.createElement('button');
      clearWatchedBtn.className = 'un-qf-act-btn tidy';
      clearWatchedBtn.type = 'button';
      clearWatchedBtn.textContent = '✓ Clear ' + n + ' watched';
      clearWatchedBtn.title = 'Review and remove the ' + n + ' ' + noun +
        ' you finished after queueing them (undoable)';
      clearWatchedBtn.setAttribute('aria-label', clearWatchedBtn.title);
      clearWatchedBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var going = buckets.watched;
        openTidyConfirm({
          title: 'Remove ' + n + ' watched ' + noun + ' from the queue?',
          // Says WHY each of these qualified, because the rule is not obvious
          // and the user has been burned by a version that got it wrong.
          note: 'These were finished AFTER you queued them. Anything you watched ' +
            'earlier and re-queued on purpose is not in this list. Removal is undoable.',
          items: going,
          actionLabel: 'Remove ' + n,
          danger: true,
          onConfirm: function () {
            removeQueueItems(going, function () {
              toastWithUndo('Cleared ' + n + ' already-watched ' + noun + ' from the queue', going);
              syncQueueDock();
            });
          }
        });
      });
      acts.appendChild(clearWatchedBtn);
    }

    if (buckets.unavailable.length) {
      var un = buckets.unavailable.length;
      var unNoun = un === 1 ? 'video' : 'videos';
      var goneBtn = document.createElement('button');
      goneBtn.className = 'un-qf-act-btn tidy';
      goneBtn.type = 'button';
      goneBtn.textContent = '⚠ Remove ' + un + ' unavailable';
      goneBtn.title = 'Review and remove the ' + un + ' ' + unNoun +
        ' that can no longer play (deleted or private)';
      goneBtn.setAttribute('aria-label', goneBtn.title);
      goneBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var going = buckets.unavailable;
        openTidyConfirm({
          title: 'Remove ' + un + ' unavailable ' + unNoun + '?',
          note: 'YouTube reports these as deleted or private, so they can never play ' +
            'from the queue. Removal is undoable.',
          items: going,
          actionLabel: 'Remove ' + un,
          danger: true,
          onConfirm: function () {
            removeQueueItems(going, function () {
              toastWithUndo('Removed ' + un + ' unavailable ' + unNoun +
                ' (deleted or private)', going);
              syncQueueDock();
            });
          }
        });
      });
      acts.appendChild(goneBtn);
    }

    if (buckets.stale.length) {
      var st = buckets.stale.length;
      var stNoun = st === 1 ? 'video' : 'videos';
      var rescueBtn = document.createElement('button');
      rescueBtn.className = 'un-qf-act-btn tidy';
      rescueBtn.type = 'button';
      // Named "Rescue", not "Clear": these are the UNCERTAIN ones, and the
      // button must promise what it actually does — move them somewhere safe,
      // never delete them.
      rescueBtn.textContent = '⇥ Rescue ' + st + ' stale';
      rescueBtn.title = 'Review and move the ' + st + ' ' + stNoun + ' queued over ' +
        staleDays + ' days ago into "' + RESCUE_PLAYLIST_TITLE + '". Nothing is deleted.';
      rescueBtn.setAttribute('aria-label', rescueBtn.title);
      rescueBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var going = buckets.stale;
        openTidyConfirm({
          title: 'Move ' + st + ' stale ' + stNoun + ' to a playlist?',
          note: 'Queued over ' + staleDays + ' days ago and not watched since. They are ' +
            'ADDED to the private playlist "' + RESCUE_PLAYLIST_TITLE + '" first, and ' +
            'only leave the queue once that succeeds. If YouTube is not connected, ' +
            'nothing is removed.',
          items: going,
          actionLabel: 'Move ' + st + ' to playlist',
          onConfirm: function () {
            chrome.storage.local.get({ unQueueRescuePlaylistId: '' }, function (d) {
              rescueStaleItems(going, d && d.unQueueRescuePlaylistId);
            });
          }
        });
      });
      acts.appendChild(rescueBtn);
    }

    acts.appendChild(shuffleBtn);
    acts.appendChild(savePlBtn);
    acts.appendChild(clearAllBtn);

    headToolbar.appendChild(modeGroup);
    headToolbar.appendChild(acts);

    head.appendChild(headTop);
    head.appendChild(headToolbar);
    fly.appendChild(head);

    // List container
    var listWrap = document.createElement('div');
    listWrap.className = 'un-qf-list';

    var draggedRowId = null;
    var isDraggingRow = false;
    var dragEndTime = 0;

    list.forEach(function (item, idx) {
      var row = document.createElement('div');
      row.className = 'un-qf-row' + (idx === 0 ? ' is-playing-next' : '');
      row.draggable = true;

      row.addEventListener('dragstart', function (e) {
        draggedRowId = item.id;
        isDraggingRow = true;
        row.classList.add('is-dragging-row');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.id);
        }
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('is-dragging-row');
        document.querySelectorAll('.un-qf-row.drop-target').forEach(function (r) { r.classList.remove('drop-target'); });
        dragEndTime = Date.now();
        setTimeout(function () {
          isDraggingRow = false;
          draggedRowId = null;
        }, 120);
      });
      row.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', function () {
        row.classList.remove('drop-target');
      });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        row.classList.remove('drop-target');
        var srcId = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || draggedRowId;
        dragEndTime = Date.now();
        setTimeout(function () {
          isDraggingRow = false;
          draggedRowId = null;
        }, 120);
        if (!srcId || srcId === item.id) return;
        WQ.moveToIndex(srcId, idx, function () {
          syncQueueDock();
        });
      });

      var num = document.createElement('div');
      num.className = 'un-qf-num';
      // No title here: this element is not focusable and has no key handler,
      // so advertising "drag to reorder" promises an affordance keyboard and
      // touch users cannot use. The up/down buttons in the row are the
      // keyboard path, and the row itself is still draggable for mouse users.
      num.setAttribute('aria-hidden', 'true');
      num.textContent = String(idx + 1);

      var thumb = document.createElement('img');
      thumb.className = 'un-qf-thumb';
      // A queued video can be deleted, region-locked or private by the time
      // the flyout renders, and its thumbnail 404s. The CSS fallback
      // (background: rgba(0,0,0,.4)) only shows while the img has no resolved
      // src -- once the request fails the browser paints its own broken-image
      // glyph straight over it. Dropping the src lets the intended dark
      // placeholder show instead.
      thumb.addEventListener('error', function () {
        thumb.removeAttribute('src');
        thumb.classList.add('un-thumb-missing');
      });
      thumb.loading = 'lazy';
      thumb.src = item.thumb || (item.id ? 'https://i.ytimg.com/vi/' + item.id + '/mqdefault.jpg' : '');
      thumb.alt = '';

      var meta = document.createElement('div');
      meta.className = 'un-qf-meta';

      if (idx === 0) {
        var nextTag = document.createElement('div');
        nextTag.className = 'un-qf-next-tag';
        nextTag.textContent = '▶ Playing Next';
        meta.appendChild(nextTag);
      }

      var t = document.createElement('div');
      t.className = 'un-qf-item-title';
      t.textContent = item.title || item.id;

      var sub = document.createElement('div');
      sub.className = 'un-qf-item-sub';
      // Age is in the row because "how long has this been here" is the question
      // the stale flag answers, and a flag with no visible basis is a black box.
      sub.textContent = [
        item.channel || '',
        item.dur ? formatQueueDur(item.dur) : '',
        formatQueueAge(item.addedAt, renderNow)
      ].filter(Boolean).join(' · ');

      meta.appendChild(t);
      meta.appendChild(sub);

      // Why this row is marked, stated on the row itself. Read off the SAME
      // classifyQueue result the header buttons count from, so a row's flag and
      // a button's number can never disagree — a button offering to clear three
      // while five rows are marked is the shape of bug that hides a data-loss
      // one behind it.
      var pct = Number(flyoutWatchState.progress[item.id]) || 0;
      if (mark.watched[item.id]) {
        row.classList.add('is-watched');
        var wTag = document.createElement('span');
        wTag.className = 'un-qf-flag watched';
        wTag.textContent = pct > 0 ? 'Watched ' + Math.min(100, Math.round(pct)) + '%' : 'Watched';
        wTag.title = 'Finished after you queued it — "Clear watched" offers to remove this';
        sub.appendChild(document.createTextNode(' '));
        sub.appendChild(wTag);
      } else if (mark.unavailable[item.id]) {
        row.classList.add('is-gone');
        var uTag = document.createElement('span');
        uTag.className = 'un-qf-flag gone';
        uTag.textContent = 'Unavailable';
        uTag.title = 'YouTube reports this as deleted or private — it can never play from the queue';
        sub.appendChild(document.createTextNode(' '));
        sub.appendChild(uTag);
      } else if (mark.stale[item.id]) {
        row.classList.add('is-stale');
        var sTag = document.createElement('span');
        sTag.className = 'un-qf-flag stale';
        sTag.textContent = 'Stale';
        sTag.title = 'Queued over ' + staleDays + ' days ago — "Rescue stale" moves this to "' +
          RESCUE_PLAYLIST_TITLE + '" rather than deleting it';
        sub.appendChild(document.createTextNode(' '));
        sub.appendChild(sTag);
      } else if (pct > 0) {
        // Partially watched but not finished: worth showing (it tells you where
        // you left off) but NOT a tidy target, so no flag styling.
        var pTag = document.createElement('span');
        pTag.className = 'un-qf-flag partial';
        pTag.textContent = Math.round(pct) + '%';
        pTag.title = 'You are ' + Math.round(pct) + '% through this one';
        sub.appendChild(document.createTextNode(' '));
        sub.appendChild(pTag);
      }

      var rowActs = document.createElement('div');
      rowActs.className = 'un-qf-row-acts';

      var playItemBtn = document.createElement('button');
      playItemBtn.className = 'un-qf-row-btn play';
      playItemBtn.type = 'button';
      playItemBtn.title = 'Play now and remove from queue';
      playItemBtn.setAttribute('aria-label', playItemBtn.title);
      playItemBtn.textContent = '▶';
      playItemBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        playFromQueue(item, 'Playing from queue');
      });

      var plItemBtn = document.createElement('button');
      plItemBtn.className = 'un-qf-row-btn pl';
      plItemBtn.type = 'button';
      plItemBtn.title = 'Save to playlist';
      plItemBtn.setAttribute('aria-label', plItemBtn.title);
      plItemBtn.textContent = '⊕';
      plItemBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openItemPlaylistMenu(plItemBtn, item);
      });

      var upBtn = document.createElement('button');
      upBtn.className = 'un-qf-row-btn';
      upBtn.type = 'button';
      // Shift-click jumps to the end rather than stepping. The list shows about
      // eight of up to 500 rows, so moving something from row 40 to the top one
      // click at a time is forty clicks and forty repaints.
      upBtn.title = 'Move up (Shift-click: send to the top)';
      upBtn.setAttribute('aria-label', upBtn.title);
      upBtn.textContent = '↑';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        // No callback: the storage listener already rebuilds on the write.
        // Passing syncQueueDock here too rebuilt the flyout twice per click.
        if (e.shiftKey) WQ.moveToIndex(item.id, 0);
        else WQ.move(item.id, -1);
      });

      var downBtn = document.createElement('button');
      downBtn.className = 'un-qf-row-btn';
      downBtn.type = 'button';
      downBtn.title = 'Move down (Shift-click: send to the bottom)';
      downBtn.setAttribute('aria-label', downBtn.title);
      downBtn.textContent = '↓';
      downBtn.disabled = idx === list.length - 1;
      downBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.shiftKey) WQ.moveToIndex(item.id, list.length - 1);
        else WQ.move(item.id, 1);
      });

      var rmBtn = document.createElement('button');
      rmBtn.className = 'un-qf-row-btn rm';
      rmBtn.type = 'button';
      rmBtn.title = 'Remove from queue';
      rmBtn.setAttribute('aria-label', rmBtn.title);
      rmBtn.textContent = '✕';
      rmBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        WQ.remove(item.id, function () { syncQueueDock(); });
      });

      rowActs.appendChild(playItemBtn);
      rowActs.appendChild(plItemBtn);
      rowActs.appendChild(upBtn);
      rowActs.appendChild(downBtn);
      rowActs.appendChild(rmBtn);

      row.appendChild(num);
      row.appendChild(thumb);
      row.appendChild(meta);
      row.appendChild(rowActs);

      row.addEventListener('click', function (e) {
        if (isDraggingRow || (Date.now() - dragEndTime < 200)) return;
        if (e.target.closest('.un-qf-row-btn, .un-qf-pl-menu, .un-qf-pl-item')) return;
        playFromQueue(item, 'Playing from queue');
      });

      listWrap.appendChild(row);
    });

    fly.appendChild(listWrap);
    // Restore where the user was. Clamped, because the list may be shorter now
    // (an item was removed), and a stale scrollTop would leave it blank.
    // Keep the stored position current as the user scrolls, so it survives the
    // next full dock rebuild.
    // `restoring` suppresses the scroll listener while restore() is assigning.
    // Setting scrollTop fires 'scroll' synchronously, so without this the
    // listener writes the value it was just given straight back into
    // flyoutScrollTop — and when the first clamp lands on 0 (the rows have not
    // sized yet, so maxScroll is 0), that stores 0 and destroys the saved
    // position before the requestAnimationFrame retry can use it.
    //
    // Hardening, not a proven fix. e2e/queue-reorder-scroll.spec.js fails on
    // roughly one run in five, and that flake was measured at the SAME rate
    // before this guard existed and before the flag work landed, so its real
    // cause is still open and is not this. Do not read this comment as saying
    // that test is fixed.
    var restoring = false;
    listWrap.addEventListener('scroll', function () {
      if (restoring) return;
      flyoutScrollTop = listWrap.scrollTop;
    });
    if (flyoutScrollTop > 0) {
      var want = flyoutScrollTop;
      var restore = function () {
        var maxScroll = Math.max(0, listWrap.scrollHeight - listWrap.clientHeight);
        // Clamped: the list may be shorter now (an item was removed), and a
        // stale offset would leave it showing blank space.
        restoring = true;
        listWrap.scrollTop = Math.min(want, maxScroll);
        restoring = false;
      };
      restore();
      // Rows can size after paint, so the first clamp can be against a
      // too-short list. Re-apply once the layout has settled.
      requestAnimationFrame(restore);
    }
  }

  // Builds one clickable row: icon in its own span so a long name can wrap
  // onto a second line (via CSS line-clamp) instead of hard-truncating —
  // the old version was plain textContent with white-space:nowrap, which
  // is why playlist names with more than ~20 characters read as cut off.
  function unIco(name) { var s = document.createElement('span'); s.className = 'un-ico'; s.setAttribute('data-ico', name); s.setAttribute('aria-hidden', 'true'); return s; }
  function labelSpan(text) { var s = document.createElement('span'); s.className = 'un-ico-label'; s.textContent = text; return s; }
  function plMenuItemRow(cls, icon, name, onClick) {
    var opt = document.createElement('button');
    opt.className = 'un-qf-pl-item' + (cls ? ' ' + cls : '');
    opt.type = 'button';
    opt.title = name;
    opt.setAttribute('aria-label', opt.title);
    var iconEl = document.createElement('span');
    iconEl.className = 'un-qf-pl-item-icon';
    // A line icon by name ('clock', 'folder', 'check'), or a plain text glyph
    // (the busy ellipsis). One icon set: no emoji (DESIGN-STANDARD 11).
    if (/^[a-z-]+$/.test(icon || '')) iconEl.appendChild(unIco(icon));
    else iconEl.textContent = icon;
    var labelEl = document.createElement('span');
    labelEl.className = 'un-qf-pl-item-label';
    labelEl.textContent = name;
    opt.appendChild(iconEl);
    opt.appendChild(labelEl);
    opt.addEventListener('click', onClick);
    return opt;
  }

  function openItemPlaylistMenu(anchorBtn, item) {
    if (!anchorBtn || !item) return;
    document.querySelectorAll('.un-qf-pl-menu').forEach(function (m) { m.remove(); });

    var menu = document.createElement('div');
    menu.className = 'un-qf-pl-menu';
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    // Position menu relative to viewport / anchor button
    var rect = anchorBtn.getBoundingClientRect();
    // position + z-index come from .un-qf-pl-menu in core.css. An inline value
    // here silently outranks the stylesheet and drifts away from the layer scale.
    if (rect.top > window.innerHeight / 2) {
      menu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
      menu.style.top = 'auto';
    } else {
      menu.style.top = (rect.bottom + 6) + 'px';
      menu.style.bottom = 'auto';
    }
    menu.style.right = Math.max(12, window.innerWidth - rect.right) + 'px';
    menu.style.left = 'auto';

    var loadLabel = document.createElement('div');
    loadLabel.className = 'un-qf-pl-item loading';
    loadLabel.textContent = 'Loading playlists…';
    menu.appendChild(loadLabel);
    document.body.appendChild(menu);

    // Keep the menu on-screen: after layout, clamp its top so a tall list
    // near the top of the viewport doesn't render partially off the top edge.
    requestAnimationFrame(function () {
      if (!menu.parentElement) return;
      var mRect = menu.getBoundingClientRect();
      if (mRect.top < 8) {
        menu.style.top = '8px';
        menu.style.bottom = 'auto';
      }
      if (mRect.bottom > window.innerHeight - 8 && menu.style.bottom === 'auto') {
        // switching to bottom-anchored would need the original anchor rect;
        // simplest safe fix here is capping max-height to what's visible.
        menu.style.maxHeight = Math.max(160, window.innerHeight - mRect.top - 12) + 'px';
      }
    });

    // Click outside listener for menu
    var dismissMenu = function (e) {
    // Not a user dismissal -- see queue-advance.js docClickHandler.
    if (e && e.isTrusted === false) return;
      if (menu && !menu.contains(e.target) && e.target !== anchorBtn) {
        menu.remove();
        document.removeEventListener('click', dismissMenu, true);
      }
    };
    setTimeout(function () {
      document.addEventListener('click', dismissMenu, true);
    }, 50);

    // Inline "New Playlist" name form — replaces prompt() with something
    // that actually matches the rest of the picker's styling instead of a
    // jarring native browser dialog.
    function showNewPlaylistForm() {
      menu.textContent = '';
      var headTitle = document.createElement('div');
      headTitle.className = 'un-qf-pl-head';
      headTitle.textContent = 'New Playlist';
      menu.appendChild(headTitle);

      var form = document.createElement('div');
      form.className = 'un-qf-pl-newform';

      var input = document.createElement('input');
      input.className = 'un-qf-pl-newform-input';
      input.type = 'text';
      input.placeholder = 'Playlist title…';
      input.maxLength = 150;
      form.appendChild(input);

      var row = document.createElement('div');
      row.className = 'un-qf-pl-newform-row';
      var createBtn = document.createElement('button');
      createBtn.className = 'un-qf-pl-newform-btn create';
      createBtn.type = 'button';
      createBtn.textContent = 'Create';
      createBtn.disabled = true;
      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'un-qf-pl-newform-btn cancel';
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      row.appendChild(createBtn);
      row.appendChild(cancelBtn);
      form.appendChild(row);
      menu.appendChild(form);

      input.addEventListener('input', function () {
        createBtn.disabled = !input.value.trim();
      });
      var submit = function () {
        var title = input.value.trim();
        if (!title) return;
        menu.remove();
        toast('Creating playlist…');
        chrome.runtime.sendMessage({
          type: 'UNSYNTH/YT/PLAYLIST_CREATE',
          title: title,
          description: 'Created with Unsynth',
          privacyStatus: 'private'
        }, function (createRes) {
          if (!createRes || !createRes.ok || !createRes.playlist || !createRes.playlist.id) {
            toast('Could not create playlist (Connect YouTube in Unsynth settings)');
            return;
          }
          var newId = createRes.playlist.id;
          chrome.runtime.sendMessage({
            type: 'UNSYNTH/YT/PLAYLIST_ADD',
            playlistId: newId,
            videoIds: [item.id]
          }, function () {
            toast('Added to "' + title + '"');
          });
        });
      };
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') { e.stopPropagation(); menu.remove(); }
      });
      createBtn.addEventListener('click', submit);
      cancelBtn.addEventListener('click', function () { menu.remove(); });
      input.focus();
    }

    // Fetch from both YouTube Data API and stored local playlists/pins
    chrome.runtime.sendMessage({ type: 'UNSYNTH/YT/PLAYLISTS_MINE' }, function (res) {
      if (!menu.parentElement) return;
      chrome.storage.local.get({ plPins: { ids: [], names: {} }, plFolderStore: { folders: {}, names: {} } }, function (storeData) {
        if (!menu.parentElement) return;
        menu.textContent = '';

        // Header inside menu
        var headTitle = document.createElement('div');
        headTitle.className = 'un-qf-pl-head';
        headTitle.textContent = 'Save to Playlist';
        menu.appendChild(headTitle);

        // 1. Watch Later Option
        menu.appendChild(plMenuItemRow('wl', 'clock', 'Watch Later', function () {
          menu.remove();
          chrome.runtime.sendMessage({ type: 'UNSYNTH/YT/WATCH_LATER_ADD', videoIds: [item.id] }, function (r) {
            // Both branches used to say "Added", so a failed write was
            // indistinguishable from a successful one.
            toast(r && r.ok ? 'Added to Watch Later' : 'Could not add to Watch Later');
          });
        }));

        // 2. New Playlist Option — opens the inline form above, not a prompt()
        menu.appendChild(plMenuItemRow('new-pl', '➕', 'New Playlist…', function () {
          showNewPlaylistForm();
        }));

        // 3. Aggregate playlists
        var plMap = new Map();
        if (res && res.ok && Array.isArray(res.playlists)) {
          res.playlists.forEach(function (pl) {
            if (pl && pl.id) plMap.set(pl.id, pl.title || pl.id);
          });
        }
        if (storeData && storeData.plPins && storeData.plPins.names) {
          Object.keys(storeData.plPins.names).forEach(function (id) {
            if (!plMap.has(id)) plMap.set(id, storeData.plPins.names[id]);
          });
        }
        if (storeData && storeData.plFolderStore && storeData.plFolderStore.names) {
          Object.keys(storeData.plFolderStore.names).forEach(function (id) {
            if (!plMap.has(id)) plMap.set(id, storeData.plFolderStore.names[id]);
          });
        }

        if (!plMap.size) {
          var hint = document.createElement('div');
          hint.className = 'un-qf-pl-hint';
          hint.textContent = 'No playlists found. Click "➕ New Playlist" to create one.';
          menu.appendChild(hint);
          return;
        }

        var plListWrap = document.createElement('div');
        plListWrap.className = 'un-qf-pl-scroll';

        // Membership state, so each row is a TOGGLE rather than add-only:
        // a playlist the video is already in offers to take it out, and says
        // so before you click. Rows render immediately and re-render once the
        // lookup lands, so the menu never blocks on the network.
        var memberIds = {};   // playlistId -> true
        var memberItemIds = {}; // playlistId -> playlistItem id (needed to remove)
        var busyIds = {};

        function renderRows() {
          plListWrap.textContent = '';
          plMap.forEach(function (name, plId) {
            var isIn = !!memberIds[plId];
            var busy = !!busyIds[plId];
            var icon = busy ? '⋯' : isIn ? 'check' : 'folder';
            var label = busy ? name : isIn ? name + ' — remove' : name;
            var row = plMenuItemRow('', icon, label, function () {
              if (busyIds[plId]) return;
              busyIds[plId] = true;
              renderRows();
              if (isIn) {
                var itemId = memberItemIds[plId];
                if (!itemId) {
                  busyIds[plId] = false;
                  renderRows();
                  toast('Could not remove from ' + name + ' — reopen the menu and try again');
                  return;
                }
                chrome.runtime.sendMessage({
                  type: 'UNSYNTH/YT/PLAYLIST_REMOVE',
                  itemIds: [itemId]
                }, function (rmRes) {
                  busyIds[plId] = false;
                  var ok = rmRes && rmRes.ok && rmRes.removed;
                  if (ok) {
                    delete memberIds[plId];
                    delete memberItemIds[plId];
                  }
                  renderRows();
                  // Report what actually happened. These used to toast the
                  // same success text on both branches, so a failed write
                  // looked identical to a successful one.
                  toast(ok ? 'Removed from ' + name : 'Could not remove from ' + name);
                });
                return;
              }
              chrome.runtime.sendMessage({
                type: 'UNSYNTH/YT/PLAYLIST_ADD',
                playlistId: plId,
                videoIds: [item.id]
              }, function (addRes) {
                busyIds[plId] = false;
                var ok = addRes && addRes.ok;
                if (ok) memberIds[plId] = true;
                renderRows();
                toast(ok ? 'Added to ' + name : 'Could not add to ' + name);
              });
            });
            if (isIn) row.classList.add('un-qf-pl-item--in');
            plListWrap.appendChild(row);
          });
        }
        renderRows();
        menu.appendChild(plListWrap);

        // Ask which of these already contain the video, then re-render.
        var plIdList = [];
        plMap.forEach(function (_n, id) { plIdList.push(id); });
        if (plIdList.length) {
          chrome.runtime.sendMessage({
            type: 'UNSYNTH/YT/VIDEO_PLAYLISTS',
            videoId: item.id,
            playlistIds: plIdList
          }, function (mRes) {
            if (!mRes || !mRes.ok || !menu.parentElement) return;
            (mRes.inIds || []).forEach(function (id) { memberIds[id] = true; });
            memberItemIds = mRes.itemIds || {};
            renderRows();
          });
        }
      });
    });
  }

  var dockMode = 'standard'; // 'standard' | 'compact' | 'minimal'
  var dockPos = null; // { left, top }
  var isDragging = false;

  // Load saved dock preferences
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ unsynthQueueDockMode: 'standard', unsynthQueueDockPos: null }, function (d) {
        if (d && d.unsynthQueueDockMode) dockMode = d.unsynthQueueDockMode;
        if (d && d.unsynthQueueDockPos) dockPos = d.unsynthQueueDockPos;
        applyDockPosition();
      });
    }
  } catch (e) {}

  function setDockMode(mode) {
    dockMode = mode;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ unsynthQueueDockMode: mode });
      }
    } catch (e) {}
    syncQueueDock();
  }

  var QUEUE_DOCK_GAP = 8;
  var QUEUE_DOCK_DEFAULT_BOTTOM = 24;
  var QUEUE_DOCK_DEFAULT_RIGHT = 24;

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function miniplayerRect() {
    try {
      var player = document.getElementById('movie_player');
      if (!player || !player.classList || !player.classList.contains('un-mini-docked-player')) return null;
      if (typeof player.getBoundingClientRect !== 'function') return null;
      var r = player.getBoundingClientRect();
      if (!r) return null;
      var w = r.width || (r.right - r.left);
      var h = r.height || (r.bottom - r.top);
      if (!(w > 0) || !(h > 0)) return null;
      return r;
    } catch (e) {
      return null;
    }
  }

  function applyDockPosition() {
    var dock = document.getElementById('un-queue-dock');
    if (!dock) return;
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
    var dockW = dock.offsetWidth || 180;
    var dockH = dock.offsetHeight || 44;
    var player = miniplayerRect();

    if (dockPos && typeof dockPos.left === 'number' && typeof dockPos.top === 'number') {
      var maxLeft = vw - dockW - 8;
      var maxTop = vh - dockH - 8;
      var clLeft = Math.max(8, Math.min(maxLeft, dockPos.left));
      var clTop = Math.max(8, Math.min(maxTop, dockPos.top));
      if (player) {
        var proposed = {
          left: clLeft,
          right: clLeft + dockW,
          top: clTop,
          bottom: clTop + dockH
        };
        if (rectsOverlap(proposed, player)) {
          var above = player.top - dockH - QUEUE_DOCK_GAP;
          var below = player.bottom + QUEUE_DOCK_GAP;
          if (above >= 8) clTop = above;
          else if (below + dockH <= vh - 8) clTop = below;
        }
      }
      dock.style.left = clLeft + 'px';
      dock.style.top = clTop + 'px';
      dock.style.right = 'auto';
      dock.style.bottom = 'auto';
      emitQueueDockChange();
      return;
    }

    dock.style.left = '';
    dock.style.top = '';
    dock.style.right = QUEUE_DOCK_DEFAULT_RIGHT + 'px';
    var bottom = QUEUE_DOCK_DEFAULT_BOTTOM;
    if (player) {
      var slot = {
        left: vw - QUEUE_DOCK_DEFAULT_RIGHT - dockW,
        right: vw - QUEUE_DOCK_DEFAULT_RIGHT,
        top: vh - QUEUE_DOCK_DEFAULT_BOTTOM - dockH,
        bottom: vh - QUEUE_DOCK_DEFAULT_BOTTOM
      };
      if (rectsOverlap(slot, player)) {
        bottom = Math.max(QUEUE_DOCK_DEFAULT_BOTTOM, Math.round(vh - player.top + QUEUE_DOCK_GAP));
      }
    }
    dock.style.bottom = bottom + 'px';
    emitQueueDockChange();
  }

  function emitQueueDockChange() {
    try {
      if (typeof window === 'undefined' || !window.dispatchEvent) return;
      // Report the UNION of every queue surface parked in the corner, not just
      // the dock. The flyout is a child of the dock but is positioned outside
      // its border box (bottom: 100% + 12px) and can be 440 x 480, so anything
      // clearing only the dock's own rect sails straight into it -- the
      // playlist bulk bar did exactly that: select on a playlist page, open
      // the queue, and the bar sat on top of the flyout's list. The finished
      // card occupies the same corner after the dock is gone and would have
      // reintroduced the identical collision.
      var dock = document.getElementById('un-queue-dock');
      var fly = document.getElementById('un-queue-flyout');
      var done = document.getElementById('un-queue-done');
      var parts = [dock];
      if (fly && flyoutOpen) parts.push(fly);
      parts.push(done);

      var r = null;
      for (var i = 0; i < parts.length; i++) {
        var el = parts[i];
        if (!el || typeof el.getBoundingClientRect !== 'function') continue;
        var b;
        try { b = el.getBoundingClientRect(); } catch (e) { continue; }
        if (!b || !b.width || !b.height) continue;
        r = r ? {
          top: Math.min(r.top, b.top),
          bottom: Math.max(r.bottom, b.bottom),
          left: Math.min(r.left, b.left),
          right: Math.max(r.right, b.right)
        } : { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      }

      var detail = { present: !!(dock || done) };
      if (r) {
        r.width = r.right - r.left;
        r.height = r.bottom - r.top;
        detail.rect = r;
      }
      window.dispatchEvent(new CustomEvent('un-queue-dock-change', { detail: detail }));
    } catch (e) {}
  }

  function makeDockDraggable(dock, handle) {
    if (!dock || !handle) return;
    var startX = 0, startY = 0, startLeft = 0, startTop = 0;
    var draggingThis = false;

    function onPointerMove(e) {
      if (!draggingThis) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) isDragging = true;
      var nextLeft = startLeft + dx;
      var nextTop = startTop + dy;
      var maxLeft = window.innerWidth - dock.offsetWidth - 8;
      var maxTop = window.innerHeight - dock.offsetHeight - 8;
      nextLeft = Math.max(8, Math.min(maxLeft, nextLeft));
      nextTop = Math.max(8, Math.min(maxTop, nextTop));
      dock.style.left = nextLeft + 'px';
      dock.style.top = nextTop + 'px';
      dock.style.right = 'auto';
      dock.style.bottom = 'auto';

      if (flyoutOpen) {
        var fly = document.getElementById('un-queue-flyout');
        if (fly) {
          var isTop = nextTop < (window.innerHeight / 2);
          var isLeft = nextLeft < (window.innerWidth / 2);
          fly.className = 'un-queue-flyout ' + (isTop ? 'fly-down ' : 'fly-up ') + (isLeft ? 'fly-left' : 'fly-right');
        }
      }
    }

    function onPointerUp(e) {
      if (!draggingThis) return;
      draggingThis = false;
      dock.classList.remove('is-dragging');
      try {
        if (handle.releasePointerCapture) handle.releasePointerCapture(e.pointerId);
      } catch (err) {}
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      var rect = dock.getBoundingClientRect();
      dockPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ unsynthQueueDockPos: dockPos });
        }
      } catch (err) {}

      setTimeout(function () { isDragging = false; }, 80);
    }

    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      // The minimal bubble is also the click-to-expand control. Don't
      // preventDefault there or the click never fires; drag still wins
      // once the pointer moves past 3px (isDragging).
      if ((' ' + (handle.className || '') + ' ').indexOf(' un-qd-mini-bubble ') === -1) {
        e.preventDefault();
      }
      var rect = dock.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      draggingThis = true;
      dock.classList.add('is-dragging');
      try {
        if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
      } catch (err) {}
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    });

    handle.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      dockPos = null;
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.remove('unsynthQueueDockPos');
        }
      } catch (err) {}
      applyDockPosition();
      if (flyoutOpen) {
        var fly = document.getElementById('un-queue-flyout');
        if (fly) {
          fly.className = 'un-queue-flyout fly-up fly-right';
        }
      }
      toast('Reset queue dock position');
    });
  }

  var doneCardTimer = null;

  function dismissFinishedCard(ack) {
    if (doneCardTimer) { clearTimeout(doneCardTimer); doneCardTimer = null; }
    var card = document.getElementById('un-queue-done');
    if (card) card.remove();
    emitQueueDockChange();
    if (!ack) return;
    var WQ = window.UNWatchQueue;
    if (WQ && WQ.clearProgress) WQ.clearProgress(function () {});
  }

  // An emptied queue used to just delete the dock, which is the exact same
  // pixels as the module being off, the dock never mounting, or the queue
  // breaking -- "it finished" and "it's broken" were indistinguishable.
  //
  // played >= total (with total > 0) is the ONLY progress state auto-advance
  // consuming the last item can produce: clear() zeroes both, and add() into
  // an empty queue resets played to 0, so a manual clear or a fresh queue
  // never trips it. Because it lives in chrome.storage.local it also survives
  // the navigation that consuming the last item performs -- module state does
  // not, which is why this is not driven off lastDockHash.
  //
  // Dismissing zeroes progress, so the card appears once per finished session
  // rather than on every subsequent page load.
  function maybeShowFinishedCard() {
    var WQ = window.UNWatchQueue;
    if (!WQ || !WQ.getProgress) return;
    WQ.getProgress(function (p) {
      if (!p || !(p.total > 0) || !(p.played > 0) || p.played < p.total) return;
      // Deduped here rather than before the read: several syncs can each
      // start a read before any of them appends, so the check has to happen
      // after the await, and a pre-read copy would only be a redundant branch.
      if (document.getElementById('un-queue-done')) return;
      // Re-check: an async add() may have landed a new item while the
      // storage read was in flight, in which case the dock is coming back
      // and a "finished" card would be a lie.
      if (document.getElementById('un-queue-dock')) return;
      if (core && core.isModuleEnabled && !core.isModuleEnabled(mod)) return;
      renderFinishedCard(p.played);
    });
  }

  function renderFinishedCard(played) {
    if (!document.body) return;
    var card = document.createElement('div');
    card.id = 'un-queue-done';
    card.className = 'un-queue-done';
    card.setAttribute('role', 'status');

    var tick = document.createElement('span');
    tick.className = 'un-qdone-tick';
    tick.textContent = '\u2713';
    tick.setAttribute('aria-hidden', 'true');

    var text = document.createElement('div');
    text.className = 'un-qdone-text';
    var head = document.createElement('strong');
    head.textContent = 'Queue finished';
    var sub = document.createElement('span');
    sub.textContent = played === 1 ? '1 video played' : played + ' videos played';
    text.appendChild(head);
    text.appendChild(sub);

    var close = document.createElement('button');
    close.className = 'un-qdone-x';
    close.type = 'button';
    close.textContent = '\u2715';
    close.title = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss queue finished notice');
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      dismissFinishedCard(true);
    });

    card.appendChild(tick);
    card.appendChild(text);
    card.appendChild(close);
    document.body.appendChild(card);
    emitQueueDockChange();

    // Long enough to read on landing after the navigation, short enough that
    // it is not parked in the corner for the rest of the session.
    //
    // Paused while the pointer or keyboard focus is on it: a flat timer takes
    // the card away from anyone reading at their own pace, and from anyone
    // tabbing toward the dismiss button, which is WCAG 2.2.1 (Timing
    // Adjustable). Restarted rather than resumed on leave, so the reader gets
    // a full window back rather than the remainder.
    // ONE engaged state, not two independent ones. Tracking hover and focus
    // separately meant either release re-armed the timer while the other was
    // still active: tab to the dismiss button, then let the cursor drift off
    // the card without moving focus, and mouseleave restarted the countdown
    // and took the card away with keyboard focus still on it -- exactly the
    // guarantee the pause exists to make.
    var hovering = false;
    var focused = false;
    var syncDismissTimer = function () {
      if (doneCardTimer) { clearTimeout(doneCardTimer); doneCardTimer = null; }
      if (hovering || focused) return;
      doneCardTimer = setTimeout(function () { dismissFinishedCard(true); }, 9000);
    };
    card.addEventListener('mouseenter', function () { hovering = true; syncDismissTimer(); });
    card.addEventListener('mouseleave', function () { hovering = false; syncDismissTimer(); });
    card.addEventListener('focusin', function () { focused = true; syncDismissTimer(); });
    card.addEventListener('focusout', function () { focused = false; syncDismissTimer(); });
    syncDismissTimer();
  }

  function syncQueueDock() {
    if (typeof document === 'undefined' || !document.getElementById || !document.createElement || !document.body) return;
    // The custom floating dock is retired. YouTube's native Up next panel is
    // the queue UI. Tear down any leftover dock from an older build.
    var leftover = document.getElementById('un-queue-dock');
    if (leftover) leftover.remove();
    closeFlyout();
    lastDockHash = '';
    emitQueueDockChange();
    // Everything below this point was ~290 lines of unreachable dock-building
    // code left behind when the dock was retired. Deleted rather than kept: it
    // could not run, and it made the retirement look like a temporary toggle.
    return;
  }

  // Click-outside, Escape, and the Alt+Q / Alt+N shortcuts.
  //
  // These were registered at PARSE TIME, outside init(), and never removed.
  // Disabling the Queue module therefore left Alt+N still popping the queue
  // and navigating the tab, and left the storage listener re-creating a dock
  // the user had just turned off. They are wired in init() and unwired in
  // teardown() now, so the module toggle actually turns the module off.
  var docClickHandler = function (e) {
    if (!flyoutOpen) return;
    // Ignore clicks this extension fired itself. ui-tune's disableAutoplay()
    // does `toggle.click()` on YouTube's own autoplay button, and eleven other
    // modules synthesise clicks for downloads, guide links and player controls.
    // Every one of those bubbles to document, lands outside this panel, and
    // read as a user dismissing it -- reordering the queue closed the flyout
    // roughly 300ms later, because a queue change re-ran the autoplay check.
    // A genuine user click is always isTrusted; a scripted one never is.
    if (e && e.isTrusted === false) return;
    var dock = document.getElementById('un-queue-dock');
    if (!dock || dock.contains(e.target)) return;
    // The per-item playlist menu is appended to <body>, not into the dock,
    // so a plain dock.contains() test reads every click inside it as an
    // outside click and tears the flyout down mid-selection. Treat the
    // menu as part of the flyout for dismissal purposes.
    if (e.target && e.target.closest && e.target.closest('.un-qf-pl-menu')) return;
    closeFlyout();
  };

  var docKeyHandler = function (e) {
    if (e.key === 'Escape' && flyoutOpen) {
      closeFlyout();
      return;
    }
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;

    // Alt+Q / Alt+N used to open the retired floating dock. YouTube's Up next
    // panel is the queue now; do not resurrect the custom widget.
  };

  var storageListener = function (ch, area) {
    if (area === 'local' && ch.unWatchQueue) {
      syncQueueDock();
    }
    if (area === 'sync' && ch.unWatchQueueSync && window.UNWatchQueue && window.UNWatchQueue.applyRemoteSync) {
      window.UNWatchQueue.applyRemoteSync(ch.unWatchQueueSync.newValue, function (updated) {
        if (updated) {
          syncQueueDock();
          toast('Queue synced from other device');
        }
      });
    }
  };

  var miniDockChangeListener = function () {
    applyDockPosition();
  };

  var mod = {
    id: 'queueAdvance',
    moduleKey: 'queueAdvance',
    init: function (c) {
      core = c;
      attach();
      syncQueueDock();
      // The handoff prefers SPA navigation, but falls back to a full page
      // load, which lands in init rather than onNavigate. Both call this; the
      // plan is cleared before the add, so running twice cannot double-queue.
      resumePendingFill();
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('click', docClickHandler, true);
        document.addEventListener('keydown', docKeyHandler, true);
      }
      try {
        // Also parse-time before: a queue write from any other module called
        // syncQueueDock() and re-created a dock the user had disabled.
        chrome.storage.onChanged.addListener(storageListener);
      } catch (e) {}
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('un-mini-dock-change', miniDockChangeListener);
      }
      // Adopt a newer queue from another device on load. chrome.storage.sync
      // pushes changes reactively while a tab is open, but a device that was
      // closed during the change never sees that event — and it only carries
      // the first ~26 items anyway. Pull once on init so a freshly opened
      // browser starts from the real queue rather than a stale local copy.
      // Best-effort: no account or no network simply leaves the local queue
      // as it is.
      try {
        var WQBoot = window.UNWatchQueue;
        if (WQBoot && typeof WQBoot.pullFromBackend === 'function') {
          WQBoot.pullFromBackend(function (changed) {
            if (changed) syncQueueDock();
          });
        }
      } catch (e) {
        /* queue still works from local storage */
      }
    },
    scan: function () {
      attach();
      // syncQueueDock() removed from scan — the chrome.storage.onChanged
      // listener (storageListener above) already triggers it reactively
      // when the queue changes. Calling it on every MutationObserver pass
      // caused redundant load+rebuild cycles.
    },
    onNavigate: function () {
      // New page — the old <video> may be reused or replaced; re-resolve it,
      // and clear the in-flight guard so the next video can advance too.
      advancing = false;
      attach();
      syncQueueDock();
      // A fill started from search or a channel finishes here, where the
      // queue can actually be written. Self-clearing and time-bounded.
      resumePendingFill();
    },
    onSettings: function (s) {
      core.settings = s;
      attach();
      syncQueueDock();
    },
    teardown: function () {
      detach();
      advancing = false;
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('click', docClickHandler, true);
        document.removeEventListener('keydown', docKeyHandler, true);
      }
      // A menu left open past teardown would keep a live Escape-stack entry
      // pointing at a handler in a module that is no longer running.
      closeFillMenu();
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('un-mini-dock-change', miniDockChangeListener);
      }
      if (typeof document !== 'undefined' && document.getElementById) {
        var dock = document.getElementById('un-queue-dock');
        if (dock) dock.remove();
        dismissFinishedCard(false);
        emitQueueDockChange();
      }
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
          chrome.storage.onChanged.removeListener(storageListener);
        }
      } catch (e) {}
    }
  };

  // Published so any surface with a list of videos can offer a bulk fill
  // without reimplementing the cap, the undo or the count. The sidebar hub's
  // catch-up digest is the first caller.
  window.UNQueueFill = { openMenu: openFillMenu, closeMenu: closeFillMenu };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
