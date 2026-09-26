/**
 * Unsynth Quality Lock — force a minimum video quality (e.g. always 1080p).
 *
 * Drives YouTube's player API (setPlaybackQualityRange on #movie_player). Those
 * methods are page-script expandos and are NOT visible from this isolated
 * world, so every call is routed through the service worker, which re-enters
 * the tab with chrome.scripting world:'MAIN'. See setQualityRange() below.
 * Falls back to polling if the player element isn't mounted yet.
 */
(function () {
  'use strict';

  // Ordered highest → lowest so indexOf comparisons work. Matches YouTube's
  // actual internal quality-key naming (confirmed against the documented
  // IFrame Player API quality levels — see docs/LESSONS.md) — NOT the naming
  // this file used to assume. 'large'/'medium'/'small'/'tiny' are the legacy
  // pre-HD key names and map to 480p/360p/240p/144p, NOT 720p/480p/360p as
  // the comments here previously (incorrectly) claimed; 720p's real key is
  // 'hd720', which was missing from this list entirely.
  const QUALITY_LEVELS = [
    'hd2880',  // 5K / 8K
    'hd2160',  // 4K
    'hd1440',  // 1440p
    'hd1080',  // 1080p
    'hd720',   // 720p
    'large',   // 480p
    'medium',  // 360p
    'small',   // 240p
    'tiny',    // 144p
    'auto'
  ];

  // Human-readable label → internal quality key mapping for settings UI.
  // Was silently wrong for every entry from 720p down — see the QUALITY_LEVELS
  // comment above. A user picking "720p" here was actually being locked to
  // 480p ('large'), and "480p"/"360p" were similarly one tier off.
  const QUALITY_LABELS = {
    'auto':   'auto',
    '4320p':  'hd2880',
    '2160p':  'hd2160',
    '1440p':  'hd1440',
    '1080p':  'hd1080',
    '720p':   'hd720',
    '480p':   'large',
    '360p':   'medium'
  };

  let core = null;
  let applyTimer = null;
  let chipEl = null;

  // ---- adaptive downgrade ------------------------------------------------
  //
  // Locking to 4K is only an improvement if the machine and connection can
  // actually sustain it. Without this, a hard lock on a weak connection means
  // permanent buffering — strictly worse than YouTube's own auto mode, which
  // is why "just force the max" is not on its own a good default.
  //
  // Health is judged from the player's OWN numbers, not a guess:
  //   * dropped frames — getVideoLoadedFraction/getStatsForNerds style data
  //     via the player's webkitDroppedFrameCount on the media element, which
  //     is the honest signal for "the GPU/CPU can't keep up with this
  //     resolution";
  //   * stalling — time spent in readyState < HAVE_FUTURE_DATA while the
  //     video is supposed to be playing, i.e. actual visible buffering.
  //
  // Both are needed: a slow connection stalls without dropping frames, and a
  // weak GPU drops frames without stalling.
  let adaptiveStrikes = 0;
  let adaptiveGoodRuns = 0;
  let adaptiveOffset = 0; // tiers below the user's chosen quality, 0 = none
  let lastFrameSample = null;
  let stallSince = 0;

  /**
   * Pure decision step, exported for tests. Given a health sample and current
   * strike state, decide whether to step down, step up, or hold.
   *
   * @returns {{action:'down'|'up'|'hold', strikes:number, goodRuns:number}}
   */
  function adaptiveDecision(sample, state, opts) {
    const strikesNeeded = (opts && opts.strikes) || 2;
    // Recovering upward is deliberately slower than dropping: dropping fixes
    // a problem the user is feeling right now, while climbing back risks
    // re-creating it, so it needs sustained evidence.
    const goodRunsNeeded = (opts && opts.goodRuns) || 6;
    let strikes = (state && state.strikes) || 0;
    let goodRuns = (state && state.goodRuns) || 0;

    const unhealthy = !!(sample && (sample.stalling || sample.dropRatio > 0.08));
    if (unhealthy) {
      strikes += 1;
      goodRuns = 0;
      if (strikes >= strikesNeeded) return { action: 'down', strikes: 0, goodRuns: 0 };
      return { action: 'hold', strikes: strikes, goodRuns: goodRuns };
    }
    strikes = 0;
    goodRuns += 1;
    if (goodRuns >= goodRunsNeeded) return { action: 'up', strikes: 0, goodRuns: 0 };
    return { action: 'hold', strikes: strikes, goodRuns: goodRuns };
  }

  /** Sample playback health from the real media element. */
  function sampleHealth() {
    const v = document.querySelector('#movie_player video');
    if (!v || v.paused || v.ended || !v.duration) {
      lastFrameSample = null;
      stallSince = 0;
      return null;
    }
    let dropRatio = 0;
    try {
      const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
      const dropped = q ? q.droppedVideoFrames : v.webkitDroppedFrameCount;
      const total = q ? q.totalVideoFrames : v.webkitDecodedFrameCount;
      if (typeof dropped === 'number' && typeof total === 'number' && total > 0) {
        if (lastFrameSample && total > lastFrameSample.total) {
          // Ratio over the INTERVAL, not lifetime: a rough patch early on
          // shouldn't hold the quality down for the rest of a long video.
          const dd = dropped - lastFrameSample.dropped;
          const dt = total - lastFrameSample.total;
          if (dt > 0) dropRatio = Math.max(0, dd / dt);
        }
        lastFrameSample = { dropped: dropped, total: total };
      }
    } catch (e) {
      /* stats unavailable — fall back to the stall signal alone */
    }
    // readyState < 3 (HAVE_FUTURE_DATA) while not paused means it is actually
    // starved, not merely seeking.
    const now = Date.now();
    let stalling = false;
    if (v.readyState < 3) {
      if (!stallSince) stallSince = now;
      // Require it to persist so a normal seek isn't mistaken for a stall.
      stalling = now - stallSince > 1500;
    } else {
      stallSince = 0;
    }
    return { dropRatio: dropRatio, stalling: stalling };
  }

  function prefs() {
    const d = (core && core.settings && core.settings.qualityLock) || {};
    return {
      // defaults.js states qualityLock.enabled: true — match the `!== false`
      // defensive-default idiom every other module's prefs() uses (see e.g.
      // volume-master.js's showPlayerControl/inlineBar), instead of `!!d.enabled`,
      // which silently defaults to OFF the moment core.settings hasn't
      // populated this key yet, contradicting the documented default.
      enabled: d.enabled !== false,
      quality:  QUALITY_LABELS[d.quality] || 'hd1080',
      // `=== true`, not `!== false`, because this default is OFF. The v7
      // migration CLEARS a persisted showChip so the new default can apply,
      // which leaves the key undefined — and `undefined !== false` is true, so
      // the old test turned the migration into a switch that forced the chip
      // back ON for exactly the upgrading users it was meant to help. Observed
      // live: the chip survived the migration while speedChip, which already
      // used `=== true`, disappeared correctly.
      showChip: d.showChip === true,
      adaptive: d.adaptive !== false,
      adaptiveStrikes: typeof d.adaptiveStrikes === 'number' ? Math.max(1, d.adaptiveStrikes) : 2,
      adaptiveFloor: QUALITY_LABELS[d.adaptiveFloor] || 'hd720'
    };
  }

  // Get the #movie_player element (YouTube's player API host).
  //
  // IMPORTANT: this returns the ELEMENT only. It does NOT give access to
  // YouTube's player API. Content scripts run in an isolated world, and
  // YouTube attaches setPlaybackQualityRange / setPlaybackQuality /
  // getPlaybackQuality to this element as PAGE-script expando properties.
  // Expando properties are not shared across the isolated-world boundary, so
  // from here those methods are `undefined` — always, on every real page, no
  // matter how long we wait. Use setQualityRange() below to actually drive the
  // player; use this only to answer "has the player element mounted yet".
  function getPlayer() {
    return document.getElementById('movie_player');
  }

  // The last quality the page world reported, refreshed on every bridge call.
  // getPlaybackQuality() is a page expando too, so it cannot be read directly
  // from here either; the MAIN-world helper returns it alongside the write.
  let lastKnownQuality = null;

  /**
   * Ask the service worker to run the real setPlaybackQualityRange in the
   * page's MAIN world (chrome.scripting world:'MAIN'), where YouTube's player
   * methods actually exist.
   *
   * This indirection is the entire fix for the defect where quality lock
   * appeared completely dead on live YouTube: applyQuality() gated on
   * `typeof player.setPlaybackQualityRange === 'function'` and that is never
   * true in this world, so it returned before doing anything — no lock, no
   * chip, no diagnostic stamp. Verified live: main world reported the method
   * present while this world reported it undefined for 20s straight.
   */
  function setQualityRange(min, max) {
    try {
      chrome.runtime.sendMessage(
        // `levels` lets the MAIN-world helper run the already-compliant check
        // itself. It has to happen there: getPlaybackQuality() is a page
        // expando too, so this world can never read the current quality to
        // compare against.
        { type: 'UNSYNTH/PLAYER/SET_QUALITY', min: min, max: max, levels: QUALITY_LEVELS },
        function (res) {
          // lastError must be READ or Chrome logs "unchecked runtime.lastError"
          // noise into the page console on every teardown/navigation race.
          if (chrome.runtime.lastError) return;
          if (res && res.ok && typeof res.current === 'string') lastKnownQuality = res.current;
        }
      );
    } catch (e) {
      /* extension context invalidated (reload/update) — nothing useful to do */
    }
  }

  // Publishes the internal quality key this module is currently targeting
  // (or 'auto'/'disabled') onto <html data-unsynth-quality-lock-target>,
  // same established pattern as core.js's own data-unsynth-scans /
  // data-unsynth-scan-ms diagnostics. Exists specifically so live/e2e
  // verification never needs to read this module's own isolated-world
  // state or a page-attached player method directly — both were confirmed,
  // live, to be unreliable to observe from outside a real user's own
  // browser session (see docs/LESSONS.md). This attribute is plain DOM,
  // reliably readable from any world, any tooling, always.
  function stampDiagnostic(key) {
    try {
      document.documentElement.setAttribute('data-unsynth-quality-lock-target', key);
    } catch (e) { /* diagnostics are best effort */ }
  }

  function applyQuality() {
    const p = prefs();
    if (!p.enabled || p.quality === 'auto') {
      // Explicitly restore auto mode so a previous lock doesn't keep sticking
      if (getPlayer()) setQualityRange('auto', 'auto');
      stampDiagnostic(p.enabled ? 'auto' : 'disabled');
      // Paused is not the same as switched off. Clicking the chip sets
      // enabled=false and updateChip() has a whole presentation for that
      // state — an em dash at 0.45 opacity reading "click to enable" — but
      // removeChip() here deleted the only control that could undo the pause,
      // so the user had to go to the dashboard to get the lock back. Keep the
      // chip and let updateChip() render the off state; teardown() still
      // removes it, which is the module actually being switched off.
      if (p.enabled) removeChip();
      else updateChip(p, null);
      return;
    }
    // Gate on the ELEMENT existing, never on the API methods being visible
    // here — they never are (see getPlayer/setQualityRange above). Gating on
    // the methods is exactly what made this module a silent no-op on every
    // real page.
    if (!getPlayer()) return;

    // Adaptive step: adjust how far below the chosen quality we're currently
    // running, based on real playback health. Runs BEFORE the target is
    // resolved so the decision applies on this same pass.
    if (p.adaptive) {
      const sample = sampleHealth();
      if (sample) {
        const decision = adaptiveDecision(
          sample,
          { strikes: adaptiveStrikes, goodRuns: adaptiveGoodRuns },
          { strikes: p.adaptiveStrikes }
        );
        adaptiveStrikes = decision.strikes;
        adaptiveGoodRuns = decision.goodRuns;
        const chosenIdx = QUALITY_LEVELS.indexOf(p.quality);
        const floorIdx = QUALITY_LEVELS.indexOf(p.adaptiveFloor);
        if (decision.action === 'down') {
          // Larger index = lower resolution. Never past the configured floor.
          const maxOffset = Math.max(0, floorIdx - chosenIdx);
          if (adaptiveOffset < maxOffset) adaptiveOffset += 1;
        } else if (decision.action === 'up' && adaptiveOffset > 0) {
          adaptiveOffset -= 1;
        }
      }
    } else {
      adaptiveOffset = 0;
    }

    try {
      // Stamped as soon as the target key is known — BEFORE the request goes
      // out, which the MAIN-world helper may skip as already-compliant. The
      // target is what's being verified (the correct-key-mapping bug this
      // exists to catch), independent of whether the API call itself turned
      // out to be needed on this particular poll.
      // The quality actually being requested = the user's choice stepped down
      // by however many tiers the adaptive logic has decided are necessary.
      const chosenIdx = QUALITY_LEVELS.indexOf(p.quality);
      const effective =
        chosenIdx >= 0 && adaptiveOffset > 0
          ? QUALITY_LEVELS[Math.min(QUALITY_LEVELS.length - 2, chosenIdx + adaptiveOffset)]
          : p.quality;

      stampDiagnostic(effective);
      // Always reflect the intended lock state on the chip first, so a throw in
      // the API call below can't leave a stale label.
      updateChip(p, effective);

      // The "already at or above the target, don't re-set and cause a
      // rebuffer" check now lives in the MAIN-world helper (it needs
      // getPlaybackQuality, which is unreadable from here). QUALITY_LEVELS
      // travels with the request so that helper can rank the current level.

      // setPlaybackQualityRange(minQuality, maxQuality). When adaptive has
      // stepped down, cap the MAX at the same tier too — otherwise the player
      // is still free to climb straight back to the resolution that was
      // stalling, and the downgrade accomplishes nothing.
      // The legacy single-quality setPlaybackQuality() call for older player
      // builds now happens inside the MAIN-world helper, alongside this one.
      setQualityRange(effective, adaptiveOffset > 0 ? effective : QUALITY_LEVELS[0]);
    } catch (e) {
      /* player API not available yet — retry handled by caller */
    }
  }

  function scheduleApply(delayMs) {
    if (applyTimer) clearTimeout(applyTimer);
    // Retry until the player element actually exists, rather than firing a
    // fixed two attempts and giving up forever.
    //
    // The old version ran applyQuality() once and then once more 3s later,
    // full stop. scan() is a deliberate no-op for this module (re-applying on
    // every DOM mutation causes rebuffering), and onNavigate only fires on a
    // real SPA navigation — so if #movie_player had not mounted by that second
    // attempt, nothing in the module would ever run again for the life of that
    // page. On a cold load or a slow one, that is a permanent silent failure
    // rather than a delay.
    // Bounded on both sides: at most ~10s of hunting for a late player, and a
    // single slow re-poll once it is up (which is what the original code was
    // reaching for with its lone 3s follow-up). Deliberately not an unbounded
    // interval — this module must not keep touching the player for the life of
    // a page, since every redundant range call risks a rebuffer.
    let waits = 0;
    const tick = function () {
      applyTimer = null;
      const mounted = !!getPlayer();
      applyQuality();
      if (mounted) {
        // Player is up: one last pass after buffering settles, then stop.
        applyTimer = setTimeout(function () { applyTimer = null; applyQuality(); }, 3000);
      } else if (++waits < 20) {
        applyTimer = setTimeout(tick, 500);
      }
    };
    applyTimer = setTimeout(tick, delayMs || 600);
  }

  // ---- Quality picker menu ----
  //
  // The chip used to be a toggle: clicking it flipped enabled on/off, so a
  // user who clicked expecting to CHOOSE a resolution got an em dash instead.
  // It now opens a real picker. Structure is copied from watch-history.js's
  // toggleWatchedMenu() (role=menu, menuitemradio rows, fixed positioning
  // clamped to the viewport, Escape via the shared LIFO panel stack, an
  // outside-click listener added on a 0ms timeout, every listener removed on
  // close) so this behaves identically to the masthead's view menu.

  const MENU_ID = 'un-ql-menu';
  let menuDocClick = null;
  let menuEsc = null;
  let menuKey = null;

  /**
   * Rows the picker offers, derived from QUALITY_LABELS so this can never
   * drift out of sync with the keys the module actually applies. Ordered
   * highest → lowest by QUALITY_LEVELS rank, with Auto first (it is the
   * "let YouTube decide" escape hatch, not a resolution).
   */
  function menuOptions() {
    const rows = [];
    Object.keys(QUALITY_LABELS).forEach(function (label) {
      rows.push({ label: label === 'auto' ? 'Auto' : label, value: label, key: QUALITY_LABELS[label] });
    });
    rows.sort(function (a, b) {
      // 'auto' sits last in QUALITY_LEVELS but reads first as an option.
      if (a.key === 'auto') return -1;
      if (b.key === 'auto') return 1;
      return QUALITY_LEVELS.indexOf(a.key) - QUALITY_LEVELS.indexOf(b.key);
    });
    return rows;
  }

  function closeMenu() {
    const menu = document.getElementById(MENU_ID);
    if (menu && menu.remove) menu.remove();
    if (menuDocClick) {
      document.removeEventListener('click', menuDocClick, true);
      menuDocClick = null;
    }
    if (menuKey) {
      document.removeEventListener('keydown', menuKey, true);
      menuKey = null;
    }
    if (menuEsc && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(menuEsc);
      menuEsc = null;
    }
    const chip = document.getElementById('un-ql-chip');
    if (chip && chip.setAttribute) chip.setAttribute('aria-expanded', 'false');
  }

  /**
   * Write the picked value and apply it immediately.
   *
   * `quality` is stored as the human LABEL ('1080p'), matching what the
   * dashboard's <select id="ql-quality"> writes and what prefs() maps through
   * QUALITY_LABELS — storing the internal key here would make prefs() fall
   * back to its hd1080 default on the next read.
   */
  function selectQuality(value) {
    if (!core) return;
    const settings = core.settings || {};
    settings.qualityLock = settings.qualityLock || {};
    if (value === null) {
      settings.qualityLock.enabled = false;
    } else {
      settings.qualityLock.enabled = true;
      settings.qualityLock.quality = value;
    }
    // In-memory state becomes authoritative immediately so a racing
    // onSettings broadcast carrying stale data cannot revert the choice.
    core.settings = settings;
    // A manual pick is a fresh intent: drop any adaptive step-down so the chip
    // does not immediately read one tier below what was just chosen.
    adaptiveOffset = 0;
    adaptiveStrikes = 0;
    adaptiveGoodRuns = 0;
    try {
      chrome.storage.sync.set({ qualityLock: settings.qualityLock }, function () {
        if (chrome.runtime && chrome.runtime.lastError) return;
        applyQuality();
      });
    } catch (e) {
      /* extension context invalidated — nothing useful to do */
    }
  }

  function openMenu(anchor) {
    if (document.getElementById(MENU_ID)) {
      closeMenu();
      return;
    }
    const p = prefs();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    // Reuses the existing menu visual language rather than inventing one.
    menu.className = 'un-home-menu un-ql-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Video quality');

    const addRow = function (label, on, onPick, title) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'un-sub-guide-item' + (on ? ' on' : '');
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.textContent = (on ? '✓ ' : '') + label;
      if (title) row.title = title;
      row.addEventListener('click', function (e) {
        if (e) {
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
        }
        closeMenu();
        onPick();
      });
      menu.appendChild(row);
      return row;
    };

    menuOptions().forEach(function (opt) {
      // The tick marks the user's CHOSEN target, not the adaptive-stepped
      // effective one — picking 4K and seeing the tick jump to 1080p because
      // the connection dipped would misreport what the setting is.
      const on = p.enabled && p.quality === opt.key;
      addRow(
        opt.label,
        on,
        function () { selectQuality(opt.value); },
        opt.key === 'auto' ? 'Let YouTube choose the resolution' : 'Lock playback to ' + opt.label
      );
    });

    // The old click-to-toggle was the only way to pause the lock; the click
    // now opens this menu, so the off state needs its own explicit row.
    addRow(
      'Lock off',
      !p.enabled,
      function () { selectQuality(null); },
      'Turn the quality lock off entirely'
    );

    document.body.appendChild(menu);
    menu.style.position = 'fixed';
    // Anchored off the chip when it is on the control bar. When the chip has
    // been collapsed into the overflow menu there is no #un-ql-chip to
    // measure, so fall back to whatever element was clicked, then to the
    // viewport — an unanchored menu at 0,0 would be worse than either.
    const el = (anchor && anchor.getBoundingClientRect) ? anchor : null;
    const r = el ? el.getBoundingClientRect() : null;
    const vw = (typeof window.innerWidth === 'number') ? window.innerWidth : 1280;
    const vh = (typeof window.innerHeight === 'number') ? window.innerHeight : 720;
    const w = menu.offsetWidth || 180;
    const h = menu.offsetHeight || 260;
    if (r) {
      // Player controls sit at the BOTTOM of the video, so open upward when
      // there is no room below — the watched menu's downward-only placement
      // would push this off-screen on every watch page.
      const below = vh - r.bottom;
      const top = below >= h + 8 ? r.bottom + 6 : Math.max(8, r.top - h - 6);
      menu.style.top = Math.round(Math.min(Math.max(8, top), Math.max(8, vh - h - 8))) + 'px';
      menu.style.left = Math.round(Math.max(8, Math.min(r.left, vw - w - 8))) + 'px';
    } else {
      menu.style.top = Math.round(Math.max(8, (vh - h) / 2)) + 'px';
      menu.style.left = Math.round(Math.max(8, (vw - w) / 2)) + 'px';
    }
    menu.style.right = 'auto';

    const chip = document.getElementById('un-ql-chip');
    if (chip && chip.setAttribute) chip.setAttribute('aria-expanded', 'true');

    menuDocClick = function (e) {
      // Not a user dismissal — the extension synthesises clicks elsewhere
      // (autoplay toggles, download links, player controls) and every one of
      // them bubbles to document. Treating those as an outside click closed
      // panels ~300ms after opening. See queue-advance.js docClickHandler.
      if (e && e.isTrusted === false) return;
      const t = e && e.target;
      if (menu.contains && menu.contains(t)) return;
      if (el && (t === el || (el.contains && el.contains(t)))) return;
      closeMenu();
    };
    // Escape routes through the shared LIFO stack so only the topmost overlay
    // closes; a raw document listener also closed whatever was open behind it.
    menuEsc = (window.UNSYNTH && window.UNSYNTH.pushPanel) ? window.UNSYNTH.pushPanel(closeMenu) : null;
    menuKey = menuEsc ? null : function (e) { if (e && e.key === 'Escape') closeMenu(); };
    setTimeout(function () {
      document.addEventListener('click', menuDocClick, true);
      if (menuKey) document.addEventListener('keydown', menuKey, true);
    }, 0);
    const first = menu.querySelector('.un-sub-guide-item.on') || menu.querySelector('.un-sub-guide-item');
    if (first && first.focus) first.focus();
  }

  // ---- Status chip in the player controls ----
  // Registered through core.addPlayerButton() (not a direct
  // host.insertBefore(el, host.firstChild)) so it participates in the same
  // coordinated ordering AND overflow-collapse system every other Unsynth
  // player button does — confirmed live this chip is on by default
  // (qualityLock.enabled/showChip both default true, see defaults.js) and
  // was a real, uncounted contributor to a crowded control bar: bypassing
  // the coordinator meant it could land anywhere (an insertion-order race,
  // same class of bug volume-master.js had) AND could never be one of the
  // buttons collapsed into the overflow menu when space ran short, since
  // the collapse logic only ever sees buttons registered in _playerBtns.
  function ensureChip() {
    if (!window.UNSYNTH || !window.UNSYNTH.addPlayerButton) return null;
    window.UNSYNTH.addPlayerButton({
      id: 'un-ql-chip',
      svg: '',
      title: 'Quality locked (Unsynth)',
      ariaLabel: 'Quality locked',
      onClick: function (e) {
        // Opens the picker. This used to toggle the lock off, which is what
        // made the chip a confusing affordance: a click aimed at "choose a
        // resolution" replaced the number with an em dash and offered no way
        // to pick anything. Turning the lock off now lives in the menu.
        if (e) {
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
        }
        // Prefer the real chip; when it has been collapsed into the overflow
        // menu the click comes from that row instead, so anchor to whatever
        // was actually clicked.
        const anchor = document.getElementById('un-ql-chip') || (e && e.currentTarget) || null;
        openMenu(anchor);
      },
      cls: 'un-ql-chip',
      priority: 45
    });
    chipEl = document.getElementById('un-ql-chip');
    return chipEl;
  }

  // Only show the chip on the real watch / shorts player, not feed previews.
  function onPlayerPage() { return window.UNSYNTH.isWatch(); }

  // `effective` is the quality actually in force, which differs from the
  // user's choice whenever adaptive has stepped down. The chip must show what
  // is REALLY playing — a chip reading "4K" during an adaptive drop to 1080p
  // would be actively misleading, and the whole point of the chip is to be
  // able to trust it at a glance.
  function updateChip(p, effective) {
    // The overflow-menu picker is the fallback surface whenever the chip is
    // not in the bar, so it is kept in sync on the same path the chip is.
    syncMenuRow(p, effective);
    if (!p.showChip || !onPlayerPage()) { removeChip(); return; }
    const chip = ensureChip();
    if (!chip) return;
    const key = effective || p.quality;
    const nameOf = function (k) {
      const e = Object.entries(QUALITY_LABELS).find(function (x) { return x[1] === k; });
      return e ? e[0] : k;
    };
    const shown = nameOf(key);
    const stepped = !!effective && effective !== p.quality;
    chip.textContent = p.enabled ? (stepped ? shown + '↓' : shown) : '—';
    chip.style.opacity = p.enabled ? '1' : '0.45';
    chip.classList.toggle('un-ql-adaptive', stepped);
    const why = stepped
      ? 'Adaptive: stepped down from ' + nameOf(p.quality) + ' to ' + shown +
        ' because playback was stalling or dropping frames. Recovers automatically.'
      : 'Quality locked to ' + shown;
    chip.title = p.enabled ? why + ' (click to change)' : 'Quality lock off (click to choose a resolution)';
    chip.setAttribute('aria-label', p.enabled ? why + ', click to change quality' : 'Quality lock off, click to choose a resolution');
    // Announces the chip as a menu button, matching what the click now does.
    chip.setAttribute('aria-haspopup', 'menu');
    if (!chip.hasAttribute || !chip.hasAttribute('aria-expanded')) chip.setAttribute('aria-expanded', 'false');
  }

  function removeChip() {
    // The menu is appended to <body>, not into the chip, so removing the chip
    // would otherwise strand an open picker (and its document listeners)
    // anchored to an element that no longer exists.
    closeMenu();
    if (window.UNSYNTH && window.UNSYNTH.removePlayerButton) window.UNSYNTH.removePlayerButton('un-ql-chip');
    chipEl = null;
  }

  // ---- Resolution picker in the "Unsynth tools" menu ----
  // The chip is hidden by default now (defaults.js qualityLock.showChip:
  // false) because YouTube's own settings gear already carries a Quality row,
  // and the bar was measured live holding 480px of Unsynth buttons against
  // YouTube's 240px. Hiding a button must not delete the feature, though, and
  // this one has no keyboard fallback: shift+q toggles the LOCK (see
  // shortcuts.js runAction), it does not open the picker. So the picker gets a
  // permanent home in the overflow menu, which costs no bar width. When the
  // chip IS shown this row would be a duplicate, so only one exists at a time.
  const MENU_ROW_ID = 'quality-picker';
  const QUALITY_MENU_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path fill="currentColor" d="M3 5h18v14H3V5zm2 2v10h14V7H5z"/>' +
    '<path fill="currentColor" d="M7 9h4v2H7V9zm0 4h7v2H7v-2z"/>' +
    '</svg>';

  function syncMenuRow(p, effective) {
    if (!window.UNSYNTH || !window.UNSYNTH.addMenuItem) return;
    // Chip visible = the picker is already one click away in the bar.
    if (p.showChip && onPlayerPage()) {
      if (window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem(MENU_ROW_ID);
      return;
    }
    if (!onPlayerPage()) {
      if (window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem(MENU_ROW_ID);
      return;
    }
    const key = effective || p.quality;
    const nameOf = function (k) {
      const e = Object.entries(QUALITY_LABELS).find(function (x) { return x[1] === k; });
      return e ? e[0] : k;
    };
    // The current value belongs in the label here, not in the bar — this is
    // the surface with room for it.
    const shown = p.enabled ? nameOf(key) : 'off';
    window.UNSYNTH.addMenuItem({
      id: MENU_ROW_ID,
      svg: QUALITY_MENU_SVG,
      label: 'Video quality (' + shown + ')',
      onClick: function (e) {
        // Anchor to whatever row was clicked — the chip does not exist here.
        openMenu((e && e.currentTarget) || null);
      },
      priority: 45
    });
  }

  function removeMenuRow() {
    if (window.UNSYNTH && window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem(MENU_ROW_ID);
  }

  // Release the lock and remove UI — called by core when the module is switched off.
  function teardown() {
    if (applyTimer) { clearTimeout(applyTimer); applyTimer = null; }
    removeChip();
    removeMenuRow();
    // Release the lock through the page world — an in-world call here would
    // silently do nothing and leave the user pinned to the locked resolution
    // after switching the module off.
    if (getPlayer()) setQualityRange('auto', 'auto');
  }

  // ---- Module interface ----
  const mod = {
    id: 'qualityLock',
    moduleKey: 'qualityLock',
    init: function (c) {
      core = c;
      syncMenuRow(prefs(), null);
      scheduleApply(1200);
    },
    scan: function () {
      // Quality lock does not need to re-apply on every DOM mutation — that can
      // rebuffer. Re-lock on navigate / settings / init only.
      //
      // The overflow-menu picker row is a different matter: it is the ONLY way
      // to reach the resolution picker now that the chip is hidden by default,
      // and applyQuality() — the path that normally refreshes it — returns
      // early whenever the player element isn't up yet, which on a cold watch
      // page is exactly when the menu is being built. Re-syncing here is cheap
      // (addMenuItem is idempotent on the same id) and makes the row's
      // appearance independent of whether the lock has managed to apply.
      syncMenuRow(prefs(), null);
    },
    onNavigate: function () {
      // New video — re-lock quality after the player initialises.
      syncMenuRow(prefs(), null);
      scheduleApply(1000);
    },
    onSettings: function (s) {
      core.settings = s;
      if (!prefs().enabled) {
        // Keep the chip in its off state — see applyQuality() above.
        updateChip(prefs(), null);
        if (getPlayer()) setQualityRange('auto', 'auto');
      } else {
        scheduleApply(200);
      }
    },
    teardown: teardown
  };

  // Exposed for unit tests: the adaptive decision is pure and is the part most
  // worth pinning (a wrong threshold silently degrades everyone's video), but
  // the rest of this module needs a live YouTube player to exercise.
  if (typeof window !== 'undefined') {
    window.UNQualityLockInternals = {
      QUALITY_LEVELS: QUALITY_LEVELS,
      QUALITY_LABELS: QUALITY_LABELS,
      adaptiveDecision: adaptiveDecision,
      // The picker is DOM-driven, so tests exercise it through these rather
      // than by reaching into module state.
      menuOptions: menuOptions,
      openMenu: openMenu,
      closeMenu: closeMenu,
      MENU_ID: MENU_ID
    };
  }

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
