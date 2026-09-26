/**
 * Playlist index + ranking for the Ctrl+K quick switcher.
 *
 * Two problems live here, both of them pure so they can be tested without a
 * browser.
 *
 * 1. WHERE THE LIST COMES FROM. Nothing in this extension persists the user's
 *    full playlist list. sidebar-hub.js and playlist-bulk.js each send
 *    UNSYNTH/YT/PLAYLISTS_MINE and keep the answer in a private closure
 *    variable that dies with the page. That is fine for a panel you deliberately
 *    open and wait on; it is wrong for a switcher whose entire value is being
 *    faster than scrolling /feed/playlists. So the switcher caches the API
 *    answer in chrome.storage.local under CACHE_KEY and opens on it instantly,
 *    refreshing in the background.
 *
 *    That cache can be empty or stale — the API needs OAuth, and a fresh
 *    profile has none. buildIndex therefore unions three sources: the cached
 *    API list (titles + counts), the folder store, and the pin store. The last
 *    two are already on disk for every user, so the switcher always opens onto
 *    something real.
 *
 * 2. WHICH ROW IS UNDER THE CURSOR. With 87 playlists, ranking is the feature.
 *    A plain substring filter puts "Late Night Ambient" above "Ambient Focus"
 *    for the query "amb" whenever the former sorts earlier, which makes Enter
 *    feel like a coin flip. Matches are therefore tiered — prefix, word start,
 *    substring, subsequence — and recency only breaks ties inside a tier. What
 *    you typed always beats what you happened to open last week.
 */
(function (g, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    if (g) g.UNPlaylistIndex = api;
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * Reach a sibling shared module in either environment.
   *
   * In the page these are globals, assigned by the shared scripts that load
   * ahead of this one in the content-script block. Under `node --test` there
   * is no such global, and silently getting null there would make every
   * channel row fall back to a raw "channel:UC…" key — a difference between
   * test and production in exactly the code the tests exist to check. So the
   * test environment resolves by require instead.
   */
  function sharedHelper(globalName, relPath) {
    var g = typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null;
    if (g && g[globalName]) return g[globalName];
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require(relPath);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // Shared with playlist-bulk.js, deliberately. It already tracks the
  // playlists you add videos to; opening one from the switcher is the same
  // signal about the same thing. A second key would give the two surfaces
  // disagreeing ideas of "recent".
  var RECENT_KEY = 'unsynthRecentPlaylists';
  var MAX_RECENT = 8;

  // The cached UNSYNTH/YT/PLAYLISTS_MINE answer: { playlists: [...], at: ms }.
  var CACHE_KEY = 'unPlIndexCache';
  // Refresh in the background when the cache is older than this. The switcher
  // still opens on the stale copy immediately; this only decides when a
  // refresh is worth the quota.
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  // 87 playlists is the real library size and every one of them can match a
  // one-character query. Rendering them all is wasted DOM nobody scrolls to,
  // and it pushes the list past the viewport. Nine rows fit the overlay.
  var MAX_RESULTS = 9;

  // How many of those nine the empty-query list holds open for channels when
  // both kinds exist. Three is enough to show the feature exists without
  // pushing the playlists a user opened the palette for below the fold.
  var RESTING_CHANNEL_SLOTS = 3;

  // Match tiers, best first. The numbers are only ever compared to each other.
  var T_PREFIX = 0; // query starts the title
  var T_WORD = 1; // query starts a word inside the title
  var T_SUBSTR = 2; // query appears anywhere in the title
  var T_FOLDER = 3; // the folder name matched, not the title
  var T_SUBSEQ = 4; // the letters appear in order, scattered
  var T_NONE = 99;

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase();
  }

  /** Lowercase and strip whitespace, so "drumand" finds "Drum and Bass". */
  function squash(s) {
    return norm(s).replace(/\s+/g, '');
  }

  /**
   * Do the characters of `q` appear in `hay`, in order AND close together?
   *
   * Plain "in order" is far too loose to be useful here. Observed on the real
   * overlay: the query "amb" matched "Streamers VOD backlog", because
   * "stre[a]}ers…" — squashed to streamersvodbacklog — contains a, then m, then
   * b, spread over sixteen characters. With 87 playlists, a three-letter query
   * under that rule matches most of the library and the ranking stops meaning
   * anything.
   *
   * So the run must be compact: the matched span may be at most SUBSEQ_SLACK
   * characters longer than the query itself. "cbt" inside "cabaret" (span 6 for
   * a 3-char query) is the kind of typed-shorthand this tier is for; a match
   * smeared across a whole title is not.
   */
  var SUBSEQ_SLACK = 4;

  function isSubsequence(hay, q) {
    if (!q) return true;
    // Try every possible starting point and keep the tightest span, so a late
    // cluster is not missed because an earlier stray letter was consumed first.
    for (var start = 0; start < hay.length; start++) {
      if (hay[start] !== q[0]) continue;
      var i = 1;
      var j = start + 1;
      for (; j < hay.length && i < q.length; j++) {
        if (hay[j] === q[i]) i++;
      }
      if (i === q.length && j - start <= q.length + SUBSEQ_SLACK) return true;
    }
    return false;
  }

  /**
   * Tier for one title against one query, plus the offset of the hit so two
   * results in the same tier can be ordered by how early they match.
   */
  function scoreTitle(title, query) {
    var t = norm(title);
    var q = norm(query);
    if (!q) return { tier: T_PREFIX, at: 0 };
    if (t.indexOf(q) === 0) return { tier: T_PREFIX, at: 0 };

    // Word start: after a space, hyphen, slash, underscore or bracket. Checked
    // before the generic substring test so "amb" prefers "Late Night Ambient"
    // over a title that merely contains "amb" mid-word.
    var wordAt = -1;
    var re = /[\s\-_/|([{:,.]+/g;
    var starts = [0];
    var m;
    while ((m = re.exec(t))) starts.push(m.index + m[0].length);
    for (var i = 0; i < starts.length; i++) {
      if (t.indexOf(q, starts[i]) === starts[i]) {
        wordAt = starts[i];
        break;
      }
    }
    if (wordAt >= 0) return { tier: T_WORD, at: wordAt };

    var sub = t.indexOf(q);
    if (sub >= 0) return { tier: T_SUBSTR, at: sub };

    // Whitespace-insensitive retry before falling back to subsequence, so
    // "drumand" is treated as the near-exact match it is rather than as
    // scattered letters.
    var st = squash(title);
    var sq = squash(query);
    if (sq && st.indexOf(sq) === 0) return { tier: T_PREFIX, at: 0 };
    if (sq && st.indexOf(sq) >= 0) return { tier: T_SUBSTR, at: st.indexOf(sq) };

    if (sq && isSubsequence(st, sq)) return { tier: T_SUBSEQ, at: 0 };
    return { tier: T_NONE, at: 0 };
  }

  /**
   * One row per thing the user can jump to, unioned across every store that
   * knows about one. `cache` is the stored UNSYNTH/YT/PLAYLISTS_MINE answer.
   *
   * TWO KINDS, TWO STORES. Playlists come from the API cache + plFolderStore +
   * plPins; channels come from subStore.groups. These are genuinely separate —
   * plFolderStore holds "PL…" ids while subStore.groups holds "channel:UC…"
   * and "@handle" keys — and playlist-folders.js already carries a comment
   * about this exact confusion having happened before. Every row is therefore
   * tagged `kind`, and neither store can contribute a row of the other's type:
   * a channel key cannot become a playlist row, and a PL id cannot become a
   * channel row.
   *
   * The user's Main / Night / Streamers are subscription groups, so a query
   * like "Night" answers with channels. `folder` carries the group name for a
   * channel and the playlist folder for a playlist — one field, because to the
   * person typing it is just "the thing this lives in".
   *
   * count is left undefined rather than 0 when it is genuinely unknown, and
   * hasCount says which it is — a folder-only row must not claim the playlist
   * is empty when nothing has ever counted it.
   */
  function buildIndex(cache, folderStore, pins, subStore, channelThumbs) {
    var byId = {};
    var order = [];

    // Only real playlist ids become rows. The live profile that prompted this
    // has folders named Main / Night / Streamers — but they are subStore.groups
    // (SUBSCRIPTION groups), whose members are "channel:UC…" keys, and
    // plFolderStore did not exist at all. Reading the wrong store is an easy
    // mistake to make while "fixing" folder search, and it would fill the
    // switcher with channel ids that navigate nowhere. Rejecting anything that
    // is not a playlist id makes that failure impossible rather than merely
    // unlikely.
    function isPlaylistId(id) {
      var s = String(id || '');
      // PL… is the common case; LL (liked) and WL (watch later) are real
      // openable lists, and FL/UU/RD are YouTube's own generated list ids.
      return /^(PL|LL|WL|FL|UU|RD|OL)[\w-]*$/.test(s);
    }

    function isChannelKey(key) {
      var s = String(key || '');
      return s.indexOf('@') === 0 || s.indexOf('channel:') === 0 || s.indexOf('c:') === 0;
    }

    function row(id) {
      if (!id || !isPlaylistId(id)) return null;
      if (!byId[id]) {
        byId[id] = {
          id: id,
          kind: 'playlist',
          title: '',
          folder: '',
          count: 0,
          hasCount: false,
          pinned: false
        };
        order.push(id);
      }
      return byId[id];
    }

    function chanRow(key) {
      if (!key || !isChannelKey(key)) return null;
      if (!byId[key]) {
        byId[key] = {
          id: key,
          kind: 'channel',
          title: '',
          folder: '',
          count: 0,
          hasCount: false,
          pinned: false,
          thumb: ''
        };
        order.push(key);
      }
      return byId[key];
    }

    var list = (cache && cache.playlists) || [];
    list.forEach(function (p) {
      if (!p || !p.id) return;
      var r = row(p.id);
      if (!r) return;
      r.title = String(p.title || '');
      if (typeof p.count === 'number' && isFinite(p.count)) {
        r.count = p.count;
        r.hasCount = true;
      }
      if (p.thumb) r.thumb = String(p.thumb);
    });

    var folders = (folderStore && folderStore.folders) || {};
    var fnames = (folderStore && folderStore.names) || {};
    Object.keys(folders).forEach(function (name) {
      (folders[name] || []).forEach(function (id) {
        var r = row(id);
        if (!r) return;
        // First folder wins. A playlist filed in two folders is an edge the
        // sidebar itself does not model, and showing one label beats showing
        // a joined string nobody can scan.
        if (!r.folder) r.folder = name;
      });
    });
    Object.keys(fnames).forEach(function (id) {
      if (byId[id] && !byId[id].title) byId[id].title = String(fnames[id] || '');
    });

    var p = pins && Array.isArray(pins.ids) ? pins : { ids: [], names: {} };
    p.ids.forEach(function (id) {
      var r = row(id);
      if (!r) return;
      r.pinned = true;
      if (!r.title && p.names && p.names[id]) r.title = String(p.names[id]);
    });

    // ---- channels, from subStore.groups -----------------------------------
    // Name resolution and avatars are NOT reimplemented here: sub-groups.js
    // already owns the alias-aware name lookup (a channel can be keyed by
    // "@handle" in one place and "channel:UC…" in another, and only that
    // module knows they are the same channel), and sub-channel-thumbs.js owns
    // the avatar cache lookup. Both are loaded ahead of this file in the
    // shared content-script block.
    var SG = sharedHelper('UNSubGroups', './sub-groups.js');
    var SCT = sharedHelper('UNSubChannelThumbs', './sub-channel-thumbs.js');
    var subs = subStore && typeof subStore === 'object' ? subStore : { groups: {}, names: {} };
    var groups = subs.groups || {};
    var thumbs = channelThumbs && typeof channelThumbs === 'object' ? channelThumbs : {};

    Object.keys(groups).forEach(function (name) {
      (groups[name] || []).forEach(function (key) {
        var r = chanRow(key);
        if (!r) return;
        // First group wins, same rule as playlist folders: one legible label
        // beats a joined string nobody can scan.
        if (!r.folder) r.folder = name;
        if (!r.title) {
          // channelDisplayLabel resolves through aliases and falls back to the
          // @handle or a shortened id — never a raw "channel:UC…" key, and
          // never blank, so an unresolved PocketTube import is still readable
          // and still typeable.
          r.title = SG && SG.channelDisplayLabel ? String(SG.channelDisplayLabel(subs, key) || '') : '';
          if (!r.title) {
            var nm = subs.names && subs.names[key];
            r.title = nm ? String(nm) : String(key);
          }
        }
        if (!r.thumb) {
          var url = SCT && SCT.lookup ? SCT.lookup(thumbs, subs, key) : thumbs[key];
          r.thumb = url && typeof url === 'string' ? url : '';
        }
      });
    });

    // A row with no title anywhere still has to be openable and typeable, so
    // it falls back to its id rather than rendering blank.
    return order.map(function (id) {
      var r = byId[id];
      if (!r.title) r.title = id;
      return r;
    });
  }

  /**
   * The URL a channel row opens.
   *
   * `tab` is settings.ui.channelDefaultTab ('home' | 'videos' | 'shorts' |
   * 'live' | 'playlists'). ui-tune.js already redirects a channel ROOT to that
   * tab, but only while the uiTune module is enabled — so the suffix is
   * appended here rather than depending on another module being on. 'home'
   * and anything unrecognised open the channel front page.
   */
  var CHANNEL_TABS = {
    videos: '/videos',
    shorts: '/shorts',
    live: '/streams',
    playlists: '/playlists',
    community: '/community',
    about: '/about'
  };

  function channelUrl(key, tab) {
    if (!key) return 'https://www.youtube.com/';
    var base;
    var k = String(key);
    if (k.indexOf('@') === 0) base = 'https://www.youtube.com/' + k;
    else if (k.indexOf('channel:') === 0) base = 'https://www.youtube.com/channel/' + k.slice(8);
    else if (k.indexOf('c:') === 0) base = 'https://www.youtube.com/c/' + k.slice(2);
    else return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(k);
    var suffix = CHANNEL_TABS[String(tab || '').toLowerCase()];
    return suffix ? base + suffix : base;
  }

  /**
   * Rank and cap. Returns NEW objects — the index is shared state that the
   * overlay re-filters on every keystroke, so writing scores onto it would
   * make the second keystroke rank against the first one's leftovers.
   *
   * opts.recent is the newest-first id list from RECENT_KEY.
   */
  function filterPlaylists(index, query, opts) {
    var o = opts || {};
    var recent = Array.isArray(o.recent) ? o.recent : [];
    var recentAt = {};
    recent.forEach(function (id, i) {
      recentAt[id] = i;
    });
    var q = String(query == null ? '' : query).trim();

    var scored = [];
    (index || []).forEach(function (r, idx) {
      var tier = T_NONE;
      var at = 0;
      var matchedFolder = false;

      if (!q) {
        tier = T_PREFIX;
      } else {
        var s = scoreTitle(r.title, q);
        tier = s.tier;
        at = s.at;
        if (r.folder) {
          var f = scoreTitle(r.folder, q);
          // A folder hit only rescues a row the title could not match, and
          // never outranks a title hit — otherwise typing "night" would put
          // every member of the Night folder above the playlist actually
          // called "Late Night Ambient".
          if (f.tier !== T_NONE && f.tier <= T_SUBSTR && tier > T_FOLDER) {
            tier = T_FOLDER;
            at = f.at;
            matchedFolder = true;
          }
        }
      }
      if (tier === T_NONE) return;

      scored.push({
        row: r,
        idx: idx,
        tier: tier,
        at: at,
        matchedFolder: matchedFolder,
        pinned: !!r.pinned,
        isChannel: r.kind === 'channel',
        recent: recentAt[r.id] === undefined ? Infinity : recentAt[r.id]
      });
    });

    // THE INTERLEAVING RULE: match quality first, type second.
    //
    // Tier decides everything, whether a row is a playlist or a channel — so a
    // channel you typed the exact prefix of beats a playlist that merely
    // contains the string somewhere. Anything else would make the palette feel
    // arbitrary: you typed what you wanted and something worse won because it
    // happened to be the other type.
    //
    // Type only breaks a tie INSIDE a tier, and there a playlist leads. This
    // is a playlist switcher that also knows about channels, and there are 606
    // channels against 87 playlists — without this, an equally-good playlist
    // would routinely sit below a wall of channels.
    scored.sort(function (a, b) {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (!q) {
        // The resting list: what you pinned, then what you actually opened,
        // then playlists before channels, then library order.
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.recent !== b.recent) return a.recent - b.recent;
        if (a.isChannel !== b.isChannel) return a.isChannel ? 1 : -1;
        return a.idx - b.idx;
      }
      // Inside a tier, an earlier hit reads as the better match.
      if (a.at !== b.at) return a.at - b.at;
      if (a.recent !== b.recent) return a.recent - b.recent;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.isChannel !== b.isChannel) return a.isChannel ? 1 : -1;
      // Shorter titles are the tighter match for the same hit position.
      var la = (a.row.title || '').length;
      var lb = (b.row.title || '').length;
      if (la !== lb) return la - lb;
      return a.idx - b.idx;
    });

    // THE RESTING RESERVATION (empty query only).
    //
    // Sorting alone lets whichever kind has more rows take every slot. With 87
    // playlists and 606 channels and nine slots, the opening list was nine
    // playlists and zero channels — so a user had no way to discover that
    // channels are searchable at all. Observed in a real browser, not
    // theorised: eleven seeded playlists filled all nine rows.
    //
    // So the empty-query list keeps a slice for the minority kind. Playlists
    // still lead and still take the majority — this is a playlist switcher —
    // but the list shows what the palette can actually do. A typed query is
    // untouched: once you type, match quality decides everything, and padding
    // a result with rows the query did not ask for would be meddling.
    var picked = scored;
    if (!q && scored.length > MAX_RESULTS) {
      var pls = [];
      var chs = [];
      scored.forEach(function (x) {
        (x.isChannel ? chs : pls).push(x);
      });
      if (pls.length && chs.length) {
        var chanSlots = Math.min(chs.length, RESTING_CHANNEL_SLOTS);
        var plSlots = MAX_RESULTS - chanSlots;
        // If there are not enough playlists to use their share, channels take
        // the remainder rather than leaving the list short.
        if (pls.length < plSlots) {
          plSlots = pls.length;
          chanSlots = Math.min(chs.length, MAX_RESULTS - plSlots);
        }
        picked = pls.slice(0, plSlots).concat(chs.slice(0, chanSlots));
        // Re-apply the comparator so the blended list is still in rank order
        // rather than "all playlists, then all channels".
        picked.sort(function (a, b) {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          if (a.recent !== b.recent) return a.recent - b.recent;
          if (a.isChannel !== b.isChannel) return a.isChannel ? 1 : -1;
          return a.idx - b.idx;
        });
      }
    }

    return picked.slice(0, MAX_RESULTS).map(function (s) {
      return {
        id: s.row.id,
        kind: s.row.kind || 'playlist',
        title: s.row.title,
        folder: s.row.folder,
        count: s.row.count,
        hasCount: s.row.hasCount,
        pinned: s.row.pinned,
        thumb: s.row.thumb || '',
        matchedFolder: s.matchedFolder
      };
    });
  }

  /** Newest first, no duplicates, capped. Mirrors playlist-bulk's pushRecent. */
  function rememberRecent(list, id) {
    if (!id) return Array.isArray(list) ? list.slice() : [];
    var prev = Array.isArray(list) ? list : [];
    return [id]
      .concat(
        prev.filter(function (x) {
          return x !== id;
        })
      )
      .slice(0, MAX_RECENT);
  }

  /** True when the cached playlist answer is old enough to be worth refetching. */
  function cacheIsStale(cache, now) {
    if (!cache || !cache.at) return true;
    return (now || Date.now()) - cache.at > CACHE_TTL_MS;
  }

  return {
    RECENT_KEY: RECENT_KEY,
    MAX_RECENT: MAX_RECENT,
    CACHE_KEY: CACHE_KEY,
    CACHE_TTL_MS: CACHE_TTL_MS,
    MAX_RESULTS: MAX_RESULTS,
    RESTING_CHANNEL_SLOTS: RESTING_CHANNEL_SLOTS,
    buildIndex: buildIndex,
    channelUrl: channelUrl,
    CHANNEL_TABS: CHANNEL_TABS,
    filterPlaylists: filterPlaylists,
    rememberRecent: rememberRecent,
    cacheIsStale: cacheIsStale,
    scoreTitle: scoreTitle
  };
});
