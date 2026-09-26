/**
 * Video stats cache + compare helpers (local snapshots, related scrape, aggregates).
 */
(function (g) {
  'use strict';

  const MAX_ENTRIES = 400;

  function parseCount(str) {
    const m = String(str || '')
      .replace(/,/g, '')
      .match(/([\d.]+)\s*(K|M|B|k|m|b)?/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1e3;
    else if (suf === 'M') n *= 1e6;
    else if (suf === 'B') n *= 1e9;
    return n > 0 ? Math.round(n) : null;
  }

  function ageDays(publishDate) {
    const t = Date.parse(publishDate || '');
    if (isNaN(t)) return null;
    return Math.max(0, (Date.now() - t) / 86400000);
  }

  function engagementRate(snap) {
    const views = Number(snap.viewCount) || 0;
    if (!views) return null;
    const likes = snap.likes != null ? Number(snap.likes) : 0;
    const comments = snap.comments != null ? Number(snap.comments) : 0;
    return ((likes + comments) / views) * 100;
  }

  function likeRatio(snap) {
    const l = Number(snap.likes) || 0;
    const d = Number(snap.dislikes) || 0;
    const t = l + d;
    return t ? (l / t) * 100 : null;
  }

  function viewsPerDay(snap) {
    const days = ageDays(snap.publishDate);
    const views = Number(snap.viewCount) || 0;
    if (!views) return null;
    if (!days || days < 1) return views;
    return views / days;
  }

  function normalize(raw) {
    if (!raw || !raw.videoId) return null;
    return {
      videoId: raw.videoId,
      title: raw.title || '',
      channelId: raw.channelId || '',
      channelName: raw.channelName || raw.author || '',
      viewCount: Number(raw.viewCount) || 0,
      likes: raw.likes != null ? Number(raw.likes) : null,
      dislikes: raw.dislikes != null ? Number(raw.dislikes) : null,
      comments: raw.comments != null ? Number(raw.comments) : null,
      publishDate: raw.publishDate || '',
      lengthSeconds: Number(raw.lengthSeconds) || 0,
      cachedAt: raw.cachedAt || Date.now()
    };
  }

  function median(nums) {
    const arr = nums.filter((n) => n != null && isFinite(n)).sort((a, b) => a - b);
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  function aggregate(list) {
    if (!list || !list.length) return null;
    const views = list.map((s) => s.viewCount).filter((n) => n > 0);
    const er = list.map(engagementRate).filter((n) => n != null);
    const lr = list.map(likeRatio).filter((n) => n != null);
    const vpd = list.map(viewsPerDay).filter((n) => n != null);
    const best = list.reduce(function (a, b) {
      return !a || b.viewCount > a.viewCount ? b : a;
    }, null);
    return {
      count: list.length,
      medianViews: median(views),
      avgViews: views.length ? views.reduce((a, b) => a + b, 0) / views.length : null,
      medianEngagement: median(er),
      medianLikeRatio: median(lr),
      medianViewsPerDay: median(vpd),
      best: best
    };
  }

  function pctDelta(current, baseline) {
    if (current == null || baseline == null || !baseline) return null;
    return ((current - baseline) / baseline) * 100;
  }

  function fmtDelta(pct) {
    if (pct == null || !isFinite(pct)) return '—';
    const sign = pct >= 0 ? '+' : '';
    return sign + pct.toFixed(0) + '%';
  }

  function compareMetric(label, currentVal, benchVal, fmtFn) {
    const delta = pctDelta(currentVal, benchVal);
    return {
      label: label,
      current: currentVal,
      benchmark: benchVal,
      delta: delta,
      currentText: fmtFn(currentVal),
      benchmarkText: fmtFn(benchVal),
      deltaText: fmtDelta(delta)
    };
  }

  function buildCompareRows(current, channelAgg, relatedAgg, fmt) {
    const rows = [];
    const fNum = (n) => (n == null ? '—' : fmt(n));
    const fPct = (n) => (n == null ? '—' : n.toFixed(1) + '%');
    if (channelAgg) {
      rows.push(compareMetric('Views', current.viewCount, channelAgg.medianViews, fNum));
      rows.push(compareMetric('Engagement', engagementRate(current), channelAgg.medianEngagement, fPct));
      rows.push(compareMetric('Like ratio', likeRatio(current), channelAgg.medianLikeRatio, fPct));
      rows.push(compareMetric('Views / day', viewsPerDay(current), channelAgg.medianViewsPerDay, fNum));
    }
    return { channel: rows, related: relatedAgg };
  }

  function scrapeRelatedFromDom(limit) {
    if (typeof document === 'undefined') return [];
    const YT =
      (typeof window !== 'undefined' && window.UNYtDom) ||
      (typeof require !== 'undefined' ? require('./yt-dom.js') : null);
    const max = limit || 12;
    const out = [];
    const seen = new Set();
    const tiles = document.querySelectorAll(YT ? YT.RELATED_TILES_SEL : '#related a');
    tiles.forEach(function (tile) {
      if (out.length >= max) return;
      const link = tile.querySelector(YT ? YT.RELATED_TILE_LINK_SEL : 'a[href*="/watch"]');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const m = href.match(/[?&]v=([\w-]{11})/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const titleEl =
        tile.querySelector('#video-title') ||
        (YT ? tile.querySelector(YT.TITLE_SEL) : null) ||
        link;
      const title = ((titleEl.textContent || titleEl.getAttribute('title') || '')).replace(/\s+/g, ' ').trim();
      const metaEl =
        tile.querySelector('#metadata-line') ||
        (YT && YT.TILE_META_ROW_SEL ? tile.querySelector(YT.TILE_META_ROW_SEL) : null) ||
        (YT && YT.TILE_META_SEL ? tile.querySelector(YT.TILE_META_SEL.split(',')[0].trim()) : null) ||
        tile;
      const metaText = (metaEl.textContent || '').replace(/\s+/g, ' ');
      const vm = metaText.match(/([\d.,]+\s*[KMB]?)\s*views/i);
      const views = parseCount(vm ? vm[1] : metaText);
      const chEl = YT ? tile.querySelector(YT.RELATED_TILE_CHANNEL_SEL) : tile.querySelector('#channel-name');
      out.push({
        videoId: m[1],
        title: title,
        viewCount: views || 0,
        channelName: chEl ? chEl.textContent.trim() : '',
        source: 'related'
      });
    });
    return out;
  }

  function mergeCacheEntry(cache, snap) {
    const norm = normalize(snap);
    if (!norm) return cache || {};
    const next = Object.assign({}, cache || {});
    const prev = next[norm.videoId] || {};
    // normalize() returns null for likes/dislikes/comments whenever the source
    // snapshot didn't carry that field (e.g. a 'related'-scrape snapshot never
    // has like/comment counts) — a plain Object.assign(prev, norm) would let
    // that null clobber a real count a fuller-source snapshot already cached.
    // Only let a field overwrite the previous entry when the new value is
    // actually present.
    const merged = Object.assign({}, prev, norm);
    ['likes', 'dislikes', 'comments'].forEach(function (k) {
      if (norm[k] == null && prev[k] != null) merged[k] = prev[k];
    });
    merged.cachedAt = Date.now();
    next[norm.videoId] = merged;
    const ids = Object.keys(next).sort(function (a, b) {
      return (next[b].cachedAt || 0) - (next[a].cachedAt || 0);
    });
    while (ids.length > MAX_ENTRIES) {
      delete next[ids.pop()];
    }
    return next;
  }

  function channelEntries(cache, channelId, excludeVideoId) {
    if (!cache || !channelId) return [];
    return Object.keys(cache)
      .map(function (id) {
        return cache[id];
      })
      .filter(function (s) {
        return s && s.channelId === channelId && s.videoId !== excludeVideoId;
      });
  }

  const api = {
    parseCount,
    normalize,
    engagementRate,
    likeRatio,
    viewsPerDay,
    aggregate,
    compareMetric,
    buildCompareRows,
    pctDelta,
    fmtDelta,
    scrapeRelatedFromDom,
    mergeCacheEntry,
    channelEntries,
    MAX_ENTRIES
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNVideoStatsCache = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
