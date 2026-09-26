/**
 * Seen-playlist import — turning "I keep a playlist of stuff I've watched"
 * into real watched state.
 *
 * Some people never let YouTube keep a watch history but still track what
 * they've seen, by hand, in playlists called things like "Seen" or "Watched".
 * Those videos are invisible to the watched filters, so a feed the user has
 * already worked through still looks untouched. This module is the pure half
 * of fixing that: which playlists to SUGGEST, and how to merge their contents
 * into the watched store without lying about when anything was watched.
 *
 * Pure by design — no chrome.*, no network, no clock of its own — so the
 * dangerous part (the merge) is testable in Node.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.UNSeenPlaylists = api;
    if (typeof self !== 'undefined') self.UNSeenPlaylists = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Words that mean "I already watched this".
   * `seen` is deliberately NOT here as a bare stem — see NEGATIVE below.
   */
  var POSITIVE = /(^|[^a-z])(seen|watched|finished|done)([^a-z]|$)/i;

  /**
   * The inverses, checked FIRST and fatal.
   *
   * This is the whole reason the matcher is a function and not a regex
   * literal at the call site. The user keeps playlists named
   * "<topic> — Unsynth unseen picks", which are lists of things they have
   * specifically NOT watched. "unseen" contains "seen". A naive /seen/ test
   * matches it, pre-ticks it, and marks a few thousand deliberately-unwatched
   * videos as watched — silently, and with no way to tell afterwards which
   * ids came from where.
   *
   * "watch later", "to watch" and "unwatched" fail the same way against
   * `watched`, so they are all excluded together.
   */
  var NEGATIVE = /(unseen|unwatched|not\s*watched|to[-\s]*watch|watch\s*later|never\s*seen|not\s*seen)/i;

  /**
   * Does this playlist title look like a list of already-watched videos?
   *
   * Word-boundary matching, not substring: "Obscene humour" and
   * "Screen recordings" both contain the letters "seen" and neither is a
   * seen-list. Suggestion only — the user ticks the real answer.
   *
   * @param {string} title
   * @returns {boolean}
   */
  function looksWatched(title) {
    if (typeof title !== 'string' || !title) return false;
    if (NEGATIVE.test(title)) return false;
    return POSITIVE.test(title);
  }

  /**
   * Which of the user's playlists to pre-tick.
   * @param {Array<{id:string,title:string}>} playlists
   * @returns {Array} the subset that looks watched, original order preserved
   */
  function suggestPlaylists(playlists) {
    return (playlists || []).filter(function (pl) {
      return pl && looksWatched(pl.title);
    });
  }

  /** YouTube video ids are exactly 11 characters of [A-Za-z0-9_-]. */
  var VIDEO_ID = /^[\w-]{11}$/;

  /**
   * Merge playlist-sourced video ids into the watched store.
   *
   * ADDITIVE ONLY. Nothing is ever removed, and no existing date is ever
   * overwritten. Re-running with the same ids is a no-op.
   *
   * ---------------------------------------------------------------------
   * On dating, which is the part that can cause real damage
   * ---------------------------------------------------------------------
   * Playlist membership proves a video was watched at SOME point. It carries
   * no date at all — the playlist item's publishedAt is when it was ADDED to
   * the list, which is not when it was watched, and treating one as the other
   * is exactly the kind of plausible-looking invention that breaks things
   * quietly.
   *
   * So every id this function dates is flagged in `watchedDatesApprox`. Per
   * the contract documented in src/shared/watch-queue.js, an approximate date
   * is treated as NO date: watchedAt() returns null for it, classifyQueue()
   * cannot conclude the video was watched after it was queued, and the item
   * is KEPT. Without that flag, ~3,000 ids stamped with the import time would
   * all read as "watched just now" — later than any queue add — and the
   * user's whole queue would be offered up for clearing. That has already
   * happened once from an invented timestamp; it does not get to happen twice.
   *
   * The timestamp itself is still stored, because watch-history.js's
   * backfillMissingDates() would otherwise fill the gap with its own
   * Date.now() on next load anyway. Writing it here alongside the approx flag
   * means the value is honest about what it is: the first moment this device
   * could prove the video had already been watched.
   *
   * @param {{watchedVideos?:Array, watchedDates?:Object, watchedDatesApprox?:Object}} prev
   *        current store contents
   * @param {Array<string>} ids video ids collected from the chosen playlists
   * @param {{now?:number}} opts injected clock, so this stays pure
   * @returns {{watchedVideos:Array, watchedDates:Object, watchedDatesApprox:Object,
   *            added:number, skipped:number}}
   */
  function mergeSeenIds(prev, ids, opts) {
    prev = prev || {};
    opts = opts || {};
    var now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();

    // Copy, never mutate the caller's objects — a partial failure upstream
    // must not leave the live store half-written.
    var watched = (prev.watchedVideos || []).slice();
    var dates = Object.assign({}, prev.watchedDates || {});
    var approx = Object.assign({}, prev.watchedDatesApprox || {});

    var have = Object.create(null);
    watched.forEach(function (id) {
      have[id] = true;
    });

    var added = 0;
    var skipped = 0;
    var seenThisRun = Object.create(null);

    (ids || []).forEach(function (raw) {
      var id = typeof raw === 'string' ? raw : '';
      if (!VIDEO_ID.test(id)) {
        skipped++;
        return;
      }
      // A video can sit in more than one of the chosen playlists.
      if (seenThisRun[id]) return;
      seenThisRun[id] = true;

      if (!have[id]) {
        have[id] = true;
        watched.push(id);
        added++;
      }
      // Only date what has no date. A real observation — recorded live, or
      // scraped from YouTube's own history page — always outranks this.
      if (dates[id] == null || dates[id] === '') {
        dates[id] = now;
        approx[id] = 1;
      }
    });

    return {
      watchedVideos: watched,
      watchedDates: dates,
      watchedDatesApprox: approx,
      added: added,
      skipped: skipped
    };
  }

  return {
    looksWatched: looksWatched,
    suggestPlaylists: suggestPlaylists,
    mergeSeenIds: mergeSeenIds
  };
});
