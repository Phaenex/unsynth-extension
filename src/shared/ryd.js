/**
 * Return YouTube Dislike helpers — formatting and like/dislike ratio.
 * Vote data is fetched via the service worker (UNSYNTH/RYD/VOTES).
 */
(function (g) {
  'use strict';

  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'K';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function likeRatio(likes, dislikes) {
    const l = Number(likes) || 0;
    const d = Number(dislikes) || 0;
    const t = l + d;
    if (!t) return null;
    return (l / t) * 100;
  }

  /**
   * "3.3y ago" / "2mo ago" / "yesterday" for a timestamp.
   *
   * Shared because the watch stats row and the analytics date chip both show
   * an upload age and must agree — two private copies would be free to drift
   * into disagreeing about the same video.
   */
  // FLOORED, never rounded. An age is a claim about time that has passed, and
  // rounding up claims time that has not: a video 8.96 years old printed
  // "9y ago" one line below YouTube's own "8y ago" for the same upload
  // (observed 2026-09-22, aircAruvnKk). YouTube floors; so does this, keeping
  // one decimal under ten years so it still adds precision rather than
  // contradicting the host.
  function relativeAge(t) {
    const days = Math.max(0, (Date.now() - t) / 86400000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 30) return Math.floor(days) + 'd ago';
    if (days < 365) return Math.max(1, Math.floor(days / 30)) + 'mo ago';
    const yrs = days / 365;
    return (yrs < 10 ? String(Math.floor(yrs * 10) / 10) : Math.floor(yrs)) + 'y ago';
  }

  /**
   * The ratio as a label, honest about rounding.
   *
   * A video with ANY dislikes is not "100% liked", and toFixed() said it was:
   * measured 2026-09-21 on a live rail tile, "▲235K ▼844 100%" — 99.64 rounded
   * up and the label contradicted the two numbers beside it. When dislikes
   * exist and the rounded value reaches 100, drop to one decimal capped below
   * 100, so the label stays true to the votes that produced it. Every renderer
   * formats through this so they cannot disagree about the same video.
   */
  function ratioLabel(likes, dislikes, decimals) {
    const r = likeRatio(likes, dislikes);
    if (r == null) return null;
    const dis = Number(dislikes) || 0;
    let s = r.toFixed(decimals == null ? 0 : decimals);
    if (dis > 0 && Number(s) >= 100) s = Math.min(r, 99.9).toFixed(1);
    return s + '%';
  }
  g.UNRyd = { fmt, likeRatio, ratioLabel, relativeAge };
})(typeof self !== 'undefined' ? self : window);
