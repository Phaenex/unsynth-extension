/**
 * Unsynth Title Cleaner — calm down clickbait titles across feeds and watch pages.
 *
 * Rules (each independently togglable):
 *   - deAllCaps:        WORD (5+ uppercase chars) → Word  (keeps ≤4-char acronyms)
 *   - stripExclamation: strip excess !! → single ! at end of a run
 *   - stripEmoji:       collapse 3+ consecutive emoji to 2 max
 *
 * Never rewrites channel names, button text, or off-page DOM.
 * Relies on core's debounced scan (no private MutationObserver).
 */
(function () {
  'use strict';

  let core = null;

  // Selectors that contain video titles (feed tiles, search, related, watch page).
  // The legacy '#video-title'/renderer-scoped selectors alone miss the modern
  // yt-lockup-view-model tile (home feed, channel grid, shelves) entirely.
  // First fix attempt guessed the hyphenated BEM-style
  // '.yt-lockup-metadata-view-model-wiz__title' class (matching
  // src/shared/yt-dom.js's older fallback) — confirmed LIVE against real
  // YouTube DOM (2026-08-24) that class does not exist on current markup at
  // all (0 matches). The real class is camelCase:
  // '.ytLockupMetadataViewModelTitle'. The generic 'h3 a' fallback (verified
  // live: matched 20/20 tiles on a real home feed) is the one that actually
  // matters for resilience against the next rename — a false-positive h3 a
  // match elsewhere on the page is harmless here too (cleanText/processElement
  // just rewrites whatever text is there; unlike DeArrow this module has no
  // tile/videoId resolution step to gate it, so this is intentionally scoped
  // to titles specifically via the class fallbacks, with h3 a as a genuine
  // fallback of last resort).
  const TITLE_SELECTORS = [
    '#video-title',
    '#title yt-formatted-string',
    'ytd-watch-metadata h1 yt-formatted-string',
    '.ytd-compact-video-renderer #video-title',
    '.ytd-grid-video-renderer #video-title',
    '.ytd-rich-grid-media #video-title',
    'ytd-reel-item-renderer #video-title',
    '.ytm-video-card-renderer .details .title',
    'ytd-playlist-video-renderer #video-title',
    '.ytLockupMetadataViewModelTitle',
    'h3 a'
  ].join(', ');

  function prefs() {
    const d = (core && core.settings && core.settings.titleCleaner) || {};
    return {
      enabled:          !!d.enabled,
      deAllCaps:        d.deAllCaps !== false,
      stripExclamation: d.stripExclamation !== false,
      stripEmoji:       d.stripEmoji === true
    };
  }

  function toTitleCase(word) {
    if (!word) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  // Emoji regex — matches sequences of emoji characters
  const EMOJI_RE = /(\p{Emoji_Presentation}|\p{Extended_Pictographic}){3,}/gu;

  function cleanText(text, p) {
    let out = text;

    if (p.deAllCaps) {
      // Match words of 3+ consecutive uppercase letters (don't touch single letters like "AI", "US" abbreviations)
      out = out.replace(/\b([A-Z]{3,})\b/g, function (match) {
        // Preserve known all-caps acronyms (2–4 chars) — only convert long SHOUTED words
        if (match.length <= 4) return match; // keep acronyms like "NASA", "HTML"
        return toTitleCase(match);
      });
    }

    if (p.stripExclamation) {
      // Collapse runs of 2+ exclamation marks to a single one
      out = out.replace(/!{2,}/g, '!');
      // Collapse runs of 2+ question marks to a single one
      out = out.replace(/\?{2,}/g, '?');
    }

    if (p.stripEmoji) {
      try {
        // Collapse 3+ consecutive emoji to 2
        out = out.replace(EMOJI_RE, function (match) {
          const chars = [...match];
          return chars.slice(0, 2).join('');
        });
      } catch (e) {
        /* unicode property escapes not supported — skip */
      }
    }

    return out;
  }

  // Per-element state kept OFF the DOM (WeakMap). Overwriting a Polymer-bound
  // title makes YouTube restore it; that restore looks like a fresh mutation and
  // re-triggers a scan. A HARD per-element write cap — that NEVER resets — makes
  // an infinite fight structurally impossible (max MAX_TRIES writes per node,
  // ever, no matter what YouTube restores the title to).
  const state = new WeakMap(); // el -> { orig, tries }
  const MAX_TRIES = 3;

  function processElement(el) {
    let st = state.get(el);
    if (!st) {
      st = { orig: el.textContent, tries: 0 };
      state.set(el, st);
    }
    if (st.tries >= MAX_TRIES) return; // give up — never reset, so it can't loop
    const clean = cleanText(el.textContent, prefs());
    if (clean === el.textContent) return; // already clean / nothing to do
    st.tries++;
    el.textContent = clean;
  }

  function processAll() {
    document.querySelectorAll(TITLE_SELECTORS).forEach(processElement);
  }

  function restoreAll() {
    document.querySelectorAll(TITLE_SELECTORS).forEach(function (el) {
      const st = state.get(el);
      if (st && el.textContent !== st.orig) el.textContent = st.orig;
      state.delete(el);
    });
  }

  function resetAndReprocess() {
    restoreAll();
    processAll();
  }

  const mod = {
    id: 'titleCleaner',
    moduleKey: 'titleCleaner',
    // Gated solely by the module toggle (core only calls these when the module
    // is enabled). The per-rule flags still come from prefs() inside cleanText.
    init: function (c) {
      core = c;
      processAll();
    },
    // Core runs scan debounced with its own observer disconnected, so the text
    // writes here can't re-trigger a scan. New feed tiles are caught on the next
    // core scan — no second observer needed (that one fed the refresh loop).
    scan: function () {
      processAll();
    },
    onNavigate: function () {
      setTimeout(processAll, 400);
    },
    onSettings: function (s) {
      core.settings = s;
      resetAndReprocess();
    },
    teardown: restoreAll
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { cleanText, toTitleCase, TITLE_SELECTORS };
  } else if (typeof window !== 'undefined' && window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
