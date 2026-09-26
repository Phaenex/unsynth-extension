/**
 * Recommended out-of-box Unsynth profile — sensible modules on, classic YouTube tune,
 * watch badges, AI filter + community list. Used by defaults.js, service worker
 * migration, and dashboard first-run apply.
 */
(function (g) {
  'use strict';

  const VERSION = 6;

  const RECOMMENDED_SYNC = {
    enabled: true,
    mode: 'hide',
    respectDisclosure: true,
    blockPlayback: true,
    hideSummaries: true,
    useRegex: false,
    watchedMode: 'dim',
    watchedDisplay: {
      badges: true,
      finished: 'dim',
      feedFilter: 'all',
      hidePartial: false
    },
    modules: {
      aiFilter: true,
      subManager: true,
      playlistManager: true,
      playlistFolders: true,
      playlistBulk: true,
      aiAssistant: true,
      analytics: true,
      sponsorBlock: true,
      uiTune: true,
      watchHistory: true,
      crossTabPlayback: true,
      forgeLink: true,
      queueAdvance: true,
      tasteRank: true,
      dislikeRestore: true,
      popoutPlayer: true,
      scrollMiniplayer: true,
      volumeMaster: true,
      factCheck: true,
      descDigest: true,
      qualityLock: true,
      speedChip: true,
      screenshot: true,
      titleCleaner: false,
      ambientMode: false,
      adSkip: true,
      deArrow: false,
      shortcuts: true,
      transcriptExport: true,
      abLoop: true,
      tabTitle: false,
      chapters: true,
      searchFilters: false,
      commentFilter: false,
      channelCompletion: false,
      playlistDebt: false,
      clipCapture: true,
      skipSeconds: true,
      liveNow: true,
      quickSwitcher: true,
      // Off in the recommended profile: the shelf can spend YouTube API quota,
      // so it stays an explicit opt-in rather than something a profile apply
      // silently turns on. Same rationale as titleCleaner.
      discoverShelf: false,
      ambientMode: true
    },
    sponsorBlock: {
      autoSkip: true,
      useCommunity: true,
      usePersonal: true,
      communityDirect: true,
      hideChapters: false,
      categoryModes: {
        sponsor: 'auto',
        selfpromo: 'auto',
        interaction: 'auto',
        music_offtopic: 'auto',
        intro: 'disabled',
        outro: 'disabled',
        preview: 'disabled',
        hook: 'disabled',
        filler: 'disabled',
        poi_highlight: 'manual',
        exclusive_access: 'overlay',
        chapter: 'overlay'
      },
      categories: {
        sponsor: true,
        selfpromo: true,
        interaction: true,
        music_offtopic: true,
        intro: false,
        outro: false,
        preview: false
      }
    },
    ui: {
      preset: 'classic',
      hideShorts: true,
      hideRecommendations: false,
      hideComments: false,
      hideLiveChat: false,
      hideEndCards: true,
      hideMerch: true,
      hidePremiumUpsell: true,
      hideNotificationBell: false,
      hideTrending: true,
      hideHomeFeed: false,
      disableHoverPreview: true,
      squareThumbnails: true,
      dimWatched: false,
      oledTheme: false,
      fullWidth: false,
      untruncatedTitles: true,
      videosPerRow: 4,
      disableAutoplay: true,
      blockStillWatching: true,
      logoToSubscriptions: true,
      defaultSpeed: 0,
      defaultVolume: -1,
      loopVideo: false,
      theaterMode: false,
      autoPauseOnTabSwitch: false,
      scrollToVolume: true,
      channelDefaultTab: 'videos',
      hideShelves: {
        forYou: false,
        mixes: false,
        news: false,
        shopping: false,
        communityPosts: false,
        continueWatching: false
      }
    },
    surfaces: {
      home: true,
      subscriptions: true,
      search: true,
      related: true,
      shorts: true,
      channel: true,
      music: true
    },
    communityList: { enabled: true },
    allowSubscribedChannels: true,
    focus: {
      enabled: false,
      start: '09:00',
      end: '17:00',
      days: [1, 2, 3, 4, 5]
    }
  };

  /** True when the user never customized watched feed display beyond stock v4 "mark". */
  function isStockWatchedDisplay(cur) {
    const wd = cur.watchedDisplay;
    const mode = cur.watchedMode;
    if (mode && mode !== 'mark') return false;
    if (!wd) return true;
    if (wd.badges === false || wd.hidePartial || (wd.feedFilter && wd.feedFilter !== 'all')) return false;
    return !wd.finished || wd.finished === 'show';
  }

  /** Merge recommended values; keep user lists (keywords, channels) and stats. */
  function mergeSync(existing) {
    const cur = existing || {};
    const out = Object.assign({}, cur);
    const rec = RECOMMENDED_SYNC;

    out.enabled = rec.enabled;
    out.mode = cur.mode || rec.mode;
    out.respectDisclosure = rec.respectDisclosure;
    out.blockPlayback = rec.blockPlayback;
    out.hideSummaries = rec.hideSummaries;
    out.watchedMode = rec.watchedMode;
    out.watchedDisplay = Object.assign({}, rec.watchedDisplay, cur.watchedDisplay || {});
    out.modules = Object.assign({}, rec.modules, cur.modules || {});
    for (const k of Object.keys(rec.modules)) {
      if (cur.modules && cur.modules[k] === false) continue;
      if (rec.modules[k] === false && (!cur.modules || cur.modules[k] !== true)) {
        out.modules[k] = false;
        continue;
      }
      out.modules[k] = true;
    }
    if (g.UNModules && g.UNModules.normalizeModules) {
      out.modules = g.UNModules.normalizeModules(out.modules, g.UNSYNTH_DEFAULTS);
    } else if (out.modules.playlistManager !== undefined) {
      if (out.modules.playlistFolders === undefined) out.modules.playlistFolders = out.modules.playlistManager;
      if (out.modules.playlistBulk === undefined) out.modules.playlistBulk = out.modules.playlistManager;
    }
    out.sponsorBlock = Object.assign({}, rec.sponsorBlock, cur.sponsorBlock || {});
    out.sponsorBlock.categories = Object.assign(
      {},
      rec.sponsorBlock.categories,
      (cur.sponsorBlock && cur.sponsorBlock.categories) || {}
    );
    out.sponsorBlock.categoryModes = Object.assign(
      {},
      rec.sponsorBlock.categoryModes,
      (cur.sponsorBlock && cur.sponsorBlock.categoryModes) || {}
    );
    // Both of these used to be a bare Object.assign({}, rec.X) — unlike every
    // other section here, that discards cur.X entirely instead of layering it
    // over the recommended default. Since mergeSync() runs on every install
    // AND every profileVersion bump (service-worker.js applySuiteProfile,
    // gated on localVer < UNProfile.VERSION — which fires on ordinary
    // updates, not just fresh installs), this silently reset a user's custom
    // ui settings (videosPerRow, theaterMode, oledTheme, dimWatched,
    // defaultSpeed, defaultVolume, hideShelves, etc.) and their
    // communityList.enabled toggle back to stock defaults on every version
    // bump — a real, repeated data-loss bug, not a one-time migration quirk.
    out.ui = Object.assign({}, rec.ui, cur.ui || {});
    out.surfaces = Object.assign({}, rec.surfaces, cur.surfaces || {});
    out.communityList = Object.assign({}, rec.communityList, cur.communityList || {});
    out.focus = Object.assign({}, rec.focus, cur.focus || {});
    if (!Array.isArray(out.keywords) || !out.keywords.length) {
      out.keywords = (g.UNSYNTH_DEFAULTS && g.UNSYNTH_DEFAULTS.keywords) || [];
    }
    if (!Array.isArray(out.channels)) out.channels = [];
    if (cur.allowSubscribedChannels === undefined) out.allowSubscribedChannels = true;
    return out;
  }

  const api = { VERSION, RECOMMENDED_SYNC, mergeSync, isStockWatchedDisplay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNProfile = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
