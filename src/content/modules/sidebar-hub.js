/**
 * YouTube sidebar hub — subscription groups at the top of the guide, with
 * expand-in-place popouts and a slide-out panel to browse and edit channels.
 */
(function () {
  'use strict';

  var SG = window.UNSubGroups;
  var PF = window.UNPlaylistFolders;
  var SCT = window.UNSubChannelThumbs;
  var FL = window.UNForgeLinks;
  var Smart = window.UNSubSmartRows;
  var TP = window.UNTasteProfile;
  var YD = window.UNYtDom;
  var CU = window.UNCatchUp;
  var CUS = window.UNCatchUpScrape;
  var M_CHANNEL_NAMES = 'UNSYNTH/YT/CHANNEL_NAMES';
  var M_SUBS_REFRESH = 'UNSYNTH/SUBS/CACHE_REFRESH';
  var M_PLAYLISTS_MINE = 'UNSYNTH/YT/PLAYLISTS_MINE';
  var SF = window.UNSubFeed;

  function emptyPlStore() {
    return { folders: {}, names: {} };
  }
  function pfEmpty() {
    return PF && PF.empty ? PF.empty() : emptyPlStore();
  }
  function emptyPins() {
    return PF && PF.emptyPins ? PF.emptyPins() : { ids: [], names: {} };
  }

  var core = null;
  var subStore = { groups: {}, names: {} };
  var plStore = pfEmpty();
  var plPins = emptyPins();
  var plPrefs = PF && PF.normalizePrefs ? PF.normalizePrefs(null) : { sidebar: true, showAll: true, hideEmpty: true, sort: 'manual' };
  var subActive = '';
  var plActive = '';
  var subHomeMode = 'off';
  var subHomeGroup = '';
  var subNewSeen = {};
  var subChannelLatest = {};
  var subChannelThumbs = {};
  var watchStats = null;
  var searchStats = null;
  var subscribedChannels = [];
  var subscribedChannelCache = { keys: [], names: [] };
  var tasteProfile = null;
  var smartVideos = [];
  var smartSuggestedVideos = [];
  // Explicit "not interested" / "never this channel" rejections. Kept out of
  // the taste profile so profile trimming can never un-dismiss something.
  var tasteDismissed = null;
  var smartNewsVideos = [];
  var forgeLastSync = 0;
  // Show the big Playlist Forge panel in the guide sidebar. Default OFF so the
  // sidebar leads with subscription groups + playlist groups; the Forge module's
  // other surfaces (watch-page tab, search, site link) are unaffected.
  var forgeSidebar = false;
  var openPopout = null;
  var openPanelKind = null;
  var openPanelName = '';
  var openPanelSubTab = 'current'; // 'current' | 'add'
  var openPanelPlTab = 'current'; // 'current' | 'add'
  var openSubsFilter = 'all'; // 'all' | 'not_in_group' | 'unassigned'
  var openAllSubsFilter = 'all'; // 'all' | 'unassigned' | groupName
  var openPlsFilter = 'all'; // 'all' | 'not_in_folder' | 'unassigned'
  var panelFilterQuery = '';
  var allSubsRefreshing = false;
  var allSubsError = '';
  var allSubsManualOpen = false;
  var manualSubExtras = [];
  var allPlaylists = [];
  var allPlaylistsLoading = false;
  var allPlaylistsError = '';
  var allPlManualOpen = false;
  var manualPlExtras = [];
  var hubDocClick = null;
  var hubDocKey = null;
  var hubDocScroll = null;
  var hubEscHandle = null;
  var hubStorageChanged = null;
  var namesFetchPending = false;
  var feedScanTimer = null;
  var FEED_POLL_MS = 150000;
  var dataReady = false;

  function subEnabled() {
    if (!core) return true;
    return core.isModuleEnabled({ moduleKey: 'subManager' });
  }

  // This file owns a shared guide surface, not just Subscription Manager.
  // Keep it alive when any section needs the hub so playlist pins do not
  // disappear merely because subscription grouping was switched off.
  function enabled() {
    return subEnabled() || plSectionEnabled() || forgeSectionEnabled();
  }

  function forgeEnabled() {
    if (!core) return true;
    return core.isModuleEnabled({ moduleKey: 'forgeLink' });
  }

  // The sidebar Forge panel needs both the module enabled AND the opt-in pref.
  function forgeSectionEnabled() {
    return forgeEnabled() && forgeSidebar === true;
  }

  function load(cb) {
    chrome.storage.local.get(
      {
        subStore: { groups: {}, names: {} },
        subActive: '',
        subHomeMode: 'off',
        subHomeGroup: '',
        plFolderStore: pfEmpty(),
        plFolderActive: '',
        plFolderPrefs: null,
        plPins: emptyPins(),
        subNewSeen: {},
        subChannelLatest: {},
        subChannelThumbs: {},
        watchStats: null,
        searchStats: null,
        subscribedChannels: { items: [], updatedAt: 0 },
        subscribedChannelCache: { keys: [], names: [] },
        unTasteProfile: null,
        subSmartVideos: [],
        subSmartSuggestedVideos: [],
        unTasteDismissed: null,
        subSmartNewsVideos: [],
        forgeLastSync: 0,
        forgePrefs: null,
        catchUpSeen: {},
        catchUp: null,
        watchedVideos: []
      },
      function (d) {
        subStore = d.subStore || { groups: {}, names: {} };
        plStore = d.plFolderStore || pfEmpty();
        plPins = PF && PF.normalizePins ? PF.normalizePins(d.plPins) : d.plPins || emptyPins();
        plPrefs = PF && PF.normalizePrefs ? PF.normalizePrefs(d.plFolderPrefs) : plPrefs;
        subActive = d.subActive || '';
        subHomeMode = d.subHomeMode || 'off';
        subHomeGroup = d.subHomeGroup || '';
        plActive = d.plFolderActive || '';
        subNewSeen = d.subNewSeen || {};
        subChannelLatest = d.subChannelLatest || {};
        subChannelThumbs = d.subChannelThumbs || {};
        watchStats = d.watchStats || null;
        searchStats = d.searchStats || null;
        subscribedChannels = (d.subscribedChannels && d.subscribedChannels.items) || [];
        subscribedChannelCache = d.subscribedChannelCache || { keys: [], names: [] };
        tasteProfile = TP && TP.normalize ? TP.normalize(d.unTasteProfile) : d.unTasteProfile;
        tasteDismissed = TP && TP.normalizeDismissed ? TP.normalizeDismissed(d.unTasteDismissed) : d.unTasteDismissed;
        // Rows stored before badges were captured carry no `badges` field, so
        // the membership guard in sub-smart-rows cannot see them and a
        // members-only video already in the list would keep showing until it
        // happened to be re-scraped. Drop those rows on load: they are a cache
        // of scraped tiles, cheap to rebuild, and an unfilterable stale entry on
        // a recommendation page is worse than a shorter list.
        smartVideos = dropUnbadgedRows(d.subSmartVideos);
        smartSuggestedVideos = dropUnbadgedRows(d.subSmartSuggestedVideos);
        smartNewsVideos = dropUnbadgedRows(d.subSmartNewsVideos);
        forgeLastSync = d.forgeLastSync || 0;
        // Default OFF: only show the sidebar Forge panel when explicitly opted in.
        forgeSidebar = !!(d.forgePrefs && d.forgePrefs.sidebar === true);
        catchUpSeen = d.catchUpSeen || {};
        // Fall back to the shipped defaults rather than to zeros: a missing
        // settings block must not silently mean "0 days, no Shorts", which
        // would render an always-empty digest and look like a broken feature.
        var cuDefaults =
          (window.UNSYNTH_DEFAULTS && window.UNSYNTH_DEFAULTS.catchUp) || { days: 7, includeShorts: false, fillMinutes: 90 };
        catchUpPrefs = Object.assign({}, cuDefaults, d.catchUp || {});
        watchedIds = d.watchedVideos || [];
        scrubBadNames();
        dataReady = true;
        cb && cb();
      }
    );
  }

  function saveSub() {
    chrome.storage.local.set({ subStore: subStore });
  }
  function savePl() {
    // Merging writer — see persistFolders() in shared/playlist-folders.js.
    if (PF && PF.persistFolders) PF.persistFolders(plStore, null, { authoritative: true });
    else chrome.storage.local.set({ plFolderStore: plStore });
  }
  function savePins() {
    if (PF && PF.persistPins) PF.persistPins(plPins);
    else chrome.storage.local.set({ plPins: plPins });
  }
  function saveNewState() {
    chrome.storage.local.set({ subNewSeen: subNewSeen, subChannelLatest: subChannelLatest });
  }
  function saveThumbs() {
    chrome.storage.local.set({ subChannelThumbs: subChannelThumbs });
  }
  function setSubActive(name) {
    subActive = name;
    chrome.storage.local.set({ subActive: name }, function () {
      try {
        document.dispatchEvent(new CustomEvent('unsynth-sub-filter-apply'));
      } catch (e) {
        /* ignore */
      }
    });
  }
  function setPlActive(name) {
    plActive = name;
    chrome.storage.local.set({ plFolderActive: name });
  }
  // Pin a group to the home feed (or clear it). sub-manager picks up the change
  // via storage and applies the home filter/shelf — keeps the two decoupled.
  function setSubHome(group, mode) {
    subHomeGroup = group;
    subHomeMode = mode;
    chrome.storage.local.set({ subHomeGroup: group, subHomeMode: mode });
  }
  function isHomeGroup(name) {
    return subHomeMode !== 'off' && subHomeGroup === name;
  }

  function sendMsg(type, extra, cb) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}), function (r) {
        cb && cb(r || { ok: false });
      });
    } catch (e) {
      cb && cb({ ok: false });
    }
  }

  function sendMsgWithTimeout(type, extra, ms, cb) {
    var finished = false;
    var timer = setTimeout(function () {
      if (finished) return;
      finished = true;
      cb && cb({ ok: false, error: 'timeout' });
    }, ms || 20000);
    sendMsg(type, extra, function (r) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cb && cb(r || { ok: false });
    });
  }

  function setNamesLoading(on) {
    var hub = document.getElementById('un-sidebar-hub');
    if (!hub) return;
    hub.classList.toggle('un-hub-names-loading', !!on);
    hub.querySelectorAll('.un-hub-pop-head').forEach(function (el) {
      if (on) {
        if (!el.dataset.baseText) el.dataset.baseText = el.textContent;
        if (el.textContent.indexOf('loading names') === -1) {
          el.textContent = el.dataset.baseText + ' — loading names…';
        }
      } else if (el.dataset.baseText) {
        el.textContent = el.dataset.baseText;
      }
    });
  }

  function nameFromGuide(key) {
    var forms = SG.keyForms(subStore, key);
    var links = document.querySelectorAll(YD ? YD.GUIDE_ENTRY_CHANNEL_LINK_SEL : 'a[href*="/@"]');
    for (var i = 0; i < links.length; i++) {
      var k = SG.channelKey(links[i].getAttribute('href'));
      if (!k || forms.indexOf(k) === -1) continue;
      var t = links[i].querySelector('yt-formatted-string, #text');
      var name = (t ? t.textContent : links[i].textContent || '').trim();
      if (name) return name;
    }
    return null;
  }

  function storedName(key) {
    return SG.storedChannelName(subStore, key);
  }

  function channelLabel(key) {
    var stored = SG.storedChannelName(subStore, key);
    if (stored) return stored;
    var guide = nameFromGuide(key);
    if (guide) {
      subStore.names = subStore.names || {};
      subStore.names[key] = guide;
      saveSub();
      return guide;
    }
    return SG.channelDisplayLabel(subStore, key);
  }

  function unresolvedChannelIds() {
    return SG.unresolvedChannelIds(subStore);
  }

  function displayChannelLabel(key) {
    var guide = nameFromGuide(key);
    if (guide) {
      subStore.names = subStore.names || {};
      if (!subStore.names[key] || SG.isUnresolvedLabel(subStore.names[key], key)) {
        subStore.names[key] = guide;
        saveSub();
      }
    }
    return SG.channelDisplayLabel(subStore, key);
  }

  function applyResolvedNames(names, thumbs, handles) {
    if (!names || !Object.keys(names).length) return false;
    var touched = false;
    var thumbTouched = false;
    subStore.names = subStore.names || {};
    for (var id in names) {
      if (!names[id]) continue;
      var k = 'channel:' + id;
      if (!subStore.names[k] || SG.isUnresolvedLabel(subStore.names[k], k)) {
        subStore.names[k] = names[id];
        touched = true;
      }
      var rawHandle = handles && handles[id];
      var hk = rawHandle ? SG.handleKey(rawHandle) : null;
      if (hk) {
        SG.setAlias(subStore, k, hk);
        if (!subStore.names[hk] || SG.isUnresolvedLabel(subStore.names[hk], hk)) {
          subStore.names[hk] = names[id];
        }
        touched = true;
      }
    }
    if (thumbs && SCT) {
      for (var tid in thumbs) {
        var tk = 'channel:' + tid;
        if (SCT.remember(subChannelThumbs, tk, thumbs[tid])) thumbTouched = true;
      }
    }
    if (touched) saveSub();
    if (thumbTouched) saveThumbs();
    return touched || thumbTouched;
  }

  function fetchChannelNamesInnertube(ids, cb) {
    if (!ids || !ids.length) {
      cb && cb(null);
      return;
    }
    var reqId = 'cn' + Date.now() + Math.random().toString(36).slice(2, 6);
    function onMsg(e) {
      if (e.source !== window || !e.data || e.data.type !== 'UN_CHANNEL_NAMES_RES' || e.data.reqId !== reqId) return;
      window.removeEventListener('message', onMsg);
      cb && cb(e.data);
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ type: 'UN_CHANNEL_NAMES_REQ', reqId: reqId, ids: ids }, '*');
    setTimeout(function () {
      window.removeEventListener('message', onMsg);
      cb && cb(null);
    }, 15000);
  }

  function resolvedNameCount() {
    var n = 0;
    Object.keys(subStore.groups || {}).forEach(function (g) {
      (subStore.groups[g] || []).forEach(function (k) {
        if (storedName(k)) n++;
      });
    });
    return n;
  }

  function scrubBadNames() {
    var touched = false;
    Object.keys(subStore.names || {}).forEach(function (k) {
      if (SG.isUnresolvedLabel(subStore.names[k], k)) {
        delete subStore.names[k];
        touched = true;
      }
    });
    if (touched) saveSub();
  }

  function refreshHubLabels() {
    document.querySelectorAll('#un-sidebar-hub [data-ch-key]').forEach(function (el) {
      var key = el.getAttribute('data-ch-key');
      if (key) el.textContent = displayChannelLabel(key);
    });
  }

  function enrichChannelNames() {
    if (namesFetchPending || !enabled()) return;
    var total = unresolvedChannelIds().length;
    if (!total) return;
    namesFetchPending = true;
    setNamesLoading(true);
    var rounds = 0;
    var maxRounds = Math.min(12, Math.ceil(total / 50) + 2);
    var triedInnertube = false;

    function finish() {
      namesFetchPending = false;
      setNamesLoading(false);
      refreshHubLabels();
    }

    function fetchBatch() {
      var ids = unresolvedChannelIds().slice(0, 50);
      if (!ids.length || rounds >= maxRounds) {
        finish();
        return;
      }
      rounds++;
      sendMsgWithTimeout(M_CHANNEL_NAMES, { ids: ids }, 20000, function (r) {
        var got = r && r.ok && r.names && Object.keys(r.names).length;
        if (got && applyResolvedNames(r.names, r.thumbs, r.handles)) {
          refreshHubLabels();
        }
        if (unresolvedChannelIds().length && got) {
          fetchBatch();
          return;
        }
        if (!got && !triedInnertube) {
          triedInnertube = true;
          fetchChannelNamesInnertube(ids, function (pageR) {
            if (pageR && pageR.ok && pageR.names && applyResolvedNames(pageR.names, pageR.thumbs, pageR.handles)) {
              refreshHubLabels();
            }
            fetchBatch();
          });
          return;
        }
        if (unresolvedChannelIds().length) {
          fetchBatch();
          return;
        }
        finish();
      });
    }
    fetchBatch();
  }

  function rememberThumb(key, url) {
    if (!SCT || !key) return false;
    return SCT.remember(subChannelThumbs, key, url);
  }

  function channelThumbUrl(key) {
    return SCT ? SCT.lookup(subChannelThumbs, subStore, key) : null;
  }

  function mkChannelAvatar(key, className) {
    var lbl = displayChannelLabel(key);
    if (SCT) {
      return SCT.mkAvatar({
        className: className || 'un-hub-panel-avatar',
        label: lbl,
        initial: channelInitial(key),
        thumbUrl: channelThumbUrl(key)
      });
    }
    var avatar = document.createElement('span');
    avatar.className = className || 'un-hub-panel-avatar';
    avatar.textContent = channelInitial(key);
    avatar.title = lbl;
    return avatar;
  }

  function scanGuideChannelThumbs() {
    if (!SCT) return false;
    var touched = false;
    document
      .querySelectorAll(YD ? YD.GUIDE_ENTRY_SEL : '#guide a[href]')
      .forEach(function (entry) {
        var a = entry.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/c/"]');
        if (!a) return;
        var key = SG.channelKey(a.getAttribute('href'));
        if (!key || !channelInAnyGroup(key)) return;
        var url = SCT.thumbFromGuideEntry(entry);
        if (url && rememberThumb(key, url)) touched = true;
      });
    if (touched) saveThumbs();
    return touched;
  }

  function tileChannelKey(tile) {
    return SF ? SF.tileChannelKey(tile) : null;
  }
  function tileVideoId(tile) {
    var a = tile.querySelector('a#thumbnail[href*="/watch"], a[href*="/watch?v="], a[href*="/watch"], a[href*="/shorts/"]');
    if (!a) return null;
    var href = a.getAttribute('href') || '';
    var m = href.match(/[?&]v=([\w-]{11})/);
    if (m) return m[1];
    var sm = href.match(/\/shorts\/([\w-]{11})/);
    return sm ? sm[1] : null;
  }

  function isHomeOrFeedPath() {
    var p = location.pathname;
    return p === '/' || p === '' || p.indexOf('/feed/') === 0;
  }

  /**
   * Scrape visible feed tiles for channel key + latest video id.
   * @param {{ groupOnly?: boolean }} opts — when true, only channels in user groups
   */
  function scanFeedTiles(opts) {
    opts = opts || {};
    var touched = false;
    var thumbTouched = false;
    var perChannel = {};
    var feedTiles = SF ? SF.FEED_TILES : (YD ? YD.FEED_TILES : []);
    feedTiles.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (tile) {
        var key = tileChannelKey(tile);
        if (!key || perChannel[key]) return;
        if (opts.groupOnly && !channelInAnyGroup(key)) return;
        var vid = tileVideoId(tile);
        if (!vid) return;
        perChannel[key] = true;
        if (SCT) {
          var thumbUrl = SCT.thumbFromFeedTile(tile);
          if (thumbUrl && rememberThumb(key, thumbUrl)) thumbTouched = true;
        }
        // YD.tileChannel() (already used correctly at scanWatchRelated below)
        // has fallbacks for the modern yt-lockup-view-model tile, where the
        // channel name is plain text with no <a> inside the channel block at
        // all. This inline query didn't, so on that tile
        // type chName stayed empty and subStore.names[key] was silently
        // never populated for the sub-group labels — no error, just
        // permanently unresolved channel names.
        var chName = YD && YD.tileChannel ? YD.tileChannel(tile) : (function () {
          var chA = tile.querySelector(YD ? YD.CHANNEL_KEY_LINK_SEL : '#channel-name a');
          return chA ? (chA.textContent || '').trim() : '';
        })();
        if (chName) {
          subStore.names = subStore.names || {};
          if (!subStore.names[key] || SG.isUnresolvedLabel(subStore.names[key], key)) {
            subStore.names[key] = chName;
            touched = true;
          }
        }
        var prev = subChannelLatest[key];
        if (!prev || prev.videoId !== vid) {
          subChannelLatest[key] = { videoId: vid, ts: Date.now() };
          invalidateNewCounts();
          touched = true;
        }
      });
    });
    if (touched) {
      chrome.storage.local.set({ subStore: subStore, subChannelLatest: subChannelLatest });
    }
    if (thumbTouched) saveThumbs();
    return touched || thumbTouched;
  }

  /** Full subscriptions feed — all visible channel tiles. */
  function scanSubscriptionsFeed() {
    if (!location.pathname.startsWith('/feed/subscriptions')) return false;
    var tiles = scanFeedTiles({ groupOnly: false });
    // The richest source for the catch-up digest by far: this page is
    // literally the folders' channels' recent uploads.
    var cu = scanCatchUp(document);
    return tiles || cu;
  }

  /** Home and other feed pages — grouped channels only. */
  function scanHomeFeed() {
    if (!isHomeOrFeedPath()) return false;
    if (location.pathname.startsWith('/feed/subscriptions')) return false;
    var grouped = scanFeedTiles({ groupOnly: true });
    var smart = scanSmartVideos(document);
    var cu = scanCatchUp(document);
    return grouped || smart || cu;
  }

  // Suggested/News/Discover only ever learn from tiles that have actually
  // rendered somewhere on the page — there's no API call backing this, by
  // design (see sub-smart-rows.js). Home was the only surface scraped,
  // which meant the candidate pool was capped at whatever fit on one
  // mostly-unscrolled home load — reported live as "needs to find and
  // suggest way more." Search results and the watch-page related rail are
  // both real, already-rendered tile sources this can scrape the exact same
  // way, so scanning them too widens the pool without touching the API.
  function scanSearchResults() {
    if (location.pathname.indexOf('/results') !== 0) return false;
    var smart = scanSmartVideos(document);
    var cu = scanCatchUp(document);
    return smart || cu;
  }

  function scanWatchRelated() {
    if (!YD || !YD.isWatchPage || !YD.isWatchPage()) return false;
    var root = YD.watchRelatedRoot && YD.watchRelatedRoot();
    if (!root) return false;
    // Scoped to the related rail, never the whole watch page — the player
    // and its chrome mutate constantly and walking past #secondary would
    // make this scan run far more often than it needs to for no benefit.
    var smart = scanSmartVideos(root);
    var cu = scanCatchUp(root);
    return smart || cu;
  }

  /**
   * A channel's own page — the most direct source there is for "what did this
   * channel upload recently", which is exactly the digest's question.
   *
   * Caught by e2e, not by reasoning: on /@Fireship/videos the page rendered 30
   * tiles of a grouped channel and catchUpSeen stayed empty, because every
   * other scan entry point gates on '/', '/feed/*', '/results' or a watch page
   * and a channel page is none of those.
   *
   * Deliberately catch-up only. scanFeedTiles() records a channel's LATEST
   * video id to drive the "new upload" badge, and a channel page shows that
   * channel's whole back catalogue — feeding it in would mark a channel as
   * having a new upload every time the user visited its page.
   */
  function scanChannelPage() {
    if (!YD || !YD.pageSurface || !CUS) return false;
    if (YD.pageSurface(location.pathname, location.host) !== 'channel') return false;
    // The tiles on this page have no channel link of their own — the channel
    // is the page — so the identity has to come from the URL. Without it every
    // tile here is keyless and the folder-membership filter drops the lot.
    var key = CUS.channelKeyFromPath(location.pathname);
    if (!key) return false;
    if (!channelInAnyGroup(key)) return false;
    return scanCatchUp(document, { channelKey: key, channelName: SG.storedChannelName(subStore, key) || '' });
  }

  /**
   * Drop stored rows that predate badge capture, plus any that are membership
   * gated. A row with no `badges` array was scraped before this data existed,
   * so nothing downstream can tell whether it is paywalled — and these lists
   * are a rebuildable cache of scraped tiles, not user data.
   */
  function dropUnbadgedRows(rows) {
    return (rows || []).filter(function (r) {
      if (!r || !Array.isArray(r.badges)) return false;
      return !isMembersOnlyVideo(r);
    });
  }

  /**
   * Inverse of UNSubGroups.channelKey — turn a stored key back into a URL.
   * Keys come in three shapes ('@handle', 'channel:UC…', 'c:name'); anything
   * else is not addressable and returns '' so the caller can skip the link
   * rather than navigating somewhere wrong.
   */
  function channelHrefFromKey(key) {
    var k = String(key || '');
    if (!k) return '';
    if (k.charAt(0) === '@') return '/' + k;
    if (k.indexOf('channel:') === 0) return '/channel/' + k.slice(8);
    if (k.indexOf('c:') === 0) return '/c/' + k.slice(2);
    return '';
  }

  /**
   * Record an explicit rejection and drop it from the rows immediately.
   *
   * Persisted BEFORE re-rendering, so a dismissal survives a reload even if
   * the user closes the page in the same second. The in-memory lists are
   * filtered here too rather than waiting for the next scrape — a card that
   * stays on screen after you press "not interested" reads as a broken button.
   */
  function dismissFeedVideo(video, wholeChannel) {
    if (!TP || !video) return;
    var next = TP.normalizeDismissed(tasteDismissed);
    if (wholeChannel && video.channelKey) next = TP.dismissChannel(next, video.channelKey);
    else next = TP.dismissVideo(next, video.videoId);
    tasteDismissed = next;

    var drop = function (list) {
      return (list || []).filter(function (r) { return !TP.isDismissed(next, r); });
    };
    smartVideos = drop(smartVideos);
    smartSuggestedVideos = drop(smartSuggestedVideos);
    smartNewsVideos = drop(smartNewsVideos);
    feedPageItems = drop(feedPageItems);

    chrome.storage.local.set({
      unTasteDismissed: next,
      subSmartVideos: smartVideos,
      subSmartSuggestedVideos: smartSuggestedVideos,
      subSmartNewsVideos: smartNewsVideos
    });

    if (window.UNSYNTH && window.UNSYNTH.toast) {
      window.UNSYNTH.toast(
        wholeChannel
          ? 'Never suggesting ' + (video.channelName || 'that channel') + ' again'
          : 'Not interested — hidden from suggestions'
      );
    }
    renderFeedPage();
  }

  /** Badge labels on a tile, via the shared helper. */
  function tileBadgeTexts(tile) {
    return YD && YD.tileBadgeTexts ? YD.tileBadgeTexts(tile) : [];
  }

  /**
   * True when a stored video row is members-only.
   * Reads the badges captured at scrape time rather than re-querying the DOM —
   * these pages render from storage and the original tile is long gone.
   */
  function isMembersOnlyVideo(video) {
    var b = (video && video.badges) || [];
    for (var i = 0; i < b.length; i++) {
      // Same anchored rule as yt-dom's MEMBER_BADGE_RE, and for the same
      // reason: a substring test matches "Member First Credit Union". Covers
      // "Members first" (early access) as well as "Members only" — both are
      // videos this feed cannot play.
      if (/^members?[\s-]*(only|first)$/.test(String(b[i]).trim())) return true;
    }
    return false;
  }

  /**
   * The channel a page belongs to, when the page IS a channel.
   *
   * A channel grid does not repeat the channel name on each tile — it is
   * implicit from the page — so YD.tileChannel() returns empty there and every
   * card scraped from a channel page ended up with no creator, rendering as the
   * fallback "YouTube". Reported from a screenshot of the Suggested page where
   * most rows read "YouTube" instead of the actual uploader.
   *
   * Returns '' off a channel page so feed scrapes keep using the per-tile name,
   * which is correct there.
   */
  function pageChannelIdentity() {
    return YD && YD.pageChannel ? YD.pageChannel() : null;
  }

  function scrapeSmartCandidates(root) {
    var candidates = [];
    var seen = {};
    var pageChan = pageChannelIdentity();
    var feedTiles = SF ? SF.FEED_TILES : (YD ? YD.FEED_TILES : []);
    feedTiles.forEach(function (sel) {
      root.querySelectorAll(sel).forEach(function (tile) {
        var videoId = tileVideoId(tile);
        if (!videoId || seen[videoId]) return;
        seen[videoId] = true;
        var title = YD.tileTitle ? YD.tileTitle(tile) : '';
        if (!title) return;
        // Duration, age and view count are right there on the tile and were
        // being thrown away — which is why the Suggested/News/Discover pages
        // rendered as a bare thumbnail, title and channel with no way to tell a
        // 40-second clip from a two-hour stream, or a fresh upload from
        // something five years old. yt-dom already exposes all three, and the
        // meta line ("350 views", "1 hour ago") is where YouTube puts the last
        // two, in that order but not always both.
        var meta = YD.tileMetaTexts ? YD.tileMetaTexts(tile) : [];
        // Views through the adapter: the compact tile drops the word "views".
        var views = YD.viewsText ? YD.viewsText(meta) : '';
        var age = '';
        meta.forEach(function (t) {
          if (!views && /view/i.test(t)) views = t;
          // An age by shape ("7y ago"), or a stream/premiere line that has no
          // number ("Premieres Sep 30") and was always shown here; not any text
          // that merely contains the word "ago".
          else if (!age && (YD.isAgeText ? (YD.isAgeText(t) || /^(streamed|premieres?|premiered)\b/i.test(t)) : /ago|stream|premier/i.test(t))) age = t;
        });
        candidates.push({
          videoId: videoId,
          title: title,
          // Fall back to the page's own channel when the tile has none — see
          // pageChannelIdentity(). A channel grid omits the name per tile.
          channelKey: tileChannelKey(tile) || (pageChan && pageChan.key) || '',
          channelName: (YD.tileChannel ? YD.tileChannel(tile) : '') || (pageChan && pageChan.name) || '',
          duration: YD.tileDurationText ? YD.tileDurationText(tile) : '',
          views: views,
          age: age,
          // Members-only, and the other badges YouTube stacks on a thumbnail.
          // Captured here so the filter below can act on it without a second
          // pass over the DOM.
          badges: tileBadgeTexts(tile)
        });
      });
    });
    return candidates;
  }

  /**
   * Remember every rendered tile that belongs to a sub-group folder, with the
   * upload age and duration scraped from the tile itself.
   *
   * Only grouped channels are kept. 606 subscriptions across three folders
   * means an ungrouped-inclusive store would grow without bound while the
   * digest — which is always scoped to one folder — could never use any of it.
   *
   * A tile with no readable age is stored with ageMs null rather than dropped:
   * the duration is still worth having for the queue fill, and buildDigest
   * excludes null-age rows from the day window on its own.
   */
  function scanCatchUp(root, pageChannel) {
    if (!CUS || !CU || !SG) return false;
    var candidates = CUS.scrapeCandidates(root || document, pageChannel);
    if (!candidates.length) return false;
    var touched = false;
    // Set when a first sighting was skipped only because its age had not
    // rendered yet. Those rows are recoverable, but ONLY if something looks
    // again -- see scheduleMetadataRetry.
    var deferred = false;
    var now = Date.now();
    candidates.forEach(function (c) {
      if (!c.videoId || !channelInAnyGroup(c.channelKey)) return;
      var prev = catchUpSeen[c.videoId];
      // A tile whose metadata row has not rendered yet scrapes with ageMs null.
      // Storing that row anyway is worse than skipping it: the digest cannot
      // place a video with no age, and the correction does not arrive for
      // FEED_POLL_MS (150s), because the only other trigger is a mutation and
      // the metadata lands in the same render pass as the tile it belongs to.
      // Measured live on a channel /videos page: the first scan wrote all 30
      // rows with a:null while a scrape moments later read every age correctly.
      //
      // Skipping instead of storing costs nothing — the next scan sees the tile
      // again. It only applies to a FIRST sighting: once an age is known, the
      // existing prev-preserving logic below keeps it.
      if (c.ageMs == null && !prev) { deferred = true; return; }
      // Re-scraping the same tile every mutation would rewrite storage
      // constantly. Only write when something actually changed — and never
      // overwrite a known age/duration with a null from a tile that happened
      // to render without its metadata block yet.
      var next = {
        t: c.title || (prev && prev.t) || '',
        k: c.channelKey || (prev && prev.k) || '',
        n: c.channelName || (prev && prev.n) || '',
        a: c.ageMs != null ? c.ageMs : prev ? prev.a : null,
        d: c.durationSec || (prev && prev.d) || 0,
        s: c.isShort || !!(prev && prev.s),
        // When the age was read, so a digest opened days later can add the
        // elapsed time instead of treating a stale "2 hours ago" as current.
        at: c.ageMs != null ? now : prev ? prev.at : now
      };
      if (
        !prev ||
        prev.t !== next.t ||
        prev.a !== next.a ||
        prev.d !== next.d ||
        prev.k !== next.k ||
        prev.s !== next.s
      ) {
        catchUpSeen[c.videoId] = next;
        touched = true;
      }
    });
    if (touched) saveCatchUpSeen();
    // A skipped first sighting is only harmless if a rescan actually follows.
    // On a settled channel page nothing else triggers one, so ask for it here.
    if (deferred && !touched) scheduleMetadataRetry();
    return touched;
  }

  // A tile's metadata row lands a render pass or two after the tile itself, so
  // a scan that arrives in between reads every age as null and skips the lot.
  //
  // The skip is correct -- a row with no age cannot be placed in the digest --
  // but the original reasoning ("the next scan sees the tile again") assumed a
  // rescan was coming. On a feed it is: tiles stream in and each mutation
  // triggers another scan. On a CHANNEL page the tiles render once and the DOM
  // then sits still, so the only remaining trigger is the 150s poll.
  //
  // Measured on /@Fireship/videos: 30 grouped tiles present, catchUpSeen empty
  // for a full 20s, because the first and only scan skipped all 30. The digest
  // was not slow, it was never going to arrive.
  //
  // So retry on a short ladder instead. Bounded and self-cancelling: once a
  // scan stores something the ladder stops, and it never outlives the page.
  var METADATA_RETRY_MS = [400, 900, 2000];
  var metadataRetryStep = 0;
  var metadataRetryTimer = null;
  // A LATE RETRY MUST PROVE IT STILL BELONGS TO THIS PAGE.
  //
  // Cancelling on onNavigate is necessary but not sufficient: a timer can fire
  // in the window after the URL has changed and before onNavigate runs, and it
  // would then do video A's deferred work against video B's document. This is
  // the stale-async class that already produced three defects in this codebase
  // (sponsorblock seeking the wrong video, the analytics panel sticking on the
  // wrong one, the wrong transcript reaching the AI) — the fix there was to
  // re-check ownership AFTER the wait rather than to trust the cancel.
  //
  // The generation is bumped on every navigation, so a timer captures the
  // generation it was scheduled in and refuses to act if it has moved on.
  var scanGeneration = 0;

  function scheduleMetadataRetry() {
    if (metadataRetryTimer) return;
    if (metadataRetryStep >= METADATA_RETRY_MS.length) return;
    var delay = METADATA_RETRY_MS[metadataRetryStep++];
    var gen = scanGeneration;
    var pathAtSchedule = location.pathname;
    metadataRetryTimer = setTimeout(function () {
      metadataRetryTimer = null;
      // The cancel may not have run yet; the generation check is what actually
      // guarantees this retry belongs to the page that asked for it.
      if (gen !== scanGeneration) return;
      if (location.pathname !== pathAtSchedule) return;
      if (document.hidden || !enabled() || !hubMounted()) return;
      // runAutoScans() re-enters scanCatchUp, which will either store rows
      // (ending the ladder) or call back in here for the next rung.
      if (runAutoScans()) {
        metadataRetryStep = 0;
        load(refreshAll);
      }
    }, delay);
  }

  // Bounded so a heavy browsing session cannot grow storage without limit.
  // Oldest-observed entries go first; the digest only ever looks back a few
  // weeks, so anything past the cap is already outside every window.
  var CATCHUP_MAX = 3000;

  function saveCatchUpSeen() {
    var ids = Object.keys(catchUpSeen);
    if (ids.length > CATCHUP_MAX) {
      ids
        .sort(function (a, b) {
          return (catchUpSeen[b].at || 0) - (catchUpSeen[a].at || 0);
        })
        .slice(CATCHUP_MAX)
        .forEach(function (id) {
          delete catchUpSeen[id];
        });
    }
    chrome.storage.local.set({ catchUpSeen: catchUpSeen });
  }

  /** Stored rows -> the candidate shape buildDigest() expects. */
  function catchUpCandidates() {
    var now = Date.now();
    return Object.keys(catchUpSeen).map(function (id) {
      var r = catchUpSeen[id];
      return {
        videoId: id,
        title: r.t || '',
        channelKey: r.k || '',
        channelName: r.n || '',
        // Age at scrape time plus however long ago that was. Without this a
        // tile scraped as "6 days ago" would still read as 6 days old a
        // fortnight later and never leave a 7-day digest.
        ageMs: r.a == null ? null : r.a + Math.max(0, now - (r.at || now)),
        durationSec: r.d || 0,
        isShort: !!r.s
      };
    });
  }

  function scanSmartVideos(root) {
    if (!Smart || !YD || !tasteProfile || !tasteProfile.totalWatched) return false;
    var candidates = scrapeSmartCandidates(root || document);
    var rankedKey = function (list) {
      return list.map(function (v) { return v.videoId + ':' + v.score; }).join('|');
    };
    var ranked = Smart.discoverVideos(candidates.concat(smartVideos), tasteProfile, subscribedChannelCache, 60, tasteDismissed);
    var rankedSuggested = Smart.suggestedVideos(candidates.concat(smartSuggestedVideos), tasteProfile, 60, tasteDismissed);
    var rankedNews = Smart.newsVideos(candidates.concat(smartNewsVideos), tasteProfile, 60, tasteDismissed);
    var changed =
      rankedKey(smartVideos) !== rankedKey(ranked) ||
      rankedKey(smartSuggestedVideos) !== rankedKey(rankedSuggested) ||
      rankedKey(smartNewsVideos) !== rankedKey(rankedNews);
    if (!changed) return false;
    smartVideos = ranked;
    smartSuggestedVideos = rankedSuggested;
    smartNewsVideos = rankedNews;
    chrome.storage.local.set({
      subSmartVideos: smartVideos,
      subSmartSuggestedVideos: smartSuggestedVideos,
      subSmartNewsVideos: smartNewsVideos
    });
    return true;
  }

  function channelInAnyGroup(key) {
    if (!key) return false;
    var forms = SG.keyForms(subStore, key);
    return Object.keys(subStore.groups || {}).some(function (g) {
      return (subStore.groups[g] || []).some(function (k) {
        return forms.indexOf(k) !== -1;
      });
    });
  }

  function guideEntryHasNewBadge(entry) {
    return !!(YD && YD.GUIDE_BADGE_SEL && entry.querySelector(YD.GUIDE_BADGE_SEL));
  }

  /** Sidebar guide badges — runs on any YouTube page with a visible guide. */
  function scanGuideSubscriptions() {
    var touched = false;
    var thumbTouched = false;
    document
      .querySelectorAll(YD ? YD.GUIDE_ENTRY_SEL : '#guide a[href]')
      .forEach(function (entry) {
        var a = entry.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/c/"]');
        if (!a) return;
        var key = SG.channelKey(a.getAttribute('href'));
        if (!key || !channelInAnyGroup(key)) return;
        if (!guideEntryHasNewBadge(entry)) return;
        var prev = subChannelLatest[key];
        if (prev && prev.videoId && prev.videoId.length === 11) return;
        if (!prev || prev.videoId !== 'guide:unread') {
          subChannelLatest[key] = { videoId: 'guide:unread', ts: Date.now() };
          invalidateNewCounts();
          touched = true;
        }
        var t = entry.querySelector('yt-formatted-string, #text');
        var name = (t ? t.textContent : a.textContent || '').trim();
        if (name) {
          subStore.names = subStore.names || {};
          if (!subStore.names[key] || SG.isUnresolvedLabel(subStore.names[key], key)) {
            subStore.names[key] = name;
            touched = true;
          }
        }
        if (SCT) {
          var gThumb = SCT.thumbFromGuideEntry(entry);
          if (gThumb && rememberThumb(key, gThumb)) thumbTouched = true;
        }
      });
    if (touched) {
      chrome.storage.local.set({ subStore: subStore, subChannelLatest: subChannelLatest });
    }
    if (thumbTouched) saveThumbs();
    return touched || thumbTouched;
  }

  function hasNewVideo(key) {
    return SG.hasUnseenVideo(subStore, subNewSeen, subChannelLatest, key);
  }

  function latestVideoId(key) {
    var forms = SG.keyForms(subStore, key);
    var best = null;
    forms.forEach(function (k) {
      var rec = subChannelLatest[k];
      if (rec && rec.videoId && (!best || (rec.ts || 0) > (best.ts || 0))) best = rec;
    });
    return best ? best.videoId : null;
  }

  function markChannelSeen(key) {
    var vid = latestVideoId(key);
    if (!vid) return;
    SG.keyForms(subStore, key).forEach(function (k) {
      subNewSeen[k] = vid;
      invalidateNewCounts();
    });
    saveNewState();
    ensureSidebar();
  }

  function markGroupSeen(name) {
    var keys = subStore.groups[name] || [];
    var touched = false;
    keys.forEach(function (key) {
      var vid = latestVideoId(key);
      if (!vid) return;
      SG.keyForms(subStore, key).forEach(function (k) {
        if (subNewSeen[k] !== vid) {
          subNewSeen[k] = vid;
          invalidateNewCounts();
          touched = true;
        }
      });
    });
    if (touched) {
      saveNewState();
      ensureSidebar();
    }
  }

  // Memo for groupNewCount, keyed on a version counter.
  //
  // hubSignature() calls this once per group, and ensureSidebar() calls
  // hubSignature() on EVERY scan just to decide whether anything changed. Each
  // call walks every channel in the group through hasNewVideo -> keyForms, so
  // on a real subscription list this is thousands of operations per scan to
  // answer a question whose answer is almost always "no". The guard cost more
  // than the work it guarded.
  //
  // Measured on @MrNightmare with the watched filter on: sidebarHub took
  // 183.4ms in one scan, 62% of the total, and tripped the runtime's own
  // slow-scan alarm at 187.6ms. That is the reported stall.
  var _newCountCache = {};
  var _newCountVersion = 0;

  // Must be called by every writer of subChannelLatest or subNewSeen. A cache
  // nobody clears is a correctness bug: a channel uploading, or the user
  // marking a group seen, would stop updating the sidebar badge.
  function invalidateNewCounts() {
    _newCountVersion++;
    _newCountCache = {};
  }

  function groupNewCount(name) {
    var key = name + '@' + _newCountVersion;
    if (Object.prototype.hasOwnProperty.call(_newCountCache, key)) return _newCountCache[key];
    var n = (subStore.groups[name] || []).filter(function (k) {
      return hasNewVideo(k);
    }).length;
    _newCountCache[key] = n;
    return n;
  }

  function channelHref(key) {
    if (!key) return '#';
    if (key.indexOf('@') === 0) return 'https://www.youtube.com/' + key;
    if (key.indexOf('channel:') === 0) return 'https://www.youtube.com/channel/' + key.slice(8);
    if (key.indexOf('c:') === 0) return 'https://www.youtube.com/c/' + key.slice(2);
    return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(key);
  }
  function playlistLabel(id) {
    return (plStore.names && plStore.names[id]) || id;
  }

  function closePopouts() {
    document.querySelectorAll('.un-hub-popout.open').forEach(function (p) {
      p.classList.remove('open');
    });
    document.querySelectorAll('.un-hub-row.expanded').forEach(function (r) {
      r.classList.remove('expanded');
    });
    document.querySelectorAll('.un-hub-chev-btn[aria-expanded="true"]').forEach(function (b) {
      b.setAttribute('aria-expanded', 'false');
    });
    openPopout = null;
  }

  function hubMounted() {
    return !!document.getElementById('un-sidebar-hub');
  }

  /** True only when the hub is still inside the live guide #sections (not an orphan). */
  function hubInPlace() {
    var hub = document.getElementById('un-sidebar-hub');
    if (!hub) return false;
    var sections = sectionsEl();
    if (!sections) return false;
    try {
      return sections.contains(hub);
    } catch (e) {
      return false;
    }
  }

  function runAutoScans() {
    return (
      scanSubscriptionsFeed() ||
      scanHomeFeed() ||
      scanSearchResults() ||
      scanWatchRelated() ||
      scanChannelPage() ||
      scanGuideSubscriptions() ||
      scanGuideChannelThumbs()
    );
  }

  /** Periodic background scan while hub is mounted. */
  function maybeScanFeed() {
    if (document.hidden) return;
    if (!enabled() || !hubMounted()) return;
    // A scan can refresh and replace the entire hub. Keep an options popout
    // stable while the user is interacting with it; the interval resumes after close.
    if (openPopout) return;
    if (runAutoScans()) load(refreshAll);
  }

  function scheduleFeedScan() {
    if (feedScanTimer) return;
    feedScanTimer = setInterval(function () {
      maybeScanFeed();
    }, FEED_POLL_MS);
  }

  function channelInitial(key) {
    var lbl = channelLabel(key);
    if (!lbl || lbl === '—') return '?';
    if (lbl.charAt(0) === '@') return lbl.charAt(1).toUpperCase();
    return lbl.charAt(0).toUpperCase();
  }

  function sortedSubKeys(keys) {
    return keys.slice().sort(function (a, b) {
      var an = hasNewVideo(a) ? 0 : 1;
      var bn = hasNewVideo(b) ? 0 : 1;
      if (an !== bn) return an - bn;
      return channelLabel(a).localeCompare(channelLabel(b));
    });
  }

  function isSubInGroup(groupName, key) {
    if (!groupName || !key) return false;
    var forms = SG.keyForms(subStore, key);
    return (subStore.groups[groupName] || []).some(function (k) {
      return forms.indexOf(k) !== -1;
    });
  }

  function isPlInFolder(folderName, plId) {
    if (!folderName || !plId) return false;
    return (plStore.folders[folderName] || []).indexOf(plId) !== -1;
  }

  function getSubsList() {
    return (subscribedChannels || [])
      .map(function (s) {
        return {
          key: SG.handleKey(s.handle) || 'channel:' + s.channelId,
          title: s.title || (s.handle ? '@' + s.handle : s.channelId),
          thumb: s.thumb,
          handle: s.handle ? (s.handle.charAt(0) === '@' ? s.handle : '@' + s.handle) : ''
        };
      })
      .concat(manualSubExtras);
  }

  function mkSubSingleAddRow(item, groupName) {
    var key = item.key;
    var row = document.createElement('div');
    row.className = 'un-hub-panel-item';
    var avatar = SCT
      ? SCT.mkAvatar({ label: item.title, initial: (item.title || '?').charAt(0).toUpperCase(), thumbUrl: item.thumb })
      : mkChannelAvatar(key);
    row.appendChild(avatar);

    var meta = document.createElement('div');
    meta.className = 'un-hub-panel-item-meta';

    var link = document.createElement('a');
    link.className = 'un-hub-panel-link';
    link.href = channelHref(key);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = item.title;
    link.title = key;
    meta.appendChild(link);

    var otherGroups = SG.groupsForChannel(subStore, key).filter(function (g) {
      return g !== groupName;
    });
    var subText = '';
    if (item.handle) subText = item.handle;
    if (otherGroups.length) {
      subText += (subText ? ' • ' : '') + 'Also in: ' + otherGroups.join(', ');
    }
    if (subText) {
      var subEl = document.createElement('span');
      subEl.className = 'un-hub-panel-item-sub';
      subEl.textContent = subText;
      meta.appendChild(subEl);
    }
    row.appendChild(meta);

    var inIt = isSubInGroup(groupName, key);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = inIt ? 'un-hub-panel-added-btn' : 'un-hub-panel-add-btn';
    btn.textContent = inIt ? '✓ In group' : '＋ Add';
    btn.title = inIt ? 'Click to remove from ' + groupName : 'Add to ' + groupName;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var nowIn = isSubInGroup(groupName, key);
      if (nowIn) {
        SG.keyForms(subStore, key).forEach(function (k) {
          SG.removeFromGroup(subStore, groupName, k);
        });
      } else {
        SG.addToGroup(subStore, groupName, key, item.title);
        if (item.thumb && SCT) {
          rememberThumb(key, item.thumb);
          saveThumbs();
        }
      }
      saveSub();
      ensureSidebar();
      renderOpenPanel();
    });
    row.appendChild(btn);
    return row;
  }

  function mkPlSingleAddRow(item, folderName) {
    var id = item.id;
    var row = document.createElement('div');
    row.className = 'un-hub-panel-item pl';

    var thumb = document.createElement('span');
    thumb.className = 'un-hub-panel-plthumb';
    if (item.thumb) {
      var img = document.createElement('img');
      img.className = 'un-hub-panel-plthumb-img';
      img.loading = 'lazy';
      img.alt = '';
      img.src = item.thumb;
      thumb.appendChild(img);
    }
    row.appendChild(thumb);

    var meta = document.createElement('div');
    meta.className = 'un-hub-panel-plmeta';
    var link = document.createElement('a');
    link.className = 'un-hub-panel-link';
    link.href = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(id);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = item.title || id;
    link.title = id;
    meta.appendChild(link);

    var subParts = [];
    if (item.count != null) {
      subParts.push(item.count + ' video' + (item.count === 1 ? '' : 's'));
    }
    var otherFolders = PF.foldersForPlaylist(plStore, id).filter(function (f) {
      return f !== folderName;
    });
    if (otherFolders.length) {
      subParts.push('In: ' + otherFolders.join(', '));
    }
    if (subParts.length) {
      var count = document.createElement('span');
      count.className = 'un-hub-panel-plcount';
      count.textContent = subParts.join(' • ');
      meta.appendChild(count);
    }
    row.appendChild(meta);

    var inIt = isPlInFolder(folderName, id);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = inIt ? 'un-hub-panel-added-btn' : 'un-hub-panel-add-btn';
    btn.textContent = inIt ? '✓ In folder' : '＋ Add';
    btn.title = inIt ? 'Click to remove from ' + folderName : 'Add to ' + folderName;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var nowIn = isPlInFolder(folderName, id);
      if (nowIn) {
        PF.removeFromFolder(plStore, folderName, id);
      } else {
        PF.addToFolder(plStore, folderName, id, item.title);
      }
      savePl();
      ensureSidebar();
      renderOpenPanel();
    });
    row.appendChild(btn);
    return row;
  }

  function ensurePanelShell() {
    var root = document.getElementById('un-hub-panel');
    if (root) {
      if (!document.body.contains(root)) document.body.appendChild(root);
      return root;
    }
    root = document.createElement('div');
    root.id = 'un-hub-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'un-hub-panel-title');
    root.hidden = true;

    var backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'un-hub-panel-backdrop';
    backdrop.setAttribute('aria-label', 'Close panel');
    backdrop.addEventListener('click', closePanel);

    var sheet = document.createElement('div');
    sheet.className = 'un-hub-panel-sheet';

    var head = document.createElement('div');
    head.className = 'un-hub-panel-head';
    head.innerHTML =
      '<div class="un-hub-panel-head-text">' +
      '<h2 class="un-hub-panel-title" id="un-hub-panel-title"></h2>' +
      '<span class="un-hub-panel-sub"></span>' +
      '</div>' +
      '<button type="button" class="un-hub-panel-close" aria-label="Close">×</button>';

    var tabsWrap = document.createElement('div');
    tabsWrap.className = 'un-hub-panel-tabs';
    tabsWrap.hidden = true;

    var searchWrap = document.createElement('div');
    searchWrap.className = 'un-hub-panel-search-wrap';
    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'un-hub-panel-search';
    search.placeholder = 'Filter…';
    search.setAttribute('aria-label', 'Filter list');
    search.autocomplete = 'off';
    search.addEventListener('input', function () {
      panelFilterQuery = search.value.trim().toLowerCase();
      renderOpenPanel();
    });
    search.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var raw = search.value.trim();
      if (!raw || !openPanelName) return;
      if (openPanelKind === 'sub') {
        var parsed = SG.parseChannelInput(raw);
        if (!parsed) {
          var matchedSub = getSubsList().find(function (s) {
            return s.title.toLowerCase() === raw.toLowerCase();
          });
          if (matchedSub) {
            parsed = { key: matchedSub.key, label: matchedSub.title };
          }
        }
        if (!parsed) return;
        e.preventDefault();
        SG.addToGroup(subStore, openPanelName, parsed.key, parsed.label || parsed.key);
        saveSub();
        search.value = '';
        panelFilterQuery = '';
        ensureSidebar();
        renderOpenPanel();
      } else if (openPanelKind === 'pl') {
        var plId = PF.parsePlaylistInput(raw);
        if (!plId) {
          var matchedPl = (allPlaylists || []).concat(manualPlExtras).find(function (p) {
            return (p.title || '').toLowerCase() === raw.toLowerCase();
          });
          if (matchedPl) plId = matchedPl.id;
        }
        if (!plId) return;
        e.preventDefault();
        PF.addToFolder(plStore, openPanelName, plId);
        savePl();
        search.value = '';
        panelFilterQuery = '';
        ensureSidebar();
        renderOpenPanel();
      }
    });
    searchWrap.appendChild(search);

    var filtersWrap = document.createElement('div');
    filtersWrap.className = 'un-hub-panel-filters';
    filtersWrap.hidden = true;

    var list = document.createElement('div');
    list.className = 'un-hub-panel-list';

    var actions = document.createElement('div');
    actions.className = 'un-hub-panel-actions';

    sheet.appendChild(head);
    sheet.appendChild(tabsWrap);
    sheet.appendChild(searchWrap);
    sheet.appendChild(filtersWrap);
    sheet.appendChild(list);
    sheet.appendChild(actions);
    root.appendChild(backdrop);
    root.appendChild(sheet);
    document.body.appendChild(root);

    head.querySelector('.un-hub-panel-close').addEventListener('click', closePanel);
    return root;
  }

  function closePanel() {
    var root = document.getElementById('un-hub-panel');
    if (!root) return;
    root.hidden = true;
    root.classList.remove('open', 'subs', 'pl');
    openPanelKind = null;
    openPanelName = '';
    openPanelSubTab = 'current';
    openPanelPlTab = 'current';
    openSubsFilter = 'all';
    openAllSubsFilter = 'all';
    openPlsFilter = 'all';
    panelFilterQuery = '';
    var search = root.querySelector('.un-hub-panel-search');
    if (search) search.value = '';
    if (hubEscHandle) { window.UNSYNTH.popPanel(hubEscHandle); hubEscHandle = null; }
  }

  function panelOpen() {
    // 'allsubs'/'allpl' (browse-all panels) have no single group/folder name
    // to key off of, unlike 'sub'/'pl' — they're open whenever their kind is set.
    if (openPanelKind === 'allsubs' || openPanelKind === 'allpl') return true;
    return !!(openPanelKind && openPanelName);
  }

  function openSubGroupPanel(name, initialTab) {
    closePopouts();
    enrichChannelNames();
    maybeScanFeed();
    openPanelKind = 'sub';
    openPanelName = name;
    openPanelSubTab = initialTab || 'current';
    openSubsFilter = 'all';
    panelFilterQuery = '';
    var root = ensurePanelShell();
    root.classList.remove('pl');
    root.classList.add('subs', 'open');
    root.hidden = false;
    if (!hubEscHandle) hubEscHandle = window.UNSYNTH.pushPanel(closePanel);
    renderOpenPanel();
    var search = root.querySelector('.un-hub-panel-search');
    if (search) {
      search.value = '';
      search.placeholder = openPanelSubTab === 'add'
        ? 'Search subscriptions to add to ' + name + '…'
        : 'Filter channels in ' + name + '… (Enter to add @handle/URL)';
      setTimeout(function () {
        search.focus();
      }, 80);
    }
  }

  function openAllSubsPanel() {
    closePopouts();
    enrichChannelNames();
    maybeScanFeed();
    openPanelKind = 'allsubs';
    openPanelName = '';
    openAllSubsFilter = 'all';
    panelFilterQuery = '';
    allSubsError = '';
    allSubsManualOpen = false;
    manualSubExtras = [];
    allSubsRefreshing = false;
    var root = ensurePanelShell();
    root.classList.remove('pl');
    root.classList.add('subs', 'open');
    root.hidden = false;
    if (!hubEscHandle) hubEscHandle = window.UNSYNTH.pushPanel(closePanel);
    renderOpenPanel();
    var search = root.querySelector('.un-hub-panel-search');
    if (search) {
      search.value = '';
      search.placeholder = 'Filter your subscriptions…';
      setTimeout(function () {
        search.focus();
      }, 80);
    }
  }

  function mkAllSubsRow(item, groupNames) {
    var key = item.key;
    var row = document.createElement('div');
    row.className = 'un-hub-panel-item';
    var avatar = SCT
      ? SCT.mkAvatar({ label: item.title, initial: (item.title || '?').charAt(0).toUpperCase(), thumbUrl: item.thumb })
      : mkChannelAvatar(key);
    row.appendChild(avatar);

    var meta = document.createElement('div');
    meta.className = 'un-hub-panel-item-meta';
    var link = document.createElement('a');
    link.className = 'un-hub-panel-link';
    link.href = channelHref(key);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = item.title;
    link.title = key;
    meta.appendChild(link);
    if (item.handle) {
      var subEl = document.createElement('span');
      subEl.className = 'un-hub-panel-item-sub';
      subEl.textContent = item.handle;
      meta.appendChild(subEl);
    }
    row.appendChild(meta);

    var chips = document.createElement('div');
    chips.className = 'un-hub-panel-chips';
    if (!groupNames.length) {
      var hint = document.createElement('span');
      hint.className = 'un-hub-panel-chip-hint';
      hint.textContent = 'No groups yet';
      chips.appendChild(hint);
    }
    groupNames.forEach(function (gname) {
      var chip = document.createElement('button');
      chip.type = 'button';
      var forms = SG.keyForms(subStore, key);
      var on = (subStore.groups[gname] || []).some(function (k) {
        return forms.indexOf(k) !== -1;
      });
      chip.className = 'un-hub-panel-chip' + (on ? ' on' : '');
      chip.textContent = gname;
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        var nowOn = chip.classList.contains('on');
        if (nowOn) {
          SG.keyForms(subStore, key).forEach(function (k) {
            SG.removeFromGroup(subStore, gname, k);
          });
        } else {
          SG.addToGroup(subStore, gname, key, item.title);
        }
        saveSub();
        ensureSidebar();
        chip.classList.toggle('on', !nowOn);
        chip.setAttribute('aria-pressed', !nowOn ? 'true' : 'false');
      });
      chips.appendChild(chip);
    });
    row.appendChild(chips);
    return row;
  }

  function mkAllSubsNewGroup() {
    var wrap = document.createElement('div');
    wrap.className = 'un-hub-panel-newgroup';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.placeholder = 'New group name…';
    input.className = 'un-hub-panel-newgroup-input';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'un-hub-panel-btn ghost';
    btn.textContent = '＋ New group';
    btn.disabled = true;
    input.addEventListener('input', function () {
      btn.disabled = !input.value.trim();
    });
    var create = function () {
      var gname = input.value.trim();
      if (!gname) return;
      if (!subStore.groups[gname]) SG.createGroup(subStore, gname);
      saveSub();
      input.value = '';
      btn.disabled = true;
      ensureSidebar();
      renderOpenPanel();
    };
    btn.addEventListener('click', create);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        create();
      }
    });
    wrap.appendChild(input);
    wrap.appendChild(btn);
    return wrap;
  }

  function mkAllSubsManualAdd() {
    var wrap = document.createElement('div');
    wrap.className = 'un-hub-panel-manualadd';
    if (!allSubsManualOpen) {
      var link = document.createElement('button');
      link.type = 'button';
      link.className = 'un-hub-inline-link';
      link.textContent = 'Not subscribed on YouTube? Paste a URL/handle';
      link.addEventListener('click', function () {
        allSubsManualOpen = true;
        renderOpenPanel();
      });
      wrap.appendChild(link);
      return wrap;
    }
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'un-hub-panel-newgroup-input';
    input.placeholder = '@handle or channel URL';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'un-hub-panel-btn ghost';
    addBtn.textContent = 'Add to list';
    var doAdd = function () {
      var parsed = SG.parseChannelInput(input.value);
      if (!parsed) return;
      var already = (subscribedChannels || [])
        .map(function (s) {
          return SG.handleKey(s.handle) || 'channel:' + s.channelId;
        })
        .concat(manualSubExtras.map(function (m) { return m.key; }))
        .indexOf(parsed.key) !== -1;
      if (!already) manualSubExtras.push({ key: parsed.key, title: parsed.label || parsed.key, thumb: '' });
      allSubsManualOpen = false;
      input.value = '';
      renderOpenPanel();
    };
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        doAdd();
      }
    });
    wrap.appendChild(input);
    wrap.appendChild(addBtn);
    return wrap;
  }

  // ---- full-page video feed (Suggested / News / Discover) ----
  //
  // The narrow #un-hub-panel dialog (channel/text-link list) is what
  // "Suggested" and "News" used to open — reported as feeling like a
  // side-panel channel manager rather than an actual page of videos. This is
  // a separate, full-viewport overlay: real thumbnail tiles, laid out like a
  // YouTube feed, anchored below the masthead so it reads as a destination
  // rather than a dialog. Kept as an overlay (not a real navigation that
  // swaps YouTube's own #content) because fighting Polymer's page router for
  // ownership of its own DOM is a losing, fragile position — this achieves
  // the same "feels like a real page" result without it.
  var feedPageKind = null;
  var feedPageTitle = '';
  var feedPageItems = [];
  var feedPageFilter = 'all';
  var feedPageSearch = '';
  var feedEscHandle = null;
  // Catch-up digest state. `catchUpGroup` doubles as "the feed page currently
  // showing a digest" so the toolbar can render the day-window controls only
  // for that kind, and re-run buildDigest when the window changes.
  var catchUpGroup = '';
  var catchUpPrefs = { days: 7, includeShorts: false, fillMinutes: 90 };
  // Every tile seen on any feed surface, keyed by video id, with the age and
  // duration scraped at the time. The digest cannot query YouTube for a
  // channel's uploads (no new network dependency, by design), so it answers
  // "what did I miss" from the tiles that have actually rendered — the same
  // approach Suggested/News/Discover already take. Persisted so a digest
  // opened on a watch page can still see what the subscriptions feed showed.
  var catchUpSeen = {};
  // The 'watchedVideos' set watch-history.js maintains — the single definition
  // of "watched" in this codebase (see sub-manager.js's note about the two
  // rival definitions that used to disagree). The digest excludes these.
  var watchedIds = [];

  function navigateYouTube(url) {
    if (!url) return;
    var targetPath = url.split('?')[0];
    var currentPath = location.pathname;
    if (targetPath === currentPath && url.indexOf('?') === -1) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Try native YouTube guide link / nav links first for instant SPA transition
    var guideLink =
      (YD && YD.guideEntryLinkByHref && document.querySelector(YD.guideEntryLinkByHref(url))) ||
      (YD && YD.guideEntryLinkByHref && document.querySelector(YD.guideEntryLinkByHref(targetPath))) ||
      document.querySelector('a[href="' + url + '"]') ||
      document.querySelector('a[href="' + targetPath + '"]');
    if (guideLink && typeof guideLink.click === 'function') {
      guideLink.click();
      return;
    }
    try {
      if (window.history && window.history.pushState) {
        window.history.pushState({}, '', url);
        window.dispatchEvent(new CustomEvent('yt-navigate-start'));
        window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
        return;
      }
    } catch (e) {
      /* fallback */
    }
    location.assign(url);
  }

  function ensureFeedPageShell() {
    var root = document.getElementById('un-hub-feedpage');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'un-hub-feedpage';
    root.hidden = true;

    var head = document.createElement('div');
    head.className = 'un-hub-feedpage-head';

    var headLeft = document.createElement('div');
    headLeft.className = 'un-hub-feedpage-head-left';

    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'un-hub-feedpage-back';
    back.setAttribute('aria-label', 'Back');
    back.textContent = '←';
    back.title = 'Back to YouTube';
    back.addEventListener('click', closeFeedPage);

    var headText = document.createElement('div');
    headText.className = 'un-hub-feedpage-head-text';
    var titleEl = document.createElement('h1');
    titleEl.className = 'un-hub-feedpage-title';
    var subEl = document.createElement('span');
    subEl.className = 'un-hub-feedpage-sub';
    headText.appendChild(titleEl);
    headText.appendChild(subEl);

    headLeft.appendChild(back);
    headLeft.appendChild(headText);
    head.appendChild(headLeft);

    var toolbar = document.createElement('div');
    toolbar.className = 'un-hub-feedpage-toolbar';

    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'un-hub-feedpage-search';
    search.placeholder = 'Filter matched videos…';
    search.addEventListener('input', function () {
      feedPageSearch = search.value.trim().toLowerCase();
      renderFeedPage();
    });

    var filters = document.createElement('div');
    filters.className = 'un-hub-feedpage-filters';

    var pillAll = document.createElement('button');
    pillAll.type = 'button';
    pillAll.className = 'un-hub-feedpage-filter-pill' + (feedPageFilter === 'all' ? ' active' : '');
    pillAll.textContent = 'All Matches';
    pillAll.addEventListener('click', function () {
      feedPageFilter = 'all';
      renderFeedPage();
    });

    var pillHigh = document.createElement('button');
    pillHigh.type = 'button';
    pillHigh.className = 'un-hub-feedpage-filter-pill' + (feedPageFilter === 'high' ? ' active' : '');
    pillHigh.textContent = '★ Top Match (80%+)';
    pillHigh.addEventListener('click', function () {
      feedPageFilter = 'high';
      renderFeedPage();
    });

    filters.appendChild(pillAll);
    filters.appendChild(pillHigh);

    toolbar.appendChild(search);
    toolbar.appendChild(filters);
    head.appendChild(toolbar);

    // Catch-up-only controls. Built once and hidden for the other feed-page
    // kinds rather than given their own shell — reusing #un-hub-feedpage was
    // the point, and a second shell would need its own Escape registration,
    // z-index slot and dismissal.
    head.appendChild(mkCatchUpControls());

    var grid = document.createElement('div');
    grid.className = 'un-hub-feedpage-grid';

    root.appendChild(head);
    root.appendChild(grid);
    document.body.appendChild(root);
    return root;
  }

  function feedThumbUrl(videoId) {
    return 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/mqdefault.jpg';
  }

  function saveCatchUpPrefs() {
    chrome.storage.local.set({ catchUp: catchUpPrefs });
  }

  var CATCHUP_WINDOWS = [1, 3, 7, 14, 30];

  /** Day-window pills + the Shorts switch + the queue-fill action. */
  function mkCatchUpControls() {
    var bar = document.createElement('div');
    bar.className = 'un-hub-catchup-bar';
    bar.hidden = true;

    var label = document.createElement('span');
    label.className = 'un-hub-catchup-label';
    label.textContent = 'Last';
    bar.appendChild(label);

    var pills = document.createElement('div');
    pills.className = 'un-hub-catchup-days';
    CATCHUP_WINDOWS.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'un-hub-catchup-day';
      b.dataset.days = String(n);
      b.textContent = n === 1 ? '24h' : n + 'd';
      b.title = 'Show uploads from the last ' + n + (n === 1 ? ' day' : ' days');
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', function () {
        catchUpPrefs.days = n;
        saveCatchUpPrefs();
        refreshCatchUp();
      });
      pills.appendChild(b);
    });
    bar.appendChild(pills);

    var shorts = document.createElement('button');
    shorts.type = 'button';
    shorts.className = 'un-hub-catchup-shorts';
    shorts.addEventListener('click', function () {
      catchUpPrefs.includeShorts = !catchUpPrefs.includeShorts;
      saveCatchUpPrefs();
      refreshCatchUp();
    });
    bar.appendChild(shorts);

    var spacer = document.createElement('span');
    spacer.className = 'un-hub-catchup-spacer';
    bar.appendChild(spacer);

    // The digest's whole point is that it is actionable. Handing the visible
    // list straight to the queue is the action, and it routes through
    // queue-advance's fill so the cap, the undo and the count are the ones
    // already tested rather than a second implementation.
    var fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'un-hub-catchup-fill';
    fill.textContent = '⊕ Fill queue';
    fill.title = 'Add these to your watch queue';
    fill.setAttribute('aria-label', fill.title);
    fill.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!window.UNQueueFill || !window.UNQueueFill.openMenu) return;
      window.UNQueueFill.openMenu(fill, {
        items: visibleCatchUpItems(),
        source: catchUpGroup,
        budgetMin: catchUpPrefs.fillMinutes,
        onBudgetChange: function (min) {
          catchUpPrefs.fillMinutes = min;
          saveCatchUpPrefs();
        }
      });
    });
    bar.appendChild(fill);

    return bar;
  }

  function syncCatchUpControls(root, visibleCount) {
    var bar = root.querySelector('.un-hub-catchup-bar');
    if (!bar) return;
    var on = feedPageKind === 'catchup';
    bar.hidden = !on;
    if (!on) return;
    bar.querySelectorAll('.un-hub-catchup-day').forEach(function (b) {
      b.classList.toggle('active', Number(b.dataset.days) === catchUpPrefs.days);
    });
    var shorts = bar.querySelector('.un-hub-catchup-shorts');
    if (shorts) {
      shorts.classList.toggle('active', !!catchUpPrefs.includeShorts);
      shorts.textContent = catchUpPrefs.includeShorts ? '▶ Shorts: on' : '▶ Shorts: off';
      shorts.title = catchUpPrefs.includeShorts ? 'Hide Shorts from the digest' : 'Include Shorts in the digest';
      shorts.setAttribute('aria-label', shorts.title);
    }
    var fill = bar.querySelector('.un-hub-catchup-fill');
    if (fill) {
      fill.disabled = !visibleCount;
      fill.title = visibleCount ? 'Add these ' + visibleCount + ' to your watch queue' : 'Nothing to add';
      fill.setAttribute('aria-label', fill.title);
    }
  }

  /** What the grid is currently showing — the same filter renderFeedPage applies. */
  function visibleCatchUpItems() {
    return (feedPageItems || []).filter(function (v) {
      if (!feedPageSearch) return true;
      var t = (v.title || '').toLowerCase();
      var ch = (v.channelName || '').toLowerCase();
      return t.indexOf(feedPageSearch) !== -1 || ch.indexOf(feedPageSearch) !== -1;
    });
  }

  /**
   * Build (or rebuild) the digest for the currently open folder.
   *
   * All the deciding happens in src/shared/catch-up.js — this only supplies the
   * inputs and renders the answer, so the ranking, the day window and the
   * watched exclusion stay unit-tested rather than living in a 4000-line DOM
   * module.
   */
  function refreshCatchUp() {
    if (!CU || !catchUpGroup) return;
    var result = CU.buildDigest({
      store: subStore,
      group: catchUpGroup,
      candidates: catchUpCandidates(),
      watchedIds: watchedIds,
      days: catchUpPrefs.days,
      includeShorts: catchUpPrefs.includeShorts,
      profile: tasteProfile
    });
    feedPageItems = result.items;
    catchUpRanking = result.ranking;
    catchUpCoverage = result;
    renderFeedPage();
  }

  var catchUpRanking = 'recency';
  var catchUpCoverage = null;

  /**
   * Say what the number means and how it was ordered.
   *
   * The ranking word is not decoration. When there is no taste profile the
   * digest is ordered by recency, and claiming it is personalised would be a
   * lie the user cannot check — so the subtitle names whichever one actually
   * ran, straight from buildDigest's own report.
   */
  function catchUpSubtitle(visibleCount) {
    if (!visibleCount) return '';
    var days = catchUpPrefs.days;
    var parts = [
      visibleCount + (visibleCount === 1 ? ' unwatched upload' : ' unwatched uploads'),
      'last ' + days + (days === 1 ? ' day' : ' days')
    ];
    if (catchUpCoverage && catchUpCoverage.groupChannels) {
      parts.push('from ' + catchUpCoverage.channelsSeen + ' of ' + catchUpCoverage.groupChannels + ' channels');
    }
    parts.push(catchUpRanking === 'taste' ? 'ranked by what you watch' : 'newest first');
    if (feedPageSearch) parts.push('filtered by "' + feedPageSearch + '"');
    return parts.join(' · ');
  }

  function openCatchUpDigest(name) {
    catchUpGroup = name;
    openFeedPage('catchup', name, []);
    refreshCatchUp();
  }

  function renderFeedPage() {
    if (!feedPageKind) return;
    var root = ensureFeedPageShell();
    var titleEl = root.querySelector('.un-hub-feedpage-title');
    var subEl = root.querySelector('.un-hub-feedpage-sub');
    var grid = root.querySelector('.un-hub-feedpage-grid');
    if (!titleEl || !subEl || !grid) return;

    // One icon set (DESIGN-STANDARD 11): a line icon, not ★ 📰 ⏱ ✦ glyphs.
    var kindIco = feedPageKind === 'suggested' ? 'suggest' : feedPageKind === 'news' ? 'news' : feedPageKind === 'catchup' ? 'clock' : 'discover';
    titleEl.textContent = '';
    titleEl.append(unIco(kindIco), labelSpan(feedPageKind === 'catchup' ? 'Catch up: ' + feedPageTitle : feedPageTitle));

    var searchInput = root.querySelector('.un-hub-feedpage-search');
    if (searchInput && document.activeElement !== searchInput) {
      searchInput.value = feedPageSearch || '';
    }

    var filterPills = root.querySelectorAll('.un-hub-feedpage-filter-pill');
    if (filterPills.length >= 2) {
      filterPills[0].classList.toggle('active', feedPageFilter === 'all');
      filterPills[1].classList.toggle('active', feedPageFilter === 'high');
      // The "80%+ match" pill is a taste-score filter. A digest ranked by
      // recency has no such scores, so leaving the pill live would offer a
      // control that silently empties the page.
      var scored = feedPageKind !== 'catchup' || catchUpRanking === 'taste';
      filterPills[1].hidden = !scored;
      if (!scored && feedPageFilter === 'high') feedPageFilter = 'all';
    }

    var visible = (feedPageItems || []).filter(function (v) {
      if (feedPageFilter === 'high' && (v.score || 0) < 80) return false;
      if (feedPageSearch) {
        var t = (v.title || '').toLowerCase();
        var ch = (v.channelName || '').toLowerCase();
        return t.indexOf(feedPageSearch) !== -1 || ch.indexOf(feedPageSearch) !== -1;
      }
      return true;
    });

    if (feedPageKind === 'catchup') {
      subEl.textContent = catchUpSubtitle(visible.length);
    } else {
      subEl.textContent = visible.length
        ? visible.length + (visible.length === 1 ? ' video matched' : ' videos matched') + (feedPageSearch ? ' for "' + feedPageSearch + '"' : '')
        : (feedPageItems.length ? 'No videos match your filter' : 'No matches yet');
    }
    syncCatchUpControls(root, visible.length);

    grid.textContent = '';
    if (!visible.length) {
      var empty = document.createElement('div');
      empty.className = 'un-hub-feedpage-empty';
      var emptyIcon = document.createElement('div');
      emptyIcon.className = 'un-hub-feedpage-empty-icon';
      emptyIcon.appendChild(unIco(feedPageKind === 'news' ? 'news' : feedPageKind === 'discover' ? 'discover' : feedPageKind === 'catchup' ? 'check' : 'suggest'));
      var emptyTitle = document.createElement('div');
      emptyTitle.className = 'un-hub-feedpage-empty-title';
      var emptyDesc = document.createElement('div');
      var emptyBtn = document.createElement('button');
      emptyBtn.type = 'button';
      emptyBtn.className = 'un-hub-feedpage-empty-btn';
      if (feedPageKind === 'catchup') {
        // Three genuinely different empty states, said plainly. Collapsing
        // them into one "nothing found" would hide the only one the user can
        // act on — an empty folder — behind two they cannot.
        var groupSize = ((subStore.groups || {})[catchUpGroup] || []).length;
        if (!groupSize) {
          emptyTitle.textContent = catchUpGroup + ' has no channels yet';
          emptyDesc.textContent = 'Add channels to this folder and their new uploads will show up here.';
          emptyBtn.textContent = 'Add channels';
          emptyBtn.addEventListener('click', function () {
            closeFeedPage();
            openSubGroupPanel(catchUpGroup, 'add');
          });
        } else if (feedPageSearch) {
          emptyTitle.textContent = 'Nothing matches "' + feedPageSearch + '"';
          emptyDesc.textContent = 'Clear the filter to see the whole digest.';
          emptyBtn.textContent = 'Clear filter';
          emptyBtn.addEventListener('click', function () {
            feedPageSearch = '';
            renderFeedPage();
          });
        } else {
          emptyTitle.textContent = "You're caught up on " + catchUpGroup;
          emptyDesc.textContent =
            CU.caughtUpLine(groupSize, catchUpPrefs.days) +
            ' Widen the window above, or open your Subscriptions feed so Unsynth can see more uploads.';
          emptyBtn.textContent = 'Open Subscriptions';
          emptyBtn.addEventListener('click', function () {
            closeFeedPage();
            navigateYouTube('/feed/subscriptions');
          });
        }
      } else {
        emptyTitle.textContent = feedPageItems.length ? 'No matching videos found' : 'Building your ' + feedPageTitle + ' feed';
        emptyDesc.textContent = feedPageItems.length
          ? 'Try clearing your search filter or selecting "All Matches".'
          : 'Browse YouTube Home with Unsynth enabled — it learns your taste automatically from videos you watch.';
        emptyBtn.textContent = 'Explore YouTube Home';
        emptyBtn.addEventListener('click', function () {
          closeFeedPage();
          navigateYouTube('/');
        });
      }
      empty.appendChild(emptyIcon);
      empty.appendChild(emptyTitle);
      empty.appendChild(emptyDesc);
      empty.appendChild(emptyBtn);
      grid.appendChild(empty);
      return;
    }

    visible.forEach(function (video) {
      var card = document.createElement('a');
      card.className = 'un-hub-feedpage-card';
      card.href = '/watch?v=' + encodeURIComponent(video.videoId);

      var thumbWrap = document.createElement('div');
      thumbWrap.className = 'un-hub-feedpage-thumb-wrap';
      var img = document.createElement('img');
      img.className = 'un-hub-feedpage-thumb';
      img.src = feedThumbUrl(video.videoId);
      img.alt = '';
      img.loading = 'lazy';
      thumbWrap.appendChild(img);

      if (video.score) {
        var score = document.createElement('span');
        score.className = 'un-hub-feedpage-score';
        score.textContent = '★ ' + video.score + '% match';
        thumbWrap.appendChild(score);
      }

      // Duration, in the corner YouTube puts it. Its absence was the single
      // most-missed thing on these pages — there was no way to tell a 40-second
      // clip from a two-hour stream before clicking.
      if (video.duration) {
        var dur = document.createElement('span');
        dur.className = 'un-hub-feedpage-duration';
        dur.textContent = video.duration;
        thumbWrap.appendChild(dur);
      }

      // Members-only content is worth calling out even when it is not being
      // filtered: it looks like any other video until you click it and hit a
      // paywall.
      if (isMembersOnlyVideo(video)) {
        var mem = document.createElement('span');
        mem.className = 'un-hub-feedpage-members';
        mem.textContent = 'Members only';
        thumbWrap.appendChild(mem);
      }

      var qBtn = document.createElement('button');
      qBtn.type = 'button';
      qBtn.className = 'un-hub-feedpage-quick-queue';
      qBtn.textContent = '+Q';
      qBtn.title = 'Add to Queue';
      qBtn.setAttribute('aria-label', qBtn.title);
      qBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var NQ = window.UNNativeQueue;
        if (NQ && NQ.add) {
          NQ.add([video.videoId], { toFront: false }).then(function (r) {
            if (window.UNSYNTH && window.UNSYNTH.toast) {
              window.UNSYNTH.toast(
                r && r.native
                  ? 'Added to YouTube queue: ' + (video.title || video.videoId)
                  : "Couldn't reach YouTube's queue"
              );
            }
          });
        }
      });
      // Hover actions. +Q was the only one, which meant the single thing you
      // could do with a bad recommendation was ignore it — and the taste
      // profile cannot tell "not interested" from "not seen yet", so ignoring
      // it teaches nothing and the same video comes back. These two are the
      // negative signal: one video, or the whole channel.
      var acts = document.createElement('div');
      acts.className = 'un-hub-feedpage-acts';

      function actBtn(label, title, handler) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'un-hub-feedpage-act';
        b.textContent = label;
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          handler();
        });
        return b;
      }

      acts.appendChild(
        actBtn('✕', 'Not interested — hide this video and stop suggesting it', function () {
          dismissFeedVideo(video, false);
        })
      );
      if (video.channelKey) {
        acts.appendChild(
          actBtn('⊘', 'Never suggest ' + (video.channelName || 'this channel') + ' again', function () {
            dismissFeedVideo(video, true);
          })
        );
      }
      thumbWrap.appendChild(acts);

      card.appendChild(qBtn);
      card.appendChild(thumbWrap);

      var metaRow = document.createElement('div');
      metaRow.className = 'un-hub-feedpage-meta-row';

      var avatar = document.createElement('div');
      avatar.className = 'un-hub-feedpage-avatar';
      var initial = (video.channelName || 'Y').charAt(0).toUpperCase();
      avatar.textContent = initial;
      metaRow.appendChild(avatar);

      var metaText = document.createElement('div');
      metaText.className = 'un-hub-feedpage-meta-text';

      var title = document.createElement('div');
      title.className = 'un-hub-feedpage-card-title';
      title.textContent = video.title || video.videoId;
      metaText.appendChild(title);

      // The creator, and a way to reach them. The whole card is an <a> to the
      // video, so this cannot be a nested <a> (invalid HTML, and browsers
      // unnest it unpredictably) — it is a button that navigates, which also
      // gives it a real keyboard stop and an accessible name.
      var ch = document.createElement('div');
      ch.className = 'un-hub-feedpage-card-channel';
      var chHref = channelHrefFromKey(video.channelKey);
      if (chHref) {
        var chBtn = document.createElement('button');
        chBtn.type = 'button';
        chBtn.className = 'un-hub-feedpage-channel-link';
        chBtn.textContent = video.channelName || 'YouTube';
        chBtn.title = 'Open ' + (video.channelName || 'this channel');
        chBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          navigateYouTube(chHref);
        });
        ch.appendChild(chBtn);
      } else {
        ch.textContent = video.channelName || 'YouTube';
      }
      metaText.appendChild(ch);

      // Views and upload age, the way YouTube writes them under its own tiles.
      // These pages showed a thumbnail, a title and a channel and nothing else,
      // so there was no way to tell a fresh upload from a five-year-old one, or
      // a video with 300 views from one with 3 million. The data was already on
      // the tiles being scraped; it was simply being discarded. Only rendered
      // when actually captured — a row of empty separators is worse than none.
      var bits = [];
      if (video.views) bits.push(video.views);
      if (video.age) bits.push(video.age);
      if (bits.length) {
        var stats = document.createElement('div');
        stats.className = 'un-hub-feedpage-card-stats';
        stats.textContent = bits.join(' · ');
        metaText.appendChild(stats);
      }

      // WHY this was suggested. The scorer produces human-readable reasons
      // ("You watch this channel (7 videos)", "Matches your interests: horror,
      // stories") and the builders store them on every row — but this render
      // read `video.reason`, singular, which nothing has ever set. The card
      // markup and its CSS were both already here, wired to a field name that
      // did not exist, so the whole feature was dead on both ends and every
      // card showed a bare "★ 81% match" with no evidence behind it.
      //
      // Two reasons is the useful ceiling: the first is almost always the
      // channel affinity and the second the topic overlap, which together say
      // everything. A third is filler and the row is line-clamped anyway.
      var why = Array.isArray(video.reasons) ? video.reasons.slice(0, 2).join(' · ') : video.reason;
      if (why) {
        var reason = document.createElement('div');
        reason.className = 'un-hub-feedpage-card-reason';
        reason.textContent = why;
        reason.title = Array.isArray(video.reasons) ? video.reasons.join('\n') : why;
        metaText.appendChild(reason);
      }

      metaRow.appendChild(metaText);
      card.appendChild(metaRow);
      grid.appendChild(card);
    });
  }

  function openFeedPage(kind, title, items) {
    closePopouts();
    closePanel();
    feedPageKind = kind;
    feedPageTitle = title;
    feedPageItems = (items || []).slice();
    feedPageFilter = 'all';
    feedPageSearch = '';
    var root = ensureFeedPageShell();
    root.hidden = false;
    document.documentElement.classList.add('un-hub-feedpage-open');
    if (!feedEscHandle) feedEscHandle = window.UNSYNTH.pushPanel(closeFeedPage);
    renderFeedPage();
  }

  function closeFeedPage() {
    var root = document.getElementById('un-hub-feedpage');
    if (root) root.hidden = true;
    document.documentElement.classList.remove('un-hub-feedpage-open');
    feedPageKind = null;
    feedPageTitle = '';
    feedPageItems = [];
    feedPageFilter = 'all';
    feedPageSearch = '';
    catchUpGroup = '';
    catchUpCoverage = null;
    catchUpRanking = 'recency';
    // The fill menu is anchored to a button inside this page. Leaving it open
    // over a closed feed page would strand a panel with no owner — and its
    // own Escape-stack entry above this one.
    if (window.UNQueueFill && window.UNQueueFill.closeMenu) window.UNQueueFill.closeMenu();
    if (feedEscHandle) { window.UNSYNTH.popPanel(feedEscHandle); feedEscHandle = null; }
  }

  function openPlFolderPanel(name) {
    closePopouts();
    openPanelKind = 'pl';
    openPanelName = name;
    panelFilterQuery = '';
    var root = ensurePanelShell();
    root.classList.remove('subs');
    root.classList.add('pl', 'open');
    root.hidden = false;
    if (!hubEscHandle) hubEscHandle = window.UNSYNTH.pushPanel(closePanel);
    renderOpenPanel();
    var search = root.querySelector('.un-hub-panel-search');
    if (search) {
      search.value = '';
      search.placeholder = 'Filter playlists… (Enter to add PL id/URL)';
      setTimeout(function () {
        search.focus();
      }, 80);
    }
  }

  function fetchAllPlaylists() {
    allPlaylistsLoading = true;
    renderOpenPanel();
    sendMsgWithTimeout(M_PLAYLISTS_MINE, {}, 20000, function (r) {
      allPlaylistsLoading = false;
      if (r && r.ok) {
        allPlaylists = r.playlists || [];
        allPlaylistsError = '';
      } else {
        allPlaylistsError = allPlaylists.length
          ? 'Refresh failed — showing your last loaded playlists.'
          : 'Connect YouTube on the dashboard to see your playlists here.';
      }
      renderOpenPanel();
    });
  }

  function openAllPlPanel() {
    closePopouts();
    openPanelKind = 'allpl';
    openPanelName = '';
    panelFilterQuery = '';
    allPlaylistsError = '';
    allPlManualOpen = false;
    manualPlExtras = [];
    var root = ensurePanelShell();
    root.classList.remove('subs');
    root.classList.add('pl', 'open');
    root.hidden = false;
    if (!hubEscHandle) hubEscHandle = window.UNSYNTH.pushPanel(closePanel);
    fetchAllPlaylists();
    renderOpenPanel();
    var search = root.querySelector('.un-hub-panel-search');
    if (search) {
      search.value = '';
      search.placeholder = 'Filter your playlists…';
      setTimeout(function () {
        search.focus();
      }, 80);
    }
  }

  function mkAllPlRow(item, folderNames) {
    var row = document.createElement('div');
    row.className = 'un-hub-panel-item pl';
    var thumb = document.createElement('span');
    thumb.className = 'un-hub-panel-plthumb';
    if (item.thumb) {
      var img = document.createElement('img');
      img.className = 'un-hub-panel-plthumb-img';
      img.loading = 'lazy';
      img.alt = '';
      img.src = item.thumb;
      thumb.appendChild(img);
    }
    row.appendChild(thumb);

    var meta = document.createElement('div');
    meta.className = 'un-hub-panel-plmeta';
    var link = document.createElement('a');
    link.className = 'un-hub-panel-link';
    link.href = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(item.id);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = item.title || item.id;
    link.title = item.id;
    meta.appendChild(link);
    if (item.count != null) {
      var count = document.createElement('span');
      count.className = 'un-hub-panel-plcount';
      count.textContent = item.count + ' video' + (item.count === 1 ? '' : 's');
      meta.appendChild(count);
    }
    row.appendChild(meta);

    var pin = document.createElement('button');
    pin.type = 'button';
    var pinned = PF.isPinned(plPins, item.id);
    pin.className = 'un-hub-panel-pin' + (pinned ? ' on' : '');
    pin.setAttribute('aria-label', pinned ? 'Unpin from sidebar' : 'Pin to sidebar');
    pin.appendChild(unIco('pin'));
    pin.addEventListener('click', function (e) {
      e.stopPropagation();
      if (PF.isPinned(plPins, item.id)) plPins = PF.unpinPlaylist(plPins, item.id);
      else plPins = PF.pinPlaylist(plPins, item.id, item.title);
      savePins();
      ensureSidebar();
      pin.classList.toggle('on');
      pin.setAttribute('aria-label', pin.classList.contains('on') ? 'Unpin from sidebar' : 'Pin to sidebar');
    });
    row.appendChild(pin);

    var chips = document.createElement('div');
    chips.className = 'un-hub-panel-chips';
    folderNames.forEach(function (fname) {
      var chip = document.createElement('button');
      chip.type = 'button';
      var on = (plStore.folders[fname] || []).indexOf(item.id) !== -1;
      chip.className = 'un-hub-panel-chip pl' + (on ? ' on' : '');
      chip.textContent = fname;
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        var nowOn = chip.classList.contains('on');
        if (nowOn) PF.removeFromFolder(plStore, fname, item.id);
        else PF.addToFolder(plStore, fname, item.id, item.title);
        savePl();
        ensureSidebar();
        chip.classList.toggle('on', !nowOn);
        chip.setAttribute('aria-pressed', !nowOn ? 'true' : 'false');
      });
      chips.appendChild(chip);
    });
    row.appendChild(chips);
    return row;
  }

  function mkAllPlManualAdd() {
    var wrap = document.createElement('div');
    wrap.className = 'un-hub-panel-manualadd';
    if (!allPlManualOpen) {
      var link = document.createElement('button');
      link.type = 'button';
      link.className = 'un-hub-inline-link';
      link.textContent = 'Have a playlist URL/ID not listed above? Paste it';
      link.addEventListener('click', function () {
        allPlManualOpen = true;
        renderOpenPanel();
      });
      wrap.appendChild(link);
      return wrap;
    }
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'un-hub-panel-newgroup-input';
    input.placeholder = 'Playlist URL or PL… id';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'un-hub-panel-btn ghost pl';
    addBtn.textContent = 'Add to list';
    var doAdd = function () {
      var plId = PF.parsePlaylistInput(input.value);
      if (!plId) return;
      var already = (allPlaylists || [])
        .concat(manualPlExtras)
        .some(function (p) {
          return p.id === plId;
        });
      if (!already) manualPlExtras.push({ id: plId, title: plId, count: null, thumb: '' });
      allPlManualOpen = false;
      input.value = '';
      renderOpenPanel();
    };
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        doAdd();
      }
    });
    wrap.appendChild(input);
    wrap.appendChild(addBtn);
    return wrap;
  }

  function mkPanelBtn(label, className, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'un-hub-panel-btn ' + (className || '');
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function openDashboard(hash) {
    if (core && core.openDashboard) {
      core.openDashboard(hash);
      return;
    }
    try {
      chrome.runtime.sendMessage({
        type: 'UNSYNTH/OPEN_EXT_PAGE',
        path: 'src/dashboard/dashboard.html',
        hash: String(hash || '').replace(/^#/, '')
      });
    } catch (e) {
      /* ignore */
    }
  }

  function mkPanelLink(label, hash) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'un-hub-panel-btn ghost';
    btn.textContent = label;
    btn.addEventListener('click', function () {
      openDashboard(hash);
    });
    return btn;
  }

  function mkDashBtn(label, hash) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'un-hub-pop-btn ghost';
    btn.textContent = label;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openDashboard(hash);
    });
    return btn;
  }

  function renderOpenPanel() {
    if (!panelOpen()) return;
    var root = ensurePanelShell();
    var title = root.querySelector('.un-hub-panel-title');
    var sub = root.querySelector('.un-hub-panel-sub');
    var tabsWrap = root.querySelector('.un-hub-panel-tabs');
    var search = root.querySelector('.un-hub-panel-search');
    var filtersWrap = root.querySelector('.un-hub-panel-filters');
    var list = root.querySelector('.un-hub-panel-list');
    var actions = root.querySelector('.un-hub-panel-actions');
    if (!title || !list || !actions) return;

    if (tabsWrap) { tabsWrap.textContent = ''; tabsWrap.hidden = true; }
    if (filtersWrap) { filtersWrap.textContent = ''; filtersWrap.hidden = true; }
    list.textContent = '';
    actions.textContent = '';
    var q = panelFilterQuery;

    if (openPanelKind === 'sub') {
      var name = openPanelName;
      var keys = subStore.groups[name] || [];
      var newN = groupNewCount(name);
      title.textContent = name;
      if (newN) {
        var badge = document.createElement('span');
        badge.className = 'un-hub-panel-new-badge';
        badge.textContent = String(newN) + ' new';
        title.appendChild(document.createTextNode(' '));
        title.appendChild(badge);
      }

      var subsList = getSubsList();
      var notInGroupList = subsList.filter(function (s) {
        return !isSubInGroup(name, s.key);
      });
      var unassignedSubs = subsList.filter(function (s) {
        return SG.groupsForChannel(subStore, s.key).length === 0;
      });

      if (tabsWrap) {
        tabsWrap.hidden = false;
        var tabCurrent = document.createElement('button');
        tabCurrent.type = 'button';
        tabCurrent.className = 'un-hub-panel-tab' + (openPanelSubTab === 'current' ? ' active' : '');
        tabCurrent.textContent = 'In Group (' + keys.length + ')';
        tabCurrent.addEventListener('click', function () {
          openPanelSubTab = 'current';
          panelFilterQuery = '';
          if (search) {
            search.value = '';
            search.placeholder = 'Filter channels in ' + name + '… (Enter to add @handle/URL)';
          }
          renderOpenPanel();
        });

        var tabAdd = document.createElement('button');
        tabAdd.type = 'button';
        tabAdd.className = 'un-hub-panel-tab' + (openPanelSubTab === 'add' ? ' active' : '');
        tabAdd.textContent = '＋ Add Channels';
        tabAdd.addEventListener('click', function () {
          openPanelSubTab = 'add';
          panelFilterQuery = '';
          if (search) {
            search.value = '';
            search.placeholder = 'Search subscriptions to add to ' + name + '…';
            setTimeout(function () { search.focus(); }, 50);
          }
          renderOpenPanel();
        });

        tabsWrap.appendChild(tabCurrent);
        tabsWrap.appendChild(tabAdd);
      }

      if (openPanelSubTab === 'current') {
        sub.textContent = keys.length
          ? keys.length + ' channel' + (keys.length === 1 ? '' : 's') + ' in group'
          : 'Empty group — browse or search to add channels';

        var visible = sortedSubKeys(keys).filter(function (key) {
          if (!q) return true;
          return channelLabel(key).toLowerCase().indexOf(q) !== -1 || key.toLowerCase().indexOf(q) !== -1;
        });

        if (!visible.length && !q) {
          var empty = document.createElement('div');
          empty.className = 'un-hub-panel-empty';
          empty.textContent = 'No channels in this group yet.';
          list.appendChild(empty);
          var browseBtn = document.createElement('button');
          browseBtn.type = 'button';
          browseBtn.className = 'un-hub-panel-btn primary';
          browseBtn.textContent = '＋ Browse Subscriptions to Add';
          browseBtn.addEventListener('click', function () {
            openPanelSubTab = 'add';
            renderOpenPanel();
          });
          list.appendChild(browseBtn);
        } else if (!visible.length && q) {
          var noMatch = document.createElement('div');
          noMatch.className = 'un-hub-panel-empty';
          noMatch.textContent = 'No channels in this group match "' + q + '".';
          list.appendChild(noMatch);
        }

        visible.forEach(function (key) {
          var isNew = hasNewVideo(key);
          var item = document.createElement('div');
          item.className = 'un-hub-panel-item' + (isNew ? ' has-new' : '');
          var avatar = mkChannelAvatar(key);
          item.appendChild(avatar);
          if (isNew) {
            var dot = document.createElement('span');
            dot.className = 'un-hub-panel-dot';
            dot.title = 'New upload since last viewed';
            item.appendChild(dot);
          }

          var meta = document.createElement('div');
          meta.className = 'un-hub-panel-item-meta';
          var link = document.createElement('a');
          link.className = 'un-hub-panel-link';
          link.href = channelHref(key);
          link.setAttribute('data-ch-key', key);
          link.textContent = displayChannelLabel(key);
          link.title = key;
          meta.appendChild(link);

          var otherGroups = SG.groupsForChannel(subStore, key).filter(function (g) {
            return g !== name;
          });
          var subParts = [];
          if (key && key.charAt(0) === '@') subParts.push(key);
          if (otherGroups.length) subParts.push('Also in: ' + otherGroups.join(', '));
          if (subParts.length) {
            var subEl = document.createElement('span');
            subEl.className = 'un-hub-panel-item-sub';
            subEl.textContent = subParts.join(' • ');
            meta.appendChild(subEl);
          }
          item.appendChild(meta);

          if (isNew) {
            var seenBtn = document.createElement('button');
            seenBtn.type = 'button';
            seenBtn.className = 'un-hub-panel-seen';
            seenBtn.textContent = '✓';
            seenBtn.title = 'Mark as seen';
            seenBtn.setAttribute('aria-label', 'Mark as seen');
            seenBtn.addEventListener('click', function (e) {
              e.preventDefault();
              markChannelSeen(key);
              renderOpenPanel();
            });
            item.appendChild(seenBtn);
          }
          var rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'un-hub-panel-rm';
          rm.textContent = '×';
          rm.title = 'Remove from ' + name;
          rm.setAttribute('aria-label', 'Remove from ' + name);
          rm.addEventListener('click', function (e) {
            e.preventDefault();
            SG.removeFromGroup(subStore, name, key);
            saveSub();
            ensureSidebar();
            renderOpenPanel();
          });
          item.appendChild(rm);
          list.appendChild(item);
        });

        if (q) {
          var nonGroupMatches = subsList.filter(function (s) {
            if (isSubInGroup(name, s.key)) return false;
            return s.title.toLowerCase().indexOf(q) !== -1 || s.key.toLowerCase().indexOf(q) !== -1;
          });
          if (nonGroupMatches.length) {
            var secTitle = document.createElement('div');
            secTitle.className = 'un-hub-panel-section-title';
            secTitle.textContent = 'From your subscriptions (' + nonGroupMatches.length + ' matching — click ＋ to add):';
            list.appendChild(secTitle);
            nonGroupMatches.slice(0, 15).forEach(function (s) {
              list.appendChild(mkSubSingleAddRow(s, name));
            });
          }

          var parsed = SG.parseChannelInput(q);
          if (parsed && !isSubInGroup(name, parsed.key)) {
            var quickAddWrap = document.createElement('div');
            quickAddWrap.className = 'un-hub-panel-quick-add';
            var quickAddBtn = document.createElement('button');
            quickAddBtn.type = 'button';
            quickAddBtn.className = 'un-hub-panel-btn ghost';
            quickAddBtn.textContent = '＋ Add "' + (parsed.label || parsed.key) + '" to ' + name;
            quickAddBtn.addEventListener('click', function () {
              SG.addToGroup(subStore, name, parsed.key, parsed.label || parsed.key);
              saveSub();
              if (search) search.value = '';
              panelFilterQuery = '';
              ensureSidebar();
              renderOpenPanel();
            });
            quickAddWrap.appendChild(quickAddBtn);
            list.appendChild(quickAddWrap);
          }
        }

        var addMoreBtn = mkPanelBtn('＋ Add channels', 'ghost', function () {
          openPanelSubTab = 'add';
          renderOpenPanel();
        });
        actions.appendChild(addMoreBtn);

        if (newN) {
          actions.appendChild(
            mkPanelBtn('Mark all as seen', 'ghost', function () {
              markGroupSeen(name);
              renderOpenPanel();
            })
          );
        }
        actions.appendChild(
          mkPanelBtn('Show in Subscriptions feed', 'primary', function () {
            setSubActive(name);
            closePanel();
            ensureSidebar();
            if (!location.pathname.startsWith('/feed/subscriptions')) navigateYouTube('/feed/subscriptions');
          })
        );
        var homeBtn = document.createElement('button');
        homeBtn.type = 'button';
        var onHomeNow = isHomeGroup(name);
        homeBtn.className = 'un-hub-panel-btn ' + (onHomeNow ? 'primary' : 'ghost');
        homeBtn.textContent = onHomeNow ? '⌂ On home — remove' : '⌂ Show on home feed';
        homeBtn.addEventListener('click', function () {
          if (isHomeGroup(name)) setSubHome('', 'off');
          else setSubHome(name, 'both');
          ensureSidebar();
          renderOpenPanel();
        });
        actions.appendChild(homeBtn);
        actions.appendChild(mkPanelLink('Edit in dashboard', '#subs'));

      } else if (openPanelSubTab === 'add') {
        sub.textContent = 'Search or browse all subscriptions to add to ' + name;

        if (filtersWrap) {
          filtersWrap.hidden = false;
          var pillAll = document.createElement('button');
          pillAll.type = 'button';
          pillAll.className = 'un-hub-filter-pill' + (openSubsFilter === 'all' ? ' active' : '');
          pillAll.textContent = 'All (' + subsList.length + ')';
          pillAll.addEventListener('click', function () {
            openSubsFilter = 'all';
            renderOpenPanel();
          });

          var pillNotIn = document.createElement('button');
          pillNotIn.type = 'button';
          pillNotIn.className = 'un-hub-filter-pill' + (openSubsFilter === 'not_in_group' ? ' active' : '');
          pillNotIn.textContent = 'Not in this group (' + notInGroupList.length + ')';
          pillNotIn.addEventListener('click', function () {
            openSubsFilter = 'not_in_group';
            renderOpenPanel();
          });

          var pillUnassigned = document.createElement('button');
          pillUnassigned.type = 'button';
          pillUnassigned.className = 'un-hub-filter-pill' + (openSubsFilter === 'unassigned' ? ' active' : '');
          pillUnassigned.textContent = 'Unassigned (' + unassignedSubs.length + ')';
          pillUnassigned.addEventListener('click', function () {
            openSubsFilter = 'unassigned';
            renderOpenPanel();
          });

          filtersWrap.appendChild(pillAll);
          filtersWrap.appendChild(pillNotIn);
          filtersWrap.appendChild(pillUnassigned);
        }

        if (!subsList.length) {
          var noSubs = document.createElement('div');
          noSubs.className = 'un-hub-panel-empty';
          noSubs.textContent = 'Connect YouTube to browse your subscriptions here.';
          list.appendChild(noSubs);
          var connectBtn = document.createElement('button');
          connectBtn.type = 'button';
          connectBtn.className = 'un-hub-panel-btn primary';
          connectBtn.textContent = 'Connect YouTube';
          connectBtn.addEventListener('click', function () {
            openDashboard('#account');
          });
          list.appendChild(connectBtn);
        }

        var visibleSubs = subsList.filter(function (s) {
          if (openSubsFilter === 'not_in_group' && isSubInGroup(name, s.key)) return false;
          if (openSubsFilter === 'unassigned' && SG.groupsForChannel(subStore, s.key).length > 0) return false;
          if (q) {
            return s.title.toLowerCase().indexOf(q) !== -1 || s.key.toLowerCase().indexOf(q) !== -1;
          }
          return true;
        }).sort(function (a, b) {
          var aIn = isSubInGroup(name, a.key);
          var bIn = isSubInGroup(name, b.key);
          if (aIn !== bIn) return aIn ? 1 : -1;
          return a.title.localeCompare(b.title);
        });

        if (!visibleSubs.length && subsList.length) {
          var noMatchSubs = document.createElement('div');
          noMatchSubs.className = 'un-hub-panel-empty';
          noMatchSubs.textContent = 'No channels match your filter.';
          list.appendChild(noMatchSubs);
        }

        visibleSubs.forEach(function (s) {
          list.appendChild(mkSubSingleAddRow(s, name));
        });

        actions.appendChild(mkAllSubsManualAdd());
        actions.appendChild(
          mkPanelBtn('← View group channels', 'primary', function () {
            openPanelSubTab = 'current';
            renderOpenPanel();
          })
        );
        var refreshSubsBtn = mkPanelBtn(allSubsRefreshing ? 'Refreshing…' : 'Refresh from YouTube', 'ghost', function () {
          if (allSubsRefreshing) return;
          allSubsRefreshing = true;
          renderOpenPanel();
          sendMsgWithTimeout(M_SUBS_REFRESH, {}, 20000, function (r) {
            allSubsRefreshing = false;
            if (r && r.ok) {
              chrome.storage.local.get({ subscribedChannels: { items: [], updatedAt: 0 } }, function (d) {
                subscribedChannels = (d.subscribedChannels && d.subscribedChannels.items) || [];
                allSubsError = '';
                renderOpenPanel();
              });
            } else {
              allSubsError = 'Refresh failed — connect YouTube on the dashboard first.';
              renderOpenPanel();
            }
          });
        });
        refreshSubsBtn.disabled = allSubsRefreshing;
        actions.appendChild(refreshSubsBtn);
      }
    } else if (openPanelKind === 'allsubs') {
      title.textContent = 'Add channels';
      var groupNames = Object.keys(subStore.groups || {});
      var subsListAll = getSubsList();
      var unassignedSubsAll = subsListAll.filter(function (s) {
        return SG.groupsForChannel(subStore, s.key).length === 0;
      });
      sub.textContent = subsListAll.length
        ? subsListAll.length + ' subscription' + (subsListAll.length === 1 ? '' : 's') + ' loaded'
        : allSubsError || 'No subscriptions loaded yet';

      if (filtersWrap) {
        filtersWrap.hidden = false;
        var pAll = document.createElement('button');
        pAll.type = 'button';
        pAll.className = 'un-hub-filter-pill' + (openAllSubsFilter === 'all' ? ' active' : '');
        pAll.textContent = 'All (' + subsListAll.length + ')';
        pAll.addEventListener('click', function () {
          openAllSubsFilter = 'all';
          renderOpenPanel();
        });

        var pUnassigned = document.createElement('button');
        pUnassigned.type = 'button';
        pUnassigned.className = 'un-hub-filter-pill' + (openAllSubsFilter === 'unassigned' ? ' active' : '');
        pUnassigned.textContent = 'Unassigned only (' + unassignedSubsAll.length + ')';
        pUnassigned.addEventListener('click', function () {
          openAllSubsFilter = 'unassigned';
          renderOpenPanel();
        });

        filtersWrap.appendChild(pAll);
        filtersWrap.appendChild(pUnassigned);
      }

      if (allSubsError && subsListAll.length) {
        var subsErrorBanner = document.createElement('div');
        subsErrorBanner.className = 'un-hub-panel-error-banner';
        subsErrorBanner.textContent = allSubsError;
        list.appendChild(subsErrorBanner);
      }

      if (!subsListAll.length) {
        var noSubsAll = document.createElement('div');
        noSubsAll.className = 'un-hub-panel-empty';
        noSubsAll.textContent = 'Connect YouTube to browse your subscriptions here.';
        list.appendChild(noSubsAll);
        var connectBtnAll = document.createElement('button');
        connectBtnAll.type = 'button';
        connectBtnAll.className = 'un-hub-panel-btn primary';
        connectBtnAll.textContent = 'Connect YouTube';
        connectBtnAll.addEventListener('click', function () {
          openDashboard('#account');
        });
        list.appendChild(connectBtnAll);
      }

      var qsub = panelFilterQuery;
      var visibleSubsAll = subsListAll
        .filter(function (s) {
          if (openAllSubsFilter === 'unassigned' && SG.groupsForChannel(subStore, s.key).length > 0) return false;
          return !qsub || s.title.toLowerCase().indexOf(qsub) !== -1 || s.key.toLowerCase().indexOf(qsub) !== -1;
        })
        .sort(function (a, b) {
          return a.title.localeCompare(b.title);
        });
      visibleSubsAll.forEach(function (s) {
        list.appendChild(mkAllSubsRow(s, groupNames));
      });

      actions.appendChild(mkAllSubsNewGroup());
      actions.appendChild(mkAllSubsManualAdd());
      var refreshBtn = mkPanelBtn(allSubsRefreshing ? 'Refreshing…' : 'Refresh from YouTube', 'ghost', function () {
        if (allSubsRefreshing) return;
        allSubsRefreshing = true;
        renderOpenPanel();
        sendMsgWithTimeout(M_SUBS_REFRESH, {}, 20000, function (r) {
          allSubsRefreshing = false;
          if (r && r.ok) {
            chrome.storage.local.get({ subscribedChannels: { items: [], updatedAt: 0 } }, function (d) {
              subscribedChannels = (d.subscribedChannels && d.subscribedChannels.items) || [];
              allSubsError = '';
              renderOpenPanel();
            });
          } else {
            allSubsError = 'Refresh failed — connect YouTube on the dashboard first.';
            renderOpenPanel();
          }
        });
      });
      refreshBtn.disabled = allSubsRefreshing;
      actions.appendChild(refreshBtn);
    } else if (openPanelKind === 'pl') {
      var folder = openPanelName;
      var ids = plStore.folders[folder] || [];
      title.textContent = folder;

      var plItems = (allPlaylists || []).concat(manualPlExtras);
      var notInFolderList = plItems.filter(function (p) {
        return !isPlInFolder(folder, p.id);
      });
      var unassignedPls = plItems.filter(function (p) {
        return PF.foldersForPlaylist(plStore, p.id).length === 0;
      });

      if (tabsWrap) {
        tabsWrap.hidden = false;
        var tabPlCurrent = document.createElement('button');
        tabPlCurrent.type = 'button';
        tabPlCurrent.className = 'un-hub-panel-tab' + (openPanelPlTab === 'current' ? ' active' : '');
        tabPlCurrent.textContent = 'In Folder (' + ids.length + ')';
        tabPlCurrent.addEventListener('click', function () {
          openPanelPlTab = 'current';
          panelFilterQuery = '';
          if (search) {
            search.value = '';
            search.placeholder = 'Filter playlists in ' + folder + '… (Enter to add PL id/URL)';
          }
          renderOpenPanel();
        });

        var tabPlAdd = document.createElement('button');
        tabPlAdd.type = 'button';
        tabPlAdd.className = 'un-hub-panel-tab' + (openPanelPlTab === 'add' ? ' active' : '');
        tabPlAdd.textContent = '＋ Add Playlists';
        tabPlAdd.addEventListener('click', function () {
          openPanelPlTab = 'add';
          panelFilterQuery = '';
          if (search) {
            search.value = '';
            search.placeholder = 'Search playlists to add to ' + folder + '…';
            setTimeout(function () { search.focus(); }, 50);
          }
          if (!allPlaylists.length && !allPlaylistsLoading) {
            fetchAllPlaylists();
          }
          renderOpenPanel();
        });

        tabsWrap.appendChild(tabPlCurrent);
        tabsWrap.appendChild(tabPlAdd);
      }

      if (openPanelPlTab === 'current') {
        sub.textContent = ids.length
          ? ids.length + ' playlist' + (ids.length === 1 ? '' : 's') + ' in folder'
          : 'Empty folder — browse or search to add playlists';

        var plVisible = ids.filter(function (id) {
          if (!q) return true;
          var lbl = playlistLabel(id).toLowerCase();
          return lbl.indexOf(q) !== -1 || id.toLowerCase().indexOf(q) !== -1;
        });

        if (!plVisible.length && !q) {
          var plEmpty = document.createElement('div');
          plEmpty.className = 'un-hub-panel-empty';
          plEmpty.textContent = 'No playlists in this folder yet.';
          list.appendChild(plEmpty);
          var browsePlBtn = document.createElement('button');
          browsePlBtn.type = 'button';
          browsePlBtn.className = 'un-hub-panel-btn primary pl';
          browsePlBtn.textContent = '＋ Browse Playlists to Add';
          browsePlBtn.addEventListener('click', function () {
            openPanelPlTab = 'add';
            if (!allPlaylists.length && !allPlaylistsLoading) fetchAllPlaylists();
            renderOpenPanel();
          });
          list.appendChild(browsePlBtn);
        } else if (!plVisible.length && q) {
          var noMatchPl = document.createElement('div');
          noMatchPl.className = 'un-hub-panel-empty';
          noMatchPl.textContent = 'No playlists in this folder match "' + q + '".';
          list.appendChild(noMatchPl);
        }

        plVisible.forEach(function (id) {
          var item = document.createElement('div');
          item.className = 'un-hub-panel-item pl';
          var avatar = document.createElement('span');
          avatar.className = 'un-hub-panel-avatar pl';
          avatar.textContent = '▶';
          item.appendChild(avatar);

          var meta = document.createElement('div');
          meta.className = 'un-hub-panel-plmeta';
          var link = document.createElement('a');
          link.className = 'un-hub-panel-link';
          link.href = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(id);
          link.textContent = playlistLabel(id);
          link.title = id;
          meta.appendChild(link);
          item.appendChild(meta);

          var rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'un-hub-panel-rm';
          rm.textContent = '×';
          rm.title = 'Remove from ' + folder;
          rm.setAttribute('aria-label', 'Remove from ' + folder);
          rm.addEventListener('click', function (e) {
            e.preventDefault();
            plStore.folders[folder] = (plStore.folders[folder] || []).filter(function (x) {
              return x !== id;
            });
            savePl();
            ensureSidebar();
            renderOpenPanel();
          });
          item.appendChild(rm);
          list.appendChild(item);
        });

        if (q) {
          var nonFolderMatches = plItems.filter(function (p) {
            if (isPlInFolder(folder, p.id)) return false;
            return (p.title || '').toLowerCase().indexOf(q) !== -1 || p.id.toLowerCase().indexOf(q) !== -1;
          });
          if (nonFolderMatches.length) {
            var secPlTitle = document.createElement('div');
            secPlTitle.className = 'un-hub-panel-section-title pl';
            secPlTitle.textContent = 'From your playlists (' + nonFolderMatches.length + ' matching — click ＋ to add):';
            list.appendChild(secPlTitle);
            nonFolderMatches.slice(0, 15).forEach(function (p) {
              list.appendChild(mkPlSingleAddRow(p, folder));
            });
          }
        }

        var addMorePlBtn = mkPanelBtn('＋ Add playlists', 'ghost pl', function () {
          openPanelPlTab = 'add';
          if (!allPlaylists.length && !allPlaylistsLoading) fetchAllPlaylists();
          renderOpenPanel();
        });
        actions.appendChild(addMorePlBtn);

        actions.appendChild(
          mkPanelBtn('Show in Library', 'primary pl', function () {
            setPlActive(folder);
            closePanel();
            ensureSidebar();
            if (location.pathname !== '/feed/playlists') navigateYouTube('/feed/playlists');
          })
        );
        actions.appendChild(mkPanelLink('Edit in dashboard', '#playlists/pl-folders-section'));

      } else if (openPanelPlTab === 'add') {
        sub.textContent = allPlaylistsLoading
          ? 'Loading your playlists…'
          : 'Search or browse all playlists to add to ' + folder;

        if (filtersWrap) {
          filtersWrap.hidden = false;
          var pillPlAll = document.createElement('button');
          pillPlAll.type = 'button';
          pillPlAll.className = 'un-hub-filter-pill' + (openPlsFilter === 'all' ? ' active' : '');
          pillPlAll.textContent = 'All (' + plItems.length + ')';
          pillPlAll.addEventListener('click', function () {
            openPlsFilter = 'all';
            renderOpenPanel();
          });

          var pillPlNotIn = document.createElement('button');
          pillPlNotIn.type = 'button';
          pillPlNotIn.className = 'un-hub-filter-pill' + (openPlsFilter === 'not_in_folder' ? ' active' : '');
          pillPlNotIn.textContent = 'Not in this folder (' + notInFolderList.length + ')';
          pillPlNotIn.addEventListener('click', function () {
            openPlsFilter = 'not_in_folder';
            renderOpenPanel();
          });

          var pillPlUnassigned = document.createElement('button');
          pillPlUnassigned.type = 'button';
          pillPlUnassigned.className = 'un-hub-filter-pill' + (openPlsFilter === 'unassigned' ? ' active' : '');
          pillPlUnassigned.textContent = 'Unassigned (' + unassignedPls.length + ')';
          pillPlUnassigned.addEventListener('click', function () {
            openPlsFilter = 'unassigned';
            renderOpenPanel();
          });

          filtersWrap.appendChild(pillPlAll);
          filtersWrap.appendChild(pillPlNotIn);
          filtersWrap.appendChild(pillPlUnassigned);
        }

        if (!allPlaylistsLoading && !plItems.length) {
          var noPl = document.createElement('div');
          noPl.className = 'un-hub-panel-empty';
          noPl.textContent = allPlaylistsError || 'No playlists found.';
          list.appendChild(noPl);
          if (allPlaylistsError) {
            var connectPlBtn = document.createElement('button');
            connectPlBtn.type = 'button';
            connectPlBtn.className = 'un-hub-panel-btn primary pl';
            connectPlBtn.textContent = 'Connect YouTube';
            connectPlBtn.addEventListener('click', function () {
              openDashboard('#account');
            });
            list.appendChild(connectPlBtn);
          }
        }

        var visiblePlToAdd = plItems.filter(function (p) {
          if (openPlsFilter === 'not_in_folder' && isPlInFolder(folder, p.id)) return false;
          if (openPlsFilter === 'unassigned' && PF.foldersForPlaylist(plStore, p.id).length > 0) return false;
          if (q) {
            return (p.title || '').toLowerCase().indexOf(q) !== -1 || p.id.toLowerCase().indexOf(q) !== -1;
          }
          return true;
        }).sort(function (a, b) {
          var aIn = isPlInFolder(folder, a.id);
          var bIn = isPlInFolder(folder, b.id);
          if (aIn !== bIn) return aIn ? 1 : -1;
          return (a.title || '').localeCompare(b.title || '');
        });

        if (!visiblePlToAdd.length && plItems.length && !allPlaylistsLoading) {
          var noMatchPlToAdd = document.createElement('div');
          noMatchPlToAdd.className = 'un-hub-panel-empty';
          noMatchPlToAdd.textContent = 'No playlists match your filter.';
          list.appendChild(noMatchPlToAdd);
        }

        visiblePlToAdd.forEach(function (p) {
          list.appendChild(mkPlSingleAddRow(p, folder));
        });

        actions.appendChild(mkAllPlManualAdd());
        actions.appendChild(
          mkPanelBtn('← View folder playlists', 'primary pl', function () {
            openPanelPlTab = 'current';
            renderOpenPanel();
          })
        );
        var refreshPlBtn = mkPanelBtn(allPlaylistsLoading ? 'Refreshing…' : 'Refresh from YouTube', 'ghost pl', function () {
          if (!allPlaylistsLoading) fetchAllPlaylists();
        });
        refreshPlBtn.disabled = allPlaylistsLoading;
        actions.appendChild(refreshPlBtn);
      }
    } else if (openPanelKind === 'allpl') {
      title.textContent = 'Add playlists';
      var folderNames = plFolderNames();
      var plItemsAll = (allPlaylists || []).concat(manualPlExtras);
      sub.textContent = allPlaylistsLoading
        ? 'Loading your playlists…'
        : plItemsAll.length
          ? plItemsAll.length + ' playlist' + (plItemsAll.length === 1 ? '' : 's') + ' · ' + pinIds().length + ' pinned'
          : allPlaylistsError || 'No playlists found';

      if (!allPlaylistsLoading && allPlaylistsError && plItemsAll.length) {
        var plErrorBanner = document.createElement('div');
        plErrorBanner.className = 'un-hub-panel-error-banner';
        plErrorBanner.textContent = allPlaylistsError;
        list.appendChild(plErrorBanner);
      }

      if (!allPlaylistsLoading && !plItemsAll.length) {
        var noPlAll = document.createElement('div');
        noPlAll.className = 'un-hub-panel-empty';
        noPlAll.textContent = allPlaylistsError || 'No playlists found.';
        list.appendChild(noPlAll);
        if (allPlaylistsError) {
          var connectPlBtnAll = document.createElement('button');
          connectPlBtnAll.type = 'button';
          connectPlBtnAll.className = 'un-hub-panel-btn primary pl';
          connectPlBtnAll.textContent = 'Connect YouTube';
          connectPlBtnAll.addEventListener('click', function () {
            openDashboard('#account');
          });
          list.appendChild(connectPlBtnAll);
        }
      }

      var qpl = panelFilterQuery;
      var visiblePlAll = plItemsAll
        .filter(function (p) {
          return !qpl || (p.title || '').toLowerCase().indexOf(qpl) !== -1;
        })
        .sort(function (a, b) {
          return (a.title || '').localeCompare(b.title || '');
        });
      visiblePlAll.forEach(function (p) {
        list.appendChild(mkAllPlRow(p, folderNames));
      });

      actions.appendChild(mkAllPlManualAdd());
      var refreshPlBtnAll = mkPanelBtn(allPlaylistsLoading ? 'Refreshing…' : 'Refresh from YouTube', 'ghost pl', function () {
        if (!allPlaylistsLoading) fetchAllPlaylists();
      });
      refreshPlBtnAll.disabled = allPlaylistsLoading;
      actions.appendChild(refreshPlBtnAll);
    }
  }

  function mkRowShell(activeClass) {
    var row = document.createElement('div');
    row.className = 'un-hub-row' + (activeClass || '');
    return row;
  }

  function bindChevronPopout(row, chevBtn, pop) {
    chevBtn.setAttribute('aria-expanded', 'false');
    chevBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasOpen = pop.classList.contains('open');
      closePopouts();
      closePanel();
      if (!wasOpen) {
        enrichChannelNames();
        pop.classList.add('open');
        row.classList.add('expanded');
        chevBtn.setAttribute('aria-expanded', 'true');
        openPopout = pop;
        maybeScanFeed();
      }
    });
  }

  function sectionsEl() {
    var selectors = YD && YD.GUIDE_SECTIONS_HOST_SEL
      ? YD.GUIDE_SECTIONS_HOST_SEL.split(/\s*,\s*/)
      : ['#guide #sections'];
    var found = [];
    for (var i = 0; i < selectors.length; i++) {
      document.querySelectorAll(selectors[i]).forEach(function (el) {
        if (found.indexOf(el) === -1) found.push(el);
      });
    }
    if (found.length < 2) return found[0] || null;
    // YouTube can retain a hidden previous drawer alongside the live guide.
    // Prefer the rendered sections so the hub is not mounted into an orphan.
    for (var j = 0; j < found.length; j++) {
      var style = getComputedStyle(found[j]);
      if (style.display !== 'none' && style.visibility !== 'hidden' && found[j].getClientRects().length) {
        return found[j];
      }
    }
    return found[0];
  }

  function mountSidebarBox(box, sections) {
    if (!sections || !box) return;
    if (core && core.insertGuideBlock) {
      core.insertGuideBlock(sections, box);
      return;
    }
    var anchor =
      sections.querySelector(YD ? YD.GUIDE_SECTION_SEL : '#sections') ||
      sections.querySelector('tp-yt-paper-section') ||
      sections.querySelector(YD ? YD.GUIDE_ENTRY_PRIMARY : 'a');
    if (anchor) {
      var host = anchor.closest(YD ? YD.GUIDE_SECTION_SEL : '#sections') || anchor;
      host.insertAdjacentElement('afterend', box);
      return;
    }
    var first = sections.firstElementChild;
    if (first) sections.insertBefore(box, first);
    else sections.appendChild(box);
  }

  function plFolderNames() {
    return Object.keys(plStore.folders || {});
  }

  /** Folder names for the sidebar, honoring hideEmpty + sort prefs. */
  function plSidebarNames() {
    return PF && PF.sortedFolderNames ? PF.sortedFolderNames(plStore, plPrefs) : plFolderNames();
  }

  function pinIds() {
    return (plPins && plPins.ids) || [];
  }

  function plSectionEnabled() {
    // Always surface the Playlists block when the user has pins or folders —
    // never let a stray sidebar:false pref hide their pinned playlists.
    if (pinIds().length > 0 || plSidebarNames().length > 0) return true;
    if (plPrefs.sidebar === false) return false;
    if (core && core.isModuleEnabled({ moduleKey: 'playlistFolders' })) return true;
    return false;
  }

  function mkPlEmptyHint() {
    var hint = document.createElement('div');
    hint.className = 'un-hub-hint empty pl';
    hint.innerHTML =
      'No pinned playlists. Use <b>＋ Pin</b> on a playlist, or <button type="button" class="un-hub-inline-link">choose them</button>.';
    var dashLink = hint.querySelector('.un-hub-inline-link');
    if (dashLink) {
      dashLink.addEventListener('click', function (e) {
        e.preventDefault();
        openDashboard('#playlists/pl-folders-section');
      });
    }
    var actions = document.createElement('div');
    actions.className = 'un-hub-pl-empty-actions';
    var lib = document.createElement('button');
    lib.type = 'button';
    lib.className = 'un-hub-pl-quick-btn';
    lib.textContent = 'Open Library';
    lib.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (location.pathname !== '/feed/playlists') navigateYouTube('/feed/playlists');
    });
    actions.appendChild(lib);
    hint.appendChild(actions);
    return hint;
  }

  function mkPinnedPlaylistRow(plId) {
    var wrap = document.createElement('div');
    wrap.className = 'un-hub-row-wrap';
    var row = mkRowShell(' pl pin');
    var main = document.createElement('a');
    main.className = 'un-hub-row-main un-hub-row-link';
    main.href = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(plId);
    var label = document.createElement('span');
    label.className = 'un-hub-row-label';
    label.textContent = PF && PF.pinLabel ? PF.pinLabel(plPins, plId) : playlistLabel(plId) || plId;
    main.appendChild(label);
    main.title = plId;
    main.setAttribute('aria-label', main.title);

    var chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'un-hub-chev-btn';
    chev.setAttribute('aria-label', 'Playlist options: ' + label.textContent);
    chev.innerHTML = '<span class="un-hub-chev">▸</span>';

    row.appendChild(main);
    row.appendChild(chev);

    var pop = document.createElement('div');
    pop.className = 'un-hub-popout';
    var popHead = document.createElement('div');
    popHead.className = 'un-hub-pop-head';
    popHead.textContent = label.textContent;
    pop.appendChild(popHead);

    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'un-hub-pop-btn primary pl';
    openBtn.textContent = 'Open playlist';
    openBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      navigateYouTube('/playlist?list=' + encodeURIComponent(plId));
    });
    var unpinBtn = document.createElement('button');
    unpinBtn.type = 'button';
    unpinBtn.className = 'un-hub-pop-btn ghost pl';
    unpinBtn.textContent = 'Unpin from sidebar';
    unpinBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      plPins = PF.unpinPlaylist(plPins, plId);
      savePins();
      closePopouts();
      ensureSidebar();
    });
    var dash = mkDashBtn('Manage in dashboard', '#playlists/pl-folders-section');
    pop.appendChild(mkPopoutActions([openBtn, unpinBtn, dash]));
    bindChevronPopout(row, chev, pop);
    wrap.appendChild(row);
    wrap.appendChild(pop);
    return wrap;
  }

  function hubSignature() {
    var sg = Object.keys(subStore.groups || {})
      .map(function (g) {
        return g + ':' + (subStore.groups[g] || []).length + ':' + groupNewCount(g);
      })
      .join('|');
    var pins = pinIds()
      .map(function (id) {
        var label = PF && PF.pinLabel ? PF.pinLabel(plPins, id) : playlistLabel(id) || id;
        return id + ':' + label;
      })
      .join(',');
    var pg = plSidebarNames()
      .map(function (f) {
        return f + ':' + (plStore.folders[f] || []).length;
      })
      .join('|');
    var pp = plPrefs.sidebar + ',' + plPrefs.showAll + ',' + plPrefs.hideEmpty + ',' + plPrefs.sort;
    // Built-in list prefs must be part of the signature or toggling one in the
    // dashboard leaves the sidebar showing the old set until something else
    // happens to change the signature.
    pp += ',' + plPrefs.showHistory + ',' + plPrefs.showLiked + ',' + plPrefs.showWatchLater;
    // The built-in rows highlight the page you're currently on, so the
    // signature has to change when that changes — otherwise the rebuild is
    // skipped and the active row stays stuck on the previous page. Only the
    // pathname and the `list` id matter here: including the whole query string
    // would rebuild the entire sidebar on every ?v= change while browsing.
    var listId = (location.search.match(/[?&]list=([\w-]+)/) || [])[1] || '';
    var here = location.pathname + (listId ? '?list=' + listId : '');
    var suggestedCount = smartSuggestedVideos.length;
    var newsCount = smartNewsVideos.length;
    var discoverCount = smartVideos.length;
    return (
      'sub' + (subEnabled() ? 1 : 0) + '::' + sg + '::' + subActive + '::home' + subHomeMode + ':' + subHomeGroup + '::pins' + pins + '::pl' + plActive +
      '::smart' + suggestedCount + ':' + newsCount + ':' + discoverCount + '::' + pg + '::pp' + pp + '::at' + here + '::fg' + (forgeSectionEnabled() ? 1 : 0)
    );
  }

  /** Scrape every subscription link in the left guide for names + thumbs. */
  function syncNamesFromGuide() {
    var keysInGroups = {};
    Object.keys(subStore.groups || {}).forEach(function (g) {
      (subStore.groups[g] || []).forEach(function (k) {
        keysInGroups[k] = true;
        SG.keyForms(subStore, k).forEach(function (f) {
          keysInGroups[f] = true;
        });
      });
    });
    if (!Object.keys(keysInGroups).length) return false;

    var touched = false;
    var thumbTouched = false;
    var links = document.querySelectorAll(
      '#sections a[href*="/@"], #sections a[href*="/channel/"], #sections a[href*="/c/"], ' +
        (YD ? YD.GUIDE_ENTRY_ALL_LINKS_SEL : 'a[href]')
    );
    links.forEach(function (a) {
      var key = SG.channelKey(a.getAttribute('href'));
      if (!key) return;
      var forms = SG.keyForms(subStore, key);
      if (
        !forms.some(function (k) {
          return keysInGroups[k];
        })
      ) {
        return;
      }
      var t = a.querySelector('yt-formatted-string, #text');
      var name = (t ? t.textContent : a.textContent || '').trim();
      if (!name || name.length > 120) return;
      forms.forEach(function (k) {
        // Only persist a GENUINE resolution. Writing a name that is itself
        // unresolved (e.g. the bare @handle == key) leaves it "unresolved", so
        // the next scan rewrites + saves again → storage-write loop.
        if ((!subStore.names[k] || SG.isUnresolvedLabel(subStore.names[k], k)) && !SG.isUnresolvedLabel(name, k)) {
          subStore.names[k] = name;
          touched = true;
        }
      });
      if (SCT) {
        var entry = a.closest(YD ? YD.GUIDE_ENTRY_SEL : 'a');
        if (entry) {
          var url = SCT.thumbFromGuideEntry(entry);
          if (url && rememberThumb(key, url)) thumbTouched = true;
        }
      }
      if (key.indexOf('@') === 0) {
        var chLink = a.closest(YD ? YD.GUIDE_ENTRY_SEL : 'a');
        if (chLink) {
          var chA = chLink.querySelector('a[href*="/channel/"]');
          if (chA) {
            var chKey = SG.channelKey(chA.getAttribute('href'));
            if (chKey && chKey.indexOf('channel:') === 0) {
              SG.setAlias(subStore, key, chKey);
              if ((!subStore.names[chKey] || SG.isUnresolvedLabel(subStore.names[chKey], chKey)) && !SG.isUnresolvedLabel(name, chKey)) {
                subStore.names[chKey] = name;
                touched = true;
              }
            }
          }
        }
      }
    });
    if (touched) saveSub();
    if (thumbTouched) saveThumbs();
    return touched || thumbTouched;
  }

  function activeGroupList(act) {
    if (!act) return [];
    return String(act).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function tileInGroup(group, tile, nameSet) {
    var key = tileChannelKey(tile);
    if (key && SG && SG.inGroup(subStore, group, key)) return true;
    if (nameSet && SG) {
      var a =
        tile &&
        tile.querySelector &&
        (tile.querySelector(YD ? YD.TILE_CHANNEL_LINK_COMPACT_SEL : '#channel-name a[href]') ||
          tile.querySelector('a[href*="/@"]'));
      var rawName = a && (a.getAttribute('href') || '').indexOf('/watch') !== 0 ? (a.textContent || '').trim() : '';
      var nm = SG.normName ? SG.normName(rawName) : rawName.toLowerCase();
      if (nm && nameSet[nm]) return true;
    }
    return false;
  }

  function isGroupLive(groupName) {
    try {
      var tiles = document.querySelectorAll(YD ? YD.LIVE_FEED_TILE_SUBSET_SEL : 'a[href*="/watch"]');
      if (!tiles.length) return false;
      var nSet = SG && SG.groupNameSet ? SG.groupNameSet(subStore, groupName) : null;
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        var isLive = false;
        var overlays = t.querySelectorAll(YD ? YD.TILE_LIVE_OVERLAY_SEL : '#time-status');
        overlays.forEach(function (el) {
          var txt = (el.textContent || '').trim().toUpperCase();
          if (txt.indexOf('LIVE') !== -1 || txt.indexOf('STREAM') !== -1) isLive = true;
        });
        if (isLive && tileInGroup(groupName, t, nSet)) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function activateSubGroup(name, multi) {
    var cur = activeGroupList(subActive);
    var next = name;
    if (multi) {
      if (cur.indexOf(name) !== -1) {
        next = cur.filter(function (x) { return x !== name; }).join(',');
      } else {
        next = cur.concat([name]).join(',');
      }
    } else {
      next = (cur.length === 1 && cur[0] === name) ? '' : name;
    }
    setSubActive(next);
    closePopouts();
    closePanel();
    ensureSidebar();
    if (!location.pathname.startsWith('/feed/subscriptions')) {
      navigateYouTube('/feed/subscriptions');
    }
  }

  function watchVideoContext() {
    var WS = window.UNWatchStats;
    var id =
      WS && WS.videoIdFromUrl
        ? WS.videoIdFromUrl(location.pathname, location.search)
        : (function () {
            var m = location.search.match(/[?&]v=([^&]+)/);
            return m ? m[1] : null;
          })();
    if (!id) return null;
    var titleEl = document.querySelector(YD ? YD.WATCH_TITLE_HEADING_SEL : 'h1');
    var title = titleEl ? titleEl.textContent.trim() : '';
    // The NAME (yt-dom.watchChannelName): the first link match is the avatar.
    var channel = YD && YD.watchChannelName ? YD.watchChannelName() : '';
    return { id: id, title: title, channel: channel };
  }

  function mkForgeSection() {
    var sec = document.createElement('div');
    sec.className = 'un-hub-section un-hub-forge';

    var head = document.createElement('div');
    head.className = 'un-hub-forge-head';
    head.innerHTML = '<span class="un-hub-forge-ico">✦</span><span>Playlist Forge</span>';
    sec.appendChild(head);

    var taste = FL && FL.tasteOneLiner ? FL.tasteOneLiner(watchStats, searchStats) : null;
    var status = document.createElement('div');
    status.className = 'un-hub-forge-status';
    if (taste) {
      status.textContent = taste;
    } else {
      status.textContent = 'Sync watch history for taste-aware discovery.';
      status.classList.add('muted');
    }
    sec.appendChild(status);

    var syncLine = document.createElement('div');
    syncLine.className = 'un-hub-forge-sync';
    syncLine.textContent = FL && FL.formatSyncAge ? FL.formatSyncAge(forgeLastSync) : '';
    sec.appendChild(syncLine);

    var actions = document.createElement('div');
    actions.className = 'un-hub-forge-actions';

    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'un-hub-forge-btn primary';
    open.textContent = 'Open Forge panel';
    open.addEventListener('click', function (e) {
      e.preventDefault();
      if (FL && FL.openPanel) {
        FL.openPanel();
      } else if (window.UNForgeLink && window.UNForgeLink.openPanel) {
        window.UNForgeLink.openPanel();
      } else if (window.UNForge && window.UNForge.openPanel) {
        window.UNForge.openPanel();
      }
    });
    actions.appendChild(open);

    var site = document.createElement('a');
    site.className = 'un-hub-forge-btn';
    site.href = FL ? FL.forgeHome() : 'https://playlist-forge.vercel.app/';
    site.target = '_blank';
    site.rel = 'noopener';
    site.textContent = 'Forge site ↗';
    actions.appendChild(site);

    var searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'un-hub-forge-btn';
    searchBtn.textContent = 'Search playlists';
    searchBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.UNForge && window.UNForge.openSearch) {
        window.UNForge.openSearch('');
      } else if (FL && FL.forgeHome) {
        window.open(FL.forgeHome(), '_blank', 'noopener');
      }
    });
    actions.appendChild(searchBtn);

    var ctx = watchVideoContext();
    if (ctx) {
      var similar = document.createElement('button');
      similar.type = 'button';
      similar.className = 'un-hub-forge-btn';
      similar.textContent = 'Similar to this video';
      similar.title = ctx.title || ctx.id;
      similar.addEventListener('click', function (e) {
        e.preventDefault();
        if (window.UNForge && window.UNForge.openSimilar) {
          window.UNForge.openSimilar(ctx.id, ctx.title, ctx.channel);
        } else if (FL && FL.forgeSeed) {
          window.open(FL.forgeSeed(ctx.id, { title: ctx.title, auto: true }), '_blank', 'noopener');
        }
      });
      actions.appendChild(similar);
    }

    sec.appendChild(actions);
    return sec;
  }

  function mkPopoutActions(actions) {
    var bar = document.createElement('div');
    bar.className = 'un-hub-pop-actions';
    actions.forEach(function (a) {
      bar.appendChild(a);
    });
    return bar;
  }

  function mkSubGroupRow(name) {
    var keys = subStore.groups[name] || [];
    var newN = groupNewCount(name);
    var wrap = document.createElement('div');
    wrap.className = 'un-hub-row-wrap';

    var currentList = activeGroupList(subActive);
    var isRowActive = currentList.indexOf(name) !== -1;
    var row = mkRowShell(isRowActive ? ' on' : '');

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'un-hub-row-main';
    var ico = document.createElement('span');
    ico.className = 'un-hub-row-ico un-ico';
    ico.setAttribute('data-ico', 'folder');
    ico.setAttribute('aria-hidden', 'true');
    main.appendChild(ico);
    var label = document.createElement('span');
    label.className = 'un-hub-row-label';
    label.textContent = name;
    var count = document.createElement('span');
    count.className = 'un-hub-row-count';
    count.textContent = String(keys.length);
    main.appendChild(label);
    main.appendChild(count);
    if (isGroupLive(name)) {
      var liveBadge = document.createElement('span');
      liveBadge.className = 'un-hub-row-live';
      liveBadge.textContent = 'LIVE';
      liveBadge.title = 'A channel in this group is streaming live';
      main.appendChild(liveBadge);
    }
    if (newN) {
      var nb = document.createElement('span');
      nb.className = 'un-hub-row-new';
      nb.textContent = String(newN);
      nb.title = newN + ' channel(s) with new uploads';
      main.appendChild(nb);
    }
    if (isHomeGroup(name)) {
      var hb = document.createElement('span');
      hb.className = 'un-hub-row-home';
      hb.textContent = '⌂';
      hb.title = 'Pinned to your home feed';
      main.appendChild(hb);
    }
    main.addEventListener('click', function (e) {
      e.stopPropagation();
      activateSubGroup(name, e.ctrlKey || e.metaKey || e.shiftKey);
    });
    main.title = 'Click to filter (Ctrl/Cmd+Click to multi-select)';
    main.setAttribute('aria-label', main.title);

    var chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'un-hub-chev-btn';
    chev.setAttribute('aria-label', 'Quick peek: ' + name);
    chev.innerHTML = '<span class="un-hub-chev">▸</span>';

    row.appendChild(main);
    row.appendChild(chev);

    var pop = document.createElement('div');
    pop.className = 'un-hub-popout';

    var popHead = document.createElement('div');
    popHead.className = 'un-hub-pop-head';
    var popHeadTitle = document.createElement('span');
    popHeadTitle.className = 'un-hub-pop-head-title';
    popHeadTitle.textContent = keys.length
      ? name + (newN ? ' — ' + newN + ' new' : ' — ' + keys.length + ' channels')
      : name + ' — empty';
    var popAddBtn = document.createElement('button');
    popAddBtn.type = 'button';
    popAddBtn.className = 'un-hub-pop-add-btn';
    popAddBtn.textContent = '＋ Add';
    popAddBtn.title = 'Add channels to ' + name;
    popAddBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closePopouts();
      openSubGroupPanel(name, 'add');
    });
    popHead.appendChild(popHeadTitle);
    popHead.appendChild(popAddBtn);
    pop.appendChild(popHead);

    var list = document.createElement('div');
    list.className = 'un-hub-pop-list';

    if (keys.length > 5) {
      var popSearchWrap = document.createElement('div');
      popSearchWrap.className = 'un-hub-pop-search-wrap';
      var popSearch = document.createElement('input');
      popSearch.type = 'search';
      popSearch.className = 'un-hub-pop-search';
      popSearch.placeholder = 'Filter ' + name + '…';
      popSearch.addEventListener('click', function (e) { e.stopPropagation(); });
      popSearch.addEventListener('input', function (e) {
        e.stopPropagation();
        var pq = popSearch.value.trim().toLowerCase();
        list.querySelectorAll('.un-hub-pop-item').forEach(function (itemEl) {
          var chKey = itemEl.getAttribute('data-pop-key') || '';
          var chName = (itemEl.querySelector('.un-hub-pop-link') || {}).textContent || '';
          var match = !pq || chKey.toLowerCase().indexOf(pq) !== -1 || chName.toLowerCase().indexOf(pq) !== -1;
          itemEl.hidden = !match;
        });
      });
      popSearchWrap.appendChild(popSearch);
      pop.appendChild(popSearchWrap);
    }

    if (!keys.length) {
      var empty = document.createElement('div');
      empty.className = 'un-hub-pop-empty';
      empty.textContent = 'No channels yet. Click ＋ Add above to add channels.';
      list.appendChild(empty);
    }
    var sorted = sortedSubKeys(keys);
    sorted.forEach(function (key) {
      var isNew = hasNewVideo(key);
      var item = document.createElement('div');
      item.className = 'un-hub-pop-item' + (isNew ? ' has-new' : '');
      item.setAttribute('data-pop-key', key);
      item.appendChild(mkChannelAvatar(key, 'un-hub-panel-avatar un-hub-pop-avatar'));
      if (isNew) {
        var dot = document.createElement('span');
        dot.className = 'un-hub-pop-new';
        dot.title = 'New upload since last viewed';
        item.appendChild(dot);
      }
      var link = document.createElement('a');
      link.className = 'un-hub-pop-link';
      link.href = channelHref(key);
      link.setAttribute('data-ch-key', key);
      link.textContent = displayChannelLabel(key);
      link.title = key;
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'un-hub-pop-rm';
      rm.textContent = '×';
      rm.title = 'Remove from group';
      rm.setAttribute('aria-label', 'Remove from group');
      rm.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        SG.removeFromGroup(subStore, name, key);
        saveSub();
        item.remove();
        var remaining = list.querySelectorAll('.un-hub-pop-item').length;
        popHeadTitle.textContent = remaining
          ? name + ' — ' + remaining + ' channel' + (remaining === 1 ? '' : 's')
          : name + ' — empty';
        if (!remaining) {
          var emp = document.createElement('div');
          emp.className = 'un-hub-pop-empty';
          emp.textContent = 'No channels yet. Click ＋ Add above to add channels.';
          list.appendChild(emp);
        }
        var rowCountEl = row.querySelector('.un-hub-row-count');
        if (rowCountEl) rowCountEl.textContent = String(remaining);
      });
      if (isNew) {
        var seenBtn = document.createElement('button');
        seenBtn.type = 'button';
        seenBtn.className = 'un-hub-pop-seen';
        seenBtn.textContent = '✓';
        seenBtn.title = 'Mark as seen';
        seenBtn.setAttribute('aria-label', 'Mark as seen');
        seenBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          markChannelSeen(key);
          seenBtn.remove();
          item.classList.remove('has-new');
          var d = item.querySelector('.un-hub-pop-new');
          if (d) d.remove();
        });
        item.appendChild(link);
        item.appendChild(seenBtn);
      } else {
        item.appendChild(link);
      }
      item.appendChild(rm);
      list.appendChild(item);
    });
    pop.appendChild(list);

    var actions = [];
    if (newN) {
      var markBtn = document.createElement('button');
      markBtn.type = 'button';
      markBtn.className = 'un-hub-pop-btn ghost';
      markBtn.textContent = 'Mark all as seen';
      markBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        markGroupSeen(name);
        closePopouts();
        ensureSidebar();
      });
      actions.push(markBtn);
    }
    // "What did I miss in this folder" — the digest. Leads the action list
    // because with 606 subscriptions across three folders it is the question
    // the folders exist to answer; filtering the feed is the older, coarser
    // way to ask it.
    var catchUpBtn = document.createElement('button');
    catchUpBtn.type = 'button';
    catchUpBtn.className = 'un-hub-pop-btn primary';
    catchUpBtn.textContent = '⏱ Catch up on ' + name;
    catchUpBtn.title = 'Unwatched uploads from this folder over the last ' + catchUpPrefs.days + ' days';
    catchUpBtn.setAttribute('aria-label', catchUpBtn.title);
    catchUpBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closePopouts();
      openCatchUpDigest(name);
    });
    actions.push(catchUpBtn);

    var filterBtn = document.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className = 'un-hub-pop-btn ghost';
    filterBtn.textContent = 'Show in Subscriptions feed';
    filterBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      activateSubGroup(name);
    });
    var homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    var onHomeNow = isHomeGroup(name);
    homeBtn.className = 'un-hub-pop-btn ' + (onHomeNow ? 'on' : 'ghost');
    homeBtn.textContent = onHomeNow ? '⌂ On home — remove' : '⌂ Show on home feed';
    homeBtn.title = onHomeNow ? 'Stop surfacing this group on the home page' : 'Pin this group to the top of your home feed and filter home to it';
    homeBtn.setAttribute('aria-label', homeBtn.title);
    homeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (isHomeGroup(name)) setSubHome('', 'off');
      else setSubHome(name, 'both');
      closePopouts();
      ensureSidebar();
    });
    actions.push(homeBtn);
    var manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'un-hub-pop-btn ghost';
    manageBtn.textContent = 'Manage / ＋ Add channels';
    manageBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closePopouts();
      openSubGroupPanel(name);
    });
    var dash = mkDashBtn('Edit in dashboard', '#subs');
    actions.push(filterBtn, manageBtn, dash);
    pop.appendChild(mkPopoutActions(actions));

    bindChevronPopout(row, chev, pop);

    wrap.appendChild(row);
    wrap.appendChild(pop);
    return wrap;
  }

  function activatePlFolder(name) {
    setPlActive(name);
    closePopouts();
    closePanel();
    ensureSidebar();
    if (location.pathname !== '/feed/playlists') {
      location.assign('/feed/playlists');
    }
  }

  function mkPlFolderRow(name) {
    var ids = plStore.folders[name] || [];
    var wrap = document.createElement('div');
    wrap.className = 'un-hub-row-wrap';

    var row = mkRowShell(plActive === name ? ' on pl' : ' pl');

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'un-hub-row-main';
    var label = document.createElement('span');
    label.className = 'un-hub-row-label';
    label.textContent = name;
    var count = document.createElement('span');
    count.className = 'un-hub-row-count';
    count.textContent = String(ids.length);
    main.appendChild(label);
    main.appendChild(count);
    main.addEventListener('click', function (e) {
      e.stopPropagation();
      activatePlFolder(name);
    });
    main.title = 'Show only this folder in Library';
    main.setAttribute('aria-label', main.title);

    var chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'un-hub-chev-btn';
    chev.setAttribute('aria-label', 'Quick peek: ' + name);
    chev.innerHTML = '<span class="un-hub-chev">▸</span>';

    row.appendChild(main);
    row.appendChild(chev);

    var pop = document.createElement('div');
    pop.className = 'un-hub-popout';

    var popHead = document.createElement('div');
    popHead.className = 'un-hub-pop-head';
    var popHeadTitle = document.createElement('span');
    popHeadTitle.className = 'un-hub-pop-head-title';
    popHeadTitle.textContent = ids.length ? name + ' — ' + ids.length + ' playlists' : name + ' — empty';
    var popAddPlBtn = document.createElement('button');
    popAddPlBtn.type = 'button';
    popAddPlBtn.className = 'un-hub-pop-add-btn';
    popAddPlBtn.textContent = '＋ Add';
    popAddPlBtn.title = 'Add playlists to ' + name;
    popAddPlBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closePopouts();
      openPlFolderPanel(name, 'add');
    });
    popHead.appendChild(popHeadTitle);
    popHead.appendChild(popAddPlBtn);
    pop.appendChild(popHead);

    var list = document.createElement('div');
    list.className = 'un-hub-pop-list';

    if (ids.length > 5) {
      var popSearchWrap = document.createElement('div');
      popSearchWrap.className = 'un-hub-pop-search-wrap';
      var popSearch = document.createElement('input');
      popSearch.type = 'search';
      popSearch.className = 'un-hub-pop-search';
      popSearch.placeholder = 'Filter ' + name + '…';
      popSearch.addEventListener('click', function (e) { e.stopPropagation(); });
      popSearch.addEventListener('input', function (e) {
        e.stopPropagation();
        var pq = popSearch.value.trim().toLowerCase();
        list.querySelectorAll('.un-hub-pop-item').forEach(function (itemEl) {
          var plText = (itemEl.querySelector('.un-hub-pop-link') || {}).textContent || '';
          var match = !pq || plText.toLowerCase().indexOf(pq) !== -1;
          itemEl.hidden = !match;
        });
      });
      popSearchWrap.appendChild(popSearch);
      pop.appendChild(popSearchWrap);
    }

    if (!ids.length) {
      var empty = document.createElement('div');
      empty.className = 'un-hub-pop-empty';
      empty.textContent = 'No playlists in this folder yet. Click ＋ Add above to add playlists.';
      list.appendChild(empty);
    }
    ids.forEach(function (id) {
      var item = document.createElement('div');
      item.className = 'un-hub-pop-item';
      var link = document.createElement('a');
      link.className = 'un-hub-pop-link';
      link.href = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(id);
      link.textContent = playlistLabel(id);
      link.title = id;
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'un-hub-pop-rm';
      rm.textContent = '×';
      rm.title = 'Remove from folder';
      rm.setAttribute('aria-label', 'Remove from folder');
      rm.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        plStore.folders[name] = (plStore.folders[name] || []).filter(function (x) {
          return x !== id;
        });
        savePl();
        item.remove();
        var remaining = list.querySelectorAll('.un-hub-pop-item').length;
        popHeadTitle.textContent = remaining
          ? name + ' — ' + remaining + ' playlist' + (remaining === 1 ? '' : 's')
          : name + ' — empty';
        if (!remaining) {
          var emp = document.createElement('div');
          emp.className = 'un-hub-pop-empty';
          emp.textContent = 'No playlists in this folder yet. Click ＋ Add above to add playlists.';
          list.appendChild(emp);
        }
        var rowCountEl = row.querySelector('.un-hub-row-count');
        if (rowCountEl) rowCountEl.textContent = String(remaining);
      });
      item.appendChild(link);
      item.appendChild(rm);
      list.appendChild(item);
    });
    pop.appendChild(list);

    var filterBtn = document.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className = 'un-hub-pop-btn primary pl';
    filterBtn.textContent = 'Show in Library';
    filterBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      activatePlFolder(name);
    });
    var managePl = document.createElement('button');
    managePl.type = 'button';
    managePl.className = 'un-hub-pop-btn ghost pl';
    managePl.textContent = 'Manage / ＋ Add playlists';
    managePl.addEventListener('click', function (e) {
      e.stopPropagation();
      closePopouts();
      openPlFolderPanel(name);
    });
    var dash = mkDashBtn('Edit in dashboard', '#playlists/pl-folders-section');
    pop.appendChild(mkPopoutActions([filterBtn, managePl, dash]));

    bindChevronPopout(row, chev, pop);

    wrap.appendChild(row);
    wrap.appendChild(pop);
    return wrap;
  }

  function unIco(name) { var s = document.createElement('span'); s.className = 'un-ico'; s.setAttribute('data-ico', name); s.setAttribute('aria-hidden', 'true'); return s; }
  function labelSpan(text) { var s = document.createElement('span'); s.className = 'un-ico-label'; s.textContent = text; return s; }
  var HUB_ROW_ICONS = {
    'All subscriptions': 'subs',
    'Suggested': 'suggest',
    'News': 'news',
    'Discover': 'discover',
    'History': 'history',
    'Liked videos': 'liked',
    'Watch later': 'later',
    'All playlists': 'list'
  };

  function mkSimpleRow(label, count, active, onClick, icon) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'un-hub-row simple' + (active ? ' on' : '');
    // The "on" class is the only thing that told a sighted user this filter is
    // applied, so a screen reader announced the active row and the inactive
    // ones identically. aria-pressed makes the state part of the announcement.
    row.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (icon) {
      var ico = document.createElement('span');
      ico.className = 'un-hub-row-ico';
      // ONE ICON SET (2026-09-23). These rows used emoji and text glyphs —
      // a yellow 👍, 📰, 🕒 beside ✦ ★ ☰ — three visual languages in one
      // list, next to YouTube's own line icons (DESIGN-STANDARD §11). Known
      // rows get a line icon drawn by CSS from data-ico; anything else keeps
      // its glyph. Keyed by label because "✦" meant two different rows.
      var named = HUB_ROW_ICONS[label];
      if (named) {
        ico.setAttribute('data-ico', named);
        ico.setAttribute('aria-hidden', 'true');
      } else if (/^[a-z-]+$/.test(icon)) {
        // An icon NAME from the shared set (core.css .un-ico), never an emoji.
        ico.className += ' un-ico';
        ico.setAttribute('data-ico', icon);
        ico.setAttribute('aria-hidden', 'true');
      } else {
        ico.textContent = icon;
      }
      row.appendChild(ico);
    }
    var lbl = document.createElement('span');
    lbl.className = 'un-hub-row-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    if (count != null && count > 0) {
      var c = document.createElement('span');
      c.className = 'un-hub-row-count';
      c.textContent = String(count);
      row.appendChild(c);
    }
    row.addEventListener('click', function (e) {
      e.stopPropagation();
      closePopouts();
      onClick();
    });
    return row;
  }

  function updateSidebarActiveState() {
    var box = document.getElementById('un-sidebar-hub');
    if (!box) return;
    var currentGroups = activeGroupList(subActive);
    box.querySelectorAll('.un-hub-section.subs-hero .un-hub-row').forEach(function (row) {
      var label = row.querySelector('.un-hub-row-label');
      if (!label) return;
      var text = label.textContent.trim();
      if (text === 'All subscriptions') {
        row.classList.toggle('on', currentGroups.length === 0);
      } else if (subStore.groups && subStore.groups[text]) {
        row.classList.toggle('on', currentGroups.indexOf(text) !== -1);
      }
    });
    var listId = (location.search.match(/[?&]list=([\w-]+)/) || [])[1] || '';
    var onHistory = location.pathname.indexOf('/feed/history') === 0;
    var onLibrary = location.pathname === '/feed/playlists' || location.pathname.indexOf('/feed/library') === 0;
    box.querySelectorAll('.un-hub-section.pl-hero .un-hub-row').forEach(function (row) {
      var label = row.querySelector('.un-hub-row-label');
      if (!label) return;
      var text = label.textContent.trim();
      if (row.classList.contains('pl') && row.classList.contains('pin')) {
        var href = (row.querySelector('a.un-hub-row-link') && row.querySelector('a.un-hub-row-link').getAttribute('href')) || '';
        var pinList = (href.match(/[?&]list=([\w-]+)/) || [])[1] || '';
        row.classList.toggle('on', !!pinList && pinList === listId);
        return;
      }
      if (row.classList.contains('pl') && !row.classList.contains('simple')) {
        row.classList.toggle('on', !!plActive && text === plActive);
        return;
      }
      if (text === 'History') row.classList.toggle('on', onHistory);
      else if (text === 'Liked videos') row.classList.toggle('on', listId === 'LL');
      else if (text === 'Watch later') row.classList.toggle('on', listId === 'WL');
      else if (text === 'All playlists') row.classList.toggle('on', onLibrary && !plActive);
    });
  }

  var sidebarMountTimer = null;

  function ensureSidebar() {
    if (!enabled()) return;
    if (!subEnabled() && !plSectionEnabled() && !forgeSectionEnabled()) {
      var old = document.getElementById('un-sidebar-hub');
      if (old) old.remove();
      return;
    }
    var sections = sectionsEl();
    if (!sections) {
      if (!sidebarMountTimer) {
        sidebarMountTimer = setTimeout(function () {
          sidebarMountTimer = null;
          ensureSidebar();
        }, 1500);
      }
      return;
    }
    if (sidebarMountTimer) {
      clearTimeout(sidebarMountTimer);
      sidebarMountTimer = null;
    }

    var sig = hubSignature();
    var existing = document.getElementById('un-sidebar-hub');
    if (existing && sections.contains(existing)) {
      if (existing.dataset.sig === sig) return;
      var prevSig = existing.dataset.sig || '';
      var structuralSig = function (s) {
        return s.replace(/::sub[01]::/, '::').replace(/::pl[^:]+::/, '::').replace(/::at[^:]+::/, '::');
      };
      if (structuralSig(prevSig) === structuralSig(sig)) {
        updateSidebarActiveState();
        existing.dataset.sig = sig;
        return;
      }
    }
    if (existing) existing.remove();
    closePopouts();

    var box = document.createElement('div');
    box.id = 'un-sidebar-hub';
    box.dataset.sig = sig;

    var hasSection = false;
    if (subEnabled()) {
      var head = document.createElement('div');
      head.className = 'un-hub-brand';
      var headTitle = document.createElement('span');
      headTitle.className = 'un-hub-brand-title';
      headTitle.textContent = 'Subscriptions';
      head.appendChild(headTitle);

      var addChBtn = document.createElement('button');
      addChBtn.type = 'button';
      addChBtn.className = 'un-hub-brand-btn';
      addChBtn.textContent = '＋ Add channels';
      addChBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openAllSubsPanel();
      });
      head.appendChild(addChBtn);
      box.appendChild(head);

      var subSec = document.createElement('div');
      subSec.className = 'un-hub-section subs-hero';

      subSec.appendChild(
        mkSimpleRow('All subscriptions', null, !subActive, function () {
          setSubActive('');
          ensureSidebar();
          if (!location.pathname.startsWith('/feed/subscriptions')) navigateYouTube('/feed/subscriptions');
        }, '✦')
      );

      subSec.appendChild(
        mkSimpleRow('Suggested', smartSuggestedVideos.length, false, function () {
          openFeedPage('suggested', 'Suggested for you', smartSuggestedVideos);
        }, '★')
      );
      subSec.appendChild(
        mkSimpleRow('News', smartNewsVideos.length, false, function () {
          openFeedPage('news', 'News', smartNewsVideos);
        }, 'news')
      );
      subSec.appendChild(
        mkSimpleRow('Discover', smartVideos.length, false, function () {
          openFeedPage('discover', 'Discover', smartVideos);
        }, '✦')
      );

      Object.keys(subStore.groups || {}).forEach(function (name) {
        subSec.appendChild(mkSubGroupRow(name));
      });

      if (!Object.keys(subStore.groups || {}).length) {
        var hint = document.createElement('div');
        hint.className = 'un-hub-hint empty';
        // One quiet line, no box: the "＋ Add channels" button in this
        // section's header is the action; the hint only says what is missing.
        hint.innerHTML =
          'No groups yet. Use <b>＋ Group</b> on a channel, or <button type="button" class="un-hub-inline-link">set them up</button>.';
        var dashLink = hint.querySelector('.un-hub-inline-link');
        if (dashLink) {
          dashLink.addEventListener('click', function (e) {
            e.preventDefault();
            openDashboard('#subs');
          });
        }
        subSec.appendChild(hint);
      }
      box.appendChild(subSec);
      hasSection = true;
    }

    if (plSectionEnabled()) {
      if (hasSection) {
        var plDivider = document.createElement('div');
        plDivider.className = 'un-hub-divider';
        box.appendChild(plDivider);
      }

      var plHead = document.createElement('div');
      plHead.className = 'un-hub-brand pl';
      var plHeadTitle = document.createElement('span');
      plHeadTitle.className = 'un-hub-brand-title';
      plHeadTitle.textContent = 'Playlists';
      plHead.appendChild(plHeadTitle);

      var addPlBtn = document.createElement('button');
      addPlBtn.type = 'button';
      addPlBtn.className = 'un-hub-brand-btn pl';
      addPlBtn.textContent = '＋ Add playlists';
      addPlBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openAllPlPanel();
      });
      plHead.appendChild(addPlBtn);
      box.appendChild(plHead);

      var plSec = document.createElement('div');
      plSec.className = 'un-hub-section pl-hero';
      var pins = pinIds();

      var builtins = PF && PF.builtinLists ? PF.builtinLists(plPrefs) : [];
      builtins.forEach(function (b) {
        var active =
          b.id === 'history'
            ? location.pathname.indexOf('/feed/history') === 0
            : location.pathname.indexOf('/playlist') === 0 &&
              new RegExp('[?&]list=' + (b.id === 'liked' ? 'LL' : 'WL') + '(&|$)').test(location.search);
        var ico = b.id === 'history' ? 'clock' : b.id === 'liked' ? 'thumb-up' : 'clock';
        plSec.appendChild(
          mkSimpleRow(b.label, null, active, function () {
            setPlActive('');
            if (location.pathname + location.search !== b.href) navigateYouTube(b.href);
          }, ico)
        );
      });

      if (plPrefs.showAll) {
        plSec.appendChild(
          mkSimpleRow('All playlists', null, false, function () {
            setPlActive('');
            if (location.pathname !== '/feed/playlists') navigateYouTube('/feed/playlists');
          }, '☰')
        );
      }
      if (pins.length) {
        pins.forEach(function (plId) {
          plSec.appendChild(mkPinnedPlaylistRow(plId));
        });
      } else {
        plSec.appendChild(mkPlEmptyHint());
      }
      var visibleFolders = plSidebarNames();
      if (visibleFolders.length) {
        var folderLabel = document.createElement('div');
        folderLabel.className = 'un-hub-hint scan';
        folderLabel.textContent = 'Folders';
        plSec.appendChild(folderLabel);
        visibleFolders.forEach(function (fname) {
          plSec.appendChild(mkPlFolderRow(fname));
        });
      }
      box.appendChild(plSec);
      hasSection = true;
    }

    if (forgeSectionEnabled()) {
      if (hasSection) {
        var forgeDivider = document.createElement('div');
        forgeDivider.className = 'un-hub-divider';
        box.appendChild(forgeDivider);
      }
      box.appendChild(mkForgeSection());
      hasSection = true;
    }

    var divider = document.createElement('div');
    divider.className = 'un-hub-divider';
    box.appendChild(divider);

    mountSidebarBox(box, sections);
    if (subEnabled()) {
      maybeScanFeed();
      scheduleFeedScan();
    }
    if (panelOpen()) renderOpenPanel();
  }

  function patchForgeSection() {
    var hub = document.getElementById('un-sidebar-hub');
    if (!hub) return;
    var status = hub.querySelector('.un-hub-forge-status');
    var sync = hub.querySelector('.un-hub-forge-sync');
    if (status && FL && FL.tasteOneLiner) {
      var taste = FL.tasteOneLiner(watchStats, searchStats);
      if (taste) {
        status.textContent = taste;
        status.classList.remove('muted');
      }
    }
    if (sync && FL && FL.formatSyncAge) sync.textContent = FL.formatSyncAge(forgeLastSync);
  }

  var guideWatchObs = null;
  var guideRemountTimer = null;
  var guideRetryTimer = null;
  var guideOpenBound = false;

  function guideDrawerEl() {
    return document.querySelector(YD ? YD.GUIDE_DRAWER_SEL : '#guide');
  }

  function isGuideExpanded() {
    var drawer = guideDrawerEl();
    if (!drawer) return false;
    if (drawer.hasAttribute('opened')) return true;
    var vis = drawer.getAttribute('visibility');
    if (vis && vis !== 'HIDDEN') return true;
    var style = drawer.getAttribute('style') || '';
    if (/visibility:\s*visible/i.test(style)) return true;
    return !!sectionsEl();
  }

  function bindGuideOpen() {
    if (guideOpenBound) return;
    guideOpenBound = true;
    document.addEventListener(
      'click',
      function (e) {
        if (!enabled()) return;
        var btn = e.target.closest(YD ? YD.GUIDE_TOGGLE_BTN_SEL : '#guide-button');
        if (!btn) return;
        setTimeout(function () {
          if (enabled()) ensureSidebar();
        }, 500);
      },
      true
    );
    var drawer = guideDrawerEl();
    if (drawer) {
      new MutationObserver(function () {
        if (!enabled()) return;
        if (!isGuideExpanded()) return;
        if (guideRemountTimer) return;
        guideRemountTimer = setTimeout(function () {
          guideRemountTimer = null;
          ensureSidebar();
        }, 350);
      }).observe(drawer, { attributes: true, attributeFilter: ['opened', 'visibility', 'style'] });
    }
  }

  function watchGuideDom() {
    if (guideWatchObs) return;
    var target = document.querySelector(YD ? YD.GUIDE_WATCH_TARGET_SEL : '#guide');
    if (!target) {
      if (guideRetryTimer) return;
      guideRetryTimer = setTimeout(function () {
        guideRetryTimer = null;
        watchGuideDom();
      }, 150);
      return;
    }
    guideWatchObs = new MutationObserver(function () {
      if (!enabled()) return;
      // Remount when YouTube wiped us OR left an orphan outside #sections.
      if (hubInPlace()) return;
      if (guideRemountTimer) return;
      guideRemountTimer = setTimeout(function () {
        guideRemountTimer = null;
        if (!hubInPlace()) ensureSidebar();
      }, 50);
    });
    guideWatchObs.observe(target, { childList: true, subtree: true });
    if (!hubInPlace()) ensureSidebar();
  }

  function refreshAll() {
    try {
      ensureSidebar();
    } catch (e) {
      console.warn('[Unsynth][sidebarHub.ensureSidebar]', e);
    }
    var namesTouched = false;
    if (subEnabled()) {
      try {
        runAutoScans();
        namesTouched = syncNamesFromGuide();
        enrichChannelNames();
      } catch (e) {
        console.warn('[Unsynth][sidebarHub.scans]', e);
      }
    }
    if (namesTouched) refreshHubLabels();
    if (panelOpen()) renderOpenPanel();
  }

  var mod = {
    id: 'sidebarHub',
    init: function (c) {
      core = c;
      // Always wire listeners — gate work on enabled(). Early-returning here
      // would leave the module half-dead if Sub Manager is enabled after init.
      load(function () {
        if (enabled()) refreshAll();
      });
      watchGuideDom();
      bindGuideOpen();
      // Named refs so teardown can remove them. The click guard also ignores the
      // Forge panel so clicking it doesn't close the hub's inline popouts.
      hubDocClick = function (e) {
      // Not a user dismissal -- see queue-advance.js docClickHandler.
      if (e && e.isTrusted === false) return;
        if (!enabled()) return;
        if (e.target.closest('#un-forge-root, #un-hub-panel')) return;
        if (!e.target.closest('#un-sidebar-hub')) closePopouts();
      };
      hubDocKey = function (e) {
        if (!enabled()) return;
        if (e.key === 'Escape' && openPopout) {
          closePopouts();
        }
      };
      // Popouts are inline within #un-sidebar-hub and scroll with the guide,
      // so we no longer close them on scroll. Only outside-click and Escape close them.
      hubDocScroll = null;
      document.addEventListener('click', hubDocClick);
      document.addEventListener('keydown', hubDocKey);
      hubStorageChanged = function (changes, area) {
        if (area === 'sync' && changes.unPlPinsSync && PF && PF.applyRemotePinSync) {
          PF.applyRemotePinSync(changes.unPlPinsSync.newValue);
          return;
        }
        if (area !== 'local') return;
        if (changes.forgePrefs) {
          // Sidebar visibility toggle lives in forgePrefs — reload + remount so
          // the Forge panel appears/disappears immediately.
          load(refreshAll);
        } else if (changes.watchStats || changes.searchStats || changes.forgeLastSync) {
          load(function () {
            patchForgeSection();
          });
        }
        if (changes.subStore) {
          load(function () {
            if (hubMounted()) {
              refreshHubLabels();
              enrichChannelNames();
            } else {
              refreshAll();
            }
          });
        } else if (
          changes.subActive ||
          changes.subHomeMode ||
          changes.subHomeGroup ||
          changes.subscribedChannels ||
          changes.subscribedChannelCache ||
          changes.unTasteProfile ||
          changes.subSmartVideos ||
          changes.plFolderStore ||
          changes.plFolderActive ||
          changes.plFolderPrefs ||
          changes.plPins ||
          changes.subNewSeen ||
          changes.subChannelLatest ||
          changes.subChannelThumbs
        ) {
          load(refreshAll);
        }
        // The digest is defined by what is NOT watched and by what has been
        // scraped, so both sets have to reach an OPEN digest. Screenshotting
        // the empty state caught this: marking every listed video watched left
        // all nine cards on screen, because watchedVideos was not a change the
        // hub reacted to at all. Kept separate from the refreshAll chain above
        // — rebuilding the whole sidebar to update a list that is already
        // rendered would be wasteful, and refreshAll does not rebuild the feed
        // page anyway.
        if (catchUpGroup && (changes.watchedVideos || changes.catchUpSeen)) {
          load(refreshCatchUp);
        }
      };
      chrome.storage.onChanged.addListener(hubStorageChanged);
    },
    onSettings: function () {
      load(function () {
        if (enabled()) refreshAll();
        else {
          closePopouts();
          var hub = document.getElementById('un-sidebar-hub');
          if (hub) hub.remove();
        }
      });
      if (!guideWatchObs) watchGuideDom();
      if (!guideOpenBound) bindGuideOpen();
      if (!hubStorageChanged) {
        // Re-init path if teardown cleared listeners then module re-enabled —
        // scan/onNavigate will remount; storage wiring happens once in init.
      }
    },
    scan: function () {
      if (!enabled()) return;
      // Keep Subscriptions groups + Playlists pins mounted. Heavy feed harvest
      // stays off the watch/shorts player path.
      if (!hubInPlace()) {
        ensureSidebar();
      }
      if (document.hidden) return;
      var onWatch =
        (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.indexOf('/shorts/') === 0;
      if (onWatch) {
        // Soft remount only — never scrape home/subs feeds during playback.
        if (!hubInPlace()) ensureSidebar();
        return;
      }
      if (subEnabled() && runAutoScans()) {
        load(refreshAll);
        return;
      }
      // Guide open / feed idle: refresh names lightly + ensure both sections.
      if (subEnabled() && sectionsEl()) {
        syncNamesFromGuide();
        enrichChannelNames();
      }
      ensureSidebar();
    },
    onNavigate: function () {
      if (!enabled()) return;
      closePopouts();
      // A new page gets fresh attempts: the ladder is per-page, and a page that
      // exhausted it must not leave the next one with none. Bumping the
      // generation also disowns any timer already in flight, which the
      // clearTimeout alone cannot do if it fires first.
      scanGeneration++;
      if (metadataRetryTimer) { clearTimeout(metadataRetryTimer); metadataRetryTimer = null; }
      metadataRetryStep = 0;
      // Always reload pins + groups from storage on SPA navigations so the
      // sidebar never remounts with an empty in-memory cache after a rebuild.
      load(refreshAll);
    },
    // Core skips scan/onSettings for a just-disabled module — remove the hub,
    // the slide-out panel, the document listeners, and reset panel state so
    // nothing lingers (or auto-repopulates) until a reload.
    teardown: function () {
      closePopouts();
      closePanel(); // resets openPanelKind/openPanelName/panelFilterQuery
      var panel = document.getElementById('un-hub-panel');
      if (panel) panel.remove();
      var hub = document.getElementById('un-sidebar-hub');
      if (hub) hub.remove();
      if (hubDocClick) { document.removeEventListener('click', hubDocClick); hubDocClick = null; }
      if (hubDocKey) { document.removeEventListener('keydown', hubDocKey); hubDocKey = null; }
      if (hubDocScroll) { window.removeEventListener('scroll', hubDocScroll, { capture: true }); hubDocScroll = null; }
      if (hubEscHandle) { window.UNSYNTH.popPanel(hubEscHandle); hubEscHandle = null; }
      if (hubStorageChanged) { chrome.storage.onChanged.removeListener(hubStorageChanged); hubStorageChanged = null; }
      if (guideWatchObs) { guideWatchObs.disconnect(); guideWatchObs = null; }
      // Same reasoning as onNavigate: disown in-flight timers as well as
      // cancelling them, so a retry cannot run against a torn-down module.
      scanGeneration++;
      if (metadataRetryTimer) { clearTimeout(metadataRetryTimer); metadataRetryTimer = null; }
      metadataRetryStep = 0;
      if (guideRetryTimer) { clearTimeout(guideRetryTimer); guideRetryTimer = null; }
      if (guideRemountTimer) { clearTimeout(guideRemountTimer); guideRemountTimer = null; }
      if (feedScanTimer) { clearInterval(feedScanTimer); feedScanTimer = null; }
      if (sidebarMountTimer) { clearTimeout(sidebarMountTimer); sidebarMountTimer = null; }
      namesFetchPending = false;
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
