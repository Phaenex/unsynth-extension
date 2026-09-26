/**
 * Coordinates AI + Forge slide-out panels so they dock side-by-side instead of overlapping.
 */
(function (g) {
  'use strict';

  function q(sel) {
    return document.querySelector(sel);
  }

  function panelWidth(root, panelSel, fallback) {
    if (!root || !root.classList.contains('open')) return 0;
    var panel = root.querySelector(panelSel);
    if (!panel) return fallback;
    var w = panel.getBoundingClientRect().width;
    return w > 0 ? w : fallback;
  }

  function sync() {
    var ai = q('.un-ai-root');
    var forge = q('.un-forge-root');
    var aiOpen = !!(ai && ai.classList.contains('open') && !ai.classList.contains('un-ai-docked'));
    var forgeOpen = !!(forge && forge.classList.contains('open'));
    var aiW = aiOpen ? panelWidth(ai, '.un-ai-panel', 380) : 0;
    var forgeW = forgeOpen ? panelWidth(forge, '.un-forge-panel', 420) : 0;
    var html = document.documentElement;
    html.style.setProperty('--un-dock-ai-w', aiW ? aiW + 'px' : '0px');
    html.style.setProperty('--un-dock-forge-w', forgeW ? forgeW + 'px' : '0px');
    html.classList.toggle('un-dock-ai-open', aiOpen);
    html.classList.toggle('un-dock-forge-open', forgeOpen);
    html.classList.toggle('un-dock-both-open', aiOpen && forgeOpen);
  }

  var raf = 0;
  function schedule() {
    if (raf) return;
    raf = g.requestAnimationFrame(function () {
      raf = 0;
      sync();
    });
  }

  if (g) {
    g.addEventListener('resize', schedule);
    g.UNSideDock = { sync: sync, schedule: schedule };
  }
})(typeof window !== 'undefined' ? window : null);
