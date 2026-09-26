/**
 * Search filters — the gaps in YouTube's own search UI.
 *
 * Two mechanisms, both costing ZERO API quota, which is the whole design
 * constraint: search.list costs 100 units against a 9,000/day cap shared with
 * playlist reads, so an API-backed filter would give the user ~90 searches a
 * day and break the seen-import when it ran out.
 *
 *   1. Query operators + the sp= parameter, rewritten into the URL. These
 *      apply to the WHOLE result set including pagination, because YouTube
 *      itself does the filtering.
 *   2. Client-side predicates over what each result tile already renders.
 *      Verified live on a real search page: views, relative age, exact
 *      duration and the description snippet are all in the DOM.
 *
 * Deliberately NOT here, because they cannot be done honestly:
 *   - like ratio: dislikes were removed from the API in Dec 2021
 *   - transcript search: needs a crawled index (this is Filmot's whole product)
 *   - subscriber-count filter: one channels.list call per unique channel would
 *     exhaust the daily quota in a handful of searches
 *
 * Pure: no DOM, no chrome.*, so every rule here is unit-testable.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UNSearchFilters = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- parsers -------------------------------------------------------------
  // Each validated against real strings pulled off a live search page.

  /**
   * "10M views" -> 10000000. Returns null when there is no count to read
   * ("No views", a live badge, a channel row).
   */
  function parseViews(text) {
    var m = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?\s*views?/i);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    var mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(n * mult);
  }

  /**
   * "7 years ago" -> 2556.75 (days). Also handles the "Streamed 2 weeks ago"
   * prefix YouTube puts on past livestreams.
   */
  function parseAgeDays(text) {
    // Long and compact units ("3d ago", "6mo ago"): YouTube A/B-tests the
    // compact form. Same vocabulary as UNCatchUp.parseAgeMs; see the note there.
    var m = String(text || '').match(/(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m(?!o)|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo|years?|yrs?|y)\s*ago/i);
    if (!m) return null;
    var n = Number(m[1]);
    var u = m[2].toLowerCase();
    var name = { s: 'second', sec: 'second', secs: 'second', m: 'minute', min: 'minute', mins: 'minute',
      h: 'hour', hr: 'hour', hrs: 'hour', d: 'day', w: 'week', wk: 'week', wks: 'week',
      mo: 'month', y: 'year', yr: 'year', yrs: 'year' }[u] || u.replace(/s$/, '');
    var per = {
      second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24,
      day: 1, week: 7, month: 30.44, year: 365.25
    }[name];
    return per ? n * per : null;
  }

  /**
   * "7:45" -> 465 seconds; "1:02:33" -> 3753. Returns null for anything that
   * is not a clock ("LIVE", "SHORTS", an empty badge).
   */
  function parseDuration(text) {
    var raw = String(text || '').trim();
    if (!raw || !/^\d+(:\d{1,2})+$/.test(raw)) return null;
    var parts = raw.split(':').map(Number);
    if (parts.some(function (p) { return !isFinite(p); })) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  // ---- the filter set ------------------------------------------------------

  function empty() {
    return {
      // URL-level (YouTube does the work, applies to every page of results)
      after: '',        // 'YYYY-MM-DD'
      before: '',       // 'YYYY-MM-DD'
      sort: '',         // '' | 'relevance' | 'date' | 'views' | 'rating'
      // Client-side (applies to loaded results)
      minViews: null,
      maxViews: null,
      minMinutes: null,
      maxMinutes: null,
      maxAgeDays: null,
      minAgeDays: null,
      excludeWords: [],   // matched against title + description snippet
      excludeChannels: [],
      hideShorts: false,
      hideWatched: false
    };
  }

  function normalize(raw) {
    var f = Object.assign(empty(), raw || {});
    ['minViews', 'maxViews', 'minMinutes', 'maxMinutes', 'maxAgeDays', 'minAgeDays'].forEach(function (k) {
      var n = Number(f[k]);
      f[k] = (f[k] === null || f[k] === '' || !isFinite(n) || n < 0) ? null : n;
    });
    f.excludeWords = (f.excludeWords || []).map(function (w) {
      return String(w || '').trim().toLowerCase();
    }).filter(Boolean);
    f.excludeChannels = (f.excludeChannels || []).map(function (c) {
      return String(c || '').trim().toLowerCase();
    }).filter(Boolean);
    f.hideShorts = !!f.hideShorts;
    f.hideWatched = !!f.hideWatched;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.after)) f.after = '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.before)) f.before = '';
    if (['relevance', 'date', 'views', 'rating'].indexOf(f.sort) === -1) f.sort = '';
    return f;
  }

  function isActive(f) {
    var n = normalize(f);
    var e = empty();
    return Object.keys(e).some(function (k) {
      if (Array.isArray(n[k])) return n[k].length > 0;
      return n[k] !== e[k];
    });
  }

  // ---- URL level -----------------------------------------------------------

  /**
   * YouTube's sp= parameter is base64url of a small protobuf.
   *   field 1 (0x08) = sort order
   *   field 2 (0x12) = filter submessage { 1 = upload date, 2 = type, 3 = duration }
   *
   * Verified live: this encoder's output for "this week" is EgIIAg==, which
   * matches the value YouTube's own UI produces, and a generated
   * sort+date value loaded and filtered correctly on a real search.
   */
  var SORT_CODES = { relevance: 0, date: 1, views: 2, rating: 3 };

  function varint(n) {
    var out = [];
    do {
      var b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  }

  function b64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b64 = typeof btoa === 'function'
      ? btoa(bin)
      : Buffer.from(bytes).toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_');
  }

  /** @returns {string} the sp= value, or '' when nothing needs encoding. */
  function buildSp(f) {
    var n = normalize(f);
    var bytes = [];
    if (n.sort && SORT_CODES[n.sort] !== undefined && n.sort !== 'relevance') {
      bytes.push(0x08);
      bytes = bytes.concat(varint(SORT_CODES[n.sort]));
    }
    if (!bytes.length) return '';
    return b64url(bytes);
  }

  /**
   * Fold the date range into the query itself. YouTube honours before: and
   * after: operators in search_query — verified live: searching
   * "blender after:2024-01-01 before:2024-06-30" returned only results aged
   * ~2 years, consistent with that window.
   *
   * This is why the date range costs no quota and survives pagination, which
   * sp= alone cannot express (it only has canned buckets: hour/today/week/
   * month/year, with no custom range — the single most-requested gap).
   */
  function buildQuery(baseQuery, f) {
    var n = normalize(f);
    var q = String(baseQuery || '').replace(/\s*\b(after|before):\d{4}-\d{2}-\d{2}\b/g, '').trim();
    if (n.after) q += ' after:' + n.after;
    if (n.before) q += ' before:' + n.before;
    return q.trim();
  }

  /** Full search URL for a query + filters. */
  function buildUrl(baseQuery, f) {
    var q = buildQuery(baseQuery, f);
    var sp = buildSp(f);
    var url = '/results?search_query=' + encodeURIComponent(q);
    if (sp) url += '&sp=' + encodeURIComponent(sp);
    return url;
  }

  // ---- client side ---------------------------------------------------------

  /**
   * Should this result be hidden?
   *
   * `item` is what a tile renders, already parsed:
   *   { title, channel, description, views, ageDays, seconds, isShort, watched }
   *
   * Any field may be null when the tile does not carry it. A null NEVER causes
   * a hide: a filter can only exclude on evidence, or a tile whose duration
   * badge has not rendered yet would vanish and look like a bug.
   *
   * @returns {string} the reason to hide, or '' to keep.
   */
  function hideReason(item, f) {
    var n = normalize(f);
    var it = item || {};

    if (n.hideShorts && it.isShort) return 'short';
    if (n.hideWatched && it.watched) return 'watched';

    if (it.views !== null && it.views !== undefined) {
      if (n.minViews !== null && it.views < n.minViews) return 'views-below-min';
      if (n.maxViews !== null && it.views > n.maxViews) return 'views-above-max';
    }

    if (it.seconds !== null && it.seconds !== undefined) {
      var mins = it.seconds / 60;
      if (n.minMinutes !== null && mins < n.minMinutes) return 'too-short';
      if (n.maxMinutes !== null && mins > n.maxMinutes) return 'too-long';
    }

    if (it.ageDays !== null && it.ageDays !== undefined) {
      if (n.maxAgeDays !== null && it.ageDays > n.maxAgeDays) return 'too-old';
      if (n.minAgeDays !== null && it.ageDays < n.minAgeDays) return 'too-new';
    }

    if (n.excludeChannels.length) {
      var ch = String(it.channel || '').toLowerCase();
      for (var i = 0; i < n.excludeChannels.length; i++) {
        if (ch && ch.indexOf(n.excludeChannels[i]) !== -1) return 'channel-excluded';
      }
    }

    if (n.excludeWords.length) {
      // Title AND description snippet: a clickbait word is as likely to sit in
      // the description, and searching only the title misses most of them.
      var hay = (String(it.title || '') + ' ' + String(it.description || '')).toLowerCase();
      for (var j = 0; j < n.excludeWords.length; j++) {
        if (hay.indexOf(n.excludeWords[j]) !== -1) return 'word-excluded';
      }
    }

    return '';
  }

  /** Human summary for the toolbar chip. */
  function summarize(f) {
    var n = normalize(f);
    var bits = [];
    if (n.after || n.before) {
      bits.push(n.after && n.before ? n.after + ' to ' + n.before
        : n.after ? 'after ' + n.after : 'before ' + n.before);
    }
    if (n.sort) bits.push('by ' + n.sort);
    if (n.minViews !== null || n.maxViews !== null) {
      bits.push('views ' + (n.minViews !== null ? n.minViews.toLocaleString() : '0') +
        '–' + (n.maxViews !== null ? n.maxViews.toLocaleString() : '∞'));
    }
    if (n.minMinutes !== null || n.maxMinutes !== null) {
      bits.push((n.minMinutes !== null ? n.minMinutes : 0) + '–' +
        (n.maxMinutes !== null ? n.maxMinutes : '∞') + ' min');
    }
    if (n.maxAgeDays !== null) bits.push('newer than ' + n.maxAgeDays + 'd');
    if (n.minAgeDays !== null) bits.push('older than ' + n.minAgeDays + 'd');
    if (n.excludeWords.length) bits.push(n.excludeWords.length + ' word' + (n.excludeWords.length === 1 ? '' : 's') + ' excluded');
    if (n.excludeChannels.length) bits.push(n.excludeChannels.length + ' channel' + (n.excludeChannels.length === 1 ? '' : 's') + ' excluded');
    if (n.hideShorts) bits.push('no Shorts');
    if (n.hideWatched) bits.push('unwatched only');
    return bits.join(' · ');
  }

  return {
    parseViews: parseViews,
    parseAgeDays: parseAgeDays,
    parseDuration: parseDuration,
    empty: empty,
    normalize: normalize,
    isActive: isActive,
    buildSp: buildSp,
    buildQuery: buildQuery,
    buildUrl: buildUrl,
    hideReason: hideReason,
    summarize: summarize,
    SORT_CODES: SORT_CODES
  };
});
