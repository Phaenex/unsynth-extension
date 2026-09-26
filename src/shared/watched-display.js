/**
 * Watched-video display settings — combinable options (badges, dim/hide, feed filter).
 * Legacy single `watchedMode` preset strings are migrated automatically.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.UNWatchedDisplay = factory();
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const DEFAULT = {
    badges: true,
    finished: 'dim', // show | dim | hide — product default matches defaults.js / recommended profile
    feedFilter: 'all', // all | only-watched | only-unseen | today
    hidePartial: false, // hide started-but-not-finished tiles
    // Independent of the watched radio above — members-only is a property of
    // the video, not of whether you have seen it, so it stacks with any view
    // rather than being another mutually-exclusive option.
    hideMembersOnly: false
  };

  const LEGACY = {
    off: { badges: false, finished: 'show', feedFilter: 'all', hidePartial: false },
    mark: { badges: true, finished: 'show', feedFilter: 'all', hidePartial: false },
    dim: { badges: true, finished: 'dim', feedFilter: 'all', hidePartial: false },
    hide: { badges: false, finished: 'hide', feedFilter: 'all', hidePartial: false },
    only: { badges: true, finished: 'show', feedFilter: 'only-watched', hidePartial: false },
    hidestarted: { badges: true, finished: 'show', feedFilter: 'all', hidePartial: true }
  };

  const PRESETS = [
    { id: 'off', label: 'Off', desc: 'No badges or filtering' },
    { id: 'mark', label: 'Mark only', desc: 'Badges on watched / in-progress' },
    { id: 'dim', label: 'Dim watched', desc: 'Badges + dim finished videos' },
    { id: 'hide', label: 'Hide watched', desc: 'Remove finished videos from feeds' },
    { id: 'only', label: 'Only watched', desc: 'Show only finished videos' },
    { id: 'hidestarted', label: 'Only unseen', desc: 'Hide anything you started' }
  ];

  function normalize(watchedDisplay, watchedMode) {
    if (watchedDisplay && typeof watchedDisplay === 'object') {
      const w = Object.assign({}, DEFAULT, watchedDisplay);
      if (!['show', 'dim', 'hide'].includes(w.finished)) w.finished = 'show';
      // 'today' MUST be listed here. The masthead's Today chip writes it
      // (watch-history.js setFeedView) and two consumers read it back
      // (feedViewKey, and the apply() branch that does the actual filtering),
      // but it was missing from this whitelist, so every write was silently
      // coerced to 'all'. The chip then lit up "All" and filtered nothing, with
      // no error anywhere. A value the UI can write and this function rejects is
      // unreachable state, so keep this list and the writers in step.
      if (!['all', 'only-watched', 'only-unseen', 'today'].includes(w.feedFilter)) w.feedFilter = 'all';
      w.badges = !!w.badges;
      w.hidePartial = !!w.hidePartial;
      w.hideMembersOnly = !!w.hideMembersOnly;
      return w;
    }
    return Object.assign({}, DEFAULT, LEGACY[watchedMode || 'off'] || LEGACY.off);
  }

  function toLegacyMode(w) {
    const n = normalize(w);
    for (const [k, v] of Object.entries(LEGACY)) {
      if (
        n.badges === v.badges &&
        n.finished === v.finished &&
        n.feedFilter === v.feedFilter &&
        n.hidePartial === v.hidePartial
      ) {
        return k;
      }
    }
    return 'mark';
  }

  function preset(id) {
    return Object.assign({}, DEFAULT, LEGACY[id] || LEGACY.off);
  }

  // Pure decision: what should happen to one feed tile given the display settings
  // and its watch state? Returns 'hide' | 'dim' | '' (show). Extracted from the
  // content-script apply() loop so it's unit-testable without a DOM. When the
  // "YT Default" peek is on, nothing is hidden/dimmed — YouTube's native feed.
  function tileWant(watchedDisplay, full, started, defaultFeedOn) {
    if (defaultFeedOn) return '';
    const w = normalize(watchedDisplay);
    if (w.hidePartial && started) return 'hide';
    if (w.feedFilter === 'only-unseen' && started) return 'hide';
    if (w.feedFilter === 'only-watched' && !full) return 'hide';
    if (w.finished === 'hide' && full) return 'hide';
    if (w.finished === 'dim' && full) return 'dim';
    return '';
  }

  return { DEFAULT, LEGACY, PRESETS, normalize, preset, toLegacyMode, tileWant };
});
