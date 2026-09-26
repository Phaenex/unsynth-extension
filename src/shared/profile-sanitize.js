/** Bounded schema validation for local data restored from profile exports. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNProfileSanitize = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;
  const PLAYLIST_RE = /^PL[A-Za-z0-9_-]{2,100}$/;
  const CHANNEL_RE = /^(?:@[A-Za-z0-9_.-]{1,100}|channel:UC[A-Za-z0-9_-]{5,100}|c:[A-Za-z0-9_.-]{1,100})$/i;
  const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

  function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function text(value, max) {
    return String(value == null ? '' : value).trim().slice(0, max);
  }

  function number(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function keys(value, max) {
    return Object.keys(record(value)).filter((key) => !BLOCKED_KEYS.has(key)).slice(0, max);
  }

  function uniqueStrings(value, maxItems, maxLength, validate) {
    const out = [];
    (Array.isArray(value) ? value : []).slice(0, maxItems).forEach((item) => {
      const clean = text(item, maxLength);
      if (!clean || (validate && !validate(clean)) || out.includes(clean)) return;
      out.push(clean);
    });
    return out;
  }

  function sanitizeSubStore(value) {
    value = record(value);
    const out = { groups: {}, names: {}, aliases: {} };
    keys(value.groups, 100).forEach((rawName) => {
      const name = text(rawName, 80);
      if (!name || Object.prototype.hasOwnProperty.call(out.groups, name)) return;
      out.groups[name] = uniqueStrings(value.groups[rawName], 500, 120, (key) => CHANNEL_RE.test(key));
    });
    keys(value.names, 5000).forEach((key) => {
      if (CHANNEL_RE.test(key)) out.names[key] = text(value.names[key], 160);
    });
    keys(value.aliases, 5000).forEach((key) => {
      const target = text(value.aliases[key], 120);
      if (CHANNEL_RE.test(key) && CHANNEL_RE.test(target)) out.aliases[key] = target;
    });
    return out;
  }

  function sanitizePlaylistStore(value) {
    value = record(value);
    const out = { folders: {}, names: {} };
    keys(value.folders, 100).forEach((rawName) => {
      const name = text(rawName, 80);
      if (!name || Object.prototype.hasOwnProperty.call(out.folders, name)) return;
      out.folders[name] = uniqueStrings(value.folders[rawName], 500, 110, (id) => PLAYLIST_RE.test(id));
    });
    keys(value.names, 5000).forEach((id) => {
      if (PLAYLIST_RE.test(id)) out.names[id] = text(value.names[id], 160);
    });
    return out;
  }

  function sanitizeChannelStringMap(value) {
    const out = {};
    keys(value, 5000).forEach((key) => {
      if (!CHANNEL_RE.test(key)) return;
      const clean = text(value[key], 120);
      if (clean) out[key] = clean;
    });
    return out;
  }

  function sanitizeChannelLatest(value) {
    const out = {};
    keys(value, 5000).forEach((key) => {
      if (!CHANNEL_RE.test(key)) return;
      const row = record(value[key]);
      const videoId = text(row.videoId, 120);
      if (!videoId) return;
      out[key] = { videoId, ts: number(row.ts, 0, Number.MAX_SAFE_INTEGER, 0) };
    });
    return out;
  }

  function sanitizePersonalSegments(value) {
    const out = {};
    keys(value, 2000).forEach((videoId) => {
      if (!VIDEO_RE.test(videoId)) return;
      const rows = [];
      (Array.isArray(value[videoId]) ? value[videoId] : []).slice(0, 100).forEach((raw) => {
        raw = record(raw);
        const pair = Array.isArray(raw.segment) ? raw.segment : [raw.start, raw.end];
        const start = number(pair[0], 0, 100000000, NaN);
        const end = number(pair[1], 0, 100000000, NaN);
        const actionType = ['skip', 'mute', 'poi', 'full', 'chapter'].includes(raw.actionType) ? raw.actionType : 'skip';
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;
        if (actionType !== 'poi' && actionType !== 'full' && end <= start + 0.1) return;
        if ((actionType === 'poi' || actionType === 'full') && end < start) return;
        const row = {
          start,
          end,
          category: text(raw.category || 'sponsor', 40),
          actionType,
          uuid: text(raw.uuid || raw.id || '', 160),
          source: 'personal'
        };
        if (actionType === 'chapter') row.description = text(raw.description || raw.title || '', 300);
        rows.push(row);
      });
      if (rows.length) out[videoId] = rows;
    });
    return out;
  }

  function sanitizeRankTracks(value) {
    return (Array.isArray(value) ? value : []).slice(0, 200).map((raw) => {
      raw = record(raw);
      const videoId = text(raw.videoId, 11);
      const keyword = text(raw.keyword, 200);
      if (!VIDEO_RE.test(videoId) || !keyword) return null;
      const history = (Array.isArray(raw.history) ? raw.history : []).slice(-60).map((row) => ({
        at: number(record(row).at, 0, Number.MAX_SAFE_INTEGER, 0),
        rank: Math.floor(number(record(row).rank, 1, 50, 50))
      }));
      return {
        id: text(raw.id, 100), keyword, videoId, videoTitle: text(raw.videoTitle, 160),
        lastRank: raw.lastRank == null ? null : Math.floor(number(raw.lastRank, 1, 50, 50)),
        history,
        createdAt: number(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
        updatedAt: number(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0)
      };
    }).filter(Boolean);
  }

  function sanitizeSchedule(value) {
    return (Array.isArray(value) ? value : []).slice(0, 300).map((raw) => {
      raw = record(raw);
      const publishAt = raw.publishAt && Number.isFinite(Date.parse(raw.publishAt)) ? new Date(raw.publishAt).toISOString() : null;
      return {
        id: text(raw.id, 100), title: text(raw.title || 'Untitled', 140), publishAt,
        notes: text(raw.notes, 2000),
        videoId: VIDEO_RE.test(text(raw.videoId, 11)) ? text(raw.videoId, 11) : '',
        status: ['draft', 'scheduled', 'published'].includes(raw.status) ? raw.status : 'draft',
        createdAt: number(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, 0)
      };
    });
  }

  function sanitizeThumbnailTests(value) {
    return (Array.isArray(value) ? value : []).slice(0, 200).map((raw) => {
      raw = record(raw);
      const videoId = text(raw.videoId, 11);
      if (!VIDEO_RE.test(videoId)) return null;
      const variants = (Array.isArray(raw.variants) ? raw.variants : []).slice(0, 10).map((variant, index) => {
        variant = record(variant);
        return {
          id: text(variant.id || 'v' + index, 40), label: text(variant.label, 8), notes: text(variant.notes, 500),
          viewsAtStart: variant.viewsAtStart == null ? null : number(variant.viewsAtStart, 0, 1000000000000000, 0),
          addedAt: number(variant.addedAt, 0, Number.MAX_SAFE_INTEGER, 0)
        };
      });
      return {
        id: text(raw.id, 100), videoId, videoTitle: text(raw.videoTitle, 160), variants,
        activeVariant: Math.floor(number(raw.activeVariant, 0, Math.max(0, variants.length - 1), 0)),
        createdAt: number(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, 0)
      };
    }).filter(Boolean);
  }

  function sanitizeVideoStatsCache(value) {
    const out = {};
    keys(value, 400).forEach((key) => {
      const raw = record(value[key]);
      // The object key IS the canonical storage slot for this entry — prefer
      // it over raw.videoId. This used to prefer raw.videoId first, so an
      // imported/hand-edited profile JSON where an entry's embedded videoId
      // field didn't match its own object key would get silently remapped to
      // out[raw.videoId], which can collide with (and drop) a different
      // entry already written under that id in the same pass.
      const videoId = text(VIDEO_RE.test(key) ? key : raw.videoId, 11);
      if (!VIDEO_RE.test(videoId)) return;
      if (Object.prototype.hasOwnProperty.call(out, videoId)) return;
      out[videoId] = {
        videoId,
        title: text(raw.title, 300), channelId: text(raw.channelId, 120), channelName: text(raw.channelName || raw.author, 160),
        viewCount: number(raw.viewCount, 0, 1000000000000000, 0),
        likes: raw.likes == null ? null : number(raw.likes, 0, 1000000000000000, 0),
        dislikes: raw.dislikes == null ? null : number(raw.dislikes, 0, 1000000000000000, 0),
        comments: raw.comments == null ? null : number(raw.comments, 0, 1000000000000000, 0),
        publishDate: text(raw.publishDate, 40), lengthSeconds: number(raw.lengthSeconds, 0, 100000000, 0),
        cachedAt: number(raw.cachedAt, 0, Number.MAX_SAFE_INTEGER, 0)
      };
    });
    return out;
  }

  function sanitizeLocal(input) {
    input = record(input);
    const out = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
    if (has('subStore')) out.subStore = sanitizeSubStore(input.subStore);
    if (has('subActive')) out.subActive = text(input.subActive, 80);
    if (has('plFolderStore')) out.plFolderStore = sanitizePlaylistStore(input.plFolderStore);
    if (has('plFolderActive')) out.plFolderActive = text(input.plFolderActive, 80);
    if (has('plFolderPrefs')) {
      const p = record(input.plFolderPrefs);
      out.plFolderPrefs = {
        sidebar: p.sidebar !== false, showAll: p.showAll !== false, hideEmpty: p.hideEmpty !== false,
        sort: ['manual', 'name', 'count'].includes(p.sort) ? p.sort : 'manual'
      };
    }
    if (has('subNewSeen')) out.subNewSeen = sanitizeChannelStringMap(input.subNewSeen);
    if (has('subChannelLatest')) out.subChannelLatest = sanitizeChannelLatest(input.subChannelLatest);
    if (has('sbPersonalSegments')) out.sbPersonalSegments = sanitizePersonalSegments(input.sbPersonalSegments);
    if (has('statsSections')) {
      out.statsSections = {};
      keys(input.statsSections, 50).forEach((key) => {
        if (/^[A-Za-z0-9_-]{1,50}$/.test(key) && typeof input.statsSections[key] === 'boolean') out.statsSections[key] = input.statsSections[key];
      });
    }
    if (has('statsCollapsed')) out.statsCollapsed = input.statsCollapsed === true;
    if (has('aiPanelOpen')) out.aiPanelOpen = input.aiPanelOpen !== false;
    if (has('aiPanelWidth')) out.aiPanelWidth = Math.round(number(input.aiPanelWidth, 280, 800, 380));
    if (has('creatorRankTracks')) out.creatorRankTracks = sanitizeRankTracks(input.creatorRankTracks);
    if (has('creatorSchedule')) out.creatorSchedule = sanitizeSchedule(input.creatorSchedule);
    if (has('creatorThumbnailTests')) out.creatorThumbnailTests = sanitizeThumbnailTests(input.creatorThumbnailTests);
    if (has('videoStatsCache')) out.videoStatsCache = sanitizeVideoStatsCache(input.videoStatsCache);
    return out;
  }

  return { sanitizeLocal };
});
