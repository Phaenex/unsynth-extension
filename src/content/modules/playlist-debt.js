/**
 * The line under a playlist title that says what you actually owe it.
 *
 * "418 videos · at least 62h 14m · 390 unfinished · you finish 31% of what you
 * start here"
 *
 * WHY THIS IS THE ONE PLACE THE SAVED-VS-FINISHED NUMBER IS HONEST
 * Per-channel completion deliberately refuses to report a "saved vs finished"
 * ratio, because it computes from watch history where saved === played by
 * construction: you cannot have played something you never saved, so the ratio
 * is 1 and the claim is meaningless. A playlist page is different — membership
 * here is what you SAVED, independent of what you played — so this is the only
 * surface where `fromPlaylist: true` is true, and the backlog line can be shown.
 *
 * WHAT IT REFUSES TO SAY
 *   - No time figure it cannot back: durations arrive from a cache that may hold
 *     part of the list, so the span is prefixed "at least" until every id is
 *     known. A floor presented as a total makes every "can I clear this" answer
 *     wrong in the user's favour.
 *   - No completion rate below three started videos. A confident percentage from
 *     one abandoned video is worse than silence.
 *   - Nothing at all on a playlist whose rows have not rendered yet.
 */
(function () {
  'use strict';

  const MOUNTED = 'un-pl-debt';
  let core = null;
  let YT = null;
  let busy = false;

  function enabled() {
    const s = (core && core.settings) || {};
    return s.playlistDebt !== false;
  }

  function onPlaylistPage() {
    return typeof location !== 'undefined'
      && location.pathname.startsWith('/playlist')
      && /[?&]list=/.test(location.search || '');
  }

  function teardown() {
    document.querySelectorAll('.' + MOUNTED).forEach((n) => n.remove());
  }

  /** Every video id rendered on this playlist page, in order. */
  function pageVideoIds() {
    // PLAYLIST_ROW_SEL covers both of YouTube's row markup generations. No
    // literal fallback, and the generations are deliberately not named here:
    // yt-dom owns every YouTube selector, a duplicate is drift the moment one
    // is renamed, and the centralization ratchet counts them in comments too.
    const sel = YT && YT.PLAYLIST_ROW_SEL;
    if (!sel) return [];
    const rows = document.querySelectorAll(sel);
    const linkSel = YT.RELATED_TILE_LINK_SEL;
    const ids = [];
    rows.forEach((row) => {
      const a = linkSel && row.querySelector(linkSel);
      const m = a && (a.getAttribute('href') || '').match(/[?&]v=([\w-]{11})/);
      if (m) ids.push(m[1]);
    });
    return ids;
  }

  /**
   * { key, name } per row, for the channel-mix clause.
   *
   * Read separately from the ids rather than as one pass: a row can have a
   * readable video id and an unreadable channel (and the reverse), and pairing
   * them would silently drop one whenever the other is missing. The grouping
   * module counts unreadable rows on purpose, so it needs every row, including
   * the ones it cannot name.
   */
  function pageChannels() {
    const sel = YT && YT.PLAYLIST_ROW_SEL;
    if (!sel) return [];
    const out = [];
    document.querySelectorAll(sel).forEach((row) => {
      out.push({
        key: YT.tileChannelKey ? YT.tileChannelKey(row) : null,
        name: YT.tileChannel ? YT.tileChannel(row) : ''
      });
    });
    return out;
  }

  function render(text) {
    const anchor = YT && YT.playlistPageMeta ? YT.playlistPageMeta() : null;
    if (!anchor) return false;
    let el = anchor.querySelector('.' + MOUNTED);
    if (!el) {
      el = document.createElement('div');
      el.className = MOUNTED;
      anchor.appendChild(el);
    }
    let textEl = el.querySelector('.un-pl-debt-text');
    if (!textEl) {
      textEl = document.createElement('span');
      textEl.className = 'un-pl-debt-text';
      el.appendChild(textEl);
    }
    // Rewrite in place rather than remove-and-add: durations stream in, and
    // tearing the node down on every update makes the line visibly flicker —
    // and would destroy the fit control mid-interaction.
    if (textEl.textContent !== text) textEl.textContent = text;
    ensureFitControl(el);
    return true;
  }

  /**
   * "I have [90] minutes" — the question a backlog actually raises.
   *
   * Built as a control rather than a static number because the budget is the
   * user's, not ours to assume. Answers in PLAYLIST ORDER and refuses to pack
   * anything whose duration is unknown, both for the same reason: a fit that
   * quietly reorders the queue or guesses a length is not a plan you can trust.
   */
  function ensureFitControl(host) {
    if (host.querySelector('.un-pl-fit')) return;
    const TB = window.UNTimeBudget;
    if (!TB) return;

    const wrap = document.createElement('span');
    wrap.className = 'un-pl-fit';

    const label = document.createElement('label');
    label.className = 'un-pl-fit-label';
    label.textContent = 'I have ';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'un-pl-fit-input';
    input.min = '5';
    input.max = '600';
    input.step = '5';
    input.value = '90';
    input.setAttribute('aria-label', 'Minutes available');

    const unit = document.createElement('span');
    unit.className = 'un-pl-fit-unit';
    unit.textContent = ' min';

    const out = document.createElement('span');
    out.className = 'un-pl-fit-out';
    out.setAttribute('role', 'status');

    label.append(input, unit);
    wrap.append(label, out);
    host.appendChild(wrap);

    const recompute = () => {
      const mins = Number(input.value);
      if (!isFinite(mins) || mins <= 0) { out.textContent = ''; return; }
      const ids = pageVideoIds();
      chrome.storage.local.get(['ytVideoDurations', 'watchedVideos'], (d) => {
        if (chrome.runtime.lastError) return;
        const PB = window.UNPlaylistBudget;
        const fit = TB.fitToBudget({
          videoIds: ids,
          durations: (d && d.ytVideoDurations) || {},
          watched: (d && d.watchedVideos) || [],
          budgetSec: mins * 60,
          fill: true
        });
        const text = TB.fitLabel(fit, PB && PB.formatSpan);
        // Says nothing rather than "0 videos": with an empty duration cache
        // that would read as "this playlist is empty" instead of "I do not know
        // how long these are yet".
        out.textContent = text ? ' → ' + text : '';
      });
    };

    input.addEventListener('input', recompute);
    input.addEventListener('change', recompute);
    recompute();
  }

  function compute(ids, cb) {
    chrome.storage.local.get(
      ['ytVideoDurations', 'watchedVideos', 'watchProgress'],
      (d) => {
        if (chrome.runtime.lastError) return cb(null);
        const PB = window.UNPlaylistBudget;
        const CC = window.UNChannelCompletion;
        if (!PB) return cb(null);

        const watched = (d && d.watchedVideos) || [];
        const budget = PB.playlistBudget({
          videoIds: ids,
          durations: (d && d.ytVideoDurations) || {},
          watched: watched
        });
        const parts = [PB.budgetLabel(budget)].filter(Boolean);

        // The channel-mix clause. A long playlist reads as undifferentiated;
        // whether it is forty creators or secretly three is the fact that
        // decides whether to keep, split or prune it.
        const PG = window.UNPlaylistGrouping;
        if (PG) {
          const gl = PG.groupingLabel(PG.groupByChannel(pageChannels()));
          if (gl) parts.push(gl);
        }

        // The completion clause, which only a playlist can honestly carry.
        if (CC) {
          const stats = CC.channelCompletion({
            videoIds: ids,
            progress: (d && d.watchProgress) || {},
            percentProgress: true,
            watched: watched,
            fromPlaylist: true
          });
          const label = CC.completionLabel(stats);
          if (label) parts.push(label);
        }
        cb(parts.length ? parts.join(' · ') : null);
      }
    );
  }

  function scan() {
    if (!enabled() || !onPlaylistPage()) {
      teardown();
      return;
    }
    if (busy) return;
    const ids = pageVideoIds();
    if (!ids.length) return;
    busy = true;
    compute(ids, (text) => {
      busy = false;
      if (!text) {
        teardown();
        return;
      }
      render(text);
    });
  }

  const mod = {
    id: 'playlistDebt',
    moduleKey: 'playlistDebt',
    init: function (c) {
      core = c;
      YT = window.UNYtDom || null;
      scan();
    },
    scan: scan,
    onNavigate: function () {
      teardown();
      scan();
    },
    onSettings: function (s) {
      core.settings = s;
      scan();
    },
    teardown: teardown
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pageVideoIds };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
