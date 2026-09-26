'use strict';

/** Suite dashboard — drives the service worker for auth, AI config, modules. */
  if (window.UNBrowserEnv) UNBrowserEnv.applyCopy();
  if (window.UNOpenPage) UNOpenPage.bindExternalLinks();
  // Escape user/YouTube-supplied strings before they ever go into innerHTML.
  var escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Apply recommended profile via service worker (includes bundled PocketTube + AiSList)
  if (window.UNProfile) {
    chrome.storage.local.get({ profileVersion: 0, subStore: null, plFolderStore: null }, (d) => {
      const PF = window.UNPlaylistFolders;
      const subEmpty = !d.subStore || !Object.keys((d.subStore.groups || {})).length;
      const plEmpty = !d.plFolderStore || !(PF && PF.folderCount(d.plFolderStore));
      if (d.profileVersion >= UNProfile.VERSION && !subEmpty && !plEmpty) return;
      send(UNMSG.PROFILE_APPLY).then((r) => {
        if (typeof refreshFilterSummary === 'function') refreshFilterSummary();
        if (typeof renderPlFolders === 'function') renderPlFolders();
        if (r && r.ok === false) {
          var el = $('modules-status') || $('use-case-status');
          flash(el, 'Setup couldn’t finish syncing' + (r.error === 'quota' ? ' — your keywords/channels list is too large to sync; trim it on the Filter tab.' : '.'), false);
        }
      });
    });
  }

  var D = window.UNSYNTH_DEFAULTS;
  var DEFAULT_PRESET = 'essentials';
  var $ = (id) => document.getElementById(id);
  var send = (type, extra) =>
    new Promise((resolve) => chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (r) => resolve(r || { ok: false, error: 'no_response' })));
  var flash = (el, msg, good) => {
    if (!el) return;
    el.textContent = msg;
    el.style.color = good === false ? 'var(--un-bad, #ff7a7a)' : 'var(--un-good, #6ee787)';
    if (msg) setTimeout(() => (el.textContent = ''), 2600);
  };

  // Styled async replacements for window.confirm/prompt (blocking natives look
  // jarring against the dashboard theme). Fall back to natives if UNDrill is gone.
  var uiConfirm = (msg, okLabel) =>
    window.UNDrill && UNDrill.confirm ? UNDrill.confirm('Confirm', msg, { okLabel: okLabel || 'OK' }) : Promise.resolve(window.confirm(msg));
  var uiPrompt = (title, def) =>
    window.UNDrill && UNDrill.prompt ? UNDrill.prompt(title, '', def) : Promise.resolve(window.prompt(title, def));

  // ---- blanket accessibility passes (cover every status span + label/input) ----
  // Announce every flash() status to screen readers.
  document.querySelectorAll('.status:not([aria-live])').forEach((el) => el.setAttribute('aria-live', 'polite'));
  // Associate sibling labels with their field's input (clicking the label focuses it).
  document.querySelectorAll('.field > label:not([for])').forEach((lbl) => {
    const input = lbl.parentElement.querySelector('input, select, textarea');
    if (!input) return;
    if (!input.id) input.id = 'un-fld-' + Math.random().toString(36).slice(2, 8);
    lbl.setAttribute('for', input.id);
  });

  // ---- tabs ----
  const VALID_TABS = ['modules', 'filter', 'tune', 'watched', 'stats', 'creator', 'playlists', 'subs', 'account', 'ai'];
  const PANEL_TITLES = {
    modules: 'Feature modules',
    filter: 'AI content filter',
    tune: 'Tune YouTube',
    watched: 'Watched history',
    stats: 'Your stats',
    creator: 'Creator Studio',
    playlists: 'Playlists',
    subs: 'Subscriptions & folders',
    account: 'Account',
    ai: 'AI provider'
  };

  function activateTab(tabId, opts) {
    const id = VALID_TABS.includes(tabId) ? tabId : 'modules';
    document.querySelectorAll('.tab').forEach((x) => {
      const on = x.dataset.tab === id;
      x.classList.toggle('active', on);
      // Keep ARIA + roving tabindex in sync for keyboard/screen-reader users.
      x.setAttribute('aria-selected', on ? 'true' : 'false');
      x.setAttribute('tabindex', on ? '0' : '-1');
    });
    document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.dataset.panel === id));
    // Start each panel at its top — switching from a long panel used to leave
    // the new one scrolled to wherever the old one was.
    if (!opts || !opts.scrollTo) window.scrollTo({ top: 0 });
    const title = $('dash-panel-title');
    if (title) title.textContent = PANEL_TITLES[id] || 'Unsynth';
    // Per-tab init functions live in dashboard-filter/stats/creator.js, which load
    // after this file — guard every call so a hash route can never throw mid-init.
    if (id === 'subs') {
      if (typeof renderSubs === 'function') renderSubs();
      // renderPlFolders moved to the playlists panel with its markup. The
      // subs panel keeps refreshActiveFilters because #active-pl-filter-line
      // — the "Playlist group:" row — is still part of its Active filter card.
      if (typeof refreshActiveFilters === 'function') refreshActiveFilters();
      if (typeof syncGroupedSubsTitles === 'function') syncGroupedSubsTitles();
    }
    if (id === 'stats') {
      if (typeof initStats === 'function') initStats();
      if (typeof initAnalyticsPrefs === 'function') initAnalyticsPrefs();
    }
    if (id === 'creator' && typeof initCreatorStudio === 'function') initCreatorStudio();
    if (id === 'filter' && typeof initFilterPanel === 'function') initFilterPanel();
    if (id === 'ai') {
      if (typeof loadAiPanelPrefs === 'function') loadAiPanelPrefs();
      // re-read provider/model/key-status when the AI tab is opened (incl. deep-link)
      if (typeof refreshAI === 'function') refreshAI();
    }
    if (id === 'watched' && typeof loadWatchedThreshold === 'function') loadWatchedThreshold();
    if (id === 'playlists') {
      if (typeof refreshPlaylistPanel === 'function') refreshPlaylistPanel();
      // Forge's card and the folders/pins card both live here now, so their
      // init runs with this panel rather than with Stats and Subscriptions.
      if (typeof loadForgePrefsUI === 'function') loadForgePrefsUI();
      if (typeof renderPlFolders === 'function') renderPlFolders();
    }
    if (id === 'account') {
      if (typeof refreshUpdatesCard === 'function') refreshUpdatesCard();
      if (typeof refreshSetupChecklist === 'function') refreshSetupChecklist();
      if (typeof refreshSelectorMissWarnings === 'function') refreshSelectorMissWarnings();
    }
    if (!opts || !opts.skipHash) {
      const h = '#' + id;
      if (location.hash !== h) history.replaceState(null, '', h);
    }
    if (opts && opts.scrollTo) {
      const el = document.getElementById(opts.scrollTo);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function routeFromHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    const parts = raw.split('/');
    let tab = parts[0];
    let scrollTo = parts[1] || null;
    if (tab === 'updates') {
      tab = 'account';
      scrollTo = 'updates';
    }
    if (tab && VALID_TABS.includes(tab)) activateTab(tab, { skipHash: true, scrollTo });
  }

  const tabBtns = Array.from(document.querySelectorAll('.tab'));
  tabBtns.forEach((t, i) => {
    t.addEventListener('click', () => activateTab(t.dataset.tab));
    // WAI-ARIA tabs pattern: arrows/Home/End move + activate within the list.
    t.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = tabBtns[(i + 1) % tabBtns.length];
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = tabBtns[(i - 1 + tabBtns.length) % tabBtns.length];
      else if (e.key === 'Home') next = tabBtns[0];
      else if (e.key === 'End') next = tabBtns[tabBtns.length - 1];
      if (next) {
        e.preventDefault();
        next.focus();
        activateTab(next.dataset.tab);
      }
    });
  });
  window.addEventListener('hashchange', routeFromHash);
  // Defer the initial route until every dashboard script has loaded — the tab
  // init functions live in dashboard-filter/stats/creator.js (loaded after core),
  // and routing synchronously here used to throw and abort the rest of this file.
  document.addEventListener('DOMContentLoaded', routeFromHash, { once: true });
  if ($('dash-reload-yt')) {
    $('dash-reload-yt').addEventListener('click', () => {
      send(UNMSG.RELOAD_YOUTUBE_TABS).then(() => {
        chrome.storage.local.set({ setupYoutubeReloaded: true });
        flash($('modules-status'), 'YouTube tabs reloaded.');
        if (typeof refreshSetupChecklist === 'function') refreshSetupChecklist();
      });
    });
  }
  if ($('dash-playlist-organizer')) {
    $('dash-playlist-organizer').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/playlist-organizer/organizer.html') });
    });
  }

  // ---- Playlists panel ----
  // The tools it links to stay on their own panels, because each is wired to JS
  // that runs on that panel's activation. This routes to them and scrolls to the
  // card itself rather than dumping the user at the top of a long panel.
  // Mounted on first open, not at page load: the organizer fetches playlists
  // and their items, so building it for every dashboard visit would spend API
  // quota on a panel nobody opened. Mounted once and then left alone, so
  // switching tabs does not throw away in-progress selections.
  function mountOrganizerFrame() {
    const host = $('pl-organizer-frame');
    if (!host || host.querySelector('iframe')) return;
    const frame = document.createElement('iframe');
    frame.className = 'pl-organizer-iframe';
    frame.title = 'Playlist Organizer';
    frame.src = chrome.runtime.getURL('src/playlist-organizer/organizer.html');
    frame.addEventListener('load', () => {
      const loading = $('pl-organizer-loading');
      if (loading) loading.remove();
    });
    host.appendChild(frame);
  }

  function refreshPlaylistPanel() {
    mountOrganizerFrame();
    const line = $('pl-panel-summary');
    if (!line) return;
    chrome.storage.local.get({ plPins: null, plFolderStore: null }, (d) => {
      if (chrome.runtime.lastError) {
        // Never claim an empty library when the store simply could not be read
        // — "0 pinned" reads as data loss.
        line.textContent = 'Could not read your saved playlists.';
        return;
      }
      const ids = (d.plPins && Array.isArray(d.plPins.ids) && d.plPins.ids) || [];
      const folders = (d.plFolderStore && d.plFolderStore.folders) || null;
      const folderCount = folders ? Object.keys(folders).length : 0;
      if (!ids.length) {
        line.textContent =
          'Nothing pinned yet. Pin playlists from YouTube’s sidebar once Playlist groups is on, or import them below.';
        return;
      }
      const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
      line.textContent =
        plural(ids.length, 'playlist', 'playlists') +
        ' pinned' +
        (folderCount ? ', in ' + plural(folderCount, 'folder', 'folders') : ', not grouped into folders yet') +
        '.';
    });
  }
  window.refreshPlaylistPanel = refreshPlaylistPanel;

  if ($('pl-panel-organizer')) {
    $('pl-panel-organizer').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/playlist-organizer/organizer.html') });
    });
  }
  if ($('dash-oneclick')) {
    $('dash-oneclick').addEventListener('click', () => {
      chrome.storage.local.get({ useCasePreset: DEFAULT_PRESET }, (d) => finishOneClickSetup(d.useCasePreset || DEFAULT_PRESET));
    });
  }

  function openSetupGuide() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/setup-guide.html') });
  }
  function openSetupSiteOnline() {
    if (window.UNSetupLinks) UNSetupLinks.openSetupSite();
    else chrome.tabs.create({ url: 'https://unsynth.vercel.app' });
  }
  function openSetupSiteOAuth() {
    if (window.UNSetupLinks) UNSetupLinks.openSetupSite('oauth');
    else chrome.tabs.create({ url: 'https://unsynth.vercel.app#oauth' });
  }
  ['open-setup-guide', 'open-setup-guide-inline', 'onboard-setup-guide'].forEach((id) => {
    if ($(id)) $(id).addEventListener('click', openSetupGuide);
  });
  ['open-setup-guide-oauth'].forEach((id) => {
    if ($(id)) $(id).addEventListener('click', openSetupSiteOAuth);
  });
  ['open-setup-site-online', 'onboard-setup-site-online', 'open-setup-site-online-wizard'].forEach((id) => {
    if ($(id)) $(id).addEventListener('click', openSetupSiteOnline);
  });

  if (window.UNDONATION) {
    const pitch = $('donation-pitch');
    if (pitch && UNDONATION.DONATION.pitch) pitch.textContent = UNDONATION.DONATION.pitch;
    if ($('donation-kofi')) {
      $('donation-kofi').addEventListener('click', () => UNDONATION.openKofi());
    }
  }

  // ---- modules ----
  const dashOpenTiers = new Set(['essential', 'player']);

  function refreshDashModuleCounts() {
    const list = $('dash-modules-list');
    if (!list) return;
    list.querySelectorAll('.dash-modgroup').forEach((grp) => {
      const rows = grp.querySelectorAll('.dash-modrow');
      const on = [...rows].filter((r) => {
        const cb = r.querySelector('[data-module]');
        return cb && cb.checked;
      }).length;
      const chip = grp.querySelector('.dash-modgroup-count');
      if (chip) {
        chip.textContent = on + ' / ' + rows.length;
        chip.classList.toggle('none', on === 0);
      }
    });
  }

  function applyDashModuleSearch() {
    const input = $('dash-mod-search');
    const list = $('dash-modules-list');
    if (!input || !list) return;
    const q = input.value.trim().toLowerCase();
    list.querySelectorAll('.dash-modgroup').forEach((grp) => {
      let shown = 0;
      grp.querySelectorAll('.dash-modrow').forEach((row) => {
        const hit = !q || (row.dataset.search || '').indexOf(q) !== -1;
        row.hidden = !hit;
        if (hit) shown++;
      });
      grp.hidden = shown === 0;
      if (q && shown > 0) grp.open = true;
      else if (!q) grp.open = dashOpenTiers.has(grp.dataset.tier);
    });
    const none = $('dash-mod-no-results');
    if (none) {
      const any = [...list.querySelectorAll('.dash-modrow')].some((r) => !r.hidden);
      none.hidden = !q || any;
    }
  }

  function initDashModuleSearch() {
    const input = $('dash-mod-search');
    const list = $('dash-modules-list');
    if (!input || !list) return;
    input.addEventListener('input', applyDashModuleSearch);
    list.querySelectorAll('.dash-modgroup').forEach((grp) => {
      grp.addEventListener('toggle', () => {
        if (!input.value.trim()) {
          if (grp.open) dashOpenTiers.add(grp.dataset.tier);
          else dashOpenTiers.delete(grp.dataset.tier);
        }
      });
    });
    refreshDashModuleCounts();
  }

  async function refreshSelectorMissWarnings() {
    const banner = $('dash-drift-banner');
    const box = $('drift-warning');
    let runtime = null;
    try {
      const tabs = await chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
      if (!tabs || !tabs.length) {
        if (banner) banner.hidden = true;
        return;
      }
      runtime = await chrome.tabs.sendMessage(tabs[0].id, { type: 'unsynth-get-diagnostics' });
    } catch (e) {
      if (banner) banner.hidden = true;
      return;
    }
    const misses = (runtime && runtime.selectorMisses) || [];
    const real = misses.filter((m) => m && m.count >= 3);
    if (banner) {
      if (!real.length) {
        banner.hidden = true;
      } else {
        banner.hidden = false;
        banner.textContent =
          real.length +
          ' feature' +
          (real.length === 1 ? '' : 's') +
          ' may not be working — YouTube changed its layout. See Account → Diagnostics.';
      }
    }
    if (box && real.length) {
      box.hidden = false;
      box.innerHTML =
        '<p class="hint" style="color:var(--un-warn)"><b>' +
        real.length +
        ' selector' +
        (real.length === 1 ? '' : 's') +
        ' stopped matching.</b> YouTube most likely changed its markup, so the features below are not doing anything. Copy diagnostics and report it.</p><ul class="hint">' +
        real
          .slice(0, 8)
          .map(
            (m) =>
              '<li><b>' +
              escHtml(m.scope) +
              '</b> &mdash; ' +
              escHtml(m.count) +
              ' misses<br><code>' +
              escHtml(String(m.selector).slice(0, 120)) +
              '</code></li>'
          )
          .join('') +
        '</ul>';
    }
  }
  window.refreshSelectorMissWarnings = refreshSelectorMissWarnings;
  refreshSelectorMissWarnings();

  chrome.storage.sync.get({ modules: D.modules, enabled: D.enabled }, (s) => {
    let mods = Object.assign({}, D.modules, s.modules);
    if (window.UNModules) mods = UNModules.normalizeModules(mods, D);
    document.querySelectorAll('[data-module]').forEach((el) => {
      el.checked = mods[el.dataset.module] !== false;
    });
    refreshActiveFilters();
    initDashModuleSearch();
  });
  if ($('open-filter-2')) $('open-filter-2').addEventListener('click', () => activateTab('filter'));

  function refreshFilterSummary() {
    const el = $('filter-summary');
    if (!el) return;
    chrome.storage.sync.get(D, (s) => {
      const on = s.enabled !== false;
      const kw = (s.keywords || []).length;
      const ch = (s.channels || []).length;
      const allow = (s.allowedChannels || []).length;
      const subsAllow = s.allowSubscribedChannels !== false;
      const mode = s.mode || 'hide';
      const comm = s.communityList && s.communityList.enabled;
      const focus = s.focus && s.focus.enabled;
      el.textContent = '';
      const status = document.createElement('b');
      status.textContent = on ? 'On' : 'Off';
      el.appendChild(status);
      el.appendChild(document.createTextNode(
        ' · mode: ' + mode + ' · ' + kw + ' keywords · ' + ch + ' blocked · ' +
        (subsAllow ? 'subs allowed' : 'subs filtered') +
        (allow ? ' · ' + allow + ' extra allowed' : '') +
        (comm ? ' · AiSList on' : '') +
        (focus ? ' · Focus schedule' : '')
      ));
    });
  }
  refreshFilterSummary();

  // ---- SponsorBlock settings ----
  const SBSEG = window.UNSBSegments;
  const SB_MODE_OPTS = [
    ['auto', 'Auto skip'],
    ['manual', 'Show button'],
    ['overlay', 'Show only'],
    ['disabled', 'Disabled']
  ];
  function buildSponsorCategoryRows() {
    const host = $('sb-category-modes');
    if (!host || !SBSEG || host.childElementCount) return;
    SBSEG.CATEGORIES.forEach((cat) => {
      const row = document.createElement('label');
      row.className = 'row sb-cat-row';
      const dot = document.createElement('span');
      dot.className = 'sb-cat-dot';
      dot.style.background = cat.color;
      const name = document.createElement('span');
      name.className = 'sb-cat-name';
      name.textContent = cat.label;
      const sel = document.createElement('select');
      sel.className = 'sb-cat-mode';
      sel.setAttribute('data-sb-mode', cat.id);
      // Restrict the choices to what each action type can actually do:
      //   skip → auto / button / show / disabled   (full four)
      //   poi (highlight) → button / show / disabled   (jump button or marker)
      //   full / chapter → show / disabled   (label/markers only, never skip)
      const allow =
        cat.action === 'skip'
          ? ['auto', 'manual', 'overlay', 'disabled']
          : cat.action === 'poi'
            ? ['manual', 'overlay', 'disabled']
            : ['overlay', 'disabled'];
      const opts = SB_MODE_OPTS.filter(([v]) => allow.indexOf(v) !== -1);
      opts.forEach(([v, l]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = l;
        sel.appendChild(o);
      });
      row.append(dot, name, sel);
      host.appendChild(row);
    });
  }
  function loadSponsorBlock(sb) {
    const cfg = Object.assign({}, D.sponsorBlock, sb);
    if ($('sb-autoskip')) $('sb-autoskip').checked = cfg.autoSkip !== false;
    if ($('sb-use-community')) $('sb-use-community').checked = cfg.useCommunity !== false;
    if ($('sb-use-personal')) $('sb-use-personal').checked = cfg.usePersonal !== false;
    if ($('sb-community-direct')) $('sb-community-direct').checked = cfg.communityDirect !== false;
    if ($('sb-hide-chapters')) $('sb-hide-chapters').checked = cfg.hideChapters === true;
    buildSponsorCategoryRows();
    document.querySelectorAll('[data-sb-mode]').forEach((el) => {
      const id = el.getAttribute('data-sb-mode');
      el.value = SBSEG ? SBSEG.modeFor(id, cfg) : 'disabled';
    });
  }
  function gatherSponsorBlock() {
    const categoryModes = {};
    const categories = {};
    document.querySelectorAll('[data-sb-mode]').forEach((el) => {
      const id = el.getAttribute('data-sb-mode');
      categoryModes[id] = el.value;
      // Keep the legacy boolean map roughly in sync for older readers.
      categories[id] = el.value !== 'disabled';
    });
    return {
      autoSkip: $('sb-autoskip') ? $('sb-autoskip').checked : true,
      useCommunity: $('sb-use-community') ? $('sb-use-community').checked : true,
      usePersonal: $('sb-use-personal') ? $('sb-use-personal').checked : true,
      communityDirect: $('sb-community-direct') ? $('sb-community-direct').checked : true,
      hideChapters: $('sb-hide-chapters') ? $('sb-hide-chapters').checked : false,
      categoryModes,
      categories
    };
  }
  chrome.storage.sync.get({ sponsorBlock: D.sponsorBlock }, (s) => loadSponsorBlock(s.sponsorBlock));

  function loadDislikeRestore(dr) {
    const d = Object.assign({}, D.dislikeRestore, dr || {});
    if ($('ryd-watch-buttons')) $('ryd-watch-buttons').checked = d.watchButtons !== false;
    if ($('ryd-watch-meta')) $('ryd-watch-meta').checked = d.watchMetaRow !== false;
    if ($('ryd-feed-tiles')) $('ryd-feed-tiles').checked = d.feedTiles !== false;
    if ($('ryd-show-ratio')) $('ryd-show-ratio').checked = d.showRatio !== false;
    if ($('ryd-show-views')) $('ryd-show-views').checked = d.showViews !== false;
    if ($('ryd-show-date')) $('ryd-show-date').checked = d.showDate !== false;
    if ($('ryd-stats-factcheck')) $('ryd-stats-factcheck').checked = d.statsFactCheck !== false;
    if ($('ryd-stats-position')) $('ryd-stats-position').value = d.statsPosition || 'wide';
    if ($('ryd-stats-style')) $('ryd-stats-style').value = d.statsStyle || 'card';
  }
  function gatherDislikeRestore() {
    return {
      feedTiles: $('ryd-feed-tiles') ? $('ryd-feed-tiles').checked : true,
      watchMetaRow: $('ryd-watch-meta') ? $('ryd-watch-meta').checked : true,
      watchButtons: $('ryd-watch-buttons') ? $('ryd-watch-buttons').checked : true,
      showRatio: $('ryd-show-ratio') ? $('ryd-show-ratio').checked : true,
      showViews: $('ryd-show-views') ? $('ryd-show-views').checked : true,
      showDate: $('ryd-show-date') ? $('ryd-show-date').checked : true,
      statsFactCheck: $('ryd-stats-factcheck') ? $('ryd-stats-factcheck').checked : true,
      statsPosition: $('ryd-stats-position') ? $('ryd-stats-position').value : 'wide',
      statsStyle: $('ryd-stats-style') ? $('ryd-stats-style').value : 'card'
    };
  }
  chrome.storage.sync.get({ dislikeRestore: D.dislikeRestore }, (s) => loadDislikeRestore(s.dislikeRestore));

  // Watch guide position. The guide listens for this key and moves in open
  // tabs, so no reload is asked for.
  if ($('guide-placement')) {
    chrome.storage.sync.get({ watchGuide: D.watchGuide }, (s) => {
      const g = Object.assign({}, D.watchGuide, s.watchGuide || {});
      $('guide-placement').value = g.placement === 'below' ? 'below' : 'side';
    });
    $('guide-placement').addEventListener('change', () => {
      const placement = $('guide-placement').value === 'below' ? 'below' : 'side';
      chrome.storage.sync.set({ watchGuide: Object.assign({}, D.watchGuide, { placement }) }, () => {
        flash($('modules-status'), placement === 'below' ? 'Watch guide moves under the video.' : 'Watch guide moves beside the video.');
      });
    });
  }
  ['ryd-watch-buttons', 'ryd-watch-meta', 'ryd-feed-tiles', 'ryd-show-ratio', 'ryd-show-views', 'ryd-show-date', 'ryd-stats-factcheck', 'ryd-stats-position', 'ryd-stats-style'].forEach((id) => {
    if ($(id)) {
      $(id).addEventListener('change', () => {
        chrome.storage.sync.set({ dislikeRestore: gatherDislikeRestore() }, () => {
          chrome.storage.local.set({ needsTabReload: true });
          flash($('modules-status'), 'Video stats prefs saved. Reload YouTube tabs to apply.');
        });
      });
    }
  });

  function loadPopoutPlayer(p) {
    const d = Object.assign({}, D.popoutPlayer, p || {});
    if ($('popout-show-btn')) $('popout-show-btn').checked = d.showPlayerButton !== false;
    if ($('popout-width')) $('popout-width').value = d.width || 853;
    if ($('popout-height')) $('popout-height').value = d.height || 480;
  }
  function gatherPopoutPlayer() {
    return {
      showPlayerButton: $('popout-show-btn') ? $('popout-show-btn').checked : true,
      width: Number($('popout-width') && $('popout-width').value) || 853,
      height: Number($('popout-height') && $('popout-height').value) || 480
    };
  }
  function loadVolumeMaster(v) {
    const d = Object.assign({}, D.volumeMaster, v || {});
    // `=== true`, not `!== false`: showPlayerControl now defaults to FALSE
    // (YouTube's own volume slider already sits in the left player controls —
    // see defaults.js). Boost/EQ still run; only the bar button is hidden.
    if ($('vol-show-ctrl')) $('vol-show-ctrl').checked = d.showPlayerControl === true;
    if ($('vol-inline-bar')) $('vol-inline-bar').checked = d.inlineBar !== false;
    if ($('vol-remember')) $('vol-remember').checked = d.rememberLevel !== false;
    // 0 is a valid starting level (start muted), so fall back only when the
    // stored value is genuinely absent — `|| 25` would rewrite a chosen 0.
    // Fall back to the shipped default rather than a second hardcoded copy of
    // it — the literal 25 here kept overriding the real default when it moved.
    if ($('vol-default-level')) {
      $('vol-default-level').value =
        typeof d.defaultLevel === 'number' ? d.defaultLevel : (D.volumeMaster && D.volumeMaster.defaultLevel) || 0;
    }
    if ($('vol-boost-max')) $('vol-boost-max').value = d.boostMax || 600;
  }
  function gatherVolumeMaster() {
    // defaultLevel MUST be gathered here even though it's a newer field: this
    // object replaces the stored volumeMaster settings wholesale, so omitting
    // a field silently resets it every time any volume setting is saved.
    const rawLevel = Number($('vol-default-level') && $('vol-default-level').value);
    return {
      showPlayerControl: $('vol-show-ctrl') ? $('vol-show-ctrl').checked : false,
      inlineBar: $('vol-inline-bar') ? $('vol-inline-bar').checked : true,
      rememberLevel: $('vol-remember') ? $('vol-remember').checked : true,
      defaultLevel: isFinite(rawLevel)
        ? Math.min(600, Math.max(0, Math.round(rawLevel)))
        : (D.volumeMaster && D.volumeMaster.defaultLevel) || 0,
      boostMax: Math.min(600, Math.max(100, Number($('vol-boost-max') && $('vol-boost-max').value) || 600))
      // audioPreset lives on the popup EQ. Never list it here: saveMediaPrefs
      // merges this object over the stored volumeMaster so the preset survives.
    };
  }
  function loadFactCheck(f) {
    const d = Object.assign({}, D.factCheck, f || {});
    if ($('fc-show-panel')) $('fc-show-panel').checked = d.showVideoPanel !== false;
    if ($('fc-auto-video')) $('fc-auto-video').checked = d.autoVideo === true;
    if ($('fc-comment-btns')) $('fc-comment-btns').checked = d.commentButtons !== false;
  }
  function gatherFactCheck() {
    return {
      showVideoPanel: $('fc-show-panel') ? $('fc-show-panel').checked : true,
      autoVideo: $('fc-auto-video') ? $('fc-auto-video').checked : false,
      commentButtons: $('fc-comment-btns') ? $('fc-comment-btns').checked : true
    };
  }
  function loadTasteRank(v) {
    const d = Object.assign({}, D.tasteRank, v || {});
    if ($('taste-badges')) $('taste-badges').checked = d.badges !== false;
    if ($('taste-reorder')) $('taste-reorder').checked = d.reorder !== false;
    if ($('taste-minscore')) {
      const ms = typeof d.minScore === 'number' ? d.minScore : 35;
      $('taste-minscore').value = String(ms);
      if ($('taste-minscore-out')) $('taste-minscore-out').textContent = ms + '%';
    }
  }
  function gatherTasteRank() {
    // Read back every field: this object REPLACES the stored tasteRank
    // settings, so anything omitted here is silently reset on each save.
    const raw = Number($('taste-minscore') && $('taste-minscore').value);
    return {
      enabled: true,
      badges: $('taste-badges') ? $('taste-badges').checked : true,
      reorder: $('taste-reorder') ? $('taste-reorder').checked : true,
      minScore: isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 35
    };
  }

  // Show the user what the profile has actually learned. A recommender the
  // user can't inspect is indistinguishable from one that's broken.
  function renderTasteSummary() {
    const out = $('taste-summary');
    if (!out) return;
    const TP = window.UNTasteProfile;
    if (!TP) {
      out.textContent = 'Taste profile unavailable.';
      return;
    }
    chrome.storage.local.get(TP.STORAGE_KEY, (d) => {
      if (chrome.runtime.lastError) return;
      const p = TP.normalize(d && d[TP.STORAGE_KEY]);
      const interests = TP.topInterests(p, 12);
      const chans = TP.topChannels(p, 5);
      if (!interests.length && !chans.length) {
        out.textContent = 'Nothing learned yet — watch a few videos and this fills in.';
        return;
      }
      const bits = [];
      bits.push(p.totalWatched + ' video' + (p.totalWatched === 1 ? '' : 's') + ' learned from.');
      if (interests.length) bits.push('Topics: ' + interests.map((i) => i.token).join(', ') + '.');
      if (chans.length) bits.push('Channels: ' + chans.map((c) => c.name).join(', ') + '.');
      out.textContent = bits.join(' ');
    });
  }

  function saveMediaPrefs() {
    chrome.storage.sync.get(
      {
        popoutPlayer: D.popoutPlayer,
        volumeMaster: D.volumeMaster,
        factCheck: D.factCheck,
        tasteRank: D.tasteRank,
        scrollMiniplayer: D.scrollMiniplayer,
        speedChip: D.speedChip
      },
      (s) => {
        chrome.storage.sync.set(
          {
            popoutPlayer: Object.assign({}, D.popoutPlayer, s.popoutPlayer, gatherPopoutPlayer()),
            volumeMaster: Object.assign({}, D.volumeMaster, s.volumeMaster, gatherVolumeMaster()),
            factCheck: Object.assign({}, D.factCheck, s.factCheck, gatherFactCheck()),
            tasteRank: Object.assign({}, D.tasteRank, s.tasteRank, gatherTasteRank()),
            scrollMiniplayer: Object.assign({}, D.scrollMiniplayer, s.scrollMiniplayer, gatherScrollMiniplayer()),
            speedChip: Object.assign({}, D.speedChip, s.speedChip, gatherSpeedChip())
          },
          () => {
            chrome.storage.local.set({ needsTabReload: true });
            flash($('modules-status'), 'Media & fact-check prefs saved. Reload YouTube tabs to apply.');
          }
        );
      }
    );
  }
  chrome.storage.sync.get(
    { popoutPlayer: D.popoutPlayer, volumeMaster: D.volumeMaster, factCheck: D.factCheck, tasteRank: D.tasteRank, scrollMiniplayer: D.scrollMiniplayer, speedChip: D.speedChip },
    (s) => {
      loadPopoutPlayer(s.popoutPlayer);
      loadVolumeMaster(s.volumeMaster);
      loadFactCheck(s.factCheck);
      loadTasteRank(s.tasteRank);
      loadScrollMiniplayer(s.scrollMiniplayer);
      loadSpeedChip(s.speedChip);
      renderTasteSummary();
    }
  );
  if ($('taste-minscore') && $('taste-minscore-out')) {
    $('taste-minscore').addEventListener('input', () => {
      $('taste-minscore-out').textContent = $('taste-minscore').value + '%';
    });
  }
  if ($('taste-refresh')) $('taste-refresh').addEventListener('click', renderTasteSummary);
  if ($('taste-clear')) {
    $('taste-clear').addEventListener('click', () => {
      const TP = window.UNTasteProfile;
      if (!TP) return;
      chrome.storage.local.remove(TP.STORAGE_KEY, () => {
        renderTasteSummary();
        flash($('taste-status'), 'Taste profile cleared.');
      });
    });
  }
  let mediaSaveTimer = null;
  [
    'popout-show-btn', 'popout-width', 'popout-height',
    'mini-show-btn',
    'vol-show-ctrl', 'vol-inline-bar', 'vol-remember', 'vol-default-level', 'vol-boost-max',
    'fc-show-panel', 'fc-auto-video', 'fc-comment-btns',
    'taste-badges', 'taste-reorder', 'taste-minscore'
  ].forEach((id) => {
    if ($(id)) $(id).addEventListener('change', saveMediaPrefs);
    // Debounce continuous input — don't write to sync storage per keystroke or
    // per pixel of slider drag. Ranges included: they do fire `change` on
    // release, but debouncing `input` too means the value applies as you drag
    // rather than only once you let go.
    if ($(id) && ($(id).type === 'number' || $(id).type === 'range')) {
      $(id).addEventListener('input', () => {
        clearTimeout(mediaSaveTimer);
        mediaSaveTimer = setTimeout(saveMediaPrefs, 350);
      });
    }
  });

  // ---- player & visual tool prefs (quality lock, screenshot, title cleaner, ambient) ----
  // Mirror the module toggle so adjusting a detail setting never silently
  // re-enables a module the user turned off.
  function moduleOn(key) {
    const cb = document.querySelector('[data-module="' + key + '"]');
    return cb ? !!cb.checked : true;
  }
  function loadQualityLock(q) {
    const d = Object.assign({}, D.qualityLock, q || {});
    if ($('ql-quality')) $('ql-quality').value = d.quality || '1080p';
    // `=== true`, not `!== false`: showChip now defaults to FALSE (the chip
    // duplicates YouTube's own settings-gear Quality row — see defaults.js),
    // and `!== false` renders an absent value as checked, which would show the
    // box ticked while the chip is actually hidden.
    if ($('ql-show-chip')) $('ql-show-chip').checked = d.showChip === true;
    if ($('ql-adaptive')) $('ql-adaptive').checked = d.adaptive !== false;
    if ($('ql-adaptive-strikes')) {
      $('ql-adaptive-strikes').value = String(typeof d.adaptiveStrikes === 'number' ? d.adaptiveStrikes : 2);
    }
    if ($('ql-adaptive-floor')) $('ql-adaptive-floor').value = d.adaptiveFloor || '720p';
  }
  function gatherQualityLock() {
    const strikes = Math.max(1, Math.min(8, Number($('ql-adaptive-strikes') && $('ql-adaptive-strikes').value) || 2));
    return {
      quality: ($('ql-quality') && $('ql-quality').value) || '1080p',
      showChip: $('ql-show-chip') ? $('ql-show-chip').checked : false,
      adaptive: $('ql-adaptive') ? $('ql-adaptive').checked : true,
      adaptiveStrikes: strikes,
      adaptiveFloor: ($('ql-adaptive-floor') && $('ql-adaptive-floor').value) || '720p'
    };
  }
  function loadScreenshot(s) {
    const d = Object.assign({}, D.screenshot, s || {});
    if ($('ss-show-btn')) $('ss-show-btn').checked = d.showButton !== false;
    if ($('ss-timestamp')) $('ss-timestamp').checked = d.includeTimestamp !== false;
  }
  function gatherScreenshot() {
    return {
      showButton: $('ss-show-btn') ? $('ss-show-btn').checked : true,
      includeTimestamp: $('ss-timestamp') ? $('ss-timestamp').checked : true
    };
  }
  function loadSkipSeconds(sk) {
    const d = Object.assign({}, D.skipSeconds, sk || {});
    if ($('sk-show-btn')) $('sk-show-btn').checked = d.showButtons !== false;
    if ($('sk-seconds')) $('sk-seconds').value = String(d.seconds || 10);
  }
  function gatherSkipSeconds() {
    return {
      showButtons: $('sk-show-btn') ? $('sk-show-btn').checked : true,
      seconds: ($('sk-seconds') && Number($('sk-seconds').value)) || 10
    };
  }
  function loadTitleCleaner(t) {
    const d = Object.assign({}, D.titleCleaner, t || {});
    if ($('tc-deallcaps')) $('tc-deallcaps').checked = d.deAllCaps !== false;
    if ($('tc-exclaim')) $('tc-exclaim').checked = d.stripExclamation !== false;
    if ($('tc-emoji')) $('tc-emoji').checked = d.stripEmoji === true;
  }
  function gatherTitleCleaner() {
    return {
      deAllCaps: $('tc-deallcaps') ? $('tc-deallcaps').checked : true,
      stripExclamation: $('tc-exclaim') ? $('tc-exclaim').checked : true,
      stripEmoji: $('tc-emoji') ? $('tc-emoji').checked : false
    };
  }
  function loadAmbientMode(a) {
    const d = Object.assign({}, D.ambientMode, a || {});
    const intensity = d.intensity != null ? d.intensity : 0.7;
    if ($('am-intensity')) $('am-intensity').value = intensity;
    if ($('am-intensity-val')) $('am-intensity-val').textContent = Number(intensity).toFixed(2);
    if ($('am-radius')) $('am-radius').value = d.radius || 90;
    const rate = typeof d.sampleRate === 'number' ? d.sampleRate : 2000;
    if ($('am-sample-rate')) $('am-sample-rate').value = rate;
    if ($('am-sample-rate-val')) $('am-sample-rate-val').textContent = String(rate);
  }
  function gatherAmbientMode() {
    const intensity = Math.min(1, Math.max(0, Number($('am-intensity') && $('am-intensity').value)));
    const rate = Math.min(5000, Math.max(250, Number($('am-sample-rate') && $('am-sample-rate').value) || 2000));
    return {
      intensity: isFinite(intensity) ? intensity : 0.7,
      radius: Math.min(220, Math.max(20, Number($('am-radius') && $('am-radius').value) || 90)),
      sampleRate: isFinite(rate) ? rate : 2000
    };
  }
  function loadDeArrow(da) {
    const d = Object.assign({}, D.deArrow, da || {});
    if ($('da-titles')) $('da-titles').checked = d.titles !== false;
    if ($('da-thumbs')) $('da-thumbs').checked = d.thumbnails !== false;
  }
  function gatherDeArrow() {
    return {
      titles: $('da-titles') ? $('da-titles').checked : true,
      thumbnails: $('da-thumbs') ? $('da-thumbs').checked : true
    };
  }
  function loadWatchQueue(q) {
    const d = Object.assign({}, D.watchQueue, q || {});
    if ($('wq-auto-advance')) $('wq-auto-advance').checked = d.autoAdvance !== false;
  }
  function gatherWatchQueue() {
    return {
      autoAdvance: $('wq-auto-advance') ? $('wq-auto-advance').checked : true
    };
  }
  function loadScrollMiniplayer(m) {
    const d = Object.assign({}, D.scrollMiniplayer, m || {});
    // `=== true`, not `!== false`: showPlayerButton now defaults to FALSE
    // (YouTube ships its own miniplayer button, and ours auto-docks on scroll
    // anyway — see defaults.js). Docking is unaffected.
    if ($('mini-show-btn')) $('mini-show-btn').checked = d.showPlayerButton === true;
  }
  function gatherScrollMiniplayer() {
    return {
      showPlayerButton: $('mini-show-btn') ? $('mini-show-btn').checked : false
    };
  }
  function loadSpeedChip(s) {
    const d = Object.assign({}, D.speedChip, s || {});
    if ($('sp-show-chip')) $('sp-show-chip').checked = d.showChip === true;
  }
  function gatherSpeedChip() {
    return {
      showChip: $('sp-show-chip') ? $('sp-show-chip').checked : false
    };
  }
  function loadAdSkip(a) {
    const d = Object.assign({}, D.adSkip, a || {});
    if ($('adskip-autoskip')) $('adskip-autoskip').checked = d.autoSkip !== false;
    if ($('adskip-mute')) $('adskip-mute').checked = d.muteNonSkippable !== false;
    if ($('adskip-overlay')) $('adskip-overlay').checked = d.hideOverlayAds !== false;
  }
  function gatherAdSkip() {
    return {
      autoSkip: $('adskip-autoskip') ? $('adskip-autoskip').checked : true,
      muteNonSkippable: $('adskip-mute') ? $('adskip-mute').checked : true,
      hideOverlayAds: $('adskip-overlay') ? $('adskip-overlay').checked : true
    };
  }
  function loadCommentFilter(cf) {
    const d = Object.assign({}, D.commentFilter, cf || {});
    const kw = Array.isArray(d.keywords) ? d.keywords.join('\n') : '';
    if ($('cf-keywords')) $('cf-keywords').value = kw;
    if ($('cf-useRegex')) $('cf-useRegex').checked = !!d.useRegex;
    if ($('filter-comment-keywords')) $('filter-comment-keywords').value = kw;
    if ($('filter-comment-useRegex')) $('filter-comment-useRegex').checked = !!d.useRegex;
  }
  function gatherCommentFilter(fromFilterTab) {
    const kwEl = fromFilterTab ? $('filter-comment-keywords') : ($('cf-keywords') || $('filter-comment-keywords'));
    const rxEl = fromFilterTab ? $('filter-comment-useRegex') : ($('cf-useRegex') || $('filter-comment-useRegex'));
    const raw = (kwEl && kwEl.value) || '';
    const keywords = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    return {
      keywords,
      useRegex: rxEl ? rxEl.checked : false
    };
  }

  // ---- shortcuts capture & rebind ----
  const SHORTCUT_DEFS = [
    { key: 'ambientMode', label: 'Toggle ambient glow', desc: 'Turns dynamic ambient lighting around the player on or off' },
    { key: 'screenshot', label: 'Capture screenshot frame', desc: 'Saves current frame as PNG' },
    { key: 'qualityLock', label: 'Toggle quality lock', desc: 'Pauses or resumes resolution lock for current video' },
    { key: 'speedDown', label: 'Decrease speed (-0.1x)', desc: 'Slows playback by 0.1x' },
    { key: 'speedUp', label: 'Increase speed (+0.1x)', desc: 'Speeds playback by 0.1x' },
    { key: 'openDashboard', label: 'Open dashboard', desc: 'Opens this settings dashboard' },
    { key: 'volumeBoostDown', label: 'Volume boost down (-10%)', desc: 'Lowers volume boost' },
    { key: 'volumeBoostUp', label: 'Volume boost up (+10%)', desc: 'Raises volume boost' },
    { key: 'quickSwitcher', label: 'Quick switcher', desc: 'Opens the palette to jump to any playlist or subscribed channel by name, folder or group' }
  ];
  let currentShortcuts = Object.assign({}, D.shortcuts);

  function formatKeyDisplay(binding) {
    if (!binding) return 'None (click to bind)';
    return binding
      .split('+')
      .map((k) => {
        if (k === 'arrowdown') return '↓';
        if (k === 'arrowup') return '↑';
        if (k === 'arrowleft') return '←';
        if (k === 'arrowright') return '→';
        return k.charAt(0).toUpperCase() + k.slice(1);
      })
      .join(' + ');
  }

  function renderShortcutsUI(shortcuts) {
    const container = $('shortcuts-table');
    if (!container) return;
    container.innerHTML = '';
    currentShortcuts = Object.assign({}, D.shortcuts, shortcuts || {});

    SHORTCUT_DEFS.forEach((def) => {
      const row = document.createElement('div');
      row.className = 'shortcut-row';

      const info = document.createElement('div');
      info.className = 'shortcut-info';
      info.innerHTML = '<span class="shortcut-name">' + escHtml(def.label) + '</span><span class="shortcut-desc">' + escHtml(def.desc) + '</span>';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shortcut-key-btn';
      btn.setAttribute('data-action', def.key);
      btn.textContent = formatKeyDisplay(currentShortcuts[def.key]);
      // The label is the key itself (often a single glyph like "["), which
      // says nothing on its own about which shortcut it rebinds.
      btn.setAttribute('aria-label',
        'Change shortcut for ' + def.label + ' (currently ' +
        formatKeyDisplay(currentShortcuts[def.key]) + ')');

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.shortcut-key-btn.recording').forEach((b) => {
          b.classList.remove('recording');
          const act = b.getAttribute('data-action');
          b.textContent = formatKeyDisplay(currentShortcuts[act]);
        });

        btn.classList.add('recording');
        btn.textContent = 'Press keys…';
        btn.setAttribute('aria-label', 'Recording new shortcut for ' + def.label + ' — press keys');

        function onKeyDown(ke) {
          ke.preventDefault();
          ke.stopPropagation();
          if (['Shift', 'Control', 'Alt', 'Meta'].includes(ke.key)) return;

          window.removeEventListener('keydown', onKeyDown, true);
          btn.classList.remove('recording');

          const k = ke.key.toLowerCase();
          let combo = '';
          if (k !== 'backspace' && k !== 'delete' && k !== 'escape') {
            const parts = [];
            if (ke.shiftKey) parts.push('shift');
            if (ke.ctrlKey) parts.push('ctrl');
            if (ke.altKey) parts.push('alt');
            if (ke.metaKey) parts.push('meta');
            parts.push(k);
            combo = parts.join('+');
          }

          currentShortcuts[def.key] = combo;
          btn.textContent = formatKeyDisplay(combo);

          chrome.storage.sync.set({ shortcuts: currentShortcuts }, () => {
            flash($('shortcuts-status'), 'Saved ' + def.label + ' (' + (combo || 'unbound') + ')');
          });
        }

        window.addEventListener('keydown', onKeyDown, { capture: true, once: false });
      });

      row.appendChild(info);
      row.appendChild(btn);
      container.appendChild(row);
    });
  }

  if ($('shortcuts-reset')) {
    $('shortcuts-reset').addEventListener('click', () => {
      currentShortcuts = Object.assign({}, D.shortcuts);
      chrome.storage.sync.set({ shortcuts: currentShortcuts }, () => {
        renderShortcutsUI(currentShortcuts);
        flash($('shortcuts-status'), 'Reset shortcuts to defaults.');
      });
    });
  }

  // Save each card on its own so adjusting one control never re-persists the
  // enabled state of unrelated modules (one chrome.storage.sync.set per card).
  function savePlayerCard(key, gather, statusId) {
    const base = D[key] && typeof D[key] === 'object' ? D[key] : {};
    chrome.storage.sync.get({ [key]: base }, (s) => {
      const payload = {};
      payload[key] = Object.assign({}, base, s[key] || {}, gather());
      chrome.storage.sync.set(payload, () => {
        chrome.storage.local.set({ needsTabReload: true });
        flash($(statusId) || $('modules-status'), 'Saved. Reload YouTube tabs to apply.');
      });
    });
  }
  const saveQl = () => savePlayerCard('qualityLock', gatherQualityLock, 'player-tools-status');
  const saveSs = () => savePlayerCard('screenshot', gatherScreenshot, 'player-tools-status');
  const saveSk = () => savePlayerCard('skipSeconds', gatherSkipSeconds, 'player-tools-status');
  const saveWq = () => savePlayerCard('watchQueue', gatherWatchQueue, 'player-tools-status');
  const saveTc = () => savePlayerCard('titleCleaner', gatherTitleCleaner, 'title-ambient-status');
  const saveAm = () => savePlayerCard('ambientMode', gatherAmbientMode, 'title-ambient-status');
  const saveDa = () => savePlayerCard('deArrow', gatherDeArrow, 'title-ambient-status');
  const saveAd = () => savePlayerCard('adSkip', gatherAdSkip, 'adskip-status');
  const saveCf = () => {
    const data = gatherCommentFilter(false);
    savePlayerCard('commentFilter', () => data, 'cf-status');
    if ($('filter-comment-keywords')) $('filter-comment-keywords').value = data.keywords.join('\n');
    if ($('filter-comment-useRegex')) $('filter-comment-useRegex').checked = data.useRegex;
  };
  const saveFilterTabCf = () => {
    const data = gatherCommentFilter(true);
    savePlayerCard('commentFilter', () => data, 'filter-status');
    if ($('cf-keywords')) $('cf-keywords').value = data.keywords.join('\n');
    if ($('cf-useRegex')) $('cf-useRegex').checked = data.useRegex;
  };
  chrome.storage.sync.get(
    { qualityLock: D.qualityLock, screenshot: D.screenshot, skipSeconds: D.skipSeconds, titleCleaner: D.titleCleaner, ambientMode: D.ambientMode, adSkip: D.adSkip, commentFilter: D.commentFilter, shortcuts: D.shortcuts, deArrow: D.deArrow, watchQueue: D.watchQueue },
    (s) => {
      loadQualityLock(s.qualityLock);
      loadScreenshot(s.screenshot);
      loadSkipSeconds(s.skipSeconds);
      loadTitleCleaner(s.titleCleaner);
      loadAmbientMode(s.ambientMode);
      loadAdSkip(s.adSkip);
      loadCommentFilter(s.commentFilter);
      loadDeArrow(s.deArrow);
      loadWatchQueue(s.watchQueue);
      renderShortcutsUI(s.shortcuts);
    }
  );
  const CARD_SAVE = {
    'ql-quality': saveQl, 'ql-show-chip': saveQl, 'ql-adaptive': saveQl, 'ql-adaptive-strikes': saveQl, 'ql-adaptive-floor': saveQl,
    'ss-show-btn': saveSs, 'ss-timestamp': saveSs,
    'sk-show-btn': saveSk, 'sk-seconds': saveSk,
    'wq-auto-advance': saveWq,
    'tc-deallcaps': saveTc, 'tc-exclaim': saveTc, 'tc-emoji': saveTc,
    'am-intensity': saveAm, 'am-radius': saveAm, 'am-sample-rate': saveAm,
    'da-titles': saveDa, 'da-thumbs': saveDa,
    'adskip-autoskip': saveAd, 'adskip-mute': saveAd, 'adskip-overlay': saveAd,
    'cf-useRegex': saveCf, 'filter-comment-useRegex': saveFilterTabCf
  };
  const cardSaveTimers = {};
  Object.keys(CARD_SAVE).forEach((id) => {
    if (!$(id)) return;
    $(id).addEventListener('change', CARD_SAVE[id]);
    if ($(id).type === 'number' || $(id).type === 'range') {
      // Debounce — a range slider fires 'input' on every pixel; chrome.storage.sync
      // has a per-minute write cap. Update the readout immediately, save throttled.
      $(id).addEventListener('input', () => {
        if (id === 'am-intensity' && $('am-intensity-val')) $('am-intensity-val').textContent = Number($(id).value).toFixed(2);
        if (id === 'am-sample-rate' && $('am-sample-rate-val')) $('am-sample-rate-val').textContent = String($(id).value);
        clearTimeout(cardSaveTimers[id]);
        cardSaveTimers[id] = setTimeout(CARD_SAVE[id], 350);
      });
    }
  });

  if ($('cf-keywords')) {
    $('cf-keywords').addEventListener('change', saveCf);
    $('cf-keywords').addEventListener('input', () => {
      clearTimeout(cardSaveTimers['cf-keywords']);
      cardSaveTimers['cf-keywords'] = setTimeout(saveCf, 600);
    });
  }
  if ($('filter-comment-keywords')) {
    $('filter-comment-keywords').addEventListener('change', saveFilterTabCf);
    $('filter-comment-keywords').addEventListener('input', () => {
      clearTimeout(cardSaveTimers['filter-comment-keywords']);
      cardSaveTimers['filter-comment-keywords'] = setTimeout(saveFilterTabCf, 600);
    });
  }

  // ---- settings profile export/import (no secrets) ----
  const PROFILE_SYNC_KEYS = [
    'modules',
    'ui',
    'sponsorBlock',
    'enabled',
    'watchedMode',
    'watchedDisplay',
    'aiPrompts',
    'mode',
    'keywords',
    'channels',
    'allowedChannels',
    'allowSubscribedChannels',
    'surfaces',
    'communityList',
    'focus',
    'hideSummaries',
    'blockPlayback',
    'respectDisclosure',
    'useRegex',
    'watchedThreshold',
    'dislikeRestore',
    'popoutPlayer',
    'volumeMaster',
    'factCheck',
    'qualityLock',
    'screenshot',
    'titleCleaner',
    'ambientMode',
    'adSkip',
    'commentFilter',
    'shortcuts',
    'skipSeconds',
    'clipCapture',
    'deArrow',
    'tabTitle',
    'chapters',
    'liveNow'
  ];
  const PROFILE_LOCAL_KEYS = [
    'subStore',
    'subActive',
    'plFolderStore',
    'plFolderActive',
    'plFolderPrefs',
    'subNewSeen',
    'subChannelLatest',
    'sbPersonalSegments',
    'statsSections',
    'statsCollapsed',
    'aiPanelOpen',
    'aiPanelWidth',
    'creatorRankTracks',
    'creatorSchedule',
    'creatorThumbnailTests',
    'videoStatsCache'
  ];
  function sanitizeProfileSync(input) {
    input = input && typeof input === 'object' ? input : {};
    const out = {};
    PROFILE_SYNC_KEYS.forEach((key) => {
      if (input[key] !== undefined) out[key] = input[key];
    });
    if (out.modules && typeof out.modules === 'object') {
      const modules = {};
      Object.keys(D.modules || {}).forEach((key) => {
        if (typeof out.modules[key] === 'boolean') modules[key] = out.modules[key];
      });
      out.modules = modules;
    }
    ['keywords', 'channels', 'allowedChannels'].forEach((key) => {
      if (!Array.isArray(out[key])) { if (out[key] !== undefined) delete out[key]; return; }
      out[key] = out[key].slice(0, 500).map((v) => String(v || '').trim().slice(0, 200)).filter(Boolean);
    });
    if (out.aiPrompts !== undefined) {
      out.aiPrompts = Array.isArray(out.aiPrompts) ? out.aiPrompts.slice(0, 50).map((p) => ({
        name: String((p && p.name) || '').slice(0, 80),
        prompt: String((p && p.prompt) || '').slice(0, 5000)
      })).filter((p) => p.name && p.prompt) : D.aiPrompts;
    }
    if (!['hide', 'label', 'dim'].includes(out.mode)) delete out.mode;
    ['enabled', 'allowSubscribedChannels', 'hideSummaries', 'blockPlayback', 'respectDisclosure', 'useRegex'].forEach((key) => {
      if (out[key] !== undefined && typeof out[key] !== 'boolean') delete out[key];
    });
    return out;
  }
  if ($('export-profile')) {
    $('export-profile').addEventListener('click', () => {
      chrome.storage.sync.get(PROFILE_SYNC_KEYS, (sync) => {
        chrome.storage.local.get(PROFILE_LOCAL_KEYS, (loc) => {
          const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            sync,
            local: {
              subStore: loc.subStore,
              subActive: loc.subActive,
              plFolderStore: loc.plFolderStore,
              plFolderActive: loc.plFolderActive,
              plFolderPrefs: loc.plFolderPrefs,
              subNewSeen: loc.subNewSeen,
              subChannelLatest: loc.subChannelLatest,
              sbPersonalSegments: loc.sbPersonalSegments,
              statsSections: loc.statsSections,
              statsCollapsed: loc.statsCollapsed,
              aiPanelOpen: loc.aiPanelOpen,
              aiPanelWidth: loc.aiPanelWidth,
              creatorRankTracks: loc.creatorRankTracks,
              creatorSchedule: loc.creatorSchedule,
              creatorThumbnailTests: loc.creatorThumbnailTests,
              videoStatsCache: loc.videoStatsCache
            }
          };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'unsynth-profile-' + new Date().toISOString().slice(0, 10) + '.json';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          flash($('profile-status'), 'Profile exported.');
        });
      });
    });
  }
  if ($('import-profile')) {
    $('import-profile').addEventListener('click', () => $('import-profile-file').click());
    $('import-profile-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) {
        flash($('profile-status'), 'Profile is too large (5 MB maximum).', false);
        e.target.value = '';
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        try {
          const raw = JSON.parse(String(r.result || ''));
          if (!raw || !raw.sync) throw new Error('invalid');
          const safeSync = sanitizeProfileSync(raw.sync);
          if (!window.UNProfileSanitize) throw new Error('profile sanitizer unavailable');
          const toSet = UNProfileSanitize.sanitizeLocal(raw.local || {});
          chrome.storage.sync.set(safeSync, () => {
            const done = () => {
              flash($('profile-status'), 'Profile imported — reload YouTube tabs.');
              chrome.storage.sync.get({ modules: D.modules, sponsorBlock: D.sponsorBlock, dislikeRestore: D.dislikeRestore, popoutPlayer: D.popoutPlayer, volumeMaster: D.volumeMaster, factCheck: D.factCheck, qualityLock: D.qualityLock, screenshot: D.screenshot, titleCleaner: D.titleCleaner, ambientMode: D.ambientMode, ui: D.ui, watchedDisplay: D.watchedDisplay, watchedMode: 'off', adSkip: D.adSkip, commentFilter: D.commentFilter, shortcuts: D.shortcuts, deArrow: D.deArrow, watchQueue: D.watchQueue, scrollMiniplayer: D.scrollMiniplayer }, (s) => {
                document.querySelectorAll('[data-module]').forEach((el) => {
                  el.checked = (Object.assign({}, D.modules, s.modules))[el.dataset.module] !== false;
                });
                loadSponsorBlock(s.sponsorBlock);
                loadDislikeRestore(s.dislikeRestore);
                loadPopoutPlayer(s.popoutPlayer);
                loadVolumeMaster(s.volumeMaster);
                loadFactCheck(s.factCheck);
                loadQualityLock(s.qualityLock);
                loadScreenshot(s.screenshot);
                loadTitleCleaner(s.titleCleaner);
                loadAmbientMode(s.ambientMode);
                loadAdSkip(s.adSkip);
                loadCommentFilter(s.commentFilter);
                loadDeArrow(s.deArrow);
                loadWatchQueue(s.watchQueue);
                loadScrollMiniplayer(s.scrollMiniplayer);
                renderShortcutsUI(s.shortcuts);
                loadTune(Object.assign({}, D.ui, s.ui));
                if (typeof window.loadWatchedForm === 'function') {
                  window.loadWatchedForm(s.watchedDisplay, s.watchedMode);
                }
                if (typeof renderPlFolders === 'function') renderPlFolders();
                if (typeof renderPlPrefs === 'function') renderPlPrefs();
                refreshFilterSummary();
              });
            };
            if (Object.keys(toSet).length) chrome.storage.local.set(toSet, done);
            else done();
          });
        } catch (err) {
          flash($('profile-status'), 'Invalid profile file.', false);
        }
        e.target.value = '';
      };
      r.readAsText(f);
    });
  }

  function updateModuleCheckboxes(modules) {
    document.querySelectorAll('[data-module]').forEach((el) => {
      el.checked = modules[el.dataset.module] !== false;
    });
  }

  function presetToastMessage(presetId, modules) {
    const preset = window.UNUseCasePresets && UNUseCasePresets.findPreset(presetId);
    const enabledCount = Object.keys(modules || {}).filter((k) => modules[k] === true).length;
    let msg =
      enabledCount +
      ' module' +
      (enabledCount === 1 ? '' : 's') +
      ' enabled';
    if (preset && preset.dashTab && PANEL_TITLES[preset.dashTab]) {
      msg += ' — open ' + PANEL_TITLES[preset.dashTab];
    } else {
      msg += ' — reload YouTube tabs';
    }
    return { msg, dashTab: preset && preset.dashTab };
  }

  function applyUseCasePreset(presetId, msg) {
    const UCP = window.UNUseCasePresets;
    if (!UCP) return Promise.resolve(false);
    const payload = UCP.applyPreset(presetId, D);
    if (!payload) return Promise.resolve(false);
    // Only include `enabled` when the preset actually sets it — writing
    // undefined makes Chrome delete the key, resetting the master switch
    // (same guard as popup.js applyPreset).
    const syncPayload = { modules: payload.modules };
    if (typeof payload.enabled === 'boolean') syncPayload.enabled = payload.enabled;
    const statusEl = () => $('use-case-status') || $('modules-status');
    const toast = presetToastMessage(presetId, payload.modules);
    // Routed through UNStore (shared/storage.js) instead of raw chrome.storage
    // callbacks — those never checked chrome.runtime.lastError, so a failed
    // write (e.g. hitting the sync quota) still flashed "Preset applied" and
    // reloaded YouTube tabs as if it had actually saved.
    return (async () => {
      try {
        if (payload.statsSections) await UNStore.setLocal('statsSections', payload.statsSections);
        await UNStore.setSyncAll(syncPayload);
        await UNStore.setLocalAll({ needsTabReload: true, useCasePreset: presetId });
        updateModuleCheckboxes(payload.modules);
        refreshDashModuleCounts();
        flash(statusEl(), msg || toast.msg);
        refreshFilterSummary();
        if (!msg && toast.dashTab && VALID_TABS.includes(toast.dashTab)) {
          setTimeout(() => activateTab(toast.dashTab), 700);
        }
        return true;
      } catch (e) {
        flash(statusEl(), 'Could not save preset (' + ((e && e.message) || 'storage error') + '). Try again.', false);
        return false;
      }
    })();
  }

  function renderUseCaseCards(containerId, opts) {
    const UCP = window.UNUseCasePresets;
    const box = $(containerId);
    if (!box || !UCP) return;
    box.textContent = '';
    let selected = opts && opts.defaultId ? opts.defaultId : DEFAULT_PRESET;
    chrome.storage.local.get({ useCasePreset: DEFAULT_PRESET }, (d) => {
      if (d.useCasePreset) selected = d.useCasePreset;
      UCP.PRESETS.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'use-case-card' + (p.id === selected ? ' on' : '');
        btn.innerHTML = '<b>' + p.label + '</b><span>' + p.desc + '</span>';
        btn.addEventListener('click', () => {
          selected = p.id;
          box.querySelectorAll('.use-case-card').forEach((c) => c.classList.toggle('on', c === btn));
          applyUseCasePreset(p.id);
          if (opts && opts.onSelect) opts.onSelect(p.id);
        });
        box.appendChild(btn);
      });
      if (opts && opts.onSelect) opts.onSelect(selected);
    });
  }

  function finishOneClickSetup(presetId) {
    const id = presetId || DEFAULT_PRESET;
    // Only reload YouTube tabs / mark onboarding done once the preset actually
    // saved — previously this ran unconditionally, so a silently-failed write
    // still ended with "You're set" and a reload into unsaved settings.
    applyUseCasePreset(id, null).then((ok) => {
      if (!ok) {
        flash($('modules-status'), 'Setup didn’t finish — fix the error above, then click “Finish setup” again.', false);
        return;
      }
      send(UNMSG.RELOAD_YOUTUBE_TABS).then(() => {
        chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] }, (tabs) => {
          if (!tabs || !tabs.length) chrome.tabs.create({ url: 'https://www.youtube.com/' });
        });
        UNStore.setLocalAll({ onboardingDone: true, setupYoutubeReloaded: true, useCasePreset: id })
          .then(() => {
            if ($('onboard')) $('onboard').setAttribute('hidden', '');
            flash($('modules-status'), 'You’re set — browse YouTube.');
            if (typeof refreshSetupChecklist === 'function') refreshSetupChecklist();
          })
          .catch(() => {
            // Tabs already reloaded with the real settings — don't block the
            // user over this bookkeeping write; onboarding may just reappear.
            flash($('modules-status'), 'You’re set — browse YouTube.', true);
          });
      });
    });
  }

  renderUseCaseCards('use-case-grid');

  // ---- first-run onboarding ----
  let onboardPreset = DEFAULT_PRESET;
  chrome.storage.local.get({ onboardingDone: false }, (d) => {
    const ob = $('onboard');
    if (ob && !d.onboardingDone) {
      ob.removeAttribute('hidden');
      // Move focus into the dialog and trap Tab within it; Esc dismisses.
      const focusables = ob.querySelectorAll('button, a[href], input, select, [tabindex]:not([tabindex="-1"])');
      if (focusables.length) focusables[0].focus();
      ob.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          chrome.storage.local.set({ onboardingDone: true });
          ob.setAttribute('hidden', '');
          return;
        }
        if (e.key !== 'Tab') return;
        const f = ob.querySelectorAll('button, a[href], input, select, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    }
  });
  renderUseCaseCards('onboard-use-cases', {
    defaultId: DEFAULT_PRESET,
    onSelect: (id) => {
      onboardPreset = id;
    }
  });
  if ($('onboard-done')) {
    $('onboard-done').addEventListener('click', () => {
      chrome.storage.local.set({ onboardingDone: true });
      if ($('onboard')) $('onboard').setAttribute('hidden', '');
    });
  }
  if ($('onboard-oneclick')) {
    $('onboard-oneclick').addEventListener('click', () => finishOneClickSetup(onboardPreset));
  }

  function gatherModules() {
    const modules = {};
    document.querySelectorAll('[data-module]').forEach((el) => {
      modules[el.dataset.module] = el.checked;
    });
    if (window.UNModules) return UNModules.normalizeModules(modules, D);
    return modules;
  }

  function saveModulesNow(msg) {
    const modules = gatherModules();
    const sponsorBlock = gatherSponsorBlock();
    const payload = { modules, sponsorBlock, enabled: modules.aiFilter !== false };
    chrome.storage.sync.set(payload, () => {
      chrome.storage.local.set({ needsTabReload: true });
      const note = msg || 'Saved.';
      flash($('modules-status'), note + ' Reload open YouTube tabs to apply module changes.');
      refreshFilterSummary();
      refreshActiveFilters();
    });
  }

  document.querySelectorAll('[data-module]').forEach((el) => {
    el.addEventListener('change', () => {
      // The same module can have a checkbox on more than one panel (the four
      // playlist modules appear under both Modules and Playlists). Mirror the
      // new value onto every other copy BEFORE saving: gatherModules() walks
      // all [data-module] nodes and last-one-wins, so without this the stale
      // twin would overwrite the box the user just clicked and the toggle would
      // appear to snap back.
      document.querySelectorAll('[data-module="' + el.dataset.module + '"]').forEach((twin) => {
        if (twin !== el) twin.checked = el.checked;
      });
      refreshDashModuleCounts();
      saveModulesNow('Saved.');
    });
  });
  document.querySelectorAll('#sb-autoskip, #sb-use-community, #sb-use-personal, #sb-community-direct, #sb-hide-chapters').forEach((el) => {
    el.addEventListener('change', () => saveModulesNow('SponsorBlock saved.'));
  });
  // Category mode <select>s are built dynamically; delegate so new rows are covered.
  const sbModesHost = document.getElementById('sb-category-modes');
  if (sbModesHost) sbModesHost.addEventListener('change', () => saveModulesNow('SponsorBlock saved.'));


// ---- Watched history: Takeout import + display mode ----
(function () {
  const $ = (id) => document.getElementById(id);
  const WS = window.UNWatchStats;
  const D = window.UNSYNTH_DEFAULTS;
  const WD = window.UNWatchedDisplay;
  if (!$('watched-display')) return;

  function setCount() {
    chrome.storage.local.get('watchedVideos', (d) => {
      $('watched-count').textContent = (((d && d.watchedVideos) || []).length).toLocaleString();
    });
    invalidateTrackedVideos();
  }

  // ---- Tracked-videos list (thumbnail + link only — no titles are stored) ----
  const TRACKED_PAGE_SIZE = 30;
  let trackedVideosData = null; // { full: [id...] (newest first), partial: [{id,pct}...] (newest first) }
  let trackedVideosShown = 0;

  function thumbUrlForTracked(id) {
    return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
  }

  // Display-only title/channel lookup via YouTube's public oEmbed endpoint.
  // Never persisted — storage keeps just the id, per the privacy note this
  // section ships with. In-memory cache only, so it re-fetches once per
  // dashboard load, not on every re-render.
  const trackedVideoMetaCache = new Map(); // id -> { title, author } | 'failed'
  function oembedUrlForTracked(id) {
    return 'https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json';
  }
  async function fetchTrackedVideoMeta(id) {
    if (trackedVideoMetaCache.has(id)) return trackedVideoMetaCache.get(id);
    try {
      const res = await fetch(oembedUrlForTracked(id));
      if (!res.ok) throw new Error('oembed_' + res.status);
      const data = await res.json();
      const meta = { title: (data && data.title) || null, author: (data && data.author_name) || null };
      trackedVideoMetaCache.set(id, meta);
      return meta;
    } catch (e) {
      trackedVideoMetaCache.set(id, 'failed');
      return 'failed';
    }
  }

  function loadTrackedVideos(cb) {
    chrome.storage.local.get(['watchedVideos', 'watchProgress'], (d) => {
      const full = ((d && d.watchedVideos) || []).slice().reverse();
      const fullSet = new Set(full);
      const progress = (d && d.watchProgress) || {};
      const partial = Object.keys(progress)
        .filter((id) => !fullSet.has(id))
        .reverse()
        .map((id) => ({ id, pct: progress[id] }));
      trackedVideosData = { full, partial };
      cb && cb();
    });
  }

  function unmarkTrackedVideo(id) {
    chrome.storage.local.get(['watchedVideos', 'watchProgress', 'watchedDates'], (d) => {
      const nextWatched = ((d && d.watchedVideos) || []).filter((v) => v !== id);
      const nextProgress = Object.assign({}, (d && d.watchProgress) || {});
      delete nextProgress[id];
      // Drop the date too. Leaving it behind orphans a timestamp for a video
      // that is no longer watched, which then reappears as a stale date if the
      // video is ever re-marked.
      const nextDates = Object.assign({}, (d && d.watchedDates) || {});
      delete nextDates[id];
      chrome.storage.local.set({ watchedVideos: nextWatched, watchProgress: nextProgress, watchedDates: nextDates }, () => {
        setCount();
        refreshLiveCard();
      });
    });
  }

  function trackedVideoRow(id, statusText) {
    const row = document.createElement('div');
    row.className = 'watch-queue-row';
    const img = document.createElement('img');
    img.className = 'watch-queue-thumb';
    img.src = thumbUrlForTracked(id);
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
    row.appendChild(img);
    const meta = document.createElement('div');
    meta.className = 'watch-queue-meta';
    const link = document.createElement('a');
    link.className = 'watch-queue-title';
    link.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = id;
    link.title = id;
    meta.appendChild(link);
    const sub = document.createElement('div');
    sub.className = 'watch-queue-sub';
    sub.textContent = statusText;
    meta.appendChild(sub);
    row.appendChild(meta);
    fetchTrackedVideoMeta(id).then((info) => {
      if (!row.isConnected || info === 'failed' || !info.title) return;
      link.textContent = info.title;
      if (info.author) sub.textContent = info.author + ' · ' + statusText;
    });
    const acts = document.createElement('div');
    acts.className = 'watch-queue-acts';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ghost-btn sm';
    rm.textContent = 'Unmark';
    rm.title = 'Remove from watched history';
    rm.addEventListener('click', () => unmarkTrackedVideo(id));
    acts.appendChild(rm);
    row.appendChild(acts);
    return row;
  }

  function renderTrackedVideos(reset) {
    const list = $('tracked-videos-list');
    if (!list) return;
    if (reset || !trackedVideosData) {
      trackedVideosShown = 0;
      loadTrackedVideos(() => renderTrackedVideos(false));
      return;
    }
    list.textContent = '';
    const combined = trackedVideosData.full
      .map((id) => ({ id, full: true, pct: 100 }))
      .concat(trackedVideosData.partial.map((p) => ({ id: p.id, full: false, pct: p.pct })));
    const bar = $('tracked-videos-loadmore-bar');
    const hint = $('tracked-videos-count-hint');
    if (!combined.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Nothing tracked yet.';
      list.appendChild(empty);
      if (bar) bar.hidden = true;
      return;
    }
    trackedVideosShown = Math.min(combined.length, trackedVideosShown || TRACKED_PAGE_SIZE);
    combined.slice(0, trackedVideosShown).forEach((v) => {
      list.appendChild(trackedVideoRow(v.id, v.full ? 'Watched' : v.pct + '% watched'));
    });
    if (bar) bar.hidden = trackedVideosShown >= combined.length;
    if (hint) hint.textContent = trackedVideosShown.toLocaleString() + ' of ' + combined.length.toLocaleString() + ' shown';
  }

  // Called whenever watchedVideos/watchProgress changes elsewhere (import,
  // clear, live tracking). Re-renders immediately if the list is open;
  // otherwise just drops the cache so the next expand fetches fresh data.
  function invalidateTrackedVideos() {
    trackedVideosData = null;
    const details = $('tracked-videos-details');
    if (details && details.open) renderTrackedVideos(true);
  }

  if ($('tracked-videos-details')) {
    $('tracked-videos-details').addEventListener('toggle', function () {
      if (this.open && !trackedVideosData) renderTrackedVideos(true);
    });
  }
  if ($('tracked-videos-loadmore')) {
    $('tracked-videos-loadmore').addEventListener('click', () => {
      trackedVideosShown += TRACKED_PAGE_SIZE;
      renderTrackedVideos(false);
    });
  }

  function refreshLiveCard() {
    chrome.storage.local.get(['watchStats', 'watchedVideos'], (d) => {
      const w = (d && d.watchStats) || null;
      const watchedN = ((d && d.watchedVideos) || []).length;
      const distinct = WS.effectiveUniqueVideos(w, watchedN);
      const br = WS.playBreakdown(w);
      const today = WS.todayKey();
      const todayN = br.today;
      const badge = $('live-source-badge');
      const src = WS.sourceLabel(w);
      if (badge) {
        badge.textContent = src === 'live' ? 'Live' : src === 'merged' ? 'Merged' : src === 'imported' ? 'Imported' : 'No data';
        badge.className = 'live-badge live-' + src;
      }
      const track = $('live-tracking-on');
      if (track) {
        chrome.storage.sync.get({ modules: D.modules }, (s) => {
          const mods = window.UNModules ? UNModules.normalizeModules(s.modules, D) : Object.assign({}, D.modules, s.modules);
          const on = mods.watchHistory !== false;
          let line = on ? 'Live tracking: on · ' + todayN.toLocaleString() + ' plays today' : 'Live tracking: off';
          if (on && w && src === 'merged' && br.live > 0) {
            line += ' · ' + br.live.toLocaleString() + ' live since import';
          }
          track.textContent = line;
          track.classList.toggle('is-off', !on);
        });
      }
      if ($('live-today')) $('live-today').textContent = todayN.toLocaleString();
      if ($('live-total')) $('live-total').textContent = (w ? br.total : 0).toLocaleString();
      if ($('live-distinct')) $('live-distinct').textContent = distinct.toLocaleString();
      if ($('live-last')) $('live-last').textContent = (w && w.lastDate) || '—';
      const sync = $('live-sync-line');
      if (sync) {
        if (w && w.lastLiveUpdate) {
          let line = 'Last live update: ' + new Date(w.lastLiveUpdate).toLocaleString();
          if (src === 'merged' && br.imported > 0) {
            line += ' · ' + br.imported.toLocaleString() + ' plays from import';
          }
          sync.textContent = line;
        } else if (w && w.importedAt) {
          sync.textContent = 'Imported: ' + w.importedAt + ' · ' + br.total.toLocaleString() + ' plays in history';
        } else sync.textContent = 'Watch a video past 75% on a fresh YouTube tab to start live tracking.';
      }
      const brEl = $('live-breakdown');
      if (brEl && w) {
        if (src === 'merged' && br.imported > 0 && br.live > 0) {
          brEl.textContent =
            br.imported.toLocaleString() + ' imported plays · ' + br.live.toLocaleString() + ' tracked live · ' + distinct.toLocaleString() + ' distinct videos marked';
          brEl.hidden = false;
        } else if (src === 'live') {
          brEl.textContent = br.total.toLocaleString() + ' plays · ' + distinct.toLocaleString() + ' distinct videos marked';
          brEl.hidden = false;
        } else if (src === 'imported') {
          brEl.textContent = br.total.toLocaleString() + ' imported plays · ' + distinct.toLocaleString() + ' distinct videos';
          brEl.hidden = false;
        } else brEl.hidden = true;
      } else if (brEl) brEl.hidden = true;
    });
  }

  function refreshTabReloadBanner() {
    chrome.runtime.sendMessage({ type: UNMSG.TAB_RELOAD_STATUS }, (r) => {
      if (chrome.runtime.lastError) return;
      const banner = $('tab-reload-banner');
      if (!banner) return;
      banner.style.display = r && r.needsTabReload ? '' : 'none';
    });
  }

  if ($('reload-yt-tabs')) {
    $('reload-yt-tabs').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: UNMSG.RELOAD_YOUTUBE_TABS }, (r) => {
        if (r && r.ok) refreshTabReloadBanner();
      });
    });
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && (ch.watchStats || ch.watchedVideos || ch.watchProgress)) {
      refreshLiveCard();
      setCount();
    }
    if (area === 'sync' && ch.modules) refreshLiveCard();
    if (area === 'sync' && (ch.watchedDisplay || ch.watchedMode) && typeof window.loadWatchedForm === 'function') {
      const wd = ch.watchedDisplay ? ch.watchedDisplay.newValue : undefined;
      const mode = ch.watchedMode ? ch.watchedMode.newValue : undefined;
      chrome.storage.sync.get({ watchedDisplay: D.watchedDisplay, watchedMode: 'off' }, (s) => {
        window.loadWatchedForm(wd != null ? wd : s.watchedDisplay, mode != null ? mode : s.watchedMode);
      });
    }
  });

  const wt = document.querySelector('.tab[data-tab="watched"]');
  if (wt) {
    wt.addEventListener('click', () => {
      setCount();
      refreshLiveCard();
      refreshTabReloadBanner();
    });
  }
  refreshLiveCard();
  refreshTabReloadBanner();

  const Drill = window.UNDrill;
  function topDays(byDate, n) {
    if (!byDate) return [];
    return Object.keys(byDate)
      .map((k) => [k, byDate[k]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }
  function openLiveDrill(kind) {
    if (!Drill) return;
    chrome.storage.local.get(['watchStats', 'watchedVideos', 'watchProgress'], (d) => {
      const w = (d && d.watchStats) || null;
      const today = WS.todayKey();
      const nodes = [];
      if (kind === 'today') {
        const n = w && w.byDate ? w.byDate[today] || 0 : 0;
        nodes.push(Drill.row('Date', today), Drill.row('Plays today', n.toLocaleString()));
        nodes.push(Drill.para('Each finish past 75% on a video counts once per session toward today.'));
        const top = topDays(w && w.byDate, 7);
        if (top.length) nodes.push(Drill.list(top.map(([day, c]) => day + ': ' + c + ' plays')));
      } else if (kind === 'total') {
        const watchedN = ((d && d.watchedVideos) || []).length;
        const distinct = WS.effectiveUniqueVideos(w, watchedN);
        const br = WS.playBreakdown(w);
        nodes.push(Drill.row('Total plays', br.total.toLocaleString()));
        nodes.push(Drill.row('Distinct videos marked', distinct.toLocaleString()));
        if (br.imported > 0 && br.live > 0) {
          nodes.push(Drill.row('From import', br.imported.toLocaleString()));
          nodes.push(Drill.row('Tracked live', br.live.toLocaleString()));
        }
        if (br.total && distinct) {
          const replays = br.total - distinct;
          if (replays > 0) nodes.push(Drill.row('Replays', replays.toLocaleString()));
        }
        nodes.push(Drill.para('Plays = each finish past 75% (or Takeout row). Distinct = videos in your marked-watched list. Clicking a badge to mark watched adds to distinct only — not play count.'));
      } else if (kind === 'distinct') {
        const watchedN = ((d && d.watchedVideos) || []).length;
        const distinct = WS.effectiveUniqueVideos(w, watchedN);
        const br = WS.playBreakdown(w);
        nodes.push(Drill.row('Distinct videos marked', distinct.toLocaleString()));
        nodes.push(Drill.row('Total plays', br.total.toLocaleString()));
        nodes.push(Drill.para('Distinct matches the “videos marked watched” count — each video ID counted once. Manual marks add to distinct, not plays.'));
      } else if (kind === 'last') {
        nodes.push(Drill.row('Last active day', (w && w.lastDate) || '—'));
        if (w && w.firstDate) nodes.push(Drill.row('First day', w.firstDate));
        if (w && w.lastLiveUpdate) nodes.push(Drill.row('Last live update', new Date(w.lastLiveUpdate).toLocaleString()));
        else if (w && w.importedAt) nodes.push(Drill.row('Imported', w.importedAt));
      }
      Drill.open(kind === 'today' ? 'Today' : kind === 'total' ? 'Total plays' : kind === 'distinct' ? 'Distinct videos' : 'Last active', nodes);
    });
  }
  if (Drill) {
    document.querySelectorAll('[data-live-drill]').forEach((cell) => {
      Drill.clickable(cell, () => openLiveDrill(cell.getAttribute('data-live-drill')));
    });
    const wc = $('watched-count');
    if (wc) {
      Drill.clickable(wc, () => {
        chrome.storage.local.get(['watchedVideos', 'watchProgress'], (d) => {
          const watched = (d && d.watchedVideos) || [];
          const progress = (d && d.watchProgress) || {};
          const partial = Object.keys(progress).filter((k) => watched.indexOf(k) === -1 && progress[k] > 0);
          const nodes = [
            Drill.row('Fully watched (75%+)', watched.length.toLocaleString()),
            Drill.row('In progress', partial.length.toLocaleString()),
            Drill.para('Red ✓ badges mark finished videos; amber % shows partial progress on feeds.')
          ];
          if (partial.length) {
            const top = partial
              .map((k) => [k, progress[k]])
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([id, pct]) => id.slice(0, 11) + '… ' + pct + '%');
            nodes.push(Drill.list(top));
          }
          Drill.open('Marked watched', nodes);
        });
      });
    }
    const srcBadge = $('live-source-badge');
    if (srcBadge) {
      srcBadge.classList.add('clickable');
      Drill.clickable(srcBadge, () => {
        chrome.storage.local.get('watchStats', (d) => {
          const w = (d && d.watchStats) || null;
          const src = WS.sourceLabel(w);
          const nodes = [
            Drill.row('Source', src === 'live' ? 'Live tracking' : src === 'merged' ? 'Merged' : src === 'imported' ? 'Takeout import' : 'No data'),
            Drill.para(
              src === 'live'
                ? 'Stats are growing as you watch on YouTube with Unsynth enabled.'
                : src === 'merged'
                  ? 'Takeout history merged with live plays since import.'
                  : src === 'imported'
                    ? 'From Google Takeout — watch videos to add live data on top.'
                    : 'Import Takeout or watch past 75% to start collecting stats.'
            )
          ];
          if (w && w.importedAt) nodes.push(Drill.row('Imported', w.importedAt));
          if (w && w.lastLiveUpdate) nodes.push(Drill.row('Last live update', new Date(w.lastLiveUpdate).toLocaleString()));
          Drill.open('Stats source', nodes);
        });
      });
    }
  }

  function hi(mode) {
    document.querySelectorAll('#watched-presets .preset').forEach((b) => b.classList.toggle('on', b.dataset.preset === mode));
  }

  function loadWatchedForm(wd, legacyMode) {
    const w = WD.normalize(wd, legacyMode);
    if ($('wd-badges')) $('wd-badges').checked = w.badges;
    if ($('wd-finished')) $('wd-finished').value = w.finished;
    if ($('wd-filter')) $('wd-filter').value = w.feedFilter;
    if ($('wd-hide-partial')) $('wd-hide-partial').checked = w.hidePartial;
    updateWatchedPreview(w);
    hi(WD.toLegacyMode(w));
  }
  // Expose for profile-import refresh (import callback lives outside this IIFE).
  window.loadWatchedForm = loadWatchedForm;
  function gatherWatchedForm() {
    return {
      badges: $('wd-badges').checked,
      finished: $('wd-finished').value,
      feedFilter: $('wd-filter').value,
      hidePartial: $('wd-hide-partial').checked
    };
  }
  function updateWatchedPreview(w) {
    const el = $('wd-preview');
    if (!el) return;
    const parts = [];
    if (w.badges) parts.push('badges on');
    if (w.finished === 'dim') parts.push('dim finished');
    else if (w.finished === 'hide') parts.push('hide finished');
    if (w.feedFilter === 'only-watched') parts.push('only watched');
    else if (w.feedFilter === 'only-unseen') parts.push('only never-started');
    if (w.hidePartial) parts.push('hide in-progress');
    el.textContent = parts.length ? 'Active: ' + parts.join(' · ') + (w.badges && w.finished === 'hide' ? ' (badges only on visible tiles)' : '') : 'No visual changes — same as Show all without badges.';
  }
  let wdSaveTimer = null;
  function scheduleWatchedSave() {
    if (wdSaveTimer) clearTimeout(wdSaveTimer);
    wdSaveTimer = setTimeout(() => saveWatchedDisplay(), 350);
  }
  function saveWatchedDisplay(then) {
    const wd = gatherWatchedForm();
    const legacy = WD.toLegacyMode(wd);
    chrome.storage.sync.set({ watchedDisplay: wd, watchedMode: legacy }, () => {
      loadWatchedForm(wd, legacy);
      flash($('watched-display-status'), 'Saved.');
      if (then) then();
    });
  }

  if ($('watched-presets')) {
    WD.PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.dataset.preset = p.id;
      b.textContent = p.label;
      b.title = p.desc;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        const wd = WD.preset(p.id);
        loadWatchedForm(wd, p.id);
        saveWatchedDisplay();
      });
      $('watched-presets').appendChild(b);
    });
  }
  ['wd-badges', 'wd-finished', 'wd-filter', 'wd-hide-partial'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      updateWatchedPreview(gatherWatchedForm());
      document.querySelectorAll('#watched-presets .preset').forEach((b) => b.classList.remove('on'));
      scheduleWatchedSave();
    });
  });
  chrome.storage.sync.get({ watchedDisplay: D.watchedDisplay, watchedMode: 'off' }, (s) => {
    loadWatchedForm(s.watchedDisplay, s.watchedMode);
  });
  setCount();
  // ---- parse helpers ----
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const fmtDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function decodeEntities(s) {
    return s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&emsp;/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<');
  }

  // Accept multiple export formats: Watchmarker (.database, base64 JSON of
  // {strIdent, progress?}), raw Watchmarker JSON, and Google Takeout.
  function parseWatchmarkerEntry(e) {
    const id = e && (e.strIdent || e.videoId || e.id);
    if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return null;
    let pct = null;
    if (typeof e.percent === 'number') pct = Math.round(e.percent);
    else if (typeof e.progress === 'number') pct = e.progress <= 1 ? Math.round(e.progress * 100) : Math.round(e.progress);
    else if (typeof e.durationWatched === 'number' && typeof e.totalDuration === 'number' && e.totalDuration > 0)
      pct = Math.round((e.durationWatched / e.totalDuration) * 100);
    else if (e.watched === true || e.finished === true) pct = 100;
    return { id, pct };
  }

  function extractWatchImport(text) {
    const ids = new Set();
    const progress = {};
    const MIN_PARTIAL = 5;
    const addFromArray = (arr) => {
      if (!Array.isArray(arr)) return false;
      let n = 0;
      arr.forEach((e) => {
        const parsed = parseWatchmarkerEntry(e);
        if (!parsed) return;
        if (parsed.pct == null || parsed.pct >= 75) ids.add(parsed.id);
        else if (parsed.pct >= MIN_PARTIAL) progress[parsed.id] = Math.max(progress[parsed.id] || 0, parsed.pct);
        n++;
      });
      return n > 0;
    };
    const t = text.trim();
    if (/^[A-Za-z0-9+/=\s]+$/.test(t.slice(0, 80))) {
      try {
        addFromArray(JSON.parse(atob(t.replace(/\s+/g, ''))));
      } catch (e) {
        /* not base64 json */
      }
    }
    if (!ids.size && !Object.keys(progress).length) {
      try {
        addFromArray(JSON.parse(t));
      } catch (e) {
        /* not json */
      }
    }
    const re = /watch\?v=([\w-]{11})/g;
    let m;
    while ((m = re.exec(text))) ids.add(m[1]);
    return { ids, progress };
  }

  function extractWatchedIds(text) {
    return extractWatchImport(text).ids;
  }

  // Rich Google Takeout parse: walks every activity cell and builds aggregate
  // stats (channels, hour/day/date/month histograms, streaks). Returns
  // { kind:'watch', ids, stats } for watch-history, { kind:'search', searchStats }
  // for search-history, or null when it isn't Takeout HTML/JSON.
  function parseTakeoutJsonTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function finishWatchTakeout(ids, chPlays, chId, chVids, byHour, byDow, byDate, byMonth, total, removed, minD, maxD, importVideoDays) {
    const dayNum = (ds) => {
      const p = ds.split('-');
      return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
    };
    const dayKeys = Object.keys(byDate).sort();
    const daySet = new Set(dayKeys.map(dayNum));
    let run = 0;
    let best = 0;
    let prevN = null;
    dayKeys.forEach((ds) => {
      const n = dayNum(ds);
      run = prevN != null && n - prevN === 1 ? run + 1 : 1;
      if (run > best) best = run;
      prevN = n;
    });
    let cur = 0;
    if (maxD) {
      let n = dayNum(fmtDay(maxD));
      while (daySet.has(n)) {
        cur++;
        n--;
      }
    }
    const busiest = Object.entries(byDate).sort((a, b) => b[1] - a[1])[0] || null;
    const channelMap = Object.create(null);
    const channelVideos = Object.create(null);
    Object.keys(chPlays).forEach((nm) => {
      channelMap[nm] = [chVids[nm] ? chVids[nm].size : 0, chPlays[nm], chId[nm] || ''];
      if (chVids[nm]) {
        const bucket = Object.create(null);
        chVids[nm].forEach((vid) => {
          bucket[vid] = 1;
        });
        channelVideos[nm] = bucket;
      }
    });
    // Use the shared ranker so the import and every later recompute agree on the
    // limit. Hard-coding 30 here meant a Takeout import discarded thousands of
    // channels at parse time — before watch-stats.js ever saw them.
    const topChannels = window.UNWatchStats
      ? UNWatchStats.topChannelsFromMap(channelMap)
      : Object.keys(channelMap)
          .map((nm) => [nm, channelMap[nm][0], channelMap[nm][1], channelMap[nm][2]])
          .sort((a, b) => b[1] - a[1] || b[2] - a[2])
          .slice(0, 1000);
    return {
      kind: 'watch',
      ids,
      stats: {
        version: 2,
        importedAt: fmtDay(new Date()),
        total,
        uniqueVideos: ids.size,
        uniqueChannels: Object.keys(chPlays).length,
        removed,
        firstDate: minD ? fmtDay(minD) : null,
        lastDate: maxD ? fmtDay(maxD) : null,
        activeDays: dayKeys.length,
        longestStreak: best,
        currentStreak: cur,
        busiestDay: busiest ? { date: busiest[0], count: busiest[1] } : null,
        byHour,
        byDow,
        byMonth,
        byDate,
        topChannels,
        channelMap,
        channelVideos,
        importVideoDays: importVideoDays || {}
      }
    };
  }

  const SEARCH_STOP = new Set(
    'the a an of to in on and or for is it my me you your with how what why who when vs de la le el del los las una uno that this from at by as'.split(' ')
  );

  function parseSearchJson(data) {
    const terms = Object.create(null);
    let total = 0;
    data.forEach((entry) => {
      const blob = entry.snippet || entry;
      const title = String((blob && blob.title) || '');
      const m = title.match(/^Searched for\s+(.+)/i);
      if (!m) return;
      total++;
      const t = m[1].trim().toLowerCase();
      if (t) terms[t] = (terms[t] || 0) + 1;
    });
    const words = Object.create(null);
    Object.keys(terms).forEach((t) => {
      const c = terms[t];
      t.split(/[^a-z0-9']+/).forEach((w) => {
        if (w.length < 3 || SEARCH_STOP.has(w)) return;
        words[w] = (words[w] || 0) + c;
      });
    });
    return {
      version: 1,
      total,
      uniqueTerms: Object.keys(terms).length,
      topTerms: Object.entries(terms)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40),
      topWords: Object.entries(words)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 60)
    };
  }

  function analyzeTakeoutJson(text) {
    let data;
    try {
      data = JSON.parse(text.trim());
    } catch (e) {
      return null;
    }
    if (!Array.isArray(data) || !data.length) return null;

    let watchCount = 0;
    let searchCount = 0;
    data.forEach((entry) => {
      const blob = entry.snippet || entry;
      const title = String((blob && blob.title) || '');
      if (/^Watched/i.test(title) || /youtube\.com\/watch/i.test(title)) watchCount++;
      if (/^Searched for/i.test(title)) searchCount++;
    });
    if (searchCount > watchCount) return { kind: 'search', searchStats: parseSearchJson(data) };
    if (!watchCount) return null;

    const ids = new Set();
    const chPlays = Object.create(null);
    const chId = Object.create(null);
    const chVids = Object.create(null);
    const byHour = new Array(24).fill(0);
    const byDow = new Array(7).fill(0);
    const byDate = Object.create(null);
    const byMonth = Object.create(null);
    const importVideoDays = Object.create(null);
    let total = 0;
    let removed = 0;
    let minD = null;
    let maxD = null;
    const reVid = /[?&]v=([\w-]{11})/;

    data.forEach((entry) => {
      const blob = entry.snippet || entry;
      const title = String((blob && blob.title) || '');
      const url = String((blob && blob.titleUrl) || title);
      if (!/^Watched/i.test(title) && !/youtube\.com\/watch/i.test(url)) return;
      total++;
      const mv = url.match(reVid);
      const vid = mv ? mv[1] : null;
      if (vid) ids.add(vid);
      if (/has been removed/i.test(title)) removed++;
      const subs = (blob && blob.subtitles) || entry.subtitles || [];
      if (Array.isArray(subs) && subs[0] && subs[0].name) {
        const nm = String(subs[0].name).trim();
        const cu = subs[0].url || '';
        const cm = String(cu).match(/\/channel\/([^/?#]+)/);
        if (nm) {
          chPlays[nm] = (chPlays[nm] || 0) + 1;
          if (cm) chId[nm] = cm[1];
          if (vid) (chVids[nm] || (chVids[nm] = new Set())).add(vid);
        }
      }
      const d = parseTakeoutJsonTime((blob && blob.time) || entry.time);
      if (d) {
        byHour[d.getHours()]++;
        byDow[d.getDay()]++;
        const ds = fmtDay(d);
        byDate[ds] = (byDate[ds] || 0) + 1;
        byMonth[ds.slice(0, 7)] = (byMonth[ds.slice(0, 7)] || 0) + 1;
        if (vid) (importVideoDays[ds] || (importVideoDays[ds] = {}))[vid] = 1;
        if (!minD || d < minD) minD = d;
        if (!maxD || d > maxD) maxD = d;
      }
    });

    if (!ids.size && !total) return null;
    return finishWatchTakeout(ids, chPlays, chId, chVids, byHour, byDow, byDate, byMonth, total, removed, minD, maxD, importVideoDays);
  }

  function analyzeTakeout(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) {
      const json = analyzeTakeoutJson(text);
      if (json) return json;
    }
    if (text.indexOf('outer-cell') === -1) return null;
    // Decide watch vs search by DOMINANCE, not mere presence: search-history.html
    // carries a few stray "Watched" rows, and the separator after "Watched" is a
    // non-breaking space (so match '>Watched' without a trailing space).
    const watchCount = text.split('>Watched').length - 1;
    const searchCount = text.split('Searched for').length - 1;
    if (searchCount > watchCount) return { kind: 'search', searchStats: parseSearch(text) };
    if (!watchCount) return null;

    const cells = text.split('outer-cell');
    const ids = new Set();
    const chPlays = Object.create(null);
    const chId = Object.create(null);
    const chVids = Object.create(null); // channel -> Set of distinct videoIds
    const byHour = new Array(24).fill(0);
    const byDow = new Array(7).fill(0);
    const byDate = Object.create(null);
    const byMonth = Object.create(null);
    const importVideoDays = Object.create(null);
    let total = 0;
    let removed = 0;
    let minD = null;
    let maxD = null;
    const reVid = /watch\?v=([\w-]{11})/;
    const reChan = /youtube\.com\/channel\/([^"]+)">([^<]+)<\/a>/;
    const reDate = /([A-Z][a-z]{2}) (\d{1,2}), (20\d\d), (\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM)/;

    for (let k = 1; k < cells.length; k++) {
      const c = cells[k];
      if (c.indexOf('>Watched') === -1 && c.indexOf('Watched a video') === -1) continue;
      total++;
      const mv = c.match(reVid);
      const vid = mv ? mv[1] : null;
      if (vid) ids.add(vid);
      if (c.indexOf('has been removed') !== -1) removed++;
      const mc = c.match(reChan);
      if (mc) {
        const cid = mc[1];
        const nm = decodeEntities(mc[2]).trim();
        if (nm) {
          chPlays[nm] = (chPlays[nm] || 0) + 1;
          chId[nm] = cid;
          if (vid) (chVids[nm] || (chVids[nm] = new Set())).add(vid);
        }
      }
      const md = c.match(reDate);
      if (md) {
        const mo = MON[md[1]];
        if (mo == null) continue;
        let hr = +md[4] % 12;
        if (md[7] === 'PM') hr += 12;
        const day = +md[2];
        const yr = +md[3];
        const d = new Date(yr, mo, day);
        byHour[hr]++;
        byDow[d.getDay()]++;
        const ds = fmtDay(d);
        byDate[ds] = (byDate[ds] || 0) + 1;
        const ms = ds.slice(0, 7);
        byMonth[ms] = (byMonth[ms] || 0) + 1;
        if (vid) (importVideoDays[ds] || (importVideoDays[ds] = {}))[vid] = 1;
        if (!minD || d < minD) minD = d;
        if (!maxD || d > maxD) maxD = d;
      }
    }

    // Work in UTC day-indices so DST shifts never break adjacency math.
    const dayNum = (ds) => {
      const p = ds.split('-');
      return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
    };
    const dayKeys = Object.keys(byDate).sort();
    const daySet = new Set(dayKeys.map(dayNum));
    // longest run of consecutive active days
    let run = 0;
    let best = 0;
    let prevN = null;
    dayKeys.forEach((ds) => {
      const n = dayNum(ds);
      run = prevN != null && n - prevN === 1 ? run + 1 : 1;
      if (run > best) best = run;
      prevN = n;
    });
    // current streak counting back from the last active day
    let cur = 0;
    if (maxD) {
      let n = dayNum(fmtDay(maxD));
      while (daySet.has(n)) {
        cur++;
        n--;
      }
    }
    const busiest = Object.entries(byDate).sort((a, b) => b[1] - a[1])[0] || null;
    // [name, distinctVideos, plays, channelId] — sorted by distinct videos, then plays
    // Full per-channel tally {name: [distinctVideos, plays, channelId]} — kept so the
    // live tracker can update channel rankings accurately as you watch.
    const channelMap = Object.create(null);
    const channelVideos = Object.create(null);
    Object.keys(chPlays).forEach((nm) => {
      channelMap[nm] = [chVids[nm] ? chVids[nm].size : 0, chPlays[nm], chId[nm] || ''];
      if (chVids[nm]) {
        const bucket = Object.create(null);
        chVids[nm].forEach((vid) => {
          bucket[vid] = 1;
        });
        channelVideos[nm] = bucket;
      }
    });
    const topChannels = Object.keys(channelMap)
      .map((nm) => [nm, channelMap[nm][0], channelMap[nm][1], channelMap[nm][2]])
      .sort((a, b) => b[1] - a[1] || b[2] - a[2])
      .slice(0, 30);

    return {
      kind: 'watch',
      ids,
      stats: {
        version: 2,
        importedAt: fmtDay(new Date()),
        total,
        uniqueVideos: ids.size,
        uniqueChannels: Object.keys(chPlays).length,
        removed,
        firstDate: minD ? fmtDay(minD) : null,
        lastDate: maxD ? fmtDay(maxD) : null,
        activeDays: dayKeys.length,
        longestStreak: best,
        currentStreak: cur,
        busiestDay: busiest ? { date: busiest[0], count: busiest[1] } : null,
        byHour,
        byDow,
        byMonth,
        byDate,
        topChannels,
        channelMap,
        channelVideos,
        importVideoDays
      }
    };
  }

  function parseSearch(text) {
    const cells = text.split('outer-cell');
    const terms = Object.create(null);
    let total = 0;
    const reTerm = /Searched for\s+<a[^>]*>([^<]+)<\/a>/;
    for (let k = 1; k < cells.length; k++) {
      const m = cells[k].match(reTerm);
      if (!m) continue;
      total++;
      const t = decodeEntities(m[1]).trim().toLowerCase();
      if (t) terms[t] = (terms[t] || 0) + 1;
    }
    const words = Object.create(null);
    Object.keys(terms).forEach((t) => {
      const c = terms[t];
      t.split(/[^a-z0-9']+/).forEach((w) => {
        if (w.length < 3 || SEARCH_STOP.has(w)) return;
        words[w] = (words[w] || 0) + c;
      });
    });
    return {
      version: 1,
      total,
      uniqueTerms: Object.keys(terms).length,
      topTerms: Object.entries(terms)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40),
      topWords: Object.entries(words)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 60)
    };
  }

  function refreshStatsBtn() {
    chrome.storage.local.get(['watchStats', 'searchStats'], (d) => {
      const has = !!((d && d.watchStats) || (d && d.searchStats));
      const btn = $('view-stats');
      if (btn) btn.disabled = !has;
    });
  }

  $('import-watched').addEventListener('click', () => $('import-watched-file').click());
  $('import-watched-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const st = $('watched-status');
    st.textContent = 'Reading…';
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result || '');
      const ta = analyzeTakeout(text);

      // search-history.html -> store search stats, nothing to mark as watched
      if (ta && ta.kind === 'search') {
        chrome.storage.local.set({ searchStats: ta.searchStats }, () => {
          st.textContent = 'Imported ' + ta.searchStats.total.toLocaleString() + ' searches. Open “View stats”.';
          refreshStatsBtn();
        });
        e.target.value = '';
        return;
      }

      const imp = ta && ta.ids ? { ids: ta.ids, progress: {} } : extractWatchImport(text);
      const found = imp.ids;
      if (!found.size && !Object.keys(imp.progress).length) {
        st.textContent = 'No videos found — supports Watchmarker (.database) and Takeout (watch-history.html/.json).';
        return;
      }
      chrome.storage.local.get(['watchedVideos', 'watchStats', 'watchProgress'], (d) => {
        const cur = new Set((d && d.watchedVideos) || []);
        let added = 0;
        found.forEach((v) => {
          if (!cur.has(v)) {
            cur.add(v);
            added++;
          }
        });
        const toSet = { watchedVideos: Array.from(cur) };
        if (Object.keys(imp.progress).length) {
          toSet.watchProgress = WS.mergeWatchProgress(d.watchProgress || {}, imp.progress);
        }
        if (ta && ta.stats) {
          const existing = d && d.watchStats;
          const mergedIds = Array.from(cur);
          toSet.watchStats = existing
            ? WS.mergeWatchStats(ta.stats, existing, { watchedCount: mergedIds.length })
            : WS.reconcileWatchStats(ta.stats, mergedIds.length);
        } else {
          const mergedIds = Array.from(cur);
          const existing = d && d.watchStats;
          toSet.watchStats = existing
            ? WS.reconcileWatchStats(existing, mergedIds.length)
            : WS.buildIdOnlyStats(mergedIds.length);
        }
        chrome.storage.local.set(toSet, () => {
          st.textContent =
            'Imported ' +
            found.size.toLocaleString() +
            ' videos (' +
            added.toLocaleString() +
            ' new)' +
            (Object.keys(imp.progress).length ? ', ' + Object.keys(imp.progress).length + ' partial' : '') +
            '.' +
            (ta && ta.stats ? ' Stats merged — “View stats”.' : ' Distinct list updated — import Takeout for play history.');
          setCount();
          refreshStatsBtn();
          refreshLiveCard();
          // if no display mode is active yet, switch to "Mark" so it's visible right away
          chrome.storage.sync.get({ watchedMode: 'off', watchedDisplay: null }, (s) => {
            const off = !s.watchedDisplay && (s.watchedMode || 'off') === 'off';
            if (off) {
              const wd = WD.preset('mark');
              chrome.storage.sync.set({ watchedMode: 'mark', watchedDisplay: wd });
              loadWatchedForm(wd, 'mark');
            }
          });
        });
      });
    };
    r.onerror = () => (st.textContent = 'Could not read that file.');
    r.readAsText(f);
    e.target.value = '';
  });

  $('export-backup').addEventListener('click', () => {
    chrome.storage.local.get(['watchedVideos', 'watchProgress', 'watchStats', 'searchStats'], (d) => {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        watchedVideos: d.watchedVideos || [],
        watchProgress: d.watchProgress || {},
        watchStats: d.watchStats || null,
        searchStats: d.searchStats || null
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'unsynth-watch-backup-' + WS.todayKey() + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      $('watched-status').textContent = 'Backup exported.';
    });
  });

  if ($('export-watchmarker')) {
    $('export-watchmarker').addEventListener('click', () => {
      chrome.storage.local.get(['watchedVideos', 'watchProgress'], (d) => {
        const watched = new Set((d && d.watchedVideos) || []);
        const prog = (d && d.watchProgress) || {};
        const arr = [];
        watched.forEach((id) => arr.push({ strIdent: id, progress: 1 }));
        Object.keys(prog).forEach((id) => {
          if (watched.has(id)) return;
          arr.push({ strIdent: id, progress: Math.min(0.74, (prog[id] || 0) / 100) });
        });
        const b64 = btoa(JSON.stringify(arr));
        const blob = new Blob([b64], { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'unsynth-watchmarker-' + WS.todayKey() + '.database';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        $('watched-status').textContent = 'Watchmarker export downloaded.';
      });
    });
  }

  $('import-backup').addEventListener('click', () => $('import-backup-file').click());
  $('import-backup-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const st = $('watched-status');
    st.textContent = 'Reading backup…';
    const r = new FileReader();
    r.onload = () => {
      try {
        const raw = JSON.parse(String(r.result || ''));
        if (!raw || (!raw.watchedVideos && !raw.watchStats)) throw new Error('invalid');
        chrome.storage.local.get(['watchedVideos', 'watchProgress', 'watchStats', 'searchStats'], (d) => {
          const toSet = {};
          if (raw.watchedVideos) toSet.watchedVideos = WS.mergeWatchedIds(d.watchedVideos, raw.watchedVideos);
          if (raw.watchProgress) toSet.watchProgress = WS.mergeWatchProgress(d.watchProgress, raw.watchProgress);
          const mergedIds = toSet.watchedVideos || d.watchedVideos || [];
          if (raw.watchStats) {
            toSet.watchStats = d.watchStats
              ? WS.mergeWatchStats(raw.watchStats, d.watchStats, { watchedCount: mergedIds.length })
              : WS.reconcileWatchStats(raw.watchStats, mergedIds.length);
          } else if (d.watchStats) {
            toSet.watchStats = WS.reconcileWatchStats(d.watchStats, mergedIds.length);
          }
          if (raw.searchStats) toSet.searchStats = raw.searchStats;
          chrome.storage.local.set(toSet, () => {
            st.textContent = 'Backup merged.';
            setCount();
            refreshStatsBtn();
            refreshLiveCard();
          });
        });
      } catch (err) {
        st.textContent = 'Invalid backup file.';
      }
      e.target.value = '';
    };
    r.readAsText(f);
  });

  if ($('view-stats')) {
    $('view-stats').addEventListener('click', () => window.UNOpenPage.stats());
    refreshStatsBtn();
  }
  $('clear-watched').addEventListener('click', async () => {
    if (!(await uiConfirm('Clear all watched videos, partial progress, and stats? This cannot be undone (export a backup first).', 'Clear everything'))) return;
    chrome.storage.local.remove(['watchedVideos', 'watchProgress', 'watchStats', 'searchStats'], () => {
      setCount();
      refreshStatsBtn();
      refreshLiveCard();
      $('watched-status').textContent = 'Cleared.';
    });
  });
})();
