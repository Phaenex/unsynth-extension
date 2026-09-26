/**
 * Chapter navigation — jump to the next/previous creator-defined chapter.
 * Reads YouTube's own already-rendered chapter list (live-confirmed DOM:
 * ytd-macro-markers-list-renderer > ytd-macro-markers-list-item-renderer,
 * each with a real `<a href="…&t=<seconds>s">` link and an `h3.macro-markers`
 * title) rather than a guessed or scraped-from-text structure. No DOM
 * insertion near the player — only reads existing elements and mutates
 * video.currentTime, the same safe surface every other player-control
 * module here uses.
 */
(function () {
  'use strict';

  let core = null;

  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video')
    );
  }

  function isWatch() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }

  function getChapters() {
    const items = document.querySelectorAll('ytd-macro-markers-list-renderer ytd-macro-markers-list-item-renderer');
    const out = [];
    items.forEach((item) => {
      const link = item.querySelector('a#endpoint');
      const titleEl = item.querySelector('h3.macro-markers');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const m = href.match(/[?&]t=(\d+)s/);
      // The FIRST chapter links to the video with no t= at all (measured on
      // aircAruvnKk, 2026-09-24: "/watch?v=aircAruvnKk"), so it was skipped
      // and "Previous chapter" could never go back to the start. A chapter
      // link to the video with no time is 0:00.
      const start = m ? Number(m[1]) : (/[?&]v=/.test(href) ? 0 : null);
      if (start === null) return;
      if (out.some((c) => c.start === start)) return;
      out.push({ start: start, title: (titleEl && (titleEl.getAttribute('title') || titleEl.textContent) || '').trim() });
    });
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  function jump(direction) {
    const video = findVideo();
    if (!video) return;
    const chapters = getChapters();
    if (!chapters.length) return;
    const t = video.currentTime;
    if (direction > 0) {
      const next = chapters.find((c) => c.start > t + 0.5);
      if (next) video.currentTime = next.start;
    } else {
      // Jump to the start of the CURRENT chapter first (standard "previous
      // track" behavior); only skip to the prior chapter if already within
      // ~2s of the current one's start.
      let prevIdx = -1;
      for (let i = 0; i < chapters.length; i++) {
        if (chapters[i].start <= t - 0.5) prevIdx = i;
      }
      if (prevIdx === -1) {
        video.currentTime = 0;
        return;
      }
      if (t - chapters[prevIdx].start > 2 || prevIdx === chapters.length - 1) {
        video.currentTime = chapters[prevIdx].start;
      } else if (prevIdx > 0) {
        video.currentTime = chapters[prevIdx - 1].start;
      } else {
        video.currentTime = 0;
      }
    }
    if (window.UNSYNTH && window.UNSYNTH.showToast) {
      const cur = getChapters().find((c) => Math.abs(c.start - video.currentTime) < 1);
      if (cur) window.UNSYNTH.showToast(cur.title, { id: 'un-chapter-toast', duration: 1500 });
    }
  }

  // Moved from standalone player buttons into the Unsynth tools overflow
  // menu — occasional actions, not single-tap frequently-used controls
  // (see docs/LESSONS.md for why the player bar was reorganized).
  function ensureButtons() {
    if (!window.UNSYNTH || !window.UNSYNTH.addMenuItem) return;
    if (!isWatch() || !getChapters().length) {
      if (window.UNSYNTH.removeMenuItem) {
        window.UNSYNTH.removeMenuItem('un-chap-prev-btn');
        window.UNSYNTH.removeMenuItem('un-chap-next-btn');
      }
      return;
    }
    window.UNSYNTH.addMenuItem({
      id: 'un-chap-prev-btn',
      svg: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
      label: 'Previous chapter',
      onClick: function () {
        jump(-1);
      },
      priority: 43
    });
    window.UNSYNTH.addMenuItem({
      id: 'un-chap-next-btn',
      svg: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
      label: 'Next chapter',
      onClick: function () {
        jump(1);
      },
      priority: 44
    });
  }

  const mod = {
    id: 'chapters',
    moduleKey: 'chapters',
    init: function (c) {
      core = c;
      ensureButtons();
    },
    scan: function () {
      ensureButtons();
    },
    onNavigate: function () {
      ensureButtons();
    },
    onSettings: function (s) {
      core.settings = s;
      ensureButtons();
    },
    teardown: function () {
      if (window.UNSYNTH && window.UNSYNTH.removeMenuItem) {
        window.UNSYNTH.removeMenuItem('un-chap-prev-btn');
        window.UNSYNTH.removeMenuItem('un-chap-next-btn');
      }
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getChapters };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
