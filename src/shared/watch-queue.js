'use strict';

/**
 * Extension watch queue (local storage). Complements YouTube's native queue when available.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UNWatchQueue = factory();
  }
})(typeof self !== 'undefined' ? self : this, function watchQueueFactory() {
  var KEY = 'unWatchQueue';
  var MAX = 500;

  // When the item entered the queue. Two things need it: the panel's age
  // readout, and the classifier below — which compares a video's WATCH date
  // against this one, so it can tell a video the user finished after queueing
  // it from one they deliberately re-queued after having watched it long ago.
  // Without this timestamp there is no way to tell those apart, and treating
  // them the same is what emptied a real user's queue (see classifyQueue).
  //
  // Preserved rather than re-stamped when it is already present, because
  // addToList() re-normalizes an item that is being MOVED (re-adding an id
  // already in the queue removes the old entry and re-inserts it). Re-stamping
  // there would make an item immortal: nudge it once a week and it never ages.
  // A missing/garbage value falls back to now — "unknown age" must read as
  // young, since treating it as 0 would date the item to 1970 and flag the
  // whole queue on its first pass.
  function stampedAt(item) {
    var v = Number(item && item.addedAt);
    return v > 0 && isFinite(v) ? v : Date.now();
  }

  // null (unknown) and 0 (a video that is entirely sponsor) are different
  // answers, so this cannot collapse to `Number(x) || 0`.
  function contentSecOf(item) {
    var raw = item && item.contentSec;
    if (raw === null || raw === undefined || raw === '') return null;
    var n = Number(raw);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function normalize(item) {
    if (!item || !item.id) return null;
    return {
      id: String(item.id),
      title: item.title || '',
      thumb: item.thumb || item.thumbnail || '',
      channel: item.channel || item.channelTitle || '',
      dur: item.dur != null ? item.dur : item.durationSec || 0,
      // Sponsor-adjusted runtime, when SponsorBlock data was available when the
      // item was queued. Kept SEPARATE from dur: the row badge must still show
      // YouTube's real runtime, while the "you'll finish at" estimate uses this.
      // null means "not known", which is not the same as 0 ("all sponsor") —
      // normalize() is a whitelist, so anything not named here is dropped.
      contentSec: contentSecOf(item),
      addedAt: stampedAt(item)
    };
  }

  // opts.toFront (default true) — insert at the front ("Play Next", the
  // original/only behavior) or the end ("Add to Queue"). Re-adding an id
  // that's already in the list removes the old entry first either way, so it
  // always ends up at the position implied by this call, not left in place.
  function addToList(list, item, opts) {
    var n = normalize(item);
    if (!n) return list || [];
    var toFront = !opts || opts.toFront !== false;
    // Re-adding an id already present MOVES it (see the filter below), and a
    // move must not reset the age clock — otherwise re-queueing an item once a
    // week keeps it looking fresh forever and it is never flagged stale.
    // The incoming item usually has no addedAt (it comes from a thumbnail
    // quick-action), so carry the existing one forward before dropping the old
    // entry. An explicit addedAt on the incoming item still wins: that is how
    // the undo restores an item at its original age rather than as brand new.
    if (!(Number(item && item.addedAt) > 0)) {
      var prior = null;
      (list || []).forEach(function (x) {
        if (x && x.id === n.id && Number(x.addedAt) > 0) prior = Number(x.addedAt);
      });
      if (prior) n.addedAt = prior;
    }
    var out = (list || []).filter(function (x) {
      return x && x.id !== n.id;
    });
    if (toFront) out.unshift(n);
    else out.push(n);
    if (out.length > MAX) {
      // Trim whichever end is farthest from the item that was just inserted —
      // trimming the same end you just inserted at would drop the item you
      // just added the moment the list is already full.
      if (toFront) out.length = MAX;
      else out.splice(0, out.length - MAX);
    }
    return out;
  }

  function removeFromList(list, videoId) {
    return (list || []).filter(function (x) {
      return x && x.id !== videoId;
    });
  }

  var SYNC_KEY = 'unWatchQueueSync';
  // Chrome's per-key ceiling is 8192 bytes. Leave real headroom rather than
  // riding the limit: the key name, JSON punctuation and any future field all
  // come out of the same budget.
  var SYNC_BYTE_BUDGET = 7600;
  var SYNC_MAX_ITEMS = 40;
  var _lastSyncError = null;

  function syncPayloadBytes(key, value) {
    try {
      return (key + JSON.stringify(value)).length;
    } catch (e) {
      return Infinity;
    }
  }
  var _syncTimer = null;
  var _lastSyncVersion = 0;
  // The last list this tab read from or wrote to storage. applyRemoteSync
  // takes it as the base when a payload arrives, and inside the lock merges
  // the local ADDS and REMOVES made since then onto the remote list (code
  // review #7): a blind overwrite lost local edits, and dropping the remote
  // (last writer wins) would lose the other device's. A pure reorder is not a
  // membership change, so the remote order stands.
  var _lastKnown = null;

  // Session progress ("2 of 5"). The queue itself only ever holds UPCOMING
  // items — onEnded() in queue-advance.js removes an item the moment it's
  // consumed, so there is no "already played" list to count from. Track a
  // separate played/total pair instead: total grows whenever new items are
  // queued from empty (a fresh session) or appended to a queue that's
  // already been fully depleted once, played increments only via
  // recordPlayed() — a deliberate, explicit call from the one real
  // consumption path (auto-advance), never inferred from a generic
  // remove() (which also fires for the user manually deleting a row, which
  // must NOT count as "played").
  var PROGRESS_KEY = 'unWatchQueueProgress';

  function getProgress(cb) {
    var fallback = { played: 0, total: 0 };
    if (safeGet({ unWatchQueueProgress: fallback }, function (d) {
      cb(d.unWatchQueueProgress || fallback);
    })) return;
    cb(fallback);
  }

  function setProgress(progress, cb) {
    if (safeSet({ unWatchQueueProgress: progress }, cb)) return;
    if (cb) cb();
  }

  // Called once, right when an item is popped for real playback (never for
  // a manual delete). listLengthBeforeRemoval is the queue length BEFORE
  // this item was taken off, i.e. how many items existed to be played
  // (this one + whatever's left) at the moment of consumption.
  function recordPlayed(listLengthBeforeRemoval, cb) {
    withQueueLock(function (done) {
      getProgress(function (p) {
        var played = p.played + 1;
        // total tracks the high-water mark of "played so far + still
        // queued" — this lets a queue that keeps growing (more videos
        // added mid-session) still report a sane total instead of the
        // count freezing at whatever it was when the session started.
        var total = Math.max(p.total, played + Math.max(0, listLengthBeforeRemoval - 1));
        setProgress({ played: played, total: total }, function () {
          if (cb) cb({ played: played, total: total });
          done();
        });
      });
    });
  }

  // Zeroing progress is what marks a finished session as acknowledged, so
  // the "queue finished" card shows once instead of on every later page
  // load. Kept separate from the internal setProgress() so callers can only
  // reset the counter, never forge an arbitrary played/total pair.
  function clearProgress(cb) {
    withQueueLock(function (done) {
      setProgress({ played: 0, total: 0 }, function () {
        if (cb) cb();
        done();
      });
    });
  }

  function compactItem(item) {
    if (!item || !item.id) return null;
    return {
      id: String(item.id).slice(0, 32),
      title: String(item.title || '').slice(0, 120),
      thumb: String(item.thumb || item.thumbnail || '').slice(0, 200),
      channel: String(item.channel || item.channelTitle || '').slice(0, 60),
      dur: Number(item.dur) || 0,
      // contentSec is deliberately NOT mirrored. It costs 23 bytes an item
      // against the 7600-byte per-key ceiling, measured at 35 items mirrored
      // without it and 32 with it on realistic titles — and the receiving device
      // can recompute it from its own SponsorBlock data anyway. Three more items
      // reaching the other device is worth more than a number that is cheap to
      // re-derive there.
      // Carried across the sync mirror on purpose. Dropping it would reset
      // every item's age to "now" on the receiving device, so a queue synced
      // between two machines would never flag anything on either of them.
      addedAt: stampedAt(item)
    };
  }

  function syncToCloud(list) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return;
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(function () {
      _syncTimer = null;
      try {
        var v = Date.now();
        _lastSyncVersion = v;
        // chrome.storage.sync caps a single key at QUOTA_BYTES_PER_ITEM
        // (8192 bytes). A flat 40-item slice fits only for SHORT titles: at
        // the field caps compactItem already allows (120-char title, 60-char
        // channel) 40 items serialises to ~11.8KB and the write is REJECTED —
        // and the old handler swallowed that error, so the queue silently
        // stopped syncing with no symptom on either device.
        //
        // Trim to fit the real byte budget instead of a guessed item count.
        var all = (list || []).map(compactItem).filter(Boolean);
        var compact = all.slice(0, SYNC_MAX_ITEMS);
        var payload = {};
        payload[SYNC_KEY] = { v: v, items: compact };
        while (compact.length > 1 && syncPayloadBytes(SYNC_KEY, payload[SYNC_KEY]) > SYNC_BYTE_BUDGET) {
          compact = compact.slice(0, compact.length - 1);
          payload[SYNC_KEY] = { v: v, items: compact };
        }
        chrome.storage.sync.set(payload, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            // Still rejected (quota across all keys, or sync disabled). The
            // local queue is unaffected; only cross-device mirroring is lost.
            _lastSyncError = String(chrome.runtime.lastError.message || 'sync failed');
          } else {
            _lastSyncError = null;
          }
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ unWatchQueueSyncMeta: { error: _lastSyncError, at: Date.now() } });
          }
        });
      } catch (e) {}

      // Backend mirror, in ADDITION to chrome.storage.sync rather than
      // instead of it. The two cover different failure modes:
      //   - chrome.storage.sync needs no account and no network, but caps a
      //     key at 8KB (~26 items with real titles) and only works in a
      //     signed-in Chrome.
      //   - the backend has neither cap, but needs a connected account and a
      //     reachable server.
      // Sending the FULL list here, not the trimmed one — the byte budget
      // above exists only for Chrome's transport.
      pushToBackend(all, v);
    }, 250);
  }

  /**
   * Best-effort backend push. Never throws into the caller and never touches
   * the local queue: a failed cloud mirror must not disturb the queue the
   * user is actually looking at.
   */
  function pushToBackend(items, version) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      chrome.runtime.sendMessage(
        { type: 'UNSYNTH/SYNC/QUEUE_PUSH', items: items || [], v: version || Date.now() },
        function (res) {
          // Reading lastError marks it handled; without this an unconnected
          // account logs an unchecked-error warning on every queue write.
          if (chrome.runtime.lastError) return;
          if (!res || !res.ok) return;
          // Another device had a newer queue. Adopt it rather than leaving
          // the two permanently disagreeing.
          if (res.stale && Array.isArray(res.items)) {
            applyRemoteSync({ v: res.v, items: res.items });
          }
        }
      );
    } catch (e) {
      /* backend mirroring is optional */
    }
  }

  /** Pull the backend queue and adopt it if it is newer than what we hold. */
  function pullFromBackend(cb) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        if (cb) cb(false);
        return;
      }
      chrome.runtime.sendMessage({ type: 'UNSYNTH/SYNC/QUEUE_PULL' }, function (res) {
        if (chrome.runtime.lastError) {
          if (cb) cb(false);
          return;
        }
        if (!res || !res.ok || !Array.isArray(res.items)) {
          if (cb) cb(false);
          return;
        }
        applyRemoteSync({ v: res.v, items: res.items }, cb);
      });
    } catch (e) {
      if (cb) cb(false);
    }
  }

  /**
   * Remote list plus the local membership edits made since `base`. Items the
   * local side ADDED (in current, not in base) are kept at the front in their
   * local order, the default place an add puts them; items it REMOVED (in
   * base, not in current) stay removed. With no base (first sync), remote wins.
   */
  function mergeLocalEdits(base, current, remote) {
    if (!base) return remote;
    var id = function (x) { return x && x.id; };
    var baseIds = {}; base.forEach(function (x) { baseIds[id(x)] = 1; });
    var curIds = {}; current.forEach(function (x) { curIds[id(x)] = 1; });
    var removed = {}; base.forEach(function (x) { if (!curIds[id(x)]) removed[id(x)] = 1; });
    var out = remote.filter(function (x) { return !removed[id(x)]; });
    var have = {}; out.forEach(function (x) { have[id(x)] = 1; });
    var added = current.filter(function (x) { return !baseIds[id(x)] && !have[id(x)]; });
    return added.concat(out).slice(0, MAX);
  }

  function applyRemoteSync(syncPayload, cb) {
    if (!syncPayload || !Array.isArray(syncPayload.items)) {
      if (cb) cb(false);
      return;
    }
    if (syncPayload.v && syncPayload.v <= _lastSyncVersion) {
      if (cb) cb(false);
      return;
    }
    _lastSyncVersion = syncPayload.v || Date.now();
    var list = syncPayload.items.map(normalize).filter(Boolean);
    var base = _lastKnown ? _lastKnown.slice() : null;
    // This used to chrome.storage.local.set() directly, outside withQueueLock
    // — a remote sync payload arriving (chrome.storage.onChanged fires this
    // independently, e.g. mid-drag while the user is reordering the queue
    // locally) could land between another mutator's load() and save(), so
    // either the sync write got silently clobbered by the in-flight local
    // save(), or the local change got clobbered by this write landing after
    // it. Route through the same lock every other mutator uses so a remote
    // sync application is a real read-modify-write step, not a bare
    // overwrite racing everything else.
    withQueueLock(function (done) {
      load(function (current) {
        var merged = mergeLocalEdits(base, current || [], list);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ unWatchQueue: merged }, function () {
            _lastKnown = merged.slice();
            if (cb) cb(true, merged);
            done();
          });
          return;
        }
        if (cb) cb(true, merged);
        done();
      });
    });
  }

  // chrome.storage throws synchronously once the extension context is gone.
  // Swallowing it HERE as well as in _runNext matters: an uncaught throw skips
  // the callback, and every caller in this file signals completion from inside
  // that callback, so the work silently never happens even with the lock freed.
  // A read that fails yields the default; a write that fails still calls back.
  function safeGet(defaults, cb) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        // The caller's callback is deliberately NOT inside this try. Wrapping
        // it turns any bug downstream into a silent partial failure: a stack
        // overflow in a long restore chain vanished here and truncated the
        // restore by a different amount on every run, with nothing logged.
        // This guard exists for context invalidation, which throws from the
        // chrome.* call itself, not from the callback.
        chrome.storage.local.get(defaults, function (d) { cb(d || defaults); });
        return true;
      }
    } catch (e) { /* fall through */ }
    return false;
  }

  // Passes chrome.runtime.lastError THROUGH to the callback. It used to call
  // cb() with no arguments no matter what, so a rejected write (QUOTA_BYTES,
  // storage unavailable, MAX_WRITE_OPERATIONS_PER_MINUTE) was indistinguishable
  // from a saved one: the queue kept rendering from an in-memory list that no
  // longer matched disk, and the items vanished on the next reload with nothing
  // logged. That is the mechanism behind a real reported incident of a queue
  // silently losing its contents.
  //
  // The callback must still FIRE on failure. Every mutator in this file signals
  // completion from inside it, so withholding it strands the caller and holds
  // the serialization lock forever (see save() below). Report the error, do not
  // swallow the callback.
  function safeSet(obj, cb) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(obj, function () {
          var err = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || null;
          if (cb) cb(err);
        });
        return true;
      }
    } catch (e) { /* fall through */ }
    return false;
  }

  function load(cb) {
    if (safeGet({ unWatchQueue: [] }, function (d) { _lastKnown = (d.unWatchQueue || []).slice(); cb(d.unWatchQueue || []); })) return;
    cb([]);
  }

  function save(list, cb) {
    if (safeSet({ unWatchQueue: list || [] }, function (err) {
      // Only mirror to the cloud when the local write actually landed —
      // pushing a list that failed to persist would make the two disagree.
      if (!err) { _lastKnown = (list || []).slice(); syncToCloud(list); }
      if (cb) cb(err);
    })) return;
    // Reached when storage is unavailable OR has started throwing. The
    // callback still fires: every mutator in this file signals completion from
    // inside it, so skipping it strands the caller and, before _runNext
    // learned to catch, held the lock forever.
    //
    // Two different cases land here. No storage API at all (a page context,
    // the unit tests) is an in-memory queue: that was always a success. A
    // storage API that exists but THREW (context invalidated) wrote nothing,
    // so it reports an error instead of the false success the review flagged.
    var hasStorage = false;
    try { hasStorage = !!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local); } catch (e) { hasStorage = true; }
    if (!hasStorage) {
      syncToCloud(list);
      if (cb) cb();
      return;
    }
    if (cb) cb(new Error('storage unavailable'));
  }

  // Every mutator below used to do its own unlocked load() -> mutate ->
  // save() straight against chrome.storage.local. The queue panel's
  // up/down/remove buttons, the "Add to Queue" thumbnail quick-actions, and
  // queue-advance.js's auto-remove-on-video-end can all fire in quick
  // succession (a user double-clicking a reorder arrow is enough) — two
  // overlapping calls both read the same pre-mutation list and the second
  // call's save() silently discards whatever the first call's save() wrote.
  //
  // A plain promise-chain (_chain.then(...)) would fix that but always
  // defers via a microtask, even when nothing is in flight — that broke an
  // existing, intentional contract: load()/save() resolve SYNCHRONOUSLY in
  // this test environment (chrome undefined), and callers rely on a
  // mutator's callback having already fired by the time the call returns.
  // A busy-flag + manual queue instead runs the first call fully
  // synchronously when uncontended (the common case) and only queues a
  // call that arrives while one is already in flight.
  var _busy = false;
  var _queue = [];
  function _runNext() {
    if (_busy) return;
    var job = _queue.shift();
    if (!job) return;
    _busy = true;
    // Releasing is idempotent and exception-proof, because BOTH failures wedge
    // the queue permanently rather than noisily:
    //
    //  * A synchronous throw. chrome.storage throws "Extension context
    //    invalidated" the moment the extension updates under an open tab --
    //    a routine event, and the reason watch-history.js has guardCtx. Nothing
    //    here caught it, so _busy stayed true for the life of the page and
    //    every later add / remove / recordPlayed queued behind a lock that
    //    would never open. The queue simply stopped working, with no error.
    //  * A job calling done() twice, which would run the next job twice and
    //    let two writers interleave -- the exact corruption this lock exists
    //    to prevent.
    var released = false;
    var release = function () {
      if (released) return;
      released = true;
      _busy = false;
      _runNext();
    };
    try {
      job(release);
    } catch (e) {
      release();
    }
  }
  function withQueueLock(fn) {
    _queue.push(fn);
    _runNext();
  }

  // Adding into an EMPTY queue is always a fresh session — reset played:0
  // so "X of Y" starts over instead of carrying a stale played count from
  // a queue the user finished or cleared earlier. Adding into a non-empty
  // queue just extends the running total (handled by recordPlayed's
  // high-water-mark logic), no reset.
  function maybeResetProgress(wasEmpty, newTotal, cb) {
    if (!wasEmpty) { cb(); return; }
    setProgress({ played: 0, total: newTotal }, cb);
  }

  function add(item, cb, opts) {
    withQueueLock(function (done) {
      load(function (list) {
        var wasEmpty = !list || !list.length;
        var next = addToList(list, item, opts);
        save(next, function (err) {
          // A failed write reports what is actually stored, plus the error
          // (code review #5: it used to report the new list as if saved).
          if (err) {
            var kept = list || [];
            if (cb) cb(kept.length, kept, err);
            done();
            return;
          }
          maybeResetProgress(wasEmpty, next.length, function () {
            if (cb) cb(next.length, next);
            done();
          });
        });
      });
    });
  }

  function addMany(items, cb, opts) {
    withQueueLock(function (done) {
      load(function (list) {
        var wasEmpty = !list || !list.length;
        var next = list || [];
        var toFront = !opts || opts.toFront !== false;
        var arr = (items || []).slice();
        // capToMax: drop what will not fit INSIDE the lock, rather than
        // letting addToList's overflow trim run. That trim removes from the
        // front -- the end nearest to playing -- so a restore into a near-full
        // queue would evict the videos about to play in favour of the ones
        // being put back. The caller cannot pre-compute this safely: reading
        // the length outside the lock leaves a storage round-trip in which
        // another add can land.
        var fitted = arr.length;
        if (opts && opts.capToMax) {
          arr = arr.slice(0, Math.max(0, MAX - next.length));
          fitted = arr.length;
        }
        // addToList always inserts one item at a time. Front-inserting in input
        // order would reverse the batch (unshifting A then B puts B before A) —
        // reverse the input first so the front-insert loop restores the
        // original order at the front. Appending already preserves order as-is.
        if (toFront) arr.reverse();
        arr.forEach(function (item) {
          next = addToList(next, item, opts);
        });
        save(next, function (err) {
          if (err) {
            var kept = list || [];
            // Nothing landed: report the stored list, 0 fitted, and why.
            if (cb) cb(kept.length, kept, 0, err);
            done();
            return;
          }
          maybeResetProgress(wasEmpty, next.length, function () {
            // Third argument is how many of `items` actually landed, which
            // differs from items.length only under capToMax.
            if (cb) cb(next.length, next, fitted);
            done();
          });
        });
      });
    });
  }

  function remove(videoId, cb) {
    withQueueLock(function (done) {
      load(function (list) {
        var next = removeFromList(list, videoId);
        save(next, function (err) {
          if (err) {
            var kept = list || [];
            if (cb) cb(kept.length, kept, err);
            done();
            return;
          }
          if (cb) cb(next.length, next);
          done();
        });
      });
    });
  }

  function clear(cb) {
    withQueueLock(function (done) {
      save([], function () {
        setProgress({ played: 0, total: 0 }, function () {
          if (cb) cb();
          done();
        });
      });
    });
  }

  function reorderList(list, videoId, toIndex) {
    var idx = -1;
    for (var i = 0; i < (list || []).length; i++) {
      if (list[i] && list[i].id === videoId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return list || [];
    var item = list[idx];
    var next = list.slice();
    next.splice(idx, 1);
    var ti = Math.max(0, Math.min(toIndex, next.length));
    next.splice(ti, 0, item);
    return next;
  }

  function move(videoId, delta, cb) {
    withQueueLock(function (done) {
      load(function (list) {
        var idx = -1;
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === videoId) {
            idx = i;
            break;
          }
        }
        if (idx < 0) {
          if (cb) cb(0, list);
          done();
          return;
        }
        var next = reorderList(list, videoId, idx + delta);
        save(next, function () {
          if (cb) cb(next.length, next);
          done();
        });
      });
    });
  }

  // Absolute-target-index reorder (drag-and-drop drop-onto-row), unlike
  // move()'s relative delta. Re-reads the list fresh inside the lock rather
  // than trusting a caller-supplied list — the flyout panel's rendered
  // snapshot can go stale between render and drop (any other queue mutation
  // firing in between), and reordering against a stale snapshot then saving
  // it directly used to silently clobber whatever changed in the meantime.
  function moveToIndex(videoId, toIndex, cb) {
    withQueueLock(function (done) {
      load(function (list) {
        var next = reorderList(list, videoId, toIndex);
        save(next, function () {
          if (cb) cb(next.length, next);
          done();
        });
      });
    });
  }

  // Default age at which an unwatched queued item is considered abandoned.
  // A week is long enough that "I'll get to it tonight" still holds, and short
  // enough that the queue stays a staging area instead of silting up into a
  // second Watch Later. Configurable via settings.watchQueue.staleDays.
  var DEFAULT_STALE_DAYS = 7;

  /**
   * Resolve when a video was watched, or null when that cannot be established.
   *
   * Returning null is not a failure mode, it is the SAFE answer, and callers
   * are required to treat it as "not watched". Three sources, in order:
   *
   *   watchedDates[id]        a real observation — either recorded live by
   *                           watch-history.js when the video finished, or
   *                           scraped off YouTube's own history page. Stored
   *                           either as epoch ms or as a 'YYYY-MM-DD' day from
   *                           the Takeout importer, so both are accepted.
   *   watchedDatesApprox[id]  a marker saying the matching date is INVENTED.
   *                           watch-history.js backfills a watched id that has
   *                           no date with Date.now() and flags it here. That
   *                           stamp always reads as "just now", so it would
   *                           always look later than the queue add and would
   *                           re-create the exact incident this guards against.
   *                           An approximate date is therefore no date at all.
   *   nothing                 null. Membership in watchedVideos on its own
   *                           proves the video was watched at SOME point, and
   *                           says nothing about when. That is the ambiguity
   *                           that cost a user their queue.
   */
  function watchedAt(id, dates, approx) {
    if (!id || !dates) return null;
    if (approx && approx[id]) return null;
    var raw = dates[id];
    if (raw == null || raw === '') return null;
    var n = Number(raw);
    if (n > 0 && isFinite(n)) return n;
    // A 'YYYY-MM-DD' day string from the Takeout import. Date.parse treats a
    // bare date as UTC midnight, which is the start of that day — the earliest
    // moment it could have been watched, so it errs toward "before the queue
    // add" and therefore toward keeping the item.
    var parsed = Date.parse(String(raw));
    return isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  /**
   * Classify a queue into what looks fine and what is worth FLAGGING. PURE: no
   * storage, no network, and no clock of its own (opts.now is supplied) so it
   * is testable and so one pass judges every item against the same instant.
   *
   * ---------------------------------------------------------------------
   * This function decides what to SHOW. It never decides what to remove.
   * ---------------------------------------------------------------------
   * An earlier design (commit 39b5df3, reverted in 61dc779) ran this
   * classification automatically when the queue flyout opened and deleted
   * tiers 1 and 2 on the spot. On a real profile it emptied a four-item queue
   * on its first run, silently, with an undo toast that expired unseen. Nothing
   * removes a queue item now except a click on a button that names the count
   * and shows the titles first. test/queue-flags.test.js asserts that
   * structurally, not by convention.
   *
   * Three tiers, ordered by how certain we are the item is unwanted:
   *   1. `watched`     — finished AFTER it was queued (see watchedAt). The one
   *                      tier the user can clear outright, because a video
   *                      they finished after queueing it is done.
   *   2. `unavailable` — deleted / private / region-locked. It can never play.
   *   3. `stale`       — sat here longer than staleDays and NOT watched. The
   *                      UNCERTAIN case: the user may still want it, so the UI
   *                      rescues these to a playlist rather than deleting.
   *
   * A watched-or-unavailable item that is ALSO stale falls in the earlier tier:
   * rescuing a video the user already finished (or one that is deleted) fills
   * the rescue playlist with exactly the noise this feature removes.
   *
   * @param {Array} list queue items
   * @param {Object} opts { now, staleDays, watchedThreshold, progress, watched,
   *                        watchedDates, watchedDatesApprox, unavailable }
   * @returns {{keep:Array, watched:Array, unavailable:Array, stale:Array}}
   */
  function classifyQueue(list, opts) {
    opts = opts || {};
    var out = { keep: [], watched: [], unavailable: [], stale: [] };
    var arr = list || [];
    if (!arr.length) return out;

    var now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
    var days = Number(opts.staleDays);
    if (!(days > 0)) days = DEFAULT_STALE_DAYS;
    var maxAgeMs = days * 24 * 60 * 60 * 1000;

    // Clamped the same way watch-history.js's fullPct() clamps it, so the two
    // can never disagree about what "watched" means.
    var thresh = Number(opts.watchedThreshold);
    if (!(thresh >= 50 && thresh <= 95)) thresh = 75;

    var progress = opts.progress || {};
    var dates = opts.watchedDates || {};
    var approx = opts.watchedDatesApprox || {};
    // Sets, not arrays: a 500-item queue against a watched set in the tens of
    // thousands (a full Takeout import) is a quadratic scan otherwise.
    var watchedSet = Object.create(null);
    (opts.watched || []).forEach(function (id) { watchedSet[id] = true; });
    var goneSet = Object.create(null);
    (opts.unavailable || []).forEach(function (id) { goneSet[id] = true; });

    arr.forEach(function (it) {
      if (!it || !it.id) return;
      var id = it.id;
      var added = Number(it.addedAt);
      var hasAge = added > 0 && isFinite(added);

      // Tier 1. Two independent claims that the video was watched — membership
      // in watchedVideos, or watchProgress past the threshold (watch-history.js
      // promotes an id OUT of the progress map and INTO the set once it crosses
      // the line, so both have to be read). Neither claim carries a time, so
      // both are gated on the same question: did the watch happen AFTER the
      // item was queued?
      //
      // A watch BEFORE the queue add is the deliberate re-queue case: the user
      // saw it once and put it back on purpose. Removing that is the incident.
      // No usable watch date, or no queue timestamp to compare against, means
      // the question is unanswerable — and unanswerable means KEEP.
      var claimsWatched = !!watchedSet[id] || Number(progress[id]) >= thresh;
      if (claimsWatched) {
        var seenAt = watchedAt(id, dates, approx);
        if (seenAt != null && hasAge && seenAt >= added) {
          out.watched.push(it);
          return;
        }
        // Falls through on purpose. It is not "finished" as far as we can
        // prove, so it is treated as any other unwatched item — which means it
        // can still be flagged stale below, and stale is rescued, not deleted.
      }

      // Tier 2.
      if (goneSet[id]) {
        out.unavailable.push(it);
        return;
      }

      // Tier 3. An item with NO addedAt is deliberately kept: its age is
      // unknown, and unknown must read as "too young to judge". The v6
      // migration stamps existing items, but a row arriving over sync from a
      // device that has not migrated yet can still land here. A FUTURE addedAt
      // (clock skew between two synced machines) reads as young for the same
      // reason — now - added is negative, so the comparison below rejects it.
      if (hasAge && (now - added) > maxAgeMs) {
        out.stale.push(it);
        return;
      }

      out.keep.push(it);
    });

    return out;
  }

  function shuffleList(list, tasteRankFn) {
    if (!list || list.length <= 1) return list || [];
    var arr = list.slice();
    if (typeof tasteRankFn === 'function') {
      arr.sort(function (a, b) {
        var scoreA = Number(tasteRankFn(a)) || 0;
        var scoreB = Number(tasteRankFn(b)) || 0;
        var noiseA = Math.random() * 0.4 - 0.2;
        var noiseB = Math.random() * 0.4 - 0.2;
        return (scoreB + noiseB) - (scoreA + noiseA);
      });
    } else {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
      }
    }
    return arr;
  }

  function shuffle(cb, tasteRankFn) {
    withQueueLock(function (done) {
      load(function (list) {
        var next = shuffleList(list, tasteRankFn);
        save(next, function () {
          if (cb) cb(next.length, next);
          done();
        });
      });
    });
  }

  return {
    KEY: KEY,
    SYNC_KEY: SYNC_KEY,
    PROGRESS_KEY: PROGRESS_KEY,
    MAX: MAX,
    normalize: normalize,
    addToList: addToList,
    removeFromList: removeFromList,
    reorderList: reorderList,
    shuffleList: shuffleList,
    classifyQueue: classifyQueue,
    compactItem: compactItem,
    DEFAULT_STALE_DAYS: DEFAULT_STALE_DAYS,
    load: load,
    save: save,
    syncToCloud: syncToCloud,
    applyRemoteSync: applyRemoteSync,
    pullFromBackend: pullFromBackend,
    syncStatus: function () {
      return { lastSyncError: _lastSyncError };
    },
    add: add,
    addMany: addMany,
    remove: remove,
    clear: clear,
    move: move,
    moveToIndex: moveToIndex,
    shuffle: shuffle,
    getProgress: getProgress,
    recordPlayed: recordPlayed,
    clearProgress: clearProgress
  };
});
