/**
 * Clamp YouTube's main media element before its first playback event. The full
 * Volume Master module loads later and replaces this temporary startup level
 * with the remembered/configured value.
 */
(function () {
  'use strict';

  var defaults = (window.UNSYNTH_DEFAULTS && window.UNSYNTH_DEFAULTS.volumeMaster) || {};
  var shippedLevel = Number(defaults.defaultLevel);
  if (!isFinite(shippedLevel)) shippedLevel = 10;
  var target = Math.max(0, Math.min(100, shippedLevel)) / 100;
  var active = true;
  var observer = null;

  function isMainMedia(node) {
    if (!node || (node.tagName !== 'VIDEO' && node.tagName !== 'AUDIO')) return false;
    return !!node.closest('#movie_player, #shorts-player, ytd-player#ytd-player, ytmusic-player-bar, ytmusic-player');
  }

  function clamp(node) {
    if (!active || !isMainMedia(node)) return;
    try {
      if (node.volume > target) node.volume = target;
    } catch (e) {
      /* media disappeared during a YouTube navigation */
    }
  }

  function scan(root) {
    if (!active || !root) return;
    if (isMainMedia(root)) clamp(root);
    if (!root.querySelectorAll) return;
    root.querySelectorAll('video, audio').forEach(clamp);
  }

  function release() {
    if (!active) return;
    active = false;
    document.removeEventListener('play', onPlayback, true);
    document.removeEventListener('playing', onPlayback, true);
    document.removeEventListener('volumechange', onVolumeChange, true);
    if (observer) observer.disconnect();
    observer = null;
  }

  function handoff(pct) {
    if (!active) return;
    var next = Number(pct);
    if (isFinite(next)) target = Math.max(0, Math.min(100, next)) / 100;
    scan(document);
    // Keep guarding through YouTube's asynchronous setVolume round trip. The
    // full module reasserts the element level after 250ms, then this temporary
    // ceiling can safely get out of the way.
    setTimeout(release, 500);
  }

  function onPlayback(event) {
    clamp(event.target);
  }

  function onVolumeChange(event) {
    // YouTube commonly reasserts its remembered level between inserting the
    // element and starting playback. Keep the startup ceiling in force until
    // Volume Master has loaded the user's real setting and releases us.
    clamp(event.target);
  }

  window.UNVolumeStartupGuard = { handoff: handoff, release: release };
  document.addEventListener('play', onPlayback, true);
  document.addEventListener('playing', onPlayback, true);
  document.addEventListener('volumechange', onVolumeChange, true);

  observer = new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(scan);
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan(document);

  // If Volume Master is disabled, stop interfering as soon as settings load.
  chrome.storage.sync.get({ modules: (window.UNSYNTH_DEFAULTS && window.UNSYNTH_DEFAULTS.modules) || {} }, function (result) {
    if (chrome.runtime.lastError || !result) return;
    if (result.modules && result.modules.volumeMaster === false) release();
  });
})();
