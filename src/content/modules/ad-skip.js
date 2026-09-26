/**
 * Ad skip — auto-clicks YouTube's own "Skip Ad" button the moment it renders,
 * and mutes non-skippable ads (restoring audio the instant the ad ends).
 *
 * Deliberately NOT network/declarativeNetRequest blocking: YouTube's in-stream
 * ads are server-side stitched into the same googlevideo.com CDN stream as the
 * real video, so there's no separate "ad domain" to block without breaking
 * playback outright. This only interacts with elements YouTube itself renders
 * as clickable/visible, the same way sponsorblock.js only mutates the real
 * <video> element it finds — never structural DOM insertion near #movie_player
 * (see docs/LESSONS.md for why that specifically broke things once already).
 *
 * IMPORTANT caveat (see docs/LESSONS.md "Automated/headless browser sessions do
 * not reliably get served real YouTube video ads"): the skip-button click path
 * only fires when YouTube renders a real, standard skip button, which is safe
 * by construction (it does nothing unless that exact element exists). The
 * ad-state detection used for muting (SKIP_SELECTOR misses, AD_STATE_SELECTORS
 * hits) is built from widely-documented YouTube player class names but was
 * NOT personally observed against a live ad this session — real ads never
 * triggered in dozens of attempts. If these selectors are stale, muting simply
 * never activates (safe no-op), it does not mute regular video playback.
 */
(function () {
  'use strict';

  let core = null;
  let video = null;
  let mutedByUs = false;
  let mo = null;
  let moHost = null; // the element `mo` is actually observing, for staleness checks

  function prefs() {
    const d = (core && core.settings && core.settings.adSkip) || {};
    return {
      autoSkip: d.autoSkip !== false,
      muteNonSkippable: d.muteNonSkippable !== false,
      hideOverlayAds: d.hideOverlayAds !== false
    };
  }

  function isWatch() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }

  function playerHost() {
    return document.querySelector('#movie_player') || document.querySelector('#shorts-player');
  }

  // Broad, pattern-based rather than one exact class name — resilient to the
  // exact class YouTube ships this redesign, since it targets what the button
  // IS (something whose class names say "skip" + "ad") rather than a single
  // guessed string. Clicking it is safe regardless: if nothing matches, this
  // is a pure no-op.
  function findSkipButton(host) {
    if (!host) return null;
    const candidates = host.querySelectorAll('button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, [class*="skip-ad" i], [class*="ad-skip" i]');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const cls = String(el.className || '');
      if (!/skip/i.test(cls) || !/ad/i.test(cls)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      return el;
    }
    return null;
  }

  // Corroborating, well-documented ad-state signals (not a single guessed
  // class) — see the module header caveat. Any one hit is enough.
  const AD_STATE_SELECTORS = ['.ad-showing', '.ad-interrupting', '.ytp-ad-text', '.ytp-ad-simple-ad-badge', '.ytp-ad-preview-text', '.ytp-ad-duration-remaining'];

  function adCurrentlyShowing(host) {
    if (!host) return false;
    if (AD_STATE_SELECTORS.some((sel) => host.querySelector(sel) || document.querySelector(sel))) return true;
    return /(^|\s)ad-showing(\s|$)/.test(host.className || '');
  }

  let overlayStyleEl = null;
  function applyOverlayHiding() {
    const hide = prefs().hideOverlayAds;
    if (hide && !overlayStyleEl) {
      overlayStyleEl = document.createElement('style');
      overlayStyleEl.id = 'un-adskip-hide-overlay';
      // Purely visual: companion/banner ad containers, never the video/audio
      // pipeline itself.
      overlayStyleEl.textContent =
        '.ytp-ad-overlay-container,.ytp-ad-overlay-slot,ytd-companion-slot-renderer,ytd-action-companion-ad-renderer,ytd-display-ad-renderer{display:none !important;}';
      (document.head || document.documentElement).appendChild(overlayStyleEl);
    } else if (!hide && overlayStyleEl) {
      overlayStyleEl.remove();
      overlayStyleEl = null;
    }
  }

  function tick() {
    const host = playerHost();
    if (!host) return;

    if (prefs().autoSkip) {
      const btn = findSkipButton(host);
      if (btn) {
        try {
          btn.click();
        } catch (e) {
          /* ignore */
        }
      }
    }

    if (prefs().muteNonSkippable && video) {
      const showing = adCurrentlyShowing(host);
      if (showing && !video.muted) {
        video.muted = true;
        mutedByUs = true;
      } else if (!showing && mutedByUs) {
        video.muted = false;
        mutedByUs = false;
      }
    }
  }

  function detachVideo() {
    if (!video) return;
    if (mutedByUs) {
      try {
        video.muted = false;
      } catch (e) {
        /* ignore */
      }
      mutedByUs = false;
    }
    video = null;
  }

  function attachVideo() {
    const v = document.querySelector('#movie_player video.html5-main-video, #movie_player video, #shorts-player video');
    if (!v || v === video) return;
    detachVideo();
    video = v;
  }

  function ensureObserver() {
    const host = playerHost();
    // Rebuild whenever the live player host isn't the one we're watching —
    // not just when `mo` is falsy. `if (mo) return` alone kept observing
    // whatever element was current at the FIRST setup() call forever: a
    // watch<->Shorts transition swaps #movie_player for #shorts-player (or
    // YouTube remounts ytd-watch-flexy), the old host can go stale/detached,
    // and `mo` silently kept wiring class-attribute mutations from a dead
    // subtree — ad-mute (which only has this observer as its signal; unlike
    // auto-skip, which core's own global mutation-driven scan() also
    // re-triggers) went silently dark until the module happened to leave and
    // re-enter a watch/shorts context via the disconnect branch in setup().
    if (mo && moHost === host && host.isConnected) return;
    disconnectObserver();
    if (!host) return;
    mo = new MutationObserver(tick);
    mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    moHost = host;
  }

  function disconnectObserver() {
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    moHost = null;
  }

  function setup() {
    if (!isWatch() && !location.pathname.startsWith('/shorts/')) {
      disconnectObserver();
      detachVideo();
      return;
    }
    attachVideo();
    ensureObserver();
    applyOverlayHiding();
    tick();
  }

  const mod = {
    id: 'adSkip',
    moduleKey: 'adSkip',
    init: function (c) {
      core = c;
      setup();
    },
    scan: function () {
      setup();
    },
    onNavigate: function () {
      detachVideo();
      setup();
    },
    onSettings: function (s) {
      core.settings = s;
      applyOverlayHiding();
      setup();
    },
    teardown: function () {
      disconnectObserver();
      detachVideo();
      if (overlayStyleEl) {
        overlayStyleEl.remove();
        overlayStyleEl = null;
      }
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { findSkipButton, adCurrentlyShowing };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
