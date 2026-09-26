/**
 * Hidden gems — a discovery shelf pinned above the YouTube home feed.
 *
 * YouTube's home ranks on recency and popularity, so the things it never shows
 * you are the overlooked ones. This shelf surfaces those instead, using signals
 * Unsynth already has locally (see shared/discover.js for the scoring):
 * low views for a video's age, small channels, subscriptions you have drifted
 * away from, and videos you saved and never came back to.
 *
 * Three tiers, each degrading to the one below rather than failing:
 *   local  – videoStatsCache entries you have seen but not watched (no OAuth)
 *   API    – recent uploads from drifted subs + your saved playlists (~15 quota
 *            units per refresh; uploads playlists cost 1 unit, search.list 100)
 *   AI     – optional re-rank + a one-line "why" using your own BYOK key
 *
 * Shuffle re-ranks the cached pool with a new seed — free, no network. Refresh
 * re-fetches. Results are cached for six hours so ordinary browsing costs nothing.
 */
(function () {
  'use strict';

  var DISC = window.UNDiscover;

  // Content scripts do not load shared/messages.js, so the type strings are
  // inlined here (same convention as ai-assistant.js / fact-check.js). They must
  // stay in step with UNMSG.DISCOVER_CANDIDATES and UNMSG.AI_LLM — smoke-manifest
  // asserts the pair matches.
  var MSG_CANDIDATES = 'UNSYNTH/DISCOVER/CANDIDATES';
  var MSG_AI_LLM = 'UNSYNTH/AI/LLM';

  var core = null;
  var cache = null; // { at, videos }
  var seed = 1;
  var busy = false;
  var lastRenderKey = '';
  var CACHE_TTL_MS = 6 * 3600 * 1000;
  var SHELF_ID = 'un-discover-shelf';

  function prefs() {
    var s = (core && core.settings && core.settings.discoverShelf) || {};
    return {
      maxItems: Number(s.maxItems) || 12,
      useApi: s.useApi !== false,
      useAi: s.useAi === true,
      rules: {
        lowViewsForAge: !(s.rules && s.rules.lowViewsForAge === false),
        smallChannel: !(s.rules && s.rules.smallChannel === false),
        driftedSub: !(s.rules && s.rules.driftedSub === false),
        unfinishedSave: !(s.rules && s.rules.unfinishedSave === false)
      }
    };
  }

  function onHome() {
    return location.pathname === '/' || location.pathname === '';
  }

  // ---- local signal gathering -------------------------------------------------

  /**
   * Exact-case UC ids for subscribed channels.
   *
   * subscribedChannelCache stores keys LOWERCASED (and mixes in @handles), which
   * the Data API will not accept. PocketTube groups and watchStats.channelMap
   * both keep original case, so use those as the source and the cache only as a
   * membership test.
   */
  function subscribedChannelIds(local) {
    var out = {};
    var subStore = local.subStore || {};
    Object.keys(subStore.groups || {}).forEach(function (group) {
      (subStore.groups[group] || []).forEach(function (entry) {
        var id = String(entry || '').replace(/^channel:/, '');
        if (/^UC[\w-]{20,}$/.test(id)) out[id] = true;
      });
    });

    var cacheKeys = {};
    ((local.subscribedChannelCache || {}).keys || []).forEach(function (k) {
      cacheKeys[String(k).toLowerCase()] = true;
    });
    var chMap = (local.watchStats || {}).channelMap || {};
    Object.keys(chMap).forEach(function (name) {
      var id = (chMap[name] || [])[2];
      if (!id || !/^UC[\w-]{20,}$/.test(id)) return;
      if (cacheKeys[id.toLowerCase()] || cacheKeys[String(name).toLowerCase()]) out[id] = true;
    });
    return Object.keys(out);
  }

  /** Subscribed channels with no watch inside the drift window — the API targets. */
  function driftedChannelIds(profile, ids, driftDays) {
    var now = Date.now();
    var cutoff = (driftDays || DISC.DEFAULTS.driftDays) * 86400000;
    var scored = ids.map(function (id) {
      var day = profile.lastDayByChannelId[id];
      var since = day ? now - Date.parse(day + 'T00:00:00Z') : Infinity;
      return { id: id, since: since };
    });
    return scored
      .filter(function (c) { return c.since >= cutoff; })
      // Longest-neglected first, but never-watched last: a channel you watched
      // once a year ago is a better bet than one you never opened at all.
      .sort(function (a, b) {
        if (a.since === Infinity && b.since !== Infinity) return 1;
        if (b.since === Infinity && a.since !== Infinity) return -1;
        return b.since - a.since;
      })
      .map(function (c) { return c.id; });
  }

  /** Candidates available with no API call at all. */
  function localCandidates(local) {
    var out = [];
    var snaps = (local.videoStatsCache && local.videoStatsCache.entries) || local.videoStatsCache || {};
    if (!snaps || typeof snaps !== 'object') return out;
    Object.keys(snaps).forEach(function (vid) {
      var s = snaps[vid];
      if (!s || !/^[A-Za-z0-9_-]{11}$/.test(vid)) return;
      out.push({
        videoId: vid,
        title: s.title || '',
        channelId: s.channelId || '',
        channelTitle: s.channel || s.channelTitle || '',
        publishedAt: s.publishDate || s.publishedAt || '',
        viewCount: Number(s.viewCount) || 0,
        thumb: s.thumb || 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg',
        source: 'seen-before'
      });
    });
    return out;
  }

  function readLocal(cb) {
    chrome.storage.local.get(
      {
        watchStats: null,
        watchedVideos: [],
        subStore: null,
        subscribedChannelCache: { keys: [], names: [] },
        plPins: { ids: [], names: {} },
        videoStatsCache: null,
        discoverCache: null
      },
      function (d) {
        if (chrome.runtime.lastError) { cb(null); return; }
        cb(d || null);
      }
    );
  }

  // ---- candidate assembly -----------------------------------------------------

  function buildProfile(local) {
    var ids = subscribedChannelIds(local);
    return DISC.buildProfile(local.watchStats, {
      subscribedChannelIds: ids,
      watchedVideoIds: local.watchedVideos || [],
      savedVideoIds: [],
      subscriberCounts: {}
    });
  }

  function gather(local, force, done) {
    var p = prefs();
    var fresh = local.discoverCache && Date.now() - local.discoverCache.at < CACHE_TTL_MS;
    if (fresh && !force) {
      done(local.discoverCache.videos || [], local.discoverCache.subsByChannel || {}, '');
      return;
    }
    if (!p.useApi) {
      done(localCandidates(local), {}, 'api_off');
      return;
    }

    var profile = buildProfile(local);
    var drifted = driftedChannelIds(profile, subscribedChannelIds(local), DISC.DEFAULTS.driftDays);
    var playlistIds = ((local.plPins || {}).ids || []).slice(0, 5);

    core
      .send(MSG_CANDIDATES, { channelIds: drifted.slice(0, 12), playlistIds: playlistIds })
      .then(function (r) {
        var apiVideos = (r && r.ok && r.videos) || [];
        var all = localCandidates(local).concat(apiVideos);
        var subs = (r && r.subsByChannel) || {};
        if (apiVideos.length) {
          chrome.storage.local.set({ discoverCache: { at: Date.now(), videos: all, subsByChannel: subs } });
        }
        done(all, subs, (r && r.degraded) || '');
      });
  }

  /** Optional LLM pass. Never blocks the shelf — the local order renders first. */
  function aiRank(videos, cb) {
    if (!prefs().useAi || !videos.length) { cb(videos); return; }
    var payload = DISC.promptPayload(videos, 30);
    core
      .send(MSG_AI_LLM, {
        system:
          'You rank YouTube videos for a viewer who wants overlooked gems, not popular hits. ' +
          'Reply with ONLY JSON: {"picks":[{"id":"<video id>","why":"<max 8 words>"}]}. ' +
          'Use only ids from the input. Order best first.',
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
        max_tokens: 900
      })
      .then(function (r) {
        if (!r || !r.ok || !r.content) { cb(videos); return; }
        try {
          var m = String(r.content).match(/\{[\s\S]*\}/);
          cb(m ? DISC.applyAiRanking(videos, JSON.parse(m[0])) : videos);
        } catch (e) {
          // A model that returns prose instead of JSON must not empty the shelf.
          cb(videos);
        }
      });
  }

  // ---- rendering --------------------------------------------------------------

  function removeShelf() {
    var el = document.getElementById(SHELF_ID);
    if (el) el.remove();
  }

  function mkCard(v) {
    var card = document.createElement('a');
    card.className = 'un-disc-card';
    card.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(v.videoId);

    var thumbWrap = document.createElement('div');
    thumbWrap.className = 'un-disc-thumb';
    var img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = v.thumb || 'https://i.ytimg.com/vi/' + encodeURIComponent(v.videoId) + '/mqdefault.jpg';
    thumbWrap.appendChild(img);
    card.appendChild(thumbWrap);

    // Every string below is remote (API/LLM) — textContent only, never innerHTML.
    var title = document.createElement('div');
    title.className = 'un-disc-title';
    title.textContent = v.title || v.videoId;
    title.title = v.title || '';
    card.appendChild(title);

    var chan = document.createElement('div');
    chan.className = 'un-disc-chan';
    chan.textContent = v.channelTitle || '';
    card.appendChild(chan);

    var why = document.createElement('div');
    why.className = 'un-disc-why';
    why.textContent = v.aiWhy || (v.reasons || [])[0] || '';
    card.appendChild(why);

    return card;
  }

  function renderShelf(videos, note) {
    var grid = (window.UNYtDom && document.querySelector(window.UNYtDom.RICH_GRID_RENDERER_SEL));
    if (!grid || !grid.parentElement) return;

    // Insert as a SIBLING above the grid — never inside #contents. YouTube's
    // Polymer reclaims foreign children there, which turns every scan into an
    // insert/remove loop (the same trap sub-manager's home shelf documents).
    var shelf = document.getElementById(SHELF_ID);
    if (!shelf) {
      shelf = document.createElement('section');
      shelf.id = SHELF_ID;
      shelf.className = 'un-disc-shelf';
      grid.parentElement.insertBefore(shelf, grid);
    }
    shelf.textContent = '';

    var head = document.createElement('div');
    head.className = 'un-disc-head';
    var brand = document.createElement('span');
    brand.className = 'un-disc-brand';
    brand.textContent = '✦ Hidden gems';
    head.appendChild(brand);

    if (note) {
      var noteEl = document.createElement('span');
      noteEl.className = 'un-disc-note';
      noteEl.textContent = note;
      head.appendChild(noteEl);
    }

    var actions = document.createElement('div');
    actions.className = 'un-disc-actions';

    var shuffle = document.createElement('button');
    shuffle.type = 'button';
    shuffle.className = 'un-disc-btn';
    shuffle.textContent = '↻ Shuffle';
    shuffle.title = 'Re-roll from the same pool — no network, no quota';
    shuffle.addEventListener('click', function (e) {
      e.preventDefault();
      seed = (seed * 1103515245 + 12345) >>> 0;
      paint();
    });
    actions.appendChild(shuffle);

    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'un-disc-btn ghost';
    refresh.textContent = 'Refresh';
    refresh.title = 'Fetch new candidates (uses a little API quota)';
    refresh.addEventListener('click', function (e) {
      e.preventDefault();
      run(true);
    });
    actions.appendChild(refresh);

    var hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'un-disc-btn ghost';
    hide.textContent = '✕';
    hide.title = 'Hide until the next reload';
    hide.addEventListener('click', function (e) {
      e.preventDefault();
      removeShelf();
      lastRenderKey = 'dismissed';
    });
    actions.appendChild(hide);

    head.appendChild(actions);
    shelf.appendChild(head);

    var row = document.createElement('div');
    row.className = 'un-disc-row';
    videos.forEach(function (v) { row.appendChild(mkCard(v)); });
    shelf.appendChild(row);
  }

  function renderEmpty(reason) {
    var grid = (window.UNYtDom && document.querySelector(window.UNYtDom.RICH_GRID_RENDERER_SEL));
    if (!grid || !grid.parentElement) return;
    var shelf = document.getElementById(SHELF_ID);
    if (!shelf) {
      shelf = document.createElement('section');
      shelf.id = SHELF_ID;
      shelf.className = 'un-disc-shelf';
      grid.parentElement.insertBefore(shelf, grid);
    }
    shelf.textContent = '';

    var head = document.createElement('div');
    head.className = 'un-disc-head';
    var brand = document.createElement('span');
    brand.className = 'un-disc-brand';
    brand.textContent = '✦ Hidden gems';
    head.appendChild(brand);
    shelf.appendChild(head);

    var hint = document.createElement('div');
    hint.className = 'un-disc-empty';
    // Say what is actually missing rather than "nothing found".
    if (reason === 'not_authed') {
      hint.textContent = 'Connect your YouTube account in the Unsynth dashboard to pull overlooked uploads from subscriptions you have drifted away from.';
    } else if (reason === 'quota_exhausted') {
      hint.textContent = 'Daily YouTube API quota is used up — gems will be back tomorrow.';
    } else if (reason === 'api_off') {
      hint.textContent = 'API lookups are off for this shelf, so only videos you have already seen can be scored.';
    } else {
      hint.textContent = 'Nothing overlooked to show yet. Watch a little more, or import your history so Unsynth knows what to compare against.';
    }
    shelf.appendChild(hint);

    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'un-disc-btn';
    open.textContent = 'Open dashboard';
    open.addEventListener('click', function (e) {
      e.preventDefault();
      if (core && core.openDashboard) core.openDashboard('#account');
    });
    shelf.appendChild(open);
  }

  var pool = [];
  var poolProfile = null;
  var poolNote = '';

  function paint() {
    if (!onHome()) return;
    if (!pool.length) { renderEmpty(poolNote); return; }
    var p = prefs();
    var ranked = DISC.rankVideos(pool, poolProfile, {
      now: Date.now(),
      seed: seed,
      maxItems: p.maxItems,
      rules: p.rules
    });
    if (!ranked.length) { renderEmpty(poolNote); return; }
    renderShelf(ranked, poolNote === 'not_authed' ? 'local signals only' : '');
  }

  function run(force) {
    if (busy || !onHome()) return;
    busy = true;
    readLocal(function (local) {
      if (!local) { busy = false; return; }
      cache = local.discoverCache;
      gather(local, force, function (videos, subsByChannel, degraded) {
        poolNote = degraded;
        poolProfile = DISC.buildProfile(local.watchStats, {
          subscribedChannelIds: subscribedChannelIds(local),
          watchedVideoIds: local.watchedVideos || [],
          savedVideoIds: videos.filter(function (v) { return v.source === 'saved'; }).map(function (v) { return v.videoId; }),
          subscriberCounts: subsByChannel
        });
        pool = videos;
        paint();
        // AI is a refinement layer: paint the local order first so the shelf is
        // never blocked on a network round-trip to a third-party model.
        aiRank(pool, function (reordered) {
          if (reordered !== pool) { pool = reordered; paint(); }
          busy = false;
        });
      });
    });
  }

  var mod = {
    id: 'discoverShelf',
    moduleKey: 'discoverShelf',

    init: function (c) {
      core = c;
      if (!DISC) return; // shared/discover.js missing — stay inert rather than throw
      seed = (Date.now() / 1000) | 0;
      run(false);
    },

    onNavigate: function () {
      if (!DISC) return;
      if (!onHome()) {
        removeShelf();
        lastRenderKey = '';
        return;
      }
      if (lastRenderKey === 'dismissed') return;
      run(false);
    },

    scan: function () {
      if (!DISC || !onHome() || lastRenderKey === 'dismissed') return;
      // YouTube rebuilds the grid on soft navigation; re-attach if ours vanished.
      if (pool.length && !document.getElementById(SHELF_ID)) paint();
    },

    teardown: function () {
      removeShelf();
      pool = [];
      poolProfile = null;
      lastRenderKey = '';
      busy = false;
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
