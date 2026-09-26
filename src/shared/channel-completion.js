'use strict';

/**
 * Per-channel completion: of what you START from a channel, how much do you finish?
 *
 * WHY THIS IS NOT A STAT PAGE FEATURE
 * Google Takeout history carries no duration and no completion, so every history
 * tool in the market is structurally blind to whether you actually liked
 * anything — every entry looks the same whether you bailed after four seconds or
 * finished a 40-minute deep dive. This extension already stores `watchProgress`
 * per video AND durations AND which videos belong to which channel, which means
 * it can compute a signal nobody else can: a taste model built on FINISHING
 * rather than on clicking. A thumbnail can fake a click. It cannot fake a finish.
 *
 * TWO NUMBERS THAT ARE NOT THE SAME, AND WERE BEING CONFLATED
 *   started -> finished    "you finish 21% of what you start here"    (actionable)
 *   saved   -> finished    "3 of the 90 you saved"                    (a backlog fact)
 * A channel you saved 90 videos from and started 14 of has a 21% completion rate
 * and a 3% conversion rate. Reporting one as the other is a four-fold error, so
 * both are returned separately and never merged.
 *
 * Pure: no DOM, no chrome APIs, no fetching. Callers supply the data.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNChannelCompletion = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, function () {

  /**
   * A video counts as FINISHED at this fraction of its content length.
   *
   * Not 1.0: outros, end cards and credits mean almost nobody reaches the literal
   * final second, so a 100% rule would report a finish rate near zero for
   * everyone and be useless. 90% is where the viewer has clearly seen the thing.
   */
  var FINISHED_AT = 0.9;

  /**
   * Below this many seconds of progress a video counts as never really STARTED.
   *
   * Autoplay, a misclick, and a thumbnail that turned out to be something else
   * all produce a few seconds of progress. Counting those as "started" makes
   * every channel look abandoned, which is the failure mode that would make this
   * number a lie in the user's favour-free direction.
   */
  var STARTED_AFTER = 30;

  /** Too few data points to say anything. Reporting 0% from one video is noise. */
  /**
   * The percentage equivalent of STARTED_AFTER.
   *
   * watch-history already refuses to save below 10%, so this mostly documents
   * the floor rather than enforcing it — but a caller passing raw data should
   * get the same protection against counting a misclick as a start.
   */
  var STARTED_PCT = 10;

  var MIN_STARTED = 3;

  function isFiniteNum(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /**
   * @param opts.videoIds    ids belonging to this channel.
   *
   *   WHAT THIS IS, AND WHAT IT IS NOT. The obvious source is watch-stats
   *   channelVideos, which is keyed by channel NAME and holds the videos you
   *   have PLAYED from that channel. That makes completionRate correct and
   *   conversionRate meaningless, because saved === played by construction.
   *
   *   A real saved-vs-finished number needs playlist membership joined to
   *   channel, which only YT_PLAYLIST_ITEMS carries and only per playlist. So
   *   conversionRate and backlogLabel are ONLY meaningful when the caller
   *   supplies playlist ids; pass `fromPlaylist: true` to unlock them.
   * @param opts.progress    { videoId: value }. Interpreted as SECONDS by
   *                         default; pass percentProgress:true when the values
   *                         are 0-100, which is what watch-history stores.
   * @param opts.percentProgress  progress values are percentages, not seconds.
   *                         Durations are then unnecessary, because a percentage
   *                         already encodes the fraction watched.
   * @param opts.durations   { videoId: totalSeconds } — content length if known,
   *                         runtime otherwise. Ignored when percentProgress is
   *                         set.
   * @param opts.watched     optional Set/array of ids known watched in full; a
   *                         video can be finished without progress ever being
   *                         recorded (history sync, another device)
   * @returns {{ saved, started, finished, completionRate, conversionRate,
   *             confident, unknownDuration }}
   */
  function channelCompletion(opts) {
    opts = opts || {};
    var ids = Array.isArray(opts.videoIds) ? opts.videoIds : [];
    var progress = opts.progress || {};
    var durations = opts.durations || {};
    var watchedSet = null;
    if (opts.watched) {
      watchedSet = opts.watched instanceof Set ? opts.watched : new Set(opts.watched);
    }

    var pct = !!opts.percentProgress;
    var started = 0;
    var finished = 0;
    var unknownDuration = 0;

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var secs = Number(progress[id]);
      var total = Number(durations[id]);
      var knownFinished = !!(watchedSet && watchedSet.has(id));

      // Finished-by-history counts even with no progress and no duration: the
      // history sync knows it was watched, and refusing to count that would
      // under-report every channel the user watches on another device.
      if (knownFinished) {
        started++;
        finished++;
        continue;
      }

      if (pct) {
        // Percentages need no duration: the value IS the fraction watched. Note
        // that watch-history saves from 10% and DELETES the entry once a video
        // crosses into watchedVideos, so anything still here is by definition
        // started-and-not-finished. The finished ones arrive via opts.watched.
        if (!isFiniteNum(secs) || secs < STARTED_PCT) continue;
        started++;
        if (secs >= FINISHED_AT * 100) finished++;
        continue;
      }

      if (!isFiniteNum(secs) || secs < STARTED_AFTER) continue;
      started++;

      if (!isFiniteNum(total) || total <= 0) {
        // Started, but there is no way to say whether it was finished. Counted
        // as started and excluded from the finished side rather than guessed —
        // guessing here would bias the rate down on exactly the videos we know
        // least about.
        unknownDuration++;
        continue;
      }
      if (secs >= total * FINISHED_AT) finished++;
    }

    // Only a caller working from playlist membership can honestly say "saved".
    // From history data, saved === played and the ratio is 1 by construction.
    var fromPlaylist = !!opts.fromPlaylist;
    var saved = ids.length;
    // Denominator excludes the unknown-duration ones: they can be neither
    // confirmed nor denied, so including them would report them as unfinished.
    var judgeable = started - unknownDuration;
    return {
      saved: saved,
      started: started,
      finished: finished,
      unknownDuration: unknownDuration,
      completionRate: judgeable >= MIN_STARTED ? finished / judgeable : null,
      conversionRate: fromPlaylist && saved > 0 ? finished / saved : null,
      fromPlaylist: fromPlaylist,
      confident: judgeable >= MIN_STARTED
    };
  }

  /**
   * The sentence to show, or null when there is not enough to say.
   *
   * Returns null rather than "0%" below the threshold: a confident-looking
   * percentage from one data point is worse than saying nothing, and an
   * instrument that fabricates completeness loses a power user permanently.
   */
  function completionLabel(stats) {
    if (!stats || !stats.confident || stats.completionRate === null) return null;
    var pct = Math.round(stats.completionRate * 100);
    return pct + '% of what you start here, you finish';
  }

  /** The backlog sentence, which is a different claim from the one above. */
  function backlogLabel(stats) {
    // Refuses outright on history data: "76 never opened" would be a claim about
    // a backlog, computed from a set that only contains things already opened.
    if (!stats || !stats.fromPlaylist || !stats.saved) return null;
    var never = stats.saved - stats.started;
    if (never <= 0) return null;
    return stats.saved + ' saved · ' + never + ' never opened';
  }

  return {
    FINISHED_AT: FINISHED_AT,
    STARTED_AFTER: STARTED_AFTER,
    MIN_STARTED: MIN_STARTED,
    STARTED_PCT: STARTED_PCT,
    channelCompletion: channelCompletion,
    completionLabel: completionLabel,
    backlogLabel: backlogLabel
  };
});
