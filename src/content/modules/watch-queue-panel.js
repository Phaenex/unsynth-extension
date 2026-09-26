/**
 * Forge Queue tab — YouTube's Up next panel is the queue UI now.
 */
(function () {
  'use strict';

  function el(tag, cls, text) { return window.UNSYNTH.el(tag, cls, text); }

  function createQueuePanel() {
    function mount(sectionEl) {
      sectionEl.textContent = '';
      sectionEl.appendChild(el('p', 'un-forge-hint', 'Use YouTube\'s Up next panel. +Q and Play next write there now — this tab no longer keeps a second list.'));
      return {
        refresh: function () {},
        destroy: function () {}
      };
    }
    return { mount: mount };
  }

  window.UNWatchQueuePanel = { create: createQueuePanel };
})();
