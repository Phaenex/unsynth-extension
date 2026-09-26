'use strict';

/**
 * Playlist Forge deep links + taste summary helpers (YouTube extension + dashboard).
 * Keep URL params aligned with playlist-forge/public/index.html deep-link handlers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UNForgeLinks = factory();
  }
})(typeof self !== 'undefined' ? self : this, function forgeLinksFactory() {
  var FORGE = 'https://playlist-forge.vercel.app';

  function personaOf(byHour) {
    if (!byHour || !byHour.length) return null;
    var p = byHour.indexOf(Math.max.apply(null, byHour));
    return p >= 22 || p <= 4 ? 'night owl' : p >= 5 && p <= 10 ? 'early bird' : p >= 11 && p <= 16 ? 'daytime' : 'evening';
  }

  function buildSummary(ws, ss) {
    var s = {};
    if (ws) {
      s.total = ws.total;
      s.uniqueChannels = ws.uniqueChannels;
      s.activeDays = ws.activeDays;
      s.firstDate = ws.firstDate;
      s.lastDate = ws.lastDate;
      s.topChannels = (ws.topChannels || []).slice(0, 20).map(function (c) {
        return [c[0], c[1]];
      });
      if (ws.byHour) {
        s.peakHour = ws.byHour.indexOf(Math.max.apply(null, ws.byHour));
        s.persona = personaOf(ws.byHour);
      }
    }
    if (ss) {
      s.topSearchWords = (ss.topWords || []).slice(0, 25).map(function (w) {
        return w[0];
      });
      s.topSearchTerms = (ss.topTerms || []).slice(0, 12).map(function (t) {
        return t[0];
      });
    }
    return s;
  }

  /** One-line taste blurb for sidebar / dashboard cards. */
  function tasteOneLiner(watchStats, searchStats) {
    var ws = watchStats;
    if (!ws || !ws.total) return null;
    var summary = buildSummary(ws, searchStats);
    var parts = [];
    parts.push(Number(ws.total).toLocaleString() + ' plays');
    if (summary.persona) parts.push(summary.persona);
    var top = (summary.topChannels || []).slice(0, 2).map(function (c) {
      return c[0];
    });
    if (top.length) parts.push(top.join(', '));
    return parts.join(' · ');
  }

  function forgeHome() {
    return FORGE + '/';
  }

  function forgeManage(playlistId) {
    return FORGE + '/?manage=' + encodeURIComponent(playlistId || '');
  }

  /** Natural-language discover query for “find similar” (matches Playlist Forge seed deep-link). */
  function similarSearchQuery(videoId, title, channelTitle) {
    var t = (title || '').trim();
    var ch = (channelTitle || '').trim();
    if (t && ch) {
      return 'Videos similar in topic, style, and tone to "' + t + '" by ' + ch;
    }
    if (t) {
      return 'Videos similar in topic, style, and quality to "' + t + '"';
    }
    return 'Videos similar in topic and quality to YouTube video ' + (videoId || '');
  }

  /** Watch-page / single-video discovery seed. */
  function forgeSeed(videoId, opts) {
    opts = opts || {};
    var p = new URLSearchParams();
    p.set('seed', videoId);
    if (opts.title) p.set('title', opts.title);
    if (opts.auto !== false) p.set('auto', '1');
    return FORGE + '/?' + p.toString();
  }

  /** Multi-select from playlist manager — comma-separated ids + optional titles. */
  function forgeSelection(videoIds, opts) {
    opts = opts || {};
    var rawIds = videoIds || [];
    var hasTitles = !!(opts.titles && opts.titles.length);
    var rawTitles = opts.titles || [];
    // Filtering rawIds with .filter(Boolean) before pairing it up with
    // rawTitles shifts every id after a dropped falsy entry one slot to the
    // left while rawTitles (a same-index-implied, separate array) doesn't
    // shift with it — Forge then received titles zipped to the wrong video
    // id from that point on. Drop the two arrays together, index by index,
    // so a title only ever survives paired with its own id.
    var ids = [];
    var titles = [];
    for (var i = 0; i < rawIds.length; i++) {
      if (!rawIds[i]) continue;
      ids.push(rawIds[i]);
      titles.push(rawTitles[i] || '');
    }
    if (!ids.length) return forgeHome();
    var p = new URLSearchParams();
    p.set('from', 'selection');
    p.set('seeds', ids.join(','));
    if (hasTitles) p.set('titles', titles.slice(0, 8).join('|'));
    if (opts.auto) p.set('auto', '1');
    return FORGE + '/?' + p.toString();
  }

  function forgeFromYoutube() {
    return FORGE + '/?from=youtube';
  }

  /** Stats tab idea cards (existing Forge contract). */
  function forgeStatsIdea(idea, auto) {
    var p = new URLSearchParams({ from: 'stats', q: idea.searchQuery, title: idea.title, count: String(idea.count || 25) });
    if (auto) p.set('auto', '1');
    return FORGE + '/?' + p.toString();
  }

  function formatSyncAge(ts) {
    if (!ts) return 'Not synced yet';
    var ms = Date.now() - Number(ts);
    if (ms < 0 || !isFinite(ms)) return 'Synced';
    var sec = Math.floor(ms / 1000);
    if (sec < 60) return 'Synced just now';
    var min = Math.floor(sec / 60);
    if (min < 60) return 'Synced ' + min + 'm ago';
    var hr = Math.floor(min / 60);
    if (hr < 48) return 'Synced ' + hr + 'h ago';
    return 'Synced ' + Math.floor(hr / 24) + 'd ago';
  }

  // Proxy a playlist-forge request through the service worker — content-script
  // fetches to playlist-forge.vercel.app are blocked by CORS. Resolves to
  // { ok, status, data } and never rejects. `path` must start with '/'.
  function apiFetch(path, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          { type: 'UNSYNTH/FORGE/FETCH', path: path, method: opts.method || 'GET', body: opts.body != null ? opts.body : null },
          function (res) {
            if (chrome.runtime.lastError || !res) {
              resolve({ ok: false, status: 0, data: null });
              return;
            }
            resolve(res);
          }
        );
      } catch (e) {
        resolve({ ok: false, status: 0, data: null });
      }
    });
  }

  return {
    FORGE: FORGE,
    apiFetch: apiFetch,
    personaOf: personaOf,
    buildSummary: buildSummary,
    tasteOneLiner: tasteOneLiner,
    forgeHome: forgeHome,
    forgeManage: forgeManage,
    similarSearchQuery: similarSearchQuery,
    forgeSeed: forgeSeed,
    forgeSelection: forgeSelection,
    forgeFromYoutube: forgeFromYoutube,
    forgeStatsIdea: forgeStatsIdea,
    formatSyncAge: formatSyncAge
  };
});
