'use strict';

/**
 * Unsynth ↔ Playlist Forge bridge (runs on playlist-forge.vercel.app).
 * Outbound: taste summary + playlist folders to Forge.
 * Inbound: Forge folder changes and built playlists sync back to extension storage.
 */
(function () {
  var PF = typeof window !== 'undefined' && window.UNPlaylistFolders;
  var WS = typeof window !== 'undefined' && window.UNWatchStats;
  var FD = typeof window !== 'undefined' && window.UNForgeDiscover;
  var FS = typeof window !== 'undefined' && window.UNForgeSync;
  var syncConfig = { enabled: false, sharedAt: 0, requestAt: 0 };
  var postTimer = null;

  function sendRuntime(type, extra) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}), function (result) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(result || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function bridgeResponse(requestId, result, status) {
    window.postMessage({
      source: 'unsynth-youtube-response',
      requestId: String(requestId || '').slice(0, 80),
      ok: !!(result && result.ok),
      status: status || (result && result.ok ? 200 : 500),
      data: result || { ok: false, error: 'extension_unavailable' }
    }, location.origin);
  }

  function confirmFn(msg) {
    try {
      return window.confirm(msg) === true;
    } catch (e) {
      return false;
    }
  }

  /** The confirmation text for a request that removes or exposes data, else ''. */
  function confirmMessage(op, p) {
    if (op !== 'playlist-update') return '';
    if (p.action === 'remove') {
      var n = Array.isArray(p.itemIds) ? Math.min(p.itemIds.length, 200) : 0;
      return 'Unsynth: Playlist Forge wants to remove ' + n + ' ' + (n === 1 ? 'video' : 'videos') +
        ' from one of your YouTube playlists. Allow?';
    }
    if (p.action === 'rename' && p.privacy) {
      return 'Unsynth: Playlist Forge wants to change one of your YouTube playlists to "' +
        String(p.privacy).slice(0, 20) + '"' + (p.title ? ' and rename it to "' + String(p.title).slice(0, 80) + '"' : '') +
        '. Allow?';
    }
    return '';
  }

  async function handleYouTubeRequest(d) {
    var requestId = String(d.requestId || '').slice(0, 80);
    var op = String(d.operation || '');
    var p = d.payload && typeof d.payload === 'object' ? d.payload : {};
    if (!requestId) return;
    if (!syncConfig.enabled) {
      return bridgeResponse(requestId, { ok: false, error: 'forge_sync_disabled' }, 403);
    }
    // YOU CONFIRM ANYTHING THAT LOSES OR EXPOSES DATA (code review #2, PR #2).
    // Any script on the Forge origin can post these requests while sync is on,
    // including a compromised third-party script or an XSS payload, and they
    // run with this extension's YouTube authority. Removing videos and changing
    // a playlist's privacy (private -> public exposes it) now need a yes from
    // the browser's own dialog, raised from this isolated world: page scripts
    // can neither answer it nor draw over it, which an in-page dialog could
    // not promise. Adding, creating, reordering and title-only renames lose
    // nothing and stay silent so Forge's normal flow is not interrupted.
    var ask = confirmMessage(op, p);
    if (ask && !confirmFn(ask)) {
      return bridgeResponse(requestId, { ok: false, error: 'user_declined' }, 403);
    }
    var result = null;
    if (op === 'auth-status') {
      result = await sendRuntime(UNMSG.AUTH_STATUS);
      // A STORED TOKEN IS NOT A LIVE CONNECTION.
      //
      // This reported `connected: !!result.authed` and answered HTTP 200 on the
      // same test, so a token that had expired with no refresh_token — or one
      // Google had revoked — was announced to the website as a working
      // connection. Every call after that failed. The dashboard already knew
      // better (it checks `usable`); this did not, and neither did the playlist
      // organizer or the stats page.
      //
      // UNAuthState is the single reading now, so the four surfaces cannot
      // drift again. canWrite() derives from the connection rather than from
      // scopeKeys alone: an expired grant still lists 'write' in its scopes.
      var AS = window.UNAuthState;
      var connected = AS ? AS.isConnected(result) : !!(result && result.authed && result.usable !== false);
      var canWrite = AS ? AS.canWrite(result)
        : connected && !!(result && result.scopeKeys && result.scopeKeys.indexOf('write') !== -1);
      return bridgeResponse(requestId, {
        ok: !!(result && result.ok),
        connected: connected,
        canWrite: canWrite,
        // Distinguishable from "never connected", so the site can say
        // Reconnect rather than sending the user through first-time setup.
        needsReconnect: AS ? AS.needsReconnect(result) : !!(result && result.authed && result.usable === false),
        hasConfig: !!(result && result.hasConfig),
        source: 'extension'
      }, connected ? 200 : 401);
    }
    if (op === 'playlists') result = await sendRuntime(UNMSG.YT_PLAYLISTS_MINE);
    else if (op === 'playlist-items') result = await sendRuntime(UNMSG.YT_PLAYLIST_ITEMS, { playlistId: String(p.playlistId || '').slice(0, 100) });
    else if (op === 'build') result = await sendRuntime(UNMSG.YT_PLAYLIST_CREATE, {
      title: String(p.title || '').slice(0, 150),
      description: String(p.description || '').slice(0, 5000),
      privacyStatus: p.privacy,
      videoIds: Array.isArray(p.videoIds) ? p.videoIds.slice(0, 200) : []
    });
    else if (op === 'playlist-update' && p.action === 'add') result = await sendRuntime(UNMSG.YT_PLAYLIST_ADD, { playlistId: p.playlistId, videoIds: Array.isArray(p.videoIds) ? p.videoIds.slice(0, 200) : [] });
    else if (op === 'playlist-update' && p.action === 'remove') result = await sendRuntime(UNMSG.YT_PLAYLIST_REMOVE, { itemIds: Array.isArray(p.itemIds) ? p.itemIds.slice(0, 200) : [] });
    else if (op === 'playlist-update' && p.action === 'rename') result = await sendRuntime(UNMSG.YT_PLAYLIST_RENAME, { playlistId: p.playlistId, title: p.title, privacy: p.privacy });
    else if (op === 'playlist-update' && p.action === 'reorder') result = await sendRuntime(UNMSG.YT_PLAYLIST_REORDER, { itemId: p.itemId, playlistId: p.playlistId, videoId: p.videoId, position: p.position });
    else return bridgeResponse(requestId, { ok: false, error: 'unsupported_operation' }, 400);
    if (!result) return bridgeResponse(requestId, { ok: false, error: 'extension_unavailable' }, 503);
    bridgeResponse(requestId, result, result.ok ? 200 : (/auth|not_authed|refresh|write_scope/.test(String(result.error || '')) ? 401 : 500));
  }

  function summarize(ws, ss) {
    if (WS && WS.summarizeForForge) {
      var summary = WS.summarizeForForge(ws, ss);
      if (FD && FD.enrichSuggestSummary) return FD.enrichSuggestSummary(summary, ws);
      return summary;
    }
    var s = {};
    if (ws) {
      s.total = ws.total;
      s.uniqueChannels = ws.uniqueChannels;
      s.topChannels = (ws.topChannels || []).slice(0, 20).map(function (c) {
        return [c[0], c[1]];
      });
    }
    if (ss && ss.topTerms) {
      s.topSearchTerms = (ss.topTerms || []).slice(0, 12).map(function (t) {
        return t[0];
      });
    }
    return s;
  }

  function post() {
    if (!syncConfig.enabled || !FS) return;
    try {
      chrome.storage.local.get(['watchStats', 'searchStats', 'plFolderStore', 'forgePrefs'], function (d) {
        if (!syncConfig.enabled) return;
        var ws = d && d.watchStats;
        var ss = d && d.searchStats;
        var plStore = d && d.plFolderStore;
        var summary = FS.sanitizeSummary(summarize(ws, ss));
        var tastePrefs = (d.forgePrefs && d.forgePrefs.taste) || null;
        var safeTaste = tastePrefs ? {
          excludeWatched: tastePrefs.excludeWatched !== false,
          boostChannels: tastePrefs.boostChannels === true,
          excludeAI: tastePrefs.excludeAI !== false,
          customAvoidChannels: (tastePrefs.customAvoidChannels || []).slice(0, 20).map(function (v) { return String(v || '').slice(0, 100); }).filter(Boolean)
        } : null;
        var payload = {
          source: 'unsynth-stats',
          summary: summary,
          forgeFolders: plStore && PF ? FS.sanitizeFolders(PF.toForgeFolders(plStore)) : null,
          forgeTastePrefs: safeTaste
        };
        window.postMessage(payload, location.origin);
        var now = Date.now();
        syncConfig.sharedAt = now;
        chrome.storage.local.set({
          forgeLastSync: now,
          forgeSync: { enabled: true, sharedAt: now, requestAt: syncConfig.requestAt || 0 }
        });
      });
    } catch (e) {
      /* ignore */
    }
  }

  function schedulePost() {
    if (!syncConfig.enabled || postTimer) return;
    postTimer = setTimeout(function () {
      postTimer = null;
      post();
    }, 1000);
  }

  function mergeForgeFolders(pfFolders) {
    if (!syncConfig.enabled || !PF || !FS || !pfFolders) return;
    pfFolders = FS.sanitizeFolders(pfFolders);
    var incoming = PF.fromForgeFolders(pfFolders);
    // Merging writer — never wholesale overwrite (see persistFolders).
    if (PF.persistFolders) {
      PF.persistFolders(incoming);
      return;
    }
    chrome.storage.local.get({ plFolderStore: PF.empty() }, function (d) {
      var merged = PF.mergeFolders(d.plFolderStore || PF.empty(), incoming);
      chrome.storage.local.set({ plFolderStore: merged });
    });
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== window) return;
    var d = e.data;
    if (!d || d.target !== 'unsynth-bridge') return;
    if (d.type === 'pf-youtube-request') {
      handleYouTubeRequest(d);
      return;
    }
    if (!syncConfig.enabled || !FS) return;
    if (d.type === 'pf-folders' && d.folders) mergeForgeFolders(d.folders);
    if (d.type === 'pf-built-playlist' && d.playlistId) {
      var built = FS.sanitizeBuiltPlaylist(d);
      if (!built) return;
      chrome.storage.local.get({ plFolderStore: PF ? PF.empty() : { folders: {}, names: {} } }, function (loc) {
        var store = loc.plFolderStore || (PF ? PF.empty() : { folders: {}, names: {} });
        if (built.folder && PF) {
          if (!store.folders[built.folder]) store.folders[built.folder] = [];
          if (store.folders[built.folder].indexOf(built.playlistId) === -1) store.folders[built.folder].push(built.playlistId);
        }
        store.names = store.names || {};
        if (built.title) store.names[built.playlistId] = built.title;
        if (PF && PF.persistFolders) {
          PF.persistFolders(store);
          return;
        }
        chrome.storage.local.set({ plFolderStore: store });
      });
    }
  });

  window.postMessage({ source: 'unsynth-youtube-ready' }, location.origin);

  chrome.storage.local.get({ forgeSync: { enabled: false, sharedAt: 0, requestAt: 0 } }, function (d) {
    syncConfig = FS ? FS.normalizeConfig(d.forgeSync) : syncConfig;
    if (syncConfig.enabled) {
      post();
      window.postMessage({ source: 'unsynth-youtube-ready' }, location.origin);
    }
  });
  setInterval(post, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) post();
  });

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.forgeSync) {
        var previous = syncConfig;
        syncConfig = FS ? FS.normalizeConfig(changes.forgeSync.newValue) : syncConfig;
        if (syncConfig.enabled && (!previous.enabled || syncConfig.requestAt > previous.requestAt)) schedulePost();
        if (!syncConfig.enabled && postTimer) { clearTimeout(postTimer); postTimer = null; }
        return;
      }
      if (changes.plFolderStore || changes.watchStats || changes.searchStats || changes.forgePrefs) {
        schedulePost();
      }
    });
  } catch (e) {
    /* ignore */
  }
})();
