/**
 * Boot — runs last in the content_scripts list, after every module has
 * registered against window.UNSYNTH. Starts the shared engine.
 */
(function () {
  'use strict';
  // Version stamp so you can confirm fresh code is actually loaded: open the
  // YouTube console and look for this line. If the version is old or missing,
  // the extension wasn't reloaded and you're running stale content scripts.
  try {
    const m = chrome.runtime.getManifest();
    const shown = m.version_name && m.version_name !== m.version ? m.version_name + ' (build ' + m.version + ')' : m.version;
    console.info('%cUnsynth ' + shown + ' loaded', 'color:#ff5a5f;font-weight:600');
  } catch (e) {
    /* getManifest unavailable in some contexts — non-fatal */
  }
  if (window.UNSYNTH && typeof window.UNSYNTH.start === 'function') {
    window.UNSYNTH.start();
  }
})();
