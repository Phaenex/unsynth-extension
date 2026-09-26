/**
 * Unsynth Screenshot — capture the current video frame as a PNG download.
 *
 * Draws the <video> element to an offscreen canvas at its native resolution,
 * then triggers a download. Works entirely client-side — no upload or API call.
 */
(function () {
  'use strict';

  let core = null;

  function prefs() {
    const d = (core && core.settings && core.settings.screenshot) || {};
    return {
      enabled:          d.enabled !== false,
      showButton:       d.showButton !== false,
      includeTimestamp: d.includeTimestamp !== false
    };
  }

  // Format a time value (seconds) as HH-MM-SS for filenames.
  function fmtTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return [h, m, sec].map(function (n) { return String(n).padStart(2, '0'); }).join('-');
  }

  function safeFilename(str) {
    return (str || 'screenshot').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  }

  function getTitle() {
    const el =
      document.querySelector('ytd-watch-metadata h1 yt-formatted-string') ||
      document.querySelector('#title yt-formatted-string') ||
      document.querySelector('h1.ytd-video-primary-info-renderer');
    return (el && el.textContent.trim()) || 'YouTube Screenshot';
  }

  function captureFrame() {
    const video = document.querySelector('video');
    if (!video) return;
    if (video.readyState < 2) { showOsd('Video not ready — try again'); return; }
    const p = prefs();

    // Build canvas at native video resolution (or client display size as fallback)
    const w = video.videoWidth  || video.clientWidth  || 1280;
    const h = video.videoHeight || video.clientHeight || 720;

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      ctx.drawImage(video, 0, 0, w, h);
    } catch (e) {
      // Cross-origin frame protection — unlikely on youtube.com but guard anyway
      showOsd('Screenshot blocked (CORS)');
      return;
    }

    canvas.toBlob(function (blob) {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      const parts = [safeFilename(getTitle())];
      if (p.includeTimestamp) parts.push(fmtTime(video.currentTime));
      a.download = parts.join('_') + '.png';
      a.href     = url;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      showOsd('Frame saved!');
    }, 'image/png');
  }

  // Brief on-screen toast so the user knows it worked
  function showOsd(msg) { window.UNSYNTH.showToast(msg, { id: 'un-ss-osd' }); }

  // ---- Player button ----
  const CAM_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/>' +
    '<path fill="currentColor" d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c' +
    '1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>' +
    '</svg>';

  // Only the real watch / shorts player — not home-feed hover previews.
  function onPlayerPage() { return window.UNSYNTH.isWatch(); }

  function ensureButton() {
    const p = prefs();
    if (!p.showButton || !onPlayerPage()) { removeButton(); return; }
    window.UNSYNTH.addPlayerButton({
      id: 'un-ss-btn',
      svg: CAM_SVG,
      title: 'Screenshot frame (Unsynth)',
      ariaLabel: 'Screenshot current frame',
      onClick: captureFrame,
      cls: 'un-ss-btn',
      priority: 30
    });
  }

  function removeButton() {
    window.UNSYNTH.removePlayerButton('un-ss-btn');
    const osd = document.getElementById('un-ss-osd');
    if (osd) osd.remove();
  }

  const mod = {
    id: 'screenshot',
    moduleKey: 'screenshot',
    init: function (c) {
      core = c;
      ensureButton();
    },
    scan: function () {
      ensureButton();
    },
    onNavigate: function () {
      ensureButton();
    },
    onSettings: function (s) {
      core.settings = s;
      ensureButton();
    },
    // Called by core when the module toggle is switched off.
    teardown: removeButton
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
