/**
 * Unsynth Watched-history module.
 *
 * Tracks how much of each video you've watched and styles feed tiles by it.
 *   - "Fully watched" = >= 75% (or imported from Watchmarker/Takeout).  -> watchedVideos (Set)
 *   - "Partial" = 20%–74% tracked (brief views under 10% are ignored).     -> watchProgress {id: pct}
 * Auto-updates as you watch; persists to chrome.storage.local. Display modes:
 *   off · mark (badge) · dim · hide (watched) · only (watched) · hidestarted (only unseen)
 * Pure DOM, no API, no account access.
 */
(function () {
  'use strict';

  const WS = window.UNWatchStats;
  function fullPct() {
    const t = settings.watchedThreshold;
    return typeof t === 'number' && t >= 50 && t <= 95 ? t : 75;
  }
  /** Only persist progress after this % — skips brief clicks / ~1 min on long videos. */
  const MIN_PROGRESS_SAVE = 10;
  /** Partial badges & "started" filtering kick in here (not at 5%). */
  const MIN_PARTIAL_UI = 20;

  let core = null;
  let WD = null;
  let settings = window.UNSYNTH_DEFAULTS || {};
  let watched = new Set();
  let progress = {};
  let watchedDates = {};
  // videoIds whose date is a first-observed estimate, not a real watch time.
  let approxDates = {};
  // videoId -> latest imported watch day, derived from watchStats.importVideoDays.
  // Built once per load rather than scanned per tile: the import is keyed by
  // DAY, so answering "when did I watch this video" without an index means
  // walking every day for every thumbnail on screen.
  let importDateByVid = null;
  let watchStats = null;
  let dataLoaded = false;
  // How many tiles the watched filter is hiding on this page, and whether the
  // user asked to see them anyway (2026-09-23). Hiding used to leave no trace:
  // 15 videos vanished from a channel grid with nothing on screen saying so.
  // The reveal is per page on purpose: it answers "what did it hide here?",
  // it is not a setting, so onNavigate clears it.
  let hiddenCount = 0;
  let revealHidden = false;

  function formatRelativeWatchTime(ts) {
    if (!ts) return '';
    const now = Date.now();
    const time = typeof ts === 'string' ? (ts.indexOf('-') !== -1 ? new Date(ts).getTime() : Number(ts)) : ts;
    const diffMs = now - time;
    if (isNaN(diffMs) || diffMs < 0) return 'Watched recently';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Watched just now';
    if (mins < 60) return `Watched ${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Watched ${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'Watched yesterday';
    if (days < 7) return `Watched ${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `Watched ${weeks}w ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `Watched ${months}mo ago`;
    const years = Math.floor(days / 365);
    return `Watched ${years}y ago`;
  }

  /**
   * Compact form of the same timestamp for the on-thumbnail pill. The eye
   * icon sitting immediately to its left already says "watched", so
   * repeating the word costs ~52px of a corner that has to share space with
   * the fresh-upload badge and the hover quick-actions.
   * Full sentence form is kept for the tooltip and aria-label.
   */
  function formatCompactWatchTime(ts) {
    const full = formatRelativeWatchTime(ts);
    if (!full) return '';
    return full
      .replace(/^Watched\s+/, '')
      .replace(/\s+ago$/, '')
      .replace(/^just now$/, 'now')
      .replace(/^recently$/, 'seen');
  }

  /**
   * Absolute calendar date for the hover tooltip. The badge shows a relative
   * form ("3mo") because that is what fits on a thumbnail, but "3 months ago"
   * is not an answer to "when exactly did I watch this" — so the precise date
   * belongs on hover.
   */
  function formatExactWatchDate(ts) {
    const time = typeof ts === 'string' ? (ts.indexOf('-') !== -1 ? new Date(ts).getTime() : Number(ts)) : ts;
    const d = new Date(time);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    } catch (e) {
      return d.toLocaleString();
    }
  }

  function getImportDateIndex() {
    if (importDateByVid) return importDateByVid;
    const days = watchStats && watchStats.importVideoDays;
    if (!days) return null;
    const idx = Object.create(null);
    // Keep the LATEST day per video, matching the old intent (sort + last).
    for (const day in days) {
      const vids = days[day];
      if (!vids) continue;
      for (const v in vids) {
        if (!idx[v] || day > idx[v]) idx[v] = day;
      }
    }
    importDateByVid = idx;
    return idx;
  }

  function getWatchTimestamp(vid) {
    if (!vid) return null;
    if (watchedDates && watchedDates[vid]) return watchedDates[vid];
    // importVideoDays is stored as { 'YYYY-MM-DD': { videoId: 1 } } by the
    // Takeout importer (dashboard-core.js), i.e. keyed by DAY. This used to
    // read it as importVideoDays[vid], which is always undefined, so every
    // date from an imported history was unreachable and the badge fell back
    // to "seen" for the whole pre-tracking library.
    const idx = getImportDateIndex();
    if (idx && idx[vid]) return idx[vid];
    return null;
  }
  let video = null;
  let onTimeBound = null;
  let tickTimer = null;
  let saveTimer = null;
  let dirty = false;
  let recordedSession = new Set();
  // Wall-clock dwell on the CURRENT short, keyed by id. currentTime is useless
  // here because a Short loops -- it resets toward 0 on every pass, so it never
  // accumulates and would gate out a short the user genuinely sat through.
  let shortDwell = { vid: null, since: 0 };
  // Videos already folded into the taste profile this session. Separate from
  // recordedSession because taste is recorded EARLIER (at 10% progress) than a
  // full watch (75%) — sharing one set would make the first partial watch
  // suppress the completion record, or vice versa.
  let tasteSession = new Set();
  let trackDot = null;
  let contextWarned = false;
  let popover = null;
  let popVid = null;
  let popTimer = null;
  let lastAttachedVid = null; // track last attached video ID to detect Shorts→Shorts reuse
  let leavingVid = null;     // saved by yt-navigate-start BEFORE url changes

  // Named listener refs so teardown can remove them without leaking on disable/re-enable.
  let onStorageChanged = null;
  let onPageHide = null;
  let onVisibilityChange = null;
  let onNavStart = null;
  // Popover document-level listeners registered in ensurePopover — stored so
  // teardown can remove them when the module is disabled.
  let popClickListener = null;
  let popKeyListener = null;
  let popScrollListener = null;

  function ensurePopover() {
    if (popover) return popover;
    popover = document.createElement('div');
    popover.className = 'un-watched-pop';
    popover.setAttribute('role', 'dialog');
    document.body.appendChild(popover);
    popClickListener = (e) => {
      if (popover && !popover.contains(e.target) && !e.target.closest('.uwm-chip')) hidePopover();
    };
    popKeyListener = (e) => {
      if (e.key === 'Escape') hidePopover();
    };
    // Dismiss on any scroll — the popover is positioned absolutely and would
    // otherwise float, detached, while the page scrolls underneath it.
    popScrollListener = () => {
      if (popover && popover.classList.contains('open')) hidePopover();
    };
    document.addEventListener('click', popClickListener);
    document.addEventListener('keydown', popKeyListener);
    window.addEventListener('scroll', popScrollListener, { passive: true, capture: true });
    return popover;
  }
  function hidePopover() {
    if (popTimer) { clearTimeout(popTimer); popTimer = null; }
    if (popover) popover.classList.remove('open');
    popVid = null;
  }
  function showPopover(anchor, vid, full, part, manual) {
    const p = ensurePopover();
    popVid = vid;
    p.textContent = '';
    function addLine(html) {
      const el = document.createElement('div');
      el.className = 'uwp-line';
      // All content here is controlled strings or safe video IDs — not user input.
      // Use textContent where possible; use DOM for the <b> tags.
      el.innerHTML = html; // controlled strings only
      p.appendChild(el);
    }
    if (full) {
      addLine(manual
        ? '<b>Marked manually</b> — adds to distinct count, not play count.'
        : '<b>Fully watched</b> — you reached ' + fullPct() + '%+ or imported this from history.');
      addLine('Badge: red ✓ on feed tiles.');
    } else {
      addLine('<b>In progress</b> — ' + part + '% watched so far.');
      addLine('Finish past ' + fullPct() + '% to mark fully watched.');
    }
    const idEl = document.createElement('span');
    idEl.className = 'uwp-id';
    idEl.textContent = 'ID: ' + vid; // textContent — safe
    p.appendChild(idEl);
    const r = anchor.getBoundingClientRect();
    p.style.left = Math.min(window.innerWidth - 280, Math.max(8, r.left)) + 'px';
    p.style.top = Math.min(window.innerHeight - 120, r.bottom + 6) + 'px';
    p.classList.add('open');
    // Auto-dismiss so the info popover never lingers; any click/scroll closes it sooner.
    if (popTimer) clearTimeout(popTimer);
    popTimer = setTimeout(hidePopover, manual ? 2200 : 4000);
  }
  function wireMarkClick(mk, vid, full, part) {
    const chip = mk.querySelector('.uwm-chip');
    if (!chip) return;
    // Store the current tile state on the element so click handlers always
    // read the LATEST values — tile recycling won't trigger the wrong video.
    chip.dataset.unwVid = vid;
    chip.dataset.unwFull = full ? '1' : '';
    chip.dataset.unwPart = String(part);
    if (chip.dataset.unwired) return; // listeners already attached
    chip.dataset.unwired = '1';
    let pressTimer = null;
    let longPress = false;

    function currentState() {
      return {
        vid: chip.dataset.unwVid,
        full: !!chip.dataset.unwFull,
        part: Number(chip.dataset.unwPart) || 0
      };
    }

    function openDetails() {
      const s = currentState();
      if (popVid === s.vid && popover && popover.classList.contains('open')) hidePopover();
      else showPopover(chip, s.vid, s.full, s.part);
    }

    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (longPress) {
        longPress = false;
        return;
      }
      const s = currentState();
      if (e.shiftKey) {
        openDetails();
        return;
      }
      if (watched.has(s.vid)) unmark(s.vid);
      else {
        markFull(s.vid);
        showPopover(chip, s.vid, true, 100, true);
      }
    });

    chip.addEventListener('pointerdown', (e) => {
      if (e.shiftKey || e.button !== 0) return;
      longPress = false;
      pressTimer = setTimeout(() => {
        longPress = true;
        openDetails();
      }, 500);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
      chip.addEventListener(ev, () => {
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = null;
      });
    });
  }

  function isStarted(part, full) {
    return full || (part >= MIN_PARTIAL_UI);
  }

  // Every tile on /feed/history is, by definition, a watched/started video —
  // "Hide watched" or "Only unseen" would otherwise erase the entire page,
  // which defeats the point of visiting it to see your history.
  function onHistoryPage() {
    return location.pathname.indexOf('/feed/history') === 0;
  }

  // The user's own library: history, saved playlists, an open playlist, Watch
  // Later, liked videos. Hiding watched items HERE removes precisely what the
  // user navigated to the page to see — a playlist with the watched entries
  // silently missing looks like the playlist lost videos. Dimming is still
  // useful on these pages (it marks progress without removing anything), so
  // only the 'hide' outcome is suppressed, not 'dim'.
  //
  // Shares the single path list with the 'library' surface in shared/yt-dom.js
  // rather than keeping a second copy — two drifting lists would mean the
  // filter and the surface disagree about what counts as the library.
  function onLibraryPage() {
    const YT = window.UNYtDom;
    if (YT && YT.isLibrarySurface) return YT.isLibrarySurface(location.pathname);
    // yt-dom not injected on this page — fall back to the narrow original
    // guard so history is still protected either way.
    return onHistoryPage();
  }

  function saveDisplay(wd) {
    wd = Object.assign({}, mode(), wd);
    if (WD) settings.watchedMode = WD.toLegacyMode(wd);
    settings.watchedDisplay = wd;
    guardCtx(() => {
      chrome.storage.sync.set({ watchedDisplay: wd, watchedMode: settings.watchedMode }, () => {
        apply();
        syncFeedToggle();
      });
    });
  }

  function isWatchedToday(vid) {
    const ts = getWatchTimestamp(vid);
    if (!ts) return false;
    const time = typeof ts === 'string' ? (ts.indexOf('-') !== -1 ? new Date(ts).getTime() : Number(ts)) : ts;
    const date = new Date(time);
    const now = new Date();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  }

  function wireFreshBadge(tile) {
    if (!tile || !tile.querySelector) return;
    const meta =
      tile.querySelector('#metadata-line') ||
      (YT && YT.TILE_META_ROW_SEL ? tile.querySelector(YT.TILE_META_ROW_SEL) : null) ||
      (YT && YT.VIDEO_META_BLOCK_SEL ? tile.querySelector(YT.VIDEO_META_BLOCK_SEL) : null);
    if (!meta) return;
    const txt = (meta.textContent || '').toLowerCase();
    // Compact ages count too ("2h ago", "45m ago"): YouTube A/B-tests that
    // tile variant (2026-09-23), and "m" is minutes there because month is "mo".
    const isFresh =
      /\b(\d+\s*(second|minute|hour|min|hr|sec|s|m(?!o)|h)s?\s*ago|streamed\s*\d+\s*(second|minute|hour|min|hr|m(?!o)|h)s?\s*ago|just\s*now)\b/i.test(
        txt
      );
    let badge = tile.querySelector('.un-fresh-badge');
    if (isFresh) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'un-fresh-badge';
        badge.textContent = 'New';
        badge.title = 'Uploaded within the last 24 hours';
        const titleEl = tile.querySelector(YT ? YT.TITLE_SEL : '#video-title');
        if (titleEl && titleEl.parentElement) {
          titleEl.parentElement.insertBefore(badge, titleEl);
        } else {
          meta.insertBefore(badge, meta.firstChild);
        }
      }
    } else if (badge) {
      badge.remove();
    }
  }

  function feedViewKey() {
    const wd = mode();
    if (wd.feedFilter === 'today') return 'today';
    if (wd.feedFilter === 'only-watched') return 'only-watched';
    if (wd.feedFilter === 'only-unseen') return 'only-unseen';
    if (wd.finished === 'hide') return 'hide-watched';
    if (wd.finished === 'dim') return 'dim-watched';
    return 'all';
  }

  // A view the bar refuses to OFFER on a surface must not ACT on it either.
  // barScopeForSurface() hid the whole-feed chips on search, channel and
  // related-sidebar pages, but nothing stopped the filter itself: leave home
  // set to "Watched today", then search for something, and the results page
  // came back nearly empty with no control anywhere on screen explaining why.
  // The stored setting is deliberately left alone -- it returns intact the
  // moment you go back to a feed that can use it.
  function surfaceAdjusted(wd) {
    if (barScopeForSurface() !== 'treat') return wd;
    // hidePartial is not a feedFilter value but it hides by the same rule --
    // whole-feed removal of tiles the user did not ask about individually --
    // and the bar has no control for it at all, so on a treat surface it was
    // the one filter that could empty a search page with nothing anywhere on
    // screen to even hint at it.
    var feedOnly = FEED_ONLY_VIEWS.indexOf(wd.feedFilter) !== -1;
    if (!feedOnly && !wd.hidePartial) return wd;
    return Object.assign({}, wd, {
      feedFilter: feedOnly ? 'all' : wd.feedFilter,
      hidePartial: false
    });
  }

  // What is actually in force here, as opposed to what is saved. These differ
  // only on a 'treat' surface holding a whole-feed view.
  function effectiveFeedView() {
    const key = feedViewKey();
    if (barScopeForSurface() === 'treat' && FEED_ONLY_VIEWS.indexOf(key) !== -1) return 'all';
    // A library page never hides (see apply), it dims instead, so the chip says
    // what is actually happening. It used to light up "Hide watched" on a
    // playlist while nothing was hidden OR dimmed (measured: 0 and 0 of 10).
    if (key === 'hide-watched' && onLibraryPage()) return 'dim-watched';
    return key;
  }

  function setFeedView(key) {
    if (key === 'today') {
      saveDisplay({ feedFilter: 'today', finished: 'show', badges: true, hidePartial: false });
    } else if (key === 'hide-watched') {
      saveDisplay({ feedFilter: 'all', finished: 'hide', badges: true, hidePartial: false });
    } else if (key === 'dim-watched') {
      saveDisplay({ feedFilter: 'all', finished: 'dim', badges: true, hidePartial: false });
    } else if (key === 'only-watched') {
      saveDisplay({ feedFilter: 'only-watched', finished: 'show', badges: true, hidePartial: false });
    } else if (key === 'only-unseen') {
      saveDisplay({ feedFilter: 'only-unseen', finished: 'show', badges: true, hidePartial: false });
    } else {
      saveDisplay({ feedFilter: 'all', finished: 'show', hidePartial: false });
    }
  }

  // Which surfaces these controls actually do anything on.
  //
  // ensureFeedToggle() had no page gate at all, so the full watch-status row
  // rendered everywhere. Measured on /watch: six of the eight chips in the bar
  // were feed filters on a page with no feed, taking 77% of YouTube's masthead
  // #end. The related sidebar IS a recommendation feed, so dim/hide belong
  // there, but the whole-feed views (Today, Watched-only) do not.
  //
  // The governing rule, and the reason this exists: a control the code already
  // knows is inert must not render. pageSurface() has computed this
  // classification all along and simply was not wired to the bar.
  function barScopeForSurface() {
    var YD = window.UNYtDom;
    var surface = YD && YD.pageSurface ? YD.pageSurface() : 'home';
    // 'full'    every watch-status view
    // 'treat'   dim/hide only: filtering a result set the user explicitly asked
    //           for by removing items reads as broken, so no whole-feed views
    // 'none'    nothing to filter
    if (surface === 'music' || surface === 'shorts') return 'none';
    if (surface === 'library') return 'treat';
    if (surface === 'search' || surface === 'channel') return 'treat';
    if (surface === 'related') return 'treat';
    return 'full';
  }

  // Views that only make sense against a whole feed.
  // Every feedFilter value that removes tiles the user did not individually
  // ask about. Keep this in step with normalize()'s whitelist in
  // shared/watched-display.js -- a value accepted there and missing here
  // filters surfaces it has no control on, invisibly.
  var FEED_ONLY_VIEWS = ['today', 'only-watched', 'only-unseen'];

  // Single source for the chip label, the menu row, and the tooltip. Three
  // copies of these strings drifted apart before: the chips read "Watched"
  // while the tooltip said "Show watched videos only".
  // One label per view, used for the chip, the menu row AND the accessible
  // name. Three separate strings drifted apart before (a chip reading
  // "Watched" under a tooltip reading "Show watched videos only"), and a
  // chip/aria mismatch is a WCAG 2.5.3 Label-in-Name failure besides -- voice
  // control users say what they see.
  //
  // The axis is "Videos:", not "Watched:". Under "Watched:" the values did not
  // parse: two of them describe what happens TO watched videos ("Dimmed",
  // "Hidden") and three select a subset ("Watched only", "Never started"),
  // so no single value word worked for both senses -- "Watched: Only" made the
  // reader reconstruct "only [watched]" from a bare adverb, and "Watched:
  // Watched only" just stutters. "Videos:" reads correctly across all six and
  // still does not collide with the Channels chip's own "All", which is the
  // collision the axis prefix exists to prevent.
  const WATCH_VIEWS = [
    { id: 'all', label: 'All', title: 'Show every video, watched or not' },
    { id: 'dim-watched', label: 'Dim watched', title: 'Dim videos you have already watched' },
    // "Hide", not "Remove": this adds a display:none class, it deletes nothing.
    { id: 'hide-watched', label: 'Hide watched', title: 'Hide videos you have already watched' },
    { id: 'today', label: 'Watched today', title: 'Show only what you watched today' },
    { id: 'only-watched', label: 'Watched only', title: 'Show only videos you have already watched' },
    // Reachable from the dashboard ("Only never-started videos") long before
    // the bar could show it. Left out of this table, feedViewKey() fell through
    // to 'all' and the chip read "All" while tileWant() hid every started video
    // on every page -- the exact shape of the 'today' bug this table exists to
    // prevent, one value along.
    { id: 'only-unseen', label: 'Never started', title: 'Show only videos you have never started' }
  ];

  function viewOption(id) {
    for (let i = 0; i < WATCH_VIEWS.length; i++) {
      if (WATCH_VIEWS[i].id === id) return WATCH_VIEWS[i];
    }
    return null;
  }

  let watchedMenuDocClick = null;
  let watchedMenuEsc = null;
  let watchedMenuKey = null;

  function closeWatchedMenu() {
    const menu = document.getElementById('un-wft-menu');
    if (menu) menu.remove();
    if (watchedMenuDocClick) {
      document.removeEventListener('click', watchedMenuDocClick, true);
      watchedMenuDocClick = null;
    }
    if (watchedMenuKey) {
      document.removeEventListener('keydown', watchedMenuKey, true);
      watchedMenuKey = null;
    }
    if (watchedMenuEsc && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(watchedMenuEsc);
      watchedMenuEsc = null;
    }
    const chip = document.querySelector('.un-wft-view-chip');
    if (chip) chip.setAttribute('aria-expanded', 'false');
  }

  function toggleWatchedMenu(chip) {
    if (document.getElementById('un-wft-menu')) {
      closeWatchedMenu();
      return;
    }
    const scope = barScopeForSurface();
    // The checkmark marks what is in force HERE. On a search page holding a
    // saved "Watched today", nothing is filtering, so ticking "Watched today"
    // would claim an effect that is not happening.
    const active = effectiveFeedView();
    const menu = document.createElement('div');
    menu.id = 'un-wft-menu';
    menu.className = 'un-home-menu';
    menu.setAttribute('role', 'menu');

    // A LIBRARY PAGE MUST NOT OFFER A CHOICE IT WILL OVERRIDE.
    //
    // tileWant() already downgrades 'hide' to '' on history, playlists and the
    // rest of the library (see onLibraryPage) — removing entries from a list
    // the user assembled looks like the list lost videos. But the MENU still
    // listed "Hide watched" as a selectable radio option there, so picking it
    // set a mode that silently did something else: the chip came back reading
    // "Dim watched". Reported live from a playlist page.
    //
    // Measured on /feed/history, /feed/playlists and /playlist with
    // outcome:'hide' stored: isLibrary true, 0 of 16 tiles hidden, chip reading
    // "Videos: Dim watched". The suppression was working; the menu was lying
    // about what was on offer.
    //
    // Omitted rather than disabled, the same rule the feed-only views follow
    // two lines down: a control that cannot do anything here should not take up
    // a row explaining that.
    const libraryHere = onLibraryPage();

    WATCH_VIEWS.forEach((opt) => {
      // Whole-feed views on a surface that has no whole feed are omitted, not
      // disabled -- the same rule the chips followed, carried into the menu.
      if (scope === 'treat' && FEED_ONLY_VIEWS.indexOf(opt.id) !== -1) return;
      if (libraryHere && opt.id === 'hide-watched') return;
      const row = document.createElement('button');
      row.type = 'button';
      const on = opt.id === active;
      row.className = 'un-sub-guide-item' + (on ? ' on' : '');
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.textContent = (on ? '✓ ' : '') + opt.label;
      row.title = opt.title;
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeWatchedMenu();
        setFeedView(opt.id);
      });
      menu.appendChild(row);
    });

    // Independent toggles, below the radio group. The views above are one
    // choice — dim OR hide OR only-watched — but "hide members-only" is a
    // property of the video rather than of whether you have seen it, so it
    // stacks with whichever view is active instead of replacing it. Rendered as
    // menuitemcheckbox, not menuitemradio, so screen readers announce the
    // difference too.
    const sep = document.createElement('div');
    sep.className = 'un-home-menu-sep';
    sep.setAttribute('role', 'separator');
    menu.appendChild(sep);

    [
      {
        key: 'hideMembersOnly',
        label: 'Hide members-only',
        title: 'Hide paid members-only videos from feeds'
      }
    ].forEach((opt) => {
      const wd = surfaceAdjusted(mode());
      const on = !!wd[opt.key];
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'un-sub-guide-item' + (on ? ' on' : '');
      row.setAttribute('role', 'menuitemcheckbox');
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.textContent = (on ? '✓ ' : '') + opt.label;
      row.title = opt.title;
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeWatchedMenu();
        const patch = {};
        patch[opt.key] = !on;
        saveDisplay(patch);
      });
      menu.appendChild(row);
    });

    // What the filter hid on THIS page, one click from seeing it. Shown dimmed,
    // so they read as the hidden ones; cleared on the next navigation.
    if (hiddenCount > 0 || revealHidden) {
      const sep2 = document.createElement('div');
      sep2.className = 'un-home-menu-sep';
      sep2.setAttribute('role', 'separator');
      menu.appendChild(sep2);
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'un-sub-guide-item' + (revealHidden ? ' on' : '');
      reveal.setAttribute('role', 'menuitemcheckbox');
      reveal.setAttribute('aria-checked', revealHidden ? 'true' : 'false');
      reveal.textContent = (revealHidden ? '✓ ' : '') + 'Show the ' + hiddenCount + ' hidden here';
      reveal.title = 'Show what the filter is hiding on this page, dimmed. Resets when you leave the page.';
      reveal.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeWatchedMenu();
        revealHidden = !revealHidden;
        const n = hiddenCount;
        apply();
        // The toast is a role="status" region, so this is also what a screen
        // reader hears when N tiles appear or vanish (panel, WCAG 4.1.3).
        if (window.UNSYNTH && window.UNSYNTH.showToast) {
          window.UNSYNTH.showToast(revealHidden
            ? 'Showing ' + n + ' hidden ' + (n === 1 ? 'video' : 'videos') + ', dimmed'
            : 'Hiding watched videos again');
        }
      });
      menu.appendChild(reveal);
    }

    document.body.appendChild(menu);
    menu.style.position = 'fixed';
    const r = chip.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    const w = menu.offsetWidth || 200;
    menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px';
    menu.style.right = 'auto';
    chip.setAttribute('aria-expanded', 'true');

    watchedMenuDocClick = (e) => {
    // Not a user dismissal -- see queue-advance.js docClickHandler.
    if (e && e.isTrusted === false) return;
      if (!menu.contains(e.target) && e.target !== chip && !chip.contains(e.target)) closeWatchedMenu();
    };
    // Escape goes through the shared LIFO stack so only the topmost overlay
    // closes; a raw document listener also closed whatever panel was open
    // behind this menu.
    watchedMenuEsc = window.UNSYNTH && window.UNSYNTH.pushPanel
      ? window.UNSYNTH.pushPanel(closeWatchedMenu)
      : null;
    watchedMenuKey = watchedMenuEsc ? null : (e) => {
      if (e.key === 'Escape') closeWatchedMenu();
    };
    setTimeout(() => {
      document.addEventListener('click', watchedMenuDocClick, true);
      if (watchedMenuKey) document.addEventListener('keydown', watchedMenuKey, true);
    }, 0);
    const first = menu.querySelector('.un-sub-guide-item.on') || menu.querySelector('.un-sub-guide-item');
    if (first && first.focus) first.focus();
  }

  function ensureFeedToggle() {
    var scope = barScopeForSurface();
    if (scope === 'none') {
      var dead = document.getElementById('un-watched-feed-toggle');
      if (dead) dead.remove();
      return;
    }
    var slot = window.UNMastheadSlot && window.UNMastheadSlot.ensureMastheadStructure();
    if (!slot) return;
    var bar = slot.bar || document.getElementById('un-watched-feed-toggle');
    // Shell may exist before the watched bar (playlist-manager masthead race).
    if (!bar) {
      var shell = document.getElementById('un-synth-masthead-bar') || slot.shell;
      if (!shell) return;
      bar = document.createElement('div');
      bar.id = 'un-watched-feed-toggle';
      bar.className = 'un-watched-feed-toggle';
      var extra = document.getElementById('un-synth-masthead-extra');
      if (extra && extra.parentElement === shell) shell.insertBefore(bar, extra);
      else shell.insertBefore(bar, shell.firstChild);
    }
    const saved = feedViewKey();
    const active = effectiveFeedView();
    if (!bar) return;
    if (!bar.dataset.built) {
      bar.dataset.built = '1';
      bar.title = 'Unsynth — filter feed by watch status (75%+ = watched)';
      // Was five flat chips (All / Dim / Hide / Today / Watched) sitting beside
      // the Channels chip's own "All" and the type row's "All" -- three
      // identical words meaning three different things, and five slots of
      // masthead width for one mutually-exclusive choice, where only a colour
      // told you which was active. Collapsed to one value chip matching the
      // Channels pattern: the axis is named, the current value is legible
      // without decoding highlight colours, and the four inactive options stop
      // costing width.
      const viewChip = document.createElement('button');
      viewChip.type = 'button';
      viewChip.className = 'un-wft-btn un-wft-view-chip';
      viewChip.dataset.role = 'view-menu';
      viewChip.setAttribute('aria-haspopup', 'menu');
      // Set at BUILD time, not only on open/close. It was written in both
      // toggleWatchedMenu paths but never here, so a chip that had not been
      // clicked yet announced a menu button with no collapsed state at all —
      // which is what the semantics audit counted as state-not-exposed.
      viewChip.setAttribute('aria-expanded', 'false');
      viewChip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleWatchedMenu(viewChip);
      });
      bar.appendChild(viewChip);
      // "YT Default" peek toggle — bypasses Unsynth's feed filtering (AI, watch
      // status, and sub-group filtering — see sub-manager.js's defaultFeedOn())
      // to reveal YouTube's native home offerings for this session.
      const def = document.createElement('button');
      def.type = 'button';
      def.className = 'un-wft-btn un-wft-default';
      def.dataset.role = 'default-feed';
      // "Pause", not "Default". The old label was actively misleading: the
      // PRODUCT default is Dim (defaults.js / WD.DEFAULT.finished), so a button
      // reading "Default" did the opposite of restoring defaults. It is also
      // not a filter like its neighbours — it is a session-scoped switch that
      // suspends all of them — so it is announced as a switch, not a toggle
      // button, and styled past a divider rather than as a peer chip.
      def.textContent = 'Pause';
      def.setAttribute('role', 'switch');
      def.title = 'Pause all Unsynth filtering for this tab and show YouTube untouched. Resets when you reload.';
      def.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleDefaultFeed();
      });
      // Direct child of the SHELL, not of this bar. The shell lays out as
      // [watched bar][extra actions], and Pause was the last child of the
      // watched bar, so it rendered sandwiched between the two value chips
      // ("Videos ▾ | Pause | Channels ▾ | Long Shorts Live") -- a session-wide
      // switch in the middle of the filters it suspends, reading as a peer of
      // them. Only a rendered screenshot showed this: every unit test passed,
      // because each container was correct in isolation and the defect lived
      // entirely in how they compose.
      //
      // Being a direct child is the whole job: the shell is a flex container
      // and `#un-synth-masthead-bar > .un-wft-default { order: 3 }` puts it
      // last visually regardless of DOM position. There was a re-assert here
      // that re-appended it on every sync "in case another module pushed it
      // back"; with the order rule in place that could never change what the
      // user sees, so it was a real DOM mutation for no visual effect, on a
      // path that runs on every watched-percentage tick. Removed.
      var shellEl = document.getElementById('un-synth-masthead-bar') || bar.parentElement;
      if (shellEl) shellEl.appendChild(def);
      else bar.appendChild(def);
    }
    const peeking = defaultFeedOn();
    const viewChip = bar.querySelector('.un-wft-view-chip');
    if (viewChip) {
      const opt = viewOption(active) || WATCH_VIEWS[0];
      const label = opt.label;
      // The count of what the filter is hiding HERE rides on the chip, so a
      // thinned-out feed says why: "Hide watched · 15". While revealed, the
      // same number stays, reading as "these 15 are the hidden ones".
      const countText = hiddenCount > 0 && !peeking ? String(hiddenCount) : '';
      const stateKey = active + '|' + countText;
      if (viewChip.dataset.view !== stateKey) {
        viewChip.dataset.view = stateKey;
        viewChip.textContent = '';
        // Name the axis, same as the Channels chip. A bare "All" here sat
        // beside the Channels chip's own "All" meaning something else.
        const axis = document.createElement('span');
        axis.className = 'un-wft-chip-axis';
        axis.textContent = 'Videos: ';
        viewChip.appendChild(axis);
        const bold = document.createElement('b');
        bold.textContent = label;
        viewChip.appendChild(bold);
        if (countText) {
          const n = document.createElement('span');
          n.className = 'un-wft-chip-count';
          n.textContent = countText;
          viewChip.appendChild(n);
        }
        viewChip.appendChild(document.createTextNode(' ▾'));
      }
      // 'all' is a no-op, so it stays outlined -- the chip is "on" only when it
      // is actually changing what you see, which is the one thing the old
      // five-chip row could never show at a glance.
      viewChip.classList.toggle('on', active !== 'all');
      viewChip.setAttribute('aria-label', 'Videos: ' + opt.label + (countText ? ', ' + countText + ' hidden on this page' : ''));
      // Say the saved view is parked rather than silently showing All. A user
      // who set "Watched today" on home and then searched should be able to
      // find out where it went.
      const parked = saved !== active ? viewOption(saved) : null;
      viewChip.title = parked
        ? opt.title + ' — "' + parked.label + '" is saved but does not apply on this page'
        : opt.title;
      viewChip.classList.toggle('un-wft-parked', !!parked);
      // While Pause is on, watch-status filtering is bypassed, so this would be
      // a no-op -- disabled rather than left to feel dead.
      viewChip.disabled = peeking;
      viewChip.classList.toggle('un-wft-muted', peeking);
      if (peeking) closeWatchedMenu();
    }
    const def = document.querySelector('.un-wft-default');
    if (def) {
      def.classList.toggle('on', peeking);
      // The label states what IS, not what clicking does: while paused it reads
      // "Paused", so the bar itself tells you why nothing is filtering.
      const label = peeking ? 'Paused' : 'Pause';
      if (def.textContent !== label) def.textContent = label;
      def.setAttribute('aria-checked', peeking ? 'true' : 'false');
      def.title = peeking
        ? 'Unsynth filtering is paused for this tab. Click to resume, or reload the page.'
        : 'Pause all Unsynth filtering for this tab and show YouTube untouched. Resets when you reload.';
    }
  }

  function syncFeedToggle() {
    ensureFeedToggle();
  }

  function trimNegligibleProgress(vid) {
    if (!vid || watched.has(vid)) return;
    if (progress[vid] != null && progress[vid] < MIN_PARTIAL_UI) {
      delete progress[vid];
      dirty = true;
    }
  }

  const IS_MUSIC = location.host === 'music.youtube.com';
  const YT = window.UNYtDom || null;
  const NS = window.UNWatchedState || null;
  const pendingMarks = new Set();

  /**
   * Whether YouTube's own resume bar may supplement the local watched store.
   * On by default: without it, anything watched on another device is invisible
   * to the filter, which is the most common "it didn't hide everything" report.
   * Opt out for anyone who wants filtering driven strictly by what this
   * extension itself recorded.
   */
  function useNativeProgress() {
    return settings.watchedUseNativeProgress !== false;
  }

  // Null-guard WS — if watch-stats.js failed to load we degrade gracefully.
  const isWatchPage = () => WS ? WS.isTrackableWatchPage(location.pathname) : (YT ? YT.isWatchPage(location.pathname) : false);
  function curVid() {
    return WS ? WS.videoIdFromUrl(location.pathname, location.search) : null;
  }
  function mode() {
    return window.UNWatchedDisplay
      ? window.UNWatchedDisplay.normalize(settings.watchedDisplay, settings.watchedMode)
      : { badges: true, finished: 'show', feedFilter: 'all', hidePartial: false };
  }
  // Session "show YouTube default feed" peek. Signalled by an <html> class (shared
  // with ai-filter so both bypass at once). On the DOM, so it resets on a full
  // reload — a peek, never a saved setting that could leave filtering off forever.
  function defaultFeedOn() {
    return document.documentElement.classList.contains('un-default-feed');
  }
  function toggleDefaultFeed() {
    const on = !defaultFeedOn();
    document.documentElement.classList.toggle('un-default-feed', on);
    apply();          // re-run watch-status filtering (now show-all while on)
    syncFeedToggle(); // refresh button highlight
    // Tell ai-filter to reveal / re-hide its AI tiles to match.
    try {
      document.dispatchEvent(new CustomEvent('unsynth-default-feed-changed', { detail: { on } }));
    } catch (e) {
      /* ignore */
    }
  }
  function tileVid(tile) {
    return YT ? YT.tileVideoId(tile) : null;
  }
  function tileThumb(tile) {
    return YT ? YT.tileThumb(tile) : null;
  }
  function forEachWatchTile(cb) {
    if (YT) {
      // While a video is playing, only badge/filter the related rail — full
      // document walks fight the player on every core scan.
      if (YT.isWatchPage(location.pathname)) {
        const root = YT.watchRelatedRoot && YT.watchRelatedRoot();
        if (!root) return;
        YT.forEachFeedTile(cb, { root: root });
        return;
      }
      YT.forEachFeedTile(cb);
      return;
    }
    document.querySelectorAll(YT ? YT.feedTileSelector() : 'none').forEach(cb);
  }

  function guardCtx(fn) {
    if (core && core.guardExtension) return core.guardExtension(fn);
    try {
      fn();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * { videoId: channelKey } for videos this browser has actually watched.
   *
   * WHY THIS HAS TO EXIST SEPARATELY
   * The obvious source for "which videos belong to this channel" is
   * watchStats.channelVideos, and it is a trap: that map is built exclusively
   * by the dashboard Takeout importer, so a user who has simply watched videos
   * has no channelVideos at all. Verified on a live profile. Anything built on
   * it renders nothing for everyone who has not imported.
   *
   * watchProgress already knows the video, and the watch page already knows the
   * channel. Recording the join here means per-channel completion starts
   * accumulating from the first video rather than from an import.
   */
  let videoChannel = {};

  function load(cb) {
    guardCtx(() => {
      chrome.storage.local.get(['watchedVideos', 'watchProgress', 'watchedDates', 'watchedDatesApprox', 'watchStats', 'videoChannel'], (d) => {
        if (chrome.runtime.lastError) {
          if (core) core.showStaleBanner();
          return;
        }
        watched = new Set((d && d.watchedVideos) || []);
        pendingMarks.forEach((id) => watched.add(id));
        progress = (d && d.watchProgress) || {};
        watchedDates = (d && d.watchedDates) || {};
        approxDates = (d && d.watchedDatesApprox) || {};
        watchStats = (d && d.watchStats) || null;
        videoChannel = (d && d.videoChannel) || {};
        importDateByVid = null; // rebuilt lazily against the new watchStats
        dataLoaded = true;
        backfillMissingDates();
        cb && cb();
      });
    });
  }

  /**
   * Drop channel links for videos that can no longer affect any number.
   *
   * This keeps the map proportional to the watch history, not bounded: nothing
   * caps watchedVideos either. The real claim is a ratio — roughly 40 bytes per
   * watched video beside the ~13 the id list already costs, so the map cannot
   * become the thing that overruns storage first.
   *
   * The map only exists to answer "how much of what I start on this channel do
   * I finish", and that question is asked against watchProgress and
   * watchedVideos. A video in neither is unreachable: keeping its channel link
   * grows storage forever and changes no output.
   *
   * Runs on persist rather than on write, so the cost lands on the debounced
   * save that was already happening instead of on every progress tick.
   */
  function pruneVideoChannel() {
    const ids = Object.keys(videoChannel);
    if (!ids.length) return;
    const next = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (progress[id] !== undefined || watched.has(id)) next[id] = videoChannel[id];
    }
    videoChannel = next;
  }

  function persist() {
    dirty = false;
    pruneVideoChannel();
    guardCtx(() => {
      chrome.storage.local.set(
        { watchProgress: progress, watchedDates, watchedDatesApprox: approxDates, videoChannel },
        () => {
          if (chrome.runtime.lastError && core) core.showStaleBanner();
        }
      );
    });
  }

  function schedulePersist() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) persist();
    }, 8000);
  }

  function syncWatchStatsUnique() {
    guardCtx(() => {
      chrome.storage.local.get('watchStats', (d) => {
        if (chrome.runtime.lastError) return;
        const ws = WS.reconcileWatchStats(d && d.watchStats, watched.size);
        if (!ws) return;
        chrome.storage.local.set({ watchStats: ws });
      });
    });
  }

  /**
   * Backfill missing watch dates from YouTube's own History page.
   *
   * Videos marked watched before this extension recorded dates — or synced
   * from another device before dates were carried — have no timestamp
   * anywhere, so their badge can only say "watched". YouTube DOES know when
   * you watched them: /feed/history groups tiles under date headers ("Today",
   * "Yesterday", "Mar 14, 2026"). Reading those headers while the user is on
   * that page recovers the real date at no API cost.
   *
   * Only ever FILLS GAPS: a video that already has a date keeps it, because a
   * locally recorded timestamp is more precise than a day header.
   */
  function parseHistoryHeading(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const now = new Date();
    if (/^today$/i.test(t)) return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (/^yesterday$/i.test(t)) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      d.setDate(d.getDate() - 1);
      return d.getTime();
    }
    // Only accept strings that actually look like a date. Date.parse is far
    // too permissive on its own: "Watch history" and "Sunday" both parse to
    // Jan 1, which would stamp a confidently wrong date on every video in the
    // section. Require a month name next to a day number.
    if (!/^[A-Za-z]{3,9}\s+\d{1,2}(,\s*\d{4})?$|^\d{1,2}\s+[A-Za-z]{3,9}(\s+\d{4})?$/.test(t)) {
      return null;
    }
    const hasYear = /\d{4}/.test(t);
    let parsed = Date.parse(hasYear ? t : t + ', ' + now.getFullYear());
    if (isNaN(parsed)) return null;
    // A bare "Dec 25" seen in January belongs to LAST year, not this one —
    // assuming the current year would put it in the future and drop it.
    if (!hasYear && parsed > Date.now()) {
      parsed = Date.parse(t + ', ' + (now.getFullYear() - 1));
      if (isNaN(parsed)) return null;
    }
    if (parsed > Date.now()) return null;
    return parsed;
  }

  function harvestHistoryDates() {
    if (!onHistoryPage()) return;
    const sections = document.querySelectorAll(YT ? YT.HISTORY_SECTION_SEL : 'none');
    if (!sections.length) return;
    const found = {};
    let n = 0;
    sections.forEach((sec) => {
      const head = sec.querySelector(YT ? YT.HISTORY_SECTION_TITLE_SEL : '#title');
      const when = parseHistoryHeading(head && head.textContent);
      if (!when) return;
      // Read video ids off the links rather than off a renderer element type.
      // Verified against the live history page: it now uses lockup tiles,
      // not classic video renderers, so querying renderer tags matched ZERO
      // tiles and the harvester silently never ran. Hrefs are the one thing
      // that survives YouTube renderer churn.
      const seenHere = Object.create(null);
      sec.querySelectorAll('a[href*="watch?v="]').forEach((a) => {
        let vid = null;
        try {
          vid = new URL(a.href, location.origin).searchParams.get('v');
        } catch (e) {
          vid = null;
        }
        if (!vid || !/^[\w-]{11}$/.test(vid) || seenHere[vid]) return;
        seenHere[vid] = 1;
        // Fill a gap, or UPGRADE an approximate date. A first-observed
        // estimate exists only because the real date was lost; YouTube's own
        // history header is the real thing, so it wins. A date we recorded
        // ourselves is never overwritten.
        if (watchedDates[vid] && !approxDates[vid]) return;
        found[vid] = when;
        n++;
      });
    });
    if (!n) return;
    Object.assign(watchedDates, found);
    // These are real dates now, so they are no longer estimates.
    Object.keys(found).forEach((vid) => {
      delete approxDates[vid];
    });
    guardCtx(() => {
      chrome.storage.local.set({ watchedDates, watchedDatesApprox: approxDates }, () => {
        if (chrome.runtime.lastError) return;
        apply();
      });
    });
  }

  /**
   * A watched video with no date is a data gap, not a normal state — every
   * path that marks one records a timestamp. Gaps come from writers that
   * touched the watched LIST without the dates beside it: cross-device sync
   * did exactly that until it was fixed, replacing watchedVideos wholesale
   * with the server's merged list while leaving watchedDates alone, so every
   * video watched on another device landed undated and stayed that way.
   *
   * Close the gap on load rather than leaving it to render as "watched" with
   * no date forever. An imported date is used when there is one; otherwise
   * the video is stamped as seen-at-first-observation, which is imprecise but
   * bounded and honest — it is the first moment this device can prove the
   * video was already watched. `dateApprox` records which ones those are so
   * the UI can say so instead of implying precision it does not have.
   */
  function backfillMissingDates() {
    if (!watched || !watched.size) return;
    var idx = getImportDateIndex();
    var now = Date.now();
    var filled = 0;
    watched.forEach(function (vid) {
      if (watchedDates[vid]) return;
      if (idx && idx[vid]) {
        watchedDates[vid] = idx[vid];
      } else {
        watchedDates[vid] = now;
        approxDates[vid] = 1;
      }
      filled++;
    });
    if (!filled) return;
    guardCtx(function () {
      chrome.storage.local.set({ watchedDates: watchedDates, watchedDatesApprox: approxDates });
    });
  }

  var historyHarvestTimer = null;
  function scheduleHistoryHarvest() {
    if (!onHistoryPage()) return;
    if (historyHarvestTimer) clearTimeout(historyHarvestTimer);
    // The history page renders progressively and appends more sections as you
    // scroll, so harvest on a debounce rather than once on navigate.
    historyHarvestTimer = setTimeout(function () {
      historyHarvestTimer = null;
      try {
        harvestHistoryDates();
      } catch (e) {
        /* never let a scrape break the page */
      }
    }, 1200);
  }

  function markFull(vid) {
    if (!vid) return;
    const isNew = !watched.has(vid);
    watched.add(vid);
    pendingMarks.add(vid);
    watchedDates[vid] = Date.now();
    // A real watch supersedes any first-observed estimate for this video.
    if (approxDates[vid]) delete approxDates[vid];
    if (progress[vid] != null) delete progress[vid];
    guardCtx(() => {
      chrome.storage.local.get('watchedVideos', (d) => {
        if (chrome.runtime.lastError) {
          if (core) core.showStaleBanner();
          return;
        }
        const a = (d && d.watchedVideos) || [];
        if (a.indexOf(vid) === -1) a.push(vid);
        chrome.storage.local.set({ watchedVideos: a, watchProgress: progress, watchedDates, watchedDatesApprox: approxDates, videoChannel }, () => {
          pendingMarks.delete(vid);
          if (chrome.runtime.lastError && core) core.showStaleBanner();
          else {
            syncWatchStatsUnique();
            apply();
          }
        });
      });
    });
    return isNew;
  }

  function unmark(vid) {
    if (!vid) return;
    watched.delete(vid);
    pendingMarks.delete(vid);
    delete progress[vid];
    delete watchedDates[vid];
    delete approxDates[vid];
    delete videoChannel[vid];
    guardCtx(() => {
      chrome.storage.local.get('watchedVideos', (d) => {
        if (chrome.runtime.lastError) {
          if (core) core.showStaleBanner();
          return;
        }
        const a = ((d && d.watchedVideos) || []).filter((id) => id !== vid);
        chrome.storage.local.set({ watchedVideos: a, watchProgress: progress, watchedDates, watchedDatesApprox: approxDates, videoChannel }, () => {
          if (chrome.runtime.lastError && core) core.showStaleBanner();
          else {
            syncWatchStatsUnique();
            apply();
          }
        });
      });
    });
  }

  /**
   * Publish the watched chip's real rendered width for the head strip.
   *
   * The chip is NOT a fixed 28px square: it sizes to its own content, so a
   * watched tile with a timestamp renders as an 86px pill ("Yesterday").
   * The select checkbox is positioned after it, and offsetting by a hard 28px
   * put the checkbox 57px INSIDE the pill, clipping the label — reported as
   * the checkbox covering the date. Measured on a real feed tile.
   *
   * Same contract as --un-taste-w in taste-rank.js: set on the TILE, because
   * the chip and the checkbox live in sibling subtrees with no shared
   * positioned ancestor closer than that.
   */
  function publishMarkWidth(tile, mk) {
    if (!tile || !mk || !mk.getBoundingClientRect) return;
    var w = Math.round(mk.getBoundingClientRect().width);
    if (w > 0) tile.style.setProperty('--un-eye-w', w + 'px');
  }
  function wireTileMark(tile, vid, full, part, started, showLabels) {
    if (!vid) return;
    const host = tileThumb(tile) || tile;
    host.classList.add('un-watched-host');
    let mk = tile.querySelector('.un-watched-mark');
    if (!mk || mk.parentElement !== host) {
      if (mk) mk.remove();
      mk = document.createElement('div');
      mk.className = 'un-watched-mark';
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'uwm-chip';
      const icon = document.createElement('span');
      icon.className = 'uwm-icon';
      icon.setAttribute('aria-hidden', 'true');
      chip.appendChild(icon);
      mk.appendChild(chip);
      // The time label lives INSIDE the chip button, not as a sibling. As a
      // sibling it was absolutely positioned against .un-watched-mark, which
      // is a 0x0 box, so its `max-width: calc(100% - 136px)` resolved against
      // zero and clipped the text to a couple of characters at every tile
      // width. One element also removes the chip/pill collision entirely.
      host.appendChild(mk);
      tile.dataset.unwlabel = '';
    }
    // Always refresh the click handler's identity, even when the visual
    // state (stateKey below) doesn't change — a tile recycled by YouTube's
    // virtualized feed for a different video that happens to land in the
    // SAME watched-state bucket (e.g. both still unwatched) would otherwise
    // keep the chip permanently bound to the OLD video, since this used to
    // run only inside the stateKey-changed branch below. wireMarkClick()
    // itself is cheap to call repeatedly (dataset writes + an early-return
    // on already-attached listeners).
    wireMarkClick(mk, vid, full, part);
    const ts = getWatchTimestamp(vid);
    const stateKey = (full ? 'full' : started ? 'p' + part : 'new') + (ts ? '_' + ts : '');
    if ((tile.dataset.unwlabel || '') !== stateKey) {
      mk.classList.toggle('is-full', full);
      mk.classList.toggle('is-partial', !full && started);
      mk.classList.toggle('is-unseen', !full && !started);
      mk.style.setProperty('--uwm-pct', (full ? 100 : started ? part : 0) + '%');
      // Bottom progress/status bar across the whole thumbnail (core.css
      // .un-watched-host.un-watched-full/partial::after) — a corner badge is
      // easy to miss while scanning a grid; a full-width bar at the edge reads
      // at a glance, the same way YouTube's own in-progress scrub bar does.
      host.classList.toggle('un-watched-full', full);
      host.classList.toggle('un-watched-partial', !full && started);
      host.style.setProperty('--uwm-pct', (full ? 100 : started ? part : 0) + '%');
      const chip = mk.querySelector('.uwm-chip');
      const icon = mk.querySelector('.uwm-icon');
      let pctText = mk.querySelector('.uwm-pct-text');
      if (!full && started && showLabels) {
        if (!pctText) {
          pctText = document.createElement('span');
          pctText.className = 'uwm-pct-text';
          chip.appendChild(pctText);
        }
        pctText.textContent = part + '%';
        mk.classList.add('has-pct-label');
      } else {
        if (pctText) pctText.remove();
        mk.classList.remove('has-pct-label');
        if (icon) icon.style.display = '';
      }

      // Last viewed time badge next to watch chip
      let timeTag = mk.querySelector('.uwm-time-tag');
      if ((full || started) && showLabels) {
        // With a date, show it. Without one, still say "watched" in words —
        // dropping the label entirely was tried and read as the badge having
        // broken, because a library of undated videos suddenly went blank.
        // These are videos marked before dates were recorded (or synced from
        // another device before dates were carried); there is no date to
        // recover for them, so the label states the fact it does know.
        // An approximate date is a first-observed estimate, not a watch time.
        // Showing it as "now" for something watched months ago would be a
        // confident lie, so those keep the plain "watched" wording and say so
        // in the tooltip.
        const approx = !!approxDates[vid];
        // A partial tile already shows "<n>%" in .uwm-pct-text, so falling back
        // to the same string here rendered the pill as "35% 35%" on every
        // partially-watched video with no recorded timestamp — the common case,
        // since progress is known long before a watch date is. Seen in a
        // rendered capture; the duplicate is invisible when reading the source,
        // because the two labels are written ~40 lines apart.
        const pctShownSeparately = !full && !!part && showLabels;
        const timeLabel = ts && !approx
          ? formatCompactWatchTime(ts)
          : full
            ? 'watched'
            : part && !pctShownSeparately
              ? part + '%'
              : '';
        if (timeLabel) {
          if (!timeTag) {
            timeTag = document.createElement('span');
            timeTag.className = 'uwm-time-tag';
            chip.appendChild(timeTag);
          } else if (timeTag.parentElement !== chip) {
            // Tile recycled from a build where the tag was a sibling of the
            // mark rather than a child of the chip — reparent it.
            chip.appendChild(timeTag);
          }
          timeTag.textContent = timeLabel;
          mk.classList.add('has-time');
          timeTag.title = ts
            ? 'Last viewed: ' + new Date(typeof ts === 'string' && ts.indexOf('-') !== -1 ? ts : ts).toLocaleString()
            : 'Watched';
        } else if (timeTag) {
          timeTag.remove();
          mk.classList.remove('has-time');
        }
      } else if (timeTag) {
        timeTag.remove();
        mk.classList.remove('has-time');
      }


      // The tooltip carries BOTH forms: the relative one people scan by, and
      // the exact date, which is the actual answer to "when did I watch this".
      // It has to live on the button — the time-tag span is pointer-events:none
      // so a title there can never fire.
      const tsApprox = !!approxDates[vid];
      const whenRel = ts && !tsApprox ? formatRelativeWatchTime(ts) : '';
      const whenExact = ts && !tsApprox ? formatExactWatchDate(ts) : '';
      let when = whenRel + (whenExact ? ' (' + whenExact + ')' : '');
      if (!when && ts && tsApprox) {
        when = 'Watched — exact date unknown, first seen ' + formatRelativeWatchTime(ts).replace(/^Watched\s+/, '');
      }
      if (full) {
        chip.title =
          (when || 'Watched (no date recorded)') +
          ' · click to unmark · Shift+click or hold for details';
        chip.setAttribute('aria-label',
          (when ? when + ' — ' : '') + (showLabels ? 'Watched, click to unmark' : 'Watched'));
      } else if (started) {
        chip.title = part + '% watched' + (when ? ' · ' + when : '') + ' — click to mark watched · Shift+click or hold for details';
        chip.setAttribute('aria-label', part + '% watched' + (when ? ' — ' + when : ''));
      } else {
        chip.title = 'Not watched — click to mark watched · Shift+click or hold for details';
        chip.setAttribute('aria-label', showLabels ? 'Mark watched' : 'Not watched');
      }
      tile.dataset.unwlabel = stateKey;
    }

    // Outside the stateKey guard on purpose. The chip sizes to its own content
    // and the head strip lays the next segment immediately after it, so the
    // width has to be republished on every pass — not only when the watched
    // STATE changed. Measuring inside the guard captured the bare 28px square
    // and left the checkbox sitting on top of the timestamp label.
    publishMarkWidth(tile, mk);
  }

  function apply() {
    if (IS_MUSIC) return; // music.youtube.com has no ytd-* tile elements
    // Don't run until the async storage read in load() has finished. Running
    // against the empty initial Set shows every tile as unwatched, then the
    // real data arrives and hides/dims them — the "homepage refresh" flash.
    if (!dataLoaded) return;
    const wd = surfaceAdjusted(mode());
    // "YT Default" peek (passed into the pure helper): while on, nothing is
    // hidden/dimmed by watch status — YouTube's native offerings. Badges keep the
    // user's setting; the saved feed-filter buttons still reflect the real value.
    const peek = defaultFeedOn();
    const seenHosts = new Set();
    let hiddenHere = 0;
    forEachWatchTile((tile) => {
      const host = (YT && YT.outermostFeedTile) ? (YT.outermostFeedTile(tile) || tile) : tile;
      const v = tileVid(tile) || tileVid(host);
      if (!v) return;
      if (seenHosts.has(host)) return;
      seenHosts.add(host);
      // Ads are not videos you watch, and a playlist, course or mix is not one
      // video: no mark, no dim, no hide. A sponsored search result used to get
      // the watched eye over its own Watch button, and every collection was
      // marked "watched" whenever its FIRST video was (it links to that one).
      const skipTile = (t) => YT && ((YT.tileIsAd && YT.tileIsAd(t)) || (YT.tileIsCollection && YT.tileIsCollection(t)));
      if (skipTile(host) || (tile !== host && skipTile(tile))) {
        host.classList.remove('un-watched-dim', 'un-watched-hide');
        const adMark = host.querySelector('.un-watched-mark');
        if (adMark) adMark.remove();
        return;
      }
      // Local store first, then YouTube's own resume bar as a supplement. The
      // local store only knows what this extension watched (plus imports), so a
      // video finished on a phone, in another browser, or before install shows
      // a full red bar here and nothing at all in `watched` — which is exactly
      // the "full red play bar but it didn't get hidden" report. The merge only
      // ever adds signal, and never reaches the persisted store: YouTube's bar
      // carries a percentage and no date, and inventing a date is what the
      // watchedDatesApprox contract in shared/watch-queue.js forbids.
      const localFull = v ? watched.has(v) : false;
      const localPart = v && !localFull ? progress[v] || 0 : 0;
      const st = (v && NS && useNativeProgress())
        ? NS.mergeNativeProgress({
          full: localFull,
          part: localPart,
          nativePct: YT && YT.tileNativeProgress ? (YT.tileNativeProgress(tile) || YT.tileNativeProgress(host)) : null,
          threshold: fullPct()
        })
        : { full: localFull, part: localPart, started: isStarted(localPart, localFull), fromNative: false };
      const full = st.full;
      const part = st.part;
      const started = st.started;

      // Only real video tiles can be filtered; the unit-tested helper decides.
      let want = (v && window.UNWatchedDisplay)
        ? window.UNWatchedDisplay.tileWant(wd, full, started, peek)
        : '';
      if (wd.feedFilter === 'today' && !peek) {
        want = (v && isWatchedToday(v)) ? '' : 'hide';
      }
      // Never hide or dim a list the user deliberately assembled: a library or
      // playlist page, or the watch page's queue/playlist panel. Removing
      // entries there looks like the playlist lost videos.
      //
      // The watch page's RELATED sidebar is the opposite case — it is a
      // recommendation feed, and filtering already-watched videos out of
      // recommendations is the point of the feature. Excluding the whole watch
      // page meant the Hide toggle read as on while nothing was hidden, which
      // is what made this look broken.
      const listSel = YT ? YT.PLAYLIST_PANEL_BOTH_SEL : 'none';
      const inChosenList = !!(
        (host.closest && host.closest(listSel)) ||
        (tile !== host && tile.closest && tile.closest(listSel))
      );
      // Suppress HIDE only, which is what the comment above has always said and
      // what the guard was written for: removing entries from a list the user
      // assembled looks like the list lost videos. Dimming removes nothing, it
      // marks progress, and on a long playlist it is the single most useful
      // place to have it.
      //
      // This line used to be `want = ''`, which killed dim as well. The result
      // was a Dim chip that rendered lit and did nothing on every library and
      // playlist page, contradicting the paragraph directly above it.
      // Library pages and chosen lists never hide; they DIM instead, which marks
      // progress without removing anything. This used to be `want = ''`, so a
      // stored "Hide watched" did nothing at all on a playlist while the chip
      // claimed it was hiding (measured 2026-09-23: 0 hidden, 0 dimmed of 10).
      if ((onLibraryPage() || inChosenList) && want === 'hide') want = 'dim';

      // Members-only, applied AFTER the watched decision and after the
      // library/playlist guard above — it is an independent axis, so it hides a
      // paid video whether or not you have watched it, and on any view. The
      // library guard is deliberately not re-applied: a members-only video in a
      // playlist you assembled is still one you cannot play, so hiding it there
      // is the point rather than a surprise. Skipped entirely while peeking at
      // YouTube's default feed, like every other filter.
      if (!peek && wd.hideMembersOnly && YT && YT.tileIsMembersOnly) {
        if (YT.tileIsMembersOnly(host) || (tile !== host && YT.tileIsMembersOnly(tile))) want = 'hide';
      }

      if (want === 'hide') {
        hiddenHere++;
        // "Show hidden" reveals them dimmed for this page, so they read as
        // the ones the filter was hiding rather than as ordinary results.
        if (revealHidden) want = 'dim';
      }
      host.classList.remove('un-watched-dim', 'un-watched-hide');
      if (want === 'dim') host.classList.add('un-watched-dim');
      else if (want === 'hide') host.classList.add('un-watched-hide');
      host.dataset.unwatched = want;

      wireFreshBadge(host);

      const showControl = v && settings.modules && settings.modules.watchHistory !== false;
      const showLabels = wd.badges !== false;
      if (showControl) {
        wireTileMark(host, v, full, part, started, showLabels);
      } else if (host.dataset.unwlabel) {
        const mk = host.querySelector('.un-watched-mark');
        if (mk) mk.remove();
        const h = tileThumb(host) || host;
        h.classList.remove('un-watched-full', 'un-watched-partial');
        host.dataset.unwlabel = '';
      }
    });
    hiddenCount = hiddenHere;
    syncFeedToggle();
  }

  // Same well-documented, corroborating class names ad-skip.js and
  // queue-advance.js use for their own ad-state detection (see either file's
  // comment for the caveat: these were never personally observed against a
  // live ad — inference from documented class names, not observation).
  // Duplicated here rather than imported because watchHistory is an
  // independently-toggleable module and must not depend on adSkip having
  // loaded.
  const AD_STATE_SELECTORS = ['.ad-showing', '.ad-interrupting', '.ytp-ad-text', '.ytp-ad-simple-ad-badge', '.ytp-ad-preview-text', '.ytp-ad-duration-remaining'];
  function adCurrentlyShowing() {
    // Shared host adapter first, so a YouTube rename is one fix rather than
    // three. The list above stays as a fallback for the window where this
    // module has run and yt-dom has not yet landed.
    const YD = window.UNYtDom;
    if (YD && YD.adPlaying) return YD.adPlaying();
    for (let i = 0; i < AD_STATE_SELECTORS.length; i++) {
      if (document.querySelector(AD_STATE_SELECTORS[i])) return true;
    }
    return false;
  }

  function onTime() {
    if (!video) return;
    const vid = curVid();
    if (!vid) return;
    // YouTube plays ads on this same <video> element (sequential src swaps,
    // not a separate ad player) — during an ad, video.currentTime/duration
    // reflect the AD's own short timeline, not the real video's. Without
    // this guard, a typical pre-roll ad crosses both MIN_PROGRESS_SAVE and
    // the full-watch threshold within seconds, silently marking the real
    // video "watched" and feeding the taste profile from it before the user
    // has watched a single real second of it.
    if (adCurrentlyShowing()) return;
    const dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    const pct = Math.min(100, Math.round((video.currentTime / dur) * 100));
    if (pct >= fullPct()) {
      const isNew = !watched.has(vid);
      markFull(vid);
      // A Short is ~20s and LOOPS, so scrolling past one crosses 75% in a
      // few seconds and used to record a permanent "fully watched" video.
      // Channels that publish mostly Shorts then dominate Top Channels
      // without the user ever choosing to watch them -- reported live as
      // wildly inflated counts for channels the user had barely touched.
      // Resume position and the watched filter still track normally; only
      // the STATISTICS contribution is gated, because that is what was
      // visibly wrong. Same shape as the pre-roll ad guard above.
      const isShort = String(location.pathname || '').startsWith('/shorts');
      if (isShort && shortDwell.vid !== vid) shortDwell = { vid: vid, since: Date.now() };
      const dwellSecs = isShort && shortDwell.since ? (Date.now() - shortDwell.since) / 1000 : 0;
      const countsForStats = WS && WS.countsAsRealWatch
        ? WS.countsAsRealWatch({ isShort: isShort, seconds: dwellSecs, pct: pct })
        : true;
      if (countsForStats && !recordedSession.has(vid)) {
        recordedSession.add(vid);
        recordWatch(vid, isNew);
      }
      return;
    }
    if (pct >= MIN_PROGRESS_SAVE && pct > (progress[vid] || 0)) {
      progress[vid] = pct;
      watchedDates[vid] = Date.now();
      noteVideoChannel(vid);
      schedulePersist();
      // Feed the taste profile from PARTIAL watches too, not just completions.
      // recordWatch() above only fires at the full-watch threshold (75% by
      // default), which for a long video can be 40 minutes in — so a profile
      // built only from completions learns extremely slowly and barely
      // reflects what someone actually browses. A 10%+ watch is a real signal
      // of interest; it just counts for less (see recordTaste's weighting).
      // Guarded to once per video per session so a single playback can't
      // repeatedly inflate its own weight as the percentage climbs.
      if (!tasteSession.has(vid)) {
        tasteSession.add(vid);
        recordTaste(vid);
      }
      // Persist only — do NOT rescrape every feed tile mid-playback. Badges
      // refresh on scan/navigate; the tracking dot is enough here.
      syncTrackingDot();
    }
  }

  function stopTick() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  function startTick() {
    if (tickTimer || !video) return;
    tickTimer = setInterval(() => {
      if (video && !video.paused) onTime();
    }, 4000);
  }

  function syncTrackingDot() {
    if (!settings.modules || settings.modules.watchHistory === false) {
      if (trackDot) trackDot.classList.remove('on', 'idle');
      return;
    }
    ensureFeedToggle();
    const bar = document.getElementById('un-watched-feed-toggle');
    if (!bar) return;
    if (!trackDot || !bar.contains(trackDot)) {
      trackDot = document.createElement('span');
      trackDot.className = 'un-track-dot';
      trackDot.title = 'Unsynth live tracking';
      bar.appendChild(trackDot);
    }
    const onPage = isWatchPage();
    const playing = !!(video && !video.paused && !video.ended);
    trackDot.classList.toggle('on', onPage && playing);
    trackDot.classList.toggle('idle', onPage && !playing);
  }

  function detachVideo() {
    if (video && onTimeBound) {
      video.removeEventListener('timeupdate', onTimeBound);
      video.removeEventListener('play', onVideoPlay);
      video.removeEventListener('pause', onVideoPause);
      video.removeEventListener('ended', onVideoEnded);
    }
    stopTick();
    video = null;
    onTimeBound = null;
    lastAttachedVid = null;
    syncTrackingDot();
  }

  function onVideoPlay() {
    startTick();
    syncTrackingDot();
  }

  function onVideoPause() {
    stopTick();
    onTime();
    syncTrackingDot();
  }

  function onVideoEnded() {
    stopTick();
    onTime();
    syncTrackingDot();
  }

  function attachAutoMark() {
    if (!isWatchPage()) {
      detachVideo();
      return;
    }
    const v = document.querySelector('video');
    if (!v) {
      syncTrackingDot();
      return;
    }
    // On Shorts, YouTube reuses the same <video> element across navigation.
    // We must re-attach if the video ID has changed even when the element hasn't.
    const sameElement = v === video;
    const sameVid = sameElement && (lastAttachedVid === curVid());
    if (sameElement && sameVid) {
      syncTrackingDot();
      return;
    }
    detachVideo();
    video = v;
    lastAttachedVid = curVid();
    onTimeBound = onTime;
    v.addEventListener('timeupdate', onTimeBound);
    v.addEventListener('play', onVideoPlay);
    v.addEventListener('pause', onVideoPause);
    v.addEventListener('ended', onVideoEnded);
    if (!v.paused && !v.ended) startTick();
    syncTrackingDot();
  }

  function readChannel() {
    const a = document.querySelector(YT ? YT.WATCH_CHANNEL_LINK_SEL : '#owner a');
    if (!a) return { name: null, id: '' };
    // Name from the name link, key from the first link as before: the first
    // match is the avatar (no text), and moving the KEY to the name link would
    // change stored ids for channels whose two links disagree.
    const name = (YT && YT.watchChannelName ? YT.watchChannelName() : '') || (a.textContent || '').trim();
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/channel\/([\w-]+)/) || href.match(/\/@([\w-]+)/);
    return { name: name || null, id: m ? m[1] : '' };
  }

  // Title of the video currently open. watch-history never needed this before
  // (it only counted videos and channels), but the taste profile learns from
  // title vocabulary, so it needs the actual words. Falls back to the tab
  // title with YouTube's suffix stripped when the metadata element hasn't
  // rendered yet.
  function readWatchTitle() {
    const h = document.querySelector(YT ? YT.WATCH_TITLE_HEADING_SEL : 'h1');
    const fromDom = h && h.textContent ? h.textContent.trim() : '';
    if (fromDom) return fromDom;
    return (document.title || '').replace(/ - YouTube(?: Shorts)?$/, '').trim();
  }

  // Fold the video into the taste profile used for "more like this" ranking.
  // Weighted by how much was actually watched: a video you finished is a much
  // stronger statement of interest than one you bailed on after ten seconds,
  // and treating them equally is how recommenders end up chasing clickbait.
  function recordTaste(vid) {
    const TP = window.UNTasteProfile;
    if (!TP) return;
    const title = readWatchTitle();
    if (!title) return;
    const ch = readChannel();
    const pct = Math.max(Number(progress[vid]) || 0, watched.has(vid) ? 100 : 0);
    // 10% → 0.3, 50% → 0.75, 100% → 1.5. Below MIN_PROGRESS_SAVE we are not
    // called at all, so a pure bounce never reaches the profile.
    const weight = Math.max(0.3, Math.min(1.5, 0.25 + (pct / 100) * 1.25));
    guardCtx(() => {
      chrome.storage.local.get(TP.STORAGE_KEY, (d) => {
        if (chrome.runtime.lastError) return;
        const next = TP.recordWatch(d && d[TP.STORAGE_KEY], {
          title: title,
          channelKey: ch.id ? String(ch.id) : ch.name || '',
          channelName: ch.name || '',
          ts: Date.now(),
          weight: weight
        });
        const patch = {};
        patch[TP.STORAGE_KEY] = next;
        chrome.storage.local.set(patch);
      });
    });
  }

  /**
   * Remember which channel a video belongs to, so per-channel completion can be
   * computed without a Takeout import.
   *
   * Recorded on BOTH the partial and the full path. A video watched to 30% and
   * abandoned is exactly the case completion is about, and it never reaches
   * recordWatch() — so hooking only the full-watch threshold would record the
   * finishes and miss every abandonment, which inverts the number.
   *
   * Keyed by channel id where one exists, falling back to the name: a rename
   * would otherwise split one channel into two.
   */
  function noteVideoChannel(vid) {
    if (!vid) return;
    const a = document.querySelector(YT ? YT.WATCH_CHANNEL_LINK_SEL : '#owner a');
    const href = a ? a.getAttribute('href') || '' : '';
    // Must be the SAME key shape the rest of the codebase uses. readChannel()
    // returns a BARE id ("UCxxx"), while yt-dom's pageChannel() — what the
    // channel page will look up with — returns a PREFIXED one ("channel:UCxxx").
    // Storing the bare form here would match nothing on every lookup, and the
    // failure is silent: the header simply never appears.
    //
    // Measured live 2026-09-14: the watch page's owner link and the channel
    // page's pathname BOTH use /@handle, so the two keys agree without needing
    // the alias map. A channel reached by its /channel/UC... URL would key
    // differently; that case falls back to no header rather than a wrong one.
    const key = YT && YT.channelKeyFromHref ? YT.channelKeyFromHref(href) : null;
    if (!key || videoChannel[vid] === key) return;
    videoChannel[vid] = key;
    schedulePersist();
  }

  function recordWatch(vid, isNew) {
    const ch = readChannel();
    noteVideoChannel(vid);
    // Only if the partial-progress path hasn't already recorded it — a video
    // watched start to finish passes through 10% before it reaches 75%, and
    // counting it twice would double its influence on the profile.
    if (!tasteSession.has(vid)) {
      tasteSession.add(vid);
      recordTaste(vid);
    }
    guardCtx(() => {
      chrome.storage.local.get('watchStats', (d) => {
        if (chrome.runtime.lastError) {
          if (core) core.showStaleBanner();
          return;
        }
        const ws = WS.recordWatchIncrement(d && d.watchStats, {
          videoId: vid,
          isNew,
          channel: { name: ch.name, id: ch.id },
          watchedCount: watched.size
        });
        chrome.storage.local.set({ watchStats: ws }, () => {
          if (chrome.runtime.lastError && core) core.showStaleBanner();
        });
      });
    });
  }

  const mod = {
    id: 'watchHistory',
    moduleKey: 'watchHistory',
    init(c) {
      core = c;
      WD = window.UNWatchedDisplay;
      settings = c.settings;
      if (!c.isContextValid()) {
        c.showStaleBanner();
        return;
      }
      load(() => {
        apply();
        ensureFeedToggle();
      });
      onStorageChanged = (ch, area) => {
        if (area === 'local' && (ch.watchedVideos || ch.watchProgress || ch.watchedDates || ch.watchStats)) load(apply);
        if (area === 'sync' && ch.watchedDisplay) {
          settings.watchedDisplay = ch.watchedDisplay.newValue;
          if (ch.watchedMode) settings.watchedMode = ch.watchedMode.newValue;
          apply();
        }
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
      const flush = () => {
        if (dirty) persist();
      };
      onPageHide = flush;
      onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') flush();
        else {
          attachAutoMark();
          onTime();
        }
      };
      // yt-navigate-start fires BEFORE the URL changes — save the leaving video ID
      // here so onNavigate (which fires after the URL has changed) can use it.
      onNavStart = () => {
        leavingVid = curVid();
      };
      window.addEventListener('pagehide', onPageHide);
      document.addEventListener('visibilitychange', onVisibilityChange);
      document.addEventListener('yt-navigate-start', onNavStart);
    },
    scan() {
      settings = core.settings;
      if (!core.isContextValid()) {
        if (!contextWarned) {
          contextWarned = true;
          core.showStaleBanner();
        }
        return;
      }
      attachAutoMark();
      apply();
      ensureFeedToggle();
      // core's scan is already debounced and re-fires as YouTube renders more
      // rows, which is exactly when new history sections appear.
      scheduleHistoryHarvest();
    },
    onNavigate() {
      settings = core.settings;
      // leavingVid was saved by yt-navigate-start before the URL changed.
      // curVid() here already returns the incoming page's video ID.
      const leaving = leavingVid || curVid();
      leavingVid = null;
      if (leaving) {
        trimNegligibleProgress(leaving);
        recordedSession.delete(leaving);
        tasteSession.delete(leaving);
      }
      if (dirty) persist();
      revealHidden = false;
      detachVideo();
      attachAutoMark();
      apply();
      scheduleHistoryHarvest();
    },
    onSettings(s) {
      settings = s;
      apply();
      syncTrackingDot();
    },
    onMessage(msg, sendResponse) {
      if (msg && msg.type === 'unsynth-mark-watched') {
        const vid = msg.videoId || curVid();
        if (vid) markFull(vid);
        sendResponse({ ok: true, count: watched.size });
        return true;
      }
      if (msg && msg.type === 'unsynth-mark-unwatched') {
        unmark(msg.videoId || curVid());
        sendResponse({ ok: true, count: watched.size });
        return true;
      }
      if (msg && msg.type === 'unsynth-watched-count') {
        sendResponse({ ok: true, count: watched.size, partial: Object.keys(progress).length });
        return true;
      }
    },
    // Module switched off: stop tracking and strip the watched UI so dimmed/hidden
    // tiles return to normal without a page reload.
    teardown() {
      // Flush any in-flight progress before removing listeners.
      if (dirty) persist();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      detachVideo();
      if (onStorageChanged) { chrome.storage.onChanged.removeListener(onStorageChanged); onStorageChanged = null; }
      if (onPageHide) { window.removeEventListener('pagehide', onPageHide); onPageHide = null; }
      if (onVisibilityChange) { document.removeEventListener('visibilitychange', onVisibilityChange); onVisibilityChange = null; }
      if (onNavStart) { document.removeEventListener('yt-navigate-start', onNavStart); onNavStart = null; }
      const bar = document.getElementById('un-watched-feed-toggle');
      if (bar) bar.remove();
      document.querySelectorAll('.un-watched-mark').forEach((n) => n.remove());
      document.querySelectorAll('.un-watched-dim, .un-watched-hide, .un-watched-host, .un-watched-full, .un-watched-partial, .has-pct-label').forEach((el) => {
        el.classList.remove('un-watched-dim', 'un-watched-hide', 'un-watched-host', 'un-watched-full', 'un-watched-partial', 'has-pct-label');
      });
      // Remove popover document-level listeners and drop the element.
      if (popClickListener) { document.removeEventListener('click', popClickListener); popClickListener = null; }
      if (popKeyListener) { document.removeEventListener('keydown', popKeyListener); popKeyListener = null; }
      if (popScrollListener) { window.removeEventListener('scroll', popScrollListener, { capture: true }); popScrollListener = null; }
      if (popover) {
        popover.remove();
        popover = null;
      }
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
