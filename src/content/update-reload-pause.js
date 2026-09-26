/**
 * Temporary guard injected only while Unsynth reloads open YouTube tabs after
 * an extension update. YouTube may restore playback as each tab comes back;
 * keep every restored player paused until the user interacts with that tab.
 */
(function () {
  'use strict';

  if (window.UNUpdateReloadPauseGuard) return;

  var active = true;

  function isMedia(node) {
    return !!node && (node.tagName === 'VIDEO' || node.tagName === 'AUDIO');
  }

  function pause(node) {
    if (!active || !isMedia(node)) return;
    try {
      node.autoplay = false;
      if (!node.paused) node.pause();
      document.documentElement.setAttribute('data-unsynth-update-paused', 'true');
    } catch (e) {
      /* media disappeared during reload */
    }
  }

  function onPlayback(event) {
    pause(event.target);
  }

  function release() {
    if (!active) return;
    active = false;
    document.removeEventListener('play', onPlayback, true);
    document.removeEventListener('playing', onPlayback, true);
    document.removeEventListener('pointerdown', onUserIntent, true);
    document.removeEventListener('keydown', onUserIntent, true);
    document.removeEventListener('touchstart', onUserIntent, true);
    document.documentElement.removeAttribute('data-unsynth-update-paused');
  }

  function onUserIntent(event) {
    if (event.isTrusted) release();
  }

  window.UNUpdateReloadPauseGuard = { release: release };
  document.addEventListener('play', onPlayback, true);
  document.addEventListener('playing', onPlayback, true);
  document.addEventListener('pointerdown', onUserIntent, true);
  document.addEventListener('keydown', onUserIntent, true);
  document.addEventListener('touchstart', onUserIntent, true);
  document.querySelectorAll('video, audio').forEach(pause);
})();
