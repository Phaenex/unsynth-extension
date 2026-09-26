/**
 * Pure SponsorBlock segment helpers — no DOM, no chrome APIs.
 * Community ("actual") segments come from sponsor.ajay.app; personal skips are local.
 *
 * Full category + action-type parity with the standalone SponsorBlock extension:
 *   actionType: skip | mute | full | poi
 *   per-category skip mode: auto | manual | overlay | disabled
 */
(function (g) {
  'use strict';

  const MIN_LEN = 0.5;

  // A single skip segment may not claim more than this fraction of the video.
  // SponsorBlock is crowd-submitted and gets griefed: one submission covering
  // 0:00-end made contentSeconds() return 0, i.e. "this video is entirely
  // sponsor", which then propagated into the time budget and the finish-time
  // clock as a real number. Legitimate high ratios do exist — a 60s Short with a
  // 20s read is 33%, a podcast clip can be half sponsor — so this is deliberately
  // set well above any honest case and only catches the whole-video shape.
  // Whole-video disclosures are a different actionType ('full') and are not
  // affected.
  const MAX_SEGMENT_FRACTION = 0.9;

  // Canonical category metadata — single source of truth shared by the content
  // module and the dashboard UI so the two never drift.
  const CATEGORIES = [
    { id: 'sponsor', label: 'Sponsor', color: '#4aa86e', action: 'skip', mode: 'auto' },
    { id: 'selfpromo', label: 'Unpaid / self-promo', color: '#c8a84b', action: 'skip', mode: 'auto' },
    { id: 'interaction', label: 'Interaction reminder (subscribe)', color: '#9b6fd4', action: 'skip', mode: 'auto' },
    { id: 'intro', label: 'Intro / intermission', color: '#5ba8a8', action: 'skip', mode: 'disabled' },
    { id: 'outro', label: 'Outro / endcards', color: '#5b6ed4', action: 'skip', mode: 'disabled' },
    { id: 'preview', label: 'Preview / recap', color: '#4889b8', action: 'skip', mode: 'disabled' },
    { id: 'hook', label: 'Hook / greeting', color: '#55b0c9', action: 'skip', mode: 'disabled' },
    { id: 'filler', label: 'Filler / tangent', color: '#7b8a3a', action: 'skip', mode: 'disabled' },
    { id: 'music_offtopic', label: 'Non-music section', color: '#c87c3a', action: 'skip', mode: 'auto' },
    { id: 'poi_highlight', label: 'Highlight (jump-to)', color: '#ff5f95', action: 'poi', mode: 'manual' },
    { id: 'exclusive_access', label: 'Full-video sponsor label', color: '#7c5cc4', action: 'full', mode: 'overlay' },
    { id: 'chapter', label: 'Chapter names (community)', color: '#9aa0a6', action: 'chapter', mode: 'overlay' }
  ];

  const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
  const CATEGORY_MAP = CATEGORIES.reduce((m, c) => { m[c.id] = c; return m; }, {});
  const MODES = ['disabled', 'overlay', 'manual', 'auto'];
  const ACTION_TYPES = ['skip', 'mute', 'poi', 'full', 'chapter'];

  function defaultModes() {
    const out = {};
    CATEGORIES.forEach((c) => { out[c.id] = c.mode; });
    return out;
  }

  function isValidSegment(start, end) {
    return typeof start === 'number' && typeof end === 'number' && isFinite(start) && isFinite(end) && end > start + MIN_LEN;
  }

  // A "point" segment (poi_highlight) or a full-video label may have start == end.
  function isValidPoint(start) {
    return typeof start === 'number' && isFinite(start) && start >= 0;
  }

  function normalizeSegment(raw, source) {
    if (!raw) return null;
    const seg = Array.isArray(raw.segment) ? raw.segment : [raw.start, raw.end];
    const start = Number(seg[0]);
    let end = Number(seg[1]);
    const category = raw.category || 'sponsor';
    const actionType = raw.actionType || 'skip';
    if (ACTION_TYPES.indexOf(actionType) === -1) return null;

    if (actionType === 'poi' || actionType === 'full') {
      // Point / whole-video markers: only need a valid start.
      if (!isValidPoint(start)) return null;
      if (!isFinite(end) || end < start) end = start;
    } else if (!isValidSegment(start, end)) {
      return null;
    }

    const uuid = raw.uuid || raw.UUID || raw.id || '';
    const out = {
      start,
      end,
      category,
      actionType,
      uuid: String(uuid || personalUuid('x', start, end, category)),
      source: source || raw.source || 'community'
    };
    // Community chapter segments carry a title in `description`.
    if (actionType === 'chapter') out.description = String(raw.description || raw.title || '').trim();
    return out;
  }

  function parseCommunityHashResponse(data, videoId) {
    const entry = (data || []).find((d) => d.videoID === videoId);
    if (!entry || !entry.segments) return [];
    return entry.segments.map((s) => normalizeSegment(s, 'community')).filter(Boolean);
  }

  function parseCommunityDirectResponse(data) {
    return (data || []).map((s) => normalizeSegment(s, 'community')).filter(Boolean);
  }

  function parsePersonalStore(store, videoId) {
    const list = (store && store[videoId]) || [];
    return list.map((s) => normalizeSegment(s, 'personal')).filter(Boolean);
  }

  function mergeSegments(lists) {
    const flat = [];
    const seen = new Set();
    for (const list of lists) {
      for (const s of list || []) {
        if (!s) continue;
        const key = s.uuid + ':' + s.start + ':' + s.end;
        if (seen.has(key)) continue;
        seen.add(key);
        flat.push(s);
      }
    }
    return flat.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  /**
   * Resolve the effective skip mode for a category from stored config, with
   * back-compat for the legacy `{ categories:{cat:bool}, autoSkip:bool }` shape.
   */
  function modeFor(category, cfg) {
    cfg = cfg || {};
    const modes = cfg.categoryModes || {};
    if (modes[category] && MODES.indexOf(modes[category]) !== -1) return modes[category];
    const legacy = cfg.categories;
    if (legacy && Object.prototype.hasOwnProperty.call(legacy, category)) {
      if (!legacy[category]) return 'disabled';
      return cfg.autoSkip === false ? 'overlay' : 'auto';
    }
    const cat = CATEGORY_MAP[category];
    return cat ? cat.mode : 'disabled';
  }

  /**
   * First segment active at `time` that should be AUTO-skipped (or auto-muted).
   * `modeResolver(category)` returns the effective mode; disabled uuids skipped.
   */
  function segmentAtTime(segments, time, disabled, modeResolver) {
    for (const seg of segments) {
      if (disabled && disabled.has(seg.uuid)) continue;
      // Only skip/mute segments are ever auto-actioned — poi/full/chapter never are.
      if (seg.actionType === 'poi' || seg.actionType === 'full' || seg.actionType === 'chapter') continue;
      if (modeResolver && modeResolver(seg.category) !== 'auto') continue;
      if (time >= seg.start + 0.05 && time < seg.end - 0.4) return seg;
    }
    return null;
  }

  /** Community chapter segments to display, when the chapter mode isn't disabled. */
  function chapterSegments(segments, disabled, modeResolver) {
    const mode = modeResolver ? modeResolver('chapter') : 'overlay';
    if (mode === 'disabled') return [];
    return (segments || [])
      .filter((seg) => seg.actionType === 'chapter' && !(disabled && disabled.has(seg.uuid)))
      .sort((a, b) => a.start - b.start);
  }

  /** Segments visible on the timeline (any non-disabled mode). */
  function visibleSegments(segments, disabled, modeResolver) {
    return (segments || []).filter((seg) => {
      if (disabled && disabled.has(seg.uuid)) return false;
      if (seg.source === 'personal') return true;
      const mode = modeResolver ? modeResolver(seg.category) : 'auto';
      return mode !== 'disabled';
    });
  }

  function categoriesParam(cats) {
    return encodeURIComponent(JSON.stringify(cats || []));
  }

  // category used to be left out of the id entirely — a user marking the
  // SAME time range under two different categories (a real, legitimate case:
  // e.g. a sponsored self-promo segment is both 'sponsor' and 'selfpromo')
  // produced the same uuid for both, so savePersonalSegment's dedup-by-uuid
  // check in sponsorblock.js silently treated the second category as an
  // already-existing duplicate and it never got saved.
  function personalUuid(videoId, start, end, category) {
    return 'personal-' + videoId + '-' + Math.round(start * 1000) + '-' + Math.round(end * 1000) + '-' + (category || 'sponsor');
  }

  function clampPersonalSegment(start, end, duration) {
    let s = Math.max(0, start);
    let e = end;
    if (duration && isFinite(duration)) e = Math.min(e, duration);
    return isValidSegment(s, e) ? { start: s, end: e } : null;
  }

  /**
   * Total seconds a viewer will actually be skipped past, for a merged segment
   * list. This is NOT `sum(end - start)`:
   *
   *   - `mergeSegments` sorts but never unions. Two contributors submitting the
   *     same break (community 60-90 and personal 62-88) are two entries, and
   *     naively adding them reports 58s removed from a 30s break. Intervals are
   *     unioned here before they are summed.
   *   - Only `skip` is removed time. `mute` still plays the video, `poi` is a
   *     zero-length jump marker, `chapter` is a label, and `full` spans the
   *     whole video as a disclosure — summing that last one reports a video with
   *     no content in it at all.
   *   - A category whose mode is not `auto` is not being skipped, so its time is
   *     not removable. With shipped defaults that means intro/outro/preview/
   *     hook/filler count as content, because by default they are left in.
   *
   * `disabled` is the set of uuids the viewer has switched off for this video.
   */
  function skippableSeconds(segments, disabled, modeResolver) {
    const ranges = [];
    for (const seg of segments || []) {
      if (!seg) continue;
      if (seg.actionType !== 'skip') continue;
      if (disabled && disabled.has(seg.uuid)) continue;
      if (modeResolver && modeResolver(seg.category) !== 'auto') continue;
      const start = Math.max(0, Number(seg.start));
      const end = Number(seg.end);
      if (!isValidSegment(start, end)) continue;
      ranges.push([start, end]);
    }
    if (!ranges.length) return 0;
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let total = 0;
    let curStart = ranges[0][0];
    let curEnd = ranges[0][1];
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i][0] <= curEnd) {
        if (ranges[i][1] > curEnd) curEnd = ranges[i][1];
      } else {
        total += curEnd - curStart;
        curStart = ranges[i][0];
        curEnd = ranges[i][1];
      }
    }
    return total + (curEnd - curStart);
  }

  /**
   * Runtime minus the parts that get skipped — what the viewer actually spends.
   *
   * Returns null when `duration` is not a usable number rather than guessing,
   * because a wrong runtime silently corrupts a time budget, and callers need to
   * be able to tell "no data" from "no sponsors". Segments are clamped to the
   * duration first: a stale submission against a re-uploaded video can claim a
   * break past the end, which would otherwise produce a negative runtime.
   */
  function implausibleSegment(seg, total) {
    if (!seg || seg.actionType !== 'skip') return false;
    const len = Number(seg.end) - Number(seg.start);
    if (!isFinite(len) || len <= 0) return false;
    return len > total * MAX_SEGMENT_FRACTION;
  }

  function contentSeconds(duration, segments, disabled, modeResolver) {
    const total = Number(duration);
    if (!isFinite(total) || total <= 0) return null;
    const clamped = [];
    for (const seg of segments || []) {
      if (!seg) continue;
      if (seg.actionType !== 'skip') { clamped.push(seg); continue; }
      // Clamp FIRST, then judge: a stale submission against a re-upload can run
      // past the end, and it is the clamped length that would actually be skipped.
      const fit = clampPersonalSegment(Number(seg.start), Number(seg.end), total);
      if (!fit) continue;
      const next = { ...seg, start: fit.start, end: fit.end };
      if (implausibleSegment(next, total)) continue;
      clamped.push(next);
    }
    const skipped = skippableSeconds(clamped, disabled, modeResolver);
    return Math.max(0, total - skipped);
  }

  /**
   * How much of the video anybody has actually reviewed.
   *
   * The gap this closes: a video with no submissions and a genuinely ad-free
   * video both produced "content === runtime", so the UI could not tell
   * "nothing to skip" from "nobody has looked". Coverage is the span from the
   * first submission to the last — inside it somebody reviewed and marked what
   * they found; outside it there is no information at all.
   *
   * Returns null when duration is unusable, and { coveredSec, uncheckedSec,
   * hasData } otherwise.
   */
  function coverage(duration, segments) {
    const total = Number(duration);
    if (!isFinite(total) || total <= 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const seg of segments || []) {
      if (!seg) continue;
      const s = Number(seg.start);
      const e = Number(seg.end);
      if (!isFinite(s) || !isFinite(e)) continue;
      if (implausibleSegment(seg, total)) continue;
      if (s < lo) lo = s;
      if (e > hi) hi = e;
    }
    if (lo === Infinity) return { coveredSec: 0, uncheckedSec: total, hasData: false };
    const covered = Math.max(0, Math.min(total, hi) - Math.max(0, lo));
    return {
      coveredSec: covered,
      uncheckedSec: Math.max(0, total - covered),
      hasData: true
    };
  }

  /**
   * The rail composition strip as a list of { frac, category } spans that tile
   * the whole duration exactly (category null = unmarked gap).
   *
   * Each segment is clipped against the previous one's end. Overlapping
   * segments are common (a sponsor read inside a self-promo) and the inline
   * version drew each from its own start, so the overlap counted twice: the
   * strip summed past 100% (measured 114) and every later span shifted right.
   *
   * @param {Array<{start:number,end:number,category?:string}>} segs sorted or not
   * @param {number} dur video duration in seconds
   * @returns {Array<{frac:number,category:(string|null)}>}
   */
  function railSpans(segs, dur) {
    if (!(dur > 0)) return [];
    const sorted = (segs || []).slice().sort((a, b) => a.start - b.start);
    const out = [];
    let prev = 0;
    sorted.forEach((s) => {
      const from = Math.max(prev, Math.min(dur, Math.max(0, Number(s.start))));
      const to = Math.max(from, Math.min(dur, Number(s.end)));
      if (to <= from) return;
      if (from > prev) out.push({ frac: (from - prev) / dur, category: null });
      out.push({ frac: (to - from) / dur, category: s.category || null });
      prev = to;
    });
    if (prev < dur) out.push({ frac: (dur - prev) / dur, category: null });
    return out;
  }

  const api = {
    railSpans,
    MIN_LEN,
    CATEGORIES,
    CATEGORY_IDS,
    CATEGORY_MAP,
    MODES,
    ACTION_TYPES,
    defaultModes,
    isValidSegment,
    isValidPoint,
    normalizeSegment,
    parseCommunityHashResponse,
    parseCommunityDirectResponse,
    parsePersonalStore,
    mergeSegments,
    modeFor,
    segmentAtTime,
    visibleSegments,
    chapterSegments,
    categoriesParam,
    personalUuid,
    clampPersonalSegment,
    skippableSeconds,
    contentSeconds,
    coverage,
    MAX_SEGMENT_FRACTION
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNSBSegments = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
