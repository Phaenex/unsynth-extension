'use strict';

/**
 * Unsynth Stats page.
 * Reads the aggregate `watchStats` / `searchStats` blobs that the dashboard
 * importer builds from a Google Takeout export and renders them as a set of
 * self-contained SVG/DOM visualisations. No external libraries, no network.
 */
(function () {
  if (window.UNBrowserEnv) UNBrowserEnv.applyCopy();
  if (window.UNOpenPage) UNOpenPage.bindExternalLinks();
  const SVGNS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const ACCENT = getComputedStyle(document.documentElement).getPropertyValue('--un-accent').trim() || '#ff5a5f';
  const AMBER = '#ffc14d';

  function fetchWithTimeout(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
    return fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal })).finally(() => clearTimeout(timer));
  }

  const nf = (n) => (n == null ? '0' : Number(n).toLocaleString());
  const D = window.UNDrill;
  let G_WS = null;
  let G_SS = null;
  let G_WATCHED_N = 0;

  function distinctVideos(ws) {
    const WS = window.UNWatchStats;
    return WS ? WS.effectiveUniqueVideos(ws, G_WATCHED_N) : ws ? ws.uniqueVideos || 0 : 0;
  }

  function pct(part, whole) {
    if (!whole) return '0%';
    return Math.round((part / whole) * 100) + '%';
  }

  function topDays(byDate, n) {
    return Object.keys(byDate || {})
      .map((k) => [k, byDate[k]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, n || 8);
  }

  const parseDay = (s) => {
    const p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  };
  const prettyDate = (s) => {
    const d = parseDay(s);
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  };
  const hourLabel = (h) => (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? h + 'a' : h - 12 + 'p');

  // ---- tiny DOM/SVG builders ----
  function h(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) k === 'text' ? (e.textContent = attrs[k]) : e.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => e.appendChild(c));
    return e;
  }
  function s(tag, attrs, kids) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => e.appendChild(c));
    return e;
  }
  function section(title, sub) {
    const head = [h('h2', { text: title })];
    if (sub) head.push(h('p', { class: 'sec-sub', text: sub }));
    const sec = h('section', { class: 'sec' }, [h('div', { class: 'sec-head' }, head)]);
    app.appendChild(sec);
    return sec;
  }

  // When embedded inside the dashboard's Stats tab, drop our own chrome and
  // report height up so the host iframe can size to content.
  const embedded = window.parent !== window;
  if (embedded) document.documentElement.classList.add('embedded');
  function reportHeight() {
    if (!embedded) return;
    const send = () => window.parent.postMessage({ unsynthStatsHeight: document.body.scrollHeight }, '*');
    send();
    setTimeout(send, 120);
    setTimeout(send, 400);
  }

  /** Atlas may open target=_blank links in a new window; prefer tabs.create. */
  function openYouTubeSearch(url) {
    if (window.UNOpenPage && UNOpenPage.openExternal) UNOpenPage.openExternal(url);
    else chrome.tabs.create({ url, active: true });
  }

  function renderSourcePill(ws, todayCount, src) {
    const hd = document.querySelector('.hd-title');
    if (!hd) return;
    const old = document.getElementById('source-pill');
    if (old) old.remove();
    if (!ws) return;
    const pill = h('span', { class: 'source-pill source-' + src, id: 'source-pill' });
    if (src === 'live' && todayCount > 0) pill.textContent = '+' + todayCount + ' today';
    else if (src === 'live') pill.textContent = 'Live tracking';
    else if (src === 'merged') pill.textContent = 'Import + live';
    else pill.textContent = 'From import';
    D.clickable(pill, () => {
      const lines = [D.row('Source', src === 'live' ? 'Live tracker only' : src === 'merged' ? 'Takeout + live tracking' : 'Takeout import')];
      if (ws.live) lines.push(D.row('Watches today', nf(todayCount)));
      if (ws.lastLiveUpdate) lines.push(D.row('Last live update', new Date(ws.lastLiveUpdate).toLocaleString()));
      if (ws.importedAt) lines.push(D.row('Imported', ws.importedAt));
      lines.push(D.para('Live tracking counts videos you finish (75%+) while browsing. Import adds your full Google Takeout history.'));
      D.open('Data source', lines);
    });
    hd.appendChild(pill);
  }

  // ---- empty state ----
  function emptyMark() {
    const m = h('div', { class: 'empty-mark' });
    m.setAttribute('aria-hidden', 'true');
    m.innerHTML = '<svg viewBox="0 0 24 24" width="36" height="36" focusable="false">'
      + '<rect x="3" y="12" width="4.5" height="9" rx="1" fill="currentColor"/>'
      + '<rect x="9.75" y="7" width="4.5" height="14" rx="1" fill="currentColor"/>'
      + '<rect x="16.5" y="3" width="4.5" height="18" rx="1" fill="currentColor"/></svg>';
    return m;
  }
  function renderEmpty() {
    $('hd-sub').textContent = 'No history imported yet';
    app.appendChild(
      h('div', { class: 'empty' }, [
        // A drawn mark, not an emoji: the icon policy is one set matched to
        // YouTube's weight, and a platform emoji renders differently on every OS.
        emptyMark(),
        h('h2', { text: 'Nothing to show yet' }),
        h('p', {
          text:
            'Import Takeout on the dashboard Watched tab, or watch videos past 75% with live tracking — your stats appear here automatically.'
        }),
        (() => {
          const b = h('button', { class: 'primary', text: 'Open dashboard → Watched' });
          b.addEventListener('click', () => send(UNMSG.OPEN_EXT_PAGE, { path: 'src/dashboard/dashboard.html', hash: 'watched' }));
          return b;
        })()
      ])
    );
  }

  function renderForgeToolbar() {
    const sec = h('section', { class: 'sec stats-forge-bar' });
    sec.appendChild(h('h2', { text: 'Playlist Forge' }));
    sec.appendChild(
      h('p', {
        class: 'sec-sub',
        text: 'Suggest and build playlists from this history — on YouTube (Forge panel) or here below.'
      })
    );
    const row = h('div', { class: 'stats-forge-actions' });
    const openForge = h('button', { class: 'primary', text: 'Open Forge site ↗' });
    openForge.addEventListener('click', () => openYouTubeSearch(FORGE + '/?from=stats'));
    const dash = h('button', { text: 'Forge defaults' });
    dash.addEventListener('click', () => send(UNMSG.OPEN_EXT_PAGE, { path: 'src/dashboard/dashboard.html', hash: 'stats' }));
    const yt = h('button', { text: 'YouTube Forge panel' });
    yt.title = 'Open YouTube — gold Forge tab on the right edge';
    yt.addEventListener('click', () => chrome.tabs.create({ url: 'https://www.youtube.com/', active: true }));
    row.append(openForge, dash, yt);
    sec.appendChild(row);
    chrome.storage.local.get({ forgePrefs: { count: 25, privacy: 'public' } }, (d) => {
      const p = Object.assign({ count: 25, privacy: 'public' }, d.forgePrefs || {});
      const hint = h('p', { class: 'stats-forge-hint', text: 'Defaults: ' + p.count + ' videos · ' + p.privacy + ' playlists' });
      sec.appendChild(hint);
      reportHeight();
    });
    app.appendChild(sec);
  }

  function renderTasteSnapshot(ws, ss) {
    const peakHour = ws && ws.byHour ? ws.byHour.indexOf(Math.max.apply(null, ws.byHour)) : null;
    const persona =
      peakHour == null
        ? null
        : peakHour >= 22 || peakHour <= 4
          ? 'Night owl'
          : peakHour >= 5 && peakHour <= 10
            ? 'Early bird'
            : peakHour >= 11 && peakHour <= 16
              ? 'Daytime watcher'
              : 'Evening watcher';
    const bits = [];
    if (persona) bits.push(persona + ' · peak ' + hourLabel(peakHour));
    if (ws && ws.topChannels && ws.topChannels[0]) bits.push('Top channel: ' + ws.topChannels[0][0]);
    if (ss && ss.topTerms && ss.topTerms[0]) bits.push('Top search: “' + ss.topTerms[0][0] + '”');
    if (!bits.length) return;
    const sec = h('section', { class: 'sec taste-snap' });
    sec.appendChild(h('h2', { text: 'Your taste snapshot' }));
    sec.appendChild(h('p', { class: 'taste-line', text: bits.join(' · ') }));
    app.appendChild(sec);
  }

  function renderExportBar(ws, ss) {
    const sec = h('section', { class: 'sec stats-export' });
    const btn = h('button', { text: 'Copy summary' });
    const status = h('span', { class: 'stats-export-status' });
    btn.addEventListener('click', () => {
      const lines = ['Unsynth YouTube stats'];
      if (ws) {
        lines.push('Videos: ' + nf(ws.uniqueVideos || ws.total) + ' distinct · ' + nf(ws.total) + ' plays');
        lines.push('Channels: ' + nf(ws.uniqueChannels) + ' · Active days: ' + nf(ws.activeDays));
        lines.push('Range: ' + ws.firstDate + ' → ' + ws.lastDate);
        if (ws.topChannels && ws.topChannels[0]) lines.push('Top channel: ' + ws.topChannels[0][0]);
      }
      if (ss) {
        lines.push('Searches: ' + nf(ss.total) + ' · Unique terms: ' + nf(ss.uniqueTerms));
        if (ss.topTerms && ss.topTerms[0]) lines.push('Top search: ' + ss.topTerms[0][0]);
      }
      const text = lines.join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
        () => {
          status.textContent = 'Copied.';
          setTimeout(() => (status.textContent = ''), 2000);
        },
        () => {
          status.textContent = 'Copy failed';
        }
      );
    });
    sec.appendChild(h('div', { class: 'stats-export-row' }, [btn, status]));
    app.appendChild(sec);
  }

  function clearRendered() {
    if (app) app.textContent = '';
    const pill = document.getElementById('source-pill');
    if (pill) pill.remove();
  }

  function loadAndRender() {
    chrome.storage.local.get(['watchStats', 'searchStats', 'watchedVideos'], (d) => {
      G_WS = d && d.watchStats;
      G_SS = d && d.searchStats;
      G_WATCHED_N = ((d && d.watchedVideos) || []).length;
      const ws = G_WS;
      const ss = G_SS;
      clearRendered();
      if (!ws && !ss) {
        $('hd-sub').textContent = 'No history imported yet';
        renderEmpty();
        return reportHeight();
      }
      const WS = window.UNWatchStats;
      const br = WS && ws ? WS.playBreakdown(ws) : { today: 0, total: 0, imported: 0, live: 0 };
      const todayCount = br.today;
      const src = WS ? WS.sourceLabel(ws) : 'imported';
      const distinct = distinctVideos(ws);
      let sub = '';
      if (ws) {
        sub = prettyDate(ws.firstDate) + ' → ' + prettyDate(ws.lastDate) + ' · ' + nf(distinct) + ' distinct · ' + nf(ws.total) + ' plays';
        if (src === 'live') sub += ' · live tracking';
        else if (src === 'merged') sub += ' · ' + nf(br.imported) + ' imported + ' + nf(br.live) + ' live';
      }
      $('hd-sub').textContent = sub || (ss ? nf(ss.total) + ' searches' : '');
      renderSourcePill(ws, todayCount, src);
      if (!embedded) renderForgeToolbar();
      if (ws || ss) renderTasteSnapshot(ws, ss);
      if (ws || ss) renderExportBar(ws, ss);
      if (ws) {
        renderHero(ws);
        renderFacts(ws);
        renderSuggest(ws, ss);
        renderHeatmap(ws);
        renderClocks(ws);
        renderMonthly(ws);
        renderChannels(ws);
      }
      if (ss) renderSearch(ss, !ws);
      if (!ws && ss) {
        $('hd-sub').textContent = nf(ss.total) + ' searches · ' + nf(ss.uniqueTerms) + ' unique';
        renderSuggest(null, ss);
      }
      reportHeight();
    });
  }

  loadAndRender();
  window.addEventListener('resize', reportHeight);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && (ch.watchStats || ch.searchStats || ch.watchedVideos)) loadAndRender();
  });
  window.addEventListener('message', (e) => {
    // Only the dashboard that embeds this page (same extension origin) may ask for a refresh.
    if (e.origin !== location.origin) return;
    if (e.data && e.data.unsynthStatsRefresh) loadAndRender();
  });

  $('open-dash').addEventListener('click', () => {
    if (window.UNOpenPage && UNOpenPage.dashboard) UNOpenPage.dashboard();
    else chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  });

  // ---- hero numbers ----
  function renderHero(ws) {
    const WS = window.UNWatchStats;
    const br = WS ? WS.playBreakdown(ws) : { total: ws.total || 0, imported: 0, live: 0 };
    const rangeDays = Math.round((parseDay(ws.lastDate) - parseDay(ws.firstDate)) / 86400000) + 1;
    const distinct = distinctVideos(ws);
    const replay = Math.max(0, (ws.total || 0) - distinct);
    const src = WS ? WS.sourceLabel(ws) : 'imported';
    const distinctSub =
      src === 'merged' && br.imported > 0 && br.live > 0
        ? nf(br.imported) + ' imported · ' + nf(br.live) + ' live plays'
        : nf(ws.total) + ' plays incl. replays';
    const cards = [
      {
        label: 'Distinct videos',
        big: nf(distinct),
        sub: distinctSub,
        drill: () =>
          D.open('Distinct videos', [
            D.row('Marked watched', nf(distinct)),
            D.row('Total plays', nf(ws.total)),
            D.row('Replays', nf(replay), 'Same video watched more than once counts as a replay.'),
            D.row('Replay rate', pct(replay, ws.total || 1)),
            br.imported > 0 ? D.row('Plays from import', nf(br.imported)) : null,
            br.live > 0 ? D.row('Plays tracked live', nf(br.live)) : null,
            D.para('Distinct = your marked-watched video list. Total plays includes every logged watch (Takeout rows + live finishes).')
          ])
      },
      {
        label: 'Channels',
        big: nf(ws.uniqueChannels),
        sub: ws.topChannels && ws.topChannels[0] ? 'top: ' + ws.topChannels[0][0] : '',
        drill: () => {
          const top = (ws.topChannels || []).slice(0, 8).map((c, i) => '#' + (i + 1) + ' ' + c[0] + ' — ' + nf(c[1]) + ' videos, ' + nf(c[2]) + ' plays');
          D.open('Channels', [
            D.row('Unique channels', nf(ws.uniqueChannels)),
            D.para('Top channels by distinct videos watched:'),
            D.list(top.length ? top : ['No channel data yet'])
          ]);
        }
      },
      {
        label: 'Active days',
        big: nf(ws.activeDays),
        sub: 'of ' + nf(rangeDays) + ' days',
        drill: () =>
          D.open('Active days', [
            D.row('Days you watched', nf(ws.activeDays)),
            D.row('Days in range', nf(rangeDays)),
            D.row('Watch rate', pct(ws.activeDays, rangeDays)),
            D.row('Current streak', nf(ws.currentStreak) + ' days'),
            D.para('An active day is any day with at least one logged watch in your history.')
          ])
      },
      {
        label: 'Longest streak',
        big: nf(ws.longestStreak),
        sub: 'days in a row',
        drill: () =>
          D.open('Watching streaks', [
            D.row('Longest streak', nf(ws.longestStreak) + ' days'),
            D.row('Current streak', nf(ws.currentStreak) + ' days'),
            ws.busiestDay ? D.row('Busiest day', nf(ws.busiestDay.count) + ' on ' + prettyDate(ws.busiestDay.date)) : null,
            D.para('Streaks count consecutive calendar days with at least one watch.')
          ])
      }
    ];
    const grid = h('div', { class: 'hero' });
    cards.forEach((c) => {
      const card = h('div', { class: 'hero-card' }, [
        h('div', { class: 'hero-num', text: c.big }),
        h('div', { class: 'hero-lbl', text: c.label }),
        h('div', { class: 'hero-sub', text: c.sub })
      ]);
      D.clickable(card, c.drill);
      grid.appendChild(card);
    });
    app.appendChild(grid);
  }

  // ---- fun facts ----
  function renderFacts(ws) {
    const peakHour = ws.byHour.indexOf(Math.max.apply(null, ws.byHour));
    const avg = Math.round(ws.total / Math.max(1, ws.activeDays));
    const night = ws.byHour.slice(0, 6).reduce((a, b) => a + b, 0);
    const persona =
      peakHour >= 22 || peakHour <= 4 ? 'Night owl' : peakHour >= 5 && peakHour <= 10 ? 'Early bird' : peakHour >= 11 && peakHour <= 16 ? 'Daytime watcher' : 'Evening watcher';
    const facts = [];
    if (ws.busiestDay) facts.push(['Busiest day', nf(ws.busiestDay.count) + ' videos', prettyDate(ws.busiestDay.date)]);
    facts.push(['Daily habit', nf(avg) + ' / day', 'on days you watched']);
    facts.push([persona, hourLabel(peakHour).replace('a', ' AM').replace('p', ' PM'), 'your peak hour']);
    if (ws.topChannels && ws.topChannels[0]) facts.push(['Most loyal to', ws.topChannels[0][0], nf(ws.topChannels[0][1]) + ' videos']);
    const rangeDays = Math.round((parseDay(ws.lastDate) - parseDay(ws.firstDate)) / 86400000) + 1;
    if (ws.longestStreak >= rangeDays) facts.push(['Never missed a day', 'every single day', 'across the whole span']);
    else facts.push(['Night sessions', nf(night) + ' videos', 'watched between midnight–6 AM']);

    const wrap = h('div', { class: 'facts' });
    facts.forEach(([k, v, sub]) => {
      const fact = h('div', { class: 'fact' }, [h('span', { class: 'fact-k', text: k }), h('span', { class: 'fact-v', text: v }), h('span', { class: 'fact-s', text: sub })]);
      if (k === 'Busiest day' && ws.busiestDay) {
        D.clickable(fact, () => D.open(k, [D.row('Date', prettyDate(ws.busiestDay.date)), D.row('Videos', nf(ws.busiestDay.count))]));
      } else if (k === 'Daily habit') {
        D.clickable(fact, () => D.open(k, [D.row('Average', nf(avg) + ' / active day'), D.row('Active days', nf(ws.activeDays))]));
      } else if (k.indexOf('owl') !== -1 || k.indexOf('bird') !== -1 || k.indexOf('watcher') !== -1) {
        D.clickable(fact, () => D.open(k, [D.row('Peak hour', hourLabel(peakHour)), D.row('Night (12a–6a)', nf(night) + ' videos')]));
      } else if (k === 'Most loyal to' && ws.topChannels[0]) {
        const ch = ws.topChannels[0];
        D.clickable(fact, () => D.open(ch[0], [D.row('Distinct videos', nf(ch[1])), D.row('Plays', nf(ch[2]))]));
      } else if (k === 'Never missed a day') {
        D.clickable(fact, () => D.open(k, [D.para('You watched at least one video every day across your entire imported span.')]));
      } else if (k === 'Night sessions') {
        D.clickable(fact, () => D.open(k, [D.row('Videos', nf(night)), D.row('Share', pct(night, ws.total))]));
      }
      wrap.appendChild(fact);
    });
    app.appendChild(wrap);
  }

  // ---- playlist ideas from your history (powered by Playlist Forge) ----
  const FORGE = 'https://playlist-forge.vercel.app';
  const FD = window.UNForgeDiscover;
  const WS_FORGE = window.UNWatchStats;

  function buildSummary(ws, ss) {
    let summary = WS_FORGE && WS_FORGE.summarizeForForge ? WS_FORGE.summarizeForForge(ws, ss) : {};
    if (FD && FD.enrichSuggestSummary) summary = FD.enrichSuggestSummary(summary, ws);
    return summary;
  }
  function ideaUrl(idea, auto) {
    const p = new URLSearchParams({ from: 'stats', q: idea.searchQuery || idea.title, title: idea.title, count: String(idea.count || 25) });
    if (auto) p.set('auto', '1');
    return FORGE + '/?' + p.toString();
  }

  function send(type, extra) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (r) => resolve(r || { ok: false, error: 'no_response' }));
    });
  }

  function loadForgePrefs() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ forgePrefs: { count: 25, privacy: 'public', defaultFolder: '' } }, (d) => {
        resolve(Object.assign({ count: 25, privacy: 'public', defaultFolder: '' }, d.forgePrefs || {}));
      });
    });
  }

  // Escape remote-controlled strings (Forge API titles/errors/urls) before they
  // reach showStatsToast's innerHTML — this page has chrome.* access.
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function safeHttpUrl(u) {
    const s = String(u || '');
    return /^https:\/\//i.test(s) ? s : '';
  }

  function showStatsToast(html, isErr) {
    const box = $('stats-toast');
    if (!box) return;
    box.className = 'stats-toast' + (isErr ? ' err show' : ' show');
    box.innerHTML = html;
    clearTimeout(showStatsToast._t);
    showStatsToast._t = setTimeout(() => box.classList.remove('show'), isErr ? 8000 : 12000);
  }

  function assignPlaylistFolder(playlistId, title, folderName) {
    const PF = window.UNPlaylistFolders;
    if (!PF || !folderName || !playlistId) return;
    chrome.storage.local.get({ plFolderStore: PF.empty() }, (d) => {
      const store = d.plFolderStore || PF.empty();
      if (!store.folders[folderName]) store.folders[folderName] = [];
      if (store.folders[folderName].indexOf(playlistId) === -1) store.folders[folderName].push(playlistId);
      store.names = store.names || {};
      if (title) store.names[playlistId] = title;
      // Add-only — merge, never overwrite. See persistFolders().
      if (PF.persistFolders) PF.persistFolders(store);
      else chrome.storage.local.set({ plFolderStore: store });
    });
  }

  async function loadForgeTastePayload() {
    return new Promise((resolve) => {
      const tasteDefault = { excludeWatched: true, boostChannels: false, excludeAI: true, customAvoidChannels: [] };
      chrome.storage.local.get(['forgePrefs', 'watchedVideos', 'watchStats'], (d) => {
        const tp = Object.assign({}, tasteDefault, (d.forgePrefs && d.forgePrefs.taste) || {});
        if (!FD || !FD.buildTastePayload) {
          resolve(null);
          return;
        }
        resolve(
          FD.buildTastePayload({
            excludeWatched: tp.excludeWatched !== false,
            boostChannels: tp.boostChannels === true,
            excludeAI: tp.excludeAI !== false,
            watchedIds: d.watchedVideos || [],
            watchStats: d.watchStats || null,
            customAvoidChannelNames: tp.customAvoidChannels || []
          })
        );
      });
    });
  }

  async function discoverForIdea(idea, count) {
    const q = idea.searchQuery || idea.title;
    const taste = await loadForgeTastePayload();
    const body = {
      request: q,
      overrides: { count: count || 25, filters: { excludeAI: true } }
    };
    if (taste) body.taste = taste;
    const r = await fetchWithTimeout(FORGE + '/api/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }, 10000);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'discover_failed');
    const list = FD && FD.extractDiscoverCandidates ? FD.extractDiscoverCandidates(data) : data.candidates || data.videos || [];
    return list.map((v) => v.id || v.videoId).filter(Boolean);
  }

  async function createOnYouTube(idea, btn, cardStatus) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Building…';
    if (cardStatus) cardStatus.textContent = '';
    try {
      const prefs = await loadForgePrefs();
      const auth = await send(UNMSG.AUTH_STATUS);
      // Same reading as every other surface. Checking scopeKeys against a
      // merely-stored token accepted an expired grant, and the message then
      // told the user to add a scope they already had — the problem was the
      // token being dead, not the permission being missing.
      const AS = window.UNAuthState;
      const writable = AS ? AS.canWrite(auth)
        : !!(auth.authed && auth.usable !== false && (auth.scopeKeys || []).includes('write'));
      if (!writable) {
        const expired = AS ? AS.needsReconnect(auth) : !!(auth.authed && auth.usable === false);
        showStatsToast(expired
          ? 'Your YouTube connection has expired. <a href="#" id="stats-toast-acct">Reconnect</a>'
          : 'Connect YouTube with <b>write</b> scope in dashboard Account tab. <a href="#" id="stats-toast-acct">Open Account</a>', true);
        const link = document.getElementById('stats-toast-acct');
        if (link) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            send(UNMSG.OPEN_EXT_PAGE, { path: 'src/dashboard/dashboard.html', hash: 'account' });
          });
        }
        return;
      }
      if (cardStatus) cardStatus.textContent = 'Finding videos…';
      const ids = await discoverForIdea(idea, prefs.count);
      if (!ids.length) {
        showStatsToast('No videos found for that idea.', true);
        return;
      }
      if (cardStatus) cardStatus.textContent = 'Creating on YouTube… 0/' + ids.length;
      const port = chrome.runtime.connect({ name: 'forge-create' });
      const r = await new Promise((resolve, reject) => {
        port.onMessage.addListener((msg) => {
          if (msg.type === 'progress' && msg.phase === 'adding' && cardStatus) {
            cardStatus.textContent = 'Adding videos… ' + msg.current + '/' + msg.total;
          }
          if (msg.type === 'done') {
            port.disconnect();
            resolve(msg);
          }
        });
        port.onDisconnect.addListener(() => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        });
        port.postMessage({
          type: 'create',
          title: idea.title,
          videoIds: ids,
          privacyStatus: prefs.privacy || 'public'
        });
      });
      if (!r.ok) {
        showStatsToast('Create failed: ' + escHtml(r.error || 'unknown'), true);
        return;
      }
      const added = r.added != null ? r.added : ids.length;
      const url = safeHttpUrl(r.url) || 'https://www.youtube.com/playlist?list=' + encodeURIComponent(r.playlistId || '');
      assignPlaylistFolder(r.playlistId, idea.title, prefs.defaultFolder);
      send(UNMSG.PLAYLIST_NOTIFY, {
        title: 'Playlist created',
        message: idea.title + ' · ' + added + ' videos',
        url
      });
      const failNote = r.failed && r.failed.length ? ' (' + r.failed.length + ' failed — open playlist to review)' : '';
      showStatsToast('Created <b>' + escHtml(idea.title) + '</b> with ' + added + ' videos' + failNote + '. <a href="' + escHtml(url) + '" target="_blank" rel="noopener">Open playlist ↗</a>');
      if (cardStatus) cardStatus.textContent = 'Done — ' + added + ' videos added.';
    } catch (e) {
      showStatsToast(escHtml(String(e)), true);
      if (cardStatus) cardStatus.textContent = '';
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
  function renderSuggest(ws, ss) {
    const sec = section('Playlist ideas from your history', 'Suggest playlists from your stats. Create on YouTube (Account OAuth) or review on Forge.');
    const summary = buildSummary(ws, ss);
    const btn = h('button', { class: 'primary sug-go', text: '✨ Suggest playlists for me' });
    const status = h('span', { class: 'sug-status' });
    sec.appendChild(h('div', { class: 'sug-bar' }, [btn, status]));
    const grid = h('div', { class: 'sug-grid' });
    sec.appendChild(grid);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = 'Thinking…';
      status.textContent = '';
      try {
        const r = await fetchWithTimeout(FORGE + '/api/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary }) }, 10000);
        const data = await r.json();
        if (!r.ok || !data.ideas) status.textContent = 'Failed: ' + (data.error || r.status);
        else renderIdeaCards(grid, data.ideas);
      } catch (e) {
        status.textContent = 'Could not reach Playlist Forge: ' + e;
      }
      btn.disabled = false;
      btn.textContent = old;
      reportHeight();
    });
  }
  function renderIdeaCards(grid, ideas) {
    grid.textContent = '';
    ideas.forEach((idea) => {
      const cardStatus = h('div', { class: 'sug-card-status' });
      const yt = h('button', { class: 'sug-build primary', text: 'Create on YouTube' });
      yt.addEventListener('click', () => createOnYouTube(idea, yt, cardStatus));
      const b1 = h('button', { class: 'sug-build', text: 'Review on Forge ↗' });
      b1.addEventListener('click', () => openYouTubeSearch(ideaUrl(idea, false)));
      const b2 = h('button', { text: 'Forge quick build ↗' });
      b2.title = 'Auto-create on Forge (needs Forge YouTube connect)';
      b2.addEventListener('click', () => openYouTubeSearch(ideaUrl(idea, true)));
      const card = h('div', { class: 'sug-card' }, [
        h('span', { class: 'sug-kind ' + (idea.kind || 'theme'), text: idea.kind || 'theme' }),
        h('div', { class: 'sug-title', text: idea.title })
      ]);
      if (idea.why || idea.description) card.appendChild(h('div', { class: 'sug-why', text: idea.why || idea.description }));
      card.appendChild(cardStatus);
      card.appendChild(h('div', { class: 'sug-acts' }, [yt, b1, b2]));
      grid.appendChild(card);
    });
    reportHeight();
  }

  // ---- contribution-style watch calendar ----
  function renderHeatmap(ws) {
    const sec = section('Your watch calendar', 'Every day you watched, shaded by how much. Brighter = more videos.');
    const dates = Object.keys(ws.byDate);
    if (!dates.length) return;
    const counts = dates.map((k) => ws.byDate[k]).sort((a, b) => a - b);
    // quartile thresholds across active days -> 4 intensity levels
    const q = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))];
    const t1 = q(0.25);
    const t2 = q(0.5);
    const t3 = q(0.75);
    const LV = ['#1b1b1b', '#5c2a2d', '#9a3138', '#d23c43', ACCENT];
    const level = (c) => (!c ? 0 : c <= t1 ? 1 : c <= t2 ? 2 : c <= t3 ? 3 : 4);

    const start = parseDay(ws.firstDate);
    start.setDate(start.getDate() - start.getDay()); // back to Sunday
    const end = parseDay(ws.lastDate);
    const CELL = 13;
    const GAP = 3;
    const PADL = 30;
    const PADT = 20;
    const weeks = Math.ceil((end - start) / (7 * 86400000)) + 1;
    const W = PADL + weeks * (CELL + GAP);
    const H = PADT + 7 * (CELL + GAP) + 4;
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'heat', width: W, height: H });

    let lastMonth = -1;
    const cur = new Date(start);
    for (let w = 0; w < weeks; w++) {
      for (let dow = 0; dow < 7; dow++) {
        if (cur > end) break;
        const key = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
        const c = ws.byDate[key] || 0;
        if (cur >= parseDay(ws.firstDate)) {
          const rect = s('rect', {
            x: PADL + w * (CELL + GAP),
            y: PADT + dow * (CELL + GAP),
            width: CELL,
            height: CELL,
            rx: 2,
            fill: LV[level(c)],
            class: c ? 'clickable' : ''
          });
          const t = s('title', { text: c ? c + ' videos · ' + prettyDate(key) : 'no videos · ' + prettyDate(key) });
          rect.appendChild(t);
          if (c) {
            rect.style.cursor = 'pointer';
            rect.addEventListener('click', () => {
              const avg = Math.round(ws.total / Math.max(1, ws.activeDays));
              D.open(prettyDate(key), [
                D.row('Videos watched', nf(c)),
                D.row('vs your daily average', (c >= avg ? '+' : '') + (c - avg) + ' (' + nf(avg) + ' avg)'),
                D.para(c >= t3 ? 'One of your heaviest days.' : c >= t1 ? 'A typical active day.' : 'Lighter than usual for you.')
              ]);
            });
          }
          svg.appendChild(rect);
        }
        // month label at the first column of each new month
        if (dow === 0 && cur.getMonth() !== lastMonth) {
          lastMonth = cur.getMonth();
          svg.appendChild(s('text', { x: PADL + w * (CELL + GAP), y: 12, class: 'heat-mo', text: MONTHS[lastMonth] }));
        }
        cur.setDate(cur.getDate() + 1);
      }
    }
    [1, 3, 5].forEach((d) => svg.appendChild(s('text', { x: 0, y: PADT + d * (CELL + GAP) + CELL - 2, class: 'heat-dow', text: DOW[d] })));

    const scroll = h('div', { class: 'heat-scroll' }, [svg]);
    sec.appendChild(scroll);
    // legend
    const leg = h('div', { class: 'legend' }, [h('span', { class: 'legend-lbl', text: 'Less' })]);
    LV.forEach((c) => leg.appendChild(h('span', { class: 'legend-box', style: 'background:' + c })));
    leg.appendChild(h('span', { class: 'legend-lbl', text: 'More' }));
    sec.appendChild(leg);
  }

  // ---- hour-of-day + day-of-week bar charts ----
  function renderClocks(ws) {
    const sec = section('When you watch', 'The clock and the week, by total videos.');
    const cols = h('div', { class: 'two-col' });

    // hour of day (24 bars)
    const hMax = Math.max.apply(null, ws.byHour) || 1;
    const peak = ws.byHour.indexOf(hMax);
    const hourBox = h('div', { class: 'chart-box' }, [h('div', { class: 'chart-cap', text: 'Hour of day' })]);
    const hb = h('div', { class: 'bars bars-hour' });
    ws.byHour.forEach((v, i) => {
      const col = h('div', { class: 'bar-col' + (i === peak ? ' peak' : '') });
      col.title = hourLabel(i) + ' · ' + nf(v) + ' videos';
      const bar = h('div', { class: 'bar' });
      bar.style.height = Math.max(2, Math.round((v / hMax) * 100)) + '%';
      col.appendChild(bar);
      if (i % 6 === 0) col.appendChild(h('span', { class: 'bar-x', text: hourLabel(i) }));
      D.clickable(col, () =>
        D.open(hourLabel(i) + ' watches', [
          D.row('Videos', nf(v)),
          D.row('Share of all watches', pct(v, ws.total)),
          D.row('Peak hour?', i === peak ? 'Yes' : 'No'),
          D.para('Hour is local time from your watch history timestamps.')
        ])
      );
      hb.appendChild(col);
    });
    hourBox.appendChild(hb);
    cols.appendChild(hourBox);

    // day of week (Mon-first)
    const order = [1, 2, 3, 4, 5, 6, 0];
    const dMax = Math.max.apply(null, ws.byDow) || 1;
    const dowBox = h('div', { class: 'chart-box' }, [h('div', { class: 'chart-cap', text: 'Day of week' })]);
    const db = h('div', { class: 'bars bars-dow' });
    order.forEach((i) => {
      const v = ws.byDow[i];
      const col = h('div', { class: 'bar-col' + (v === dMax ? ' peak' : '') });
      col.title = DOW[i] + ' · ' + nf(v) + ' videos';
      const bar = h('div', { class: 'bar' });
      bar.style.height = Math.max(2, Math.round((v / dMax) * 100)) + '%';
      col.appendChild(bar);
      col.appendChild(h('span', { class: 'bar-x', text: DOW[i] }));
      D.clickable(col, () =>
        D.open(DOW[i] + 's', [
          D.row('Videos', nf(v)),
          D.row('Share of all watches', pct(v, ws.total)),
          D.row('Busiest weekday?', v === dMax ? 'Yes' : 'No'),
          D.para('Totals every watch logged on this weekday across your full history.')
        ])
      );
      db.appendChild(col);
    });
    dowBox.appendChild(db);
    cols.appendChild(dowBox);

    sec.appendChild(cols);
  }

  // ---- monthly trend area chart ----
  function renderMonthly(ws) {
    const keys = Object.keys(ws.byMonth).sort();
    if (keys.length < 2) return;
    const sec = section('Month by month', 'How your watching rose and fell over time.');
    const vals = keys.map((k) => ws.byMonth[k]);
    const max = Math.max.apply(null, vals);
    const W = 720;
    const H = 240;
    const PADL = 44;
    const PADB = 28;
    const PADT = 14;
    const innerW = W - PADL - 12;
    const innerH = H - PADT - PADB;
    const x = (i) => PADL + (keys.length === 1 ? innerW / 2 : (i / (keys.length - 1)) * innerW);
    const y = (v) => PADT + innerH - (v / max) * innerH;
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'line', preserveAspectRatio: 'none' });

    // gridlines + y labels
    for (let g = 0; g <= 2; g++) {
      const gv = (max / 2) * g;
      const gy = y(gv);
      svg.appendChild(s('line', { x1: PADL, y1: gy, x2: W - 12, y2: gy, class: 'grid' }));
      svg.appendChild(s('text', { x: PADL - 8, y: gy + 4, class: 'axis y', text: nf(Math.round(gv)) }));
    }
    let line = '';
    keys.forEach((k, i) => (line += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(vals[i]).toFixed(1) + ' '));
    const area = 'M' + x(0).toFixed(1) + ' ' + (PADT + innerH) + ' ' + line.replace(/^M/, 'L') + 'L' + x(keys.length - 1).toFixed(1) + ' ' + (PADT + innerH) + ' Z';
    svg.appendChild(s('path', { d: area, class: 'area' }));
    svg.appendChild(s('path', { d: line.trim(), class: 'stroke' }));
    keys.forEach((k, i) => {
      const dot = s('circle', { cx: x(i), cy: y(vals[i]), r: 3.4, class: 'dot' });
      dot.appendChild(s('title', { text: MONTHS[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4) + ' · ' + nf(vals[i]) + ' videos' }));
      dot.style.cursor = 'pointer';
      dot.addEventListener('click', () => {
        const label = MONTHS[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4);
        const prev = i > 0 ? vals[i - 1] : null;
        const delta = prev != null ? vals[i] - prev : null;
        D.open(label, [
          D.row('Videos watched', nf(vals[i])),
          delta != null ? D.row('vs prior month', (delta >= 0 ? '+' : '') + nf(delta)) : null,
          D.para('Monthly total from your aggregated watch history.')
        ]);
      });
      svg.appendChild(dot);
      if (keys.length <= 14 || i % 2 === 0) svg.appendChild(s('text', { x: x(i), y: H - 8, class: 'axis x', text: MONTHS[+k.slice(5, 7) - 1] }));
    });
    sec.appendChild(h('div', { class: 'line-wrap' }, [svg]));
  }

  // ---- top channels ranked bars ----
  const CHAN_PAGE = 50; // rows added per "Show more" — 1000 at once is unusable

  function renderChannels(ws) {
    const all = ws.topChannels || [];
    if (!all.length) return;
    const sec = section(
      'Top channels',
      'Distinct videos per channel (grey bar = share). Click a row for details.'
    );
    const max = all[0][1] || 1;

    // A real import can carry hundreds of channels, so give it a filter rather
    // than a single expand-everything toggle.
    let filtered = all;
    let shown = 15;
    let query = '';

    const search = h('input', {
      class: 'chan-search',
      type: 'search',
      placeholder: 'Filter ' + nf(all.length) + ' channels…',
      'aria-label': 'Filter channels by name'
    });
    if (all.length > 15) sec.appendChild(search);

    const list = h('ol', { class: 'chan-list' });
    const more = h('button', { class: 'more' });
    const summary = h('p', { class: 'chan-summary' });

    function applyFilter() {
      const q = query.trim().toLowerCase();
      filtered = q ? all.filter((c) => String(c[0]).toLowerCase().indexOf(q) !== -1) : all;
      shown = Math.min(Math.max(15, shown), Math.max(15, filtered.length));
      paint();
    }

    search.addEventListener('input', () => {
      query = search.value;
      shown = 15;
      applyFilter();
      reportHeight();
    });

    function paint() {
      list.innerHTML = '';
      const slice = filtered.slice(0, shown);
      slice.forEach((c, i) => {
        const name = c[0];
        const videos = c[1];
        const plays = c[2] != null ? c[2] : c[1];
        const id = c[3] || '';
        const nameEl = id
          ? h('a', { class: 'chan-name', text: name, href: 'https://www.youtube.com/channel/' + id, target: '_blank', rel: 'noopener' })
          : h('span', { class: 'chan-name', text: name });
        const track = h('span', { class: 'chan-track' });
        const fill = h('span', { class: 'chan-fill' });
        fill.style.width = Math.max(3, Math.round((videos / max) * 100)) + '%';
        track.appendChild(fill);
        const cnt = h('span', { class: 'chan-count' }, [h('b', { text: nf(videos) })]);
        if (plays > videos) cnt.appendChild(h('span', { class: 'chan-plays', text: nf(plays) + ' plays' }));
        const row = h('li', { class: 'chan-row' }, [h('span', { class: 'chan-rank', text: '#' + (i + 1) }), nameEl, track, cnt]);
        const share = Math.round((videos / max) * 100);
        const replayCh = Math.max(0, plays - videos);
        D.clickable(row, () =>
          D.open(name, [
            D.row('Distinct videos', nf(videos)),
            D.row('Total plays', nf(plays)),
            D.row('Replays on channel', nf(replayCh)),
            D.row('Share of your #1', share + '%'),
            id ? D.para('Opens on YouTube when you click the channel name.') : D.para('Channel ID not available from import.')
          ])
        );
        list.appendChild(row);
      });

      // Keep the reader oriented: with a filter applied, "showing 12 of 15,805"
      // is the difference between trusting the number and not.
      const total = filtered.length;
      summary.textContent = total
        ? 'Showing ' + nf(Math.min(shown, total)) + ' of ' + nf(total) +
          (query ? ' matching "' + query + '"' : ' channels')
        : 'No channels match "' + query + '"';

      const remaining = Math.max(0, total - shown);
      more.hidden = remaining === 0;
      more.textContent = remaining
        ? 'Show ' + nf(Math.min(CHAN_PAGE, remaining)) + ' more'
        : '';
    }

    more.addEventListener('click', () => {
      shown += CHAN_PAGE;
      paint();
      reportHeight();
    });

    applyFilter();
    sec.appendChild(list);
    sec.appendChild(summary);
    sec.appendChild(more);
  }

  // ---- search history ----
  function renderSearch(ss, soloHeader) {
    const sec = section('What you searched', nf(ss.total) + ' searches · ' + nf(ss.uniqueTerms) + ' unique terms');

    if (ss.topWords && ss.topWords.length) {
      const max = ss.topWords[0][1];
      const cloud = h('div', { class: 'cloud' });
      ss.topWords.forEach(([w, c]) => {
        const size = 13 + Math.round((Math.sqrt(c) / Math.sqrt(max)) * 30);
        const span = h('a', { class: 'cloud-w', text: w, href: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(w), target: '_blank', rel: 'noopener' });
        span.style.fontSize = size + 'px';
        span.style.opacity = (0.5 + 0.5 * (c / max)).toFixed(2);
        span.title = nf(c) + ' searches — click for details';
        span.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            openYouTubeSearch(span.href);
            return;
          }
          if (e.shiftKey) return;
          e.preventDefault();
          D.open('“' + w + '”', [
            D.row('Times searched', nf(c)),
            D.row('Share of top word', pct(c, max)),
            D.para('Double-click or ' + (window.UNBrowserEnv ? UNBrowserEnv.modClickLabel() : 'Ctrl+click') + ' the word to search on YouTube.')
          ]);
        });
        span.addEventListener('dblclick', (e) => {
          e.preventDefault();
          openYouTubeSearch(span.href);
        });
        cloud.appendChild(span);
      });
      sec.appendChild(cloud);
    }

    if (ss.topTerms && ss.topTerms.length) {
      const grid = h('div', { class: 'term-grid' });
      ss.topTerms.slice(0, 24).forEach(([t, c]) => {
        const link = h('a', { class: 'term', href: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(t), target: '_blank', rel: 'noopener' }, [h('span', { class: 'term-t', text: t }), h('span', { class: 'term-c', text: nf(c) })]);
        link.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            openYouTubeSearch(link.href);
            return;
          }
          e.preventDefault();
          D.open('Search: ' + t, [D.row('Times searched', nf(c)), D.para((window.UNBrowserEnv ? UNBrowserEnv.modClickLabel() : 'Ctrl+click') + ' to open this search on YouTube.')]);
        });
        grid.appendChild(link);
      });
      sec.appendChild(h('h3', { class: 'sub-h', text: 'Most repeated searches' }));
      sec.appendChild(grid);
    }
  }
})();
