/**
 * Shared subscription-feed tile selectors and channel-key extraction.
 * Thin wrapper over yt-dom.js — kept for backward compatibility with tests/imports.
 */
(function (g, factory) {
  'use strict';

  var YD = typeof require !== 'undefined' ? require('./yt-dom.js') : g && g.UNYtDom;
  var api = factory(YD);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNSubFeed = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis, function (YD) {
  'use strict';

  if (!YD) throw new Error('UNYtDom required');

  return {
    FEED_TILES: YD.FEED_TILES,
    CHANNEL_LINK_SEL: YD.CHANNEL_LINK_SEL,
    tileChannelKey: YD.tileChannelKey,
    forEachFeedTile: YD.forEachFeedTile
  };
});
