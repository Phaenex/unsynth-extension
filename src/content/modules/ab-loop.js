/**
 * A-B loop — mark two points on the current video and repeat playback
 * between them until turned off. Only ever reads/writes video.currentTime
 * on the real <video> element (same safe surface as sponsorblock.js's own
 * segment-skip), never touches DOM structure near #movie_player.
 */
(function () {
  'use strict';

  let core = null;
  let video = null;
  let pointA = null;
  let pointB = null;
  let looping = false;
  let popupEl = null;

  function el(tag, cls, text) {
    return window.UNSYNTH.el(tag, cls, text);
  }

  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video')
    );
  }

  function fmt(s) {
    if (s == null) return '—';
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ':' + String(sec).padStart(2, '0');
  }

  function onTime() {
    if (!looping || !video || pointA == null || pointB == null) return;
    if (video.currentTime >= pointB) video.currentTime = pointA;
  }

  function detachVideo() {
    if (!video) return;
    video.removeEventListener('timeupdate', onTime);
    video = null;
  }
  function attachVideo() {
    const v = findVideo();
    if (!v || v === video) return;
    detachVideo();
    video = v;
    video.addEventListener('timeupdate', onTime);
  }

  function resetPoints() {
    pointA = null;
    pointB = null;
    looping = false;
  }

  function closePopup() {
    if (popupEl) {
      // Unregister from the shared LIFO escape stack and drop the
      // outside-click listener before the node goes away, or both leak.
      if (popupEl._escHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
        window.UNSYNTH.popPanel(popupEl._escHandle);
      }
      if (popupEl._onOut) document.removeEventListener('click', popupEl._onOut, true);
      const returnTo = popupEl._returnFocus;
      if (popupEl.parentNode) popupEl.parentNode.removeChild(popupEl);
      popupEl = null;
      if (returnTo && returnTo.isConnected) {
        try { returnTo.focus(); } catch (e) { /* ignore */ }
      }
      return;
    }
    popupEl = null;
  }

  function refreshPopup() {
    if (!popupEl) return;
    const status = popupEl.querySelector('.un-abl-status');
    if (status) {
      status.textContent = 'A: ' + fmt(pointA) + '   B: ' + fmt(pointB) + (looping ? '   (looping)' : '');
    }
    const loopBtn = popupEl.querySelector('.un-abl-toggle');
    if (loopBtn) {
      loopBtn.disabled = pointA == null || pointB == null || pointB <= pointA;
      loopBtn.textContent = looping ? 'Stop looping' : 'Start looping';
    }
  }

  function openPopup() {
    closePopup();
    const host = document.getElementById('movie_player') || document.body;
    popupEl = el('div', 'un-abl-panel');
    popupEl.appendChild(el('div', 'un-abl-status'));

    const actions = el('div', 'un-abl-actions');
    const markA = el('button', 'un-abl-btn', 'Mark A (now)');
    markA.addEventListener('click', () => {
      if (video) pointA = video.currentTime;
      refreshPopup();
    });
    const markB = el('button', 'un-abl-btn', 'Mark B (now)');
    markB.addEventListener('click', () => {
      if (video) pointB = video.currentTime;
      refreshPopup();
    });
    const toggle = el('button', 'un-abl-btn un-abl-toggle', 'Start looping');
    toggle.addEventListener('click', () => {
      looping = !looping;
      if (looping && video && pointA != null) video.currentTime = pointA;
      refreshPopup();
    });
    const clear = el('button', 'un-abl-btn', 'Clear');
    clear.addEventListener('click', () => {
      resetPoints();
      refreshPopup();
    });
    const close = el('button', 'un-abl-btn un-abl-close', 'Close');
    close.addEventListener('click', closePopup);

    actions.append(markA, markB, toggle, clear, close);
    popupEl.appendChild(actions);
    host.appendChild(popupEl);

    // Match the panel contract every other Unsynth overlay follows:
    // Escape closes via the shared LIFO stack (so only the topmost panel
    // closes), clicking outside dismisses, and focus moves in and is
    // returned to the trigger on close.
    popupEl.setAttribute('role', 'dialog');
    popupEl.setAttribute('aria-label', 'A-B loop controls');
    popupEl._returnFocus = document.activeElement;
    if (window.UNSYNTH && window.UNSYNTH.pushPanel) {
      popupEl._escHandle = window.UNSYNTH.pushPanel(closePopup);
    }
    popupEl._onOut = function onOut(e) {
    // Not a user dismissal -- see queue-advance.js docClickHandler.
    if (e && e.isTrusted === false) return;
      if (!popupEl || popupEl.contains(e.target)) return;
      if (e.target.closest && e.target.closest('#un-abl-btn-player')) return;
      closePopup();
    };
    document.addEventListener('click', popupEl._onOut, true);
    try { markA.focus(); } catch (e) { /* ignore */ }

    refreshPopup();
  }

  function togglePopup() {
    if (popupEl) closePopup();
    else openPopup();
  }

  function isWatch() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }

  // Moved from a standalone player button into the Unsynth tools overflow
  // menu — an occasional/specialized action, not a single-tap
  // frequently-used control (see docs/LESSONS.md).
  function ensureButton() {
    if (!window.UNSYNTH || !window.UNSYNTH.addMenuItem) return;
    if (!isWatch()) {
      if (window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem('un-abl-btn-player');
      return;
    }
    window.UNSYNTH.addMenuItem({
      id: 'un-abl-btn-player',
      svg: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 4v16l-5-8 5-8zm10 0v16l5-8-5-8zM11 4h2v16h-2z"/></svg>',
      label: 'A-B loop',
      onClick: togglePopup,
      priority: 46
    });
  }

  const mod = {
    id: 'abLoop',
    moduleKey: 'abLoop',
    init: function (c) {
      core = c;
      attachVideo();
      ensureButton();
    },
    scan: function () {
      attachVideo();
      ensureButton();
    },
    onNavigate: function () {
      detachVideo();
      resetPoints();
      closePopup();
      attachVideo();
      ensureButton();
    },
    onSettings: function (s) {
      core.settings = s;
      ensureButton();
    },
    teardown: function () {
      detachVideo();
      resetPoints();
      closePopup();
      if (window.UNSYNTH && window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem('un-abl-btn-player');
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
