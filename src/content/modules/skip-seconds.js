/**
 * Skip seconds — player buttons that seek the video back/forward by a
 * configurable number of seconds (default 10s), mirroring what a keyboard
 * shortcut like J/L already does, as a clickable equivalent on the player
 * bar itself.
 *
 * addPlayerButton() only applies title/class/svg on first creation, not on
 * later calls (see docs/LESSONS.md) — since the icon needs to show the
 * CURRENT configured seconds value and that can change at runtime, the
 * button DOM nodes are mutated directly on every settings update, the same
 * workaround clip-capture.js already established for its recording-state
 * indicator.
 */
(function () {
  'use strict';

  let core = null;
  let lastRenderedSeconds = null;

  function prefs() {
    const d = (core && core.settings && core.settings.skipSeconds) || {};
    return {
      enabled: d.enabled !== false,
      showButtons: d.showButtons !== false,
      seconds: Number(d.seconds) > 0 ? Number(d.seconds) : 10
    };
  }

  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video')
    );
  }

  function skip(delta) {
    const video = findVideo();
    if (!video || !isFinite(video.duration)) return;
    const next = Math.min(Math.max(0, video.currentTime + delta), video.duration);
    video.currentTime = next;
  }

  function onPlayerPage() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }

  // Double-chevron "skip" glyph with the configured seconds rendered below it.
  function buildSvg(direction, seconds) {
    const arrowPath =
      direction === 'back'
        ? 'M11 5 4 11l7 6V5zM19 5l-7 6 7 6V5z'
        : 'M13 5l7 6-7 6V5zM5 5l7 6-7 6V5z';
    return (
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
      '<path fill="currentColor" d="' + arrowPath + '"/>' +
      '<text x="12" y="23" font-size="6.5" font-weight="700" text-anchor="middle" fill="currentColor">' + seconds + '</text>' +
      '</svg>'
    );
  }

  function ensureButtons() {
    const p = prefs();
    if (!p.showButtons || !onPlayerPage()) {
      removeButtons();
      return;
    }
    if (!window.UNSYNTH || !window.UNSYNTH.addPlayerButton) return;
    window.UNSYNTH.addPlayerButton({
      id: 'un-skip-back-btn',
      svg: buildSvg('back', p.seconds),
      title: 'Back ' + p.seconds + 's (Unsynth)',
      ariaLabel: 'Skip back ' + p.seconds + ' seconds',
      // Reads prefs() fresh at CLICK time, not p.seconds captured in this
      // closure — addPlayerButton() only registers the click listener once,
      // on first creation (see docs/LESSONS.md), so a closure capturing
      // today's seconds value would keep using it forever even after the
      // user changes the setting. Confirmed live: without this, changing
      // the dashboard setting correctly updated the button's icon/label but
      // clicking it kept seeking by the OLD amount.
      onClick: function () { skip(-prefs().seconds); },
      cls: 'un-skip-btn',
      priority: 41
    });
    window.UNSYNTH.addPlayerButton({
      id: 'un-skip-fwd-btn',
      svg: buildSvg('forward', p.seconds),
      title: 'Forward ' + p.seconds + 's (Unsynth)',
      ariaLabel: 'Skip forward ' + p.seconds + ' seconds',
      onClick: function () { skip(prefs().seconds); },
      cls: 'un-skip-btn',
      priority: 42
    });
    // Re-apply the icon/labels directly when the configured seconds value
    // changes — addPlayerButton() only sets these on first creation.
    if (lastRenderedSeconds !== p.seconds) {
      lastRenderedSeconds = p.seconds;
      const back = document.getElementById('un-skip-back-btn');
      if (back) {
        back.innerHTML = buildSvg('back', p.seconds);
        back.title = 'Back ' + p.seconds + 's (Unsynth)';
        back.setAttribute('aria-label', 'Skip back ' + p.seconds + ' seconds');
      }
      const fwd = document.getElementById('un-skip-fwd-btn');
      if (fwd) {
        fwd.innerHTML = buildSvg('forward', p.seconds);
        fwd.title = 'Forward ' + p.seconds + 's (Unsynth)';
        fwd.setAttribute('aria-label', 'Skip forward ' + p.seconds + ' seconds');
      }
    }
  }

  function removeButtons() {
    if (window.UNSYNTH && window.UNSYNTH.removePlayerButton) {
      window.UNSYNTH.removePlayerButton('un-skip-back-btn');
      window.UNSYNTH.removePlayerButton('un-skip-fwd-btn');
    }
  }

  const mod = {
    id: 'skipSeconds',
    moduleKey: 'skipSeconds',
    init: function (c) {
      core = c;
      ensureButtons();
    },
    scan: function () {
      ensureButtons();
    },
    onNavigate: function () {
      lastRenderedSeconds = null; // force a fresh label re-apply on the new page's buttons
      ensureButtons();
    },
    onSettings: function (s) {
      core.settings = s;
      ensureButtons();
    },
    teardown: removeButtons
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { skip };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
