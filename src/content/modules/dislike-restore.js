/**
 * Video stats on YouTube — likes, dislikes, ratio (and views) on the watch page
 * and on feed/related tiles. Vote data from Return YouTube Dislike API.
 */
(function () {
  'use strict';

  const M_RYD = 'UNSYNTH/RYD/VOTES';
  const FMT = window.UNRyd ? UNRyd.fmt : (n) => String(n);
  const RATIO = window.UNRyd ? UNRyd.likeRatio : () => null;
  // One label for every surface, and it cannot say 100% over a dislike count.
  const RATIO_LABEL = window.UNRyd && UNRyd.ratioLabel ? UNRyd.ratioLabel : (l, d, n) => { const r = RATIO(l, d); return r == null ? null : r.toFixed(n || 0) + '%'; };

  const YT = window.UNYtDom || null;
  function tileSel() {
    return YT ? YT.feedTileSelector() : '';
  }

  let core = null;
  let lastVid = null;
  let lastVotes = null;
  let pendingWatch = false;
  let pageViews = null;
  let pagePublished = '';
  const feedCache = Object.create(null);
  const queued = new Set();
  let fetchQueue = [];
  let fetchActive = 0;
  const MAX_CONCURRENT = 3;
  let io = null;
  let watchBtnObs = null;
  let watchBtnObsBroad = false;
  let watchBtnTimer = null;

  function prefs() {
    const d = (core && core.settings && core.settings.dislikeRestore) || {};
    return {
      feedTiles: d.feedTiles !== false,
      watchMetaRow: d.watchMetaRow !== false,
      watchButtons: d.watchButtons !== false,
      showRatio: d.showRatio !== false,
      showViews: d.showViews !== false,
      showDate: d.showDate !== false,
      // Where the stats panel mounts on a watch page:
      //   'wide'         - full content column, above the whole title block
      //   'aboveChannel' - inside #owner, directly above the avatar row
      //   'belowChannel' - after the Like/Share row (the original position)
      statsPosition: d.statsPosition || 'wide',
      // 'card' keeps the bordered surface; 'plain' drops it to sit closer to
      // native YouTube.
      statsStyle: d.statsStyle || 'card'
    };
  }

  function isWatch() {
    return (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.startsWith('/shorts/');
  }

  function videoId() {
    const m = location.search.match(/[?&]v=([\w-]{11})/);
    if (m) return m[1];
    const sm = location.pathname.match(/\/shorts\/(\w[\w-]{10})/);
    if (sm) return sm[1];
    // /@channel/live has no ?v=; the id is on the watch element. Without this
    // the Stats row never built there (found in the owner's browser, 2026-09-23).
    return (window.UNYtDom && window.UNYtDom.liveChannelVideoId ? window.UNYtDom.liveChannelVideoId() : '') || null;
  }

  function send(type, extra) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}), function (r) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // The same bridge reply already carries publishDate, so the stats row can
  // show the upload date without a second round trip. Returns the whole shape
  // now; callers that only wanted views read .viewCount.
  function requestPageStats() {
    return new Promise(function (resolve) {
      const reqId = 'uv' + Date.now();
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.type !== 'UN_STATS' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve({
          viewCount: Number(e.data.viewCount) || null,
          publishDate: e.data.publishDate || ''
        });
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'UN_STATS_REQ', reqId: reqId }, '*');
      setTimeout(function () {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 2500);
    });
  }

  function requestPageViews() {
    return requestPageStats().then(function (s) {
      return s ? s.viewCount : null;
    });
  }

  /** "Jun 11, 2023 · 3.3y ago" for the stats row, or '' when unknown. */
  function publishedBit() {
    if (!pagePublished) return '';
    const t = Date.parse(pagePublished);
    if (isNaN(t)) return '';
    const exact = new Date(t).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const age = window.UNRyd && UNRyd.relativeAge ? UNRyd.relativeAge(t) : '';
    const label = age ? exact + ' · ' + age : exact;
    return (
      '<span class="un-vs-date" title="Published ' +
      new Date(t).toLocaleString().replace(/"/g, '&quot;') +
      '">' +
      label.replace(/&/g, '&amp;').replace(/</g, '&lt;') +
      '</span>'
    );
  }

  function findActionRow() {
    const selectors = YT && YT.WATCH_LIKE_ACTION_ROW_SEL
      ? YT.WATCH_LIKE_ACTION_ROW_SEL.split(/\s*,\s*/)
      : ['#top-level-buttons-computed'];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function findSegmented(row) {
    if (row) {
      const scoped =
        row.querySelector('segmented-like-dislike-button-view-model') ||
        row.querySelector(YT ? YT.SEGMENTED_LIKE_SEL : 'segmented-like-dislike-button-view-model');
      if (scoped) return scoped;
    }
    return (
      document.querySelector('segmented-like-dislike-button-view-model') ||
      document.querySelector(YT ? YT.SEGMENTED_LIKE_SEL : 'segmented-like-dislike-button-view-model')
    );
  }

  function findLikeHost(row) {
    const seg = findSegmented(row);
    if (seg) {
      const host =
        seg.querySelector('like-button-view-model') ||
        seg.querySelector('#segmented-like-button');
      if (host) return host;
    }
    if (row) {
      const scoped = row.querySelector('like-button-view-model');
      if (scoped) return scoped;
    }
    return document.querySelector('like-button-view-model') || document.querySelector('#segmented-like-button');
  }

  function findDislikeHost(row) {
    const seg = findSegmented(row);
    if (seg) {
      const host =
        seg.querySelector('dislike-button-view-model') ||
        seg.querySelector('#segmented-dislike-button');
      if (host) return host;
    }
    if (row) {
      const scoped = row.querySelector('dislike-button-view-model');
      if (scoped) return scoped;
    }
    return document.querySelector('dislike-button-view-model') || document.querySelector('#segmented-dislike-button');
  }

  function findButtonInHost(host) {
    if (!host) return null;
    if (host.tagName === 'BUTTON') return host;
    return (
      host.querySelector('button.yt-spec-button-shape-next') ||
      host.querySelector('yt-button-shape button') ||
      host.querySelector('button') ||
      host.querySelector('tp-yt-paper-button')
    );
  }

  function ariaLikeButton(root) {
    if (!root) return null;
    const buttons = root.querySelectorAll('button[aria-label]');
    for (let i = 0; i < buttons.length; i++) {
      const label = (buttons[i].getAttribute('aria-label') || '').toLowerCase();
      if (label.indexOf('dislike') !== -1) continue;
      if (label.indexOf('like') !== -1) return buttons[i];
    }
    return null;
  }

  function ariaDislikeButton(root) {
    if (!root) return null;
    const buttons = root.querySelectorAll('button[aria-label]');
    for (let i = 0; i < buttons.length; i++) {
      const label = (buttons[i].getAttribute('aria-label') || '').toLowerCase();
      if (label.indexOf('dislike') !== -1) return buttons[i];
    }
    return null;
  }

  function findLikeButton(row) {
    const btn = findButtonInHost(findLikeHost(row));
    if (btn) return btn;
    if (row) {
      const fb = ariaLikeButton(row);
      if (fb) return fb;
    }
    return ariaLikeButton(document) || document.querySelector(YT ? YT.TOGGLE_LIKE_BTN_SEL : 'button[aria-label*="like" i]');
  }

  function findDislikeButton(row) {
    const btn = findButtonInHost(findDislikeHost(row));
    if (btn) return btn;
    if (row) {
      const fb = ariaDislikeButton(row);
      if (fb) return fb;
    }
    return ariaDislikeButton(document) || document.querySelector(YT ? YT.TOGGLE_DISLIKE_BTN_SEL : 'button[aria-label*="dislike" i]');
  }

  function findNativeLikeSlot(btn) {
    if (!btn) return null;
    const sels = '#text, span[role="text"], yt-formatted-string, .yt-spec-button-shape-next__text, .button-renderer-text';
    const nodes = btn.querySelectorAll(sels);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.classList.contains('un-ryd-count')) continue;
      return el;
    }
    return null;
  }

  function clearInjectedLikeCounts(btn) {
    if (!btn) return;
    btn.querySelectorAll('.un-ryd-count').forEach(function (n) {
      n.remove();
    });
    btn.classList.remove('un-ryd-has-count');
  }

  function setLikeCount(btn, count) {
    if (!btn || count == null) return;
    const n = FMT(count);
    btn.setAttribute('aria-label', n + ' likes');
    clearInjectedLikeCounts(btn);
    const slot = findNativeLikeSlot(btn);
    if (slot) {
      slot.textContent = n;
      slot.removeAttribute('is-empty');
      slot.hidden = false;
    }
  }

  function ensureDislikeCountSlot(btn, host) {
    let slot = btn.querySelector('.un-ryd-count');
    if (!slot) {
      slot = document.createElement('span');
      slot.className = 'un-ryd-count';
      btn.appendChild(slot);
    }
    btn.classList.add('un-ryd-has-count');
    if (host) host.classList.add('un-ryd-has-count');
    slot.removeAttribute('is-empty');
    slot.hidden = false;
    return slot;
  }

  function setDislikeCount(btn, count, host) {
    if (!btn || count == null) return;
    const n = FMT(count);
    btn.setAttribute('aria-label', n + ' dislikes');
    btn.querySelectorAll('.un-ryd-count').forEach(function (node) {
      node.remove();
    });
    btn.classList.remove('un-ryd-has-count');
    if (host) host.classList.remove('un-ryd-has-count');
    const slot = findNativeLikeSlot(btn);
    if (slot) {
      slot.textContent = n;
      slot.removeAttribute('is-empty');
      slot.hidden = false;
      btn.classList.add('un-ryd-has-count');
      if (host) host.classList.add('un-ryd-has-count');
      return;
    }
    ensureDislikeCountSlot(btn, host).textContent = n;
  }

  function applyWatchButtons(votes) {
    const row = findActionRow();
    if (!row) return false;
    const seg = findSegmented(row);
    const dislikeHost = findDislikeHost(row);
    const likeBtn = findLikeButton(row);
    const dislikeBtn = findDislikeButton(row);
    if (!likeBtn && !dislikeBtn) return false;
    setLikeCount(likeBtn, votes.likes);
    setDislikeCount(dislikeBtn, votes.dislikes, dislikeHost);
    if (seg) {
      if (prefs().showRatio) {
        const ratio = RATIO(votes.likes, votes.dislikes);
        if (ratio != null) {
          seg.setAttribute('data-un-ryd-ratio', ratio.toFixed(1));
          seg.title = RATIO_LABEL(votes.likes, votes.dislikes, 1) + ' liked · Return YouTube Dislike';
        } else {
          seg.removeAttribute('data-un-ryd-ratio');
          seg.removeAttribute('title');
        }
      } else {
        seg.removeAttribute('data-un-ryd-ratio');
        seg.removeAttribute('title');
      }
      seg.classList.add('un-ryd-segmented');
    }
    return true;
  }

  function narrowWatchTargets() {
    return [
      document.querySelector('#above-the-fold'),
      document.querySelector('#actions'),
      document.querySelector('#actions-inner'),
      document.querySelector(YT ? YT.WATCH_METADATA_SEL : '#above-the-fold')
    ].filter(Boolean);
  }

  function scheduleWatchButtons() {
    if (!isWatch() || !prefs().watchButtons) return;
    if (watchBtnTimer) clearTimeout(watchBtnTimer);
    watchBtnTimer = setTimeout(function () {
      watchBtnTimer = null;
      if (lastVotes && lastVotes.ok) applyWatchButtons(lastVotes);
      else refreshWatch();
      // If we fell back to observing the whole document, re-scope to the action
      // bar now that it exists so we stop reacting to every page-wide mutation.
      if (watchBtnObsBroad && narrowWatchTargets().length) {
        stopWatchButtonObserver();
        ensureWatchButtonObserver();
      }
    }, 150);
  }

  function ensureWatchButtonObserver() {
    if (watchBtnObs) return;
    if (!prefs().watchButtons) return;
    watchBtnObs = new MutationObserver(scheduleWatchButtons);
    const targets = narrowWatchTargets();
    if (!targets.length) {
      watchBtnObsBroad = true;
      watchBtnObs.observe(document.documentElement, { childList: true, subtree: true });
      return;
    }
    watchBtnObsBroad = false;
    targets.forEach(function (t) {
      watchBtnObs.observe(t, { childList: true, subtree: true });
    });
  }

  function stopWatchButtonObserver() {
    if (watchBtnTimer) {
      clearTimeout(watchBtnTimer);
      watchBtnTimer = null;
    }
    if (watchBtnObs) {
      watchBtnObs.disconnect();
      watchBtnObs = null;
    }
  }

  function watchStatsAnchor() {
    const selectors = YT && YT.WATCH_STATS_ANCHOR_SEL
      ? YT.WATCH_STATS_ANCHOR_SEL.split(/\s*,\s*/)
      : ['#actions'];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function statsSummaryHtml(votes, views) {
    const p = prefs();
    const bits = [];
    // LIKES LEAD ONLY WHEN THE RATIO CANNOT.
    //
    // YouTube's own like button shows this number about eighty pixels above,
    // so leading with it spends the first slot of our strip on a duplicate.
    // The deck's collapsed summary already reached this conclusion and says so:
    // "This used to lead with the like count ... Repeating the host costs a row
    // and adds nothing; the dislike count and the ratio are the restored data."
    //
    // But the like count is not useless here: seeing it BESIDE dislikes is what
    // makes the ratio legible, which is the same reason the analytics grid
    // keeps host duplicates in a trailing position rather than deleting them.
    // So dislikes lead, and likes follow as the denominator that gives them
    // scale.
    if (votes.dislikes != null) bits.push('<span class="un-vs-dislikes">' + FMT(votes.dislikes) + ' dislikes</span>');
    if (votes.likes != null) bits.push('<span class="un-vs-likes">' + FMT(votes.likes) + ' likes</span>');
    if (p.showRatio) {
      const ratio = RATIO(votes.likes, votes.dislikes);
      if (ratio != null) bits.push('<span class="un-vs-ratio">' + RATIO_LABEL(votes.likes, votes.dislikes, 1) + ' liked</span>');
    }
    const vc = views != null ? views : votes.viewCount;
    if (p.showViews && vc) bits.push('<span class="un-vs-views">' + FMT(vc) + ' views</span>');
    // THE DATE MOVED UNDER THE CHANNEL NAME, SO IT DOES NOT ALSO LIVE HERE.
    //
    // Requested: the publication date should sit under the channel name and be
    // easier to find. It now mounts into the owner row's #upload-info as
    // .un-deck-published — verified live at x=93,y=734 inside the owner box.
    //
    // This bit was left behind, so the same fact printed twice: "Published Oct
    // 5, 2017" under the channel AND "Oct 5, 2017 · 9y ago" a hundred pixels
    // right, in the stats line. Whichever a reader found first, the other was
    // noise.
    //
    // Only emitted when the deck placement is NOT available — the 'belowChannel'
    // and 'aboveChannel' stats positions do not mount the owner-row date, and
    // dropping it unconditionally would delete the date for those users.
    // No date in the stats line for any position any more: it lives under the
    // channel name (syncOwnerDate). In the 'aboveChannel' layout this bit
    // rendered as a loose "Published Jun 28, 2024" line between the Stats and
    // Fact check slots — an orphan, reported from a real profile 2026-09-21.
    if (!bits.length) return '';
    return bits.join('<span class="un-vs-sep" aria-hidden="true">·</span>');
  }

  /**
   * Where the stats row mounts.
   *
   * Preferred: immediately BEFORE the channel row (ytd-video-owner-renderer),
   * which puts it directly under the title — asked for as "above Smosh Games".
   * It used to go after #actions, the Like/Share row, which is what pushed it
   * below the channel and made it easy to miss.
   *
   * Falls back to the old anchor when the owner renderer is absent (Shorts and
   * the reel overlay have no such element), so no surface loses the row.
   */
  function watchStatsMount() {
    // The shared deck owns placement when it can be built: fact-check, the
    // description digest and this strip used to mount three separate cards
    // with three borders, which is what made the page look like a stack of
    // unrelated panels. Inside the deck they are slots separated by hairlines.
    // Only the 'wide' position uses it — the other two are explicit requests
    // for a different spot, so they keep their own anchors.
    if (prefs().statsPosition !== 'belowChannel' && window.UNWatchDeck) {
      const s = window.UNWatchDeck.slot('stats');
      if (s) {
        // Every other slot owner syncs after mounting. This one did not, so the
        // header shipped with no aria-expanded and the slot rendered open until
        // some unrelated module happened to fire a sync and slam it shut.
        if (window.UNWatchDeck.syncEmpty) window.UNWatchDeck.syncEmpty();
        if (window.UNWatchDeck.syncCollapse) window.UNWatchDeck.syncCollapse();
        if (window.UNWatchDeck.setSummary) {
          // REPORT WHAT YOUTUBE DOES NOT.
          //
          // This used to lead with the like count — "561K · 99%" — while
          // YouTube's own like button shows 561K about eighty pixels below.
          // Repeating the host costs a row and adds nothing; the dislike count
          // and the ratio are the restored data, and the only reason this slot
          // exists.
          //
          // The arrow prefixes carry the meaning alongside colour, so the
          // numbers are still distinguishable without it.
          var v = lastVotes;
          var r = v && v.likes != null && v.dislikes != null ? RATIO(v.likes, v.dislikes) : null;
          var bits = [];
          // NOT a triangle. The deck draws a down-pointing triangle as its
          // disclosure caret, on the same row, a few hundred pixels right — so
          // a ▼ here put two down-triangles with different meanings side by
          // side. An independent reviewer read the glyph as ambiguous between
          // "dislike" and "collapse". The word carries the meaning without
          // competing with the control.
          // 2026-09-22: no dislike count here either. The restored dislike
          // button already prints it ("5K") on the same screen — this row
          // read "5K dislikes" 120px below it. The ratio and the daily rate
          // are the two figures nothing else on the page states.
          if (r != null) bits.push(RATIO_LABEL(v.likes, v.dislikes, 1) + ' liked');
          var views = pageViews != null ? pageViews : (v && v.viewCount);
          var pub = Date.parse(pagePublished);
          if (views && Number.isFinite(pub)) {
            var days = Math.max(1, (Date.now() - pub) / 86400000);
            bits.push(FMT(Math.round(views / days)) + ' views a day');
          }
          if (!bits.length && v && v.dislikes != null) bits.push(FMT(v.dislikes) + ' dislikes');
          window.UNWatchDeck.setSummary('stats', bits.join(' · '));
        }
        return { el: s, where: 'append' };
      }
    }

    // No literal fallbacks: yt-dom.js is the single source for renderer names
    // and the selector budget counts a duplicate here as drift.
    const pos = prefs().statsPosition;

    // 'wide' — before #top-row, inside #above-the-fold. #owner and #top-row are
    // the elements that constrain the panel's width on some layouts, so this is
    // the only placement guaranteed to span the full content column.
    if (pos !== 'belowChannel') {
      const topSel = YT && YT.WATCH_TOP_ROW_SEL;
      const topRow = topSel ? document.querySelector(topSel) : null;
      if (topRow && topRow.parentElement) return { el: topRow, where: 'beforebegin' };
    }

    // 'aboveChannel' — inside #owner, directly above the avatar row.
    if (pos !== 'belowChannel') {
      const ownerSel = YT && YT.WATCH_OWNER_RENDERER_SEL;
      const owner = ownerSel ? document.querySelector(ownerSel) : null;
      if (owner && owner.parentElement) return { el: owner, where: 'beforebegin' };
    }

    // 'belowChannel' — the original spot, after the Like/Share row. Also the
    // fallback everywhere else, including Shorts, which has no owner renderer.
    const anchor = watchStatsAnchor();
    return anchor ? { el: anchor, where: 'afterend' } : null;
  }

  /** Density/chrome variants, driven by the statsStyle pref. */
  function applyStatsStyle(row) {
    if (!row) return;
    row.classList.toggle('un-vs-plain', prefs().statsStyle === 'plain');
  }

  /** insertAdjacentElement has no 'append' position; the deck slot wants one. */
  function placeAt(mount, node) {
    if (mount.where === 'append') {
      if (node.parentElement !== mount.el) mount.el.appendChild(node);
      return;
    }
    mount.el.insertAdjacentElement(mount.where, node);
  }

  function ensureWatchMetaRow() {
    const mount = watchStatsMount();
    let row = document.getElementById('un-vid-stats');
    if (row && mount && !mount.el.contains(row)) {
      const placed =
        mount.where === 'append'
          ? row.parentElement === mount.el
          : mount.where === 'beforebegin'
            ? mount.el.previousElementSibling === row
            : mount.el.nextElementSibling === row;
      if (!placed) placeAt(mount, row);
    }
    if (row) {
      applyStatsStyle(row);
      return row;
    }
    if (!mount) return null;
    row = document.createElement('div');
    row.id = 'un-vid-stats';
    row.className = 'un-vid-stats';
    applyStatsStyle(row);
    row.setAttribute('role', 'region');
    row.setAttribute('aria-label', 'Video stats from Unsynth');
    placeAt(mount, row);
    return row;
  }

  function ratioBarMarkup(votes) {
    if (!prefs().showRatio) return '';
    const ratio = RATIO(votes.likes, votes.dislikes);
    if (ratio == null) return '';
    const pct = Math.max(0, Math.min(100, ratio));
    return (
      '<div class="un-ryd-ratio-bar" role="meter" aria-label="Like/dislike ratio" aria-valuenow="' +
      pct.toFixed(1) +
      '" aria-valuemin="0" aria-valuemax="100" aria-valuetext="' +
      RATIO_LABEL(votes.likes, votes.dislikes, 1) +
      ' of viewers liked this video" title="' +
      RATIO_LABEL(votes.likes, votes.dislikes, 1) +
      ' liked (Return YouTube Dislike)"><span class="un-ryd-ratio-fill" style="width:' +
      pct +
      '%"></span></div>'
    );
  }

  /**
   * The publication date, under the channel name, for EVERY stats position.
   *
   * It used to mount only from inside the 'wide' deck path, and the other two
   * positions printed it into the stats line instead — which is how a real
   * profile ended up with "Published Jun 28, 2024" floating between the Stats
   * and Fact check slots. One fact, one place, whatever else is configured.
   */
  function syncOwnerDate() {
    // Keep the publication date visible while detailed audience stats are closed.
    var owner = YT && document.querySelector(YT.WATCH_OWNER_RENDERER_SEL);
    var channelInfo = owner && owner.querySelector('#upload-info');
    var date = document.querySelector('.un-deck-published');
    var publishedTime = Date.parse(pagePublished);
    if (channelInfo && prefs().showDate && Number.isFinite(publishedTime)) {
      if (!date) {
        date = document.createElement('time');
        date.className = 'un-deck-published';
        channelInfo.appendChild(date);
      }
      date.dateTime = new Date(publishedTime).toISOString();
      date.title = 'Published ' + new Date(publishedTime).toLocaleString();
      // One date, one place. "Published Oct 5, 2017 · 9y ago" here; the
      // separate chip under the title (analytics.js) printed the same
      // date a second time 60px away and the stats grid a third. The
      // relative age was the only thing the chip added, so it moves here.
      var exact = new Date(publishedTime).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric'
      });
      // The exact date only. YouTube prints the relative age ("8y ago") on the
      // line under the title; repeating it here added nothing but a second,
      // differently-rounded figure for the same fact (DESIGN-STANDARD rule B).
      // The relative age stays in the tooltip for anyone hovering the date.
      var age = window.UNRyd && UNRyd.relativeAge ? UNRyd.relativeAge(publishedTime) : '';
      date.textContent = 'Published ' + exact;
      if (age) date.title = 'Published ' + new Date(publishedTime).toLocaleString() + ' (' + age + ')';
    } else if (date) {
      date.remove();
    }
  }

  function applyWatchUI(votes, views) {
    syncOwnerDate();
    if (!votes || !votes.ok) return;
    const p = prefs();

    if (p.watchButtons) {
      applyWatchButtons(votes);
      ensureWatchButtonObserver();
    }

    if (p.watchMetaRow) {
      const meta = ensureWatchMetaRow();
      if (meta) {
        const summaryHtml = statsSummaryHtml(votes, views);
        const barHtml = ratioBarMarkup(votes);
        const hasData = !!summaryHtml || !!barHtml;

        let main = meta.querySelector('.un-vid-stats-main');
        if (!main) {
          meta.querySelectorAll('.un-vid-stats-chips, .un-ryd-ratio-bar, .un-vid-stats-tools').forEach(function (n) {
            n.remove();
          });
          main = document.createElement('div');
          main.className = 'un-vid-stats-main';
          meta.appendChild(main);
        }

        let body = main.querySelector('.un-vid-stats-body');
        if (!body) {
          body = document.createElement('div');
          body.className = 'un-vid-stats-body';
          main.insertBefore(body, main.firstChild);
        }

        let bar = body.querySelector('.un-ryd-ratio-bar');
        if (barHtml) {
          if (bar) bar.outerHTML = barHtml;
          else body.insertAdjacentHTML('afterbegin', barHtml);
        } else if (bar) bar.remove();

        let summary = body.querySelector('.un-vid-stats-summary');
        if (summaryHtml) {
          if (summary) summary.innerHTML = summaryHtml;
          else {
            summary = document.createElement('div');
            summary.className = 'un-vid-stats-summary';
            summary.innerHTML = summaryHtml;
            body.appendChild(summary);
          }
        } else if (summary) summary.remove();

        if (!meta.querySelector('.un-vid-stats-panel')) {
          const panel = document.createElement('div');
          panel.className = 'un-vid-stats-panel';
          panel.hidden = true;
          meta.appendChild(panel);
        }

        meta.classList.toggle('on', hasData);
        if (window.UNStatsCompareUI && hasData) {
          UNStatsCompareUI.ensureMetaControls(meta, votes, views != null ? views : votes.viewCount);
        }
      }
    }

    window.dispatchEvent(
      new CustomEvent('unsynth-ryd-votes', {
        detail: { videoId: votes.videoId, votes: votes, viewCount: views }
      })
    );
  }

  function findTileMeta(tile) {
    if (!tile || !tile.querySelector) return null;
    var parts = YT && YT.TILE_META_HOST_SEL
      ? YT.TILE_META_HOST_SEL.split(/\s*,\s*/)
      : ['#metadata-line', '#byline-container'];
    for (var i = 0; i < parts.length; i++) {
      var el = tile.querySelector(parts[i]);
      if (el) return el;
    }
    return null;
  }

  // Deliberately never caches into tile.dataset — a tile recycled by
  // YouTube's virtualized feed for a different video must always resolve to
  // its CURRENT video, not whatever was first seen here. A cached shortcut
  // previously lived here (tile.dataset.unVid) and fed back into
  // observeTiles()'s own recycle-detection check, making that check compare
  // a stale value against itself — it could never fire, so a recycled tile
  // kept showing the OLD video's like/dislike/view stats indefinitely.
  function tileVideoId(tile) {
    // Check /watch?v= links first
    const watchLinks = tile.querySelectorAll('a[href*="/watch"], a[href*="v="]');
    for (let i = 0; i < watchLinks.length; i++) {
      const m = (watchLinks[i].getAttribute('href') || '').match(/[?&]v=([\w-]{11})/);
      if (m) return m[1];
    }
    // Fall back to /shorts/ID links
    const shortsLinks = tile.querySelectorAll('a[href*="/shorts/"]');
    for (let i = 0; i < shortsLinks.length; i++) {
      const sm = (shortsLinks[i].getAttribute('href') || '').match(/\/shorts\/([\w-]{11})/);
      if (sm) return sm[1];
    }
    return null;
  }

  function scrapeTileViews(tile) {
    const meta = findTileMeta(tile);
    if (!meta) return null;
    // The compact tile drops the word "views"; the adapter recovers the count
    // from its position before the age (yt-dom viewsText).
    const YDM = window.UNYtDom;
    const fromAdapter = YDM && YDM.viewsText && YDM.tileMetaTexts ? YDM.viewsText(YDM.tileMetaTexts(tile)) : '';
    const m = (fromAdapter || meta.textContent).match(/([\d.,]+\s*[KMBkmb]?)\s*views/i);
    return m ? m[1].trim() : null;
  }

  function applyFeedStats(tile, votes) {
    if (!votes || !votes.ok) return;
    const meta = findTileMeta(tile);
    if (!meta) return;
    if (meta.querySelector('.un-vid-stats-feed')) return;

    const p = prefs();
    const scrapedViews = scrapeTileViews(tile);
    const ratio = RATIO(votes.likes, votes.dislikes);

    const box = document.createElement('div');
    box.className = 'un-vid-stats-feed';
    box.title = FMT(votes.likes) + ' likes · ' + FMT(votes.dislikes) + ' dislikes (Return YouTube Dislike)';
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', FMT(votes.likes) + ' likes, ' + FMT(votes.dislikes) + ' dislikes' + (ratio != null ? ', ' + RATIO_LABEL(votes.likes, votes.dislikes) + ' liked' : ''));

    function stat(cls, text) {
      const s = document.createElement('span');
      s.className = 'un-vsf-stat ' + cls;
      s.textContent = text;
      box.appendChild(s);
    }

    let any = false;
    if (votes.likes != null) { stat('un-vsf-like', FMT(votes.likes)); any = true; }
    if (votes.dislikes != null) { stat('un-vsf-dislike', FMT(votes.dislikes)); any = true; }
    // The percentage alone. A 34px bar beside an exact "%" is a second, less
    // precise encoding of the same number, and with the arrow and the sentiment
    // colour already on the row it made five encodings of one fact in 12px.
    if (p.showRatio && ratio != null) {
      stat('un-vsf-ratio', RATIO_LABEL(votes.likes, votes.dislikes));
      any = true;
    }
    // Only add a view count when the tile does not already carry one.
    // votes.viewCount (RYD) and the rendered tile count are two independent
    // numbers for the same thing, and they disagree often enough that appending
    // ours into the same metadata block printed "759K views" directly above
    // "754K views" with nothing to distinguish them. YouTube's own number is
    // the one the user is reading, so it wins; ours fills a genuine gap only.
    if (p.showViews && !scrapedViews) {
      const v = votes.viewCount ? FMT(votes.viewCount) + ' views' : '';
      if (v) { stat('un-vsf-views', v); any = true; }
    }
    if (!any) return;
    meta.appendChild(box);
  }

  function enqueueFetch(vid, tile) {
    if (!vid || feedCache[vid] || queued.has(vid)) return;
    queued.add(vid);
    fetchQueue.push({ vid: vid, tile: tile });
    drainQueue();
  }

  function drainQueue() {
    while (fetchActive < MAX_CONCURRENT && fetchQueue.length) {
      const job = fetchQueue.shift();
      fetchActive++;
      send(M_RYD, { videoId: job.vid })
        .then(function (r) {
          // Only cache successful responses — caching a failure would block
          // every future retry for this video for the rest of the session.
          if (r && r.ok) {
            feedCache[job.vid] = r;
            // Evict oldest entries (insertion order) when the cache exceeds 200.
            const keys = Object.keys(feedCache);
            if (keys.length > 200) {
              const excess = keys.length - 200;
              for (let ki = 0; ki < excess; ki++) delete feedCache[keys[ki]];
            }
            if (job.tile && document.contains(job.tile)) applyFeedStats(job.tile, r);
            else document.querySelectorAll(tileSel()).forEach(function (t) {
              if (tileVideoId(t) === job.vid) applyFeedStats(t, r);
            });
          }
        })
        .finally(function () {
          fetchActive--;
          queued.delete(job.vid);
          drainQueue();
        });
    }
  }

  function ensureFeedObserver() {
    if (io || !prefs().feedTiles) return;
    io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (ent) {
          if (!ent.isIntersecting) return;
          const tile = ent.target;
          const vid = tileVideoId(tile);
          if (!vid) return;
          if (feedCache[vid]) {
            applyFeedStats(tile, feedCache[vid]);
            return;
          }
          enqueueFetch(vid, tile);
        });
      },
      { root: null, rootMargin: '120px', threshold: 0.05 }
    );
  }

  function observeTiles() {
    if (!prefs().feedTiles) return;
    ensureFeedObserver();
    const onWatch =
      (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.indexOf('/shorts/') === 0;
    let nodes;
    if (onWatch) {
      const root =
        (window.UNYtDom && window.UNYtDom.watchRelatedRoot && window.UNYtDom.watchRelatedRoot()) ||
        document.querySelector(YT ? YT.RELATED_RAIL_SEL : '#related');
      if (!root) return;
      nodes = root.querySelectorAll(tileSel());
    } else {
      nodes = document.querySelectorAll(tileSel());
    }
    nodes.forEach(function (tile) {
      if (tile.classList && tile.classList.contains('un-sub-hidden')) return;
      const vid = tileVideoId(tile);
      if (!vid) return;
      // Virtual scroll reuses a tile node for a different video — if the id
      // changed, drop the stale stats and re-observe for the new one.
      if (tile.dataset && tile.dataset.unObsVid && tile.dataset.unObsVid !== vid) {
        const old = tile.querySelector('.un-vid-stats-feed');
        if (old) old.remove();
        if (io) io.unobserve(tile);
        delete tile.dataset.unObserved;
      }
      if (tile.dataset && tile.dataset.unObserved) return;
      if (tile.dataset) {
        tile.dataset.unObserved = '1';
        tile.dataset.unObsVid = vid;
      }
      if (feedCache[vid]) {
        applyFeedStats(tile, feedCache[vid]);
        return;
      }
      if (io) io.observe(tile);
    });
  }

  function clearUI() {
    document.querySelectorAll('.un-deck-published').forEach(function (n) { n.remove(); });
    stopWatchButtonObserver();
    document.querySelectorAll('.un-ryd-count').forEach(function (n) {
      n.remove();
    });
    document.querySelectorAll('.un-ryd-has-count').forEach(function (b) {
      b.classList.remove('un-ryd-has-count');
    });
    document.querySelectorAll('.un-ryd-segmented').forEach(function (b) {
      b.classList.remove('un-ryd-segmented');
      b.removeAttribute('data-un-ryd-ratio');
      b.removeAttribute('title');
    });
    const bar = document.getElementById('un-ryd-bar');
    if (bar) bar.remove();
    const meta = document.getElementById('un-vid-stats');
    if (meta) {
      meta.classList.remove('expanded');
      const panel = meta.querySelector('.un-vid-stats-panel');
      if (panel) {
        panel.hidden = true;
        panel.textContent = '';
      }
    }
    if (window.UNStatsCompareUI) UNStatsCompareUI.closePopout();
    if (meta) meta.remove();
    document.querySelectorAll('.un-vid-stats-feed').forEach(function (n) {
      n.remove();
    });
    document.querySelectorAll(tileSel()).forEach(function (t) {
      if (t.dataset) {
        delete t.dataset.unObserved;
        delete t.dataset.unObsVid;
      }
    });
    if (io) {
      io.disconnect();
      io = null;
    }
  }

  async function refreshWatch() {
    const vid = videoId();
    if (!vid) return;
    if (vid === lastVid && lastVotes && lastVotes.ok) {
      applyWatchUI(lastVotes, pageViews);
      return;
    }
    if (pendingWatch) return;
    pendingWatch = true;
    lastVid = vid;
    try {
      const p = prefs();
      // One bridge call answers both — the reply already carries publishDate,
      // so showing the upload date here costs no extra round trip.
      if (p.showViews || p.showDate) {
        const s = await requestPageStats();
        pageViews = s ? s.viewCount : null;
        pagePublished = s ? s.publishDate : '';
      }
      const r = await send(M_RYD, { videoId: vid });
      lastVotes = r;
      if (r && r.ok) applyWatchUI(r, pageViews);
      else if (pageViews && p.watchMetaRow) {
        const meta = ensureWatchMetaRow();
        if (meta) {
          meta.textContent = '';
          const span = document.createElement('span');
          span.className = 'un-vs-views';
          span.textContent = FMT(pageViews) + ' views';
          meta.appendChild(span);
          meta.classList.add('on');
        }
      }
    } finally {
      pendingWatch = false;
      // If the page changed while this fetch was in flight, fetch the new one.
      if (isWatch() && videoId() && videoId() !== vid) refreshWatch();
    }
  }

  function refresh() {
    if (core && !core.isModuleEnabled(mod)) {
      clearUI();
      return;
    }
    if (isWatch()) {
      if (prefs().watchButtons) ensureWatchButtonObserver();
      refreshWatch();
    } else {
      stopWatchButtonObserver();
      lastVid = null;
      lastVotes = null;
      pageViews = null;
      pagePublished = '';
    }
    // Feed/related tiles get stats on EVERY page — including the watch-page
    // recommendations sidebar and end-screen — not just home/search/playlist.
    // Lazy IntersectionObserver + capped concurrency keep the fetch load sane.
    observeTiles();
  }

  function destroy() {
    clearUI();
    lastVid = null;
    lastVotes = null;
    pageViews = null;
    pagePublished = '';
    pendingWatch = false;
    fetchQueue = [];
    queued.clear();
    fetchActive = 0;
  }

  const mod = {
    id: 'dislikeRestore',
    moduleKey: 'dislikeRestore',
    init: function (c) {
      core = c;
      refresh();
    },
    scan: refresh,
    onNavigate: function () {
      // Tear down stale watch-button observer before re-evaluating on new URL.
      stopWatchButtonObserver();
      lastVid = null;
      lastVotes = null;
      pageViews = null;
      pagePublished = '';
      refresh();
    },
    onSettings: function () {
      if (core && !core.isModuleEnabled(mod)) destroy();
      else refresh();
    },
    // Core skips onSettings for a just-disabled module, so clean up here.
    teardown: destroy
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
