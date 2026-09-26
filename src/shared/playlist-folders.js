/**
 * Playlist pins + optional PocketTube-style folder map.
 *
 * - plPins (local + chrome.storage.sync mirror): { ids: PL…[], names: { [plId]: title } }
 *   — what the YouTube sidebar shows (real playlists the user pinned). The
 *   ids+names payload is small enough to follow the Chrome profile; folders are not.
 * - plFolderStore (local): { folders, names } — optional organization for Library
 *   filtering; empty folder shells are never auto-imported into the sidebar.
 */
(function (g, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    if (g) g.UNPlaylistFolders = api;
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var PL_RE = /^PL[\w-]+$/;

  // Sidebar display preferences. Stored in chrome.storage.local as plFolderPrefs.
  // The sidebar primary list is pinned playlists (plPins); folders are optional.
  var PREFS_DEFAULT = {
    sidebar: true, // show the Playlists section in the guide sidebar
    showAll: true, // show the "All playlists" (Library) row
    hideEmpty: true, // hide folders that contain no playlists (default on)
    sort: 'manual', // 'manual' (insertion) | 'name' (A–Z) | 'count' (most playlists)
    // YouTube's own built-in lists, surfaced as standard rows in the Playlists
    // block. These are the lists people reach for constantly and they are not
    // "playlists" you can pin, so before this they were simply absent from the
    // sidebar. On by default — requested as standard behavior for the app —
    // but each is individually toggleable from the dashboard.
    showHistory: true, // /feed/history
    showLiked: true, // /playlist?list=LL
    showWatchLater: true // /playlist?list=WL
  };
  var SORT_MODES = ['manual', 'name', 'count'];

  // The built-in lists, in the order they appear in the sidebar. `pref` maps to
  // the PREFS_DEFAULT key that shows/hides each one.
  var BUILTIN_LISTS = [
    { id: 'history', label: 'History', href: '/feed/history', pref: 'showHistory' },
    { id: 'liked', label: 'Liked videos', href: '/playlist?list=LL', pref: 'showLiked' },
    { id: 'watchlater', label: 'Watch later', href: '/playlist?list=WL', pref: 'showWatchLater' }
  ];

  /** The built-in list rows the user has left enabled, in display order. */
  function builtinLists(prefs) {
    var p = normalizePrefs(prefs);
    return BUILTIN_LISTS.filter(function (b) {
      return p[b.pref] !== false;
    });
  }

  function empty() {
    return { folders: {}, names: {} };
  }

  function emptyPins() {
    return { ids: [], names: {} };
  }

  /** Normalize pinned-playlist store. Drop junk ids, keep first-seen order. */
  function normalizePins(pins) {
    var src = pins && typeof pins === 'object' ? pins : {};
    var names = src.names && typeof src.names === 'object' ? src.names : {};
    var seen = {};
    var ids = [];
    (Array.isArray(src.ids) ? src.ids : []).forEach(function (id) {
      var plId = String(id || '');
      if (!PL_RE.test(plId) || seen[plId]) return;
      seen[plId] = true;
      ids.push(plId);
    });
    var outNames = {};
    ids.forEach(function (id) {
      if (names[id]) outNames[id] = String(names[id]);
    });
    return { ids: ids, names: outNames };
  }

  function isPinned(pins, plId) {
    var p = normalizePins(pins);
    return !!plId && p.ids.indexOf(plId) !== -1;
  }

  function pinPlaylist(pins, plId, title) {
    var p = normalizePins(pins);
    if (!PL_RE.test(String(plId || ''))) return p;
    if (p.ids.indexOf(plId) === -1) p.ids.push(plId);
    if (title) p.names[plId] = String(title);
    return p;
  }

  function unpinPlaylist(pins, plId) {
    var p = normalizePins(pins);
    p.ids = p.ids.filter(function (id) {
      return id !== plId;
    });
    if (p.names && p.names[plId]) delete p.names[plId];
    return p;
  }

  function pinLabel(pins, plId) {
    var p = normalizePins(pins);
    return (p.names && p.names[plId]) || plId;
  }

  /** Remove folders that have zero playlists (empty PocketTube shells). */
  function pruneEmptyFolders(store) {
    store = store || empty();
    var folders = store.folders || {};
    Object.keys(folders).forEach(function (name) {
      if (!(folders[name] || []).length) delete folders[name];
    });
    store.folders = folders;
    return store;
  }

  /** Fill defaults + clamp the sort mode so callers never see junk values. */
  function normalizePrefs(prefs) {
    var p = prefs && typeof prefs === 'object' ? prefs : {};
    return {
      sidebar: p.sidebar !== false,
      showAll: p.showAll !== false,
      // Default ON — empty Main/Night/Streamers shells must not flood the sidebar.
      hideEmpty: p.hideEmpty !== false,
      sort: SORT_MODES.indexOf(p.sort) !== -1 ? p.sort : 'manual',
      showHistory: p.showHistory !== false,
      showLiked: p.showLiked !== false,
      showWatchLater: p.showWatchLater !== false
    };
  }

  /** Folder names for display: honors hideEmpty + sort from prefs. */
  function sortedFolderNames(store, prefs) {
    var p = normalizePrefs(prefs);
    var folders = (store && store.folders) || {};
    var names = Object.keys(folders);
    if (p.hideEmpty) {
      names = names.filter(function (n) {
        return (folders[n] || []).length > 0;
      });
    }
    if (p.sort === 'name') {
      names.sort(function (a, b) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });
    } else if (p.sort === 'count') {
      names.sort(function (a, b) {
        return (folders[b] || []).length - (folders[a] || []).length;
      });
    }
    return names;
  }

  /**
   * PocketTube playlist-manager export: { FolderName: [PL…], ysc_collection: {…} }.
   */
  function fromPocketTube(json) {
    var out = empty();
    if (!json || typeof json !== 'object') return out;
    var coll = json.ysc_collection || {};
    var folderNames = Object.keys(coll);
    if (!folderNames.length) {
      folderNames = Object.keys(json).filter(function (k) {
        return k.indexOf('ysc_') !== 0 && Array.isArray(json[k]);
      });
    }
    folderNames.forEach(function (name) {
      var ids = Array.isArray(json[name]) ? json[name] : [];
      out.folders[name] = ids.filter(function (id) {
        return PL_RE.test(String(id));
      });
    });
    return out;
  }

  function mergeFolders(base, incoming) {
    base = base || empty();
    incoming = incoming || empty();
    var out = {
      folders: {},
      names: Object.assign({}, base.names, incoming.names)
    };
    var all = {};
    Object.keys(base.folders || {}).forEach(function (f) {
      all[f] = true;
    });
    Object.keys(incoming.folders || {}).forEach(function (f) {
      all[f] = true;
    });
    Object.keys(all).forEach(function (f) {
      var seen = {};
      var merged = [];
      []
        .concat((base.folders && base.folders[f]) || [], (incoming.folders && incoming.folders[f]) || [])
        .forEach(function (id) {
          if (id && !seen[id]) {
            seen[id] = true;
            merged.push(id);
          }
        });
      out.folders[f] = merged;
    });
    return out;
  }

  function createFolder(store, name) {
    store.folders = store.folders || {};
    if (!store.folders[name]) store.folders[name] = [];
    return store;
  }

  function deleteFolder(store, name) {
    if (store.folders) delete store.folders[name];
    return store;
  }

  function renameFolder(store, oldName, newName) {
    if (!store.folders || !store.folders[oldName]) return store;
    newName = String(newName || '').trim();
    if (!newName || newName === oldName) return store;
    if (!store.folders[newName]) store.folders[newName] = store.folders[oldName];
    else {
      var seen = {};
      var merged = (store.folders[newName] || []).concat(store.folders[oldName] || []);
      store.folders[newName] = merged.filter(function (id) {
        if (!id || seen[id]) return false;
        seen[id] = true;
        return true;
      });
    }
    delete store.folders[oldName];
    return store;
  }

  function parsePlaylistInput(raw) {
    var str = String(raw || '').trim();
    if (!str) return null;
    var m = str.match(/[?&]list=([^&]+)/);
    if (m && PL_RE.test(m[1])) return m[1];
    if (PL_RE.test(str)) return str;
    return null;
  }

  function addToFolder(store, folder, plId, title) {
    store.folders = store.folders || {};
    store.names = store.names || {};
    var arr = store.folders[folder] || (store.folders[folder] = []);
    if (plId && arr.indexOf(plId) === -1) arr.push(plId);
    if (plId && title) store.names[plId] = title;
    return store;
  }

  function removeFromFolder(store, folder, plId) {
    if (store.folders && store.folders[folder]) {
      store.folders[folder] = store.folders[folder].filter(function (id) {
        return id !== plId;
      });
    }
    return store;
  }

  function movePlaylistToFolder(store, plId, fromFolder, toFolder) {
    if (!plId || !toFolder) return store;
    if (fromFolder && fromFolder !== toFolder) removeFromFolder(store, fromFolder, plId);
    addToFolder(store, toFolder, plId);
    return store;
  }

  function folderCount(store) {
    return Object.keys((store && store.folders) || {}).length;
  }

  /** PocketTube Playlist manager export with ysc envelope but no folder names or PL ids. */
  function isEmptyPocketTubePlaylistExport(json) {
    if (!json || typeof json !== 'object' || json.folders || json.groups) return false;
    if (!json.ysc_settings && json.ysc_collection === undefined) return false;
    if (folderCount(fromPocketTube(json))) return false;
    return true;
  }

  /** Empty folder shells from PocketTube subscription export ysc_collection (Main/Night/…). */
  function scaffoldFromSubsExport(json) {
    var out = empty();
    if (!json || typeof json !== 'object') return out;
    Object.keys(json.ysc_collection || {}).forEach(function (name) {
      out.folders[name] = [];
    });
    return out;
  }

  /**
   * Playlist export only when it actually contains playlist IDs.
   * Never scaffold empty Main/Night/Streamers shells from subscription names —
   * those looked like "playlist groups" but weren't the user's playlists.
   */
  function resolveBundledImport(playlistJson, subsJson) {
    var out = fromPocketTube(playlistJson);
    if (playlistCount(out) > 0) return out;
    // Keep scaffold helper for explicit optional imports / tests, but auto-import
    // must not create empty folder shells.
    void subsJson;
    return empty();
  }

  function playlistCount(store) {
    var n = 0;
    Object.values((store && store.folders) || {}).forEach(function (arr) {
      n += (arr && arr.length) || 0;
    });
    return n;
  }

  /** Playlist Forge local folder format → Unsynth plFolderStore. */
  function fromForgeFolders(pf) {
    var out = empty();
    if (!pf || typeof pf !== 'object') return out;
    (pf.names || []).forEach(function (name) {
      out.folders[name] = out.folders[name] || [];
    });
    Object.keys(pf.assign || {}).forEach(function (plId) {
      var folder = pf.assign[plId];
      if (!folder) return;
      if (!out.folders[folder]) out.folders[folder] = [];
      if (out.folders[folder].indexOf(plId) === -1) out.folders[folder].push(plId);
    });
    return out;
  }

  /** Unsynth plFolderStore → Playlist Forge pf:folders shape. */
  function toForgeFolders(store) {
    store = store || empty();
    var names = Object.keys(store.folders || {});
    var assign = {};
    names.forEach(function (name) {
      (store.folders[name] || []).forEach(function (plId) {
        assign[plId] = name;
      });
    });
    return { names: names, assign: assign };
  }

  // ---- pin cross-device sync (chrome.storage.sync, newest-wins) ----
  // Folders stay local: a full plFolderStore blows past the 8KB/item cap.
  // Pins are a short id list + titles, so they can follow the Chrome profile.
  var PIN_SYNC_KEY = 'unPlPinsSync';
  var PIN_SYNC_BYTE_BUDGET = 7600;
  var PIN_SYNC_MAX = 80;
  var PIN_NAME_CAP = 80;
  var _lastPinSyncVersion = 0;
  var _lastPinSyncError = null;
  var _pinSyncTimer = null;

  function pinSyncPayloadBytes(value) {
    try {
      return (PIN_SYNC_KEY + JSON.stringify(value)).length;
    } catch (e) {
      return Infinity;
    }
  }

  function compactPinSyncPayload(pins, v) {
    var n = normalizePins(pins);
    var ids = n.ids.slice(0, PIN_SYNC_MAX);
    var names = {};
    ids.forEach(function (id) {
      if (n.names[id]) names[id] = String(n.names[id]).slice(0, PIN_NAME_CAP);
    });
    var payload = { v: v || Date.now(), ids: ids, names: names };
    while (ids.length > 1 && pinSyncPayloadBytes(payload) > PIN_SYNC_BYTE_BUDGET) {
      ids = ids.slice(0, ids.length - 1);
      names = {};
      ids.forEach(function (id) {
        if (n.names[id]) names[id] = String(n.names[id]).slice(0, PIN_NAME_CAP);
      });
      payload = { v: payload.v, ids: ids, names: names };
    }
    return payload;
  }

  function syncPinsToCloud(pins, v) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return;
    if (_pinSyncTimer) clearTimeout(_pinSyncTimer);
    _pinSyncTimer = setTimeout(function () {
      _pinSyncTimer = null;
      try {
        var payload = {};
        payload[PIN_SYNC_KEY] = compactPinSyncPayload(pins, v);
        chrome.storage.sync.set(payload, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            _lastPinSyncError = String(chrome.runtime.lastError.message || 'sync failed');
          } else {
            _lastPinSyncError = null;
          }
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ unPlPinsSyncMeta: { error: _lastPinSyncError, at: Date.now() } });
          }
        });
      } catch (e) {
        _lastPinSyncError = String((e && e.message) || e);
      }
    }, 250);
  }

  function persistPins(pins, cb) {
    var n = normalizePins(pins);
    var v = Date.now();
    _lastPinSyncVersion = v;
    function afterLocal() {
      syncPinsToCloud(n, v);
      if (cb) cb(n);
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ plPins: n, unPlPinsSyncLocalV: v }, afterLocal);
      return;
    }
    afterLocal();
  }

  /**
   * The single merging write path for plFolderStore.
   *
   * Seven call sites across separate JS contexts (sidebar hub, folder manager,
   * dashboard, stats page, Forge bridge) each held their own module-level copy
   * of the whole store and wrote it wholesale with
   * `chrome.storage.local.set({ plFolderStore: store })`. A save from one
   * context therefore overwrote, in full, any folder another context had
   * created since that copy was read. Because they run in different contexts,
   * an in-process lock cannot help -- the write itself has to re-read and
   * merge. mergeFolders() below already did the right union; it was simply
   * never on the write path.
   *
   * `authoritative` is the escape hatch and it matters: a blind union would
   * resurrect every playlist the user just removed from a folder, which is a
   * worse bug than the race. A caller that holds the complete, current picture
   * (it just did its own read-modify-write, or the user explicitly deleted
   * something) passes authoritative:true and its version wins outright.
   *
   * @param {{folders:Object,names:Object}} next  the writer's view of the store
   * @param {function} [cb]                       called with the merged result
   * @param {{authoritative?:boolean}} [opts]
   */
  function persistFolders(next, cb, opts) {
    var authoritative = !!(opts && opts.authoritative);
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      if (cb) cb(next);
      return;
    }
    chrome.storage.local.get({ plFolderStore: null }, function (d) {
      var prev = (d && d.plFolderStore) || null;
      var merged = (!prev || authoritative) ? next : mergeFolders(prev, next);
      chrome.storage.local.set({ plFolderStore: merged }, function () {
        var err = (chrome.runtime && chrome.runtime.lastError) || null;
        if (cb) cb(merged, err);
      });
    });
  }

  function applyRemotePinSync(payload, cb) {
    if (!payload || !Array.isArray(payload.ids)) {
      if (cb) cb(false);
      return;
    }
    function write(localV) {
      if (payload.v && payload.v <= localV) {
        if (cb) cb(false);
        return;
      }
      var n = normalizePins(payload);
      _lastPinSyncVersion = payload.v || Date.now();
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ plPins: n, unPlPinsSyncLocalV: _lastPinSyncVersion }, function () {
          if (cb) cb(true, n);
        });
        return;
      }
      if (cb) cb(true, n);
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ unPlPinsSyncLocalV: 0 }, function (d) {
        write(Math.max(d.unPlPinsSyncLocalV || 0, _lastPinSyncVersion));
      });
      return;
    }
    write(_lastPinSyncVersion);
  }

  function hydratePinsFromSync(cb) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || !chrome.storage.sync) {
      if (cb) cb(false);
      return;
    }
    chrome.storage.local.get({ plPins: emptyPins(), unPlPinsSyncLocalV: 0 }, function (loc) {
      chrome.storage.sync.get(PIN_SYNC_KEY, function (syn) {
        var remote = syn && syn[PIN_SYNC_KEY];
        var localV = loc.unPlPinsSyncLocalV || 0;
        var localPins = normalizePins(loc.plPins);
        if (remote && remote.v && remote.v > localV) {
          applyRemotePinSync(remote, cb);
          return;
        }
        if (localPins.ids.length && (!remote || !remote.v)) {
          persistPins(localPins, function () {
            if (cb) cb(true);
          });
          return;
        }
        if (cb) cb(false);
      });
    });
  }

  return {
    empty,
    emptyPins,
    normalizePins,
    isPinned,
    pinPlaylist,
    unpinPlaylist,
    pinLabel,
    pruneEmptyFolders,
    PREFS_DEFAULT,
    normalizePrefs,
    sortedFolderNames,
    BUILTIN_LISTS,
    builtinLists,
    fromPocketTube,
    mergeFolders,
    createFolder,
    deleteFolder,
    renameFolder,
    parsePlaylistInput,
    addToFolder,
    removeFromFolder,
    movePlaylistToFolder,
    folderCount,
    playlistCount,
    scaffoldFromSubsExport,
    isEmptyPocketTubePlaylistExport,
    resolveBundledImport,
    fromForgeFolders,
    toForgeFolders,
    persistPins,
    persistFolders,
    applyRemotePinSync,
    hydratePinsFromSync,
    compactPinSyncPayload,
    pinSyncPayloadBytes,
    PIN_SYNC_KEY,
    PIN_SYNC_BYTE_BUDGET,
    lastPinSyncError: function () {
      return _lastPinSyncError;
    },
    PL_RE
  };
});
