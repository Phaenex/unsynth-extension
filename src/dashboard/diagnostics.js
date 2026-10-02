'use strict';

/**
 * Read-only storage diagnostics.
 *
 * Built because there was no way to check what an import actually produced:
 * chrome-extension:// pages are unreachable to browser automation, and a page's
 * MAIN world has no chrome.storage, so the only signal was inferring state from
 * badges rendered on youtube.com. That is guesswork, and it produced at least
 * one wrong conclusion (a "16 years of history" claim that was really 9 months).
 *
 * SAFETY: this never reads or prints a credential. It deliberately does not
 * touch auth_tokens, ai_config, oauth_client_secret, or githubPat — only counts,
 * date ranges, and structural shape. The report is also written to
 * document.title and <html data-unsynth-report> so a reader that can see the
 * page's DOM (but not run privileged code) can pull it without screenshots.
 */
(function () {
  const out = document.getElementById('out');

  // Keys whose VALUES must never be rendered. Presence is reported as a boolean.
  const SECRET_KEYS = new Set([
    'auth_tokens',
    'ai_config',
    'oauth_client_id',
    'oauth_client_secret',
    'githubPat'
  ]);

  const nf = (n) => (typeof n === 'number' ? n.toLocaleString() : String(n));

  function getLocal(defaults) {
    return new Promise((resolve) => {
      chrome.storage.local.get(defaults, (d) => resolve(chrome.runtime.lastError ? null : d || {}));
    });
  }

  function bytesInUse() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.getBytesInUse(null, (n) => resolve(chrome.runtime.lastError ? null : n));
      } catch (e) {
        resolve(null);
      }
    });
  }

  function allKeys() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (d) => resolve(chrome.runtime.lastError ? {} : d || {}));
    });
  }

  function monthSpan(byMonth) {
    const keys = Object.keys(byMonth || {}).sort();
    if (!keys.length) return null;
    return { first: keys[0], last: keys[keys.length - 1], count: keys.length };
  }

  async function build() {
    const lines = [];
    const push = (s) => lines.push(s);

    const raw = await allKeys();
    const storeKeys = Object.keys(raw);
    const bytes = await bytesInUse();

    push('# Unsynth storage diagnostics');
    push('version        : ' + chrome.runtime.getManifest().version +
      (chrome.runtime.getManifest().version_name ? ' (' + chrome.runtime.getManifest().version_name + ')' : ''));
    push('generated      : ' + new Date().toISOString());
    push('storage.local  : ' + (bytes == null ? 'unknown' : nf(bytes) + ' bytes') + ' across ' + storeKeys.length + ' keys');
    push('');

    // ---- credentials: presence only, never values ----
    push('## credentials (presence only)');
    SECRET_KEYS.forEach((k) => {
      const present = Object.prototype.hasOwnProperty.call(raw, k) && raw[k] != null && raw[k] !== '';
      push('  ' + k.padEnd(22) + (present ? 'set' : '—'));
    });
    push('');

    // ---- watch history ----
    const d = await getLocal({
      watchStats: null,
      watchedVideos: [],
      watchProgress: {},
      searchStats: null,
      subStore: null,
      subscribedChannelCache: { keys: [] },
      plFolderStore: null,
      plPins: { ids: [] },
      videoStatsCache: null,
      discoverCache: null
    });

    const ws = d.watchStats;
    push('## watch history');
    if (!ws) {
      push('  watchStats     : ABSENT — nothing imported and no live tracking yet');
    } else {
      const cm = ws.channelMap || {};
      const cv = ws.channelVideos || {};
      const ivd = ws.importVideoDays || {};
      const ivdDays = Object.keys(ivd);
      let ivdVideos = 0;
      ivdDays.forEach((day) => (ivdVideos += Object.keys(ivd[day] || {}).length));

      push('  source         : ' + (window.UNWatchStats ? UNWatchStats.sourceLabel(ws) : (ws.live ? 'live' : 'imported')));
      push('  total plays    : ' + nf(ws.total || 0));
      push('  unique videos  : ' + nf(ws.uniqueVideos || 0));
      push('  unique channels: ' + nf(ws.uniqueChannels || 0));
      push('  date range     : ' + (ws.firstDate || '?') + ' -> ' + (ws.lastDate || '?'));
      push('  active days    : ' + nf(ws.activeDays || 0));
      push('  longest streak : ' + nf(ws.longestStreak || 0));
      push('');
      push('  ### retained detail (this is where caps bite)');
      push('  channelMap entries    : ' + nf(Object.keys(cm).length) + '   <- full per-channel tallies');
      push('  channelVideos entries : ' + nf(Object.keys(cv).length));
      push('  topChannels retained  : ' + nf((ws.topChannels || []).length) + '   <- what the UI lists');
      const capped = Object.keys(cm).length - (ws.topChannels || []).length;
      if (capped > 0) {
        push('  CHANNELS NOT LISTED   : ' + nf(capped) + ' (in channelMap but absent from topChannels)');
      }
      push('');
      push('  ### histograms');
      const ms = monthSpan(ws.byMonth);
      const msLive = monthSpan(ws.liveByMonth);
      push('  byMonth buckets  : ' + (ms ? ms.count + ' (' + ms.first + ' -> ' + ms.last + ')' : 'none'));
      push('  liveByMonth      : ' + (msLive ? msLive.count + ' (' + msLive.first + ' -> ' + msLive.last + ')' : 'none'));
      push('  byDate days      : ' + nf(Object.keys(ws.byDate || {}).length));
      push('  liveByDate days  : ' + nf(Object.keys(ws.liveByDate || {}).length));
      push('  byHour populated : ' + (ws.byHour || []).filter((n) => n > 0).length + '/24');
      push('  byDow populated  : ' + (ws.byDow || []).filter((n) => n > 0).length + '/7');
      push('');
      push('  ### drift signal (hidden-gems shelf depends on this)');
      push('  importVideoDays days   : ' + nf(ivdDays.length));
      push('  importVideoDays videos : ' + nf(ivdVideos));
      if (!ivdDays.length) {
        push('  NOTE: empty -> "subs you drifted from" scores nothing. Needs a Takeout import.');
      }
    }
    push('');
    push('  watchedVideos set : ' + nf((d.watchedVideos || []).length));
    push('  watchProgress     : ' + nf(Object.keys(d.watchProgress || {}).length) + ' partially-watched');
    push('');

    // ---- search ----
    const ss = d.searchStats;
    push('## search history');
    if (!ss) push('  ABSENT — import search-history.html for taste signals');
    else {
      push('  total searches : ' + nf(ss.total || 0));
      push('  topTerms       : ' + nf((ss.topTerms || []).length));
      push('  topWords       : ' + nf((ss.topWords || []).length));
    }
    push('');

    // ---- subs / playlists ----
    push('## subscriptions & playlists');
    const groups = (d.subStore && d.subStore.groups) || {};
    push('  sub groups        : ' + Object.keys(groups).length + (Object.keys(groups).length ? ' (' + Object.keys(groups).join(', ') + ')' : ''));
    Object.keys(groups).forEach((g) => push('    ' + g.padEnd(18) + nf((groups[g] || []).length) + ' channels'));
    push('  subscribedCache   : ' + nf(((d.subscribedChannelCache || {}).keys || []).length) + ' keys');
    const folders = (d.plFolderStore && d.plFolderStore.folders) || {};
    push('  playlist folders  : ' + Object.keys(folders).length);
    push('  pinned playlists  : ' + nf(((d.plPins || {}).ids || []).length));
    push('');

    // ---- caches ----
    const vsc = d.videoStatsCache;
    const vscEntries = vsc ? Object.keys(vsc.entries || vsc).length : 0;
    push('## caches');
    push('  videoStatsCache : ' + nf(vscEntries) + ' entries');
    push('  discoverCache   : ' + (d.discoverCache ? nf((d.discoverCache.videos || []).length) + ' candidates, age ' + Math.round((Date.now() - (d.discoverCache.at || 0)) / 60000) + 'm' : 'empty'));
    push('  cache_* keys    : ' + storeKeys.filter((k) => k.indexOf('cache_') === 0).length);
    push('');

    push('## all storage keys');
    push('  ' + storeKeys.sort().join(', '));

    return lines.join('\n');
  }

  async function render() {
    out.textContent = 'Reading…';
    let report;
    try {
      report = await build();
    } catch (e) {
      report = 'DIAGNOSTICS ERROR: ' + (e && e.message ? e.message : String(e));
    }
    out.textContent = report;
    // Machine-readable mirrors so an automated reader can retrieve this without
    // screenshotting: the full report on <html>, a one-line summary in the title.
    try {
      document.documentElement.setAttribute('data-unsynth-report', report);
      const m = report.match(/total plays\s*:\s*([\d,]+)/);
      document.title = 'Unsynth diagnostics — ' + (m ? m[1] + ' plays' : 'ready');
    } catch (e) {
      /* attribute size limits — the <pre> is still authoritative */
    }
  }

  document.getElementById('refresh').addEventListener('click', render);
  document.getElementById('copy').addEventListener('click', () => {
    navigator.clipboard.writeText(out.textContent).then(() => {
      const b = document.getElementById('copy');
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy report'), 1500);
    });
  });

  render();
})();
