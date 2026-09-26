'use strict';

/**
 * WHICH VIEWS EXIST RIGHT NOW, AND WHAT THE LAUNCHER SHOULD DO ABOUT IT.
 *
 * The inventory established that aiAssistant, forgeLink and queueAdvance ALL
 * ship disabled, so every combination of the three is a state a real user can
 * be in — eight of them, not one happy path plus edge cases.
 *
 * Two rules the plan states and this enforces:
 *
 *   Never silently enable a module. A panel that turns on a feature because a
 *   view looked empty is making a settings change the user did not ask for.
 *
 *   Never show a working-looking control for an unavailable feature. A greyed
 *   Summarize button that does nothing is worse than no button, because the
 *   user cannot tell whether it is broken or off.
 *
 * So a disabled module contributes NO view. It is not rendered as an empty tab
 * or a disabled tab: it is absent, and the panel offers one explicit enable
 * path instead of pretending the feature is present.
 *
 * With nothing enabled there is no drawer to open, so the launcher is OMITTED
 * rather than opening an empty panel — settings stay reachable from the
 * dashboard, which is where module toggles live anyway.
 */
(function (root) {
  /**
   * View ownership. Watch is AI-backed, Discover is Forge-backed, Queue is
   * queue-backed. Library is deliberately NOT tied to one module: playlist
   * selection and drafts are panel-level state, and the plan puts the
   * queue→playlist bridge there, so it appears whenever anything that can
   * produce a playlist action is on.
   */
  var VIEW_OWNERS = {
    watch: ['aiAssistant'],
    discover: ['forgeLink'],
    library: ['forgeLink', 'queueAdvance'],
    queue: ['queueAdvance']
  };

  var VIEW_ORDER = ['watch', 'discover', 'library', 'queue'];

  var LABELS = {
    watch: 'Watch',
    discover: 'Discover',
    library: 'Library',
    queue: 'Queue'
  };

  /** Modules a view needs, of which ANY ONE being enabled is enough. */
  function viewAvailable(view, enabled) {
    var owners = VIEW_OWNERS[view] || [];
    for (var i = 0; i < owners.length; i++) {
      if (enabled && enabled[owners[i]]) return true;
    }
    return false;
  }

  /**
   * @param enabled { aiAssistant, forgeLink, queueAdvance } booleans
   * @returns {
   *   views:        view ids that actually exist, in order
   *   labels:       id -> label, for the ones that exist
   *   showLauncher: false when there is nothing to open
   *   reason:       why the launcher is hidden, when it is
   *   disabled:     modules that are off, so one enable path can name them
   * }
   */
  function resolve(enabled) {
    enabled = enabled || {};
    var views = [];
    for (var i = 0; i < VIEW_ORDER.length; i++) {
      if (viewAvailable(VIEW_ORDER[i], enabled)) views.push(VIEW_ORDER[i]);
    }
    var labels = {};
    for (var j = 0; j < views.length; j++) labels[views[j]] = LABELS[views[j]];

    var disabled = [];
    var all = ['aiAssistant', 'forgeLink', 'queueAdvance'];
    for (var k = 0; k < all.length; k++) {
      if (!enabled[all[k]]) disabled.push(all[k]);
    }

    return {
      views: views,
      labels: labels,
      // NO VIEWS MEANS NO LAUNCHER. An empty drawer is a dead control, and the
      // plan forbids it explicitly. The dashboard still reaches every setting.
      showLauncher: views.length > 0,
      reason: views.length ? null : 'all-modules-disabled',
      disabled: disabled
    };
  }

  /**
   * Which view should be shown, given what exists and what was last open.
   *
   * Returns null only when nothing exists. Falls back to the first available
   * view rather than to a fixed default, because the fixed default may be the
   * one that was just turned off — which is the live-toggle case: a module can
   * be disabled while the panel is open.
   */
  function pickView(available, preferred) {
    if (!available || !available.length) return null;
    if (preferred && available.indexOf(preferred) !== -1) return preferred;
    return available[0];
  }

  /**
   * Did availability change in a way the open panel must react to?
   *
   * Used when settings change while the panel is open: a view disappearing
   * under the user needs a route change, a view appearing does not.
   */
  function diff(before, after) {
    var b = (before && before.views) || [];
    var a = (after && after.views) || [];
    var removed = b.filter(function (v) { return a.indexOf(v) === -1; });
    var added = a.filter(function (v) { return b.indexOf(v) === -1; });
    return { removed: removed, added: added, changed: removed.length > 0 || added.length > 0 };
  }

  var api = {
    VIEW_ORDER: VIEW_ORDER,
    VIEW_OWNERS: VIEW_OWNERS,
    LABELS: LABELS,
    resolve: resolve,
    pickView: pickView,
    diff: diff,
    viewAvailable: viewAvailable
  };

  if (root) root.UNPanelAvailability = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
