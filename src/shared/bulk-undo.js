'use strict';

/**
 * One level of undo for a destructive bulk playlist action.
 *
 * WHY THIS IS NOT A CONFIRM DIALOG
 * A confirm before every bulk remove trains people to click through it, and it
 * costs a decision on the 99 runs that were correct to protect the 1 that was
 * not. An undo inverts that: the common case stays one click, and the mistake is
 * recoverable. That only holds if the undo genuinely restores, so the honesty
 * rules below matter more than the feature.
 *
 * WHAT CAN AND CANNOT BE UNDONE
 * A removed playlist item's itemId dies with it — YouTube mints a new one on
 * re-add. So an undo restores the VIDEOS, not the items, and cannot restore
 * their original positions: a re-added video lands at the end. That is a real
 * difference from "nothing happened", and `describe()` says so rather than
 * letting the word "undo" imply more than it delivers.
 *
 * A move is a remove plus an add elsewhere. Undoing it must reverse BOTH halves
 * or it silently duplicates the video, so a move records the destination and
 * `plan()` returns the add-back and the remove-from-destination together.
 *
 * Pure: no DOM, no chrome APIs, no fetching. The caller performs the plan.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNBulkUndo = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, function () {

  /**
   * How long an undo stays offered.
   *
   * Long enough to notice a mistake and act, short enough that the bar is not
   * permanently occupied by a stale offer. Beyond this the record is dropped
   * rather than kept: an undo that has silently expired but still shows a button
   * is worse than no button.
   */
  var TTL_MS = 30000;

  /**
   * Record what an action did, so it can be reversed.
   *
   * @param op    'remove' | 'move'
   * @param opts.playlistId  the playlist acted on
   * @param opts.videoIds    videos affected
   * @param opts.destIds     for 'move': where they went
   * @param opts.at          timestamp (injectable for tests)
   */
  function record(op, opts) {
    opts = opts || {};
    var ids = (opts.videoIds || []).filter(Boolean);
    if (!ids.length) return null;
    if (op !== 'remove' && op !== 'move') return null;
    return {
      op: op,
      playlistId: opts.playlistId || '',
      videoIds: ids,
      destIds: op === 'move' ? (opts.destIds || []).filter(Boolean) : [],
      at: typeof opts.at === 'number' ? opts.at : Date.now()
    };
  }

  function isLive(rec, at) {
    if (!rec || !rec.playlistId || !rec.videoIds.length) return false;
    return (( typeof at === 'number' ? at : Date.now()) - rec.at) < TTL_MS;
  }

  /**
   * The operations that reverse this record, in the order they must run.
   *
   * Returns [] for anything expired or malformed, so a caller that forgets to
   * check isLive() still cannot fire a stale undo.
   */
  function plan(rec, at) {
    if (!isLive(rec, at)) return [];
    var steps = [{ type: 'add', playlistId: rec.playlistId, videoIds: rec.videoIds.slice() }];
    if (rec.op === 'move') {
      // Reverse the other half too. Without this the video exists in BOTH
      // playlists afterwards, which is not what the user asked to undo.
      rec.destIds.forEach(function (dest) {
        steps.push({ type: 'removeFrom', playlistId: dest, videoIds: rec.videoIds.slice() });
      });
    }
    return steps;
  }

  /** The offer text. Says what it will do, including what it cannot restore. */
  function describe(rec, at) {
    if (!isLive(rec, at)) return null;
    var n = rec.videoIds.length;
    var noun = n === 1 ? 'video' : 'videos';
    // "Put back" rather than "undo": a re-added video lands at the end, so the
    // original order is NOT restored and the word should not imply it was.
    return 'Put ' + n + ' ' + noun + ' back (order is not restored)';
  }

  return {
    TTL_MS: TTL_MS,
    record: record,
    isLive: isLive,
    plan: plan,
    describe: describe
  };
});
