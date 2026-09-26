  // ---- Filter tab (shared form) ----
  let filterPanelReady = false;
  function initFilterPanel() {
    const root = $('filter-panel-root');
    if (!root || !window.UNFilterForm) return;
    if (!filterPanelReady) {
      filterPanelReady = true;
      // Live percentage readout beside the sensitivity slider — a bare range
      // input gives no indication of the value being chosen.
      const ms = $('filter-minscore');
      const msOut = $('filter-minscore-out');
      if (ms && msOut) {
        ms.addEventListener('input', () => {
          msOut.textContent = ms.value + '%';
        });
      }
      $('filter-save').addEventListener('click', () => {
        const next = UNFilterForm.gatherFilterForm(root);
        // Keep Modules-tab / popup master aligned with this Filter master toggle
        // without clobbering other module flags.
        chrome.storage.sync.get({ modules: D.modules }, (cur) => {
          const modules = Object.assign({}, cur.modules || D.modules, {
            aiFilter: next.enabled !== false
          });
          chrome.storage.sync.set(Object.assign({}, next, { modules }), () => {
            // The keyword/block/allow textareas can push this past
            // chrome.storage.sync's 8 KB per-item quota. Saying "Saved." when the
            // write was rejected is how edits quietly disappear on reload.
            const err = chrome.runtime.lastError;
            if (err) {
              flash($('filter-status'), UNFilterForm.describeSyncError(err), false);
              return;
            }
            flash($('filter-status'), 'Saved.');
            refreshFilterSummary();
          });
        });
      });
      $('filter-reset').addEventListener('click', () => {
        // Reset only filter-owned keys — never clobber modules/ui/sponsorBlock/etc.
        const aiFilterOn = D.modules && D.modules.aiFilter !== false;
        const filterDefaults = {
          enabled: D.enabled,
          respectDisclosure: D.respectDisclosure,
          blockPlayback: D.blockPlayback,
          hideSummaries: D.hideSummaries,
          useRegex: D.useRegex,
          mode: D.mode,
          minScore: D.minScore,
          surfaces: Object.assign({}, D.surfaces),
          keywords: (D.keywords || []).slice(),
          channels: (D.channels || []).slice(),
          allowedChannels: (D.allowedChannels || []).slice(),
          allowSubscribedChannels: D.allowSubscribedChannels,
          communityList: Object.assign({}, D.communityList),
          focus: Object.assign({}, D.focus, { days: ((D.focus && D.focus.days) || []).slice() })
        };
        chrome.storage.sync.get({ modules: D.modules }, (cur) => {
          const modules = Object.assign({}, cur.modules || D.modules, { aiFilter: aiFilterOn });
          chrome.storage.sync.set(Object.assign({}, filterDefaults, { modules }), () => {
            UNFilterForm.loadFilterForm(root, D, filterDefaults);
            UNFilterForm.renderChannelChips(root);
            UNFilterForm.renderAllowChips(root);
            refreshFilterSummary();
            flash($('filter-status'), 'Reset to defaults.');
          });
        });
      });
      $('filter-aislist-sync').addEventListener('click', () => {
        const st = $('filter-aislist-status');
        if (st) st.textContent = 'Syncing…';
        send(UNMSG.AISLIST_SYNC).then((r) => {
          if (!r || !r.ok) {
            if (st) st.textContent = 'Sync failed.';
            return;
          }
          if (st) st.textContent = (r.count || 0).toLocaleString() + ' channels synced.';
        });
      });
      $('filter-channel-add').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const inp = $('filter-channel-add');
        const v = (inp.value || '').trim();
        if (!v) return;
        const ta = $('filter-channels');
        const cur = UNFilterForm.linesToArr(ta.value);
        if (!cur.some((c) => c.toLowerCase() === v.toLowerCase())) cur.push(v);
        ta.value = UNFilterForm.arrToLines(cur);
        inp.value = '';
        UNFilterForm.saveList('channels', cur, (okSave, message) => {
          UNFilterForm.reportListError(root, 'channels', okSave ? '' : message);
        });
        UNFilterForm.renderChannelChips(root);
      });
      $('filter-allow-add').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const inp = $('filter-allow-add');
        const v = (inp.value || '').trim();
        if (!v) return;
        const parsed = SG().parseChannelInput(v);
        const add = parsed ? parsed.label || parsed.key : v;
        if (!add) return;
        const ta = $('filter-allowedChannels');
        const cur = UNFilterForm.linesToArr(ta.value);
        if (!cur.some((c) => c.toLowerCase() === add.toLowerCase())) cur.push(add);
        ta.value = UNFilterForm.arrToLines(cur);
        inp.value = '';
        UNFilterForm.saveList('allowedChannels', cur, (okSave, message) => {
          UNFilterForm.reportListError(root, 'allowedChannels', okSave ? '' : message);
        });
        UNFilterForm.renderAllowChips(root);
      });
      const allowSubsEl = $('filter-allowSubscribedChannels');
      if (allowSubsEl) {
        allowSubsEl.addEventListener('change', () => {
          UNFilterForm.syncSetOrFlash('allowSubscribedChannels', allowSubsEl.checked, root);
        });
      }
      const subsCacheRefresh = $('filter-subs-cache-refresh');
      if (subsCacheRefresh) {
        subsCacheRefresh.addEventListener('click', () => {
          const st = $('filter-subs-cache-status');
          if (st) st.textContent = 'Refreshing…';
          send(UNMSG.SUBS_CACHE_REFRESH).then((r) => {
            refreshSubsCacheStatus();
            if (!r || !r.ok) {
              if (st) st.textContent = 'Refresh failed' + (r && r.error === 'not_authed' ? ' — connect YouTube first' : '');
              return;
            }
            if (st) st.textContent = (r.count || 0).toLocaleString() + ' channels cached (OAuth).';
          });
        });
      }
      $('filter-communityList').addEventListener('change', () => {
        if (!$('filter-communityList').checked) return;
        send(UNMSG.AISLIST_GET).then((r) => {
          if (!r || !r.count) send(UNMSG.AISLIST_SYNC);
        });
      });
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'sync' && ch.channels && root.closest('.panel.active')) {
          $('filter-channels').value = UNFilterForm.arrToLines(ch.channels.newValue || []);
          UNFilterForm.renderChannelChips(root);
        }
        if (area === 'sync' && ch.allowedChannels && root.closest('.panel.active')) {
          $('filter-allowedChannels').value = UNFilterForm.arrToLines(ch.allowedChannels.newValue || []);
          UNFilterForm.renderAllowChips(root);
        }
        if (area === 'local' && (ch.subscribedChannelCache || ch.subscribedChannelsOAuthUpdated) && root.closest('.panel.active')) {
          refreshSubsCacheStatus();
        }
      });
    }
    chrome.storage.sync.get(D, (s) => {
      UNFilterForm.loadFilterForm(root, D, s);
      UNFilterForm.renderChannelChips(root);
      UNFilterForm.renderAllowChips(root);
      send(UNMSG.AISLIST_GET).then((r) => {
        const st = $('filter-aislist-status');
        if (!st) return;
        if (!r || !r.count) st.textContent = 'Not synced yet — click Sync list now.';
        else st.textContent = r.count.toLocaleString() + ' channels cached.';
      });
      refreshSubsCacheStatus();
    });
  }

  function refreshSubsCacheStatus() {
    const st = $('filter-subs-cache-status');
    if (!st) return;
    chrome.storage.local.get(
      {
        subscribedChannelCache: { keys: [], names: [] },
        subscribedChannelsOAuthUpdated: 0,
        subscribedChannelsGuideMerged: 0
      },
      (d) => {
        const n = (d.subscribedChannelCache && d.subscribedChannelCache.keys && d.subscribedChannelCache.keys.length) || 0;
        const oauth = d.subscribedChannelsOAuthUpdated || 0;
        const guide = d.subscribedChannelsGuideMerged || 0;
        const parts = [n.toLocaleString() + ' channels in cache'];
        if (oauth) {
          try {
            parts.push('OAuth: ' + new Date(oauth).toLocaleString());
          } catch (e) {
            parts.push('OAuth refreshed');
          }
        } else parts.push('OAuth: not refreshed yet');
        if (guide) parts.push('sidebar merged');
        st.textContent = parts.join(' · ');
      }
    );
  }

  function refreshActiveFilters() {
    chrome.storage.local.get({ subActive: '', plFolderActive: '' }, (d) => {
      const subEl = $('active-sub-group');
      const plEl = $('active-pl-folder');
      if (subEl) subEl.textContent = d.subActive || 'All subscriptions';
      if (plEl) plEl.textContent = d.plFolderActive || 'All playlists';
    });
    chrome.storage.sync.get({ modules: D.modules }, (s) => {
      const mods = window.UNModules ? UNModules.normalizeModules(Object.assign({}, D.modules, s.modules), D) : Object.assign({}, D.modules, s.modules);
      const plLine = $('active-pl-filter-line');
      const plAdvanced = $('pl-folders-advanced');
      const showPl = mods.playlistFolders !== false;
      if (plLine) plLine.hidden = !showPl;
      if (plAdvanced) plAdvanced.classList.toggle('module-off', !showPl);
    });
  }

  function loadWatchedThreshold() {
    chrome.storage.sync.get({ watchedThreshold: D.watchedThreshold || 75 }, (s) => {
      const el = $('wd-threshold');
      const lbl = $('wd-threshold-val');
      if (!el) return;
      el.value = s.watchedThreshold || 75;
      if (lbl) lbl.textContent = el.value + '%';
    });
  }

  function loadAiPanelPrefs() {
    chrome.storage.local.get({ aiPanelOpen: true, aiPanelWidth: 380 }, (d) => {
      if ($('ai-panel-open')) $('ai-panel-open').checked = d.aiPanelOpen !== false;
      if ($('ai-panel-width')) $('ai-panel-width').value = d.aiPanelWidth || 380;
    });
  }

  if ($('wd-threshold')) {
    $('wd-threshold').addEventListener('input', (e) => {
      const v = Number(e.target.value) || 75;
      if ($('wd-threshold-val')) $('wd-threshold-val').textContent = v + '%';
    });
    $('wd-threshold').addEventListener('change', (e) => {
      chrome.storage.sync.set({ watchedThreshold: Number(e.target.value) || 75 });
      flash($('watched-display-status'), 'Threshold saved.');
    });
  }
  if ($('save-ai-panel-prefs')) {
    $('save-ai-panel-prefs').addEventListener('click', () => {
      chrome.storage.local.set(
        {
          aiPanelOpen: $('ai-panel-open').checked,
          aiPanelWidth: Number($('ai-panel-width').value) || 380
        },
        () => flash($('ai-panel-prefs-status'), 'Panel prefs saved.')
      );
    });
  }
  if ($('clear-sub-active')) {
    $('clear-sub-active').addEventListener('click', () => {
      chrome.storage.local.set({ subActive: '' }, () => refreshActiveFilters());
    });
  }
  if ($('clear-pl-active')) {
    $('clear-pl-active').addEventListener('click', () => {
      chrome.storage.local.set({ plFolderActive: '' }, () => refreshActiveFilters());
    });
  }

