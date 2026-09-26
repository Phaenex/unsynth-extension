/**
 * Unsynth "Tune" module — YouTube UI/UX customization.
 *
 * Three tiers:
 *   - CSS toggles: set <html> classes (UNUI.classesFor) + a --un-vpr property;
 *     all the hiding/theming lives in ui-tune.css, gated by those classes.
 *   - JS-DOM behavior: disable autoplay, block "are you still watching?",
 *     redirect the logo to subscriptions.
 *   - Player (isolated-world DOM): default speed/volume, loop, theater mode.
 *
 * New behaviors (v2):
 *   - Auto-pause on tab switch
 *   - Channel page default-tab redirect (→ Videos)
 *   - Scroll-to-volume on the player
 *   - Feed shelf hider (CSS class per shelf type)
 */
(function () {
  'use strict';

  let core = null;
  let ui = {};
  const YT = window.UNYtDom || null;

  const ALL_CLASSES = Object.values(window.UNUI ? window.UNUI.CLASS_MAP : {});

  // Classes that hide HOME-feed content. While the "YT Default" peek is on these
  // are suspended so YouTube's native offerings show — otherwise a hidden home
  // feed (un-hide-home) makes the peek look like it does nothing. Non-feed hides
  // (comments, chat, end cards, merch, bell, premium) are not "offerings" and stay.
  const FEED_HIDE_CLASSES = new Set([
    'un-hide-home', 'un-hide-shorts', 'un-hide-recs', 'un-hide-trending'
  ]);
  function defaultFeedOn() {
    return document.documentElement.classList.contains('un-default-feed');
  }

  function applyCss() {
    const root = document.documentElement;
    const peek = defaultFeedOn();
    const want = new Set(window.UNUI.classesFor(ui));
    for (const cls of ALL_CLASSES) {
      if (want.has(cls) && !(peek && FEED_HIDE_CLASSES.has(cls))) root.classList.add(cls);
      else root.classList.remove(cls);
    }
    // videos-per-row via custom property (0 = leave default)
    if (ui.videosPerRow && ui.videosPerRow > 0) root.style.setProperty('--un-vpr', String(ui.videosPerRow));
    else root.style.removeProperty('--un-vpr');
    applyShelfClasses(peek);
  }

  // ---- Shelf hider (granular per-shelf-type CSS gating) ----
  const SHELF_CLASS_MAP = {
    forYou:          'un-hide-shelf-foryou',
    mixes:           'un-hide-shelf-mixes',
    news:            'un-hide-shelf-news',
    shopping:        'un-hide-shelf-shopping',
    communityPosts:  'un-hide-shelf-community',
    continueWatching:'un-hide-shelf-continue'
  };

  function applyShelfClasses(peek) {
    if (peek === undefined) peek = defaultFeedOn();
    const shelves = (ui.hideShelves) || {};
    const root = document.documentElement;
    Object.entries(SHELF_CLASS_MAP).forEach(function ([key, cls]) {
      // Suspend shelf hiding too while peeking at YouTube's default feed.
      if (shelves[key] && !peek) root.classList.add(cls);
      else root.classList.remove(cls);
    });
  }

  // ---- JS-DOM behavior ----
  function applyLogoRedirect() {
    if (!ui.logoToSubscriptions) return;
    document.querySelectorAll(YT ? YT.TOPBAR_LOGO_SEL : 'a#logo').forEach((a) => {
      if (a.getAttribute('href') !== '/feed/subscriptions') a.setAttribute('href', '/feed/subscriptions');
    });
  }
  function blockStillWatching() {
    if (!ui.blockStillWatching) return;
    // The "Video paused. Continue watching?" confirm dialog.
    const dlg = document.querySelector(YT ? YT.CONFIRM_DIALOG_SEL : 'none');
    if (dlg) {
      const btn = dlg.querySelector('#confirm-button button, button[aria-label*="Yes"], yt-button-renderer button');
      if (btn) btn.click();
    }
  }
  function disableAutoplay() {
    if (!ui.disableAutoplay) return;
    const toggle = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (toggle) toggle.click();
  }

  // ---- player (isolated-world DOM access works for these) ----
  function mainPlayerVideo() {
    return (
      document.querySelector(YT ? YT.YTD_PLAYER_SEL + ' video.html5-main-video' : '#movie_player video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('#shorts-player video') ||
      document.querySelector((YT && YT.YTD_PLAYER_SEL) ? YT.YTD_PLAYER_SEL + ' video.html5-main-video' : 'video')
    );
  }
  function applyPlayer() {
    const v = mainPlayerVideo();
    if (!v) return;
    if (ui.defaultSpeed && ui.defaultSpeed > 0 && v.playbackRate !== ui.defaultSpeed) {
      try {
        v.playbackRate = ui.defaultSpeed;
      } catch (e) {
        /* ignore */
      }
    }
    if (typeof ui.defaultVolume === 'number' && ui.defaultVolume >= 0 && !v.dataset.unVol) {
      try {
        v.volume = Math.min(1, ui.defaultVolume / 100);
        v.dataset.unVol = '1'; // apply once per element so the user can still adjust
      } catch (e) {
        /* ignore */
      }
    }
    if (ui.loopVideo) v.loop = true;
  }
  function applyTheater() {
    if (!ui.theaterMode || !(window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch')) return;
    const flexy = document.querySelector(YT ? YT.WATCH_FLEXY_SEL : 'none');
    if (flexy && !flexy.hasAttribute('theater')) {
      const sizeBtn = document.querySelector('.ytp-size-button');
      if (sizeBtn) sizeBtn.click();
    }
  }

  // ---- Auto-pause on tab switch ----
  let autoPauseAttached = false;
  let unPaused = false; // true only if WE paused it

  function handleVisChange() {
    if (!ui.autoPauseOnTabSwitch) return;
    // mainPlayerVideo() (below) exists specifically because a bare
    // document.querySelector('video') isn't reliable — YouTube's own
    // persistent miniplayer, a stale leftover from SPA navigation, or any
    // other <video> earlier in document order can win instead of the real
    // player, silently pausing/resuming the wrong element.
    const v = mainPlayerVideo();
    if (!v) return;
    if (document.hidden) {
      if (!v.paused) {
        v.pause();
        unPaused = true;
      }
    } else {
      if (unPaused && v.paused) {
        v.play().catch(function () {});
      }
      unPaused = false;
    }
  }

  function attachAutoPause() {
    if (autoPauseAttached) return;
    document.addEventListener('visibilitychange', handleVisChange);
    autoPauseAttached = true;
  }

  // ---- Channel page default tab redirect ----
  let channelRedirectDone = false;

  function applyChannelTab() {
    const want = ui.channelDefaultTab;
    if (!want || want === 'home') return;
    const path = location.pathname;
    // Match channel root URLs: /@handle, /channel/UC..., /user/...
    // but NOT already on a sub-page like /@handle/videos
    const isChannelRoot = /^\/((@[^/]+|channel\/[^/]+|user\/[^/]+))(\/featured)?$/.test(path);
    if (!isChannelRoot) { channelRedirectDone = false; return; }
    if (channelRedirectDone) return;

    const TAB_HREF_PARTS = {
      videos: ['/videos'],
      shorts: ['/shorts'],
      live: ['/streams', '/live'],
      playlists: ['/playlists'],
      community: ['/community', '/posts'],
      about: ['/about']
    };
    const TAB_LABEL_MAP = {
      videos:    ['Videos'],
      shorts:    ['Shorts'],
      live:      ['Live'],
      playlists: ['Playlists'],
      community: ['Community', 'Posts'],
      about:     ['About']
    };
    const hrefParts = TAB_HREF_PARTS[want] || ['/videos'];
    const labels = TAB_LABEL_MAP[want] || ['Videos'];

    function tabLink(tab) {
      if (tab.matches && tab.matches('a[href]')) return tab;
      return tab.querySelector('a[href]');
    }

    // The guide-entry renderer also matches entries in the permanent LEFT
    // SIDEBAR guide, not just the channel's own tab bar — and that sidebar
    // has a "Shorts" entry that's always present but 0×0/hidden (a structural
    // fixture, not a transient stale node). Live-reproduced: with document
    // order putting that hidden sidebar entry before the real tab bar, the
    // label-matching loop below clicked it instead — a no-op click on a
    // detached-looking element — and channelRedirectDone got set true
    // permanently, silently skipping the real per-channel redirect forever.
    // Only trust a tab that's actually rendered.
    function isRenderedTab(tab) {
      const r = tab.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function tryClick() {
      const tabs = Array.prototype.filter.call(
        document.querySelectorAll(YT ? YT.GUIDE_TAB_ENTRY_SEL : 'none'),
        isRenderedTab
      );
      for (const tab of tabs) {
        const link = tabLink(tab);
        const href = link ? link.getAttribute('href') || '' : '';
        if (href && hrefParts.some(function (part) { return href.indexOf(part) !== -1; })) {
          if (!tab.hasAttribute('aria-selected') || tab.getAttribute('aria-selected') === 'false') {
            (link || tab).click();
          }
          return true;
        }
      }
      for (const tab of tabs) {
        const text = tab.textContent.trim();
        if (labels.some(function (l) { return text === l; })) {
          if (!tab.hasAttribute('aria-selected') || tab.getAttribute('aria-selected') === 'false') {
            tab.click();
          }
          return true;
        }
      }
      return false;
    }

    // Only mark done once the click lands — otherwise a slow SPA hydration
    // would permanently skip retries on later scans.
    if (tryClick()) {
      channelRedirectDone = true;
    } else {
      setTimeout(function () {
        if (tryClick()) channelRedirectDone = true;
      }, 800);
    }
  }

  // ---- Scroll-to-Volume on player ----
  let scrollVolAttached = false;
  // Accumulated, deltaMode-normalized wheel distance. Trackpads fire many tiny
  // events; mouse wheels fire few large ones. We convert both to pixel distance
  // and advance volume by one step once that distance crosses the threshold —
  // and never by more than one step per wheel event, so a single scroll tick
  // is predictable.
  let wheelAccum = 0;
  const WHEEL_PX_PER_STEP = 28; // px of scroll per volume tick
  const WHEEL_VOL_STEP = 2; // percentage points per tick — 1% was too slow to cross a useful range
  function wheelSteps(e) {
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; // lines → px
    else if (e.deltaMode === 2) dy *= (window.innerHeight || 800); // pages → px
    // Reset on direction change so leftover momentum doesn't fight the new scroll.
    if ((dy < 0 && wheelAccum > 0) || (dy > 0 && wheelAccum < 0)) wheelAccum = 0;
    wheelAccum += dy;
    let steps = 0;
    while (wheelAccum <= -WHEEL_PX_PER_STEP) { steps += 1; wheelAccum += WHEEL_PX_PER_STEP; }
    while (wheelAccum >= WHEEL_PX_PER_STEP) { steps -= 1; wheelAccum -= WHEEL_PX_PER_STEP; }
    // Cap to a single tick per event — a big mouse-wheel notch must not jump
    // by 3–4 ticks at once.
    if (steps > 1) steps = 1;
    else if (steps < -1) steps = -1;
    return steps; // +1 scroll-up (louder), -1 scroll-down (quieter), 0 = sub-threshold
  }

  // Is the wheel event over the player — and nothing else on top of it? We
  // hit-test the element actually painted under the cursor with
  // document.elementFromPoint, NOT the player's bounding box alone. A pure
  // geometry test treats any overlay that happens to sit over the player's
  // rectangle — the guide/mini-guide drawer, a search/menu dropdown, an
  // engagement panel, our own download/volume popups, a dialog — as "the
  // player", so scrolling that overlay changed the video volume AND blocked the
  // overlay from scrolling itself. The rendered top-most element resolves this:
  // player chrome (gradients, auto-hide controls) is a descendant of
  // #movie_player, so it still counts as the player, while anything layered on
  // top does not. Geometry stays only as a fallback when elementFromPoint can't
  // resolve a node (e.g. off-screen / mid-transition coordinates).
  function wheelOverPlayer(e) {
    const player = document.getElementById('movie_player');
    if (!player) return null;
    const top = document.elementFromPoint(e.clientX, e.clientY);
    if (top) {
      // The player (or its own chrome) is genuinely under the cursor.
      if (player.contains(top)) return player;
      // Something else is layered over the player here — let it scroll itself.
      return null;
    }
    // elementFromPoint returned nothing (detached/off-screen point). Fall back
    // to the bounding-box test so a valid over-player scroll still registers.
    const r = player.getBoundingClientRect();
    if (
      r.width > 0 && r.height > 0 &&
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom
    ) {
      return player;
    }
    return null;
  }

  function onPlayerScroll(e) {
    if (!ui.scrollToVolume) return;
    if (!wheelOverPlayer(e)) return;
    // Plain scroll directly over the player adjusts volume (the feature the user
    // turned on). We preventDefault so the page doesn't also scroll — but only
    // over the player, so scrolling the title/description/comments still works.
    e.preventDefault();
    e.stopPropagation();
    const steps = wheelSteps(e);
    if (!steps) return; // sub-threshold trackpad movement — wait for more
    const delta = steps * WHEEL_VOL_STEP; // ±2% per qualifying scroll tick
    // Drive the same boost level the top overlay bar shows so the two readouts
    // agree instead of competing. Fall back to native volume if Volume Master
    // is disabled.
    const VM = window.UNVolume;
    if (VM && VM.setGain && VM.getGain) {
      VM.setGain(VM.getGain() + delta, true);
      showVolumeOsd(VM.getGain(), e.clientX, e.clientY);
      return;
    }
    // Same reasoning as handleVisChange above — mainPlayerVideo() avoids
    // silently reading/writing an ad or stale-leftover <video>'s volume
    // while the real player never moves.
    const v = mainPlayerVideo();
    if (!v) return;
    const newVol = Math.min(100, Math.max(0, Math.round(v.volume * 100 + delta)));
    v.volume = newVol / 100;
    showVolumeOsd(newVol, e.clientX, e.clientY);
  }

  // Lightweight scroll-to-volume HUD: a compact level readout (icon + bar + %)
  // that pops up right next to the cursor. Drives the same boost as the top
  // overlay bar, so the two never disagree; the enhancers live only on that bar.
  let volOsdTimer = null;
  // pct is the unified level (0–600): 0–100 is native volume, >100 is Web Audio
  // boost. The bar fills 0–100% of the NATIVE range (full at 100), and the
  // `over` class recolors it for the boosted range — so scrolling visibly moves
  // the meter instead of crawling 1/6 of the way across a 600-wide scale.
  function showVolumeOsd(pct, x, y) {
    let osd = document.getElementById('un-vol-osd');
    if (!osd) {
      osd = document.createElement('div');
      osd.id = 'un-vol-osd';
      osd.className = 'un-vol-osd';
      osd.setAttribute('role', 'status');
      osd.setAttribute('aria-live', 'polite');
      osd.innerHTML =
        '<span class="un-vol-osd-ico" aria-hidden="true">🔊</span>' +
        '<span class="un-vol-osd-bar"><span class="un-vol-osd-fill"></span></span>' +
        '<span class="un-vol-osd-pct"></span>';
      document.body.appendChild(osd);
    }
    const fill = osd.querySelector('.un-vol-osd-fill');
    const pctEl = osd.querySelector('.un-vol-osd-pct');
    const ico = osd.querySelector('.un-vol-osd-ico');
    // Bar fill + state come from the shared, unit-tested helper; inline fallback
    // keeps the HUD working even if volume-level.js failed to load first.
    const VL = typeof UNVolumeLevel !== 'undefined' ? UNVolumeLevel : null;
    const fillPct = VL ? VL.osdFillPercent(pct) : Math.max(0, Math.min(100, pct));
    const st = VL ? VL.osdState(pct) : { muted: pct === 0, over: pct > 100, icon: pct === 0 ? '🔇' : pct < 50 ? '🔉' : '🔊' };
    if (fill) fill.style.width = fillPct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (ico) ico.textContent = st.icon;
    osd.classList.toggle('muted', st.muted);
    osd.classList.toggle('over', st.over);
    // Anchor it beside the cursor (offset down-right), clamped to the viewport.
    if (typeof x === 'number' && typeof y === 'number') {
      const w = osd.offsetWidth || 190;
      const h = osd.offsetHeight || 42;
      const m = 8;
      let left = x + 18;
      let top = y + 18;
      if (left + w > window.innerWidth - m) left = x - 18 - w;
      if (left < m) left = m;
      if (top + h > window.innerHeight - m) top = y - 18 - h;
      if (top < m) top = m;
      osd.style.left = left + 'px';
      osd.style.top = top + 'px';
    }
    osd.style.opacity = '1';
    if (volOsdTimer) clearTimeout(volOsdTimer);
    volOsdTimer = setTimeout(function () {
      if (osd) osd.style.opacity = '0';
    }, 1100);
  }

  function attachScrollVol() {
    if (scrollVolAttached) return;
    document.addEventListener('wheel', onPlayerScroll, { passive: false, capture: true });
    scrollVolAttached = true;
  }
  function detachScrollVol() {
    if (!scrollVolAttached) return;
    document.removeEventListener('wheel', onPlayerScroll, { capture: true });
    scrollVolAttached = false;
  }

  function tagShortsGuideEntries() {
    if (!ui.hideShorts) return;
    document.querySelectorAll(YT ? YT.GUIDE_SHORTS_LINK_SEL : 'none').forEach(function (a) {
      var entry = a.closest(YT ? YT.GUIDE_ENTRY_SEL : 'none');
      if (entry) entry.classList.add('un-shorts-nav');
    });
  }

  function runDom() {
    applyLogoRedirect();
    // Still-watching / autoplay only matter while a video is playing.
    const onPlayer =
      (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.indexOf('/shorts/') === 0;
    if (onPlayer) {
      blockStillWatching();
      disableAutoplay();
      applyPlayer();
    }
    tagShortsGuideEntries();
    applyChannelTab();

    if (ui.autoPauseOnTabSwitch) attachAutoPause();
    if (ui.scrollToVolume) attachScrollVol();
    else detachScrollVol();
  }

  // Module switched off: strip every layout class from <html> (restores the
  // hidden Shorts/comments/recs etc.) and detach listeners. Core skips
  // onSettings for a just-disabled module, so this runs instead.
  function teardown() {
    document.removeEventListener('unsynth-default-feed-changed', applyCss);
    const root = document.documentElement;
    for (const cls of ALL_CLASSES) root.classList.remove(cls);
    detachScrollVol();
    if (autoPauseAttached) {
      document.removeEventListener('visibilitychange', handleVisChange);
      autoPauseAttached = false;
    }
    const osd = document.getElementById('un-vol-osd');
    if (osd) osd.remove();
  }

  const mod = {
    id: 'uiTune',
    moduleKey: 'uiTune',
    init(c) {
      core = c;
      ui = (c.settings && c.settings.ui) || {};
      applyCss();
      // Re-apply layout classes when the "YT Default" peek toggles, so the home
      // feed / shorts / shelves reveal (and re-hide) in lockstep with it.
      // applyCss is a named module-level function so removeEventListener works.
      document.addEventListener('unsynth-default-feed-changed', applyCss);
    },
    scan() {
      ui = (core.settings && core.settings.ui) || {};
      runDom();
    },
    onNavigate() {
      channelRedirectDone = false;
      ui = (core.settings && core.settings.ui) || {};
      runDom();
      setTimeout(applyTheater, 800);
    },
    onSettings(s) {
      ui = (s && s.ui) || {};
      applyCss();
      runDom();
      applyTheater();
    },
    teardown: teardown
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();

