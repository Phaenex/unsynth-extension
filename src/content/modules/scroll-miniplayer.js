/**
 * Scroll-triggered miniplayer — scroll the player just out of view (e.g.
 * reading comments) and the REAL #movie_player visually docks into a small
 * fixed box via CSS only, still on the same /watch page. Native YouTube has
 * no equivalent: scrolling on /watch does nothing to the player natively.
 * Draggable and resizable; both are remembered (chrome.storage.local) across
 * dock cycles and page loads. Defaults to the bottom-LEFT — see
 * defaultDockPos() for why that specific corner.
 *
 * The dock persists for as long as the user keeps scrolling. There was once a
 * second stage that handed off to YouTube's own native miniplayer past a
 * scroll threshold; it navigated away from the watch page, which made long
 * comment threads destroy the page being read. Removed — see the note where
 * it used to live, above handleScroll().
 *
 * Never active on Shorts — scrolling IS Shorts' navigation gesture.
 *
 * Stage 1 docking is CSS-only (a class toggled on #movie_player itself) —
 * #movie_player is NEVER reparented in the DOM. An earlier version reparented
 * the real player into a separate `#un-mini-dock` wrapper, which caused a
 * cascade of confirmed-live failures documented in docs/LESSONS.md:
 *   - inserting a sentinel/sibling near the player broke YouTube's own
 *     player-construction bootstrap depending on insertion order;
 *   - once docked, the sentinel used to mark the restore position could be
 *     silently destroyed by YouTube's own re-rendering of that DOM region at
 *     any time, with no way to detect or prevent it from outside;
 *   - critically, navigating away (e.g. clicking a related video) while the
 *     player was still physically reparented into the dock reliably broke
 *     YouTube's own SPA transition — the new page's player was never
 *     constructed at all, confirmed reproducibly, regardless of how early
 *     the extension tried to undock beforehand.
 * CSS-only docking sidesteps all three: the player is always exactly where
 * YouTube itself put it, so its own SPA/bootstrap logic never has to guess.
 *
 * BOTH the dock (enter) and undock (exit) transitions are driven by plain
 * getBoundingClientRect()/scroll-position checks inside the scroll handler
 * — there is NO IntersectionObserver anywhere in this module. That wasn't
 * the original design: an IntersectionObserver was tried for the enter
 * trigger, and a second one (with a negative rootMargin) for the exit
 * trigger. Both were confirmed live, independently, to report stale or
 * simply wrong `isIntersecting` values in the frame immediately following
 * this module's own large, abrupt layout shifts (docking/undocking) —
 * reproducibly causing an instant, unwanted re-dock right after a correct
 * undock (confirmed via a MutationObserver transition log: undock at
 * scrollY=X immediately followed, within single-digit milliseconds, by a
 * re-dock at the SAME scrollY, on every scroll step). Direct
 * getBoundingClientRect() reads inside the already-reliable, scroll-driven,
 * rAF-throttled handler were confirmed to report correct, sane numbers
 * across the same transitions every time. Two independent
 * IntersectionObserver failures in the same file is a pattern, not a fluke
 * — don't reach for one here again without re-verifying very carefully.
 */
(function () {
  'use strict';

  var core = null;
  var docked = false; // dock state (our own overlay)
  var dockScrollY = 0; // window.scrollY at the moment the dock engaged
  var dockPlayerDocBottom = 0; // player's document-relative bottom edge at the moment Stage 1 engaged
  var onScroll = null;
  var scrollTicking = false;
  var dockBar = null;
  var onPlayerEnter = null;
  var onPlayerLeave = null;
  var onWindowResize = null;

  var EXIT_BUFFER_PX = 160; // hysteresis before undocking back to normal on scroll-up

  // ---- draggable position + resizable size — user-moveable/-sizable,
  // remembered across dock cycles and page loads (chrome.storage.local,
  // same pattern ai-assistant.js already uses for aiPanelWidth). ----
  var DOCK_W = 320;
  var DOCK_H = 180;
  var DOCK_ASPECT = DOCK_H / DOCK_W; // locked 16:9 — resizing drags width, height follows
  var DOCK_MIN_W = 200;
  var DOCK_MAX_W = 960;
  var DOCK_MARGIN = 16;
  var DOCK_BOTTOM_GAP = 24; // breathing room above the bottom edge
  var dockPos = null; // {top, left} in viewport px, or null = default bottom-right corner
  var dockSize = { w: DOCK_W, h: DOCK_H };
  // True once the user has resized the box themselves (or a saved size was
  // restored). Their explicit choice must never be overwritten by the default.
  var sizeUserSet = false;

  function maxDockW() {
    return Math.max(DOCK_MIN_W, Math.min(DOCK_MAX_W, window.innerWidth - DOCK_MARGIN * 2));
  }

  function clampDockPos(top, left) {
    var maxLeft = Math.max(0, window.innerWidth - dockSize.w);
    var maxTop = Math.max(0, window.innerHeight - dockSize.h);
    return {
      top: Math.min(Math.max(0, top), maxTop),
      left: Math.min(Math.max(0, left), maxLeft)
    };
  }

  // A saved position is only meaningful on the screen it was saved on.
  //
  // clampDockPos() only pulls a point back INSIDE the viewport, so a position
  // saved on a laptop stays exactly where it was on a large monitor — which is
  // no longer the corner the user left it in, it is the middle of the page.
  // Reported as the dock "floating in the MIDDLE of the comments with comment
  // text bleeding through it", and reproduced exactly: {top:458,left:392} saved
  // at 1280x720 restores to 392,458 on a 2185x1017 viewport, parked over the
  // comment column. (The value lives in chrome.storage.local under
  // unMiniDockPos_v2 — checking localStorage, or the legacy unMiniDockPos key,
  // shows nothing while a stale position is still in force, which is why this
  // first read as a default-placement bug rather than restored state.)
  //
  // The test is the VIEWPORT the position was saved at, not where the point
  // happens to sit now. An edge-proximity heuristic was tried first and was
  // wrong: dragging the dock up from the corner to read something underneath is
  // a normal action that leaves it mid-screen, and that heuristic threw the
  // drag away on the next dock (caught by the existing drag/resize e2e test —
  // it moved to y=336 and was snapped back to 516). Comparing viewports instead
  // keeps every deliberate placement made on the current screen and discards
  // only the ones stranded by a resolution change.
  //
  // Positions saved before this field existed have no viewport recorded. Those
  // are re-anchored once, since there is no way to tell what screen they came
  // from and the reported bug is exactly such a value.
  function isStalePos(pos) {
    if (!pos) return false;
    var vw = pos.vw, vh = pos.vh;
    if (typeof vw !== "number" || typeof vh !== "number") return true;
    // A small change (a devtools pane, a zoom step) should not discard the
    // choice; a different monitor should.
    return Math.abs(vw - window.innerWidth) > 120 || Math.abs(vh - window.innerHeight) > 120;
  }

  // The default dock size is just DOCK_W × DOCK_H (320×180), capped to the
  // viewport. No gap-measurement magic — a compact, out-of-the-way default
  // that never covers comments or suggestions. The user can resize via the
  // handle, and that choice is saved.
  function applyDefaultSize() {
    if (sizeUserSet) return;
    var w = Math.min(DOCK_W, maxDockW());
    var maxH = window.innerHeight - DOCK_BOTTOM_GAP - DOCK_MARGIN;
    if (Math.round(w * DOCK_ASPECT) > maxH) w = Math.floor(maxH / DOCK_ASPECT);
    if (w < DOCK_MIN_W) w = DOCK_MIN_W;
    dockSize = { w: w, h: Math.round(w * DOCK_ASPECT) };
  }

  // Bottom-right corner of the viewport, offset by the margin. Dead simple,
  // no gap calculations — the player sits in the absolute corner.
  function defaultDockPos() {
    var top = window.innerHeight - DOCK_BOTTOM_GAP - dockSize.h;
    var left = window.innerWidth - DOCK_MARGIN - dockSize.w;
    return clampDockPos(top, left);
  }

  // Applies the current position AND size to the player/bar/resize handle
  // via inline !important styles — an inline !important rule correctly
  // beats an author-stylesheet !important rule per the CSS cascade, so this
  // always wins over scroll-miniplayer.css's defaults once called.
  function applyDockPosition(player, bar, handle) {
    var pos = dockPos ? clampDockPos(dockPos.top, dockPos.left) : defaultDockPos();
    [player, bar].forEach(function (el) {
      if (!el) return;
      el.style.setProperty('top', pos.top + 'px', 'important');
      el.style.setProperty('left', pos.left + 'px', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('right', 'auto', 'important');
    });
    if (player) {
      ['width', 'max-width'].forEach(function (prop) {
        player.style.setProperty(prop, dockSize.w + 'px', 'important');
      });
      ['height', 'max-height'].forEach(function (prop) {
        player.style.setProperty(prop, dockSize.h + 'px', 'important');
      });
    }
    if (bar) bar.style.setProperty('width', dockSize.w + 'px', 'important');
    if (handle) {
      handle.style.setProperty('top', pos.top + dockSize.h - 14 + 'px', 'important');
      handle.style.setProperty('left', pos.left + dockSize.w - 14 + 'px', 'important');
    }
    try {
      window.dispatchEvent(new CustomEvent('un-mini-dock-change', { detail: { docked: true } }));
    } catch (err) {
      /* ignore — queue-advance listens for this; missing CustomEvent in tests is fine */
    }
  }

  function loadSavedPosition() {
    try {
      chrome.storage.local.get(['unMiniDockPos_v2', 'unMiniDockSize_v2'], function (d) {
        if (d && d.unMiniDockPos_v2 && typeof d.unMiniDockPos_v2.top === 'number' && typeof d.unMiniDockPos_v2.left === 'number') {
          // Only a RESTORED position can be stale, and only here — dockPos is
          // reassigned from clampDockPos() on every drag/resize frame, and that
          // returns a bare {top,left} with no viewport stamp, so re-testing it
          // later would discard the user's own drag the moment they made it.
          dockPos = isStalePos(d.unMiniDockPos_v2) ? null : d.unMiniDockPos_v2;
        }
        if (d && d.unMiniDockSize_v2 && typeof d.unMiniDockSize_v2.w === 'number') {
          var w = Math.min(Math.max(DOCK_MIN_W, d.unMiniDockSize_v2.w), maxDockW());
          dockSize = { w: w, h: Math.round(w * DOCK_ASPECT) };
          sizeUserSet = true; // a real saved choice — don't override it
        }
      });
      // Purge ALL legacy keys that may have stored stale coordinates/sizes
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(['unMiniDockPos', 'unMiniDockSize']);
      }
    } catch (e) {
      /* ignore — falls back to the default corner/size */
    }
  }

  function savePosition(pos) {
    try {
      // Record the viewport alongside the coordinates. Without it there is no
      // way to tell a deliberate placement from one stranded by a screen change
      // on the next load — see isStalePos().
      chrome.storage.local.set({
        unMiniDockPos_v2: {
          top: pos.top,
          left: pos.left,
          vw: window.innerWidth,
          vh: window.innerHeight
        }
      });
    } catch (e) {
      /* ignore — position just won't persist across page loads */
    }
  }

  function saveSize(size) {
    try {
      chrome.storage.local.set({ unMiniDockSize_v2: size });
    } catch (e) {
      /* ignore — size just won't persist across page loads */
    }
  }

  var dragMove = null;
  var dragUp = null;

  function startDrag(e, player, bar, handle) {
    // Only the bar's own background starts a drag — a click that landed on
    // one of its buttons (expand/close) must not also start dragging.
    if (e.target !== bar || e.button !== 0) return;
    e.preventDefault();
    var startX = e.clientX;
    var startY = e.clientY;
    var rect = player.getBoundingClientRect();
    var startTop = rect.top;
    var startLeft = rect.left;
    try {
      bar.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore — not fatal, drag still tracks via document-level listeners below */
    }
    bar.classList.add('un-mini-dock-bar--dragging');
    dragMove = function (ev) {
      var dx = ev.clientX - startX;
      var dy = ev.clientY - startY;
      dockPos = clampDockPos(startTop + dy, startLeft + dx);
      applyDockPosition(player, bar, handle);
    };
    dragUp = function () {
      bar.classList.remove('un-mini-dock-bar--dragging');
      document.removeEventListener('pointermove', dragMove);
      document.removeEventListener('pointerup', dragUp);
      dragMove = null;
      dragUp = null;
      if (dockPos) savePosition(dockPos);
    };
    document.addEventListener('pointermove', dragMove);
    document.addEventListener('pointerup', dragUp);
  }

  var resizeMove = null;
  var resizeUp = null;

  function startResize(e, player, bar, handle) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    var startX = e.clientX;
    var startW = dockSize.w;
    var startPos = dockPos ? clampDockPos(dockPos.top, dockPos.left) : defaultDockPos();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore — not fatal, resize still tracks via document-level listeners below */
    }
    handle.classList.add('un-mini-resize-handle--dragging');
    sizeUserSet = true; // explicit resize — the gap-fitting default steps aside
    resizeMove = function (ev) {
      var dw = ev.clientX - startX;
      var w = Math.min(Math.max(DOCK_MIN_W, startW + dw), maxDockW());
      dockSize = { w: w, h: Math.round(w * DOCK_ASPECT) };
      // Growing can push the box past the right/bottom edge since position
      // is stored as a fixed top/left, not anchored to an edge — reclamp
      // against the new size every move, not just on release.
      dockPos = clampDockPos(startPos.top, startPos.left);
      applyDockPosition(player, bar, handle);
    };
    resizeUp = function () {
      handle.classList.remove('un-mini-resize-handle--dragging');
      document.removeEventListener('pointermove', resizeMove);
      document.removeEventListener('pointerup', resizeUp);
      resizeMove = null;
      resizeUp = null;
      saveSize(dockSize);
      if (dockPos) savePosition(dockPos);
    };
    document.addEventListener('pointermove', resizeMove);
    document.addEventListener('pointerup', resizeUp);
  }

  function prefs() {
    var d = (core && core.settings && core.settings.scrollMiniplayer) || {};
    return {
      enabled: d.enabled !== false,
      showPlayerButton: d.showPlayerButton !== false
    };
  }

  function isShorts() {
    return location.pathname.indexOf('/shorts/') === 0;
  }
  function isWatch() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }

  function findPlayer() {
    return document.getElementById('movie_player');
  }
  // One line-icon set (core.css .un-ico), shared by every bar button that draws one.
  function unIco(name) { var s = document.createElement('span'); s.className = 'un-ico'; s.setAttribute('data-ico', name); s.setAttribute('aria-hidden', 'true'); return s; }
  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video')
    );
  }

  // ---- Stage 1: dock via CSS only — #movie_player never leaves its real DOM spot ----

  var barMediaVideo = null;
  var onBarPlay = null;
  var onBarPause = null;
  var onBarVolume = null;

  function unbindBarMedia() {
    if (!barMediaVideo) return;
    try {
      if (onBarPlay) barMediaVideo.removeEventListener('play', onBarPlay);
      if (onBarPause) barMediaVideo.removeEventListener('pause', onBarPause);
      if (onBarVolume) barMediaVideo.removeEventListener('volumechange', onBarVolume);
    } catch (e) {}
    barMediaVideo = null;
    onBarPlay = null;
    onBarPause = null;
    onBarVolume = null;
  }

  function syncBarButtons() {
    if (!dockBar) return;
    var vid = findVideo();
    var playBtn = dockBar.querySelector ? dockBar.querySelector('.un-mini-bar-play') : null;
    var muteBtn = dockBar.querySelector ? dockBar.querySelector('.un-mini-bar-mute') : null;
    if (playBtn) {
      var paused = !vid || vid.paused;
      playBtn.textContent = paused ? '▶' : '❚❚';
      playBtn.title = paused ? 'Play' : 'Pause';
      playBtn.setAttribute('aria-label', playBtn.title);
    }
    if (muteBtn) {
      var muted = !!(vid && vid.muted);
      muteBtn.textContent = '';
      muteBtn.appendChild(unIco(muted ? 'vol-mute' : 'vol-high'));
      muteBtn.title = muted ? 'Unmute' : 'Mute';
      muteBtn.setAttribute('aria-label', muteBtn.title);
    }
  }

  function bindBarMedia() {
    unbindBarMedia();
    var vid = findVideo();
    if (!vid || typeof vid.addEventListener !== 'function') {
      syncBarButtons();
      return;
    }
    barMediaVideo = vid;
    onBarPlay = function () { syncBarButtons(); };
    onBarPause = function () { syncBarButtons(); };
    onBarVolume = function () { syncBarButtons(); };
    vid.addEventListener('play', onBarPlay);
    vid.addEventListener('pause', onBarPause);
    vid.addEventListener('volumechange', onBarVolume);
    syncBarButtons();
  }

  function ensureDockBar(player) {
    if (dockBar && dockBar.isConnected) {
      bindBarMedia();
      return dockBar;
    }
    dockBar = document.createElement('div');
    dockBar.className = 'un-mini-dock-bar';
    dockBar.title = 'Drag to move (Double-click to reset)';

    var playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'un-mini-bar-btn un-mini-bar-play';
    playBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var vid = findVideo();
      if (!vid) return;
      if (vid.paused) vid.play();
      else vid.pause();
    });

    var muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'un-mini-bar-btn un-mini-bar-mute';
    muteBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var vid = findVideo();
      if (!vid) return;
      vid.muted = !vid.muted;
      if (typeof vid.dispatchEvent === 'function') {
        try { vid.dispatchEvent(new Event('volumechange')); } catch (err) {}
      }
    });

    var expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'un-mini-bar-btn';
    expand.title = 'Back to full view';
    expand.setAttribute('aria-label', 'Back to full view');
    expand.textContent = '⤢';
    expand.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'un-mini-bar-btn';
    close.title = 'Close mini player';
    close.setAttribute('aria-label', 'Close mini player');
    close.textContent = '✕';
    close.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.scrollTo({ top: 0, behavior: 'auto' });
      tryUndock();
    });

    dockBar.appendChild(playBtn);
    dockBar.appendChild(muteBtn);
    dockBar.appendChild(expand);
    dockBar.appendChild(close);
    dockBar.addEventListener('pointerdown', function (e) {
      startDrag(e, player, dockBar, resizeHandle);
    });
    dockBar.addEventListener('dblclick', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dockPos = null;
      sizeUserSet = false;
      dockSize = { w: DOCK_W, h: DOCK_H };
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.remove(['unMiniDockPos', 'unMiniDockPos_v2', 'unMiniDockSize', 'unMiniDockSize_v2']);
        }
      } catch (err) {}
      applyDockPosition(player, dockBar, resizeHandle);
    });
    document.body.appendChild(dockBar);
    bindBarMedia();
    return dockBar;
  }

  function removeDockBar() {
    unbindBarMedia();
    if (dockBar) {
      dockBar.remove();
      dockBar = null;
    }
  }

  var resizeHandle = null;

  function ensureResizeHandle(player, bar) {
    if (resizeHandle && resizeHandle.isConnected) return resizeHandle;
    resizeHandle = document.createElement('div');
    resizeHandle.className = 'un-mini-resize-handle';
    resizeHandle.title = 'Drag to resize';
    resizeHandle.addEventListener('pointerdown', function (e) {
      startResize(e, player, bar, resizeHandle);
    });
    document.body.appendChild(resizeHandle);
    return resizeHandle;
  }

  function removeResizeHandle() {
    if (resizeHandle) {
      resizeHandle.remove();
      resizeHandle = null;
    }
  }

  var layoutSpacer = null; // holds the player's vacated flow space while docked

  // Does taking the player out of flow actually collapse the page, or does
  // YouTube already reserve that slot by itself?
  //
  // Measured, not assumed, and measured EVERY dock rather than once — a
  // spacer that isn't needed is not harmless, it is the flicker bug (see
  // ensureLayoutSpacer below). Sets `display:none` on the player for the
  // duration of one synchronous layout read and puts it straight back, so
  // nothing is ever painted in that state: style write, forced reflow via
  // scrollHeight, style restore, all inside a single task.
  //
  // Measured live at 1440x900 on both layouts, hiding #movie_player changed
  // document.scrollHeight by exactly 0:
  //   default layout : 4090 -> 4090   (#player-container-inner padding-top: 741.938px)
  //   theater layout : 5699 -> 5699   (#player-container-inner padding-top: 75%)
  // #player-container is absolutely positioned, so the player's subtree
  // contributes no height to that wrapper at all; the padding-ratio box is
  // what holds the slot open, and it keeps holding it while docked.
  function measureFlowContribution(player) {
    // A probe that cannot run is not evidence the slot is reserved. Report the
    // player's own height so the caller keeps the spacer — the pre-existing,
    // conservative behaviour — rather than silently returning 0 and dropping a
    // spacer some layout may genuinely need. This is the path a stub element in
    // the unit tests takes, and would also be the path if a future DOM lacked
    // the style API this reads.
    if (!player || !player.style || typeof player.style.getPropertyValue !== 'function' ||
        typeof player.style.getPropertyPriority !== 'function' ||
        typeof document === 'undefined' || !document.documentElement) {
      return typeof player.getBoundingClientRect === 'function'
        ? player.getBoundingClientRect().height
        : 0;
    }
    var doc = document.documentElement;
    var before = doc.scrollHeight;
    var hadInline = player.style.getPropertyValue('display');
    var hadPriority = player.style.getPropertyPriority('display');
    player.style.setProperty('display', 'none', 'important');
    var collapsed = doc.scrollHeight; // reading scrollHeight forces the reflow
    if (hadInline) player.style.setProperty('display', hadInline, hadPriority);
    else player.style.removeProperty('display');
    void doc.scrollHeight; // flush the restore before anything can paint
    return before - collapsed;
  }

  // Insert a spacer ONLY if the player's slot really does collapse without it.
  //
  // The spacer exists because position:fixed contributes no height, and an
  // earlier build reflowed the two-column layout underneath the dock (the
  // sidebar visibly overlapping it — see docs/LESSONS.md). That reasoning is
  // sound in general and stays. What was wrong was applying it unconditionally.
  //
  // On YouTube's current layouts the slot does NOT collapse, so the spacer was
  // not backfilling vacated space — it was adding a SECOND copy of it.
  // Measured docked at 1440x900: #player-container-inner 1484px and
  // #primary-inner 2570px with the spacer, versus 742px and 1828px with the
  // spacer hidden, which are exactly the undocked values. That phantom ~742px
  // appeared the instant the dock engaged, pushing page content down far enough
  // that the player's own slot came back into view, which satisfied the undock
  // check on the next frame, which shrank the page again and put the slot back
  // out of view — dock, undock, dock, on nearly every scroll step. Logged with
  // a MutationObserver on the player's class list: 15 transitions between
  // y=840 and y=2000 while scrolling steadily DOWN in 40px steps, never once
  // scrolling back up. That is the reported "glitching".
  //
  // So the spacer is now conditional on a real measurement, taken fresh at each
  // dock. If a future YouTube layout does size the wrapper from the player
  // itself, the measurement reports it and the spacer comes back automatically.
  function ensureLayoutSpacer(player) {
    if (layoutSpacer && layoutSpacer.isConnected) return layoutSpacer;
    var rect = player.getBoundingClientRect();
    // Below a few px the "collapse" is rounding, not a real reserved slot.
    if (measureFlowContribution(player) < 4) return null;
    layoutSpacer = document.createElement('div');
    layoutSpacer.className = 'un-mini-layout-spacer';
    layoutSpacer.style.height = rect.height + 'px';
    // Insert AFTER the player, matching the confirmed-safe insertion order
    // for anything placed near a YouTube-managed element (see the sentinel
    // insertion-order lesson in docs/LESSONS.md) — the player's own DOM
    // position is untouched either way (CSS-only docking), but this keeps
    // the same safe convention.
    if (player.parentElement) player.parentElement.insertBefore(layoutSpacer, player.nextSibling);
    return layoutSpacer;
  }

  function removeLayoutSpacer() {
    if (layoutSpacer) {
      layoutSpacer.remove();
      layoutSpacer = null;
    }
  }

  function tryDock() {
    if (docked || !prefs().enabled || isShorts() || document.fullscreenElement) return;
    var player = findPlayer();
    var video = findVideo();
    if (!player || !video || video.paused || video.ended) return;
    // Measure and, if the slot really does collapse, hold it open — BEFORE
    // adding the fixed-position class, since the measurement has to see the
    // player still in flow. On YouTube's current layouts nothing collapses and
    // no spacer is created; inserting one anyway is what caused the dock to
    // flicker on every scroll step. See ensureLayoutSpacer().
    ensureLayoutSpacer(player);
    // Cache the player's real document-relative bottom edge BEFORE it goes
    // position:fixed — see handleScroll()'s exit check for why this is kept
    // as a fallback independent of the (mutable, occasionally reclaimed by
    // YouTube's own re-render) layoutSpacer element.
    var preDockRect = player.getBoundingClientRect();
    dockScrollY = window.scrollY;
    dockPlayerDocBottom = preDockRect.bottom + dockScrollY;
    player.classList.add('un-mini-docked-player');
    var bar = ensureDockBar(player);
    var handle = ensureResizeHandle(player, bar);
    // Fit the never-yet-sized default to the gap beside the comment text.
    // Measured here (at dock time) rather than at init: the comment thread
    // isn't laid out until the user has scrolled toward it, which is exactly
    // when docking happens.
    applyDefaultSize();
    applyDockPosition(player, bar, handle);
    onPlayerEnter = function () {
      bar.classList.add('un-mini-dock-bar--visible');
      handle.classList.add('un-mini-resize-handle--visible');
    };
    onPlayerLeave = function () {
      bar.classList.remove('un-mini-dock-bar--visible');
      handle.classList.remove('un-mini-resize-handle--visible');
    };
    player.addEventListener('mouseenter', onPlayerEnter);
    player.addEventListener('mouseleave', onPlayerLeave);
    // The bar/handle visually sit ON TOP of the player's edges (higher
    // z-index), so moving the mouse from the player's body up into them
    // fires the player's mouseleave right as the user tries to grab one —
    // confirmed live, this raced pointer-events back to none before a drag
    // could ever start. Listening on both too keeps them visible through
    // that transition (leave-then-immediately-re-enter, both synchronous,
    // well before any subsequent drag/resize event).
    bar.addEventListener('mouseenter', onPlayerEnter);
    bar.addEventListener('mouseleave', onPlayerLeave);
    handle.addEventListener('mouseenter', onPlayerEnter);
    handle.addEventListener('mouseleave', onPlayerLeave);
    docked = true;
    document.documentElement.classList.add('un-mini-docked');
    try {
      window.dispatchEvent(new CustomEvent('un-mini-dock-change', { detail: { docked: true } }));
    } catch (e) {}
  }

  // Put the <video> back to the size of its container after undocking.
  //
  // Mechanism, measured live rather than inferred. While docked,
  // scroll-miniplayer.css forces .html5-video-container and
  // video.html5-main-video to 100%, so the frame scales into the small box
  // while YouTube's own INLINE pixel sizes on the <video> sit underneath,
  // untouched. Removing the class normally uncovers those original values and
  // everything is fine — a plain dock/undock round trip restores 1431x805
  // exactly.
  //
  // It breaks when YouTube recomputes its layout WHILE docked (a window
  // resize, a theater toggle, an SPA navigation, its own periodic resize
  // handling). Then it measures the 480x270 dock box and rewrites the inline
  // size to match. Undocking now restores a full-width container around a
  // 480x270 video — a small picture in the top-left with dead space beside it,
  // which is the reported bug. Confirmed by reproducing exactly that sequence:
  // dock -> dispatch resize -> undock leaves playerBox 1431x805 with videoBox
  // 480x270.
  //
  // The previous attempt called setSize() synchronously inside tryUndock,
  // which is too early: the inline dock geometry has only just been removed
  // and layout has not been recomputed, so YouTube measures the box it is
  // still occupying. Waiting two frames lets the undocked rect settle first,
  // and the size is then verified rather than assumed — if the video still
  // doesn't match its container, clear the stale inline values so YouTube's
  // own CSS can size it.
  // Schedules the next check. requestAnimationFrame is the right tool while the
  // tab is visible (it fires exactly when layout has settled), but it does NOT
  // fire at all in a background tab — verified live: rAF never ran with
  // document.hidden true. Undocking can happen there (an SPA navigation, a
  // scroll restored on a tab the user hasn't focused yet), so fall back to a
  // timer rather than leaving the video stuck at dock size until the next
  // unrelated resize.
  function nextFrame(fn) {
    if (typeof document !== 'undefined' && document.hidden) {
      setTimeout(fn, 50);
      return;
    }
    requestAnimationFrame(fn);
  }

  function restoreVideoSize(player) {
    // Undocking must never depend on this succeeding — it is a cosmetic
    // correction, and a player object without the DOM methods it uses (an
    // early/partial element, or a stub) is not a reason to throw halfway
    // through tryUndock and leave the dock bar and listeners behind.
    if (!player || typeof player.querySelector !== 'function' || typeof player.getBoundingClientRect !== 'function') return;
    var attempts = 0;
    function attempt() {
      attempts++;
      var video = player.querySelector('video.html5-main-video');
      if (!video || typeof video.getBoundingClientRect !== 'function') return;
      var box = player.getBoundingClientRect();
      if (!box.width || !box.height) {
        if (attempts < 4) nextFrame(attempt);
        return;
      }
      try {
        if (typeof player.setSize === 'function') player.setSize();
      } catch (e) {
        /* player API not ready — the fallbacks below still apply */
      }
      var vb = video.getBoundingClientRect();
      // >2px on either axis is a real mismatch, not sub-pixel rounding.
      var sizeOk = Math.abs(vb.width - box.width) <= 2 && Math.abs(vb.height - box.height) <= 2;
      // Size alone is not enough. YouTube positions the <video> with inline
      // left/top, and a stale offset survives a size that happens to match —
      // observed live as top:-848px on a correctly-sized 2173x848 video, i.e.
      // the picture pushed a full player-height above its own container and
      // the frame rendering solid black. Check the offset too, or the restore
      // returns early on a player that looks right by the numbers and is
      // invisible on screen.
      var posOk = Math.abs(vb.left - box.left) <= 2 && Math.abs(vb.top - box.top) <= 2;
      if (sizeOk && posOk) return;
      if (attempts < 4) {
        // Give YouTube one more frame to react to setSize() before forcing it.
        nextFrame(attempt);
        return;
      }
      // Last resort: YouTube kept a stale inline size or offset. Clearing the
      // properties alone is NOT enough — measured live, a cleared <video>
      // collapses to height 0 because YouTube's own stylesheet does not size
      // it; the element is laid out entirely by these inline values. So clear
      // the container, then WRITE correct values rather than hoping the
      // cascade supplies them.
      var container = player.querySelector('.html5-video-container');
      if (container) {
        ['width', 'height'].forEach(function (prop) {
          container.style.removeProperty(prop);
        });
      }
      // Fit the video inside the player box at its own aspect ratio and
      // centre it, which is what YouTube's own sizing produces.
      var vw = video.videoWidth || 16;
      var vh = video.videoHeight || 9;
      var scale = Math.min(box.width / vw, box.height / vh);
      var fitW = Math.max(1, Math.round(vw * scale));
      var fitH = Math.max(1, Math.round(vh * scale));
      video.style.width = fitW + 'px';
      video.style.height = fitH + 'px';
      video.style.left = Math.round((box.width - fitW) / 2) + 'px';
      video.style.top = Math.round((box.height - fitH) / 2) + 'px';
      try {
        window.dispatchEvent(new Event('resize'));
      } catch (e) {
        /* ignore */
      }
    }
    nextFrame(function () {
      nextFrame(attempt);
    });
  }

  function tryUndock() {
    if (!docked) return;
    var player = findPlayer();
    if (player) {
      player.classList.remove('un-mini-docked-player');
      // applyDockPosition() sets top/left/bottom/right/width/height as
      // INLINE styles — removing the class only drops the CSS rule that
      // made position:fixed apply; the inline values themselves are a
      // separate thing and stay on the element regardless. #movie_player's
      // own normal (undocked) position is `relative` (confirmed live),
      // which DOES respect top/left offsets — so without clearing them,
      // the player would stay visibly shifted away from its real layout
      // position (and the wrong size) by whatever the last dock/drag/resize
      // state was, confirmed live as a real, reproducible bug: every dock
      // after the first landed the player at a wildly wrong rect instead
      // of its true position.
      ['top', 'left', 'bottom', 'right', 'width', 'height', 'max-width', 'max-height'].forEach(function (prop) {
        player.style.removeProperty(prop);
      });
      if (onPlayerEnter) player.removeEventListener('mouseenter', onPlayerEnter);
      if (onPlayerLeave) player.removeEventListener('mouseleave', onPlayerLeave);
    }
    onPlayerEnter = null;
    onPlayerLeave = null;
    removeDockBar();
    removeResizeHandle();
    // Drop the spacer and the docked flag BEFORE restoring the video size.
    // restoreVideoSize() calls player.setSize() and then measures the result,
    // and both read the live layout — while the spacer is still a sibling
    // holding the player's old height, and while .un-mini-docked is still on
    // <html> keeping the docked CSS applied, YouTube sizes the video against
    // geometry that is about to disappear. That is how the restore ends up
    // "correct" against the wrong box: a small picture with dead space beside
    // it, which is the reported symptom.
    removeLayoutSpacer();
    docked = false;
    document.documentElement.classList.remove('un-mini-docked');
    try {
      window.dispatchEvent(new CustomEvent('un-mini-dock-change', { detail: { docked: false } }));
    } catch (e) {}
    if (player) restoreVideoSize(player);
  }

  // ---- (removed) Stage 2: hand off to YouTube's own native miniplayer ----
  //
  // There used to be a second stage here: scrolling ~2400px past the dock
  // point drove YouTube's own native miniplayer via its right-click context
  // menu. Doing that hands control to YouTube, and YouTube's native
  // miniplayer *navigates away from the watch page by design* — it shrinks
  // the video into the corner and drops you on the homepage.
  //
  // That made the common case actively hostile: scrolling down to read
  // comments or look for another suggestion is EXACTLY the behavior Stage 1
  // exists to support, and doing enough of it silently destroyed the page the
  // user was reading. Reported as "no matter what video, super annoying if I
  // am trying to scroll for more suggestions or comments."
  //
  // Raising the threshold would only move the cliff, not remove it — a long
  // comment thread passes any fixed pixel count. So the stage is gone
  // entirely: Stage 1 docking now persists for the whole page, however far
  // the user scrolls. YouTube's native miniplayer is still available to
  // anyone who actually wants it, via its own right-click menu.

  function handleScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(function () {
      scrollTicking = false;
      if (docked) {
        // Undock once the player's real slot (the layout spacer marks
        // exactly where the full-size player will land) has scrolled far
        // enough into view that reverting to full size won't immediately
        // go right back out of view. See the file header for why this is a
        // plain rect check and not an IntersectionObserver.
        var exitReady = false;
        if (layoutSpacer && layoutSpacer.isConnected) {
          exitReady = layoutSpacer.getBoundingClientRect().bottom > EXIT_BUFFER_PX;
        } else {
          // The spacer reference went stale — YouTube's own re-render
          // reclaimed that DOM region while docked (confirmed as a real,
          // reproducible cause of "stuck docked, had to click Close
          // manually": a detached node's getBoundingClientRect() is
          // all-zero, so the check above never fires again for the rest of
          // the dock). Falls back to the player's document-relative bottom
          // edge captured at dock time, which needs no live DOM reference.
          exitReady = dockPlayerDocBottom - window.scrollY > EXIT_BUFFER_PX;
        }
        if (exitReady) {
          tryUndock();
          return;
        }
        // Stays docked stably while scrolling without layout-thrashing refits
        return;
      }
      // Not docked — dock once the player itself has scrolled fully out of
      // the viewport (no overlap at all, matching the old IntersectionObserver
      // threshold:0 semantics, just computed directly).
      var player = findPlayer();
      if (!player) return;
      var pr = player.getBoundingClientRect();
      if (pr.bottom <= 0 || pr.top >= window.innerHeight) tryDock();
    });
  }

  // ---- manual override button (QA tool + explicit user control) ----

  // Fixed pixel size, NOT width/height="100%".
  //
  // This icon alone used percentage sizing, so instead of rendering at icon
  // size it stretched to fill the whole button box — visibly oversized and
  // vertically misaligned next to every neighbouring control, which is how it
  // was reported ("that broken floating window button"). Every other Unsynth
  // player button declares explicit pixels (20–22px); popout-player uses 22
  // for this same 36-unit viewBox, so match it exactly — the two are adjacent
  // and any difference between them reads as a rendering bug.
  var MINI_SVG =
    '<svg height="22" viewBox="0 0 36 36" width="22" aria-hidden="true">' +
    '<path fill="currentColor" d="M31 8H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h26a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm0 18H5V10h26v16z"/>' +
    '<path fill="currentColor" d="M20 16h9v7h-9z"/></svg>';

  function ensurePlayerButton() {
    if (!window.UNSYNTH || !window.UNSYNTH.addPlayerButton) return;
    if (!prefs().showPlayerButton || !isWatch() || isShorts()) {
      removePlayerButton();
      return;
    }
    window.UNSYNTH.addPlayerButton({
      id: 'un-mini-btn',
      svg: MINI_SVG,
      title: 'Dock miniplayer (Unsynth)',
      ariaLabel: 'Toggle dock miniplayer',
      onClick: function () {
        if (docked) tryUndock();
        else tryDock();
      },
      cls: 'un-mini-btn',
      priority: 25
    });
  }
  function removePlayerButton() {
    if (window.UNSYNTH && window.UNSYNTH.removePlayerButton) window.UNSYNTH.removePlayerButton('un-mini-btn');
  }

  function setup() {
    if (isShorts() || !isWatch()) return;
    if (!prefs().enabled) {
      tryUndock();
      return;
    }
    ensurePlayerButton();
  }

  // yt-navigate-start fires BEFORE the URL/DOM transition begins (confirmed
  // real, already used the same way by watch-history.js and sub-manager.js).
  // core.js's own module contract only exposes onNavigate() on
  // yt-navigate-finish. Undocking here is a belt-and-suspenders safety net —
  // with CSS-only docking, being docked at navigate time is no longer known
  // to break anything, but there's no reason to carry the docked visual
  // state into a page transition either.
  var onNavStart = null;

  var mod = {
    id: 'scrollMiniplayer',
    moduleKey: 'scrollMiniplayer',
    init: function (c) {
      core = c;
      loadSavedPosition();
      onScroll = handleScroll;
      window.addEventListener('scroll', onScroll, { passive: true });
      onWindowResize = function () {
        if (!docked) return;
        // The viewport shrinking can leave a previously-valid size/position
        // no longer fitting (e.g. a wide box saved on a big monitor, window
        // resized narrower) — reclamp size against the new max before
        // re-applying position.
        if (dockSize.w > maxDockW()) dockSize = { w: maxDockW(), h: Math.round(maxDockW() * DOCK_ASPECT) };
        applyDockPosition(findPlayer(), dockBar, resizeHandle);
      };
      window.addEventListener('resize', onWindowResize);
      onNavStart = function () {
        tryUndock();
      };
      document.addEventListener('yt-navigate-start', onNavStart);
      setup();
    },
    scan: function () {
      setup();
    },
    onNavigate: function () {
      tryUndock();
      removePlayerButton();
      setup();
    },
    onSettings: function (s) {
      core.settings = s;
      setup();
    },
    teardown: function () {
      if (onNavStart) {
        document.removeEventListener('yt-navigate-start', onNavStart);
        onNavStart = null;
      }
      if (onScroll) {
        window.removeEventListener('scroll', onScroll);
        onScroll = null;
      }
      if (onWindowResize) {
        window.removeEventListener('resize', onWindowResize);
        onWindowResize = null;
      }
      if (dragMove) {
        document.removeEventListener('pointermove', dragMove);
        dragMove = null;
      }
      if (dragUp) {
        document.removeEventListener('pointerup', dragUp);
        dragUp = null;
      }
      tryUndock();
      removePlayerButton();
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
