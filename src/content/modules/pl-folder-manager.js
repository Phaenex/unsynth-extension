/**
 * Playlist pin + folder manager — pins real YouTube playlists into the sidebar
 * via "＋ Pin", optionally assigns them to folders for Library filtering.
 */
(function () {
  'use strict';

  var PF = window.UNPlaylistFolders;
  var YD = window.UNYtDom;

  function emptyPlStore() {
    return { folders: {}, names: {} };
  }
  function pfEmpty() {
    return PF && PF.empty ? PF.empty() : emptyPlStore();
  }
  function emptyPins() {
    return PF && PF.emptyPins ? PF.emptyPins() : { ids: [], names: {} };
  }

  var core = null;
  var store = pfEmpty();
  var pins = emptyPins();
  var active = '';
  var menuAnchorBtn = null;

  function load(cb) {
    chrome.storage.local.get({ plFolderStore: pfEmpty(), plFolderActive: '', plPins: emptyPins() }, function (d) {
      store = d.plFolderStore || pfEmpty();
      pins = PF && PF.normalizePins ? PF.normalizePins(d.plPins) : d.plPins || emptyPins();
      active = d.plFolderActive || '';
      cb && cb();
    });
  }
  function saveStore() {
    // Route through the merging writer so a save here cannot clobber a folder
    // another context created since `store` was read. Authoritative: this
    // module owns the full picture and its removals must stick.
    if (PF && PF.persistFolders) PF.persistFolders(store, null, { authoritative: true });
    else chrome.storage.local.set({ plFolderStore: store });
  }
  function savePins() {
    if (PF && PF.persistPins) PF.persistPins(pins);
    else chrome.storage.local.set({ plPins: pins });
  }

  function playlistIdFromUrl() {
    var m = location.search.match(/[?&]list=([^&]+)/);
    return m ? m[1] : null;
  }
  function onPlaylistPage() {
    return location.pathname.startsWith('/playlist') && !!playlistIdFromUrl();
  }
  function onLibraryPage() {
    return location.pathname === '/feed/playlists' || location.pathname.indexOf('/feed/library') === 0;
  }

  function playlistIdFromTile(tile) {
    var a = tile.querySelector('a[href*="/playlist?list="], a[href*="list="]');
    if (!a) return null;
    var m = (a.getAttribute('href') || '').match(/[?&]list=([^&]+)/);
    return m ? m[1] : null;
  }
  // YouTube reskinned /feed/playlists onto the lockup view model: a playlist
  // tile is now rich-item wrapping lockup, and legacy playlist renderers match
  // nothing there. Both legacy names are kept because they still render on
  // other surfaces. Verified live against a signed-in /feed/playlists: legacy
  // 0, rich-item 4, lockup 4, so matching only the legacy pair silently
  // disabled folder filtering, the empty state, and every per-tile pin button.
  // The old playlist header survives as an EMPTY zero-size stub, and the real
  // header renders a hidden duplicate alongside the visible one. querySelector
  // returns the first in document order, which is the wrong one in both cases,
  // so anchor on the first match that actually has a box.
  function firstVisible(sel) {
    var nodes = document.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return nodes[i];
    }
    return null;
  }

  function playlistTitleFromPage() {
    var t =
      firstVisible(YD ? YD.PLAYLIST_PAGE_HEADER_H1_SEL : 'h1') ||
      document.querySelector(YD ? YD.PLAYLIST_HEADER_TITLE_SEL : '#title');
    return t ? t.textContent.trim() : '';
  }

  function tileSel() {
    return YD ? YD.PLAYLIST_INDEX_TILE_SEL : 'none';
  }

  // A rich-item and the lockup inside it both match TILE_SEL. Keep only the
  // outermost, so a tile is never counted or hidden twice.
  function playlistTiles() {
    var sel = tileSel();
    var all = [].slice.call(document.querySelectorAll(sel));
    return all.filter(function (el) {
      return !(el.parentElement && el.parentElement.closest(sel));
    });
  }

  function playlistTitleFromTile(tile) {
    var t = tile.querySelector(YD ? YD.PLAYLIST_TILE_TITLE_SEL : '#title, h3');
    return t ? t.textContent.trim() : '';
  }

  function clearFilter() {
    document.querySelectorAll('[data-unplf]').forEach(function (el) {
      delete el.dataset.unplf;
      el.classList.remove('un-plf-hidden');
    });
  }

  function applyFilter() {
    if (!onLibraryPage() || !active) {
      clearFilter();
      hideLibraryEmpty();
      return;
    }
    var allowed = new Set(store.folders[active] || []);
    var total = 0;
    var hidden = 0;
    playlistTiles().forEach(function (tile) {
      var plId = playlistIdFromTile(tile);
      if (!plId) return;
      total += 1;
      // Re-decide on EVERY pass rather than skipping tiles already stamped.
      // The old guard (`if (tile.dataset.unplf) return`) treated the stamp as
      // "already decided", so a tile hidden under one folder stayed hidden after
      // switching folders or turning the filter off — scan() runs on every DOM
      // mutation and never clears it. The visible symptom was playlists missing
      // until you opened a video, which made YouTube rebuild the list with fresh
      // unstamped tiles. Toggling the class both ways is idempotent and cheap.
      tile.dataset.unplf = '1';
      var hide = !allowed.has(plId);
      tile.classList.toggle('un-plf-hidden', hide);
      if (hide) hidden += 1;
    });
    if (total > 0 && hidden === total) showLibraryEmpty();
    else hideLibraryEmpty();
  }

  function hideLibraryEmpty() {
    var n = document.getElementById('un-plf-empty');
    if (n) n.remove();
  }

  function showLibraryEmpty() {
    if (document.getElementById('un-plf-empty')) return;
    var host =
      document.querySelector(YD ? YD.PLAYLIST_SECTION_CONTENTS_SEL : '#contents') ||
      document.querySelector(YD ? YD.PLAYLIST_BROWSE_RESULTS_SEL : '#contents') ||
      document.querySelector(YD ? YD.PLAYLIST_SECTION_CONTENTS_CLASS_SEL : '#contents') ||
      document.body;
    var box = document.createElement('div');
    box.id = 'un-plf-empty';
    box.className = 'un-plf-empty';
    var msg = document.createElement('p');
    msg.textContent = 'No playlists in this folder.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'un-plf-empty-clear';
    btn.textContent = 'Show all playlists';
    btn.addEventListener('click', function () {
      active = '';
      chrome.storage.local.set({ plFolderActive: '' });
      applyFilter();
    });
    box.appendChild(msg);
    box.appendChild(btn);
    host.insertBefore(box, host.firstChild);
  }

  function positionMenu(menu, btn) {
    var r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = Math.min(window.innerWidth - 220, Math.max(8, r.left)) + 'px';
    menu.style.top = Math.min(window.innerHeight - 260, r.bottom + 6) + 'px';
  }

  function setPinButtonState(btn, plId) {
    if (!btn) return;
    var on = PF && PF.isPinned ? PF.isPinned(pins, plId) : false;
    btn.classList.toggle('on', on);
    if (btn.classList.contains('un-plf-addbtn')) {
      btn.textContent = on ? '✓ Pinned' : '＋ Pin';
      btn.title = on ? 'Pinned to sidebar — click for options' : 'Pin this playlist to the YouTube sidebar';
      btn.setAttribute('aria-label', btn.title);
    } else {
      btn.textContent = on ? '★' : '＋';
      btn.title = on ? 'Pinned — options' : 'Pin to sidebar';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function openPinMenu(btn, plId, title) {
    if (!plId) return;
    var menu = document.createElement('div');
    menu.id = 'un-plf-menu';
    menuAnchorBtn = btn;

    var pinned = PF && PF.isPinned ? PF.isPinned(pins, plId) : false;
    var pinRow = document.createElement('button');
    pinRow.type = 'button';
    pinRow.className = 'un-plf-menu-action' + (pinned ? ' on' : '');
    pinRow.textContent = pinned ? 'Unpin from sidebar' : 'Pin to sidebar';
    pinRow.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (pinned) pins = PF.unpinPlaylist(pins, plId);
      else pins = PF.pinPlaylist(pins, plId, title);
      savePins();
      setPinButtonState(btn, plId);
      menu.remove();
      menuAnchorBtn = null;
    });
    menu.appendChild(pinRow);

    var folderNames = Object.keys(store.folders || {});
    if (folderNames.length) {
      var sep = document.createElement('div');
      sep.className = 'un-plf-menu-sep';
      sep.textContent = 'Also in folders';
      menu.appendChild(sep);
      folderNames.forEach(function (fname) {
        var row = document.createElement('label');
        row.className = 'un-plf-menu-row';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = (store.folders[fname] || []).indexOf(plId) !== -1;
        cb.addEventListener('change', function () {
          if (cb.checked) PF.addToFolder(store, fname, plId, title);
          else PF.removeFromFolder(store, fname, plId);
          saveStore();
        });
        row.appendChild(cb);
        row.appendChild(document.createTextNode(' ' + fname));
        menu.appendChild(row);
      });
    } else {
      var hint = document.createElement('div');
      hint.className = 'un-plf-menu-hint';
      hint.textContent = 'Folders are optional — pin puts it in the sidebar.';
      menu.appendChild(hint);
    }

    // ＋ Folder. The popup, the dashboard's module label and the module
    // manifest all advertise this as part of Playlist groups, and the
    // dashboard's own empty state tells people to "use ＋ Folder on YouTube" —
    // but the only createFolder() caller was the dashboard itself, so there
    // was no way to make a folder from YouTube at all. Without one, a fresh
    // profile can never reach the folder filter or its empty state.
    var addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.className = 'un-plf-menu-action add';
    addRow.textContent = '＋ New folder…';
    menu.appendChild(addRow);

    var form = document.createElement('div');
    form.className = 'un-plf-menu-newform';
    form.hidden = true;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'un-plf-menu-newinput';
    input.placeholder = 'Folder name';
    input.maxLength = 60;
    var err = document.createElement('div');
    err.className = 'un-plf-menu-hint';
    err.hidden = true;
    form.appendChild(input);
    form.appendChild(err);
    menu.appendChild(form);

    addRow.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      form.hidden = !form.hidden;
      if (!form.hidden) input.focus();
    });

    function commitNewFolder() {
      var name = (input.value || '').trim();
      if (!name) return;
      // Reject a duplicate rather than silently folding into the existing one,
      // which would look like the new folder swallowed someone else's contents.
      if (Object.prototype.hasOwnProperty.call(store.folders || {}, name)) {
        err.textContent = 'That folder already exists.';
        err.hidden = false;
        return;
      }
      if (PF && PF.createFolder) PF.createFolder(store, name);
      else {
        store.folders = store.folders || {};
        store.folders[name] = [];
      }
      // Put this playlist in the folder it was just created from. Creating an
      // empty folder from a playlist's own menu and having nothing happen
      // reads as a no-op.
      if (PF && PF.addToFolder) PF.addToFolder(store, name, plId, title);
      saveStore();
      menu.remove();
      menuAnchorBtn = null;
      applyFilter();
    }

    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitNewFolder(); }
      else if (e.key === 'Escape') { e.preventDefault(); form.hidden = true; }
      else { err.hidden = true; }
    });

    document.body.appendChild(menu);
    positionMenu(menu, btn);
  }

  function togglePinMenu(btn, plId, title) {
    var old = document.getElementById('un-plf-menu');
    if (old) {
      var sameBtn = menuAnchorBtn === btn;
      old.remove();
      menuAnchorBtn = null;
      if (sameBtn) return;
    }
    openPinMenu(btn, plId, title);
  }

  function ensurePlaylistPageButton() {
    if (!onPlaylistPage()) return;
    var plId = playlistIdFromUrl();
    if (!plId) return;
    var existing = document.getElementById('un-plf-addbtn');
    if (existing) {
      // getElementById existing is not proof it's correctly placed — the
      // button is never removed on onNavigate (only #un-plf-menu is), so a
      // stale node left over from a prior playlist page (YouTube's SPA
      // routing does not always tear down old DOM — the same failure mode
      // already found and fixed in sub-manager.js today) can sit detached or
      // invisible while this check keeps trusting it and never re-anchors.
      var r = existing.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setPinButtonState(existing, plId);
        return;
      }
      existing.remove();
    }
    var anchor =
      firstVisible(YD ? YD.PLAYLIST_HEADER_ACTIONS_SEL : 'none') ||
      document.querySelector(YD ? YD.PLAYLIST_HEADER_MENU_CONTAINER_SEL : '#menu') ||
      document.querySelector('#meta #menu') ||
      document.querySelector(YD ? YD.PLAYLIST_HEADER_MENU_SEL : 'none');
    if (!anchor) return;
    var btn = document.createElement('button');
    btn.id = 'un-plf-addbtn';
    btn.className = 'un-plf-addbtn';
    setPinButtonState(btn, plId);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePinMenu(btn, plId, playlistTitleFromPage());
    });
    var host = anchor.parentElement || anchor;
    host.style.position = 'relative';
    host.insertBefore(btn, anchor.nextSibling);
  }

  function ensureLibraryTileButtons() {
    if (!onLibraryPage()) return;
    playlistTiles().forEach(function (tile) {
      var plId = playlistIdFromTile(tile);
      if (!plId) return;
      var existing = tile.querySelector('.un-plf-tile-btn');
      if (existing) {
        setPinButtonState(existing, plId);
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'un-plf-tile-btn';
      setPinButtonState(btn, plId);
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        togglePinMenu(btn, plId, playlistTitleFromTile(tile));
      });
      tile.style.position = 'relative';
      tile.appendChild(btn);
    });
  }

  function refreshAll() {
    if (core && !core.isModuleEnabled(mod)) return;
    applyFilter();
    ensurePlaylistPageButton();
    ensureLibraryTileButtons();
  }

  var onDocClick = null;
  var onStorageChanged = null;

  var mod = {
    id: 'plFolderManager',
    moduleKey: 'playlistFolders',
    init: function (c) {
      core = c;
      load(refreshAll);
      onDocClick = function (e) {
      // Not a user dismissal -- see queue-advance.js docClickHandler.
      if (e && e.isTrusted === false) return;
        if (!e.target.closest('.un-plf-addbtn, .un-plf-tile-btn, #un-plf-menu')) {
          var m = document.getElementById('un-plf-menu');
          if (m) m.remove();
          menuAnchorBtn = null;
        }
      };
      document.addEventListener('click', onDocClick);
      onStorageChanged = function (changes, area) {
        if (area === 'sync' && changes.unPlPinsSync && PF && PF.applyRemotePinSync) {
          PF.applyRemotePinSync(changes.unPlPinsSync.newValue);
          return;
        }
        if (area !== 'local') return;
        if (changes.plFolderStore || changes.plFolderActive || changes.plPins) {
          load(function () {
            clearFilter();
            refreshAll();
          });
        }
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
    },
    scan: function () {
      // Playlist pin UI only matters on playlist / library surfaces.
      const p = location.pathname;
      if (
        p.indexOf('/playlist') === 0 ||
        p === '/feed/playlists' ||
        p.indexOf('/feed/library') === 0
      ) {
        refreshAll();
      }
    },
    onNavigate: function () {
      var m = document.getElementById('un-plf-menu');
      if (m) m.remove();
      menuAnchorBtn = null;
      clearFilter();
      refreshAll();
    },
    teardown: function () {
      if (onDocClick) {
        document.removeEventListener('click', onDocClick);
        onDocClick = null;
      }
      if (onStorageChanged) {
        chrome.storage.onChanged.removeListener(onStorageChanged);
        onStorageChanged = null;
      }
      clearFilter();
      hideLibraryEmpty();
      var menu = document.getElementById('un-plf-menu');
      if (menu) menu.remove();
      menuAnchorBtn = null;
      var addbtn = document.getElementById('un-plf-addbtn');
      if (addbtn) addbtn.remove();
      document.querySelectorAll('.un-plf-tile-btn').forEach(function (n) {
        n.remove();
      });
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
