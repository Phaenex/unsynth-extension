/**
 * Unsynth Ambient Mode — projects a soft color glow around the video player
 * that matches the dominant edge colors of the current video frame.
 *
 * Samples on a low-frequency timer (default ~2s), never a 60fps rAF loop.
 * Pauses while the tab is hidden or the video is paused so playback stays light.
 */
(function () {
  'use strict';

  let core = null;
  let sampleTimer = null;
  let lastSampleTime = 0;
  let canvas = null;
  let ctx = null;
  let playerEl = null;
  let videoEl = null;
  let enabled = false;
  let visBound = false;

  const SAMPLE_W = 64;
  const SAMPLE_H = 36;

  // Gated on the module toggle directly (dashboard's "Feature modules"
  // checkbox, the only control that ever existed for turning this on) — the
  // dashboard's own hint text for this card says "Enable each in Feature
  // modules above," but this used to also require an inner `enabled` flag
  // that no control anywhere ever set, leaving the glow permanently
  // unreachable even with the module checked. See docs/LESSONS.md.
  function prefs() {
    const d = (core && core.settings && core.settings.ambientMode) || {};
    return {
      enabled: !(core && core.settings && core.settings.modules && core.settings.modules.ambientMode === false),
      intensity: typeof d.intensity === 'number' ? d.intensity : 0.7,
      radius: typeof d.radius === 'number' ? d.radius : 90,
      sampleRate: typeof d.sampleRate === 'number' ? d.sampleRate : 2000
    };
  }

  function ensureCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = SAMPLE_W;
      canvas.height = SAMPLE_H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    return ctx;
  }

  function sampleEdgeColor(imgData) {
    const d = imgData.data;
    const w = SAMPLE_W;
    const h = SAMPLE_H;
    let r = 0,
      g = 0,
      b = 0,
      count = 0;

    function addPixel(x, y) {
      const i = (y * w + x) * 4;
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      count++;
    }

    const STRIP = 3;
    for (let x = 0; x < w; x++) {
      for (let s = 0; s < STRIP; s++) {
        addPixel(x, s);
        addPixel(x, h - 1 - s);
      }
    }
    for (let y = STRIP; y < h - STRIP; y++) {
      for (let s = 0; s < STRIP; s++) {
        addPixel(s, y);
        addPixel(w - 1 - s, y);
      }
    }
    if (!count) return { r: 0, g: 0, b: 0 };
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
  }

  function applyGlow(rgb, p) {
    if (!playerEl) playerEl = document.getElementById('movie_player');
    if (!playerEl) return;
    const alpha = Math.min(1, Math.max(0, p.intensity));
    const radius = Math.round(p.radius);
    const glow =
      `0 0 ${radius}px ${Math.round(radius * 0.4)}px rgba(${rgb.r},${rgb.g},${rgb.b},${(alpha * 0.7).toFixed(2)}),` +
      `0 0 ${Math.round(radius * 1.8)}px ${Math.round(radius * 0.6)}px rgba(${rgb.r},${rgb.g},${rgb.b},${(alpha * 0.35).toFixed(2)})`;
    playerEl.style.setProperty('--un-ambient-glow', glow);
    playerEl.classList.add('un-ambient-active');
  }

  function clearGlow() {
    if (!playerEl) playerEl = document.getElementById('movie_player');
    if (playerEl) {
      playerEl.style.removeProperty('--un-ambient-glow');
      playerEl.classList.remove('un-ambient-active');
    }
  }

  function onPlayerPage() {
    return (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.startsWith('/shorts/');
  }

  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('#shorts-player video') ||
      document.querySelector('ytd-player video.html5-main-video')
    );
  }

  function sample() {
    const p = prefs();
    if (!p.enabled || !onPlayerPage() || document.hidden) {
      clearGlow();
      return;
    }

    const now = Date.now();
    if (now - lastSampleTime < p.sampleRate) return;
    lastSampleTime = now;

    const video = findVideo();
    videoEl = video;
    if (!video || video.paused || video.ended || video.readyState < 2) return;

    const c = ensureCanvas();
    try {
      c.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      const imgData = c.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
      const rgb = sampleEdgeColor(imgData);
      applyGlow(rgb, p);
    } catch (e) {
      /* cross-origin or GPU unavailable — skip this sample */
    }
  }

  function clearSampleTimer() {
    if (sampleTimer) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
  }

  function start() {
    enabled = true;
    bindVisibility();
    clearSampleTimer();
    if (document.hidden) return;
    const rate = Math.max(500, prefs().sampleRate || 2000);
    sample(); // paint once immediately when entering a watch page
    sampleTimer = setInterval(sample, rate);
  }

  function stop() {
    enabled = false;
    clearSampleTimer();
    clearGlow();
    canvas = null;
    ctx = null;
    videoEl = null;
  }

  function onVisibility() {
    if (!enabled) return;
    if (document.hidden) {
      clearSampleTimer();
      return;
    }
    if (prefs().enabled && onPlayerPage()) start();
  }

  function bindVisibility() {
    if (visBound) return;
    visBound = true;
    document.addEventListener('visibilitychange', onVisibility);
  }

  function unbindVisibility() {
    if (!visBound) return;
    visBound = false;
    document.removeEventListener('visibilitychange', onVisibility);
  }

  const mod = {
    id: 'ambientMode',
    moduleKey: 'ambientMode',
    init: function (c) {
      core = c;
      if (prefs().enabled && onPlayerPage()) start();
    },
    scan: function () {
      playerEl = null;
      if (prefs().enabled && onPlayerPage()) {
        if (!sampleTimer && !document.hidden) start();
      } else {
        stop();
      }
    },
    onNavigate: function () {
      playerEl = null;
      lastSampleTime = 0;
      if (!onPlayerPage()) stop();
      else if (prefs().enabled) start();
    },
    onSettings: function (s) {
      core.settings = s;
      if (prefs().enabled && onPlayerPage()) start();
      else stop();
    },
    teardown: function () {
      stop();
      unbindVisibility();
    }
  };

  // Export the pure sampler for tests. test/ambient-mode-sampling.test.js used
  // to carry its own copy of this algorithm and assert against that, so the
  // shipped function had no coverage at all while the suite reported a passing
  // "ambient-mode" test. Same pattern as the other modules that expose their
  // pure helpers under module.exports.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sampleEdgeColor, SAMPLE_W, SAMPLE_H };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
