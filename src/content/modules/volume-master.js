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
  // Why the last Web Audio attach failed, for the popup's status line.
  let lastAttachError = '';
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

  /**
   * MAKEUP GAIN, MEASURED (2026-10-02). Chrome's DynamicsCompressorNode adds
   * automatic makeup gain derived from threshold, knee and ratio. Measured live
   * on a real video, every compressor preset was simply LOUDER than Off: Night
   * +6.8 dB flat across every band (the opposite of a night mode), Cinema
   * +5.6, Vocal +5.2, Smart +3.4. Louder always wins a quick A/B, so the
   * presets sounded better for the wrong reason.
   *
   * The makeup gain is a fixed function of those settings, so measure it the
   * way Chrome computes it: render a -60 dBFS tone (far below every threshold,
   * so nothing is compressed) through a compressor with the same settings, and
   * the output level IS the makeup gain. The trim node after the compressor
   * applies the inverse. Quiet passages then come out at the level they went
   * in, and the compressor only does its job: bringing loud passages down.
   */
  const makeupCache = new Map();
  function makeupGainFor(c) {
    const key = [c.threshold, c.ratio, c.knee].join('/');
    if (makeupCache.has(key)) return makeupCache.get(key);
    const job = new Promise(function (resolve) {
      try {
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!OAC) { resolve(1); return; }
        const rate = 48000;
        const off = new OAC(1, Math.round(rate * 0.3), rate);
        const osc = off.createOscillator();
        osc.frequency.value = 1000;
        const level = off.createGain();
        level.gain.value = 0.001; // -60 dBFS peak
        const comp = off.createDynamicsCompressor();
        comp.threshold.value = c.threshold;
        comp.ratio.value = c.ratio;
        comp.knee.value = c.knee;
        comp.attack.value = c.attack;
        comp.release.value = c.release;
        osc.connect(level); level.connect(comp); comp.connect(off.destination);
        osc.start(0);
        off.startRendering().then(function (buf) {
          const d = buf.getChannelData(0);
          const from = Math.round(rate * 0.2);
          let sum = 0;
          for (let k = from; k < d.length; k++) sum += d[k] * d[k];
          const rms = Math.sqrt(sum / (d.length - from));
          const g = rms / (0.001 / Math.SQRT2);
          resolve(isFinite(g) && g > 0 ? g : 1);
        }, function () { resolve(1); });
      } catch (e) {
        resolve(1);
      }
    });
    makeupCache.set(key, job);
    return job;
  }

  /* ==========================================================================
     THE AUDIO CHAIN, v2 (2026-10-02)

     User report on v1: it changed the sound a little, and not for the
     better. v1 was one or two biquads and a compressor per preset. Measured
     honestly (make-up gain cancelled) it changed little, and what it changed
     was not what commercial enhancers do. v2 follows the established designs:

     - DIALOGUE comes from the centre of the stereo image. TV clear-voice modes
       lift the centre (mid) against the sides and add ~2.85 kHz presence
       (US8238560; EUSIPCO 2015 dialogue enhancement). A mid/side matrix here
       turns the sides down for Vocal and up (wider) for Cinema.
     - BASS ON SMALL SPEAKERS is psychoacoustic. Laptop drivers cannot play
       40-120 Hz, so a shelf there is inaudible on them. A virtual-bass branch
       generates harmonics of the low band (the "missing fundamental") that
       small drivers can play, and the ear hears the bass note.
     - NIGHT raises quiet passages and lowers loud ones around the average.
       The leveller's trim pivots at -20 dBFS pink noise, so the average stays
       put, quiet dialogue comes up and explosions come down.
     - EVERY PRESET IS LOUDNESS-MATCHED to Off: an offline copy of this exact
       chain renders K-weighted pink noise and the output trim cancels the
       difference. What changes is the sound, not the volume, so an A/B
       comparison is fair.
     - A LIMITER at the very end catches the 150-600% boost before it clips.

     Graph: src -> 10-band graphic EQ (31 Hz-16 kHz) -> sum
            (+ low band -> rectifier -> highpass -> virtual-bass gain -> sum)
            -> stereo up-mix -> mid/side (side split at 150 Hz) -> leveller -> trim
            -> mono -> boost gain -> limiter -> limiter trim -> speakers
     ========================================================================== */
  // TONE IS A 10-BAND GRAPHIC EQ (2026-10-02), at the ISO octave centres every
  // graphic equaliser uses (Equalizer APO / Peace, hardware 1/1-octave EQs),
  // so each preset is a curve that can be read and compared like one, and the
  // Custom preset uses the same engine. Peaking bands, one octave wide.
  //
  // Presets were checked against how real gear sets these modes:
  // - Cinema follows THX Re-EQ / Denon Cinema EQ: home rooms make film mixes
  //   bright, so it CUTS the top (-2 at 8 kHz, -3 at 16 kHz). The v2 chain
  //   boosted it, the opposite of every cinema mode in a receiver.
  // - Width only above 150 Hz when widening: the side signal is split by a
  //   Linkwitz-Riley crossover and only the top is widened, so bass stays
  //   mono (the standard mono-compatibility rule for wideners).
  // - Dialogue: sides down (centre focus), mud cut, 2-4 kHz up (TV clear-voice).
  // - Night: strong levelling around a pivot (Dolby volume leveller idea).
  const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_Q = 1.41; // one octave
  const FLAT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  // vb: a half-wave rectifier turns ~0.21 of a low note into its 2nd
  // harmonic, so vb 2.4 puts that harmonic near -6 dB of the low band, the
  // usual virtual-bass design point (2nd -6, 3rd -12, 4th -18 dB).
  // eq: dB per band; width: side gain (above 150 Hz when > 1, all bands when
  // < 1); vb: virtual-bass level; lev: leveller (null = off).
  const PRESETS = {
    normal: { eq: FLAT, width: 1, vb: 0, lev: null },
    cinematic: { eq: [3, 4, 3, 0, -1, 0, 1, 0, -2, -3], width: 1.35, vb: 0.9,
      lev: { threshold: -24, ratio: 2.5, knee: 12, attack: 0.020, release: 0.300 } },
    'smart-enhance': { eq: [1, 1, 1, -1, -1, 0, 1, 1, 0, 0], width: 1.1, vb: 0.45,
      lev: { threshold: -22, ratio: 2, knee: 18, attack: 0.030, release: 0.400 } },
    'bass-boost': { eq: [5, 6, 5, 2, 0, 0, 0, 0, 0, 0], width: 1, vb: 2.4,
      lev: { threshold: -18, ratio: 2, knee: 12, attack: 0.030, release: 0.300 } },
    'vocal-boost': { eq: [-6, -4, -2, -2, 0, 1, 3, 4, 2, 0], width: 0.45, vb: 0,
      lev: { threshold: -24, ratio: 2, knee: 12, attack: 0.015, release: 0.300 } },
    'treble-boost': { eq: [0, 0, 0, 0, 0, 0, 1, 3, 5, 6], width: 1, vb: 0, lev: null },
    compressor: { eq: [-3, -2, -1, 0, 0, 0, 1, 1, 0, 0], width: 0.85, vb: 0,
      lev: { threshold: -38, ratio: 8, knee: 20, attack: 0.004, release: 0.500 } },
    mono: { eq: FLAT, width: 1, vb: 0, lev: null, mono: true },
    custom: { eq: FLAT, width: 1, vb: 0, lev: null }
  };
  const LEV_BYPASS = { threshold: 0, ratio: 1, knee: 0, attack: 0.003, release: 0.250 };
  // -2 dBFS: at -1 the attack overshot to a 1.026 peak on a hot tone at 600%.
  const LIMITER = { threshold: -2, ratio: 20, knee: 0, attack: 0.002, release: 0.100 };
  // The Custom curve, from settings (volumeMaster.customEq), clamped to ±12 dB.
  function customCurve() {
    const raw = (core && core.settings && core.settings.volumeMaster && core.settings.volumeMaster.customEq) ||
      (globalSettings && globalSettings.customEq) || FLAT;
    return EQ_FREQS.map(function (_, i) { const v = Number(raw[i]); return isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0; });
  }
  function presetOf(name) {
    if (name === 'custom') return Object.assign({}, PRESETS.custom, { eq: customCurve() });
    return PRESETS[name] || PRESETS.normal;
  }
  // What identifies a preset's sound: Custom changes with its curve.
  function presetKey(name) { return name === 'custom' ? 'custom:' + customCurve().join(',') : name; }

  // Half-wave rectifier: positively homogeneous, so the harmonics it makes
  // track the input level linearly (no level-dependent distortion). It makes
  // even harmonics only: strong for 75-120 Hz notes, weak for 60 Hz.
  let rectCurve = null;
  function rectifierCurve() {
    if (rectCurve) return rectCurve;
    const n = 2049;
    rectCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; rectCurve[i] = x > 0 ? x : 0; }
    return rectCurve;
  }

  /**
   * WHAT YOU SET IS WHAT YOU GET (2026-10-02). Octave-wide bands overlap, so
   * setting neighbours to 5, 6, 5 dB measured +7.7 and +10 dB (bands add up;
   * every graphic EQ has this interaction). The curve a preset or the Custom
   * sliders ask for is the RESPONSE wanted at each centre frequency, so solve
   * for the band gains that produce it: measure the summed response with the
   * biquads' own maths and correct, a few damped passes. Cached per curve.
   */
  const solveCache = new Map();
  let solveCtx = null;
  function solveEq(target) {
    const key = target.join(',');
    if (solveCache.has(key)) return solveCache.get(key);
    let gains = target.slice();
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!solveCtx) solveCtx = new OAC(1, 128, 48000);
      const freqs = new Float32Array(EQ_FREQS);
      const bands = EQ_FREQS.map(function (f) {
        const b = solveCtx.createBiquadFilter(); b.type = 'peaking'; b.frequency.value = f; b.Q.value = EQ_Q; return b;
      });
      const mag = new Float32Array(freqs.length);
      const ph = new Float32Array(freqs.length);
      for (let pass = 0; pass < 12; pass++) {
        const resp = new Float32Array(freqs.length);
        bands.forEach(function (b, j) {
          b.gain.value = gains[j];
          b.getFrequencyResponse(freqs, mag, ph);
          for (let k = 0; k < freqs.length; k++) resp[k] += 20 * Math.log10(mag[k]);
        });
        let worst = 0;
        gains = gains.map(function (gj, j) {
          const err = target[j] - resp[j];
          worst = Math.max(worst, Math.abs(err));
          return Math.max(-18, Math.min(18, gj + 0.7 * err));
        });
        if (worst < 0.05) break;
      }
    } catch (e) { gains = target.slice(); }
    solveCache.set(key, gains);
    return gains;
  }

  // LOWPASS/HIGHPASS Q IS IN DECIBELS in Web Audio (measured: Q = 0.707 put a
  // +0.71 dB bump at the cutoff). A Butterworth section is -3.0103 dB; with
  // 0.707 the crossover halves did not sum flat and Cinema's widening leaked
  // +1.8 dB of side into the bass it promises to keep mono. Peaking Q is the
  // ordinary bandwidth Q and is unaffected.
  const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);

  function biquad(ctx, type, f, q) {
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b;
  }

  /** Builds the preset-dependent part of the chain on any BaseAudioContext. */
  function buildChain(ctx) {
    const n = {};
    n.eq = EQ_FREQS.map(function (f) { return biquad(ctx, 'peaking', f, EQ_Q); });
    for (let i = 0; i < n.eq.length - 1; i++) n.eq[i].connect(n.eq[i + 1]);
    const eqOut = n.eq[n.eq.length - 1];
    n.sum = ctx.createGain();
    n.vbLp = biquad(ctx, 'lowpass', 120, BUTTERWORTH_Q_DB);
    n.vbShape = ctx.createWaveShaper(); n.vbShape.curve = rectifierCurve();
    n.vbHp = biquad(ctx, 'highpass', 150, BUTTERWORTH_Q_DB);
    n.vbGain = ctx.createGain(); n.vbGain.gain.value = 0;
    eqOut.connect(n.sum);
    eqOut.connect(n.vbLp); n.vbLp.connect(n.vbShape); n.vbShape.connect(n.vbHp); n.vbHp.connect(n.vbGain); n.vbGain.connect(n.sum);
    // Stereo up-mix, then mid/side: M = (L+R)/2, S = (L-R)/2.
    n.up = ctx.createGain(); n.up.channelCount = 2; n.up.channelCountMode = 'explicit'; n.up.channelInterpretation = 'speakers';
    n.split = ctx.createChannelSplitter(2);
    n.sum.connect(n.up); n.up.connect(n.split);
    const g = function (v) { const x = ctx.createGain(); x.gain.value = v; return x; };
    n.mid = g(1); n.side = g(1);
    const mL = g(0.5); const mR = g(0.5); const sL = g(0.5); const sR = g(-0.5);
    n.split.connect(mL, 0); n.split.connect(mR, 1); n.split.connect(sL, 0); n.split.connect(sR, 1);
    mL.connect(n.mid); mR.connect(n.mid); sL.connect(n.side); sR.connect(n.side);
    // Three side paths: direct (Off, narrowing), and a Linkwitz-Riley 4th-order
    // split at 150 Hz for widening only the top. LR4 low + high sum flat.
    n.sDirect = g(1);
    n.sLow = g(0); n.sHigh = g(0);
    const lp1 = biquad(ctx, 'lowpass', 150, BUTTERWORTH_Q_DB); const lp2 = biquad(ctx, 'lowpass', 150, BUTTERWORTH_Q_DB);
    const hp1 = biquad(ctx, 'highpass', 150, BUTTERWORTH_Q_DB); const hp2 = biquad(ctx, 'highpass', 150, BUTTERWORTH_Q_DB);
    n.side.connect(n.sDirect);
    n.side.connect(lp1); lp1.connect(lp2); lp2.connect(n.sLow);
    n.side.connect(hp1); hp1.connect(hp2); hp2.connect(n.sHigh);
    n.sideOut = g(1);
    n.sDirect.connect(n.sideOut); n.sLow.connect(n.sideOut); n.sHigh.connect(n.sideOut);
    // L' = M + S', R' = M - S'.
    n.outL = g(1); n.outR = g(1);
    const negS = g(-1);
    n.mid.connect(n.outL); n.mid.connect(n.outR);
    n.sideOut.connect(n.outL); n.sideOut.connect(negS); negS.connect(n.outR);
    n.merge = ctx.createChannelMerger(2);
    n.outL.connect(n.merge, 0, 0); n.outR.connect(n.merge, 0, 1);
    // The leveller has a real dry path. Chrome's compressor is not transparent
    // even at ratio 1 / threshold 0 (an impulse came out 14 dB down through
    // the "bypassed" node), so presets without levelling skip it entirely.
    n.lev = ctx.createDynamicsCompressor();
    n.levWet = g(0); n.levDry = g(1);
    n.trim = ctx.createGain();
    n.merge.connect(n.lev); n.lev.connect(n.levWet); n.levWet.connect(n.trim);
    n.merge.connect(n.levDry); n.levDry.connect(n.trim);
    n.input = n.eq[0]; n.output = n.trim;
    return n;
  }

  function setP(param, value, t, ramp) {
    if (!param) return;
    if (ramp) rampParam(param, value, t);
    else { try { param.setValueAtTime(value, t); } catch (e) { param.value = value; } }
  }
  /** Sets a chain's parameters for a preset (trim excluded: see loudnessTrimFor). */
  function configureChain(n, name, t, ramp) {
    const p = presetOf(name);
    const gains = solveEq(EQ_FREQS.map(function (_, i) { return p.eq[i] || 0; }));
    for (let i = 0; i < n.eq.length; i++) setP(n.eq[i].gain, gains[i], t, ramp);
    setP(n.vbGain.gain, p.vb, t, ramp);
    // Widening keeps the bass mono; narrowing narrows every band.
    if (p.width > 1) {
      setP(n.sDirect.gain, 0, t, ramp); setP(n.sLow.gain, 1, t, ramp); setP(n.sHigh.gain, p.width, t, ramp);
    } else {
      setP(n.sDirect.gain, p.width, t, ramp); setP(n.sLow.gain, 0, t, ramp); setP(n.sHigh.gain, 0, t, ramp);
    }
    setP(n.levWet.gain, p.lev ? 1 : 0, t, ramp);
    setP(n.levDry.gain, p.lev ? 0 : 1, t, ramp);
    const c = p.lev || LEV_BYPASS;
    setP(n.lev.threshold, c.threshold, t, ramp);
    setP(n.lev.ratio, c.ratio, t, false); setP(n.lev.knee, c.knee, t, false);
    setP(n.lev.attack, c.attack, t, false); setP(n.lev.release, c.release, t, false);
  }

  // K-weighting approximation (BS.1770 pre-filter + RLB), so the loudness match
  // follows what the ear hears rather than raw energy, which bass dominates.
  function kWeight(ctx) {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 60; hp.Q.value = 20 * Math.log10(0.5); // Q 0.5, in dB
    const sh = ctx.createBiquadFilter(); sh.type = 'highshelf'; sh.frequency.value = 1500; sh.gain.value = 4;
    hp.connect(sh);
    return { input: hp, output: sh };
  }
  let pinkBuf = null;
  function pinkNoise(ctx) {
    // Stereo pink noise (Kellet filter), mostly correlated between channels
    // like programme material, scaled to about -20 dBFS RMS.
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const gen = function () {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      }
      return out;
    };
    const centre = gen(); const l = gen(); const r = gen();
    const L = buf.getChannelData(0); const R = buf.getChannelData(1);
    let sum = 0;
    for (let i = 0; i < len; i++) { L[i] = centre[i] + 0.4 * l[i]; R[i] = centre[i] + 0.4 * r[i]; sum += L[i] * L[i]; }
    const scale = 0.1 / Math.sqrt(sum / len); // 0.1 RMS = -20 dBFS
    for (let i = 0; i < len; i++) { L[i] *= scale; R[i] *= scale; }
    return buf;
  }
  async function renderLoudness(name) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const rate = 48000;
    const off = new OAC(2, rate * 3, rate);
    if (!pinkBuf) pinkBuf = pinkNoise(off);
    const src0 = off.createBufferSource(); src0.buffer = pinkBuf;
    // Programme material carries more low end and less top than pink noise
    // (measured on a trailer: matching on plain pink left Treble 2.5 dB quiet
    // and Bass 1.9 dB loud), so tilt the reference toward it.
    const tLo = off.createBiquadFilter(); tLo.type = 'lowshelf'; tLo.frequency.value = 150; tLo.gain.value = 3;
    const tHi = off.createBiquadFilter(); tHi.type = 'highshelf'; tHi.frequency.value = 3000; tHi.gain.value = -6;
    src0.connect(tLo); tLo.connect(tHi);
    const src = { connect: function (d) { tHi.connect(d); }, start: function (t) { src0.start(t); } };
    const k = kWeight(off);
    if (name === null) {
      src.connect(k.input);
    } else {
      const n = buildChain(off);
      configureChain(n, name, 0, false);
      src.connect(n.input); n.output.connect(k.input);
    }
    k.output.connect(off.destination);
    src.start(0);
    const out = await off.startRendering();
    let sum = 0;
    let cnt = 0;
    for (let ch = 0; ch < 2; ch++) {
      const d = out.getChannelData(ch);
      for (let i = rate; i < d.length; i++) { sum += d[i] * d[i]; cnt++; } // skip the leveller's first second
    }
    return Math.sqrt(sum / cnt);
  }
  /**
   * The trim that makes a preset as loud as Off on K-weighted pink noise at
   * -20 dBFS: for the levelled presets this is also the pivot, so passages
   * quieter than that come up and louder ones come down.
   */
  const trimCache = new Map();
  function loudnessTrimFor(name) {
    const key = presetKey(name);
    if (trimCache.has(key)) return trimCache.get(key);
    const job = (async function () {
      try {
        if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext)) return 1;
        const ref = await renderLoudness(null);
        const got = await renderLoudness(name);
        const t = ref / got;
        return isFinite(t) && t > 0 ? Math.min(4, Math.max(0.25, t)) : 1;
      } catch (e) { return 1; }
    })();
    trimCache.set(key, job);
    return job;
  }

  // For the live tests: lets e2e render each preset offline through the real
  // chain and measure its response (ISOLATED world, invisible to the page).
  try {
    window.__unsynthAudioChain = { EQ_FREQS: EQ_FREQS, PRESETS: PRESETS, presetOf: presetOf, buildChain: buildChain, solveEq: solveEq,
      configureChain: configureChain, loudnessTrimFor: loudnessTrimFor, makeupGainFor: makeupGainFor, LIMITER: LIMITER };
  } catch (e) { /* no window */ }

  function applyPresetToGraph(entry, preset) {
    if (!entry || !entry.ctx || !entry.chain) return;
    // Only reconfigure when the preset actually changed: syncAllVideos runs on
    // every scan, and re-setting the leveller each pass re-triggers its
    // envelope and pumps the audio.
    const key = presetKey(preset);
    if (entry._unPreset === key) return;
    entry._unPreset = key;
    const t = entry.ctx.currentTime;
    configureChain(entry.chain, preset, t, true);
    if (preset === 'normal' || preset === 'mono') {
      rampParam(entry.chain.trim.gain, 1, t);
    } else {
      loudnessTrimFor(preset).then(function (g) {
        // A late answer must still belong to the preset on screen.
        if (entry._unPreset !== key) return;
        rampParam(entry.chain.trim.gain, g, entry.ctx.currentTime);
      });
    }
    if (entry.mono) {
      if (presetOf(preset).mono) {
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

      const chain = buildChain(ctx);
      const mono = ctx.createGain();
      const gain = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      const limTrim = ctx.createGain();
      limiter.threshold.value = LIMITER.threshold; limiter.ratio.value = LIMITER.ratio; limiter.knee.value = LIMITER.knee;
      limiter.attack.value = LIMITER.attack; limiter.release.value = LIMITER.release;
      // The limiter only acts above -1 dBFS; cancel its own make-up gain so it
      // is transparent below that.
      makeupGainFor(LIMITER).then(function (g) { if (g > 0) limTrim.gain.value = 1 / g; });

      gain.gain.value = gainValue(gainPct);

      // YouTube's own volume is applied BEFORE this graph (measured: the chain's
      // input dropped 5.5-6 dB going from 100% to 50%, twice over). Levelling
      // and the loudness match then depended on where the volume slider sat.
      // volIn undoes it on the way in and volOut re-applies it on the way out,
      // so the chain always works on the programme at its real level and Off
      // sounds exactly as before.
      const volIn = ctx.createGain();
      const volOut = ctx.createGain();
      src.connect(volIn);
      volIn.connect(chain.input);
      chain.output.connect(volOut);
      volOut.connect(mono);
      mono.connect(gain);
      gain.connect(limiter);
      limiter.connect(limTrim);
      limTrim.connect(ctx.destination);
      // The popup's level meter reads the real output here (after every stage).
      const meter = ctx.createAnalyser();
      meter.fftSize = 2048;
      limTrim.connect(meter);

      const onPlay = function () {
        if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      };
      const entry = {
        ctx: ctx,
        chain: chain,
        volIn: volIn,
        volOut: volOut,
        limiter: limiter,
        meter: meter,
        mono: mono,
        gain: gain,
        onPlay: onPlay
      };
      applyPresetToGraph(entry, activePreset);
      syncVolumeNorm(video, entry);

      graphs.set(video, entry);
      liveGraphs.set(video, entry);
      audioCtxs.add(ctx);
      video.dataset.unVolGraph = '1';
      video.addEventListener('play', onPlay, { once: false });
    } catch (e) {
      lastAttachError = (e && (e.name ? e.name + ': ' : '') + (e.message || '')) || 'unknown error';
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
  // Keeps volIn * volOut == 1 with volIn = 1 / element volume. Below 1% the
  // element is effectively silent anyway, so the undo stops there rather than
  // multiplying noise by 100+.
  function syncVolumeNorm(v, entry) {
    const g = entry || graphs.get(v);
    if (!g || !g.volIn || !g.volOut) return;
    const vol = Math.max(0.01, Math.min(1, Number(v.volume) || 0));
    const t = g.ctx.currentTime;
    try {
      g.volIn.gain.setTargetAtTime(1 / vol, t, 0.015);
      g.volOut.gain.setTargetAtTime(vol, t, 0.015);
    } catch (e) {
      g.volIn.gain.value = 1 / vol;
      g.volOut.gain.value = vol;
    }
  }

  function ensureVolListener(v) {
    if (v._unVolH) return;
    const h = function () { syncVolumeNorm(v); syncFromNative(v); };
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
  /**
   * WHAT IS THE AUDIO ACTUALLY DOING (2026-10-02). A user could not hear the
   * presets or the boost change anything, and nothing on screen could say
   * whether the audio was even going through Unsynth. The popup polls this
   * and shows it as a live meter plus one line of status:
   *   on         processing, with the measured output level (dBFS)
   *   suspended  Chrome has not let the page start audio yet
   *   bypass     Off at 100% or less: YouTube plays the audio directly
   *   failed     an effect is wanted but the audio chain could not attach
   *   no-video   nothing to process on this page
   */
  function audioStatus() {
    const v = document.querySelector('#movie_player video') || mediaTargets()[0] || null;
    if (!v) return { state: 'no-video' };
    const base = { preset: activePreset, gain: gainPct, nativeVol: Math.round((v.volume || 0) * 100), muted: !!v.muted, paused: !!v.paused };
    const g = graphs.get(v);
    if (!g) {
      const wanted = gainPct > 100 || (activePreset && activePreset !== 'normal');
      return Object.assign(base, { state: wanted ? 'failed' : 'bypass', error: wanted ? (lastAttachError || 'not attached yet') : '' });
    }
    let levelDb = null;
    if (g.meter) {
      const buf = new Float32Array(g.meter.fftSize);
      g.meter.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      levelDb = rms > 1e-5 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -99;
    }
    return Object.assign(base, { state: g.ctx.state === 'running' ? 'on' : 'suspended', levelDb: levelDb, applied: String(g._unPreset || 'normal').split(':')[0] });
  }

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
    ['mono', 'Mono'], ['custom', 'Custom'], ['normal', 'Off']
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
      if (msg.type === 'unsynth-vol-status') {
        sendResponse(audioStatus());
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
      if (msg.type === 'unsynth-vol-status') {
        sendResponse(audioStatus());
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
