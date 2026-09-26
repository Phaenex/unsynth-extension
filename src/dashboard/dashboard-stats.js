  // ---- stats tab: embed the stats page and auto-size it ----
  function refreshStatsFrame() {
    const fr = $('stats-frame');
    if (!fr || !fr.contentWindow) return;
    try {
      fr.contentWindow.postMessage({ unsynthStatsRefresh: true }, '*');
    } catch (e) {
      /* ignore */
    }
  }
  function initStats() {
    chrome.storage.local.get(['watchStats', 'searchStats'], (d) => {
      const has = !!((d && d.watchStats) || (d && d.searchStats));
      const fr = $('stats-frame');
      const empty = $('stats-empty');
      if (!fr) return;
      if (!has) {
        fr.classList.add('stats-frame-hidden');
        if (empty) empty.classList.remove('stats-empty-hidden');
        return;
      }
      if (empty) empty.classList.add('stats-empty-hidden');
      fr.classList.remove('stats-frame-hidden');
      if (!fr.getAttribute('src')) fr.setAttribute('src', '../stats/stats.html');
      else refreshStatsFrame();
    });
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && (ch.watchStats || ch.searchStats || ch.watchedVideos)) {
      initStats();
      refreshStatsFrame();
    }
  });
  window.addEventListener('message', (e) => {
    const fr = $('stats-frame');
    // only accept the height handshake from our own embedded stats iframe
    if (!fr || e.source !== fr.contentWindow) return;
    if (e.data && typeof e.data.unsynthStatsHeight === 'number') fr.style.height = e.data.unsynthStatsHeight + 24 + 'px';
  });
  if ($('stats-pop')) $('stats-pop').addEventListener('click', () => window.UNOpenPage.stats());
  if ($('open-forge')) {
    $('open-forge').addEventListener('click', () => {
      const url = window.UNForgeLinks ? window.UNForgeLinks.forgeFromYoutube() : 'https://playlist-forge.vercel.app/?from=youtube';
      window.UNOpenPage.openExternal(url);
    });
  }
  if ($('open-forge-panel')) {
    $('open-forge-panel').addEventListener('click', () => {
      send(UNMSG.OPEN_FORGE_PANEL, { tab: 'suggest' }).then((r) => {
        if (r && r.ok) flash($('forge-prefs-status'), 'Opening Forge on YouTube…');
        else flash($('forge-prefs-status'), 'Open a YouTube tab with Unsynth loaded, then try again.');
      });
    });
  }

  function parseAvoidChannels(text) {
    return String(text || '')
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function loadForgePrefsUI() {
    const tasteDefault = { excludeWatched: true, boostChannels: false, excludeAI: true, customAvoidChannels: [] };
    chrome.storage.local.get({ forgePrefs: { count: 25, privacy: 'public', defaultFolder: '', taste: tasteDefault } }, (d) => {
      const p = Object.assign({ count: 25, privacy: 'public', defaultFolder: '', taste: tasteDefault }, d.forgePrefs || {});
      p.taste = Object.assign({}, tasteDefault, p.taste || {});
      if ($('forge-count')) $('forge-count').value = String(p.count || 25);
      if ($('forge-privacy')) $('forge-privacy').value = p.privacy || 'public';
      if ($('forge-avoid')) $('forge-avoid').value = (p.taste.customAvoidChannels || []).join(', ');
      if ($('forge-pref-sidebar')) $('forge-pref-sidebar').checked = p.sidebar === true;
      const PF = window.UNPlaylistFolders;
      chrome.storage.local.get({ plFolderStore: PF ? PF.empty() : { folders: {} } }, (loc) => {
        const sel = $('forge-folder');
        if (!sel) return;
        const store = loc.plFolderStore || (PF ? PF.empty() : { folders: {} });
        const names = Object.keys(store.folders || {}).sort();
        sel.textContent = '';
        sel.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: 'None — don’t assign' }));
        names.forEach((n) => {
          sel.appendChild(Object.assign(document.createElement('option'), { value: n, textContent: n }));
        });
        sel.value = p.defaultFolder || '';
      });
    });
  }
  loadForgePrefsUI();
  if ($('save-forge-prefs')) {
    $('save-forge-prefs').addEventListener('click', () => {
      const count = Math.max(5, Math.min(100, +($('forge-count').value || 25)));
      const privacy = $('forge-privacy').value || 'public';
      const defaultFolder = ($('forge-folder') && $('forge-folder').value) || '';
      const tasteDefault = { excludeWatched: true, boostChannels: false, excludeAI: true, customAvoidChannels: [] };
      chrome.storage.local.get({ forgePrefs: {} }, (d) => {
        const cur = Object.assign({ taste: tasteDefault }, d.forgePrefs || {});
        const taste = Object.assign({}, tasteDefault, cur.taste || {}, {
          customAvoidChannels: parseAvoidChannels($('forge-avoid') && $('forge-avoid').value)
        });
        // Preserve the sidebar-visibility flag (it has its own control below and
        // isn't part of this form) so saving defaults never silently flips it.
        const sidebar = $('forge-pref-sidebar') ? $('forge-pref-sidebar').checked : cur.sidebar === true;
        chrome.storage.local.set({ forgePrefs: { count, privacy, defaultFolder, taste, sidebar } }, () => {
          flash($('forge-prefs-status'), 'Forge defaults saved.');
        });
      });
    });
  }
  if ($('forge-pref-sidebar')) {
    $('forge-pref-sidebar').addEventListener('change', () => {
      const on = $('forge-pref-sidebar').checked;
      chrome.storage.local.get({ forgePrefs: {} }, (d) => {
        const next = Object.assign({}, d.forgePrefs || {}, { sidebar: on });
        chrome.storage.local.set({ forgePrefs: next }, () => {
          flash($('forge-prefs-status'), on ? 'Forge panel shown in the YouTube sidebar.' : 'Forge panel hidden from the YouTube sidebar.');
        });
      });
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    // The Forge card moved from Stats to Playlists — it is playlist work, not
    // statistics. This gate has to follow it, or the folder <select> in its
    // defaults silently stops refreshing when folders change.
    if (area === 'local' && changes.plFolderStore && document.querySelector('.panel[data-panel="playlists"].active')) loadForgePrefsUI();
  });

  function renderWatchQueue() {
    const listEl = $('watch-queue-list');
    if (!listEl) return;
    listEl.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = "Use YouTube's Up next panel on a watch page. This list is retired.";
    listEl.appendChild(empty);
  }
  renderWatchQueue();
  if ($('watch-queue-play')) $('watch-queue-play').hidden = true;
  if ($('watch-queue-clear')) $('watch-queue-clear').hidden = true;

  // ---- analytics overlay prefs (stats tab) ----
  const ANALYTICS_SECTIONS = [
    ['engagement', 'Engagement'],
    ['compare', 'Compare videos'],
    ['seo', 'SEO score'],
    ['tags', 'Tags'],
    ['creator', 'Keyword research']
  ];
  function initAnalyticsPrefs() {
    const box = $('analytics-section-toggles');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    ANALYTICS_SECTIONS.forEach(([key, label]) => {
      const lbl = document.createElement('label');
      lbl.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.analyticsSec = key;
      cb.id = 'analytics-sec-' + key;
      lbl.setAttribute('for', cb.id);
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + label));
      box.appendChild(lbl);
    });
    chrome.storage.local.get({ statsSections: {}, statsCollapsed: true }, (d) => {
      const pref = d.statsSections || {};
      box.querySelectorAll('[data-analytics-sec]').forEach((cb) => {
        cb.checked = pref[cb.dataset.analyticsSec] !== false;
      });
      if ($('analytics-collapsed')) $('analytics-collapsed').checked = !!d.statsCollapsed;
    });
    if ($('save-analytics-prefs')) {
      $('save-analytics-prefs').addEventListener('click', () => {
        const pref = {};
        box.querySelectorAll('[data-analytics-sec]').forEach((cb) => {
          pref[cb.dataset.analyticsSec] = cb.checked;
        });
        chrome.storage.local.set(
          { statsSections: pref, statsCollapsed: $('analytics-collapsed') ? $('analytics-collapsed').checked : false },
          () => flash($('analytics-prefs-status'), 'Overlay prefs saved.')
        );
      });
    }
  }
  initAnalyticsPrefs();

