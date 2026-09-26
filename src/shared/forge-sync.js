/** Privacy and validation boundary for the Playlist Forge page bridge. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNForgeSync = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const PL_RE = /^PL[\w-]{10,}$/i;

  function text(value, max) {
    return String(value == null ? '' : value).trim().slice(0, max || 120);
  }

  function finite(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(min, Math.min(max, n));
  }

  function normalizeConfig(value) {
    value = value && typeof value === 'object' ? value : {};
    return {
      enabled: value.enabled === true,
      sharedAt: finite(value.sharedAt, 0, Number.MAX_SAFE_INTEGER) || 0,
      requestAt: finite(value.requestAt, 0, Number.MAX_SAFE_INTEGER) || 0
    };
  }

  function stringList(value, limit, maxLength) {
    if (!Array.isArray(value)) return [];
    const out = [];
    value.slice(0, limit).forEach(function (item) {
      const clean = text(item, maxLength);
      if (clean && out.indexOf(clean) === -1) out.push(clean);
    });
    return out;
  }

  /** Allowlist the compact taste fields; never forward raw history structures. */
  function sanitizeSummary(value) {
    value = value && typeof value === 'object' ? value : {};
    const out = {};
    ['total', 'uniqueChannels', 'activeDays', 'peakHour'].forEach(function (key) {
      const n = finite(value[key], 0, 1000000000);
      if (n !== undefined) out[key] = n;
    });
    ['firstDate', 'lastDate', 'persona'].forEach(function (key) {
      const clean = text(value[key], 40);
      if (clean) out[key] = clean;
    });
    if (Array.isArray(value.topChannels)) {
      out.topChannels = value.topChannels.slice(0, 20).map(function (row) {
        if (!Array.isArray(row)) return null;
        const name = text(row[0], 100);
        const count = finite(row[1], 0, 1000000000);
        return name && count !== undefined ? [name, count] : null;
      }).filter(Boolean);
    }
    out.topSearchWords = stringList(value.topSearchWords, 25, 80);
    out.topSearchTerms = stringList(value.topSearchTerms, 12, 120);
    out.avoidChannelNames = stringList(value.avoidChannelNames, 20, 100);
    if (Array.isArray(value.boostChannelNames)) {
      // enrichSuggestSummary uses [name,count,score] for boosted channels.
      out.boostChannelNames = (value.boostChannelNames || []).slice(0, 12).map(function (row) {
        if (!Array.isArray(row)) return null;
        const name = text(row[0], 100);
        const count = finite(row[1], 0, 1000000000);
        const score = finite(row[2], 0, 100);
        return name ? [name, count || 0, score || 0] : null;
      }).filter(Boolean);
    }
    out.tasteHints = stringList(value.tasteHints, 8, 180);
    Object.keys(out).forEach(function (key) {
      if (Array.isArray(out[key]) && !out[key].length) delete out[key];
    });
    return out;
  }

  /** Validate Forge's {names,assign} folder envelope before touching storage. */
  function sanitizeFolders(value) {
    value = value && typeof value === 'object' ? value : {};
    const names = stringList(value.names, 100, 80);
    const assign = {};
    const rawAssign = value.assign && typeof value.assign === 'object' ? value.assign : {};
    Object.keys(rawAssign).slice(0, 2000).forEach(function (playlistId) {
      if (!PL_RE.test(playlistId)) return;
      const folder = text(rawAssign[playlistId], 80);
      if (!folder) return;
      if (names.indexOf(folder) === -1 && names.length < 100) names.push(folder);
      if (names.indexOf(folder) !== -1) assign[playlistId] = folder;
    });
    return { names: names, assign: assign };
  }

  function sanitizeBuiltPlaylist(value) {
    value = value && typeof value === 'object' ? value : {};
    const playlistId = text(value.playlistId, 80);
    if (!PL_RE.test(playlistId)) return null;
    return { playlistId: playlistId, folder: text(value.folder, 80), title: text(value.title, 160) };
  }

  return { normalizeConfig, sanitizeSummary, sanitizeFolders, sanitizeBuiltPlaylist };
});
