/**
 * Watch-stats aggregation — shared by live tracker, Takeout import, and backup merge.
 * Loaded in content scripts, extension pages, and Node tests.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.UNWatchStats = api;
    if (typeof self !== 'undefined') self.UNWatchStats = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function fmtDayLocal(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function dayNum(ds) {
    const p = String(ds).split('-');
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }

  function emptyStats(ds) {
    return {
      version: 2,
      total: 0,
      uniqueVideos: 0,
      uniqueChannels: 0,
      removed: 0,
      firstDate: ds || null,
      lastDate: ds || null,
      activeDays: 0,
      longestStreak: 0,
      currentStreak: 0,
      busiestDay: null,
      byHour: new Array(24).fill(0),
      byDow: new Array(7).fill(0),
      byMonth: {},
      byDate: {},
      topChannels: [],
      channelMap: {},
      channelVideos: {},
      importVideoDays: {},
      live: false
    };
  }

  function normalizeStats(ws) {
    if (!ws) return null;
    const out = Object.assign({}, ws);
    if (!out.byHour || out.byHour.length !== 24) out.byHour = new Array(24).fill(0);
    if (!out.byDow || out.byDow.length !== 7) out.byDow = new Array(7).fill(0);
    if (!out.byMonth) out.byMonth = {};
    if (!out.byDate) out.byDate = {};
    if (!out.channelMap) out.channelMap = {};
    if (!out.channelVideos) out.channelVideos = {};
    if (!out.importVideoDays) out.importVideoDays = {};
    return out;
  }

  function mergeHistograms(target, source, len) {
    if (!source) return;
    for (let i = 0; i < len; i++) target[i] = (target[i] || 0) + (source[i] || 0);
  }

  function mergeCountMap(target, source) {
    if (!source) return;
    Object.keys(source).forEach((k) => {
      target[k] = (target[k] || 0) + source[k];
    });
  }

  /** Merge import + live daily histogram buckets into one map. */
  function mergeAllByDate(target, source) {
    if (!source) return;
    mergeCountMap(target, source.byDate);
    mergeCountMap(target, source.liveByDate);
  }

  function mergeAllHourDow(targetHour, targetDow, source) {
    if (!source) return;
    mergeHistograms(targetHour, source.byHour, 24);
    mergeHistograms(targetHour, source.liveByHour, 24);
    mergeHistograms(targetDow, source.byDow, 7);
    mergeHistograms(targetDow, source.liveByDow, 7);
  }

  function mergeAllMonth(target, source) {
    if (!source) return;
    mergeCountMap(target, source.byMonth);
    mergeCountMap(target, source.liveByMonth);
  }

  function mergeVideoDayMaps(a, b) {
    const out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach((day) => {
      out[day] = Object.assign({}, out[day] || {}, b[day]);
    });
    return out;
  }

  function mergeChannelVideoMaps(a, b) {
    const out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach((name) => {
      out[name] = Object.assign({}, out[name] || {}, b[name]);
    });
    return out;
  }

  /**
   * Merge channel tallies. When channelVideos maps exist, distinct = union of video ids;
   * otherwise distinct uses Math.max (approximate — may under-count when both sides differ).
   */
  function mergeChannelMaps(a, b, aVideos, bVideos) {
    const out = Object.assign({}, a || {});
    const videos = mergeChannelVideoMaps(aVideos, bVideos);
    if (!b) return { channelMap: out, channelVideos: videos };
    Object.keys(b).forEach((name) => {
      const src = b[name];
      const dst = out[name];
      const plays = (dst ? dst[1] || 0 : 0) + (src[1] || 0);
      let distinct;
      const union = Object.assign({}, videos[name] || {});
      if (Object.keys(union).length) {
        distinct = Object.keys(union).length;
      } else {
        distinct = Math.max(dst ? dst[0] || 0 : 0, src[0] || 0);
      }
      out[name] = [distinct, plays, src[2] || (dst && dst[2]) || ''];
    });
    Object.keys(videos).forEach((name) => {
      if (!out[name]) {
        const vids = videos[name];
        out[name] = [Object.keys(vids).length, 0, ''];
      } else {
        out[name][0] = Object.keys(videos[name]).length;
      }
    });
    return { channelMap: out, channelVideos: videos };
  }

  // How many channels the ranked list keeps. This was 30, which is fine for a
  // few weeks of live tracking and badly wrong for a real Takeout import: a
  // measured 15,805-channel history had 15,775 channels dropped, leaving the
  // "top channels" list representing only 16.5% of actual plays. The full
  // tallies live in channelMap either way — this cap only bounds the ranked
  // array that gets rendered and re-serialised on every update.
  var TOP_CHANNELS_LIMIT = 1000;

  function topChannelsFromMap(channelMap, limit) {
    var n = limit || TOP_CHANNELS_LIMIT;
    return Object.keys(channelMap)
      .map((name) => [name, channelMap[name][0], channelMap[name][1], channelMap[name][2]])
      .sort((a, b) => b[1] - a[1] || b[2] - a[2])
      .slice(0, n);
  }

  function sumByDate(byDate) {
    if (!byDate) return 0;
    return Object.keys(byDate).reduce((s, k) => s + (byDate[k] || 0), 0);
  }

  function combinedPlayTotal(ws) {
    if (!ws) return 0;
    return sumByDate(ws.byDate) + sumByDate(ws.liveByDate);
  }

  /** Distinct video count — watchedVideos set wins when available. */
  function effectiveUniqueVideos(ws, watchedCount) {
    if (watchedCount != null && watchedCount >= 0) return watchedCount;
    return ws ? ws.uniqueVideos || 0 : 0;
  }

  /**
   * Align aggregate fields with histograms and the watchedVideos set.
   * total = sum(byDate + liveByDate) when histograms have data; uniqueVideos = watched set size when known.
   */
  function reconcileWatchStats(ws, watchedIdsOrCount) {
    if (!ws) return ws;
    const out = recomputeDerived(normalizeStats(ws));
    const byDateSum = combinedPlayTotal(out);
    if (byDateSum > 0) out.total = byDateSum;
    if (out.importedAt && out.importedPlayTotal == null) out.importedPlayTotal = sumByDate(out.byDate);
    const count = Array.isArray(watchedIdsOrCount) ? watchedIdsOrCount.length : watchedIdsOrCount;
    if (count != null && count >= 0) out.uniqueVideos = count;
    return out;
  }

  function recomputeDerived(ws) {
    const combined = Object.create(null);
    mergeCountMap(combined, ws.byDate);
    mergeCountMap(combined, ws.liveByDate);
    const keys = Object.keys(combined).sort();
    ws.activeDays = keys.length;
    if (keys.length) {
      if (!ws.firstDate || keys[0] < ws.firstDate) ws.firstDate = keys[0];
      if (!ws.lastDate || keys[keys.length - 1] > ws.lastDate) ws.lastDate = keys[keys.length - 1];
    }
    const set = Object.create(null);
    keys.forEach((k) => (set[dayNum(k)] = 1));
    let run = 0;
    let best = 0;
    let prev = null;
    keys.forEach((k) => {
      const n = dayNum(k);
      run = prev != null && n - prev === 1 ? run + 1 : 1;
      if (run > best) best = run;
      prev = n;
    });
    ws.longestStreak = best;
    let curr = 0;
    if (ws.lastDate) {
      let n2 = dayNum(ws.lastDate);
      while (set[n2]) {
        curr++;
        n2--;
      }
      if (dayNum(ws.lastDate) < dayNum(todayKey()) - 1) {
        curr = 0;
      }
    }
    ws.currentStreak = curr;
    const bz = keys.map((k) => [k, combined[k]]).sort((a, b) => b[1] - a[1])[0];
    ws.busiestDay = bz ? { date: bz[0], count: bz[1] } : null;
    ws.uniqueChannels = Object.keys(ws.channelMap || {}).length;
    ws.topChannels = topChannelsFromMap(ws.channelMap || {});
    return ws;
  }

  function mergeWatchStats(imported, existing, opts) {
    const o = opts || {};
    const a = normalizeStats(imported);
    const b = normalizeStats(existing);
    if (!a) return o.watchedCount != null ? reconcileWatchStats(b, o.watchedCount) : b;
    if (!b) return reconcileWatchStats(recomputeDerived(a), o.watchedCount != null ? o.watchedCount : a.uniqueVideos);
    const out = normalizeStats(Object.assign({}, b));
    out.removed = (a.removed || 0) + (b.removed || 0);
    mergeAllHourDow(out.byHour, out.byDow, a);
    mergeAllMonth(out.byMonth, a);
    mergeAllByDate(out.byDate, a);
    const chMerge = mergeChannelMaps(a.channelMap, b.channelMap, a.channelVideos, b.channelVideos);
    out.channelMap = chMerge.channelMap;
    out.channelVideos = chMerge.channelVideos;
    out.importVideoDays = mergeVideoDayMaps(a.importVideoDays, b.importVideoDays);
    out.live = !!(a.live || b.live);
    if (a.importedAt && !b.importedAt) out.importedAt = a.importedAt;
    if (b.importedAt) out.importedAt = b.importedAt;
    if (a.lastLiveUpdate || b.lastLiveUpdate) out.lastLiveUpdate = Math.max(a.lastLiveUpdate || 0, b.lastLiveUpdate || 0);
    const importedPlays = sumByDate(a.byDate) || (a.importedAt ? a.total : 0) || 0;
    out.importedPlayTotal = (b.importedPlayTotal || 0) + importedPlays;
    const watchedCount = o.watchedCount != null ? o.watchedCount : Math.max(a.uniqueVideos || 0, b.uniqueVideos || 0);
    return reconcileWatchStats(out, watchedCount);
  }

  function mergeWatchedIds(a, b) {
    const s = new Set(a || []);
    (b || []).forEach((id) => s.add(id));
    return Array.from(s);
  }

  function mergeWatchProgress(a, b) {
    const out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach((id) => {
      out[id] = Math.max(out[id] || 0, b[id] || 0);
    });
    return out;
  }

  /**
   * Merge two videoId -> watch-timestamp maps, keeping the LATER date per
   * video. Values may be epoch ms (what markFull stores) or 'YYYY-MM-DD'
   * strings (what the Takeout importer stores), so compare on a normalized
   * numeric time rather than on the raw values, which are not comparable to
   * each other. The original value is preserved so downstream formatters keep
   * whatever precision they were given.
   */
  function mergeWatchedDates(a, b) {
    const timeOf = (v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const n = v.indexOf('-') !== -1 ? new Date(v).getTime() : Number(v);
        return isNaN(n) ? 0 : n;
      }
      return 0;
    };
    const out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach((id) => {
      if (out[id] == null || timeOf(b[id]) > timeOf(out[id])) out[id] = b[id];
    });
    return out;
  }

  /** Minimal stats when only video IDs are imported (Watchmarker / URL scrape). */
  function buildIdOnlyStats(watchedCount) {
    const ds = todayKey();
    return reconcileWatchStats(
      Object.assign(emptyStats(ds), {
        importedAt: ds,
        uniqueVideos: watchedCount || 0,
        total: 0
      }),
      watchedCount || 0
    );
  }

  function ensureLiveBuckets(out) {
    if (!out.liveByHour || out.liveByHour.length !== 24) out.liveByHour = new Array(24).fill(0);
    if (!out.liveByDow || out.liveByDow.length !== 7) out.liveByDow = new Array(7).fill(0);
    if (!out.liveByMonth) out.liveByMonth = {};
    if (!out.liveByDate) out.liveByDate = {};
    return out;
  }

  /** Increment stats for one completed watch (live tracker). */
  function recordWatchIncrement(ws, opts) {
    const o = opts || {};
    const now = o.date || new Date();
    const ds = o.day || fmtDayLocal(now);
    const isNew = !!o.isNew;
    const ch = o.channel || {};
    const videoId = o.videoId || null;

    let out = normalizeStats(ws) || emptyStats(ds);

    if (videoId && out.importVideoDays && out.importVideoDays[ds] && out.importVideoDays[ds][videoId]) {
      if (o.watchedCount != null && o.watchedCount >= 0) out.uniqueVideos = o.watchedCount;
      out.live = true;
      out.lastLiveUpdate = Date.now();
      return reconcileWatchStats(out, o.watchedCount != null ? o.watchedCount : out.uniqueVideos);
    }

    const imported = !!out.importedAt;
    if (imported) ensureLiveBuckets(out);

    const byDate = imported ? out.liveByDate : out.byDate;
    const byHour = imported ? out.liveByHour : out.byHour;
    const byDow = imported ? out.liveByDow : out.byDow;
    const byMonth = imported ? out.liveByMonth : out.byMonth;

    out.total = (out.total || 0) + 1;
    byHour[now.getHours()] = (byHour[now.getHours()] || 0) + 1;
    byDow[now.getDay()] = (byDow[now.getDay()] || 0) + 1;
    byDate[ds] = (byDate[ds] || 0) + 1;
    byMonth[ds.slice(0, 7)] = (byMonth[ds.slice(0, 7)] || 0) + 1;
    if (!out.firstDate || ds < out.firstDate) out.firstDate = ds;
    if (!out.lastDate || ds > out.lastDate) out.lastDate = ds;
    out.live = true;
    out.lastLiveUpdate = Date.now();

    if (ch.name) {
      const cm = out.channelMap;
      const cv = out.channelVideos;
      const e = cm[ch.name] || (cm[ch.name] = [0, 0, ch.id || '']);
      e[1] += 1;
      if (isNew && videoId) {
        const bucket = cv[ch.name] || (cv[ch.name] = {});
        if (!bucket[videoId]) {
          bucket[videoId] = 1;
          e[0] = Object.keys(bucket).length;
        }
      } else if (isNew) {
        e[0] += 1;
      }
      if (ch.id) e[2] = ch.id;
    }

    if (o.watchedCount != null && o.watchedCount >= 0) out.uniqueVideos = o.watchedCount;
    else if (isNew) out.uniqueVideos = (out.uniqueVideos || 0) + 1;

    return reconcileWatchStats(out, o.watchedCount != null ? o.watchedCount : out.uniqueVideos);
  }

  function todayKey() {
    return fmtDayLocal(new Date());
  }

  function sourceLabel(ws) {
    if (!ws) return 'none';
    if (ws.live && ws.importedAt) return 'merged';
    if (ws.live) return 'live';
    return 'imported';
  }

  function personaOf(byHour) {
    if (!byHour || !byHour.length) return null;
    const p = byHour.indexOf(Math.max.apply(null, byHour));
    return p >= 22 || p <= 4 ? 'night owl' : p >= 5 && p <= 10 ? 'early bird' : p >= 11 && p <= 16 ? 'daytime' : 'evening';
  }

  /** Compact taste summary for Playlist Forge /api/suggest. */
  function summarizeForForge(ws, ss) {
    const out = {};
    if (ws) {
      out.total = ws.total;
      out.uniqueChannels = ws.uniqueChannels;
      out.activeDays = ws.activeDays;
      out.firstDate = ws.firstDate;
      out.lastDate = ws.lastDate;
      out.topChannels = (ws.topChannels || []).slice(0, 20).map(function (c) {
        return [c[0], c[1]];
      });
      if (ws.byHour) {
        out.peakHour = ws.byHour.indexOf(Math.max.apply(null, ws.byHour));
        out.persona = personaOf(ws.byHour);
      }
    }
    if (ss) {
      out.topSearchWords = (ss.topWords || []).slice(0, 25).map(function (w) {
        return w[0];
      });
      out.topSearchTerms = (ss.topTerms || []).slice(0, 12).map(function (t) {
        return t[0];
      });
    }
    return out;
  }

  /** Play counts split for merged import + live tracking UI. */
  function playBreakdown(ws) {
    if (!ws) return { total: 0, imported: 0, live: 0, today: 0 };
    const histTotal = combinedPlayTotal(ws);
    const total = Math.max(histTotal, ws.total || 0);
    const imported = ws.importedPlayTotal != null ? ws.importedPlayTotal : ws.importedAt ? sumByDate(ws.byDate) : 0;
    const live = ws.live ? Math.max(0, total - imported) : 0;
    const day = todayKey();
    const today = (ws.byDate ? ws.byDate[day] || 0 : 0) + (ws.liveByDate ? ws.liveByDate[day] || 0 : 0);
    return { total, imported, live, today };
  }

  /** YouTube watch or Shorts page where live progress tracking applies. */
  /**
   * Minimum seconds on a Short before it counts as a deliberate watch.
   *
   * A Short is ~20s and LOOPS, so percentage is close to meaningless there:
   * scroll past one, it plays 15 seconds, crosses the 75% full-watch
   * threshold, and is recorded forever as a fully-watched video. Channels
   * that publish mostly Shorts then dominate Top Channels without the user
   * ever having chosen to watch them.
   *
   * 30s is roughly one and a half loops of a typical Short -- long enough
   * that you stopped rather than scrolled past, short enough that genuinely
   * watching one still counts.
   */
  var SHORT_MIN_SECONDS = 30;

  /**
   * Does this playback count as a deliberate watch for STATISTICS?
   *
   * Progress tracking is unaffected -- resume position and the watched filter
   * still work on Shorts. This governs only what feeds the stats and the
   * channel chart, which is where inflation is visible and wrong.
   *
   * Same shape of guard as watch-history.js's pre-roll ad check: a short
   * timeline crossing a threshold designed for real videos.
   *
   * @param {{isShort?:boolean, seconds?:number, pct?:number}} o
   * @returns {boolean}
   */
  function countsAsRealWatch(o) {
    o = o || {};
    if (!o.isShort) return true;
    var secs = Number(o.seconds);
    return isFinite(secs) && secs >= SHORT_MIN_SECONDS;
  }

  function isTrackableWatchPage(pathname) {
    const p = pathname || '';
    const YD = typeof self !== 'undefined' && self.UNYtDom ? self.UNYtDom : null;
    // Channel live URLs (/@x/live) serve a watch page; yt-dom owns that rule.
    return p === '/watch' || p.startsWith('/shorts') || !!(YD && YD.isLiveChannelPath && YD.isLiveChannelPath(p));
  }

  /** 11-char video id from /watch?v= or /shorts/ID location. */
  function videoIdFromUrl(pathname, search) {
    const qs = search || '';
    const m = qs.match(/[?&]v=([\w-]{11})/);
    if (m) return m[1];
    const sm = String(pathname || '').match(/^\/shorts\/([\w-]{11})/);
    if (sm) return sm[1];
    const YD = typeof self !== 'undefined' && self.UNYtDom ? self.UNYtDom : null;
    const live = YD && YD.liveChannelVideoId ? YD.liveChannelVideoId() : '';
    return live || null;
  }

  return {
    fmtDayLocal,
    dayNum,
    emptyStats,
    normalizeStats,
    sumByDate,
    combinedPlayTotal,
    effectiveUniqueVideos,
    reconcileWatchStats,
    buildIdOnlyStats,
    mergeWatchStats,
    mergeWatchedIds,
    mergeWatchProgress,
    mergeWatchedDates,
    recordWatchIncrement,
    recomputeDerived,
    topChannelsFromMap,
    todayKey,
    sourceLabel,
    summarizeForForge,
    playBreakdown,
    isTrackableWatchPage,
    countsAsRealWatch,
    SHORT_MIN_SECONDS,
    videoIdFromUrl
  };
});
