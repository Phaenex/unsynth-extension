/**
 * Playback-state tab title — prefixes the browser tab title with ▶ while
 * playing / ⏸ while paused, so it's visible without switching to the tab.
 * Only ever reads/restores document.title; never touches player DOM.
 */
(function () {
  'use strict';

  let core = null;
  let video = null;
  let baseTitle = null; // the title with any prefix we added stripped off

  const PREFIX_RE = /^[▶⏸]\s/;

  // Gated solely by the module toggle (dashboard "Feature modules" checkbox) —
  // no redundant inner enabled flag with no UI to ever set it (see
  // docs/LESSONS.md for why that's a trap: ambient-mode.js has exactly this
  // dead-end shape today, an inner `enabled` default that nothing ever sets).
  function prefs() {
    return { enabled: !(core && core.settings && core.settings.modules && core.settings.modules.tabTitle === false) };
  }

  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video')
    );
  }

  function currentBase() {
    return document.title.replace(PREFIX_RE, '');
  }

  function updateTitle() {
    if (!prefs().enabled || !video) return;
    const prefix = video.paused || video.ended ? '⏸ ' : '▶ ';
    const base = currentBase();
    const next = prefix + base;
    if (document.title !== next) document.title = next;
  }

  function restoreTitle() {
    if (document.title !== currentBase()) document.title = currentBase();
  }

  function onPlay() {
    updateTitle();
  }
  function onPause() {
    updateTitle();
  }

  function detach() {
    if (!video) return;
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('ended', onPause);
    video = null;
    restoreTitle();
  }
  function attach() {
    if (!prefs().enabled) return;
    const v = findVideo();
    if (!v || v === video) return;
    detach();
    video = v;
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    updateTitle();
  }

  const mod = {
    id: 'tabTitle',
    moduleKey: 'tabTitle',
    init: function (c) {
      core = c;
      baseTitle = document.title;
      attach();
    },
    scan: function () {
      attach();
    },
    onNavigate: function () {
      detach();
      attach();
    },
    onSettings: function (s) {
      core.settings = s;
      if (!prefs().enabled) detach();
      else attach();
    },
    teardown: function () {
      detach();
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
