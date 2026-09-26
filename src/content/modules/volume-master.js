/**
 * Per-tab volume boost (0–600%) via Web Audio gain — inspired by Volume Master.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'unsynthTabVolume';
  const PRESET_STORAGE_KEY = 'unsynthTabAudioPreset';
  const graphs = new WeakMap();
  const audioCtxs = new Set(); // strong refs to created AudioContexts so teardown can close them
  const liveGraphs = new Map(); // iterable ownership for detached-media cleanup
  const listenedMedia = new Set();
  let core = null;
  let cfg = {};
  let gainPct = 100;
  // Percentage points per wheel tick. Must match ui-tune.js's WHEEL_VOL_STEP —
  // these are two separately-injected content scripts with no shared scope, so
  // the value is duplicated rather than imported. Change both together.
  const WHEEL_VOL_STEP = 2;
  // Default Off — Web Audio graphs are expensive; only wire when the user picks
  // an EQ preset or boosts past 100%. Stored host presets still win on load.
  let activePreset = 'normal';
  let lastVolMedia = null;
  let uiRoot = null; // the player-bar toggle button itself (id un-vol-btn)
  let popRoot = null; // the slider/preset popover — a separate, body-level element
  let popResizeHandler = null;
  let inlineRoot = null;
  let globalSettings = null;
  let autonomousObserver = null;
  let docCloseBound = false;

  function handoffStartupGuard(pct) {
    try {
      if (window.UNVolumeStartupGuard && window.UNVolumeStartupGuard.handoff) {
        window.UNVolumeStartupGuard.handoff(pct);
      }
    } catch (e) {
      /* startup guard is best-effort */
    }
  }

  // Close the volume popup on an outside click. Bound to `document` exactly once
  // (looking up the current popup each time) so rebuilding the control on every
  // navigation doesn't stack a new listener each time.
  function onDocCloseClick(ev) {
    // Not a user dismissal -- see queue-advance.js docClickHandler.
    if (ev && ev.isTrusted === false) return;
    if (!popRoot) return;
    if ((uiRoot && uiRoot.contains(ev.target)) || popRoot.contains(ev.target)) return;
    closePopover();
  }

  // Esc closes the volume popup (keyboard parity with the outside-click close).
  function onDocCloseKey(ev) {
    if (ev.key !== 'Escape' || !popRoot) return;
    closePopover();
    if (uiRoot) uiRoot.focus();
  }

  function prefs() {
    const d = (core && core.settings && core.settings.volumeMaster) || globalSettings || {};
    return {
      boostMax: Math.min(600, Math.max(100, d.boostMax || 600)),
      showPlayerControl: d.showPlayerControl !== false,
      inlineBar: d.inlineBar !== false,
      rememberLevel: d.rememberLevel !== false,
      defaultLevel: clampLevel(d.defaultLevel),
      audioPreset: d.audioPreset || 'normal'
    };
  }

  // The level a video starts at when there is nothing remembered to restore.
  // 0 is a legitimate choice (start muted), so this only falls back to the
  // product default when the setting is genuinely absent/non-numeric — a
  // `|| DEFAULT_LEVEL` would silently turn a deliberate 0 into 25.
  const DEFAULT_LEVEL = 50;
  function clampLevel(v) {
    const n = Number(v);
    if (!isFinite(n)) return DEFAULT_LEVEL;
    return Math.max(0, Math.min(600, Math.round(n)));
  }

  function defaultPreset() {
    return prefs().audioPreset || 'normal';
  }

  // Use chrome.storage.LOCAL, not session: session storage is blocked from content
  // scripts by default ("Access to storage is not allowed from this context"),
  // which threw on d being undefined. Every callback guards lastError + undefined.
  function loadStoredPreset() {
    return new Promise(function (resolve) {
      const fallback = defaultPreset();
      if (!prefs().rememberLevel) {
        resolve(fallback);
        return;
      }
      try {
        chrome.storage.local.get({ [PRESET_STORAGE_KEY]: {} }, function (d) {
          if (chrome.runtime.lastError || !d) { resolve(fallback); return; }
          const map = d[PRESET_STORAGE_KEY] || {};
          resolve(map[location.hostname] || fallback);
        });
      } catch (e) { resolve(fallback); }
    });
  }

  function saveStoredPreset(preset) {
    if (!prefs().rememberLevel) return;
    try {
      chrome.storage.local.get({ [PRESET_STORAGE_KEY]: {} }, function (d) {
        if (chrome.runtime.lastError || !d) return;
        const map = d[PRESET_STORAGE_KEY] || {};
        map[location.hostname] = preset;
        chrome.storage.local.set({ [PRESET_STORAGE_KEY]: map });
      });
    } catch (e) { /* ignore */ }
  }

  // The Web Audio gain node carries BOOST only (>100%); native video.volume
  // carries 0–100%. So the node must be 1.0 at or below 100% (same as
  // computeBoostGain). Using pct/100 here muted the graph entirely at 0% and
  // double-attenuated 0–100% (gain 0.5 × native 0.5 = 0.25 effective).
  function gainValue(pct) {
    return typeof UNVolumeLevel !== 'undefined'
      ? UNVolumeLevel.computeBoostGain(pct)
      : (pct > 100 ? pct / 100 : 1);
  }

  // Has loadStored() resolved yet? The media scan can fire BEFORE the async
  // storage read comes back. Acting on the placeholder level in that window
  // overwrites the level being restored and then persists the wrong value —
  // confirmed live: a remembered 70% was clobbered to 100% in storage before
  // the restore landed. Both maybeAdoptNative() and syncFromNative() wait for
  // this, and syncAllVideos() uses it to know the level is real.
  let levelLoaded = false;

  // Resolves the level a video should start at: the level remembered for this
  // host, else the configured default. Every failure path falls back to that
  // default (25% out of the box) rather than the old hardcoded 100% —
  // starting every video at full volume was the reported complaint, and a
  // storage error is not a reason to blast the user.
  function loadStored() {
    return new Promise(function (resolve) {
      const fallback = prefs().defaultLevel;
      if (!prefs().rememberLevel) {
        resolve(fallback);
        return;
      }
      try {
        chrome.storage.local.get({ [STORAGE_KEY]: {} }, function (d) {
          if (chrome.runtime.lastError || !d) {
            resolve(fallback);
            return;
          }
          const map = d[STORAGE_KEY] || {};
          const saved = map[location.hostname];
          resolve(typeof saved === 'number' ? saved : fallback);
        });
      } catch (e) {
        resolve(fallback);
      }
    });
  }

  function saveStored(pct) {
    if (!prefs().rememberLevel) return;
    try {
      chrome.storage.local.get({ [STORAGE_KEY]: {} }, function (d) {
        if (chrome.runtime.lastError || !d) return;
        const map = d[STORAGE_KEY] || {};
        map[location.hostname] = pct;
        chrome.storage.local.set({ [STORAGE_KEY]: map });
      });
    } catch (e) { /* ignore */ }
    try { chrome.runtime.sendMessage({ type: 'UNSYNTH/VOL/BADGE', gain: pct }).catch(function () {}); } catch (e) { /* ignore */ }
  }

  function applyGainToGraph(entry, pct) {
    if (!entry || !entry.gain) return;
    entry.gain.gain.value = gainValue(pct);
    if (entry.ctx && entry.ctx.state === 'suspended') entry.ctx.resume().catch(function () {});
  }

  // Unified level: 0–100% drives the element's NATIVE volume (so YouTube's own
  // slider, mute, and our UI all stay in lockstep), and anything above 100%
  // pins native at full and adds Web Audio boost on top. Without a graph (e.g.
  // before audio is wired) it still drives native volume up to 100%.
  function nativeForPct(pct) {
    return typeof UNVolumeLevel !== 'undefined'
      ? UNVolumeLevel.nativeForPct(pct)
      : Math.min(100, Math.max(0, pct)) / 100;
  }
  function applyLevel(video, entry, pct) {
    const boost = typeof UNVolumeLevel !== 'undefined' ? UNVolumeLevel.computeBoostGain(pct) : (pct > 100 ? pct / 100 : 1);
    if (entry && entry.gain) {
      entry.gain.gain.value = boost;
      if (entry.ctx && entry.ctx.state === 'suspended') entry.ctx.resume().catch(function () {});
    }
    try {
      const target = nativeForPct(pct);
      if (Math.abs((video.volume || 0) - target) > 0.002) video.volume = target;
    } catch (e) { /* ignore */ }
  }

  // The reverse direction: when the user drags YouTube's own volume slider or
  // hits mute, mirror it into our level so every surface shows the same number.
  // We tell our own writes apart from the user's by comparing against the native
  // value our current level would produce.
  function syncFromNative(video) {
    // Nothing to mirror INTO yet: until the stored level has loaded, gainPct
    // is still the placeholder 100. YouTube sets its own volume on the
    // element during startup, and treating that write as "the user changed
    // the volume" both overwrote the level being restored and then persisted
    // it — confirmed live, a remembered 70% came back as 100% and 100 was
    // written to storage, permanently losing the real value. The user cannot
    // have dragged a slider before the player finished loading, so anything
    // arriving in this window is startup noise by definition.
    if (!levelLoaded) return;
    // Only the MAIN player drives our shared level. YouTube spawns muted
    // preview/ad <video> elements (volume 0); their volumechange events would
    // otherwise reset gainPct to 0 and mute the real video — the snap-to-0 bug.
    const mainV = document.querySelector('#movie_player video');
    if (mainV && video !== mainV) return;
    // A volumechange arriving while we're still waiting out our own native
    // push's round trip is noise from that round trip, not a genuine user
    // drag — see pushNativeToYouTube's comment for why this exists.
    if (Date.now() < suppressNativeSyncUntil) return;
    const actual = video.volume || 0;
    // Drift-detection (our-own-write dead-band + active-boost guard) lives in the
    // unit-tested shared helper; inline fallback keeps parity if it failed to load.
    const needSync = typeof UNVolumeLevel !== 'undefined'
      ? UNVolumeLevel.shouldSyncFromNative(gainPct, actual, video.muted)
      : !((!video.muted && Math.abs(actual - nativeForPct(gainPct)) < 0.006) || (gainPct > 100 && !video.muted && actual >= 0.994));
    if (!needSync) return;
    // Mute is separate state from level, so a muted element keeps the level it
    // is muting instead of collapsing it to 0. This used to read
    // `video.muted ? 0 : Math.round(actual * 100)`, which destroyed the level:
    // measured live, video.volume 0.06 and getVolume() 6 rendered as "0%",
    // and saveStored() below then persisted that 0 so the real 6% never came
    // back. Rounding was never the defect — Math.round(0.06 * 100) is 6.
    // Unit-tested in test/volume-level.test.js; inline fallback keeps parity
    // if the shared helper failed to load, same convention as the checks above.
    const nv = typeof UNVolumeLevel !== 'undefined'
      ? UNVolumeLevel.levelFromNative(actual, video.muted, gainPct)
      : (video.muted ? gainPct : Math.round(actual * 100));
    if (nv === gainPct) return;
    gainPct = nv;
    adopted = true; // a real user volume change — lock it in so scans enforce it
    saveStored(gainPct);
    // Re-apply through the unified model so the Web Audio boost node matches the
    // new level (e.g. dragging the native slider down out of a >100% boost must
    // drop the gain node too, not just the displayed number). applyLevel only
    // writes video.volume when it differs, so this won't loop on our own change.
    applyLevel(video, graphs.get(video), gainPct);
    updateUi();
  }

  // Smoothly glide an AudioParam to a new value instead of jumping it. A hard
  // setValueAtTime on a filter gain or the compressor threshold steps the signal
  // level instantaneously, which clicks/pops on a preset switch. setTargetAtTime
  // eases over ~3 time-constants (here ~120ms) — inaudible transition. Frequency,
  // Q, ratio, knee, attack and release don't click, so they stay instantaneous.
  function rampParam(param, value, t, tc) {
    if (!param) return;
    tc = tc || 0.04;
    try {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(value, t, tc);
      // setTargetAtTime is asymptotic — pin the EXACT target once the glide has
      // settled (~8 time constants ≈ 0.32s) so a bypass truly reaches 0 instead
      // of leaving a tiny residual gain/threshold.
      param.setValueAtTime(value, t + tc * 8);
    } catch (e) {
      try { param.value = value; } catch (e2) { /* ignore */ }
    }
  }

  function applyPresetToGraph(entry, preset) {
    if (!entry || !entry.ctx) return;
    // Only reconfigure when the preset actually changed. syncAllVideos calls this
    // on every scan; re-running setValueAtTime on the compressor/EQ each pass
    // re-triggers the dynamics envelope and pumps the audio up and down ("a filter
    // getting applied and unapplied"). Skip when nothing changed.
    if (entry._unPreset === preset) return;
    entry._unPreset = preset;
    const ctx = entry.ctx;
    const t = ctx.currentTime;

    // 1. Configure filterLow (lowshelf EQ)
    if (entry.filterLow) {
      if (preset === 'smart-enhance') {
        entry.filterLow.type = 'lowshelf';
        entry.filterLow.frequency.setValueAtTime(120, t);
        rampParam(entry.filterLow.gain, 2.5, t);   // reduced from 3.5 to avoid muddiness
      } else if (preset === 'bass-boost') {
        entry.filterLow.type = 'lowshelf';
        entry.filterLow.frequency.setValueAtTime(150, t);
        rampParam(entry.filterLow.gain, 8, t);
      } else if (preset === 'cinematic') {
        // Cinematic: a wide "smile" curve — weight under the dialogue and air
        // above it — plus levelling that keeps quiet dialogue audible without
        // flattening the loud moments. Shelf sits at 90Hz rather than 150 so
        // it lifts the body of the mix instead of only the sub, which is what
        // makes a boost sound boomy on speakers with a real low end.
        entry.filterLow.type = 'lowshelf';
        entry.filterLow.frequency.setValueAtTime(90, t);
        rampParam(entry.filterLow.gain, 5.5, t);
      } else {
        // Bypass
        rampParam(entry.filterLow.gain, 0, t);
      }
    }

    // 2. Configure filterMid (peaking / highshelf EQ)
    if (entry.filterMid) {
      if (preset === 'smart-enhance') {
        entry.filterMid.type = 'peaking';
        entry.filterMid.frequency.setValueAtTime(3000, t);  // boosted to presence range instead of 2kHz
        entry.filterMid.Q.setValueAtTime(0.7, t);           // wider Q — less harsh
        rampParam(entry.filterMid.gain, 3.5, t);            // reduced from 4.5
      } else if (preset === 'vocal-boost') {
        entry.filterMid.type = 'peaking';
        entry.filterMid.frequency.setValueAtTime(2000, t);
        entry.filterMid.Q.setValueAtTime(1.0, t);
        rampParam(entry.filterMid.gain, 6, t);
      } else if (preset === 'treble-boost') {
        entry.filterMid.type = 'highshelf';
        entry.filterMid.frequency.setValueAtTime(3000, t);
        rampParam(entry.filterMid.gain, 6, t);
      } else if (preset === 'cinematic') {
        // Presence lift at 2.8kHz keeps dialogue intelligible over the bigger
        // low end. Kept moderate and wide (low Q) so it adds clarity rather
        // than the harsh edge a narrow boost up here produces.
        entry.filterMid.type = 'peaking';
        entry.filterMid.frequency.setValueAtTime(2800, t);
        entry.filterMid.Q.setValueAtTime(0.6, t);
        rampParam(entry.filterMid.gain, 3, t);
      } else {
        // Bypass
        rampParam(entry.filterMid.gain, 0, t);
      }
    }

    // 3. Configure compressorNode.
    // CRITICAL: always set attack + release explicitly. Chrome's defaults (3ms attack,
    // 250ms release) cause audible pumping on transients — especially noticeable when
    // quality changes, buffering events, or frequent updates trigger gain swings.
    // Slower attack (30ms+) lets transients through naturally; slower release (400ms+)
    // prevents the "breathing" artifact between quiet and loud sections.
    if (entry.compressor) {
      if (preset === 'smart-enhance') {
        // Gentle levelling — high threshold so it only catches the loudest spikes.
        // Fast enough to smooth peaks, slow enough not to pump on normal speech.
        rampParam(entry.compressor.threshold, -14, t);       // raised from -24 to only catch true peaks
        entry.compressor.ratio.setValueAtTime(2.5, t);       // gentle ratio
        entry.compressor.knee.setValueAtTime(18, t);         // wide soft knee — smooth onset
        entry.compressor.attack.setValueAtTime(0.040, t);    // 40ms — lets transients through
        entry.compressor.release.setValueAtTime(0.500, t);   // 500ms — slow fade-back, no pumping
      } else if (preset === 'vocal-boost') {
        rampParam(entry.compressor.threshold, -18, t);
        entry.compressor.ratio.setValueAtTime(2.5, t);
        entry.compressor.knee.setValueAtTime(10, t);
        entry.compressor.attack.setValueAtTime(0.020, t);    // 20ms — tighter for speech
        entry.compressor.release.setValueAtTime(0.350, t);   // 350ms
      } else if (preset === 'cinematic') {
        // Film mixes have a huge dynamic range — whispered dialogue then an
        // explosion. Moderate levelling pulls the quiet parts up without
        // squashing the peaks flat, which is the whole point of the mode.
        rampParam(entry.compressor.threshold, -22, t);
        entry.compressor.ratio.setValueAtTime(3, t);
        entry.compressor.knee.setValueAtTime(24, t);
        entry.compressor.attack.setValueAtTime(0.025, t);
        entry.compressor.release.setValueAtTime(0.450, t);
      } else if (preset === 'compressor') {
        // "Night mode" — aggressive levelling for late-night watching
        rampParam(entry.compressor.threshold, -35, t);
        entry.compressor.ratio.setValueAtTime(10, t);        // reduced from 12 (less clamp)
        entry.compressor.knee.setValueAtTime(30, t);
        entry.compressor.attack.setValueAtTime(0.005, t);    // 5ms — catches peaks fast
        entry.compressor.release.setValueAtTime(0.600, t);   // 600ms — very slow release to prevent pumping
      } else {
        // Bypass compressor — set to values that have no effect
        rampParam(entry.compressor.threshold, 0, t);
        entry.compressor.ratio.setValueAtTime(1, t);
        entry.compressor.knee.setValueAtTime(0, t);
        entry.compressor.attack.setValueAtTime(0.003, t);    // Chrome default
        entry.compressor.release.setValueAtTime(0.250, t);   // Chrome default
      }
    }

    // 4. Configure monoNode
    if (entry.mono) {
      if (preset === 'mono') {
        entry.mono.channelCount = 1;
        entry.mono.channelCountMode = 'explicit';
      } else {
        entry.mono.channelCount = 2;
        entry.mono.channelCountMode = 'max';
      }
    }
  }

  function attachVideo(video) {
    if (!video || graphs.has(video) || video.dataset.unVolGraph) return;
    // Defer Web Audio until boost (>100%) or a non-Off EQ preset is needed.
    // createMediaElementSource can only run once per element and routes all
    // playback through an AudioContext — leave YouTube native when idle.
    if (!(gainPct > 100 || (activePreset && activePreset !== 'normal'))) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaElementSource(video);

      const filterLow = ctx.createBiquadFilter();
      const filterMid = ctx.createBiquadFilter();
      const compressor = ctx.createDynamicsCompressor();
      const mono = ctx.createGain();
      const gain = ctx.createGain();

      gain.gain.value = gainValue(gainPct);

      // Connect pipeline
      src.connect(filterLow);
      filterLow.connect(filterMid);
      filterMid.connect(compressor);
      compressor.connect(mono);
      mono.connect(gain);
      gain.connect(ctx.destination);

      const onPlay = function () {
        if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      };
      const entry = {
        ctx: ctx,
        filterLow: filterLow,
        filterMid: filterMid,
        compressor: compressor,
        mono: mono,
        gain: gain,
        onPlay: onPlay
      };
      applyPresetToGraph(entry, activePreset);

      graphs.set(video, entry);
      liveGraphs.set(video, entry);
      audioCtxs.add(ctx);
      video.dataset.unVolGraph = '1';
      video.addEventListener('play', onPlay, { once: false });
    } catch (e) {
      /* createMediaElementSource failed (element already wired) — no graph, so
         native volume is the only control. Only impose it once we've adopted a
         real level (mirrors syncAllVideos); never force 0 on a fresh/muted load. */
      if (adopted && gainPct <= 100) {
        try {
          video.volume = gainPct / 100;
        } catch (err) {
          /* ignore */
        }
      }
    }
  }

  // Listen for native volume changes once per element (works whether or not a
  // Web Audio graph was built). Handler kept on the element for teardown.
  function ensureVolListener(v) {
    if (v._unVolH) return;
    const h = function () { syncFromNative(v); };
    v._unVolH = h;
    v.addEventListener('volumechange', h);
    listenedMedia.add(v);
  }

  function cleanupDetachedMedia() {
    const now = Date.now();
    listenedMedia.forEach(function (v) {
      if (v && v.isConnected) { try { delete v._unVolDetachedAt; } catch (e) {} return; }
      if (v && !v._unVolDetachedAt) { v._unVolDetachedAt = now; return; }
      if (v && now - v._unVolDetachedAt < 30000) return;
      if (v && v._unVolH) {
        try { v.removeEventListener('volumechange', v._unVolH); } catch (e) {}
        try { delete v._unVolH; } catch (e) {}
      }
      listenedMedia.delete(v);
    });
    liveGraphs.forEach(function (g, v) {
      if (v && v.isConnected) { delete g.detachedAt; return; }
      if (!g.detachedAt) { g.detachedAt = now; return; }
      if (now - g.detachedAt < 30000) return;
      if (g.onPlay && v) { try { v.removeEventListener('play', g.onPlay); } catch (e) {} }
      graphs.delete(v);
      liveGraphs.delete(v);
      audioCtxs.delete(g.ctx);
      try { g.ctx.close().catch(function () {}); } catch (e) {}
    });
  }

  // Settle on the level for this page, once, the first time media is seen.
  //
  // This USED to adopt YouTube's own native volume as our level, on the theory
  // that YouTube should stay the source of truth for 0–100%. That theory is
  // wrong once the extension has a level of its own, and it broke both of the
  // level features outright — confirmed live in the browser, twice:
  //   - the configured default (25%) was adopted straight back to 100% on
  //     every load, so the setting appeared to do nothing;
  //   - a level remembered for the host resolved from storage correctly as
  //     70%, then got adopted back to 100% in the very same tick, and the
  //     100 was persisted over the real value.
  // By the time this runs we always have an authoritative level — restored
  // from storage, or the configured default when there was nothing to restore
  // — so the correct direction is to PUSH ours onto the player.
  //
  // Genuine user changes still flow the other way: syncFromNative() mirrors
  // slider drags and mute back into our level, and it is the thing that keeps
  // YouTube's UI and ours in agreement after load.
  let adopted = false;
  function maybeAdoptNative() {
    // The stored level hasn't resolved yet — imposing the placeholder now
    // would fight the restore that's about to land, and could be saved over
    // the real value.
    if (!levelLoaded) return;
    if (adopted) return;
    adopted = true;
    pushNativeToYouTube(gainPct);
    updateUi();
  }

  function isYouTubeHost() {
    return /(^|\.)youtube\.com$/.test(location.hostname) || location.hostname === 'music.youtube.com';
  }

  /**
   * Prefer the real watch/shorts/music player — never wire Web Audio onto every
   * hover-preview / related / ad <video>, which are short-lived and expensive.
   */
  function mediaTargets() {
    if (isYouTubeHost()) {
      const seen = new Set();
      const out = [];
      const selectors = [
        '#movie_player video.html5-main-video',
        '#movie_player video',
        '#shorts-player video',
        'ytd-player#ytd-player video.html5-main-video',
        'ytmusic-player-bar video',
        'ytmusic-player video'
      ];
      for (let i = 0; i < selectors.length; i++) {
        document.querySelectorAll(selectors[i]).forEach(function (v) {
          if (!v || seen.has(v)) return;
          seen.add(v);
          out.push(v);
        });
        if (out.length) break; // first matching selector group is enough
      }
      return out;
    }
    // Off YouTube: still boost page media, but skip silent/hidden preview nodes.
    return Array.prototype.slice.call(document.querySelectorAll('video, audio')).filter(function (v) {
      if (!v) return false;
      if (v.muted && (v.paused || v.readyState < 2)) return false;
      if (v.offsetWidth < 2 && v.offsetHeight < 2) return false;
      return true;
    });
  }

  function syncAllVideos() {
    cleanupDetachedMedia();
    const list = mediaTargets();
    maybeAdoptNative(list);
    // Only write our level back to the element once we know what the level
    // should BE. Before that, a transient 0 on load would get re-imposed every
    // scan and fight the user.
    //
    // `adopted` covers the case where we took YouTube's own volume as our
    // level. `levelLoaded` covers the other one: a level restored from storage
    // (or the configured default) is equally authoritative and must be
    // enforced too. Without it, `enforce` stayed false for any restored level
    // at or below 100 — so a remembered 70% resolved correctly, logged
    // correctly, and was then never actually written to the element. Confirmed
    // live: loadStored() returned 70 while the video sat at 100 forever.
    const enforce = adopted || levelLoaded || gainPct > 100;
    const wantGraph = gainPct > 100 || (activePreset && activePreset !== 'normal');
    list.forEach(function (v) {
      if (wantGraph) attachVideo(v);
      ensureVolListener(v);
      const g = graphs.get(v);
      // ALWAYS keep the graph's context running. createMediaElementSource routes
      // the element's audio through the graph, so a suspended context = silence
      // even when volume is up. This must not be gated behind `enforce`.
      if (g && g.ctx && g.ctx.state === 'suspended') g.ctx.resume().catch(function () {});
      // Guard applyLevel: the inner check (> 0.002) handles native volume, but we
      // also guard the gain-node write here so repeated scans at the same level
      // don't keep re-setting the Web Audio gain value (which can interact with
      // the compressor's envelope and cause subtle pumping artifacts).
      if (enforce) {
        const wantBoost = typeof UNVolumeLevel !== 'undefined' ? UNVolumeLevel.computeBoostGain(gainPct) : (gainPct > 100 ? gainPct / 100 : 1);
        if (g && g.gain && Math.abs(g.gain.gain.value - wantBoost) > 0.001) {
          applyLevel(v, g, gainPct);
        } else if (!g || !g.gain) {
          applyLevel(v, g, gainPct);
        }
      }
      if (g && wantGraph) applyPresetToGraph(g, activePreset);
    });
  }

  // Mirror the 0–100 portion of our level onto YouTube's own player via the
  // MAIN-world bridge (ai-bridge.js). Without this, YouTube's native slider
  // never tracks our boost bar / scroll-to-volume, and YouTube re-asserts its
  // stale value back onto the element. Boost (>100) pins YouTube at 100; the
  // Web Audio gain node carries the rest. No-op off youtube.com — applyLevel
  // drives those sites through element.volume directly.
  // rAF-coalesced so a fast scroll (many setGain calls per frame) sends ONE
  // postMessage with the latest level, not one per wheel tick.
  let nativePushPending = false;
  let nativePushPct = 100;
  // YouTube's own movie_player.setVolume() (called by ai-bridge.js in response
  // to the UN_VOL_SET message below) does NOT reliably set the underlying
  // <video>.volume to the requested pct/100 — live-verified it can land on a
  // different value entirely (observed: requesting 87 produced a real
  // video.volume of ~0.668, while movie_player.getVolume() still correctly
  // reported 87 — YouTube's internal state and the raw element diverge). That
  // stray volumechange event would otherwise be indistinguishable from a real
  // user drag to syncFromNative below, which "adopts" it and silently
  // overwrites the correct level we just set. Suppress adoption for a short
  // window after every native push — long enough to cover the postMessage +
  // YouTube-internal round trip, short enough to never miss a genuine
  // in-between user action.
  let suppressNativeSyncUntil = 0;
  function pushNativeToYouTube(pct) {
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
    nativePushPct = Math.min(100, Math.max(0, Math.round(pct)));
    suppressNativeSyncUntil = Date.now() + 500;
    if (nativePushPending) return;
    nativePushPending = true;
    requestAnimationFrame(function () {
      nativePushPending = false;
      try {
        window.postMessage({ type: 'UN_VOL_SET', pct: nativePushPct }, '*');
      } catch (e) {
        /* ignore — bridge not present */
      }
      // The suppression above stops the wrong value from being adopted back
      // into gainPct, but does nothing to fix video.volume itself — YouTube's
      // setVolume() already wrote its own (wrong) value directly to the
      // element by then. Re-assert the real level once that side effect has
      // had time to land, so the actual audio output matches what's
      // displayed, not just the internal state.
      setTimeout(function () {
        syncAllVideos();
      }, 250);
    });
  }

  function setGain(pct, animate) {
    const p = prefs();
    gainPct = typeof UNVolumeLevel !== 'undefined'
      ? UNVolumeLevel.clampGain(pct, p.boostMax)
      : Math.max(0, Math.min(p.boostMax, Math.round(pct)));
    adopted = true; // an explicit choice; don't re-adopt the native volume over it

    syncAllVideos();
    pushNativeToYouTube(gainPct); // keep YouTube's native slider/state in lockstep
    saveStored(gainPct);
    updateUi(animate);
  }

  function setPreset(preset) {
    activePreset = preset || 'normal';
    saveStoredPreset(activePreset);
    syncAllVideos(); // may lazily create Web Audio when leaving Off
    syncAllPresets();
  }

  function syncAllPresets() {
    mediaTargets().forEach(function (v) {
      const g = graphs.get(v);
      if (g) applyPresetToGraph(g, activePreset);
    });
  }

  function updateUi(animate) {
    updateInline(animate); // independent of the player-bar control
    if (uiRoot) {
      // The bar button is icon-only (see ensurePlayerControl), so the current
      // level lives in the tooltip and the accessible name rather than in a
      // text span that would widen the button.
      uiRoot.title = 'Tab volume ' + gainPct + '% — scroll to adjust (Unsynth)';
      uiRoot.setAttribute('aria-label', 'Volume boost, ' + gainPct + '%');
      uiRoot.classList.toggle('boosted', gainPct > 100);
      uiRoot.classList.toggle('muted', gainPct === 0);
    }
    if (!popRoot) return;
    const slider = popRoot.querySelector('.un-vol-slider');
    if (slider) {
      slider.setAttribute('max', String(prefs().boostMax));
      slider.value = String(gainPct);
    }
    // Highlight the matching preset button
    popRoot.querySelectorAll('.un-vol-preset').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-v')) === gainPct);
    });
    popRoot.querySelectorAll('.un-vol-eqbtn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-preset') === activePreset);
    });
  }

  const VOL_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.06c1.48-.74 2.5-2.26 2.5-4.03z"/></svg>';

  // Registered through core.addPlayerButton() — not a direct
  // host.insertBefore(el, host.firstChild) — so it participates in the same
  // coordinated ordering AND overflow-collapse system every other Unsynth
  // player button does. An earlier fix here only patched the insertion-order
  // RACE (this used to fight core.js for host.firstChild); it never actually
  // registered the control with core._playerBtns, so it still counted toward
  // .ytp-right-controls' width (forcing OTHER buttons to collapse) but could
  // never itself be chosen as a collapse victim — confirmed live, the same
  // "bypasses the coordinator" defect quality-lock.js had, just with the
  // symptom patched instead of the root cause. addPlayerButton() only
  // supports a plain SVG button (no popover child), so the slider/EQ panel
  // is now a separate, body-level element positioned off the button's own
  // getBoundingClientRect() — the exact pattern core.js's own "Unsynth
  // tools" dropdown already uses for _openMenu()/_positionMenu() (see
  // core.js) — rather than nesting interactive content inside a <button>,
  // which the HTML content model disallows anyway.
  function ensurePlayerControl() {
    if (!prefs().showPlayerControl) {
      if (window.UNSYNTH && window.UNSYNTH.removePlayerButton) window.UNSYNTH.removePlayerButton('un-vol-btn');
      uiRoot = null;
      closePopover();
      return;
    }
    if (!window.UNSYNTH || !window.UNSYNTH.addPlayerButton) return;
    window.UNSYNTH.addPlayerButton({
      id: 'un-vol-btn',
      // Icon only. This used to append a live "<span class=un-vol-label>NN%
      // </span>", which made a 48px icon slot into a wide text chip — part of
      // why Unsynth occupied 480px of the control bar against YouTube's own
      // 240px. The current level now rides in the title/aria-label (updated on
      // every change by updateUi) and in the popover, so nothing is lost from
      // the readout; it just stops consuming bar width to say it.
      svg: VOL_ICON_SVG,
      title: 'Tab volume ' + gainPct + '% — scroll to adjust (Unsynth)',
      ariaLabel: 'Volume boost, ' + gainPct + '%',
      onClick: function (e) {
        e.stopPropagation();
        togglePopover();
      },
      cls: 'un-vol-ctrl un-vol-btn',
      priority: 33
    });
    const btn = document.getElementById('un-vol-btn');
    const isFresh = btn && btn !== uiRoot;
    uiRoot = btn;
    if (isFresh) {
      btn.setAttribute('aria-expanded', 'false');
      // Scroll wheel on the control — same ±2% step as scroll-over-player in
      // ui-tune.js (WHEEL_VOL_STEP); the two must agree or the same gesture
      // moves volume at two different rates depending on cursor position.
      // addPlayerButton() only attaches the onClick from its spec on first
      // creation — this listener needs the same first-creation-only guard.
      btn.addEventListener('wheel', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const delta = (e.deltaY < 0 ? 1 : -1) * WHEEL_VOL_STEP;
        setGain(gainPct + delta);
      }, { passive: false });
    }
    if (!docCloseBound) {
      document.addEventListener('click', onDocCloseClick);
      document.addEventListener('keydown', onDocCloseKey);
      docCloseBound = true;
    }
    updateUi();
  }

  function positionPopover() {
    if (!popRoot || !uiRoot) return;
    const r = uiRoot.getBoundingClientRect();
    popRoot.style.position = 'fixed';
    popRoot.style.bottom = window.innerHeight - r.top + 8 + 'px';
    popRoot.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  }

  function openPopover() {
    if (popRoot || !uiRoot) return;
    popRoot = document.createElement('div');
    popRoot.className = 'un-vol-pop';
    popRoot.innerHTML =
      '<input type="range" class="un-vol-slider" min="0" max="' +
      prefs().boostMax +
      '" step="1" value="' +
      gainPct +
      '" aria-label="Volume level" />' +
      '<div class="un-vol-presets">' +
      ['0', '50', '100', '200', '400', '600'].map(function (n) {
        return '<button type="button" class="un-vol-preset" data-v="' + n + '">' + n + '%</button>';
      }).join('') +
      '</div>' +
      '<div class="un-vol-eq-label">Audio preset</div>' +
      '<div class="un-vol-eq">' +
      [['smart-enhance', 'Smart'], ['bass-boost', 'Bass'], ['vocal-boost', 'Vocal'], ['treble-boost', 'Treble'], ['compressor', 'Night'], ['mono', 'Mono'], ['normal', 'Off']]
        .map(function (p) {
          return '<button type="button" class="un-vol-eqbtn" data-preset="' + p[0] + '">' + p[1] + '</button>';
        }).join('') +
      '</div>';

    const slider = popRoot.querySelector('.un-vol-slider');
    slider.addEventListener('input', function () {
      setGain(Number(slider.value));
    });
    popRoot.querySelectorAll('.un-vol-preset').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        setGain(Number(b.getAttribute('data-v')));
      });
    });
    popRoot.querySelectorAll('.un-vol-eqbtn').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        setPreset(b.getAttribute('data-preset'));
        updateUi();
      });
    });

    document.body.appendChild(popRoot);
    positionPopover();
    popResizeHandler = positionPopover;
    window.addEventListener('resize', popResizeHandler);
    uiRoot.setAttribute('aria-expanded', 'true');
    updateUi();
  }

  function closePopover() {
    if (popResizeHandler) {
      window.removeEventListener('resize', popResizeHandler);
      popResizeHandler = null;
    }
    if (popRoot) {
      popRoot.remove();
      popRoot = null;
    }
    if (uiRoot) uiRoot.setAttribute('aria-expanded', 'false');
  }

  function togglePopover() {
    if (popRoot) closePopover();
    else openPopover();
  }

  const EQ_PRESETS = [
    ['cinematic', 'Cinema'], ['smart-enhance', 'Smart'], ['bass-boost', 'Bass'],
    ['vocal-boost', 'Vocal'], ['treble-boost', 'Treble'], ['compressor', 'Night'],
    ['mono', 'Mono'], ['normal', 'Off']
  ];

  // Always-visible volume bar baked into the watch page, just under the video.
  function ensureInlineControl() {
    if (!prefs().inlineBar || !(window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch')) {
      if (inlineRoot && inlineRoot.parentNode) inlineRoot.parentNode.removeChild(inlineRoot);
      inlineRoot = null;
      return;
    }
    // Preferred home: pinned to the top of the player as an auto-hiding overlay
    // (reads as part of the player chrome, follows it into theater/mini/fullscreen).
    // Fall back to a flow strip below the player if the player isn't mounted yet.
    const player = document.getElementById('movie_player');
    const overlay = !!player;
    if (inlineRoot && inlineRoot.isConnected) {
      // If we built the flow fallback before the player mounted, promote it to
      // the player overlay once the player is available.
      if (player && inlineRoot.parentNode !== player) {
        inlineRoot.classList.add('un-vol-inline--overlay');
        player.appendChild(inlineRoot);
      }
      updateInline();
      return;
    }
    const anchor =
      player ||
      document.querySelector('#above-the-fold') ||
      document.querySelector('ytd-watch-metadata');
    if (!anchor) return;
    if (document.getElementById('un-vol-inline')) { inlineRoot = document.getElementById('un-vol-inline'); updateInline(); return; }

    inlineRoot = document.createElement('div');
    inlineRoot.id = 'un-vol-inline';
    inlineRoot.className = 'un-vol-inline' + (overlay ? ' un-vol-inline--overlay' : '');
    inlineRoot.innerHTML =
      '<button type="button" class="un-vol-inline-ico" aria-label="Mute / unmute boost" title="Reset to 100%">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.06c1.48-.74 2.5-2.26 2.5-4.03z"/></svg></button>' +
      '<input type="range" class="un-vol-inline-slider" min="0" max="' + prefs().boostMax + '" step="1" value="' + gainPct + '" aria-label="Tab volume (percent)" />' +
      '<span class="un-vol-inline-val">' + gainPct + '%</span>' +
      '<div class="un-vol-inline-presets" role="group" aria-label="Audio preset">' +
      EQ_PRESETS.map(function (p) {
        return '<button type="button" class="un-vol-inline-eq" data-preset="' + p[0] + '">' + p[1] + '</button>';
      }).join('') +
      '</div>';

    const slider = inlineRoot.querySelector('.un-vol-inline-slider');
    slider.addEventListener('input', function () { setGain(Number(slider.value)); });
    inlineRoot.querySelector('.un-vol-inline-ico').addEventListener('click', function () {
      setGain(gainPct === 100 ? 0 : 100);
    });
    inlineRoot.querySelectorAll('.un-vol-inline-eq').forEach(function (b) {
      b.addEventListener('click', function () { setPreset(b.getAttribute('data-preset')); updateInline(); });
    });

    if (overlay) anchor.appendChild(inlineRoot);
    else anchor.insertBefore(inlineRoot, anchor.firstChild);
    updateInline();
  }

  function updateInline(animate) {
    if (!inlineRoot || !inlineRoot.isConnected) return;
    const slider = inlineRoot.querySelector('.un-vol-inline-slider');
    const val = inlineRoot.querySelector('.un-vol-inline-val');
    if (slider) { slider.setAttribute('max', String(prefs().boostMax)); slider.value = String(gainPct); }
    if (val) val.textContent = gainPct + '%';
    inlineRoot.classList.toggle('boosted', gainPct > 100);
    inlineRoot.classList.toggle('muted', gainPct === 0);
    inlineRoot.querySelectorAll('.un-vol-inline-eq').forEach(function (b) {
      var on = b.getAttribute('data-preset') === activePreset;
      b.classList.toggle('active', on);
      // Without this the "active" class was the only signal, so every preset
      // announced identically and the selected one was unknowable by ear.
      // aria-pressed rather than a radiogroup: these are already in a
      // role="group", and a radiogroup would owe arrow-key roving focus that
      // this control does not implement.
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    if (animate) {
      inlineRoot.classList.remove('un-vol-flash');
      // trigger reflow to restart animation
      void inlineRoot.offsetWidth;
      inlineRoot.classList.add('un-vol-flash');
    }
  }

  function destroy() {
    if (window.UNSYNTH && window.UNSYNTH.removePlayerButton) window.UNSYNTH.removePlayerButton('un-vol-btn');
    uiRoot = null;
    closePopover();
    if (inlineRoot && inlineRoot.parentNode) inlineRoot.parentNode.removeChild(inlineRoot);
    inlineRoot = null;
  }

  // Module switched off: restore unity gain on live media (so audio isn't left
  // boosted with no control) and remove the UI. gainPct/storage are untouched,
  // so re-enabling restores the remembered level.
  function teardown() {
    const media = new Set(Array.prototype.slice.call(document.querySelectorAll('video, audio')));
    listenedMedia.forEach(function (v) { media.add(v); });
    liveGraphs.forEach(function (_g, v) { media.add(v); });
    media.forEach(function (v) {
      const g = graphs.get(v);
      if (g) {
        try { applyGainToGraph(g, 100); } catch (e) {}
        if (g.onPlay) { try { v.removeEventListener('play', g.onPlay); } catch (e) {} }
        graphs.delete(v);
        liveGraphs.delete(v);
      }
      if (v._unVolH) { try { v.removeEventListener('volumechange', v._unVolH); } catch (e) {} delete v._unVolH; }
      listenedMedia.delete(v);
      if (v.dataset) delete v.dataset.unVolGraph;
    });
    // Close every AudioContext we opened so they don't count against Chrome's
    // per-tab limit after the module is disabled.
    audioCtxs.forEach(function (ctx) {
      try { ctx.close().catch(function () {}); } catch (e) {}
    });
    audioCtxs.clear();
    liveGraphs.clear();
    listenedMedia.clear();
    // Remove the document-level close handlers and the autonomous observer.
    document.removeEventListener('click', onDocCloseClick);
    document.removeEventListener('keydown', onDocCloseKey);
    docCloseBound = false;
    if (autonomousObserver) {
      autonomousObserver.disconnect();
      autonomousObserver = null;
    }
    adopted = false; // re-adopt YouTube's native volume if the module is re-enabled
    destroy();
    // Drop the global so scroll-to-volume / other modules can't resurrect graphs
    // after this module is disabled.
    try { delete window.UNVolume; } catch (e) { window.UNVolume = undefined; }
  }

  function startAutonomousObserver() {
    if (autonomousObserver) return;
    // Debounce mutations — one syncAllVideos per frame is plenty. Skip work in
    // background tabs so non-YouTube browsing stays light.
    let rafPending = false;
    autonomousObserver = new MutationObserver(function () {
      if (document.hidden) return;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        if (!document.hidden) syncAllVideos();
      });
    });
    autonomousObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function autonomousInit() {
    const defaults = (window.UNSYNTH_DEFAULTS && window.UNSYNTH_DEFAULTS.volumeMaster) || {};
    chrome.storage.sync.get({ volumeMaster: defaults }, (res) => {
      globalSettings = res.volumeMaster || {};
      Promise.all([loadStored(), loadStoredPreset()]).then(function (res2) {
        gainPct = res2[0];
        activePreset = res2[1];
        levelLoaded = true; // adoption may now run against a real level
        handoffStartupGuard(gainPct);
        syncAllVideos();
        pushNativeToYouTube(gainPct); // same reconcile as mod.init — see there
        startAutonomousObserver();
      });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.volumeMaster) {
        globalSettings = changes.volumeMaster.newValue || {};
        syncAllVideos();
      }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'unsynth-vol-get') {
        sendResponse({
          gain: gainPct,
          max: prefs().boostMax,
          preset: activePreset,
          scrollToVolume: false,
          rememberLevel: prefs().rememberLevel,
          showPlayerControl: false
        });
        return false;
      }
      if (msg.type === 'unsynth-vol-set') {
        setGain(msg.gain);
        sendResponse({ ok: true, gain: gainPct });
        return false;
      }
      if (msg.type === 'unsynth-preset-set') {
        setPreset(msg.preset);
        sendResponse({ ok: true, preset: activePreset });
        return false;
      }
    });
  }

  // Shared in-page API so sibling modules (e.g. ui-tune's scroll-to-volume HUD)
  // drive the SAME boost level this bar shows, instead of a competing native
  // volume — keeps the top overlay bar and the scroll readout in lockstep.
  function exposeUNVolume() {
    window.UNVolume = {
      getGain: function () { return gainPct; },
      setGain: function (p, animate) { setGain(p, animate); },
      getMax: function () { return prefs().boostMax; }
    };
  }
  exposeUNVolume();

  const mod = {
    id: 'volumeMaster',
    moduleKey: 'volumeMaster',
    init: function (c) {
      core = c;
      cfg = prefs();
      exposeUNVolume();
      Promise.all([loadStored(), loadStoredPreset()]).then(function (res) {
        gainPct = res[0];
        activePreset = res[1];
        levelLoaded = true; // adoption may now run against a real level
        handoffStartupGuard(gainPct);
        syncAllVideos();
        // Push the RESTORED level into YouTube's own player state too, not
        // just onto the <video> element.
        //
        // syncAllVideos() writes element.volume, which is the audio path, but
        // movie_player keeps a separate internal level that drives its own
        // slider — and it starts from YouTube's remembered value, not ours.
        // Without this the two never reconcile on load: measured live on a
        // fresh watch page, the extension showed 24%, element.volume was 0.24,
        // and movie_player.getVolume()/the native slider both said 49. Every
        // user-initiated change already pushes (see setGain); only the restore
        // path did not, which is why it looked like the setting was ignored.
        pushNativeToYouTube(gainPct);
        ensurePlayerControl();
        ensureInlineControl();
      });
    },
    scan: function () {
      cfg = prefs();
      cleanupDetachedMedia();
      const list = mediaTargets();
      const cur = list[0] || null;
      if (cur !== lastVolMedia) {
        lastVolMedia = cur;
        syncAllVideos();
      }
      ensurePlayerControl();
      ensureInlineControl();
    },
    onNavigate: function () {
      lastVolMedia = null;
      syncAllVideos();
      ensurePlayerControl();
      ensureInlineControl();
    },
    onSettings: function (s) {
      core.settings = s;
      cfg = prefs();
      exposeUNVolume();
      syncAllVideos();
      ensurePlayerControl();
      ensureInlineControl();
    },
    onMessage: function (msg, sendResponse) {
      if (msg.type === 'unsynth-vol-get') {
        sendResponse({
          gain: gainPct,
          max: prefs().boostMax,
          preset: activePreset,
          scrollToVolume: (core && core.settings && core.settings.ui && core.settings.ui.scrollToVolume) !== false,
          rememberLevel: prefs().rememberLevel,
          showPlayerControl: prefs().showPlayerControl
        });
        return false;
      }
      if (msg.type === 'unsynth-vol-set') {
        setGain(msg.gain);
        sendResponse({ ok: true, gain: gainPct });
        return false;
      }
      if (msg.type === 'unsynth-preset-set') {
        setPreset(msg.preset);
        sendResponse({ ok: true, preset: activePreset });
        return false;
      }
    },
    teardown: teardown
  };

  if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  } else {
    autonomousInit();
  }
})();
