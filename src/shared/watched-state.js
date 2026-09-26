/**
 * Watch state used for feed filtering, merged from two sources.
 *
 * The extension's own store (watchedVideos / watchProgress) only contains what
 * the extension itself observed, plus Takeout / Watchmarker imports. YouTube
 * draws its red resume bar from server-side history, which additionally covers
 * videos watched on a phone, in another browser, or before the extension was
 * installed. That gap is why a tile can show a completely full red bar and
 * still not be hidden by "Hide watched" — the local store has genuinely never
 * heard of it.
 *
 * Two rules govern the merge, and both matter:
 *
 *   1. Native progress may only ADD watched signal. It never clears a local
 *      watched flag and never lowers a higher locally-tracked percentage.
 *      YouTube's bar resets in ways the local store should not follow (a
 *      cleared history, a signed-out session), so treating it as authoritative
 *      in the downward direction would silently un-watch finished videos.
 *
 *   2. It is a display and filtering input ONLY. It never reaches the persisted
 *      store. YouTube's bar reports a percentage and never a date, so writing it
 *      to watchedVideos / watchedDates would require inventing a timestamp —
 *      exactly what the watchedDatesApprox contract in shared/watch-queue.js
 *      forbids: "An approximate date is therefore no date at all." A fabricated
 *      "just now" stamp always sorts later than a queue add and re-creates the
 *      data-loss incident that contract was written to prevent.
 *
 * Thresholds are the ones watch-history.js already uses, passed in rather than
 * redefined, so the two can never disagree about what "started" or "finished"
 * means.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.UNWatchedState = factory();
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /** Mirrors MIN_PARTIAL_UI in content/modules/watch-history.js. */
  var MIN_PARTIAL_UI = 20;

  function clampThreshold(t) {
    var n = Number(t);
    return n >= 50 && n <= 95 ? n : 75;
  }

  /**
   * @param {Object} o
   * @param {boolean} o.full      video is in the local watched set
   * @param {number}  o.part      locally tracked percentage (0 when unknown)
   * @param {?number} o.nativePct YouTube's own resume-bar percentage, or null
   *                              when the tile has no bar. Null means "YouTube
   *                              is not claiming anything" and is never read as
   *                              zero, which would be a claim of its own.
   * @param {number}  o.threshold the user's watchedThreshold (50-95, default 75)
   * @returns {{full:boolean, part:number, started:boolean, fromNative:boolean}}
   */
  function mergeNativeProgress(o) {
    o = o || {};
    var full = !!o.full;
    var part = Number(o.part) > 0 ? Number(o.part) : 0;
    var threshold = clampThreshold(o.threshold);
    var fromNative = false;

    var native = o.nativePct;
    var hasNative = native !== null && native !== undefined && isFinite(Number(native));

    if (hasNative && !full) {
      var pct = Number(native);
      if (pct >= threshold) {
        full = true;
        fromNative = true;
      } else if (pct >= MIN_PARTIAL_UI && pct > part) {
        // Upward only: a lower native reading never overwrites a higher local one.
        part = pct;
        fromNative = true;
      }
    }

    var started = full || part >= MIN_PARTIAL_UI;
    return { full: full, part: part, started: started, fromNative: fromNative };
  }

  return { MIN_PARTIAL_UI: MIN_PARTIAL_UI, mergeNativeProgress: mergeNativeProgress };
});
