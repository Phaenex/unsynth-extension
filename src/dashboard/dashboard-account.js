'use strict';

/** Account / OAuth + update check + setup checklist + Forge cards. */
// Extracted from dashboard-core.js. Runs at global scope (classic script),
// loaded AFTER dashboard-core.js so its shared vars ($, send, flash, D, UNMSG)
// are already defined. Functions here are global and resolved by name.
  // ---- account / oauth ----
  const FL = window.UNForgeLinks;
  const UC = window.UNUpdateCheck;
  const localVersion = chrome.runtime.getManifest().version;
  const localVersionName = chrome.runtime.getManifest().version_name || '';
  // "1.0 · build 1.2.2" when a release has a public name, "v1.2.2" otherwise.
  const shownVersion = (v, name) => (UC && UC.displayVersion ? UC.displayVersion(v, name) : 'v' + v);

  function formatUpdateCheckTime(ts) {
    if (!ts) return 'never';
    try {
      return new Date(ts).toLocaleString();
    } catch (e) {
      return '—';
    }
  }

  function buildUpdateCommand() {
    return UC ? UC.updateCommand(UC.detectPlatform(), null, navigator.userAgent) : 'npm run update';
  }

  function renderUpdateWizard(data) {
    const wizard = $('update-wizard');
    if (!wizard) return;
    const available = data && data.ok && data.status === 'available';
    wizard.hidden = !available;
    if (!available) return;

    const downloadUrl = data.downloadUrl || (UC && UC.RELEASE_DOWNLOAD_URL) || 'https://unsynth.vercel.app/downloads/unsynth-latest.zip';
    if ($('update-wizard-version')) $('update-wizard-version').textContent = shownVersion(data.remoteVersion, data.remoteVersionName);
    const link = $('update-wizard-download');
    if (link) link.href = downloadUrl;

    const sha = (data.sha256 || '').trim();
    const shaRow = $('update-wizard-sha-row');
    if (shaRow) shaRow.hidden = !sha;
    if ($('update-wizard-sha')) $('update-wizard-sha').textContent = sha;
  }

  function renderUpdateStatus(data) {
    const msg = $('update-status-msg');
    const remoteLine = $('update-remote-line');
    if (!msg) return;
    msg.className = 'update-status';
    msg.textContent = '';
    renderUpdateWizard(null);
    if (!data) return;

    if (data.needsPat) {
      msg.textContent = 'Private repo — add a GitHub token to check for updates, or update manually below.';
      msg.classList.add('update-needs-pat');
      if ($('update-no-pat-hint')) $('update-no-pat-hint').hidden = false;
      return;
    }
    if ($('update-no-pat-hint')) $('update-no-pat-hint').hidden = true;

    if (!data.ok && data.error) {
      msg.textContent = data.message || 'Check failed: ' + data.error;
      msg.classList.add('update-error');
      return;
    }

    if (data.remoteVersion) {
      if (remoteLine) remoteLine.hidden = false;
      if ($('update-remote-version')) $('update-remote-version').textContent = shownVersion(data.remoteVersion, data.remoteVersionName);
    }

    if (data.status === 'available') {
      msg.textContent = shownVersion(data.remoteVersion, data.remoteVersionName) + ' is published — follow the steps below, then Reload Unsynth.';
      msg.classList.add('update-available');
      renderUpdateWizard(data);
    } else if (data.status === 'up_to_date') {
      msg.textContent = 'Up to date with the published release (' +
        (data.remoteVersion ? shownVersion(data.remoteVersion, data.remoteVersionName) : shownVersion(localVersion, localVersionName)) + ').';
      msg.classList.add('update-ok');
    }
  }

  function refreshUpdatesCard() {
    if ($('update-local-version')) $('update-local-version').textContent = shownVersion(localVersion, localVersionName);
    if ($('auto-reload-update')) {
      chrome.storage.sync.get({ autoReloadTabsOnUpdate: true }, (s) => {
        $('auto-reload-update').checked = !!(s && s.autoReloadTabsOnUpdate);
      });
    }
    const preview = $('update-cmd-preview');
    if (preview && UC) {
      const cmd = buildUpdateCommand();
      preview.textContent = 'Copy update command runs npm run update from: ' + cmd.split('\n')[0].replace('cd ', '').replace(' &&', '');
    }
    chrome.storage.local.get({ githubPat: '', updateLastCheck: 0, updateRemoteVersion: '', updateRemoteVersionName: '' }, (d) => {
      if ($('github-pat')) {
        $('github-pat').value = '';
        $('github-pat').placeholder = d.githubPat ? '•••••• (saved)' : 'ghp_… or github_pat_…';
      }
      if ($('update-last-check')) {
        $('update-last-check').textContent = 'Last check: ' + formatUpdateCheckTime(d.updateLastCheck);
      }
      if (d.updateRemoteVersion) {
        if ($('update-remote-line')) $('update-remote-line').hidden = false;
        if ($('update-remote-version')) $('update-remote-version').textContent = shownVersion(d.updateRemoteVersion, d.updateRemoteVersionName);
        const status =
          window.UNSemver && UNSemver.isNewer(d.updateRemoteVersion, localVersion) ? 'available' : 'up_to_date';
        renderUpdateStatus({
          ok: true,
          remoteVersion: d.updateRemoteVersion,
          remoteVersionName: d.updateRemoteVersionName,
          status
        });
      } else if (!d.githubPat) {
        const msg = $('update-status-msg');
        if (msg) {
          msg.className = 'update-status';
          msg.textContent = 'Click Check for updates — the deployed release works without a GitHub token.';
        }
        if ($('update-no-pat-hint')) $('update-no-pat-hint').hidden = false;
      }
    });
  }

  if ($('auto-reload-update')) {
    $('auto-reload-update').addEventListener('change', () => {
      const on = $('auto-reload-update').checked;
      chrome.storage.sync.set({ autoReloadTabsOnUpdate: on }, () => {
        flash($('update-check-status'), on ? 'YouTube tabs will auto-reload after updates.' : 'Auto-reload off.');
      });
    });
  }

  if ($('save-github-pat')) {
    $('save-github-pat').addEventListener('click', () => {
      const val = ($('github-pat').value || '').trim();
      chrome.storage.local.set({ githubPat: val }, () => {
        $('github-pat').value = '';
        $('github-pat').placeholder = val ? '•••••• (saved)' : 'ghp_… or github_pat_…';
        flash($('update-check-status'), val ? 'Token saved locally.' : 'Token cleared.');
        if (!val && $('update-status-msg')) {
          $('update-status-msg').className = 'update-status';
          $('update-status-msg').textContent = 'Token cleared — deployed release checks still work without it.';
        }
      });
    });
  }

  if ($('check-updates')) {
    $('check-updates').addEventListener('click', async () => {
      flash($('update-check-status'), 'Checking…');
      const patInput = ($('github-pat').value || '').trim();
      const stored = await new Promise((resolve) =>
        chrome.storage.local.get({ githubPat: '' }, (d) => resolve(d.githubPat || ''))
      );
      const pat = patInput || stored;
      if (patInput) {
        await new Promise((resolve) => chrome.storage.local.set({ githubPat: patInput }, resolve));
        $('github-pat').value = '';
        $('github-pat').placeholder = '•••••• (saved)';
      }
      const r = await send(UNMSG.UPDATE_CHECK, pat ? { pat } : {});
      if ($('update-last-check')) {
        $('update-last-check').textContent = 'Last check: ' + formatUpdateCheckTime(r.checkedAt || Date.now());
      }
      renderUpdateStatus(r);
      if (r.needsPat) {
        flash($('update-check-status'), 'Add GitHub token first.', false);
      } else if (r.ok) {
        flash($('update-check-status'), r.status === 'available' ? 'Update available.' : 'Up to date.', true);
      } else {
        flash($('update-check-status'), r.message || r.error || 'Check failed', false);
      }
    });
  }

  function copyUpdateCommand() {
    const cmd = buildUpdateCommand();
    return navigator.clipboard.writeText(cmd).then(() => flash($('update-check-status'), 'Command copied — edit the path first.'));
  }

  if ($('copy-update-cmd')) {
    $('copy-update-cmd').addEventListener('click', () => {
      copyUpdateCommand();
    });
  }
  if ($('copy-update-cmd-wizard')) {
    $('copy-update-cmd-wizard').addEventListener('click', () => {
      copyUpdateCommand();
    });
  }
  if ($('copy-update-sha')) {
    $('copy-update-sha').addEventListener('click', () => {
      const sha = ($('update-wizard-sha') && $('update-wizard-sha').textContent) || '';
      if (!sha) return;
      navigator.clipboard.writeText(sha).then(() => flash($('update-check-status'), 'SHA-256 copied.'));
    });
  }

  if ($('reload-extension')) {
    $('reload-extension').addEventListener('click', () => {
      chrome.runtime.reload();
    });
  }

  if ($('updates-reload-yt')) {
    $('updates-reload-yt').addEventListener('click', () => {
      send(UNMSG.RELOAD_YOUTUBE_TABS).then(() => {
        chrome.storage.local.set({ setupYoutubeReloaded: true });
        flash($('update-check-status'), 'YouTube tabs reloaded.');
        refreshSetupChecklist();
      });
    });
  }

  refreshUpdatesCard();

  async function refreshSetupChecklist() {
    const list = document.querySelector('.setup-checklist');
    if (!list) return;
    const local = await new Promise((resolve) =>
      chrome.storage.local.get({ setupYoutubeReloaded: false, onboardingDone: false }, resolve)
    );
    const oauth = await send(UNMSG.OAUTH_GET_CONFIG);
    const auth = await send(UNMSG.AUTH_STATUS);
    const ai = await send(UNMSG.AI_CONFIG_GET);
    const provider = ai.ok ? ai.provider || 'openrouter' : 'openrouter';
    const hasAiKey = ai.ok && ai.hasKey && ai.hasKey[provider];
    const states = {
      install: true,
      reload: !!(local.setupYoutubeReloaded || local.onboardingDone),
      oauth: !!(oauth.ok && oauth.clientId && oauth.hasSecret),
      // Ticked only for a token that can actually be used — an expired,
      // unrenewable one should not read as a completed setup step.
      connect: !!(auth.ok && auth.authed && auth.usable !== false),
      ai: !!hasAiKey
    };
    list.querySelectorAll('[data-step]').forEach((li) => {
      li.classList.toggle('setup-done', !!states[li.dataset.step]);
    });
    const coreDone = states.install && states.reload;
    const corePct = coreDone ? 100 : states.install ? 50 : 0;
    const fill = $('setup-progress-fill');
    const pct = $('setup-progress-pct');
    const banner = $('setup-ready-banner');
    if (fill) fill.style.width = corePct + '%';
    if (pct) pct.textContent = corePct + '%';
    if (banner) banner.hidden = !coreDone;
    const optDone = [states.oauth, states.connect, states.ai].filter(Boolean).length;
    const txt = $('setup-progress-text');
    if (txt) {
      txt.textContent = coreDone
        ? 'Core ready · ' + optDone + '/3 optional steps'
        : states.install
          ? 'Reload YouTube to finish core setup'
          : 'Install extension';
    }
  }

  function refreshForgeCards() {
    if (!FL) return;
    chrome.storage.local.get({ watchStats: null, searchStats: null, forgeLastSync: 0, forgeSync: { enabled: false } }, (d) => {
      const taste = FL.tasteOneLiner(d.watchStats, d.searchStats);
      const enabled = !!(d.forgeSync && d.forgeSync.enabled);
      const sync = enabled ? FL.formatSyncAge(d.forgeLastSync) : 'Sync off — data stays on this device';
      const line = enabled && taste ? taste + ' · ' + sync : sync;
      const subsEl = $('forge-subs-status');
      const acctEl = $('forge-account-status');
      if (subsEl) subsEl.textContent = line;
      if (acctEl) acctEl.textContent = line;
      if ($('forge-sync-enabled')) $('forge-sync-enabled').checked = enabled;
      if ($('forge-sync-now')) $('forge-sync-now').disabled = !enabled;
    });
  }

  if ($('fetch-update')) {
    $('fetch-update').addEventListener('click', async () => {
      const button = $('fetch-update');
      button.disabled = true;
      flash($('update-check-status'), 'Fetching latest release…');
      const r = await send(UNMSG.UPDATE_FETCH);
      button.disabled = false;
      if (r && r.ok) {
        // Be explicit about whether the archive was checksum-verified — this file
        // gets sideloaded as an extension, so "downloaded" alone is not the whole story.
        const suffix = r.verified
          ? ' Checksum verified.'
          : r.unverifiedReason === 'no_published_checksum'
            ? ' Note: the release publishes no checksum, so it could not be verified.'
            : ' Note: checksum could not be verified on this browser.';
        flash($('update-check-status'), 'ZIP downloaded — unzip over the existing folder, then Reload Unsynth.' + suffix, true);
      } else {
        flash($('update-check-status'), (r && (r.message || r.error)) || 'Download failed', false);
      }
    });
  }

  function openForgeTab() {
    const url = FL ? FL.forgeHome() : 'https://playlist-forge.vercel.app/';
    chrome.tabs.create({ url });
  }

  function setForgeSync(enabled, requestNow) {
    chrome.storage.local.get({ forgeSync: { enabled: false, sharedAt: 0, requestAt: 0 } }, (d) => {
      const current = window.UNForgeSync ? UNForgeSync.normalizeConfig(d.forgeSync) : d.forgeSync;
      const next = {
        enabled: enabled === true,
        sharedAt: current.sharedAt || 0,
        requestAt: requestNow ? Date.now() : current.requestAt || 0
      };
      chrome.storage.local.set({ forgeSync: next }, () => {
        refreshForgeCards();
        flash(
          $('forge-sync-status'),
          next.enabled ? (requestNow ? 'Sync requested. Open Forge if it is not already open.' : 'Forge sync enabled.') : 'Forge sync is off.',
          true
        );
      });
    });
  }

  if ($('forge-sync-enabled')) {
    $('forge-sync-enabled').addEventListener('change', () => {
      setForgeSync($('forge-sync-enabled').checked, $('forge-sync-enabled').checked);
    });
  }
  if ($('forge-sync-now')) $('forge-sync-now').addEventListener('click', () => setForgeSync(true, true));
  if ($('forge-sync-revoke')) {
    $('forge-sync-revoke').addEventListener('click', () => {
      chrome.storage.local.remove('forgeLastSync', () => setForgeSync(false, false));
    });
  }
  if ($('forge-account-open')) $('forge-account-open').addEventListener('click', openForgeTab);
  if ($('forge-subs-open')) $('forge-subs-open').addEventListener('click', openForgeTab);

  // Drift check lives in dashboard-core.js (top-bar banner + detailed list here).
  if (typeof window.refreshSelectorMissWarnings === 'function') refreshSelectorMissWarnings();

  if ($('copy-diagnostics')) {
    $('copy-diagnostics').addEventListener('click', async () => {
      const tabs = await chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
      let runtime = null;
      if (tabs && tabs[0] && tabs[0].id != null) {
        try { runtime = await chrome.tabs.sendMessage(tabs[0].id, { type: 'unsynth-get-diagnostics' }); } catch (e) { runtime = null; }
      }
      const storageBytes = await new Promise((resolve) => chrome.storage.local.getBytesInUse(null, (n) => resolve(n || 0)));

      // Watch-date coverage. "Why does this thumbnail say watched with no
      // date" is only answerable by knowing which of the three sources holds
      // a date for it, so report the counts rather than making people guess.
      const wd = await new Promise((resolve) =>
        chrome.storage.local.get(['watchedVideos', 'watchedDates', 'watchStats'], resolve)
      );
      const wdIds = (wd && wd.watchedVideos) || [];
      const wdDates = (wd && wd.watchedDates) || {};
      const impDays = (wd && wd.watchStats && wd.watchStats.importVideoDays) || {};
      const importedVids = new Set();
      Object.keys(impDays).forEach((day) => {
        const v = impDays[day];
        if (v) Object.keys(v).forEach((id) => importedVids.add(id));
      });
      const datedLocally = wdIds.filter((id) => wdDates[id]).length;
      const datedByImport = wdIds.filter((id) => !wdDates[id] && importedVids.has(id)).length;
      const watchDates = {
        watchedVideos: wdIds.length,
        withLocalDate: datedLocally,
        withImportedDateOnly: datedByImport,
        withNoDate: wdIds.length - datedLocally - datedByImport,
        importDaysRecorded: Object.keys(impDays).length,
        importedVideosWithDates: importedVids.size
      };
      const report = {
        capturedAt: new Date().toISOString(),
        extensionVersion: chrome.runtime.getManifest().version,
        browser: navigator.userAgent,
        browserEnvironment: window.UNBrowserEnv ? {
          name: UNBrowserEnv.browserName(),
          atlasDetected: UNBrowserEnv.isAtlas(),
          compatibility: UNBrowserEnv.extensionCapabilities(chrome)
        } : { unavailable: true },
        localStorageBytes: storageBytes,
        watchDates,
        youtubeRuntime: runtime || { unavailable: true }
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
        flash($('diagnostics-status'), 'Diagnostics copied.', true);
      } catch (e) {
        flash($('diagnostics-status'), 'Clipboard unavailable.', false);
      }
    });
  }

  async function refreshAccount() {
    const cfg = await send(UNMSG.OAUTH_GET_CONFIG);
    if (cfg.ok) {
      $('redirect-uri').textContent = cfg.redirectUri || '';
      $('client-id').value = cfg.clientId || '';
      $('client-secret').placeholder = cfg.hasSecret ? '•••••• (saved)' : 'GOCSPX-…';
      if ($('oauth-dev-seed-note')) $('oauth-dev-seed-note').hidden = !cfg.devSeed;
    }
    const st = await send(UNMSG.AUTH_STATUS);
    if (st.ok) {
      const hasWrite = (st.scopeKeys || []).indexOf('write') !== -1;
      // A stored token that cannot be renewed is not a connection. Saying
      // "Connected ✓" for one means every failing call looks like a different
      // bug, so name the real state instead.
      const dead = st.authed && st.usable === false;
      if (dead) {
        $('auth-status').textContent = 'Session expired — reconnect';
        $('auth-status').style.color = '#e88';
      } else if (st.authed) {
        $('auth-status').textContent = hasWrite ? 'Connected ✓ (read + write)' : 'Connected (read-only — reconnect for write)';
        $('auth-status').style.color = hasWrite ? '#6ee787' : '#e8c878';
      } else {
        $('auth-status').textContent = st.hasConfig ? 'Not connected' : 'Add credentials first';
        $('auth-status').style.color = '#9a9a9a';
      }
      // loadChannel() is the live proof: it actually calls the API. Running it
      // on a dead token is what turns "expired" into a visible failure rather
      // than a silent one.
      if (st.authed) loadChannel();
    }
    const q = await send(UNMSG.QUOTA_GET);
    if (q.ok) $('quota-line').textContent = `API quota today: ${q.quota.used} / ${q.cap} units (this install). Google Cloud may still be exhausted separately.`;
  }
  function paintChannelLine(r) {
    const el = $('channel-line');
    if (!el) return;
    const ch = r && r.channel;
    if (ch && ch.snippet) {
      const s = ch.statistics || {};
      const stale = r.stale || r.error === 'quota' ? ' — last known (Google Cloud quota is used up today)' : '';
      el.textContent = ch.snippet.title + ' — ' + (s.subscriberCount || '?') + ' subs, ' + (s.videoCount || '?') + ' videos' + stale;
      return;
    }
    if (r && r.error === 'quota') {
      el.textContent = 'YouTube is connected, but this Google Cloud project is out of API quota today. The name comes back after midnight Pacific.';
      return;
    }
    if (r && !r.ok) {
      el.textContent = r.error ? 'Could not load channel: ' + r.error : '';
      return;
    }
    el.textContent = 'Connected, but this Google login has no YouTube channel.';
  }
  async function loadChannel() {
    const r = await send(UNMSG.YT_CHANNELS_MINE);
    paintChannelLine(r || {});
  }
  $('copy-redirect').addEventListener('click', () => {
    navigator.clipboard.writeText($('redirect-uri').textContent).then(() => flash($('oauth-status'), 'Copied.'));
  });
  $('save-oauth').addEventListener('click', async () => {
    const r = await send(UNMSG.OAUTH_SET_CONFIG, { clientId: $('client-id').value.trim(), clientSecret: $('client-secret').value.trim() });
    flash($('oauth-status'), r.ok ? 'Saved.' : 'Error', r.ok);
    $('client-secret').value = '';
    refreshAccount();
    refreshSetupChecklist();
  });
  $('connect').addEventListener('click', async () => {
    flash($('auth-status'), 'Opening consent…');
    const r = await send(UNMSG.AUTH_START, { scopes: ['readonly', 'write'] });
    if (r.ok) {
      const hasWrite = (r.scopeKeys || []).indexOf('write') !== -1;
      flash($('auth-status'), hasWrite ? 'Connected ✓ (read + write)' : 'Connected (read-only)', hasWrite);
      loadChannel();
      refreshAccount();
      refreshSetupChecklist();
      syncGroupedSubsTitles();
      enrichNames();
      send(UNMSG.SUBS_CACHE_REFRESH);
      refreshSubsCacheStatus();
    } else {
      flash($('auth-status'), 'Failed: ' + (r.error || ''), false);
    }
  });
  $('signout').addEventListener('click', async () => {
    await send(UNMSG.AUTH_SIGNOUT);
    chrome.storage.local.remove([
      'subscribedChannelCache',
      'subscribedChannelsOAuthUpdated',
      'subscribedChannelsGuideMerged',
      'subscribedChannelsUpdated'
    ]);
    $('channel-line').textContent = '';
    flash($('auth-status'), 'Signed out.');
    refreshSetupChecklist();
    refreshSubsCacheStatus();
  });
