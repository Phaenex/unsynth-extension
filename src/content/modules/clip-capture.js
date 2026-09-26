/**
 * Clip capture — record a short WebM clip (video + audio) of the current
 * playback via the native HTMLVideoElement.captureStream() + MediaRecorder
 * APIs. No new dependency: a true animated GIF needs a bundled encoder
 * library, which isn't justified for this; WebM download covers the same
 * "capture more than one frame" need natively.
 *
 * Same drawImage-without-CORS-taint surface screenshot.js already proved
 * safe on YouTube's own player — captureStream() is the same trust boundary.
 */
(function () {
  'use strict';

  let core = null;
  let recorder = null;
  let chunks = [];
  let recordingSince = 0;
  let autoStopTimer = null;
  const MAX_DURATION_MS = 20000;

  function prefs() {
    const d = (core && core.settings && core.settings.clipCapture) || {};
    return { enabled: d.enabled !== false };
  }

  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video')
    );
  }

  function safeFilename(str) {
    return (str || 'clip').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  }
  function getTitle() {
    const el = document.querySelector('ytd-watch-metadata h1 yt-formatted-string') || document.querySelector('#title yt-formatted-string');
    return (el && el.textContent.trim()) || 'YouTube Clip';
  }

  function isRecording() {
    return !!recorder && recorder.state === 'recording';
  }

  function pickMimeType() {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return 'video/webm';
  }

  function startRecording() {
    const video = findVideo();
    if (!video || typeof video.captureStream !== 'function') {
      if (window.UNSYNTH && window.UNSYNTH.showToast) {
        window.UNSYNTH.showToast('Clip capture not supported on this video', { id: 'un-clip-osd' });
      }
      return;
    }
    let stream;
    try {
      stream = video.captureStream();
    } catch (e) {
      if (window.UNSYNTH && window.UNSYNTH.showToast) {
        window.UNSYNTH.showToast('Clip capture blocked (CORS)', { id: 'un-clip-osd' });
      }
      return;
    }
    chunks = [];
    try {
      recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    } catch (e) {
      recorder = null;
      return;
    }
    recorder.ondataavailable = function (e) {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = function () {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
      const blob = new Blob(chunks, { type: 'video/webm' });
      chunks = [];
      if (blob.size > 0) downloadClip(blob);
      updateButton();
    };
    recorder.start();
    recordingSince = Date.now();
    autoStopTimer = setTimeout(stopRecording, MAX_DURATION_MS);
    if (window.UNSYNTH && window.UNSYNTH.showToast) {
      window.UNSYNTH.showToast('Recording clip… click again to stop (max 20s)', { id: 'un-clip-osd', duration: 2000 });
    }
    updateButton();
  }

  function stopRecording() {
    if (recorder && recorder.state === 'recording') recorder.stop();
  }

  function downloadClip(blob) {
    const video = findVideo();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const seconds = Math.round((Date.now() - recordingSince) / 1000);
    a.href = url;
    a.download = safeFilename(getTitle()) + '_clip_' + seconds + 's.webm';
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 10000);
    if (window.UNSYNTH && window.UNSYNTH.showToast) {
      window.UNSYNTH.showToast('Clip saved (' + seconds + 's)!', { id: 'un-clip-osd' });
    }
  }

  const CLIP_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z"/></svg>';

  function onPlayerPage() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }

  function updateButton() {
    if (!window.UNSYNTH || !window.UNSYNTH.addPlayerButton) return;
    if (!prefs().enabled || !onPlayerPage()) {
      removeButton();
      return;
    }
    window.UNSYNTH.addPlayerButton({
      id: 'un-clip-btn',
      svg: CLIP_SVG,
      title: 'Record a clip, up to 20s (Unsynth)',
      ariaLabel: 'Start recording clip',
      onClick: function () {
        if (isRecording()) stopRecording();
        else startRecording();
      },
      cls: 'un-clip-btn',
      priority: 47
    });
    // addPlayerButton only sets title/class/svg on first creation — mutate the
    // live node directly so the recording-state visuals actually update on
    // subsequent calls (see docs/LESSONS.md).
    const btn = document.getElementById('un-clip-btn');
    if (btn) {
      const rec = isRecording();
      btn.classList.toggle('un-clip-recording', rec);
      btn.title = rec ? 'Stop clip recording (Unsynth)' : 'Record a clip, up to 20s (Unsynth)';
      btn.setAttribute('aria-label', rec ? 'Stop recording clip' : 'Start recording clip');
    }
  }

  function removeButton() {
    if (window.UNSYNTH && window.UNSYNTH.removePlayerButton) window.UNSYNTH.removePlayerButton('un-clip-btn');
  }

  const mod = {
    id: 'clipCapture',
    moduleKey: 'clipCapture',
    init: function (c) {
      core = c;
      updateButton();
    },
    scan: function () {
      updateButton();
    },
    onNavigate: function () {
      stopRecording();
      updateButton();
    },
    onSettings: function (s) {
      core.settings = s;
      updateButton();
    },
    teardown: function () {
      stopRecording();
      removeButton();
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
