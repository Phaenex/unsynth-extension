/**
 * Minimal semver helpers for extension update checks (major.minor.patch).
 */
(function (g) {
  'use strict';

  function parseSemver(v) {
    const m = String(v || '')
      .trim()
      .match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
  }

  /** @returns {-1|0|1} negative if a < b */
  function compareSemver(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
    if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
    if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
    return 0;
  }

  function isNewer(remote, local) {
    return compareSemver(remote, local) > 0;
  }

  const api = { parseSemver, compareSemver, isNewer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNSemver = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
