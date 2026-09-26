/**
 * Quick switcher (Shift+P by default) — playlists AND subscribed channels.
 *
 * 87 playlists (2 pinned) and 606 subscriptions across three groups. Reaching
 * any of them means loading /feed/playlists or the guide and scrolling. This is
 * the command-palette answer: one keystroke, type three letters, Enter.
 *
 * The two halves come from genuinely separate stores — plFolderStore holds
 * "PL…" ids, subStore.groups holds "channel:UC…" / "@handle" keys — and
 * playlist-folders.js already carries a comment about that confusion having
 * happened before. So the user's Main / Night / Streamers are SUBSCRIPTION
 * groups: typing "Night" answers with channels, not playlists. See
 * src/shared/playlist-index.js for the union and the ranking rule.
 *
 * The binding is NOT ctrl+k, which is what this shipped as first. Chrome
 * consumes ctrl+k for address-bar search, so the keydown never reached the page
 * and the feature was unreachable in the browser it targets — the module was
 * fine, the chord was not. See the default in defaults.js; it is rebindable
 * from the dashboard shortcuts table.
 *
 * Data comes from src/shared/playlist-index.js, which unions the cached
 * UNSYNTH/YT/PLAYLISTS_MINE answer with the folder store and the pin store.
 * The union matters: the API list needs OAuth and a five-minute round trip, so
 * a switcher that waited for it would be empty exactly when you pressed the
 * key. It opens on cache and folders instantly and refreshes behind you.
 *
 * The overlay follows watch-history.js's toggleWatchedMenu(): Escape through
 * the shared LIFO panel stack so only the topmost surface closes, an
 * outside-click dismiss that ignores synthetic clicks (twelve modules in this
 * extension fire clicks that bubble to document — see
 * test/dismiss-synthetic-click.test.js), and every listener removed on close.
 */
(function () {
  'use strict';

  var core = null;
  var bound = false;

  var PI = typeof window !== 'undefined' ? window.UNPlaylistIndex : null;
  var PF = typeof window !== 'undefined' ? window.UNPlaylistFolders : null;
  // Avatar builder shared with sidebar-hub.js — same cache, same fallback.
  var SCT = typeof window !== 'undefined' ? window.UNSubChannelThumbs : null;
  var M_PLAYLISTS_MINE = 'UNSYNTH/YT/PLAYLISTS_MINE';

  var OVERLAY_ID = 'un-qs-overlay';
  var INPUT_ID = 'un-qs-input';

  // Live state while the overlay is open.
  var index = [];
  var results = [];
  var recents = [];
  var selected = 0;
  var restoreFocus = null;
  var refreshing = false;

  // Listener handles, so close() can unwire exactly what open() wired.
  var docClick = null;
  var escHandle = null;
  var keyFallback = null;
  var trapHandler = null;

  function prefs() {
    return (core && core.settings && core.settings.shortcuts) || {};
  }

  function binding() {
    var b = prefs().quickSwitcher;
    return typeof b === 'string' ? b.toLowerCase() : '';
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!el.isContentEditable;
  }

  /**
   * Same shape as shortcuts.js eventCombo, with one difference: meta is folded
   * into ctrl. A Mac user pressing Cmd and a Windows user pressing Ctrl mean
   * the same thing, so a binding written either way matches either key. (The
   * shipped default is shift-only, but a user may rebind to a ctrl/cmd chord
   * the browser does not reserve, and that must work on both platforms.)
   */
  function comboOf(e) {
    var parts = [];
    if (e.shiftKey) parts.push('shift');
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    parts.push(String(e.key || '').toLowerCase());
    return parts.join('+');
  }

  function normalizeBinding(b) {
    return String(b || '')
      .toLowerCase()
      .split('+')
      .map(function (p) {
        return p === 'meta' || p === 'cmd' ? 'ctrl' : p;
      })
      .filter(function (p, i, all) {
        return all.indexOf(p) === i;
      })
      .join('+');
  }

  // ---- data ---------------------------------------------------------------

  function readStores(cb) {
    var want = {
      plFolderStore: PF ? PF.empty() : { folders: {}, names: {} },
      plPins: PF ? PF.emptyPins() : { ids: [], names: {} },
      // Subscriptions, for the channel half of the index. subStore is written
      // by sub-manager.js and is on disk for every user with groups — which is
      // why a cold playlist cache still opens onto something useful.
      subStore: { groups: {}, names: {} },
      // Avatars, so a channel row looks like a channel rather than another
      // line of text. Same cache the sidebar hub renders from.
      subChannelThumbs: {}
    };
    want[PI.CACHE_KEY] = null;
    want[PI.RECENT_KEY] = [];
    function fallback() {
      cb({ playlists: [] }, want.plFolderStore, want.plPins, [], want.subStore, want.subChannelThumbs);
    }
    try {
      chrome.storage.local.get(want, function (d) {
        if (chrome.runtime.lastError || !d) {
          fallback();
          return;
        }
        cb(
          d[PI.CACHE_KEY] || { playlists: [] },
          d.plFolderStore || want.plFolderStore,
          PF && PF.normalizePins ? PF.normalizePins(d.plPins) : d.plPins || want.plPins,
          Array.isArray(d[PI.RECENT_KEY]) ? d[PI.RECENT_KEY] : [],
          d.subStore || want.subStore,
          d.subChannelThumbs || want.subChannelThumbs
        );
      });
    } catch (e) {
      fallback();
    }
  }

  /**
   * Refresh the cached API list. Never blocks opening: the overlay is already
   * on screen showing whatever was on disk, and this repaints it if the answer
   * differs. A failure is silent by design — an unauthorised profile still has
   * pins and folders, and an error banner over a working list would be noise.
   */
  function refreshCache(onDone) {
    if (refreshing) return;
    refreshing = true;
    var settled = false;
    var finish = function (playlists) {
      if (settled) return;
      settled = true;
      refreshing = false;
      if (!playlists) {
        if (onDone) onDone(false);
        return;
      }
      var payload = {};
      payload[PI.CACHE_KEY] = { playlists: playlists, at: Date.now() };
      try {
        chrome.storage.local.set(payload);
      } catch (e) {
        /* a cache write failing must not break the open overlay */
      }
      if (onDone) onDone(true);
    };
    var timer = setTimeout(function () {
      finish(null);
    }, 20000);
    try {
      chrome.runtime.sendMessage({ type: M_PLAYLISTS_MINE }, function (r) {
        clearTimeout(timer);
        if (chrome.runtime.lastError || !r || !r.ok || !Array.isArray(r.playlists)) {
          finish(null);
          return;
        }
        finish(r.playlists);
      });
    } catch (e) {
      clearTimeout(timer);
      finish(null);
    }
  }

  // ---- rendering ----------------------------------------------------------

  function overlayEl() {
    return document.getElementById(OVERLAY_ID);
  }

  function inputEl() {
    return document.getElementById(INPUT_ID);
  }

  function rowId(i) {
    return 'un-qs-row-' + i;
  }

  /**
   * What the index actually holds, said accurately.
   *
   * The old copy read "Searching N playlists by title and folder" and, when
   * empty, "Connect YouTube on the dashboard, or pin a playlist". Once
   * channels joined the index both lines lie: the first calls 606
   * subscriptions playlists, and the second tells a user with a full
   * subscription list that they have nothing. Channels come from local
   * storage and are present without any OAuth, so the "connect" advice only
   * belongs when there is genuinely nothing at all.
   */
  function countLabel() {
    var pl = 0;
    var ch = 0;
    index.forEach(function (r) {
      if (r.kind === 'channel') ch++;
      else pl++;
    });
    if (!pl && !ch) {
      return 'Connect YouTube on the dashboard, pin a playlist, or set up subscription groups to fill this list.';
    }
    var parts = [];
    if (pl) parts.push(pl === 1 ? '1 playlist' : pl + ' playlists');
    if (ch) parts.push(ch === 1 ? '1 channel' : ch + ' channels');
    return 'Searching ' + parts.join(' and ') + ' by name, folder and group.';
  }

  function renderList() {
    var root = overlayEl();
    if (!root) return;
    var list = root.querySelector('.un-qs-list');
    var empty = root.querySelector('.un-qs-empty');
    var count = root.querySelector('.un-qs-count');
    var input = inputEl();
    if (!list) return;

    list.textContent = '';

    if (!results.length) {
      list.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = '';
        var line = document.createElement('div');
        var q = input ? input.value.trim() : '';
        if (q) {
          line.appendChild(document.createTextNode('No playlist matches '));
          var b = document.createElement('b');
          b.textContent = q;
          line.appendChild(b);
        } else {
          line.textContent = 'No playlists found yet.';
        }
        empty.appendChild(line);
        var sub = document.createElement('div');
        sub.className = 'un-qs-empty-sub';
        sub.textContent = countLabel();
        empty.appendChild(sub);
      }
      if (count) count.textContent = '';
      if (input) input.setAttribute('aria-activedescendant', '');
      announce(q ? 'No matches' : 'No playlists');
      return;
    }

    if (empty) empty.hidden = true;
    list.hidden = false;

    results.forEach(function (r, i) {
      var li = document.createElement('li');
      li.setAttribute('role', 'presentation');

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'un-qs-row';
      btn.id = rowId(i);
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', i === selected ? 'true' : 'false');
      btn.tabIndex = -1;
      if (r.matchedFolder) btn.dataset.via = 'folder';
      btn.dataset.plid = r.id;
      // The two row types must not look identical. data-kind carries it for
      // CSS (and for any audit that would otherwise have to parse text).
      btn.dataset.kind = r.kind || 'playlist';

      if (r.kind === 'channel') {
        // A real avatar, built by the SAME helper the sidebar hub uses, which
        // already handles the lazy <img>, the alt text and the fall back to an
        // initial when the image 404s. Reimplementing it here would be a
        // second thing to keep in sync.
        var initial = (r.title || '?').replace(/^@/, '').charAt(0).toUpperCase() || '?';
        var avatar = SCT
          ? SCT.mkAvatar({
              className: 'un-qs-avatar',
              label: r.title,
              initial: initial,
              thumbUrl: r.thumb
            })
          : (function () {
              var el = document.createElement('span');
              el.className = 'un-qs-avatar';
              el.textContent = initial;
              return el;
            })();
        avatar.setAttribute('aria-hidden', 'true');
        btn.appendChild(avatar);
      } else if (r.pinned) {
        var pin = document.createElement('span');
        pin.className = 'un-qs-pin';
        pin.textContent = '●';
        // The dot means "pinned to your sidebar" and a dot cannot say that.
        pin.setAttribute('aria-label', 'pinned');
        pin.title = 'Pinned to the sidebar';
        btn.appendChild(pin);
      } else {
        // Keeps every playlist title on the same left edge whether or not it
        // is pinned; without it the pinned rows sit one glyph to the right and
        // the column reads as ragged.
        var spacer = document.createElement('span');
        spacer.className = 'un-qs-pin un-qs-pin-blank';
        spacer.setAttribute('aria-hidden', 'true');
        btn.appendChild(spacer);
      }

      var title = document.createElement('span');
      title.className = 'un-qs-title';
      title.textContent = r.title;
      btn.appendChild(title);

      if (r.folder) {
        var f = document.createElement('span');
        f.className = 'un-qs-folder';
        f.textContent = r.folder;
        btn.appendChild(f);
      }

      if (r.hasCount) {
        var n = document.createElement('span');
        n.className = 'un-qs-num';
        n.textContent = r.count === 1 ? '1 video' : r.count + ' videos';
        btn.appendChild(n);
      }

      // Announced as one sentence rather than four fragments, so a screen
      // reader does not read "● Ambient Focus Main 42 videos".
      btn.setAttribute(
        'aria-label',
        r.title +
          // Sighted users get an avatar vs a dot; this is the same information
          // for anyone listening, and it disambiguates a channel and a
          // playlist that share a name.
          (r.kind === 'channel' ? ', channel' : ', playlist') +
          (r.folder ? ', in ' + r.folder : '') +
          (r.hasCount ? ', ' + r.count + (r.count === 1 ? ' video' : ' videos') : '') +
          (r.pinned ? ', pinned' : '')
      );

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openRow(r.id, r.kind);
      });
      btn.addEventListener('mousemove', function () {
        if (selected === i) return;
        selected = i;
        syncSelection();
      });

      li.appendChild(btn);
      list.appendChild(li);
    });

    if (count) {
      count.textContent = results.length >= PI.MAX_RESULTS ? PI.MAX_RESULTS + '+' : String(results.length);
    }
    syncSelection();
  }

  function syncSelection() {
    var root = overlayEl();
    if (!root) return;
    var rows = root.querySelectorAll('.un-qs-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('aria-selected', i === selected ? 'true' : 'false');
    }
    var active = rows[selected];
    var input = inputEl();
    if (input) input.setAttribute('aria-activedescendant', active ? active.id : '');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    var r = results[selected];
    if (r) {
      announce(
        r.title +
          (r.folder ? ', ' + r.folder : '') +
          '. ' +
          (selected + 1) +
          ' of ' +
          results.length
      );
    }
  }

  function announce(text) {
    var root = overlayEl();
    if (!root) return;
    var sr = root.querySelector('.un-qs-sr');
    if (sr) sr.textContent = text || '';
  }

  function applyQuery() {
    var input = inputEl();
    results = PI.filterPlaylists(index, input ? input.value : '', { recent: recents });
    selected = 0;
    renderList();
  }

  // ---- open / close -------------------------------------------------------

  /** The user's preferred channel landing tab, or 'videos' (the product default). */
  function channelTabPref() {
    var ui = (core && core.settings && core.settings.ui) || {};
    return ui.channelDefaultTab || 'videos';
  }

  /**
   * Open a row. `kind` decides the destination, because the two id spaces are
   * disjoint and opening a channel key as ?list= would 404.
   *
   * Recents are only recorded for playlists: RECENT_KEY is shared with
   * playlist-bulk.js, whose picker reads it as "playlists you add videos to".
   * Writing channel keys into it would put unopenable entries in that picker.
   */
  function openRow(id, kind) {
    if (!id) return;
    var url;
    if (kind === 'channel') {
      url = PI.channelUrl(id, channelTabPref());
    } else {
      recents = PI.rememberRecent(recents, id);
      var payload = {};
      payload[PI.RECENT_KEY] = recents;
      try {
        chrome.storage.local.set(payload);
      } catch (e) {
        /* recency is a nicety; never block the navigation on it */
      }
      url = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(id);
    }
    close();
    // A real navigation, not history.pushState: YouTube's SPA router owns its
    // own history and pushing at it from outside leaves the app rendering the
    // previous page at the new URL.
    location.href = url;
  }

  function close() {
    var root = overlayEl();
    if (root) root.remove();

    if (docClick) {
      document.removeEventListener('click', docClick, true);
      docClick = null;
    }
    if (keyFallback) {
      document.removeEventListener('keydown', keyFallback, true);
      keyFallback = null;
    }
    if (trapHandler) {
      document.removeEventListener('focusin', trapHandler, true);
      trapHandler = null;
    }
    if (escHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(escHandle);
      escHandle = null;
    }

    results = [];
    selected = 0;

    // Focus goes back where it was, or the page is left with focus on <body>
    // and the next Tab starts from the top of YouTube.
    var back = restoreFocus;
    restoreFocus = null;
    if (back && back.isConnected && back.focus) {
      try {
        back.focus();
      } catch (e) {
        /* the element can be detached between open and close */
      }
    }
  }

  function buildOverlay() {
    var back = document.createElement('div');
    back.id = OVERLAY_ID;
    back.className = 'un-qs-backdrop';
    // The semantics live on the OVERLAY element, not on the inner panel.
    // Checked in a real browser: with them on .un-qs-panel, #un-qs-overlay
    // reported role null / aria-modal null, so anything inspecting "the
    // overlay" — an audit, a screen reader entering from the backdrop — saw an
    // anonymous div. The element that is the modal is the one that says so.
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', 'Switch playlist or channel');

    var panel = document.createElement('div');
    panel.className = 'un-qs-panel';

    var row = document.createElement('div');
    row.className = 'un-qs-inputrow';

    var glyph = document.createElement('span');
    glyph.className = 'un-qs-glyph';
    glyph.textContent = '⌕';
    glyph.setAttribute('aria-hidden', 'true');
    row.appendChild(glyph);

    var input = document.createElement('input');
    input.id = INPUT_ID;
    input.className = 'un-qs-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Playlist, channel, folder or group…';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'un-qs-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-label', 'Filter playlists by title or folder');
    row.appendChild(input);

    var count = document.createElement('span');
    count.className = 'un-qs-count';
    row.appendChild(count);

    panel.appendChild(row);

    var list = document.createElement('ul');
    list.id = 'un-qs-list';
    list.className = 'un-qs-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Playlists');
    panel.appendChild(list);

    var empty = document.createElement('div');
    empty.className = 'un-qs-empty';
    empty.hidden = true;
    panel.appendChild(empty);

    var foot = document.createElement('div');
    foot.className = 'un-qs-foot';
    [
      ['↑↓', 'move'],
      ['Enter', 'open'],
      ['Esc', 'close']
    ].forEach(function (pair) {
      var span = document.createElement('span');
      var kbd = document.createElement('kbd');
      kbd.textContent = pair[0];
      span.appendChild(kbd);
      span.appendChild(document.createTextNode(' ' + pair[1]));
      foot.appendChild(span);
    });
    panel.appendChild(foot);

    var sr = document.createElement('div');
    sr.className = 'un-qs-sr';
    sr.setAttribute('role', 'status');
    sr.setAttribute('aria-live', 'polite');
    panel.appendChild(sr);

    back.appendChild(panel);
    // document.body, never documentElement — see quick-switcher.css.
    document.body.appendChild(back);

    input.addEventListener('input', applyQuery);
    // On the PANEL, not the input. The rows are focusable targets for the
    // browser's own focus machinery even at tabIndex -1 (a click, or the trap
    // pulling focus back mid-Tab), and a handler bound only to the input then
    // never sees the keystroke: observed live, a Tab after focus was stolen
    // landed on .un-qs-row-2 and the arrow keys stopped working entirely.
    // Bound to the panel, every key inside the modal reaches the same handler
    // whichever descendant happens to hold focus.
    panel.addEventListener('keydown', onPanelKeydown);

    return back;
  }

  function onPanelKeydown(e) {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (!results.length) return;
      selected = (selected + 1) % results.length;
      syncSelection();
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (!results.length) return;
      selected = (selected - 1 + results.length) % results.length;
      syncSelection();
      return;
    }
    if (e.key === 'Home' && results.length) {
      e.preventDefault();
      selected = 0;
      syncSelection();
      return;
    }
    if (e.key === 'End' && results.length) {
      e.preventDefault();
      selected = results.length - 1;
      syncSelection();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      var r = results[selected];
      if (r) openRow(r.id, r.kind);
      return;
    }
    if (e.key === 'Escape') {
      // Handled by the shared panel stack, but stopped here as well so
      // YouTube's own Escape handlers never see it while the modal is up.
      e.stopPropagation();
    }
  }

  function open() {
    if (overlayEl()) {
      close();
      return;
    }
    restoreFocus = document.activeElement;
    var root = buildOverlay();
    var input = inputEl();

    index = [];
    results = [];
    recents = [];
    selected = 0;
    renderList();

    readStores(function (cache, folders, pins, recent, subs, thumbs) {
      // The user may have closed it during the storage round trip.
      if (!overlayEl()) return;
      index = PI.buildIndex(cache, folders, pins, subs, thumbs);
      recents = recent;
      applyQuery();
      // Only NOW is the network considered, and only to refresh the playlist
      // half. Channels came from local storage and are already on screen; a
      // cold playlist cache therefore shows 606 subscriptions immediately
      // instead of an empty box while an OAuth round trip runs.
      if (PI.cacheIsStale(cache, Date.now())) {
        refreshCache(function (changed) {
          if (!changed || !overlayEl()) return;
          readStores(function (c2, f2, p2, r2, s2, t2) {
            if (!overlayEl()) return;
            index = PI.buildIndex(c2, f2, p2, s2, t2);
            recents = r2;
            applyQuery();
          });
        });
      }
    });

    docClick = function (e) {
      // Not a user dismissal — see queue-advance.js docClickHandler. Twelve
      // modules here synthesise clicks that bubble to document.
      if (e && e.isTrusted === false) return;
      var el = overlayEl();
      if (!el) return;
      var target = e && e.target;
      if (!target) return;
      // A target that is no longer in the document cannot tell us where the
      // click happened: contains() is false for a detached node, which reads
      // as "outside the panel" and dismissed the palette. The list re-renders
      // on every keystroke, so its rows are detached constantly — and this
      // fired as an intermittent, unexplained close. Ignore rather than guess.
      if (target.isConnected === false) return;
      // Measured against the OVERLAY, not the inner panel. The backdrop is
      // part of the palette; a click that lands on it is still a click on a
      // dismiss surface, which is handled below, but anything the overlay
      // contains — including a row — must never be read as "outside".
      if (el.contains(target)) {
        var panel = el.querySelector('.un-qs-panel');
        // Clicking the backdrop itself (outside the panel box) still closes,
        // which is the behaviour every other panel here has.
        if (panel && !panel.contains(target)) close();
        return;
      }
      close();
    };

    escHandle = window.UNSYNTH && window.UNSYNTH.pushPanel ? window.UNSYNTH.pushPanel(close) : null;
    keyFallback = escHandle
      ? null
      : function (e) {
          if (e.key === 'Escape') close();
        };

    // Focus trap. The overlay holds exactly one tabbable control (the input);
    // rows are driven by ↑/↓ and carry tabIndex -1. So the trap is simply
    // "focus cannot leave", which also survives YouTube stealing focus on its
    // own timers, something a Tab-cycling trap does not catch.
    trapHandler = function (e) {
      var el = overlayEl();
      if (!el) return;
      var i = inputEl();
      if (!i) return;
      // Focus belongs on the input and nowhere else, including on a row.
      // Rows are <button>s — natively focusable even at tabIndex -1 via a
      // click, and reachable by Tab while the panel's keydown handler has not
      // yet swallowed it. Observed live: focus landed on .un-qs-row-2 and the
      // arrow keys stopped working, because the keystrokes were going to a
      // button instead of the combobox.
      //
      // Deferred by a tick. Calling focus() synchronously inside focusin
      // re-enters the browser's own focus machinery mid-transfer, which on
      // some paths left focus nowhere and let the next event dismiss the
      // palette — the intermittent "Tab must not dismiss the modal" failure.
      // Letting the in-flight transfer finish first makes the correction
      // reliable.
      if (e.target === i) return;
      setTimeout(function () {
        if (!overlayEl()) return;
        var cur = inputEl();
        if (cur && document.activeElement !== cur) cur.focus();
      }, 0);
    };

    setTimeout(function () {
      if (!overlayEl()) return;
      document.addEventListener('click', docClick, true);
      if (keyFallback) document.addEventListener('keydown', keyFallback, true);
      document.addEventListener('focusin', trapHandler, true);
    }, 0);

    if (input) input.focus();
    void root;
  }

  // ---- binding ------------------------------------------------------------

  function onKeydown(e) {
    if (!prefs().enabled) return;
    var b = normalizeBinding(binding());
    if (!b) return;

    if (overlayEl()) {
      // Tab is handled HERE, at the document level, not only on the panel.
      //
      // The panel handler only sees Tab while focus is already inside the
      // panel. If focus has escaped — YouTube moves it on its own timers, and
      // a row can take it — Tab then walks YouTube's own tab order, focus
      // lands on a page button, and the palette is dismissed. Observed live as
      // an intermittent "Tab must not dismiss the modal": the event log showed
      // focusin on .un-qs-row-2, then on a YouTube <button>, then no overlay.
      //
      // Swallowing Tab whenever the modal is open makes the trap airtight
      // rather than merely usually-right: there is nothing to tab to, because
      // the palette is a modal.
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (results.length) {
          selected = e.shiftKey
            ? (selected - 1 + results.length) % results.length
            : (selected + 1) % results.length;
          syncSelection();
        }
        var inp = inputEl();
        if (inp && document.activeElement !== inp) inp.focus();
        return;
      }
      // While open, the panel's own handler owns the keyboard.
      //
      // Press-again-to-close must NOT fire while the caret is in the filter.
      // The default binding is a plain letter (shift+p), so an unconditional
      // close here means typing a capital P — the first character of plenty of
      // playlist titles — dismisses the palette mid-query. Caught by driving
      // the real keyboard: the overlay vanished on a keystroke that should
      // have filtered.
      //
      // Escape is the close while typing (and it is advertised in the footer);
      // the binding only toggles when focus is somewhere the character would
      // be discarded anyway.
      if (isTypingTarget(e.target)) return;
      if (normalizeBinding(comboOf(e)) === b) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }

    // Unlike shortcuts.js this is NOT limited to typing targets only when the
    // page is a watch page: the switcher is a navigation tool and has to work
    // on the home feed, a channel, and /feed/playlists. It still yields to a
    // real text field, so the binding inside YouTube's search box is untouched.
    if (isTypingTarget(e.target)) return;
    if (normalizeBinding(comboOf(e)) !== b) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    open();
  }

  function bind() {
    if (bound) return;
    document.addEventListener('keydown', onKeydown, true);
    bound = true;
  }

  function unbind() {
    if (!bound) return;
    document.removeEventListener('keydown', onKeydown, true);
    bound = false;
    close();
  }

  var mod = {
    id: 'quickSwitcher',
    moduleKey: 'quickSwitcher',
    init: function (c) {
      core = c;
      bind();
    },
    onSettings: function (s) {
      core.settings = s;
    },
    onNavigate: function () {
      // A YouTube SPA navigation leaves a stale modal floating over a page it
      // no longer describes.
      close();
    },
    teardown: unbind
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { comboOf: comboOf, normalizeBinding: normalizeBinding };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
