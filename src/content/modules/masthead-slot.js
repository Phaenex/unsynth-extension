/**
 * Shared YouTube masthead slot.
 *
 * Phase 5: core.ensureMastheadShell() is the SOLE owner of the masthead DOM
 * (shell + watched bar + extra-actions container, and the ordering between
 * them). This module no longer builds any DOM itself — it only exposes helpers
 * that delegate to core so existing callers (sub-manager, watch-history,
 * playlist-manager) keep working while there is a single source of truth.
 */
(function () {
  'use strict';

  function mastheadAnchor() {
    return (
      document.querySelector('ytd-masthead #end #buttons') ||
      document.querySelector('ytd-masthead #end') ||
      document.querySelector('#masthead #end')
    );
  }

  function ensureMastheadStructure() {
    if (window.UNSYNTH && typeof window.UNSYNTH.ensureMastheadShell === 'function') {
      return window.UNSYNTH.ensureMastheadShell();
    }
    // Fallback only if core somehow isn't present yet — read whatever exists.
    var shell = document.getElementById('un-synth-masthead-bar');
    if (!shell) return null;
    return {
      shell: shell,
      bar: document.getElementById('un-watched-feed-toggle'),
      extra: document.getElementById('un-synth-masthead-extra')
    };
  }

  window.UNMastheadSlot = { mastheadAnchor: mastheadAnchor, ensureMastheadStructure: ensureMastheadStructure };
})();
