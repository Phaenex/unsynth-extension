/**
 * Pure decision logic for the dev-only auto-reload watcher (see
 * scripts/dev-watch.js and src/background/service-worker.js). Kept
 * separate from any chrome.* API calls specifically so it's testable in
 * plain Node with no mocking — the actual chrome.management.getSelf() /
 * fetch() / chrome.runtime.reload() calls live in the service worker,
 * this file only decides, given their results, whether a reload is due.
 */
(function (g) {
  'use strict';

  /**
   * @param {string} installType - from chrome.management.getSelf().installType.
   *   'development' is Chrome's own signal for "loaded unpacked via
   *   Developer Mode" — the hard gate. A real Chrome Web Store or
   *   offline-installed copy never reports this value, so this function
   *   returns false unconditionally for every real install, regardless of
   *   the version arguments.
   * @param {?string} previousVersion - the last version token seen, or
   *   null if this is the first successful contact with the dev-watch
   *   server this session (no prior baseline to compare against).
   * @param {?string} currentVersion - the version token just fetched, or
   *   null if the fetch failed/returned nothing usable.
   * @returns {boolean} true only when installType is 'development' AND
   *   both versions are known AND they differ.
   */
  function shouldReload(installType, previousVersion, currentVersion) {
    if (installType !== 'development') return false;
    if (previousVersion == null || currentVersion == null) return false;
    return previousVersion !== currentVersion;
  }

  const api = { shouldReload };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNDevReload = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
