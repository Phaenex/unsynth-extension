/**
 * DeArrow — crowd-sourced neutral titles + thumbnails from the DeArrow
 * community database (same backend/team as SponsorBlock: sponsor.ajay.app).
 * Confirmed live this session: GET
 * https://sponsor.ajay.app/api/branding?videoID=<id>&service=YouTube returns
 * { titles: [{title, original, votes, locked, UUID}],
 *   thumbnails: [{timestamp, original, votes, locked, UUID}] }.
 * Selection rule per the real API, same for both lists: prefer a locked
 * entry, else the highest-voted entry with votes >= 0; if nothing qualifies
 * (or the winning thumbnail entry is `original: true`, meaning "YouTube's
 * own is already the best pick"), the element is left untouched.
 *
 * Thumbnail images are rendered by a second, dedicated service — confirmed
 * live: GET https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=<id>&time=<timestamp>
 * returns a real image (webp), no auth needed. Setting a tile's <img src>
 * directly to that cross-origin URL was confirmed live to load with no CSP
 * block (content scripts don't need a host_permissions entry for a plain
 * <img> load — that's only required for fetch()/XHR).
 *
 * Reuses title-cleaner.js's exact anti-fight-loop pattern (WeakMap-tracked,
 * hard MAX_TRIES cap that never resets) since overwriting a Polymer-bound
 * title element causes YouTube to "restore" it, which looks like a fresh
 * mutation and would otherwise re-trigger forever. Only ever mutates
 * `textContent`/`src` on an element that already exists — no sibling
 * insertion near YouTube-managed containers (see docs/LESSONS.md).
 */
(function () {
  'use strict';

  const API = 'https://sponsor.ajay.app';
  const THUMB_API = 'https://dearrow-thumb.ajay.app';
  let core = null;
  function ytDom() {
    return (typeof window !== 'undefined' && window.UNYtDom) || null;
  }
  function tileSelectors() {
    var YT = ytDom();
    return YT ? YT.feedTileSelector() : '';
  }
  function titleSelectors() {
    var YT = ytDom();
    return YT ? YT.DEARROW_TITLE_SEL : '#video-title';
  }

  // Shared feed tiles include 'yt-lockup-view-model' (home feed/channel
  // grid/shelf tiles). Confirmed LIVE (2026-08-24) against real YouTube DOM:
  // its title lives at 'h3 a.ytLockupMetadataViewModelTitle' — a camelCase,
  // no-hyphen class name, NOT the hyphenated
  // '.yt-lockup-metadata-view-model-wiz__title' BEM-style name that was
  // guessed here previously (that class does not exist on today's markup at
  // all — confirmed 0 matches live). The real fix is the generic 'h3 a'
  // fallback (verified live: matches all 20/20 tiles on a real home feed,
  // same pattern src/shared/yt-dom.js's TITLE_SEL already relies on), with
  // the specific class kept as a documented, verified primary.
  function prefs() {
    const d = (core && core.settings && core.settings.deArrow) || {};
    return { titles: d.titles !== false, thumbnails: d.thumbnails !== false };
  }

  function isWatch() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }
  function watchVideoId() {
    return window.UNSYNTH && window.UNSYNTH.videoId ? window.UNSYNTH.videoId() : null;
  }
  function tileVideoId(tile) {
    const links = tile.querySelectorAll('a[href*="/watch"], a[href*="v="], a[href*="/shorts/"]');
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute('href') || '';
      const m = href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
      if (m) return m[1];
    }
    return null;
  }

  // Content scripts can't fetch sponsor.ajay.app directly (CORS drops on
  // error responses) — proxy through the service worker, same as
  // sponsorblock.js's sbFetch.
  function branding(vid) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'UNSYNTH/PROXY/FETCH', url: API + '/api/branding?videoID=' + encodeURIComponent(vid) + '&service=YouTube' },
          (res) => {
            if (chrome.runtime.lastError || !res || !res.ok || !res.data) {
              resolve(null);
              return;
            }
            resolve(res.data);
          }
        );
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Confirmed selection rule (filterAndSortBranding in SponsorBlockServer):
  // locked wins outright; otherwise highest-voted with votes >= 0.
  //
  // A winner flagged `original: true` is YouTube’s OWN title, which the
  // database carries so people can vote that the original needs no replacing.
  // Writing it back is worse than doing nothing — the module exists to replace
  // clickbait and would instead re-assert it, discarding any real submission
  // underneath. pickThumbnailTime below has always rejected `original`, and the
  // header documents the rule as "same for both lists"; this half of it was
  // simply never implemented. Observed live on videoID pzBi1nwDn8U, where
  // YouTube’s own title (2 votes) outranked the community one (1 vote) and won.
  function pickTitle(data) {
    const titles = (data && data.titles) || [];
    if (!titles.length) return null;
    const locked = titles.find((t) => t.locked);
    const winner = locked ||
      titles.filter((t) => (t.votes || 0) >= 0).sort((a, b) => (b.votes || 0) - (a.votes || 0))[0];
    if (!winner || winner.original) return null;
    return winner.title;
  }

  // Same rule, applied to the thumbnails list. A winning entry with
  // `original: true` means "YouTube's own thumbnail is already the best
  // pick" — leave the tile alone. `timestamp` is the frame (seconds) the
  // render service should extract.
  function pickThumbnailTime(data) {
    const list = (data && data.thumbnails) || [];
    if (!list.length) return null;
    const locked = list.find((t) => t.locked);
    const winner = locked || list.filter((t) => (t.votes || 0) >= 0).sort((a, b) => (b.votes || 0) - (a.votes || 0))[0];
    if (!winner || winner.original || typeof winner.timestamp !== 'number') return null;
    return winner.timestamp;
  }

  function thumbnailUrl(vid, time) {
    return THUMB_API + '/api/v1/getThumbnail?videoID=' + encodeURIComponent(vid) + '&time=' + encodeURIComponent(time);
  }

  const cache = Object.create(null); // vid -> {title, thumbTime} (thumbTime may be null)
  // vid -> array of pending `apply` callbacks waiting on an in-flight fetch.
  // A plain Set (vid seen vs not) would silently drop every caller after the
  // first for the same in-flight vid — a real bug found while adding the
  // thumbnail consumer, since it now fires an enqueue() for the same vid
  // moments after the title consumer does (see docs/LESSONS.md).
  const pending = new Map();
  let fetchQueue = [];
  let fetchActive = 0;
  const MAX_CONCURRENT = 3;

  function enqueue(vid, apply) {
    if (!vid) return;
    if (cache[vid] !== undefined) {
      apply(cache[vid]);
      return;
    }
    if (pending.has(vid)) {
      pending.get(vid).push(apply);
      return;
    }
    pending.set(vid, [apply]);
    fetchQueue.push(vid);
    drain();
  }
  function drain() {
    while (fetchActive < MAX_CONCURRENT && fetchQueue.length) {
      const vid = fetchQueue.shift();
      fetchActive++;
      branding(vid)
        .then((data) => {
          const resolved = { title: pickTitle(data), thumbTime: pickThumbnailTime(data) };
          cache[vid] = resolved; // cache the miss too — don't refetch every scan
          const keys = Object.keys(cache);
          if (keys.length > 300) keys.slice(0, keys.length - 300).forEach((k) => delete cache[k]);
          const cbs = pending.get(vid) || [];
          pending.delete(vid);
          cbs.forEach((cb) => cb(resolved));
        })
        .finally(() => {
          fetchActive--;
          drain();
        });
    }
  }

  // Same shape as title-cleaner.js: a hard per-element write cap that never
  // resets, so a Polymer "restore" of the original text can't start an
  // infinite fight.
  const state = new WeakMap(); // el -> { tries }
  const MAX_TRIES = 3;

  function applyTitle(el, title) {
    if (!title) return;
    let st = state.get(el);
    if (!st) {
      st = { tries: 0 };
      state.set(el, st);
    }
    if (st.tries >= MAX_TRIES) return;
    if (el.textContent === title) return;
    st.tries++;
    el.textContent = title;
    el.title = title;
  }

  const thumbState = new WeakMap(); // img -> { tries }
  function applyThumbnail(img, url) {
    if (!url) return;
    let st = thumbState.get(img);
    if (!st) {
      st = { tries: 0 };
      thumbState.set(img, st);
    }
    if (st.tries >= MAX_TRIES) return;
    if (img.src === url) return;
    st.tries++;
    img.src = url;
  }

  let io = null;
  function ensureObserver() {
    if (io) return;
    io = new IntersectionObserver(
      (entries) => {
        entries.forEach((ent) => {
          if (!ent.isIntersecting) return;
          processTitleElement(ent.target);
        });
      },
      { root: null, rootMargin: '150px', threshold: 0.05 }
    );
  }

  let thumbIo = null;
  function ensureThumbObserver() {
    if (thumbIo) return;
    thumbIo = new IntersectionObserver(
      (entries) => {
        entries.forEach((ent) => {
          if (!ent.isIntersecting) return;
          processThumbTile(ent.target);
        });
      },
      { root: null, rootMargin: '150px', threshold: 0.05 }
    );
  }

  function findTileFor(titleEl) {
    const sel = tileSelectors();
    return sel ? titleEl.closest(sel) : null;
  }

  // A tile can be recycled by YouTube's virtualized feed for a DIFFERENT
  // video while a branding() fetch for the OLD video is still in flight (the
  // enqueue callback closes over the element, not the video id). Without
  // re-checking identity at write time, a late-arriving stale response paints
  // the old video's title/thumbnail onto a tile whose <a href> now points at
  // a different video — the user sees title A, clicks, and video B loads.
  function processTitleElement(el) {
    const tile = findTileFor(el);
    const vid = tile ? tileVideoId(tile) : watchVideoId();
    if (!vid) return;
    enqueue(vid, (resolved) => {
      const stillTile = findTileFor(el);
      const stillVid = stillTile ? tileVideoId(stillTile) : watchVideoId();
      if (stillVid !== vid) return;
      applyTitle(el, resolved.title);
    });
  }

  function processThumbTile(tile) {
    const vid = tileVideoId(tile);
    const img = tile.querySelector('img');
    if (!vid || !img) return;
    enqueue(vid, (resolved) => {
      if (tileVideoId(tile) !== vid) return;
      applyThumbnail(img, resolved.thumbTime != null ? thumbnailUrl(vid, resolved.thumbTime) : null);
    });
  }

  function scanFeedTitles() {
    document.querySelectorAll(titleSelectors()).forEach((el) => {
      if (findTileFor(el)) io.observe(el);
    });
  }

  function scanFeedThumbs() {
    document.querySelectorAll(tileSelectors()).forEach((tile) => thumbIo.observe(tile));
  }

  function processWatchTitle() {
    const vid = watchVideoId();
    if (!vid) return;
    var YT = ytDom();
    const els = document.querySelectorAll(YT ? YT.WATCH_TITLE_STRING_SEL : 'h1');
    if (!els.length) return;
    enqueue(vid, (resolved) => {
      // A SPA navigation to a different video can complete while this fetch
      // is still in flight — same tile-identity race as the feed tiles above,
      // just keyed on the URL instead of a recycled DOM node.
      if (watchVideoId() !== vid) return;
      els.forEach((el) => applyTitle(el, resolved.title));
    });
  }

  function processAll() {
    const p = prefs();
    if (p.titles) {
      ensureObserver();
      scanFeedTitles();
      if (isWatch()) processWatchTitle();
    }
    if (p.thumbnails) {
      ensureThumbObserver();
      scanFeedThumbs();
    }
  }

  const mod = {
    id: 'deArrow',
    moduleKey: 'deArrow',
    init: function (c) {
      core = c;
      processAll();
    },
    scan: function () {
      processAll();
    },
    onNavigate: function () {
      processAll();
    },
    onSettings: function (s) {
      core.settings = s;
      processAll();
    },
    teardown: function () {
      if (io) {
        io.disconnect();
        io = null;
      }
      if (thumbIo) {
        thumbIo.disconnect();
        thumbIo = null;
      }
      fetchQueue = [];
      pending.clear();
      fetchActive = 0;
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pickTitle, pickThumbnailTime, thumbnailUrl, titleSelectors, tileSelectors };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
