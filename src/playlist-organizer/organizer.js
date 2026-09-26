'use strict';

(function () {
  const state = {
    playlists: [],
    playlistsLoaded: false,
    playlistsError: '',
    open: new Map(),
    selected: new Map(),
    auth: null,
    pins: { ids: [], names: {} },
    folders: { folders: {}, names: {} },
    watched: new Set(),
    hideWatched: false,
    busy: false,
    playlistQuery: '',
    videoQuery: '',
    // { videoId: seconds }, filled in as columns open. Durations never change,
    // and the service worker caches them permanently, so this only ever grows
    // and a re-open costs nothing.
    durations: {}
  };
  const Lib = () => window.UNPlaylistLibrary || {};

  const $ = (id) => document.getElementById(id);
  const send = (type, extra) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (reply) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(reply || { ok: false, error: 'no_response' });
      });
    });

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  let noticeTimer = null;
  function notice(message, good) {
    const el = $('notice');
    clearTimeout(noticeTimer);
    el.textContent = message;
    el.classList.toggle('bad', good === false);
    el.hidden = !message;
    if (message) noticeTimer = setTimeout(() => { el.hidden = true; }, good === false ? 7000 : 4000);
  }

  function readableError(error) {
    const value = String(error || 'unknown_error');
    if (/not_authed|auth_expired|no_refresh_token|refresh_failed|yt_api_401/i.test(value)) return 'Your YouTube connection expired. Reconnect and try again.';
    if (/quota/i.test(value)) return 'The YouTube API quota is used up for today.';
    if (/forbidden|yt_api_403/i.test(value)) return 'YouTube refused that change. Reconnect with read + write access.';
    return value.replace(/^yt_api_/, 'YouTube API error ');
  }

  function playlistById(id) {
    return state.playlists.find((playlist) => playlist.id === id) || null;
  }

  function selectionKey(sourceId, itemId) {
    return sourceId + ':' + itemId;
  }

  function selectedRecords() {
    return Array.from(state.selected.values());
  }

  function hasWriteAccess() {
    // Write is a property OF a live connection. Checking scopeKeys against a
    // merely-stored token says yes for an expired grant, because the scopes it
    // was issued with are still listed on it.
    const AS = window.UNAuthState;
    if (AS) return AS.canWrite(state.auth);
    return !!(state.auth && state.auth.authed && state.auth.usable !== false
      && (state.auth.scopeKeys || []).includes('write'));
  }

  function setBusy(on, message) {
    state.busy = on;
    document.body.classList.toggle('busy', on);
    syncToolbar();
    if (message) notice(message, true);
  }

  function saveOpenPlaylists() {
    chrome.storage.local.set({ playlistOrganizerOpenIds: Array.from(state.open.keys()) });
  }

  async function loadPins() {
    const stored = await new Promise((resolve) => chrome.storage.local.get({
      plPins: { ids: [], names: {} },
      plFolderStore: { folders: {}, names: {} },
      watchedVideos: []
    }, resolve));
    state.pins = window.UNPlaylistFolders.normalizePins(stored.plPins);
    state.folders = stored.plFolderStore && stored.plFolderStore.folders
      ? stored.plFolderStore
      : { folders: {}, names: {} };
    state.watched = new Set(stored.watchedVideos || []);
    renderPinManager();
  }

  function isWatched(videoId) {
    return !!(videoId && state.watched.has(videoId));
  }

  function toggleWatched(videoId) {
    if (!videoId) return;
    if (state.watched.has(videoId)) state.watched.delete(videoId);
    else state.watched.add(videoId);
    chrome.storage.local.get({ watchedVideos: [] }, (d) => {
      const a = (d && d.watchedVideos) || [];
      const next = state.watched.has(videoId)
        ? (a.indexOf(videoId) === -1 ? a.concat([videoId]) : a)
        : a.filter((id) => id !== videoId);
      chrome.storage.local.set({ watchedVideos: next });
    });
    renderColumns();
  }

  function stalePinIds() {
    const live = new Set(state.playlists.map((playlist) => playlist.id));
    return state.pins.ids.filter((id) => !live.has(id));
  }

  function renderPinManager() {
    const section = $('pin-manager');
    const root = $('pin-list');
    const stale = state.playlistsLoaded ? stalePinIds() : [];
    section.hidden = state.pins.ids.length === 0;
    $('pin-count').textContent = state.pins.ids.length + ' pinned' + (stale.length ? ' · ' + stale.length + ' dead' : '');
    $('unpin-all-stale').hidden = stale.length === 0;
    root.textContent = '';
    state.pins.ids.forEach((id, index) => {
      const playlist = playlistById(id);
      const row = node('div', 'org-pin-row' + (!playlist && state.playlistsLoaded ? ' dead' : ''));
      const title = node('button', 'org-pin-name', state.pins.names[id] || (playlist && playlist.title) || id);
      title.type = 'button';
      title.title = playlist ? 'Open ' + playlist.title : 'Deleted or unavailable: ' + id;
      title.disabled = !playlist;
      title.addEventListener('click', () => openPlaylist(id, true));
      const actions = node('div', 'org-pin-actions');
      const up = node('button', '', '↑');
      up.type = 'button';
      up.title = 'Move pin up';
      up.setAttribute('aria-label', up.title);
      up.disabled = index === 0;
      up.addEventListener('click', () => movePin(id, -1));
      const down = node('button', '', '↓');
      down.type = 'button';
      down.title = 'Move pin down';
      down.setAttribute('aria-label', down.title);
      down.disabled = index === state.pins.ids.length - 1;
      down.addEventListener('click', () => movePin(id, 1));
      const remove = node('button', '', '×');
      remove.type = 'button';
      remove.title = 'Unpin from sidebar';
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => unpinPlaylists([id]));
      actions.append(up, down, remove);
      row.append(title, actions);
      root.appendChild(row);
    });
  }

  function savePins(message) {
    const write = window.UNPlaylistFolders.persistPins
      ? (next) => window.UNPlaylistFolders.persistPins(state.pins, next)
      : (next) => chrome.storage.local.set({ plPins: state.pins }, next);
    write(() => {
      renderPinManager();
      renderPlaylistList();
      if (message) notice(message, true);
    });
  }

  function pinPlaylist(id) {
    const playlist = playlistById(id);
    if (!playlist) return;
    state.pins = window.UNPlaylistFolders.pinPlaylist(state.pins, id, playlist.title);
    savePins(playlist.title + ' pinned to the YouTube sidebar.');
  }

  function unpinPlaylists(ids) {
    ids.forEach((id) => {
      state.pins = window.UNPlaylistFolders.unpinPlaylist(state.pins, id);
    });
    savePins(ids.length + ' sidebar pin' + (ids.length === 1 ? '' : 's') + ' removed.');
  }

  function movePin(id, delta) {
    const from = state.pins.ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= state.pins.ids.length) return;
    state.pins.ids.splice(from, 1);
    state.pins.ids.splice(to, 0, id);
    savePins('Sidebar order updated.');
  }

  // Monotonic, so a slower earlier check cannot land after a newer one.
  let authSeq = 0;
  // The last reply that was a real answer, so an unverified check can still
  // say what was known rather than claiming nothing.
  let lastGoodAuth = null;

  async function refreshAuth() {
    const mySeq = ++authSeq;
    const result = await send(UNMSG.AUTH_STATUS);
    // A LATE ANSWER MUST PROVE IT IS STILL THE CURRENT ONE.
    // refreshAuth() runs on load and again after connectYouTube(), so two can
    // be in flight; without this they assign in completion order rather than
    // call order. Same defect class that produced three P0s in the content
    // scripts — re-check after every await.
    if (mySeq !== authSeq) return state.auth;

    // DO NOT FABRICATE AN ANSWER FROM A FAILED CHECK.
    //
    // This coerced a transport failure into { authed:false, hasConfig:false }.
    // That object has a boolean `authed` and no `ok`, so isAnswer() accepts it
    // as a genuine reply and needsSetup() fires first — rendering "YouTube
    // setup needed" with a "Set up YouTube" button for a fully connected user
    // whose message merely dropped. The most alarming label available, for the
    // one situation that says nothing about the credential.
    //
    // The raw reply is kept instead, so describe() can return 'unverified'.
    state.auth = result;
    if (window.UNAuthState && window.UNAuthState.isAnswer(result)) lastGoodAuth = result;
    const status = $('auth-state');
    const connect = $('connect-youtube');
    status.className = 'org-connection';
    // AN EXPIRED TOKEN IS NOT A READ-ONLY CONNECTION.
    //
    // This branched on `authed` alone, so a token that had expired with no way
    // to renew it fell into the read-only arm and rendered "Connected
    // read-only" with an "Enable edits" button — a working-looking control for
    // an account that cannot do anything. Reconnecting is the actual fix, and
    // the user was never told that.
    const AS = window.UNAuthState;
    const view = AS ? AS.describe(state.auth, lastGoodAuth) : null;
    if (view && view.state === 'unverified') {
      // A CHECK THAT FAILED IS NOT A VERDICT ON THE ACCOUNT.
      // Keep whatever was last known, say the check did not complete, and
      // offer RETRY — never Connect or Set up, which is what sends a user to
      // re-authorize an account that was working the whole time.
      const known = view.last ? ' · last known: ' + view.last.label : '';
      status.textContent = 'Could not check your YouTube connection' + known;
      status.classList.add('warn');
      connect.textContent = 'Retry';
      connect.hidden = false;
      syncToolbar();
      return state.auth;
    }
    if (view && view.state === 'expired') {
      status.textContent = 'YouTube connection expired';
      status.classList.add('warn');
      connect.textContent = 'Reconnect YouTube';
      connect.hidden = false;
    } else if (hasWriteAccess()) {
      status.textContent = 'YouTube connected · edits on';
      status.classList.add('ok');
      connect.hidden = true;
    } else if (AS ? AS.isConnected(state.auth) : state.auth.authed) {
      status.textContent = 'Connected read-only';
      status.classList.add('warn');
      connect.textContent = 'Enable edits';
      connect.hidden = false;
    } else {
      status.textContent = state.auth.hasConfig ? 'YouTube not connected' : 'YouTube setup needed';
      connect.textContent = state.auth.hasConfig ? 'Connect YouTube' : 'Set up YouTube';
      connect.hidden = false;
    }
    syncToolbar();
    return state.auth;
  }

  /**
   * THE BUTTON'S LABEL AND ITS ACTION MUST AGREE.
   *
   * #connect-youtube is bound once, permanently, to connectYouTube(). The
   * unverified branch relabels it "Retry" — but the handler underneath still
   * opened Google consent, or the settings page when hasConfig was false. So a
   * user whose message merely dropped pressed a button reading Retry and was
   * sent to re-authorize an account that was working the whole time. That is
   * precisely the outcome the unverified state exists to prevent, arrived at
   * through the button instead of through the label.
   *
   * The dispatcher routes on the state the button is currently presenting, so
   * relabelling can never again diverge from behaviour.
   */
  function connectAction() {
    const AS = window.UNAuthState;
    const view = AS ? AS.describe(state.auth, lastGoodAuth) : null;
    if (view && view.state === 'unverified') return recheckConnection();
    return connectYouTube();
  }

  /**
   * Re-run the status check and nothing else. No AUTH_START, no settings page:
   * a failed check is not a verdict on the credential, so the only correct
   * response is to ask again.
   */
  async function recheckConnection() {
    setBusy(true, 'Rechecking your YouTube connection…');
    try {
      await refreshAuth();
      const AS = window.UNAuthState;
      const view = AS ? AS.describe(state.auth, lastGoodAuth) : null;
      if (view && view.state === 'unverified') {
        notice('Still could not reach the extension background. Try again in a moment.', false);
        return;
      }
      await loadPlaylists(true, true);
    } finally {
      setBusy(false);
    }
  }

  async function connectYouTube() {
    if (!state.auth || !state.auth.hasConfig) {
      openSettings();
      return;
    }
    setBusy(true, 'Opening Google consent…');
    const result = await send(UNMSG.AUTH_START, { scopes: ['readonly', 'write'] });
    setBusy(false);
    if (!result.ok) return notice(readableError(result.error), false);
    await refreshAuth();
    await loadPlaylists(true, true);
  }

  function openSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#account') });
  }

  async function loadPlaylists(restoreOpen, fresh) {
    state.playlistsError = '';
    if (!state.auth || !state.auth.authed) {
      state.playlists = [];
      state.playlistsLoaded = false;
      renderPlaylistList();
      renderDestination();
      return { ok: false, error: state.auth && state.auth.hasConfig ? 'not_authed' : 'setup_needed' };
    }
    $('playlist-list').replaceChildren(node('div', 'org-list-empty', 'Loading playlists…'));
    const result = await send(UNMSG.YT_PLAYLISTS_MINE, { fresh: !!fresh });
    if (!result.ok) {
      state.playlistsError = result.error || 'no_response';
      state.playlists = [];
      state.playlistsLoaded = false;
      renderPlaylistList();
      notice(readableError(result.error), false);
      return result;
    }
    const ordered = Lib().orderPlaylists
      ? Lib().orderPlaylists(result.playlists || [])
      : (result.playlists || []);
    state.playlists = ordered;
    state.playlistsLoaded = true;
    $('playlist-total').textContent = state.playlists.length + ' loaded';
    renderPlaylistList();
    renderDestination();
    renderPinManager();
    if (restoreOpen) {
      const stored = await new Promise((resolve) => chrome.storage.local.get({ playlistOrganizerOpenIds: [] }, resolve));
      const valid = (stored.playlistOrganizerOpenIds || []).filter((id) => playlistById(id));
      await Promise.all(valid.map((id) => openPlaylist(id, false)));
    }
    return { ok: true };
  }

  function appendPlaylistRow(root, playlist) {
    const label = node('label', 'org-playlist-row' + (state.open.has(playlist.id) ? ' open' : ''));
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = state.open.has(playlist.id);
    check.setAttribute('aria-label', 'Open ' + playlist.title);
    check.addEventListener('change', () => check.checked ? openPlaylist(playlist.id, true) : closePlaylist(playlist.id));
    const pin = node('button', 'pin-toggle' + (window.UNPlaylistFolders.isPinned(state.pins, playlist.id) ? ' on' : ''), window.UNPlaylistFolders.isPinned(state.pins, playlist.id) ? 'Pinned' : 'Pin');
    pin.type = 'button';
    pin.title = window.UNPlaylistFolders.isPinned(state.pins, playlist.id) ? 'Unpin from sidebar' : 'Pin to sidebar';
    pin.addEventListener('click', (event) => {
      event.preventDefault();
      if (window.UNPlaylistFolders.isPinned(state.pins, playlist.id)) unpinPlaylists([playlist.id]);
      else pinPlaylist(playlist.id);
    });
    if (playlist.standard) pin.hidden = true;
    label.append(check, node('span', 'title', playlist.title), node('span', 'count', String(playlist.count || 0)), pin);
    root.appendChild(label);
  }

  function renderPlaylistList() {
    const root = $('playlist-list');
    root.textContent = '';
    const query = state.playlistQuery.toLowerCase();
    const visible = state.playlists.filter((playlist) => !query || playlist.title.toLowerCase().includes(query));
    if (!visible.length) {
      const msg = Lib().emptyLibraryMessage
        ? Lib().emptyLibraryMessage({
          authed: !!(state.auth && state.auth.authed),
          hasConfig: !!(state.auth && state.auth.hasConfig),
          error: state.playlistsError,
          playlistCount: state.playlists.length,
          query: state.playlistQuery
        })
        : (state.playlists.length ? 'No matching playlist.' : 'Connect YouTube to load your playlists.');
      root.appendChild(node('div', 'org-list-empty', msg));
      return;
    }
    const assigned = new Set();
    const folderNames = Object.keys(state.folders.folders || {}).sort((a, b) => a.localeCompare(b));
    folderNames.forEach((name) => {
      const ids = state.folders.folders[name] || [];
      const rows = visible.filter((playlist) => ids.indexOf(playlist.id) !== -1);
      if (!rows.length) return;
      rows.forEach((playlist) => assigned.add(playlist.id));
      root.appendChild(node('div', 'org-folder-label', name));
      rows.forEach((playlist) => appendPlaylistRow(root, playlist));
    });
    const rest = visible.filter((playlist) => !assigned.has(playlist.id));
    if (rest.length && assigned.size) root.appendChild(node('div', 'org-folder-label', 'Ungrouped'));
    rest.forEach((playlist) => appendPlaylistRow(root, playlist));
  }

  function renderDestination() {
    const select = $('destination');
    const previous = select.value;
    select.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Choose playlist…';
    select.appendChild(first);
    state.playlists.forEach((playlist) => {
      const option = document.createElement('option');
      option.value = playlist.id;
      option.textContent = playlist.title;
      select.appendChild(option);
    });
    if (playlistById(previous)) select.value = previous;
    syncToolbar();
  }

  async function openPlaylist(id, persist) {
    if (state.open.has(id)) return;
    const playlist = playlistById(id);
    if (!playlist) return;
    state.open.set(id, { playlist, items: [], loading: true, error: '' });
    if (persist !== false) saveOpenPlaylists();
    renderPlaylistList();
    renderColumns();
    const result = await fetchPlaylistItems(id, false);
    const column = state.open.get(id);
    if (!column) return;
    column.loading = false;
    if (result.ok) column.items = result.items;
    else column.error = readableError(result.error);
    renderColumns();
    if (result.ok) loadDurations(result.items);
  }

  /**
   * Fill in durations for a column that just loaded.
   *
   * playlistItems.list carries no duration at all, which is why no playlist tool
   * shows hours. videos.list does, 50 ids per call at 1 quota unit, and the
   * service worker caches the result permanently — so the second open of the
   * same playlist costs nothing.
   *
   * Never blocks the column: the videos render immediately with a count, and the
   * time budget appears when it arrives. A failure leaves the count alone rather
   * than showing a wrong total.
   */
  async function loadDurations(items) {
    const ids = (items || [])
      .map((i) => i && i.videoId)
      .filter((id) => id && !(id in state.durations));
    if (!ids.length) return;
    const reply = await send(UNMSG.YT_VIDEO_DURATIONS, { videoIds: ids });
    if (!reply || !reply.ok || !reply.durations) return;
    Object.assign(state.durations, reply.durations);
    renderColumns();
  }

  function closePlaylist(id) {
    state.open.delete(id);
    for (const [key, record] of state.selected) {
      if (record.sourceId === id) state.selected.delete(key);
    }
    saveOpenPlaylists();
    renderPlaylistList();
    renderColumns();
    syncToolbar();
  }

  function closeAll() {
    state.open.clear();
    state.selected.clear();
    saveOpenPlaylists();
    renderPlaylistList();
    renderColumns();
    syncToolbar();
  }

  async function fetchPlaylistItems(playlistId, fresh) {
    const result = await send(UNMSG.YT_PLAYLIST_ITEMS, { playlistId, fresh: !!fresh });
    return result.ok ? { ok: true, items: result.items || [] } : result;
  }

  async function refreshColumn(id) {
    const column = state.open.get(id);
    if (!column || column.loading) return;
    column.loading = true;
    column.error = '';
    renderColumns();
    const result = await fetchPlaylistItems(id, true);
    if (!state.open.has(id)) return;
    column.loading = false;
    if (result.ok) column.items = result.items;
    else column.error = readableError(result.error);
    for (const [key, record] of state.selected) {
      if (record.sourceId === id) state.selected.delete(key);
    }
    renderColumns();
    syncToolbar();
  }

  async function refreshAll() {
    await refreshAuth();
    const loaded = await loadPlaylists(false, true);
    await Promise.all(Array.from(state.open.keys()).map(refreshColumn));
    if (loaded && loaded.ok) notice('Playlists refreshed.', true);
  }

  function visibleItems(column) {
    const query = state.videoQuery.toLowerCase();
    return column.items.filter((item) => {
      if (state.hideWatched && isWatched(item.videoId)) return false;
      if (!query) return true;
      return item.title.toLowerCase().includes(query) || (item.channel || '').toLowerCase().includes(query);
    });
  }

  function bumpPlaylistCount(id, delta) {
    const playlist = playlistById(id);
    if (!playlist) return;
    playlist.count = Math.max(0, (Number(playlist.count) || 0) + delta);
    renderPlaylistList();
    renderDestination();
  }

  function renderColumns() {
    const root = $('playlist-columns');
    root.textContent = '';
    $('workspace-empty').hidden = state.open.size > 0;
    state.open.forEach((column, id) => root.appendChild(renderColumn(id, column)));
    syncSelectionUI();
  }

  function renderColumn(id, column) {
    const section = node('article', 'org-column');
    section.dataset.playlistId = id;

    const head = node('div', 'org-column-head');
    const titleRow = node('div', 'org-column-title');
    const title = node('h2', '', column.playlist.title);
    title.title = column.playlist.title;
    const close = node('button', '', '×');
    close.type = 'button';
    close.title = 'Close playlist';
    close.setAttribute('aria-label', 'Close ' + column.playlist.title);
    close.addEventListener('click', () => closePlaylist(id));
    titleRow.append(title, close);
    // "312 videos" says nothing about whether you can clear it: ten minutes of
    // Shorts and a 40-hour lecture series are both a number. The budget line
    // hedges with "at least" while durations are still arriving, because a sum
    // over part of the playlist is a floor, not its length.
    let shown;
    if (column.loading) shown = 'Loading videos…';
    else if (column.error) shown = 'Could not load';
    else {
      const PB = window.UNPlaylistBudget;
      const stats = PB && PB.playlistBudget({
        videoIds: column.items.map((i) => i.videoId),
        durations: state.durations,
        watched: state.watched
      });
      shown = (PB && PB.budgetLabel(stats)) || column.items.length + ' videos';
    }
    head.append(titleRow, node('div', 'org-column-meta', shown));
    section.appendChild(head);

    const tools = node('div', 'org-column-tools');
    const selectLabel = document.createElement('label');
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.dataset.selectAll = id;
    selectAll.addEventListener('change', () => selectVisible(id, selectAll.checked));
    selectLabel.append(selectAll, document.createTextNode('Select shown'));
    const refresh = node('button', 'quiet', '↻ Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => refreshColumn(id));
    tools.append(selectLabel, refresh);
    section.appendChild(tools);

    const list = node('div', 'org-video-list');
    if (column.loading) list.appendChild(node('div', 'org-column-message', 'Loading videos…'));
    else if (column.error) {
      const message = node('div', 'org-column-message bad');
      message.append(node('p', '', column.error));
      const retry = node('button', 'quiet', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => refreshColumn(id));
      message.append(retry);
      list.appendChild(message);
    }
    else {
      const items = visibleItems(column);
      if (!items.length) list.appendChild(node('div', 'org-column-message', state.videoQuery ? 'No matching videos.' : 'This playlist is empty.'));
      items.forEach((item) => list.appendChild(renderVideoRow(id, column, item)));
    }
    section.appendChild(list);
    return section;
  }

  function renderVideoRow(sourceId, column, item) {
    const key = selectionKey(sourceId, item.itemId);
    const row = node('div', 'org-video-row');
    row.dataset.key = key;
    row.dataset.itemId = item.itemId;
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', key);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (event) => {
      const from = event.dataTransfer.types.includes('text/plain');
      if (!from) return;
      event.preventDefault();
      row.classList.add('drop-before');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('drop-before');
      const fromKey = event.dataTransfer.getData('text/plain');
      reorderByDrop(sourceId, fromKey, item.itemId);
    });

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'org-video-check';
    checkbox.setAttribute('aria-label', 'Select ' + item.title);
    checkbox.addEventListener('change', () => toggleSelection(sourceId, item, checkbox.checked));

    const thumb = node('div', 'org-thumb');
    if (item.thumb) {
      const image = document.createElement('img');
      image.src = item.thumb;
      image.alt = '';
      image.loading = 'lazy';
      thumb.appendChild(image);
    } else thumb.appendChild(node('span', 'missing', 'No thumbnail'));

    const main = node('div', 'org-video-main');
    const link = node('a', 'org-video-title', item.title || 'Unavailable video');
    if (item.videoId) {
      link.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(item.videoId);
      link.target = '_blank';
      link.rel = 'noreferrer';
    }
    const fullIndex = column.items.indexOf(item);
    const lower = node('div', 'org-video-tools');
    lower.appendChild(node('span', 'org-position', '#' + (fullIndex + 1) + (item.channel ? ' · ' + item.channel : '')));
    if (item.videoId) {
      const watched = isWatched(item.videoId);
      const mark = node('button', 'org-watched-dot' + (watched ? ' on' : ''), watched ? 'Watched' : 'Unseen');
      mark.type = 'button';
      mark.title = watched ? 'Mark unwatched' : 'Mark watched';
      mark.setAttribute('aria-label', mark.title);
      mark.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleWatched(item.videoId);
      });
      lower.appendChild(mark);
    }
    const order = node('div', 'org-order-buttons');
    const up = node('button', '', '↑');
    up.type = 'button';
    up.title = 'Move up';
    up.setAttribute('aria-label', up.title);
    up.disabled = fullIndex <= 0;
    up.addEventListener('click', () => reorderItem(sourceId, item.itemId, fullIndex - 1));
    const down = node('button', '', '↓');
    down.type = 'button';
    down.title = 'Move down';
    down.setAttribute('aria-label', down.title);
    down.disabled = fullIndex >= column.items.length - 1;
    down.addEventListener('click', () => reorderItem(sourceId, item.itemId, fullIndex + 1));
    order.append(up, down);
    lower.appendChild(order);
    main.append(link, lower);
    row.append(checkbox, thumb, main);
    return row;
  }

  function toggleSelection(sourceId, item, checked) {
    const key = selectionKey(sourceId, item.itemId);
    if (checked) state.selected.set(key, { sourceId, item });
    else state.selected.delete(key);
    syncSelectionUI();
    syncToolbar();
  }

  function selectVisible(sourceId, checked) {
    const column = state.open.get(sourceId);
    if (!column) return;
    visibleItems(column).forEach((item) => {
      const key = selectionKey(sourceId, item.itemId);
      if (checked) state.selected.set(key, { sourceId, item });
      else state.selected.delete(key);
    });
    syncSelectionUI();
    syncToolbar();
  }

  function selectAllOpen() {
    const hasVisible = Array.from(state.open.values()).some((column) => visibleItems(column).length);
    if (!hasVisible) return notice('Open a playlist with videos first.', false);
    state.open.forEach((column, id) => {
      visibleItems(column).forEach((item) => {
        state.selected.set(selectionKey(id, item.itemId), { sourceId: id, item });
      });
    });
    renderColumns();
  }

  function syncSelectionUI() {
    document.querySelectorAll('.org-video-row').forEach((row) => {
      const selected = state.selected.has(row.dataset.key);
      row.classList.toggle('selected', selected);
      const input = row.querySelector('.org-video-check');
      if (input) input.checked = selected;
    });
    document.querySelectorAll('[data-select-all]').forEach((input) => {
      const column = state.open.get(input.dataset.selectAll);
      const items = column ? visibleItems(column) : [];
      const selected = items.filter((item) => state.selected.has(selectionKey(input.dataset.selectAll, item.itemId))).length;
      input.checked = items.length > 0 && selected === items.length;
      input.indeterminate = selected > 0 && selected < items.length;
    });
  }

  function syncToolbar() {
    const count = state.selected.size;
    const destination = $('destination').value;
    $('selected-count').textContent = count + ' selected';
    $('clear-selection').disabled = !count || state.busy;
    $('destination').disabled = !state.playlists.length || state.busy;
    $('copy-selected').disabled = !count || !destination || !hasWriteAccess() || state.busy;
    $('move-selected').disabled = !count || !destination || !hasWriteAccess() || state.busy;
    $('delete-selected').disabled = !count || !hasWriteAccess() || state.busy;
    $('refresh-all').disabled = state.busy;
    $('create-playlist').disabled = state.busy || !hasWriteAccess();
  }

  function clearSelection() {
    state.selected.clear();
    syncSelectionUI();
    syncToolbar();
  }

  function confirmAction(title, message, buttonText) {
    return new Promise((resolve) => {
      const dialog = $('confirm-dialog');
      $('confirm-title').textContent = title;
      $('confirm-message').textContent = message;
      $('confirm-action').textContent = buttonText;
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  async function copyOrMove(mode) {
    const targetId = $('destination').value;
    const target = playlistById(targetId);
    const records = selectedRecords().filter((record) => record.sourceId !== targetId && record.item.videoId);
    if (!target || !records.length) return notice('Choose a different destination for the selected videos.', false);

    setBusy(true, (mode === 'move' ? 'Moving' : 'Copying') + ' selected videos…');
    try {
      const targetResult = await fetchPlaylistItems(targetId, true);
      if (!targetResult.ok) throw new Error(readableError(targetResult.error));
      const existing = new Set(targetResult.items.map((item) => item.videoId).filter(Boolean));
      const requested = Array.from(new Set(records.map((record) => record.item.videoId)));
      const alreadyThere = requested.filter((videoId) => existing.has(videoId));
      const toAdd = requested.filter((videoId) => !existing.has(videoId));
      const successful = new Set(alreadyThere);
      let failedCount = 0;

      if (toAdd.length) {
        const add = await send(UNMSG.YT_PLAYLIST_ADD, { playlistId: targetId, videoIds: toAdd });
        if (!add.ok) throw new Error(readableError(add.error));
        const failed = new Set(add.failed || []);
        toAdd.forEach((videoId) => {
          if (!failed.has(videoId)) successful.add(videoId);
        });
        failedCount = failed.size;
      }

      let removed = 0;
      if (mode === 'move') {
        const itemIds = records.filter((record) => successful.has(record.item.videoId)).map((record) => record.item.itemId);
        if (itemIds.length) {
          const result = await send(UNMSG.YT_PLAYLIST_REMOVE, { itemIds });
          if (!result.ok) throw new Error(readableError(result.error));
          removed = result.removed || 0;
          removeLocalItems(new Set(itemIds.filter((id) => !(result.failed || []).includes(id))));
        }
      }

      if (state.open.has(targetId)) await refreshColumn(targetId);
      const addedCount = Math.max(0, successful.size - alreadyThere.length);
      if (addedCount) bumpPlaylistCount(targetId, addedCount);
      if (mode === 'move' && removed) {
        const bySource = {};
        records.filter((record) => successful.has(record.item.videoId)).forEach((record) => {
          bySource[record.sourceId] = (bySource[record.sourceId] || 0) + 1;
        });
        Object.keys(bySource).forEach((sourceId) => bumpPlaylistCount(sourceId, -bySource[sourceId]));
      }
      clearSelection();
      const done = mode === 'move' ? removed : addedCount;
      const duplicateNote = alreadyThere.length ? ' ' + alreadyThere.length + ' already there.' : '';
      notice(done + ' video' + (done === 1 ? '' : 's') + (mode === 'move' ? ' moved to ' : ' copied to ') + target.title + '.' + duplicateNote + (failedCount ? ' ' + failedCount + ' failed.' : ''), failedCount ? false : true);
    } catch (error) {
      notice(readableError(error.message), false);
    } finally {
      setBusy(false);
    }
  }

  function removeLocalItems(ids) {
    state.open.forEach((column, sourceId) => {
      column.items = column.items.filter((item) => !ids.has(item.itemId));
      for (const id of ids) state.selected.delete(selectionKey(sourceId, id));
    });
    renderColumns();
  }

  async function deleteSelected() {
    const records = selectedRecords();
    if (!records.length) return;
    const playlistCount = new Set(records.map((record) => record.sourceId)).size;
    const ok = await confirmAction(
      'Remove selected videos?',
      records.length + ' playlist item' + (records.length === 1 ? '' : 's') + ' will be removed from ' + playlistCount + ' playlist' + (playlistCount === 1 ? '' : 's') + '.\nThe videos themselves are not deleted from YouTube.',
      'Remove videos'
    );
    if (!ok) return;
    setBusy(true, 'Removing selected videos…');
    const ids = records.map((record) => record.item.itemId);
    const result = await send(UNMSG.YT_PLAYLIST_REMOVE, { itemIds: ids });
    if (result.ok) {
      const failed = new Set(result.failed || []);
      const removedIds = new Set(ids.filter((id) => !failed.has(id)));
      const bySource = {};
      records.forEach((record) => {
        if (removedIds.has(record.item.itemId)) bySource[record.sourceId] = (bySource[record.sourceId] || 0) + 1;
      });
      Object.keys(bySource).forEach((sourceId) => bumpPlaylistCount(sourceId, -bySource[sourceId]));
      removeLocalItems(removedIds);
      clearSelection();
      notice((result.removed || 0) + ' playlist item' + (result.removed === 1 ? '' : 's') + ' removed.' + (failed.size ? ' ' + failed.size + ' failed.' : ''), failed.size ? false : true);
    } else notice(readableError(result.error), false);
    setBusy(false);
  }

  async function reorderItem(sourceId, itemId, targetIndex) {
    if (state.busy || !hasWriteAccess()) return notice('Connect YouTube with edit access to reorder videos.', false);
    const column = state.open.get(sourceId);
    if (!column) return;
    const fromIndex = column.items.findIndex((item) => item.itemId === itemId);
    if (fromIndex < 0 || targetIndex < 0 || targetIndex >= column.items.length || fromIndex === targetIndex) return;
    const item = column.items[fromIndex];
    if (!item.videoId) return notice('Unavailable videos cannot be reordered.', false);
    setBusy(true);
    const result = await send(UNMSG.YT_PLAYLIST_REORDER, {
      itemId: item.itemId,
      playlistId: sourceId,
      videoId: item.videoId,
      position: targetIndex
    });
    if (result.ok) {
      column.items.splice(fromIndex, 1);
      column.items.splice(targetIndex, 0, item);
      renderColumns();
      notice('Order updated.', true);
    } else notice(readableError(result.error), false);
    setBusy(false);
  }

  function reorderByDrop(sourceId, fromKey, targetItemId) {
    const record = state.selected.get(fromKey);
    const prefix = sourceId + ':';
    if (!fromKey.startsWith(prefix)) return notice('Use Move to send videos to another playlist.', false);
    const itemId = fromKey.slice(prefix.length);
    const column = state.open.get(sourceId);
    if (!column) return;
    const targetIndex = column.items.findIndex((item) => item.itemId === targetItemId);
    reorderItem(sourceId, record ? record.item.itemId : itemId, targetIndex);
  }

  function bindEvents() {
    $('connect-youtube').addEventListener('click', connectAction);
    $('open-settings').addEventListener('click', openSettings);
    $('refresh-all').addEventListener('click', refreshAll);
    $('close-all').addEventListener('click', closeAll);
    $('unpin-all-stale').addEventListener('click', () => unpinPlaylists(stalePinIds()));
    $('clear-selection').addEventListener('click', clearSelection);
    $('select-all-open').addEventListener('click', selectAllOpen);
    $('destination').addEventListener('change', syncToolbar);
    $('copy-selected').addEventListener('click', () => copyOrMove('copy'));
    $('move-selected').addEventListener('click', () => copyOrMove('move'));
    $('delete-selected').addEventListener('click', deleteSelected);
    $('playlist-search').addEventListener('input', (event) => {
      state.playlistQuery = event.target.value.trim();
      renderPlaylistList();
    });
    $('video-search').addEventListener('input', (event) => {
      state.videoQuery = event.target.value.trim();
      renderColumns();
    });
    $('hide-watched').addEventListener('change', (event) => {
      state.hideWatched = !!event.target.checked;
      renderColumns();
    });
    $('create-playlist').addEventListener('click', openCreatePlaylist);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if ($('create-dialog').open || $('confirm-dialog').open) return;
      if (state.selected.size) {
        event.preventDefault();
        clearSelection();
      }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.watchedVideos) {
        const next = (ch.watchedVideos.newValue || []);
        state.watched = new Set(next);
        renderColumns();
      }
    });
  }

  async function openCreatePlaylist() {
    if (!hasWriteAccess()) return notice('Connect YouTube with edit access to create a playlist.', false);
    const dialog = $('create-dialog');
    $('create-title').value = '';
    $('create-privacy').value = 'private';
    const ok = await new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
      $('create-title').focus();
    });
    if (!ok) return;
    const title = $('create-title').value.trim();
    if (!title) return;
    setBusy(true, 'Creating playlist…');
    const result = await send(UNMSG.YT_PLAYLIST_CREATE, { title, privacyStatus: $('create-privacy').value, videoIds: [] });
    setBusy(false);
    if (!result.ok) return notice(readableError(result.error), false);
    const created = { id: result.playlistId, title: result.title || title, count: 0, thumb: '' };
    state.playlists = Lib().orderPlaylists ? Lib().orderPlaylists(state.playlists.concat([created])) : state.playlists.concat([created]);
    $('playlist-total').textContent = state.playlists.length + ' loaded';
    renderPlaylistList();
    renderDestination();
    $('destination').value = created.id;
    notice((created.title) + ' created.', true);
    syncToolbar();
  }

  async function init() {
    bindEvents();
    await loadPins();
    await refreshAuth();
    await loadPlaylists(true, true);
  }

  init().catch((error) => notice(readableError(error.message), false));
})();
