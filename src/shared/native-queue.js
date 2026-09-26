'use strict';

/**
 * Native-queue bridge — the single way the extension writes to YouTube's OWN
 * queue (the list its "Add to queue" / "Play next" menu items feed).
 *
 * Why this exists: queueing was implemented three separate times. forge-link.js
 * had its own postMessage bridge, playlist-bulk.js drove the "⋮" menu by
 * synthesizing clicks, and both of those were bolted onto a *different*,
 * extension-only list in src/shared/watch-queue.js. So "+Q" on a feed tile and
 * "Play next" in the popover on the SAME tile wrote to two unrelated queues,
 * neither of which was the queue YouTube itself was playing from. That is the
 * "doesn't work properly at all or integrate with the built in youtube add to
 * que" report: the buttons did something, just not to the queue the user was
 * looking at.
 *
 * Everything now funnels through here. The isolated content world can't touch
 * the player, so this posts to the MAIN-world listener in
 * src/content/ai-bridge.js, which dispatches the same DOM events YouTube's own
 * menu items fire.
 *
 * Node-safe: guards every browser global so the unit tests can require it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UNNativeQueue = factory();
  }
})(typeof self !== 'undefined' ? self : this, function nativeQueueFactory() {
  // Mutable via setTimeoutMs() so tests can exercise the timeout path without
  // adding seconds of real waiting to the suite.
  var TIMEOUT_MS = 3500;

  function setTimeoutMs(ms) {
    if (typeof ms === 'number' && isFinite(ms) && ms > 0) TIMEOUT_MS = ms;
  }

  // YouTube video IDs are exactly 11 chars of [A-Za-z0-9_-]. Filtering here
  // (as well as in the MAIN-world bridge) keeps a malformed id from consuming
  // a request slot and timing out.
  function validId(id) {
    return typeof id === 'string' && /^[\w-]{11}$/.test(id);
  }

  function normalizeIds(videoIds) {
    var arr = Array.isArray(videoIds) ? videoIds : [videoIds];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var id = arr[i];
      // De-dupe: queueing the same id twice in one batch is always a mistake
      // (double-click, or the same video in two shelves) and YouTube would
      // happily add a duplicate row.
      if (!validId(id) || seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
    return out;
  }

  /**
   * Add video(s) to YouTube's native queue.
   *
   * NOTE on toFront: YouTube's native queue is APPEND-ONLY from here. Its own
   * tile menus offer no "Play next", and the INSERT_AFTER_CURRENT_VIDEO /
   * listPosition variants were tested against a live signed-in session and all
   * appended. toFront is still forwarded (and still orders the extension's own
   * local list) so callers keep one vocabulary, but it does not change where
   * the video lands in YouTube's queue.
   *
   * @param {string|string[]} videoIds
   * @param {{toFront?: boolean}} [opts] toFront:true => "Play next" locally.
   * @returns {Promise<{ok:boolean, native:boolean, added?:number, error?:string}>}
   */
  function add(videoIds, opts) {
    var ids = normalizeIds(videoIds);
    if (!ids.length) return Promise.resolve({ ok: false, native: false, error: 'no_valid_ids' });
    if (typeof window === 'undefined' || typeof window.postMessage !== 'function') {
      return Promise.resolve({ ok: false, native: false, error: 'no_window' });
    }
    var toFront = !!(opts && opts.toFront);
    return new Promise(function (resolve) {
      var reqId = 'q' + Date.now() + Math.random().toString(36).slice(2, 8);
      var timer = null;
      function done(result) {
        if (!timer) return; // already settled
        clearTimeout(timer);
        timer = null;
        window.removeEventListener('message', onMsg);
        resolve(result);
      }
      function onMsg(e) {
        // Only trust same-window replies carrying this exact request id.
        if (e.source !== window) return;
        if (!e.data || e.data.type !== 'UN_YT_QUEUE_RESULT' || e.data.reqId !== reqId) return;
        done(e.data);
      }
      // Both sides of this handshake have a deadline, and whichever expires
      // first decides the reported outcome — so they have to stay ordered.
      // The MAIN-world bridge (ai-bridge.js) waits for all ids' rows to
      // render, which is slowest on the FIRST add because YouTube also has to
      // create the backing queue playlist server-side. Its old fixed 3s
      // ceiling expired before the row appeared and reported
      // queue_unavailable for a write that had already succeeded — confirmed
      // live on a watch page, where the queue really did grow 2 -> 3 while the
      // UI said "Couldn't reach YouTube's queue". The bridge now polls
      // 48 + 2/id ticks of 125ms (>=6s); this deadline keeps 2x headroom over
      // that so the bridge always gets to answer with a real row count
      // instead of the caller timing out first and producing the same false
      // failure from the other side.
      // (Scaling by batch size also fixes the earlier variant of this bug: a
      // flat timeout made a large multi-select "Add to queue" report "timeout"
      // — surfaced as "added to extension queue" — on an add still landing.)
      var addTimeoutMs = TIMEOUT_MS * 2 + Math.min(ids.length, 50) * 300;
      timer = setTimeout(function () {
        // Settle rather than hang: the MAIN-world bridge is absent on some
        // surfaces (YouTube Music, an embed), and a caller awaiting this
        // forever would leave its button stuck disabled.
        clearTimeout(timer);
        timer = 1; // keep done() from short-circuiting on the null check
        done({ ok: false, native: false, error: 'timeout' });
      }, addTimeoutMs);
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'UN_YT_QUEUE_ADD', reqId: reqId, videoIds: ids, toFront: toFront }, '*');
    });
  }

  /**
   * Deprecated alias for add(). Kept so no caller breaks, but it does NOT
   * front-insert: YouTube's queue accepts appends only from an extension
   * (measured live 2026-09-15 — a queue row's action menu carries just
   * "Remove from playlist" and "Share"). Prefer add() and say what you mean.
   */
  function playNext(videoIds) {
    return add(videoIds, { toFront: false });
  }

  /**
   * Remove video(s) from YouTube's native queue (the "Remove from playlist"
   * item on a queue-panel row's own menu).
   *
   * @param {string|string[]} videoIds
   * @returns {Promise<{ok:boolean, native:boolean, removed?:number, error?:string}>}
   */
  function remove(videoIds) {
    var ids = normalizeIds(videoIds);
    if (!ids.length) return Promise.resolve({ ok: false, native: false, error: 'no_valid_ids' });
    if (typeof window === 'undefined' || typeof window.postMessage !== 'function') {
      return Promise.resolve({ ok: false, native: false, error: 'no_window' });
    }
    return new Promise(function (resolve) {
      var reqId = 'qr' + Date.now() + Math.random().toString(36).slice(2, 8);
      var timer = null;
      function done(result) {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        window.removeEventListener('message', onMsg);
        resolve(result);
      }
      function onMsg(e) {
        if (e.source !== window) return;
        if (!e.data || e.data.type !== 'UN_YT_QUEUE_RESULT' || e.data.reqId !== reqId) return;
        done(e.data);
      }
      // The bridge removes one row at a time (each needs its own real
      // click-through-menu cycle plus a stability wait — up to ~3.4s), can
      // retry once for anything still present after the first pass, then
      // does a final settle check. A single-item timeout (right for add()'s
      // one fast round trip) is not enough for that, so scale by batch size
      // — as a multiple of TIMEOUT_MS rather than an added fixed constant,
      // so tests that shrink TIMEOUT_MS via setTimeoutMs() shrink this
      // proportionally too instead of always paying a multi-second floor.
      // The *3 (not *2) leaves headroom beyond the bridge's own worst case —
      // measured live, a 2-item batch with one retry pass took long enough
      // that a *2 multiplier's timeout fired branch BEFORE the bridge's own
      // real reply arrived, even though that reply reported success. The
      // caller then treated a real removal as a failure and left its UI
      // (selection, "select mode") in the pre-removal state.
      var removeTimeoutMs = TIMEOUT_MS * (ids.length * 3 + 1);
      timer = setTimeout(function () {
        clearTimeout(timer);
        timer = 1;
        done({ ok: false, native: false, error: 'timeout' });
      }, removeTimeoutMs);
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'UN_YT_QUEUE_REMOVE', reqId: reqId, videoIds: ids }, '*');
    });
  }

  return {
    setTimeoutMs: setTimeoutMs,
    getTimeoutMs: function () {
      return TIMEOUT_MS;
    },
    validId: validId,
    normalizeIds: normalizeIds,
    add: add,
    playNext: playNext,
    remove: remove
  };
});
