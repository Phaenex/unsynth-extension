'use strict';

/**
 * How long is this playlist, and how much of it have you not finished?
 *
 * WHY A COUNT IS NOT ENOUGH
 * "312 videos" tells you nothing about whether you can clear it. Ten minutes of
 * Shorts and a 40-hour lecture series both read as a number. Every playlist tool
 * shows the count because the count is what playlistItems.list returns —
 * durations are simply not on a playlist item, which is why nobody shows hours.
 * The duration cache makes them available, so this turns a count into a budget.
 *
 * WHAT IT REFUSES TO DO
 * Durations arrive from a cache that may not hold every id yet. A total computed
 * over 40 of 312 videos is not "the playlist length" and must never be shown as
 * one, so every result carries `known`/`total` and `complete`, and the label
 * says "at least" whenever it is working from a subset. An understated total
 * presented as exact is the failure that makes a time budget worthless.
 *
 * Pure: no DOM, no chrome APIs, no fetching. Callers supply the data.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNPlaylistBudget = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, function () {

  function isFiniteNum(n) {
    return typeof n === 'number' && isFinite(n) && n > 0;
  }

  /**
   * @param opts.videoIds  ids in the playlist, in any order.
   * @param opts.durations { videoId: seconds } — whatever the cache holds.
   * @param opts.watched   Set/array of ids already finished.
   * @returns {{ total, known, unknown, seconds, unfinished, unfinishedSeconds,
   *             complete }}
   */
  function playlistBudget(opts) {
    opts = opts || {};
    var ids = Array.isArray(opts.videoIds) ? opts.videoIds : [];
    var durations = opts.durations || {};
    var watchedSet = null;
    if (opts.watched) {
      watchedSet = opts.watched instanceof Set ? opts.watched : new Set(opts.watched);
    }

    var known = 0;
    var seconds = 0;
    var unfinished = 0;
    var unfinishedSeconds = 0;

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (!id) continue;
      var d = Number(durations[id]);
      var isWatched = !!(watchedSet && watchedSet.has(id));
      // Unfinished is a COUNT over every id, not only the ones with a duration:
      // "how many are left" is answerable without knowing how long they are, and
      // dropping the unknown ones would under-report the backlog.
      if (!isWatched) unfinished++;
      if (!isFiniteNum(d)) continue;
      known++;
      seconds += d;
      if (!isWatched) unfinishedSeconds += d;
    }

    return {
      total: ids.length,
      known: known,
      unknown: ids.length - known,
      seconds: seconds,
      unfinished: unfinished,
      unfinishedSeconds: unfinishedSeconds,
      complete: ids.length > 0 && known === ids.length
    };
  }

  /**
   * "4h 12m", "38m", "45s". Never "0h 0m" — that reads as broken rather than as
   * empty, so a zero returns null and the caller omits the clause entirely.
   */
  function formatSpan(seconds) {
    var s = Math.round(Number(seconds) || 0);
    if (s <= 0) return null;
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h && m) return h + 'h ' + m + 'm';
    if (h) return h + 'h';
    if (m) return m + 'm';
    return s + 's';
  }

  /**
   * The line under a playlist title.
   *
   * Shape: "312 videos · at least 41h 8m · 296 unfinished"
   *
   * The "at least" is the honest part. It appears whenever durations are missing
   * for any id, because the total is then a floor rather than a measurement.
   * Dropping that qualifier would present a partial sum as the playlist length.
   */
  function budgetLabel(stats) {
    if (!stats || !stats.total) return null;
    var parts = [stats.total + (stats.total === 1 ? ' video' : ' videos')];

    var span = formatSpan(stats.seconds);
    if (span) parts.push((stats.complete ? '' : 'at least ') + span);

    // Only worth saying when some are done; on an untouched playlist the
    // unfinished count just repeats the total.
    if (stats.unfinished && stats.unfinished !== stats.total) {
      parts.push(stats.unfinished + ' unfinished');
    }
    return parts.join(' · ');
  }

  return {
    playlistBudget: playlistBudget,
    formatSpan: formatSpan,
    budgetLabel: budgetLabel
  };
});
