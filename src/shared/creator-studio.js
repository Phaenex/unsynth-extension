/**
 * Creator Studio — keyword research, rank tracking, thumbnail tests, publish schedule.
 * Data in chrome.storage.local; keyword suggest via Google YouTube autocomplete.
 */
(function (g) {
  'use strict';

  const STOP = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'it',
    'this', 'that', 'your', 'you', 'my', 'how', 'what', 'why', 'when', 'who', 'are', 'was', 'be', 'has', 'have',
    'had', 'not', 'all', 'can', 'will', 'just', 'get', 'got', 'its', 'our', 'we', 'they', 'them', 'their', 'i',
    'me', 'he', 'she', 'his', 'her', 'as', 'if', 'so', 'do', 'did', 'does', 'about', 'into', 'out', 'up', 'down',
    'video', 'videos', 'youtube', 'watch', 'full', 'new', 'best', 'top', 'vs', 'part', 'episode', 'ep'
  ]);

  function uid() {
    return 'cs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\w\s#@+-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w));
  }

  /** Keyword ideas from title, tags, description (local heuristics). */
  function suggestFromPage(title, tags, description) {
    const titleWords = tokenize(title);
    const tagList = (tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    const descWords = tokenize(description).slice(0, 40);
    const bigrams = [];
    const raw = String(title || '').toLowerCase().split(/\s+/).filter(Boolean);
    for (let i = 0; i < raw.length - 1; i++) {
      const bg = raw[i] + ' ' + raw[i + 1];
      if (bg.length > 5 && !STOP.has(raw[i])) bigrams.push(bg);
    }
    const scored = new Map();
    function add(kw, score) {
      const k = kw.trim().toLowerCase();
      if (!k || k.length < 3) return;
      scored.set(k, (scored.get(k) || 0) + score);
    }
    titleWords.forEach((w) => add(w, 3));
    bigrams.forEach((b) => add(b, 4));
    tagList.forEach((t) => add(t, 5));
    descWords.forEach((w) => add(w, 1));
    tagList.forEach((t) => {
      const parts = t.split(/\s+/);
      if (parts.length > 1) parts.forEach((p) => add(p, 2));
    });
    return [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([keyword, score]) => ({ keyword, score, source: 'page' }));
  }

  /** Parse Google YouTube suggest JSONP-style response. */
  function parseSuggestBody(text) {
    try {
      const m = String(text).match(/^\s*\[.*\]\s*$/s);
      if (!m) {
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start < 0 || end < 0) return [];
        return JSON.parse(text.slice(start, end + 1))[1] || [];
      }
      return JSON.parse(text)[1] || [];
    } catch (_) {
      return [];
    }
  }

  function mergeSuggestions(page, remote) {
    const seen = new Set();
    const out = [];
    (remote || []).forEach((kw) => {
      const k = String(kw).trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ keyword: k, score: 6, source: 'suggest' });
    });
    (page || []).forEach((item) => {
      if (seen.has(item.keyword)) return;
      seen.add(item.keyword);
      out.push(item);
    });
    return out.slice(0, 30);
  }

  function normalizeRankTracks(list) {
    return Array.isArray(list) ? list : [];
  }

  function normalizeSchedule(list) {
    return Array.isArray(list) ? list : [];
  }

  function normalizeThumbnailTests(list) {
    return Array.isArray(list) ? list : [];
  }

  function addRankTrack(store, { keyword, videoId, videoTitle }) {
    const tracks = normalizeRankTracks(store);
    const kw = String(keyword || '').trim();
    const vid = String(videoId || '').trim();
    if (!kw || !vid) return { ok: false, error: 'missing_fields' };
    const existing = tracks.find((t) => t.keyword === kw && t.videoId === vid);
    // Both callers do chrome.storage.local.set({ creatorRankTracks: res.tracks
    // }) unconditionally — this branch used to omit `tracks` entirely, so
    // clicking an already-tracked keyword a second time wrote
    // creatorRankTracks: undefined and wiped the whole rank-tracking list.
    if (existing) return { ok: true, track: existing, duplicate: true, tracks };
    const track = {
      id: uid(),
      keyword: kw,
      videoId: vid,
      videoTitle: String(videoTitle || '').slice(0, 120),
      lastRank: null,
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    tracks.unshift(track);
    return { ok: true, track, tracks };
  }

  function recordRank(tracks, trackId, rank) {
    const list = normalizeRankTracks(tracks);
    const t = list.find((x) => x.id === trackId);
    if (!t) return null;
    const r = rank == null ? null : Math.max(1, Math.floor(Number(rank)));
    t.lastRank = r;
    t.updatedAt = Date.now();
    if (r != null) {
      t.history = (t.history || []).concat([{ at: Date.now(), rank: r }]).slice(-60);
    }
    return list;
  }

  function addScheduleItem(store, { title, publishAt, notes, videoId }) {
    const items = normalizeSchedule(store);
    const item = {
      id: uid(),
      title: String(title || 'Untitled').slice(0, 140),
      publishAt: publishAt || null,
      notes: String(notes || '').slice(0, 2000),
      videoId: videoId ? String(videoId) : '',
      status: 'draft',
      createdAt: Date.now()
    };
    items.unshift(item);
    return { ok: true, item, items };
  }

  function addThumbnailTest(store, { videoId, videoTitle, variants }) {
    const tests = normalizeThumbnailTests(store);
    const vid = String(videoId || '').trim();
    if (!vid) return { ok: false, error: 'missing_video' };
    const test = {
      id: uid(),
      videoId: vid,
      videoTitle: String(videoTitle || '').slice(0, 120),
      variants: (variants || [{ label: 'A', notes: 'Current thumbnail', viewsAtStart: null }]).map((v, i) => ({
        id: 'v' + i,
        label: String(v.label || String.fromCharCode(65 + i)).slice(0, 8),
        notes: String(v.notes || '').slice(0, 500),
        viewsAtStart: v.viewsAtStart != null ? Number(v.viewsAtStart) : null,
        addedAt: Date.now()
      })),
      activeVariant: 0,
      createdAt: Date.now()
    };
    tests.unshift(test);
    return { ok: true, test, tests };
  }

  /** Parse search results HTML for video id positions (best-effort). */
  function parseSearchRanks(html, videoId) {
    const id = String(videoId || '').trim();
    if (!id || !html) return null;
    const re = /"videoId":"([^"]+)"/g;
    let m;
    let rank = 0;
    const seen = new Set();
    while ((m = re.exec(html))) {
      const vid = m[1];
      if (seen.has(vid)) continue;
      seen.add(vid);
      rank += 1;
      if (vid === id) return rank;
      if (rank >= 50) break;
    }
    return null;
  }

  /** Actionable SEO tips from page metadata (local heuristics). */
  function seoChecklist(title, tags, description) {
    const tips = [];
    const t = String(title || '').trim();
    const len = t.length;
    if (!len) tips.push({ level: 'warn', text: 'Add a descriptive title before publishing.' });
    else if (len < 40) tips.push({ level: 'warn', text: 'Title may be short for search — aim for 40–70 characters.' });
    else if (len > 70) tips.push({ level: 'warn', text: 'Title may truncate in results — consider shortening to ~70 characters.' });
    else tips.push({ level: 'good', text: 'Title length looks solid for search.' });

    const tagList = (tags || []).map((x) => String(x).trim()).filter(Boolean);
    if (tagList.length < 5) tips.push({ level: 'warn', text: 'Use 5–15 relevant tags; you have ' + tagList.length + '.' });
    else if (tagList.length > 15) tips.push({ level: 'warn', text: 'Many tags (' + tagList.length + ') — focus on the most relevant.' });
    else tips.push({ level: 'good', text: 'Tag count looks reasonable (' + tagList.length + ').' });

    const desc = String(description || '').trim();
    if (desc.length < 120) tips.push({ level: 'warn', text: 'Description is short — first 2 lines drive search snippets.' });
    else tips.push({ level: 'good', text: 'Description has enough text for snippets and keyword context.' });

    return tips;
  }

  function exportCreatorBundle(rankTracks, schedule, thumbnailTests) {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        creatorRankTracks: normalizeRankTracks(rankTracks),
        creatorSchedule: normalizeSchedule(schedule),
        creatorThumbnailTests: normalizeThumbnailTests(thumbnailTests)
      },
      null,
      2
    );
  }

  /** Schedule items due within `withinMs` (default 7 days). */
  function dueScheduleItems(schedule, withinMs) {
    const windowMs = withinMs != null ? withinMs : 7 * 86400000;
    const now = Date.now();
    return normalizeSchedule(schedule).filter((item) => {
      if (!item.publishAt) return false;
      const t = Date.parse(item.publishAt);
      return t >= now && t - now <= windowMs;
    });
  }

  const api = {
    uid,
    tokenize,
    suggestFromPage,
    parseSuggestBody,
    mergeSuggestions,
    normalizeRankTracks,
    normalizeSchedule,
    normalizeThumbnailTests,
    addRankTrack,
    recordRank,
    addScheduleItem,
    addThumbnailTest,
    parseSearchRanks,
    seoChecklist,
    exportCreatorBundle,
    dueScheduleItems,
    STORAGE_KEYS: {
      rankTracks: 'creatorRankTracks',
      schedule: 'creatorSchedule',
      thumbnailTests: 'creatorThumbnailTests'
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNCreatorStudio = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
