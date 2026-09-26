/**
 * Unsynth Analytics — a vidIQ-style stats card injected into the watch page's
 * right column. Everything is computed from the page's own player response
 * (zero API quota) plus a best-effort DOM scrape for the like count. Proprietary
 * scores are labelled "our heuristic" — never presented as vidIQ-equivalent.
 */
(function () {
  'use strict';

  let core = null;
  let panel = null;
  let rydHandler = null;
  let lastVideo = null;
  let building = false;
  // Collapsed by default. Expanded, this card is a 2x4 grid, two buttons, three
  // meter rows, a compare block and an SEO ring at the top of the related
  // column — a dashboard where the standard wants an instrument. The header
  // carries a one-line summary so the closed state still says something.
  let collapsedPref = true;
  let sectionPref = {};
  let liveUpdate = null;
  let liveUpdateTimer = null;

  const FL = window.UNForgeLinks;
  const WS = window.UNWatchStats;
  const isWatch = () =>
    WS && WS.isTrackableWatchPage ? WS.isTrackableWatchPage(location.pathname) : (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch');
  function videoId() {
    if (WS && WS.videoIdFromUrl) return WS.videoIdFromUrl(location.pathname, location.search);
    const m = location.search.match(/[?&]v=([^&]+)/);
    return m ? m[1] : null;
  }

  function el(tag, cls, text) { return window.UNSYNTH.el(tag, cls, text); }
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function fmtDur(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const x = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
  }

  // ---- bridge ----
  let seq = 0;
  function requestStats() {
    return new Promise((resolve) => {
      const reqId = 's' + ++seq;
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.type !== 'UN_STATS' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'UN_STATS_REQ', reqId }, '*');
      setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 4000);
    });
  }

  // best-effort like count from the DOM (YouTube hides the exact number)
  function scrapeLikes() {
    const sels = [
      'like-button-view-model button',
      'segmented-like-dislike-button-view-model button',
      'ytd-menu-renderer #top-level-buttons-computed button',
      '#top-level-buttons-computed button'
    ];
    for (const s of sels) {
      const btn = document.querySelector(s);
      if (!btn) continue;
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').replace(/,/g, '');
      const m = label.match(/([\d.]+)\s*(K|M|B)?/i);
      if (m) {
        let n = parseFloat(m[1]);
        const suf = (m[2] || '').toUpperCase();
        if (suf === 'K') n *= 1e3;
        else if (suf === 'M') n *= 1e6;
        else if (suf === 'B') n *= 1e9;
        if (n > 0) return Math.round(n);
      }
    }
    return null;
  }

  // parse "1.2M", "12,345", "1.2M subscribers" → number
  function parseCount(str) {
    const m = String(str || '').replace(/,/g, '').match(/([\d.]+)\s*(K|M|B)?/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1e3;
    else if (suf === 'M') n *= 1e6;
    else if (suf === 'B') n *= 1e9;
    return n > 0 ? Math.round(n) : null;
  }
  // A repo-wide selector-drift audit (2026-08-23) flagged this as possibly
  // stale, by analogy with scrapeLikes() above needing view-model fallbacks.
  // Checked live against real YouTube DOM (2026-08-24): these selectors are
  // still correct — 'ytd-comments-header-renderer #count' resolves to e.g.
  // "2,455,259 Comments" once the section has actually rendered. The only
  // thing that looked like a bug (querying immediately after page load
  // returns just "Comments", no digits, so parseCount -> null) is expected,
  // already-handled behavior: comments load lazily "only after you scroll"
  // (see the caller's own comment), and the liveUpdate() closure re-calls
  // this on every scan until it succeeds. Not a live bug.
  function scrapeComments() {
    const sels = ['ytd-comments-header-renderer #count', '#comments #count .count-text', 'ytd-comments-header-renderer yt-formatted-string'];
    for (const s of sels) {
      const n = document.querySelector(s);
      if (n) {
        const v = parseCount(n.textContent);
        if (v != null) return v;
      }
    }
    return null;
  }
  function scrapeSubs() {
    const sels = ['#owner #subscriber-count', 'yt-formatted-string#owner-sub-count', '#upload-info #owner-sub-count', '#owner-sub-count'];
    for (const s of sels) {
      const n = document.querySelector(s);
      if (n && /subscrib/i.test(n.textContent)) {
        const v = parseCount(n.textContent);
        if (v != null) return v;
      }
    }
    return null;
  }

  function ageDays(publishDate) {
    const t = Date.parse(publishDate || '');
    if (isNaN(t)) return null;
    return Math.max(0, (Date.now() - t) / 86400000);
  }
  function ageHours(publishDate) {
    const t = Date.parse(publishDate || '');
    if (isNaN(t)) return null;
    return Math.max(0, (Date.now() - t) / 3600000);
  }
  function fmtDate(publishDate) {
    const t = Date.parse(publishDate || '');
    if (isNaN(t)) return '';
    return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // SEO heuristic — OUR approximation, not vidIQ's private index.
  function computeSEO(stats) {
    const tl = (stats.title || '').length;
    const tags = (stats.keywords || []).length;
    const checks = [
      {
        ok: tl >= 30 && tl <= 70,
        label: 'Title 30-70 chars (' + tl + ')',
        why:
          tl < 30
            ? 'Short titles may lack keywords searchers use; aim for 30–70 characters.'
            : tl > 70
              ? 'Long titles get truncated in search and browse — front-load the hook.'
              : 'Title length is in the sweet spot for search and browse display.'
      },
      {
        ok: tags >= 5,
        label: 'At least 5 tags (' + tags + ')',
        why: tags < 5 ? 'More tags help YouTube categorize the video — aim for 5+ relevant ones.' : 'Enough tags to help discovery and categorization.'
      },
      {
        ok: stats.descriptionLen >= 200,
        label: 'Description 200+ chars (' + stats.descriptionLen + ')',
        why:
          stats.descriptionLen < 200
            ? 'Longer descriptions give more keyword context and room for links/timestamps.'
            : 'Description has enough room for context and keywords.'
      },
      {
        ok: stats.lengthSeconds >= 60,
        label: 'Full-length (not a Short)',
        why:
          stats.lengthSeconds < 60
            ? 'Under 60s is treated as a Short — different discovery mechanics than long-form.'
            : 'Standard long-form video — typical SEO and engagement patterns apply.'
      }
    ];
    const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
    return { score, checks };
  }
  function letter(score) {
    return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 55 ? 'D' : 'F';
  }
  function gradeColor(score) {
    return score >= 80 ? '#6ee787' : score >= 55 ? '#ffc15a' : '#ff6a5f';
  }

  // ---- render helpers ----
  function sectionHead(text) {
    const h = el('div', 'un-seo-head');
    h.appendChild(el('span', '', text));
    return h;
  }
  // horizontal bar with a real value, scaled, and a "good" threshold colouring
  // rating relative to the "good" threshold — the vidIQ-style verbal context
  // that turns a bare percentage into "is this number good or not?"
  function rate(pct, good) {
    if (pct == null) return null;
    if (pct >= good) return 'good';
    if (pct >= good * 0.6) return 'avg';
    return 'low';
  }
  const RATE_WORD = { good: 'Strong', avg: 'Average', low: 'Low' };
  function meter(label, pct, scale, good, why, whyBox) {
    const row = el('div', 'un-bar-row' + (why ? ' clickable' : ''));
    const top = el('div', 'un-bar-top');
    top.appendChild(el('span', 'un-bar-label', label));
    const right = el('div', 'un-bar-right');
    const rk = rate(pct, good);
    if (rk) right.appendChild(el('span', 'un-bar-rate ' + rk, RATE_WORD[rk]));
    right.appendChild(el('span', 'un-bar-val', pct != null ? pct.toFixed(2) + '%' : '—'));
    top.appendChild(right);
    row.appendChild(top);
    const track = el('div', 'un-bar-track');
    const fill = el('div', 'un-bar-fill');
    fill.style.width = (pct != null ? Math.min(100, (pct / scale) * 100) : 0) + '%';
    if (rk) fill.classList.add(rk);
    track.appendChild(fill);
    row.appendChild(track);
    if (why && whyBox) {
      right.appendChild(el('span', 'un-why-cue', 'ⓘ'));
      row.title = 'Why this metric?';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-label', label + ' — why this metric?');
      const toggleWhy = () => {
        let w = whyBox.querySelector('.un-eng-why');
        if (!w) {
          w = el('div', 'un-eng-why');
          whyBox.appendChild(w);
        }
        w.textContent = why;
        w.style.display = w.dataset.last === label && w.style.display !== 'none' ? 'none' : '';
        if (w.style.display !== 'none') w.style.display = '';
        w.dataset.last = label;
      };
      row.addEventListener('click', toggleWhy);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWhy(); }
      });
    }
    return row;
  }
  function applySections(root) {
    [['engagement', '.un-sec-engagement'], ['compare', '.un-sec-compare'], ['seo', '.un-sec-seo'], ['tags', '.un-sec-tags'], ['creator', '.un-sec-creator']].forEach((p) => {
      const sec = root.querySelector(p[1]);
      if (sec) sec.style.display = sectionPref[p[0]] === false ? 'none' : '';
    });
  }

  function buildPanel(stats, vid) {
    const root = el('div', 'un-stats');
    // Which video this panel describes. Without it the panel's ownership is
    // unobservable from outside, so a stale-video render could not be asserted
    // on at all — the late-answer guard above had no way to be tested.
    if (vid) root.setAttribute('data-video-id', vid);
    const head = el('div', 'un-stats-head');
    head.appendChild(el('span', 'un-stats-title', '✦ Stats'));
    // Shown only while collapsed (analytics.css): the numbers a closed card owes.
    const sum = el('span', 'un-stats-sum', '');
    head.appendChild(sum);
    const gradeBadge = el('button', 'un-grade', '·');
    gradeBadge.title = 'Overall score (our heuristic) — click for the breakdown';
    gradeBadge.setAttribute('aria-label', gradeBadge.title);
    head.appendChild(gradeBadge);
    head.appendChild(el('span', 'un-stats-tag', 'heuristic'));
    const popBtn = el('button', 'un-stats-pop', '⤢');
    popBtn.title = 'Pop out stats panel';
    popBtn.setAttribute('aria-label', popBtn.title);
    popBtn.type = 'button';
    head.appendChild(popBtn);
    const gear = el('button', 'un-stats-gear', '⚙');
    gear.title = 'Choose what shows';
    gear.setAttribute('aria-label', gear.title);
    head.appendChild(gear);
    head.appendChild(el('span', 'un-stats-caret', '▾'));
    root.appendChild(head);

    const settings = el('div', 'un-stats-settings');
    root.appendChild(settings);
    const body = el('div', 'un-stats-body');

    head.addEventListener('click', (e) => {
      if (e.target === gear || e.target === gradeBadge || e.target === popBtn) return;
      const collapsed = root.classList.toggle('collapsed');
      collapsedPref = collapsed;
      chrome.storage.local.set({ statsCollapsed: collapsed });
    });
    if (collapsedPref) root.classList.add('collapsed');
    popBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.getElementById('un-stats-float');
      const existingBd = document.getElementById('un-stats-float-backdrop');
      if (existing) {
        existing.remove();
        if (existingBd) existingBd.remove();
        return;
      }
      const float = root.cloneNode(true);
      float.id = 'un-stats-float';
      float.classList.add('floating');
      float.classList.remove('collapsed');
      // cloneNode copies structure but not listeners, so every control in the
      // clone is dead. Neutralize them so they don't look clickable (the close
      // button is re-enabled below).
      float.querySelectorAll('button, select, input, [role="button"]').forEach((c) => {
        c.style.pointerEvents = 'none';
        c.style.opacity = '0.5';
        if ('disabled' in c) c.disabled = true;
      });
      const hint = document.createElement('p');
      hint.className = 'un-stats-float-hint';
      hint.textContent = 'Read-only preview — controls are disabled here; use the sidebar panel for live updates and compare.';
      float.querySelector('.un-stats-body').prepend(hint);
      const backdrop = document.createElement('div');
      backdrop.className = 'un-stats-float-backdrop';
      backdrop.id = 'un-stats-float-backdrop';
      backdrop.addEventListener('click', () => {
        float.remove();
        backdrop.remove();
      });
      const close = float.querySelector('.un-stats-pop');
      if (close) {
        close.style.pointerEvents = '';
        close.style.opacity = '';
        close.disabled = false;
        close.textContent = '×';
        close.title = 'Close';
        close.addEventListener('click', (ev) => {
          ev.stopPropagation();
          float.remove();
          backdrop.remove();
        });
      }
      document.body.appendChild(backdrop);
      document.body.appendChild(float);
    });
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      root.classList.toggle('settings-open');
    });

    const views = Number(stats.viewCount) || 0;
    const days = ageDays(stats.publishDate);
    const perDay = days && days >= 1 ? views / days : views;
    const hours = ageHours(stats.publishDate);
    const recent = hours != null && hours < 48;
    const vph = hours && hours >= 1 ? views / hours : null;
    const dateSub = stats.publishDate ? fmtDate(stats.publishDate) : days ? Math.round(days) + ' days old' : '';
    const seo = computeSEO(stats);
    // these load lazily on YouTube (likes after the button renders, comments
    // only after you scroll) — so they start null and updateLive() refreshes.
    let likes = scrapeLikes();
    let dislikes = null;
    let comments = scrapeComments();
    let subs = scrapeSubs();

    function applyRyd(votes) {
      if (!votes || !votes.ok) return;
      if (votes.likes != null) likes = votes.likes;
      dislikes = votes.dislikes;
      renderLive();
    }
    if (vid) {
      chrome.runtime.sendMessage({ type: 'UNSYNTH/RYD/VOTES', videoId: vid }, (r) => {
        if (chrome.runtime.lastError) return;
        if (r && r.ok) applyRyd(r);
      });
    }
    // Stored at module scope + replaced each build so navigations don't stack
    // a new listener every time (removed in remove()/teardown).
    if (rydHandler) window.removeEventListener('unsynth-ryd-votes', rydHandler);
    rydHandler = function (e) {
      if (!e.detail || e.detail.videoId !== vid) return;
      applyRyd(e.detail.votes);
    };
    window.addEventListener('unsynth-ryd-votes', rydHandler);

    // a click drawer that expands more about whichever stat cell you tap
    const detail = el('div', 'un-stat-detail');
    detail.style.display = 'none';
    let openKey = null;
    function statDetail(key) {
      const lr = likes && views ? (likes / views) * 100 : null;
      const cpk = comments && views ? (comments / views) * 1000 : null;
      switch (key) {
        case 'views': {
          let s = fmt(views) + ' total';
          if (vph != null) s += ' · ≈ ' + fmt(Math.round(vph)) + '/hr';
          if (days) s += ' · ≈ ' + fmt(Math.round(perDay)) + '/day';
          if (recent && vph) s += ' · on pace for ~' + fmt(Math.round(views + vph * 24 * 30)) + ' in 30 days';
          return s;
        }
        case 'velocity':
          return recent
            ? 'Views per hour since upload' + (vph != null ? ' — ≈ ' + fmt(Math.round(vph)) + '/hr.' : '.')
            : 'Average views per day over its lifetime' + (vph != null ? ' (lifetime ≈ ' + fmt(Math.round(vph)) + '/hr).' : '.');
        case 'likes':
          return likes == null
            ? 'Likes appear once the like button renders or RYD loads.'
            : fmt(likes) +
                ' likes' +
                (dislikes != null ? ' · ' + fmt(dislikes) + ' dislikes (RYD)' : ' · dislikes hidden by YouTube');
        case 'dislikes':
          return dislikes == null
            ? 'Dislike counts come from Return YouTube Dislike when that module is on.'
            : fmt(dislikes) +
                ' dislikes · ' +
                (likes && dislikes ? (((likes / (likes + dislikes)) * 100).toFixed(1) + '% liked') : '—');
        case 'comments':
          return comments == null ? 'Comment count loads when you scroll to the comments.' : fmt(comments) + ' comments · ' + (cpk != null ? cpk.toFixed(1) + ' per 1,000 views.' : '');
        case 'length': {
          const L = stats.lengthSeconds || 0;
          const kind = L < 60 ? 'Short' : L < 240 ? 'Quick watch' : L < 1200 ? 'Standard' : 'Long-form';
          return fmtDur(L) + ' · ' + kind + '.';
        }
        case 'channel': {
          if (subs == null) return 'Subscriber count from the channel byline.';
          const reach = subs ? (views / subs) * 100 : null;
          return fmt(subs) + ' subscribers · views ≈ ' + (reach != null ? Math.round(reach) + '%' : '—') + ' of the sub count.';
        }
        default:
          return '';
      }
    }
    function toggleDetail(key, cell) {
      grid.querySelectorAll('.un-stat.active').forEach((c) => c.classList.remove('active'));
      if (openKey === key) {
        openKey = null;
        detail.style.display = 'none';
        return;
      }
      openKey = key;
      cell.classList.add('active');
      detail.textContent = statDetail(key);
      detail.style.display = '';
    }

    const grid = el('div', 'un-stats-grid');
    const stat = (label, val, sub, key) => {
      const d = el('div', 'un-stat' + (key ? ' clickable' : ''));
      d.appendChild(el('div', 'un-stat-l', label));
      d.appendChild(el('div', 'un-stat-v', val));
      d.appendChild(el('div', 'un-stat-s', sub || '')); // always present so we can update it
      if (key) {
        d.setAttribute('role', 'button');
        d.setAttribute('tabindex', '0');
        d.setAttribute('aria-label', label + ': show details');
        d.addEventListener('click', () => toggleDetail(key, d));
        d.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDetail(key, d); }
        });
      }
      return d;
    };
    const likeStat = stat('Likes', '—', '', 'likes');
    const dislikeStat = stat('Dislikes', '—', 'RYD', 'dislikes');
    const commentStat = stat('Comments', '—', '', 'comments');
    const channelStat = stat('Channel', '—', '', 'channel');
    // ORDER BY WHAT YOUTUBE DOES NOT ALREADY SHOW.
    //
    // An independent IA review applied the obvious test: views, likes, length
    // and subscriber count are all printed by YouTube a few hundred pixels
    // left of this panel. Only dislikes, the velocity figure and the derived
    // ratios are net-new — so a grid that opened with Views was leading with
    // the most redundant thing on screen and burying the reason the panel
    // exists.
    //
    // Dislikes first, then velocity, then comments. The host duplicates go
    // last, where they serve as context rather than as the headline. They are
    // not deleted: seeing likes beside dislikes is what makes the ratio
    // readable, and length beside views is what makes the velocity readable.
    grid.appendChild(dislikeStat);
    grid.appendChild(
      recent
        ? stat('Views / hr', vph != null ? fmt(Math.round(vph)) : '—', hours < 24 ? Math.round(hours) + 'h old' : Math.round(hours / 24) + 'd old', 'velocity')
        : stat('Avg / day', days ? fmt(Math.round(perDay)) : '—', dateSub, 'velocity')
    );
    grid.appendChild(likeStat);
    grid.appendChild(commentStat);
    grid.appendChild(stat('Views', fmt(views), '', 'views'));
    // Length dropped: the runtime strip 300px away prints "Full length 18:40"
    // already, and seven cells in a 2-column grid left one empty grey cell.
    grid.appendChild(channelStat);
    body.appendChild(grid);
    body.appendChild(detail);

    // grade breakdown drawer (toggled by the header badge)
    const breakdown = el('div', 'un-grade-bd');
    breakdown.style.display = 'none';
    body.appendChild(breakdown);
    function computeGrade() {
      if (likes == null) return null;
      const er = views ? ((likes + (comments || 0)) / views) * 100 : 0;
      const lr = views ? (likes / views) * 100 : 0;
      const likeRatioPct = likes != null && dislikes != null && likes + dislikes > 0 ? (likes / (likes + dislikes)) * 100 : null;
      const engScore = Math.min(50, (er / 5) * 50);
      const seoScore = (seo.score / 100) * 30;
      const likeScore = likeRatioPct != null ? Math.min(20, (likeRatioPct / 95) * 20) : Math.min(20, (lr / 3) * 20);
      const total = Math.round(engScore + seoScore + likeScore);
      const parts = [
        {
          name: 'Engagement',
          score: Math.round(engScore),
          max: 50,
          why:
            'Likes + comments are ' +
            er.toFixed(2) +
            '% of views. Full 50 pts at 5% combined engagement — measures how much viewers reacted.'
        },
        {
          name: 'SEO',
          score: Math.round(seoScore),
          max: 30,
          why:
            'Metadata checklist scored ' +
            seo.score +
            '/100 (title, tags, description, format). Worth up to 30 pts of the overall grade.'
        },
        {
          name: 'Like ratio',
          score: Math.round(likeScore),
          max: 20,
          why:
            likeRatioPct != null
              ? likeRatioPct.toFixed(1) + '% liked (RYD likes ÷ likes+dislikes). Full 20 pts at 95%+.'
              : (lr != null ? lr.toFixed(2) : '0') + '% of viewers liked. Full 20 pts at 3% like rate.'
        }
      ];
      return { total, letter: letter(total), color: gradeColor(total), parts };
    }
    let gradeWhy = null;
    function showGradeWhy(text) {
      let w = breakdown.querySelector('.un-grade-why');
      if (!w) {
        w = el('div', 'un-grade-why');
        breakdown.appendChild(w);
      }
      if (gradeWhy === text) {
        gradeWhy = null;
        w.style.display = 'none';
        return;
      }
      gradeWhy = text;
      w.textContent = text;
      w.style.display = '';
    }
    function renderBreakdown(g) {
      breakdown.textContent = '';
      const head = el('div', 'un-grade-bd-h', 'Score ' + g.total + '/100 — our heuristic');
      head.title = 'Click components below for why each matters';
      breakdown.appendChild(head);
      breakdown.appendChild(
        el(
          'div',
          'un-grade-summary',
          'A = 90+, B = 80+, C = 70+, D = 55+, F = below. Not vidIQ — computed from this page only.'
        )
      );
      g.parts.forEach((part) => {
        const row = el('div', 'un-grade-row clickable');
        row.appendChild(el('span', 'un-grade-rl', part.name));
        const track = el('div', 'un-grade-track');
        const fill = el('div', 'un-grade-fill');
        fill.style.width = Math.round((part.score / part.max) * 100) + '%';
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('span', 'un-grade-rv', part.score + '/' + part.max));
        row.title = 'Why this score?';
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-label', part.name + ' score — why?');
        const showWhy = (e) => {
          if (e) e.stopPropagation();
          showGradeWhy(part.why);
        };
        row.addEventListener('click', showWhy);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showWhy(); }
        });
        breakdown.appendChild(row);
      });
    }
    gradeBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!gradeBadge.classList.contains('has')) return;
      const open = breakdown.style.display === 'none';
      breakdown.style.display = open ? '' : 'none';
      if (open) {
        const g = computeGrade();
        if (g) showGradeWhy('Overall ' + g.letter + ' (' + g.total + '/100). Tap each bar for how that part was calculated.');
      } else gradeWhy = null;
    });

    // bridge to the AI popout (per the chosen layout)
    const sumBtn = el('button', 'un-stats-sumbtn', '✦ Summarize with AI');
    sumBtn.addEventListener('click', () => window.dispatchEvent(new CustomEvent('unsynth-ai-open', { detail: { summarize: true } })));
    body.appendChild(sumBtn);
    if (FL && FL.similarSearchQuery && videoId()) {
      const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string.ytd-watch-metadata');
      const title = titleEl ? titleEl.textContent.trim() : '';
      const chEl = document.querySelector('#owner #channel-name a, ytd-channel-name a, ytd-video-owner-renderer a');
      const channel = chEl ? chEl.textContent.trim() : '';
      const forgeBtn = el('button', 'un-stats-forge', 'Find similar in Forge');
      forgeBtn.type = 'button';
      forgeBtn.title = 'Search for similar videos in the Forge panel';
      forgeBtn.setAttribute('aria-label', forgeBtn.title);
      forgeBtn.addEventListener('click', () => {
        if (window.UNForge && window.UNForge.openSimilar) {
          window.UNForge.openSimilar(videoId(), title, channel);
        } else if (FL.forgeSeed) {
          window.open(FL.forgeSeed(videoId(), { title: title, auto: true }), '_blank', 'noopener');
        }
      });
      body.appendChild(forgeBtn);
    }

    // engagement bars (rebuilt by updateLive as likes/comments load)
    const engSec = el('div', 'un-stats-sec un-sec-engagement');
    engSec.appendChild(sectionHead('Engagement'));
    const engBody = el('div', 'un-eng-body');
    engSec.appendChild(engBody);
    body.appendChild(engSec);

    const compareSec = el('div', 'un-stats-sec un-sec-compare');
    const cmpHead = sectionHead('Compare');
    const cmpBtn = el('button', 'un-stats-copy', 'Expand');
    cmpHead.appendChild(cmpBtn);
    compareSec.appendChild(cmpHead);
    const cmpBody = el('div', 'un-compare-inline');
    cmpBody.hidden = true;
    compareSec.appendChild(cmpBody);
    let cmpLoaded = false;
    cmpBtn.addEventListener('click', async () => {
      if (!cmpBody.hidden) {
        cmpBody.hidden = true;
        cmpBtn.textContent = 'Expand';
        return;
      }
      cmpBtn.textContent = 'Loading…';
      cmpBody.hidden = false;
      if (!cmpLoaded && window.UNStatsCompareUI) {
        try {
          const data = await UNStatsCompareUI.loadCompareData(
            { ok: true, videoId: vid, likes: likes, dislikes: dislikes },
            views
          );
          cmpBody.textContent = '';
          if (data) {
            cmpBody.appendChild(
              UNStatsCompareUI.buildPanelContent(data.current, data.channelAgg, data.relatedList, data.relatedAgg)
            );
          } else {
            cmpBody.appendChild(el('div', 'un-stats-none', 'Could not load comparison.'));
          }
          cmpLoaded = true;
        } catch (e) {
          // Never strand the button on 'Loading…' — let the user retry.
          cmpBody.textContent = '';
          cmpBody.appendChild(el('div', 'un-stats-none', 'Failed to load — click to retry.'));
          cmpBtn.textContent = 'Expand';
          cmpBody.hidden = true;
          return;
        }
      }
      cmpBtn.textContent = 'Collapse';
    });
    body.appendChild(compareSec);

    function setStat(cell, val, sub) {
      cell.querySelector('.un-stat-v').textContent = val;
      cell.querySelector('.un-stat-s').textContent = sub || '';
    }
    let snapshotSaved = false;
    function maybeSaveSnapshot() {
      if (snapshotSaved || !vid || !window.UNStatsCompareUI) return;
      if (!views) return;
      snapshotSaved = true;
      UNStatsCompareUI.saveSnapshot({
        videoId: vid,
        title: stats.title,
        channelId: stats.channelId,
        channelName: stats.author,
        viewCount: views,
        likes: likes,
        dislikes: dislikes,
        comments: comments,
        publishDate: stats.publishDate,
        lengthSeconds: stats.lengthSeconds
      });
    }

    function renderLive() {
      const lr = likes && views ? (likes / views) * 100 : null;
      const cr = comments && views ? (comments / views) * 100 : null;
      const likeRatioPct = likes != null && dislikes != null && likes + dislikes > 0 ? (likes / (likes + dislikes)) * 100 : null;
      setStat(likeStat, likes != null ? fmt(likes) : '—', lr != null ? lr.toFixed(1) + '% of views' : 'not loaded yet');
      setStat(
        dislikeStat,
        dislikes != null ? fmt(dislikes) : '—',
        likeRatioPct != null ? likeRatioPct.toFixed(1) + '% liked' : 'RYD loading…'
      );
      setStat(commentStat, comments != null ? fmt(comments) : '—', comments != null ? '' : 'not loaded yet');
      setStat(channelStat, subs != null ? fmt(subs) : '—', subs != null ? 'subscribers' : '');
      sum.textContent = [
        views ? fmt(views) + ' views' : '',
        likes != null ? fmt(likes) + ' likes' : '',
        dislikes != null ? fmt(dislikes) + ' dislikes' : ''
      ].filter(Boolean).join(' · ');
      // Combined engagement rate: (likes + comments) / views.
      //
      // NULL UNTIL COMMENTS ARE KNOWN, not "likes only". comments is null until
      // the user scrolls far enough for YouTube to render the comment count —
      // the panel says "scroll to load" right above this. Treating null as 0
      // made this metric collapse to exactly likes/view, then judged it against
      // a 4% threshold while the identical number was judged against 2% one row
      // below: the same 2.31% shipped as LOW and STRONG simultaneously.
      // A metric that cannot be computed reports that it cannot be computed.
      const er = likes != null && views && comments != null
        ? ((likes + comments) / views) * 100
        : null;
      engBody.textContent = '';
      engBody.appendChild(
        meter(
          'Engagement rate',
          er,
          8,
          4,
          'Combined (likes + comments) ÷ views. Green at 4%+; scales to 8% for full bar.',
          engBody
        )
      );
      // "Likes / view" is not rendered here: the LIKES tile already prints
      // "2.3% of views" as its sub-label, forty pixels away, and the meter
      // restated it to two decimal places. One number, one place.
      if (likeRatioPct != null) {
        engBody.appendChild(
          meter('Like ratio (RYD)', likeRatioPct, 100, 90, 'Likes ÷ (likes + dislikes) from Return YouTube Dislike. Green at 90%+.', engBody)
        );
      }
      engBody.appendChild(meter('Comments / view', cr, 0.5, 0.2, 'Comment count ÷ views. Green at 0.2%+; full bar at 0.5%.', engBody));
      // headline grade badge + breakdown
      const g = computeGrade();
      if (g) {
        gradeBadge.textContent = g.letter;
        gradeBadge.style.setProperty('--gc', g.color);
        gradeBadge.classList.add('has');
        renderBreakdown(g);
      } else {
        gradeBadge.textContent = '·';
        gradeBadge.classList.remove('has');
      }
      if (openKey) detail.textContent = statDetail(openKey);
      maybeSaveSnapshot();
    }
    renderLive();
    // re-scrape on each scan; YouTube fills these in after load / on scroll
    liveUpdate = function () {
      const nl = scrapeLikes(), nc = scrapeComments(), ns = scrapeSubs();
      let changed = false;
      if (nl != null && nl !== likes) { likes = nl; changed = true; }
      if (nc != null && nc !== comments) { comments = nc; changed = true; }
      if (ns != null && ns !== subs) { subs = ns; changed = true; }
      if (changed) renderLive();
    };

    // SEO ring + checklist (uses the `seo` computed above)
    const seoSec = el('div', 'un-stats-sec un-sec-seo');
    const seoTop = el('div', 'un-seo-top');
    const ring = el('div', 'un-ring clickable');
    ring.title = 'SEO score — click checklist items for why';
    ring.style.setProperty('--pct', seo.score);
    ring.style.setProperty('--col', seo.score >= 75 ? '#6ee787' : seo.score >= 50 ? '#ffc15a' : '#ff6a5f');
    ring.appendChild(el('span', '', String(seo.score)));
    seoTop.appendChild(ring);
    const checks = el('div', 'un-seo-checks');
    checks.appendChild(el('div', 'un-seo-label', 'SEO score'));
    let seoWhy = null;
    function showSeoWhy(text) {
      let w = checks.querySelector('.un-seo-why');
      if (!w) {
        w = el('div', 'un-seo-why');
        checks.appendChild(w);
      }
      if (seoWhy === text) {
        seoWhy = null;
        w.style.display = 'none';
        return;
      }
      seoWhy = text;
      w.textContent = text;
      w.style.display = '';
    }
    ring.addEventListener('click', () => {
      showSeoWhy('SEO is ' + seo.score + '/100 from 4 checks: title length, tag count, description length, and video format.');
    });
    seo.checks.forEach((c) => {
      const row = el('div', 'un-seo-row clickable');
      const mark = el('span', 'un-seo-mark ' + (c.ok ? 'y' : 'n'), c.ok ? '✓' : '✗');
      // Decorative now that the label states the result: left readable it is
      // either announced as punctuation or duplicated.
      mark.setAttribute('aria-hidden', 'true');
      row.appendChild(mark);
      row.appendChild(el('span', 'un-seo-text', c.label));
      const cue = el('span', 'un-why-cue', 'ⓘ');
      cue.setAttribute('aria-hidden', 'true');
      row.appendChild(cue);
      row.title = 'Why this check?';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      // The pass/fail is carried by a ✓ / ✗ glyph, which a screen reader reads
      // as punctuation or skips entirely — so the one thing the row exists to
      // say was the one thing it did not announce. The result goes into the
      // label, ahead of the affordance.
      row.setAttribute('aria-label',
        (c.ok ? 'Passed: ' : 'Failed: ') + c.label + ' — why this check?');
      row.addEventListener('click', () => showSeoWhy(c.why));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showSeoWhy(c.why); }
      });
      checks.appendChild(row);
    });
    seoTop.appendChild(checks);
    seoSec.appendChild(seoTop);
    body.appendChild(seoSec);

    // tags
    const tagSec = el('div', 'un-stats-sec un-sec-tags');
    if ((stats.keywords || []).length) {
      const th = sectionHead('Tags (' + stats.keywords.length + ')');
      const copy = el('button', 'un-stats-copy', 'Copy');
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(stats.keywords.join(', '));
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1000);
      });
      th.appendChild(copy);
      tagSec.appendChild(th);
      const tw = el('div', 'un-stats-tags');
      stats.keywords.slice(0, 25).forEach((t) => tw.appendChild(el('span', 'un-stats-tagchip', t)));
      tagSec.appendChild(tw);
    } else {
      tagSec.appendChild(el('div', 'un-stats-none', 'No tags on this video.'));
    }
    body.appendChild(tagSec);

    const creatorSec = el('div', 'un-stats-sec un-sec-creator');
    const cHead = sectionHead('Keyword research');
    creatorSec.appendChild(cHead);
    const kwWrap = el('div', 'un-stats-tags');
    const CS = window.UNCreatorStudio;
    if (CS) {
      // FILTER THE TOKENIZER OUTPUT.
      //
      // suggestFromPage returns n-grams straight from the title, which on a real
      // video produced chips reading "network? |", "| deep" and "chapter 1" —
      // punctuation and sentence fragments shipped as suggested keywords. An
      // independent reviewer called it "shipping the tokenizer", correctly.
      // A keyword a creator would actually track has no punctuation, is not a
      // bare number, and is more than one character.
      const usableKeyword = (k) => {
        const t = String(k || '').trim();
        if (t.length < 3) return false;
        // Punctuation means the n-gram straddled a sentence or title boundary.
        if (/[|?!,;:"(){}[\]]/.test(t)) return false;
        if (/^\d+$/.test(t)) return false;
        // A trailing bare number is a chapter index, not a search term.
        if (/\s\d{1,2}$/.test(t)) return false;
        return true;
      };
      CS.suggestFromPage(stats.title, stats.keywords, '')
        .filter((s2) => usableKeyword(s2 && s2.keyword))
        .forEach(({ keyword }) => {
        const chip = el('span', 'un-stats-tagchip un-kw-chip', keyword);
        chip.title = 'Click to track rank for this keyword';
        chip.addEventListener('click', () => {
          chrome.storage.local.get({ creatorRankTracks: [] }, (d) => {
            const res = CS.addRankTrack(d.creatorRankTracks, {
              keyword,
              videoId: vid,
              videoTitle: stats.title || vid
            });
            chrome.storage.local.set({ creatorRankTracks: res.tracks }, () => {
              chip.textContent = keyword + ' ✓';
            });
          });
        });
        kwWrap.appendChild(chip);
      });
    }
    creatorSec.appendChild(kwWrap);
    const rankRow = el('div', 'un-creator-actions');
    const rankBtn = el('button', 'un-stats-copy', 'Check rank');
    rankBtn.addEventListener('click', () => {
      const kw = (stats.title || '').split(/\s+/).slice(0, 4).join(' ');
      rankBtn.textContent = '…';
      chrome.runtime.sendMessage({ type: 'UNSYNTH/CREATOR/RANK_CHECK', keyword: kw, videoId: vid }, (r) => {
        rankBtn.textContent = r && r.rank != null ? 'Rank #' + r.rank : 'Not in top 50';
        setTimeout(() => (rankBtn.textContent = 'Check rank'), 2500);
      });
    });
    rankRow.appendChild(rankBtn);
    creatorSec.appendChild(rankRow);
    body.appendChild(creatorSec);

    root.appendChild(body);

    // settings: toggle which sections show
    [['engagement', 'Engagement'], ['compare', 'Compare videos'], ['seo', 'SEO score'], ['tags', 'Tags'], ['creator', 'Keyword research']].forEach((p) => {
      const lbl = el('label', 'un-set-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sectionPref[p[0]] !== false;
      cb.addEventListener('change', () => {
        sectionPref[p[0]] = cb.checked;
        chrome.storage.local.set({ statsSections: sectionPref });
        applySections(root);
      });
      lbl.appendChild(cb);
      lbl.appendChild(el('span', '', p[1]));
      settings.appendChild(lbl);
    });
    applySections(root);

    return root;
  }

  // The Stats tab of the side panel (2026-09-21): depth opens beside the
  // video, and the deck's Stats header is the launcher. The old placement —
  // a card inserted at the top of the related column — is the fallback for a
  // page with no host.
  const SP = () => (window.UNSidePanel && window.UNSidePanel.register ? window.UNSidePanel : null);
  function registerTab() {
    const sp = SP();
    if (sp) sp.register({ id: 'stats', label: 'Stats', order: 10 });
  }
  function wireDeckLauncher() {
    const deck = window.UNWatchDeck;
    const sp = SP();
    // toggle, not open: the header announces aria-expanded, so a second click
    // closes what the first opened (creator-guide.spec.js pins exactly that).
    if (deck && deck.setLauncher && sp) deck.setLauncher('stats', function () { sp.toggle('stats'); });
  }
  function insertPanel() {
    if (!panel) return;
    registerTab();
    const sp = SP();
    const host = sp ? sp.body('stats') : null;
    if (host) {
      if (panel.parentNode !== host) host.appendChild(panel);
      wireDeckLauncher();
      return;
    }
    const YD = window.UNYtDom;
    const sec = YD ? (document.querySelector(YD.WATCH_SIDE_COLUMN_SEL) || document.querySelector(YD.WATCH_SIDE_OUTER_SEL)) : null;
    if (sec && panel.parentNode !== sec) sec.insertBefore(panel, sec.firstChild);
  }

  // ---- publish-date chip, next to the title ----
  //
  // YouTube shows the upload date only inside the collapsed description, as
  // relative text ("20 years ago"). Measured on a real watch page: the title
  // renders at y=684 and the date at y=1111 — over 400px down, below the fold,
  // and it takes a click to turn into an actual date. So "when was this
  // published" needs a scroll and an expand, every time.
  //
  // The chip puts the real date beside the title.
  //
  // SOURCE, and the trap that cost a rewrite here: the obvious source is the
  // `meta[itemprop="datePublished"]` tag, which is in the ordinary DOM and
  // readable straight from the isolated world. It is also WRONG on any SPA
  // navigation — measured live, clicking a related video changed
  // location.href but left that meta tag (and the ld+json blob) pinned to the
  // FIRST video's date, still stale ten seconds later. A chip built on it
  // showed "Apr 23, 2005" on every subsequent video.
  //
  // The player response is the only source observed to actually follow
  // navigation (movie_player.getPlayerResponse(), which ai-bridge.js already
  // exposes over UN_STATS_REQ — verified 2005 -> 2026 across a related-video
  // click). So the bridge is the real source; the meta tag is kept only as a
  // first-paint fallback on a cold load, where it is not yet stale and the
  // bridge may not have answered.
  const DATE_CHIP_ID = 'un-pubdate-chip';
  // Cached per video id so a scan does not re-ask the bridge on every mutation.
  let pubDateVid = null;
  let pubDateAt = null;
  let pubDatePending = false;

  function currentWatchId() {
    try {
      // Channel live URLs carry no ?v= (2026-09-23).
      return new URL(location.href).searchParams.get('v') || (window.UNYtDom && window.UNYtDom.liveChannelVideoId ? window.UNYtDom.liveChannelVideoId() : '') || null;
    } catch (e) {
      return null;
    }
  }

  function readPublishedMeta() {
    const m = document.querySelector(
      'meta[itemprop="datePublished"], meta[itemprop="uploadDate"]'
    );
    const raw = m && m.getAttribute('content');
    if (!raw) return null;
    const t = Date.parse(raw);
    return isNaN(t) ? null : t;
  }

  /**
   * Resolve the publish date for the video on screen, preferring the bridge.
   * Returns a timestamp immediately when one is already known for this video,
   * and otherwise kicks off one bridge request and repaints when it lands.
   */
  function resolvePublished() {
    const vid = currentWatchId();
    if (!vid) return null;
    if (pubDateVid === vid && pubDateAt != null) return pubDateAt;

    if (!pubDatePending) {
      pubDatePending = true;
      requestStats()
        .then((d) => {
          pubDatePending = false;
          // Ignore a late answer for a video the user has already left.
          if (currentWatchId() !== vid) return;
          const t = d && d.publishDate ? Date.parse(d.publishDate) : NaN;
          if (isNaN(t)) return;
          pubDateVid = vid;
          pubDateAt = t;
          renderDateChip();
        })
        .catch(() => {
          pubDatePending = false;
        });
    }

    // Cold load: the meta tag is still correct before any SPA navigation has
    // happened, so it fills the gap until the bridge answers. Only trusted
    // when nothing has been resolved yet for a previous video, because that is
    // exactly the case where it is known to go stale.
    if (pubDateVid === null) {
      const meta = readPublishedMeta();
      if (meta != null) return meta;
    }
    return null;
  }

  // Shared with the watch stats row so the two can never disagree about the
  // age of the same video. Local fallback only if ryd.js somehow is not up.
  function relativeAge(t) {
    if (window.UNRyd && UNRyd.relativeAge) return UNRyd.relativeAge(t);
    const days = Math.max(0, (Date.now() - t) / 86400000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 30) return Math.floor(days) + 'd ago';
    if (days < 365) return Math.max(1, Math.floor(days / 30)) + 'mo ago';
    const yrs = days / 365;
    return (yrs < 10 ? String(Math.floor(yrs * 10) / 10) : Math.floor(yrs)) + 'y ago';
  }

  // One observer for the life of the page: the stats row can arrive well after
  // this chip paints, and whoever gets there second has to resolve the tie.
  let statsRowObserver = null;
  function watchForStatsRow() {
    if (statsRowObserver) return;
    statsRowObserver = new MutationObserver(function () {
      if (document.querySelector('#un-vid-stats .un-vs-date')) {
        removeDateChip();
        statsRowObserver.disconnect();
        statsRowObserver = null;
      }
    });
    statsRowObserver.observe(document.body, { childList: true, subtree: true });
  }

  function removeDateChip() {
    const old = document.getElementById(DATE_CHIP_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  function renderDateChip() {
    // RETIRED 2026-09-21. The owner row already prints "Published <date>", now
    // with the relative age too (dislike-restore.js), and the stats grid shows
    // the date under Avg/day — this chip was the third copy of one fact on a
    // single screen. It also collided with the sidebar hub at 125%+ zoom
    // (measured by zoom-reflow.spec.js). Kept as a function so every caller
    // stays valid; it now only guarantees the chip is gone.
    removeDateChip();
    if (true) return;
    if (!isWatch()) {
      removeDateChip();
      return;
    }
    // A chip left over from the previous video must go the moment the URL
    // changes, even if a scan lands before onNavigate does. Without this the
    // old date stays visible under the new title for as long as the bridge
    // takes to answer, which reads as a wrong date rather than a pending one.
    const vid = currentWatchId();
    const existing = document.getElementById(DATE_CHIP_ID);
    if (existing && existing.dataset.vid && existing.dataset.vid !== vid) removeDateChip();

    // The watch stats row (dislike-restore) now carries the upload date beside
    // likes/ratio/views, which is where it was asked to live. Standing down
    // here rather than deleting this chip keeps the date visible for anyone
    // who has that row turned off — and stops it rendering twice for everyone
    // who has it on.
    if (document.querySelector('#un-vid-stats .un-vs-date')) {
      removeDateChip();
      return;
    }
    // The stats row is built by a different module and often lands AFTER this
    // chip, so the check above can pass on first paint and leave both on
    // screen — reproduced as dateNodeCount: 2 on roughly half of cold loads.
    // Watch for the row arriving and stand down then.
    watchForStatsRow();
    const t = resolvePublished();
    if (t == null) return; // no date yet — the bridge reply repaints when it lands
    // Anchor to the title's container so the chip sits on the title line.
    // Selector lives in shared/yt-dom.js, not inline here — see
    // test/selector-centralization.test.js for why every renderer name belongs
    // in one file.
    const YTD = window.UNYtDom || null;
    const title = YTD && YTD.watchTitleRoot ? YTD.watchTitleRoot() : null;
    if (!title) return;

    const exact = new Date(t).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const label = exact + ' · ' + relativeAge(t);

    let chip = document.getElementById(DATE_CHIP_ID);
    if (
      chip &&
      chip.dataset.for === String(t) &&
      chip.dataset.vid === (vid || '') &&
      chip.parentNode === title
    ) {
      return;
    }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = DATE_CHIP_ID;
      chip.className = 'un-pubdate-chip';
    }
    chip.dataset.for = String(t);
    chip.dataset.vid = vid || '';
    chip.textContent = label;
    // A date is information, not a control: expose it as text with a full
    // timestamp on hover rather than pretending it is interactive.
    chip.title = 'Published ' + new Date(t).toLocaleString();
    if (chip.parentNode !== title) title.appendChild(chip);
  }

  function remove() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    removeDateChip();
    if (rydHandler) {
      window.removeEventListener('unsynth-ryd-votes', rydHandler);
      rydHandler = null;
    }
  }

  async function render() {
    if (!isWatch()) {
      remove();
      lastVideo = null;
      return;
    }
    const vid = videoId();
    if (!vid || (vid === lastVideo && panel && document.body.contains(panel))) {
      insertPanel();
      return;
    }
    if (building) return;
    building = true;
    try {
      const stats = await requestStats();
      // Ignore a late answer for a video the user has already left. Without it
      // the panel renders A's numbers onto B AND stamps lastVideo = A, so the
      // freshness check above then suppresses the corrective re-render and the
      // wrong panel persists for the rest of the visit. resolvePublished()
      // earlier in this file has always done this; the panel path did not.
      if (videoId() !== vid) return;
      if (!stats || !stats.viewCount) {
        building = false;
        return;
      }
      remove();
      lastVideo = vid;
      panel = buildPanel(stats, vid);
      insertPanel();
    } finally {
      building = false;
    }
  }

  const mod = {
    id: 'analytics',
    moduleKey: 'analytics',
    init(c) {
      core = c;
      chrome.storage.local.get(['statsCollapsed', 'statsSections'], (d) => {
        collapsedPref = d && d.statsCollapsed != null ? !!d.statsCollapsed : true;
        sectionPref = (d && d.statsSections) || {};
        render();
      });
    },
    scan() {
      // The date chip is independent of the stats panel: it reads a meta tag,
      // so it must still appear when the panel is absent (no API key, quota
      // spent, or the panel simply not built yet). Cheap enough to reconcile
      // every scan — it early-returns once the chip matches the current video.
      renderDateChip();
      // re-insert if YouTube wiped the column, or build if missing
      if (isWatch()) {
        if (!panel || !document.body.contains(panel)) render();
        else {
          insertPanel();
          // Live scrape is cheap but not free — coalesce while player chromes churn.
          if (liveUpdate && !liveUpdateTimer) {
            liveUpdateTimer = setTimeout(function () {
              liveUpdateTimer = null;
              if (liveUpdate && panel && document.body.contains(panel)) liveUpdate();
            }, 1500);
          }
        }
      }
    },
    onNavigate() {
      // Drop the previous video's date immediately rather than leaving it on
      // screen while the new one resolves — a stale date that looks confident
      // is worse than no date. Clearing the cache is what forces a fresh
      // bridge lookup instead of reusing the last video's answer.
      pubDateVid = null;
      pubDateAt = null;
      removeDateChip();
      renderDateChip();
      render();
    },
    // Core skips scan/onSettings for a just-disabled module, so remove the
    // overlay here instead of leaving it until the next page reload.
    teardown: remove
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
