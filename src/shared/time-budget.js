'use strict';

/**
 * "I have 90 minutes. What actually fits?"
 *
 * WHY A PLAYLIST CANNOT ANSWER THIS TODAY
 * The question people actually have about a backlog is not "how long is it" but
 * "what can I finish tonight". Answering needs durations per video, which no
 * playlist surface carries — so the question has never been askable, and people
 * guess by eyeballing thumbnails.
 *
 * WHAT IT REFUSES TO DO
 *   - It will not pack a video whose duration is unknown. Including one would
 *     make the fit a guess, and a plan that overruns is worse than a shorter one
 *     that holds. Unknowns are reported separately, never silently skipped.
 *   - It packs in PLAYLIST ORDER by default rather than greedily by size.
 *     Reordering someone's queue to squeeze in more minutes optimises the wrong
 *     thing: a playlist is usually in its order on purpose.
 *
 * Pure: no DOM, no chrome APIs. The caller supplies ids and durations.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNTimeBudget = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, function () {

  function isFiniteNum(n) {
    return typeof n === 'number' && isFinite(n) && n > 0;
  }

  /**
   * @param opts.videoIds   candidates, in the order they should be considered.
   * @param opts.durations  { videoId: seconds }
   * @param opts.watched    Set/array to skip (already finished).
   * @param opts.budgetSec  how much time is available.
   * @param opts.fill       when true, keep scanning past a video that does not
   *                        fit to pick up shorter ones behind it. Default false:
   *                        stop at the first that does not fit, which preserves
   *                        the run as a contiguous stretch of the playlist.
   * @returns {{ picked, seconds, remaining, skippedUnknown, skippedTooLong,
   *             exhausted }}
   */
  function fitToBudget(opts) {
    opts = opts || {};
    var ids = Array.isArray(opts.videoIds) ? opts.videoIds : [];
    var durations = opts.durations || {};
    var budget = Number(opts.budgetSec);
    var watchedSet = null;
    if (opts.watched) {
      watchedSet = opts.watched instanceof Set ? opts.watched : new Set(opts.watched);
    }
    if (!isFiniteNum(budget)) {
      return { picked: [], seconds: 0, remaining: 0, skippedUnknown: 0, skippedTooLong: 0, exhausted: false };
    }

    var picked = [];
    var seconds = 0;
    var skippedUnknown = 0;
    var skippedTooLong = 0;
    var stopped = false;

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (!id) continue;
      if (watchedSet && watchedSet.has(id)) continue;
      var d = Number(durations[id]);
      if (!isFiniteNum(d)) {
        // Never packed. A fit built on a guessed length is not a fit.
        skippedUnknown++;
        continue;
      }
      if (seconds + d <= budget) {
        picked.push(id);
        seconds += d;
        continue;
      }
      skippedTooLong++;
      if (!opts.fill) { stopped = true; break; }
    }

    return {
      picked: picked,
      seconds: seconds,
      remaining: Math.max(0, budget - seconds),
      skippedUnknown: skippedUnknown,
      skippedTooLong: skippedTooLong,
      // True when the whole list was considered rather than cut short.
      exhausted: !stopped
    };
  }

  /**
   * The sentence. Names what it could not consider, so the number is not read as
   * a complete answer when it is not one.
   */
  function fitLabel(fit, formatSpan) {
    if (!fit || !fit.picked.length) return null;
    var n = fit.picked.length;
    var span = formatSpan ? formatSpan(fit.seconds) : Math.round(fit.seconds / 60) + 'm';
    var text = n + (n === 1 ? ' video fits' : ' videos fit') + ' in ' + span;
    if (fit.skippedUnknown) {
      text += ' · ' + fit.skippedUnknown + ' of unknown length not counted';
    }
    return text;
  }

  return {
    fitToBudget: fitToBudget,
    fitLabel: fitLabel
  };
});
