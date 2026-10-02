/**
 * Shared YouTube DOM helpers — feed tile selectors, metadata scraping, page detection.
 * Single source of truth so modules don't drift when YouTube changes layout.
 */
(function (g, factory) {
  'use strict';

  var SG = typeof require !== 'undefined' ? require('./sub-groups.js') : g && g.UNSubGroups;
  var api = factory(SG);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNYtDom = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis, function (SG) {
  'use strict';

  /** Standard video feed tiles on youtube.com (not music.youtube.com). */
  var FEED_TILES = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-rich-grid-media',
    'ytd-reel-item-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'yt-lockup-view-model'
  ];

  var CHANNEL_LINK_SEL =
    'ytd-channel-name a[href], #channel-name a[href], a.yt-simple-endpoint.ytd-channel-name[href], ' +
    '.ytd-channel-name a[href], yt-content-metadata-view-model a[href*="/@"], ' +
    'yt-content-metadata-view-model a[href*="/channel/"], ' +
    'a.yt-lockup-metadata-view-model__title[href*="/@"], a.yt-lockup-metadata-view-model__title[href*="/channel/"], ' +
    '.yt-content-metadata-view-model-wiz a[href*="/@"], .yt-content-metadata-view-model-wiz a[href*="/channel/"], ' +
    '.yt-lockup-metadata-view-model-wiz a[href*="/@"], .yt-lockup-metadata-view-model-wiz a[href*="/channel/"]';

  var TITLE_SEL =
    '#video-title, #video-title-link, a#video-title, yt-formatted-string#video-title, ' +
    '.yt-lockup-metadata-view-model-wiz__title, .yt-lockup-metadata-view-model__heading, h3 a, ' +
    'a.yt-lockup-metadata-view-model__title, [class*="metadata-view-model"] [title]';

  var CHANNEL_SEL =
    'ytd-channel-name a, ytd-channel-name #text, #channel-name a, #channel-name #text, ' +
    'a.yt-simple-endpoint.ytd-channel-name, .yt-content-metadata-view-model-wiz__metadata-text, ' +
    '.yt-content-metadata-view-model__metadata-text, ytd-channel-name yt-formatted-string';

  var CHANNEL_KEY_LINK_SEL =
    'ytd-channel-name a, #channel-name a, a.yt-simple-endpoint.ytd-channel-name, a[href^="/@"], a[href*="/channel/"], ' +
    '.yt-content-metadata-view-model-wiz a[href*="/@"], .yt-content-metadata-view-model-wiz a[href*="/channel/"]';

  function normalizeListKey(k) {
    if (!k) return null;
    if (k.indexOf('channel:') === 0) return k.slice(8).toLowerCase();
    return k.toLowerCase();
  }

  function channelKeyFromHref(href) {
    if (!href || !SG) return null;
    return normalizeListKey(SG.channelKey(href));
  }

  function feedTileSelector() {
    return FEED_TILES.join(', ');
  }

  /** True when this tile sits inside another FEED_TILES host (lockup inside rich-item). */
  function isNestedFeedTile(tile) {
    if (!tile || !tile.parentElement || !tile.parentElement.closest) return false;
    try {
      return !!tile.parentElement.closest(feedTileSelector());
    } catch (e) {
      return false;
    }
  }

  function outermostFeedTileRaw(tile) {
    if (!tile) return null;
    var outer = tile;
    var hops = 0;
    while (hops++ < 8 && outer.parentElement && outer.parentElement.closest) {
      var up = outer.parentElement.closest(feedTileSelector());
      if (!up || up === outer) break;
      outer = up;
    }
    return outer;
  }

  /* ==========================================================================
     PER-SCAN TILE MEMO (2026-10-01)

     On a long scrolled page every module asked every tile the same questions
     on every scan: aiFilter, watchHistory, sidebarHub's catch-up scrape and
     subManager each looked up the channel key, video id, ad status and resume
     bar, all through querySelector. Measured on a search page scrolled for
     30 s (~47k nodes): 62 scans, p95 99 ms, nearly all over core's 50 ms
     alarm, and these helpers were the largest share of it.

     While core.runScan() runs (beginScan/endScan), each answer is computed
     once per tile and shared. Outside a scan nothing is memoised, so event
     handlers always read the live DOM.

     The channel key also survives ACROSS scans, but only bound to the tile's
     video id: YouTube recycles tile elements for other videos, and a new
     video id drops the entry. A video's channel cannot change, and an empty
     key is never kept, because a tile's metadata can render after its link.

     The state lives on the global, not in this closure: yt-dom is bundled
     into both content bundles, and modules hold whichever instance existed
     when they loaded. Every instance must see the same scan.
     ========================================================================== */
  var SCAN_KEY = '__unsynthTileScan';
  var GLOBAL = typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis;
  function scanState() {
    return GLOBAL[SCAN_KEY] || null;
  }
  // dirtyList: the tiles that changed since the last scan (core.js, DIRTY-TILE
  // SCANNING), or null for a full scan. Only callers that pass dirtyOk see it.
  function beginScan(dirtyList) {
    var prev = GLOBAL[SCAN_KEY];
    GLOBAL[SCAN_KEY] = {
      memo: new Map(),
      tiles: null,
      dirty: Array.isArray(dirtyList) ? dirtyList : null,
      dirtySet: Array.isArray(dirtyList) && typeof Set !== 'undefined' ? new Set(dirtyList) : null,
      stable: (prev && prev.stable) || (typeof WeakMap !== 'undefined' ? new WeakMap() : null)
    };
  }
  function endScan() {
    var st = GLOBAL[SCAN_KEY];
    // Keep only the cross-scan channel keys; drop the per-scan answers.
    if (st) GLOBAL[SCAN_KEY] = { memo: null, tiles: null, stable: st.stable };
  }
  function memoTile(tile, name, fn) {
    var st = scanState();
    if (!st || !st.memo || !tile) return fn(tile);
    var m = st.memo.get(tile);
    if (!m) {
      m = {};
      st.memo.set(tile, m);
    }
    if (Object.prototype.hasOwnProperty.call(m, name)) return m[name];
    return (m[name] = fn(tile));
  }
  function tileVideoId(tile) { return memoTile(tile, 'vid', tileVideoIdRaw); }
  // The tile's cross-scan entry for this video, replaced when the video changes.
  function stableEntry(stable, tile, vid) {
    var e = stable.get(tile);
    if (!e || e.vid !== vid) {
      e = { vid: vid };
      stable.set(tile, e);
    }
    return e;
  }
  // Title and channel-name ELEMENTS are kept across scans, never their text:
  // DeArrow and the title cleaner rewrite that text in place, so it is read
  // fresh every time. Finding the element is the expensive part (the selector
  // lists are long), and a kept element is only reused while it still sits in
  // the same tile showing the same video.
  // noneOnceTitled: also keep "there is no such element" once the title has
  // rendered (channel /videos tiles have no channel name: 310 ms / 30 s of
  // re-searching 600 tiles, 2026-10-01), the same rule as an empty key.
  function elementAcrossScans(name, find, noneOnceTitled) {
    return function (tile) {
      var st = scanState();
      var stable = st && st.memo && st.stable;
      var vid = stable ? tileVideoId(tile) : null;
      if (vid) {
        var hit = stable.get(tile);
        if (hit && hit.vid === vid) {
          var el = hit[name];
          if (el && el.isConnected !== false && (!tile.contains || tile.contains(el))) return el;
          if (!el && hit[name + 'None']) return null;
        }
      }
      var found = find(tile);
      if (vid && found) stableEntry(stable, tile, vid)[name] = found;
      else if (vid && noneOnceTitled && titleEl(tile)) stableEntry(stable, tile, vid)[name + 'None'] = true;
      return found;
    };
  }
  var titleEl = elementAcrossScans('titleEl', titleElRaw, false);
  var channelEl = elementAcrossScans('channelEl', channelElRaw, true);
  function tileTitle(tile) { return memoTile(tile, 'title', function (t) { return tileTitleFrom(t, titleEl(t)); }); }
  function tileChannel(tile) { return memoTile(tile, 'channel', function (t) { return tileChannelFrom(channelEl(t)); }); }
  function tileThumb(tile) { return memoTile(tile, 'thumb', tileThumbRaw); }
  function tileNativeProgress(tile) { return memoTile(tile, 'progress', tileNativeProgressRaw); }
  // Ad and collection status are the tile's KIND, stamped with the tile, so
  // they follow the same video-id binding as the channel key. Unlike the key,
  // false is kept too: it is the answer for nearly every tile, and not
  // keeping it is what made tileIsAd the largest helper left (107 ms / 30 s).
  function kindAcrossScans(name, raw) {
    return function (tile) {
      var st = scanState();
      var stable = st && st.memo && st.stable;
      var vid = stable ? tileVideoId(tile) : null;
      // A tile that changed since the last scan is asked again: a sponsored
      // badge or collection stack can render after the watch link.
      var changed = !!(st && st.dirtySet && st.dirtySet.has(tile));
      if (vid && !changed) {
        var hit = stable.get(tile);
        if (hit && hit.vid === vid && Object.prototype.hasOwnProperty.call(hit, name)) return hit[name];
      }
      var v = raw(tile);
      // true is final for this video; false only once the title has rendered
      // (the noKey rule below), since the markers render with the metadata.
      if (vid && (v || titleEl(tile))) stableEntry(stable, tile, vid)[name] = v;
      return v;
    };
  }
  var adAcrossScans = kindAcrossScans('ad', tileIsAdRaw);
  var collectionAcrossScans = kindAcrossScans('collection', tileIsCollectionRaw);
  function tileIsAd(tile) { return memoTile(tile, 'ad', adAcrossScans); }
  function tileIsCollection(tile) { return memoTile(tile, 'collection', collectionAcrossScans); }
  function outermostFeedTile(tile) { return memoTile(tile, 'outer', outermostFeedTileRaw); }
  function channelKeyAcrossScans(tile) {
    var st = scanState();
    var stable = st && st.memo && st.stable;
    var vid = stable ? tileVideoId(tile) : null;
    if (vid) {
      var hit = stable.get(tile);
      if (hit && hit.vid === vid && (hit.key || hit.noKey)) return hit.key || null;
    }
    var key = tileChannelKeyRaw(tile);
    if (vid && key) {
      stableEntry(stable, tile, vid).key = key;
    } else if (vid && titleEl(tile)) {
      // No channel link, but the metadata block has rendered (the title is
      // stamped with it): a channel's own /videos tiles carry no channel link
      // at all. Without this, 600 tiles re-ran the longest lookup in this file
      // every scan for an answer that could not change (436 ms / 30 s,
      // 2026-10-01). Before the title renders, an empty key is still not kept.
      stableEntry(stable, tile, vid).noKey = true;
    }
    return key;
  }
  function tileChannelKey(tile) { return memoTile(tile, 'chKey', channelKeyAcrossScans); }

  function forEachFeedTile(cb, opts) {
    opts = opts || {};
    var selectors = FEED_TILES.slice();
    if (opts.extraSelectors) {
      selectors = selectors.concat(opts.extraSelectors);
    }
    var root = opts.root || null;
    if (typeof root === 'string' && typeof document !== 'undefined') {
      root = document.querySelector(root);
    }
    if (!root && typeof document !== 'undefined') root = document;
    if (!root || !root.querySelectorAll) return;
    // ONE walk, not one per selector (2026-10-01). Nine renderer names meant
    // nine full-document querySelectorAll walks per call, seven callers per
    // scan; on a scrolled search page (~47k nodes) this line was the
    // extension's single largest cost. A selector list returns each element
    // once, in document order, so an outer tile still comes before a tile
    // nested in it, which is the only ordering any caller relies on.
    var count = 0;
    var st = scanState();
    var shared = st && st.memo && root === document && !opts.extraSelectors;
    // Per-tile decoration can take just the tiles that changed. Anything that
    // COUNTS or lists the page must not pass dirtyOk: it would see a fraction.
    if (shared && opts.dirtyOk && st.dirty) {
      st.dirty.forEach(function (tile) {
        count++;
        cb(tile);
      });
      return 'dirty';
    }
    var list = shared && st.tiles;
    if (!list) {
      list = Array.prototype.slice.call(root.querySelectorAll(selectors.join(',')));
      if (shared) st.tiles = list;
    }
    list.forEach(function (tile) {
      count++;
      cb(tile);
    });
    // Drift canary. This is the single funnel every feed feature walks, so one
    // hook here covers most of the surface that YouTube markup changes break.
    //
    // Reported only when the caller asserts tiles should exist (opts.expectTiles)
    // AND none of the renderer names matched -- a feed with genuinely zero
    // videos, or a page still loading, is not drift. Without that narrowing the
    // signal is noise, and a noisy signal gets ignored.
    if (opts.expectTiles && count === 0) {
      var core = (typeof window !== 'undefined' && window.UNSYNTH) || null;
      if (core && core.reportSelectorMiss) {
        core.reportSelectorMiss(opts.scope || 'feed', selectors.join(','));
      }
    }
    return 'full';
  }

  function tileChannelKeyRaw(tile) {
    if (!tile || !tile.querySelectorAll) return null;
    var links = tile.querySelectorAll(CHANNEL_LINK_SEL);
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (!href || href.indexOf('/watch') === 0) continue;
      var key = SG ? SG.channelKey(href) : channelKeyFromHref(href);
      if (key) return normalizeListKey(key);
    }
    var alt = tile.querySelector(CHANNEL_KEY_LINK_SEL);
    return channelKeyFromHref(alt && alt.getAttribute('href'));
  }

  // --- search results page -------------------------------------------------
  // Centralized here for the same reason as everything else in this file: when
  // YouTube renames a renderer, one edit fixes every caller instead of a hunt
  // through modules. Dual-form throughout -- legacy ytd-* and the newer
  // *-view-model components ship side by side while surfaces migrate.
  var SEARCH_TILES = 'ytd-video-renderer, yt-lockup-view-model';
  var SEARCH_RESULTS_HOST = 'ytd-search #container, ytd-two-column-search-results-renderer';
  // `.ytContentMetadataViewModelMetadataText` is the current one — measured
  // live, a channel-grid tile carries "1d ago" and "380K views" ONLY in that
  // class, so the two legacy selectors matched nothing and every caller saw an
  // empty meta list. That is why the Suggested/News/Discover pages had no date
  // or view count to show.
  var TILE_META_SEL =
    '#metadata-line span, .inline-metadata-item, ' +
    '.ytContentMetadataViewModelMetadataText, ' +
    'yt-content-metadata-view-model .yt-content-metadata-view-model__metadata-text';
  // `.ytBadgeShapeText` / `.ytBadgeShapeThumbnailBadge` are the current names —
  // YouTube renamed the badge again and the older two stopped matching on
  // playlist rows, which is how the select button ended up sitting on top of the
  // duration on every row of a playlist (the CSS that dodges the badge is keyed
  // off finding it). The legacy names stay for the surfaces still serving them.
  var TILE_DURATION_SEL =
    'ytd-thumbnail-overlay-time-status-renderer #text, ' +
    '.badge-shape-wiz__text, .ytThumbnailBadgeViewModelBadge, ' +
    '.ytBadgeShapeText, .ytBadgeShapeThumbnailBadge';
  var TILE_DESC_SEL =
    '.metadata-snippet-text, .yt-lockup-metadata-view-model__description';
  var TILE_TITLE_TEXT_SEL =
    '#video-title, .yt-lockup-metadata-view-model__title';
  var TILE_CHANNEL_TEXT_SEL =
    'ytd-channel-name a, .yt-content-metadata-view-model__metadata-text';

  /** Metadata strings on a tile ("10M views", "7 years ago"), in DOM order. */
  function tileMetaTexts(tile) {
    if (!tile || !tile.querySelectorAll) return [];
    return Array.prototype.slice.call(tile.querySelectorAll(TILE_META_SEL))
      .map(function (e) { return (e.textContent || '').trim(); })
      .filter(Boolean);
  }

  /**
   * The view-count item from a tile's meta texts, always in the long form
   * ("10M views"), or '' when the tile has none.
   *
   * YouTube A/B-tests a compact tile (captured live 2026-09-23 on search): the
   * meta line reads ["10M", "7y ago", "381K", "3.3K", "99%"], so the word
   * "views" is gone and the likes and comments that follow look identical.
   * The views are the bare count immediately BEFORE the age; the counts after
   * it are never taken. Returned with " views" appended so every existing
   * "N views" parser reads it unchanged.
   */
  var BARE_COUNT_RE = /^[\d.,]+\s*[KMB]?$/i;
  // An age item has the age SHAPE: a number, a unit, then "ago" at the end
  // ("7y ago", "2 hours ago", "Streamed 3 days ago"). An unanchored \bago\b
  // took any title or name containing the word (independent review found
  // ['12K', 'Stream Ago Show'] -> "12K views").
  var AGE_TEXT_RE = /\d+\s*[a-z]+\s+ago\s*$/i;
  function isAgeText(text) {
    return AGE_TEXT_RE.test(String(text || '').trim());
  }
  function viewsText(metaTexts) {
    var list = metaTexts || [];
    for (var i = 0; i < list.length; i++) {
      if (/\bviews?\b/i.test(list[i])) return list[i];
    }
    for (var j = 1; j < list.length; j++) {
      if (isAgeText(list[j]) && BARE_COUNT_RE.test(String(list[j - 1]).trim())) {
        return String(list[j - 1]).trim() + ' views';
      }
    }
    return '';
  }

  /** Raw duration badge text ("7:45", "LIVE", ""). */
  function tileDurationText(tile) {
    if (!tile || !tile.querySelector) return '';
    var el = tile.querySelector(TILE_DURATION_SEL);
    return el ? (el.textContent || '').trim() : '';
  }

  function tileDescription(tile) {
    if (!tile || !tile.querySelector) return '';
    var el = tile.querySelector(TILE_DESC_SEL);
    return el ? (el.textContent || '').trim() : '';
  }

  function titleElRaw(tile) {
    return tile && tile.querySelector ? tile.querySelector(TITLE_SEL) : null;
  }
  function tileTitleRaw(tile) {
    return tileTitleFrom(tile, titleElRaw(tile));
  }
  function tileTitleFrom(tile, el) {
    if (!tile || !tile.querySelector) return '';
    if (el) {
      var t = (el.getAttribute('title') || el.textContent || '').trim();
      if (t) return t;
    }
    var a = tile.querySelector('a[href*="/watch"], a[href*="/shorts/"]');
    return a ? (a.getAttribute('title') || a.textContent || '').trim() : '';
  }

  function channelElRaw(tile) {
    return tile && tile.querySelector ? tile.querySelector(CHANNEL_SEL) : null;
  }
  function tileChannelRaw(tile) {
    return tileChannelFrom(channelElRaw(tile));
  }
  function tileChannelFrom(el) {
    return el ? (el.textContent || '').trim() : '';
  }

  function tileVideoIdRaw(tile) {
    if (!tile || !tile.querySelector) return null;
    var a = tile.querySelector('a#thumbnail[href*="/watch"], a[href*="/watch?v="], a[href*="/watch"], a[href*="/shorts/"]');
    var href = a && a.getAttribute('href');
    if (!href) return null;
    var m = href.match(/[?&]v=([\w-]{11})/);
    if (m) return m[1];
    var sm = href.match(/\/shorts\/([\w-]{11})/);
    return sm ? sm[1] : null;
  }

  function tileThumbRaw(tile) {
    if (!tile || !tile.querySelector) return null;
    return (
      tile.querySelector('a#thumbnail') ||
      tile.querySelector('a.yt-lockup-view-model-wiz__content-image') ||
      tile.querySelector('a[href*="/watch"], a[href*="/shorts/"]')
    );
  }

  // YouTube's OWN resume bar — the red sliver across the bottom of a thumbnail.
  // It is drawn from server-side watch history, so it covers videos watched on
  // another device, in another browser, or before this extension existed. The
  // local watched store cannot know about any of those, which is why a tile can
  // show a completely full red bar and still not be in `watchedVideos`.
  //
  // Both the legacy renderer and the newer view-model layout are matched; each
  // puts the fill percentage in an inline `width` style on the inner element.
  var RESUME_BAR_SEL = [
    'ytd-thumbnail-overlay-resume-playback-renderer #progress',
    'ytd-thumbnail-overlay-resume-playback-renderer .ytd-thumbnail-overlay-resume-playback-renderer',
    '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment',
    '.ytProgressBarLineProgressBarPlayed',
    'yt-thumbnail-overlay-progress-bar-view-model .ytProgressBarLineProgressBarPlayed'
  ].join(',');

  /**
   * Percentage of YouTube's own resume bar on a feed tile.
   *
   * @param {Element} tile a feed tile
   * @returns {number|null} 0-100, or null when the tile has no resume bar or
   *   the bar carries no usable width. Null means "YouTube is not claiming
   *   anything about this video" and must never be collapsed to 0, which would
   *   read as the positive claim "watched none of it".
   */
  function tileNativeProgressRaw(tile) {
    if (!tile || !tile.querySelector) return null;
    var el = tile.querySelector(RESUME_BAR_SEL);
    if (!el) return null;
    var raw = (el.style && el.style.width) || '';
    if (!raw && el.getAttribute) {
      var attr = el.getAttribute('style') || '';
      var m = attr.match(/width\s*:\s*([\d.]+)%/);
      raw = m ? m[1] + '%' : '';
    }
    var pct = parseFloat(String(raw));
    if (!isFinite(pct)) return null;
    if (pct < 0) return 0;
    if (pct > 100) return 100;
    return Math.round(pct);
  }

  // Live-broadcast marker. YouTube renders this differently across layouts:
  // the yt-lockup-view-model grid (home page, channel tabs) uses a
  // badge-shape.ytBadgeShapeThumbnailLive; the legacy ytd-video-renderer
  // (search results) still uses a plain is-live-video attribute on
  // ytd-thumbnail. Both confirmed live against real YouTube DOM — search's
  // badge-shape carries a DIFFERENT class (ytBadgeShapeLive, no "Thumbnail"),
  // used for an inline live-indicator elsewhere, not the grid thumbnail badge,
  // so it is intentionally not included here.
  // Live-broadcast marker. YouTube has shipped several different markers for
  // this and still mixes them across layouts, so check all of them.
  //
  // `ytBadgeShapeThumbnailLive` was the ONLY badge class checked here, and it
  // matches nothing on current YouTube — verified live against a live-filtered
  // search: that selector found 0 tiles on a page with 9 live results, while
  // `ytBadgeShapeLive` and `ytd-thumbnail[is-live-video]` each found all 9.
  // That single stale class is why the "Live now" shelf frequently failed to
  // appear at all. It's kept in the list because it costs nothing and older
  // cached layouts may still emit it.
  var LIVE_BADGE_SEL = [
    'badge-shape.ytBadgeShapeLive',
    'badge-shape.ytBadgeShapeThumbnailLive',
    '.badge-shape-wiz--thumbnail-live',
    'ytd-thumbnail-overlay-time-status-renderer[overlay-style="LIVE"]',
    '.ytThumbnailOverlayBadgeViewModelHost .badge-shape-wiz--thumbnail-live'
  ].join(',');
  function tileIsLive(tile) {
    if (!tile || !tile.querySelector) return false;
    if (tile.querySelector(LIVE_BADGE_SEL)) return true;
    // Attribute form — present on the same tiles as the modern badge, and the
    // more stable of the two since it isn't a styling class.
    if (tile.querySelector('ytd-thumbnail[is-live-video], [is-live-video]')) return true;
    var thumb = tile.querySelector('ytd-thumbnail');
    return !!(thumb && thumb.hasAttribute && thumb.hasAttribute('is-live-video'));
  }

  function isMusicHost(host) {
    return host === 'music.youtube.com';
  }

  /**
   * Selectors YouTube sets while an ad is on the player.
   *
   * Centralised here because two modules already carried an identical private
   * copy (queue-advance.js, watch-history.js) and a third needed it. Host DOM
   * knowledge belongs in this adapter, so a YouTube rename is one fix.
   */
  var AD_STATE_SELECTORS = [
    '.ad-showing', '.ad-interrupting', '.ytp-ad-text',
    '.ytp-ad-simple-ad-badge', '.ytp-ad-preview-text', '.ytp-ad-duration-remaining'
  ];

  /**
   * Is an ad on the player right now?
   *
   * Matters for anything reading <video>.duration or currentTime: during an ad
   * the element reports the AD's numbers, not the video's. Measured on a watch
   * page 2026-09-16 — the runtime strip re-rendered mid-session and printed
   * "RUNTIME 0:30" over a real 18:40, because 0:30 was the ad.
   */
  function adPlaying(doc) {
    var d = doc || document;
    for (var i = 0; i < AD_STATE_SELECTORS.length; i++) {
      if (d.querySelector(AD_STATE_SELECTORS[i])) return true;
    }
    return false;
  }

  /**
   * THE PLAYER'S OWN READOUTS (2026-09-24, for the guide's Now line).
   *
   * The chapter the playhead is in, as YouTube's control bar labels it, and
   * whether the player is showing a live stream. Measured on aircAruvnKk:
   * .ytp-live-badge EXISTS on an ordinary video with display:none, so its
   * presence says nothing; only a visible badge, or the live class YouTube
   * puts on the time display, means live.
   */
  var PLAYER_SEL = '#movie_player';
  var PLAYER_CHAPTER_SEL = '#movie_player .ytp-chapter-title-content';
  var PLAYER_LIVE_TIME_SEL = '#movie_player .ytp-time-display.ytp-live';
  var PLAYER_LIVE_BADGE_SEL = '#movie_player .ytp-live-badge';

  function playerVideo(doc) {
    var d = doc || document;
    return d.querySelector(PLAYER_SEL + ' video') || d.querySelector('video');
  }

  function playerChapterTitle(doc) {
    var d = doc || document;
    var el = d.querySelector(PLAYER_CHAPTER_SEL);
    var t = el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    return t;
  }

  function playerIsLive(doc) {
    var d = doc || document;
    if (d.querySelector(PLAYER_LIVE_TIME_SEL)) return true;
    var b = d.querySelector(PLAYER_LIVE_BADGE_SEL);
    if (!b || !b.getBoundingClientRect) return false;
    var view = d.defaultView;
    if (view && view.getComputedStyle && view.getComputedStyle(b).display === 'none') return false;
    return b.getBoundingClientRect().width > 0;
  }

  var NATIVE_CHAPTER_MARKERS_SEL = 'ytd-macro-markers-list-item-renderer';

  /**
   * Extract native YouTube chapter items from the page when YouTube renders
   * them (e.g. from engagement panel / macro markers / auto-chapters).
   */
  function nativeChapters(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.querySelectorAll) return [];
    var markers = d.querySelectorAll(NATIVE_CHAPTER_MARKERS_SEL);
    if (!markers.length) return [];
    // YouTube leaves the previous video's chapter markers in the page for
    // ~1.5 s after an in-page switch (measured 2026-10-01: 18 markers for A
    // still present when B's guide rendered, gone by +1.5 s). Each marker
    // links to /watch?v=<its video>, so keep only the current video's.
    var curVid = '';
    try {
      // URL first: it changes before ytd-watch-flexy's video-id does. The
      // attribute covers channel /live URLs, which carry no v=.
      var flexy = d.querySelector('ytd-watch-flexy[video-id]');
      curVid = (d.location ? new URLSearchParams(d.location.search).get('v') : '') ||
        (flexy && flexy.getAttribute('video-id')) || '';
    } catch (e) { curVid = ''; }
    var out = [];
    for (var i = 0; i < markers.length; i++) {
      if (curVid) {
        var link = markers[i].querySelector('a[href*="v="]');
        var m = link && /[?&]v=([\w-]{11})/.exec(link.getAttribute('href') || '');
        if (m && m[1] !== curVid) continue;
      }
      var timeEl = markers[i].querySelector('#time');
      var titleEl = markers[i].querySelector('#details h4, #title, #endpoint');
      var timeText = timeEl && timeEl.textContent ? timeEl.textContent.trim() : '';
      var titleText = titleEl && titleEl.textContent ? titleEl.textContent.trim() : '';
      if (timeText) {
        out.push({ label: timeText, title: titleText, el: markers[i] });
      }
    }
    return out;
  }

  /**
   * A channel's live URL — /@handle/live, /channel/UC…/live, /c/name/live,
   * /user/name/live. YouTube serves the live stream's WATCH PAGE at that URL
   * without redirecting to /watch?v= (measured 2026-09-23 on /@LofiGirl/live:
   * pathname stayed, ytd-watch-flexy[video-id] carried the id). Every check
   * written as `pathname === '/watch'` treated it as not-a-watch-page, so the
   * guide, stats and the rest never mounted on live streams opened that way.
   */
  var LIVE_CHANNEL_PATH_RE = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/;
  function isLiveChannelPath(pathname) {
    return LIVE_CHANNEL_PATH_RE.test(pathname || '');
  }

  /** The watch LAYOUT (player + side column): /watch and channel live URLs. Not Shorts. */
  function isWatchLayout(pathname) {
    pathname = pathname || (typeof location !== 'undefined' ? location.pathname : '');
    return pathname === '/watch' || isLiveChannelPath(pathname);
  }

  function isWatchPage(pathname) {
    pathname = pathname || (typeof location !== 'undefined' ? location.pathname : '');
    return isWatchLayout(pathname) || pathname.indexOf('/shorts/') === 0;
  }

  /**
   * The video id on a channel live URL, where it is not in the address. Read
   * from the watch element's own attribute, which YouTube updates on SPA
   * navigation (the canonical <link> can lag). '' when not available.
   */
  function liveChannelVideoId(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof location === 'undefined' || !isLiveChannelPath(location.pathname)) return '';
    var f = doc.querySelector(WATCH_FLEXY_SEL);
    var id = f && f.getAttribute ? f.getAttribute('video-id') : '';
    return id && /^[\w-]{11}$/.test(id) ? id : '';
  }

  function isLibraryPage(pathname) {
    pathname = pathname || (typeof location !== 'undefined' ? location.pathname : '');
    return pathname === '/feed/playlists';
  }

  // Every surface that shows the user's OWN saved/watched content, as opposed
  // to a recommendation feed: watch history, the playlists index, an open
  // playlist, Watch Later, liked videos, downloads, purchases, clips, courses.
  // Deliberately separate from (and broader than) isLibraryPage() above, which
  // is the narrow "/feed/playlists index" check other callers already depend
  // on — widening that one would silently change their behavior.
  //
  // These pages must not inherit recommendation-feed filtering: the user
  // navigated here to see specific content, and hiding watched items empties
  // the very page they opened. Backs the 'library' surface in pageSurface().
  var LIBRARY_PREFIXES = [
    '/playlist',
    '/feed/history',
    '/feed/playlists',
    '/feed/library',
    '/feed/downloads',
    '/feed/purchases',
    '/feed/clips',
    '/feed/courses'
  ];
  function isLibrarySurface(pathname) {
    pathname = pathname || (typeof location !== 'undefined' ? location.pathname : '');
    for (var i = 0; i < LIBRARY_PREFIXES.length; i++) {
      if (pathname.indexOf(LIBRARY_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function pageSurface(pathname, host) {
    pathname = pathname || (typeof location !== 'undefined' ? location.pathname : '');
    host = host || (typeof location !== 'undefined' ? location.host : '');
    if (isMusicHost(host)) return 'music';
    if (pathname === '/' || pathname.indexOf('/feed/recommended') === 0) return 'home';
    if (pathname.indexOf('/feed/subscriptions') === 0) return 'subscriptions';
    if (pathname.indexOf('/results') === 0) return 'search';
    if (pathname.indexOf('/shorts') === 0) return 'shorts';
    if (pathname.indexOf('/watch') === 0) return 'related';
    if (
      pathname.indexOf('/@') === 0 ||
      pathname.indexOf('/channel/') === 0 ||
      pathname.indexOf('/c/') === 0 ||
      pathname.indexOf('/user/') === 0
    ) {
      return 'channel';
    }
    if (pathname.indexOf('/feed/trending') === 0 || pathname.indexOf('/feed/explore') === 0) return 'home';
    if (pathname.indexOf('/hashtag/') === 0) return 'home';
    // The user's own library (history, playlists, Watch Later, …) is NOT a
    // recommendation feed — see isLibrarySurface(). Reported live: "when i go
    // and view playlists or my history my homepage setting shouldnt effect
    // what i am seeing there." These used to fall through to the 'home'
    // catch-all below, which is exactly why homepage rules leaked in.
    if (isLibrarySurface(pathname)) return 'library';
    return 'home';
  }

  function surfaceForTile(tile, fallback) {
    if (tile.closest && tile.closest('#related, ytd-watch-next-secondary-results-renderer')) return 'related';
    var tag = tile.tagName ? tile.tagName.toLowerCase() : '';
    if (
      tag === 'ytd-reel-item-renderer' ||
      (tile.closest && tile.closest('ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts]'))
    ) {
      return 'shorts';
    }
    return fallback;
  }

  /** Root for watch-page secondary / related tiles (keeps feed walks off the player tree). */
  function watchRelatedRoot() {
    if (typeof document === 'undefined') return null;
    return (
      document.querySelector('#related') ||
      document.querySelector('ytd-watch-next-secondary-results-renderer') ||
      document.querySelector('ytd-watch-flexy #secondary') ||
      document.querySelector('ytd-watch-flexy #secondary-inner')
    );
  }

  // Badges YouTube stacks on a tile — "Members only", "New", "4K", "CC" and so
  // on. Discovered live rather than guessed: "Members only" renders inside
  // .ytBadgeShapeCommerce (the paid-content shape) and as a metadata badge,
  // while the DURATION uses .ytBadgeShapeThumbnailDefault, so the two must not
  // be matched by one loose [class*="badge"] selector.
  var TILE_BADGE_SEL =
    '.ytContentMetadataViewModelBadge, .ytBadgeShapeCommerce, ' +
    'ytd-badge-supported-renderer .badge, .badge-style-type-members-only';

  /** Badge labels on a tile, lowercased and de-duplicated. */
  function tileBadgeTexts(tile) {
    if (!tile || !tile.querySelectorAll) return [];
    var seen = Object.create(null);
    var out = [];
    tile.querySelectorAll(TILE_BADGE_SEL).forEach(function (el) {
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t || t.length > 40 || seen[t]) return;
      seen[t] = true;
      out.push(t);
    });
    return out;
  }

  /**
   * Membership-gated badge labels.
   *
   * Two distinct things, both gated behind paying a channel:
   *   "Members only"  — you cannot watch it unless you are a member.
   *   "Members first" — early access; it goes public later, but not yet.
   * Both are useless in a feed you cannot play from, so both count.
   *
   * ANCHORED, not a substring search, and this matters: a text scan for
   * "members first" across live YouTube returns "Members 1st Federal Credit
   * Union", "Member First Credit Union", "MembershipFirst", channel names,
   * and the video title "How To Watch Members Only Videos On YouTube" — none
   * of which are membership badges. Requiring the label to BE the phrase
   * (optionally with a trailing marker) rather than merely contain it is what
   * keeps a credit union out of the filter. Kept alongside the badge-container
   * scoping in tileBadgeTexts, so both the element and its text must qualify.
   */
  // Anchored at BOTH ends. `\b` at the tail was not enough — it still matched
  // "Member First Credit Union" and "Members first early access - YouTube",
  // both of which are real strings live YouTube returns. A genuine badge is the
  // phrase and nothing else, so requiring that is what separates a paywall from
  // a bank.
  var MEMBER_BADGE_RE = /^members?[\s-]*(only|first)$/;

  function tileIsMembersOnly(tile) {
    return tileBadgeTexts(tile).some(function (t) {
      return MEMBER_BADGE_RE.test(t);
    });
  }

  // YouTube's own sticky filter-chip row ("All / Podcasts / Gaming / Live …").
  // It lives INSIDE the grid renderer and is itself sticky, so anything of ours
  // inserted above the grid lands earlier in DOM order and gets painted over —
  // which is why live-now.js anchors to this rather than to the grid.
  var FEED_CHIP_BAR_SEL =
    'ytd-feed-filter-chip-bar-renderer, #chips-wrapper, yt-chip-cloud-renderer';

  /** YouTube's feed filter-chip bar, or null on feeds that have none. */
  function feedChipBar() {
    if (typeof document === 'undefined') return null;
    return document.querySelector(FEED_CHIP_BAR_SEL);
  }

  // The channel a CHANNEL PAGE belongs to. A channel grid does not repeat the
  // uploader on each tile — it is implicit from the page — so tileChannel()
  // returns empty there and scraped rows had no creator at all.
  var PAGE_CHANNEL_NAME_SEL =
    'ytd-channel-name #text, yt-dynamic-text-view-model .yt-core-attributed-string, ' +
    '#channel-header h1, #page-header h1';

  /** Channel identity for the current page, or null when it is not a channel. */
  function pageChannel() {
    if (typeof document === 'undefined' || typeof location === 'undefined') return null;
    var p = location.pathname || '';
    var isChannel =
      p.indexOf('/@') === 0 || p.indexOf('/channel/') === 0 || p.indexOf('/c/') === 0 || p.indexOf('/user/') === 0;
    if (!isChannel) return null;
    var el = document.querySelector(PAGE_CHANNEL_NAME_SEL);
    var name = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    var key = channelKeyFromHref(p);
    if (!name && !key) return null;
    return { name: name, key: key || '' };
  }

  // The channel page's own header block — the area holding the name, handle and
  // subscriber count. Centralised for the same reason as everything else here:
  // YouTube has shipped four generations of this markup and a rename would
  // otherwise break silently, rendering nothing rather than erroring.
  var CHANNEL_HEADER_INFO_SEL =
    // Current (measured live 2026-09-14): the block holding name, handle and
    // video count. YouTube moved these from kebab-case wiz__ names to camelCase
    // view-model classes, so the old selectors matched nothing and the caller
    // silently rendered nothing rather than erroring.
    '.ytPageHeaderViewModelHeadlineInfo, ' +
    // Previous generations, kept because a stale selector costs nothing and
    // YouTube has reverted markup before.
    'yt-page-header-renderer .page-header-view-model-wiz__page-header-headline-info, ' +
    '#channel-header-container, ' +
    'ytd-channel-tagline-renderer';

  /** The channel header's info block, or null before it renders. */
  function channelHeaderInfo() {
    if (typeof document === 'undefined') return null;
    return document.querySelector(CHANNEL_HEADER_INFO_SEL);
  }

  // Comment threads on a watch page. Centralised for the same reason as every
  // other renderer name here: fact-check.js reads them to fact-check a single
  // comment, and the summarizer samples them for audience sentiment, so a
  // rename would silently break both.
  var COMMENTS_ROOT_SEL = 'ytd-comments #contents, ytd-comments';
  var COMMENT_THREAD_SEL = 'ytd-comment-thread-renderer';
  var COMMENT_TEXT_SEL = '#content-text, yt-formatted-string#content-text';

  /** The container holding rendered comment threads, or null before they load. */
  function commentsRoot() {
    if (typeof document === 'undefined') return null;
    return document.querySelector(COMMENTS_ROOT_SEL);
  }

  // The watch page's title block — the heading element, not the text node. Used
  // as an anchor by anything that wants to sit on the title line rather than
  // down in the description. Centralised here so a YouTube rename shows up in
  // one place, like every other renderer name in this file.
  var WATCH_TITLE_SEL = 'ytd-watch-metadata #title, ytd-watch-metadata h1';

  /** The watch-page title block, or null when not on a rendered watch page. */
  function watchTitleRoot() {
    if (typeof document === 'undefined') return null;
    return document.querySelector(WATCH_TITLE_SEL);
  }

  /**
   * The watch page's channel NAME. Not querySelector(WATCH_CHANNEL_LINK_SEL).
   *
   * A selector list returns the first match in DOCUMENT order, and
   * `ytd-video-owner-renderer a` matches the avatar link, which precedes the
   * name and has no text. Measured 2026-09-22 on 3 of 3 videos: first match
   * href "/@3blue1brown", text "". Every module reading .textContent off that
   * got "" — the watch-page Block channel button disabled itself (opacity
   * 0.35, dead on every video), AI and fact-check prompts lost the channel,
   * and watch history saved name: null.
   *
   * Callers that want the channel KEY keep reading the first match's href:
   * the avatar and the name link can disagree ("/@LuisFonsiVEVO" vs
   * "/channel/UC…"), and changing which one feeds a stored key would split a
   * channel's history across two keys.
   */
  function watchChannelName(root) {
    var doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc) return '';
    var all = doc.querySelectorAll(WATCH_CHANNEL_LINK_SEL);
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      if (t) return t;
    }
    return '';
  }

  /** Breadth-first query that pierces open shadow roots (YouTube player chrome). */
  function deepQuery(root, selector) {
    if (!root || !selector) return null;
    try {
      if (root.querySelector) {
        var direct = root.querySelector(selector);
        if (direct) return direct;
      }
    } catch (e) {
      /* ignore */
    }
    var queue = [];
    if (root.shadowRoot) queue.push(root.shadowRoot);
    if (root.children) {
      for (var i = 0; i < root.children.length; i++) queue.push(root.children[i]);
    }
    while (queue.length) {
      var node = queue.shift();
      if (!node || node.nodeType !== 1) continue;
      try {
        if (node.matches && node.matches(selector)) return node;
        if (node.querySelector) {
          var inner = node.querySelector(selector);
          if (inner) return inner;
        }
      } catch (e2) {
        /* ignore */
      }
      if (node.shadowRoot) queue.push(node.shadowRoot);
      if (node.children) {
        for (var j = 0; j < node.children.length; j++) queue.push(node.children[j]);
      }
    }
    return null;
  }

  // --- Guide (sidebar) -----------------------------------------------------
  var GUIDE_ENTRY_SEL = 'ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer';
  var MINI_GUIDE_SEL = 'ytd-mini-guide-renderer';
  var GUIDE_ENTRY_PRIMARY = 'ytd-guide-entry-renderer';
  var GUIDE_ENTRY_CHANNEL_LINK_SEL =
    'ytd-guide-entry-renderer a[href*="/@"], ytd-guide-entry-renderer a[href*="/channel/"], ytd-guide-entry-renderer a[href*="/c/"]';
  var GUIDE_ENTRY_ALL_LINKS_SEL =
    'ytd-guide-entry-renderer a[href], ytd-mini-guide-entry-renderer a[href], ytd-guide-collapsible-entry-entry-renderer a[href]';
  var GUIDE_SECTION_SEL = 'ytd-guide-section-renderer';
  var GUIDE_SECTIONS_HOST_SEL =
    'ytd-guide-renderer #sections, ytd-guide-renderer #items, tp-yt-app-drawer #sections, ' +
    'ytd-app #guide-content #sections, ytd-app #guide-wrapper #sections, #guide #sections';
  var GUIDE_DRAWER_SEL = 'tp-yt-app-drawer#guide, ytd-app tp-yt-app-drawer, #guide';
  var GUIDE_WATCH_TARGET_SEL = 'ytd-guide-renderer, tp-yt-app-drawer, ytd-app #guide-wrapper';
  var GUIDE_TOGGLE_BTN_SEL =
    '#guide-button, ytd-guide-button-renderer button, button[aria-label*="Guide"], button[aria-label*="guide"]';
  var GUIDE_BADGE_SEL =
    'ytd-badge-supported-renderer, yt-badge-shape, paper-badge#badge, #guide-badge, .badge-style';

  function guideEntryLinkByHref(href) {
    return GUIDE_ENTRY_PRIMARY + ' a[href="' + href + '"]';
  }

  // --- Playlist bulk -------------------------------------------------------
  var PLAYLIST_ROW_SEL = 'yt-lockup-view-model, ytd-playlist-video-renderer';
  var PLAYLIST_PANEL_SEL = 'ytd-playlist-panel-renderer';
  var PLAYLIST_PANEL_VIDEO_SEL = 'ytd-playlist-panel-video-renderer';
  var PLAYLIST_ADD_TO_SEL = 'ytd-add-to-playlist-renderer';
  var PLAYLIST_OPTION_SEL = 'ytd-playlist-add-to-option-renderer';
  var PLAYLIST_ROW_CONTAINER_SEL = 'ytd-item-section-renderer, #contents, .ytd-section-list-renderer';
  var PLAYLIST_THUMB_SEL =
    'ytd-playlist-video-thumbnail-renderer, ytd-thumbnail, a#thumbnail, ' +
    '.yt-lockup-view-model-wiz__content-image, .yt-thumbnail-view-model, ' +
    'yt-thumbnail-view-model, .ytThumbnailViewModelHost, #thumbnail';
  var PLAYLIST_ROW_TITLE_SEL =
    'h3, .yt-lockup-metadata-view-model-wiz__title, #video-title, a[href*="/watch"]';
  var PLAYLIST_ROW_CHANNEL_SEL =
    '#text.ytd-channel-name, .yt-lockup-metadata-view-model-wiz__metadata, #channel-name yt-formatted-string';

  var AD_TILE_SEL =
    'ad-button-view-model, ad-button-group-view-model, ytd-ad-slot-renderer, ' +
    'ytd-promoted-video-renderer, ytd-display-ad-renderer, ytd-in-feed-ad-layout-renderer, ' +
    'ytd-player-legacy-desktop-watch-ads-renderer, ytm-companion-ad-renderer';

  /**
   * Whether a feed tile is (or wraps) an ad. Ads are not videos you watch, so
   * the watched filter must neither mark nor dim them (2026-09-23: a sponsored
   * search result got the watched eye over its own Watch button).
   */
  function tileIsAdRaw(tile) {
    if (!tile || !tile.matches) return false;
    try {
      return tile.matches(AD_TILE_SEL) || !!tile.querySelector(AD_TILE_SEL) ||
        !!(tile.closest && tile.closest('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer'));
    } catch (e) {
      return false;
    }
  }

  /**
   * Whether a feed tile is a playlist, course or mix rather than one video.
   * Its link points at the collection's FIRST video, so the watched filter
   * used to mark the whole collection "watched" (and dim or hide it) whenever
   * that one video was: measured 2026-09-23 on search ("10 lessons") and on a
   * channel's Playlists tab, where every collection carried the eye. They all
   * wear YouTube's stacked collection thumbnail.
   */
  var COLLECTION_TILE_SEL =
    'yt-collection-thumbnail-view-model, .ytCollectionThumbnailViewModelHost, ytd-playlist-thumbnail';
  function tileIsCollectionRaw(tile) {
    if (!tile || !tile.matches) return false;
    try {
      return tile.matches('ytd-radio-renderer, ytd-playlist-renderer, ytd-grid-playlist-renderer') ||
        !!tile.querySelector(COLLECTION_TILE_SEL);
    } catch (e) {
      return false;
    }
  }

  // --- Watch page ----------------------------------------------------------
  var WATCH_METADATA_SEL = 'ytd-watch-metadata';
  var WATCH_TITLE_HEADING_SEL =
    'h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string.ytd-watch-metadata, ' +
    'h1.ytd-shorts yt-formatted-string, ytd-reel-player-header-renderer yt-formatted-string, ' +
    'h1.ytd-watch-metadata, h1.title yt-formatted-string, #title h1';
  var WATCH_CHANNEL_LINK_SEL =
    '#owner #channel-name a, ytd-channel-name a, ytd-video-owner-renderer a, ytd-reel-player-header-renderer a, ' +
    'ytd-channel-name#channel-name a, #upload-info #channel-name a, ytd-video-owner-renderer a[href*="/@"], ' +
    'ytd-video-owner-renderer a[href*="/channel/"], ytd-reel-player-header-renderer a[href*="/@"], ' +
    'ytd-reel-player-header-renderer a[href*="/channel/"]';
  var WATCH_OWNER_RENDERER_SEL = 'ytd-video-owner-renderer';
  /* The row ABOVE the channel row. Mounting before ytd-video-owner-renderer
     lands the stats panel inside #owner -> #top-row, which are the elements
     that constrain its width on some layouts; mounting before #top-row itself
     puts it in #above-the-fold, which is the full content column. */
  var WATCH_TOP_ROW_SEL = '#above-the-fold #top-row, ytd-watch-metadata #top-row';
  /* The related column beside the player, and the column the player lives in.
     The guide mounts at the top of the side column when the page is laid out
     in two columns (2026-09-22: "a side thing so people don't need to scroll").
     Two-column is decided by GEOMETRY in watch-deck.js, not by an attribute:
     YouTube's layout attributes have drifted before, and a stale attribute
     would put the guide under the comments in the one-column layout. */
  // SCOPED TO ytd-watch-flexy (2026-09-24). YouTube keeps the previous page's
  // layout in the DOM: after search or home, the FIRST #primary in the document
  // is the hidden results column at 0px wide. The guide measured that one,
  // decided there was no side column, and mounted under the player (user report:
  // "why is it under the player again?"; measured search -> watch: primaries
  // [search 0px, watch 1817px]).
  var WATCH_SIDE_COLUMN_SEL = 'ytd-watch-flexy #secondary #secondary-inner';
  var WATCH_PRIMARY_COLUMN_SEL = 'ytd-watch-flexy #primary';
  var WATCH_SIDE_OUTER_SEL = 'ytd-watch-flexy #secondary';
  /* Theater's player row (a flexbox): the guide column is a sibling here.
     And what YouTube itself puts at the top of the side column, which the
     guide yields to by going compact: the playlist queue and live chat. */
  var WATCH_THEATER_ROW_SEL = 'ytd-watch-flexy #full-bleed-container, #full-bleed-container';
  var WATCH_PLAYLIST_PANEL_SEL = 'ytd-watch-flexy #secondary ytd-playlist-panel-renderer#playlist';
  var WATCH_LIVE_CHAT_SEL = 'ytd-watch-flexy #secondary ytd-live-chat-frame#chat, ytd-watch-flexy #secondary #chat-container #chat';
  var WATCH_REEL_HEADER_SEL = 'ytd-reel-player-header-renderer';
  var WATCH_EXPANDABLE_DESC_SEL = 'ytd-expandable-video-description-body-renderer';
  var WATCH_ACTIONS_SEL = 'ytd-watch-metadata #actions';
  var WATCH_TITLE_STRING_SEL = 'ytd-watch-metadata h1 yt-formatted-string';
  var WATCH_LIKE_ACTION_ROW_SEL =
    '#actions-inner #menu #top-level-buttons-computed, ytd-watch-metadata #menu #top-level-buttons-computed, ' +
    '#above-the-fold #menu #top-level-buttons-computed, ytd-menu-renderer #top-level-buttons-computed, ' +
    '#top-level-buttons-computed, ytd-reel-player-overlay-renderer #actions #top-level-buttons-computed, ' +
    'ytd-reel-player-overlay-renderer #actions';
  var WATCH_STATS_ANCHOR_SEL =
    'ytd-watch-metadata #actions, #actions, #above-the-fold #actions, ytd-reel-player-overlay-renderer #actions';
  var TILE_META_HOST_SEL =
    '#metadata-line, ytd-video-meta-block #metadata-line, yt-content-metadata-view-model, ' +
    '.ytLockupMetadataViewModelMetadata, .yt-content-metadata-view-model-wiz__metadata-row, ' +
    '.yt-lockup-metadata-view-model-wiz__metadata, div#metadata-line, #byline-container';
  var REEL_TILE_TAG = 'ytd-reel-item-renderer';
  var RICH_GRID_RENDERER_SEL = 'ytd-rich-grid-renderer';
  var WATCH_AI_TRANSCRIPT_SEL = 'ytd-video-description-transcript-section-renderer';
  var WATCH_AI_SUMMARY_SEL =
    'ytd-expandable-metadata-renderer, #expandable-metadata, ytd-structured-description-content-renderer ytd-info-row-renderer, ' +
    WATCH_AI_TRANSCRIPT_SEL + ', #description-inline-expander, ' +
    'ytd-structured-description-content-renderer, ytd-video-description-infocards-section-renderer, ' +
    '[class*="generative-summary"], [class*="GenerativeSummary"]';
  var WATCH_DISCLOSURE_HOST_SEL =
    '#description, ytd-watch-metadata, #info-container, ytd-expandable-video-description-body-renderer, ' +
    '#above-the-fold, ytd-badge-supported-renderer, [class*="altered-content"], [class*="AlteredContent"]';
  var RELATED_RAIL_SEL = '#related, ytd-watch-next-secondary-results-renderer, ytd-watch-flexy #secondary';
  var YTD_PLAYER_SEL = 'ytd-player';

  // --- Player engagement (likes / dislikes) -------------------------------
  var SEGMENTED_LIKE_SEL = 'ytd-segmented-like-dislike-button-renderer';
  var TOGGLE_LIKE_BTN_SEL = 'ytd-toggle-button-renderer button[aria-label*="like" i]';
  var TOGGLE_DISLIKE_BTN_SEL = 'ytd-toggle-button-renderer button[aria-label*="dislike" i]';
  var REEL_OVERLAY_ACTIONS_SEL =
    'ytd-watch-metadata #menu #top-level-buttons-computed, #actions #top-level-buttons-computed, ' +
    'ytd-menu-renderer #top-level-buttons-computed, ytd-reel-player-overlay-renderer #actions #top-level-buttons-computed, ' +
    'ytd-reel-player-overlay-renderer #actions';

  // --- Thumbnails / live overlays ------------------------------------------
  var TILE_THUMB_SEL =
    'ytd-thumbnail, a#thumbnail, ytd-playlist-thumbnail, yt-thumbnail-view-model, .ytThumbnailViewModelHost, ' +
    '.yt-lockup-view-model-wiz__content-image, .ytLockupViewModelHostContentImage, ytm-thumbnail-cover, #thumbnail, a[href*="/watch"]';
  var TILE_THUMB_BADGE_HOST_SEL = 'ytd-thumbnail, a#thumbnail, yt-thumbnail-view-model, img';
  var TILE_LIVE_OVERLAY_SEL =
    'ytd-thumbnail-overlay-time-status-renderer, span.ytd-thumbnail-overlay-time-status-renderer, badge-shape, .badge-shape-wiz__text, #time-status';
  var TILE_CHANNEL_LINK_COMPACT_SEL = 'ytd-channel-name a[href], #channel-name a[href]';
  var LIVE_FEED_TILE_SUBSET_SEL =
    'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model';

  // --- Subscriptions / channel page ----------------------------------------
  var SUB_FEED_CONTAINER_SEL =
    'ytd-section-list-renderer, ytd-rich-grid-renderer, #primary #contents, ytd-browse[page-subtype="subscriptions"] #contents';
  var SUB_GRID_ITEM_SEL = 'ytd-rich-grid-renderer ytd-rich-item-renderer';
  var SUB_RICH_ITEM_SEL = 'ytd-rich-item-renderer, ytd-video-renderer';
  var CONTINUATION_SEL = 'ytd-continuation-item-renderer';
  var CHANNEL_PAGE_HEADER_SEL =
    '.ytPageHeaderViewModelHeadline h1, ytd-channel-name#channel-name #text, #channel-header #text, yt-formatted-string.ytd-channel-name';
  // The channel header (yt-page-header-view-model) renders Subscribe as the
  // first action of yt-flexible-actions-view-model, a plain button-view-model
  // with no subscribe-specific element (measured 2026-10-01 on @Fireship and
  // @Fireship/videos). None of the older names matched it, so +Group and Block
  // channel never appeared on channel pages.
  var SUBSCRIBE_BUTTON_SEL = 'yt-page-header-view-model yt-flexible-actions-view-model .ytFlexibleActionsViewModelAction:first-child, ' +
    'yt-subscribe-button-view-model, #subscribe-button, ytd-subscribe-button-renderer';

  // DeArrow title query — extends TITLE_SEL with per-renderer scoping.
  var DEARROW_TITLE_SEL =
    TITLE_SEL + ', ytd-watch-metadata h1 yt-formatted-string, .ytd-compact-video-renderer #video-title, ' +
    '.ytd-grid-video-renderer #video-title, .ytd-rich-grid-media #video-title, ' +
    'ytd-reel-item-renderer #video-title, ytd-playlist-video-renderer #video-title, .ytLockupMetadataViewModelTitle';

  var TILE_META_ROW_SEL = '.yt-content-metadata-view-model-wiz__metadata-row';

  // --- Transcript panel (ai-bridge MAIN world, ai-assistant, fact-check) ----
  var TRANSCRIPT_SEGMENT_SEL = 'ytd-transcript-segment-renderer';
  var TRANSCRIPT_SEGMENT_TEXT_SEL = '.segment-text, yt-formatted-string.segment-text';
  var TRANSCRIPT_SEGMENT_TIMESTAMP_SEL = '.segment-timestamp';
  var TRANSCRIPT_PANEL_SEL = 'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]';
  var TRANSCRIPT_ENGAGEMENT_PANEL_SEL = 'ytd-engagement-panel-section-list-renderer';
  var TRANSCRIPT_RENDERER_SEL = 'ytd-transcript-renderer, ytd-transcript-search-panel-renderer';
  var TRANSCRIPT_SEGMENT_FALLBACK_SEL = 'ytd-transcript-segment-renderer, [class*="transcript-segment"]';
  var TRANSCRIPT_DESC_BUTTON_SEL =
    'ytd-video-description-transcript-section-renderer button, ytd-video-description-transcript-section-renderer ytd-button-renderer';
  var TRANSCRIPT_TOGGLE_BUTTON_SEL = 'ytd-button-renderer button, button[aria-label], tp-yt-paper-button';
  var TRANSCRIPT_PANEL_HEADER_BTN_SEL =
    '#visibility-button button, #visibility-button, ytd-engagement-panel-title-header-renderer button[aria-label]';
  var TRANSCRIPT_BUTTON_RENDERER_SEL = 'ytd-button-renderer, yt-button-shape';
  var YTD_APP_SEL = 'ytd-app';
  var MENU_SERVICE_ITEM_SEL = 'ytd-menu-service-item-renderer, yt-list-item-view-model';
  var PLAYLIST_PANEL_BOTH_SEL = PLAYLIST_PANEL_SEL + ', ' + PLAYLIST_PANEL_VIDEO_SEL;

  // --- History page (watch-history harvest) --------------------------------
  var HISTORY_SECTION_SEL = 'ytd-item-section-renderer';
  var HISTORY_SECTION_TITLE_SEL = '#title, #header #title, .ytd-item-section-renderer #title';
  var VIDEO_META_BLOCK_SEL = 'ytd-video-meta-block';

  // --- Playlist library / folder manager -----------------------------------
  var PLAYLIST_INDEX_TILE_SEL =
    'ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-rich-item-renderer, yt-lockup-view-model';
  var PLAYLIST_PAGE_HEADER_H1_SEL = 'yt-page-header-view-model h1';

  // The metadata block under a playlist page's title — where YouTube already
  // prints "N videos" and the view count, and therefore where a line about this
  // playlist belongs. Falls back across generations; null just means not yet
  // rendered, and the caller retries on its next scan.
  var PLAYLIST_PAGE_META_SEL =
    'yt-page-header-view-model .ytPageHeaderViewModelHeadlineInfo, ' +
    'yt-page-header-view-model .page-header-view-model-wiz__page-header-headline-info, ' +
    'ytd-playlist-sidebar-primary-info-renderer #stats';

  /** The playlist page's metadata block, or null before it renders. */
  function playlistPageMeta() {
    if (typeof document === 'undefined') return null;
    // Return a VISIBLE block, not merely the first match. Measured live
    // 2026-09-15: a playlist page carries six headline-info blocks, and most are
    // hidden template instances at a zero rect. Mounting into one of those gives
    // an element that passes every existence assertion and that nobody can see —
    // a failure this codebase has already shipped once.
    var nodes = document.querySelectorAll(PLAYLIST_PAGE_META_SEL);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetParent !== null) return nodes[i];
    }
    return null;
  }
  var PLAYLIST_HEADER_TITLE_SEL = 'ytd-playlist-header-renderer #title, h1.ytd-playlist-header-renderer';
  var PLAYLIST_TILE_TITLE_SEL =
    '#video-title, yt-formatted-string#video-title, .ytd-playlist-thumbnail #text, #title, h3';
  var PLAYLIST_SECTION_CONTENTS_SEL = 'ytd-section-list-renderer #contents';
  var PLAYLIST_BROWSE_RESULTS_SEL = 'ytd-browse ytd-two-column-browse-results-renderer';
  var PLAYLIST_SECTION_CONTENTS_CLASS_SEL = '#contents.ytd-section-list-renderer';
  var PLAYLIST_HEADER_ACTIONS_SEL = 'yt-page-header-view-model yt-flexible-actions-view-model';
  var PLAYLIST_HEADER_MENU_CONTAINER_SEL = 'ytd-playlist-header-renderer #menu-container';
  var PLAYLIST_HEADER_MENU_SEL = 'ytd-playlist-header-renderer ytd-menu-renderer';
  var YTD_MENU_RENDERER_SEL = 'ytd-menu-renderer';

  // --- Live shelf (live-now.js) --------------------------------------------
  var LIVE_MARK_SEL =
    LIVE_BADGE_SEL + ', ytd-thumbnail[is-live-video], [is-live-video]';
  var LIVE_SHELF_ANCHOR_SEL =
    'ytd-rich-grid-renderer, ytd-section-list-renderer, ytd-two-column-browse-results-renderer #contents, ' +
    'ytd-browse[role="main"] #contents';

  // --- Watch description / comments (fact-check, ai-assistant) -------------
  var WATCH_DESC_EXPAND_SEL =
    'tp-yt-paper-button#expand, #description #expand, ytd-text-inline-expander #expand, #description-inline-expander #expand';
  // YouTube keeps BOTH controls in the DOM and swaps which one is visible, so
  // presence is not state — offsetParent is. Verified live on a watch page:
  // collapsed => #expand visible ("...more"), #collapse hidden; expanded =>
  // the reverse, and ytd-text-inline-expander carries is-expanded.
  var WATCH_DESC_COLLAPSE_SEL =
    'tp-yt-paper-button#collapse, #description #collapse, ytd-text-inline-expander #collapse, #description-inline-expander #collapse';
  var WATCH_DESC_EXPANDER_SEL = 'ytd-text-inline-expander, #description-inline-expander';
  var WATCH_DESC_TEXT_SEL =
    '#description-inline-expander yt-formatted-string, #description yt-formatted-string, ytd-reel-player-overlay-renderer #description';
  var COMMENT_CONTENT_FALLBACK_SEL =
    '#content-text, yt-formatted-string#content-text, .ytd-comment-renderer #content-text';
  var REEL_OVERLAY_SEL = 'ytd-reel-player-overlay-renderer';
  var COMMENTS_HOST_FALLBACK_SEL = '#comments, ytd-comments';
  var COMMENT_ANY_THREAD_SEL = 'ytd-comment-thread-renderer, ytd-comment-renderer';
  var COMMENT_TOOLBAR_SEL = '#toolbar, ytd-comment-action-buttons-renderer, #action-buttons';

  // --- UI tune (masthead / guide) ------------------------------------------
  var TOPBAR_LOGO_SEL = 'ytd-topbar-logo-renderer a#logo-icon, a#logo, ytd-logo a';
  var CONFIRM_DIALOG_SEL = 'yt-confirm-dialog-renderer, ytd-enforcement-message-view-model';
  var WATCH_FLEXY_SEL = 'ytd-watch-flexy';
  var GUIDE_TAB_ENTRY_SEL = 'yt-tab-shape, ytd-guide-entry-renderer, tp-yt-paper-tab';
  var GUIDE_SHORTS_LINK_SEL =
    'ytd-guide-entry-renderer a[href="/shorts"], ytd-guide-entry-renderer a[href^="/shorts/"], ' +
    'ytd-mini-guide-entry-renderer a[href="/shorts"], ytd-mini-guide-entry-renderer a[href^="/shorts/"]';

  // --- Related sidebar scrape (video-stats-cache) --------------------------
  var RELATED_COMPACT_TILE_SEL =
    '#secondary ytd-compact-video-renderer, ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer, #related ytd-compact-video-renderer';
  var RELATED_LOCKUP_TILE_SEL =
    '#secondary yt-lockup-view-model, ytd-watch-next-secondary-results-renderer yt-lockup-view-model, #related yt-lockup-view-model';
  var RELATED_TILES_SEL = RELATED_COMPACT_TILE_SEL + ', ' + RELATED_LOCKUP_TILE_SEL;
  var RELATED_TILE_LINK_SEL =
    'a#video-title[href*="/watch"], a.ytd-compact-video-renderer[href*="/watch"], a[href*="/watch"]';
  var RELATED_TILE_CHANNEL_SEL =
    '#channel-name, .ytd-channel-name, yt-formatted-string.ytd-channel-name, ' +
    '.yt-content-metadata-view-model-wiz__metadata-text, .yt-content-metadata-view-model__metadata-text';

  /** YouTube player right-controls host — used for download/screenshot/popout buttons. */
  function playerControlsHost() {
    if (typeof document === 'undefined') return null;
    var host =
      document.querySelector('#movie_player .ytp-right-controls') ||
      document.querySelector('.html5-video-player .ytp-right-controls') ||
      document.querySelector('.ytp-right-controls');
    if (host) return host;
    var roots = [
      document.getElementById('movie_player'),
      document.querySelector('ytd-player'),
      document.querySelector('#player'),
      document.querySelector('ytd-watch-flexy')
    ];
    for (var r = 0; r < roots.length; r++) {
      host = deepQuery(roots[r], '.ytp-right-controls');
      if (host) return host;
    }
    return null;
  }

  return {
    FEED_TILES: FEED_TILES,
    CHANNEL_LINK_SEL: CHANNEL_LINK_SEL,
    TITLE_SEL: TITLE_SEL,
    CHANNEL_SEL: CHANNEL_SEL,
    CHANNEL_KEY_LINK_SEL: CHANNEL_KEY_LINK_SEL,
    feedTileSelector: feedTileSelector,
    isNestedFeedTile: isNestedFeedTile,
    outermostFeedTile: outermostFeedTile,
    forEachFeedTile: forEachFeedTile,
    beginScan: beginScan,
    endScan: endScan,
    scanMemo: memoTile,
    tileChannelKey: tileChannelKey,
    tileTitle: tileTitle,
    tileChannel: tileChannel,
    tileVideoId: tileVideoId,
    tileThumb: tileThumb,
    tileNativeProgress: tileNativeProgress,
    SEARCH_TILES: SEARCH_TILES,
    SEARCH_RESULTS_HOST: SEARCH_RESULTS_HOST,
    TILE_TITLE_TEXT_SEL: TILE_TITLE_TEXT_SEL,
    TILE_CHANNEL_TEXT_SEL: TILE_CHANNEL_TEXT_SEL,
    tileMetaTexts: tileMetaTexts,
    viewsText: viewsText,
    isAgeText: isAgeText,
    tileDurationText: tileDurationText,
    tileDescription: tileDescription,
    tileIsLive: tileIsLive,
    channelKeyFromHref: channelKeyFromHref,
    normalizeListKey: normalizeListKey,
    isMusicHost: isMusicHost,
    isWatchPage: isWatchPage,
    isWatchLayout: isWatchLayout,
    isLiveChannelPath: isLiveChannelPath,
    liveChannelVideoId: liveChannelVideoId,
    adPlaying: adPlaying,
    playerVideo: playerVideo,
    playerChapterTitle: playerChapterTitle,
    playerIsLive: playerIsLive,
    PLAYER_CHAPTER_SEL: PLAYER_CHAPTER_SEL,
    NATIVE_CHAPTER_MARKERS_SEL: NATIVE_CHAPTER_MARKERS_SEL,
    nativeChapters: nativeChapters,
    AD_STATE_SELECTORS: AD_STATE_SELECTORS,
    isLibraryPage: isLibraryPage,
    isLibrarySurface: isLibrarySurface,
    pageSurface: pageSurface,
    surfaceForTile: surfaceForTile,
    watchRelatedRoot: watchRelatedRoot,
    watchTitleRoot: watchTitleRoot,
    watchChannelName: watchChannelName,
    commentsRoot: commentsRoot,
    feedChipBar: feedChipBar,
    pageChannel: pageChannel,
    CHANNEL_HEADER_INFO_SEL: CHANNEL_HEADER_INFO_SEL,
    channelHeaderInfo: channelHeaderInfo,
    FEED_CHIP_BAR_SEL: FEED_CHIP_BAR_SEL,
    tileBadgeTexts: tileBadgeTexts,
    tileIsMembersOnly: tileIsMembersOnly,
    TILE_BADGE_SEL: TILE_BADGE_SEL,
    TILE_META_SEL: TILE_META_SEL,
    TILE_DURATION_SEL: TILE_DURATION_SEL,
    TILE_THUMB_SEL: TILE_THUMB_SEL,
    TILE_THUMB_BADGE_HOST_SEL: TILE_THUMB_BADGE_HOST_SEL,
    TILE_LIVE_OVERLAY_SEL: TILE_LIVE_OVERLAY_SEL,
    TILE_CHANNEL_LINK_COMPACT_SEL: TILE_CHANNEL_LINK_COMPACT_SEL,
    LIVE_FEED_TILE_SUBSET_SEL: LIVE_FEED_TILE_SUBSET_SEL,
    GUIDE_ENTRY_SEL: GUIDE_ENTRY_SEL,
    GUIDE_ENTRY_PRIMARY: GUIDE_ENTRY_PRIMARY,
    GUIDE_ENTRY_CHANNEL_LINK_SEL: GUIDE_ENTRY_CHANNEL_LINK_SEL,
    GUIDE_ENTRY_ALL_LINKS_SEL: GUIDE_ENTRY_ALL_LINKS_SEL,
    GUIDE_SECTION_SEL: GUIDE_SECTION_SEL,
    GUIDE_SECTIONS_HOST_SEL: GUIDE_SECTIONS_HOST_SEL,
    GUIDE_DRAWER_SEL: GUIDE_DRAWER_SEL,
    GUIDE_WATCH_TARGET_SEL: GUIDE_WATCH_TARGET_SEL,
    GUIDE_TOGGLE_BTN_SEL: GUIDE_TOGGLE_BTN_SEL,
    GUIDE_BADGE_SEL: GUIDE_BADGE_SEL,
    guideEntryLinkByHref: guideEntryLinkByHref,
    PLAYLIST_ROW_SEL: PLAYLIST_ROW_SEL,
    PLAYLIST_PANEL_SEL: PLAYLIST_PANEL_SEL,
    PLAYLIST_PANEL_VIDEO_SEL: PLAYLIST_PANEL_VIDEO_SEL,
    PLAYLIST_ADD_TO_SEL: PLAYLIST_ADD_TO_SEL,
    PLAYLIST_OPTION_SEL: PLAYLIST_OPTION_SEL,
    PLAYLIST_ROW_CONTAINER_SEL: PLAYLIST_ROW_CONTAINER_SEL,
    PLAYLIST_THUMB_SEL: PLAYLIST_THUMB_SEL,
    PLAYLIST_ROW_TITLE_SEL: PLAYLIST_ROW_TITLE_SEL,
    PLAYLIST_ROW_CHANNEL_SEL: PLAYLIST_ROW_CHANNEL_SEL,
    AD_TILE_SEL: AD_TILE_SEL,
    tileIsAd: tileIsAd,
    tileIsCollection: tileIsCollection,
    WATCH_METADATA_SEL: WATCH_METADATA_SEL,
    WATCH_TITLE_HEADING_SEL: WATCH_TITLE_HEADING_SEL,
    WATCH_CHANNEL_LINK_SEL: WATCH_CHANNEL_LINK_SEL,
    WATCH_OWNER_RENDERER_SEL: WATCH_OWNER_RENDERER_SEL,
    WATCH_TOP_ROW_SEL: WATCH_TOP_ROW_SEL,
    WATCH_SIDE_COLUMN_SEL: WATCH_SIDE_COLUMN_SEL,
    WATCH_PRIMARY_COLUMN_SEL: WATCH_PRIMARY_COLUMN_SEL,
    WATCH_SIDE_OUTER_SEL: WATCH_SIDE_OUTER_SEL,
    WATCH_THEATER_ROW_SEL: WATCH_THEATER_ROW_SEL,
    WATCH_PLAYLIST_PANEL_SEL: WATCH_PLAYLIST_PANEL_SEL,
    WATCH_LIVE_CHAT_SEL: WATCH_LIVE_CHAT_SEL,
    WATCH_REEL_HEADER_SEL: WATCH_REEL_HEADER_SEL,
    WATCH_EXPANDABLE_DESC_SEL: WATCH_EXPANDABLE_DESC_SEL,
    WATCH_ACTIONS_SEL: WATCH_ACTIONS_SEL,
    WATCH_TITLE_STRING_SEL: WATCH_TITLE_STRING_SEL,
    WATCH_LIKE_ACTION_ROW_SEL: WATCH_LIKE_ACTION_ROW_SEL,
    WATCH_STATS_ANCHOR_SEL: WATCH_STATS_ANCHOR_SEL,
    TILE_META_HOST_SEL: TILE_META_HOST_SEL,
    TILE_META_ROW_SEL: TILE_META_ROW_SEL,
    REEL_TILE_TAG: REEL_TILE_TAG,
    RICH_GRID_RENDERER_SEL: RICH_GRID_RENDERER_SEL,
    WATCH_AI_SUMMARY_SEL: WATCH_AI_SUMMARY_SEL,
    WATCH_AI_TRANSCRIPT_SEL: WATCH_AI_TRANSCRIPT_SEL,
    WATCH_DISCLOSURE_HOST_SEL: WATCH_DISCLOSURE_HOST_SEL,
    RELATED_RAIL_SEL: RELATED_RAIL_SEL,
    YTD_PLAYER_SEL: YTD_PLAYER_SEL,
    SEGMENTED_LIKE_SEL: SEGMENTED_LIKE_SEL,
    TOGGLE_LIKE_BTN_SEL: TOGGLE_LIKE_BTN_SEL,
    TOGGLE_DISLIKE_BTN_SEL: TOGGLE_DISLIKE_BTN_SEL,
    REEL_OVERLAY_ACTIONS_SEL: REEL_OVERLAY_ACTIONS_SEL,
    SUB_FEED_CONTAINER_SEL: SUB_FEED_CONTAINER_SEL,
    SUB_GRID_ITEM_SEL: SUB_GRID_ITEM_SEL,
    SUB_RICH_ITEM_SEL: SUB_RICH_ITEM_SEL,
    CONTINUATION_SEL: CONTINUATION_SEL,
    CHANNEL_PAGE_HEADER_SEL: CHANNEL_PAGE_HEADER_SEL,
    SUBSCRIBE_BUTTON_SEL: SUBSCRIBE_BUTTON_SEL,
    MINI_GUIDE_SEL: MINI_GUIDE_SEL,
    DEARROW_TITLE_SEL: DEARROW_TITLE_SEL,
    COMMENT_THREAD_SEL: COMMENT_THREAD_SEL,
    COMMENT_TEXT_SEL: COMMENT_TEXT_SEL,
    WATCH_TITLE_SEL: WATCH_TITLE_SEL,
    TRANSCRIPT_SEGMENT_SEL: TRANSCRIPT_SEGMENT_SEL,
    TRANSCRIPT_SEGMENT_TEXT_SEL: TRANSCRIPT_SEGMENT_TEXT_SEL,
    TRANSCRIPT_SEGMENT_TIMESTAMP_SEL: TRANSCRIPT_SEGMENT_TIMESTAMP_SEL,
    TRANSCRIPT_PANEL_SEL: TRANSCRIPT_PANEL_SEL,
    TRANSCRIPT_ENGAGEMENT_PANEL_SEL: TRANSCRIPT_ENGAGEMENT_PANEL_SEL,
    TRANSCRIPT_RENDERER_SEL: TRANSCRIPT_RENDERER_SEL,
    TRANSCRIPT_SEGMENT_FALLBACK_SEL: TRANSCRIPT_SEGMENT_FALLBACK_SEL,
    TRANSCRIPT_DESC_BUTTON_SEL: TRANSCRIPT_DESC_BUTTON_SEL,
    TRANSCRIPT_TOGGLE_BUTTON_SEL: TRANSCRIPT_TOGGLE_BUTTON_SEL,
    TRANSCRIPT_PANEL_HEADER_BTN_SEL: TRANSCRIPT_PANEL_HEADER_BTN_SEL,
    TRANSCRIPT_BUTTON_RENDERER_SEL: TRANSCRIPT_BUTTON_RENDERER_SEL,
    YTD_APP_SEL: YTD_APP_SEL,
    MENU_SERVICE_ITEM_SEL: MENU_SERVICE_ITEM_SEL,
    PLAYLIST_PANEL_BOTH_SEL: PLAYLIST_PANEL_BOTH_SEL,
    HISTORY_SECTION_SEL: HISTORY_SECTION_SEL,
    HISTORY_SECTION_TITLE_SEL: HISTORY_SECTION_TITLE_SEL,
    VIDEO_META_BLOCK_SEL: VIDEO_META_BLOCK_SEL,
    PLAYLIST_INDEX_TILE_SEL: PLAYLIST_INDEX_TILE_SEL,
    PLAYLIST_PAGE_HEADER_H1_SEL: PLAYLIST_PAGE_HEADER_H1_SEL,
    PLAYLIST_PAGE_META_SEL: PLAYLIST_PAGE_META_SEL,
    playlistPageMeta: playlistPageMeta,
    PLAYLIST_HEADER_TITLE_SEL: PLAYLIST_HEADER_TITLE_SEL,
    PLAYLIST_TILE_TITLE_SEL: PLAYLIST_TILE_TITLE_SEL,
    PLAYLIST_SECTION_CONTENTS_SEL: PLAYLIST_SECTION_CONTENTS_SEL,
    PLAYLIST_BROWSE_RESULTS_SEL: PLAYLIST_BROWSE_RESULTS_SEL,
    PLAYLIST_SECTION_CONTENTS_CLASS_SEL: PLAYLIST_SECTION_CONTENTS_CLASS_SEL,
    PLAYLIST_HEADER_ACTIONS_SEL: PLAYLIST_HEADER_ACTIONS_SEL,
    PLAYLIST_HEADER_MENU_CONTAINER_SEL: PLAYLIST_HEADER_MENU_CONTAINER_SEL,
    PLAYLIST_HEADER_MENU_SEL: PLAYLIST_HEADER_MENU_SEL,
    YTD_MENU_RENDERER_SEL: YTD_MENU_RENDERER_SEL,
    LIVE_MARK_SEL: LIVE_MARK_SEL,
    LIVE_SHELF_ANCHOR_SEL: LIVE_SHELF_ANCHOR_SEL,
    WATCH_DESC_EXPAND_SEL: WATCH_DESC_EXPAND_SEL,
    WATCH_DESC_COLLAPSE_SEL: WATCH_DESC_COLLAPSE_SEL,
    WATCH_DESC_EXPANDER_SEL: WATCH_DESC_EXPANDER_SEL,
    WATCH_DESC_TEXT_SEL: WATCH_DESC_TEXT_SEL,
    COMMENT_CONTENT_FALLBACK_SEL: COMMENT_CONTENT_FALLBACK_SEL,
    REEL_OVERLAY_SEL: REEL_OVERLAY_SEL,
    COMMENTS_HOST_FALLBACK_SEL: COMMENTS_HOST_FALLBACK_SEL,
    COMMENT_ANY_THREAD_SEL: COMMENT_ANY_THREAD_SEL,
    COMMENT_TOOLBAR_SEL: COMMENT_TOOLBAR_SEL,
    TOPBAR_LOGO_SEL: TOPBAR_LOGO_SEL,
    CONFIRM_DIALOG_SEL: CONFIRM_DIALOG_SEL,
    WATCH_FLEXY_SEL: WATCH_FLEXY_SEL,
    GUIDE_TAB_ENTRY_SEL: GUIDE_TAB_ENTRY_SEL,
    GUIDE_SHORTS_LINK_SEL: GUIDE_SHORTS_LINK_SEL,
    RELATED_COMPACT_TILE_SEL: RELATED_COMPACT_TILE_SEL,
    RELATED_LOCKUP_TILE_SEL: RELATED_LOCKUP_TILE_SEL,
    RELATED_TILES_SEL: RELATED_TILES_SEL,
    RELATED_TILE_LINK_SEL: RELATED_TILE_LINK_SEL,
    RELATED_TILE_CHANNEL_SEL: RELATED_TILE_CHANNEL_SEL,
    deepQuery: deepQuery,
    playerControlsHost: playerControlsHost
  };
});
