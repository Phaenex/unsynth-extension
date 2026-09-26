/**
 * Normalize module flags — split legacy playlistManager into playlistFolders + playlistBulk.
 */
(function (g) {
  'use strict';

  function normalizeModules(mods, defaults) {
    const base = Object.assign({}, (defaults && defaults.modules) || {}, mods || {});
    // The old combined `playlistManager` toggle was split into playlistFolders +
    // playlistBulk. Legacy ON should light up both new modules — but legacy OFF
    // must NOT switch them off: they are distinct features with their own
    // defaults (on) and their own toggles now. Only propagate a `true`, and only
    // when the split flag is still unset. An explicit split flag always wins.
    if (base.playlistManager === true) {
      if (base.playlistFolders === undefined) base.playlistFolders = true;
      if (base.playlistBulk === undefined) base.playlistBulk = true;
    }
    return base;
  }

  const api = { normalizeModules };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNModules = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
