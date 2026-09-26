/**
 * Comment filter — hide comments matching user keywords. Reuses the same
 * word-boundary-aware matcher ai-filter.js/sub-manager.js already rely on
 * (shared/match.js's makeMatcher + titleMatch, generic over any string, not
 * just video titles) rather than a new, unproven substring check.
 *
 * Hide-only (display:none on the thread), never reorders or removes DOM
 * nodes — YouTube owns and virtualizes this list; reordering it would risk
 * fighting its own lazy-load/pagination logic. Sorting is left to YouTube's
 * own native "Sort by" control, which already exists and isn't reimplemented
 * here.
 */
(function () {
  'use strict';

  let core = null;

  function prefs() {
    const d = (core && core.settings && core.settings.commentFilter) || {};
    return {
      keywords: Array.isArray(d.keywords) ? d.keywords : [],
      useRegex: !!d.useRegex
    };
  }

  function matcher() {
    const p = prefs();
    if (!p.keywords.length) return null;
    return window.UNMatch ? window.UNMatch.makeMatcher({ keywords: p.keywords, useRegex: p.useRegex }) : null;
  }

  // Same fallback chain fact-check.js already added for the identical
  // element (comment body text) — a bare '#content-text' silently returns
  // nothing on markup where the id moved to a nested yt-formatted-string or
  // legacy-renderer-scoped element, and commentText('') always fails to
  // match any keyword, so a comment that should be hidden silently isn't.
  function commentText(thread) {
    const el = thread.querySelector('#content-text, yt-formatted-string#content-text, .ytd-comment-renderer #content-text');
    return el ? el.textContent || '' : '';
  }

  function processThread(thread, m) {
    if (!m) {
      if (thread.classList.contains('un-cf-hidden')) thread.classList.remove('un-cf-hidden');
      return;
    }
    const text = commentText(thread);
    const result = m.titleMatch(text);
    thread.classList.toggle('un-cf-hidden', !!(result && result.hit));
  }

  function scanComments() {
    const m = matcher();
    document.querySelectorAll('ytd-comment-thread-renderer').forEach((thread) => {
      processThread(thread, m);
    });
  }

  function clearAll() {
    document.querySelectorAll('.un-cf-hidden').forEach((t) => t.classList.remove('un-cf-hidden'));
  }

  const mod = {
    id: 'commentFilter',
    moduleKey: 'commentFilter',
    init: function (c) {
      core = c;
      scanComments();
    },
    scan: function () {
      scanComments();
    },
    onNavigate: function () {
      clearAll();
      scanComments();
    },
    onSettings: function (s) {
      core.settings = s;
      scanComments();
    },
    teardown: clearAll
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { commentText };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
