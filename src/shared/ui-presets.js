/**
 * UI/UX feature → <html> class map, and the one-click preset bundles.
 * UMD-ish: attaches UNUI to the global (content script + dashboard) and
 * exports for Node unit tests. Single source of truth so the module, the
 * settings UI, and the tests never drift.
 */
(function (g) {
  'use strict';

  // Boolean CSS toggles → the <html> class the stylesheet (ui-tune.css) keys on.
  const CLASS_MAP = {
    hideShorts: 'un-hide-shorts',
    hideRecommendations: 'un-hide-recs',
    hideComments: 'un-hide-comments',
    hideLiveChat: 'un-hide-chat',
    hideEndCards: 'un-hide-endcards',
    hideMerch: 'un-hide-merch',
    hidePremiumUpsell: 'un-hide-premium',
    hideNotificationBell: 'un-hide-bell',
    hideTrending: 'un-hide-trending',
    hideHomeFeed: 'un-hide-home',
    disableHoverPreview: 'un-no-hover-preview',
    squareThumbnails: 'un-square-thumbs',
    dimWatched: 'un-dim-watched',
    oledTheme: 'un-oled',
    fullWidth: 'un-full-width',
    untruncatedTitles: 'un-full-titles'
  };

  // One-click presets. Each is a partial `ui` object; unset keys fall back to
  // the defaults (all off). Numeric/behavior/player keys included where useful.
  const PRESETS = {
    off: {},
    focus: {
      hideShorts: true,
      hideRecommendations: true,
      hideComments: true,
      hideEndCards: true,
      hideMerch: true,
      hidePremiumUpsell: true,
      hideNotificationBell: true,
      hideTrending: true,
      hideHomeFeed: true,
      disableHoverPreview: true,
      oledTheme: true,
      videosPerRow: 4,
      disableAutoplay: true,
      blockStillWatching: true,
      theaterMode: true
    },
    cinema: {
      hideRecommendations: true,
      hideEndCards: true,
      hideNotificationBell: true,
      oledTheme: true,
      fullWidth: true,
      disableAutoplay: true,
      theaterMode: true,
      defaultVolume: 80
    },
    classic: {
      hideShorts: true,
      hideTrending: true,
      hidePremiumUpsell: true,
      hideMerch: true,
      hideEndCards: true,
      disableHoverPreview: true,
      squareThumbnails: true,
      untruncatedTitles: true,
      logoToSubscriptions: true,
      disableAutoplay: true,
      blockStillWatching: true,
      videosPerRow: 4
    },
    compact: {
      hideShorts: true,
      fullWidth: true,
      untruncatedTitles: true,
      videosPerRow: 6,
      disableHoverPreview: true
    },
    study: {
      hideShorts: true,
      hideRecommendations: true,
      hideComments: true,
      hideLiveChat: true,
      hideEndCards: true,
      hideMerch: true,
      hidePremiumUpsell: true,
      hideNotificationBell: true,
      hideTrending: true,
      hideHomeFeed: true,
      disableHoverPreview: true,
      dimWatched: true,
      disableAutoplay: true,
      blockStillWatching: true,
      defaultSpeed: 1.25
    }
  };

  /** Map a ui-settings object to the list of <html> classes to apply. */
  function classesFor(ui) {
    const out = [];
    if (!ui) return out;
    for (const key in CLASS_MAP) {
      if (ui[key]) out.push(CLASS_MAP[key]);
    }
    return out;
  }

  /** Merge a preset's partial over the all-off defaults (for applying a preset). */
  function applyPreset(name, base) {
    const preset = PRESETS[name] || {};
    return Object.assign({}, base || {}, preset, { preset: name });
  }

  const api = { CLASS_MAP, PRESETS, classesFor, applyPreset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNUI = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
