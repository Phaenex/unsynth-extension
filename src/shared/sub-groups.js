/**
 * Pure subscription-group logic — no DOM, no chrome APIs.
 * A "channel key" is a stable id derived from a channel link: "@handle"
 * (lowercased) or "channel:UC…". Groups map a name → array of channel keys.
 * Display names are kept separately so the UI can show readable labels.
 *
 * UMD: attaches UNSubGroups to the global (content + dashboard) + exports for tests.
 */
(function (g) {
  'use strict';

  /** Derive a stable channel key from an href like "/@Handle" or "/channel/UC…". */
  function channelKey(href) {
    if (!href) return null;
    var h = String(href);
    var at = h.match(/\/@([^/?#]+)/);
    if (at) return '@' + at[1].toLowerCase();
    var ch = h.match(/\/channel\/([^/?#]+)/);
    if (ch) return 'channel:' + ch[1];
    var user = h.match(/\/(?:c|user)\/([^/?#]+)/);
    if (user) return 'c:' + user[1].toLowerCase();
    return null;
  }

  /**
   * Record that two channel keys are the same channel (e.g. "@handle" ⇄
   * "channel:UC…"). Feed tiles link by @handle while imports key by channelId;
   * the alias map lets either form match a group built from the other.
   */
  function setAlias(store, a, b) {
    if (!a || !b || a === b) return store;
    store.aliases = store.aliases || {};
    store.aliases[a] = b;
    store.aliases[b] = a;
    return store;
  }

  /** A key plus its alias (if any) — the set of forms that identify one channel. */
  function keyForms(store, key) {
    if (key == null) return [];
    var al = store && store.aliases && store.aliases[key];
    return al && al !== key ? [key, al] : [key];
  }

  function addToGroup(store, group, key, name) {
    store.groups = store.groups || {};
    store.names = store.names || {};
    var arr = store.groups[group] || (store.groups[group] = []);
    if (key && arr.indexOf(key) === -1) arr.push(key);
    if (key && name) store.names[key] = name;
    return store;
  }

  function removeFromGroup(store, group, key) {
    if (store.groups && store.groups[group]) {
      store.groups[group] = store.groups[group].filter(function (k) {
        return k !== key;
      });
    }
    return store;
  }

  function createGroup(store, group) {
    store.groups = store.groups || {};
    if (!store.groups[group]) store.groups[group] = [];
    return store;
  }

  function deleteGroup(store, group) {
    if (store.groups) delete store.groups[group];
    return store;
  }

  function renameGroup(store, oldName, newName) {
    if (!store.groups || !store.groups[oldName]) return store;
    newName = String(newName || '').trim();
    if (!newName || newName === oldName) return store;
    if (!store.groups[newName]) store.groups[newName] = store.groups[oldName];
    else {
      var seen = {};
      var merged = (store.groups[newName] || []).concat(store.groups[oldName] || []);
      store.groups[newName] = merged.filter(function (k) {
        if (!k || seen[k]) return false;
        seen[k] = true;
        return true;
      });
    }
    delete store.groups[oldName];
    return store;
  }

  /** Parse @handle, UC… id, or youtube.com URL into a channel key. */
  function parseChannelInput(raw) {
    var str = String(raw || '').trim();
    if (!str) return null;
    var at = str.match(/\/@([^/?#]+)/);
    if (at) return { key: '@' + at[1].toLowerCase(), label: '@' + at[1] };
    var ch = str.match(/\/channel\/(UC[\w-]+)/i);
    if (ch) return { key: 'channel:' + ch[1], label: null };
    var legacy = str.match(/\/(?:c|user)\/([^/?#]+)/i);
    if (legacy) return { key: 'c:' + legacy[1].toLowerCase(), label: legacy[1] };
    if (/^UC[\w-]+$/.test(str)) return { key: 'channel:' + str, label: null };
    if (str.charAt(0) === '@') return { key: str.toLowerCase(), label: str };
    if (/^[\w.-]+$/.test(str) && str.indexOf('PL') !== 0) return { key: '@' + str.toLowerCase(), label: '@' + str };
    return null;
  }

  function reorderInGroup(store, group, fromIdx, toIdx) {
    var arr = store.groups && store.groups[group];
    if (!arr || fromIdx < 0 || fromIdx >= arr.length) return store;
    toIdx = Math.max(0, Math.min(toIdx, arr.length - 1));
    if (fromIdx === toIdx) return store;
    var item = arr.splice(fromIdx, 1)[0];
    arr.splice(toIdx, 0, item);
    return store;
  }

  function moveChannelToGroup(store, key, fromGroup, toGroup) {
    if (!key || !toGroup) return store;
    if (fromGroup && fromGroup !== toGroup) removeFromGroup(store, fromGroup, key);
    addToGroup(store, toGroup, key);
    return store;
  }

  /** Which groups a channel key belongs to (matching either alias form). */
  function groupsForChannel(store, key) {
    var out = [];
    var groups = (store && store.groups) || {};
    var forms = keyForms(store, key);
    for (var name in groups) {
      if (
        forms.some(function (k) {
          return groups[name].indexOf(k) !== -1;
        })
      )
        out.push(name);
    }
    return out;
  }

  /** Is a tile's channel in the active group? (matches either alias form) */
  function inGroup(store, group, key) {
    if (!group) return true; // no active group => everything passes
    var arr = (store && store.groups && store.groups[group]) || [];
    var tileForms = keyForms(store, key);
    return arr.some(function (member) {
      return keyForms(store, member).some(function (mf) {
        return tileForms.indexOf(mf) !== -1;
      });
    });
  }

  /**
   * Pure decision for sub-manager.js's applyFilter()/applyHomeFilter() top
   * branch: what should happen to group-based feed filtering right now?
   * 'peek' (the "YT Default" masthead toggle beats an active group — filtering
   * pauses so the feed reads as YouTube would normally show it), 'off' (no
   * group filtering applies), or 'filter' (hide tiles outside the active group).
   */
  function filterMode(defaultFeedOn, onFilterFeed, active) {
    if (defaultFeedOn) return 'peek';
    if (!onFilterFeed || !active) return 'off';
    return 'filter';
  }

  /** Normalize a channel display name for fuzzy matching. */
  function normName(s) {
    return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * The set of normalized display names for a group's members. This bridges the
   * common mismatch where a group stores channel IDs ("channel:UC…", e.g. a
   * PocketTube import) but YouTube's feed only links channels by @handle — the
   * keys never match, but the resolved names do. Returns an object used as a set.
   */
  function groupNameSet(store, group) {
    var set = Object.create(null);
    var arr = (store && store.groups && store.groups[group]) || [];
    arr.forEach(function (key) {
      keyForms(store, key).forEach(function (k) {
        var n = store && store.names && store.names[k];
        if (n && !isUnresolvedLabel(n, k)) set[normName(n)] = true;
      });
    });
    return set;
  }

  /** Detect PocketTube export kind from array contents (UC… = subs, PL… = playlists). */
  function pocketTubeKind(json) {
    if (!json || typeof json !== 'object' || json.groups || json.folders) return null;
    if (!json.ysc_collection && !json.ysc_settings) return null;
    var keys = Object.keys(json).filter(function (k) {
      return k.indexOf('ysc_') !== 0 && Array.isArray(json[k]);
    });
    if (!keys.length) return null;
    for (var i = 0; i < keys.length; i++) {
      var arr = json[keys[i]] || [];
      for (var j = 0; j < arr.length; j++) {
        var id = String(arr[j]);
        if (/^PL[\w-]+$/.test(id)) return 'playlists';
        if (/^UC[\w-]+$/.test(id)) return 'subs';
      }
    }
    return null;
  }

  /** Merge incoming groups into an existing store (union channels per group name). */
  function mergeStores(base, incoming) {
    base = base || { groups: {}, names: {} };
    incoming = incoming || { groups: {}, names: {} };
    // A plain Object.assign(base.names, incoming.names) lets every key present
    // in incoming win outright — including a blank/placeholder name (e.g. a
    // PocketTube export, which never has real names, or a hand-edited/older
    // groups-JSON a user imports) for a channel the base store already
    // resolved via the Data API. Only let incoming's name win when the base
    // side doesn't already have a real resolved name for that key, same
    // "don't regress a resolved name" invariant applyChannelNames enforces.
    var names = Object.assign({}, base.names);
    Object.keys(incoming.names || {}).forEach(function (k) {
      var inName = incoming.names[k];
      if (!inName) return;
      if (!names[k] || isUnresolvedLabel(names[k], k)) names[k] = inName;
    });
    var out = {
      groups: {},
      names: names,
      aliases: Object.assign({}, base.aliases, incoming.aliases)
    };
    var all = {};
    Object.keys(base.groups || {}).forEach(function (g) {
      all[g] = true;
    });
    Object.keys(incoming.groups || {}).forEach(function (g) {
      all[g] = true;
    });
    Object.keys(all).forEach(function (g) {
      var seen = {};
      var merged = [];
      []
        .concat((base.groups && base.groups[g]) || [], (incoming.groups && incoming.groups[g]) || [])
        .forEach(function (k) {
          if (k && !seen[k]) {
            seen[k] = true;
            merged.push(k);
          }
        });
      out.groups[g] = merged;
    });
    return out;
  }

  /**
   * Convert a PocketTube subscription-manager export into our store.
   * PocketTube shape: { GroupName: [channelId...], ..., ysc_collection: {GroupName:...} }.
   * Channel ids (UC…) become "channel:UC…" keys. Names aren't in the export, so
   * they're left blank (enrich later via the Data API).
   */
  function fromPocketTube(json) {
    var out = { groups: {}, names: {} };
    if (!json || typeof json !== 'object') return out;
    var coll = json.ysc_collection || {};
    var groupNames = Object.keys(coll);
    if (!groupNames.length) {
      // fall back: any top-level array key that isn't a ysc_* meta key
      groupNames = Object.keys(json).filter(function (k) {
        return k.indexOf('ysc_') !== 0 && Array.isArray(json[k]);
      });
    }
    groupNames.forEach(function (g) {
      var ids = Array.isArray(json[g]) ? json[g] : [];
      out.groups[g] = ids.map(function (id) {
        return /^UC[\w-]+$/.test(id) ? 'channel:' + id : String(id);
      });
    });
    return out;
  }

  /** Detect a PocketTube subscription export (vs our own store format). */
  function isPocketTube(json) {
    return pocketTubeKind(json) === 'subs';
  }

  /** Normalize an API customUrl/handle ("@Handle", "Handle") to a "@handle" key. */
  function handleKey(handle) {
    if (!handle) return null;
    var h = String(handle).trim().replace(/^@/, '').toLowerCase();
    return h ? '@' + h : null;
  }

  /** Extract a bare UC… id from a "channel:UC…" key, or null. */
  function channelIdFromKey(key) {
    if (!key || key.indexOf('channel:') !== 0) return null;
    var id = key.slice(8);
    return /^UC[\w-]+$/.test(id) ? id : null;
  }

  /** True when a stored label is missing or still the raw key / channel id. */
  function isUnresolvedLabel(label, key) {
    if (!label || !key) return true;
    if (label === key) return true;
    if (label.indexOf('channel:') === 0) return true;
    if (key.indexOf('channel:') === 0 && label === key.slice(8)) return true;
    if (key.indexOf('channel:') === 0 && /^Channel [\w-]{4,12}$/.test(label)) return true;
    return false;
  }

  function formatChannelKey(key) {
    if (!key) return '—';
    if (key.indexOf('@') === 0) return key;
    if (key.indexOf('channel:') === 0) {
      var id = key.slice(8);
      if (id.length <= 10) return id;
      return id.slice(0, 4) + '…' + id.slice(-4);
    }
    if (key.indexOf('c:') === 0) return key.slice(2);
    return key;
  }

  /** Resolved display name from store.names (alias-aware), or a short id fallback. */
  function storedChannelName(store, key) {
    var forms = keyForms(store, key);
    for (var i = 0; i < forms.length; i++) {
      var n = store.names && store.names[forms[i]];
      if (n && !isUnresolvedLabel(n, forms[i])) return n;
    }
    return null;
  }

  function channelDisplayLabel(store, key) {
    var stored = storedChannelName(store, key);
    if (stored) return stored;
    if (key && key.indexOf('@') === 0) return key;
    return formatChannelKey(key);
  }

  /** Collect UC ids for keys in groups that still lack a resolved name. */
  function unresolvedChannelIds(store) {
    var ids = [];
    var seen = {};
    Object.keys(store.groups || {}).forEach(function (g) {
      (store.groups[g] || []).forEach(function (key) {
        keyForms(store, key).forEach(function (k) {
          var id = channelIdFromKey(k);
          if (!id || seen[id]) return;
          if (!isUnresolvedLabel(store.names && store.names[k], k)) return;
          seen[id] = true;
          ids.push(id);
        });
      });
    });
    return ids;
  }

  /** Merge { UCid: title } (+ optional handles) into store.names for channel: keys. */
  function applyChannelNames(store, names, thumbs, handles) {
    if (!names || !Object.keys(names).length) return false;
    store.names = store.names || {};
    var touched = false;
    for (var id in names) {
      if (!names[id]) continue;
      var k = 'channel:' + id;
      if (!store.names[k] || isUnresolvedLabel(store.names[k], k)) {
        store.names[k] = names[id];
        touched = true;
      }
      var rawHandle = handles && handles[id];
      var hk = rawHandle ? handleKey(rawHandle) : null;
      if (hk) {
        setAlias(store, k, hk);
        if (!store.names[hk] || isUnresolvedLabel(store.names[hk], hk)) {
          store.names[hk] = names[id];
        }
        touched = true;
      }
    }
    return touched;
  }

  /**
   * Does a channel have an upload newer than the last seen video id?
   * `seen` / `latest` maps are keyed by channel key; alias forms are checked.
   */
  function hasUnseenVideo(store, seen, latest, key) {
    if (!key || !latest) return false;
    var forms = keyForms(store, key);
    var best = null;
    for (var i = 0; i < forms.length; i++) {
      var rec = latest[forms[i]];
      if (rec && rec.videoId && (!best || (rec.ts || 0) > (best.ts || 0))) best = rec;
    }
    if (!best || !best.videoId) return false;
    for (var j = 0; j < forms.length; j++) {
      if (seen && seen[forms[j]] === best.videoId) return false;
    }
    return true;
  }

  /** Last-seen video id for a channel (any alias form). */
  function seenVideoId(store, seen, key) {
    if (!seen || !key) return null;
    var forms = keyForms(store, key);
    for (var i = 0; i < forms.length; i++) {
      if (seen[forms[i]]) return seen[forms[i]];
    }
    return null;
  }

  function isSubscribedInCache(cache, channel, chKey) {
    if (!cache || !cache.keys || !cache.keys.length) return false;
    var set = {};
    cache.keys.forEach(function (k) {
      set[String(k).toLowerCase()] = true;
    });
    var nk = chKey ? String(chKey).toLowerCase() : '';
    if (nk && set[nk]) return true;
    var c = (channel || '').trim().toLowerCase();
    if (!c || !cache.names || !cache.names.length) return false;
    for (var i = 0; i < cache.names.length; i++) {
      if (cache.names[i] === c) return true;
    }
    return false;
  }

  /** Build local cache from YouTube subscriptions.list (+ handle enrichment). */
  function buildSubscribedCache(subs) {
    var keys = {};
    var names = {};
    (subs || []).forEach(function (s) {
      if (!s || !s.channelId) return;
      keys[s.channelId.toLowerCase()] = true;
      if (s.title) names[String(s.title).trim().toLowerCase()] = true;
      var hk = handleKey(s.handle);
      if (hk) keys[hk] = true;
    });
    return {
      keys: Object.keys(keys),
      names: Object.keys(names)
    };
  }

  function mergeSubscribedKeys(existing, moreKeys) {
    var keyMap = {};
    var nameMap = {};
    (existing && existing.keys ? existing.keys : []).forEach(function (k) {
      keyMap[String(k).toLowerCase()] = true;
    });
    (existing && existing.names ? existing.names : []).forEach(function (n) {
      nameMap[String(n).toLowerCase()] = true;
    });
    (moreKeys || []).forEach(function (k) {
      if (k) keyMap[String(k).toLowerCase()] = true;
    });
    return {
      keys: Object.keys(keyMap),
      names: Object.keys(nameMap)
    };
  }

  /** Merge OAuth-built cache with existing (keeps guide-scraped @handle keys). */
  function mergeSubscribedCaches(existing, built) {
    var merged = mergeSubscribedKeys(existing, built && built.keys ? built.keys : []);
    var nameMap = {};
    (merged.names || []).forEach(function (n) {
      nameMap[String(n).toLowerCase()] = true;
    });
    (built && built.names ? built.names : []).forEach(function (n) {
      if (n) nameMap[String(n).toLowerCase()] = true;
    });
    merged.names = Object.keys(nameMap);
    return merged;
  }

  var api = {
    channelKey,
    handleKey,
    channelIdFromKey,
    isUnresolvedLabel,
    formatChannelKey,
    storedChannelName,
    channelDisplayLabel,
    unresolvedChannelIds,
    applyChannelNames,
    hasUnseenVideo,
    seenVideoId,
    setAlias,
    keyForms,
    addToGroup,
    removeFromGroup,
    createGroup,
    deleteGroup,
    renameGroup,
    parseChannelInput,
    reorderInGroup,
    moveChannelToGroup,
    groupsForChannel,
    inGroup,
    filterMode,
    normName,
    groupNameSet,
    pocketTubeKind,
    mergeStores,
    fromPocketTube,
    isPocketTube,
    buildSubscribedCache,
    mergeSubscribedKeys,
    mergeSubscribedCaches,
    isSubscribedInCache
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNSubGroups = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
