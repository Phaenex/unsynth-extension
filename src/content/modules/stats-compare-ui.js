/**
 * Expandable / pop-out stats compare UI for watch page stats strip.
 */
(function () {
  'use strict';

  const VSC = window.UNVideoStatsCache;
  const FMT = window.UNRyd ? UNRyd.fmt : (n) => String(n);

  let popout = null;
  let popoutEscHandler = null;

  function el(tag, cls, text) { return window.UNSYNTH.el(tag, cls, text); }

  function requestPageStats() {
    return new Promise(function (resolve) {
      const reqId = 'uvs' + Date.now();
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.type !== 'UN_STATS' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'UN_STATS_REQ', reqId: reqId }, '*');
      setTimeout(function () {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 3500);
    });
  }

  function requestRyd(videoId) {
    return new Promise(function (resolve) {
      if (!videoId) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'UNSYNTH/RYD/VOTES', videoId: videoId }, function (r) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r && r.ok ? r : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // buildStats() below fires saveSnapshot() once for the current video plus once
  // per related tile (up to 12) back-to-back. Each call used to do its own
  // unlocked chrome.storage.local get-then-set — with that many concurrent
  // read/merge/write cycles racing against the same videoStatsCache key, every
  // writer but the last landed on a stale base object and its merged entry was
  // silently lost (confirmed: up to 13 concurrent calls here → up to 12 lost
  // writes). Chain every call through one promise so each get/merge/set fully
  // completes before the next one reads, same serialization pattern as
  // UNStore.quotaAdd in shared/storage.js.
  let _saveChain = Promise.resolve();
  function saveSnapshot(snap) {
    if (!snap || !snap.videoId) return;
    _saveChain = _saveChain.then(function () {
      return new Promise(function (resolve) {
        chrome.storage.local.get({ videoStatsCache: {} }, function (d) {
          const merged = VSC.mergeCacheEntry(d.videoStatsCache || {}, snap);
          chrome.storage.local.set({ videoStatsCache: merged }, resolve);
        });
      });
    }).catch(function () {});
  }

  function deltaClass(delta) {
    if (delta == null || !isFinite(delta)) return '';
    if (delta >= 10) return 'up';
    if (delta <= -10) return 'down';
    return 'flat';
  }

  function renderCompareTable(current, channelAgg, relatedAgg) {
    const wrap = el('div', 'un-compare-table-wrap');
    const table = el('table', 'un-compare-table');
    const thead = el('thead');
    const hr = el('tr');
    ['Metric', 'This video', 'Channel median', 'Related avg'].forEach(function (h) {
      hr.appendChild(el('th', '', h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');

    function addRow(label, cur, ch, rel, fmt) {
      const tr = el('tr');
      tr.appendChild(el('td', 'un-compare-metric', label));
      tr.appendChild(el('td', 'un-compare-val current', fmt(cur)));
      const chTd = el('td', 'un-compare-val');
      const chDelta = VSC.pctDelta(cur, ch);
      chTd.textContent = ch != null ? fmt(ch) + ' (' + VSC.fmtDelta(chDelta) + ')' : '—';
      // deltaClass() is '' when there's no benchmark — classList.add('') throws
      // ("token must not be empty"), which crashed the whole compare render.
      const chCls = deltaClass(chDelta);
      if (chCls) chTd.classList.add(chCls);
      tr.appendChild(chTd);
      const relTd = el('td', 'un-compare-val');
      const relDelta = VSC.pctDelta(cur, rel);
      relTd.textContent = rel != null ? fmt(rel) + ' (' + VSC.fmtDelta(relDelta) + ')' : '—';
      const relCls = deltaClass(relDelta);
      if (relCls) relTd.classList.add(relCls);
      tr.appendChild(relTd);
      tbody.appendChild(tr);
    }

    const fN = (n) => (n == null ? '—' : FMT(Math.round(n)));
    const fP = (n) => (n == null ? '—' : n.toFixed(1) + '%');

    addRow('Views', current.viewCount, channelAgg && channelAgg.medianViews, relatedAgg && relatedAgg.avgViews, fN);
    addRow(
      'Engagement',
      VSC.engagementRate(current),
      channelAgg && channelAgg.medianEngagement,
      relatedAgg && relatedAgg.medianEngagement,
      fP
    );
    addRow('Like ratio', VSC.likeRatio(current), channelAgg && channelAgg.medianLikeRatio, relatedAgg && relatedAgg.medianLikeRatio, fP);
    addRow(
      'Views / day',
      VSC.viewsPerDay(current),
      channelAgg && channelAgg.medianViewsPerDay,
      relatedAgg && relatedAgg.medianViewsPerDay,
      fN
    );

    table.appendChild(tbody);
    wrap.appendChild(table);

    if (channelAgg && channelAgg.best && channelAgg.best.videoId !== current.videoId) {
      wrap.appendChild(
        el(
          'p',
          'un-compare-note',
          'Channel best in cache: "' +
            (channelAgg.best.title || channelAgg.best.videoId) +
            '" · ' +
            FMT(channelAgg.best.viewCount) +
            ' views (' +
            channelAgg.count +
            ' videos saved)'
        )
      );
    } else if (channelAgg && channelAgg.count > 0) {
      wrap.appendChild(el('p', 'un-compare-note', channelAgg.count + ' other videos from this channel in your cache.'));
    } else {
      wrap.appendChild(
        el(
          'p',
          'un-compare-note',
          'No channel history yet — watch more videos from this creator to unlock channel median comparisons.'
        )
      );
    }

    return wrap;
  }

  function renderRelatedList(current, related) {
    const sec = el('div', 'un-compare-related');
    sec.appendChild(el('div', 'un-compare-subhead', 'Related on this page'));
    if (!related.length) {
      sec.appendChild(el('p', 'un-compare-empty', 'Scroll the sidebar — related videos appear here for live comparison.'));
      return sec;
    }
    const maxViews = Math.max(current.viewCount || 1, ...related.map((r) => r.viewCount || 0));
    related.slice(0, 8).forEach(function (r) {
      const row = el('div', 'un-compare-rel-row');
      const pct = Math.max(4, Math.round(((r.viewCount || 0) / maxViews) * 100));
      const bar = el('div', 'un-compare-rel-bar');
      const fill = el('div', 'un-compare-rel-fill');
      fill.style.width = pct + '%';
      if (r.videoId === current.videoId) fill.classList.add('current');
      bar.appendChild(fill);
      row.appendChild(bar);
      const meta = el('div', 'un-compare-rel-meta');
      meta.appendChild(el('span', 'un-compare-rel-title', r.title || r.videoId));
      meta.appendChild(el('span', 'un-compare-rel-views', FMT(r.viewCount || 0) + ' views'));
      row.appendChild(meta);
      sec.appendChild(row);
    });
    return sec;
  }

  function buildPanelContent(current, channelAgg, relatedList, relatedAgg) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('div', 'un-compare-title', current.title || 'This video'));
    frag.appendChild(
      el(
        'p',
        'un-compare-lead',
        'Compared to other videos from ' + (current.channelName || 'this channel') + ' (your cache) and related videos on this page.'
      )
    );
    frag.appendChild(renderCompareTable(current, channelAgg, relatedAgg));
    frag.appendChild(renderRelatedList(current, relatedList));
    return frag;
  }

  async function loadCompareData(votes, pageViews) {
    const page = await requestPageStats();
    const vid = (page && page.videoId) || (votes && votes.videoId) || '';
    const ryd = votes && votes.ok ? votes : await requestRyd(vid);
    const current = VSC.normalize({
      videoId: vid,
      title: page && page.title,
      channelId: page && page.channelId,
      channelName: page && page.author,
      viewCount: pageViews != null ? pageViews : page && page.viewCount,
      likes: ryd && ryd.likes,
      dislikes: ryd && ryd.dislikes,
      publishDate: page && page.publishDate,
      lengthSeconds: page && page.lengthSeconds
    });
    if (!current) return null;
    saveSnapshot(current);

    const relatedList = VSC.scrapeRelatedFromDom(12);
    relatedList.forEach(function (r) {
      saveSnapshot(r);
    });

    return new Promise(function (resolve) {
      chrome.storage.local.get({ videoStatsCache: {} }, function (d) {
        const cache = d.videoStatsCache || {};
        const channelList = VSC.channelEntries(cache, current.channelId, current.videoId);
        const channelAgg = VSC.aggregate(channelList);
        const relatedAgg = VSC.aggregate(relatedList.filter((r) => r.viewCount > 0));
        resolve({ current: current, channelAgg: channelAgg, relatedList: relatedList, relatedAgg: relatedAgg });
      });
    });
  }

  function closePopout() {
    if (popoutEscHandler) {
      document.removeEventListener('keydown', popoutEscHandler);
      popoutEscHandler = null;
    }
    if (popout && popout.parentNode) popout.parentNode.removeChild(popout);
    popout = null;
  }

  function openPopout(bodyContent) {
    closePopout();
    popout = el('div', 'un-stats-popout');
    popout.setAttribute('role', 'dialog');
    popout.setAttribute('aria-modal', 'true');
    popout.setAttribute('aria-label', 'Video stats compare');
    const backdrop = el('div', 'un-stats-popout-backdrop');
    backdrop.addEventListener('click', closePopout);
    const card = el('div', 'un-stats-popout-card');
    const head = el('div', 'un-stats-popout-head');
    head.appendChild(el('span', 'un-stats-popout-title', 'Stats compare'));
    const closeBtn = el('button', 'un-stats-popout-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', closePopout);
    head.appendChild(closeBtn);
    card.appendChild(head);
    const body = el('div', 'un-stats-popout-body');
    body.appendChild(bodyContent);
    card.appendChild(body);
    popout.appendChild(backdrop);
    popout.appendChild(card);
    document.body.appendChild(popout);
    popoutEscHandler = function (ev) {
      if (ev.key === 'Escape') {
        closePopout();
        return;
      }
      if (ev.key !== 'Tab') return;
      // Trap focus inside the dialog (aria-modal is not enforced for injected DOM).
      const focusables = Array.prototype.slice
        .call(card.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(function (n) { return n.offsetParent !== null; });
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!card.contains(document.activeElement)) {
        ev.preventDefault();
        first.focus();
      } else if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', popoutEscHandler);
    closeBtn.focus();
  }

  function setExpandOpen(meta, panel, expandBtn, open) {
    meta.classList.toggle('expanded', open);
    panel.hidden = !open;
    expandBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /** Opt-out setting: the fact-check actions ride on the stats panel. */
  function factCheckInStats() {
    const core = window.UNSYNTH;
    const d = (core && core.settings && core.settings.dislikeRestore) || {};
    // The button only FIRES the fact-check module's own control. With that
    // module off it rendered anyway, as the one filled button in the row, and
    // pressing it toasted "Claim review is turned off" (found on the owner's
    // profile 2026-09-24). The guide's More tools list offers Fact check
    // instead.
    const mods = (core && core.settings && core.settings.modules) || {};
    return d.statsFactCheck !== false && mods.factCheck !== false;
  }

  /**
   * Fire the fact-check module's own button rather than re-implementing it.
   * That module owns the AI key handling, the error states and the results
   * panel; duplicating any of that here would be a second copy to keep in
   * sync. If its row has not rendered yet there is nothing to click, so say
   * so instead of failing silently.
   */
  function clickFactCheck(action) {
    const btn = document.querySelector('.un-fc-btn[data-action="' + action + '"]');
    if (btn) {
      btn.click();
      return;
    }
    const core = window.UNSYNTH;
    if (core && core.toast) core.toast('Claim review is turned off for this video');
  }

  function ensureMetaControls(meta, votes, pageViews) {
    if (!meta || !VSC) return;

    meta._unCompareCtx = { votes: votes, pageViews: pageViews };

    const main = meta.querySelector('.un-vid-stats-main');
    if (!main) return;

    let tools = main.querySelector('.un-vid-stats-tools');
    if (!tools) {
      tools = el('div', 'un-vid-stats-tools');

      // FOUR CONTROLS AT ONE WEIGHT IS NOT A HIERARCHY.
      //
      // Measured on a live watch page: Compare, Expand, Claim review and
      // Summarize all rendered at border rgba(0,0,0,0.16), weight 600,
      // 11.5px — identical. The only difference was a 3%-opacity fill, which
      // is not a visual distinction anyone reads. Worse, the fill was on the
      // WRONG pair: Summarize, the marquee AI action, was a `ghost` while
      // Compare, a disclosure for a panel most users never open, carried the
      // filled treatment.
      //
      // The order below is by what a user actually does on a watch page, and
      // the classes now mean something:
      //   un-vsb-primary    one per row, filled and confident
      //   (default)         secondary, outlined
      //   ghost             utility, text-weight — disclosure, not action
      //
      // Compare is a DISCLOSURE, not an action: it toggles an inline panel and
      // carries aria-expanded. It reads as secondary and sits after the real
      // actions rather than leading them.
      const expandBtn = el('button', 'un-vid-stats-btn');
      expandBtn.type = 'button';
      expandBtn.setAttribute('aria-expanded', 'false');
      expandBtn.title = 'Compare to channel median and related videos';
      expandBtn.setAttribute('aria-label', expandBtn.title);
      expandBtn.innerHTML = 'Compare <span class="un-vid-stats-caret" aria-hidden="true">▾</span>';

      // Expand opens the SAME comparison in a dialog. It is a second route to
      // one destination, so it recedes to utility weight rather than competing
      // with the inline disclosure beside it.
      const popBtn = el('button', 'un-vid-stats-btn ghost');
      popBtn.type = 'button';
      popBtn.textContent = 'Expand';
      popBtn.title = 'Open full compare panel';
      popBtn.setAttribute('aria-label', 'Open full compare panel in a dialog');

      // Fact-check lives in its own block further down the page, which means
      // two Unsynth surfaces stacked on one watch page doing related jobs.
      // Its two actions ride here instead, so the stats panel is the single
      // place to act on a video. The fact-check module still owns the work and
      // the results panel — these only fire its buttons.
      if (factCheckInStats()) {
        // SUMMARIZE IS THE PRIMARY ACTION ON A WATCH PAGE.
        //
        // It is the one control here that answers "what is in this video"
        // without watching it, it needs no prior context, and it applies to
        // every video. It was the ghost. It leads now, and it is the only
        // filled control in the row.
        const sum = el('button', 'un-vid-stats-btn un-vsb-primary un-vs-fc');
        sum.type = 'button';
        sum.textContent = 'Summarize';
        sum.title = 'Summarize this video';
        sum.setAttribute('aria-label', sum.title);
        sum.addEventListener('click', () => clickFactCheck('summarize'));

        // ONE ENTRY POINT FOR CLAIM REVIEW, NOT TWO.
        //
        // This button and the fact slot's own "✦ Claim review" title are the
        // same feature about eighty pixels apart — and this one is a MIRROR
        // that fires the fact panel's button, with CSS hiding the original.
        // Two controls, one action, no way to tell them apart.
        //
        // The fact slot keeps it: that slot exists to hold the result, so the
        // control belongs beside where its output lands. Removing the mirror
        // leaves exactly one path, and the slot below is where it already led.
        tools.appendChild(sum);
        // Tell CSS to hide the fact panel's own Summarize, or it renders twice.
        // Its Claim review button is no longer mirrored, so it stays visible
        // and becomes the single entry point.
        document.body.classList.add('un-vs-fc-mirrored');
      }

      // Disclosures last: real actions first, then the ways to see more.
      tools.appendChild(expandBtn);
      tools.appendChild(popBtn);

      main.appendChild(tools);

      let panel = meta.querySelector('.un-vid-stats-panel');
      if (!panel) {
        panel = el('div', 'un-vid-stats-panel');
        panel.hidden = true;
        panel.id = 'un-vid-stats-panel-' + ((votes && votes.videoId) || Math.random().toString(36).slice(2));
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'Video stats comparison');
        meta.appendChild(panel);
      }
      expandBtn.setAttribute('aria-controls', panel.id);

      // Defeats any inherited CSS that could keep the panel invisible (the stats
      // card clips with overflow:hidden for rounded corners; a parent flex row
      // could zero its height). This is the fix for "Compare does nothing".
      function forcePanelVisible() {
        panel.hidden = false;
        panel.style.display = 'block';
        panel.style.overflow = 'visible';
        panel.style.maxHeight = 'none';
        meta.style.overflow = 'visible';
        try { panel.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
      }

      let loading = false;

      async function showCompare(mode) {
        if (loading) return;
        loading = true;
        const ctx = meta._unCompareCtx || { votes: votes, pageViews: pageViews };
        panel.textContent = '';
        panel.appendChild(el('p', 'un-compare-loading', 'Loading comparison…'));
        setExpandOpen(meta, panel, expandBtn, true);
        // Force the panel visible past any inherited CSS (overflow/height/display)
        // and bring it into view — this is the "nothing happens on click" guard.
        forcePanelVisible();

        try {
          const data = await loadCompareData(ctx.votes, ctx.pageViews);
          if (!data) {
            panel.textContent = 'Could not load stats for this video.';
            return;
          }
          const content = buildPanelContent(data.current, data.channelAgg, data.relatedList, data.relatedAgg);
          // Clone BEFORE appendChild — appending a DocumentFragment empties it,
          // so the popout must take its copy first.
          const popoutCopy = mode === 'popout' ? content.cloneNode(true) : null;
          panel.textContent = '';
          panel.appendChild(content);
          forcePanelVisible();
          if (mode === 'popout') {
            openPopout(popoutCopy);
            setExpandOpen(meta, panel, expandBtn, false);
          }
        } catch (e) {
          // Surface the real cause instead of swallowing it — a silent "Failed to
          // load" with no detail is undebuggable.
          try { console.error('[Unsynth] compare failed:', (e && (e.stack || e.message)) || e); } catch (_) { /* ignore */ }
          // Never leave the panel stuck on the spinner — collapse so the next
          // Compare click triggers a fresh fetch (not the toggle-closed branch).
          panel.textContent = 'Failed to load stats. Click Compare to retry.';
          setExpandOpen(meta, panel, expandBtn, false);
        } finally {
          loading = false;
        }
      }

      expandBtn.addEventListener('click', function () {
        const open = meta.classList.contains('expanded');
        if (open) {
          setExpandOpen(meta, panel, expandBtn, false);
          return;
        }
        showCompare('inline');
      });

      popBtn.addEventListener('click', function () {
        showCompare('popout');
      });
    }
  }

  window.UNStatsCompareUI = {
    ensureMetaControls: ensureMetaControls,
    loadCompareData: loadCompareData,
    buildPanelContent: buildPanelContent,
    openPopout: openPopout,
    closePopout: closePopout,
    saveSnapshot: saveSnapshot
  };
})();
