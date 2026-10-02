/**
 * Module registry — single source of truth for feature modules.
 * Consumed by codegen (defaults / dashboard / popup / injection table)
 * and by the build. Node + browser safe (no DOM).
 *
 * Fields:
 *   id            – registry id (unique)
 *   moduleKey     – primary key in settings.modules (may be shared)
 *   moduleKeys    – optional keys for a shared helper; load while any is on
 *   label         – short UI label
 *   description   – muted hint after the checkbox
 *   defaultOn     – default for settings.modules[moduleKey]
 *   popup         – include in popup MODS list
 *   dashboard     – include in dashboard Feature modules card
 *   legacy        – not shown in UI; kept for normalize/migration only
 *   entry         – content-script JS path (relative to repo root)
 *   css           – optional CSS paths
 *   lazy          – if true, Phase 2 registers via chrome.scripting
 *   alwaysLoad    – helper / side module that loads with its moduleKey
 *   order         – ascending load order within the YouTube content_scripts block
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.UNModuleManifest = factory();
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /** Shared scripts that precede core.js (load order is the array order). */
  const SHARED_BEFORE_CORE = [
    'src/shared/ai-keywords.js',
    'src/defaults.js',
    'src/shared/messages.js',
    'src/shared/match.js',
    'src/shared/ui-presets.js',
    'src/shared/transcript.js',
    'src/shared/desc-digest.js',
    'src/shared/sub-groups.js',
    'src/shared/yt-dom.js',
    'src/shared/sub-feed.js',
    'src/shared/sub-channel-thumbs.js',
    'src/shared/playlist-folders.js',
    'src/shared/playlist-index.js',
    'src/shared/modules-normalize.js',
    'src/shared/watch-deck.js',
    'src/shared/side-panel.js',
    'src/shared/watch-stats.js',
    'src/shared/taste-profile.js',
    'src/shared/sub-smart-rows.js',
    // Catch-up digest + smart queue fill. Order matters and is asserted in
    // test/catch-up-wiring.test.js: catch-up.js ranks with taste-profile.js
    // above, and catch-up-scrape.js reads yt-dom.js's tile selectors plus
    // catch-up.js's parsers, so both must already be defined.
    'src/shared/catch-up.js',
    'src/shared/catch-up-scrape.js',
    'src/shared/forge-links.js',
    'src/shared/forge-discover.js',
    'src/shared/watch-queue.js',
    'src/shared/search-filters.js',
    'src/shared/native-queue.js',
    'src/shared/side-dock.js',
    'src/shared/ryd.js',
    'src/shared/watched-display.js',
    'src/shared/watched-state.js',
    'src/shared/sponsorblock-segments.js',
    'src/shared/segment-cache.js',
    'src/shared/channel-completion.js',
    'src/shared/playlist-budget.js',
    'src/shared/playlist-grouping.js',
    'src/shared/bulk-undo.js',
    'src/shared/time-budget.js',
    'src/shared/creator-studio.js',
    'src/shared/video-stats-cache.js',
    'src/shared/discover.js',
    'src/shared/volume-level.js',
    'src/shared/browser-env.js',
    'src/shared/guided-tour.js'
  ];

  const CORE_CSS = [
    'src/shared/design-tokens.css',
    'src/content/core.css',
    'src/content/side-dock.css',
    'src/content/side-panel.css',
    'src/content/media-tools.css',
    'src/content/guided-tour.css'
  ];

  const MODULES = [
    {
      id: 'aiFilter',
      moduleKey: 'aiFilter',
      dashTier: 'essential',
      label: 'AI content filter',
      description: 'hide AI videos/music/summaries',
      defaultOn: true,
      popup: false,
      dashboard: true,
      entry: 'src/content/modules/ai-filter.js',
      css: [],
      lazy: true,
      order: 10
    },
    {
      id: 'uiTune',
      moduleKey: 'uiTune',
      group: 'feed',
      dashTier: 'essential',
      label: 'Tune (layout)',
      description: 'hide Shorts/recs, presets, player',
      defaultOn: true,
      popup: true,
      popupLabel: 'Tune (layout)',
      dashboard: true,
      entry: 'src/content/modules/ui-tune.js',
      css: ['src/content/ui-tune.css'],
      lazy: true,
      order: 20
    },
    {
      id: 'aiAssistant',
      moduleKey: 'aiAssistant',
      group: 'content',
      dashTier: 'power',
      label: 'AI assistant',
      description: 'transcript summary & Q&A (BYOK)',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/ai-assistant.js',
      css: ['src/content/ai-assistant.css'],
      lazy: true,
      order: 30
    },
    {
      id: 'subManager',
      moduleKey: 'subManager',
      group: 'feed',
      dashTier: 'power',
      label: 'Subscription manager',
      description: 'groups, feed filter, PocketTube import',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/sub-manager.js',
      css: ['src/content/sub-manager.css'],
      lazy: true,
      order: 40
    },
    {
      id: 'playlistFolders',
      moduleKey: 'playlistFolders',
      group: 'feed',
      dashTier: 'power',
      label: 'Playlist groups',
      description: 'pin playlists in the sidebar; folders, ＋ Folder, Library filter',
      defaultOn: true,
      popup: true,
      popupLabel: 'Playlist groups (sidebar)',
      dashboard: true,
      entry: 'src/content/modules/pl-folder-manager.js',
      css: ['src/content/pl-folder-manager.css'],
      lazy: true,
      order: 50
    },
    {
      id: 'sidebarHub',
      moduleKey: 'subManager',
      moduleKeys: ['subManager', 'playlistFolders', 'forgeLink'],
      label: 'Sidebar hub',
      description: 'internal — guide hub for subs/playlists/forge',
      defaultOn: true,
      popup: false,
      dashboard: false,
      alwaysLoad: true,
      entry: 'src/content/modules/sidebar-hub.js',
      css: ['src/content/sidebar-hub.css'],
      lazy: true,
      order: 55
    },
    {
      id: 'mastheadSlot',
      moduleKey: 'subManager',
      // Every module that calls window.UNMastheadSlot owns it (2026-09-23).
      // It was keyed to subManager alone, and the lazy registry decides by
      // moduleKey(s) only (alwaysLoad is not read there), so with subManager
      // off the watched filter ran with no top-bar control at all: measured on
      // a near-Essentials profile and reproduced headless (Essentials: no
      // bar; + subManager: bar and chip). test/masthead-slot-owners.test.js
      // keeps this list in step with the callers.
      moduleKeys: ['subManager', 'watchHistory', 'playlistBulk'],
      label: 'Masthead slot',
      description: 'internal — shared masthead shell',
      defaultOn: true,
      popup: false,
      dashboard: false,
      alwaysLoad: true,
      entry: 'src/content/modules/masthead-slot.js',
      css: [],
      lazy: true,
      order: 56
    },
    {
      id: 'playlistBulk',
      moduleKey: 'playlistBulk',
      group: 'feed',
      dashTier: 'power',
      label: 'Playlist bulk tools',
      description: 'multi-select, dedupe, Forge links',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/playlist-bulk.js',
      css: ['src/content/playlist-bulk.css'],
      lazy: true,
      order: 60
    },
    {
      id: 'forgeSearchPanel',
      moduleKey: 'forgeLink',
      label: 'Forge search panel',
      description: 'internal',
      defaultOn: true,
      popup: false,
      dashboard: false,
      alwaysLoad: true,
      entry: 'src/content/modules/forge-search-panel.js',
      css: [],
      lazy: true,
      order: 70
    },
    {
      id: 'watchQueuePanel',
      moduleKey: 'forgeLink',
      label: 'Watch queue panel',
      description: 'internal',
      defaultOn: true,
      popup: false,
      dashboard: false,
      alwaysLoad: true,
      entry: 'src/content/modules/watch-queue-panel.js',
      css: [],
      lazy: true,
      order: 75
    },
    {
      id: 'tasteRank',
      moduleKey: 'tasteRank',
      group: 'feed',
      dashTier: 'power',
      label: 'Suggestions for your taste',
      description: 'score the suggestion rail against what you actually watch, and float the best matches to the top',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/taste-rank.js',
      css: [],
      lazy: true,
      order: 77
    },
    {
      id: 'queueAdvance',
      moduleKey: 'queueAdvance',
      group: 'player',
      dashTier: 'player',
      label: 'Queue auto-advance',
      description: 'queue dock on the page; play-next is a separate dashboard setting',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/queue-advance.js',
      css: [],
      lazy: true,
      order: 76
    },
    {
      id: 'forgeLink',
      moduleKey: 'forgeLink',
      group: 'content',
      dashTier: 'power',
      label: 'Playlist Forge',
      description: 'suggest & build playlists on YouTube',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/forge-link.js',
      css: ['src/content/forge-link.css'],
      lazy: true,
      order: 80
    },
    {
      id: 'dislikeRestore',
      moduleKey: 'dislikeRestore',
      group: 'content',
      dashTier: 'essential',
      label: 'Video stats on YouTube',
      description: 'RYD likes/dislikes on feeds, search & watch pages; compare vs channel',
      defaultOn: true,
      popup: true,
      popupLabel: 'Video stats (feeds + watch)',
      dashboard: true,
      entry: 'src/content/modules/dislike-restore.js',
      css: ['src/content/dislike-restore.css'],
      lazy: true,
      order: 90
    },
    {
      id: 'statsCompareUi',
      moduleKey: 'dislikeRestore',
      label: 'Stats compare UI',
      description: 'internal',
      defaultOn: true,
      popup: false,
      dashboard: false,
      alwaysLoad: true,
      entry: 'src/content/modules/stats-compare-ui.js',
      css: [],
      lazy: true,
      order: 91
    },
    {
      id: 'volumeMaster',
      moduleKey: 'volumeMaster',
      group: 'player',
      dashTier: 'player',
      label: 'Volume master',
      description: 'per-tab boost up to 600% on player controls',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/volume-master.js',
      css: [],
      lazy: true,
      order: 100
    },
    {
      id: 'popoutPlayer',
      moduleKey: 'popoutPlayer',
      group: 'player',
      dashTier: 'player',
      label: 'Popout player',
      description: 'floating resizable window for the current video',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/popout-player.js',
      css: [],
      lazy: true,
      order: 110
    },
    {
      id: 'scrollMiniplayer',
      moduleKey: 'scrollMiniplayer',
      group: 'player',
      dashTier: 'player',
      label: 'Scroll miniplayer',
      description: 'dock the player into a corner when you scroll past it — draggable, resizable, and never leaves the page',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/scroll-miniplayer.js',
      css: ['src/content/scroll-miniplayer.css'],
      lazy: true,
      order: 115
    },
    {
      id: 'factCheck',
      moduleKey: 'factCheck',
      group: 'content',
      dashTier: 'power',
      label: 'AI fact-check',
      description: 'check video claims & comments (BYOK)',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/fact-check.js',
      css: ['src/content/fact-check.css'],
      lazy: true,
      order: 120
    },
    {
      id: 'descDigest',
      moduleKey: 'descDigest',
      group: 'content',
      dashTier: 'power',
      label: 'Watch description',
      description: 'compact blurb, links, and timestamps for the video you are watching',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/desc-digest.js',
      css: ['src/content/desc-digest.css'],
      lazy: true,
      order: 122
    },
    {
      id: 'analytics',
      moduleKey: 'analytics',
      group: 'content',
      dashTier: 'power',
      label: 'Analytics overlay',
      description: 'watch-page stats card, SEO, engagement, compare',
      defaultOn: true,
      popup: true,
      popupLabel: 'Stats overlay',
      dashboard: true,
      entry: 'src/content/modules/analytics.js',
      css: ['src/content/analytics.css'],
      lazy: true,
      order: 130
    },
    {
      id: 'sponsorBlock',
      moduleKey: 'sponsorBlock',
      group: 'player',
      dashTier: 'essential',
      label: 'SponsorBlock',
      description: 'skip sponsor segments + markers',
      defaultOn: true,
      popup: true,
      popupLabel: 'SponsorBlock skip (community + personal)',
      dashboard: true,
      entry: 'src/content/modules/sponsorblock.js',
      css: ['src/content/sponsorblock.css'],
      lazy: true,
      order: 140
    },
    {
      id: 'discoverShelf',
      moduleKey: 'discoverShelf',
      label: 'Hidden gems shelf',
      description: 'overlooked videos above the home feed',
      // Off by default: it can spend YouTube API quota, so the user opts in.
      defaultOn: false,
      popup: true,
      popupLabel: 'Hidden gems (home shelf)',
      dashboard: true,
      entry: 'src/content/modules/discover-shelf.js',
      css: ['src/content/discover-shelf.css'],
      lazy: true,
      order: 145
    },
    {
      id: 'watchHistory',
      moduleKey: 'watchHistory',
      group: 'feed',
      dashTier: 'essential',
      label: 'Watch history',
      description: 'track, mark, dim watched videos',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/watch-history.js',
      css: [],
      lazy: true,
      order: 150
    },
    {
      id: 'crossTabPlayback',
      moduleKey: 'crossTabPlayback',
      group: 'player',
      dashTier: 'player',
      label: 'Cross-tab playback',
      description: 'pause older YouTube playback when a new tab starts',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/cross-tab-playback.js',
      css: [],
      lazy: true,
      order: 155
    },
    {
      id: 'qualityLock',
      moduleKey: 'qualityLock',
      group: 'player',
      dashTier: 'essential',
      label: 'Quality lock',
      description: 'force a minimum resolution (e.g. 1080p)',
      defaultOn: true,
      popup: true,
      popupLabel: 'Quality lock (force HD)',
      dashboard: true,
      entry: 'src/content/modules/quality-lock.js',
      css: [],
      lazy: true,
      order: 160
    },
    {
      id: 'speedChip',
      moduleKey: 'speedChip',
      group: 'player',
      dashTier: 'player',
      label: 'Speed chip',
      description: 'shows the current playback speed on the player and opens a picker to change it',
      defaultOn: true,
      popup: true,
      popupLabel: 'Speed chip (player control)',
      dashboard: true,
      entry: 'src/content/modules/speed-chip.js',
      css: [],
      lazy: true,
      order: 165
    },
    {
      id: 'screenshot',
      moduleKey: 'screenshot',
      group: 'tools',
      dashTier: 'player',
      label: 'Screenshot frame',
      description: 'camera button to save the current frame as PNG',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/screenshot.js',
      css: [],
      lazy: true,
      order: 170
    },
    {
      id: 'titleCleaner',
      moduleKey: 'titleCleaner',
      group: 'feed',
      dashTier: 'power',
      label: 'Title cleaner',
      description: 'calm ALL-CAPS clickbait & emoji spam in titles',
      defaultOn: false,
      popup: true,
      popupLabel: 'Calm clickbait titles',
      dashboard: true,
      entry: 'src/content/modules/title-cleaner.js',
      css: [],
      lazy: true,
      order: 190
    },
    {
      id: 'ambientMode',
      moduleKey: 'ambientMode',
      group: 'player',
      dashTier: 'player',
      label: 'Ambient mode',
      description: 'soft glow around the player from on-screen colors',
      // Off by default — canvas frame sampling has a real (if small) cost,
      // and this used to be gated by a second, unreachable inner flag that
      // made "default on" here moot anyway (see docs/LESSONS.md). Now that
      // the module toggle is the only gate, defaultOn actually controls the
      // real on/off state, so it needs to genuinely match the stated intent.
      defaultOn: false,
      popup: true,
      popupLabel: 'Ambient glow mode',
      dashboard: true,
      entry: 'src/content/modules/ambient-mode.js',
      css: ['src/content/ambient-mode.css'],
      lazy: true,
      order: 200
    },
    {
      id: 'adSkip',
      moduleKey: 'adSkip',
      group: 'player',
      dashTier: 'essential',
      label: 'Ad skip',
      description: 'auto-click Skip Ad, mute non-skippable ads, hide banner/overlay ads',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/ad-skip.js',
      css: [],
      lazy: true,
      order: 210
    },
    {
      id: 'deArrow',
      moduleKey: 'deArrow',
      group: 'feed',
      dashTier: 'power',
      label: 'DeArrow titles',
      description: 'crowd-sourced titles and thumbnails; pick which on the dashboard',
      defaultOn: false,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/dearrow.js',
      css: [],
      lazy: true,
      order: 220
    },
    {
      id: 'shortcuts',
      moduleKey: 'shortcuts',
      group: 'tools',
      dashTier: 'power',
      label: 'Keyboard shortcuts',
      description: 'in-page hotkeys for ambient mode, screenshot, quality lock, speed, volume boost, and the dashboard',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/shortcuts.js',
      css: [],
      lazy: true,
      order: 230
    },
    {
      id: 'transcriptExport',
      moduleKey: 'transcriptExport',
      group: 'content',
      dashTier: 'power',
      label: 'Transcript export',
      description: 'copy or download the video transcript as plain text',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/transcript-export.js',
      css: ['src/content/transcript-export.css'],
      lazy: true,
      order: 240
    },
    {
      id: 'abLoop',
      moduleKey: 'abLoop',
      group: 'player',
      dashTier: 'player',
      label: 'A-B loop',
      description: 'mark two points and repeat playback between them',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/ab-loop.js',
      css: ['src/content/ab-loop.css'],
      lazy: true,
      order: 250
    },
    {
      id: 'tabTitle',
      moduleKey: 'tabTitle',
      group: 'player',
      dashTier: 'player',
      label: 'Playback tab title',
      description: 'show play/pause state in the browser tab title',
      defaultOn: false,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/tab-title.js',
      css: [],
      lazy: true,
      order: 260
    },
    {
      id: 'chapters',
      moduleKey: 'chapters',
      group: 'player',
      dashTier: 'player',
      label: 'Chapter navigation',
      description: 'jump to the next/previous creator-defined chapter',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/chapters.js',
      css: [],
      lazy: true,
      order: 270
    },
    {
      id: 'searchFilters',
      moduleKey: 'searchFilters',
      group: 'feed',
      dashTier: 'power',
      label: 'Search filters',
      description: 'exact date range, view and duration bounds, and keyword/channel exclusions on the search page',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/search-filters.js',
      css: ['src/content/search-filters.css'],
      lazy: true,
      order: 275
    },
    {
      id: 'commentFilter',
      moduleKey: 'commentFilter',
      group: 'feed',
      dashTier: 'power',
      label: 'Comment filter',
      description: 'hide comments matching keywords',
      defaultOn: false,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/comment-filter.js',
      css: ['src/content/comment-filter.css'],
      lazy: true,
      order: 280
    },
    {
      id: 'playlistDebt',
      moduleKey: 'playlistDebt',
      group: 'feed',
      dashTier: 'power',
      label: 'Playlist debt line',
      description: 'under a playlist title: how many hours it holds, how many are unfinished, and how much of it you actually finish',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/playlist-debt.js',
      css: ['src/content/playlist-debt.css'],
      lazy: true,
      order: 284
    },
    {
      id: 'channelCompletionHeader',
      moduleKey: 'channelCompletion',
      group: 'feed',
      dashTier: 'power',
      label: 'Channel completion',
      description: 'on a channel page, what share of the videos you start there you actually finish',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/channel-completion-header.js',
      css: ['src/content/channel-completion.css'],
      lazy: true,
      order: 285
    },
    {
      id: 'clipCapture',
      moduleKey: 'clipCapture',
      group: 'tools',
      dashTier: 'player',
      label: 'Clip capture',
      description: 'record a short WebM clip (video + audio) of the current playback',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/clip-capture.js',
      css: [],
      lazy: true,
      order: 290
    },
    {
      id: 'skipSeconds',
      moduleKey: 'skipSeconds',
      group: 'player',
      dashTier: 'player',
      label: 'Skip seconds',
      description: 'back/forward player buttons that seek by a configurable number of seconds',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/skip-seconds.js',
      css: [],
      lazy: true,
      order: 300
    },
    {
      id: 'liveNow',
      moduleKey: 'liveNow',
      group: 'feed',
      dashTier: 'power',
      label: 'Live now shelf',
      description: 'pins any live stream already loaded in your home feed to the top',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/live-now.js',
      css: ['src/content/live-now.css'],
      lazy: true,
      order: 310
    },
    {
      id: 'quickSwitcher',
      moduleKey: 'quickSwitcher',
      group: 'tools',
      dashTier: 'power',
      label: 'Quick switcher',
      description: 'Shift+P anywhere on YouTube to jump to any playlist or subscribed channel by name, folder or group',
      defaultOn: true,
      popup: true,
      dashboard: true,
      entry: 'src/content/modules/quick-switcher.js',
      css: ['src/content/quick-switcher.css'],
      lazy: true,
      order: 320
    }
  ];

  /** Legacy key kept in defaults for normalize/migration; not a toggle. */
  const LEGACY_MODULE_DEFAULTS = {
    playlistManager: true
  };

  function sortedModules() {
    return MODULES.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function defaultModulesMap() {
    const out = Object.assign({}, LEGACY_MODULE_DEFAULTS);
    MODULES.forEach((m) => {
      // alwaysLoad helpers share a moduleKey with a user-facing toggle — they
      // must not win the default (forgeLink, subManager, dislikeRestore, …).
      if (m.alwaysLoad) return;
      if (out[m.moduleKey] === undefined) out[m.moduleKey] = m.defaultOn !== false;
    });
    return out;
  }

  /**
   * Product-order first, then anything new.
   *
   * These lists are a *preferred display order*, not the source of membership.
   * They used to be the filter, which quietly broke the SSOT contract: adding a
   * module with popup/dashboard true put it in defaults.js and the injection
   * table but never in the popup or the dashboard, and nothing failed. Membership
   * now comes from MODULES; unlisted keys append in registry order so a new
   * module always shows up somewhere.
   */
  function orderedKeys(order, byKey) {
    const listed = order.filter((k) => byKey[k]);
    const seen = new Set(listed);
    const extra = MODULES.map((m) => m.moduleKey).filter((k) => byKey[k] && !seen.has(k) && !seen.add(k));
    return listed.concat(extra);
  }

  function popupMods() {
    const order = [
      'subManager',
      'playlistBulk',
      'playlistFolders',
      'forgeLink',
      'dislikeRestore',
      'popoutPlayer',
      'scrollMiniplayer',
      'queueAdvance',
      'tasteRank',
      'volumeMaster',
      'factCheck',
      'descDigest',
      'aiAssistant',
      'analytics',
      'sponsorBlock',
      'discoverShelf',
      'uiTune',
      'watchHistory',
      'crossTabPlayback',
      'qualityLock',
      'speedChip',
      'screenshot',
      'titleCleaner',
      'ambientMode',
      'adSkip',
      'deArrow',
      'shortcuts',
      'transcriptExport',
      'abLoop',
      'tabTitle',
      'chapters',
      'searchFilters',
      'commentFilter',
      'channelCompletion',
      'playlistDebt',
      'clipCapture',
      'skipSeconds',
      'liveNow',
      'quickSwitcher'
    ];
    const byKey = {};
    MODULES.forEach((m) => {
      if (!m.popup) return;
      if (!byKey[m.moduleKey]) byKey[m.moduleKey] = m;
    });
    // main's orderedKeys() helper, with this branch's third element: the popup's
    // grouping metadata. The popup renders 34 toggles; a flat list was ~1840px
    // of content in a 320px-wide window, so they're grouped by WHERE the feature
    // acts (player / feed / content / tools). Kept here rather than in popup.js
    // so the grouping has one owner and survives codegen regenerating that file.
    return orderedKeys(order, byKey).map((k) => {
      const m = byKey[k];
      return [k, m.popupLabel || m.label, { group: m.group || 'tools', desc: m.description || '' }];
    });
  }

  function dashboardRows() {
    const order = [
      'aiFilter',
      'subManager',
      'playlistFolders',
      'playlistBulk',
      'forgeLink',
      'dislikeRestore',
      'popoutPlayer',
      'scrollMiniplayer',
      'queueAdvance',
      'tasteRank',
      'volumeMaster',
      'factCheck',
      'descDigest',
      'aiAssistant',
      'analytics',
      'sponsorBlock',
      'discoverShelf',
      'uiTune',
      'watchHistory',
      'crossTabPlayback',
      'qualityLock',
      'speedChip',
      'screenshot',
      'titleCleaner',
      'ambientMode',
      'adSkip',
      'deArrow',
      'shortcuts',
      'transcriptExport',
      'abLoop',
      'tabTitle',
      'chapters',
      'searchFilters',
      'commentFilter',
      'channelCompletion',
      'playlistDebt',
      'clipCapture',
      'skipSeconds',
      'liveNow',
      'quickSwitcher'
    ];
    const byKey = {};
    MODULES.forEach((m) => {
      if (!m.dashboard) return;
      if (!byKey[m.moduleKey]) byKey[m.moduleKey] = m;
    });
    // main's orderedKeys(), plus dashTier: the dashboard groups rows into
    // Essential / Player / Power sections and cannot do it without that field.
    return orderedKeys(order, byKey).map((k) => {
      const m = byKey[k];
      return { moduleKey: k, label: m.label, description: m.description || '', dashTier: m.dashTier || 'power' };
    });
  }

  /** Full static YouTube content_scripts JS list (parity / pre-lazy). */
  function youtubeJsList() {
    const js = SHARED_BEFORE_CORE.slice();
    js.push('src/content/core.js');
    sortedModules().forEach((m) => js.push(m.entry));
    js.push('src/content/boot.js');
    return js;
  }

  /** Core-only JS list (Phase 2+ static declaration). */
  function youtubeCoreJsList() {
    return SHARED_BEFORE_CORE.concat(['src/content/core.js', 'src/content/boot.js']);
  }

  function youtubeCssList() {
    const css = CORE_CSS.slice();
    const seen = {};
    CORE_CSS.forEach((c) => {
      seen[c] = true;
    });
    sortedModules().forEach((m) => {
      (m.css || []).forEach((c) => {
        if (!seen[c]) {
          seen[c] = true;
          css.push(c);
        }
      });
    });
    return css;
  }

  function lazyModuleEntries() {
    return sortedModules().filter((m) => m.lazy !== false);
  }

  return {
    SHARED_BEFORE_CORE,
    CORE_CSS,
    MODULES,
    LEGACY_MODULE_DEFAULTS,
    sortedModules,
    defaultModulesMap,
    popupMods,
    dashboardRows,
    youtubeJsList,
    youtubeCoreJsList,
    youtubeCssList,
    lazyModuleEntries
  };
});
