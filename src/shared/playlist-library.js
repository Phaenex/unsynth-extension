'use strict';

/**
 * Shared playlist-library helpers — empty-state copy, standard-list merge,
 * and the sort that keeps Watch Later / Liked at the top.
 *
 * Used by the service worker (YT_PLAYLISTS_MINE) and the Playlist Organizer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UNPlaylistLibrary = factory();
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function playlistLibraryFactory() {
  function isAuthError(err) {
    var e = String(err || '');
    if (/not_authed|no_refresh_token|refresh_failed|auth_expired|invalid_grant/i.test(e)) return true;
    return /yt_api_401|(^|[^0-9])401([^0-9]|$)/.test(e);
  }

  function emptyLibraryMessage(state) {
    var s = state || {};
    if (s.query) return 'No matching playlist.';
    if (s.error) {
      var err = String(s.error);
      if (isAuthError(err)) return 'Your YouTube connection expired. Reconnect and try again.';
      if (/quota/i.test(err)) return 'The YouTube API quota is used up for today.';
      if (/forbidden/i.test(err)) return 'The organizer could not talk to the extension. Reload Unsynth and try again.';
      if (/no_response/i.test(err)) return 'No response from the extension. Reload Unsynth and try again.';
      if (/yt_api_403|(^|[^0-9])403([^0-9]|$)/.test(err)) return 'YouTube refused that request. Reconnect with read access.';
      return err.replace(/^yt_api_/, 'YouTube API error ');
    }
    if (!s.authed) {
      return s.hasConfig ? 'Connect YouTube to load your playlists.' : 'Set up YouTube in Settings, then connect.';
    }
    return 'No playlists on this account yet.';
  }

  function mergeStandardPlaylists(created, related) {
    var src = Array.isArray(created) ? created : [];
    var rel = related && typeof related === 'object' ? related : {};
    var byId = {};
    src.forEach(function (p) {
      if (p && p.id) byId[p.id] = p;
    });
    var out = [];
    var seen = {};
    var standards = [
      { id: rel.watchLater || 'WL', title: 'Watch later', standard: 'watchLater' },
      { id: rel.likes || 'LL', title: 'Liked videos', standard: 'likes' }
    ];
    standards.forEach(function (row) {
      if (!row.id || seen[row.id]) return;
      seen[row.id] = true;
      var existing = byId[row.id];
      out.push({
        id: row.id,
        title: row.title,
        count: existing && existing.count != null ? existing.count : 0,
        thumb: (existing && existing.thumb) || '',
        standard: row.standard
      });
    });
    src.forEach(function (p) {
      if (!p || !p.id || seen[p.id]) return;
      seen[p.id] = true;
      out.push(p);
    });
    return out;
  }

  function orderPlaylists(list) {
    var rows = Array.isArray(list) ? list.slice() : [];
    var standards = rows.filter(function (p) { return p && p.standard; });
    var rest = rows.filter(function (p) { return p && !p.standard; }).sort(function (a, b) {
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
    return standards.concat(rest);
  }

  return {
    isAuthError: isAuthError,
    emptyLibraryMessage: emptyLibraryMessage,
    mergeStandardPlaylists: mergeStandardPlaylists,
    orderPlaylists: orderPlaylists
  };
});
