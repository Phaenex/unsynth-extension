/**
 * Playlist Forge on YouTube — sidebar, slide-out panel with
 * suggest / discover / create on YouTube (Unsynth OAuth) or open Forge site.
 */
(function () {
  'use strict';

  const FORGE = 'https://playlist-forge.vercel.app';
  const M_AUTH = 'UNSYNTH/AUTH/STATUS';
  const M_AUTH_START = 'UNSYNTH/AUTH/START';
  const M_ADD = 'UNSYNTH/YT/PLAYLIST_ADD';
  const M_WL = 'UNSYNTH/YT/WATCH_LATER_ADD';
  const M_PLS = 'UNSYNTH/YT/PLAYLISTS_MINE';
  const M_OPEN = 'UNSYNTH/OPEN_URL';
  const M_EXT = 'UNSYNTH/OPEN_EXT_PAGE';
  const M_FORGE_PANEL = 'UNSYNTH/FORGE/OPEN_PANEL';
  const M_NOTIFY = 'UNSYNTH/PLAYLIST/NOTIFY';
  const WS = window.UNWatchStats;
  const PF = window.UNPlaylistFolders;
  const FL = window.UNForgeLinks;
  const FD = window.UNForgeDiscover;

  // Looked up lazily rather than captured at parse time. Load order currently
  // guarantees shared/watch-queue.js runs first, so a const binding happens to
  // work today — but if that order ever changes this silently becomes
  // permanently undefined and every "Add to queue" here dies with no error,
  // which is exactly the class of failure that made the queue look broken
  // before. A getter costs nothing and cannot go stale.
  function wq() {
    return window.UNWatchQueue;
  }

  // forge-search-panel.js and forge-link.js are registered separately. Even
  // though the generated table lists the helper first, Chrome does not promise
  // execution order across separate content-script registrations. Capturing it
  // at parse time made a small startup race permanent: Search displayed
  // "helpers missing" and the playlist picker never existed until reload.
  function fsp() {
    return window.UNForgeSearchPanel;
  }

  let core = null;
  let prefs = { count: 25, privacy: 'public', defaultFolder: '' };
  let panelOpen = false;
  let activeTab = 'suggest';
  let forgeEscHandle = null;
  let forgeStorageListener = null;
  let forgeMsgListener = null;
  let searchPanelApi = null;
  let queuePanelApi = null;
  let auth = { authed: false, canWrite: false, hasConfig: false };
  let playlists = [];
  let playlistsLoaded = false;
  let playlistsLoading = false;
  let playlistsError = null;
  let playlistLoadPromise = null;
  let folderNames = [];
  let lastCreate = null;

  function el(tag, cls, text) { return window.UNSYNTH.el(tag, cls, text); }

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

  function openUrl(url) {
    send(M_OPEN, { url: url });
  }

  function openDashboard(hash) {
    send(M_EXT, { path: 'src/dashboard/dashboard.html', hash: hash || '' });
  }

  function loadPrefs(cb) {
    const tasteDefault = FD && FD.DEFAULT_FORGE_TASTE ? FD.DEFAULT_FORGE_TASTE : { excludeWatched: true, boostChannels: false, excludeAI: true, customAvoidChannels: [] };
    chrome.storage.local.get({ forgePrefs: { count: 25, privacy: 'public', defaultFolder: '', taste: tasteDefault } }, function (d) {
      prefs = Object.assign({ count: 25, privacy: 'public', defaultFolder: '', taste: tasteDefault }, d.forgePrefs || {});
      prefs.taste = Object.assign({}, tasteDefault, prefs.taste || {});
      if (cb) cb();
    });
  }

  function getTastePrefs() {
    const tasteDefault = FD && FD.DEFAULT_FORGE_TASTE ? FD.DEFAULT_FORGE_TASTE : {};
    return Object.assign({}, tasteDefault, (prefs && prefs.taste) || {});
  }

  function savePrefs() {
    chrome.storage.local.set({ forgePrefs: prefs });
  }

  function loadFolderNames(cb) {
    if (!PF) {
      folderNames = [];
      if (cb) cb();
      return;
    }
    chrome.storage.local.get({ plFolderStore: PF.empty() }, function (d) {
      const store = d.plFolderStore || PF.empty();
      folderNames = Object.keys(store.folders || {}).sort();
      if (cb) cb();
    });
  }

  function assignToFolder(playlistId, title, folderName) {
    const folder = folderName || prefs.defaultFolder;
    if (!folder || !PF || !playlistId) return;
    chrome.storage.local.get({ plFolderStore: PF.empty() }, function (d) {
      const store = d.plFolderStore || PF.empty();
      if (!store.folders) store.folders = {};
      if (!store.folders[folder]) store.folders[folder] = [];
      if (store.folders[folder].indexOf(playlistId) === -1) store.folders[folder].push(playlistId);
      store.names = store.names || {};
      if (title) store.names[playlistId] = title;
      // Add-only, so merge rather than overwrite: this never needs to remove
      // anything, and a plain set() here would drop folders created elsewhere.
      if (PF.persistFolders) PF.persistFolders(store);
      else chrome.storage.local.set({ plFolderStore: store });
    });
  }

  function notifyCreated(title, added, url) {
    send(M_NOTIFY, {
      title: 'Playlist created',
      message: title + ' · ' + added + ' video' + (added === 1 ? '' : 's'),
      url: url
    });
  }

  function updateProgressBar(current, total) {
    const bar = document.getElementById('un-forge-progress');
    const fill = document.getElementById('un-forge-progress-fill');
    if (!bar || !fill) return;
    if (!total) {
      bar.classList.remove('on');
      return;
    }
    bar.classList.add('on');
    fill.style.width = Math.round((current / total) * 100) + '%';
    if (current >= total) {
      setTimeout(function () {
        bar.classList.remove('on');
        fill.style.width = '0%';
      }, 800);
    }
  }

  function createViaPort(payload) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const port = chrome.runtime.connect({ name: 'forge-create' });
      function finish(err, result) {
        if (settled) return;
        settled = true;
        try {
          port.disconnect();
        } catch (e) {
          /* ignore */
        }
        if (err) reject(err);
        else resolve(result);
      }
      port.onMessage.addListener(function (msg) {
        if (msg.type === 'progress') {
          if (msg.phase === 'creating') setStatus('Creating playlist…');
          else if (msg.total) setStatus('Adding videos… ' + msg.current + '/' + msg.total);
          updateProgressBar(msg.current || 0, msg.total || 0);
        } else if (msg.type === 'done') {
          finish(null, msg);
        }
      });
      port.onDisconnect.addListener(function () {
        if (chrome.runtime.lastError && !settled) finish(new Error(chrome.runtime.lastError.message));
      });
      port.postMessage(Object.assign({ type: 'create' }, payload));
    });
  }

  function showRetryBar(result) {
    let row = document.getElementById('un-forge-retry');
    if (!row) {
      row = el('div', 'un-forge-retry');
      row.id = 'un-forge-retry';
      const status = document.getElementById('un-forge-status');
      if (status && status.parentNode) status.parentNode.insertBefore(row, status.nextSibling);
    }
    row.textContent = '';
    if (!result || !result.failed || !result.failed.length) {
      row.classList.remove('on');
      return;
    }
    row.classList.add('on');
    row.appendChild(el('span', '', result.failed.length + ' video' + (result.failed.length === 1 ? '' : 's') + ' could not be added.'));
    const retry = el('button', 'un-forge-btn ghost', 'Retry failed');
    retry.type = 'button';
    retry.addEventListener('click', function () {
      btnLoading(retry, true);
      send(M_ADD, { playlistId: result.playlistId, videoIds: result.failed })
        .then(function (r) {
          if (!r.ok) {
            setStatus('Retry failed: ' + (r.error || ''), 'err');
            return;
          }
          const added = r.added != null ? r.added : 0;
          setStatus('Retry added ' + added + ' more.', 'ok');
          if (r.failed && r.failed.length) lastCreate = Object.assign({}, result, { failed: r.failed });
          else {
            lastCreate = null;
            showRetryBar(null);
          }
        })
        .finally(function () {
          btnLoading(retry, false, 'Retry failed');
        });
    });
    row.appendChild(retry);
  }

  function renderFolderSelect(sel, value) {
    if (!sel) return;
    sel.textContent = '';
    sel.appendChild(el('option', '', 'None'));
    folderNames.forEach(function (name) {
      const opt = el('option', '', name);
      opt.value = name;
      if (name === value) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function finishCreateResult(r, title) {
    if (!r || !r.ok) return null;
    lastCreate = r;
    const added = r.added != null ? r.added : 0;
    const failNote = r.failed && r.failed.length ? ' (' + r.failed.length + ' failed)' : '';
    setStatus('Created “' + title + '” with ' + added + ' video' + (added === 1 ? '' : 's') + failNote + '.', 'ok');
    showToast('Playlist created', title + ' · ' + added + ' videos', r.url);
    showRetryBar(r);
    assignToFolder(r.playlistId, title, prefs.defaultFolder);
    notifyCreated(title, added, r.url);
    return r;
  }

  function hasWrite(scopeKeys) {
    return !!(scopeKeys && scopeKeys.indexOf('write') !== -1);
  }

  function playlistIdFromUrl() {
    const m = location.search.match(/[?&]list=([^&]+)/);
    return m ? m[1] : null;
  }

  function watchVideoId() {
    if (WS && WS.videoIdFromUrl) return WS.videoIdFromUrl(location.pathname, location.search);
    const m = location.search.match(/[?&]v=([\w-]{11})/);
    if (m) return m[1];
    const sm = location.pathname.match(/^\/shorts\/([\w-]{11})/);
    return sm ? sm[1] : null;
  }

  function watchPageContext() {
    const id = watchVideoId();
    if (!id) return null;
    const titleEl = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string.ytd-watch-metadata, h1.ytd-shorts yt-formatted-string, ytd-reel-player-header-renderer yt-formatted-string'
    );
    const title = titleEl ? titleEl.textContent.trim() : '';
    const chEl = document.querySelector(
      '#owner #channel-name a, ytd-channel-name a, ytd-video-owner-renderer a, ytd-reel-player-header-renderer a'
    );
    const channel = chEl ? chEl.textContent.trim() : '';
    return { id: id, title: title, channel: channel };
  }

  function openSimilarInForge(videoId, title, channelTitle) {
    const id = videoId || watchVideoId();
    if (!id) {
      setStatus('Open a video first.', 'err');
      return;
    }
    const ctx = watchPageContext();
    const t = title != null ? title : ctx ? ctx.title : '';
    const ch = channelTitle != null ? channelTitle : ctx ? ctx.channel : '';
    ensurePanel();
    setPanelOpen(true);
    showTab('search');
    if (searchPanelApi && searchPanelApi.runSimilar) {
      searchPanelApi.runSimilar(id, t, ch);
      return;
    }
    if (FL && FL.forgeSeed) {
      openUrl(FL.forgeSeed(id, { title: t, auto: true }));
    }
  }

  function forgeBuildUrl(opts) {
    const p = new URLSearchParams({ from: 'youtube' });
    if (opts.title) p.set('title', opts.title);
    if (opts.q) p.set('q', opts.q);
    p.set('count', String(opts.count || prefs.count || 25));
    if (opts.auto) p.set('auto', '1');
    if (opts.videoIds && opts.videoIds.length) p.set('videoIds', opts.videoIds.join(','));
    if (opts.manage) p.set('manage', opts.manage);
    return FORGE + '/?' + p.toString();
  }

  function ideaUrl(idea, auto) {
    return forgeBuildUrl({
      title: idea.title,
      q: idea.searchQuery,
      count: idea.count || prefs.count,
      auto: auto
    });
  }

  function selectedVideoIdsFromPage() {
    const ids = [];
    document.querySelectorAll('.un-plm-on').forEach(function (row) {
      const a = row.querySelector('a[href*="/watch"]');
      if (!a) return;
      const m = (a.getAttribute('href') || '').match(/[?&]v=([^&]+)/);
      if (m) ids.push(m[1]);
    });
    if (ids.length) return ids;
    const one = watchVideoId();
    return one ? [one] : [];
  }

  function panelRoot() {
    return document.getElementById('un-forge-root');
  }

  function setPanelOpen(on, viaHost) {
    // Hosted: the side panel owns open/close and Escape; this only mirrors it.
    if (hosted() && !viaHost) {
      if (on) window.UNSidePanel.open('forge'); else window.UNSidePanel.close();
      return;
    }
    panelOpen = !!on;
    const root = panelRoot();
    if (root) {
      root.classList.toggle('open', panelOpen);
      const backdrop = document.getElementById('un-forge-backdrop');
      if (backdrop) backdrop.classList.toggle('on', panelOpen);
    }
    const tabEl = document.querySelector('.un-forge-tab');
    if (tabEl) tabEl.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    if (!panelOpen && searchPanelApi && searchPanelApi.closePreview) {
      searchPanelApi.closePreview();
    }
    if (panelOpen) {
      hydratePanelSection(activeTab);
      // Push onto LIFO Escape stack (guard double-push).
      if (!forgeEscHandle && !viaHost) forgeEscHandle = window.UNSYNTH.pushPanel(function () { setPanelOpen(false); });
      // Move keyboard focus into the dialog (it declares aria-modal).
      const closeBtn = root && root.querySelector('.un-forge-x');
      if (closeBtn) setTimeout(function () { closeBtn.focus(); }, 60);
      refreshPlaylistUi();
      refreshStatsLine();
    } else {
      if (forgeEscHandle) { window.UNSYNTH.popPanel(forgeEscHandle); forgeEscHandle = null; }
    }
    if (window.UNSideDock && window.UNSideDock.schedule) window.UNSideDock.schedule();
  }

  function togglePanel() {
    setPanelOpen(!panelOpen);
  }

  function setStatus(msg, kind) {
    const s = document.getElementById('un-forge-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'un-forge-status' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : kind === 'warn' ? ' warn' : '');
  }

  function showToast(titleText, bodyText, link) {
    let box = document.getElementById('un-forge-toast');
    if (!box) {
      box = el('div', 'un-forge-toast');
      box.id = 'un-forge-toast';
      panelRoot().appendChild(box);
    }
    box.textContent = '';
    const msg = el('div', 'un-forge-toast-msg');
    msg.appendChild(el('b', '', titleText));
    msg.appendChild(document.createElement('br'));
    msg.appendChild(document.createTextNode(bodyText));
    box.appendChild(msg);
    if (link) {
      const a = el('a', 'un-forge-toast-link', 'Open playlist ↗');
      a.href = link;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        openUrl(link);
      });
      box.appendChild(a);
    }
    box.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      box.classList.remove('show');
    }, 12000);
  }

  function btnLoading(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.disabled = true;
      btn.dataset.label = btn.textContent;
      btn.classList.add('loading');
      btn.textContent = label || 'Working…';
    } else {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = btn.dataset.label || label || btn.textContent;
    }
  }

  function showTab(name) {
    activeTab = name;
    hydratePanelSection(name);
    document.querySelectorAll('.un-forge-nav button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    document.querySelectorAll('.un-forge-section').forEach(function (sec) {
      sec.classList.toggle('on', sec.dataset.section === name);
    });
  }

  function hydratePanelSection(name) {
    const root = panelRoot();
    if (!root) return;
    const section = root.querySelector('.un-forge-section[data-section="' + name + '"]');
    if (!section || section.dataset.hydrated === '1') return;
    if (name === 'guide') renderGuideSection(section);
    else if (name === 'search') mountSearchPanel(section);
    else if (name === 'queue') mountQueuePanel(section);
    else return;
    section.dataset.hydrated = '1';
  }

  function renderGuideSection(sec) {
    sec.textContent = '';
    const hero = el('div', 'un-forge-guide-hero');
    hero.appendChild(el('span', 'un-forge-guide-spark', '✦'));
    hero.appendChild(el('h3', 'un-forge-guide-title', 'Forge Guide'));
    hero.appendChild(
      el(
        'p',
        'un-forge-guide-lead',
        'How to read grades, spot the good videos, and know what to build.'
      )
    );
    sec.appendChild(hero);

    const ladder = el('div', 'un-forge-guide-block');
    ladder.appendChild(el('h4', 'un-forge-guide-h', 'Forge grades (A–F)'));
    ladder.appendChild(
      el(
        'p',
        'un-forge-guide-sub',
        'Each video gets a letter score from relevance, quality, engagement, and hidden-gem bonus.'
      )
    );
    const rail = el('div', 'un-forge-grade-rail');
    [
      { letter: 'A', pts: '80–100', cls: 'gA', note: 'Lock these in — strong match and worth keeping.' },
      { letter: 'B', pts: '64–79', cls: 'gB', note: 'Solid picks; great for themed playlists.' },
      { letter: 'C', pts: '48–63', cls: 'gC', note: 'Okay filler if you need more variety.' },
      { letter: 'D', pts: '32–47', cls: 'gD', note: 'Weak — only if you love the channel anyway.' },
      { letter: 'F', pts: '0–31', cls: 'gF', note: 'Off-topic or bad fit — usually skip.' }
    ].forEach(function (g) {
      const row = el('div', 'un-forge-grade-row');
      const badge = el('span', 'un-forge-grade-badge ' + g.cls, g.letter);
      const bar = el('div', 'un-forge-grade-bar');
      const fill = el('span', 'un-forge-grade-fill ' + g.cls, '');
      fill.style.width = g.letter === 'A' ? '100%' : g.letter === 'B' ? '82%' : g.letter === 'C' ? '64%' : g.letter === 'D' ? '46%' : '22%';
      bar.appendChild(fill);
      const meta = el('div', 'un-forge-grade-meta');
      meta.appendChild(el('span', 'un-forge-grade-pts', g.pts + ' pts'));
      meta.appendChild(el('span', 'un-forge-grade-note', g.note));
      row.append(badge, bar, meta);
      rail.appendChild(row);
    });
    ladder.appendChild(rail);

    const stack = el('div', 'un-forge-score-stack');
    stack.appendChild(el('span', 'un-forge-stack-lbl', 'Score mix'));
    [
      { name: 'Relevance', w: '40%', cls: 'rel' },
      { name: 'Quality', w: '30%', cls: 'qual' },
      { name: 'Engagement', w: '20%', cls: 'eng' },
      { name: 'Hidden gem', w: '10%', cls: 'gem' }
    ].forEach(function (part) {
      const chip = el('div', 'un-forge-stack-part ' + part.cls);
      chip.appendChild(el('i', '', ''));
      chip.appendChild(el('b', '', part.w));
      chip.appendChild(document.createTextNode(' ' + part.name));
      stack.appendChild(chip);
    });
    ladder.appendChild(stack);
    sec.appendChild(ladder);

    const verdict = el('div', 'un-forge-guide-block');
    verdict.appendChild(el('h4', 'un-forge-guide-h', 'Match verdicts'));
    const vgrid = el('div', 'un-forge-verdict-grid');
    [
      {
        cls: 'good',
        icon: '✓',
        title: 'Good match',
        body: 'On-topic for your search. Checked by default when you build.'
      },
      {
        cls: 'weak',
        icon: '~',
        title: 'Loose match',
        body: 'Related but not ideal — review before adding.'
      },
      {
        cls: 'off',
        icon: '✗',
        title: 'Off-topic',
        body: 'Wrong vibe — dimmed and unchecked. Graded F automatically.'
      }
    ].forEach(function (v) {
      const card = el('div', 'un-forge-verdict-card ' + v.cls);
      card.appendChild(el('span', 'un-forge-verdict-icon', v.icon));
      card.appendChild(el('b', '', v.title));
      card.appendChild(el('p', '', v.body));
      vgrid.appendChild(card);
    });
    verdict.appendChild(vgrid);
    sec.appendChild(verdict);

    const ranks = el('div', 'un-forge-guide-block');
    ranks.appendChild(el('h4', 'un-forge-guide-h', 'Rank modes'));
    const rlist = el('div', 'un-forge-rank-list');
    const rankCopy = FD && FD.RANK_LABELS ? FD.RANK_LABELS : {};
    [
      ['hidden_gem', 'Small channels, underrated finds — best for “discover something new”.'],
      ['top', 'Most views — crowd favorites and proven hits.'],
      ['newest', 'Fresh uploads — good for timely topics.'],
      ['relevance', 'Closest to your exact words.']
    ].forEach(function (pair) {
      const row = el('div', 'un-forge-rank-row');
      row.appendChild(el('span', 'un-forge-rank-name', rankCopy[pair[0]] || pair[0]));
      row.appendChild(el('span', 'un-forge-rank-desc', pair[1]));
      rlist.appendChild(row);
    });
    ranks.appendChild(rlist);
    sec.appendChild(ranks);

    const pick = el('div', 'un-forge-guide-pick');
    pick.appendChild(el('h4', 'un-forge-guide-h', 'What should I get?'));
    pick.appendChild(
      el(
        'p',
        'un-forge-guide-sub',
        'Quick picks based on what you are trying to do:'
      )
    );
    const picks = el('ul', 'un-forge-pick-list');
    [
      'Cozy background playlist → rank hidden gems, grades A–B, 15–25 videos.',
      'Definitive “best of” list → rank top, keep good matches only.',
      'Deep dive on one topic → relevance rank, sort by best grade.',
      'Watch later pile → hover thumbnails, +Q queue, or +Playlist to sort later.'
    ].forEach(function (line) {
      const li = el('li', '', line);
      picks.appendChild(li);
    });
    pick.appendChild(picks);
    const go = el('button', 'un-forge-btn primary', 'Try Search with this in mind');
    go.type = 'button';
    go.addEventListener('click', function () {
      showTab('search');
    });
    pick.appendChild(go);
    sec.appendChild(pick);

    const thumbTip = el('div', 'un-forge-guide-block un-forge-thumb-tip');
    thumbTip.appendChild(el('h4', 'un-forge-guide-h', 'Thumbnail quick actions'));
    thumbTip.appendChild(
      el(
        'p',
        'un-forge-guide-sub',
        'On Search results (and suggest previews): hover a thumbnail for ☑ select, ▶ preview, +Q queue, and ⊕ playlist — without leaving the panel.'
      )
    );
    sec.appendChild(thumbTip);
  }

  async function refreshAuth() {
    const r = await send(M_AUTH);
    auth.authed = !!(r && r.authed);
    auth.canWrite = auth.authed && hasWrite(r.scopeKeys);
    auth.hasConfig = !!(r && r.hasConfig);
    return auth;
  }

  // Gated on `authed`, not `canWrite`: listing playlists is a READ. Gating it
  // on write scope meant a connected read-only account saw an empty picker and
  // no explanation, which reads as "the extension can't see my playlists".
  // Whether they can be written to is a separate question, answered by the
  // write-scope UI in refreshAuthBanner()/renderPlaylistPicker().
  async function loadPlaylists() {
    if (!auth.authed) {
      playlists = [];
      playlistsLoaded = true;
      playlistsError = 'not_authed';
      return { ok: false, error: playlistsError };
    }
    if (playlistLoadPromise) return playlistLoadPromise;
    playlistsLoading = true;
    playlistsError = null;
    playlistLoadPromise = (async function () {
      const r = await send(M_PLS);
      playlistsLoaded = true;
      if (r && r.ok) {
        playlists = r.playlists || [];
        return { ok: true, playlists: playlists };
      }
      playlists = [];
      playlistsError = (r && r.error) || 'no_response';
      return { ok: false, error: playlistsError };
    })();
    try {
      return await playlistLoadPromise;
    } finally {
      playlistsLoading = false;
      playlistLoadPromise = null;
    }
  }

  function isPlaylistAuthError(err) {
    const e = String(err || '');
    if (/not_authed|no_refresh_token|refresh_failed|auth_expired|invalid_grant/i.test(e)) return true;
    return /(^|[^0-9])401([^0-9]|$)/.test(e);
  }

  function playlistLoadMessage(err) {
    const e = String(err || '');
    if (!e) return 'No YouTube playlists found';
    if (isPlaylistAuthError(e)) return 'YouTube session expired - reconnect to load playlists';
    if (/(^|[^0-9])403([^0-9]|$)/.test(e)) return 'YouTube refused playlist access (403) - check OAuth/API setup';
    if (/quota/i.test(e)) return 'YouTube API quota used up - playlists can load again tomorrow';
    if (/no_response/i.test(e)) return "Couldn't reach the extension background - try again";
    return "Couldn't load YouTube playlists: " + e.slice(0, 70);
  }

  function refreshPlaylistUi() {
    renderPlaylistPicker();
    if (searchPanelApi && searchPanelApi.refreshPlaylistPicker) searchPanelApi.refreshPlaylistPicker();
    return refreshAuth()
      .then(function () {
        refreshAuthBanner();
        renderPlaylistPicker();
        if (searchPanelApi && searchPanelApi.refreshPlaylistPicker) searchPanelApi.refreshPlaylistPicker();
        return loadPlaylists();
      })
      .then(function (r) {
        refreshAuthBanner();
        renderPlaylistPicker();
        if (searchPanelApi && searchPanelApi.refreshPlaylistPicker) searchPanelApi.refreshPlaylistPicker();
        if (searchPanelApi && searchPanelApi.refreshWriteUi) searchPanelApi.refreshWriteUi();
        return r;
      });
  }


  /**
   * What is stopping this panel from doing its job, in the order it should be
   * fixed. Returns [] when nothing is.
   *
   * The panel has two independent prerequisites and used to report them as two
   * differently-styled messages stacked at the top with no order between them:
   * a bordered connect prompt and a loose amber sentence. A user could not tell
   * which to fix first, or that fixing one still left the other.
   */
  function forgeBlockers(stats) {
    const out = [];
    if (!auth.hasConfig) {
      out.push({
        id: 'config',
        title: 'Add your Google credentials',
        body: 'Forge writes playlists with your own OAuth client, so nothing goes through a server we run.',
        action: 'Account settings',
        run: function () { openDashboard('account'); }
      });
    } else if (!auth.canWrite) {
      out.push({
        id: 'connect',
        title: auth.authed ? 'Reconnect with write access' : 'Connect YouTube',
        body: auth.authed
          ? 'The current connection is read-only, so Forge can suggest but not save.'
          : 'Forge needs permission to create playlists on your account.',
        action: auth.authed ? 'Reconnect YouTube' : 'Connect YouTube',
        run: connectYouTube
      });
    }
    if (!stats || (!stats.ws && !stats.ss)) {
      out.push({
        id: 'history',
        title: 'No watch history yet',
        body: 'Suggestions are built from what you actually watch. Import a Google Takeout export, or watch a few videos past 75%.',
        action: 'Import Takeout',
        run: function () { openDashboard('account'); }
      });
    }
    return out;
  }

  /**
   * Render the blocked state, or clear it.
   *
   * Centred in the panel rather than stacked at the top: an empty state that
   * hugs the header and leaves 600px blank reads as a broken panel, not as a
   * panel waiting for something.
   */
  function renderForgeBlocked(stats) {
    const panel = document.querySelector('.un-forge-panel');
    if (!panel) return false;
    const blockers = forgeBlockers(stats);
    let box = document.getElementById('un-forge-blocked');
    panel.classList.toggle('is-blocked', blockers.length > 0);
    if (!blockers.length) {
      if (box) box.remove();
      return false;
    }
    if (!box) {
      box = el('div', 'un-forge-blocked');
      box.id = 'un-forge-blocked';
      const nav = panel.querySelector('.un-forge-nav');
      panel.insertBefore(box, nav || null);
    }
    box.textContent = '';
    box.appendChild(el('p', 'un-forge-blocked-lead',
      blockers.length === 1 ? 'One thing first' : blockers.length + ' things first'));
    blockers.forEach(function (b, i) {
      const step = el('div', 'un-forge-blocked-step');
      step.appendChild(el('span', 'un-forge-blocked-n', String(i + 1)));
      const body = el('div', 'un-forge-blocked-body');
      body.appendChild(el('h4', 'un-forge-blocked-t', b.title));
      body.appendChild(el('p', 'un-forge-blocked-d', b.body));
      const act = el('button', 'un-forge-btn' + (i === 0 ? '' : ' ghost'), b.action);
      act.type = 'button';
      act.addEventListener('click', b.run);
      body.appendChild(act);
      step.appendChild(body);
      box.appendChild(step);
    });
    return true;
  }

  function refreshAuthBanner() {
    const box = document.getElementById('un-forge-auth');
    if (!box) return;
    box.textContent = '';
    if (auth.canWrite && !playlistsError) {
      box.className = 'un-forge-auth ok';
      box.appendChild(el('span', '', playlistsLoading ? 'YouTube connected - loading playlists.' : 'YouTube connected - can create playlists here'));
      return;
    }
    // When the panel is blocked, the blocked state says this properly and this
    // banner would be the second message for the same problem.
    //
    // ONLY when the blocked state actually covers this problem. A failed
    // playlist fetch is not one of the blockers — forgeBlockers() ranks config,
    // connect and history — so with canWrite true and an expired session the
    // blocked box was up for the HISTORY blocker, this banner blanked itself
    // deferring to it, and nothing on the panel mentioned that playlists had
    // failed to load. Silence about the actual error, caused by suppressing a
    // duplicate that was not a duplicate.
    if (document.getElementById('un-forge-blocked') && !playlistsError) {
      box.className = 'un-forge-auth';
      box.textContent = '';
      return;
    }
    box.className = 'un-forge-auth warn';
    const msg = el('span', '', playlistsError && auth.authed ? playlistLoadMessage(playlistsError) : auth.authed ? 'Read-only - reconnect with write access to create playlists' : auth.hasConfig ? 'Connect YouTube to create playlists on this panel' : 'Add OAuth credentials in Account settings first');
    const acts = el('div', 'un-forge-auth-acts');
    if (!auth.hasConfig) {
      const settings = el('button', 'un-forge-btn ghost', 'Account settings');
      settings.type = 'button';
      settings.addEventListener('click', function () {
        openDashboard('account');
      });
      acts.appendChild(settings);
    } else if (!auth.canWrite || playlistsError) {
      // Only a profile that WAS connected can reconnect. A fresh profile gets
      // an auth error from the playlist fetch too, and read "Reconnect YouTube"
      // for an account it had never linked (seen live 2026-09-21).
      const needsReconnect = !!auth.authed && isPlaylistAuthError(playlistsError);
      // Never-connected first: such a profile also has a failed playlist fetch,
      // and read "Retry playlists" for an account it had never linked.
      const connect = el('button', 'un-forge-btn', !auth.authed ? 'Connect YouTube' : needsReconnect ? 'Reconnect YouTube' : playlistsError ? 'Retry playlists' : 'Enable write access');
      connect.type = 'button';
      connect.addEventListener('click', needsReconnect || !auth.authed || !auth.canWrite ? connectYouTube : refreshPlaylistUi);
      acts.appendChild(connect);
    }
    box.append(msg, acts);
  }

  async function connectYouTube() {
    setStatus('Opening Google sign-in…');
    const r = await send(M_AUTH_START, { scopes: ['readonly', 'write'] });
    if (r && r.ok) {
      await refreshAuth();
      await loadPlaylists();
      refreshAuthBanner();
      renderPlaylistPicker();
      if (searchPanelApi && searchPanelApi.refreshPlaylistPicker) searchPanelApi.refreshPlaylistPicker();
      if (searchPanelApi && searchPanelApi.refreshWriteUi) searchPanelApi.refreshWriteUi();
      setStatus(auth.canWrite ? 'Connected — you can create playlists here.' : 'Connected (read-only). Reconnect with write access.', auth.canWrite ? 'ok' : 'warn');
    } else {
      setStatus('Connect failed — check Account tab in the dashboard.', 'err');
    }
  }

  function loadTasteData() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(['watchStats', 'watchedVideos'], function (d) {
        resolve({
          watchStats: d.watchStats || null,
          watchedIds: d.watchedVideos || []
        });
      });
    });
  }

  function buildDiscoverTaste(tasteData, formFields) {
    if (!FD || !FD.buildTastePayload) return null;
    const tp = getTastePrefs();
    const f = formFields || {};
    return FD.buildTastePayload({
      excludeWatched: f.excludewatched != null ? f.excludewatched : tp.excludeWatched !== false,
      boostChannels: f.boostchannels != null ? f.boostchannels : tp.boostChannels === true,
      excludeAI: f.excludeai != null ? f.excludeai : tp.excludeAI !== false,
      watchedIds: tasteData.watchedIds,
      watchStats: tasteData.watchStats,
      customAvoidChannelNames: tp.customAvoidChannels || []
    });
  }

  function renderTasteChip(ws) {
    const chip = document.getElementById('un-forge-taste-chip');
    if (!chip) return;
    const tp = getTastePrefs();
    const bits = [];
    if (tp.excludeAI !== false) bits.push('human narrators');
    if (tp.excludeWatched !== false) bits.push('skip watched');
    if (!tp.boostChannels) bits.push('no channel boost');
    if (tp.customAvoidChannels && tp.customAvoidChannels.length) bits.push('blocklist ' + tp.customAvoidChannels.length);
    if (FD && ws && ws.topChannels && ws.topChannels.length) {
      const part = FD.partitionChannels(ws.topChannels, ws);
      if (part.avoid.length) bits.push('avoid ' + part.avoid.length + ' saturated');
    }
    chip.textContent = bits.length ? bits.join(' · ') : 'Default taste filters';
    chip.title = 'Edit in dashboard Stats → Forge defaults';
  }

  function renderOnboarding(ws, ss) {
    const box = document.getElementById('un-forge-onboard');
    if (!box) return;
    if (ws || ss) {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    box.innerHTML = '';
    box.appendChild(el('p', '', 'Import Takeout on the Watched tab or watch videos past 75% for personalized suggestions.'));
    const row = el('div', 'un-forge-onboard-acts');
    const wat = el('button', 'un-forge-btn ghost', 'Open Watched settings');
    wat.type = 'button';
    wat.addEventListener('click', function () {
      openDashboard('watched');
    });
    const tryBtn = el('button', 'un-forge-btn', 'Try a template in Search');
    tryBtn.type = 'button';
    tryBtn.addEventListener('click', function () {
      showTab('search');
      if (FD && FD.FORGE_TEMPLATES && FD.FORGE_TEMPLATES[0] && searchPanelApi) {
        searchPanelApi.setQuery(FD.FORGE_TEMPLATES[0].query);
      }
    });
    row.append(wat, tryBtn);
    box.appendChild(row);
  }

  function renderTemplateRow(container) {
    if (!container || !FD || !FD.FORGE_TEMPLATES) return;
    container.textContent = '';
    container.appendChild(el('span', 'un-forge-tpl-lbl', 'Quick start'));
    FD.FORGE_TEMPLATES.forEach(function (tpl) {
      const b = el('button', 'un-forge-tpl', tpl.label);
      b.type = 'button';
      b.title = tpl.query;
      b.addEventListener('click', function () {
        openSearchTab(tpl.query);
      });
      container.appendChild(b);
    });
  }

  function wireThumbImg(img, v) {
    if (!FD || !FD.thumbFallbackUrls) {
      const id = videoIdOf(v);
      img.src = v.thumb || v.thumbnail || (id ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' : '');
      return;
    }
    const urls = FD.thumbFallbackUrls(v);
    let idx = 0;
    img.src = urls[0] || '';
    img.alt = v.title || '';
    img.onerror = function () {
      idx += 1;
      if (idx < urls.length) img.src = urls[idx];
      else img.onerror = null;
    };
  }

  function thumbActBtn(icon, title, onClick) {
    const b = el('button', 'un-forge-s-tact');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = icon;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function openPreviewPlMenu(wrap, videoId) {
    if (!wrap || !videoId) return;
    let menu = wrap.querySelector('.un-forge-s-plmenu');
    if (!menu) {
      menu = el('div', 'un-forge-s-plmenu');
      wrap.appendChild(menu);
    }
    if (menu.classList.contains('on')) {
      menu.classList.remove('on');
      return;
    }
    document.querySelectorAll('.un-forge-s-plmenu.on').forEach(function (m) {
      m.classList.remove('on');
    });
    menu.textContent = '';
    menu.classList.add('on');
    menu.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    refreshAuth().then(function () {
      return loadPlaylists();
    }).then(function () {
      if (!menu.classList.contains('on')) return;
      menu.textContent = '';
      if (!auth.canWrite) {
        menu.appendChild(el('span', 'un-forge-s-plload', 'Connect YouTube to add to playlists'));
        return;
      }
      const wl = el('button', 'un-forge-s-plopt', 'Watch Later');
      wl.type = 'button';
      wl.addEventListener('click', function () {
        menu.classList.remove('on');
        addVideoToWatchLater(videoId);
      });
      menu.appendChild(wl);
      if (!playlists.length) {
        menu.appendChild(el('span', 'un-forge-s-plload', 'No playlists loaded'));
        return;
      }
      playlists.slice(0, 18).forEach(function (pl) {
        const opt = el('button', 'un-forge-s-plopt', pl.title || pl.id);
        opt.type = 'button';
        opt.addEventListener('click', function () {
          menu.classList.remove('on');
          addVideoToPlaylist(pl.id, [videoId]);
        });
        menu.appendChild(opt);
      });
    });
  }

  function renderPreviewVid(v) {
    const id = videoIdOf(v);
    const card = el('div', 'un-forge-vid-card');
    const tw = el('div', 'un-forge-vid-thumbwrap un-forge-s-thumbwrap');
    const img = el('img', 'un-forge-s-thumb');
    img.loading = 'lazy';
    wireThumbImg(img, v);
    const shade = el('div', 'un-forge-s-thumbshade');
    const titleStrip = el('div', 'un-forge-s-thumbtitle', v.title || id);
    const acts = el('div', 'un-forge-s-thumbacts');
    const plWrap = el('div', 'un-forge-s-plwrap');
    acts.append(
      thumbActBtn('▶', 'Preview on YouTube', function () {
        openUrl(v.url || 'https://www.youtube.com/watch?v=' + id);
      }),
      thumbActBtn('+Q', 'Add to queue', function () {
        addVideoToQueue(v);
      })
    );
    const plBtn = thumbActBtn('⊕', 'Add to playlist', function () {
      openPreviewPlMenu(plWrap, id);
    });
    plWrap.append(plBtn, el('div', 'un-forge-s-plmenu'));
    acts.appendChild(plWrap);
    tw.append(img, shade, titleStrip, acts);
    tw.addEventListener('click', function (e) {
      if (e.target.closest('.un-forge-s-tact, .un-forge-s-plmenu, .un-forge-s-pick')) return;
      openUrl(v.url || 'https://www.youtube.com/watch?v=' + id);
    });
    card.appendChild(tw);
    card.appendChild(el('div', 'un-forge-vid-ch', v.channelTitle || ''));
    return card;
  }

  async function discoverVideos(q, count, opts) {
    opts = opts || {};
    const tasteData = await loadTasteData();
    const taste = buildDiscoverTaste(tasteData);
    const overrides = { count: count || prefs.count || 25, filters: { excludeAI: opts.excludeAI !== false } };
    const body = { request: q, overrides: overrides };
    if (taste) body.taste = taste;
    // Proxied through the SW (content scripts can't fetch playlist-forge — CORS).
    const res = await window.UNForgeLinks.apiFetch('/api/discover', { method: 'POST', body: body });
    if (!res.ok) throw new Error((res.data && res.data.error) || 'discover_failed');
    const json = res.data || {};
    const list = FD && FD.extractDiscoverCandidates ? FD.extractDiscoverCandidates(json) : json.candidates || json.videos || [];
    return list.map(function (v) {
      return FD && FD.normalizeCandidate ? FD.normalizeCandidate(v) : v;
    });
  }

  function videoIdOf(v) {
    if (!v) return '';
    return v.id || v.videoId || (v.snippet && v.snippet.resourceId && v.snippet.resourceId.videoId) || '';
  }

  async function buildOnYouTube(opts) {
    await refreshAuth();
    const title = (opts.title || 'Playlist').slice(0, 150);
    let ids = (opts.videoIds || []).filter(Boolean);
    const q = opts.q || opts.searchQuery || title;
    if (!ids.length && q) {
      setStatus('Finding videos…');
      const list = await discoverVideos(q, opts.count || prefs.count);
      ids = list.map(videoIdOf).filter(Boolean);
    }
    if (!ids.length) {
      setStatus('No videos to add.', 'err');
      return null;
    }
    if (!auth.canWrite) {
      setStatus('Connect YouTube with write access first.', 'err');
      refreshAuthBanner();
      return null;
    }
    setStatus('Creating playlist on YouTube…');
    updateProgressBar(0, ids.length);
    try {
      const r = await createViaPort({
        title: title,
        videoIds: ids,
        privacyStatus: prefs.privacy || 'public'
      });
      if (!r.ok) {
        if (r.error === 'needs_write_scope') {
          setStatus('Need write access — click Connect YouTube.', 'err');
          refreshAuthBanner();
        } else if (r.error === 'auth_expired') {
          setStatus('Session expired — reconnect in Account settings.', 'err');
        } else {
          setStatus('Create failed: ' + (r.error || 'unknown'), 'err');
        }
        return null;
      }
      finishCreateResult(r, title);
      await loadPlaylists();
      renderPlaylistPicker();
      return r;
    } catch (e) {
      setStatus('Create error: ' + e, 'err');
      updateProgressBar(0, 0);
      return null;
    }
  }

  async function addSelectedToPlaylist(playlistId, videoIds) {
    const ids = videoIds || pickedVideoIds();
    if (!ids.length) {
      setStatus('Select videos first.', 'err');
      return;
    }
    if (!auth.canWrite) {
      setStatus('Connect YouTube with write access first.', 'err');
      return;
    }
    setStatus('Adding videos…');
    const r = await send(M_ADD, { playlistId: playlistId, videoIds: ids });
    if (!r.ok) {
      setStatus(r.error === 'auth_expired' ? 'Reconnect YouTube.' : 'Add failed: ' + (r.error || ''), 'err');
      return;
    }
    const added = r.added != null ? r.added : ids.length;
    setStatus('Added ' + added + ' video' + (added === 1 ? '' : 's') + ' to playlist.', 'ok');
    showToast('Added to playlist', added + ' videos', 'https://www.youtube.com/playlist?list=' + playlistId);
  }

  // Delegates to the shared bridge (src/shared/native-queue.js) so every
  // surface that queues a video — this panel, the search panel, feed/playlist
  // row buttons — goes through one implementation and one contract.
  function tryNativeQueueAdd(videoIds, opts) {
    var NQ = window.UNNativeQueue;
    if (!NQ) return Promise.resolve({ ok: false, native: false, error: 'bridge_missing' });
    return NQ.add(videoIds, opts);
  }

  function queueItemFromVideo(v) {
    const id = videoIdOf(v);
    return {
      id: id,
      title: v.title || '',
      thumb: v.thumb || v.thumbnail || (id ? 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' : ''),
      channel: v.channelTitle || '',
      dur: v.durationSec || 0
    };
  }

  // Everything added from here APPENDS to YouTube's queue. opts.toFront is
  // still accepted and still orders the extension's own list, but it cannot
  // move anything on the native side.
  //
  // This is a platform limit, not a missing feature. Measured live 2026-09-15:
  // a queue row's action menu contains exactly "Remove from playlist" and
  // "Share" — there is no front-insert command and no reorder control to drive,
  // and the addToPlaylistCommand used below is append-only by construction.
  // An earlier pass "fixed" this by forwarding toFront across the bridge, where
  // the page-world handler reads it nowhere: the label changed, the behaviour
  // did not. The status text below now says what actually happens.
  function addManyVideosToQueue(videos, opts) {
    const items = (videos || []).map(queueItemFromVideo).filter(function (i) {
      return i && i.id;
    });
    if (!items.length) {
      setStatus('Select videos first.', 'err');
      return;
    }
    const ids = items.map(function (i) {
      return i.id;
    });
    var toFront = !opts || opts.toFront !== false;
    tryNativeQueueAdd(ids, { toFront: toFront }).then(function (native) {
      if (native && native.native) {
        setStatus('Added to YouTube queue · ' + items.length + ' · lands at the end of Up next.', 'ok');
      } else {
        setStatus("Couldn't reach YouTube's queue.", 'err');
      }
      if (searchPanelApi && searchPanelApi.refreshQueueBar) searchPanelApi.refreshQueueBar();
    });
  }

  function addVideoToQueue(v, opts) {
    addManyVideosToQueue([v], opts);
  }

  async function addVideoToWatchLater(videoId) {
    if (!videoId) return;
    if (!auth.canWrite) {
      setStatus('Connect YouTube with write access first.', 'err');
      refreshAuthBanner();
      return;
    }
    setStatus('Adding to Watch Later…');
    const r = await send(M_WL, { videoIds: [videoId] });
    if (!r.ok) {
      setStatus(r.error === 'auth_expired' ? 'Reconnect YouTube.' : 'Watch Later failed: ' + (r.error || ''), 'err');
      return;
    }
    setStatus('Added to Watch Later.', 'ok');
  }

  async function addVideoToPlaylist(playlistId, videoIdOrIds) {
    const ids = Array.isArray(videoIdOrIds) ? videoIdOrIds.filter(Boolean) : videoIdOrIds ? [videoIdOrIds] : [];
    if (!ids.length || !playlistId) return;
    await addSelectedToPlaylist(playlistId, ids);
  }

  async function addManyToWatchLater(videoIds) {
    const ids = (videoIds || []).filter(Boolean);
    if (!ids.length) {
      setStatus('Select videos first.', 'err');
      return;
    }
    if (!auth.canWrite) {
      setStatus('Connect YouTube with write access first.', 'err');
      refreshAuthBanner();
      return;
    }
    setStatus('Adding to Watch Later…');
    const r = await send(M_WL, { videoIds: ids });
    if (!r.ok) {
      setStatus(r.error === 'auth_expired' ? 'Reconnect YouTube.' : 'Watch Later failed: ' + (r.error || ''), 'err');
      return;
    }
    const added = r.added != null ? r.added : ids.length;
    setStatus('Added ' + added + ' video' + (added === 1 ? '' : 's') + ' to Watch Later.', 'ok');
  }

  function renderIdeas(ideas) {
    const box = document.getElementById('un-forge-ideas');
    if (!box) return;
    box.textContent = '';
    if (!ideas || !ideas.length) {
      const empty = el('div', 'un-forge-empty-card');
      empty.appendChild(el('p', '', 'No ideas yet'));
      empty.appendChild(el('p', 'un-forge-empty-sub', 'Import Takeout on the Watched tab or watch videos past 75%, then try again.'));
      const wat = el('button', 'un-forge-btn ghost', 'Open Watched settings');
      wat.type = 'button';
      wat.addEventListener('click', function () {
        openDashboard('watched');
      });
      empty.appendChild(wat);
      box.appendChild(empty);
      return;
    }
    ideas.forEach(function (idea, idx) {
      const card = el('div', 'un-forge-idea');
      card.appendChild(el('span', 'un-forge-idea-kind', idea.kind || 'theme'));
      card.appendChild(el('div', 'un-forge-idea-title', idea.title));
      if (idea.why || idea.description) card.appendChild(el('div', 'un-forge-idea-why', idea.why || idea.description));
      const prevBox = el('div', 'un-forge-discover');
      prevBox.dataset.ideaIdx = String(idx);
      prevBox.appendChild(el('p', 'un-forge-idea-preview-lbl', 'Loading video previews…'));
      card.appendChild(prevBox);
      const acts = el('div', 'un-forge-idea-acts');
      const yt = el('button', 'un-forge-btn primary', 'Create on YouTube');
      yt.type = 'button';
      yt.addEventListener('click', function () {
        btnLoading(yt, true);
        buildOnYouTube({ title: idea.title, q: idea.searchQuery || idea.title, count: idea.count || prefs.count })
          .catch(function (e) {
            setStatus(String(e), 'err');
          })
          .finally(function () {
            btnLoading(yt, false, 'Create on YouTube');
          });
      });
      const review = el('button', 'un-forge-btn', 'Search this idea');
      review.type = 'button';
      review.addEventListener('click', function () {
        openSearchTab(idea.searchQuery || idea.title);
      });
      const reviewForge = el('button', 'un-forge-btn ghost', 'Review on Forge ↗');
      reviewForge.type = 'button';
      reviewForge.addEventListener('click', function () {
        openUrl(ideaUrl(idea, false));
      });
      const quick = el('button', 'un-forge-btn ghost', 'Forge quick build ↗');
      quick.type = 'button';
      quick.addEventListener('click', function () {
        openUrl(ideaUrl(idea, true));
      });
      acts.append(yt, review, reviewForge, quick);
      card.appendChild(acts);
      box.appendChild(card);
    });
    loadIdeaPreviews(ideas);
  }

  async function loadIdeaPreviews(ideas) {
    const previewCount = Math.min(8, prefs.count || 25);
    for (let i = 0; i < ideas.length; i++) {
      const idea = ideas[i];
      const box = document.querySelector('#un-forge-ideas .un-forge-discover[data-idea-idx="' + i + '"]');
      if (!box) continue;
      try {
        const list = await discoverVideos(idea.searchQuery || idea.title, previewCount);
        box.textContent = '';
        if (!list.length) {
          box.appendChild(el('p', 'un-forge-empty-sub', 'No videos found for this idea yet — try Search this idea.'));
          continue;
        }
        const head = el('div', 'un-forge-idea-preview-head', 'Preview · ' + list.length + ' found');
        box.appendChild(head);
        list.slice(0, 8).forEach(function (v) {
          box.appendChild(renderPreviewVid(v));
        });
      } catch (e) {
        box.textContent = '';
        box.appendChild(el('p', 'un-forge-empty-sub', 'Could not load previews — try Search this idea.'));
      }
    }
  }

  function renderPlaylistPicker(selectId) {
    const sel = document.getElementById(selectId || 'un-forge-pl-pick');
    if (!sel) return;
    sel.textContent = '';
    // Adding to a playlist needs write scope, so the control stays disabled
    // without it — but the message must describe the ACTUAL state. It used to
    // say "Connect YouTube first" to an already-connected read-only user,
    // sending them to re-run a connection that was already done.
    if (!auth.canWrite || playlistsLoading || playlistsError || !playlists.length) {
      sel.disabled = true;
      let msg;
      if (!auth.authed) msg = 'Connect YouTube first';
      else if (!auth.canWrite) msg = 'Read-only - enable write access';
      else if (playlistsLoading || !playlistsLoaded) msg = 'Loading YouTube playlists.';
      else if (playlistsError) msg = playlistLoadMessage(playlistsError);
      else msg = 'No YouTube playlists found';
      sel.appendChild(el('option', '', msg));
      return;
    }
    sel.disabled = false;
    sel.appendChild(el('option', '', 'Add selected to…'));
    playlists.slice(0, 40).forEach(function (pl) {
      const opt = el('option', '', pl.title + (pl.count ? ' (' + pl.count + ')' : ''));
      opt.value = pl.id;
      sel.appendChild(opt);
    });
  }

  function pickedVideoIds() {
    if (searchPanelApi && searchPanelApi.getPickedIds) return searchPanelApi.getPickedIds();
    return [];
  }

  function openSearchTab(query) {
    ensurePanel();
    setPanelOpen(true);
    showTab('search');
    if (searchPanelApi) {
      if (query) searchPanelApi.setQuery(query);
      if (query) searchPanelApi.runDiscover();
    }
  }

  async function refreshStatsLine() {
    const line = document.getElementById('un-forge-stats-line');
    if (!line) return null;
    return new Promise(function (resolve) {
      chrome.storage.local.get(['watchStats', 'searchStats'], function (d) {
        const ws = d.watchStats;
        const ss = d.searchStats;
        if (!ws && !ss) {
          // Handled by the blocked state, which ranks it against the auth
          // blocker instead of printing a second unranked warning beside it.
          line.textContent = '';
          line.className = 'un-forge-stats-line';
          renderForgeBlocked(null);
          resolve(null);
          return;
        }
        const bits = [];
        if (ws && ws.total) bits.push(ws.total.toLocaleString() + ' plays');
        if (ws && ws.uniqueChannels) bits.push(ws.uniqueChannels + ' channels');
        if (ss && ss.total) bits.push(ss.total.toLocaleString() + ' searches');
        if (FD && ws && ws.topChannels && ws.topChannels.length) {
          const part = FD.partitionChannels(ws.topChannels, ws);
          if (part.avoid.length) bits.push('avoiding ' + part.avoid.length + ' saturated channels');
        }
        line.textContent = bits.length ? 'Using ' + bits.join(' · ') : 'Stats loaded — ready to suggest.';
        line.className = 'un-forge-stats-line ok';
        renderForgeBlocked({ ws: ws, ss: ss });
        renderTasteChip(ws);
        renderOnboarding(ws, ss);
        resolve({ ws: ws, ss: ss });
      });
    });
  }

  async function runSuggest() {
    const btn = document.getElementById('un-forge-suggest-btn');
    const data = await refreshStatsLine();
    if (!data || (!data.ws && !data.ss)) {
      setStatus('Need watch or search stats first (Watched tab / Takeout).', 'err');
      showTab('suggest');
      return;
    }
    if (!WS || !WS.summarizeForForge) {
      setStatus('Stats helper missing — reload the extension.', 'err');
      return;
    }
    btnLoading(btn, true, 'Thinking…');
    setStatus('');
    try {
      let summary = WS.summarizeForForge(data.ws, data.ss);
      if (FD && FD.enrichSuggestSummary) summary = FD.enrichSuggestSummary(summary, data.ws);
      // Proxied through the SW (content scripts can't fetch playlist-forge — CORS).
      const res = await window.UNForgeLinks.apiFetch('/api/suggest', { method: 'POST', body: { summary: summary } });
      const json = res.data || {};
      if (!res.ok || !json.ideas) {
        setStatus('Suggest failed: ' + (json.error || res.status), 'err');
        renderIdeas([]);
      } else {
        setStatus(json.ideas.length + ' playlist ideas from your history.', 'ok');
        renderIdeas(json.ideas);
      }
    } catch (e) {
      setStatus('Could not reach Playlist Forge: ' + e, 'err');
    }
    btnLoading(btn, false, '✨ Suggest from my history');
  }

  function mountSearchPanel(secSearch) {
    const searchPanel = fsp();
    if (!searchPanel || !searchPanel.create) {
      secSearch.appendChild(el('p', 'un-forge-hint', 'Search panel failed to load - reload the extension.'));
      return;
    }
    const panel = searchPanel.create({
      setStatus: setStatus,
      btnLoading: btnLoading,
      openUrl: openUrl,
      getPrefs: function () {
        return prefs;
      },
      getTastePrefs: getTastePrefs,
      onPrefsChange: function (p) {
        prefs = p;
        savePrefs();
      },
      buildOnYouTube: buildOnYouTube,
      addToPlaylist: addVideoToPlaylist,
      addToWatchLater: addVideoToWatchLater,
      addToQueue: addVideoToQueue,
      addManyToQueue: addManyVideosToQueue,
      addManyToWatchLater: addManyToWatchLater,
      canWrite: function () {
        return auth.canWrite;
      },
      getPlaylists: function () {
        return playlists;
      },
      getPlaylistState: function () {
        return {
          items: playlists,
          loaded: playlistsLoaded,
          loading: playlistsLoading,
          error: playlistsError,
          errorMessage: playlistLoadMessage(playlistsError)
        };
      },
      ensurePlaylists: function () {
        return refreshPlaylistUi();
      },
      forgeBuildUrl: forgeBuildUrl,
      renderPlaylistPicker: renderPlaylistPicker,
      showQueueTab: function () { showTab('queue'); }
    });
    if (panel) {
      searchPanelApi = panel.mount(secSearch);
      if (searchPanelApi && searchPanelApi.refreshPlaylistPicker) searchPanelApi.refreshPlaylistPicker();
      if (searchPanelApi && searchPanelApi.refreshWriteUi) searchPanelApi.refreshWriteUi();
    } else {
      secSearch.appendChild(el('p', 'un-forge-hint', 'Search helpers missing - reload the extension.'));
    }
  }

  function mountQueuePanel(secQueue) {
    const WQP = window.UNWatchQueuePanel;
    if (!WQP || !WQP.create) {
      secQueue.appendChild(el('p', 'un-forge-hint', 'Queue panel failed to load — reload the extension.'));
      return;
    }
    const panel = WQP.create({ openUrl: openUrl });
    if (panel) queuePanelApi = panel.mount(secQueue);
    else secQueue.appendChild(el('p', 'un-forge-hint', 'Queue helpers missing — reload the extension.'));
  }

  function ensurePanel() {
    if (panelRoot()) return;
    const root = el('div', 'un-forge-root');
    root.id = 'un-forge-root';

    const backdrop = el('button', 'un-forge-backdrop');
    backdrop.id = 'un-forge-backdrop';
    backdrop.type = 'button';
    backdrop.setAttribute('aria-label', 'Close Forge panel');
    backdrop.addEventListener('click', function () {
      setPanelOpen(false);
    });

    const tab = el('button', 'un-wft-btn un-forge-tab', 'Forge');
    tabEl = tab;
    tab.setAttribute('data-un-sp-launch', 'forge');
    tab.type = 'button';
    tab.title = 'Playlist Forge — suggest & build playlists';
    tab.setAttribute('aria-label', tab.title);
    tab.setAttribute('aria-expanded', 'false');
    tab.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    const panel = el('div', 'un-forge-panel');
    forgePanelEl = panel;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'un-forge-panel-title');
    const head = el('div', 'un-forge-head');
    const brand = el('div', 'un-forge-brand');
    brand.appendChild(el('span', 'un-forge-logo', '⚒'));
    const brandTitle = el('b', '', 'Playlist Forge');
    brandTitle.id = 'un-forge-panel-title';
    brand.appendChild(brandTitle);
    head.appendChild(brand);
    const headActs = el('div', 'un-forge-head-acts');
    const site = el('button', 'un-forge-link', 'Site ↗');
    site.type = 'button';
    site.addEventListener('click', function () {
      openUrl(FL ? FL.forgeFromYoutube() : FORGE + '/?from=youtube');
    });
    const close = el('button', 'un-forge-x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close Forge panel');
    close.addEventListener('click', function () {
      setPanelOpen(false);
    });
    headActs.append(site, close);
    head.appendChild(headActs);
    panel.appendChild(head);

    const authBox = el('div', 'un-forge-auth');
    authBox.id = 'un-forge-auth';
    panel.appendChild(authBox);

    const statsLine = el('p', 'un-forge-stats-line', '');
    statsLine.id = 'un-forge-stats-line';
    panel.appendChild(statsLine);
    const tasteChip = el('div', 'un-forge-taste-chip');
    tasteChip.id = 'un-forge-taste-chip';
    panel.appendChild(tasteChip);
    const onboard = el('div', 'un-forge-onboard');
    onboard.id = 'un-forge-onboard';
    onboard.style.display = 'none';
    panel.appendChild(onboard);
    const tplRow = el('div', 'un-forge-templates');
    tplRow.id = 'un-forge-templates';
    panel.appendChild(tplRow);
    renderTemplateRow(tplRow);
    const statusBox = el('div', 'un-forge-status', '');
    statusBox.id = 'un-forge-status';
    panel.appendChild(statusBox);
    const prog = el('div', 'un-forge-progress');
    prog.id = 'un-forge-progress';
    const progFill = el('div', 'un-forge-progress-fill');
    progFill.id = 'un-forge-progress-fill';
    prog.appendChild(progFill);
    panel.appendChild(prog);

    const nav = el('div', 'un-forge-nav');
    ['guide', 'suggest', 'search', 'queue', 'page', 'options'].forEach(function (name) {
      const labels = { guide: '✦ Guide', suggest: 'Suggest', search: 'Search', queue: '▶ Queue', page: 'This page', options: 'Options' };
      const b = el('button', '', labels[name]);
      b.type = 'button';
      b.dataset.tab = name;
      b.addEventListener('click', function () {
        showTab(name);
      });
      nav.appendChild(b);
    });
    panel.appendChild(nav);

    const secGuide = el('div', 'un-forge-section');
    secGuide.dataset.section = 'guide';
    panel.appendChild(secGuide);

    // Suggest section
    const secSuggest = el('div', 'un-forge-section on');
    secSuggest.dataset.section = 'suggest';
    secSuggest.appendChild(el('h3', 'un-forge-h', 'From your watch history'));
    const sugBtn = el('button', 'un-forge-btn primary', '✨ Suggest from my history');
    sugBtn.type = 'button';
    sugBtn.id = 'un-forge-suggest-btn';
    sugBtn.addEventListener('click', runSuggest);
    secSuggest.appendChild(sugBtn);
    secSuggest.appendChild(el('div', 'un-forge-ideas', ''));
    secSuggest.querySelector('.un-forge-ideas').id = 'un-forge-ideas';
    panel.appendChild(secSuggest);

    // Search section (full discover flow)
    const secSearch = el('div', 'un-forge-section');
    secSearch.dataset.section = 'search';
    panel.appendChild(secSearch);

    // Watch queue (advanced view — reorder/remove/play, live-synced with the
    // mini queue bar in the Search tab and the dashboard's own queue list)
    const secQueue = el('div', 'un-forge-section');
    secQueue.dataset.section = 'queue';
    panel.appendChild(secQueue);

    // Page context
    const secPage = el('div', 'un-forge-section');
    secPage.dataset.section = 'page';
    secPage.appendChild(el('h3', 'un-forge-h', 'From this page'));
    const ctx = el('div', 'un-forge-ctx');
    ctx.id = 'un-forge-ctx';
    secPage.appendChild(ctx);
    panel.appendChild(secPage);

    // Options
    const secOpt = el('div', 'un-forge-section');
    secOpt.dataset.section = 'options';
    secOpt.appendChild(el('h3', 'un-forge-h', 'Defaults'));
    const setRow = el('label', 'un-forge-set');
    setRow.appendChild(el('span', '', 'Videos per playlist'));
    const countIn = el('input', '');
    countIn.type = 'number';
    countIn.min = '5';
    countIn.max = '100';
    countIn.value = String(prefs.count);
    countIn.addEventListener('change', function () {
      prefs.count = Math.max(5, Math.min(100, +countIn.value || 25));
      countIn.value = String(prefs.count);
      savePrefs();
    });
    setRow.appendChild(countIn);
    secOpt.appendChild(setRow);
    const privRow = el('label', 'un-forge-set');
    privRow.appendChild(el('span', '', 'New playlist privacy'));
    const privSel = el('select', 'un-forge-privacy');
    privSel.id = 'un-forge-privacy';
    ['public', 'unlisted', 'private'].forEach(function (p) {
      const opt = el('option', '', p.charAt(0).toUpperCase() + p.slice(1));
      opt.value = p;
      if (p === prefs.privacy) opt.selected = true;
      privSel.appendChild(opt);
    });
    privSel.addEventListener('change', function () {
      prefs.privacy = privSel.value;
      savePrefs();
    });
    privRow.appendChild(privSel);
    secOpt.appendChild(privRow);
    const foldRow = el('label', 'un-forge-set');
    foldRow.appendChild(el('span', '', 'Default folder'));
    const foldSel = el('select', 'un-forge-folder');
    foldSel.id = 'un-forge-folder';
    foldSel.addEventListener('change', function () {
      prefs.defaultFolder = foldSel.value || '';
      savePrefs();
    });
    foldRow.appendChild(foldSel);
    secOpt.appendChild(foldRow);
    const hint = el('p', 'un-forge-hint', 'Create on YouTube uses Unsynth Account OAuth (write scope). Same defaults live in dashboard Stats → Forge defaults.');
    secOpt.appendChild(hint);
    const dashBtn = el('button', 'un-forge-btn ghost', 'Open dashboard');
    dashBtn.type = 'button';
    dashBtn.addEventListener('click', function () {
      openDashboard('');
    });
    secOpt.appendChild(dashBtn);
    panel.appendChild(secOpt);

    root.append(backdrop, tab, panel);
    // Mounts inside <body>, not on documentElement. YouTube sets
    // `body { position: fixed }` (its own .lock-scrollbar) whenever the guide
    // or a dialog is open, which makes body a stacking context. A sibling of
    // body escapes it and paints over every Unsynth overlay regardless of
    // z-index — measured: the Forge tab won elementFromPoint over the hub
    // panel's folder chips and swallowed the clicks. Staying inside body puts
    // this in the same stacking context as everything else, so --un-z-* wins.
    document.body.appendChild(root);
    mountInHost();
    syncForgeTabVisibility();

    showTab(activeTab);
    if (window.UNSideDock && window.UNSideDock.schedule) window.UNSideDock.schedule();
    refreshPlaylistUi().then(function () {
      loadFolderNames(function () {
        renderFolderSelect(document.getElementById('un-forge-folder'), prefs.defaultFolder || '');
      });
    });
    refreshStatsLine();
    refreshContext();
    // CSS owns the fixed tab position; avoid a forced layout read here.
  }

  function refreshContext() {
    const box = document.getElementById('un-forge-ctx');
    if (!box) return;
    box.textContent = '';
    const plId = playlistIdFromUrl();
    const onPl = location.pathname.startsWith('/playlist') && plId;
    const vid = watchVideoId();
    const sel = selectedVideoIdsFromPage();
    const fromSelect = document.querySelectorAll('.un-plm-on').length > 0;

    function ctxBtn(label, cls, fn) {
      const b = el('button', 'un-forge-btn' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    }

    if (fromSelect && sel.length >= 1) {
      const label = sel.length === 1 ? 'Create playlist from selected video' : 'Create playlist from ' + sel.length + ' selected';
      const createSel = ctxBtn(label, 'primary', function () {
        btnLoading(createSel, true);
        buildOnYouTube({ title: sel.length === 1 ? 'Selected video' : 'Selected videos', videoIds: sel, count: sel.length }).finally(function () {
          btnLoading(createSel, false, label);
        });
      });
      box.appendChild(createSel);
      if (sel.length > 1) {
        box.appendChild(
          ctxBtn('Send selection to Forge ↗', 'ghost', function () {
            openUrl(forgeBuildUrl({ title: 'Selected videos', q: 'selected', videoIds: sel, count: sel.length }));
          })
        );
      }
    }
    if (onPl) {
      box.appendChild(
        ctxBtn('Send this playlist to Forge ↗', '', function () {
          openUrl(forgeBuildUrl({ manage: plId }));
        })
      );
    }
    if (vid && !fromSelect) {
      const ctx = watchPageContext();
      const aroundBtn = ctxBtn('Find similar videos', 'primary', function () {
        openSimilarInForge(vid, ctx ? ctx.title : '', ctx ? ctx.channel : '');
      });
      box.appendChild(aroundBtn);
      const createBtn = ctxBtn('Quick playlist (this video only)', '', function () {
        btnLoading(createBtn, true);
        buildOnYouTube({ title: ctx && ctx.title ? 'Similar to ' + ctx.title.slice(0, 40) : 'Similar videos', videoIds: [vid], count: 1 }).finally(function () {
          btnLoading(createBtn, false, 'Quick playlist (this video only)');
        });
      });
      box.appendChild(createBtn);
      box.appendChild(
        ctxBtn('Open on Forge site ↗', 'ghost', function () {
          if (FL && FL.forgeSeed) openUrl(FL.forgeSeed(vid, { title: ctx ? ctx.title : '' }));
        })
      );
    }
    if (!box.children.length) {
      const empty = el('div', 'un-forge-empty-card');
      empty.appendChild(el('p', '', 'Nothing from this page yet'));
      empty.appendChild(el('p', 'un-forge-empty-sub', 'Open a video or playlist, or use Select on a playlist page.'));
      box.appendChild(empty);
    }
  }

  function ensureSidebar() {
    const sections = document.querySelector('ytd-guide-renderer #sections, tp-yt-app-drawer #sections');
    if (!sections) return;
    // The shared sidebar hub already surfaces Forge when present, so avoid a duplicate guide block.
    if (document.getElementById('un-sidebar-hub')) {
      const dup = document.getElementById('un-forge-guide');
      if (dup) dup.remove();
      return;
    }
    const onPl = location.pathname.startsWith('/playlist') && playlistIdFromUrl();
    const sig = onPl ? 'pl:' + playlistIdFromUrl() : 'home';
    let box = document.getElementById('un-forge-guide');
    if (box && box.dataset.sig === sig) return;
    if (box) box.remove();
    box = el('div', '');
    box.id = 'un-forge-guide';
    box.dataset.sig = sig;
    box.appendChild(el('div', 'un-forge-guide-head', 'Playlist Forge'));
    box.appendChild(el('p', 'un-forge-guide-hint', 'Search playlists, suggest from history, or open Forge.'));

    function mk(label, fn, primary) {
      const b = el('button', 'un-forge-guide-item' + (primary ? ' primary' : ''));
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }

    box.appendChild(
      mk(
        'Open Forge panel',
        function () {
          ensurePanel();
          setPanelOpen(true);
        },
        true
      )
    );
    box.appendChild(
      mk('Suggest from history', function () {
        ensurePanel();
        setPanelOpen(true);
        showTab('suggest');
        runSuggest();
      })
    );
    box.appendChild(
      mk('How grades work', function () {
        ensurePanel();
        setPanelOpen(true);
        showTab('guide');
      })
    );
    box.appendChild(
      mk('Search playlists', function () {
        openSearchTab('');
      })
    );
    box.appendChild(
      mk('Open Forge site ↗', function () {
        openUrl(FL ? FL.forgeFromYoutube() : FORGE + '/?from=youtube');
      })
    );
    if (onPl) {
      box.appendChild(
        mk('Send this playlist ↗', function () {
          openUrl(forgeBuildUrl({ manage: playlistIdFromUrl() }));
        })
      );
    }

    if (core && core.insertGuideBlock) core.insertGuideBlock(sections, box);
    else sections.prepend(box);
  }

  function destroyUI() {
    setPanelOpen(false);
    if (searchPanelApi && searchPanelApi.destroy) searchPanelApi.destroy();
    searchPanelApi = null;
    if (queuePanelApi && queuePanelApi.destroy) queuePanelApi.destroy();
    queuePanelApi = null;
    ['un-forge-root', 'un-forge-guide'].forEach(function (id) {
      const n = document.getElementById(id);
      if (n) n.remove();
    });
    const legacyMasthead = document.getElementById('un-forge-masthead');
    if (legacyMasthead) legacyMasthead.remove();
    if (forgeStorageListener) {
      chrome.storage.onChanged.removeListener(forgeStorageListener);
      forgeStorageListener = null;
    }
    if (forgeMsgListener) {
      chrome.runtime.onMessage.removeListener(forgeMsgListener);
      forgeMsgListener = null;
    }
    if (window.UNSideDock && window.UNSideDock.schedule) window.UNSideDock.schedule();
  }

  function syncForgeTabVisibility() {
    const tab = document.querySelector('.un-forge-tab');
    if (!tab) return;
    const hub = document.getElementById('un-sidebar-hub');
    const hubHasForge = !!(hub && hub.querySelector('.un-hub-forge'));
    tab.style.display = hubHasForge ? 'none' : '';
  }

  function refresh() {
    if (core && !core.isModuleEnabled(mod)) {
      destroyUI();
      return;
    }
    loadPrefs(function () {
      ensurePanel();
      ensureSidebar();
      refreshContext();
      syncForgeTabVisibility();
      loadFolderNames(function () {
        renderFolderSelect(document.getElementById('un-forge-folder'), prefs.defaultFolder || '');
      });
      const countIn = document.querySelector('#un-forge-root input[type=number]');
      if (countIn) countIn.value = String(prefs.count);
      const privSel = document.getElementById('un-forge-privacy');
      if (privSel) privSel.value = prefs.privacy || 'public';
    });
  }

  // Lightweight scan: remount/position only — never re-read storage on every
  // MutationObserver pass (that was a hot path during watch playback).

  // THE LAUNCHER LIVES IN THE MASTHEAD, NOT ON THE RIGHT EDGE.
  //
  // As a fixed tab at right:0 it painted over whatever the related column put
  // under it — measured at 100 percent zoom by zoom-reflow.spec.js, visible in
  // the 2026-09-21 captures as the tab sitting on the Stats card's corner — and
  // it stayed stranded mid-page when a panel opened. The masthead bar already
  // hosts every other module control (Select, Download, Pause), scrolls with
  // fades when it overflows, and is the one place a user looks for Unsynth.
  // Moved on every scan because YouTube rebuilds the masthead on navigation.
  //
  // FROM A KEPT REFERENCE, NOT A SELECTOR. The first version looked the tab up
  // with querySelector on each scan; when YouTube tore the masthead down the
  // old #un-synth-masthead-extra went with it, the tab inside it left the
  // document, and there was nothing left to find — both launchers vanished on
  // the first navigation (probed 2026-09-21: roots present, tabs absent, no
  // errors). The Download button survives the same rebuild because its module
  // keeps the element and re-appends it. Same here.
  let tabEl = null;
  let mountRetries = 0;
  // HOSTED IN THE SIDE PANEL (2026-09-21): the Forge body is UNSidePanel's
  // 'forge' tab — docked beside the video on /watch, a right drawer on every
  // other page — and the masthead chip opens that tab. The fixed slide-out
  // shell this module used to own is the host's job now.
  let forgePanelEl = null;
  function hosted() {
    const r = panelRoot();
    return !!(r && r.closest && r.closest('#un-side-panel, #un-side-panel-float'));
  }
  function mountInHost() {
    const sp = window.UNSidePanel && window.UNSidePanel.register ? window.UNSidePanel : null;
    if (!sp || !forgePanelEl) return;
    sp.register({
      id: 'forge', label: 'Forge', order: 40,
      onShow: function () { setPanelOpen(true, true); },
      onHide: function () { setPanelOpen(false, true); }
    });
    // The whole root moves (see ai-assistant.js): lookups go through the root.
    const hb = sp.body('forge');
    const r = panelRoot();
    if (hb && r && r.parentElement !== hb) hb.appendChild(r);
    // A door under the video on /watch (2026-09-22), beside Stats, Fact check
    // and AI. Off /watch there is no deck and the masthead chip is the door.
    const deck = window.UNWatchDeck;
    const onWatchPage = (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch');
    if (onWatchPage && deck && deck.slot && deck.setLauncher) {
      deck.slot('forge');
      deck.setLauncher('forge', function () { sp.toggle('forge'); });
      if (deck.setSummary) deck.setSummary('forge', 'Suggest, search, build playlists');
      if (deck.syncEmpty) deck.syncEmpty();
      if (deck.syncCollapse) deck.syncCollapse();
    }
  }
  function mountTab() {
    const t = tabEl || document.querySelector('.un-forge-tab');
    const extra = document.getElementById('un-synth-masthead-extra');
    if (!t) return;
    if (!extra) {
      // On a quiet cold load (signed-out home, no feed) the first scan can run
      // before core has built the masthead slot, and a page with no further
      // mutations never scans again — the tab then sits hidden in its root
      // for good (playlist-picker-auth.spec.js timed out on exactly that).
      // Bounded: a page with no masthead at all stops asking after ~10s.
      if (mountRetries < 20) { mountRetries++; setTimeout(mountTab, 500); }
      return;
    }
    mountRetries = 0;
    if (t.parentElement !== extra) extra.appendChild(t);
  }

  function lightScan() {
    if (core && !core.isModuleEnabled(mod)) {
      destroyUI();
      return;
    }
    if (!prefs) {
      refresh();
      return;
    }
    ensurePanel();
    ensureSidebar();
    syncForgeTabVisibility();
    if (panelOpen) refreshContext();
  }

  function bindForgeListeners() {
    if (!forgeStorageListener) {
      forgeStorageListener = function (changes, area) {
        if (area !== 'local') return;
        if (!core || (typeof mod !== 'undefined' && !core.isModuleEnabled(mod))) return;
        if (changes.forgePrefs && panelRoot()) {
          loadPrefs(function () {
            const countIn = document.querySelector('#un-forge-root input[type=number]');
            if (countIn) countIn.value = String(prefs.count);
            const privSel = document.getElementById('un-forge-privacy');
            if (privSel) privSel.value = prefs.privacy || 'public';
            renderFolderSelect(document.getElementById('un-forge-folder'), prefs.defaultFolder || '');
          });
        }
        if (changes.plFolderStore) {
          loadFolderNames(function () {
            renderFolderSelect(document.getElementById('un-forge-folder'), prefs.defaultFolder || '');
          });
        }
      };
      chrome.storage.onChanged.addListener(forgeStorageListener);
    }
    if (!forgeMsgListener) {
      forgeMsgListener = function (msg, _sender, sendResponse) {
        if (!msg || msg.type !== M_FORGE_PANEL) return;
        if (!core || !core.isModuleEnabled(mod)) return;
        ensurePanel();
        setPanelOpen(true);
        if (msg.tab) showTab(msg.tab);
        sendResponse({ ok: true });
        return true;
      };
      chrome.runtime.onMessage.addListener(forgeMsgListener);
    }
  }

  const mod = {
    id: 'forgeLink',
    moduleKey: 'forgeLink',
    init: function (c) {
      core = c;
      bindForgeListeners();
      refresh();
    },
    scan: function () { mountTab(); mountInHost(); lightScan(); },
    onNavigate: function () {
      mountTab();
      mountInHost();
      // Close any open preview so its document keydown handler doesn't leak
      // across SPA navigations.
      if (searchPanelApi && searchPanelApi.closePreview) searchPanelApi.closePreview();
      refresh();
      if (panelOpen) {
        refreshStatsLine();
        refreshContext();
      }
    },
    onSettings: function () {
      refresh();
    },
    // Core skips onSettings for a just-disabled module — remove the Forge panel,
    // guide, and the gold tab here so they don't linger until a reload.
    teardown: function () {
      destroyUI();
      document.querySelectorAll('.un-forge-tab').forEach(function (n) { n.remove(); });
    }
  };

  window.UNForge = {
    openPanel: function (tab) {
      ensurePanel();
      setPanelOpen(true);
      if (tab) showTab(tab);
    },
    openSearch: openSearchTab,
    openSimilar: openSimilarInForge
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
