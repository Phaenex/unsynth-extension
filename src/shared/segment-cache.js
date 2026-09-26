'use strict';

/**
 * A persistent, bounded cache of SponsorBlock segment lists, keyed by video id.
 *
 * WHY THIS EXISTS
 * Annotating the Up next rail means wanting segments for up to 20 videos at once,
 * and SponsorBlock has no batch endpoint. The hash-prefix route
 * (`/api/skipSegments/{4-hex}`) looks like one but is not: with 65,536 buckets
 * over roughly ten million submitted videos, two arbitrary videos practically
 * never share a prefix. It is a privacy mechanism, not a batching one. So 20 rows
 * is 20 requests, and the only way to make that acceptable is to not make most of
 * them.
 *
 * Two properties do the work:
 *   - Segments barely change. A video's sponsor breaks are submitted once and
 *     then edited rarely, so a long TTL is honest rather than a shortcut.
 *   - The same videos recur. The rail repeats across watch pages, and today's
 *     sidebar is tomorrow's watch page, so a hit rate well above zero is the
 *     normal case rather than the lucky one.
 *
 * Also used by the watch page itself, which previously refetched its own
 * segments on every navigation including back-and-forth between two videos.
 *
 * Pure storage: no fetching, no DOM. The caller supplies the fetcher.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNSegmentCache = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, function () {

  var KEY = 'unSbSegmentCache';

  /**
   * Fourteen days.
   *
   * Not permanent, unlike the duration cache: durations are a fact about the file
   * and never change, while segments are crowd edits that can be corrected or
   * removed. Two weeks is long enough that the rail is nearly always warm, short
   * enough that a correction reaches the user within a fortnight.
   */
  var TTL_MS = 14 * 24 * 60 * 60 * 1000;

  /**
   * Hard ceiling on entries.
   *
   * chrome.storage.local has no per-key quota in practice, but an unbounded map
   * of every video ever seen in a sidebar would grow without limit on a heavy
   * account. 1,500 is roughly a month of rails for someone watching several hours
   * a day, and eviction is oldest-first.
   */
  var MAX_ENTRIES = 1500;

  function now() { return Date.now(); }

  function isFresh(entry, at) {
    return !!entry && typeof entry.t === 'number' && (at - entry.t) < TTL_MS;
  }

  /**
   * Split ids into what the cache can answer and what it cannot.
   *
   * Returns { hits: { id: segments }, misses: [id] }. A cached EMPTY list is a
   * hit, not a miss: "this video has no segments" is an answer worth remembering,
   * and treating it as a miss would refetch every ad-free video forever.
   */
  function partition(store, ids, at) {
    at = at || now();
    var hits = Object.create(null);
    var misses = [];
    for (var i = 0; i < (ids || []).length; i++) {
      var id = ids[i];
      if (!id) continue;
      var entry = store && store[id];
      if (isFresh(entry, at)) hits[id] = entry.s || [];
      else misses.push(id);
    }
    return { hits: hits, misses: misses };
  }

  /**
   * Merge fresh results in and evict down to the ceiling.
   *
   * Eviction is by write time, oldest first, which is a deliberate choice over
   * least-recently-used: LRU would need a read to touch the entry, and the read
   * path here is meant to be free.
   */
  function merge(store, results, at) {
    at = at || now();
    var next = Object.assign(Object.create(null), store || {});
    Object.keys(results || {}).forEach(function (id) {
      next[id] = { t: at, s: results[id] || [] };
    });

    var keys = Object.keys(next);
    if (keys.length > MAX_ENTRIES) {
      keys.sort(function (a, b) { return (next[a].t || 0) - (next[b].t || 0); });
      var drop = keys.length - MAX_ENTRIES;
      for (var i = 0; i < drop; i++) delete next[keys[i]];
    }
    return next;
  }

  /** Drop everything past its TTL. Cheap enough to run on load. */
  function prune(store, at) {
    at = at || now();
    var next = Object.create(null);
    Object.keys(store || {}).forEach(function (id) {
      if (isFresh(store[id], at)) next[id] = store[id];
    });
    return next;
  }

  function stats(store, at) {
    at = at || now();
    var total = 0;
    var fresh = 0;
    var withSegments = 0;
    Object.keys(store || {}).forEach(function (id) {
      total++;
      if (isFresh(store[id], at)) {
        fresh++;
        if ((store[id].s || []).length) withSegments++;
      }
    });
    return { total: total, fresh: fresh, withSegments: withSegments };
  }

  return {
    KEY: KEY,
    TTL_MS: TTL_MS,
    MAX_ENTRIES: MAX_ENTRIES,
    partition: partition,
    merge: merge,
    prune: prune,
    stats: stats
  };
});
