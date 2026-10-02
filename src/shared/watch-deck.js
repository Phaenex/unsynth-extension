'use strict';

/**
 * One container for everything Unsynth adds above the fold on a watch page.
 *
 * Before this, three modules each found their own anchor and inserted their
 * own card: fact-check, the description digest, and the stats strip. That is
 * why the page showed three stacked panels with three borders and three
 * different visual weights, all doing related jobs — reported as wanting them
 * blended into one seamless menu.
 *
 * They now mount into shared slots inside a single deck, in a fixed order,
 * separated by hairlines rather than by gaps between cards. Each module still
 * owns and renders its own content; this only owns where that content lands
 * and what the seams look like.
 *
 * Slot order is deliberate — glanceable facts first, then what the video is
 * about. Review controls sit beside stats before the description content:
 *
 *   stats   likes · dislikes · ratio · views · date, and the action buttons
 *   fact    the fact-check row, and its results when opened
 *   desc    chapter jumps and outbound links
 *
 * Node-safe: guards every browser global so the unit tests can require it.
 */
(function (g) {
  var DECK_ID = 'un-watch-deck';

  /** Slots in render order. A module asks for its slot by name. */
  // 'runtime' first: it is the only slot that answers 'should I keep watching',
  // and the composition strip needs the full column width to be legible.
  // Keep the action row before the description in visual and keyboard order.
  // ai and forge (2026-09-22): every side-panel tab gets a door under the
  // video. Before, Stats and Fact check were the only tabs reachable from the
  // deck and AI / Forge lived only as masthead chips 700px away — two of the
  // four things the panel offers were undiscoverable from where the user is
  // looking. Their rows sit in the same list as Stats and Fact check, and the
  // right column stopped being two slabs with a dead gap between them.
  var SLOTS = ['runtime', 'stats', 'fact', 'ai', 'forge', 'desc'];

  function slotClass(name) {
    return 'un-deck-slot un-deck-' + name;
  }

  /**
   * Decide where the deck itself goes.
   *
   * Prefer after #top-row, inside #above-the-fold, below the creator row.
   * #owner and #top-row both constrain width, so mounting inside either is
   * what made the panel look boxed in.
   */
  /**
   * BESIDE THE VIDEO FIRST (2026-09-22). User report: "make the underbar thing a side
   * thing so it prevents people from needing to scroll". Under the player the
   * guide started at y≈650 on a 900px window — below the fold on arrival. At
   * the top of the related column it sits next to the player at y≈68.
   *
   * Only when the page really has two columns, decided by geometry: the side
   * column must be laid out to the RIGHT of the primary column and wide
   * enough to hold the guide. In YouTube's one-column layout the related list
   * sits below the video, and mounting there would bury the guide.
   */
  function sideMount(doc, yt) {
    // Selectors come from yt-dom.js only: both are scoped to the watch layout
    // there, because other pages leave a hidden #primary in the DOM.
    if (!yt || !yt.WATCH_SIDE_COLUMN_SEL || !yt.WATCH_PRIMARY_COLUMN_SEL) return null;
    var side = doc.querySelector(yt.WATCH_SIDE_COLUMN_SEL);
    var prim = doc.querySelector(yt.WATCH_PRIMARY_COLUMN_SEL);
    if (!side || !prim || !side.getBoundingClientRect || !prim.getBoundingClientRect) return null;
    var s = side.getBoundingClientRect();
    var p = prim.getBoundingClientRect();
    if (s.width < 280 || p.width < 1) return null;
    if (s.left < p.right - 2) return null;
    return side;
  }

  /**
   * THEATER (2026-09-23, decided by an expert review panel).
   *
   * YouTube's theater player fills the window and drops the related column
   * BELOW it (measured: guide at y=991 on 1920x1080). A right-edge drawer
   * over the picture was tried and rejected as "in the face"; the panel
   * rejected any overlay and any in-player popup (it fights YouTube's
   * single-key shortcuts). What theater keeps instead is a guide COLUMN
   * inside YouTube's own theater row (#full-bleed-container, a flexbox):
   * the player narrows by the column's width and nothing ever covers the
   * picture. A 16:9 video in theater at 1920x1080 is only 1620px wide with
   * ~140px of black bar each side, so most of the column comes out of the
   * bars: the picture shrinks ~8% (1620x911 -> 1489x838, measured).
   * Fullscreen still gives the full picture; the guide hides there.
   */
  function sideIsBelowPlayer(doc, side) {
    var player = doc.querySelector('#movie_player');
    if (!player || !player.getBoundingClientRect || !side.getBoundingClientRect) return false;
    var pr = player.getBoundingClientRect();
    return pr.height > 0 && side.getBoundingClientRect().top >= pr.bottom - 2;
  }

  var THEATER_COL_ID = 'un-theater-col';
  function theaterColumn(doc, yt) {
    var row = doc.querySelector((yt && yt.WATCH_THEATER_ROW_SEL) || '#full-bleed-container');
    if (!row) return null;
    var col = doc.getElementById(THEATER_COL_ID);
    if (!col) {
      col = doc.createElement('div');
      col.id = THEATER_COL_ID;
      col.className = 'un-theater-col';
    }
    if (col.parentElement !== row) row.appendChild(col);
    return col;
  }

  /**
   * Tell the page (CSS: html.un-theater-guide) whether the theater column is
   * in use, and nudge YouTube's player to re-measure when that changes: it
   * sizes itself on window resize, and the column changes its width without
   * one.
   */
  var theaterOn = false;
  function syncTheater(doc, active) {
    var onWatch = typeof location === 'undefined' || (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch');
    var on = !!active && onWatch;
    if (doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.toggle('un-theater-guide', on);
    if (on !== theaterOn) {
      theaterOn = on;
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        try { setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 0); } catch (e) { /* no Event constructor */ }
      }
    }
  }

  /**
   * YIELD TO YOUTUBE'S OWN COLUMN CONTENT. On a playlist page the queue sits
   * at the top of the related column, on a live stream the chat does. The
   * guide stays above them (its doors reachable without scrolling) but
   * compact: a one-line runtime and the four doors in one row, chapters on
   * demand. Measured before: the full guide pushed the playlist to y=629.
   */
  function columnHasPrimaryPanel(doc, yt) {
    var sels = [yt && yt.WATCH_PLAYLIST_PANEL_SEL, yt && yt.WATCH_LIVE_CHAT_SEL].filter(Boolean);
    for (var i = 0; i < sels.length; i++) {
      var el = doc.querySelector(sels[i]);
      if (el && el.getBoundingClientRect && el.getBoundingClientRect().height > 120) return true;
    }
    return false;
  }

  function markCompact(deck, doc, on) {
    if (!deck.classList) return;
    deck.classList.toggle('is-compact', on);
    var t = deck.querySelector ? deck.querySelector('.un-deck-desc > .un-deck-head .un-deck-head-t') : null;
    if (!t) return;
    // Name only what is there: a live stream has links and no chapters, and a
    // toggle promising "Chapters & links" there opens to half its promise.
    var label = SLOT_TITLES.desc;
    if (on) {
      var ch = !!deck.querySelector('.un-deck-pv-list[aria-label="Chapters"]');
      var ln = !!deck.querySelector('.un-deck-pv-list[aria-label="Links"]');
      label = ch && ln ? 'Chapters & links' : ch ? 'Chapters' : ln ? 'Links' : SLOT_TITLES.desc;
    }
    if (t.textContent !== label) t.textContent = label;
  }

  // Theater toggles, window resizes and SPA navigations change the layout
  // without necessarily triggering a module scan, so the deck re-places
  // itself on those too. Installed once.
  var layoutWatch = false;
  function watchLayout(doc, yt) {
    if (layoutWatch || typeof window === 'undefined') return;
    layoutWatch = true;
    var t = null;
    var again = function () {
      clearTimeout(t);
      t = setTimeout(function () { if (doc.getElementById(DECK_ID)) ensureDeck(doc, yt); else syncTheater(doc, false); }, 150);
    };
    window.addEventListener('resize', again);
    doc.addEventListener('yt-navigate-finish', again);
    try {
      var flexy = doc.querySelector((yt && yt.WATCH_FLEXY_SEL) || '#page-manager > *');
      if (flexy && typeof MutationObserver !== 'undefined') {
        new MutationObserver(again).observe(flexy, { attributes: true, attributeFilter: ['theater', 'fullscreen'] });
      }
    } catch (e) { /* no flexy yet; resize and navigation still cover it */ }
  }

  /** 'side' unless the user chose 'below' (dashboard, Watch guide > Position). */
  function placementPref() {
    try {
      var core = typeof window !== 'undefined' ? window.UNSYNTH : null;
      var wg = core && core.settings && core.settings.watchGuide;
      return wg && wg.placement === 'below' ? 'below' : 'side';
    } catch (e) { return 'side'; }
  }

  /** Shown unless the user turned it off (dashboard, Watch guide; or the tour). */
  function tourButtonPref() {
    try {
      var core = typeof window !== 'undefined' ? window.UNSYNTH : null;
      var wg = core && core.settings && core.settings.watchGuide;
      return !(wg && wg.showTourButton === false);
    } catch (e) { return true; }
  }

  function syncTourButton(nowEl) {
    var b = nowEl && nowEl.querySelector ? nowEl.querySelector('.un-deck-tour-btn') : null;
    if (!b) return;
    var hide = !tourButtonPref();
    if (b.hidden !== hide) b.hidden = hide;
  }

  function findMount(doc, yt) {
    if (!doc || !doc.querySelector) return null;
    var side = placementPref() === 'below' ? null : sideMount(doc, yt);
    if (side && doc.getElementById && sideIsBelowPlayer(doc, side)) {
      var col = theaterColumn(doc, yt);
      if (col) return { el: col, where: 'afterbegin', side: true, theater: true };
    }
    if (side) return { el: side, where: 'afterbegin', side: true };
    // BELOW THE CREATOR, NOT ABOVE IT.
    //
    // The deck used to mount before the top row, which put 147px of Unsynth
    // between the title and the channel and pushed YouTube's own
    // "24M views · 8 years ago" underneath both. Measured: title y=734, deck
    // y=764, channel y=933 — the host's primary metadata ended up third.
    //
    // Unsynth is the power layer, not the headline. The reading order is title,
    // native metadata, creator, then what Unsynth adds. Anchoring after the
    // owner row also puts the deck directly above the native description and
    // chapter list, which is what it annotates.
    // #top-row is the whole title+creator block, so AFTER it is below the
    // creator and above the description. Anchoring on ytd-video-owner-renderer
    // instead lands the deck INSIDE #owner -> #top-row, which is a flex row:
    // tried, and it squeezed the channel name to "3Blue…" and pushed Subscribe
    // off to the right. The selector comment in yt-dom.js records the same trap
    // for the old before-mount.
    var topSel = yt && yt.WATCH_TOP_ROW_SEL;
    var topRow = topSel ? doc.querySelector(topSel) : null;
    if (topRow && topRow.parentElement) return { el: topRow, where: 'afterend' };
    var actionSel = yt && yt.WATCH_STATS_ANCHOR_SEL;
    if (actionSel) {
      var parts = actionSel.split(/\s*,\s*/);
      for (var i = 0; i < parts.length; i++) {
        var a = doc.querySelector(parts[i]);
        if (a) return { el: a, where: 'afterend' };
      }
    }
    return null;
  }

  /**
   * Which placement the deck is in drives its whole layout (watch-deck.css
   * `.is-side`), and the side panel docks INSIDE the side guide so the doors
   * are its tabs. Tell the panel to re-home whenever the deck moves.
   */
  /**
   * ROOT FLAGS INSTEAD OF html:has() (2026-10-01). Five rules styled the
   * page from the guide's state with `html:has(#un-watch-deck...)`. A :has()
   * anchored on <html> searches the whole document, and Chrome re-ran it on
   * every style recalc: the player's progress bar recalcs about once a
   * frame, so a playing video paid it ~120 times a second. Measured on a
   * watch page with Chrome's selector stats: the worst of the five cost
   * ~1.9ms per recalc on its own, and style recalc ran 4.5x the no-extension
   * cost while playing, 40x while paused. The deck now mirrors its state
   * onto <html> as two classes and the rules read those. Only flips when the
   * state changes, so it adds no recalcs of its own.
   */
  var ROOT_GUIDE = 'un-has-guide';
  var ROOT_SIDE_GUIDE = 'un-has-side-guide';
  function syncRootFlags(doc) {
    var root = doc && doc.documentElement;
    if (!root || !root.classList || !doc.getElementById) return;
    var deck = doc.getElementById(DECK_ID);
    var shown = !!(deck && deck.classList && !deck.classList.contains('is-empty'));
    var side = shown && deck.classList.contains('is-side');
    if (root.classList.contains(ROOT_GUIDE) !== shown) root.classList.toggle(ROOT_GUIDE, shown);
    if (root.classList.contains(ROOT_SIDE_GUIDE) !== side) root.classList.toggle(ROOT_SIDE_GUIDE, side);
  }

  function markSide(deck, side) {
    var wasSide = deck.classList && deck.classList.contains('is-side');
    if (deck.classList) deck.classList.toggle('is-side', side);
    syncRootFlags(deck.ownerDocument);
    // NOTIFY MODULES THAT THE LAYOUT CHANGED (2026-09-30). desc-digest builds
    // the chapter/link chip list with a cap that depends on isSide() — if the
    // deck starts under the video then moves beside it, modules need to
    // re-render with the uncapped list. A custom event keeps the coupling
    // one-directional: watch-deck fires, modules subscribe, no module import.
    if (wasSide !== !!side && deck.dispatchEvent && typeof CustomEvent !== 'undefined') {
      try { deck.dispatchEvent(new CustomEvent('un-placement-change', { bubbles: true, detail: { side: !!side } })); } catch (_e) { /* isolated context — ignore */ }
    }
    try {
      var g = typeof window !== 'undefined' ? window : null;
      if (g && g.UNSidePanel && g.UNSidePanel.sync) g.UNSidePanel.sync();
    } catch (e) { /* no panel host on this page */ }
  }

  /* ==========================================================================
     LOADING WITHOUT JUMPS OR STALE CONTENT (2026-10-01)

     Measured on three entry paths (direct load, search click, related click):
     the guide appeared at ~194px, then grew to ~675px a second later when the
     description arrived, pushing YouTube's related list down two or three
     times (379px in one step). Worse, on a related click the guide kept the
     PREVIOUS video's stats for ~0.9s and its chapters for ~1.4s: clickable
     rows that would seek the new video to the old one's times (DESIGN-STANDARD
     section 8, "no stale flash under the next video").

     First load: the guide stays out of the layout until its description is
     ready (contentReady) or PENDING_MS has passed, so it appears once, whole.
     Video to video: on yt-navigate-start the guide keeps its height and hides
     everything tied to the old video behind a loading line, until the new
     description is ready or SWITCH_MS has passed. Same-sized guides then do
     not move anything at all.
     ========================================================================== */
  var PENDING_MS = 1200;
  var SWITCH_MS = 2500;
  var pendingTimer = null;
  var switchTimer = null;
  // The video the guide described when the switch began. Until the URL moves
  // off it, a "content ready" is the OLD video's late refresh and must not
  // reveal the guide.
  var switchOrigin = null;
  function urlVid() {
    try { return new URLSearchParams(location.search).get('v') || ''; } catch (e) { return ''; }
  }
  function descDigestOn() {
    try {
      var core = typeof window !== 'undefined' ? window.UNSYNTH : null;
      var mods = core && core.settings && core.settings.modules;
      return !(mods && mods.descDigest === false);
    } catch (e) { return true; }
  }
  function beginPending(deck) {
    if (!deck || !deck.classList || !descDigestOn()) return;
    deck.classList.add('is-pending');
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () { endPending(deck.ownerDocument); }, PENDING_MS);
  }
  function endPending(doc) {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (deck && deck.classList.contains('is-pending')) {
      deck.classList.remove('is-pending');
      fitView(doc);
    }
  }
  function beginSwitch(doc) {
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck || deck.classList.contains('is-pending')) return;
    var h = deck.getBoundingClientRect ? Math.round(deck.getBoundingClientRect().height) : 0;
    if (h > 0) deck.style.minHeight = h + 'px';
    deck.classList.add('is-switching');
    switchOrigin = urlVid();
    if (switchTimer) clearTimeout(switchTimer);
    switchTimer = setTimeout(function () { endSwitch(doc); }, SWITCH_MS);
  }
  function endSwitch(doc) {
    if (switchTimer) { clearTimeout(switchTimer); switchTimer = null; }
    switchOrigin = null;
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return;
    deck.classList.remove('is-switching');
    deck.style.minHeight = '';
    fitView(doc);
  }
  /** The description for the current video has rendered (or there is none): show the guide. */
  function contentReady(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    endPending(doc);
    if (switchOrigin !== null && switchOrigin && urlVid() === switchOrigin) return;
    endSwitch(doc);
  }

  /**
   * The deck element, created on first use and reused after that.
   * Returns null when no mount point exists yet (page still building).
   */
  function ensureDeck(doc, yt) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.createElement) return null;
    yt = yt || (typeof window !== 'undefined' ? window.UNYtDom : null);

    var deck = doc.getElementById(DECK_ID);
    var mount = findMount(doc, yt);
    if (doc.getElementById) {
      syncTheater(doc, !!(mount && mount.theater));
      if (mount) watchLayout(doc, yt);
    }

    if (deck) {
      // Re-place it if YouTube rebuilt the block around it (every SPA
      // navigation), or the layout crossed between one and two columns.
      if (mount) {
        var placed;
        if (mount.where === 'afterbegin') placed = mount.el.firstElementChild === deck;
        else if (mount.where === 'beforebegin') placed = mount.el.previousElementSibling === deck;
        else placed = mount.el.nextElementSibling === deck;
        if (!placed) {
          mount.el.insertAdjacentElement(mount.where, deck);
          markSide(deck, !!mount.side);
        }
      }
      markCompact(deck, doc, !!(mount && mount.side && !mount.theater && columnHasPrimaryPanel(doc, yt)));
      return deck;
    }

    if (!mount) return null;
    deck = doc.createElement('div');
    deck.id = DECK_ID;
    deck.className = 'un-watch-deck';
    beginPending(deck);
    markSide(deck, !!mount.side);
    deck.setAttribute('role', 'region');
    deck.setAttribute('aria-label', 'Unsynth video details');
    for (var i = 0; i < SLOTS.length; i++) {
      var s = doc.createElement('div');
      s.className = slotClass(SLOTS[i]);
      s.dataset.slot = SLOTS[i];
      deck.appendChild(s);
    }
    mount.el.insertAdjacentElement(mount.where, deck);
    watchOwnBodies(deck, doc);
    wireNow(doc);
    return deck;
  }

  /**
   * The deck keeps its own empty flags true (2026-09-23).
   *
   * Every module was trusted to call syncEmpty() after filling its slot, and
   * dislike-restore called it BEFORE appending the stats. On a full profile a
   * later module's sync repaired that by accident; on a reduced-module profile nothing
   * came later, so the Stats slot held its content under display:none and the
   * whole guide showed as an empty strip (found in his browser, reproduced by
   * e2e/deck-empty-sync.spec.js). Watching the bodies means no module has to
   * remember. syncEmpty only toggles classes, so it cannot retrigger this
   * childList observer.
   */
  function watchOwnBodies(deck, doc) {
    if (!deck || deck.__unBodiesObs || typeof MutationObserver === 'undefined') return;
    // Synced directly in the callback, NOT deferred to requestAnimationFrame.
    // The first version used rAF, and rAF does not run in a hidden tab:
    // measured in a user browser, a background tab kept the guide empty
    // ("raf did NOT run within 2s", visibilityState hidden) until it was
    // shown. The observer already batches a burst of mutations into one call.
    // Targets are the slot (modules may append straight into it before
    // slotBody moves the content) or the body.
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i].target;
        if (t && t.classList && (t.classList.contains('un-deck-body') || t.classList.contains('un-deck-slot'))) {
          syncEmpty(doc);
          return;
        }
      }
    });
    obs.observe(deck, { childList: true, subtree: true });
    deck.__unBodiesObs = obs;
  }

  /**
   * Hand a module its slot. It appends whatever it likes inside.
   * Returns null when the deck cannot be placed yet — callers fall back to
   * their own anchor so nothing disappears if this fails.
   */
  function slot(name, doc, yt) {
    if (SLOTS.indexOf(name) === -1) return null;
    var deck = ensureDeck(doc, yt);
    if (!deck) return null;
    var el = deck.querySelector('.un-deck-' + name);
    if (!el) return null;
    // Hand back the BODY, not the slot, so a module renders inside the
    // collapsible region rather than beside the header that collapses it.
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return el;
    ensureSlotHeader(el, name, d);
    return slotBody(el, d);
  }

  /**
   * Per-slot collapse.
   *
   * WHY THIS EXISTS
   * The deck measured 200px before the runtime strip and 296px after, at 1680.
   * The fold sits at 1050 on a 1050-tall window and the title is at 734, so
   * there are 316px between them: a 296px deck consumes essentially all of it
   * and pushes the description, the comments and the fact-check results below
   * the fold. The strip earned its height; the rest is reference material that
   * is read once and then in the way.
   *
   * So every slot gets a header that collapses it, the state persists per slot
   * rather than globally, and the defaults are chosen by what is still undecided
   * when the panel renders: the user has already clicked the video, so runtime
   * is open and likes/views are not.
   *
   * The header is a real <button> with aria-expanded, so this works from the
   * keyboard and announces its state, rather than being a click-target div.
   */
  var COLLAPSE_KEY = 'unDeckCollapsed';

  // Reference material starts closed; the thing you have not decided yet does
  // not. Stats are decision inputs for a thumbnail grid, not for a page you are
  // already on.
  // Everything here is reference material, which is why it all starts closed.
  /**
   * WHAT OPENS BY DEFAULT.
   *
   * All three used to start closed, which made the deck three rows that named
   * information without showing any: "13 chapters · 12 links" and no chapters,
   * no links. Naming a thing is not showing it, and progressive disclosure is
   * for detail, not for a feature's primary value.
   *
   * desc opens because it holds the chapter and link chips — the only part of
   * this deck the user navigates WITH rather than reads. Reaching a chapter
   * cost three clicks; it now costs none.
   *
   * stats stays closed: the like count it leads with is already on YouTube's
   * own button a few pixels away, so open-by-default would spend a row
   * repeating the host. Its header carries the ratio, which YouTube does not
   * show, and that is the part worth surfacing.
   *
   * fact stays closed because "not run" is not a verdict and must not be the
   * loudest thing here. It is an action until it has a result.
   */
  // desc STARTS COLLAPSED NOW THAT ITS HEADER CARRIES THE VALUE.
  //
  // It was expanded by default for a good reason: the header said "7 chapters ·
  // 5 links" — a count — so the body was the only place the actual timestamps
  // existed, and collapsing it hid the feature's whole point.
  //
  // setPreview() moved those timestamps into the header as clickable chips, so
  // an expanded body now renders the SAME seven stamps a second time, 113px
  // below the first set. Measured on the reference video at 1680px: the slot
  // was 180px, being a 52px header and a 113px body showing its duplicate.
  // That is 113px spent repeating what the row above already says, and it put
  // the deck at 368px against a documented 340px budget.
  //
  // The body still holds what the header cannot: the full description text and
  // links past the cap. One click still opens it. Nothing was deleted — the
  // duplicate was.
  var DEFAULT_COLLAPSED = { stats: true, desc: true, fact: true };

  // Runtime is NOT collapsible. It was briefly given a label-less header so the
  // word would not appear twice above a strip that prints its own readout, but
  // that shipped an 18px unlabeled caret: under the 24px minimum target, first in
  // tab order, and announcing "expanded" with nothing nameable behind it. A copy
  // problem does not get solved by deleting the label. The slot that answers the
  // only open question does not need a way to hide itself.
  var UNCOLLAPSIBLE = { runtime: true };

  var SLOT_TITLES = {
    runtime: 'Runtime',
    stats: 'Stats',
    desc: 'Description',
    fact: 'Fact check',
    ai: 'Ask AI',
    forge: 'Forge'
  };

  var _collapsed = null;

  function readCollapsed(cb) {
    if (_collapsed) { cb(_collapsed); return; }
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        var q = {};
        q[COLLAPSE_KEY] = null;
        chrome.storage.local.get(q, function (d) {
          var stored = (d && d[COLLAPSE_KEY]) || null;
          _collapsed = Object.assign({}, DEFAULT_COLLAPSED, stored || {});
          cb(_collapsed);
        });
        return;
      }
    } catch (e) { /* no extension context (unit tests, page world) */ }
    _collapsed = Object.assign({}, DEFAULT_COLLAPSED);
    cb(_collapsed);
  }

  function writeCollapsed(next) {
    _collapsed = next;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        var p = {};
        p[COLLAPSE_KEY] = next;
        chrome.storage.local.set(p);
      }
    } catch (e) { /* context invalidated mid-write; the paint already happened */ }
  }

  // Without this the module-level cache never invalidates. Two YouTube tabs open,
  // toggle in one, and the other keeps a stale object forever — then writes it
  // back over the first on its next toggle. Last writer wins, silently.
  var _watchingStorage = false;
  function watchCollapsedChanges() {
    if (_watchingStorage) return;
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[COLLAPSE_KEY]) return;
        _collapsed = Object.assign({}, DEFAULT_COLLAPSED, changes[COLLAPSE_KEY].newValue || {});
        applyCollapsed(typeof document !== 'undefined' ? document : null, _collapsed);
        applyGroupFolds(typeof document !== 'undefined' ? document : null, _collapsed);
      });
      _watchingStorage = true;
    } catch (e) { /* no extension context */ }
  }

  /** Build (or refresh) the header button for one slot. */
  function ensureSlotHeader(slotEl, name, doc) {
    if (!slotEl || UNCOLLAPSIBLE[name]) return null;
    var head = slotEl.querySelector(':scope > .un-deck-head');
    if (!head) {
      head = doc.createElement('button');
      head.type = 'button';
      head.className = 'un-deck-head';
      // One glyph per row, drawn by CSS from the slot name (watch-deck.css),
      // so a row is recognisable before it is read. Decorative: the label
      // carries the name.
      var ico = doc.createElement('span');
      ico.className = 'un-deck-ico';
      ico.setAttribute('aria-hidden', 'true');
      head.appendChild(ico);
      var label = doc.createElement('span');
      label.className = 'un-deck-head-t';
      label.textContent = SLOT_TITLES[name] || name;
      var sum = doc.createElement('span');
      sum.className = 'un-deck-head-s';
      var caret = doc.createElement('span');
      caret.className = 'un-deck-caret';
      caret.setAttribute('aria-hidden', 'true');
      // Label, then value, then caret. Appending the summary first read as
      // "56.7M · 90%Stats" to both the eye and a screen reader.
      head.appendChild(label);
      head.appendChild(sum);
      // The outcome of pressing, when the row is an action rather than a
      // readout ("Review claims"). Part of the button's accessible name.
      var act = doc.createElement('span');
      act.className = 'un-deck-head-a';
      head.appendChild(act);
      head.appendChild(caret);
      head.addEventListener('click', function () {
        var fn = launchers[name];
        if (fn) { fn(); return; }
        toggleSlot(name, doc);
      });
      // Without aria-controls the button announces "expanded" with no way to say
      // expanded-what, and collapsing removes content with no announced relation.
      head.setAttribute('aria-controls', DECK_ID + '-body-' + name);
      slotEl.insertBefore(head, slotEl.firstChild);
    }
    return head;
  }

  /**
   * A slot's own content lives in a body wrapper, so collapsing hides the
   * content without hiding the header that un-collapses it.
   */
  function slotBody(slotEl, doc) {
    if (!slotEl) return null;
    var body = slotEl.querySelector(':scope > .un-deck-body');
    if (!body) {
      body = doc.createElement('div');
      body.className = 'un-deck-body';
      body.id = DECK_ID + '-body-' + (slotEl.dataset ? slotEl.dataset.slot : '');
      // Move anything a module already appended into the body.
      var kids = [];
      for (var i = 0; i < slotEl.childNodes.length; i++) {
        var n = slotEl.childNodes[i];
        if (n.nodeType === 1 && (n.classList.contains('un-deck-head') || n.classList.contains('un-deck-body') ||
          n.classList.contains('un-deck-preview'))) continue;
        kids.push(n);
      }
      kids.forEach(function (n) { body.appendChild(n); });
      slotEl.appendChild(body);
    }
    return body;
  }

  // Folded chapter / link groups share the slots' store, keyed "pv:<group>",
  // so they sync across tabs the same way. Missing means open.
  function groupFoldKey(name) { return 'pv:' + name; }
  function applyGroupFolds(doc, state) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return;
    var rows = deck.querySelectorAll('.un-deck-pv-row[data-group]');
    for (var i = 0; i < rows.length; i++) {
      var head = rows[i].querySelector(':scope > .un-deck-pv-heading.is-toggle');
      var fold = !!(head && state && state[groupFoldKey(rows[i].dataset.group)]);
      rows[i].classList.toggle('is-folded', fold);
      if (head) head.setAttribute('aria-expanded', fold ? 'false' : 'true');
    }
  }

  function applyCollapsed(doc, state) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return;
    SLOTS.forEach(function (name) {
      var slotEl = deck.querySelector('.un-deck-' + name);
      if (!slotEl) return;
      var head = ensureSlotHeader(slotEl, name, doc);
      slotBody(slotEl, doc);
      if (launchers[name]) markLauncher(slotEl, name, true);
      if (UNCOLLAPSIBLE[name] || launchers[name]) { slotEl.classList.remove('is-collapsed'); return; }
      // BESIDE THE VIDEO THE DESCRIPTION IS THE VIEW, NOT A FOLD (2026-09-24).
      // Its header is hidden there and its body (every link, what is worth
      // knowing) always shows, so it must never be marked collapsed: showing
      // the body under aria-expanded="false" is a claim about nothing, and
      // deck-collapse.spec caught exactly that (3 of 4 runs).
      if (name === 'desc' && deck.classList.contains('is-side') && !deck.classList.contains('is-compact')) {
        slotEl.classList.remove('is-collapsed');
        if (head) head.setAttribute('aria-expanded', 'true');
        return;
      }
      var off = !!(state && state[name]);
      slotEl.classList.toggle('is-collapsed', off);
      if (head) head.setAttribute('aria-expanded', off ? 'false' : 'true');
    });
  }

  /**
   * A launcher header opens the side panel tab that holds this slot's depth,
   * instead of collapsing a body under the video. The slot's own body, if it
   * has one, stays visible: it is the glance content (2026-09-21 decision —
   * deck = glance strip, depth opens beside the video).
   */
  var launchers = {};
  /**
   * Stamp (or clear) a slot's launcher marks. Called from setLauncher AND from
   * applyCollapsed: a module can register its launcher before the deck's
   * header exists, and until 2026-09-21 that left the behaviour registered but
   * the header unmarked — an un-collapsed slot with no data-un-sp-launch, which
   * deck-collapse.spec.js correctly refused as "reference material left open".
   */
  function markLauncher(slotEl, name, on) {
    if (!slotEl) return;
    slotEl.classList.toggle('is-launcher', !!on);
    var head = slotEl.querySelector(':scope > .un-deck-head');
    if (!head) return;
    if (on) {
      if (!head.hasAttribute('aria-expanded')) head.setAttribute('aria-expanded', 'false');
      head.setAttribute('aria-controls', 'un-side-panel');
      head.setAttribute('data-un-sp-launch', name);
      head.title = 'Open in the side panel';
    } else {
      head.setAttribute('aria-controls', DECK_ID + '-body-' + name);
      head.removeAttribute('data-un-sp-launch');
      head.removeAttribute('title');
    }
  }
  function setLauncher(name, fn, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (fn) launchers[name] = fn; else delete launchers[name];
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return;
    var slotEl = deck.querySelector('.un-deck-' + name);
    if (!slotEl) return;
    markLauncher(slotEl, name, !!fn);
    if (fn) slotEl.classList.remove('is-collapsed');
  }
  function toggleSlot(name, doc) {
    readCollapsed(function (state) {
      var next = Object.assign({}, state);
      next[name] = !next[name];
      writeCollapsed(next);
      applyCollapsed(doc, next);
    });
  }

  /**
   * The one-line summary a collapsed slot shows instead of a bare label.
   *
   * Without this, collapsing STATS replaces a row of glanceable numbers with the
   * word STATS — the same height, none of the information, and no signal that
   * anything is behind it. A value beside the label is what makes the header read
   * as expandable rather than as one more inert YouTube metadata row.
   */
  function setSummary(name, text, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return;
    var el = deck.querySelector('.un-deck-' + name + ' > .un-deck-head .un-deck-head-s');
    if (el) el.textContent = text || '';
  }

  /**
   * Render a slot's PRIMARY VALUE into its header row, as real interactive
   * items rather than a count of them.
   *
   * DESIGN-STANDARD.md section 1, rule A: "Do not spend a row saying
   * information exists when the information itself fits." Its Weak/Strong
   * table names this exact surface:
   *
   *   Weak                Strong
   *   13 chapters   >     0:00  1:07  2:42  3:35  5:31  +8
   *   12 links      >     github.com  patreon.com  +10
   *
   * Before this existed the deck's only content primitive was setSummary(),
   * which takes a string. A string-only API cannot express "seven buttons that
   * seek the video", so every module that had list-shaped value had no way to
   * show it and fell back to counting. desc-digest rendered "7 chapters · 5
   * links" while holding the parsed, clickable stamps the whole time. The
   * missing primitive was the cause; the counting was the symptom.
   *
   * items: [{ label, title?, onClick?, href? }]
   *   onClick -> a <button> (seek, expand)
   *   href    -> an <a> (external link, opens in a new tab)
   *   neither -> a plain <span>
   * opts.cap       how many to show before overflowing (default: all)
   * opts.onOverflow(rest) custom handler for the +N chip; the default reveals
   *   the remaining items inline, which keeps the value one click away rather
   *   than in another surface.
   */
  /**
   * WHERE THE CHIPS LIVE (2026-09-22): beside the header, not inside it.
   *
   * They used to render into .un-deck-head-s, i.e. inside the slot header —
   * a <button>. A button containing buttons and links is invalid HTML, and
   * the accessibility tree flattens a button's content into its name, so a
   * screen reader heard one control called "Explore this video 0:00 1:07
   * 2:42 …" instead of eight seek buttons. The stopPropagation below was
   * papering over the same nesting for mouse users.
   *
   * The preview is now a sibling group (.un-deck-preview) that follows the
   * header. Items may carry a `group` ("Chapters", "Links"): each group gets
   * a visible label so a row of chips says what kind of thing it is, and a
   * `sub` (the chapter title) so a timestamp says what is there.
   */
  function previewHost(slotEl, doc) {
    var host = slotEl.querySelector(':scope > .un-deck-preview');
    if (!host) {
      host = doc.createElement('div');
      host.className = 'un-deck-preview';
      var head = slotEl.querySelector(':scope > .un-deck-head');
      if (head && head.nextSibling) slotEl.insertBefore(host, head.nextSibling);
      else slotEl.appendChild(host);
    }
    return host;
  }

  function setPreview(name, items, opts, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return;
    var slotEl = deck.querySelector('.un-deck-' + name);
    if (!slotEl || !slotEl.querySelector(':scope > .un-deck-head')) return;
    var host = previewHost(slotEl, doc);
    opts = opts || {};

    while (host.firstChild) host.removeChild(host.firstChild);
    slotEl.classList.toggle('has-preview', !!(items && items.length));
    // The header's own summary is the fallback for "no preview"; with one, it
    // would repeat the preview as a count.
    var sumEl = slotEl.querySelector(':scope > .un-deck-head .un-deck-head-s');
    if (sumEl && items && items.length) sumEl.textContent = '';
    if (!items || !items.length) return;

    // Split into groups in first-seen order; ungrouped items share one.
    var groups = [];
    var byName = {};
    items.forEach(function (it) {
      var g = it.group || '';
      if (!byName[g]) { byName[g] = { name: g, items: [] }; groups.push(byName[g]); }
      byName[g].items.push(it);
    });
    groups.forEach(function (grp) {
      if (grp.name === 'Chapters') {
        grp.items = grp.items
          .map(function (item, index) { return { item: item, index: index }; })
          .sort(function (a, b) {
            var as = typeof a.item.sec === 'number' ? a.item.sec : Infinity;
            var bs = typeof b.item.sec === 'number' ? b.item.sec : Infinity;
            return as === bs ? a.index - b.index : as - bs;
          })
          .filter(function (entry, index, sorted) {
            return index === 0 || typeof entry.item.sec !== 'number' || entry.item.sec !== sorted[index - 1].item.sec;
          })
          .map(function (entry) { return entry.item; });
      }
      var row = doc.createElement('div');
      row.className = 'un-deck-pv-row';
      if (grp.name) row.dataset.group = grp.name;
      if (grp.name) {
        // FOLDABLE GROUPS BESIDE THE VIDEO (2026-10-01). User report: "THE CHAPTERS
        // IN THE SIDE BAR SHOULD BE COLLAPSABLE AS WELL", like the rows above
        // them. Beside the video the heading is a toggle; under the video the
        // groups are one line of chips each and stay a plain label.
        var foldable = deck.classList.contains('is-side') && !deck.classList.contains('is-compact');
        var heading = doc.createElement(foldable ? 'button' : 'div');
        heading.className = 'un-deck-pv-heading';
        if (foldable) {
          heading.type = 'button';
          heading.classList.add('is-toggle');
          heading.addEventListener('click', function (ev) {
            ev.preventDefault();
            readCollapsed(function (state) {
              var next = Object.assign({}, state);
              next[groupFoldKey(grp.name)] = !row.classList.contains('is-folded');
              writeCollapsed(next);
              applyGroupFolds(doc, next);
              fitView(doc);
            });
          });
        }
        var lab = doc.createElement('span');
        lab.className = 'un-deck-pv-lab';
        lab.textContent = grp.name;
        heading.appendChild(lab);
        if (grp.name === 'Chapters') {
          var count = doc.createElement('span');
          count.className = 'un-deck-pv-count';
          count.textContent = String(grp.items.length);
          count.setAttribute('aria-label', grp.items.length + (grp.items.length === 1 ? ' chapter' : ' chapters'));
          heading.appendChild(count);
        }
        if (foldable) {
          var caret = doc.createElement('span');
          caret.className = 'un-deck-caret';
          caret.setAttribute('aria-hidden', 'true');
          heading.appendChild(caret);
        }
        row.appendChild(heading);
      }
      var list = doc.createElement('div');
      list.className = 'un-deck-pv-list';
      if (grp.name) list.setAttribute('aria-label', grp.name);
      // The toggle names the region it folds, as the rows' headers do.
      if (grp.name && heading && heading.tagName === 'BUTTON') {
        list.id = 'un-deck-pv-' + grp.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        heading.setAttribute('aria-controls', list.id);
      }
      row.appendChild(list);
      host.appendChild(row);
      fillGroup(list, grp.items, grp.name ? (opts.caps && opts.caps[grp.name]) || opts.cap : opts.cap);
      if (grp.name === 'Chapters') wireChapterKeys(list);
    });
    if (_collapsed) applyGroupFolds(doc, _collapsed);
    else readCollapsed(function (state) { applyGroupFolds(doc, state); });

    function wireChapterKeys(list) {
      list.addEventListener('keydown', function (ev) {
        if (!/^(ArrowUp|ArrowDown|Home|End)$/.test(ev.key || '')) return;
        var chapters = list.querySelectorAll('.un-deck-chip:not(.un-deck-chip-more)');
        if (!chapters.length) return;
        var active = doc.activeElement;
        var index = Array.prototype.indexOf.call(chapters, active);
        var next = ev.key === 'Home' ? 0 : ev.key === 'End' ? chapters.length - 1 : index + (ev.key === 'ArrowUp' ? -1 : 1);
        next = Math.max(0, Math.min(chapters.length - 1, next));
        if (chapters[next] && chapters[next].focus) {
          ev.preventDefault();
          chapters[next].focus();
        }
      });
    }

    function fillGroup(list, groupItems, capN) {
      var cap = typeof capN === 'number' && capN > 0 ? capN : groupItems.length;
      // A "+1" chip costs the same width as the one item it hides.
      if (groupItems.length === cap + 1) cap = groupItems.length;
      var shown = groupItems.slice(0, cap);
      var rest = groupItems.slice(cap);
      shown.forEach(function (item) { list.appendChild(chipFor(item)); });
      if (rest.length) {
        var more = doc.createElement('button');
        more.type = 'button';
        more.className = 'un-deck-chip un-deck-chip-more';
        more.textContent = '+' + rest.length;
        more.title = 'Show ' + rest.length + ' more';
        more.setAttribute('aria-label', more.title);
        more.addEventListener('click', function (ev) {
          ev.preventDefault();
          if (opts.onOverflow) { opts.onOverflow(rest); return; }
          var frag = doc.createDocumentFragment();
          rest.forEach(function (item) { frag.appendChild(chipFor(item)); });
          list.insertBefore(frag, more);
          more.remove();
        });
        list.appendChild(more);
      }
    }

    function chipFor(item) {
      var node;
      if (item.href) {
        node = doc.createElement('a');
        node.href = item.href;
        // setAttribute, not the .target/.rel properties: both reflect in a real
        // DOM, but the attribute form is what a DOM inspector, a test and a CSP
        // audit all read, and it cannot be shadowed by an expando.
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      } else if (item.onClick) {
        node = doc.createElement('button');
        node.type = 'button';
      } else {
        node = doc.createElement('span');
      }
      node.className = 'un-deck-chip' + (item.sub ? ' has-sub' : '');
      if (typeof item.sec === 'number' && isFinite(item.sec)) node.dataset.start = String(item.sec);
      if (item.sub) {
        var t = doc.createElement('span');
        t.className = 'un-deck-chip-t';
        t.textContent = item.label;
        var s = doc.createElement('span');
        s.className = 'un-deck-chip-s';
        s.textContent = item.sub;
        node.appendChild(t);
        node.appendChild(s);
        if (typeof item.duration === 'string' && item.duration) {
          var d = doc.createElement('span');
          d.className = 'un-deck-chip-d';
          d.textContent = item.duration;
          node.appendChild(d);
        }
      } else {
        node.textContent = item.label;
      }
      if (item.title) node.title = item.title;
      if (item.onClick) {
        node.addEventListener('click', function (ev) {
          ev.preventDefault();
          item.onClick();
        });
      }
      return node;
    }
  }

  /** Visible outcome text on a launcher row ("Review claims"); '' clears it. */
  function setAction(name, text, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return;
    var el = deck.querySelector('.un-deck-' + name + ' > .un-deck-head .un-deck-head-a');
    if (el) el.textContent = text || '';
  }

  /** Called after any module renders into a slot. */
  function syncCollapse(doc) {
    watchCollapsedChanges();
    readCollapsed(function (state) { applyCollapsed(doc, state); });
  }

  /**
   * A slot with nothing in it must not render its hairline, or the deck shows
   * dividers with no content between them. Cheap enough to call on any paint.
   */
  function syncEmpty(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return;
    var filled = 0;
    var slots = deck.querySelectorAll('.un-deck-slot');
    for (var i = 0; i < slots.length; i++) {
      // The body, not the slot: every slot now carries a header button, so
      // counting slot children would report every slot as filled forever.
      var body = slots[i].querySelector(":scope > .un-deck-body");
      var has = body ? body.children.length > 0 : slots[i].children.length > 0;
      // A launcher slot is filled by its header: the value it shows and the
      // panel it opens are the content.
      if (!has && launchers[slots[i].dataset ? slots[i].dataset.slot : '']) has = true;
      slots[i].classList.toggle('is-empty', !has);
      if (has) filled++;
    }
    // More tools and Now are content: with every module off they are the
    // whole guide, and an empty-flagged guide is display:none.
    if (renderMore(doc) > 0) filled++;
    if (renderNow(doc)) filled++;
    deck.classList.toggle('is-empty', filled === 0);
    syncRootFlags(doc);
    fitView(doc);
  }

  function remove(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (deck && deck.parentNode) deck.parentNode.removeChild(deck);
    syncRootFlags(doc);
  }

  /* ==========================================================================
     MORE TOOLS AND NOW (2026-09-24)

     A user, on their own profile (most watch-page modules off): "i just see a
     time and stats right now", and asked for the menu to "show more at a
     glance" and say what the features are. Every row was owned by a module,
     so a switched-off module left no trace: the guide could not show what it
     does not have, and nothing said Fact check, Ask AI, Forge or Chapters
     existed. The guide now names every watch-page feature that is off, says
     in one line what it does, and turns it on in this tab (the service worker
     injects it; no reload, no trip to settings).

     "Now" is the one thing the guide can say about the video while it plays
     that nothing else does: the chapter you are in, what is left at your
     speed, and when it ends. SponsorBlock's runtime row gives totals; this
     gives the moment.
     ========================================================================== */

  /**
   * Every watch-page feature the guide can offer, in the order they are
   * listed when off. `slot` is where it renders once on (null: it adds depth
   * to another row). Keys must stay in step with GUIDE_MODULE_KEYS in the
   * service worker (test/guide-more-tools.test.js checks both lists).
   */
  var FEATURES = [
    { key: 'descDigest', slot: 'desc', label: 'Chapters & links', blurb: 'Timestamps and links from the description, one click away' },
    { key: 'sponsorBlock', slot: 'runtime', label: 'Skip segments', blurb: 'Skips sponsors and shows how long the video really is' },
    { key: 'dislikeRestore', slot: 'stats', label: 'Stats', blurb: 'Likes, dislikes and the like ratio' },
    { key: 'analytics', slot: 'stats', label: 'Full stats', blurb: 'Views per day, engagement, SEO and compare' },
    { key: 'factCheck', slot: 'fact', label: 'Fact check', blurb: 'Checks what the video claims. Uses your AI key' },
    { key: 'aiAssistant', slot: 'ai', label: 'Ask AI', blurb: 'Summaries and answers from the transcript. Uses your AI key' },
    { key: 'forgeLink', slot: 'forge', label: 'Forge', blurb: 'Build and add to playlists from what you watch' }
  ];

  // key -> 'pending' while the worker is switching it on, 'failed' after an
  // error. A key that succeeded is dropped from the list by the settings
  // reload, not by this map.
  var _enabling = {};
  var _moreErr = {};
  // Compact only: the list folds behind one "+ N tools" button so the
  // playlist queue keeps its place near the top of the column.
  var _moreOpen = false;

  function suiteSettings() {
    try {
      var core = typeof window !== 'undefined' ? window.UNSYNTH : null;
      return core && core.settings && core.settings.modules ? core.settings : null;
    } catch (e) { return null; }
  }

  /** Features whose module is explicitly off, per the suite's own settings. */
  function offFeatures(settings) {
    var s = settings || suiteSettings();
    if (!s || !s.modules) return [];
    return FEATURES.filter(function (f) { return s.modules[f.key] === false; });
  }

  function turnOn(f, doc) {
    if (_enabling[f.key] === 'pending') return;
    _enabling[f.key] = 'pending';
    delete _moreErr[f.key];
    renderMore(doc);
    var done = function (res) {
      if (res && res.ok) {
        // The settings write reaches core via storage.onChanged; its reload
        // flips modules[key] and the next render drops the row. Keep the row
        // in its pending state until then rather than guessing.
        _enabling[f.key] = 'done';
        setTimeout(function () { renderMore(doc); }, 400);
        return;
      }
      _enabling[f.key] = 'failed';
      _moreErr[f.key] = res && res.reload
        ? 'Turned on. Reload the page to load it.'
        : 'Could not turn it on here. Try Settings.';
      renderMore(doc);
    };
    try {
      var type = (typeof window !== 'undefined' && window.UNMSG && window.UNMSG.GUIDE_ENABLE_MODULE) || 'UNSYNTH/GUIDE/ENABLE_MODULE';
      chrome.runtime.sendMessage({ type: type, key: f.key }, function (res) {
        if (chrome.runtime.lastError) { done(null); return; }
        done(res);
      });
    } catch (e) {
      done(null);
    }
  }

  /**
   * The "More tools" group at the end of the guide: one row per feature that
   * is off. Rebuilt only when the set or a row's state changes, so calling it
   * from every syncEmpty costs a string compare.
   */
  function renderMore(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return 0;
    var list = offFeatures();
    // 'done' only bridges the gap until settings say on. Once they do, forget
    // it: kept, a feature switched off again later in this tab came back as a
    // row whose button was stuck on a disabled "Turning on…" (e2e: off, on,
    // off, on in one tab).
    var offNow = {};
    list.forEach(function (f) { offNow[f.key] = true; });
    Object.keys(_enabling).forEach(function (k) {
      if (_enabling[k] === 'done' && !offNow[k]) delete _enabling[k];
    });
    var host = deck.querySelector(':scope > .un-deck-more');
    if (!list.length) {
      if (host) host.parentNode.removeChild(host);
      return 0;
    }
    var sig = (_moreOpen ? 'open|' : '') + list.map(function (f) { return f.key + ':' + (_enabling[f.key] || '') + ':' + (_moreErr[f.key] || ''); }).join('|');
    if (host && host.getAttribute('data-sig') === sig) return list.length;
    if (!host) {
      host = doc.createElement('section');
      host.className = 'un-deck-more';
      host.setAttribute('aria-label', 'More Unsynth tools');
      deck.appendChild(host);
    }
    host.setAttribute('data-sig', sig);
    while (host.firstChild) host.removeChild(host.firstChild);
    var h = doc.createElement('h3');
    h.className = 'un-deck-more-h';
    h.textContent = 'More tools';
    host.appendChild(h);
    host.classList.toggle('is-open', _moreOpen);
    var tog = doc.createElement('button');
    tog.type = 'button';
    tog.className = 'un-deck-more-toggle';
    tog.setAttribute('aria-expanded', _moreOpen ? 'true' : 'false');
    tog.textContent = _moreOpen ? 'Hide tools' : '+ ' + list.length + (list.length === 1 ? ' tool' : ' tools') + ' you can turn on';
    tog.addEventListener('click', function (ev) {
      ev.preventDefault();
      _moreOpen = !_moreOpen;
      renderMore(doc);
    });
    host.appendChild(tog);
    var ul = doc.createElement('ul');
    ul.className = 'un-deck-more-list';
    list.forEach(function (f) {
      var li = doc.createElement('li');
      li.className = 'un-deck-more-row';
      li.setAttribute('data-key', f.key);
      // Same glyph as the row it becomes once on (watch-deck.css maps data-ico).
      li.setAttribute('data-ico', f.slot);
      var ico = doc.createElement('span');
      ico.className = 'un-deck-ico';
      ico.setAttribute('aria-hidden', 'true');
      var txt = doc.createElement('span');
      txt.className = 'un-deck-more-txt';
      var t = doc.createElement('span');
      t.className = 'un-deck-more-t';
      t.textContent = f.label;
      var b = doc.createElement('span');
      b.className = 'un-deck-more-b';
      b.textContent = _moreErr[f.key] || f.blurb;
      if (_moreErr[f.key]) b.classList.add('is-err');
      txt.appendChild(t);
      txt.appendChild(b);
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'un-deck-more-on';
      var state = _enabling[f.key];
      // Verb and name as separate spans: the full row shows "Turn on" beside
      // the name, the compact row has no room for the name elsewhere and
      // shows "+ Fact check" instead (watch-deck.css).
      var verb = doc.createElement('span');
      verb.className = 'un-deck-more-verb';
      verb.textContent = state === 'pending' || state === 'done' ? 'Turning on…' : 'Turn on';
      var nm = doc.createElement('span');
      nm.className = 'un-deck-more-name';
      nm.textContent = f.label;
      btn.appendChild(verb);
      btn.appendChild(nm);
      btn.disabled = state === 'pending' || state === 'done';
      btn.setAttribute('aria-label', 'Turn on ' + f.label);
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        turnOn(f, doc);
      });
      li.appendChild(ico);
      li.appendChild(txt);
      li.appendChild(btn);
      ul.appendChild(li);
    });
    host.appendChild(ul);
    return list.length;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtLeft(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  function fmtRate(r) {
    return (Math.round(r * 100) / 100).toString().replace(/\.0+$/, '') + '×';
  }

  /**
   * What the Now line says, from the player, or null when there is nothing
   * true to say (no player, an ad, duration not known yet). Pure given its
   * inputs, so the unit tests drive it without a browser.
   */
  function nowText(v, opts) {
    opts = opts || {};
    if (!v) return null;
    // During an ad the player's numbers are the ad's, so say so instead of
    // timing it. The row stays (with Tour): hiding it shrank the guide ~40 px
    // for the ad and grew it back after (measured 2026-10-01: 605 vs 649 px).
    if (opts.ad) return { live: false, ad: true, chapter: '', text: 'Ad playing', pct: 0 };
    if (opts.live) return { live: true, text: 'Live', chapter: '' };
    var dur = v.duration;
    if (!isFinite(dur) || dur <= 0) return null;
    var rate = v.playbackRate > 0 ? v.playbackRate : 1;
    var left = Math.max(0, dur - (v.currentTime || 0)) / rate;
    var parts = [fmtLeft(left) + ' left' + (Math.abs(rate - 1) > 0.001 ? ' at ' + fmtRate(rate) : '')];
    var now = opts.now instanceof Date ? opts.now : new Date();
    if (left >= 30) {
      var end = new Date(now.getTime() + left * 1000);
      var clock = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      parts.push('ends ' + clock);
    }
    return {
      live: false,
      chapter: opts.chapter || '',
      text: parts.join(' · '),
      pct: Math.max(0, Math.min(100, ((v.currentTime || 0) / dur) * 100))
    };
  }

  function renderNow(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return false;
    var yd = typeof window !== 'undefined' ? window.UNYtDom : null;
    var v = yd && yd.playerVideo ? yd.playerVideo(doc) : doc.querySelector('video');
    var info = nowText(v, {
      ad: !!(yd && yd.adPlaying && yd.adPlaying(doc)),
      live: !!(yd && yd.playerIsLive && yd.playerIsLive(doc)),
      chapter: yd && yd.playerChapterTitle ? yd.playerChapterTitle(doc) : ''
    });
    var el = deck.querySelector(':scope > .un-deck-now');
    if (!info) {
      if (el) el.hidden = true;
      return false;
    }
    if (!el) {
      el = doc.createElement('div');
      el.className = 'un-deck-now';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'off');
      el.innerHTML = '<span class="un-deck-now-dot" aria-hidden="true"></span>' +
        '<span class="un-deck-now-ch"></span>' +
        '<span class="un-deck-now-nav" hidden>' +
          '<button class="un-deck-now-step is-prev" type="button" aria-label="Previous chapter" title="Previous chapter">◀</button>' +
          '<button class="un-deck-now-step is-next" type="button" aria-label="Next chapter" title="Next chapter">▶</button>' +
        '</span>' +
        '<span class="un-deck-now-t"></span>' +
        '<button class="un-deck-tour-btn" type="button" title="Interactive Feature Tour & Help" aria-label="Feature tour">Tour</button>' +
        '<span class="un-deck-now-bar" aria-hidden="true"><span class="un-deck-now-fill"></span></span>';
      var tourBtn = el.querySelector('.un-deck-tour-btn');
      if (tourBtn) {
        tourBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          try {
            var gt = typeof window !== 'undefined' ? window.UNGuidedTour : null;
            if (gt && typeof gt.startTour === 'function') gt.startTour(true);
          } catch (err) {}
        });
      }
      var prevBtn = el.querySelector('.un-deck-now-step.is-prev');
      var nextBtn = el.querySelector('.un-deck-now-step.is-next');
      if (prevBtn) {
        prevBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          stepChapter(deck, -1);
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          stepChapter(deck, 1);
        });
      }
      deck.insertBefore(el, deck.firstChild);
    }
    syncTourButton(el);
    el.hidden = false;
    el.classList.toggle('is-live', !!info.live);
    el.classList.toggle('is-ad', !!info.ad);
    var ch = el.querySelector('.un-deck-now-ch');
    var t = el.querySelector('.un-deck-now-t');
    var fill = el.querySelector('.un-deck-now-fill');
    // ONE SOURCE FOR "WHICH CHAPTER" (2026-09-24). YouTube's control-bar label
    // lags a seek: captured at 5:00 the Now line said "Noise Cancellation"
    // while the list (from the chapter starts) marked "Battery Life". The
    // list's current row names the chapter when there is a list; YouTube's
    // label is the fallback when there is none.
    var cur = info.ad ? null : markCurrentChapter(deck, v && !info.live ? v.currentTime : null);
    var curName = cur ? ((cur.querySelector('.un-deck-chip-s') || {}).textContent || '') : '';
    var chapter = info.ad ? '' : (curName || info.chapter);
    if (ch.textContent !== chapter) ch.textContent = chapter;
    ch.hidden = !chapter;
    var nav = el.querySelector('.un-deck-now-nav');
    if (nav) {
      var chips = deck.querySelectorAll('.un-deck-pv-list[aria-label="Chapters"] > .un-deck-chip:not(.un-deck-chip-more)');
      if (chips.length > 1 && !info.live && !info.ad) {
        nav.hidden = false;
        var curIdx = -1;
        for (var ci = 0; ci < chips.length; ci++) {
          if (chips[ci] === cur) { curIdx = ci; break; }
        }
        var pBtn = nav.querySelector('.is-prev');
        var nBtn = nav.querySelector('.is-next');
        if (pBtn) pBtn.disabled = curIdx <= 0;
        if (nBtn) nBtn.disabled = curIdx >= chips.length - 1;
      } else {
        nav.hidden = true;
      }
    }
    if (t.textContent !== info.text) t.textContent = info.text;
    if (fill) fill.style.width = info.live ? '100%' : info.pct.toFixed(1) + '%';
    return true;
  }

  function stepChapter(deck, dir) {
    if (!deck) return;
    var chips = deck.querySelectorAll('.un-deck-pv-list[aria-label="Chapters"] > .un-deck-chip:not(.un-deck-chip-more)');
    if (!chips.length) return;
    var cur = deck.querySelector('.un-deck-pv-list[aria-label="Chapters"] > .un-deck-chip.is-current');
    var idx = -1;
    for (var i = 0; i < chips.length; i++) {
      if (chips[i] === cur) { idx = i; break; }
    }
    var targetIdx = idx === -1 ? (dir > 0 ? 0 : chips.length - 1) : idx + dir;
    if (targetIdx >= 0 && targetIdx < chips.length) {
      chips[targetIdx].click();
    }
  }

  /**
   * THE CHAPTER YOU ARE IN, IN THE LIST (2026-09-24). The Now line named it
   * but the chapter list beside it was static: in theater it read "Noise
   * Cancellation" over a list where that row looked like every other. The
   * row whose start is the last one at or before the playhead gets
   * aria-current and a marker; it moves as the video plays. Starts come from
   * the chips' own time labels, so the list and the marker cannot disagree.
   */
  function chipSeconds(label) {
    var parts = String(label || '').trim().split(':').map(Number);
    if (parts.length < 2 || parts.some(function (n) { return isNaN(n); })) return null;
    return parts.reduce(function (acc, n) { return acc * 60 + n; }, 0);
  }
  // Scrolls the chip's own scrolling view (the side guide's .un-deck-desc) so
  // the chip is visible, and nothing else: never the page.
  function scrollChipIntoView(chip) {
    try {
      var view = chip.closest ? chip.closest('.un-deck-desc') : null;
      if (!view || view.scrollHeight <= view.clientHeight + 1) return;
      var vr = view.getBoundingClientRect();
      var cr = chip.getBoundingClientRect();
      var target = null;
      if (cr.top < vr.top) target = view.scrollTop + (cr.top - vr.top) - 8;
      else if (cr.bottom > vr.bottom) target = view.scrollTop + (cr.bottom - vr.bottom) + 8;
      if (target === null) return;
      if (view.scrollTo) view.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      else view.scrollTop = Math.max(0, target);
    } catch (_e) { /* detached node — ignore */ }
  }

  function markCurrentChapter(deck, t) {
    var chips = deck.querySelectorAll('.un-deck-pv-list[aria-label="Chapters"] > .un-deck-chip:not(.un-deck-chip-more)');
    if (!chips.length) return null;
    var current = null;
    if (typeof t === 'number' && isFinite(t)) {
      for (var i = 0; i < chips.length; i++) {
        var lab = chips[i].querySelector('.un-deck-chip-t');
        var dataStart = chips[i].dataset ? Number(chips[i].dataset.start) : NaN;
        var s = isFinite(dataStart) ? dataStart : chipSeconds(lab ? lab.textContent : chips[i].textContent);
        if (s != null && s <= t + 0.25) current = chips[i];
      }
    }
    for (var j = 0; j < chips.length; j++) {
      var on = chips[j] === current;
      var wasOn = chips[j].classList.contains('is-current');
      if (wasOn !== on) chips[j].classList.toggle('is-current', on);
      if (on) chips[j].setAttribute('aria-current', 'true');
      else if (chips[j].hasAttribute('aria-current')) chips[j].removeAttribute('aria-current');
      // SCROLL THE ACTIVE CHAPTER INTO VIEW (2026-09-30). In side mode the
      // chapter list scrolls inside .un-deck-desc; without this the active
      // chapter could be above or below the visible window while the Now bar
      // showed a different name. Only scroll when the chapter changes (wasOn
      // false, on true) to avoid fighting a user who has manually scrolled.
      //
      // Inside the view ONLY (2026-10-02). scrollIntoView scrolls every
      // scrollable ancestor, the page included: a chapter change while you
      // read the comments smooth-scrolled the page back up to the guide
      // (measured 1200 -> 480 px), which also undocked the mini player
      // (scroll-dock-and-queue.spec, 3 of 3 runs).
      if (on && !wasOn) scrollChipIntoView(chips[j]);
      if (on && chips[j].style && chips[j].style.setProperty) {
        var start = chips[j].dataset ? Number(chips[j].dataset.start) : NaN;
        var nextStart = j + 1 < chips.length && chips[j + 1].dataset ? Number(chips[j + 1].dataset.start) : NaN;
        var video = deck.ownerDocument && deck.ownerDocument.querySelector ? deck.ownerDocument.querySelector('#movie_player video') : null;
        var end = isFinite(nextStart) ? nextStart : (video && isFinite(video.duration) ? video.duration : NaN);
        var pct = isFinite(start) && isFinite(end) && end > start ? Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100)) : 0;
        chips[j].style.setProperty('--un-chapter-progress', pct.toFixed(1) + '%');
      } else if (!on && chips[j].style && chips[j].style.removeProperty) {
        chips[j].style.removeProperty('--un-chapter-progress');
      }
    }
    return current;
  }

  /**
   * TRUE WHEN THE DECK IS SIDE-MOUNTED AND NOT COMPACT (2026-09-30).
   *
   * Exposes the layout state to modules that render INTO the deck (desc-digest)
   * so they can adapt without querying the DOM themselves. The canonical answer
   * is the deck's own class list: is-side without is-compact means the desc
   * slot is a scrollable full-height column, not a wrapping chip row.
   */
  function isSide(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck) return false;
    return deck.classList.contains('is-side') && !deck.classList.contains('is-compact');
  }

  /**
   * Keep Now current. Media events do not bubble but DO pass through the
   * capture phase, so one capturing listener on the document follows the
   * player even when YouTube swaps the <video> element. timeupdate fires ~4x
   * a second; the text only changes once a second, and renderNow writes the
   * DOM only when it did.
   */
  var _nowWired = false;
  function wireNow(doc) {
    if (_nowWired || !doc || !doc.addEventListener) return;
    _nowWired = true;
    var last = 0;
    var tick = function (ev) {
      var t = ev && ev.type;
      var nowMs = Date.now();
      if (t === 'timeupdate' && nowMs - last < 900) return;
      last = nowMs;
      renderNow(doc);
    };
    // 'seeking' as well as 'seeked': after a seek the video can buffer for
    // seconds (readyState 1, measured), firing neither timeupdate nor seeked,
    // and the chapter marker sat on the old chapter until data arrived.
    ['timeupdate', 'ratechange', 'durationchange', 'loadedmetadata', 'play', 'pause', 'seeking', 'seeked', 'emptied'].forEach(function (type) {
      doc.addEventListener(type, tick, true);
    });
  }

  /**
   * The guide used to exist only when a module asked for a slot, so a profile
   * with every watch-page module off had no guide at all, and nowhere to find
   * the features. On a watch page it now builds itself: Now and More tools
   * need no module.
   */
  /**
   * RE-DECIDE THE POSITION WHEN THE LAYOUT CHANGES (2026-09-24).
   *
   * User report: "why is it under the player again?" Reproduced: homepage, click a
   * video. The guide was built while the watch layout was still hidden, so
   * the side column measured too narrow, it took the under-player fallback,
   * and nothing asked again: it stayed in #above-the-fold with the related
   * column 696px wide beside it. The position is now re-decided when the
   * side column or the window changes size, and a few times after each
   * navigation. ensureDeck() only moves the guide when its mount differs, so
   * a steady layout costs a few rect reads.
   */
  function replace() {
    if (typeof document === 'undefined') return;
    var deck = document.getElementById(DECK_ID);
    if (!deck) return;
    ensureDeck(document);
    syncEmpty(document);
    // Placement decides whether the description can fold, so re-apply the
    // collapse state whenever the guide may have moved.
    syncCollapse(document);
    fitView(document);
  }

  /**
   * END THE GUIDE AT THE PLAYER'S BOTTOM EDGE (2026-09-24).
   *
   * With every link listed, the view area (chapters, summary, links) ran to
   * 1051px on a sponsor-heavy video and the guide to 893px, against the 700px
   * budget that keeps it level with the player (runtime-strip-ad-guard.spec:
   * at rest 633px, bottom 701 vs the player's 722). The view area gets exactly
   * the room between its top and the player's bottom edge and scrolls inside;
   * nothing is hidden, and the guide never outgrows the video beside it.
   * Floor of 240px so a short player still shows a useful slice.
   */
  function fitView(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    var deck = doc && doc.getElementById ? doc.getElementById(DECK_ID) : null;
    if (!deck || !deck.getBoundingClientRect) return;
    // First, and whatever the view is doing: with a door open the view is
    // hidden (no rect), and the early returns below would skip the panel.
    if (deck.classList.contains('is-side') && !deck.classList.contains('is-compact')) fitOpenPanel(doc, deck);
    var view = deck.querySelector(':scope > .un-deck-desc');
    if (!view) return;
    if (!deck.classList.contains('is-side') || deck.classList.contains('is-compact')) {
      if (view.style.maxHeight) view.style.maxHeight = '';
      return;
    }
    var player = doc.querySelector('#movie_player');
    if (!player || !player.getBoundingClientRect) return;
    var pb = player.getBoundingClientRect().bottom;
    var vt = view.getBoundingClientRect().top;
    if (!(pb > 0) || !(vt > 0)) return;
    // 240, not 360 (2026-10-02): a 360 px floor, raised without a recorded
    // reason in 1.2.13, pushed the guide 47-80 px below the player whenever the
    // runtime strip carries segments (734 px at 1680x1050 against a 700 px
    // budget, runtime-strip-ad-guard.spec). The chapter list can fold now.
    var avail = Math.max(240, Math.floor(pb - vt - 12));
    var next = avail + 'px';
    if (view.style.maxHeight !== next) view.style.maxHeight = next;
    watchViewScroll(view);
  }

  /**
   * AN OPEN DOOR STAYS ON SCREEN (2026-09-24). Measured at 1600x1000 with
   * Stats open: the guide's bottom at 1108 in a 1000px window, so the end of
   * the panel sat below the fold and needed a PAGE scroll on top of the
   * panel's own. The open panel now ends inside the window (its own scroll
   * does the rest), never shorter than 280px, never taller than the 680px
   * the stylesheet already allowed.
   */
  function fitOpenPanel(doc, deck) {
    var panel = deck.querySelector(':scope > #un-side-panel.is-open');
    if (!panel || !panel.getBoundingClientRect) return;
    var win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!win || !win.innerHeight) return;
    var top = panel.getBoundingClientRect().top + (win.scrollY || 0);
    var avail = Math.floor(win.innerHeight - top - 16);
    var h = Math.max(280, Math.min(680, avail));
    var next = h + 'px';
    if (panel.style.maxHeight !== next) panel.style.maxHeight = next;
  }

  /**
   * SAY THAT THERE IS MORE (2026-09-24). The view scrolls inside itself, and
   * the only cue was a thin scrollbar: the chapters were simply cut through a
   * row at the bottom edge. The bottom fades while there is more below, and
   * stops fading at the end, so the cut reads as "continues" and the end reads
   * as the end.
   */
  function syncViewFade(view) {
    var more = view.scrollHeight - view.clientHeight - view.scrollTop > 4;
    if (view.classList.contains('has-more-below') !== more) view.classList.toggle('has-more-below', more);
  }
  function watchViewScroll(view) {
    if (!view.__unFadeWired) {
      view.__unFadeWired = true;
      view.addEventListener('scroll', function () { syncViewFade(view); }, { passive: true });
    }
    syncViewFade(view);
  }
  var _placementWired = false;
  var _observedCol = null;
  function watchPlacement() {
    if (_placementWired || typeof window === 'undefined') return;
    _placementWired = true;
    var t = null;
    var soon = function () { if (t) clearTimeout(t); t = setTimeout(replace, 150); };
    window.addEventListener('resize', soon);
    if (typeof ResizeObserver === 'undefined') return;
    var ro = new ResizeObserver(soon);
    var attach = function () {
      var yd = window.UNYtDom;
      var col = yd && yd.WATCH_SIDE_OUTER_SEL ? document.querySelector(yd.WATCH_SIDE_OUTER_SEL) : null;
      if (col && col !== _observedCol) {
        if (_observedCol) ro.unobserve(_observedCol);
        ro.observe(col);
        _observedCol = col;
      }
    };
    attach();
    document.addEventListener('yt-navigate-finish', function () { setTimeout(attach, 300); });
  }

  var _autoStarted = false;
  var _autoWaits = 0;
  function autoStart() {
    if (_autoStarted || typeof window === 'undefined' || typeof document === 'undefined' || !document.addEventListener) return;
    // This file is bundled BEFORE core.js (content-core order: watch-deck at
    // 14, core at 43), so UNSYNTH does not exist yet when it first runs. The
    // first version returned here for good, and a profile with every
    // watch-page module off got no guide at all (e2e guide-more-tools, "every
    // watch-page module off"). Wait for the core instead.
    if (!window.UNSYNTH) {
      if (_autoWaits++ < 100 && typeof setTimeout !== 'undefined') setTimeout(autoStart, 100);
      return;
    }
    _autoStarted = true;
    var tries = 0;
    var timer = null;
    var attempt = function () {
      timer = null;
      var yd = window.UNYtDom;
      var onWatch = yd && yd.isWatchLayout ? yd.isWatchLayout(location.pathname) : location.pathname === '/watch';
      if (!onWatch) return;
      if (!suiteSettings()) { if (tries++ < 60) timer = setTimeout(attempt, 500); return; }
      var deck = ensureDeck(document);
      if (!deck) { if (tries++ < 60) timer = setTimeout(attempt, 500); return; }
      syncCollapse(document);
      syncEmpty(document);
      // Check the position again once YouTube has finished laying out.
      [800, 2000, 4500].forEach(function (ms) { setTimeout(replace, ms); });
    };
    var kick = function () {
      tries = 0;
      if (timer) clearTimeout(timer);
      timer = setTimeout(attempt, 300);
    };
    document.addEventListener('yt-navigate-finish', kick);
    // Fires on the click, before the URL or the player change: the earliest
    // moment the guide's content stops describing the video on screen.
    // A navigation to the video already playing (a ?t= link, a playlist
    // re-click) never refreshes the guide, so it would sit on the loading line
    // for the whole SWITCH_MS. Skip it when the target is known, and end it at
    // navigate-finish when the video turned out not to change.
    var curVid = urlVid;
    var switchFromVid = null;
    document.addEventListener('yt-navigate-start', function (e) {
      var d = e && e.detail;
      var target = d && d.endpoint && d.endpoint.watchEndpoint ? d.endpoint.watchEndpoint.videoId : '';
      var from = curVid();
      if (target && from && target === from) return;
      switchFromVid = from;
      beginSwitch(document);
    });
    // Without the description module nothing calls contentReady(), so the
    // switch would sit on its 2.5 s cap and keep the new video's stats hidden
    // (found 2026-10-01 in review of this code). Then the new page itself is
    // the signal: YouTube has finished navigating, and every module has
    // already dropped the previous video's values in its onNavigate.
    document.addEventListener('yt-navigate-finish', function () {
      var same = switchFromVid !== null && curVid() === switchFromVid;
      switchFromVid = null;
      if (same || !descDigestOn()) setTimeout(function () { endSwitch(document); }, same ? 0 : 300);
    });
    watchPlacement();
    try {
      if (chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'sync') return;
          if (changes.watchGuide) {
            // core reloads settings on the same event; move after it has.
            setTimeout(replace, 250);
            setTimeout(replace, 1200);
            // A paused video fires no media events, so Now would not re-render
            // on its own to show or hide the Tour button.
            setTimeout(function () { renderNow(document); }, 250);
            setTimeout(function () { renderNow(document); }, 1200);
          }
          if (!changes.modules) return;
          // A feature switched OFF starts over as a plain "Turn on" row. The
          // renderMore cleanup only ran if a render happened while it was on,
          // and when a fast load let "off" arrive first the row came back stuck
          // on a disabled "Turning on..." (guide-more-tools e2e, 2026-10-01).
          var nextMods = changes.modules.newValue || {};
          Object.keys(_enabling).forEach(function (k) {
            if (nextMods[k] === false) { delete _enabling[k]; delete _moreErr[k]; }
          });
          // core reloads settings on the same event; render after it has.
          setTimeout(function () { syncEmpty(document); }, 250);
          setTimeout(function () { syncEmpty(document); }, 1200);
        });
      }
    } catch (e) { /* no extension context */ }
    wireNow(document);
    kick();
  }

  var api = {
    DECK_ID: DECK_ID,
    SLOTS: SLOTS,
    findMount: findMount,
    ensureDeck: ensureDeck,
    slot: slot,
    syncEmpty: syncEmpty,
    syncCollapse: syncCollapse,
    setSummary: setSummary,
    setPreview: setPreview,
    contentReady: contentReady,
    setAction: setAction,
    setLauncher: setLauncher,
    toggleSlot: toggleSlot,
    DEFAULT_COLLAPSED: DEFAULT_COLLAPSED,
    SLOT_TITLES: SLOT_TITLES,
    FEATURES: FEATURES,
    offFeatures: offFeatures,
    renderMore: renderMore,
    nowText: nowText,
    renderNow: renderNow,
    placementPref: placementPref,
    fitView: fitView,
    isSide: isSide,
    remove: remove
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNWatchDeck = api;
  autoStart();
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
