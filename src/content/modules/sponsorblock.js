/**
 * Unsynth SponsorBlock — full parity with the standalone extension:
 *   • Community ("actual") data from sponsor.ajay.app (privacy hash, then direct)
 *   • Personal skips saved on this device (chrome.storage.local)
 *   • Per-category skip modes: auto / manual / overlay / disabled
 *   • Action types: skip, mute, poi (highlight jump), full (full-video label)
 *   • Hide creator YouTube chapters
 *   • Works on watch pages AND Shorts (markers + submit + manual prompt)
 * Vote 👍/👎 on community skips to improve the database.
 */
(function () {
  'use strict';

  const API = 'https://sponsor.ajay.app';
  const PERSONAL_KEY = 'sbPersonalSegments';
  const SB = () => window.UNSBSegments;
  const ALL_CATS = () => (SB() ? SB().CATEGORY_IDS : ['sponsor']);
  const CAT_LABEL = (c) => {
    const seg = SB();
    if (c === 'personal') return 'personal skip';
    const meta = seg && seg.CATEGORY_MAP[c];
    return meta ? meta.label : c;
  };
  const CAT_SHORT = {
    sponsor: 'sponsor',
    selfpromo: 'self-promo',
    interaction: 'reminder',
    intro: 'intro',
    outro: 'outro',
    preview: 'recap',
    hook: 'hook',
    filler: 'filler',
    music_offtopic: 'non-music',
    poi_highlight: 'highlight',
    exclusive_access: 'full-video sponsor',
    chapter: 'chapter',
    personal: 'personal skip'
  };

  let core = null;
  let segments = [];
  let curVideo = null;
  let video = null;
  let notice = null;
  let onStorageChanged = null;
  let total = 0;
  let personalStore = {};
  const disabled = new Set();
  let mutedByUs = false;
  let manualPrompt = null;
  let manualPromptSeg = null;
  let fullLabel = null;
  let chapterStyleEl = null;
  let chapterTitleEl = null;

  function el(tag, cls, text) { return window.UNSYNTH.el(tag, cls, text); }

  const isWatch = () => window.UNSYNTH.isWatch();
  const isShorts = () => location.pathname.startsWith('/shorts');
  const onPlayerPage = () => isWatch() || isShorts();
  function videoId() {
    if (isShorts()) {
      const m = location.pathname.match(/\/shorts\/([\w-]{11})/);
      if (m) return m[1];
    }
    return window.UNSYNTH.videoId();
  }
  function cfg() {
    return (core && core.settings && core.settings.sponsorBlock) || {};
  }
  function useCommunity() {
    return cfg().useCommunity !== false;
  }
  function usePersonal() {
    return cfg().usePersonal !== false;
  }
  function modeFor(cat) {
    const seg = SB();
    return seg ? seg.modeFor(cat, cfg()) : 'auto';
  }
  // A category counts as "on" (skip / mute) automatically.
  function autoCat(cat) {
    return modeFor(cat) === 'auto';
  }

  function userId(cb) {
    chrome.storage.local.get('sbUserId', (d) => {
      let id = d && d.sbUserId;
      if (!id || String(id).length < 32) {
        const arr = new Uint8Array(24);
        crypto.getRandomValues(arr);
        id = 'unsynth-' + Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
        chrome.storage.local.set({ sbUserId: id });
      }
      cb(id);
    });
  }

  async function sha256hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.prototype.map.call(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function loadPersonalStore(cb) {
    chrome.storage.local.get(PERSONAL_KEY, (d) => {
      personalStore = (d && d[PERSONAL_KEY]) || {};
      cb(personalStore);
    });
  }

  function savePersonalSegment(vid, start, end, category) {
    const segApi = SB();
    if (!segApi || !vid) return Promise.resolve(false);
    const dur = video && video.duration;
    const clamped = segApi.clampPersonalSegment(start, end, dur);
    if (!clamped) return Promise.resolve(false);
    const entry = {
      start: clamped.start,
      end: clamped.end,
      category: category || 'sponsor',
      actionType: 'skip',
      uuid: segApi.personalUuid(vid, clamped.start, clamped.end, category || 'sponsor'),
      source: 'personal'
    };
    return new Promise((resolve) => {
      loadPersonalStore(() => {
        const list = (personalStore[vid] || []).slice();
        const dup = list.find((s) => s.uuid === entry.uuid);
        if (!dup) list.push(entry);
        list.sort((a, b) => a.start - b.start);
        personalStore[vid] = list;
        chrome.storage.local.set({ [PERSONAL_KEY]: personalStore }, () => {
          if (vid === curVideo) reloadSegments();
          resolve(true);
        });
      });
    });
  }

  // Proxy a sponsor.ajay.app request through the SW — content-script fetches get
  // CORS-blocked (the API drops its CORS header on error/down responses). Never rejects.
  function sbFetch(url, method, body) {
    return new Promise(function (resolve) {
      try {
        const m = { type: 'UNSYNTH/PROXY/FETCH', url: url, method: method || 'GET' };
        if (body != null) m.body = body;
        chrome.runtime.sendMessage(m, function (res) {
          if (chrome.runtime.lastError || !res) { resolve({ ok: false, status: 0, data: null }); return; }
          resolve(res);
        });
      } catch (e) {
        resolve({ ok: false, status: 0, data: null });
      }
    });
  }

  async function fetchCommunitySegments(vid, strict) {
    const segApi = SB();
    if (!segApi) return [];
    try {
      const cats = ALL_CATS();
      const q = segApi.categoriesParam(cats);
      const actions = segApi.categoriesParam(segApi.ACTION_TYPES);
      const prefix = (await sha256hex(vid)).slice(0, 4);
      const r = await sbFetch(API + '/api/skipSegments/' + prefix + '?categories=' + q + '&actionTypes=' + actions);
      if (r.ok && r.data) {
        const segs = segApi.parseCommunityHashResponse(r.data, vid);
        if (segs.length) return segs;
      }
      if (cfg().communityDirect !== false) {
        const r2 = await sbFetch(API + '/api/skipSegments?videoID=' + encodeURIComponent(vid) + '&categories=' + q + '&actionTypes=' + actions);
        if (r2.ok && r2.data) return segApi.parseCommunityDirectResponse(r2.data);
        if (strict && !r2.ok && r2.status !== 404) throw new Error("Segment check unavailable");
      } else if (strict && !r.ok && r.status !== 404) {
        throw new Error('Segment check unavailable');
      }
    } catch (e) {
      if (strict) throw e;
      /* network */
    }
    return [];
  }

  function personalSegmentsFor(vid) {
    const segApi = SB();
    if (!segApi || !usePersonal()) return [];
    return segApi.parsePersonalStore(personalStore, vid);
  }

  async function reloadSegments() {
    const segApi = SB();
    if (!segApi) {
      segments = [];
      return;
    }
    const vid = curVideo;
    if (!vid) {
      segments = [];
      return;
    }
    const lists = [];
    if (usePersonal()) lists.push(personalSegmentsFor(vid));

    // Test seam. Inert in production: nothing assigns this outside a test.
    //
    // The race lives between the await below and the write after it, which is
    // not reachable from outside the function — four harness designs failed to
    // observe it because the window closes on its own (B's own fetch lands
    // during the wait and overwrites A's contamination before it can be read).
    // This lets a test advance navigation at exactly that instant, so the guard
    // below becomes directly observable rather than inferred from timing.
    if (typeof window !== 'undefined' && window.__unsynthNavRaceHook) {
      try { await window.__unsynthNavRaceHook('before-fetch', vid); } catch (e) { /* a hook must never break playback */ }
    }

    if (useCommunity()) lists.push(await fetchCommunitySegments(vid));

    if (typeof window !== 'undefined' && window.__unsynthNavRaceHook) {
      try { await window.__unsynthNavRaceHook('after-fetch', vid); } catch (e) { /* as above */ }
    }
    // A LATE ANSWER MUST NOT REACH ANOTHER VIDEO. `segments` is consumed by
    // onTime(), which writes video.currentTime — so without this check, video
    // A's community fetch resolving after the user has moved to B overwrites
    // B's segments with A's timestamps and the player JUMPS FORWARD mid-playback
    // at A's sponsor boundaries, skipping real content of B. Worse than a
    // cosmetic contamination, because the output is a seek and not a paint.
    // Same guard desc-digest.js already uses after its await.
    if (curVideo !== vid) return;
    segments = segApi.mergeSegments(lists);
    // Which video the loaded segments belong to. onTime() acts on `segments` by
    // writing video.currentTime, so this is the state whose ownership actually
    // matters — and it was not observable from outside, which made the race
    // untestable: UNSYNTH_CONTENT_SEC is refreshed on its own path (line ~910,
    // on loadedmetadata) and therefore always reports the current video whether
    // or not `segments` was contaminated. Published for the navigation-race
    // guard and for diagnostics.
    window.UNSYNTH_SEGMENTS_OWNER = { videoId: vid, count: segments.length };
    publishContentSec();
    renderMarkers();
    renderChapters();
    renderFullLabel();
  }

  /**
   * Publish this video's sponsor-adjusted runtime for other modules.
   *
   * Only the video actually on screen has segments — they are fetched per video
   * id, so there is no way to know this for 40 candidate tiles without 40 API
   * calls. That is why this is published as a single current-video value rather
   * than resolved on demand: the queue reads it at the moment the user queues
   * the video they are watching, and items queued from anywhere else honestly
   * carry no content length at all.
   *
   * Republished on every segment reload, because a settings change (enabling
   * intro skipping, disabling a category) changes the answer without changing
   * the video.
   */
  function publishContentSec() {
    const segApi = SB();
    // Same trap as renderRuntimeStrip: during an ad the element reports the
    // ad's duration. This publishes a global other modules read, so a bad
    // value does not stay local. Keep the last good figure rather than
    // republishing the ad's.
    const YD = window.UNYtDom;
    if (YD && YD.adPlaying && YD.adPlaying()) return;
    const video = document.querySelector('video');
    const dur = video && video.duration;
    if (!segApi || !curVideo || !isFinite(dur) || dur <= 0) {
      window.UNSYNTH_CONTENT_SEC = null;
      return;
    }
    const sec = segApi.contentSeconds(dur, segments, disabled, modeFor);
    window.UNSYNTH_CONTENT_SEC = sec === null ? null : { videoId: curVideo, contentSec: sec, durationSec: dur };
    renderRuntimeStrip();
  }

  /**
   * Render the runtime strip into the deck's 'runtime' slot.
   *
   * THIS IS THE CONSUMER THAT DID NOT EXIST. publishContentSec() was writing
   * window.UNSYNTH_CONTENT_SEC in four places and nothing read it, so the
   * sponsor-adjusted runtime shipped in 1.3.0 was invisible to the user.
   *
   * Accessibility is load-bearing here, not decoration. The strip is the most
   * visually dominant thing this extension draws and it was going to ship as a
   * row of unlabelled divs: nothing for a screen reader, no keyboard entry, and
   * hover-only affordances that do not exist on touch. So instead:
   *   - the strip is a list and each region is a listitem with its own label
   *   - each skippable segment is a real button that seeks past itself, which
   *     makes it tabbable and gives the hover behaviour a keyboard equivalent
   *   - the strip carries a text summary that does not depend on colour at all
   *
   * Coverage is drawn rather than only computed. An unchecked region is hatched
   * instead of rendered as content, because "nobody submitted segments" and
   * "this video has no ads" are different answers that used to look identical.
   */
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function catLabel(id) {
    var segApi = SB();
    var meta = segApi && segApi.CATEGORY_MAP && segApi.CATEGORY_MAP[id];
    return (meta && meta.label) || id || 'segment';
  }

  // Tearing the strip down leaves an empty slot, and an empty slot still owns a
  // header button. Without this the deck renders a coral-bordered panel whose
  // only open slot is a bare caret over nothing — which is exactly what every
  // live stream showed, because duration is Infinity there.
  function syncDeckAfterRemoval() {
    var deck = window.UNWatchDeck;
    if (!deck) return;
    if (deck.syncEmpty) deck.syncEmpty(document);
    if (deck.syncCollapse) deck.syncCollapse(document);
  }

  function removeRuntimeStrip() {
    var old = document.getElementById('un-sb-runtime');
    if (old) old.remove();
  }

  function rtStat(label, value, cls, note) {
    var g = document.createElement('span');
    g.className = 'un-sb-rt-stat';
    var l = document.createElement('span');
    l.className = 'un-sb-rt-lab';
    l.textContent = label;
    var v = document.createElement('span');
    v.className = 'un-sb-rt-val' + (cls ? ' ' + cls : '');
    v.textContent = value;
    g.appendChild(l);
    g.appendChild(v);
    if (note) {
      var n = document.createElement('span');
      n.className = 'un-sb-rt-prov';
      n.textContent = note;
      g.appendChild(n);
    }
    return g;
  }

  function renderRuntimeStrip() {
    var deck = window.UNWatchDeck;
    var segApi = SB();
    if (!deck || !segApi || !segApi.coverage) { removeRuntimeStrip(); syncDeckAfterRemoval(); return; }

    // DO NOT RE-RENDER DURING AN AD, and do not tear the strip down either.
    //
    // <video>.duration is the AD's duration while an ad is on the player, so a
    // re-render mid-ad overwrites a correct strip with the ad's numbers.
    // Measured 2026-09-16: a watch page showing "CONTENT 17:49 · RUNTIME 18:40"
    // at 11s degraded to "RUNTIME 0:30" with a single unchecked segment at 20s.
    // 0:30 was the pre-roll. The strip was not wrong about the data it had — it
    // was reading the wrong video.
    //
    // Keeping what is already drawn is deliberate: removing it would make the
    // strip vanish and reappear on every ad break, which is worse than briefly
    // stale, and the numbers it holds are still the ones for this video.
    var YD = window.UNYtDom;
    if (YD && YD.adPlaying && YD.adPlaying()) {
      if (document.getElementById('un-sb-runtime')) return;
      removeRuntimeStrip();
      syncDeckAfterRemoval();
      return;
    }

    var video = document.querySelector('video');
    var dur = video && video.duration;
    // A live stream has no total, so there is no proportional strip to draw and
    // no honest end time. Render nothing rather than a playhead stuck at 100%.
    if (!curVideo || !isFinite(dur) || dur <= 0) { removeRuntimeStrip(); syncDeckAfterRemoval(); return; }

    var slot = deck.slot('runtime');
    if (!slot) { removeRuntimeStrip(); syncDeckAfterRemoval(); return; }

    var content = segApi.contentSeconds(dur, segments, disabled, modeFor);
    if (content === null) { removeRuntimeStrip(); syncDeckAfterRemoval(); return; }
    var cov = segApi.coverage(dur, segments) || { coveredSec: 0, uncheckedSec: dur, hasData: false };
    var skipped = Math.max(0, dur - content);

    removeRuntimeStrip();
    var wrap = document.createElement('div');
    wrap.id = 'un-sb-runtime';
    wrap.className = 'un-sb-rt';

    var visibleSkips = segApi.visibleSegments(segments, disabled, modeFor)
      .filter(function (sg) { return sg.actionType === 'skip'; });

    // NOTHING TO SKIP IS ONE LINE, NOT AN INSTRUMENT (2026-09-22).
    //
    // With no reported segments the strip used to draw a hero figure equal to
    // the player's own duration, a full-width hatched bar, a one-item key
    // reading "Unmarked" and a sentence explaining the hatch — four elements,
    // ~110px, all saying "nobody reported anything" (DESIGN-STANDARD rule E,
    // decorative telemetry; captured on jNQXAC9IVRw). The honest content is
    // the sentence, so the sentence is what renders. It still says unchecked,
    // never clean: "no reports" is not "no ads".
    if (!visibleSkips.length) {
      wrap.classList.add('is-quiet');
      var q = document.createElement('p');
      q.className = 'un-sb-rt-quiet';
      var qv = document.createElement('span');
      qv.className = 'un-sb-rt-val';
      qv.textContent = fmtClock(dur);
      q.appendChild(qv);
      q.appendChild(document.createTextNode(' · Nobody has reported skip segments for this video. Unreported is not the same as checked.'));
      wrap.appendChild(q);
      slot.appendChild(wrap);
      if (deck.syncEmpty) deck.syncEmpty(document); if (deck.syncCollapse) deck.syncCollapse(document);
      return;
    }

    var head = document.createElement('div');
    head.className = 'un-sb-rt-head';
    if (cov.hasData && skipped > 0) {
      head.appendChild(rtStat('After skips', fmtClock(content), 'is-hero'));
      head.appendChild(rtStat('Full length', fmtClock(dur)));
      head.appendChild(rtStat('Skippable', fmtClock(skipped), 'is-crowd', 'reported segments'));
    } else {
      head.appendChild(rtStat('Full length', fmtClock(dur), 'is-hero'));
    }
    // Keep exact segment details available on focus as well as hover.
    var legend = document.createElement('span');
    legend.className = 'un-sb-rt-legend';
    legend.setAttribute('aria-hidden', 'true');
    head.appendChild(legend);
    wrap.appendChild(head);

    var strip = document.createElement('ul');
    strip.className = 'un-sb-rt-tape';
    strip.setAttribute('aria-label',
      'Video timeline. ' + fmtClock(content) + ' after available skips out of ' + fmtClock(dur) + '. ' +
      (skipped > 0 ? fmtClock(skipped) + ' in enabled skip segments.' : 'No enabled skip segments.') +
      ' Unmarked portions are not verified. Coloured buttons jump to the end of a reported segment.');

    var visible = segApi.visibleSegments(segments, disabled, modeFor)
      .filter(function (sg) { return sg.actionType === 'skip'; })
      .slice()
      .sort(function (a, b) { return a.start - b.start; });

    var lo = visible.length ? Math.max(0, visible[0].start) : 0;
    var hi = visible.length ? Math.min(dur, visible[visible.length - 1].end) : 0;

    function pushRegion(from, to, kind, seg) {
      var w = ((to - from) / dur) * 100;
      if (w <= 0) return;
      var li = document.createElement('li');
      li.className = 'un-sb-rt-seg is-' + kind;
      li.style.width = w.toFixed(3) + '%';
      if (kind === 'unchecked') {
        li.setAttribute('aria-label',
          'Unmarked, ' + fmtClock(from) + ' to ' + fmtClock(to) +
          '. No enabled skip segment here; this does not mean the footage is verified.');
        li.title = li.getAttribute('aria-label');
      } else if (seg) {
        li.classList.add('un-sb-' + seg.category);
        var len = to - from;
        var label = catLabel(seg.category) + ', ' + fmtClock(len) +
          ', from ' + fmtClock(from) + ' to ' + fmtClock(to);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'un-sb-rt-skip';
        btn.setAttribute('aria-label', 'Skip ' + label);
        btn.title = catLabel(seg.category) + ' · ' + fmtClock(from) + '–' + fmtClock(to) + ' · jump to end';
        // Print the duration inside the segment when it is wide enough to hold
        // it. This is what replaced the legend the panel cut.
        if (w >= 3.2) {
          var t = document.createElement('span');
          t.className = 'un-sb-rt-inl';
          t.textContent = fmtClock(len);
          btn.appendChild(t);
        }
        // Teach the colour at the moment the user asks, rather than making
        // them wait out a native tooltip or learn it from a skip notice that
        // may not fire for minutes. Focus as well as hover: a keyboard user
        // reaching this segment gets the same answer.
        var explain = function (on) {
          var strip = document.getElementById('un-sb-runtime');
          if (!strip) return;
          var leg = strip.querySelector('.un-sb-rt-legend');
          if (!leg) return;
          if (on) {
            leg.textContent = catLabel(seg.category) + ' · ' + fmtClock(from) + '–' + fmtClock(to) + ' · jump to end';
            leg.style.setProperty('--un-sb-cat-color',
              getComputedStyle(li).backgroundColor);
          }
          strip.classList.toggle('is-explaining', !!on);
        };
        btn.addEventListener('mouseenter', function () { explain(true); });
        btn.addEventListener('mouseleave', function () { explain(false); });
        btn.addEventListener('focus', function () { explain(true); });
        btn.addEventListener('blur', function () { explain(false); });
        btn.addEventListener('click', function () {
          var v = document.querySelector('video');
          if (v && isFinite(to)) v.currentTime = Math.min(dur - 0.1, to);
        });
        li.appendChild(btn);
      } else {
        li.setAttribute('aria-label', 'Content, ' + fmtClock(from) + ' to ' + fmtClock(to));
      }
      strip.appendChild(li);
    }

    if (!visible.length) {
      pushRegion(0, dur, 'unchecked', null);
    } else {
      if (lo > 0) pushRegion(0, lo, 'unchecked', null);
      var prev = lo;
      visible.forEach(function (sg) {
        var s = Math.max(lo, Math.min(dur, sg.start));
        var e = Math.max(s, Math.min(dur, sg.end));
        if (s > prev) pushRegion(prev, s, 'unchecked', null);
        pushRegion(s, e, 'skip', sg);
        prev = e;
      });
      if (prev < hi) pushRegion(prev, hi, 'unchecked', null);
      if (hi < dur) pushRegion(hi, dur, 'unchecked', null);
    }

    var tapeWrap = document.createElement('div');
    tapeWrap.className = 'un-sb-rt-wrap';
    tapeWrap.appendChild(strip);
    var ph = document.createElement('span');
    ph.className = 'un-sb-rt-playhead';
    ph.style.left = (((video.currentTime || 0) / dur) * 100).toFixed(3) + '%';
    tapeWrap.appendChild(ph);
    wrap.appendChild(tapeWrap);

    // The key names only what is coloured. "Unmarked" used to lead it, a
    // swatch for the plain track that 88% of every tape is — a legend entry
    // for the absence of data. That meaning now lives where it is asked: the
    // tape's own label and each plain region's tooltip.
    var key = document.createElement('div');
    key.className = 'un-sb-rt-key';
    key.setAttribute('aria-label', 'Timeline colour key');
    var shownCategories = {};
    visible.forEach(function (seg) {
      if (shownCategories[seg.category]) return;
      shownCategories[seg.category] = true;
      var item = document.createElement('span');
      item.className = 'un-sb-rt-key-item';
      var swatch = document.createElement('i');
      swatch.className = 'un-sb-rt-swatch un-sb-' + seg.category;
      swatch.setAttribute('aria-hidden', 'true');
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(catLabel(seg.category)));
      key.appendChild(item);
    });
    // "Select a coloured segment to jump past it" rides the key as its last
    // item instead of a sentence-long paragraph under it: same instruction,
    // no extra row. The arithmetic ("full length minus reported segments")
    // is the hero's tooltip.
    var hint = document.createElement('span');
    hint.className = 'un-sb-rt-hint';
    hint.textContent = 'Click a colour to skip it';
    key.appendChild(hint);
    wrap.appendChild(key);
    var heroEl = head.querySelector('.un-sb-rt-val.is-hero');
    if (heroEl) heroEl.parentNode.title = 'Full length minus the reported segments you have enabled';

    slot.appendChild(wrap);
    if (deck.syncEmpty) deck.syncEmpty(document); if (deck.syncCollapse) deck.syncCollapse(document);
  }

  /* ===== Up next chips ====================================================
   *
   * A corner chip on each sidebar thumbnail carrying the real runtime, plus the
   * composition strip welded along the bottom edge.
   *
   * WHY A CHIP AND NOT A LINE OF TEXT
   * The obvious design is one more line under the title. Measured, the rail is 20
   * rows of 160px, so a 16px line is 320px of extra scroll to say what a chip on
   * unused image space says for free. The thumbnail is 284px wide — YouTube
   * reserves far more picture than it labels — so the top-left corner is empty
   * on every row.
   *
   * WHY IT IS LAZY
   * SponsorBlock has no batch endpoint. The hash-prefix route looks like one and
   * is not: 65,536 buckets over roughly ten million submitted videos means two
   * arbitrary rail videos practically never share a prefix. So 20 rows is 20
   * requests, and this only fetches for rows the user has actually scrolled to,
   * behind the persistent cache in shared/segment-cache.js. A rail that is never
   * scrolled costs a handful of requests, not twenty.
   */
  var RAIL_ANNOTATED = 'un-sb-railed';
  var railObserver = null;
  // YouTube appends sidebar tiles lazily as you scroll — measured live
  // 2026-09-15: 20 tiles at load, 40 after scrolling, while annotations froze
  // at 4. observeRail() runs once per navigation, so every tile YouTube added
  // afterwards was never handed to the IntersectionObserver and could never be
  // annotated no matter how far the user scrolled. This watches the rail
  // container and observes newcomers.
  var railMutObserver = null;
  var railQueue = [];
  var railBusy = false;
  var railCache = null;

  function railEnabled() {
    var c = cfg();
    return c.railChips !== false;
  }

  function loadRailCache(cb) {
    if (railCache) { cb(railCache); return; }
    var SCache = window.UNSegmentCache;
    if (!SCache) { cb(null); return; }
    try {
      var q = {};
      q[SCache.KEY] = null;
      chrome.storage.local.get(q, function (d) {
        // Prune on load: a fortnight of entries is cheap to walk once per page,
        // and it keeps the stored blob from carrying dead weight forever.
        railCache = SCache.prune((d && d[SCache.KEY]) || {});
        cb(railCache);
      });
    } catch (e) { cb(null); }
  }

  function saveRailCache(results) {
    var SCache = window.UNSegmentCache;
    if (!SCache || !railCache) return;
    railCache = SCache.merge(railCache, results);
    try {
      var p = {};
      p[SCache.KEY] = railCache;
      chrome.storage.local.set(p);
    } catch (e) { /* context invalidated; the paint already happened */ }
  }

  /** Cache-first segments for one video id. Never rejects. */
  function railSegments(vid) {
    return new Promise(function (resolve) {
      var SCache = window.UNSegmentCache;
      loadRailCache(function (store) {
        if (SCache && store) {
          var part = SCache.partition(store, [vid]);
          if (Object.prototype.hasOwnProperty.call(part.hits, vid)) {
            resolve(part.hits[vid]);
            return;
          }
        }
        fetchCommunitySegments(vid).then(function (segs) {
          var out = segs || [];
          var res = {};
          res[vid] = out;
          saveRailCache(res);
          resolve(out);
        }).catch(function () { resolve([]); });
      });
    });
  }

  /**
   * One row at a time, in scroll order.
   *
   * Twenty parallel requests to a community API is rude and gets rate-limited.
   * Serial with a small gap is slower per row and finishes the visible ones
   * sooner, which is the part the user sees.
   */
  function pumpRailQueue() {
    if (railBusy) return;
    var next = railQueue.shift();
    if (!next) return;
    railBusy = true;
    railSegments(next.vid).then(function (segs) {
      try { paintRailTile(next.tile, next.vid, segs); } catch (e) { /* tile went away */ }
      railBusy = false;
      if (railQueue.length) setTimeout(pumpRailQueue, 120);
    });
  }

  function railThumb(tile) {
    var YD = window.UNYtDom;
    if (YD && YD.tileThumb) {
      var t = YD.tileThumb(tile);
      if (t) return t;
    }
    // No literal fallback: yt-dom owns every YouTube selector, and a duplicate
    // here is drift the moment YouTube renames one of them.
    return null;
  }

  function paintRailTile(tile, vid, segs) {
    if (!tile || !tile.isConnected) return;
    var host = railThumb(tile);
    if (!host) return;
    var segApi = SB();
    if (!segApi) return;

    var old = host.querySelector('.un-sb-rail');
    if (old) old.remove();

    // Duration is not on the tile as a number, only as a badge like "14:14", so
    // it is parsed rather than fetched. Without it there is no proportional
    // strip to draw and no real runtime to state.
    // tileDurationText covers three markup generations and already returns '' or
    // 'LIVE' rather than a clock when there is no real duration.
    var YD2 = window.UNYtDom;
    var dur = YD2 && YD2.tileDurationText ? parseClock(YD2.tileDurationText(tile)) : 0;

    var wrap = document.createElement('div');
    wrap.className = 'un-sb-rail';

    var cov = dur > 0 ? segApi.coverage(dur, segs) : null;
    var content = dur > 0 ? segApi.contentSeconds(dur, segs, disabled, modeFor) : null;

    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'un-sb-rail-chip';
    if (content !== null && dur > 0 && dur - content >= 30) {
      // Only claim a saving worth acting on. Under 30 seconds the chip would be
      // noise on every row, which is how an annotation stops being read.
      chip.textContent = fmtClock(content) + ' real';
      chip.classList.add('is-real');
    } else if (cov && !cov.hasData) {
      chip.textContent = 'Check skips';
      chip.classList.add('is-unknown');
    } else if (cov && cov.uncheckedSec > dur * 0.25) {
      chip.textContent = 'Refresh skips';
      chip.classList.add('is-partial');
    } else {
      // Reviewed, nothing worth skipping. Say nothing rather than print a chip
      // that means "no news".
      chip = null;
    }

    if (chip) {
      chip.setAttribute('aria-label',
        chip.textContent + ' — of ' + fmtClock(dur) + ' total');
      chip.title = 'Check SponsorBlock for reported skip segments. This is not an AI-content check.';
      chip.setAttribute('aria-label', 'Check reported skip segments on SponsorBlock');
      chip.addEventListener('click', async function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (chip.disabled) return;
        var restoreFocus = document.activeElement === chip;
        chip.disabled = true;
        chip.textContent = 'Checking…';
        chip.setAttribute('aria-busy', 'true');
        try {
          var fresh = await fetchCommunitySegments(vid, true);
          var yd = window.UNYtDom;
          if (!tile.isConnected || !yd || yd.tileVideoId(tile) !== vid) return;
          var saved = {}; saved[vid] = fresh; saveRailCache(saved);
          restoreFocus = restoreFocus && (document.activeElement === chip || document.activeElement === document.body);
          paintRailTile(tile, vid, fresh);
          var updated = tile.querySelector('.un-sb-rail-chip');
          if (updated && !fresh.length) {
            updated.textContent = 'No skips reported';
            updated.title = 'Checked SponsorBlock: no segments reported. This is not an AI verdict. Click to check again.';
          }
          if (updated) {
            updated.setAttribute('aria-label', updated.textContent + '. Check reported skip segments on SponsorBlock');
            if (restoreFocus) updated.focus();
          }
        } catch (error) {
          if (chip.isConnected) { chip.textContent = 'Retry skip check'; chip.title = 'SponsorBlock could not be reached. Click to retry.'; chip.setAttribute('aria-label', 'Skip check failed. Retry SponsorBlock check'); }
        } finally {
          chip.disabled = false;
          chip.removeAttribute('aria-busy');
        }
      });
      wrap.appendChild(chip);
    }

    if (dur > 0 && segs && segs.length) {
      var strip = document.createElement('span');
      strip.className = 'un-sb-rail-strip';
      strip.setAttribute('aria-hidden', 'true');
      var visible = segApi.visibleSegments(segs, disabled, modeFor)
        .filter(function (s) { return s.actionType === 'skip'; });
      // Shared, unit-tested: clips overlapping segments so the spans tile to
      // exactly 100% (the inline loop double-counted overlaps and shifted
      // every later span; measured 114% in the live rail-chips spec).
      segApi.railSpans(visible, dur).forEach(function (sp) {
        strip.appendChild(railSpan(sp.frac, sp.category));
      });
      wrap.appendChild(strip);
    }

    if (!wrap.children.length) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(wrap);
  }

  function railSpan(frac, category) {
    var i = document.createElement('i');
    i.style.width = (frac * 100).toFixed(3) + '%';
    if (category) i.className = 'un-sb-' + category;
    return i;
  }

  /** "14:14" or "1:02:03" -> seconds. Returns 0 for anything else, including live. */
  function parseClock(text) {
    if (!text) return 0;
    var m = String(text).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!m) return 0;
    return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
  }

  /**
   * Watch the rail and enqueue rows as they come into view.
   *
   * IntersectionObserver rather than annotating everything on sight: the rail
   * renders 20 rows and most users see four. Fetching for all twenty would spend
   * sixteen requests on rows nobody scrolled to.
   */
  function observeRail() {
    if (!railEnabled()) { teardownRail(); return; }
    var YD = window.UNYtDom;
    var sel = YD && YD.RELATED_TILES_SEL;
    if (!sel) return;

    if (!railObserver && typeof IntersectionObserver !== 'undefined') {
      railObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var tile = e.target;
          railObserver.unobserve(tile);
          if (tile.classList.contains(RAIL_ANNOTATED)) return;
          tile.classList.add(RAIL_ANNOTATED);
          var vid = YD.tileVideoId ? YD.tileVideoId(tile) : null;
          if (!vid) return;
          railQueue.push({ tile: tile, vid: vid });
          pumpRailQueue();
        });
      }, { rootMargin: '200px 0px' });
    }
    if (!railObserver) return;

    var observeAll = function () {
      var tiles = document.querySelectorAll(sel);
      for (var i = 0; i < tiles.length; i++) {
        if (!tiles[i].classList.contains(RAIL_ANNOTATED)) railObserver.observe(tiles[i]);
      }
    };
    observeAll();

    // Pick up tiles YouTube adds after this point. Observing the whole subtree
    // rather than a specific container: the rail's host element differs across
    // YouTube's markup generations, and a missed container means silently zero
    // new annotations — the exact failure this fixes.
    if (!railMutObserver && typeof MutationObserver !== 'undefined') {
      var pending = null;
      railMutObserver = new MutationObserver(function () {
        // Coalesce: YouTube inserts tiles in bursts, and re-running the sweep
        // per mutation would call observe() hundreds of times for one batch.
        if (pending) return;
        pending = setTimeout(function () {
          pending = null;
          if (railObserver) observeAll();
        }, 250);
      });
      railMutObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function teardownRail() {
    if (railObserver) { railObserver.disconnect(); railObserver = null; }
    if (railMutObserver) { railMutObserver.disconnect(); railMutObserver = null; }
    railQueue.length = 0;
    document.querySelectorAll('.un-sb-rail').forEach(function (n) { n.remove(); });
    document.querySelectorAll('.' + RAIL_ANNOTATED).forEach(function (n) {
      n.classList.remove(RAIL_ANNOTATED);
    });
  }

  // ===== auto behaviors (throttled — timeupdate is ~4Hz and too chatty) =====
  let lastOnTimeMs = 0;
  let cachedChapters = null;
  let cachedChaptersSig = '';
  let lastChapterUuid = null;
  let lastMuteIn = null;
  let lastManualUuid = null;

  function chaptersCached() {
    // Must include the chapter mode: chapterList() -> segApi.chapterSegments()
    // returns [] outright when modeFor('chapter') === 'disabled', but a
    // same-video settings toggle (e.g. flipping chapter captions off mid-
    // playback) doesn't change segments.length or disabled.size — the two
    // things this key WAS built from — so the sig stayed identical and the
    // stale pre-toggle (non-empty) list kept getting served. The on-screen
    // caption never disappeared until the user navigated to a new video,
    // which is the only other place cachedChapters gets reset.
    const sig = curVideo + ':' + segments.length + ':' + disabled.size + ':' + modeFor('chapter');
    if (cachedChapters && cachedChaptersSig === sig) return cachedChapters;
    cachedChaptersSig = sig;
    cachedChapters = chapterList();
    return cachedChapters;
  }

  function onTime() {
    if (!video) return;
    const now = Date.now();
    // Always check skip promptly so mid-sponsor detection isn't lagged, but
    // coalesce DOM chapter/mute prompt work to ~4Hz max.
    const t = video.currentTime;
    // Auto-skip (must stay close to realtime)
    for (const seg of segments) {
      if (disabled.has(seg.uuid)) continue;
      if (seg.actionType !== 'skip') continue;
      if (modeFor(seg.category) !== 'auto') continue;
      if (t >= seg.start + 0.05 && t < seg.end - 0.4) {
        const skipped = seg.end - video.currentTime;
        video.currentTime = seg.end;
        total += Math.max(0, skipped);
        showNotice(seg);
        return;
      }
    }
    if (now - lastOnTimeMs < 250) return;
    lastOnTimeMs = now;
    handleMute(t);
    updateManualPrompt(t);
    updateChapterTitle(t);
  }

  // mute action: auto-mute inside a mute segment (auto mode), restore after.
  function handleMute(t) {
    if (!video) return;
    let inMute = false;
    for (const seg of segments) {
      if (disabled.has(seg.uuid)) continue;
      if (seg.actionType !== 'mute') continue;
      if (modeFor(seg.category) !== 'auto') continue;
      if (t >= seg.start && t < seg.end) { inMute = true; break; }
    }
    if (lastMuteIn === inMute) return;
    lastMuteIn = inMute;
    if (inMute && !video.muted) {
      video.muted = true;
      mutedByUs = true;
    } else if (!inMute && mutedByUs) {
      video.muted = false;
      mutedByUs = false;
    }
  }

  // manual mode: show a "Skip …" button while inside a manual segment.
  function updateManualPrompt(t) {
    let active = null;
    for (const seg of segments) {
      if (disabled.has(seg.uuid)) continue;
      if (seg.actionType !== 'skip') continue;
      if (modeFor(seg.category) !== 'manual') continue;
      if (t >= seg.start && t < seg.end - 0.2) { active = seg; break; }
    }
    const uuid = active ? active.uuid : null;
    if (uuid === lastManualUuid) return;
    lastManualUuid = uuid;
    if (active) showManualPrompt(active);
    else removeManualPrompt();
  }

  function removeManualPrompt() {
    if (manualPrompt && manualPrompt.parentNode) manualPrompt.parentNode.removeChild(manualPrompt);
    manualPrompt = null;
    manualPromptSeg = null;
  }

  function showManualPrompt(seg) {
    if (manualPromptSeg && manualPromptSeg.uuid === seg.uuid && manualPrompt) return;
    removeManualPrompt();
    manualPromptSeg = seg;
    manualPrompt = el('div', 'un-sb-notice un-sb-manual');
    manualPrompt.appendChild(el('span', 'un-sb-dot un-sb-' + seg.category));
    manualPrompt.appendChild(el('span', 'un-sb-txt', (CAT_SHORT[seg.category] || seg.category)));
    const skip = el('button', 'un-sb-btn un-sb-skipnow', 'Skip →');
    skip.addEventListener('click', () => {
      if (video) video.currentTime = seg.end;
      total += Math.max(0, seg.end - seg.start);
      removeManualPrompt();
    });
    manualPrompt.appendChild(skip);
    const host = playerHost();
    host.appendChild(manualPrompt);
  }

  function playerHost() {
    return document.querySelector('#movie_player') || document.querySelector('#shorts-player') || document.body;
  }

  function detachVideo() {
    if (!video) return;
    video.removeEventListener('timeupdate', onTime);
    video.removeEventListener('loadedmetadata', onMeta);
    video.removeEventListener('durationchange', onMeta);
    if (mutedByUs) { try { video.muted = false; } catch (e) {} mutedByUs = false; }
    video = null;
    lastMuteIn = null;
    lastManualUuid = null;
    lastChapterUuid = null;
    cachedChapters = null;
    cachedChaptersSig = '';
    lastOnTimeMs = 0;
  }

  function onMeta() {
    renderMarkers();
    renderChapters();
    renderFullLabel();
    // The runtime strip needs this too, and did not have it.
    //
    // renderRuntimeStrip bails when duration is not yet a finite positive
    // number, which is the normal state for the first moments after a player
    // swap — and nothing re-ran it once the number arrived, so the strip stayed
    // gone for the rest of the session. Reproduced by setting [dark] on <html>,
    // which makes YouTube rebuild the player: duration read 0 and the strip
    // never came back.
    publishContentSec();
  }

  // Scoped to #movie_player/#shorts-player, matching every other module that
  // reads the live player's <video> (ad-skip.js, chapters.js, volume-master.js,
  // etc.). This used to end with a bare 'video' fallback — sponsorblock.js was
  // the only module in the codebase with one — which matches the FIRST <video>
  // ANYWHERE in the document: an ad's own <video>, a hover-preview, or a stale
  // leftover node YouTube's SPA routing didn't tear down from a previous page.
  // onTime() then runs auto-skip/auto-mute against whatever that wrong node is.
  function attachVideo() {
    const v = document.querySelector('#movie_player video.html5-main-video, #movie_player video, #shorts-player video');
    if (!v) return;
    if (v === video) return;
    detachVideo();
    video = v;
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
  }

  function removeNotice() {
    if (notice && notice.parentNode) notice.parentNode.removeChild(notice);
    notice = null;
  }

  function showNotice(seg) {
    removeNotice();
    const isPersonal = seg.source === 'personal';
    notice = el('div', 'un-sb-notice');
    notice.appendChild(el('span', 'un-sb-dot un-sb-' + (seg.category || 'sponsor')));
    const label = isPersonal ? 'Skipped personal segment' : 'Skipped ' + (CAT_SHORT[seg.category] || seg.category);
    notice.appendChild(el('span', 'un-sb-txt', label));
    if (!isPersonal) {
      const up = el('button', 'un-sb-btn', '👍');
      up.title = 'This skip was correct';
      up.setAttribute('aria-label', 'This skip was correct');
      const down = el('button', 'un-sb-btn', '👎');
      down.title = 'Wrong — bring it back';
      down.setAttribute('aria-label', 'Wrong skip — bring the segment back');
      up.addEventListener('click', () => {
        vote(seg.uuid, 1);
        up.textContent = '✓';
        up.disabled = true;
      });
      down.addEventListener('click', () => {
        vote(seg.uuid, 0);
        disabled.add(seg.uuid);
        if (video) video.currentTime = seg.start;
        removeNotice();
      });
      notice.appendChild(up);
      notice.appendChild(down);
    }
    const undo = el('button', 'un-sb-btn un-sb-undo', 'Undo');
    undo.addEventListener('click', () => {
      disabled.add(seg.uuid);
      if (video) video.currentTime = seg.start;
      removeNotice();
    });
    notice.appendChild(undo);
    playerHost().appendChild(notice);
    clearTimeout(showNotice._t);
    showNotice._t = setTimeout(removeNotice, 6500);
  }

  function vote(uuid, type) {
    if (!uuid || String(uuid).indexOf('personal-') === 0) return;
    userId((id) => {
      sbFetch(API + '/api/voteOnSponsorTime?UUID=' + encodeURIComponent(uuid) + '&userID=' + encodeURIComponent(id) + '&type=' + type, 'POST');
    });
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ===== full-video sponsor label (exclusive_access / full action) =====
  function removeFullLabel() {
    if (fullLabel && fullLabel.parentNode) fullLabel.parentNode.removeChild(fullLabel);
    fullLabel = null;
  }

  function renderFullLabel() {
    removeFullLabel();
    if (!onPlayerPage()) return;
    const seg = segments.find((s) => s.actionType === 'full' && !disabled.has(s.uuid) && modeFor(s.category) !== 'disabled');
    if (!seg) return;
    fullLabel = el('div', 'un-sb-full-label');
    fullLabel.appendChild(el('span', 'un-sb-dot un-sb-' + seg.category));
    fullLabel.appendChild(el('span', 'un-sb-txt', 'Entire video is a sponsor'));
    playerHost().appendChild(fullLabel);
    clearTimeout(renderFullLabel._t);
    renderFullLabel._t = setTimeout(removeFullLabel, 8000);
  }

  // ===== highlight (poi) — jump-to button in the player controls =====
  function ensureHighlightButton() {
    const seg = segments.find((s) => s.actionType === 'poi' && !disabled.has(s.uuid) && modeFor(s.category) !== 'disabled');
    if (!onPlayerPage() || !seg) {
      window.UNSYNTH.removePlayerButton('un-sb-poi-btn');
      return;
    }
    window.UNSYNTH.addPlayerButton({
      id: 'un-sb-poi-btn',
      svg: '★',
      title: 'Jump to highlight (' + fmt(seg.start) + ')',
      ariaLabel: 'Jump to the video highlight',
      onClick: () => { if (video) video.currentTime = seg.start; },
      cls: 'un-sb-poi-btn',
      priority: 48
    });
  }

  // ===== hide creator YouTube chapters =====
  function applyChapterHiding() {
    const hide = cfg().hideChapters === true;
    if (hide && !chapterStyleEl) {
      chapterStyleEl = document.createElement('style');
      chapterStyleEl.id = 'un-sb-hide-chapters';
      chapterStyleEl.textContent =
        '.ytp-chapter-container,.ytp-chapter-title,ytd-macro-markers-list-renderer,' +
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-description-chapters"]' +
        '{display:none !important;}';
      (document.head || document.documentElement).appendChild(chapterStyleEl);
    } else if (!hide && chapterStyleEl) {
      chapterStyleEl.remove();
      chapterStyleEl = null;
    }
  }

  function removeMarkers() {
    document.querySelectorAll('.un-sb-markers').forEach((m) => m.remove());
  }

  // ===== community chapter names =====
  function removeChapters() {
    document.querySelectorAll('.un-sb-chapters').forEach((m) => m.remove());
  }
  function chapterList() {
    const segApi = SB();
    if (!segApi || !segApi.chapterSegments) return [];
    return segApi.chapterSegments(segments, disabled, modeFor);
  }
  // Boundary ticks on the progress bar, each tooltip = the community chapter name.
  function renderChapters() {
    if (!onPlayerPage()) {
      removeChapters();
      return;
    }
    const bar = progressBar();
    const dur = video && video.duration;
    if (!bar || !dur || !isFinite(dur)) return;
    const chaps = chapterList();
    const sig = 'c:' + curVideo + ':' + Math.round(dur) + ':' + chaps.map((s) => s.uuid).join(',');
    let layer = bar.querySelector('.un-sb-chapters');
    if (layer && layer.dataset.sig === sig) return;
    if (layer) layer.remove();
    if (!chaps.length) return;
    layer = el('div', 'un-sb-chapters');
    layer.dataset.sig = sig;
    chaps.forEach((seg) => {
      const left = Math.max(0, Math.min(100, (seg.start / dur) * 100));
      const tick = el('div', 'un-sb-chap-tick');
      tick.style.left = left + '%';
      tick.title = (seg.description || 'Chapter') + ' · ' + fmt(seg.start);
      layer.appendChild(tick);
    });
    bar.appendChild(layer);
  }
  // A small "current chapter" caption over the player, community-sourced.
  function removeChapterTitle() {
    if (chapterTitleEl && chapterTitleEl.parentNode) chapterTitleEl.parentNode.removeChild(chapterTitleEl);
    chapterTitleEl = null;
  }
  function updateChapterTitle(t) {
    const chaps = chaptersCached();
    if (!chaps.length) {
      if (lastChapterUuid) {
        removeChapterTitle();
        lastChapterUuid = null;
      }
      return;
    }
    let cur = null;
    for (const seg of chaps) {
      if (t >= seg.start && (seg.end <= seg.start || t < seg.end)) cur = seg;
    }
    const uuid = cur ? cur.uuid : null;
    if (uuid === lastChapterUuid) return;
    lastChapterUuid = uuid;
    const name = cur && cur.description;
    if (!name) {
      removeChapterTitle();
      return;
    }
    if (!chapterTitleEl) {
      chapterTitleEl = el('div', 'un-sb-chap-title');
      chapterTitleEl.appendChild(el('span', 'un-sb-dot un-sb-chapter'));
      chapterTitleEl.appendChild(el('span', 'un-sb-chap-title-txt', ''));
      playerHost().appendChild(chapterTitleEl);
    } else if (!chapterTitleEl.parentNode) {
      playerHost().appendChild(chapterTitleEl);
    }
    const txt = chapterTitleEl.querySelector('.un-sb-chap-title-txt');
    if (txt && txt.textContent !== name) txt.textContent = name;
  }

  function progressBar() {
    // Watch pages: .ytp-progress-bar. Shorts: the like/progress rail differs;
    // YouTube renders a <div class="YtProgressBarLineComponent…"> or the native
    // progress bar inside the shorts player — target the generic progress bar.
    return (
      document.querySelector('#movie_player .ytp-progress-bar') ||
      document.querySelector('#shorts-player .ytp-progress-bar') ||
      document.querySelector('.ytp-progress-bar')
    );
  }

  function renderMarkers() {
    if (!onPlayerPage()) {
      removeMarkers();
      return;
    }
    const segApi = SB();
    const bar = progressBar();
    const dur = video && video.duration;
    if (!bar || !dur || !isFinite(dur)) return;
    const shown = segApi
      ? segApi.visibleSegments(segments, disabled, modeFor).filter((s) => s.actionType === 'skip' || s.actionType === 'mute')
      : [];
    const sig = curVideo + ':' + Math.round(dur) + ':' + shown.map((s) => s.uuid + s.source).join(',');
    let layer = bar.querySelector('.un-sb-markers');
    if (layer && layer.dataset.sig === sig) return;
    if (layer) layer.remove();
    if (!shown.length) return;
    layer = el('div', 'un-sb-markers');
    layer.dataset.sig = sig;
    shown.forEach((seg) => {
      const left = Math.max(0, Math.min(100, (seg.start / dur) * 100));
      const w = Math.max(0.25, Math.min(100 - left, ((seg.end - seg.start) / dur) * 100));
      const cls = 'un-sb-mark un-sb-' + (seg.source === 'personal' ? 'personal' : seg.category);
      const m = el('div', cls);
      m.style.left = left + '%';
      m.style.width = w + '%';
      const src = seg.source === 'personal' ? 'personal' : CAT_SHORT[seg.category] || seg.category;
      m.title = src + ' · ' + fmt(seg.start) + '–' + fmt(seg.end);
      layer.appendChild(m);
    });
    bar.appendChild(layer);
  }

  async function load() {
    if (!onPlayerPage()) {
      segments = [];
      removeNotice();
      removeMarkers();
      removeChapters();
      removeChapterTitle();
      removeManualPrompt();
      removeFullLabel();
      window.UNSYNTH.removePlayerButton('un-sb-poi-btn');
      window.UNSYNTH.removeMenuItem('un-sb-submit-btn');
      closeSubmitPanel();
      curVideo = null;
      window.UNSYNTH_CONTENT_SEC = null;
      applyChapterHiding();
      return;
    }
    applyChapterHiding();
    const vid = videoId();
    if (!vid) return;
    attachVideo();
    if (vid !== curVideo) {
      curVideo = vid;
      // The previous video's answer must not survive into this one.
      window.UNSYNTH_CONTENT_SEC = null;
      total = 0;
      disabled.clear();
      removeMarkers();
      removeChapters();
      removeChapterTitle();
      removeManualPrompt();
    }
    await new Promise((resolve) => loadPersonalStore(resolve));
    await reloadSegments();
    ensureSubmitButton();
    ensureHighlightButton();
    // The rail is rebuilt by YouTube on every navigation, so re-observe rather
    // than assuming the previous observer still has anything attached.
    observeRail();
  }

  // ===== community segment submission =====
  function sbUserId(cb) {
    userId(cb);
  }

  function fmtTime(s) {
    if (s == null || isNaN(s)) return '—';
    s = Math.max(0, Math.floor(s));
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function submitSegment(vid, start, end, category, cb) {
    if (!vid || start == null || end == null || isNaN(start) || isNaN(end)) {
      cb({ ok: false, msg: 'Mark a start and end first' });
      return;
    }
    if (end <= start) {
      cb({ ok: false, msg: 'End must be after start' });
      return;
    }
    if (end - start < 0.4) {
      cb({ ok: false, msg: 'Segment too short' });
      return;
    }
    sbUserId(function (userID) {
      var body = {
        videoID: vid,
        userID: userID,
        userAgent: 'Unsynth',
        segments: [{ segment: [Number(start.toFixed(3)), Number(end.toFixed(3))], category: category || 'sponsor', actionType: 'skip' }]
      };
      sbFetch(API + '/api/skipSegments', 'POST', body).then(function (res) {
        if (res.ok || res.status === 200) {
          cb({ ok: true });
          return;
        }
        var msg =
          res.status === 409
            ? 'Already in the database'
            : res.status === 429
              ? 'Rate limited — try again shortly'
              : res.status === 403
                ? 'Rejected (duplicate or low reputation)'
                : res.status === 400
                  ? 'Invalid segment'
                  : res.text || 'Failed (' + (res.status || 0) + ')';
        cb({ ok: false, msg: msg });
      });
    });
  }

  var markStart = null;
  var markEnd = null;

  // Moved from a standalone player button into the Unsynth tools overflow
  // menu — an occasional action (most users submit a segment rarely if
  // ever), not a single-tap frequently-used control (see docs/LESSONS.md).
  function ensureSubmitButton() {
    if (!onPlayerPage()) {
      window.UNSYNTH.removeMenuItem('un-sb-submit-btn');
      return;
    }
    window.UNSYNTH.addMenuItem({
      id: 'un-sb-submit-btn',
      svg: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2 3 7v6c0 5.06 3.44 9.79 9 11 5.56-1.21 9-5.94 9-11V7l-9-5zm-1 15-4-4 1.41-1.41L11 14.17l6.59-6.59L19 9l-8 8z"/></svg>',
      label: 'Submit sponsor segment',
      onClick: toggleSubmitPanel,
      priority: 50
    });
  }

  function closeSubmitPanel() {
    var p = document.getElementById('un-sb-submit-panel');
    if (p) p.remove();
  }

  function toggleSubmitPanel() {
    if (document.getElementById('un-sb-submit-panel')) {
      closeSubmitPanel();
      return;
    }
    var player = playerHost();
    if (!player) return;
    markStart = null;
    markEnd = null;
    var panel = el('div', 'un-sb-submit-panel');
    panel.id = 'un-sb-submit-panel';

    panel.appendChild(el('div', 'un-sb-sp-title', 'Submit sponsor segment'));
    panel.appendChild(el('div', 'un-sb-sp-hint', 'Goes to the public SponsorBlock database — mark the exact start and end.'));

    var times = el('div', 'un-sb-sp-times');
    var startBtn = el('button', 'un-sb-sp-mark', 'Mark start');
    var startVal = el('span', 'un-sb-sp-val', '—');
    var endBtn = el('button', 'un-sb-sp-mark', 'Mark end');
    var endVal = el('span', 'un-sb-sp-val', '—');
    startBtn.addEventListener('click', function () {
      var v = document.querySelector('#movie_player video.html5-main-video, #movie_player video, #shorts-player video');
      if (v) {
        markStart = v.currentTime;
        startVal.textContent = fmtTime(markStart);
      }
    });
    endBtn.addEventListener('click', function () {
      var v = document.querySelector('#movie_player video.html5-main-video, #movie_player video, #shorts-player video');
      if (v) {
        markEnd = v.currentTime;
        endVal.textContent = fmtTime(markEnd);
      }
    });
    var row1 = el('div', 'un-sb-sp-row');
    row1.append(startBtn, startVal);
    var row2 = el('div', 'un-sb-sp-row');
    row2.append(endBtn, endVal);
    times.append(row1, row2);
    panel.appendChild(times);

    var cat = document.createElement('select');
    cat.className = 'un-sb-sp-cat';
    ALL_CATS().forEach(function (c) {
      // Only skip-type categories are submittable as timed segments here.
      var meta = SB() && SB().CATEGORY_MAP[c];
      if (meta && meta.action !== 'skip') return;
      var o = document.createElement('option');
      o.value = c;
      o.textContent = CAT_SHORT[c] || c;
      cat.appendChild(o);
    });
    panel.appendChild(cat);

    var status = el('div', 'un-sb-sp-status');
    panel.appendChild(status);

    var actions = el('div', 'un-sb-sp-actions');
    var submitBtn = el('button', 'un-sb-sp-submit', 'Submit');
    var cancelBtn = el('button', 'un-sb-sp-cancel', 'Cancel');
    submitBtn.addEventListener('click', function () {
      status.className = 'un-sb-sp-status';
      status.textContent = 'Submitting…';
      submitBtn.disabled = true;
      submitSegment(curVideo || videoId(), markStart, markEnd, cat.value, function (r) {
        if (r.ok) {
          status.className = 'un-sb-sp-status ok';
          status.textContent = 'Submitted — thanks! It will appear after review.';
          reloadSegments();
          setTimeout(closeSubmitPanel, 1600);
        } else {
          status.className = 'un-sb-sp-status err';
          status.textContent = r.msg || 'Failed';
          submitBtn.disabled = false;
        }
      });
    });
    cancelBtn.addEventListener('click', closeSubmitPanel);
    actions.append(submitBtn, cancelBtn);
    panel.appendChild(actions);

    player.appendChild(panel);
  }

  const mod = {
    id: 'sponsorBlock',
    moduleKey: 'sponsorBlock',
    init(c) {
      core = c;
      onStorageChanged = (changes, area) => {
        if (area === 'local' && changes[PERSONAL_KEY] && onPlayerPage()) load();
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
      load();
    },
    scan() {
      if (!onPlayerPage()) return;
      attachVideo();
      renderMarkers();
      renderChapters();
      ensureSubmitButton();
      ensureHighlightButton();
      applyChapterHiding();
      // Re-sweep for tiles YouTube appended since the last pass. dearrow.js and
      // dislike-restore.js both do this from their own scan hooks; this module
      // observed once per navigation and was the only one of the three that
      // went blind to lazily-added tiles. Cheap: observe() on an already
      // observed element is a no-op, and annotated tiles are skipped by class.
      observeRail();
    },
    onNavigate() {
      removeNotice();
      removeManualPrompt();
      load();
    },
    onSettings(s) {
      if (s) core.settings = s;
      applyChapterHiding();
      if (onPlayerPage()) load();
      else renderMarkers();
    },
    onMessage(msg, sendResponse) {
      if (!msg || !msg.type) return;
      if (msg.type === 'unsynth-sb-personal-save') {
        const vid = msg.videoId || videoId();
        const start = Number(msg.start);
        const end = Number(msg.end);
        savePersonalSegment(vid, start, end, msg.category).then((ok) => sendResponse({ ok }));
        return true;
      }
      if (msg.type === 'unsynth-sb-personal-recent') {
        const vid = msg.videoId || videoId();
        const v = document.querySelector('#movie_player video.html5-main-video, #movie_player video, #shorts-player video');
        if (!v || !vid) {
          sendResponse({ ok: false });
          return true;
        }
        const span = Math.max(5, Number(msg.seconds) || 30);
        const end = v.currentTime;
        savePersonalSegment(vid, end - span, end, msg.category || 'sponsor').then((ok) => sendResponse({ ok }));
        return true;
      }
    },
    teardown() {
      clearTimeout(showNotice._t);
      clearTimeout(renderFullLabel._t);
      removeNotice();
      removeMarkers();
      removeChapters();
      removeChapterTitle();
      removeManualPrompt();
      removeFullLabel();
      closeSubmitPanel();
      window.UNSYNTH.removeMenuItem('un-sb-submit-btn');
      window.UNSYNTH.removePlayerButton('un-sb-poi-btn');
      teardownRail();
      if (chapterStyleEl) { chapterStyleEl.remove(); chapterStyleEl = null; }
      detachVideo();
      if (onStorageChanged) {
        try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) {}
        onStorageChanged = null;
      }
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
