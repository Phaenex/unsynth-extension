/**
 * Hidden-gems discovery — pure scoring and ranking. No chrome APIs, no DOM.
 * Loaded in content scripts, the service worker, extension pages, and Node tests.
 *
 * The shelf answers one question: "what would I probably like that YouTube's home
 * feed will never show me?" YouTube optimises for recency and popularity, so the
 * things it buries are exactly the four signals scored here:
 *
 *   lowViewsForAge  – few views for how long it has been up
 *   smallChannel    – channel far below the subscriber counts you normally watch
 *   driftedSub      – you subscribed, then stopped watching
 *   unfinishedSave  – you saved it to a playlist and never came back
 *
 * Each rule contributes 0..1, is weighted, and reports a human-readable reason so
 * the shelf can say *why* a video is there instead of being another black box.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    if (root) root.UNDiscover = api;
    if (typeof self !== 'undefined') self.UNDiscover = api;
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const DAY_MS = 86400000;

  const DEFAULTS = {
    maxItems: 12,
    // A subscription counts as "drifted" after this long with no watch.
    driftDays: 120,
    // Views/day at or below this reads as genuinely overlooked.
    gemViewsPerDay: 20,
    // Ignore anything younger than this — a 2-day-old video has low views
    // because it is new, not because it was overlooked.
    minAgeDays: 30,
    weights: {
      lowViewsForAge: 1.0,
      smallChannel: 0.7,
      driftedSub: 1.2,
      unfinishedSave: 1.1
    },
    // Rules the user has switched off are skipped entirely.
    rules: {
      lowViewsForAge: true,
      smallChannel: true,
      driftedSub: true,
      unfinishedSave: true
    }
  };

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function dayOf(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  function dayToMs(ds) {
    const p = String(ds || '').split('-');
    if (p.length !== 3) return 0;
    const ms = Date.UTC(+p[0], +p[1] - 1, +p[2]);
    return isFinite(ms) ? ms : 0;
  }

  /** A channel's uploads playlist is its id with the UC prefix swapped for UU. */
  function uploadsPlaylistId(channelId) {
    const id = String(channelId || '');
    return /^UC[\w-]{20,}$/.test(id) ? 'UU' + id.slice(2) : '';
  }

  /**
   * Last day each channel was watched, derived from watchStats.
   *
   * watchStats has no per-channel timestamp, but importVideoDays is
   * { day: { videoId: 1 } } and channelVideos is { channelName: { videoId: 1 } }.
   * Joining them on videoId recovers a last-seen day per channel.
   *
   * @returns {Object} { [channelName]: 'YYYY-MM-DD' }
   */
  function lastWatchDayByChannel(watchStats) {
    const out = Object.create(null);
    if (!watchStats) return out;
    const byDay = watchStats.importVideoDays || {};
    const chVideos = watchStats.channelVideos || {};

    const dayOfVideo = Object.create(null);
    Object.keys(byDay).forEach((day) => {
      const vids = byDay[day] || {};
      Object.keys(vids).forEach((vid) => {
        if (!dayOfVideo[vid] || day > dayOfVideo[vid]) dayOfVideo[vid] = day;
      });
    });

    Object.keys(chVideos).forEach((channel) => {
      const vids = chVideos[channel] || {};
      Object.keys(vids).forEach((vid) => {
        const day = dayOfVideo[vid];
        if (!day) return;
        if (!out[channel] || day > out[channel]) out[channel] = day;
      });
    });
    return out;
  }

  /**
   * Condense everything Unsynth already knows about the viewer into the shape the
   * scorer needs. All inputs are optional — the profile degrades rather than fails.
   *
   * @param {Object} watchStats  UNWatchStats aggregate (local)
   * @param {Object} opts        { subscribedChannelIds, savedVideoIds, watchedVideoIds, subscriberCounts }
   */
  function buildProfile(watchStats, opts) {
    const o = opts || {};
    const ws = watchStats || {};
    const channelMap = ws.channelMap || {};

    // Channel id -> plays, so drift can be judged by id (names collide/rename).
    const playsByChannelId = Object.create(null);
    const playsByChannelName = Object.create(null);
    const idByName = Object.create(null);
    Object.keys(channelMap).forEach((name) => {
      const entry = channelMap[name] || [];
      const plays = num(entry[1]);
      const id = entry[2] || '';
      playsByChannelName[name] = plays;
      if (id) {
        idByName[name] = id;
        playsByChannelId[id] = (playsByChannelId[id] || 0) + plays;
      }
    });

    const lastDayByName = lastWatchDayByChannel(ws);
    const lastDayByChannelId = Object.create(null);
    Object.keys(lastDayByName).forEach((name) => {
      const id = idByName[name];
      if (id) lastDayByChannelId[id] = lastDayByName[name];
    });

    // Typical subscriber count of the channels actually watched — the yardstick
    // for "small". Median, not mean: one huge channel shouldn't move the bar.
    const counts = [];
    const subCounts = o.subscriberCounts || {};
    Object.keys(subCounts).forEach((id) => {
      const n = num(subCounts[id]);
      if (n > 0) counts.push(n);
    });
    counts.sort((a, b) => a - b);
    const medianSubs = counts.length ? counts[Math.floor(counts.length / 2)] : 0;

    return {
      playsByChannelId,
      playsByChannelName,
      lastDayByChannelId,
      lastDayByName,
      medianSubs,
      subscribedChannelIds: new Set(o.subscribedChannelIds || []),
      savedVideoIds: new Set(o.savedVideoIds || []),
      watchedVideoIds: new Set(o.watchedVideoIds || []),
      topChannels: (ws.topChannels || []).slice(0, 30).map((c) => c[0])
    };
  }

  function ageDays(publishedAt, now) {
    const ms = typeof publishedAt === 'number' ? publishedAt : Date.parse(publishedAt || '');
    if (!isFinite(ms) || !ms) return 0;
    return Math.max(0, (now - ms) / DAY_MS);
  }

  /**
   * Score one candidate against the profile.
   * @returns {{ score: number, reasons: string[], parts: Object }}
   */
  function scoreVideo(video, profile, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const weights = Object.assign({}, DEFAULTS.weights, o.weights || {});
    const rules = Object.assign({}, DEFAULTS.rules, o.rules || {});
    const now = o.now || Date.now();
    const p = profile || buildProfile(null, {});
    const v = video || {};
    const parts = {};
    const reasons = [];

    const age = ageDays(v.publishedAt, now);
    const views = num(v.viewCount);

    // 1. Low views for its age.
    if (rules.lowViewsForAge && age >= o.minAgeDays) {
      const perDay = views / Math.max(1, age);
      // 0 at gemViewsPerDay, approaching 1 as views/day approaches zero.
      const raw = 1 - Math.min(1, perDay / Math.max(1, o.gemViewsPerDay));
      if (raw > 0) {
        parts.lowViewsForAge = raw;
        if (raw > 0.5) {
          reasons.push(
            views > 0
              ? formatViews(views) + ' views in ' + formatAge(age)
              : 'barely seen in ' + formatAge(age)
          );
        }
      }
    }

    // 2. Small channel relative to what the viewer normally watches.
    if (rules.smallChannel && p.medianSubs > 0) {
      const subs = num(v.subscriberCount);
      if (subs > 0 && subs < p.medianSubs) {
        const raw = 1 - subs / p.medianSubs;
        parts.smallChannel = raw;
        if (raw > 0.6) reasons.push('small channel — ' + formatViews(subs) + ' subs');
      }
    }

    // 3. Subscribed, then stopped watching.
    if (rules.driftedSub && v.channelId && p.subscribedChannelIds.has(v.channelId)) {
      const lastDay = p.lastDayByChannelId[v.channelId];
      const daysSince = lastDay ? Math.max(0, (now - dayToMs(lastDay)) / DAY_MS) : Infinity;
      if (daysSince >= o.driftDays) {
        // Saturates at 2x driftDays so "never watched" and "gone 8 months" rank
        // close together rather than letting Infinity dominate the whole shelf.
        const raw = Math.min(1, daysSince / (o.driftDays * 2));
        parts.driftedSub = raw;
        reasons.push(lastDay ? 'a sub you have not watched since ' + lastDay.slice(0, 7) : 'a sub you never got to');
      }
    }

    // 4. Saved and never watched.
    if (rules.unfinishedSave && v.videoId && p.savedVideoIds.has(v.videoId) && !p.watchedVideoIds.has(v.videoId)) {
      parts.unfinishedSave = 1;
      reasons.push('saved to a playlist, never watched');
    }

    let score = 0;
    Object.keys(parts).forEach((key) => {
      score += parts[key] * num(weights[key]);
    });

    return { score, reasons, parts };
  }

  function formatViews(n) {
    const v = num(n);
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  }

  function formatAge(days) {
    const d = Math.round(days);
    if (d >= 730) return Math.floor(d / 365) + ' years';
    if (d >= 365) return 'a year';
    if (d >= 60) return Math.floor(d / 30) + ' months';
    return d + ' days';
  }

  /** Deterministic PRNG so a given shuffle seed always produces the same order. */
  function seededRandom(seed) {
    let s = (num(seed) || 1) >>> 0;
    return function () {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }

  /** Fisher-Yates with a seeded PRNG. Does not mutate the input. */
  function shuffleWithSeed(arr, seed) {
    const out = (arr || []).slice();
    const rand = seededRandom(seed);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /**
   * Score, filter, de-duplicate and order candidates for the shelf.
   *
   * Ordering is deliberately not "strictly best first": the top band is shuffled
   * so pressing Shuffle produces a genuinely different row instead of the same
   * twelve videos in the same order forever. Videos already watched are dropped,
   * and one channel can never take more than `maxPerChannel` slots.
   */
  function rankVideos(videos, profile, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const p = profile || buildProfile(null, {});
    const maxPerChannel = o.maxPerChannel || 2;
    const seen = new Set();

    const scored = [];
    (videos || []).forEach((v) => {
      if (!v || !v.videoId) return;
      if (seen.has(v.videoId)) return;
      seen.add(v.videoId);
      // Never recommend something already watched — that is the opposite of the point.
      if (p.watchedVideoIds.has(v.videoId)) return;
      const result = scoreVideo(v, p, o);
      if (result.score <= 0) return;
      scored.push(Object.assign({}, v, { score: result.score, reasons: result.reasons, parts: result.parts }));
    });

    scored.sort((a, b) => b.score - a.score || String(a.videoId).localeCompare(String(b.videoId)));

    // Take a pool wider than the shelf, shuffle it, then enforce channel variety.
    const pool = shuffleWithSeed(scored.slice(0, Math.max(o.maxItems * 3, o.maxItems)), o.seed);
    const perChannel = Object.create(null);
    const out = [];
    pool.forEach((v) => {
      if (out.length >= o.maxItems) return;
      const key = v.channelId || v.channelTitle || '?';
      const used = perChannel[key] || 0;
      if (used >= maxPerChannel) return;
      perChannel[key] = used + 1;
      out.push(v);
    });
    return out;
  }

  /** Compact candidate list for the optional LLM ranking pass. */
  function promptPayload(videos, limit) {
    return (videos || []).slice(0, limit || 40).map((v) => ({
      id: v.videoId,
      title: String(v.title || '').slice(0, 140),
      channel: String(v.channelTitle || '').slice(0, 80),
      views: num(v.viewCount),
      why: (v.reasons || []).slice(0, 2)
    }));
  }

  /**
   * Apply an LLM's ordering to already-scored videos.
   * The model returns ids (and optionally a one-line note); anything it invents or
   * omits is ignored, so a bad response degrades to the local order rather than
   * emptying the shelf.
   */
  function applyAiRanking(videos, aiResult) {
    const byId = Object.create(null);
    (videos || []).forEach((v) => {
      if (v && v.videoId) byId[v.videoId] = v;
    });
    const picks = (aiResult && Array.isArray(aiResult.picks) ? aiResult.picks : []).slice(0, 60);
    const out = [];
    const used = new Set();
    picks.forEach((pick) => {
      const id = pick && (typeof pick === 'string' ? pick : pick.id);
      const v = id && byId[id];
      if (!v || used.has(id)) return;
      used.add(id);
      const note = pick && typeof pick === 'object' ? String(pick.why || '').slice(0, 120) : '';
      out.push(note ? Object.assign({}, v, { aiWhy: note }) : v);
    });
    // Anything the model dropped keeps its local rank behind the picks.
    (videos || []).forEach((v) => {
      if (v && v.videoId && !used.has(v.videoId)) out.push(v);
    });
    return out;
  }

  return {
    DEFAULTS,
    uploadsPlaylistId,
    lastWatchDayByChannel,
    buildProfile,
    ageDays,
    scoreVideo,
    rankVideos,
    shuffleWithSeed,
    seededRandom,
    formatViews,
    formatAge,
    promptPayload,
    applyAiRanking,
    dayOf
  };
});
