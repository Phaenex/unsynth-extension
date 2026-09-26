'use strict';

/**
 * Tile scraping for the catch-up digest.
 *
 * Separated from catch-up.js so the pure ranking/packing logic stays free of
 * DOM assumptions, and so the part that rots — YouTube's markup — has one
 * place to be fixed.
 *
 * RENDERER DRIFT, MEASURED NOT ASSUMED
 * Verified live this session against real youtube.com:
 *
 *   /@Fireship/videos : ytd-rich-item-renderer 30, yt-lockup-view-model 30
 *                       (every lockup nested inside a rich item),
 *                       ytd-grid-video-renderer 0, ytd-rich-grid-media 0,
 *                       ytd-thumbnail-overlay-time-status-renderer 0,
 *                       badge-shape 30.
 *   /results?…        : ytd-video-renderer 15, yt-lockup-view-model 5
 *                       (all top-level), ytd-rich-item-renderer 0.
 *
 * Two things follow. First, walking the shared FEED_TILES list emits a lockup
 * twice on a channel page — once as the rich item, once as its own nested
 * lockup — so nested lockups are dropped and top-level ones kept. Second, the
 * duration on the modern tile lives in badge-shape, NOT in the
 * ytd-thumbnail-overlay-time-status-renderer that the legacy selectors look
 * for, and that element is entirely absent on that surface.
 *
 * The tile selector list is deliberately read from yt-dom.js rather than
 * copied. A second hardcoded list is exactly how the drift from ytd-* tags to
 * yt-*-view-model tags produced two real bugs here: one list gets updated, the
 * other quietly matches nothing.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./yt-dom.js'), require('./catch-up.js'));
  } else {
    root.UNCatchUpScrape = factory(root.UNYtDom, root.UNCatchUp);
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function (YD, CU) {
  'use strict';

  // Duration badge, newest first. badge-shape is where it actually is on the
  // modern lockup; the two legacy forms are kept because search and older
  // cached layouts still ship them, and an extra selector that matches
  // nothing costs nothing.
  var DUR_SEL = 'badge-shape, ytd-thumbnail-overlay-time-status-renderer, #time-status, .badge-shape-wiz__text';

  // Where the "N hours ago" text lives. The modern tile concatenates it with
  // the view count inside yt-content-metadata-view-model; the legacy tile
  // keeps it in #metadata-line.
  var META_SEL = 'yt-content-metadata-view-model, #metadata-line, ytd-video-meta-block';

  function textOf(el) {
    return el ? (el.textContent || '').trim() : '';
  }

  /** Duration from whichever badge on this tile parses as a real clock time. */
  function tileDurationSec(tile) {
    if (!tile || !tile.querySelectorAll) return 0;
    var found = 0;
    tile.querySelectorAll(DUR_SEL).forEach(function (el) {
      if (found) return;
      var sec = CU.parseDurationSec(textOf(el));
      if (sec) found = sec;
    });
    return found;
  }

  /** Upload age from any metadata block on the tile, or null when absent. */
  function tileAgeMs(tile) {
    if (!tile || !tile.querySelectorAll) return null;
    var age = null;
    tile.querySelectorAll(META_SEL).forEach(function (el) {
      if (age != null) return;
      var parsed = CU.parseAgeMs(textOf(el));
      if (parsed != null) age = parsed;
    });
    if (age == null) {
      // Last resort: the whole tile's text. Cheaper selectors first so this
      // only runs on layouts none of them covered.
      age = CU.parseAgeMs(textOf(tile));
    }
    return age;
  }

  function tileIsShort(tile) {
    if (!tile) return false;
    if (tile.tagName && tile.tagName.toLowerCase() === 'ytd-reel-item-renderer') return true;
    return !!(tile.querySelector && tile.querySelector('a[href*="/shorts/"]'));
  }

  /**
   * Channel key from a channel-page URL, normalised the way tileChannelKey()
   * normalises one scraped from an href (lowercased, "channel:" prefix
   * dropped) so the two are directly comparable.
   */
  function channelKeyFromPath(pathname) {
    if (!pathname) return null;
    var p = String(pathname);
    var at = p.match(/^\/@([^/?#]+)/);
    if (at) return '@' + at[1].toLowerCase();
    var ch = p.match(/^\/channel\/([^/?#]+)/);
    if (ch) return ch[1].toLowerCase();
    var legacy = p.match(/^\/(?:c|user)\/([^/?#]+)/);
    if (legacy) return 'c:' + legacy[1].toLowerCase();
    return null;
  }

  /**
   * Scrape catch-up candidates out of a root element.
   *
   * @param root document or a scoped container
   * @param pageChannel optional { channelKey, channelName } for the channel
   *        whose page this is. Needed because on a channel's own /videos tab
   *        the tiles carry NO channel link at all — verified live on
   *        /@Fireship/videos, where all 30 tiles have zero channel hrefs,
   *        since the channel is the page. tileChannelKey() derives a key only
   *        from an href, so without this every tile on the single most direct
   *        source of a channel's recent uploads came back keyless and was
   *        dropped by the folder-membership filter. Confirmed by e2e:
   *        catchUpSeen stayed empty on a page rendering 30 grouped-channel
   *        tiles. It is a FALLBACK only — a tile that carries its own channel
   *        link keeps it, because a channel page also renders shelves of other
   *        creators' videos and stamping the page's channel onto those would
   *        file someone else's upload under this folder.
   * @returns [{ videoId, title, channelKey, channelName, ageMs, durationSec, isShort }]
   */
  function scrapeCandidates(root, pageChannel) {
    var out = [];
    if (!root || !root.querySelectorAll) return out;
    var seen = Object.create(null);
    var selectors = (YD && YD.FEED_TILES) || [];

    selectors.forEach(function (sel) {
      root.querySelectorAll(sel).forEach(function (tile) {
        // A lockup nested inside a rich item is the SAME tile reached twice.
        // Confirmed live: on a channel /videos page all 30 lockups sit inside
        // the 30 rich items, so without this the digest counts everything
        // twice. A top-level lockup (search) has no such ancestor and is kept.
        if (
          tile.tagName &&
          tile.tagName.toLowerCase() === 'yt-lockup-view-model' &&
          tile.closest &&
          tile.closest('ytd-rich-item-renderer')
        ) {
          return;
        }
        var videoId = YD.tileVideoId(tile);
        if (!videoId || seen[videoId]) return;
        seen[videoId] = true;
        var key = YD.tileChannelKey(tile) || '';
        var chName = YD.tileChannel(tile) || '';
        if (!key && pageChannel && pageChannel.channelKey) {
          key = pageChannel.channelKey;
          if (!chName) chName = pageChannel.channelName || '';
        }
        out.push({
          videoId: videoId,
          title: YD.tileTitle(tile) || '',
          channelKey: key,
          channelName: chName,
          ageMs: tileAgeMs(tile),
          durationSec: tileDurationSec(tile),
          isShort: tileIsShort(tile)
        });
      });
    });
    return out;
  }

  return {
    DUR_SEL: DUR_SEL,
    META_SEL: META_SEL,
    tileDurationSec: tileDurationSec,
    tileAgeMs: tileAgeMs,
    tileIsShort: tileIsShort,
    channelKeyFromPath: channelKeyFromPath,
    scrapeCandidates: scrapeCandidates
  };
});
