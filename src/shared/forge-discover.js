'use strict';

/**
 * Playlist Forge discover helpers — overrides, taste payload, grading, sorting.
 * Shared between YouTube search panel and unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UNForgeDiscover = factory();
  }
})(typeof self !== 'undefined' ? self : this, function forgeDiscoverFactory() {
  var RANK_LABELS = {
    hidden_gem: 'hidden gems',
    top: 'most popular',
    newest: 'newest',
    relevance: 'relevance'
  };

  /** Map search form fields → /api/discover overrides. */
  function buildOverrides(fields) {
    fields = fields || {};
    var o = { filters: {} };
    if (fields.rank) o.rank = fields.rank;
    if (fields.count) o.count = Math.max(1, Math.min(200, Number(fields.count) || 0));
    if (fields.maxmin) o.filters.maxDurationSec = Number(fields.maxmin) * 60;
    if (fields.minmin) o.filters.minDurationSec = Number(fields.minmin) * 60;
    if (fields.pubafter) o.filters.publishedAfter = String(fields.pubafter).trim();
    if (fields.pubbefore) o.filters.publishedBefore = String(fields.pubbefore).trim();
    if (fields.maxsubs) o.filters.maxChannelSubs = Number(fields.maxsubs);
    if (fields.excludeai) o.filters.excludeAI = true;
    if (!Object.keys(o.filters).length) delete o.filters;
    if (!o.rank && !o.count && !o.filters) return {};
    return o;
  }

  var FORGE_TEMPLATES = [
    {
      label: 'Narrated history',
      query:
        'non-AI narrated history documentaries told by real people, documentary voice not AI voiceover, not reaction videos'
    },
    {
      label: 'Real scary stories',
      query:
        'scary stories and true horror narrated by real people first person, not AI voice and not reaction compilations'
    },
    {
      label: 'Hidden gem docs',
      query: 'underrated documentary deep dives from small channels, authentic narration, under 20 minutes'
    },
    {
      label: 'Explore new niche',
      query: 'videos I have probably not seen before in this topic, avoid mainstream reaction channels'
    }
  ];

  var DEFAULT_FORGE_TASTE = {
    excludeWatched: true,
    boostChannels: false,
    excludeAI: true,
    customAvoidChannels: []
  };

  function mergeAvoidNames(existing, extra) {
    var names = (existing || []).slice();
    (extra || []).forEach(function (n) {
      n = String(n || '').trim();
      if (n && names.indexOf(n) === -1) names.push(n);
    });
    return names;
  }

  /**
   * Split watch-history top channels into boost vs avoid.
   * Avoidance is opt-in: watch history is evidence of interest, not permission
   * to blacklist channels based on a bundled opinion.
   * Channel tuple: [name, distinctVideos, playCount, channelId]
   */
  function partitionChannels(topChannels, ws, opts) {
    opts = opts || {};
    var maxDistinctShare = opts.maxDistinctShare != null ? opts.maxDistinctShare : 0.06;
    var maxPlayShare = opts.maxPlayShare != null ? opts.maxPlayShare : 0.1;
    var patterns = opts.avoidPatterns || [];
    var totalDistinct = (ws && (ws.uniqueVideos || ws.total)) || 0;
    if (!totalDistinct && topChannels && topChannels.length) {
      totalDistinct = topChannels.reduce(function (s, c) {
        return s + (c[1] || 0);
      }, 0);
    }
    if (!totalDistinct) totalDistinct = 1;
    var totalPlays = 0;
    (topChannels || []).forEach(function (c) {
      totalPlays += c[2] || 0;
    });
    if (!totalPlays) totalPlays = totalDistinct;

    var avoid = [];
    var boost = [];
    (topChannels || []).forEach(function (c) {
      var name = c[0] || '';
      var distinct = c[1] || 0;
      var plays = c[2] || 0;
      var id = c[3] || '';
      var distinctShare = distinct / totalDistinct;
      var playShare = plays / totalPlays;
      var generic = patterns.some(function (p) {
        return p.test(name);
      });
      var saturated = distinctShare >= maxDistinctShare || playShare >= maxPlayShare;
      if (generic) {
        avoid.push({ name: name, id: id, reason: 'explicit-pattern' });
      } else if (saturated) {
        if (opts.autoAvoidSaturated === true) avoid.push({ name: name, id: id, reason: 'saturated' });
      } else if (distinct >= 2) {
        boost.push(c);
      }
    });
    return { avoid: avoid, boost: boost };
  }

  /** Refine /api/suggest summary — drop saturated channels, add avoid list + taste hints. */
  function enrichSuggestSummary(summary, ws) {
    summary = summary || {};
    if (!ws || !ws.topChannels || !ws.topChannels.length) return summary;
    var part = partitionChannels(ws.topChannels, ws);
    if (part.avoid.length) {
      summary.avoidChannelNames = part.avoid.map(function (a) {
        return a.name;
      });
      summary.avoidChannelIds = part.avoid
        .map(function (a) {
          return a.id;
        })
        .filter(Boolean);
    }
    summary.topChannels = part.boost.slice(0, 12).map(function (c) {
      return [c[0], c[1], c[2] || 0];
    });
    summary.tasteHints = summary.tasteHints || [];
    var hint =
      'Prefer authentic narrators, real people telling stories, and documentary-style history — not AI voiceovers or reaction/review clones.';
    if (summary.tasteHints.indexOf(hint) === -1) summary.tasteHints.push(hint);
    return summary;
  }

  /**
   * Taste payload for /api/discover from extension storage shapes.
   * opts: { excludeWatched, boostChannels, watchedIds, watchStats }
   */
  function buildTastePayload(opts) {
    opts = opts || {};
    var taste = {};
    if (opts.excludeWatched && opts.watchedIds && opts.watchedIds.length) {
      taste.excludeWatched = true;
      taste.watchedIds = opts.watchedIds.slice(0, 8000);
    }
    var ws = opts.watchStats;
    if (ws && ws.topChannels && ws.topChannels.length) {
      var part = partitionChannels(ws.topChannels, ws);
      if (part.avoid.length) {
        taste.avoidChannels = true;
        taste.avoidChannelNames = part.avoid
          .map(function (a) {
            return a.name;
          })
          .slice(0, 25);
        taste.avoidChannelIds = part.avoid
          .map(function (a) {
            return a.id;
          })
          .filter(Boolean)
          .slice(0, 25);
      }
      if (opts.boostChannels && part.boost.length) {
        taste.boostChannels = true;
        taste.topChannelIds = part.boost
          .map(function (c) {
            return c[3];
          })
          .filter(Boolean)
          .slice(0, 15);
        taste.topChannelNames = part.boost
          .map(function (c) {
            return c[0];
          })
          .slice(0, 15);
      }
    }
    if (opts.excludeAI) taste.preferHuman = true;
    if (opts.customAvoidChannelNames && opts.customAvoidChannelNames.length) {
      taste.avoidChannels = true;
      taste.avoidChannelNames = mergeAvoidNames(taste.avoidChannelNames, opts.customAvoidChannelNames).slice(0, 30);
    }
    return Object.keys(taste).length ? taste : null;
  }

  /** Cumulative AI grade: relevance 40 + quality 30 + engagement 20 + gem 10. */
  function gradeOf(v) {
    var verdict = v && v.verdict;
    if (!verdict) return null;
    if (verdict.match === 'off') {
      return {
        letter: 'F',
        score: 0,
        parts: [
          { name: 'Relevance', score: 0, max: 40, why: 'AI judged this off-topic for your request — automatic F.' },
          { name: 'Quality', score: 0, max: 30, why: 'Not scored when match is off-topic.' },
          { name: 'Engagement', score: 0, max: 20, why: 'Not scored when match is off-topic.' },
          { name: 'Hidden gem', score: 0, max: 10, why: 'Not scored when match is off-topic.' }
        ]
      };
    }
    var matchPts = verdict.match === 'good' ? 40 : 18;
    var q = verdict.quality || 3;
    var quality = Math.round(((q - 1) / 4) * 30);
    var views = Number(v.viewCount) || 0;
    var likes = Number(v.likeCount) || 0;
    var comments = Number(v.commentCount) || 0;
    var eng = views ? (likes + comments) / views : 0;
    var engagement = Math.round(Math.min(eng / 0.05, 1) * 20);
    var gem = 0;
    var gemWhy = 'No hidden-gem bonus — needs strong engagement on modest view counts.';
    if (views < 50000 && eng > 0.02) {
      gem = 10;
      gemWhy = 'Under 50K views with >2% engagement — underrated find bonus (+10).';
    } else if (views < 200000 && eng > 0.015) {
      gem = 5;
      gemWhy = 'Under 200K views with >1.5% engagement — modest gem bonus (+5).';
    }
    var score = Math.round(matchPts + quality + engagement + gem);
    var letter = score >= 80 ? 'A' : score >= 64 ? 'B' : score >= 48 ? 'C' : score >= 32 ? 'D' : 'F';
    var engPct = views ? (eng * 100).toFixed(2) : '0';
    return {
      letter: letter,
      score: score,
      parts: [
        {
          name: 'Relevance',
          score: matchPts,
          max: 40,
          why:
            verdict.match === 'good'
              ? 'Strong AI match to your request (40/40).' + (verdict.reason ? ' ' + verdict.reason : '')
              : 'Loose match (18/40) — related but not ideal.' + (verdict.reason ? ' ' + verdict.reason : '')
        },
        {
          name: 'Quality',
          score: quality,
          max: 30,
          why: 'AI quality rating ' + q + '/5 mapped to up to 30 points.'
        },
        {
          name: 'Engagement',
          score: engagement,
          max: 20,
          why: engPct + '% combined like+comment rate. Full 20 pts at 5% engagement.'
        },
        { name: 'Hidden gem', score: gem, max: 10, why: gemWhy }
      ]
    };
  }

  function videoIdOf(v) {
    if (!v) return '';
    return v.id || v.videoId || (v.snippet && v.snippet.resourceId && v.snippet.resourceId.videoId) || '';
  }

  /** Best-effort YouTube thumbnail URL (prefers hq over mq from API payloads). */
  function thumbUrlFor(v, quality) {
    var id = videoIdOf(v);
    if (!id) return '';
    var t = (v && (v.thumb || v.thumbnail)) || '';
    var q = quality === 'mq' ? 'mqdefault' : quality === 'max' ? 'maxresdefault' : quality === 'sd' ? 'sddefault' : 'hqdefault';
    if (t) {
      // This used to only rewrite t for quality:'mq' and otherwise return t
      // completely unchanged for hq/sd/max — so requesting 'max' on a video
      // whose payload thumb was already an hqdefault URL silently returned
      // the hq URL instead of upgrading it, and thumbFallbackUrls() below
      // (which calls thumbUrlFor(v,'max') then thumbUrlFor(v,'hq')) ended up
      // trying the SAME url twice instead of actually attempting maxres
      // first. Rewrite whatever known quality tag t currently carries to the
      // one actually requested, for every tier, not just 'mq'.
      if (/maxresdefault|sddefault|hqdefault|mqdefault/.test(t)) {
        return t.replace(/maxresdefault|sddefault|hqdefault|mqdefault/, q);
      }
      return t;
    }
    return 'https://i.ytimg.com/vi/' + id + '/' + q + '.jpg';
  }

  /** Ordered fallbacks for <img onerror> (max → hq → sd → mq). */
  function thumbFallbackUrls(v) {
    var id = videoIdOf(v);
    if (!id) return [];
    var urls = [];
    function add(u) {
      if (u && urls.indexOf(u) === -1) urls.push(u);
    }
    add(thumbUrlFor(v, 'max'));
    add(thumbUrlFor(v, 'hq'));
    ['maxresdefault', 'hqdefault', 'sddefault', 'mqdefault'].forEach(function (q) {
      add('https://i.ytimg.com/vi/' + id + '/' + q + '.jpg');
    });
    return urls;
  }

  function normalizeCandidate(v) {
    var id = videoIdOf(v);
    if (!id) return v;
    return Object.assign({}, v, {
      id: id,
      thumb: thumbUrlFor(v, 'hq'),
      url: v.url || 'https://www.youtube.com/watch?v=' + id
    });
  }

  /** Accept legacy `videos` key from /api/discover responses. */
  function extractDiscoverCandidates(data) {
    if (!data) return [];
    return data.candidates || data.videos || [];
  }

  function applyVerdicts(candidates, verdicts) {
    var byId = {};
    (verdicts || []).forEach(function (vd) {
      if (vd && vd.id) byId[vd.id] = vd;
    });
    return (candidates || []).map(function (v) {
      var id = videoIdOf(v);
      var verdict = byId[id];
      var out = Object.assign({}, v);
      if (verdict) {
        out.verdict = verdict;
        out.grade = gradeOf(Object.assign({}, out, { verdict: verdict }));
      }
      return out;
    });
  }

  /** Sort candidates; returns a new array (does not mutate input). */
  function sortCandidates(list, mode, candMap) {
    var items = (list || []).slice();
    var rankOf = { good: 0, weak: 1, off: 2 };
    items.sort(function (a, b) {
      var va = candMap[a] || a;
      var vb = candMap[b] || b;
      if (typeof a === 'string') {
        va = candMap[a] || {};
        vb = candMap[b] || {};
      }
      if (mode === 'views') return (vb.viewCount || 0) - (va.viewCount || 0);
      if (mode === 'longest') return (vb.durationSec || 0) - (va.durationSec || 0);
      if (mode === 'shortest') return (va.durationSec || 0) - (vb.durationSec || 0);
      if (mode === 'match') {
        var ra = va.verdict ? rankOf[va.verdict.match] : 1;
        var rb = vb.verdict ? rankOf[vb.verdict.match] : 1;
        if (ra !== rb) return ra - rb;
        return (vb.viewCount || 0) - (va.viewCount || 0);
      }
      if (mode === 'grade') {
        var sa = va.grade ? va.grade.score : -1;
        var sb = vb.grade ? vb.grade.score : -1;
        if (sa !== sb) return sb - sa;
        return (vb.viewCount || 0) - (va.viewCount || 0);
      }
      if (mode === 'rank') {
        var rka = va.rank != null ? va.rank : va.discoveryRank != null ? va.discoveryRank : 9999;
        var rkb = vb.rank != null ? vb.rank : vb.discoveryRank != null ? vb.discoveryRank : 9999;
        if (rka !== rkb) return rka - rkb;
        return (vb.viewCount || 0) - (va.viewCount || 0);
      }
      return 0;
    });
    return items;
  }

  function formatCount(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function formatDur(sec) {
    sec = Number(sec) || 0;
    if (!sec) return '';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s;
    if (h) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss;
    return m + ':' + ss;
  }

  function yearOf(iso) {
    if (!iso) return '';
    var y = String(iso).slice(0, 4);
    return /^\d{4}$/.test(y) ? y : '';
  }

  function summaryLine(stats, returned) {
    if (!stats || !stats.perQuery || !stats.perQuery.length) {
      return returned ? returned + ' videos' : '';
    }
    var parts = stats.perQuery.map(function (q) {
      return '"' + q.q + '" → ' + (q.error ? 'failed' : q.found);
    });
    var line = parts.join(' · ');
    if (stats.returned != null) line += ' · showing ' + stats.returned;
    return line;
  }

  function readFormFields(root) {
    if (!root) return {};
    function val(id) {
      var el = root.querySelector('#' + id);
      return el ? el.value : '';
    }
    function chk(id) {
      var el = root.querySelector('#' + id);
      return el ? !!el.checked : false;
    }
    return {
      request: val('un-forge-search-req'),
      title: val('un-forge-search-title'),
      rank: val('un-forge-search-rank'),
      count: val('un-forge-search-count'),
      maxmin: val('un-forge-search-maxmin'),
      minmin: val('un-forge-search-minmin'),
      pubafter: val('un-forge-search-pubafter'),
      pubbefore: val('un-forge-search-pubbefore'),
      maxsubs: val('un-forge-search-maxsubs'),
      excludeai: chk('un-forge-search-excludeai'),
      excludewatched: chk('un-forge-search-excludewatched'),
      boostchannels: chk('un-forge-search-boostchannels')
    };
  }

  function applyFormFields(root, fields) {
    if (!root || !fields) return;
    function setVal(id, v) {
      var el = root.querySelector('#' + id);
      if (el && v != null) el.value = v;
    }
    function setChk(id, v) {
      var el = root.querySelector('#' + id);
      if (el) el.checked = !!v;
    }
    setVal('un-forge-search-req', fields.request || '');
    setVal('un-forge-search-title', fields.title || '');
    setVal('un-forge-search-rank', fields.rank || '');
    setVal('un-forge-search-count', fields.count || '');
    setVal('un-forge-search-maxmin', fields.maxmin || '');
    setVal('un-forge-search-minmin', fields.minmin || '');
    setVal('un-forge-search-pubafter', fields.pubafter || '');
    setVal('un-forge-search-pubbefore', fields.pubbefore || '');
    setVal('un-forge-search-maxsubs', fields.maxsubs || '');
    setChk('un-forge-search-excludeai', fields.excludeai !== false);
    setChk('un-forge-search-excludewatched', fields.excludewatched !== false);
    setChk('un-forge-search-boostchannels', fields.boostchannels === true);
  }

  return {
    RANK_LABELS: RANK_LABELS,
    FORGE_TEMPLATES: FORGE_TEMPLATES,
    DEFAULT_FORGE_TASTE: DEFAULT_FORGE_TASTE,
    buildOverrides: buildOverrides,
    buildTastePayload: buildTastePayload,
    partitionChannels: partitionChannels,
    enrichSuggestSummary: enrichSuggestSummary,
    gradeOf: gradeOf,
    videoIdOf: videoIdOf,
    thumbUrlFor: thumbUrlFor,
    thumbFallbackUrls: thumbFallbackUrls,
    normalizeCandidate: normalizeCandidate,
    extractDiscoverCandidates: extractDiscoverCandidates,
    applyVerdicts: applyVerdicts,
    sortCandidates: sortCandidates,
    formatCount: formatCount,
    formatDur: formatDur,
    yearOf: yearOf,
    summaryLine: summaryLine,
    readFormFields: readFormFields,
    applyFormFields: applyFormFields
  };
});
