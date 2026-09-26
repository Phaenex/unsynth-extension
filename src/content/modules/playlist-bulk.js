/**
 * This file IS the `playlistBulk` module (registry id `playlistBulk`,
 * moduleKey `playlistBulk`). The legacy `playlistManager` settings key is kept
 * only for back-compat/migration (mirrored to playlistFolders + playlistBulk)
 * and has no UI toggle of its own.
 *
 * Unsynth Playlist Manager (in-page, PocketTube-style).
 *   - "✦ Manage" toggles SELECT MODE on a playlist page: a checkbox is overlaid
 *     on every real video thumbnail (yt-lockup-view-model). Selecting is pure
 *     DOM — no API, no OAuth — so the checkboxes appear instantly.
 *   - A floating action bar (Queue / Remove / Move / Copy / Dedupe + target playlist)
 *     appears while selecting. The write actions lazily fetch the playlist's
 *     videoId→playlistItemId map via the Data API (needs Connect YouTube); until
 *     then they show an honest "Connect YouTube first" toast.
 *   - Search box on the playlist page + search inside the "Save to playlist"
 *     popup (both pure DOM).
 */
(function () {
  'use strict';

  let core = null;
  const YT = window.UNYtDom || null;

  const FL = window.UNForgeLinks;
  const M_ITEMS = 'UNSYNTH/YT/PLAYLIST_ITEMS';
  const M_PLS = 'UNSYNTH/YT/PLAYLISTS_MINE';
  const M_ADD = 'UNSYNTH/YT/PLAYLIST_ADD';
  const M_REMOVE = 'UNSYNTH/YT/PLAYLIST_REMOVE';
  const M_VIDEO_PLAYLISTS = 'UNSYNTH/YT/VIDEO_PLAYLISTS';
  const M_CREATE = 'UNSYNTH/YT/PLAYLIST_CREATE';

  // Most-recently-used destination playlists (ids, newest first, capped). Floats
  // the playlists you actually add to up to the top of the picker next time.
  const RECENT_KEY = 'unsynthRecentPlaylists';
  let recentIds = [];
  function loadRecent() {
    try {
      chrome.storage.local.get({ [RECENT_KEY]: [] }, (d) => {
        if (chrome.runtime.lastError || !d) return;
        recentIds = Array.isArray(d[RECENT_KEY]) ? d[RECENT_KEY] : [];
      });
    } catch (e) {
      /* ignore */
    }
  }
  function pushRecent(id) {
    if (!id) return;
    recentIds = [id].concat(recentIds.filter((x) => x !== id)).slice(0, 8);
    try {
      chrome.storage.local.set({ [RECENT_KEY]: recentIds });
    } catch (e) {
      /* ignore */
    }
  }

  // per-page state
  // True while the current selection was made by the Watched button, so a
  // following Move to… still surfaces the Watched archive playlist. Merging the
  // two watched buttons must not quietly drop that affordance.
  let watchedSelectionActive = false;
  const PL = { selecting: false, plId: null, selected: new Set(), pls: [], plsError: null, itemMap: null, itemMapPl: null, authed: false, canWrite: false, authChecked: false, busy: false, inCache: null };

  function el(tag, cls, text) { return window.UNSYNTH.el(tag, cls, text); }
  function btn(cls, text) {
    const b = el('button', cls, text);
    b.type = 'button';
    return b;
  }
  // Set textContent only when it changes. These setters run on every scan;
  // reassigning textContent unconditionally replaces text nodes (a childList
  // mutation) which re-triggers the core MutationObserver -> scan -> ... loop.
  function setText(e, txt) {
    if (e && e.textContent !== txt) e.textContent = txt;
  }
  function send(type, extra) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (r) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function playlistIdFromUrl() {
    const m = location.search.match(/[?&]list=([^&]+)/);
    return m ? m[1] : null;
  }
  function onPlaylistPage() {
    return location.pathname.startsWith('/playlist') && !!playlistIdFromUrl();
  }

  // Can the playlist-write actions (Remove, Move to...) act on this selection?
  //
  // This used to be onPlaylistPage() alone, which is /playlist ONLY. Playing a
  // playlist puts you on /watch?v=...&list=PL..., where the queue panel shows
  // that playlist's real contents and ?list= carries the very id the Data API
  // needs -- but the path is /watch, so every .un-plm-pl action was hidden and
  // selecting from the queue offered no way to remove or move. Reported live:
  // "when i am viewing a playlist and click on a video and the playlist plays
  // ... it doesnt give me the options to remove from the playlist or move".
  //
  // The id must be a real, writable playlist. YouTube's synthetic lists are
  // not: LL (liked), WL (watch later) and RD*/UL*/PU* (radio/mixes) reject
  // playlistItems writes, so offering Remove there would fail at the API.
  // Pure and exported so the rule is pinned by tests without a live page.
  function playlistWritableFromUrl(pathname, listId) {
    if (!listId) return false;
    if (/^(LL|WL)$/.test(listId)) return false;
    if (/^(RD|UL|PU)/.test(listId)) return false;
    if (String(pathname || '').startsWith('/playlist')) return true;
    // A playlist loaded into the watch queue is the same backend object.
    return String(pathname || '').startsWith('/watch');
  }

  function canEditPlaylistHere() {
    return playlistWritableFromUrl(location.pathname, playlistIdFromUrl());
  }

  // Lift the playlist action bar above the queue dock when both sit in the
  // same bottom band. Pure so tests can pin the math without a live dock.
  function bulkBarBottomPx(barH, dockRect, vh) {
    var def = 24;
    var height = barH > 0 ? barH : 48;
    var viewH = vh > 0 ? vh : 0;
    if (!dockRect || !viewH) return def;
    var dockTop = Number(dockRect.top);
    var dockBottom = Number(dockRect.bottom);
    if (!isFinite(dockTop) || !isFinite(dockBottom)) return def;
    var barTop = viewH - def - height;
    var barBottom = viewH - def;
    if (dockBottom <= barTop + 1 || dockTop >= barBottom - 1) return def;
    return Math.max(def, Math.round(viewH - dockTop + 8));
  }

  function applyBarPosition() {
    const bar = document.getElementById('un-plm-bar');
    if (!bar) return;
    const dock = document.getElementById('un-queue-dock');
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
    const barH = bar.offsetHeight || 48;
    let dockRect = null;
    if (dock && typeof dock.getBoundingClientRect === 'function') {
      try {
        dockRect = dock.getBoundingClientRect();
        // Clear the flyout too, not just the dock. The queue flyout is a CHILD
        // of the dock but is positioned outside its border box
        // (bottom: calc(100% + 12px)) and can be 440 x 480, so a bar that
        // cleared only the dock's own rect parked itself squarely inside the
        // flyout's list. This function re-measures locally and ignores the
        // event detail, so the union has to be computed here, at the point of
        // use, rather than only by the emitter.
        const fly = document.getElementById('un-queue-flyout');
        if (fly && typeof fly.getBoundingClientRect === 'function') {
          const f = fly.getBoundingClientRect();
          if (f.width > 0 && f.height > 0) {
            dockRect = {
              top: Math.min(dockRect.top, f.top),
              bottom: Math.max(dockRect.bottom, f.bottom),
              left: Math.min(dockRect.left, f.left),
              right: Math.max(dockRect.right, f.right)
            };
          }
        }
      } catch (e) {
        dockRect = null;
      }
    }
    bar.style.bottom = bulkBarBottomPx(barH, dockRect, vh) + 'px';
  }

  // ---- derive the videoId for one playlist row ----
  function rowVideoId(row) {
    const a = row.querySelector('a[href*="/watch"]');
    if (a) {
      const m = (a.getAttribute('href') || '').match(/[?&]v=([^&]+)/);
      if (m) return m[1];
    }
    const host = row.querySelector('[class*="content-id-"]');
    if (host) {
      const m = host.className.match(/content-id-([\w-]+)/);
      if (m) return m[1];
    }
    return null;
  }
  function rowTitle(row) {
    const t = row.querySelector(YT ? YT.PLAYLIST_ROW_TITLE_SEL : 'h3, #video-title');
    return t ? t.textContent.trim() : '';
  }
  function rowSel() {
    return YT ? YT.PLAYLIST_ROW_SEL : '';
  }
  function feedTileSel() {
    return YT ? YT.feedTileSelector() : '';
  }
  function currentTileSel() {
    return onPlaylistPage() ? rowSel() : feedTileSel();
  }
  function allRows() {
    return Array.prototype.slice.call(document.querySelectorAll(currentTileSel()));
  }
  function hasTiles() {
    return !!document.querySelector(currentTileSel());
  }

  // ---- on-page toolbar (search + Select + Dedupe + count) ----
  // The bulk actions used to live ONLY in the masthead "Select" button, which is
  // far from the playlist. This puts a visible toolbar right above the rows.
  function ensurePlaylistToolbar() {
    if (!onPlaylistPage()) return;
    if (document.getElementById('un-pl-toolbar')) {
      updateToolbar();
      return;
    }
    const firstRow = document.querySelector(rowSel());
    if (!firstRow) return;
    // the rows live in a shared container; anchor the bar above that container
    const container = firstRow.closest(YT ? YT.PLAYLIST_ROW_CONTAINER_SEL : '#contents') || firstRow.parentElement;
    if (!container || !container.parentElement) return;

    const wrap = el('div', 'un-pl-toolbar');
    wrap.id = 'un-pl-toolbar';

    const input = el('input', 'un-pl-search');
    input.id = 'un-pl-search';
    input.type = 'text';
    input.placeholder = 'Search this playlist…';
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      allRows().forEach((row) => {
        const text = rowTitle(row).toLowerCase();
        row.style.display = !q || text.includes(q) ? '' : 'none';
      });
    });

    const selBtn = btn('un-pl-tb-btn un-pl-tb-select un-pl-tb-primary', '☑ Select');
    selBtn.title = 'Select multiple videos to move, copy or remove in bulk';
    selBtn.addEventListener('click', () => {
      PL.selecting ? exitSelect() : enterSelect();
      updateToolbar();
    });

    const dedupeBtn = btn('un-pl-tb-btn', 'Dedupe');
    dedupeBtn.title = 'Find and remove duplicate videos in this playlist (needs YouTube connected)';
    dedupeBtn.addEventListener('click', doDedupe);

    // One button, not two. "Archive Watched" and "Move watched" both ran
    // selectWatchedOnPage() on the same set; the only difference was that Move
    // also forced the destination picker open. That is a step, not a separate
    // capability, and "Archive" named something the button did not do (its own
    // tooltip said "select ... so you can remove them"). Selecting and letting
    // the bulk bar decide keeps Remove, Move to… and Add to playlist… all one
    // click away without presuming which one you wanted.
    // "Select watched", not "Watched": the bare word read as a filter toggle
    // beside a page that already has a watched filter in the masthead, and
    // this is an action that selects (2026-09-23).
    const watchedBtn = btn('un-pl-tb-btn', 'Select watched');
    watchedBtn.title = 'Select every watched video in this playlist, then Remove or Move them';
    watchedBtn.addEventListener('click', archiveWatchedVideos);

    const exportBtn = btn('un-pl-tb-btn', 'Export');
    exportBtn.title = 'Export this playlist to a Markdown file';
    exportBtn.addEventListener('click', exportPlaylist);

    const count = el('span', 'un-pl-tb-count');

    // Count sits with the search field, not pushed to the far right: at the
    // right edge it lands underneath the Forge tab (position:fixed, right:0)
    // and reads as "7 vid" with the tab over it.
    const head = el('div', 'un-pl-tb-head');
    head.append(input, count);
    const acts = el('div', 'un-pl-tb-acts');
    acts.append(selBtn, dedupeBtn, watchedBtn, exportBtn);
    wrap.append(head, acts);
    container.parentElement.insertBefore(wrap, container);
    ensureAuthOnce();
    updateToolbar();
  }

  function watchedSetFromStorage(d) {
    const ids = ((d && d.unWatchedIds) || []).concat((d && d.watchedVideos) || []);
    return new Set(ids);
  }

  function rowLooksWatched(row) {
    return !!(row && (row.classList.contains('is-watched') || row.querySelector('.uwm-watched')));
  }

  function watchedIdsOnPage(watchedSet) {
    return collectWatchedVideoIds(allRows(), watchedSet, rowVideoId, rowLooksWatched);
  }

  function selectWatchedOnPage(matched) {
    if (!PL.selecting) enterSelect();
    PL.selected.clear();
    watchedSelectionActive = false;
    matched.forEach((id) => PL.selected.add(id));
    decorateRows();
    updateBar();
    updateToolbar();
  }

  function archiveWatchedVideos() {
    try {
      chrome.storage.local.get({ unWatchedIds: [], watchedVideos: [] }, function (d) {
        const matched = watchedIdsOnPage(watchedSetFromStorage(d));
        if (!matched.length) {
          toastBar('No watched videos found in this playlist');
          return;
        }
        selectWatchedOnPage(matched);
        // Remember where this selection came from. "Move watched" used to be a
        // separate button purely so the picker could offer (or offer to create)
        // a "Watched" archive playlist. Merging the buttons must not quietly
        // drop that, so the next Move to… on THIS selection still gets it.
        watchedSelectionActive = true;
        toastBar('Selected ' + matched.length + ' watched video' + (matched.length === 1 ? '' : 's') + '. Click Remove to delete, or Move to… to keep them.');
      });
    } catch (e) {
      // This wraps the whole selection flow, so swallowing it meant the button
      // did nothing at all: no selection, no toast, no error, nothing in the
      // console. Say so, and record it where diagnostics() will show it.
      toastBar('Could not select watched videos — reload the page and try again.');
      if (core && core.reportError) core.reportError('playlistBulk', e);
    }
  }

  function exportPlaylist() {
    var rows = allRows();
    var items = [];
    rows.forEach(function (r) {
      var vid = rowVideoId(r);
      var title = rowTitle(r);
      if (vid) {
        items.push({
          id: vid,
          title: title || vid,
          url: 'https://www.youtube.com/watch?v=' + vid
        });
      }
    });
    if (!items.length) {
      toastBar('No videos to export');
      return;
    }
    var md = '# Playlist Export (' + items.length + ' videos)\n\n' +
      items.map(function (it, idx) {
        return (idx + 1) + '. [' + it.title.replace(/[[\]]/g, '') + '](' + it.url + ')';
      }).join('\n');

    try {
      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'playlist-export.md';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      toastBar('Exported ' + items.length + ' videos as Markdown');
    } catch (e) {
      toastBar('Could not export playlist');
    }
  }

  function updateToolbar() {
    const wrap = document.getElementById('un-pl-toolbar');
    if (!wrap) return;
    const selBtn = wrap.querySelector('.un-pl-tb-select');
    if (selBtn) {
      setText(selBtn, PL.selecting ? '✓ Done' : '☑ Select');
      selBtn.classList.toggle('on', PL.selecting);
    }
    const count = wrap.querySelector('.un-pl-tb-count');
    if (count) {
      const n = allRows().filter((r) => rowVideoId(r)).length;
      setText(count, n ? n + ' videos' : '');
    }
  }

  // Resolve auth/playlist data once per playlist page so per-row actions know
  // whether edits are possible without forcing the user into bulk-select mode.
  // checkAuth is cheap (reads stored token state); playlists load lazily on demand.
  function ensureAuthOnce() {
    if (PL.authChecked) return;
    PL.authChecked = true;
    checkAuth();
  }
  // Load the user's playlists whenever they're CONNECTED — not only when they
  // also granted write scope.
  //
  // This gate used to be `PL.canWrite`, so a read-only connection never
  // fetched anything and the picker rendered "No playlists yet" over an
  // account with plenty of playlists ("it doesnt show my active playlists even
  // though youtube is connected"). Listing playlists is a read; the write
  // scope only governs whether the *apply* step can modify them, and the
  // picker already handles that separately.
  // Pure: given the current auth/cache state, should the playlist list be
  // fetched? Extracted so the regression (gating a READ on write scope) is
  // pinned by a test instead of living only inside an async DOM path.
  function shouldFetchPlaylists(state) {
    const s = state || {};
    if (!s.authed) return false; // nothing to fetch without a connection
    return !(s.playlistCount > 0); // already cached — don't refetch
  }

  async function ensurePlaylistData() {
    await checkAuth();
    if (shouldFetchPlaylists({ authed: PL.authed, canWrite: PL.canWrite, playlistCount: PL.pls.length })) {
      await loadPlaylists();
    }
  }

  // ---- "Select" in the YouTube masthead bar (next to watched filters) ----
  function ensureMastheadShell() {
    if (window.UNMastheadSlot) {
      var slot = window.UNMastheadSlot.ensureMastheadStructure();
      return slot ? slot.extra : null;
    }
    return document.getElementById('un-synth-masthead-extra');
  }

  function mastheadSlot() {
    return ensureMastheadShell();
  }

  function ensureManageButton() {
    const existing = document.getElementById('un-plm-btn');
    if (!hasTiles()) {
      if (existing) existing.remove();
      exitSelect();
      return;
    }
    const plId = playlistIdFromUrl();
    if (PL.plId !== plId) {
      exitSelect();
      PL.plId = plId;
      PL.itemMap = null;
      PL.itemMapPl = null;
      PL.authChecked = false;
    }
    const slot = core && core.ensureMastheadShell ? core.ensureMastheadShell()?.extra : mastheadSlot();
    if (!slot) {
      if (!ensureManageButton._wait) {
        ensureManageButton._wait = true;
        const retry = () => {
          ensureManageButton._wait = false;
          ensureManageButton();
        };
        document.addEventListener('unsynth-masthead-ready', retry, { once: true });
        setTimeout(retry, 200);
      }
      return;
    }
    let b = existing;
    if (!b) {
      b = btn('un-wft-btn un-plm-select-btn', 'Select');
      b.id = 'un-plm-btn';
      // This button toggles selection mode, so it is a toggle and has to say
      // so. It flipped its label and its .on class and exposed neither to
      // assistive tech: the semantics audit counted it as named but
      // state-not-exposed, which means a screen reader announced "Select" then
      // "Done" with nothing to say a mode had been entered.
      b.setAttribute('aria-pressed', 'false');
      b.title = 'Select multiple videos — add to a playlist (and more on a playlist page)';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        PL.selecting ? exitSelect() : enterSelect();
      });
      slot.appendChild(b);
    }
    setFabLabel();
  }

  function setFabLabel() {
    const b = document.getElementById('un-plm-btn');
    if (b) {
      setText(b, PL.selecting ? 'Done' : 'Select');
      b.classList.toggle('on', PL.selecting);
      // Kept in step with the class above — a visual state with no ARIA
      // equivalent is the state not existing for anyone not looking at it.
      b.setAttribute('aria-pressed', PL.selecting ? 'true' : 'false');
    }
  }

  function enterSelect() {
    PL.selecting = true;
    document.body.classList.add('un-plm-selecting');
    setFabLabel();
    updateToolbar();
    decorateRows();
    ensureBar();
    updateBar();
    checkAuth();
    loadPlaylists();
    loadRecent();
  }
  function exitSelect() {
    PL.selecting = false;
    PL.selected.clear();
    watchedSelectionActive = false;
    closePicker();
    document.body.classList.remove('un-plm-selecting');
    setFabLabel();
    updateToolbar();
    document.querySelectorAll('.un-plm-shield').forEach((c) => c.remove());
    document.querySelectorAll('.un-plm-host').forEach((h) => h.classList.remove('un-plm-host', 'un-plm-on'));
    const bar = document.getElementById('un-plm-bar');
    if (bar) bar.remove();
    try {
      decorateRowActions();
    } catch (e) {
      /* ignore */
    }
  }

  function toggleRow(row) {
    const v = rowVideoId(row);
    if (!v) return;
    if (PL.selected.has(v)) PL.selected.delete(v);
    else PL.selected.add(v);
    row.classList.toggle('un-plm-on', PL.selected.has(v));
    // Clearing the last selection leaves select mode.
    //
    // Select mode used to be entered and left only from the masthead button,
    // so being in it with nothing selected was a normal waypoint. Now that a
    // tile can start it, the reverse has to work too — otherwise unpicking your
    // one video strands you in a mode with an empty action bar and the quick
    // actions hidden, and the only way out is a button somewhere else. Lives
    // here rather than in the caller so it applies however the last item was
    // cleared (the tile button, or the full-tile click shield).
    if (!PL.selected.size) {
      exitSelect();
      return;
    }
    updateBar();
  }

  // Start a multi-select from the tile itself.
  //
  // Selecting used to require finding the "Select" button in the masthead
  // first, then coming back and clicking the video you already had the cursor
  // on. This does both in one click: turn select mode on if it isn't, then
  // select this video. Clicking it again on the same tile deselects, and
  // deselecting the last one leaves select mode so the user isn't stranded in
  // a mode with nothing chosen.
  function startSelectFrom(row) {
    const vid = rowVideoId(row);
    if (!vid) return;
    if (!PL.selecting) {
      enterSelect();
      // enterSelect() re-decorates; the row element itself is unchanged, so
      // selecting straight after is safe.
      PL.selected.add(vid);
      row.classList.add('un-plm-on');
      updateBar();
      return;
    }
    // toggleRow handles leaving select mode when this clears the last one.
    toggleRow(row);
  }

  // ---- click-shield over every rendered row (self-healing on YouTube re-render) ----
  // A full-row overlay sits ON TOP so the click can't be stolen by YouTube's
  // thumbnail hover scrim, and the whole thumbnail toggles selection.
  function decorateRows() {
    if (!PL.selecting) return;
    allRows().forEach((row) => {
      const vid = rowVideoId(row);
      if (!vid) return;
      row.classList.add('un-plm-host');
      let shield = row.querySelector(':scope > .un-plm-shield');
      if (!shield) {
        // Real checkbox semantics, not a click-only div: without a role and
        // tabindex a keyboard user could not select or deselect a video in
        // bulk mode at all — the whole feature was mouse-only.
        shield = el('div', 'un-plm-shield');
        shield.setAttribute('role', 'checkbox');
        shield.setAttribute('tabindex', '0');
        shield.setAttribute('aria-checked', String(PL.selected.has(vid)));
        shield.setAttribute('aria-label', 'Select this video for bulk actions');
        const badge = el('div', 'un-plm-badge');
        badge.appendChild(el('span', 'un-plm-tick', '✓'));
        shield.appendChild(badge);
        shield.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleRow(row); // read videoId live — rows are recycled by YouTube
        });
        shield.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
          e.preventDefault();
          e.stopPropagation();
          toggleRow(row);
        });
        row.appendChild(shield);
      }
      const isOn = PL.selected.has(vid);
      row.classList.toggle('un-plm-on', isOn);
      if (shield) shield.setAttribute('aria-checked', String(isOn));
    });
  }

  // ---- floating action bar ----
  function openForgeSelection() {
    if (!PL.selected.size || !FL) return;
    // ids used to be Array.from(PL.selected) (Set insertion/click order) while
    // titles was built from a separate allRows() pass (page order) — whenever
    // a user's click order differed from page order (very common: selecting
    // videos out of sequence, or via a range-select), forgeSelection() zipped
    // ids[i] with titles[i] from two differently-ordered arrays, so Forge
    // received the wrong title attached to a given video id. Build both from
    // one page-order pass, same fix already applied to queueSelected() below.
    const ids = [];
    const titles = [];
    allRows().forEach((row) => {
      const vid = rowVideoId(row);
      if (vid && PL.selected.has(vid)) {
        ids.push(vid);
        titles.push(rowTitle(row));
      }
    });
    window.open(FL.forgeSelection(ids, { titles }), '_blank', 'noopener');
  }

  // Return selected videos in page order, regardless of the order in which
  // their checkboxes were clicked. That is the order users see and the order
  // both the native and mirrored extension queues should receive.
  function selectedItemsInOrder(rows, selected, itemForRow) {
    const chosen = selected instanceof Set ? selected : new Set(selected || []);
    return Array.prototype.slice
      .call(rows || [])
      .map((row) => itemForRow(row))
      .filter((item) => item && chosen.has(item.id));
  }

  function collectWatchedVideoIds(rows, watchedSet, getId, rowLooksWatched) {
    const ids = [];
    const seen = watchedSet && typeof watchedSet.has === 'function' ? watchedSet : new Set();
    (rows || []).forEach((row) => {
      if (!row) return;
      const id = getId(row);
      if (!id) return;
      if (seen.has(id) || (rowLooksWatched && rowLooksWatched(row))) ids.push(id);
    });
    return ids;
  }

  function findWatchedArchivePlaylist(playlists) {
    return (playlists || []).find((p) => p && /^watched$/i.test(String(p.title || '').trim())) || null;
  }

  function queueSelected() {
    const items = selectedItemsInOrder(allRows(), PL.selected, rowQueueItem);
    if (!items.length) return;
    const NQ = window.UNNativeQueue;
    const n = items.length + (items.length === 1 ? ' video' : ' videos');
    const fail = (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch')
      ? "Couldn't reach YouTube's queue"
      : "YouTube's queue only builds on a watch page — open a video first";
    if (!NQ) {
      toastBar(fail);
      return;
    }
    NQ.add(
      items.map((item) => item.id),
      { toFront: false }
    ).then((result) => {
      toastBar(result && result.native ? n + ' added to YouTube queue' : fail);
    });
  }

  // Is the current selection entirely rows from the "Up next" queue panel?
  //
  // Separate from onPlaylistPage()'s "Remove"/"Move to…", which write to a
  // real YouTube playlist via the Data API. The queue panel is not a
  // playlist the user owns — it's YouTube's temporary per-session queue — so
  // removing from it needs a different action, gated on being selected FROM
  // the panel rather than on the current page type (selecting a video from
  // the queue panel is possible from any watch page, panel state included).
  function onlyQueuePanelSelected() {
    if (!PL.selected.size) return false;
    const panel = document.querySelector(YT ? YT.PLAYLIST_PANEL_SEL : '#secondary');
    if (!panel) return false;
    // Ghost rows YouTube leaves behind (display:none, still isConnected)
    // after a removal must not count here, or a video just removed from the
    // queue can keep "Remove from queue" showing for a selection that no
    // longer includes anything actually in the panel.
    const panelIds = new Set(
      Array.prototype.slice
        .call(panel.querySelectorAll(YT ? YT.PLAYLIST_PANEL_VIDEO_SEL : 'a[href*="/watch"]'))
        .filter((row) => row.offsetParent !== null)
        .map((row) => rowVideoId(row))
        .filter(Boolean)
    );
    let allInPanel = true;
    PL.selected.forEach((id) => {
      if (!panelIds.has(id)) allInPanel = false;
    });
    return allInPanel;
  }

  /**
   * A per-row "remove from queue" button, revealed on hover.
   *
   * Deliberately NOT paired with up/down arrows. YouTube's native queue is
   * append-only from an extension: src/shared/native-queue.js documents that
   * INSERT_AFTER_CURRENT_VIDEO and the listPosition variants were tested
   * against a live signed-in session and every one of them appended. Checked
   * the DOM too — the panel rows carry no drag handle and nothing in them is
   * draggable. Shipping arrows that quietly did nothing would be worse than
   * not shipping them.
   *
   * Placement is on the LEFT, before the thumbnail, for the same reason the
   * checkbox moved there: YouTube's ⋮ owns the right edge and our controls
   * were swallowing its clicks.
   */
  function ensureQueueRowRemove(row, vid) {
    if (!row || !vid) return;
    if (row.querySelector(':scope > .un-plm-qprm')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'un-plm-qprm';
    b.textContent = '✕';
    b.title = 'Remove from queue';
    b.setAttribute('aria-label', 'Remove this video from the queue');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const NQ = window.UNNativeQueue;
      if (!NQ) {
        toastBar("Couldn't reach YouTube's queue");
        return;
      }
      b.disabled = true;
      NQ.remove([vid]).then((r) => {
        b.disabled = false;
        toastBar(r && r.ok ? 'Removed from queue' : 'Failed to remove from queue');
      });
    });
    row.insertBefore(b, row.firstChild);
  }

  function removeSelectedFromQueue() {
    const ids = Array.from(PL.selected);
    if (!ids.length) return;
    const NQ = window.UNNativeQueue;
    if (!NQ) {
      toastBar("Can't reach the queue right now");
      return;
    }
    // Shared cleanup so a genuinely-successful removal always clears
    // selection, whether the confirmation arrived on time or (see below)
    // only showed up as the video actually being gone from the DOM after
    // this promise gave up waiting.
    const finishRemoved = (removedIds, label) => {
      removedIds.forEach((id) => PL.selected.delete(id));
      if (!PL.selected.size) {
        exitSelect();
        toastBar(label);
        return;
      }
      decorateRows();
      updateBar();
      toastBar(label);
    };
    // A batch of 2+ videos can take longer than any one client-side timeout
    // covers — each needs a real click-through-YouTube's-own-menu cycle, and
    // the bridge can retry once — so a "Failed: timeout" reply here does not
    // reliably mean the removal didn't happen; it can mean the confirmation
    // just hadn't arrived yet. Reported live: the videos were actually gone
    // from the queue seconds after this promise resolved with ok:false,
    // leaving the selection/bar stuck showing videos that no longer existed.
    // Re-check the real DOM once, after giving the (possibly still in
    // flight) removal more time to land, and reconcile either way.
    const reconcileAgainstDom = () => {
      // YouTube leaves a removed queue-panel row in the document, hidden via
      // display:none, instead of deleting it — confirmed live, isConnected
      // stayed true. Ungated, that ghost row reads as "still queued" and
      // this reconciliation would conclude nothing was removed even when the
      // native panel visibly showed it gone.
      const stillQueued = ids.filter((id) => {
        return allRows().some((row) => rowVideoId(row) === id && row.offsetParent !== null);
      });
      const actuallyRemoved = ids.filter((id) => stillQueued.indexOf(id) === -1);
      if (!actuallyRemoved.length) {
        toastBar('Failed to remove from queue');
        return;
      }
      const n = actuallyRemoved.length;
      finishRemoved(actuallyRemoved, 'Removed ' + n + (n === 1 ? ' video' : ' videos') + ' from queue');
    };
    toastBar('Removing…');
    NQ.remove(ids).then((r) => {
      if (!r || !r.ok) {
        toastBar('Removing… (taking longer than usual)');
        setTimeout(reconcileAgainstDom, 4000);
        return;
      }
      const n = r.removed != null ? r.removed : ids.length;
      finishRemoved(ids, 'Removed ' + n + (n === 1 ? ' video' : ' videos') + ' from queue');
    });
  }

  function ensureBar() {
    if (document.getElementById('un-plm-bar')) return;
    const bar = el('div', 'un-plm-bar');
    bar.id = 'un-plm-bar';

    // left group: selection count + select-all / clear
    const left = el('div', 'un-plm-grp');
    const count = el('span', 'un-plm-count');
    const selAll = btn('un-plm-link', 'Select all');
    const clear = btn('un-plm-link', 'Clear');
    selAll.addEventListener('click', selectAll);
    clear.addEventListener('click', () => {
      PL.selected.clear();
    watchedSelectionActive = false;
      decorateRows();
      updateBar();
    });
    left.append(count, selAll, clear);

    // right group: queue / playlist / copy actions work on any surface;
    // Move / Remove / Dedupe (class un-plm-pl) only make sense on a playlist page.
    const right = el('div', 'un-plm-grp');
    const queueB = btn('un-plm-act un-plm-queue-selected', 'Add to queue');
    const addB = btn('un-plm-act', 'Add to playlist…');
    const moveB = btn('un-plm-act un-plm-pl', 'Move to…');
    const removeB = btn('un-plm-act un-plm-pl un-plm-rm', 'Remove');
    // Distinct from removeB above: that one edits a real YouTube playlist via
    // the Data API and only makes sense on a playlist page. This removes from
    // the "Up next" queue panel — a per-session list, not a playlist the user
    // owns — via the same DOM/Innertube-command bridge "Add to queue" uses, so
    // it needs no OAuth and is gated on the selection being FROM the panel
    // rather than on the current page type.
    const removeQueueB = btn('un-plm-act un-plm-rm un-plm-remove-queue', 'Remove from queue');
    const dedupe = btn('un-plm-act un-plm-pl un-plm-dedupe', 'Dedupe');
    const copyL = btn('un-plm-act', 'Copy links');
    const connect = btn('un-plm-act un-plm-connect', 'Connect YouTube');
    connect.style.display = 'none';
    queueB.addEventListener('click', queueSelected);
    // Load playlists BEFORE opening, exactly as the per-row ≡→ and ≡+ buttons
    // already do. openPicker() renders synchronously from PL.pls and only
    // re-renders on search input or the membership lookup (itself gated on
    // PL.pls.length), so opening with an empty list leaves the picker showing
    // nothing but "Watch later" — with no second render to correct it.
    //
    // For "Move watched" this was worse than cosmetic: with no playlists loaded,
    // an EXISTING "Watched" archive could not be found, so the picker offered to
    // create a second one. Caught by playlist-move-watched.spec.js, which had
    // been failing on exactly that assertion.
    addB.addEventListener('click', async (e) => {
      const target = e.currentTarget;
      await ensurePlaylistData();
      openPicker('add', target);
    });
    moveB.addEventListener('click', async (e) => {
      const target = e.currentTarget;
      const archive = watchedSelectionActive;
      await ensurePlaylistData();
      openPicker('move', target, null, { watchedArchive: archive });
    });
    removeB.addEventListener('click', doRemove);
    removeQueueB.addEventListener('click', removeSelectedFromQueue);
    dedupe.addEventListener('click', doDedupe);
    copyL.addEventListener('click', doCopyLinks);
    connect.addEventListener('click', connectYouTube);
    const forgeSend = btn('un-plm-act un-plm-forge-btn', 'Send to Forge ↗');
    forgeSend.title = 'Discover similar videos in Playlist Forge from your selection';
    forgeSend.addEventListener('click', openForgeSelection);
    const forge = el('a', 'un-plm-forge', 'Forge ↗');
    // Use the shared helper (UNForgeLinks) — a bare `FORGE` const was never
    // defined in this module, so this line threw a ReferenceError mid-build and
    // the entire action bar never mounted (select mode showed checkboxes but no
    // Add/Move/Remove/Dedupe options, on playlist pages AND feeds).
    forge.href = FL ? FL.forgeManage(PL.plId || '') : '#';
    forge.title = 'Open this playlist in Playlist Forge';
    forge.target = '_blank';
    forge.rel = 'noopener';
    forge.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'UNSYNTH/OPEN_URL', url: forge.href });
    });
    // PRIMARY row vs an overflow menu.
    //
    // Measured before this split, on a playlist watch page with 3 selected: 12
    // controls, 833px wide, wrapped onto THREE rows 132px tall, every label
    // broken across 2-3 lines ("Add / to / queue"), every action carrying the
    // same visual weight — including two separate Forge entry points and a
    // bright blue Connect button louder than any real action.
    //
    // What stays inline is what you reach for on a selection: put it somewhere,
    // or take it out of here. Everything occasional (dedupe, copy links, both
    // Forge routes) moves behind "More", which is one control instead of four.
    // Connect stays out of the menu because it is a precondition, not an
    // action — when it shows, nothing else on the bar can work.
    const more = btn('un-plm-act un-plm-more', 'More ▾');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    const moreMenu = el('div', 'un-plm-moremenu');
    moreMenu.setAttribute('role', 'menu');
    moreMenu.hidden = true;
    [dedupe, copyL, forgeSend, forge].forEach(function (b) {
      b.classList.add('un-plm-moreitem');
      b.setAttribute('role', 'menuitem');
      moreMenu.appendChild(b);
    });
    function closeMore() {
      moreMenu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
    }
    more.addEventListener('click', function (e) {
      e.stopPropagation();
      const open = moreMenu.hidden;
      moreMenu.hidden = !open;
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Dismiss like every other menu in this extension: outside click and Escape.
    document.addEventListener('click', function (e) {
      if (moreMenu.hidden) return;
      if (moreMenu.contains(e.target) || e.target === more) return;
      closeMore();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !moreMenu.hidden) closeMore();
    });
    moreMenu.addEventListener('click', function () { closeMore(); });

    // Leaving select mode, on the bar you are already looking at.
    //
    // The only way out was the masthead's Select button, which relabels itself
    // to "Done" — and on a wide screen that is ~900px away from the bar at the
    // bottom of the page, in the opposite corner from where the work is
    // happening. Reported: "when i hit select the widget open but done goes all
    // the way up top". The masthead button still works and still relabels; this
    // is a second door in the room you are standing in, not a replacement.
    const doneB = btn('un-plm-act un-plm-done', 'Done');
    doneB.title = 'Leave select mode';
    doneB.addEventListener('click', exitSelect);

    const moreWrap = el('div', 'un-plm-morewrap');
    moreWrap.append(more, moreMenu);
    right.append(queueB, addB, moveB, removeB, removeQueueB, connect, moreWrap, doneB);

    const toast = el('span', 'un-plm-toast');
    toast.style.display = 'none';

    bar.append(left, el('div', 'un-plm-div'), right, toast);
    document.body.appendChild(bar);
    applyBarPosition();
    updateBar();
  }

  function updateBar() {
    const bar = document.getElementById('un-plm-bar');
    if (!bar) return;
    const n = PL.selected.size;
    const count = bar.querySelector('.un-plm-count');
    if (count) setText(count, n ? n + ' selected' : 'Select videos');
    // Playlist-write actions follow the PLAYLIST, not the path: a playlist
    // loaded into the watch queue is the same object the Data API edits.
    const onPl = canEditPlaylistHere();
    bar.querySelectorAll('.un-plm-pl').forEach((b) => (b.style.display = onPl ? '' : 'none'));
    // "Remove from queue" only makes sense while the whole selection is
    // drawn from the "Up next" panel — shown instead of (never alongside)
    // the playlist "Remove" above, which edits a different backend entirely.
    const removeQueueB = bar.querySelector('.un-plm-remove-queue');
    const fromQueue = onlyQueuePanelSelected();
    if (removeQueueB) {
      // Was `!onPl && fromQueue`, which is exactly backwards for the case that
      // matters most. Playing a playlist puts you on /watch?v=…&list=PL…, where
      // onPl is TRUE — so the queue button was hidden and the only Remove on
      // offer deleted from the playlist itself. Reported as: "if i select
      // multiple and remove from the side playlist queue it just wont remove
      // from the queue, it removes from the playlist."
      //
      // Both actions are legitimate there and they are not the same action, so
      // both are shown and the labels say which is which. Off a playlist page
      // the queue button is still the only one, as before.
      const showRemoveQueue = fromQueue;
      removeQueueB.style.display = showRemoveQueue ? '' : 'none';
      removeQueueB.disabled = !showRemoveQueue || !n;
    }
    // When both Removes are visible, "Remove" alone is dangerously vague — one
    // takes a video out of this session's Up next, the other deletes it from a
    // playlist you own. Name the destructive one explicitly; revert to the
    // short label when it is the only one on the bar.
    const removeB = bar.querySelector('.un-plm-rm.un-plm-pl');
    if (removeB) {
      const bothVisible = onPl && fromQueue;
      setText(removeB, bothVisible ? 'Delete from playlist' : 'Remove');
      removeB.title = bothVisible
        ? 'Permanently remove the selected videos from this playlist'
        : '';
      removeB.classList.toggle('un-plm-danger', bothVisible);
    }
    // Dedupe is a .un-plm-pl item and lives inside the More menu now, so off a
    // playlist the menu can end up holding nothing but hidden children. Hide
    // the trigger too rather than offering a button that opens an empty menu.
    const moreWrapEl = bar.querySelector('.un-plm-morewrap');
    if (moreWrapEl) {
      const anyVisible = Array.prototype.slice
        .call(moreWrapEl.querySelectorAll('.un-plm-moreitem'))
        .some(function (b) { return b.style.display !== 'none'; });
      moreWrapEl.style.display = anyVisible ? '' : 'none';
    }
    // Actions that need a selection. Keyed off classes, NOT textContent: the
    // Remove button is relabelled to "Delete from playlist" when both Removes
    // are on the bar, and a label match would silently stop disabling it on an
    // empty selection — leaving a live destructive button with nothing picked.
    // (Dedupe works on the whole playlist, so it is not gated.)
    bar.querySelectorAll('.un-plm-act').forEach((b) => {
      // Dedupe acts on the whole playlist, Connect is a precondition, and the
      // More trigger must stay clickable with nothing selected because Dedupe
      // lives inside it.
      // Dedupe acts on the whole playlist, Connect is a precondition, More must
      // stay clickable because Dedupe lives inside it, and Done is the way OUT
      // — greying out the exit when nothing is selected is exactly backwards,
      // since an empty selection is the most likely moment to want to leave.
      if (
        b.classList.contains('un-plm-dedupe') ||
        b.classList.contains('un-plm-connect') ||
        b.classList.contains('un-plm-more') ||
        b.classList.contains('un-plm-done')
      ) {
        return;
      }
      b.disabled = n === 0;
    });
    // need WRITE scope for remove/move/copy/dedupe — show the button until we have it
    const connect = bar.querySelector('.un-plm-connect');
    if (connect) {
      connect.style.display = PL.canWrite ? 'none' : '';
      setText(connect, PL.authed ? 'Enable edits' : 'Connect YouTube');
    }
    const forgeSend = bar.querySelector('.un-plm-forge-btn');
    if (forgeSend) {
      const showSend = PL.selecting && n > 0;
      forgeSend.style.display = showSend ? '' : 'none';
      forgeSend.disabled = !showSend;
    }
    const forge = bar.querySelector('.un-plm-forge');
    if (forge && FL) {
      if (onPl && PL.plId) forge.href = FL.forgeManage(PL.plId);
      else forge.href = FL.forgeHome();
    }
  }

  // ---- destination picker (clean searchable playlist list) ----
  function closePicker() {
    const pick = document.getElementById('un-plm-picker');
    if (pick) pick.remove();
    document.removeEventListener('click', onDocClickClose, true);
    document.removeEventListener('keydown', onPickerKey, true);
  }
  function onDocClickClose(e) {
  // Not a user dismissal -- see queue-advance.js docClickHandler.
  if (e && e.isTrusted === false) return;
    const pick = document.getElementById('un-plm-picker');
    if (pick && !pick.contains(e.target) && !e.target.closest('.un-plm-act')) closePicker();
  }
  // Escape dismisses the picker.
  //
  // Click-outside was the only way to close it, which leaves the keyboard with
  // no exit at all and breaks the expectation every other dismissible surface
  // on the page sets — including this module's own queue menu, which already
  // handled Escape. Capture phase so it fires before YouTube's own handlers,
  // and stopPropagation so dismissing the picker doesn't also trigger whatever
  // Escape means to the page underneath (closing the player's settings menu,
  // exiting fullscreen).
  function onPickerKey(e) {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('un-plm-picker')) return;
    e.stopPropagation();
    e.preventDefault();
    closePicker();
  }
  // Turns the empty-list state into a message that says what actually happened.
  // "No playlists yet." is only true when the fetch SUCCEEDED and returned
  // nothing; for every failure mode it is a lie that sends the user looking in
  // the wrong place.
  // Single source of truth for "is this failure fixed by signing in again?".
  // The message and the button used to test different patterns, so a
  // `not_authed` / `refresh_failed` error (neither of which contains the
  // literal "auth" or "token") printed "sign-in expired" above a button
  // labelled "Retry" that only re-ran the same doomed fetch. Observed live.
  // NOTE on the status matching: the API layer throws 'yt_api_401' / 'yt_api_403'
  // (src/shared/api.js). A \b word boundary does NOT fire between '_' and '4'
  // because '_' is a word character, so /\b401\b/ never matched those strings —
  // an expired-token 401 fell through to the generic branch. Match the real
  // shape instead, and anchor the end so 'yt_api_4031' can't masquerade as 403.
  function isAuthError(err) {
    const e = String(err || '');
    if (/not_authed|no_refresh_token|refresh_failed|auth_expired|invalid_grant/i.test(e)) return true;
    return /(^|[^0-9])401([^0-9]|$)/.test(e);
  }

  function emptyListMessage(query) {
    if (query) return 'No matching playlist.';
    if (!PL.plsError) return 'No playlists yet.';
    const e = String(PL.plsError);
    if (isAuthError(e)) return 'YouTube sign-in expired — reconnect to see your playlists.';
    if (/(^|[^0-9])403([^0-9]|$)/.test(e)) return 'YouTube refused the request (403). Check the API key/OAuth setup in Settings.';
    if (/quota/i.test(e)) return 'Daily YouTube API quota used up — your playlists will load again tomorrow.';
    if (/no_response/i.test(e)) return "Couldn't reach the extension background. Try again in a moment.";
    return "Couldn't load your playlists: " + e.slice(0, 80);
  }

  function openPicker(mode, anchor, vids, opts) {
    closePicker();
    const sel = vids || Array.from(PL.selected);
    if (!sel.length) return;
    opts = opts || {};
    const watchedArchive = !!opts.watchedArchive;
    const n = sel.length;
    const pick = el('div', 'un-plm-picker');
    pick.id = 'un-plm-picker';
    pick.append(el('div', 'un-plm-pk-head', (mode === 'move' ? 'Move ' : 'Add ') + n + (n === 1 ? ' video to' : ' videos to')));

    if (!PL.canWrite) {
      pick.append(
        el('div', 'un-plm-pk-empty', PL.authed ? "You're connected read-only. Enable edits to move or copy between playlists." : 'Connect YouTube to move or copy between playlists.')
      );
      // When connected read-only we CAN list the playlists, so show them
      // (inert) rather than an empty panel. Hiding them made a working
      // connection look broken — the user can see the account is linked, so a
      // blank list reads as "the extension can't find my playlists" instead of
      // "you need one more permission".
      if (PL.authed && PL.pls.length) {
        const preview = el('div', 'un-plm-pk-list un-plm-pk-list-ro');
        PL.pls.slice(0, 50).forEach((p) => {
          const row = el('div', 'un-plm-pk-row un-plm-pk-row-ro');
          row.append(el('span', 'un-plm-pk-t', p.title), el('span', 'un-plm-pk-c', String(p.count)));
          preview.append(row);
        });
        pick.append(preview);
      }
      const c = btn('un-plm-act un-plm-connect', PL.authed ? 'Enable edits' : 'Connect YouTube');
      c.style.display = '';
      c.addEventListener('click', async () => {
        closePicker();
        await connectYouTube();
      });
      pick.append(c);
    } else {
      const search = el('input', 'un-plm-pk-search');
      search.type = 'text';
      search.placeholder = 'Search your playlists…';
      const list = el('div', 'un-plm-pk-list');
      // Multi-select: tick one or more destinations, then apply once. Recent
      // destinations float to the top so the playlists you actually use are a
      // single click away.
      const chosen = new Set();

      const foot = el('div', 'un-plm-pk-foot');
      const applyBtn = btn('un-plm-pk-apply', '');
      applyBtn.addEventListener('click', () => {
        const dests = Array.from(chosen);
        if (!dests.length) return;
        closePicker();
        applyDestinations(dests, mode === 'move', sel);
      });
      foot.append(applyBtn);

      const refreshApply = () => {
        const k = chosen.size;
        applyBtn.disabled = k === 0;
        applyBtn.textContent = k === 0
          ? (mode === 'move' ? 'Move to…' : 'Add to…')
          : (mode === 'move' ? 'Move to ' : 'Add to ') + k + (k === 1 ? ' playlist' : ' playlists');
      };

      // Playlists the (single) video is already in — floated to the top when known.
      let inIds = new Set();

      const rowFor = (p, isIn) => {
        const row = el('label', 'un-plm-pk-row');
        if (chosen.has(p.id)) row.classList.add('on');
        const ck = el('input', 'un-plm-pk-ck');
        ck.type = 'checkbox';
        ck.checked = chosen.has(p.id);
        ck.addEventListener('change', () => {
          if (ck.checked) chosen.add(p.id);
          else chosen.delete(p.id);
          row.classList.toggle('on', ck.checked);
          refreshApply();
        });
        row.append(ck, el('span', 'un-plm-pk-t', p.title));
        if (isIn) row.append(el('span', 'un-plm-pk-in', '✓ in'));
        row.append(el('span', 'un-plm-pk-c', String(p.count)));
        return row;
      };

      const render = (q) => {
        list.textContent = '';
        const wlItem = { id: 'WL', title: 'Watch later', count: 'Standard' };
        // Exclude the CURRENT playlist only while managing that playlist's own
        // page, where "add to the list you are already looking at" is a no-op
        // and "move" would be meaningless. On a watch page the &list= param is
        // just what is playing — adding a sidebar suggestion to the playlist
        // you are currently watching is a completely reasonable thing to want,
        // and hiding it made the destination look mysteriously missing.
        const excludeId = onPlaylistPage() ? PL.plId : null;
        const avail = PL.pls.filter((p) => p.id !== excludeId && p.id !== 'WL');
        const matches = avail.filter((p) => !q || p.title.toLowerCase().includes(q));
        const showWl = !q || 'watch later'.includes(q);

        if (!matches.length && !showWl) {
          list.append(el('div', 'un-plm-pk-empty', emptyListMessage(q)));
          if (PL.plsError) {
            // Offer the action that actually fixes the common case (an expired
            // or revoked token) instead of leaving a dead end.
            const needsAuth = isAuthError(PL.plsError);
            const retry = btn('un-plm-act un-plm-connect', needsAuth ? 'Reconnect YouTube' : 'Retry');
            retry.style.display = '';
            retry.addEventListener('click', async () => {
              closePicker();
              if (needsAuth) {
                await connectYouTube();
                return;
              }
              PL.pls = [];
              PL.plsError = null;
              await ensurePlaylistData();
            });
            list.append(retry);
          }
          return;
        }
        // Sections (when not searching): Standard Watch Later at the very top,
        // then playlists the video is ALREADY IN, then your Recent destinations, then everything else.
        const groups = [];
        const archivePl = findWatchedArchivePlaylist(avail);
        if (q) {
          const qItems = showWl ? [wlItem].concat(matches) : matches;
          groups.push(['', qItems]);
        } else {
          groups.push(['Standard', [wlItem]]);
          if (watchedArchive && archivePl) {
            groups.push(['Watched archive', [archivePl]]);
          }
          const skipArchive = archivePl ? archivePl.id : null;
          const already = matches.filter((p) => inIds.has(p.id) && p.id !== skipArchive);
          const recent = recentIds.map((id) => matches.find((p) => p.id === id)).filter((p) => p && !inIds.has(p.id) && p.id !== 'WL' && p.id !== skipArchive);
          const used = new Set(already.concat(recent).map((p) => p.id));
          if (skipArchive) used.add(skipArchive);
          const rest = matches.filter((p) => !used.has(p.id) && p.id !== 'WL');
          if (already.length) groups.push(['Already in', already]);
          if (recent.length) groups.push(['Recent', recent]);
          if (rest.length) groups.push([groups.length ? 'All playlists' : '', rest]);
        }
        const showCreateWatched = watchedArchive && !archivePl && (!q || 'watched'.indexOf(q) !== -1);
        let createPlaced = false;
        const placeCreateWatched = () => {
          if (!showCreateWatched || createPlaced) return;
          createPlaced = true;
          list.append(el('div', 'un-plm-pk-sec', 'Watched archive'));
          const createRow = btn('un-plm-pk-create-watched', "Create 'Watched' playlist and move");
          createRow.addEventListener('click', async () => {
            closePicker();
            toastBar('Creating Watched playlist…');
            const r = await send(M_CREATE, {
              title: 'Watched',
              description: 'Videos you have already watched. Unsynth moves finished playlist items here so the original list stays unwatched.',
              privacyStatus: 'private'
            });
            const newId = r && (r.playlistId || (r.playlist && r.playlist.id));
            if (!newId) {
              toastBar(r && r.error === 'needs_write_scope' ? 'Connect YouTube with edit access first' : 'Could not create Watched playlist');
              return;
            }
            PL.pls = [{ id: newId, title: 'Watched', count: 0 }].concat(PL.pls.filter((p) => p.id !== newId));
            await applyDestinations([newId], mode === 'move', sel);
          });
          list.append(createRow);
        };
        groups.forEach(([label, items]) => {
          if (label) list.append(el('div', 'un-plm-pk-sec', label));
          items.forEach((p) => list.append(rowFor(p, inIds.has(p.id))));
          if (label === 'Standard') placeCreateWatched();
        });
        placeCreateWatched();
      };

      search.addEventListener('input', () => render(search.value.trim().toLowerCase()));
      render('');
      refreshApply();
      pick.append(search, list, foot);
      setTimeout(() => search.focus(), 30);

      // For a single video, find which playlists already contain it (cheap
      // per-playlist videoId check in the SW) and float them to the top. Skipped
      // for multi-select — membership across the set would be ambiguous.
      if (sel.length === 1 && PL.pls.length) {
        const vid = sel[0];
        // Show a cached answer immediately so reopening the picker for the same
        // video does not blank the "Already in" section while the round-trip
        // repeats.
        const cached = PL.inCache && PL.inCache[vid];
        if (cached) {
          inIds = new Set(cached);
          render(search.value.trim().toLowerCase());
        }
        const memberIds = PL.pls
          .filter((p) => p.id !== (onPlaylistPage() ? PL.plId : null))
          .map((p) => p.id);
        send(M_VIDEO_PLAYLISTS, { videoId: vid, playlistIds: memberIds }).then((r) => {
          if (!r || !r.ok || !r.inIds) return;
          if (!PL.inCache) PL.inCache = {};
          PL.inCache[vid] = r.inIds;
          if (document.getElementById('un-plm-picker') !== pick) return;
          inIds = new Set(r.inIds);
          render(search.value.trim().toLowerCase());
        });
      }
    }
    document.body.append(pick);
    // Anchor near the trigger. With the bulk bar present, sit above it; from a
    // per-row button, drop below the button (or flip up near the viewport floor).
    // Move watched opens the picker from the toolbar while also entering select
    // mode, so the bulk bar exists but has often not laid out yet. Parking above
    // that bar shoved the list off-screen. Pin to the toolbar button instead.
    const bar = opts.watchedArchive ? null : document.getElementById('un-plm-bar');
    const ref = anchor || bar;
    const ar = (ref || document.body).getBoundingClientRect();
    pick.style.left = Math.max(12, Math.min(ar.left, window.innerWidth - 332)) + 'px';
    if (bar) {
      // Sit clear of the bar rather than merely "above where the bar was".
      const MASTHEAD_TOP = 64;
      const placeAboveBar = () => {
        const b = document.getElementById('un-plm-bar');
        const p = document.getElementById('un-plm-picker');
        if (!b || !p) return;
        const top = b.getBoundingClientRect().top;
        if (!top || top <= 0) return;
        const bottomOffset = window.innerHeight - top + 10;
        p.style.bottom = bottomOffset + 'px';
        // Only `bottom` was being set here, so a tall list (many playlists,
        // or the 50-item read-only preview) grew upward past the top of the
        // viewport with no way to scroll back to the search field. The
        // no-bar branch below already clamps this way; this one did not.
        const avail = window.innerHeight - bottomOffset - MASTHEAD_TOP - 8;
        p.style.maxHeight = Math.max(180, avail) + 'px';
      };
      const initialBottom = window.innerHeight - bar.getBoundingClientRect().top + 10;
      pick.style.bottom = initialBottom + 'px';
      pick.style.maxHeight =
        Math.max(180, window.innerHeight - initialBottom - MASTHEAD_TOP - 8) + 'px';
      requestAnimationFrame(placeAboveBar);
    } else {
      const ph = pick.offsetHeight || 340;
      const mastheadTop = 64;
      const spaceBelow = window.innerHeight - ar.bottom - 16;
      const spaceAbove = ar.top - mastheadTop - 16;
      if (spaceBelow >= Math.min(ph, 240) || spaceBelow >= spaceAbove) {
        const top = Math.max(mastheadTop + 4, ar.bottom + 8);
        pick.style.top = top + 'px';
        pick.style.maxHeight = Math.max(180, window.innerHeight - top - 16) + 'px';
      } else {
        const idealTop = ar.top - ph - 8;
        const clampedTop = Math.max(mastheadTop + 4, idealTop);
        pick.style.top = clampedTop + 'px';
        pick.style.maxHeight = Math.max(180, ar.top - clampedTop - 8) + 'px';
      }
    }
    setTimeout(() => document.addEventListener('click', onDocClickClose, true), 0);
    document.addEventListener('keydown', onPickerKey, true);
  }

  // The one live undo record, or null. Single-level on purpose: a stack of
  // undos on a remote, eventually-consistent list invites reversing operations
  // out of order against a playlist that has moved on underneath them.
  let undoRec = null;
  let undoTimer = null;

  /**
   * Show a message with a "put back" button beside it.
   *
   * The button says "Put N videos back (order is not restored)" rather than
   * "Undo", because a removed item's itemId dies with it and YouTube mints a new
   * one on re-add: the videos come back, at the END of the playlist. Calling
   * that "undo" would imply the playlist returns to its previous state.
   */
  function offerUndo(op, opts, msg) {
    const BU = window.UNBulkUndo;
    const bar = document.getElementById('un-plm-bar');
    undoRec = BU ? BU.record(op, opts) : null;
    if (!BU || !undoRec || !bar) {
      toastBar(msg);
      return;
    }
    toastBar(msg);
    let btn = bar.querySelector('.un-plm-undo');
    if (!btn) {
      btn = el('button', 'un-plm-undo');
      btn.type = 'button';
      btn.addEventListener('click', runUndo);
      bar.appendChild(btn);
    }
    btn.textContent = BU.describe(undoRec) || 'Put back';
    btn.disabled = false;
    btn.style.display = '';
    clearTimeout(undoTimer);
    // Drop the offer when the record expires. A button that has silently gone
    // stale but still looks clickable is worse than no button at all.
    undoTimer = setTimeout(hideUndo, BU.TTL_MS);
  }

  function hideUndo() {
    undoRec = null;
    clearTimeout(undoTimer);
    const btn = document.querySelector('.un-plm-undo');
    if (btn) btn.style.display = 'none';
  }

  const runUndo = withBusy(async function () {
    const BU = window.UNBulkUndo;
    const steps = BU ? BU.plan(undoRec) : [];
    if (!steps.length) {
      hideUndo();
      toastBar('That undo has expired');
      return;
    }
    const btn = document.querySelector('.un-plm-undo');
    if (btn) btn.disabled = true;
    toastBar('Putting back…');

    let failed = 0;
    for (const step of steps) {
      let r;
      if (step.type === 'add') {
        r = await send(M_ADD, { playlistId: step.playlistId, videoIds: step.videoIds });
      } else {
        // Reversing the far half of a move needs that playlist's own itemIds,
        // which this page does not hold. Reported rather than skipped silently:
        // a partial undo that claims success is the failure this whole feature
        // exists to avoid.
        r = { ok: false, error: 'needs_destination_page' };
      }
      if (!r || !r.ok) failed++;
    }
    hideUndo();
    if (failed) {
      toastBar(failed === steps.length ? 'Could not put them back' : 'Put back, but the copy elsewhere remains');
    } else {
      toastBar('Put back at the end of the playlist');
      refreshAfterUndo();
    }
  });

  /** Re-render so the restored rows appear without a manual reload. */
  function refreshAfterUndo() {
    PL.itemMap = null;
    if (typeof decorateRows === 'function') decorateRows();
  }

  function toastBar(msg) {
    const bar = document.getElementById('un-plm-bar');
    if (!bar) {
      // No bulk bar (per-row action) — show a standalone bottom-center flash.
      flashToast(msg);
      return;
    }
    let t = bar.querySelector('.un-plm-toast');
    if (!t) {
      t = el('span', 'un-plm-toast');
      bar.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = '';
    clearTimeout(toastBar._t);
    toastBar._t = setTimeout(() => {
      t.style.display = 'none';
      t.textContent = '';
    }, 3000);
  }
  function flashToast(msg) {
    let f = document.getElementById('un-plm-flash');
    if (!f) {
      f = el('div', 'un-plm-flash');
      f.id = 'un-plm-flash';
      document.body.appendChild(f);
    }
    f.textContent = msg;
    f.classList.add('on');
    clearTimeout(flashToast._t);
    flashToast._t = setTimeout(() => f.classList.remove('on'), 3000);
  }

  // Select all. On a playlist (finite, virtualized) auto-scroll to load every
  // row first. On feeds (home/search/subs are endless) just take what's rendered.
  let selectingAll = false;
  async function selectAll() {
    if (selectingAll) return;
    selectingAll = true;
    const grab = () =>
      allRows().forEach((row) => {
        const v = rowVideoId(row);
        if (v) PL.selected.add(v);
      });
    if (onPlaylistPage()) {
      const fab = document.getElementById('un-plm-btn');
      toastBar('Loading every video…');
      const y0 = window.scrollY;
      let last = -1;
      let stable = 0;
      for (let i = 0; i < 80; i++) {
        grab();
        decorateRows();
        updateBar();
        if (fab) fab.textContent = '… ' + PL.selected.size;
        window.scrollTo(0, document.documentElement.scrollHeight);
        await wait(380);
        const n = PL.selected.size;
        if (n === last) {
          if (++stable >= 3) break;
        } else {
          stable = 0;
          last = n;
        }
      }
      window.scrollTo(0, y0);
      await wait(150);
      setFabLabel();
    } else {
      grab();
    }
    decorateRows();
    updateBar();
    toastBar('Selected ' + PL.selected.size);
    selectingAll = false;
  }

  function doCopyLinks() {
    const vids = Array.from(PL.selected);
    if (!vids.length) return;
    const links = vids.map((v) => 'https://www.youtube.com/watch?v=' + v).join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText(links) : Promise.reject()).then(
      () => toastBar('Copied ' + vids.length + ' link' + (vids.length === 1 ? '' : 's')),
      () => toastBar('Copy failed')
    );
  }

  // ---- data: auth + playlists + videoId→itemId map ----
  function hasWrite(scopeKeys) {
    return !!(scopeKeys && scopeKeys.indexOf('write') !== -1);
  }
  async function checkAuth() {
    const r = await send('UNSYNTH/AUTH/STATUS');
    PL.authed = !!(r && r.authed);
    PL.canWrite = !!(r && r.authed) && hasWrite(r.scopeKeys);
    updateBar();
    return PL.authed;
  }
  // Keeps WHY the fetch failed, instead of collapsing every failure into an
  // empty list. The picker used to render "No playlists yet." for an expired
  // token, an exceeded API quota, and a genuinely empty account alike — over an
  // account with ~95 playlists, observed live. An empty list is a legitimate
  // state; an error is not, and the two must not look identical.
  async function loadPlaylists() {
    const r = await send(M_PLS);
    if (r && r.ok) {
      PL.authed = true;
      PL.pls = r.playlists || [];
      PL.plsError = null;
    } else {
      PL.pls = [];
      // `send()` resolves null when the background never answered (worker
      // asleep / message port closed), which is itself worth surfacing.
      PL.plsError = (r && r.error) || 'no_response';
    }
    updateBar();
  }
  async function connectYouTube() {
    toastBar('Opening Google sign-in…');
    const r = await send('UNSYNTH/AUTH/START', { scopes: ['readonly', 'write'] });
    if (r && r.ok) {
      PL.authed = true;
      PL.canWrite = hasWrite(r.scopeKeys);
      toastBar(PL.canWrite ? 'Connected — edits enabled ✓' : 'Connected (read-only)');
      PL.itemMap = null;
      PL.itemMapPl = null;
      await loadPlaylists();
    } else {
      toastBar('Connect failed: ' + ((r && r.error) || 'see extension Settings'));
    }
  }
  /**
   * videoId -> playlistItem id for THIS playlist.
   *
   * @param {boolean} [fresh] Bypass the cache. Required before any delete: a
   *   playlistItem id is per-row, not per-video, so an id captured before an
   *   earlier move/remove is already dead. Deleting with a stale id 404s, which
   *   used to surface as "Moved N" while the video stayed in the old playlist.
   */
  async function ensureItemMap(fresh) {
    if (!fresh && PL.itemMapPl === PL.plId && PL.itemMap) return PL.itemMap;
    const r = await send(M_ITEMS, { playlistId: PL.plId });
    if (!r.ok) return null; // not_authed etc.
    const m = {};
    (r.items || []).forEach((it) => {
      if (it.videoId) m[it.videoId] = it.itemId;
    });
    PL.itemMap = m;
    PL.itemMapPl = PL.plId;
    return m;
  }
  function hideRow(vid) {
    allRows().forEach((row) => {
      if (rowVideoId(row) === vid) row.style.display = 'none';
    });
  }

  // ---- write actions ----
  // Serialize the destructive write paths. Without this a double-click on
  // Remove / Move to… fires two overlapping runs against the same selection:
  // the second reads PL.selected before the first has finished clearing it,
  // so the same videos get added twice or removed against a stale item map.
  // organizer.js already does this with state.busy; this is the same idea.
  function withBusy(fn) {
    return async function () {
      if (PL.busy) return undefined;
      PL.busy = true;
      // Any write can change which playlists contain a video, so the
      // "Already in" answer must be re-fetched rather than served stale.
      PL.inCache = null;
      updateBar();
      try {
        return await fn.apply(null, arguments);
      } finally {
        PL.busy = false;
        updateBar();
      }
    };
  }

  function needWrite() {
    if (PL.canWrite) return false;
    toastBar(PL.authed ? 'Enable edits first — the button is in the bar' : 'Connect YouTube first');
    return true;
  }

  // Bulk add/move/remove over a long-lived Port instead of one-shot
  // chrome.runtime.sendMessage.
  //
  // A single sendMessage call used to carry the WHOLE batch: the background
  // handler looped one fetch() per video (add), then one fetch() per item
  // (remove for a move), each followed by a fixed sleep, entirely inside that
  // one message's async handler. For a few dozen+ videos that routinely
  // outlived the MV3 service worker's lifetime — the worker got killed
  // mid-loop, whatever had already been written stayed written, and the
  // content script only ever saw `send()` resolve null (no timeout, no partial
  // progress), which surfaced as a generic "Failed" no matter how much of the
  // batch had actually gone through. Reported live as large playlist moves
  // "not moving them all", stalling, or erroring out.
  //
  // The Port survives worker restarts within the connection's lifetime the
  // same way ai-stream/forge-create already rely on, and the background now
  // reports progress per-item (see runBulkPlaylistOp in service-worker.js) so
  // the UI shows real numbers instead of a single pass/fail after however long
  // the batch takes.
  function runBulkViaPort(payload) {
    return new Promise((resolve) => {
      let settled = false;
      let port;
      try {
        port = chrome.runtime.connect({ name: 'playlist-bulk' });
      } catch (e) {
        resolve(null);
        return;
      }
      function finish(result) {
        if (settled) return;
        settled = true;
        try {
          port.disconnect();
        } catch (e) {
          /* ignore */
        }
        resolve(result);
      }
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'progress') {
          if (msg.phase === 'adding' && msg.total) {
            toastBar('Adding… ' + msg.current + '/' + msg.total + (destIdsCount(payload) > 1 ? ' to ' + shortDest(msg.dest) : ''));
          } else if (msg.phase === 'removing' && msg.total) {
            toastBar('Removing originals… ' + msg.current + '/' + msg.total);
          }
        } else if (msg.type === 'done') {
          finish(msg);
        }
      });
      port.onDisconnect.addListener(() => {
        // A disconnect without a 'done' message means the worker died (or the
        // connection never reached it) before finishing — surface that as a
        // real failure instead of hanging forever, which is what happened
        // with the old sendMessage path when the worker was killed mid-loop.
        if (!settled) finish(null);
      });
      try {
        port.postMessage(Object.assign({ type: 'apply' }, payload));
      } catch (e) {
        finish(null);
      }
    });
  }
  function destIdsCount(payload) {
    return (payload && payload.destIds && payload.destIds.length) || 0;
  }
  function shortDest(id) {
    const p = PL.pls.find((x) => x.id === id);
    return p ? p.title : id || '';
  }
  // Pure: past this many individual API writes (videos × destinations, or
  // items to remove), route through the Port instead of one-shot
  // chrome.runtime.sendMessage. Below the threshold a plain message is
  // cheaper (no Port setup) and still finishes well inside the MV3 worker's
  // lifetime even running serially-equivalent work; above it, a worker
  // restart mid-batch becomes a real risk and the Port's per-item progress
  // and restart-survivability start to matter. Extracted so the threshold is
  // pinned by a test instead of living only as a magic number at each call
  // site (removeVids / applyDestinations / doDedupe all used to repeat it).
  function shouldUsePortForBulkOp(workUnits) {
    return workUnits > 10;
  }

  // Remove a specific set of videoIds from THIS playlist. Shared by the bulk
  // "Remove" button and per-row remove. Returns the count removed (or -1 on error).
  const removeVids = withBusy(async function (vids) {
    if (!vids.length) return -1;
    if (needWrite()) return -1;
    toastBar('Working…');
    // Fresh map — a playlistItem id cached before an earlier move/remove in this
    // session no longer exists, and deleting a dead id 404s.
    const map = await ensureItemMap(true);
    if (!map) {
      toastBar('Connect YouTube first');
      return -1;
    }
    const pairs = vids.map((v) => [v, map[v]]).filter((p) => p[1]);
    if (!pairs.length) {
      toastBar('Items not found (playlist over 400?)');
      return -1;
    }
    const itemIds = pairs.map((p) => p[1]);
    // Small batches go through the plain one-shot message (cheap, no need for
    // a Port's setup cost); larger ones use the Port so the run survives a
    // worker restart and reports progress instead of one silent wait.
    const r = shouldUsePortForBulkOp(itemIds.length)
      ? await runBulkViaPort({ destIds: [], move: false, videoIds: [], itemIds, sourcePlaylistId: PL.plId }).then((d) =>
          d ? { ok: d.ok, removed: d.removed, error: d.error } : { ok: false, error: 'no_response' }
        )
      : await send(M_REMOVE, { itemIds });
    if (!r || !r.ok) {
      toastBar(r && r.error === 'auth_expired' ? 'Reconnect YouTube' : 'Failed: ' + ((r && r.error) || ''));
      return -1;
    }
    // Hide only what actually got deleted — hiding a row whose DELETE failed
    // makes a still-present video look gone until the next reload.
    const failedIds = new Set(r.failed || []);
    let n = 0;
    pairs.forEach(([v, itemId]) => {
      if (failedIds.has(itemId)) return;
      PL.selected.delete(v);
      delete map[v];
      hideRow(v);
      n++;
    });
    updateBar();
    // main's count (PR #6): only rows whose DELETE actually succeeded, so a
    // partial removal says so instead of claiming all of them. The undo offer
    // carries that same message rather than replacing it with a rosier one.
    const msg = n === pairs.length ? 'Removed ' + n : 'Removed ' + n + ' of ' + pairs.length;
    // Offer to put them back rather than confirming beforehand. A confirm costs
    // a decision on the 99 runs that were correct to protect the 1 that was not,
    // and trains people to click through it. This keeps the common case at one
    // click and makes the mistake recoverable.
    //
    // Only the videos that actually left are offered back — putting back a row
    // whose delete failed would duplicate it.
    const removedVids = pairs.filter(([, itemId]) => !failedIds.has(itemId)).map(([v]) => v);
    offerUndo('remove', { playlistId: PL.plId, videoIds: removedVids }, msg);
    return n;
  });
  function doRemove() {
    return removeVids(Array.from(PL.selected));
  }

  // Add the videoIds into ONE OR MORE destination playlists. For "move", the
  // originals are removed from THIS playlist once, after the adds. Each used
  // destination is recorded so the picker floats it to the top next time.
  const applyDestinations = withBusy(async function (destIds, move, vids) {
    vids = vids || Array.from(PL.selected);
    destIds = (destIds || []).filter(Boolean);
    if (!vids.length || !destIds.length) return;
    if (needWrite()) return;
    toastBar('Working…');

    // Large batches (more videos×destinations than a single sendMessage
    // reliably survives — see runBulkViaPort above) go through the Port,
    // which also handles the move's remove-originals phase in the same
    // worker-restart-safe run instead of a second, separate one-shot call.
    const workUnits = vids.length * destIds.length;
    if (shouldUsePortForBulkOp(workUnits)) {
      // Send PAIRS, not two arrays that have to stay index-aligned by luck.
      // itemIds used to be vids.map((v) => map[v]).filter(Boolean), and that
      // filter COMPACTS: one video missing from the map shifts every later item
      // id back a slot. The worker pairs each original with its add result to
      // decide what is safe to delete, so a shifted array means it spares and
      // deletes the wrong rows — the exact data-loss class this whole guard
      // exists to prevent, reintroduced by the guard itself.
      let itemPairs = [];
      if (move) {
        const map = await ensureItemMap();
        if (map) {
          itemPairs = vids
            .map((v) => ({ videoId: v, itemId: map[v] }))
            .filter((pr) => pr.itemId);
        }
      }
      const itemIds = itemPairs.map((pr) => pr.itemId);
      const d = await runBulkViaPort({
        destIds,
        move,
        videoIds: vids,
        itemIds,
        itemPairs,
        sourcePlaylistId: PL.plId
      });
      if (!d || !d.ok) {
        const err = (d && d.error) || 'no_response';
        toastBar(err === 'auth_expired' ? 'Reconnect YouTube' : err === 'not_authed' ? 'Connect YouTube first' : 'Failed: ' + err);
        return;
      }
      destIds.forEach((id) => {
        if (d.perDest && d.perDest[id] && d.perDest[id].added) pushRecent(id);
      });
      const where = d.okDests === 1 ? '1 playlist' : d.okDests + ' playlists';
      if (!move) {
        toastBar('Added ' + vids.length + ' to ' + where);
        return;
      }
      if (d.removed) {
        // Only clear the rows that actually left. keptBack names the videos the
        // worker refused to delete because their add failed — they are still in
        // this playlist, so hiding their rows would make a partial move look
        // complete and the video would only reappear on reload.
        const kept = new Set(Array.isArray(d.keptBack) ? d.keptBack : []);
        const map = PL.itemMap || {};
        vids.forEach((v) => {
          if (kept.has(v)) return;
          PL.selected.delete(v);
          delete map[v];
          hideRow(v);
        });
        updateBar();
        const movedCount = vids.length - kept.size;
        toastBar(
          kept.size
            ? 'Moved ' + movedCount + ' to ' + where + ' — kept ' + kept.size + ' here (add failed)'
            : 'Moved ' + vids.length + ' to ' + where
        );
      } else {
        toastBar('Added to ' + where + (d.moveIncomplete ? ' (reconnect to remove originals)' : ' (remove failed)'));
      }
      return;
    }

    let okDests = 0;
    let lastErr = '';
    // Track which videos failed to land in EVERY destination. A move must never
    // delete an original that isn't safely somewhere else — a partial add
    // followed by a blanket delete loses the video from both playlists.
    const addFailedEverywhere = new Set(vids);
    for (const dest of destIds) {
      const r = await send(M_ADD, { playlistId: dest, videoIds: vids });
      if (r.ok) {
        okDests++;
        pushRecent(dest);
        const failedHere = new Set(r.failed || []);
        vids.forEach((v) => {
          if (!failedHere.has(v)) addFailedEverywhere.delete(v);
        });
      } else {
        lastErr = r.error || '';
      }
    }
    if (!okDests) {
      toastBar(
        lastErr === 'auth_expired'
          ? 'Reconnect YouTube'
          : lastErr === 'not_authed'
            ? 'Connect YouTube first'
            : // A readonly token refuses writes with 403. Without this the bar
              // read "Failed: needs_write_scope", which does not tell anyone
              // what to actually do about it.
              lastErr === 'needs_write_scope'
              ? 'Reconnect YouTube with edit access (Dashboard → Account)'
              : 'Failed: ' + lastErr
      );
      return;
    }
    const where = okDests === 1 ? '1 playlist' : okDests + ' playlists';
    if (!move) {
      toastBar('Added ' + vids.length + ' to ' + where);
      return;
    }
    // Move = remove the originals from this playlist once (after the adds).
    // Refetch the item map: playlistItem ids are per-row, so any id cached
    // before an earlier move in this session is dead and its DELETE 404s.
    const map = await ensureItemMap(true);
    if (!map) {
      toastBar('Added to ' + where + ' (reconnect to remove originals)');
      return;
    }
    // Only delete originals that actually reached a destination.
    const safeToRemove = vids.filter((v) => !addFailedEverywhere.has(v));
    if (safeToRemove.length < vids.length) {
      const stuck = vids.length - safeToRemove.length;
      toastBar('Added to ' + where + ' — kept ' + stuck + ' here (add failed)');
    }
    const pairs = safeToRemove.map((v) => [v, map[v]]).filter((p) => p[1]);
    if (!pairs.length) {
      toastBar('Added to ' + where + ' (originals not found to remove)');
      return;
    }
    const rr = await send(M_REMOVE, { itemIds: pairs.map((p) => p[1]) });
    if (!rr.ok) {
      toastBar(rr.error === 'auth_expired' ? 'Added to ' + where + ' (reconnect to remove originals)' : 'Added to ' + where + ' (remove failed)');
      return;
    }
    // Only clear rows the API actually deleted. A partial failure used to hide
    // every row regardless, so videos still in the playlist vanished from view
    // until reload and the move looked complete when it wasn't.
    const failedIds = new Set(rr.failed || []);
    let removedCount = 0;
    pairs.forEach(([v, itemId]) => {
      if (failedIds.has(itemId)) return;
      PL.selected.delete(v);
      delete map[v];
      hideRow(v);
      removedCount++;
    });
    updateBar();
    if (removedCount === vids.length) {
      toastBar('Moved ' + removedCount + ' to ' + where);
    } else {
      // Compare against what we attempted to remove, not the original selection —
      // videos deliberately kept back (their add failed) aren't remove failures.
      toastBar('Added to ' + where + ' — removed ' + removedCount + ' of ' + pairs.length + ' originals');
    }
  });

  const doDedupe = withBusy(async function () {
    if (needWrite()) return;
    toastBar('Scanning…');
    const map = await ensureItemMap();
    if (!map) {
      toastBar('Connect YouTube first');
      return;
    }
    // re-fetch the full item list (ordered) to find duplicate videoIds
    const r = await send(M_ITEMS, { playlistId: PL.plId });
    if (!r.ok) {
      toastBar('Connect YouTube first');
      return;
    }
    const seen = {};
    const dupeItemIds = [];
    const dupeVids = [];
    (r.items || []).forEach((it) => {
      if (!it.videoId) return;
      if (seen[it.videoId]) {
        dupeItemIds.push(it.itemId);
        dupeVids.push(it.videoId);
      } else seen[it.videoId] = true;
    });
    if (!dupeItemIds.length) {
      toastBar('No duplicates');
      return;
    }
    toastBar('Removing ' + dupeItemIds.length + ' duplicate' + (dupeItemIds.length === 1 ? '' : 's') + '…');
    const rr = shouldUsePortForBulkOp(dupeItemIds.length)
      ? await runBulkViaPort({ destIds: [], move: false, videoIds: [], itemIds: dupeItemIds, sourcePlaylistId: PL.plId }).then((d) =>
          d ? { ok: d.ok, removed: d.removed, error: d.error } : { ok: false, error: 'no_response' }
        )
      : await send(M_REMOVE, { itemIds: dupeItemIds });
    if (!rr || !rr.ok) {
      toastBar(rr && rr.error === 'auth_expired' ? 'Reconnect YouTube' : 'Failed');
      return;
    }
    toastBar('Removed ' + (rr.removed != null ? rr.removed : dupeItemIds.length) + ' duplicates — reload to refresh');
  });

  // ---- search inside the "Save to playlist" popup ----
  function ensureAddToSearch() {
    const renderer = document.querySelector(YT ? YT.PLAYLIST_ADD_TO_SEL : '#playlists');
    if (!renderer || renderer.querySelector('#un-pl-popup-search')) return;
    const input = el('input', 'un-pl-popup-search');
    input.id = 'un-pl-popup-search';
    input.type = 'text';
    input.placeholder = 'Find a playlist…';
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      renderer.querySelectorAll(YT ? YT.PLAYLIST_OPTION_SEL : '[role="option"]').forEach((opt) => {
        const label = opt.querySelector('yt-formatted-string#label, #label, yt-formatted-string');
        const text = label ? label.textContent.toLowerCase() : '';
        opt.style.display = !q || text.includes(q) ? '' : 'none';
      });
    });
    const anchor = renderer.querySelector('#playlists') || renderer.firstElementChild || renderer;
    anchor.parentElement ? anchor.parentElement.insertBefore(input, anchor) : renderer.insertBefore(input, renderer.firstChild);
  }

  // ---- per-row hover actions (playlist page, not in bulk-select) ----
  function rowActBtn(glyph, label, onClick, extraClass) {
    const b = btn('un-plm-rowact' + (extraClass ? ' ' + extraClass : ''), glyph);
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Pass the button element explicitly: handlers that await lose
      // e.currentTarget, and the picker needs a stable anchor.
      onClick(e, b);
    });
    return b;
  }

  function selectActBtn(onClick) {
    const b = btn('un-plm-select');
    b.title = 'Select this video';
    b.setAttribute('aria-label', 'Select this video');
    const box = el('span', 'un-plm-selectbox');
    box.setAttribute('aria-hidden', 'true');
    b.appendChild(box);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(e, b);
    });
    return b;
  }

  function ensureOverlay(host, actsClass) {
    host.classList.add('un-plm-rowthumb');
    let ov = host.querySelector(':scope > .un-plm-overlay');
    if (ov) return ov;
    ov = el('div', 'un-plm-overlay');
    const acts = el('div', actsClass);
    const sel = el('div', 'un-plm-selectbtn');
    ov.appendChild(acts);
    ov.appendChild(sel);
    host.appendChild(ov);
    return ov;
  }

  function closeMoreMenu() {
    const m = document.getElementById('un-plm-more-menu');
    if (m) m.remove();
    if (moreMenuDocClick) {
      document.removeEventListener('click', moreMenuDocClick, true);
      moreMenuDocClick = null;
    }
    if (moreMenuKey) {
      document.removeEventListener('keydown', moreMenuKey, true);
      moreMenuKey = null;
    }
  }
  let moreMenuDocClick = null;
  let moreMenuKey = null;
  function toggleMoreMenu(anchorBtn, items) {
    if (document.getElementById('un-plm-more-menu')) {
      closeMoreMenu();
      return;
    }
    closeQueueMenu();
    const menu = document.createElement('div');
    menu.id = 'un-plm-more-menu';
    menu.className = 'un-plm-queue-menu';
    items.forEach((it) => {
      const b = queueMenuItemBtn(it.label, it.onClick);
      if (it.danger) b.classList.add('danger');
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    menu.style.position = 'fixed';
    const r = anchorBtn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    const w = menu.offsetWidth || 150;
    menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px';
    moreMenuDocClick = (e) => {
      if (e && e.isTrusted === false) return;
      if (!menu.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) closeMoreMenu();
    };
    moreMenuKey = (e) => {
      if (e.key === 'Escape') closeMoreMenu();
    };
    setTimeout(() => {
      document.addEventListener('click', moreMenuDocClick, true);
      document.addEventListener('keydown', moreMenuKey, true);
    }, 0);
  }

  // The thumbnail box to hang overlays on.
  //
  // The `|| row` fallback is deliberate but was too eager: on newer playlist
  // markup none of the older selectors matched, so every overlay anchored to
  // the whole ROW instead of the image — measured live at 733px wide, which
  // put the action group and the select button on the same pixels (they both
  // stretched the full row) and pushed the actions across the watched chip.
  // Try the current lockup image selectors too, and only fall back to the row
  // when there is genuinely no image box to use.
  function rowThumb(row) {
    // Prefer the inner image box. PLAYLIST_THUMB_SEL can match the lockup
    // content-image column, which is wider than the rounded thumbnail —
    // the rail then sits in the gutter and paints over the title.
    return (
      row.querySelector(
        'yt-thumbnail-view-model, .ytThumbnailViewModelHost, ytd-thumbnail, ytd-playlist-video-thumbnail-renderer, a#thumbnail'
      ) ||
      row.querySelector(YT ? YT.PLAYLIST_THUMB_SEL : 'a#thumbnail, #thumbnail') ||
      row
    );
  }
  // Feed thumbnail: resolve to the actual thumbnail <a> (the image box), the same
  // element the watched-mark uses, so quick-actions land ON the thumbnail and not
  // on the whole card. Returns null when there's no real thumbnail link.
  // Ad surfaces YouTube renders inside the feed. Their call-to-action is an
  // <a> that can carry a /watch href, so the last fallback below happily
  // matches it and we decorate a 137x40 button as though it were a thumbnail:
  // the quick-actions row (85x60) then overflows it and collides with the
  // select box. Measured on /feed/trending, where every one of these was an
  // ad-button-view-model inside ytwAdButtonGroupViewModelHost. Matched by name
  // rather than by size, because "too small" is a guess about a symptom and
  // "this is an ad" is the actual reason.
  function adHostsSel() {
    return YT ? YT.AD_TILE_SEL : '';
  }

  function feedThumb(row) {
    var adSel = adHostsSel();
    if (adSel && row.closest(adSel)) return null;
    var found = YT && YT.tileThumb ? YT.tileThumb(row) : row.querySelector('a#thumbnail, a[href*="/watch"]');
    // The row itself can be clean while the only /watch link inside it belongs
    // to an ad attachment, so check what was actually found too.
    if (found && adSel && found.closest(adSel)) return null;
    return found;
  }
  // Pure: does a "⋮" menu item's text match YouTube's "Add to queue"?
  //
  // Queueing no longer drives that menu — it goes through the player bridge
  // (see queueVideo) because synthesizing menu clicks was half of why the
  // buttons behaved inconsistently. Kept because it is the string contract for
  // recognizing YouTube's own menu item, which any future menu-driving code
  // (and its tests) still needs.
  function isAddToQueueMatch(text) {
    return /^add to queue$/i.test((text || '').trim());
  }

  // Pure: turns a stream of async DOM-mutating tasks into a strict FIFO queue,
  // for operations that share one global piece of YouTube UI. YouTube reuses a
  // single `ytd-popup-container` popup across every tile's "⋮" menu, so two
  // concurrent menu-driving operations race against the same node. Retained as
  // a tested utility for the menu-driven paths in this module.
  function createSerialQueue() {
    let tail = Promise.resolve();
    return function run(taskFn) {
      const result = tail.then(taskFn, taskFn);
      tail = result.then(
        () => {},
        () => {}
      );
      return result;
    };
  }
  // Play next / Add to queue live behind one small popover rather than two more
  // standalone icons — playlist rows already carry 4 buttons and feed tiles 2;
  // a 5th/3rd icon each starts crowding a thumbnail-sized hit area. Both items
  // route through queueVideo(), the same path "+Q" uses.
  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }
  function rowQueueItem(row) {
    const id = rowVideoId(row);
    if (!id) return null;
    // Prefer selectors scoped to a single clean text element. rowTitle()'s own
    // last-resort fallback (`a[href*="/watch"]`) can match a big wrapping
    // anchor — on some tile types (radio/mix cards) that anchor also contains
    // this row's own injected action buttons, so its textContent picks up
    // their glyphs. #text.ytd-channel-name avoids ytd-channel-name's
    // duplicate visually-hidden text node (confirmed live: the bare element
    // doubles the channel name).
    const titleEl = row.querySelector(YT ? YT.PLAYLIST_ROW_TITLE_SEL : 'h3, #video-title');
    const channelEl = row.querySelector(YT ? YT.PLAYLIST_ROW_CHANNEL_SEL : '#channel-name');
    return {
      id,
      title: clean(titleEl ? titleEl.textContent : rowTitle(row)),
      thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
      channel: clean(channelEl ? channelEl.textContent : ''),
      dur: 0 // no duration-badge parsing exists in this codebase yet; watch-queue.js/dashboard-stats.js already treat 0 as "don't show duration"
    };
  }
  // The ONE queue path for every row/tile button in this module.
  //
  // Previously "+Q" drove YouTube's "⋮" menu by synthesizing clicks while the
  // "▶+" popover wrote to the extension-only list — two different queues from
  // two buttons on the same thumbnail, neither reliably the one YouTube played
  // from. Now both write to YouTube's real queue (via the shared bridge) and
  // mirror into the local list, which is what the Forge panel renders and what
  // queue-advance.js falls back to. One click, one queue, both views agree.
  //
  // The local mirror is intentionally NOT conditional on the native call
  // succeeding: on surfaces where the MAIN-world bridge isn't present the
  // extension's own queue still has to work, which is the behavior that
  // existed before and that the Forge panel depends on.
  // "(extension queue)" means different things depending on where the click
  // happened, and the old flat suffix didn't distinguish them — reported live
  // as "adding to queue doesn't work" from a feed page, which is misleading:
  // YouTube's OWN "Add to queue" needs an active watch page to build the
  // native queue into (see UN_YT_QUEUE_ADD in ai-bridge.js — confirmed live,
  // off /watch the write never survives navigating to one). So queueing from
  // a feed tile ALWAYS lands in the extension's own list, by design, not as a
  // degraded fallback — and queue-advance.js plays it automatically once the
  // current video ends. That's a genuinely different, working path, and
  // deserves different words than "landed in native queue but from a watch
  // page it unexpectedly didn't" (worth flagging as a real anomaly there).
  function queueVideo(item, opts) {
    if (!item || !item.id) return;
    const NQ = window.UNNativeQueue;
    const onWatchPage = (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch');
    const fail = onWatchPage
      ? "Couldn't reach YouTube's queue"
      : "YouTube's queue only builds on a watch page — open a video first";
    if (!NQ) {
      toastBar(fail);
      return;
    }
    // Always an append: opts.toFront is gone from every caller here because the
    // native queue cannot front-insert from an extension. One message, and it
    // is the true one.
    NQ.add([item.id], { toFront: false }).then((r) => {
      toastBar(r && r.native ? 'Added to YouTube queue — lands at the end of Up next' : fail);
    });
  }

  let queueMenuDocClick = null;
  let queueMenuKey = null;
  function closeQueueMenu() {
    const m = document.getElementById('un-plm-queue-menu');
    if (m) m.remove();
    if (queueMenuDocClick) {
      document.removeEventListener('click', queueMenuDocClick, true);
      queueMenuDocClick = null;
    }
    if (queueMenuKey) {
      document.removeEventListener('keydown', queueMenuKey, true);
      queueMenuKey = null;
    }
  }
  function queueMenuItemBtn(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'un-plm-queue-menu-item';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeQueueMenu();
      closeMoreMenu();
      onClick();
    });
    return b;
  }
  function toggleQueueMenu(anchorBtn, row) {
    if (document.getElementById('un-plm-queue-menu')) {
      closeQueueMenu();
      return;
    }
    const item = rowQueueItem(row);
    if (!item) return;
    const menu = document.createElement('div');
    menu.id = 'un-plm-queue-menu';
    menu.className = 'un-plm-queue-menu';
    // One item, not two. "Play next" and "Add to queue" both resolved to the
    // same append — YouTube's queue takes no front-insert from an extension
    // (measured live 2026-09-15: a queue row's menu offers only "Remove from
    // playlist" and "Share"). Offering the choice implied a difference that
    // could not exist.
    menu.appendChild(
      queueMenuItemBtn('Add to queue', () => {
        queueVideo(item, { toFront: false });
      })
    );
    document.body.appendChild(menu);
    menu.style.position = 'fixed';
    const r = anchorBtn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    const w = menu.offsetWidth || 150;
    menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px';
    queueMenuDocClick = (e) => {
    // Not a user dismissal -- see queue-advance.js docClickHandler.
    if (e && e.isTrusted === false) return;
      if (!menu.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) closeQueueMenu();
    };
    queueMenuKey = (e) => {
      if (e.key === 'Escape') closeQueueMenu();
    };
    setTimeout(() => {
      document.addEventListener('click', queueMenuDocClick, true);
      document.addEventListener('keydown', queueMenuKey, true);
    }, 0);
  }

  function decorateRowActions() {
    if (!onPlaylistPage() || PL.selecting) return;
    allRows().forEach((row) => {
      const vid = rowVideoId(row);
      if (!vid) return;
      const host = rowThumb(row);
      if (host.querySelector(':scope > .un-plm-overlay')) return;
      const ov = ensureOverlay(host, 'un-plm-rowacts');
      const acts = ov.querySelector('.un-plm-rowacts');
      const selWrap = ov.querySelector('.un-plm-selectbtn');
      acts.appendChild(
        rowActBtn('+Q', 'Add to queue', (e, b) => {
          const it = rowQueueItem(row);
          if (!it) return;
          b.disabled = true;
          queueVideo(it, { toFront: false });
          // Re-enable on the next frame: queueVideo resolves asynchronously and
          // leaving the button dead until then makes a working click feel stuck.
          setTimeout(() => {
            b.disabled = false;
          }, 250);
        })
      );
      // ONE queue button, not two. These were a front-insert / append pair until
      // queueVideo dropped opts.toFront (the native queue cannot front-insert
      // from an extension). That pass fixed the lying tooltip but kept both
      // buttons: same handler, same argument, same toast. The duplicate shipped
      // as a second '+Q' that did nothing new and cost 28px of a corner three
      // other controls already share.
      // Move and Remove are the two actions a playlist page exists for, and
      // they were buried two clicks deep behind "⋯ More actions" — reported as
      // the quick buttons not doing remove or move at all. They are direct row
      // buttons now; the overflow keeps them too, so muscle memory still works.
      acts.appendChild(
        rowActBtn('≡→', 'Move to another playlist', async (e, b) => {
          const v = rowVideoId(row);
          if (!v) return;
          await ensurePlaylistData();
          openPicker('move', b, [v]);
        })
      );
      acts.appendChild(
        rowActBtn('✕', 'Remove from this playlist', (e, b) => {
          const v = rowVideoId(row);
          if (v) removeVids([v]);
        }, 'un-plm-rowact-danger')
      );
      acts.appendChild(
        rowActBtn('⋯', 'More actions', (e, b) => {
          toggleMoreMenu(b, [
            {
              label: 'Copy link',
              onClick: () => {
                const v = rowVideoId(row);
                if (!v) return;
                const link = 'https://www.youtube.com/watch?v=' + v;
                (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
                  () => toastBar('Link copied'),
                  () => toastBar('Copy failed')
                );
              }
            },
            {
              label: 'Move to another playlist',
              onClick: async () => {
                const v = rowVideoId(row);
                if (!v) return;
                await ensurePlaylistData();
                openPicker('move', b, [v]);
              }
            },
            {
              label: 'Remove from this playlist',
              danger: true,
              onClick: () => {
                const v = rowVideoId(row);
                if (v) removeVids([v]);
              }
            }
          ]);
        })
      );
      selWrap.appendChild(selectActBtn(() => startSelectFrom(row)));
    });
  }

  // ---- per-thumbnail quick actions on feeds (home / search / subs / watch
  // sidebar): add-to-queue + add-to-playlist. Sits top-right of the thumb so it
  // coexists with the watched bubble (top-left) — they never clobber each other.
  function decorateFeedActions() {
    if (onPlaylistPage() || PL.selecting) return;
    // On watch/shorts, only decorate the related rail — never walk the whole
    // document while the player mutates constantly.
    let rows;
    let panelRowSet = null;
    if ((window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.indexOf('/shorts/') === 0) {
      const root =
        (YT && YT.watchRelatedRoot && YT.watchRelatedRoot()) ||
        document.querySelector(YT ? YT.RELATED_RAIL_SEL : '#related');
      if (!root) return;
      rows = Array.prototype.slice.call(root.querySelectorAll(feedTileSel()));
      // The "Up next" queue panel (ytd-playlist-panel-renderer) lives in
      // #secondary alongside — not inside — the plain #related list, so when
      // both exist watchRelatedRoot() picks #related and every queued
      // thumbnail is outside the searched subtree: reported as "no checkboxes
      // on the thumbnails in the queue" and reproduced live with a real queue
      // open. Query the panel directly so its rows get decorated regardless
      // of which element the root lookup above landed on.
      const panel = document.querySelector(YT ? YT.PLAYLIST_PANEL_SEL : '#secondary');
      if (panel && panel !== root && !root.contains(panel)) {
        // Skip ghost rows: YouTube leaves a removed queue entry in the
        // document hidden via display:none rather than deleting it, so an
        // unfiltered query here would keep re-decorating (and counting)
        // videos that are no longer really in the queue.
        panelRowSet = new Set(
          Array.prototype.slice
            .call(panel.querySelectorAll(feedTileSel()))
            .filter((row) => row.offsetParent !== null)
        );
        panelRowSet.forEach((row) => {
          if (rows.indexOf(row) === -1) rows.push(row);
        });
      }
    } else {
      rows = allRows();
    }
    const isQueuePanelRow = (row) => !!(panelRowSet && panelRowSet.has(row));
    rows.forEach((row) => {
      const vid = rowVideoId(row);
      if (!vid) return;
      const host = feedThumb(row);
      if (!host || host.querySelector(':scope > .un-plm-overlay')) return;
      if (isQueuePanelRow(row)) host.classList.add('un-plm-qpthumb');
      const ov = ensureOverlay(host, 'un-plm-feedacts');
      const acts = ov.querySelector('.un-plm-feedacts');
      const selWrap = ov.querySelector('.un-plm-selectbtn');
      // Queue-panel rows: the checkbox covered the artwork, because the
      // overlay it lives in is inside the 100x56 thumbnail and that thumbnail
      // is overflow:hidden — so NO amount of CSS could move it clear, it would
      // just be clipped. Re-parent it onto the row instead.
      //
      // It goes on the LEFT. An earlier pass parked it on the right on the
      // belief that "everything past the title is empty"; that was wrong.
      // Measured on a live queue: the row is 683px, the title ends at x=2564
      // and YouTube's own ⋮ occupies 2572-2612 with 8px of slack either side.
      // The checkbox landed at 2582-2610 — entirely INSIDE that button — and a
      // hit test confirmed elementFromPoint() at the ⋮'s centre returned
      // span.un-plm-selectbox, so the menu could not be opened at all.
      // The left has real room: a 24px index column and the thumbnail start.
      if (isQueuePanelRow(row) && selWrap && selWrap.parentElement !== row) {
        row.classList.add('un-plm-qprow');
        row.insertBefore(selWrap, row.firstChild);
      }
      if (isQueuePanelRow(row)) ensureQueueRowRemove(row, vid);
      // Queue-panel rows are already in the queue and ~100×56. Only select.
      if (!isQueuePanelRow(row)) {
        acts.appendChild(
          rowActBtn('+Q', 'Add to queue', (e, b) => {
            const it = rowQueueItem(row);
            if (!it) return;
            b.disabled = true;
            queueVideo(it, { toFront: false });
            setTimeout(() => {
              b.disabled = false;
            }, 250);
          })
        );
        // Second '+Q' removed here for the same reason as on playlist rows: it
        // called queueVideo with the identical argument and differed only in its
        // tooltip.
        acts.appendChild(
          rowActBtn('≡+', 'Add to a playlist', async (e, anchorEl) => {
            const v = rowVideoId(row);
            if (!v) return;
            await ensurePlaylistData();
            openPicker('add', anchorEl, [v]);
          })
        );
      }
      selWrap.appendChild(selectActBtn(() => startSelectFrom(row)));
    });
  }

  function run() {
    try {
      ensurePlaylistToolbar();
    } catch (e) {
      /* ignore */
    }
    try {
      ensureManageButton();
    } catch (e) {
      /* ignore */
    }
    try {
      if (PL.selecting) decorateRows();
      else {
        decorateRowActions();
        decorateFeedActions();
      }
    } catch (e) {
      /* ignore */
    }
    try {
      ensureAddToSearch();
    } catch (e) {
      /* ignore */
    }
  }

  // Self-heal run() independent of the core scan loop.
  //
  // init() used to call run() exactly once. On a watch page the related rail
  // hydrates asynchronously, so that single call could land before a single
  // tile existed — hasTiles() false, so the masthead "Select" button was
  // removed/never added and decorateFeedActions()/decorateRowActions() had
  // nothing to decorate. The core MutationObserver scan is supposed to call
  // run() again on the next relevant DOM change, but a watch page that has
  // settled (video paused, nothing else mutating) can go a long time without
  // one — reproduced live on three different watch pages: masthead button,
  // per-tile checkboxes and row actions all silently absent for the page's
  // entire lifetime, no error logged anywhere.
  //
  // Stopping as soon as ANY tile existed was still not enough: a video added
  // to the "Up next" queue panel well after the page settled (no tiles were
  // missing when this first ran) never got decorated either, because nothing
  // re-triggered the check once it had already found tiles once — reproduced
  // live, queueing two videos ~5s after load left both permanently without a
  // select checkbox. Keep checking for any UNDECORATED row (not just "any
  // row") for a longer window, so a late addition still gets a checkbox.
  // Bounded so a page that genuinely never decorates doesn't poll forever.
  function hasUndecoratedRow() {
    return allRows().some((row) => {
      const host = feedThumb(row) || (onPlaylistPage() ? row : null);
      return host && !host.querySelector('.un-plm-selectbtn') && !host.querySelector('.un-plm-shield');
    });
  }
  let pollUntilTilesTimer = null;
  function pollUntilTiles() {
    // A navigation restarts the window rather than stacking a second
    // interval on top of one still running from the previous page.
    if (pollUntilTilesTimer) clearInterval(pollUntilTilesTimer);
    let tries = 0;
    pollUntilTilesTimer = setInterval(() => {
      tries++;
      if (PL.selecting) return; // decorateRows() owns select-mode UI, not this poller
      if (hasTiles() && hasUndecoratedRow()) run();
      if (tries >= 40) {
        clearInterval(pollUntilTilesTimer);
        pollUntilTilesTimer = null;
      }
    }, 750);
  }

  const mod = {
    id: 'playlistBulk',
    moduleKey: 'playlistBulk',
    init(c) {
      core = c;
      loadRecent(); // so the recent-destinations ordering is ready for any picker
      run();
      pollUntilTiles();
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('un-queue-dock-change', applyBarPosition);
        window.addEventListener('un-mini-dock-change', applyBarPosition);
      }
    },
    scan() {
      run();
    },
    onNavigate() {
      run();
      pollUntilTiles();
    },
    // Module switched off: exit select mode and remove all injected UI.
    teardown() {
      if (pollUntilTilesTimer) {
        clearInterval(pollUntilTilesTimer);
        pollUntilTilesTimer = null;
      }
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('un-queue-dock-change', applyBarPosition);
        window.removeEventListener('un-mini-dock-change', applyBarPosition);
      }
      exitSelect();
      closeQueueMenu();
      closeMoreMenu();
      ['un-plm-btn', 'un-plm-bar', 'un-pl-toolbar', 'un-plm-flash'].forEach((id) => {
        const n = document.getElementById(id);
        if (n) n.remove();
      });
      document.querySelectorAll('.un-pl-toolbar, .un-pl-searchwrap').forEach((n) => n.remove());
      document.querySelectorAll('.un-plm-overlay').forEach((n) => n.remove());
      // Queue-panel checkboxes are re-parented onto the row (out of the
      // clipped thumbnail), so removing overlays alone would strand them.
      document.querySelectorAll('.un-plm-qprow > .un-plm-selectbtn').forEach((n) => n.remove());
      document.querySelectorAll('.un-plm-qprow').forEach((n) => n.classList.remove('un-plm-qprow'));
      document.querySelectorAll('.un-plm-rowthumb').forEach((n) => n.classList.remove('un-plm-rowthumb', 'un-plm-qpthumb'));
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { playlistWritableFromUrl, createSerialQueue, isAddToQueueMatch, selectedItemsInOrder, collectWatchedVideoIds, findWatchedArchivePlaylist, shouldFetchPlaylists, shouldUsePortForBulkOp, bulkBarBottomPx };
  } else if (typeof window !== 'undefined' && window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
