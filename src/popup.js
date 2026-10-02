'use strict';

/**
 * Popup quick-control panel:
 *   - master AI-filter on/off + hidden counts
 *   - one-click "block this channel" on a watch page
 *   - live per-feature toggles (core hot-reloads modules from storage.sync)
 *   - links to the dashboard (with hash routing)
 */
(function () {
  const D = window.UNSYNTH_DEFAULTS;
  const $ = (id) => document.getElementById(id);

  function showFatal(msg, hint) {
    // DOM APIs only — never interpolate into HTML, even for hardcoded strings.
    document.body.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'pop-fatal';
    const brand = document.createElement('div');
    brand.className = 'pop-brand';
    const dot = document.createElement('span');
    dot.className = 'dot';
    brand.appendChild(dot);
    brand.appendChild(document.createTextNode('Unsynth'));
    wrap.appendChild(brand);
    const p = document.createElement('p');
    p.textContent = String(msg == null ? '' : msg);
    wrap.appendChild(p);
    if (hint) {
      const h = document.createElement('p');
      h.className = 'pop-fatal-hint';
      h.textContent = String(hint);
      wrap.appendChild(h);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pop-fatal-open';
    btn.className = 'pop-fatal-btn';
    btn.textContent = 'Open settings';
    btn.addEventListener('click', () => {
      openDashFallback('');
      window.close();
    });
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  function extensionsAdminUrl() {
    return window.UNBrowserEnv ? UNBrowserEnv.extensionsUrl() : 'chrome://extensions';
  }

  function openDashFallback(hash) {
    const rel = 'src/dashboard/dashboard.html';
    const base = chrome.runtime.getURL(rel);
    const h = String(hash || '').replace(/^#/, '');
    const url = h ? base + '#' + h : base;
    chrome.tabs.create({ url, active: true }, () => {
      if (chrome.runtime.lastError) {
        try {
          chrome.runtime.openOptionsPage();
        } catch (e) {
          /* ignore */
        }
      }
    });
  }

  try {
    if (!chrome || !chrome.runtime || !chrome.runtime.id) {
      showFatal(
        'Unsynth needs a reload.',
        'Open ' + extensionsAdminUrl() + ', click Reload on Unsynth, accept any new permissions, then reload your YouTube tabs.'
      );
      return;
    }
  } catch (e) {
    showFatal('Unsynth is unavailable.', 'Reload the extension from your browser extensions page.');
    return;
  }

  function openDash(hash) {
    chrome.runtime.sendMessage(
      {
        type: UNMSG.OPEN_EXT_PAGE,
        path: 'src/dashboard/dashboard.html',
        hash: String(hash || '').replace(/^#/, '')
      },
      (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) openDashFallback(hash);
      }
    );
  }

  function showHealthBanner(text) {
    const existing = $('pop-health-banner');
    if (existing) {
      existing.textContent = text;
      return;
    }
    const el = document.createElement('p');
    el.id = 'pop-health-banner';
    el.className = 'pop-health';
    el.textContent = text;
    const head = document.querySelector('.pop-head');
    if (head && head.parentNode) head.parentNode.insertBefore(el, head.nextSibling);
  }

  function checkExtensionHealth() {
    chrome.runtime.sendMessage({ type: UNMSG.TAB_RELOAD_STATUS }, (r) => {
      if (chrome.runtime.lastError || !r) {
        showHealthBanner('Extension service worker is not responding — reload Unsynth at ' + extensionsAdminUrl() + '.');
        return;
      }
      if (r.needsTabReload) refreshTabReloadBanner();
    });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !/youtube\.com/.test(tab.url || '')) return;
      chrome.tabs.sendMessage(tab.id, { type: 'unsynth-ping' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showHealthBanner('YouTube tab is not running Unsynth yet — reload the tab (or open a fresh watch page).');
        }
      });
    });
    if (chrome.permissions && chrome.permissions.contains) {
      chrome.permissions.contains({ permissions: ['downloads'] }, (ok) => {
        if (!ok) {
          showHealthBanner('Updates need the Downloads permission — reload Unsynth at ' + extensionsAdminUrl() + ' and accept permissions.');
        }
      });
    }
  }

  const MODS = [
    // @unsynth-codegen-modules-begin
    ['subManager', 'Subscription manager', 'feed', 'groups, feed filter, PocketTube import'],
    ['playlistBulk', 'Playlist bulk tools', 'feed', 'multi-select, dedupe, Forge links'],
    ['playlistFolders', 'Playlist groups (sidebar)', 'feed', 'pin playlists in the sidebar; folders, ＋ Folder, Library filter'],
    ['forgeLink', 'Playlist Forge', 'content', 'suggest & build playlists on YouTube'],
    ['dislikeRestore', 'Video stats (feeds + watch)', 'content', 'RYD likes/dislikes on feeds, search & watch pages; compare vs channel'],
    ['popoutPlayer', 'Popout player', 'player', 'floating resizable window for the current video'],
    ['scrollMiniplayer', 'Scroll miniplayer', 'player', 'dock the player into a corner when you scroll past it — draggable, resizable, and never leaves the page'],
    ['queueAdvance', 'Queue auto-advance', 'player', 'queue dock on the page; play-next is a separate dashboard setting'],
    ['tasteRank', 'Suggestions for your taste', 'feed', 'score the suggestion rail against what you actually watch, and float the best matches to the top'],
    ['volumeMaster', 'Volume master', 'player', 'per-tab boost up to 600% on player controls'],
    ['factCheck', 'AI fact-check', 'content', 'check video claims & comments (BYOK)'],
    ['descDigest', 'Watch description', 'content', 'compact blurb, links, and timestamps for the video you are watching'],
    ['aiAssistant', 'AI assistant', 'content', 'transcript summary & Q&A (BYOK)'],
    ['analytics', 'Stats overlay', 'content', 'watch-page stats card, SEO, engagement, compare'],
    ['sponsorBlock', 'SponsorBlock skip (community + personal)', 'player', 'skip sponsor segments + markers'],
    ['discoverShelf', 'Hidden gems (home shelf)', 'tools', 'overlooked videos above the home feed'],
    ['uiTune', 'Tune (layout)', 'feed', 'hide Shorts/recs, presets, player'],
    ['watchHistory', 'Watch history', 'feed', 'track, mark, dim watched videos'],
    ['crossTabPlayback', 'Cross-tab playback', 'player', 'pause older YouTube playback when a new tab starts'],
    ['qualityLock', 'Quality lock (force HD)', 'player', 'force a minimum resolution (e.g. 1080p)'],
    ['speedChip', 'Speed chip (player control)', 'player', 'shows the current playback speed on the player and opens a picker to change it'],
    ['screenshot', 'Screenshot frame', 'tools', 'camera button to save the current frame as PNG'],
    ['titleCleaner', 'Calm clickbait titles', 'feed', 'calm ALL-CAPS clickbait & emoji spam in titles'],
    ['ambientMode', 'Ambient glow mode', 'player', 'soft glow around the player from on-screen colors'],
    ['adSkip', 'Ad skip', 'player', 'auto-click Skip Ad, mute non-skippable ads, hide banner/overlay ads'],
    ['deArrow', 'DeArrow titles', 'feed', 'crowd-sourced titles and thumbnails; pick which on the dashboard'],
    ['shortcuts', 'Keyboard shortcuts', 'tools', 'in-page hotkeys for ambient mode, screenshot, quality lock, speed, volume boost, and the dashboard'],
    ['transcriptExport', 'Transcript export', 'content', 'copy or download the video transcript as plain text'],
    ['abLoop', 'A-B loop', 'player', 'mark two points and repeat playback between them'],
    ['tabTitle', 'Playback tab title', 'player', 'show play/pause state in the browser tab title'],
    ['chapters', 'Chapter navigation', 'player', 'jump to the next/previous creator-defined chapter'],
    ['searchFilters', 'Search filters', 'feed', 'exact date range, view and duration bounds, and keyword/channel exclusions on the search page'],
    ['commentFilter', 'Comment filter', 'feed', 'hide comments matching keywords'],
    ['channelCompletion', 'Channel completion', 'feed', 'on a channel page, what share of the videos you start there you actually finish'],
    ['playlistDebt', 'Playlist debt line', 'feed', 'under a playlist title: how many hours it holds, how many are unfinished, and how much of it you actually finish'],
    ['clipCapture', 'Clip capture', 'tools', 'record a short WebM clip (video + audio) of the current playback'],
    ['skipSeconds', 'Skip seconds', 'player', 'back/forward player buttons that seek by a configurable number of seconds'],
    ['liveNow', 'Live now shelf', 'feed', 'pins any live stream already loaded in your home feed to the top'],
    ['quickSwitcher', 'Quick switcher', 'tools', 'Shift+P anywhere on YouTube to jump to any playlist or subscribed channel by name, folder or group']
    // @unsynth-codegen-modules-end
  ];

  if (window.UNBrowserEnv) UNBrowserEnv.applyCopy();
  checkExtensionHealth();

  function normalizeMods(mods) {
    if (window.UNModules) return UNModules.normalizeModules(mods, D);
    return mods;
  }

  function loadAll() {
    chrome.storage.sync.get({ enabled: D.enabled, stats: D.stats, modules: D.modules }, (s) => {
      const mods = normalizeMods(Object.assign({}, D.modules, s.modules));
      const showAi = mods.aiFilter !== false && s.enabled !== false;
      const master = $('pop-master');
      if (master) master.style.display = showAi ? '' : 'none';
      const en = $('enabled');
      if (en) en.checked = s.enabled !== false && mods.aiFilter !== false;
      const countEl = $('count');
      if (countEl) countEl.textContent = (s.stats && s.stats.hidden) || 0;
      renderModules(mods);
    });
    chrome.storage.local.get({ subActive: '', plFolderActive: '' }, (d) => {
      const badge = $('active-filter-badge');
      if (!badge) return;
      const parts = [];
      if (d.subActive) parts.push('Subscription group: ' + d.subActive);
      if (d.plFolderActive) parts.push('Playlist group: ' + d.plFolderActive);
      badge.textContent = parts.length ? parts.join(' · ') : '';
      badge.hidden = !parts.length;
      badge.classList.toggle('clickable', !!parts.length);
      badge.title = parts.length ? 'Open Subscriptions settings' : '';
    });
    if (window.UNWatchedDisplay) {
      chrome.storage.sync.get({ watchedDisplay: D.watchedDisplay, watchedMode: 'off' }, (s) => {
        hiPopPreset(UNWatchedDisplay.toLegacyMode(UNWatchedDisplay.normalize(s.watchedDisplay, s.watchedMode)));
      });
    }
    refreshSyncLine();
  }

  function formatSyncAge(ts) {
    if (!ts) return '';
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 90) return 'just now';
    if (sec < 3600) return Math.round(sec / 60) + 'm ago';
    if (sec < 86400) return Math.round(sec / 3600) + 'h ago';
    return Math.round(sec / 86400) + 'd ago';
  }

  function refreshSyncLine() {
    const detail = $('pop-sync-detail');
    const line = $('pop-sync-line');
    if (!detail) return;
    chrome.storage.local.get(
      {
        unWatchQueue: [],
        plPins: { ids: [] },
        subStore: { groups: {} },
        plFolderStore: { folders: {} },
        historySync: { enabled: false, lastSyncAt: 0, lastError: null },
        unWatchQueueSyncMeta: { error: null },
        unPlPinsSyncMeta: { error: null },
        librarySync: { enabled: false, lastError: null }
      },
      (d) => {
        const qn = (d.unWatchQueue || []).length;
        const pn = ((d.plPins && d.plPins.ids) || []).length;
        const gn = Object.keys(((d.subStore && d.subStore.groups) || {})).length;
        const fn = Object.keys(((d.plFolderStore && d.plFolderStore.folders) || {})).length;
        const hs = d.historySync || {};
        // Spelled out: "Q 0 · P 0 · G 0 · F 0" meant nothing to a reader.
        const bits = ['Queue ' + qn, 'Pinned ' + pn, 'Groups ' + gn, 'Folders ' + fn];
        if (!hs.enabled) bits.push('History off');
        else if (hs.lastError) bits.push('History error');
        else if (hs.lastSyncAt) bits.push('History ' + formatSyncAge(hs.lastSyncAt));
        else bits.push('History on');
        detail.textContent = ' · ' + bits.join(' · ');
        const errs = [];
        if (d.unWatchQueueSyncMeta && d.unWatchQueueSyncMeta.error) errs.push('Queue: ' + d.unWatchQueueSyncMeta.error);
        if (d.unPlPinsSyncMeta && d.unPlPinsSyncMeta.error) errs.push('Pins: ' + d.unPlPinsSyncMeta.error);
        if (d.librarySync && d.librarySync.lastError) errs.push('Library: ' + d.librarySync.lastError);
        if (hs.lastError) errs.push('History: ' + hs.lastError);
        if (line) {
          line.title = errs.length
            ? errs.join(' · ')
            : 'Settings and pins follow this Chrome profile. Queue, groups, and folders use the Unsynth server when you opt in on Account.';
        }
      }
    );
  }

  loadAll();

  function renderPopUseCases() {
    const UCP = window.UNUseCasePresets;
    const box = $('pop-use-cases');
    if (!box || !UCP) return;
    box.textContent = '';
    chrome.storage.local.get({ useCasePreset: 'essentials' }, (d) => {
      const active = d.useCasePreset || 'essentials';
      UCP.PRESETS.forEach((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pop-uc' + (p.id === active ? ' on' : '');
        b.textContent = p.label;
        b.title = p.desc;
        b.setAttribute('aria-label', b.title);
        b.addEventListener('click', () => {
          const payload = UCP.applyPreset(p.id, D);
          if (!payload) return;
          // Don't write enabled:undefined (Chrome removes the key, resetting the
          // master switch to its default of true). Only set it when the preset does.
          const syncPayload = { modules: payload.modules };
          if (payload.enabled !== undefined) syncPayload.enabled = payload.enabled;
          const finish = () => {
            chrome.storage.local.set({ needsTabReload: true, useCasePreset: p.id }, () => {
              box.querySelectorAll('.pop-uc').forEach((x) => x.classList.toggle('on', x === b));
              loadAll();
              refreshTabReloadBanner();
            });
          };
          if (payload.statsSections) {
            chrome.storage.local.set({ statsSections: payload.statsSections }, () => {
              chrome.storage.sync.set(syncPayload, finish);
            });
          } else {
            chrome.storage.sync.set(syncPayload, finish);
          }
        });
        box.appendChild(b);
      });
    });
  }
  renderPopUseCases();

  // Always the full list.
  //
  // This used to hide every switched-OFF module (falling back to the full list
  // only when nothing was left), which made the popup's own toggles one-way:
  // turning a feature off removed its row, so turning it back on meant opening
  // the dashboard. That was a reasonable trade when the alternative was a flat
  // 33-row wall, but the rows are grouped, collapsed and searchable now, so the
  // full list costs nothing and the toggles work in both directions.
  function filterPopModules() {
    return MODS;
  }

  function refreshTabReloadBanner() {
    chrome.runtime.sendMessage({ type: UNMSG.TAB_RELOAD_STATUS }, (r) => {
      const banner = $('pop-tab-reload-banner');
      if (!banner) return;
      // Acknowledge lastError so Chrome doesn't log unchecked-error noise during
      // service-worker startup.
      if (chrome.runtime.lastError || !r) { banner.style.display = 'none'; return; }
      banner.style.display = r.needsTabReload ? '' : 'none';
    });
  }
  refreshTabReloadBanner();
  if ($('pop-reload-yt-tabs')) {
    $('pop-reload-yt-tabs').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: UNMSG.RELOAD_YOUTUBE_TABS }, (r) => {
        if (r && r.ok) refreshTabReloadBanner();
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.enabled || changes.modules || changes.stats)) loadAll();
    if (area === 'local' && (changes.subActive || changes.plFolderActive || changes.unWatchQueue || changes.plPins || changes.historySync || changes.unWatchQueueSyncMeta || changes.unPlPinsSyncMeta)) loadAll();
    if (area === 'local' && changes.needsTabReload) refreshTabReloadBanner();
  });

  $('enabled') && $('enabled').addEventListener('change', (e) => {
    const on = e.target.checked;
    chrome.storage.sync.get({ modules: D.modules }, (s) => {
      const m = normalizeMods(Object.assign({}, D.modules, s.modules));
      m.aiFilter = on;
      chrome.storage.sync.set({ enabled: on, modules: m });
    });
  });

  const WD = window.UNWatchedDisplay;

  function applyPopPreset(id) {
    if (!WD) return;
    const wd = WD.preset(id);
    chrome.storage.sync.set({ watchedDisplay: wd, watchedMode: id }, () => hiPopPreset(id));
  }
  function hiPopPreset(id) {
    document.querySelectorAll('#pop-wmode button').forEach((b) => b.classList.toggle('on', b.dataset.preset === id));
  }
  const popBox = $('pop-wmode');
  if (popBox && WD) {
    WD.PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.preset = p.id;
      b.textContent = p.label;
      b.title = p.desc;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => applyPopPreset(p.id));
      popBox.appendChild(b);
    });
  }
  if ($('open-watched-dash')) {
    $('open-watched-dash').addEventListener('click', (e) => {
      e.preventDefault();
      openDash('#watched');
    });
  }

  // Display order + copy for the four groups. Keyed by the `group` field the
  // manifest now carries on every popup module (see popupMods()).
  const GROUP_META = [
    ['player', 'Player'],
    ['feed', 'Feed & sidebar'],
    ['content', 'Content & AI'],
    ['tools', 'Tools']
  ];

  // Which groups the user left open, so a re-render (any toggle writes to
  // storage, which re-renders) doesn't collapse what they were working in.
  const openGroups = new Set(['player']);

  function renderModules(mods) {
    const box = $('modules');
    box.textContent = '';
    const visible = filterPopModules(mods);
    if (!visible.length) {
      const hint = document.createElement('p');
      hint.className = 'pop-hint';
      hint.textContent = 'Pick a preset above to enable features.';
      box.appendChild(hint);
      updateFeatureCount(0, 0);
      return;
    }

    const byGroup = new Map();
    visible.forEach((row) => {
      const g = row[2] || 'tools';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(row);
    });

    let totalOn = 0;
    let total = 0;

    GROUP_META.forEach(([gid, gname]) => {
      const rows = byGroup.get(gid);
      if (!rows || !rows.length) return;
      const on = rows.filter(([key]) => mods[key] !== false).length;
      totalOn += on;
      total += rows.length;

      const grp = document.createElement('details');
      grp.className = 'modgroup';
      grp.dataset.group = gid;
      grp.open = openGroups.has(gid);
      grp.addEventListener('toggle', () => {
        if (grp.open) openGroups.add(gid);
        else openGroups.delete(gid);
      });

      const sum = document.createElement('summary');
      const caret = document.createElement('span');
      caret.className = 'modgroup-caret';
      caret.textContent = '▶';
      const name = document.createElement('span');
      name.className = 'modgroup-name';
      name.textContent = gname;
      const cnt = document.createElement('span');
      cnt.className = 'modgroup-count' + (on ? '' : ' none');
      cnt.textContent = on + ' / ' + rows.length;
      sum.append(caret, name, cnt);
      grp.appendChild(sum);

      const items = document.createElement('div');
      items.className = 'modgroup-items';

      rows.forEach(([key, label, , desc]) => {
        const row = document.createElement('div');
        row.className = 'modrow';
        // Searched against label + description, lowercased once here rather
        // than on every keystroke.
        row.dataset.search = (label + ' ' + (desc || '')).toLowerCase();

        const txt = document.createElement('div');
        txt.className = 'modrow-txt';
        const t = document.createElement('span');
        t.className = 'modrow-label';
        t.textContent = label;
        txt.appendChild(t);
        if (desc) {
          const d = document.createElement('span');
          d.className = 'modrow-desc';
          d.textContent = desc;
          txt.appendChild(d);
        }

        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.className = 'un-switch';
        inp.checked = mods[key] !== false;
        // The label text is a sibling, not a wrapping <label> — name the control
        // explicitly so screen readers announce what the switch toggles.
        inp.setAttribute('aria-label', label);
        inp.addEventListener('change', () => {
          // Keep the group's "on / total" chip honest immediately; the storage
          // round-trip re-renders a moment later and confirms it.
          const delta = inp.checked ? 1 : -1;
          const chip = grp.querySelector('.modgroup-count');
          if (chip) {
            const nextOn = Math.max(0, parseInt(chip.textContent, 10) + delta);
            chip.textContent = nextOn + ' / ' + rows.length;
            chip.classList.toggle('none', nextOn === 0);
          }
          chrome.storage.sync.get({ modules: D.modules }, (s) => {
            const m = normalizeMods(Object.assign({}, D.modules, s.modules));
            m[key] = inp.checked;
            chrome.storage.sync.set({ modules: m }, () => {
              chrome.storage.local.set({ needsTabReload: true });
            });
          });
        });

        row.append(txt, inp);
        items.appendChild(row);

        if (key === 'commentFilter') {
          const wrap = document.createElement('div');
          wrap.className = 'pop-cf-keywords';
          wrap.id = 'pop-cf-box';
          const lab = document.createElement('label');
          lab.setAttribute('for', 'pop-cf-keywords');
          lab.textContent = 'Keywords (one per line)';
          const ta = document.createElement('textarea');
          ta.id = 'pop-cf-keywords';
          ta.rows = 3;
          ta.spellcheck = false;
          ta.placeholder = 'spam\ncrypto';
          ta.setAttribute('aria-label', 'Comment filter keywords');
          wrap.append(lab, ta);
          items.appendChild(wrap);
          chrome.storage.sync.get({ commentFilter: D.commentFilter }, (s) => {
            const d = Object.assign({}, D.commentFilter, s.commentFilter || {});
            ta.value = Array.isArray(d.keywords) ? d.keywords.join('\n') : '';
          });
          let kwTimer = null;
          const saveKw = () => {
            const keywords = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
            chrome.storage.sync.get({ commentFilter: D.commentFilter }, (s) => {
              const next = Object.assign({}, D.commentFilter, s.commentFilter || {}, { keywords: keywords });
              chrome.storage.sync.set({ commentFilter: next });
            });
          };
          ta.addEventListener('change', saveKw);
          ta.addEventListener('input', () => {
            clearTimeout(kwTimer);
            kwTimer = setTimeout(saveKw, 600);
          });
        }
      });

      grp.appendChild(items);
      box.appendChild(grp);
    });

    updateFeatureCount(totalOn, total);
    applyFeatureSearch();
  }

  function updateFeatureCount(on, total) {
    const el = $('pop-feature-count');
    if (el) el.textContent = total ? String(on) : '';
  }

  // Filters across every group at once and opens the groups holding a match,
  // so finding one toggle never means expanding four sections by hand.
  function applyFeatureSearch() {
    const input = $('pop-feature-search');
    const box = $('modules');
    if (!input || !box) return;
    const q = input.value.trim().toLowerCase();
    let hits = 0;

    box.querySelectorAll('.modgroup').forEach((grp) => {
      let shown = 0;
      grp.querySelectorAll('.modrow').forEach((row) => {
        const hit = !q || (row.dataset.search || '').indexOf(q) !== -1;
        row.hidden = !hit;
        if (hit) shown++;
      });
      const cfBox = grp.querySelector('.pop-cf-keywords');
      if (cfBox) {
        const cfRow = [...grp.querySelectorAll('.modrow')].find((r) => r.querySelector('#pop-cf-keywords') || (r.dataset.search || '').indexOf('comment filter') !== -1);
        cfBox.hidden = !cfRow || cfRow.hidden;
      }
      grp.hidden = shown === 0;
      hits += shown;
      if (q) grp.open = shown > 0;
      else grp.open = openGroups.has(grp.dataset.group);
    });

    const none = $('pop-no-results');
    if (none) none.hidden = !(q && hits === 0);
  }

  // ---- tabs ----
  // "Now" is the default on every open: the audio/filter/watched controls are
  // what most openings are for, and they fit without scrolling.
  function selectTab(name) {
    document.querySelectorAll('.pop-tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // Driven off the panes that actually exist rather than a hardcoded pair,
    // so adding a tab is a markup change and cannot leave a pane stuck open
    // behind another one.
    document.querySelectorAll('.pop-pane').forEach((p) => {
      p.hidden = p.id !== 'pop-pane-' + name;
    });
    if (name === 'features') {
      const s = $('pop-feature-search');
      if (s) s.focus();
    }
    // Counts are read live on open, not cached from a previous session — a
    // stale "0 pinned" would read as a broken account rather than a stale UI.
    if (name === 'playlists') refreshPlaylistTab();
  }

  document.querySelectorAll('.pop-tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });

  // ---- playlists tab ----
  // The four playlist modules, in the order they matter to someone actually
  // organising a library. Keys and copy are the same ones the Features pane and
  // the dashboard use — deliberately not reworded here, so a feature does not
  // appear to be two different things depending on where you read about it.
  const PLAYLIST_MODULES = [
    ['playlistFolders', 'Playlist groups', 'pin playlists in the sidebar; folders, ＋ Folder, Library filter'],
    ['playlistBulk', 'Bulk tools', 'multi-select, dedupe, Forge links'],
    ['forgeLink', 'Playlist Forge', 'suggest & build playlists on YouTube'],
    ['quickSwitcher', 'Quick switcher', 'Shift+P to jump to any playlist by name']
  ];

  function renderPlaylistModules(mods) {
    const box = $('pop-pl-modules');
    if (!box) return;
    box.textContent = '';
    PLAYLIST_MODULES.forEach(([key, label, desc]) => {
      const row = document.createElement('div');
      row.className = 'modrow';

      const txt = document.createElement('div');
      txt.className = 'modrow-txt';
      const t = document.createElement('span');
      t.className = 'modrow-label';
      t.textContent = label;
      txt.appendChild(t);
      const d = document.createElement('span');
      d.className = 'modrow-desc';
      d.textContent = desc;
      txt.appendChild(d);

      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.className = 'un-switch';
      inp.checked = mods[key] !== false;
      inp.setAttribute('aria-label', label);
      // Same write path as the Features pane, including the needsTabReload
      // flag — a toggle here and a toggle there must not behave differently.
      inp.addEventListener('change', () => {
        chrome.storage.sync.get({ modules: D.modules }, (s) => {
          const m = normalizeMods(Object.assign({}, D.modules, s.modules));
          m[key] = inp.checked;
          chrome.storage.sync.set({ modules: m }, () => {
            chrome.storage.local.set({ needsTabReload: true });
          });
        });
      });

      row.append(txt, inp);
      box.appendChild(row);
    });
  }

  /** Live pin/folder counts. Never renders an invented number. */
  function refreshPlaylistCounts() {
    const countEl = $('pop-pl-count');
    const foldersEl = $('pop-pl-folders');
    const emptyEl = $('pop-pl-empty');
    if (!countEl || !foldersEl) return;
    chrome.storage.local.get({ plPins: null, plFolderStore: null }, (d) => {
      if (chrome.runtime.lastError) {
        // Say nothing rather than claim zero — an unreadable store is not an
        // empty library, and "0 pinned" would read as data loss.
        countEl.textContent = '—';
        foldersEl.textContent = '—';
        return;
      }
      const ids = (d.plPins && Array.isArray(d.plPins.ids) && d.plPins.ids) || [];
      const folders = (d.plFolderStore && d.plFolderStore.folders) || null;
      const folderCount = folders ? Object.keys(folders).length : 0;
      countEl.textContent = String(ids.length);
      foldersEl.textContent = String(folderCount);
      if (emptyEl) emptyEl.hidden = ids.length > 0;
    });
  }

  function refreshPlaylistTab() {
    refreshPlaylistCounts();
    chrome.storage.sync.get({ modules: D.modules }, (s) => {
      renderPlaylistModules(normalizeMods(Object.assign({}, D.modules, s.modules)));
    });
  }

  if ($('pop-pl-open-organizer')) {
    $('pop-pl-open-organizer').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/playlist-organizer/organizer.html') });
      window.close();
    });
  }
  // These three live on the dashboard's Playlists panel. They used to be spread
  // across #watched, #subs and #stats and the hashes here pointed at those old
  // homes; once the cards were gathered onto one panel those links landed the
  // user on the wrong tab entirely. The hash is `tab/scrollTo`, so each still
  // scrolls to its own card rather than the top of the panel.
  if ($('pop-pl-seen')) {
    $('pop-pl-seen').addEventListener('click', () => openDash('#playlists/dash-seen-playlists'));
  }
  if ($('pop-pl-folders-btn')) {
    $('pop-pl-folders-btn').addEventListener('click', () => openDash('#playlists/pl-folders-advanced'));
  }
  if ($('pop-pl-forge')) {
    $('pop-pl-forge').addEventListener('click', () => openDash('#playlists'));
  }

  const featureSearch = $('pop-feature-search');
  if (featureSearch) {
    featureSearch.addEventListener('input', applyFeatureSearch);
    // Esc clears the filter rather than closing the whole popup mid-search.
    featureSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && featureSearch.value) {
        e.stopPropagation();
        e.preventDefault();
        featureSearch.value = '';
        applyFeatureSearch();
      }
    });
  }

  $('open-dash') && $('open-dash').addEventListener('click', (e) => {
    e.preventDefault();
    openDash();
  });
  $('open-dash2') && $('open-dash2').addEventListener('click', (e) => {
    e.preventDefault();
    openDash();
  });
  $('open-sync') && $('open-sync').addEventListener('click', (e) => {
    e.preventDefault();
    openDash('#account');
  });
  const filterBadge = $('active-filter-badge');
  if (filterBadge) {
    filterBadge.addEventListener('click', () => {
      if (!filterBadge.hidden) openDash('#subs');
    });
  }
  if ($('open-tour')) {
    $('open-tour').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (tab && tab.url && tab.url.includes('youtube.com')) {
          chrome.tabs.sendMessage(tab.id, { type: 'UNSYNTH/TOUR/START' }, () => {
            window.close();
          });
        } else {
          chrome.tabs.create({ url: 'https://www.youtube.com' });
          window.close();
        }
      });
    });
  }
  $('open-options') && $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    openDash('#filter');
  });
  if ($('open-updates')) {
    $('open-updates').addEventListener('click', (e) => {
      e.preventDefault();
      openDash('#updates');
    });
  }
  if ($('open-playlist-organizer')) {
    $('open-playlist-organizer').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('src/playlist-organizer/organizer.html') });
      window.close();
    });
  }
  if ($('open-support')) {
    $('open-support').addEventListener('click', (e) => {
      e.preventDefault();
      if (window.UNDONATION) UNDONATION.openKofi();
    });
  }

  if ($('open-shortcuts')) {
    $('open-shortcuts').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  function initAudioPanel() {
    const slider = $('pop-audio-slider');
    const badge = $('pop-audio-badge');
    const eqSelect = $('pop-audio-eq');
    const scrollChk = $('pop-audio-scroll');
    const rememberChk = $('pop-audio-remember');
    const playerCtrlChk = $('pop-audio-player-ctrl');
    const inactiveOverlay = $('pop-audio-inactive');
    const panel = $('pop-audio-panel');

    let activeTabId = null;

    function setPanelDisabled(disabled) {
      slider.disabled = disabled;
      eqSelect.disabled = disabled;
      scrollChk.disabled = disabled;
      rememberChk.disabled = disabled;
      playerCtrlChk.disabled = disabled;
      panel.querySelectorAll('.pop-audio-chip').forEach(b => b.disabled = disabled);
      inactiveOverlay.style.display = disabled ? 'flex' : 'none';
      if (disabled) {
        panel.classList.add('inactive');
      } else {
        panel.classList.remove('inactive');
      }
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !/^https?:\/\//i.test(tab.url || '')) {
        setPanelDisabled(true);
        return;
      }
      activeTabId = tab.id;

      const isYt = /youtube\.com/.test(tab.url || '');
      panel.querySelectorAll('.yt-only-opt').forEach((opt) => {
        opt.style.display = isYt ? '' : 'none';
      });

      chrome.tabs.sendMessage(activeTabId, { type: 'unsynth-vol-get' }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          setPanelDisabled(true);
          return;
        }

        setPanelDisabled(false);
        updateVolumeUi(resp.gain);
        eqSelect.value = resp.preset || 'cinematic';
        showEq();
        scrollChk.checked = !!resp.scrollToVolume;
        rememberChk.checked = !!resp.rememberLevel;
        playerCtrlChk.checked = !!resp.showPlayerControl;
      });
    });

    // Live meter: polls the tab while the popup is open (it closes with it).
    const meterEl = $('pop-audio-meter');
    const meterFill = $('pop-audio-meter-fill');
    const meterTxt = $('pop-audio-meter-txt');
    const PRESET_NAMES = {
      cinematic: 'Cinema', 'smart-enhance': 'Smart', normal: 'Off', 'bass-boost': 'Bass',
      'vocal-boost': 'Vocal', 'treble-boost': 'Treble', compressor: 'Night', mono: 'Mono', custom: 'Custom'
    };
    function showMeter(st) {
      if (!meterEl) return;
      let text = '';
      let pct = 0;
      let problem = false;
      let off = false;
      if (!st) {
        // vol-get answered but this did not: the tab runs Unsynth from before
        // the last extension reload, which keeps none of these controls.
        text = 'This tab runs an old copy of Unsynth: reload the tab';
        problem = true;
        off = true;
      } else if (st.state === 'on') {
        const db = typeof st.levelDb === 'number' ? st.levelDb : -99;
        pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        const what = (PRESET_NAMES[st.applied] || st.applied) + (st.gain > 100 ? ' · ' + st.gain + '%' : '');
        text = st.paused ? 'Processing · ' + what + ' · paused'
          : st.muted ? 'Processing · ' + what + ' · muted'
            : 'Processing · ' + what + ' · ' + (db <= -98 ? 'silence' : db.toFixed(0) + ' dB');
        meterEl.classList.toggle('is-hot', db > -3);
      } else if (st.state === 'bypass') {
        text = 'Effects off · YouTube plays the audio as is';
        off = true;
      } else if (st.state === 'suspended') {
        text = 'Chrome is holding the audio: click the video once';
        problem = true;
        off = true;
      } else if (st.state === 'failed') {
        // Chrome's own wording is jargon; say what it means. The raw text stays
        // in the tooltip for a bug report.
        const raw = st.error || '';
        const why = /already connected|MediaElementSource/i.test(raw)
          ? 'another extension or YouTube already owns this video’s audio'
          : (raw.split(':')[0] || 'could not attach to the video');
        text = 'Effects not running: ' + why;
        problem = true;
        off = true;
      } else {
        text = 'No video on this page';
        off = true;
      }
      meterFill.style.width = pct + '%';
      meterTxt.textContent = text;
      meterTxt.title = st && st.error ? text + ' (' + st.error + ')' : text;
      meterEl.classList.toggle('is-problem', problem);
      meterEl.classList.toggle('is-off', off);
    }
    function pollMeter() {
      if (!activeTabId) return;
      chrome.tabs.sendMessage(activeTabId, { type: 'unsynth-vol-status' }, (st) => {
        if (chrome.runtime.lastError) { showMeter(null); return; }
        showMeter(st || null);
      });
    }
    setInterval(pollMeter, 200);

    function updateVolumeUi(gain) {
      slider.value = gain;
      badge.textContent = gain + '%';
      // Drive the track's filled portion — the CSS gradient reads this var.
      slider.style.setProperty('--pop-vol-fill', Math.max(0, Math.min(100, (gain / 600) * 100)) + '%');
      if (gain > 100) {
        badge.classList.add('boosted');
      } else {
        badge.classList.remove('boosted');
      }
      panel.querySelectorAll('.pop-audio-chip').forEach(chip => {
        chip.classList.toggle('active', Number(chip.getAttribute('data-v')) === gain);
      });
    }

    slider.addEventListener('input', () => {
      if (!activeTabId) return;
      const gain = Number(slider.value);
      updateVolumeUi(gain);
      chrome.tabs.sendMessage(activeTabId, { type: 'unsynth-vol-set', gain }, () => {
        if (chrome.runtime.lastError) {}
      });
    });

    panel.querySelectorAll('.pop-audio-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        if (!activeTabId) return;
        const gain = Number(chip.getAttribute('data-v'));
        updateVolumeUi(gain);
        chrome.tabs.sendMessage(activeTabId, { type: 'unsynth-vol-set', gain }, () => {
          if (chrome.runtime.lastError) {}
        });
      });
    });

    // ---- Custom EQ: ten faders, saved to volumeMaster.customEq ----
    const EQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
    const eqPanel = $('pop-eq');
    const eqBands = $('pop-eq-bands');
    let customEq = (D.volumeMaster && Array.isArray(D.volumeMaster.customEq) ? D.volumeMaster.customEq : EQ_LABELS.map(() => 0)).slice();
    let eqSaveTimer = null;
    function fmtDb(v) { return (v > 0 ? '+' : '') + v; }
    function buildEqBands() {
      if (!eqBands || eqBands.childElementCount) return;
      EQ_LABELS.forEach((lab, i) => {
        const band = document.createElement('div');
        band.className = 'pop-eq-band';
        const val = document.createElement('span');
        val.className = 'pop-eq-val';
        const slot = document.createElement('div');
        slot.className = 'pop-eq-slot';
        const r = document.createElement('input');
        r.type = 'range'; r.min = '-12'; r.max = '12'; r.step = '1';
        r.className = 'pop-eq-range';
        r.setAttribute('aria-label', lab + 'Hz, decibels');
        r.dataset.band = String(i);
        const f = document.createElement('span');
        f.className = 'pop-eq-freq';
        f.textContent = lab;
        slot.appendChild(r);
        band.appendChild(val); band.appendChild(slot); band.appendChild(f);
        eqBands.appendChild(band);
        r.addEventListener('input', () => {
          customEq[i] = Number(r.value);
          paintEq();
          // Dragging a fader means you want to hear it: switch to Custom.
          if (eqSelect.value !== 'custom') { eqSelect.value = 'custom'; eqSelect.dispatchEvent(new Event('change')); }
          scheduleEqSave();
        });
      });
    }
    function paintEq() {
      if (!eqBands) return;
      eqBands.querySelectorAll('.pop-eq-band').forEach((band, i) => {
        const v = Number(customEq[i]) || 0;
        const r = band.querySelector('.pop-eq-range');
        if (Number(r.value) !== v) r.value = String(v);
        const val = band.querySelector('.pop-eq-val');
        val.textContent = fmtDb(v);
        val.classList.toggle('is-on', v !== 0);
      });
    }
    // Sync storage allows a limited number of writes a minute, so a drag saves
    // once it settles; the tab picks the curve up from storage.
    function scheduleEqSave() {
      if (eqSaveTimer) clearTimeout(eqSaveTimer);
      eqSaveTimer = setTimeout(() => {
        chrome.storage.sync.get({ volumeMaster: D.volumeMaster }, (s) => {
          const vm = Object.assign({}, D.volumeMaster, s.volumeMaster);
          vm.customEq = customEq.slice();
          chrome.storage.sync.set({ volumeMaster: vm });
        });
      }, 250);
    }
    function showEq() { if (eqPanel) eqPanel.hidden = eqSelect.value !== 'custom'; }
    buildEqBands();
    chrome.storage.sync.get({ volumeMaster: D.volumeMaster }, (s) => {
      const vm = Object.assign({}, D.volumeMaster, s.volumeMaster);
      if (Array.isArray(vm.customEq)) customEq = vm.customEq.slice(0, 10).map((v) => Math.max(-12, Math.min(12, Number(v) || 0)));
      paintEq();
    });
    const flatBtn = $('pop-eq-flat');
    if (flatBtn) flatBtn.addEventListener('click', () => { customEq = customEq.map(() => 0); paintEq(); scheduleEqSave(); });

    eqSelect.addEventListener('change', () => {
      showEq();
      const preset = eqSelect.value;
      chrome.storage.sync.get({ volumeMaster: D.volumeMaster }, (s) => {
        const vm = Object.assign({}, D.volumeMaster, s.volumeMaster);
        vm.audioPreset = preset;
        chrome.storage.sync.set({ volumeMaster: vm });
      });
      if (!activeTabId) return;
      chrome.tabs.sendMessage(activeTabId, { type: 'unsynth-preset-set', preset }, () => {
        if (chrome.runtime.lastError) {}
      });
    });

    scrollChk.addEventListener('change', () => {
      chrome.storage.sync.get({ ui: D.ui }, (s) => {
        const ui = Object.assign({}, D.ui, s.ui);
        ui.scrollToVolume = scrollChk.checked;
        chrome.storage.sync.set({ ui });
      });
    });

    rememberChk.addEventListener('change', () => {
      chrome.storage.sync.get({ volumeMaster: D.volumeMaster }, (s) => {
        const vm = Object.assign({}, D.volumeMaster, s.volumeMaster);
        vm.rememberLevel = rememberChk.checked;
        chrome.storage.sync.set({ volumeMaster: vm });
      });
    });

    playerCtrlChk.addEventListener('change', () => {
      chrome.storage.sync.get({ volumeMaster: D.volumeMaster }, (s) => {
        const vm = Object.assign({}, D.volumeMaster, s.volumeMaster);
        vm.showPlayerControl = playerCtrlChk.checked;
        chrome.storage.sync.set({ volumeMaster: vm });
      });
    });
  }

  initAudioPanel();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !/youtube\.com/.test(tab.url || '')) {
      // Not on YouTube: make the scan button do what its label promises —
      // it used to sit disabled saying "Open YouTube to scan" forever.
      const scanOff = $('scan-ai');
      if (scanOff) {
        scanOff.disabled = false;
        scanOff.addEventListener('click', () => {
          chrome.tabs.create({ url: 'https://www.youtube.com/', active: true });
          window.close();
        });
      }
      return;
    }

    // Parse video ID from both /watch?v=ID and /shorts/ID paths.
    const tabUrl = tab.url || '';
    const shortsMatch = tabUrl.match(/\/shorts\/([\w-]{11})/);
    const watchMatch = tabUrl.match(/[?&]v=([\w-]{11})/);
    const tabVid = (shortsMatch && shortsMatch[1]) || (watchMatch && watchMatch[1]) || null;

    const scan = $('scan-ai');
    scan.disabled = false;
    scan.textContent = 'Scan this page for AI channels';
    scan.addEventListener('click', () => {
      chrome.tabs.sendMessage(tab.id, { type: 'unsynth-scan-ai' }, () => {
        if (chrome.runtime.lastError) return;
        window.close();
      });
    });
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-get-context' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      $('page-count').textContent = resp.pageHidden || 0;
      // resp.watch is already true for Shorts since isWatch() covers /shorts/ paths
      if (!resp.watch || !resp.channel) return;
      const blockBtn = $('block-channel');
      chrome.storage.sync.get({ channels: [] }, (d) => {
        const channels = d.channels || [];
        const blocked = channels.some((c) => c.toLowerCase() === resp.channel.toLowerCase());
        if (blocked) {
          blockBtn.textContent = 'Blocked ✓';
          blockBtn.disabled = true;
          return;
        }
        blockBtn.disabled = false;
        blockBtn.textContent = `Block — ${resp.channel}`;
        if (tabVid) blockBtn.title = `Video ID: ${tabVid}`;
        blockBtn.onclick = () => {
          chrome.tabs.sendMessage(tab.id, { type: 'unsynth-block-channel' }, (r) => {
            if (chrome.runtime.lastError || !r || !r.ok) return;
            blockBtn.textContent = 'Blocked ✓';
            blockBtn.disabled = true;
          });
        };
      });
    });
  });
})();
