/**
 * Playlist Forge Search tab — full discover flow on YouTube.
 * Requires window.UNForgeDiscover (shared helpers).
 */
(function () {
  'use strict';

  var FD = window.UNForgeDiscover;
  var MAX_SAVED = 24;

  // Module-scope discover cache (survives panel re-mounts) so re-running the same
  // request is instant instead of a fresh backend round-trip + re-judge.
  var _discoverCache = {};
  var DISCOVER_TTL = 10 * 60 * 1000;
  var DISCOVER_MAX = 30;

  function pruneDiscoverCache(now) {
    now = now || Date.now();
    Object.keys(_discoverCache).forEach(function (key) {
      if (!_discoverCache[key] || now - _discoverCache[key].at >= DISCOVER_TTL) delete _discoverCache[key];
    });
    var keys = Object.keys(_discoverCache).sort(function (a, b) {
      return _discoverCache[a].at - _discoverCache[b].at;
    });
    while (keys.length >= DISCOVER_MAX) delete _discoverCache[keys.shift()];
  }

  // Turn a failed apiFetch response into a human, actionable message.
  function forgeErrorText(res, fallback) {
    if (res && res.data && res.data.error) return String(res.data.error);
    if (!res || res.status === 0) return 'Forge backend is unreachable (offline, slow, or down). Check your connection and try again.';
    if (res.status === 429) return 'Forge is rate-limited right now — wait a moment and try again.';
    if (res.status >= 500) return 'Forge backend error (' + res.status + '). Try again shortly.';
    return fallback || 'Request failed.';
  }

  // apiFetch with one retry on a transient (network/0/5xx) failure.
  async function forgeFetch(path, opts) {
    var res = await window.UNForgeLinks.apiFetch(path, opts);
    if (res && res.ok) return res;
    if (!res || res.status === 0 || res.status >= 500) {
      await new Promise(function (r) { setTimeout(r, 600); });
      var retry = await window.UNForgeLinks.apiFetch(path, opts);
      if (retry && retry.ok) return retry;
      return retry || res;
    }
    return res;
  }

  function el(tag, cls, text) { return window.UNSYNTH.el(tag, cls, text); }

  function createPanel(deps) {
    if (!FD) return null;

    var root = null;
    var candMap = {};
    var cardOrder = [];
    // Client-side relevance filter: drop Forge results from channels the user has
    // blocked or that match their AI keyword/channel rules — so Forge respects the
    // same filtering as the rest of the suite, not just the backend's own AI check.
    var userMatcher = null;
    var userSettings = null;
    var hiddenByUserFilter = 0;
    (function loadUserFilter() {
      try {
        chrome.storage.sync.get({ channels: [], keywords: [], useRegex: false, allowedChannels: [] }, function (d) {
          userSettings = d || {};
          if (window.UNMatch && window.UNMatch.makeMatcher) userMatcher = window.UNMatch.makeMatcher(userSettings);
        });
      } catch (e) {
        /* fail open — show everything if settings can't load */
      }
    })();
    function isFilteredOut(v) {
      if (!userMatcher || !userSettings) return false; // not loaded yet → fail open
      var ch = v.channelTitle || v.channelName || '';
      // Forge search results only carry a channel display name from the
      // backend — no @handle/UC-id is available here, unlike a live feed
      // tile's DOM-derived chKey. Passing null (not a DOM-derived key) lets
      // isChannelAllowed fall back to name-based matching for @handle entries.
      if (window.UNMatch && window.UNMatch.isChannelAllowed && window.UNMatch.isChannelAllowed(userSettings, ch, null)) return false;
      return !!userMatcher.match(v.title || '', ch).hit;
    }
    var filterMode = 'all';
    var gradeFilter = null;
    var lastRequest = '';
    var judgePromise = null;
    var forcedExclude = [];
    var openPlMenu = null;
    var openBulkPlMenu = null;
    var docClickHandler = null;
    var queueChangeHandler = null;
    var selWl = null;
    var previewBackdrop = null;
    var previewKeyHandler = null;
    var previewEscHandle = null;
    var previewReturnFocus = null;

    function closePlMenus() {
      if (!root) return;
      root.querySelectorAll('.un-forge-s-plmenu.on').forEach(function (m) {
        m.classList.remove('on');
      });
      openPlMenu = null;
      openBulkPlMenu = null;
    }

    function refreshWriteUi() {
      if (!root) return;
      var canWrite = deps.canWrite ? deps.canWrite() : false;
      if (selWl) {
        selWl.disabled = !canWrite;
        selWl.classList.toggle('disabled', !canWrite);
        selWl.title = canWrite ? 'Add selected videos to Watch Later' : 'Connect YouTube with write access';
        selWl.setAttribute('aria-label', selWl.title);
      }
      closePlMenus();
    }

    function closePreview() {
      if (previewBackdrop) {
        previewBackdrop.classList.remove('on');
        var iframe = previewBackdrop.querySelector('iframe');
        if (iframe) iframe.src = '';
      }
      if (previewEscHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
        window.UNSYNTH.popPanel(previewEscHandle);
        previewEscHandle = null;
      }
      if (previewKeyHandler) {
        document.removeEventListener('keydown', previewKeyHandler);
        previewKeyHandler = null;
      }
      if (previewReturnFocus && previewReturnFocus.isConnected) {
        try { previewReturnFocus.focus(); } catch (e) { /* ignore */ }
      }
      previewReturnFocus = null;
    }

    function previewHost() {
      return document.getElementById('un-forge-root') || document.body;
    }

    function wireThumbImg(img, v) {
      var urls = FD.thumbFallbackUrls(v);
      var idx = 0;
      img.src = urls[0] || '';
      img.alt = v.title || '';
      img.onerror = function () {
        idx += 1;
        if (idx < urls.length) img.src = urls[idx];
        else img.onerror = null;
      };
    }

    function statsLine(v) {
      var parts = [];
      if (v.viewCount != null) parts.push(FD.formatCount(v.viewCount) + ' views');
      if (v.likeCount != null) parts.push(FD.formatCount(v.likeCount) + ' likes');
      if (v.durationSec) parts.push(FD.formatDur(v.durationSec));
      var yr = FD.yearOf(v.publishedAt);
      if (yr) parts.push(String(yr));
      if (v.channelTitle) parts.push(v.channelTitle);
      return parts.join(' · ');
    }

    function showPreview(v) {
      var id = FD.videoIdOf(v);
      if (!id) return;
      if (!previewBackdrop) {
        previewBackdrop = el('div', 'un-forge-preview-backdrop');
        previewBackdrop.innerHTML =
          '<div class="un-forge-preview-box" role="dialog" aria-modal="true">' +
          '<button type="button" class="un-forge-preview-x" aria-label="Close">×</button>' +
          '<div class="un-forge-preview-hero"><img class="un-forge-preview-poster" alt="" /></div>' +
          '<h4 class="un-forge-preview-title"></h4>' +
          '<p class="un-forge-preview-stats"></p>' +
          '<p class="un-forge-preview-reason"></p>' +
          '<div class="un-forge-preview-frame"></div>' +
          '<a class="un-forge-preview-open" target="_blank" rel="noopener">Open on YouTube ↗</a>' +
          '</div>';
        previewBackdrop.addEventListener('click', function (e) {
          if (e.target === previewBackdrop) closePreview();
        });
        previewBackdrop.querySelector('.un-forge-preview-x').addEventListener('click', closePreview);
        previewHost().appendChild(previewBackdrop);
      } else if (previewBackdrop.parentNode !== previewHost()) {
        previewHost().appendChild(previewBackdrop);
      }
      previewBackdrop.querySelector('.un-forge-preview-title').textContent = v.title || id;
      previewBackdrop.querySelector('.un-forge-preview-stats').textContent = statsLine(v);
      var reasonEl = previewBackdrop.querySelector('.un-forge-preview-reason');
      if (v.verdict && v.verdict.reason) {
        reasonEl.textContent = (v.verdict.label || v.verdict.match) + ' — ' + v.verdict.reason;
        reasonEl.style.display = '';
      } else {
        reasonEl.textContent = '';
        reasonEl.style.display = 'none';
      }
      var poster = previewBackdrop.querySelector('.un-forge-preview-poster');
      wireThumbImg(poster, v);
      var frameWrap = previewBackdrop.querySelector('.un-forge-preview-frame');
      frameWrap.textContent = '';
      var iframe = document.createElement('iframe');
      iframe.src = 'https://www.youtube.com/embed/' + id + '?autoplay=0&rel=0';
      iframe.title = v.title || 'Video preview';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      frameWrap.appendChild(iframe);
      var openLink = previewBackdrop.querySelector('.un-forge-preview-open');
      openLink.href = v.url || 'https://www.youtube.com/watch?v=' + id;
      previewBackdrop.classList.add('on');
      // This modal opens on top of the Forge panel, which is already on the
      // shared LIFO escape stack. A raw document listener here meant one
      // Escape closed the preview AND the panel underneath it. Going through
      // the stack closes only the topmost.
      if (previewEscHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
        window.UNSYNTH.popPanel(previewEscHandle);
        previewEscHandle = null;
      }
      if (window.UNSYNTH && window.UNSYNTH.pushPanel) {
        previewEscHandle = window.UNSYNTH.pushPanel(closePreview);
      } else {
        previewKeyHandler = function (e) {
          if (e.key === 'Escape') closePreview();
        };
        document.addEventListener('keydown', previewKeyHandler);
      }
      previewReturnFocus = document.activeElement;
      try { previewBackdrop.querySelector('.un-forge-preview-open').focus(); } catch (e) { /* ignore */ }
    }

    function openPlaylistMenu(wrap, videoId) {
      if (!wrap || !videoId) return;
      var menu = wrap.querySelector('.un-forge-s-plmenu');
      if (!menu) return;
      if (openPlMenu === menu) {
        closePlMenus();
        return;
      }
      closePlMenus();
      menu.textContent = '';
      menu.classList.add('on');
      openPlMenu = menu;
      // menu.textContent = '' above only clears CHILDREN — a listener on menu
      // itself survives every reopen, and this ran on every single
      // openPlaylistMenu() call with no matching removeEventListener. `menu`
      // is the persistent node created once in mount() (never recreated), so
      // reopening this control N times stacked N identical listeners. Each
      // only calls stopPropagation() (idempotent), so no double-firing bug —
      // but it's a real, unbounded leak. Guard so it's only ever attached once.
      if (!menu.dataset.unStopPropBound) {
        menu.dataset.unStopPropBound = '1';
        menu.addEventListener('click', function (e) {
          e.stopPropagation();
        });
      }

      var canWrite = deps.canWrite ? deps.canWrite() : false;
      var wl = el('button', 'un-forge-s-plopt' + (canWrite ? '' : ' disabled'), 'Watch Later');
      wl.type = 'button';
      if (!canWrite) wl.title = 'Connect YouTube with write access';
      wl.disabled = !canWrite;
      wl.addEventListener('click', function () {
        if (!canWrite) return;
        closePlMenus();
        if (deps.addToWatchLater) deps.addToWatchLater(videoId);
      });
      menu.appendChild(wl);

      var playlistState = deps.getPlaylistState ? deps.getPlaylistState() : null;
      var pls = playlistState ? playlistState.items : deps.getPlaylists ? deps.getPlaylists() : [];
      if ((!playlistState || !playlistState.loaded) && !(playlistState && playlistState.loading) && deps.ensurePlaylists) {
        menu.appendChild(el('span', 'un-forge-s-plload', 'Loading playlists…'));
        deps.ensurePlaylists().then(function () {
          if (openPlMenu !== menu) return;
          openPlMenu = null;
          openPlaylistMenu(wrap, videoId);
        });
        return;
      }
      if (playlistState && playlistState.loading) {
        menu.appendChild(el('span', 'un-forge-s-plload', 'Loading playlists.'));
        return;
      }
      if (playlistState && playlistState.error) {
        menu.appendChild(el('span', 'un-forge-s-plload', playlistState.errorMessage || "Couldn't load playlists"));
        var retry = el('button', 'un-forge-s-plopt', 'Retry playlists');
        retry.type = 'button';
        retry.addEventListener('click', function () {
          deps.ensurePlaylists().then(function () {
            if (openPlMenu !== menu) return;
            openPlMenu = null;
            openPlaylistMenu(wrap, videoId);
          });
        });
        menu.appendChild(retry);
        return;
      }
      if (!pls.length) {
        menu.appendChild(el('span', 'un-forge-s-plload', 'No YouTube playlists found'));
        return;
      }
      pls.slice(0, 20).forEach(function (pl) {
        var b = el('button', 'un-forge-s-plopt', pl.title + (pl.count ? ' (' + pl.count + ')' : ''));
        b.type = 'button';
        b.addEventListener('click', function () {
          closePlMenus();
          if (deps.addToPlaylist) deps.addToPlaylist(pl.id, videoId);
        });
        menu.appendChild(b);
      });
    }

    function openBulkPlaylistMenu(wrap) {
      if (!wrap) return;
      var menu = wrap.querySelector('.un-forge-s-plmenu');
      if (!menu) return;
      var picked = getPickedIds();
      if (!picked.length) {
        setStatus('Select videos first.', 'err');
        return;
      }
      if (openBulkPlMenu === menu) {
        closePlMenus();
        return;
      }
      closePlMenus();
      menu.textContent = '';
      menu.classList.add('on');
      openBulkPlMenu = menu;
      // Same unbounded-listener-stacking issue as openPlaylistMenu() above,
      // on this menu's own persistent node — see that comment for detail.
      if (!menu.dataset.unStopPropBound) {
        menu.dataset.unStopPropBound = '1';
        menu.addEventListener('click', function (e) {
          e.stopPropagation();
        });
      }

      var canWrite = deps.canWrite ? deps.canWrite() : false;
      var wl = el('button', 'un-forge-s-plopt' + (canWrite ? '' : ' disabled'), 'Watch Later');
      wl.type = 'button';
      if (!canWrite) wl.title = 'Connect YouTube with write access';
      wl.disabled = !canWrite;
      wl.addEventListener('click', function () {
        if (!canWrite) return;
        closePlMenus();
        if (deps.addManyToWatchLater) deps.addManyToWatchLater(picked);
      });
      menu.appendChild(wl);

      var playlistState = deps.getPlaylistState ? deps.getPlaylistState() : null;
      var pls = playlistState ? playlistState.items : deps.getPlaylists ? deps.getPlaylists() : [];
      if ((!playlistState || !playlistState.loaded) && !(playlistState && playlistState.loading) && deps.ensurePlaylists) {
        menu.appendChild(el('span', 'un-forge-s-plload', 'Loading playlists…'));
        deps.ensurePlaylists().then(function () {
          if (openBulkPlMenu !== menu) return;
          openBulkPlMenu = null;
          openBulkPlaylistMenu(wrap);
        });
        return;
      }
      if (playlistState && playlistState.loading) {
        menu.appendChild(el('span', 'un-forge-s-plload', 'Loading playlists.'));
        return;
      }
      if (playlistState && playlistState.error) {
        menu.appendChild(el('span', 'un-forge-s-plload', playlistState.errorMessage || "Couldn't load playlists"));
        var retry = el('button', 'un-forge-s-plopt', 'Retry playlists');
        retry.type = 'button';
        retry.addEventListener('click', function () {
          deps.ensurePlaylists().then(function () {
            if (openBulkPlMenu !== menu) return;
            openBulkPlMenu = null;
            openBulkPlaylistMenu(wrap);
          });
        });
        menu.appendChild(retry);
        return;
      }
      if (!pls.length) {
        menu.appendChild(el('span', 'un-forge-s-plload', 'No YouTube playlists found'));
        return;
      }
      pls.slice(0, 20).forEach(function (pl) {
        var b = el('button', 'un-forge-s-plopt', pl.title + (pl.count ? ' (' + pl.count + ')' : ''));
        b.type = 'button';
        b.addEventListener('click', function () {
          closePlMenus();
          if (deps.addToPlaylist) deps.addToPlaylist(pl.id, picked);
        });
        menu.appendChild(b);
      });
    }

    function renderQueueBar() {
      var bar = root.querySelector('#un-forge-search-queuebar');
      if (!bar || !window.UNWatchQueue) return;
      window.UNWatchQueue.load(function (list) {
        var info = bar.querySelector('#un-forge-search-queueinfo');
        if (info) info.textContent = list.length ? list.length + ' video' + (list.length === 1 ? '' : 's') : 'Empty';
        bar.style.display = list.length ? 'flex' : 'none';
      });
    }

    function playQueueNext() {
      if (!window.UNWatchQueue) return;
      window.UNWatchQueue.load(function (list) {
        if (!list.length) {
          setStatus('Queue is empty.', 'err');
          return;
        }
        var next = list[0];
        window.UNWatchQueue.remove(next.id, function () {
          renderQueueBar();
        });
        if (deps.openUrl) deps.openUrl('https://www.youtube.com/watch?v=' + next.id);
        else location.assign('/watch?v=' + next.id);
      });
    }

    function setStatus(msg, kind) {
      if (deps.setStatus) deps.setStatus(msg, kind);
    }

    function btnLoading(btn, on, label) {
      if (deps.btnLoading) deps.btnLoading(btn, on, label);
    }

    function openUrl(url) {
      if (deps.openUrl) deps.openUrl(url);
    }

    function getPrefs() {
      return deps.getPrefs ? deps.getPrefs() : { count: 25, privacy: 'public' };
    }

    function idsInMap() {
      return Object.keys(candMap);
    }

    function loadTasteData(cb) {
      chrome.storage.local.get(['watchStats', 'watchedVideos'], function (d) {
        cb({
          watchStats: d.watchStats || null,
          watchedIds: d.watchedVideos || []
        });
      });
    }

    function tasteFromForm(fields, tasteData) {
      var tp = deps.getTastePrefs ? deps.getTastePrefs() : {};
      return FD.buildTastePayload({
        excludeWatched: fields.excludewatched != null ? fields.excludewatched : tp.excludeWatched !== false,
        boostChannels: fields.boostchannels != null ? fields.boostchannels : tp.boostChannels === true,
        excludeAI: fields.excludeai != null ? fields.excludeai : tp.excludeAI !== false,
        watchedIds: tasteData.watchedIds,
        watchStats: tasteData.watchStats,
        customAvoidChannelNames: tp.customAvoidChannels || []
      });
    }

    function saveLastSearch(fields) {
      var p = Object.assign({}, getPrefs(), { lastSearch: fields });
      if (deps.onPrefsChange) deps.onPrefsChange(p);
    }

    function loadSaved(cb) {
      chrome.storage.local.get({ forgeSavedSearches: [] }, function (d) {
        cb(d.forgeSavedSearches || []);
      });
    }

    function renderSavedPicker() {
      var sel = root && root.querySelector('#un-forge-search-saved');
      if (!sel) return;
      loadSaved(function (arr) {
        var cur = sel.value;
        sel.textContent = '';
        sel.appendChild(el('option', '', 'Saved searches…'));
        arr.forEach(function (item, i) {
          var opt = el('option', '', item.name);
          opt.value = String(i);
          sel.appendChild(opt);
        });
        if (cur) sel.value = cur;
      });
    }

    async function apiDiscover(request, overrides, taste, exclude) {
      var body = { request: request, overrides: overrides, taste: taste };
      if (exclude && exclude.length) body.exclude = exclude;
      // Serve a recent identical request from cache (instant, no re-judge). The
      // exclude list grows on "Find more", so paginated calls never false-hit.
      var key = JSON.stringify(body);
      pruneDiscoverCache();
      var hit = _discoverCache[key];
      if (hit && Date.now() - hit.at < DISCOVER_TTL) return hit.data;
      // Proxied through the SW (content scripts can't fetch playlist-forge — CORS).
      var res = await forgeFetch('/api/discover', { method: 'POST', body: body });
      if (!res || !res.ok) throw new Error(forgeErrorText(res, 'discover_failed'));
      pruneDiscoverCache();
      _discoverCache[key] = { data: res.data, at: Date.now() };
      return res.data;
    }

    async function apiJudge(request, videos) {
      var res = await forgeFetch('/api/judge', { method: 'POST', body: { request: request, videos: videos } });
      if (!res || !res.ok) throw new Error(forgeErrorText(res, 'judge_failed'));
      return (res.data && res.data.verdicts) || [];
    }

    function showSkeleton(n) {
      var box = root.querySelector('#un-forge-search-results');
      if (!box) return;
      box.textContent = '';
      for (var i = 0; i < (n || 6); i++) {
        var sk = el('div', 'un-forge-skel-card');
        sk.appendChild(el('div', 'un-forge-skel-thumb'));
        sk.appendChild(el('div', 'un-forge-skel-lines'));
        box.appendChild(sk);
      }
      root.querySelector('#un-forge-search-plan').style.display = 'none';
      root.querySelector('#un-forge-search-summary').style.display = 'none';
      root.querySelector('#un-forge-search-gradebar').className = 'un-forge-gradebar';
      root.querySelector('#un-forge-search-resultctl').style.display = 'none';
      root.querySelector('#un-forge-search-selbar').style.display = 'none';
      root.querySelector('#un-forge-search-build').style.display = 'none';
    }

    function showPlan(plan) {
      var p = root.querySelector('#un-forge-search-plan');
      p.textContent = '';
      if (!plan) {
        p.style.display = 'none';
        return;
      }
      var f = plan.filters || {};
      var row1 = el('div', 'un-forge-plan-row');
      row1.appendChild(el('span', 'un-forge-chip plabel', 'looking for'));
      row1.appendChild(el('span', 'un-forge-chip tag', FD.RANK_LABELS[plan.rank] || plan.rank || 'auto'));
      row1.appendChild(el('span', 'un-forge-chip badge', 'up to ' + plan.count));
      if (f.maxDurationSec) row1.appendChild(el('span', 'un-forge-chip badge', '≤ ' + Math.round(f.maxDurationSec / 60) + ' min'));
      if (f.minDurationSec) row1.appendChild(el('span', 'un-forge-chip badge', '≥ ' + Math.round(f.minDurationSec / 60) + ' min'));
      if (f.publishedAfter) row1.appendChild(el('span', 'un-forge-chip badge', 'after ' + String(f.publishedAfter).slice(0, 10)));
      if (f.publishedBefore) row1.appendChild(el('span', 'un-forge-chip badge', 'before ' + String(f.publishedBefore).slice(0, 10)));
      if (f.excludeAI) row1.appendChild(el('span', 'un-forge-chip badge', 'no AI'));
      if (f.maxChannelSubs) row1.appendChild(el('span', 'un-forge-chip badge', '≤ ' + FD.formatCount(f.maxChannelSubs) + ' subs'));
      p.appendChild(row1);
      var row2 = el('div', 'un-forge-plan-row');
      row2.appendChild(el('span', 'un-forge-chip plabel', 'searched'));
      (plan.searchQueries || []).forEach(function (q) {
        var pill = el('span', 'un-forge-chip qpill');
        pill.appendChild(el('span', 'qn', q));
        row2.appendChild(pill);
      });
      p.appendChild(row2);
      p.style.display = 'block';
    }

    function showSummary(stats, returned) {
      var s = root.querySelector('#un-forge-search-summary');
      var line = FD.summaryLine(stats, returned);
      if (hiddenByUserFilter > 0) {
        line = (line ? line + ' · ' : '') + 'hid ' + hiddenByUserFilter + ' from blocked / AI-filtered channels';
      }
      s.textContent = line;
      s.style.display = line ? 'block' : 'none';
    }

    function defaultChecked(v) {
      if (!v.verdict) return true;
      return v.verdict.match !== 'off';
    }

    function thumbActBtn(icon, title, onClick) {
      var b = el('button', 'un-forge-s-tact');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.textContent = icon;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        closePlMenus();
        onClick();
      });
      return b;
    }

    function renderCard(v) {
      var id = FD.videoIdOf(v);
      var card = el('div', 'un-forge-s-card');
      card.dataset.id = id;
      card.dataset.dur = String(v.durationSec || 0);
      if (v.verdict && v.verdict.match === 'off') card.classList.add('offtopic');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'un-forge-s-pick';
      cb.checked = defaultChecked(v);
      cb.addEventListener('change', updateSelBar);

      var tw = el('div', 'un-forge-s-thumbwrap');
      var img = el('img', 'un-forge-s-thumb');
      img.loading = 'lazy';
      wireThumbImg(img, v);
      var shade = el('div', 'un-forge-s-thumbshade');
      var thumbActs = el('div', 'un-forge-s-thumbacts');
      thumbActs.appendChild(
        thumbActBtn('▶', 'Preview in panel', function () {
          showPreview(v);
        })
      );
      // No "Play next" here. YouTube's queue is append-only from an extension:
      // measured live 2026-09-15, a queue row's action menu offers exactly two
      // items, "Remove from playlist" and "Share" — no front-insert, no reorder.
      // The button shipped anyway and ran the IDENTICAL append command as
      // "Add to queue", so the two controls differed only in their label.
      //
      // (The queue BAR's "Play next" is a different thing and still exists: it
      // pops the extension's own queue and navigates to that video, which works.)
      thumbActs.appendChild(
        thumbActBtn('+Q', 'Add to queue', function () {
          if (deps.addToQueue) deps.addToQueue(v, { toFront: false });
        })
      );
      var plWrap = el('div', 'un-forge-s-plwrap');
      var plBtn = thumbActBtn('⊕', 'Add to a playlist', function () {
        openPlaylistMenu(plWrap, id);
      });
      plWrap.append(plBtn, el('div', 'un-forge-s-plmenu'));
      thumbActs.appendChild(plWrap);
      tw.appendChild(img);
      tw.appendChild(shade);
      tw.appendChild(thumbActs);
      tw.appendChild(cb);
      if (v.durationSec) {
        tw.appendChild(el('span', 'un-forge-s-dur', FD.formatDur(v.durationSec)));
      }
      var gradeEl = el('span', 'un-forge-s-grade');
      if (v.grade) {
        gradeEl.textContent = v.grade.letter;
        gradeEl.classList.add('g' + v.grade.letter);
        gradeEl.style.display = '';
      } else {
        gradeEl.style.display = 'none';
      }
      tw.appendChild(gradeEl);
      tw.addEventListener('click', function (e) {
        if (e.target === cb || e.target.closest('.un-forge-s-tact, .un-forge-s-plmenu, .un-forge-s-pick')) return;
        e.preventDefault();
        openUrl(v.url || ('https://www.youtube.com/watch?v=' + id));
      });

      var body = el('div', 'un-forge-s-body');
      var meta = el('div', 'un-forge-s-meta');
      meta.appendChild(el('div', 'un-forge-s-title', v.title || id));
      meta.appendChild(el('div', 'un-forge-s-sub', statsLine(v)));
      var verdictRow = el('div', 'un-forge-s-verdict');
      if (v.verdict) {
        verdictRow.appendChild(
          el('span', 'un-forge-vmatch ' + v.verdict.match, v.verdict.label || v.verdict.match)
        );
        if (v.verdict.reason) verdictRow.appendChild(el('span', 'un-forge-vreason', v.verdict.reason));
      } else {
        verdictRow.appendChild(el('span', 'un-forge-vpending', 'Judging…'));
      }
      meta.appendChild(verdictRow);
      body.appendChild(meta);

      var rm = el('button', 'un-forge-s-rm', '×');
      rm.type = 'button';
      rm.title = 'Remove';
      rm.setAttribute('aria-label', rm.title);
      rm.addEventListener('click', function () {
        delete candMap[id];
        cardOrder = cardOrder.filter(function (x) {
          return x !== id;
        });
        card.remove();
        renderVerdictBar();
        renderGradeBar();
        updateSelBar();
      });
      body.appendChild(rm);

      card.append(tw, body);
      return card;
    }

    function renderResults(append) {
      var box = root.querySelector('#un-forge-search-results');
      if (!append) box.textContent = '';
      if (!cardOrder.length && !append) {
        box.appendChild(
          el(
            'p',
            'un-forge-empty',
            hiddenByUserFilter > 0
              ? 'All ' + hiddenByUserFilter + ' results were from channels you block or filter. Loosen your filters or try a different query.'
              : 'No videos found for that query.'
          )
        );
        return;
      }
      var ids = append ? cardOrder.slice(-(cardOrder.length - (append._startLen || 0))) : cardOrder;
      if (append && append._newIds) ids = append._newIds;
      ids.forEach(function (id) {
        var v = candMap[id];
        if (!v) return;
        box.appendChild(renderCard(v));
      });
      root.querySelector('#un-forge-search-resultctl').style.display = cardOrder.length ? 'flex' : 'none';
      root.querySelector('#un-forge-search-selbar').style.display = cardOrder.length ? 'flex' : 'none';
      root.querySelector('#un-forge-search-build').style.display = cardOrder.length ? 'block' : 'none';
      renderVerdictBar();
      renderGradeBar();
      updateSelBar();
      applyFilter();
    }

    function mergeCandidates(candidates, append) {
      var newIds = [];
      var startLen = cardOrder.length;
      if (!append) hiddenByUserFilter = 0;
      (candidates || []).forEach(function (v) {
        var id = FD.videoIdOf(v);
        if (!id || candMap[id]) return;
        var norm = FD.normalizeCandidate(v);
        if (isFilteredOut(norm)) { hiddenByUserFilter++; return; }
        candMap[id] = norm;
        cardOrder.push(id);
        newIds.push(id);
      });
      if (append) {
        renderResults({ _newIds: newIds, _startLen: startLen });
      } else {
        renderResults(false);
      }
      return newIds;
    }

    function judgeNew(request, ids) {
      var videos = ids
        .map(function (id) {
          return candMap[id];
        })
        .filter(Boolean)
        .map(function (v) {
          return {
            id: FD.videoIdOf(v),
            title: v.title,
            channelTitle: v.channelTitle,
            durationSec: v.durationSec,
            viewCount: v.viewCount,
            likeCount: v.likeCount
          };
        });
      if (!videos.length) return Promise.resolve();
      judgePromise = apiJudge(request, videos)
        .then(function (verdicts) {
          var updated = FD.applyVerdicts(
            videos.map(function (vv) {
              return candMap[vv.id];
            }),
            verdicts
          );
          updated.forEach(function (v) {
            var id = FD.videoIdOf(v);
            candMap[id] = Object.assign({}, candMap[id], v);
            var card = root.querySelector('.un-forge-s-card[data-id="' + id + '"]');
            if (!card) return;
            var pick = card.querySelector('.un-forge-s-pick');
            if (pick && v.verdict) {
              pick.checked = defaultChecked(v);
              if (v.verdict.match === 'off') card.classList.add('offtopic');
            }
            var gradeEl = card.querySelector('.un-forge-s-grade');
            if (gradeEl && v.grade) {
              gradeEl.textContent = v.grade.letter;
              gradeEl.className = 'un-forge-s-grade g' + v.grade.letter;
              gradeEl.style.display = '';
            }
            var verdictRow = card.querySelector('.un-forge-s-verdict');
            if (verdictRow && v.verdict) {
              verdictRow.textContent = '';
              verdictRow.appendChild(el('span', 'un-forge-vmatch ' + v.verdict.match, v.verdict.label || v.verdict.match));
              if (v.verdict.reason) verdictRow.appendChild(el('span', 'un-forge-vreason', v.verdict.reason));
            }
          });
          renderVerdictBar();
          renderGradeBar();
          updateSelBar();
          applyFilter();
        })
        .catch(function () {
          ids.forEach(function (id) {
            var row = root.querySelector('.un-forge-s-card[data-id="' + id + '"] .un-forge-vpending');
            if (row) row.textContent = 'Judge unavailable';
          });
        });
      return judgePromise;
    }

    function renderVerdictBar() {
      var bar = root.querySelector('#un-forge-search-verdictbar');
      bar.textContent = '';
      var c = { all: cardOrder.length, good: 0, weak: 0, off: 0 };
      cardOrder.forEach(function (id) {
        var v = candMap[id];
        if (!v || !v.verdict) return;
        if (v.verdict.match === 'good') c.good++;
        else if (v.verdict.match === 'weak') c.weak++;
        else if (v.verdict.match === 'off') c.off++;
      });
      [
        ['all', 'All', c.all],
        ['good', '✓ Good', c.good],
        ['weak', '~ Loose', c.weak],
        ['off', '✗ Off', c.off]
      ].forEach(function (ch) {
        var b = el('button', 'un-forge-vchip' + (filterMode === ch[0] ? ' on' : ''), ch[1] + ' ' + ch[2]);
        b.type = 'button';
        b.addEventListener('click', function () {
          filterMode = ch[0];
          applyFilter();
          renderVerdictBar();
        });
        bar.appendChild(b);
      });
    }

    function renderGradeBar() {
      var gb = root.querySelector('#un-forge-search-gradebar');
      gb.textContent = '';
      var order = ['A', 'B', 'C', 'D', 'F'];
      var counts = { A: 0, B: 0, C: 0, D: 0, F: 0 };
      var total = 0;
      cardOrder.forEach(function (id) {
        var g = candMap[id] && candMap[id].grade && candMap[id].grade.letter;
        if (counts[g] != null) {
          counts[g]++;
          total++;
        }
      });
      if (!total) {
        gb.className = 'un-forge-gradebar';
        return;
      }
      var track = el('div', 'un-forge-gb-track');
      order.forEach(function (g) {
        if (!counts[g]) return;
        var i = el('i', 'un-forge-gb-seg g' + g);
        i.style.width = (counts[g] / total) * 100 + '%';
        i.title = counts[g] + ' graded ' + g;
        i.addEventListener('click', function () {
          gradeFilter = gradeFilter === g ? null : g;
          applyFilter();
        });
        track.appendChild(i);
      });
      var legend = el('div', 'un-forge-gb-legend');
      order.forEach(function (g) {
        if (!counts[g]) return;
        var span = el('span', '');
        span.appendChild(el('span', 'un-forge-gb-dot g' + g));
        span.appendChild(el('b', '', String(counts[g])));
        span.appendChild(document.createTextNode(' ' + g));
        legend.appendChild(span);
      });
      gb.appendChild(track);
      gb.appendChild(legend);
      gb.className = 'un-forge-gradebar show';
    }

    function applyFilter() {
      root.querySelectorAll('.un-forge-s-card').forEach(function (card) {
        var id = card.dataset.id;
        var v = candMap[id];
        var show = filterMode === 'all';
        if (!show && v && v.verdict) show = v.verdict.match === filterMode;
        if (show && gradeFilter && v && v.grade) show = v.grade.letter === gradeFilter;
        card.style.display = show ? '' : 'none';
      });
      updateSelBar();
    }

    function applySort() {
      var mode = root.querySelector('#un-forge-search-sort').value;
      cardOrder = FD.sortCandidates(cardOrder, mode, candMap);
      var box = root.querySelector('#un-forge-search-results');
      cardOrder.forEach(function (id) {
        var card = box.querySelector('.un-forge-s-card[data-id="' + id + '"]');
        if (card) box.appendChild(card);
      });
    }

    function updateSelBar() {
      var cards = Array.prototype.slice.call(root.querySelectorAll('.un-forge-s-card'));
      var visible = cards.filter(function (c) {
        return c.style.display !== 'none';
      });
      var checked = visible.filter(function (c) {
        var p = c.querySelector('.un-forge-s-pick');
        return p && p.checked;
      });
      var secs = checked.reduce(function (n, c) {
        return n + (Number(c.dataset.dur) || 0);
      }, 0);
      var info = root.querySelector('#un-forge-search-selinfo');
      if (info) {
        info.innerHTML = '<b>' + checked.length + '</b> of ' + visible.length + ' selected · <b>~' + Math.round(secs / 60) + '</b> min';
      }
      var createBtn = root.querySelector('#un-forge-search-create');
      if (createBtn) createBtn.textContent = 'Create on YouTube (' + checked.length + ')';
    }

    function getPickedIds() {
      var ids = [];
      root.querySelectorAll('.un-forge-s-card').forEach(function (card) {
        if (card.style.display === 'none') return;
        var pick = card.querySelector('.un-forge-s-pick');
        if (pick && pick.checked) ids.push(card.dataset.id);
      });
      return ids;
    }

    function getTitle() {
      var t = root.querySelector('#un-forge-search-title');
      var r = root.querySelector('#un-forge-search-req');
      var title = t ? t.value.trim() : '';
      var req = r ? r.value.trim() : '';
      return (title || req || 'Playlist').slice(0, 150);
    }

    function buildExcludeList(append) {
      var exclude = append ? idsInMap().slice() : [];
      forcedExclude.forEach(function (id) {
        if (id && exclude.indexOf(id) === -1) exclude.push(id);
      });
      return exclude.length ? exclude : null;
    }

    async function runDiscover(append, opts) {
      opts = opts || {};
      if (!append && !opts.keepExclude) forcedExclude = [];
      var fields = FD.readFormFields(root);
      var request = fields.request.trim();
      if (!request) {
        setStatus('Enter a search query first.', 'err');
        return;
      }
      lastRequest = request;
      saveLastSearch(fields);
      var btn = root.querySelector('#un-forge-search-go');
      if (!append) {
        btnLoading(btn, true, 'Discovering…');
        setStatus('Thinking about what you want…');
        showSkeleton(6);
        candMap = {};
        cardOrder = [];
        filterMode = 'all';
        gradeFilter = null;
      } else {
        btn = root.querySelector('#un-forge-search-findmore');
        btnLoading(btn, true, 'Finding…');
      }
      var overrides = FD.buildOverrides(fields);
      try {
        var tasteData = await new Promise(function (resolve) {
          loadTasteData(resolve);
        });
        var taste = tasteFromForm(fields, tasteData);
        var data = await apiDiscover(request, overrides, taste, buildExcludeList(append));
        var discovered = FD.extractDiscoverCandidates(data);
        if (!append) showPlan(data.plan);
        if (data.note) setStatus(data.note, 'warn');
        else if (!discovered.length) {
          var allFailed =
            data.stats &&
            data.stats.perQuery &&
            data.stats.perQuery.length &&
            data.stats.perQuery.every(function (q) {
              return q.error;
            });
          var filterHint =
            fields.excludewatched && tasteData.watchedIds && tasteData.watchedIds.length > 2000
              ? ' Try unchecking Exclude watched in Advanced filters.'
              : '';
          setStatus(
            allFailed
              ? 'All searches failed — YouTube API quota may be used up.'
              : 'No videos matched. Loosen filters or reword the request.' + filterHint,
            'err'
          );
        } else {
          setStatus((append ? 'Added ' : '') + discovered.length + ' videos.', 'ok');
        }
        var titleIn = root.querySelector('#un-forge-search-title');
        if (titleIn && !titleIn.value.trim()) titleIn.value = request.slice(0, 60);
        var candidates = discovered.filter(function (v) {
          var id = FD.videoIdOf(v);
          return !forcedExclude.length || forcedExclude.indexOf(id) === -1;
        });
        var newIds = mergeCandidates(candidates, !!append);
        showSummary(data.stats, discovered.length);
        if (!append && !newIds.length && discovered.length && hiddenByUserFilter) {
          setStatus('All ' + hiddenByUserFilter + ' results were from blocked or AI-filtered channels — loosen your filters.', 'warn');
        }
        if (newIds.length) judgeNew(request, newIds);
      } catch (e) {
        setStatus((e && e.message) || 'Discover failed — try again.', 'err');
        if (!append) root.querySelector('#un-forge-search-results').textContent = '';
      }
      if (!append) btnLoading(root.querySelector('#un-forge-search-go'), false, 'Discover');
      else btnLoading(root.querySelector('#un-forge-search-findmore'), false, '+ Find more');
    }

    function mount(sectionEl) {
      root = el('div', 'un-forge-search-root');

      var ta = el('textarea', 'un-forge-search-req');
      ta.id = 'un-forge-search-req';
      ta.placeholder = 'e.g. obscure but genuinely good synthwave from 2015–2018, under 5 minutes, no AI-generated stuff';
      ta.rows = 3;
      root.appendChild(ta);

      var ctrl = el('div', 'un-forge-search-ctrl');
      function lbl(text, child) {
        var L = el('label', 'un-forge-search-ctl');
        L.appendChild(el('span', '', text));
        L.appendChild(child);
        return L;
      }
      var rank = el('select', '');
      rank.id = 'un-forge-search-rank';
      ['', 'hidden_gem', 'top', 'newest', 'relevance'].forEach(function (v) {
        var opt = el('option', '', v ? FD.RANK_LABELS[v] : 'auto');
        opt.value = v;
        rank.appendChild(opt);
      });
      var count = el('input', '');
      count.id = 'un-forge-search-count';
      count.type = 'number';
      count.min = '1';
      count.max = '100';
      count.placeholder = 'auto';
      count.style.width = '70px';
      var maxmin = el('input', '');
      maxmin.id = 'un-forge-search-maxmin';
      maxmin.type = 'number';
      maxmin.min = '0';
      maxmin.placeholder = 'any';
      maxmin.style.width = '70px';
      var go = el('button', 'un-forge-btn primary', 'Discover');
      go.type = 'button';
      go.id = 'un-forge-search-go';
      go.addEventListener('click', function () {
        runDiscover(false);
      });
      ctrl.append(lbl('Rank', rank), lbl('Count', count), lbl('Max min', maxmin), go);
      root.appendChild(ctrl);

      var adv = el('details', 'un-forge-search-adv');
      adv.appendChild(el('summary', '', 'Advanced filters'));
      var advInner = el('div', 'un-forge-search-ctrl');
      function mkInput(id, ph) {
        var inp = el('input', '');
        inp.id = id;
        inp.placeholder = ph || 'any';
        inp.style.width = '80px';
        return inp;
      }
      var exAi = document.createElement('input');
      exAi.type = 'checkbox';
      exAi.id = 'un-forge-search-excludeai';
      exAi.checked = true;
      var exW = document.createElement('input');
      exW.type = 'checkbox';
      exW.id = 'un-forge-search-excludewatched';
      exW.checked = true;
      var boost = document.createElement('input');
      boost.type = 'checkbox';
      boost.id = 'un-forge-search-boostchannels';
      boost.checked = false;
      advInner.append(
        lbl('After', mkInput('un-forge-search-pubafter', '2015')),
        lbl('Before', mkInput('un-forge-search-pubbefore', '2020')),
        lbl('Min min', mkInput('un-forge-search-minmin')),
        lbl('Max subs', mkInput('un-forge-search-maxsubs')),
        lbl('Exclude AI', exAi),
        lbl('Exclude watched', exW),
        lbl('Boost my channels', boost)
      );
      adv.appendChild(advInner);
      root.appendChild(adv);

      var savedRow = el('div', 'un-forge-search-saved-row');
      var saveBtn = el('button', 'un-forge-btn ghost', '★ Save');
      saveBtn.type = 'button';
      saveBtn.addEventListener('click', function () {
        var name = prompt('Name this search');
        if (!name || !name.trim()) return;
        var fields = FD.readFormFields(root);
        loadSaved(function (arr) {
          arr.unshift({
            name: name.trim(),
            fields: fields,
            savedAt: Date.now()
          });
          if (arr.length > MAX_SAVED) arr.length = MAX_SAVED;
          chrome.storage.local.set({ forgeSavedSearches: arr }, renderSavedPicker);
        });
      });
      var savedSel = el('select', 'un-forge-search-saved-pick');
      savedSel.id = 'un-forge-search-saved';
      savedSel.addEventListener('change', function () {
        if (!savedSel.value) return;
        loadSaved(function (arr) {
          var item = arr[Number(savedSel.value)];
          if (item && item.fields) FD.applyFormFields(root, item.fields);
          savedSel.value = '';
        });
      });
      var delSaved = el('button', 'un-forge-btn ghost', '×');
      delSaved.type = 'button';
      delSaved.title = 'Delete selected saved search';
      delSaved.setAttribute('aria-label', delSaved.title);
      delSaved.addEventListener('click', function () {
        if (!savedSel.value) return;
        loadSaved(function (arr) {
          arr.splice(Number(savedSel.value), 1);
          chrome.storage.local.set({ forgeSavedSearches: arr }, renderSavedPicker);
          savedSel.value = '';
        });
      });
      savedRow.append(saveBtn, savedSel, delSaved);
      root.appendChild(savedRow);

      var plan = el('div', 'un-forge-search-plan');
      plan.id = 'un-forge-search-plan';
      root.appendChild(plan);
      var summary = el('div', 'un-forge-search-summary');
      summary.id = 'un-forge-search-summary';
      root.appendChild(summary);
      var gradebar = el('div', 'un-forge-gradebar');
      gradebar.id = 'un-forge-search-gradebar';
      root.appendChild(gradebar);

      var selbar = el('div', 'un-forge-search-selbar');
      selbar.id = 'un-forge-search-selbar';
      selbar.style.display = 'none';
      var selinfo = el('span', '');
      selinfo.id = 'un-forge-search-selinfo';
      selbar.appendChild(selinfo);
      var selAll = el('button', 'un-forge-btn ghost', 'Select all');
      selAll.type = 'button';
      selAll.addEventListener('click', function () {
        root.querySelectorAll('.un-forge-s-card').forEach(function (c) {
          if (c.style.display === 'none') return;
          var p = c.querySelector('.un-forge-s-pick');
          if (p) p.checked = true;
        });
        updateSelBar();
      });
      var selNone = el('button', 'un-forge-btn ghost', 'Clear');
      selNone.type = 'button';
      selNone.addEventListener('click', function () {
        root.querySelectorAll('.un-forge-s-pick').forEach(function (p) {
          p.checked = false;
        });
        updateSelBar();
      });
      var selQueue = el('button', 'un-forge-btn ghost', '+ Queue');
      selQueue.type = 'button';
      // Always appends (not "Play Next") — front-inserting a multi-select would
      // leave "which one plays next" ambiguous; appending preserves the order
      // you picked them in at the end of the queue.
      selQueue.title = 'Add selected videos to the end of your watch queue';
      selQueue.setAttribute('aria-label', selQueue.title);
      selQueue.addEventListener('click', function () {
        var picked = getPickedIds();
        if (!picked.length) {
          setStatus('Select videos first.', 'err');
          return;
        }
        var videos = picked
          .map(function (id) {
            return candMap[id];
          })
          .filter(Boolean);
        if (deps.addManyToQueue) deps.addManyToQueue(videos, { toFront: false });
      });
      selWl = el('button', 'un-forge-btn ghost', '+ Watch Later');
      selWl.type = 'button';
      selWl.title = 'Add selected videos to Watch Later';
      selWl.setAttribute('aria-label', selWl.title);
      selWl.addEventListener('click', function () {
        var picked = getPickedIds();
        if (!picked.length) {
          setStatus('Select videos first.', 'err');
          return;
        }
        if (deps.addManyToWatchLater) deps.addManyToWatchLater(picked);
      });
      var selPlWrap = el('div', 'un-forge-s-plwrap un-forge-sel-plwrap');
      var selPlBtn = el('button', 'un-forge-btn ghost', '+ Playlist');
      selPlBtn.type = 'button';
      selPlBtn.title = 'Add selected videos to a playlist';
      selPlBtn.setAttribute('aria-label', selPlBtn.title);
      selPlBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openBulkPlaylistMenu(selPlWrap);
      });
      var selPlMenu = el('div', 'un-forge-s-plmenu');
      selPlWrap.append(selPlBtn, selPlMenu);
      selbar.append(selAll, selNone, selQueue, selWl, selPlWrap);
      refreshWriteUi();
      root.appendChild(selbar);

      var resultctl = el('div', 'un-forge-search-resultctl');
      resultctl.id = 'un-forge-search-resultctl';
      resultctl.style.display = 'none';
      var verdictbar = el('div', 'un-forge-search-verdictbar');
      verdictbar.id = 'un-forge-search-verdictbar';
      resultctl.appendChild(verdictbar);
      var findmore = el('button', 'un-forge-btn', '+ Find more');
      findmore.type = 'button';
      findmore.id = 'un-forge-search-findmore';
      findmore.addEventListener('click', function () {
        runDiscover(true);
      });
      resultctl.appendChild(findmore);
      var sortLbl = el('label', 'un-forge-search-sortlbl', 'Sort');
      var sortSel = el('select', '');
      sortSel.id = 'un-forge-search-sort';
      [
        ['grade', 'best grade'],
        ['match', 'best match'],
        ['rank', 'discovery rank'],
        ['views', 'most views'],
        ['longest', 'longest'],
        ['shortest', 'shortest']
      ].forEach(function (pair) {
        var opt = el('option', '', pair[1]);
        opt.value = pair[0];
        sortSel.appendChild(opt);
      });
      sortSel.addEventListener('change', applySort);
      sortLbl.appendChild(sortSel);
      resultctl.appendChild(sortLbl);
      root.appendChild(resultctl);

      var queuebar = el('div', 'un-forge-search-queuebar');
      queuebar.id = 'un-forge-search-queuebar';
      queuebar.style.display = 'none';
      var qinfo = el('span', 'un-forge-search-queueinfo', 'Empty');
      qinfo.id = 'un-forge-search-queueinfo';
      queuebar.appendChild(el('span', 'un-forge-search-queuelbl', 'Queue'));
      queuebar.appendChild(qinfo);
      var playNext = el('button', 'un-forge-btn ghost', 'Play next');
      playNext.type = 'button';
      playNext.addEventListener('click', playQueueNext);
      var clearQ = el('button', 'un-forge-btn ghost', 'Clear');
      clearQ.type = 'button';
      clearQ.addEventListener('click', function () {
        if (window.UNWatchQueue) {
          window.UNWatchQueue.clear(function () {
            renderQueueBar();
            setStatus('Queue cleared.', 'ok');
          });
        }
      });
      var manageQ = el('button', 'un-forge-btn ghost', 'Manage ▸');
      manageQ.type = 'button';
      manageQ.title = 'Open the full queue viewer (reorder, remove, play any item)';
      manageQ.setAttribute('aria-label', manageQ.title);
      manageQ.addEventListener('click', function () {
        if (deps.showQueueTab) deps.showQueueTab();
      });
      queuebar.append(playNext, clearQ, manageQ);
      root.appendChild(queuebar);

      var results = el('div', 'un-forge-search-results');
      results.id = 'un-forge-search-results';
      root.appendChild(results);

      var build = el('div', 'un-forge-search-build');
      build.id = 'un-forge-search-build';
      build.style.display = 'none';
      var titleIn = el('input', 'un-forge-search-title');
      titleIn.id = 'un-forge-search-title';
      titleIn.type = 'text';
      titleIn.placeholder = 'Playlist title (optional)';
      build.appendChild(titleIn);
      var buildActs = el('div', 'un-forge-row un-forge-build-acts');
      var createBtn = el('button', 'un-forge-btn primary', 'Create on YouTube');
      createBtn.type = 'button';
      createBtn.id = 'un-forge-search-create';
      createBtn.addEventListener('click', function () {
        var ids = getPickedIds();
        if (!ids.length) {
          setStatus('Select videos first.', 'err');
          return;
        }
        btnLoading(createBtn, true);
        if (deps.buildOnYouTube) {
          deps
            .buildOnYouTube({ title: getTitle(), videoIds: ids })
            .catch(function (e) {
              setStatus(String(e), 'err');
            })
            .finally(function () {
              btnLoading(createBtn, false, 'Create on YouTube (' + ids.length + ')');
            });
        }
      });
      var plPick = el('select', 'un-forge-pl-pick');
      plPick.id = 'un-forge-search-pl-pick';
      plPick.addEventListener('change', function () {
        if (!plPick.value) return;
        var ids = getPickedIds();
        if (deps.addToPlaylist) deps.addToPlaylist(plPick.value, ids);
        plPick.value = '';
      });
      var forgeBtn = el('button', 'un-forge-btn ghost', 'Open on Forge ↗');
      forgeBtn.type = 'button';
      forgeBtn.addEventListener('click', function () {
        var fields = FD.readFormFields(root);
        if (deps.forgeBuildUrl) {
          openUrl(
            deps.forgeBuildUrl({
              title: getTitle(),
              q: fields.request,
              count: fields.count || getPrefs().count,
              videoIds: getPickedIds()
            })
          );
        }
      });
      buildActs.append(createBtn, plPick, forgeBtn);
      build.appendChild(buildActs);
      root.appendChild(build);

      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          runDiscover(false);
        }
      });

      if (docClickHandler) document.removeEventListener('click', docClickHandler);
      docClickHandler = function (e) {
        if (!root || !root.contains(e.target)) closePlMenus();
      };
      document.addEventListener('click', docClickHandler);

      if (queueChangeHandler && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.removeListener(queueChangeHandler);
      }
      queueChangeHandler = function (changes, area) {
        if (area !== 'local' || !changes.unWatchQueue) return;
        renderQueueBar();
      };
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener(queueChangeHandler);
      }

      sectionEl.textContent = '';
      sectionEl.appendChild(el('h3', 'un-forge-h', 'Search & build'));
      sectionEl.appendChild(root);

      renderSavedPicker();
      renderQueueBar();
      if (deps.getPrefs) {
        var p = deps.getPrefs();
        if (p.lastSearch) FD.applyFormFields(root, p.lastSearch);
        if (p.count && count && !count.value) count.value = String(p.count);
      }

      return {
        getPickedIds: getPickedIds,
        setQuery: function (q) {
          var t = root.querySelector('#un-forge-search-req');
          if (t) t.value = q || '';
        },
        runDiscover: function () {
          return runDiscover(false);
        },
        runSimilar: function (videoId, title, channelTitle) {
          var FL = window.UNForgeLinks;
          var q =
            FL && FL.similarSearchQuery
              ? FL.similarSearchQuery(videoId, title, channelTitle)
              : 'Videos similar to ' + (title || videoId || 'this video');
          FD.applyFormFields(root, {
            request: q,
            title: (title || q).slice(0, 60)
          });
          forcedExclude = videoId ? [videoId] : [];
          return runDiscover(false, { keepExclude: true });
        },
        refreshPlaylistPicker: function () {
          if (deps.renderPlaylistPicker) deps.renderPlaylistPicker('un-forge-search-pl-pick');
        },
        refreshQueueBar: renderQueueBar,
        refreshWriteUi: refreshWriteUi,
        closePreview: closePreview,
        destroy: function () {
          closePreview();
          if (previewBackdrop) {
            previewBackdrop.remove();
            previewBackdrop = null;
          }
          if (docClickHandler) {
            document.removeEventListener('click', docClickHandler);
            docClickHandler = null;
          }
          if (queueChangeHandler && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.removeListener(queueChangeHandler);
            queueChangeHandler = null;
          }
          closePlMenus();
          root = null;
        }
      };
    }

    return { mount: mount };
  }

  window.UNForgeSearchPanel = { create: createPanel };
})();
