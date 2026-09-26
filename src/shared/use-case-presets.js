/**
 * One-click use-case presets — enable only what you need (single-feature) or full stack.
 */
(function (g) {
  'use strict';

  const MODULE_KEYS = [
    'aiFilter',
    'subManager',
    'playlistFolders',
    'playlistBulk',
    'forgeLink',
    'dislikeRestore',
    'popoutPlayer',
    'scrollMiniplayer',
    'volumeMaster',
    'factCheck',
    'descDigest',
    'aiAssistant',
    'analytics',
    'sponsorBlock',
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
    'commentFilter',
    'clipCapture',
    'skipSeconds',
    'liveNow',
    'quickSwitcher'
  ];

  function allOff() {
    const m = {};
    MODULE_KEYS.forEach((k) => {
      m[k] = false;
    });
    return m;
  }

  /** @type {Array<{ id: string, label: string, desc: string, dashTab?: string, modules: Record<string, boolean>, statsSections?: object }>} */
  const PRESETS = [
    {
      id: 'essentials',
      label: 'Essentials',
      desc: 'AI filter, cleaner layout, dislikes, watch history, SponsorBlock, ad skip, and quality lock — no keys needed',
      modules: {
        aiFilter: true,
        uiTune: true,
        dislikeRestore: true,
        watchHistory: true,
        sponsorBlock: true,
        adSkip: true,
        qualityLock: true
      }
    },
    {
      id: 'full-stack',
      label: 'Full stack',
      desc: 'Full suite vs stacking extensions — core is free; also enables BYOK AI assistant + fact-check (need your key to run)',
      modules: {
        aiFilter: true,
        subManager: true,
        playlistFolders: true,
        playlistBulk: true,
        forgeLink: true,
        dislikeRestore: true,
        popoutPlayer: true,
        scrollMiniplayer: true,
        volumeMaster: true,
        factCheck: true,
        descDigest: true,
        aiAssistant: true,
        analytics: true,
        sponsorBlock: true,
        uiTune: true,
        watchHistory: true,
        crossTabPlayback: true,
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
        commentFilter: false,
        clipCapture: true,
        skipSeconds: true,
        liveNow: true,
        quickSwitcher: true
      }
    },
    {
      id: 'ai-filter',
      label: 'AI filter',
      desc: 'Hide synthetic narration and robot-voice channels only',
      dashTab: 'filter',
      modules: {
        aiFilter: true,
        uiTune: true
      }
    },
    {
      id: 'video-stats',
      label: 'Video stats',
      desc: 'Return YouTube Dislike counts on search, home, and watch pages',
      dashTab: 'stats',
      modules: {
        dislikeRestore: true,
        analytics: true
      },
      statsSections: { engagement: true, compare: true, seo: false, tags: false, creator: false }
    },
    {
      id: 'subs-playlists',
      label: 'Subs & playlists',
      desc: 'Subscription groups, playlist bulk tools, and Forge',
      dashTab: 'subs',
      modules: {
        subManager: true,
        playlistFolders: true,
        playlistBulk: true,
        forgeLink: true,
        watchHistory: true,
        uiTune: true
      }
    },
    {
      id: 'creator',
      label: 'Creator growth',
      desc: 'SEO overlay, keywords, rank tracking, and watch stats',
      dashTab: 'creator',
      modules: {
        analytics: true,
        dislikeRestore: true,
        forgeLink: true,
        watchHistory: true,
        uiTune: true
      },
      statsSections: { engagement: true, compare: true, seo: true, tags: true, creator: true }
    },
    {
      id: 'minimal',
      label: 'Lightweight',
      desc: 'SponsorBlock skips and a cleaner YouTube layout',
      dashTab: 'tune',
      modules: {
        sponsorBlock: true,
        uiTune: true
      }
    }
  ];

  function findPreset(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  /** Build sync payload for chrome.storage from a preset id. */
  function applyPreset(id, defaults) {
    const preset = findPreset(id);
    if (!preset) return null;
    const base = allOff();
    MODULE_KEYS.forEach((k) => {
      if (preset.modules[k] === true) base[k] = true;
    });
    let modules = base;
    if (g.UNModules && g.UNModules.normalizeModules) {
      modules = g.UNModules.normalizeModules(base, defaults || g.UNSYNTH_DEFAULTS);
    }
    // Callers persist the preset id separately (storage.local useCasePreset),
    // so it isn't included here.
    const out = { modules };
    // Only ever turn the global AI-filter switch ON via a preset; never silently
    // OFF — a preset that omits aiFilter leaves the master switch untouched (the
    // module gate already stops filtering when aiFilter is off).
    if (modules.aiFilter !== false) out.enabled = true;
    if (preset.statsSections) out.statsSections = Object.assign({}, preset.statsSections);
    return out;
  }

  const api = { MODULE_KEYS, PRESETS, findPreset, applyPreset, allOff };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNUseCasePresets = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
