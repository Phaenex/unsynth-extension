'use strict';

/**
 * Catch-up digest + smart queue fill — the pure decision layer for both.
 *
 * Two questions, both answered from data the extension already collects, with
 * no new network dependency:
 *
 *   buildDigest()  "what did I miss in <folder> over the last N days"
 *   planFill()     "fill my queue from this list — everything, or N minutes"
 *
 * NO DOM, NO chrome APIs. Everything here is unit-testable in Node, which
 * matters because neither feature fails loudly when it is wrong: a bad day
 * window just shows the wrong videos, and a bad time budget just overfills a
 * queue. Both look like they worked.
 *
 * WHERE THE INPUTS COME FROM
 *   store        src/shared/sub-groups.js — folder membership, alias-aware.
 *                An imported PocketTube store keys channels by "channel:UC…"
 *                while YouTube's feed links them by "@handle", so membership
 *                MUST go through SG.inGroup() rather than an array indexOf.
 *   candidates   tiles scraped from whatever feed has rendered, the same pool
 *                sidebar-hub.js already builds for Suggested/News/Discover.
 *   watchedIds   the 'watchedVideos' set watch-history.js maintains.
 *   profile      src/shared/taste-profile.js.
 *
 * RANKING, HONESTLY
 * The ask was "prefer channels the user rarely skips". Nothing in this
 * extension records a skip: watch-history stores watch PROGRESS and a
 * fully-watched set, and taste-profile folds progress into a per-channel
 * weight where a full watch counts more than a bounce. That weight is the
 * closest real signal to "rarely skipped", so channel affinity is what ranks
 * the digest. When there is no profile yet, ranking falls back to plain
 * recency and buildDigest() reports `ranking: 'recency'` so the UI can say so
 * rather than implying a personalisation that is not happening.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./sub-groups.js'), require('./taste-profile.js'));
  } else {
    root.UNCatchUp = factory(root.UNSubGroups, root.UNTasteProfile);
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function (SG, TP) {
  'use strict';

  var DAY_MS = 86400000;

  var AGE_UNITS = {
    second: 1000,
    minute: 60000,
    hour: 3600000,
    day: DAY_MS,
    week: 7 * DAY_MS,
    month: 30 * DAY_MS,
    year: 365 * DAY_MS
  };

  /**
   * Relative upload age out of YouTube's own metadata text, in ms.
   *
   * There is no timestamp attribute on a feed tile. Verified live against
   * youtube.com/@Fireship/videos: every tile is a ytd-rich-item-renderer
   * wrapping a yt-lockup-view-model, and the only date information anywhere in
   * it is the string inside yt-content-metadata-view-model — which arrives
   * concatenated with the view count and the like count, e.g.
   * "609K views • 8 hours ago13K15699%596K views". So this scans for the
   * "<n> <unit> ago" phrase rather than trying to split the text.
   *
   * Returns null, never 0, when no age is present: a tile whose age cannot be
   * read is unknown, and dating it to "now" would sweep the entire feed into
   * a 7-day digest.
   */
  // Long and compact spellings of each unit. YouTube A/B-tests a compact tile
  // ("2h ago", "5d ago", "2w ago", "3mo ago", "1y ago": the five forms seen in
  // 240 live ages, 2026-09-23); in that variant the long-only pattern read every
  // age as null and the digest never filled. "mo" is month, so a bare "m" is
  // minutes; "s" and "m" were not observed and follow the same scheme.
  // No \b after "ago": the age runs straight into the like count
  // ("8 hours ago13K...").
  var AGE_RE = /(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m(?!o)|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo|years?|yrs?|y)\s*ago/i;
  var AGE_UNIT_NAME = { s: 'second', sec: 'second', m: 'minute', min: 'minute', h: 'hour', hr: 'hour',
    d: 'day', w: 'week', wk: 'week', mo: 'month', y: 'year', yr: 'year' };

  /** Canonical unit name ('hour', 'month', …) for any long or compact spelling. */
  function ageUnitName(raw) {
    var u = String(raw || '').toLowerCase();
    if (AGE_UNITS[u]) return u;
    var singular = u.replace(/s$/, '');
    if (AGE_UNITS[singular]) return singular;
    return AGE_UNIT_NAME[u] || AGE_UNIT_NAME[singular] || null;
  }

  function parseAgeMs(text) {
    if (!text) return null;
    var m = String(text).match(AGE_RE);
    if (!m) return null;
    var name = ageUnitName(m[2]);
    var unit = name && AGE_UNITS[name];
    if (!unit) return null;
    return Number(m[1]) * unit;
  }

  /**
   * Seconds out of a duration badge, or 0 when the text is not a duration.
   *
   * The strictness is deliberate. On live search results the same
   * badge-shape element that reads "6:46" on a video tile reads "9 lessons"
   * or "44 videos" on a course/playlist lockup — both confirmed live. A loose
   * parse would put playlists into a time-budget fill with a made-up length.
   */
  function parseDurationSec(text) {
    if (!text) return 0;
    var m = String(text).trim().match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/);
    if (!m) return 0;
    var h = m[1] ? Number(m[1]) : 0;
    return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  /**
   * The length a time budget should actually charge for an item.
   *
   * `durationSec` is YouTube's runtime, which includes the sponsor reads. A
   * 40-minute budget packed from runtime overshoots by the ad load of whatever
   * it picked — so the caller may supply `contentSec` (from
   * UNSBSegments.contentSeconds) and that wins when it is present. This module
   * stays pure and does no fetching; it just stops preferring the wrong number
   * when the right one has been handed to it.
   *
   * Not `|| durationSec`: a video that is ALL sponsor legitimately has
   * contentSec === 0, and falling through on that would charge the budget the
   * full runtime for a video with nothing in it.
   *
   * But null/undefined/'' must NOT be treated as that zero. Number(null) is 0,
   * not NaN, so an isFinite() guard alone accepts it — and toQueueItems writes
   * contentSec: null whenever there is no segment data, which would charge the
   * budget nothing per video and let an unbounded number in. "All sponsor" and
   * "no data" are different answers and only the first one is zero.
   */
  function budgetSecOf(item) {
    if (!item) return 0;
    var raw = item.contentSec;
    if (raw !== null && raw !== undefined && raw !== '') {
      var content = Number(raw);
      if (isFinite(content) && content >= 0) return content;
    }
    return Number(item.durationSec) || 0;
  }

  /**
   * YouTube returns durations as ISO 8601 ("PT4M13S"), which is the only shape
   * videos.list will give you. Parsed here rather than in the service worker so
   * it is testable without a browser.
   *
   * The cases that bite: a live stream returns "P0D" and must come back 0 rather
   * than NaN; hours appear only when non-zero ("PT2H" has no minutes or seconds
   * at all); and days appear on genuinely long uploads ("P1DT2H").
   */
  function parseIsoDuration(iso) {
    if (!iso || typeof iso !== 'string') return 0;
    var m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!m) return 0;
    var d = Number(m[1] || 0);
    var h = Number(m[2] || 0);
    var mi = Number(m[3] || 0);
    var sec = Number(m[4] || 0);
    var total = d * 86400 + h * 3600 + mi * 60 + sec;
    return isFinite(total) && total > 0 ? Math.round(total) : 0;
  }

  function isShortCandidate(c) {
    if (!c) return false;
    if (c.isShort) return true;
    // YouTube's own cut-off. A 45-second upload is a Short whether or not the
    // tile happened to render the Shorts badge.
    var d = Number(c.durationSec) || 0;
    return d > 0 && d <= 60;
  }

  /** Channel affinity for one candidate, alias-aware, 0 when unknown. */
  function affinity(profile, candidate, now) {
    if (!TP || !profile) return 0;
    var result = TP.scoreCandidate(profile, {
      title: candidate.title || '',
      channelKey: candidate.channelKey || '',
      channelName: candidate.channelName || ''
    }, { now: now });
    return result && result.score ? result.score : 0;
  }

  function hasProfile(profile) {
    return !!(profile && profile.totalWatched && (
      Object.keys(profile.channels || {}).length || Object.keys(profile.tokens || {}).length
    ));
  }

  /**
   * "What did I miss in this folder?"
   *
   * @param opts.store         sub-groups store
   * @param opts.group         folder name
   * @param opts.candidates    scraped tiles: { videoId, title, channelKey,
   *                           channelName, ageMs, durationSec, isShort }
   * @param opts.watchedIds    array/Set of watched video ids
   * @param opts.days          day window (inclusive at the boundary)
   * @param opts.includeShorts
   * @param opts.profile       taste profile, or null
   * @returns { items, ranking, groupChannels, channelsSeen }
   */
  function buildDigest(opts) {
    opts = opts || {};
    var store = opts.store || { groups: {} };
    var group = opts.group;
    var days = Number(opts.days) > 0 ? Number(opts.days) : 7;
    var windowMs = days * DAY_MS;
    var includeShorts = !!opts.includeShorts;
    var now = opts.now || Date.now();
    var profile = opts.profile;
    var ranked = hasProfile(profile);

    var watched = Object.create(null);
    (opts.watchedIds instanceof Set ? Array.from(opts.watchedIds) : opts.watchedIds || []).forEach(function (id) {
      if (id) watched[id] = true;
    });

    var seen = Object.create(null);
    var channelsSeen = Object.create(null);
    var items = [];

    (opts.candidates || []).forEach(function (c) {
      if (!c || !c.videoId) return;
      if (seen[c.videoId]) return;
      if (watched[c.videoId]) return;
      // Membership via SG so an @handle tile still matches a channel:UC group
      // member (and vice versa) through the alias map.
      if (!SG || !SG.inGroup(store, group, c.channelKey)) return;
      if (!includeShorts && isShortCandidate(c)) return;
      var age = c.ageMs;
      if (age == null) return; // unknown age — cannot claim it is recent
      if (age > windowMs) return;
      seen[c.videoId] = true;
      if (c.channelKey) channelsSeen[c.channelKey] = true;
      items.push(Object.assign({}, c, {
        score: ranked ? affinity(profile, c, now) : 0
      }));
    });

    items.sort(function (a, b) {
      if (ranked && b.score !== a.score) return b.score - a.score;
      return (a.ageMs || 0) - (b.ageMs || 0); // newest first
    });

    return {
      items: items,
      ranking: ranked ? 'taste' : 'recency',
      groupChannels: ((store.groups || {})[group] || []).length,
      channelsSeen: Object.keys(channelsSeen).length
    };
  }

  /**
   * Pack items into a minute budget.
   *
   * Keeps scanning past an item that does not fit rather than stopping at the
   * first one — abandoning a 45-minute budget because item 3 happens to be an
   * hour long is not what "fill to 45 minutes" means. Items with an unknown
   * duration (0, the codebase's existing "not parsed" value) are skipped
   * entirely: counting them as free would let an unbounded number into a
   * budget, which defeats the budget.
   *
   * Charges `contentSec` when the caller supplied it, so "I have 40 minutes"
   * means 40 minutes of video and not 40 minutes including the ads.
   *
   * @param slots optional hard cap on item count (the queue's remaining room)
   */
  function fillByBudget(items, budgetMin, queuedSec, slots) {
    var budgetSec = Math.max(0, Number(budgetMin) || 0) * 60 - (Number(queuedSec) || 0);
    var out = [];
    var total = 0;
    var cap = slots == null ? Infinity : Math.max(0, slots);
    (items || []).forEach(function (item) {
      if (out.length >= cap) return;
      var d = budgetSecOf(item);
      if (d <= 0) return;
      if (total + d > budgetSec) return;
      total += d;
      out.push(item);
    });
    return { items: out, totalSec: total };
  }

  /**
   * Decide exactly what a bulk add will do, before it touches the queue.
   *
   * Everything the caller needs to be honest with the user comes back here:
   * what will be added, how much was dropped for the cap, and how much was
   * already queued. Re-adding an id that is already in the queue would not be
   * a no-op — addToList() removes and reinserts it, silently REORDERING a
   * queue the user built by hand — so those are filtered out here rather than
   * handed to addMany.
   *
   * @param opts.mode        'all' | 'budget'
   * @param opts.queueIds    ids already in the queue
   * @param opts.queueLength current queue length
   * @param opts.queuedSec   seconds already queued (budget mode)
   * @param opts.max         queue cap (UNWatchQueue.MAX)
   */
  function planFill(opts) {
    opts = opts || {};
    var max = Number(opts.max) > 0 ? Number(opts.max) : 500;
    var queueLength = Math.max(0, Number(opts.queueLength) || 0);
    var slots = Math.max(0, max - queueLength);

    var queued = Object.create(null);
    (opts.queueIds || []).forEach(function (id) {
      if (id) queued[id] = true;
    });

    var eligible = [];
    var alreadyQueued = 0;
    (opts.items || []).forEach(function (item) {
      if (!item || !item.videoId) return;
      if (queued[item.videoId]) {
        alreadyQueued++;
        return;
      }
      eligible.push(item);
    });

    var picked;
    var totalSec = 0;
    if (opts.mode === 'budget') {
      var packed = fillByBudget(eligible, opts.budgetMin, opts.queuedSec, slots);
      picked = packed.items;
      totalSec = packed.totalSec;
    } else {
      picked = eligible.slice(0, slots);
      picked.forEach(function (i) {
        totalSec += budgetSecOf(i);
      });
    }

    return {
      items: picked,
      added: picked.length,
      // Only the cap counts as "dropped". In budget mode a video left out
      // because it did not fit the time is not an overflow, it is the budget
      // working, and reporting it as dropped would read as a failure.
      dropped: opts.mode === 'budget' ? 0 : Math.max(0, eligible.length - picked.length),
      alreadyQueued: alreadyQueued,
      totalSec: totalSec,
      full: slots === 0 || (opts.mode !== 'budget' && eligible.length > picked.length),
      max: max
    };
  }

  /**
   * The "you're caught up" sentence. Here rather than inline in the view so it
   * is testable — it read "from these 1 channels" on screen, and a folder of
   * one is a normal case (a folder being built up, or a single channel that
   * posts constantly).
   */
  function caughtUpLine(channelCount, days) {
    var n = Number(channelCount) || 0;
    var d = Number(days) || 0;
    return (
      'No unwatched uploads from ' +
      (n === 1 ? 'this 1 channel' : 'these ' + n + ' channels') +
      ' in the last ' + d + (d === 1 ? ' day.' : ' days.')
    );
  }

  /** Digest candidates -> the shape src/shared/watch-queue.js stores. */
  function toQueueItems(items) {
    return (items || []).map(function (v) {
      return {
        id: v.videoId,
        title: v.title || v.videoId,
        channel: v.channelName || '',
        dur: Number(v.durationSec) || 0,
        // Kept alongside dur, not instead of it: the queue row still shows the
        // real runtime badge, while the finish-time estimate uses this.
        contentSec: isFinite(Number(v.contentSec)) ? Number(v.contentSec) : null,
        thumb: v.thumb || ''
      };
    });
  }

  function fmtBudget(sec) {
    sec = Math.floor(Number(sec) || 0);
    var h = Math.floor(sec / 3600);
    var m = Math.round((sec % 3600) / 60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  /**
   * One line saying exactly what happened. A bulk add that does not report its
   * real count is indistinguishable from one that silently dropped half the
   * list, so every reason for a shortfall is named.
   */
  function fillSummary(result) {
    var r = result || {};
    var added = Number(r.added) || 0;
    if (!added) {
      if (r.alreadyQueued) return 'Nothing to add — all ' + r.alreadyQueued + ' already queued';
      if (r.full) return 'Nothing added — the queue is full at ' + (r.max || 500);
      return 'Nothing to add';
    }
    var msg = 'Added ' + added + (added === 1 ? ' video' : ' videos') + ' to the queue';
    var notes = [];
    if (r.dropped) notes.push(r.dropped + ' skipped, queue is full at ' + (r.max || 500));
    if (r.alreadyQueued) notes.push(r.alreadyQueued + ' already queued');
    if (r.totalSec) notes.push(fmtBudget(r.totalSec));
    if (notes.length) msg += ' · ' + notes.join(' · ');
    return msg;
  }

  return {
    DAY_MS: DAY_MS,
    parseAgeMs: parseAgeMs,
    AGE_RE: AGE_RE,
    ageUnitName: ageUnitName,
    parseDurationSec: parseDurationSec,
    parseIsoDuration: parseIsoDuration,
    isShortCandidate: isShortCandidate,
    buildDigest: buildDigest,
    caughtUpLine: caughtUpLine,
    fillByBudget: fillByBudget,
    budgetSecOf: budgetSecOf,
    planFill: planFill,
    toQueueItems: toQueueItems,
    fillSummary: fillSummary,
    fmtBudget: fmtBudget
  };
});
