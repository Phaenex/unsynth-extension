'use strict';

/** Subscription groups + playlist folders UI. */
// Extracted from dashboard-core.js. Runs at global scope (classic script),
// loaded AFTER dashboard-core.js so its shared vars ($, send, flash, D, UNMSG)
// are already defined. Functions here are global and resolved by name.
  // ---- subscription groups (chrome.storage.local 'subStore') ----
  const SG = () => window.UNSubGroups;
  const SCT = () => window.UNSubChannelThumbs;
  function loadSubs(cb) {
    chrome.storage.local.get({ subStore: { groups: {}, names: {} }, subChannelThumbs: {} }, (d) =>
      cb(d.subStore || { groups: {}, names: {} }, d.subChannelThumbs || {})
    );
  }
  function saveSubs(store, then) {
    chrome.storage.local.set({ subStore: store }, then || function () {});
  }
  function saveSubThumbs(thumbs, then) {
    chrome.storage.local.set({ subChannelThumbs: thumbs }, then || function () {});
  }
  function channelThumbUrl(thumbs, store, key) {
    const sct = SCT();
    return sct ? sct.lookup(thumbs, store, key) : null;
  }
  function mkDashChanAvatar(thumbs, store, key) {
    const sct = SCT();
    const lbl = (store.names && store.names[key]) || key;
    const initial = lbl.charAt(0) === '@' ? lbl.charAt(1).toUpperCase() : lbl.charAt(0).toUpperCase();
    if (sct) {
      return sct.mkAvatar({
        className: 'chan-avatar',
        label: lbl,
        initial: initial,
        thumbUrl: channelThumbUrl(thumbs, store, key)
      });
    }
    const el = document.createElement('span');
    el.className = 'chan-avatar';
    el.textContent = initial;
    el.title = lbl;
    return el;
  }

  function mkEmptyState(msg, actions) {
    const box = document.createElement('div');
    box.className = 'dash-empty-state';
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = msg;
    box.appendChild(p);
    if (actions && actions.length) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      actions.forEach(([label, fn, primary]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        if (primary) b.className = 'primary';
        b.addEventListener('click', fn);
        bar.appendChild(b);
      });
      box.appendChild(bar);
    }
    return box;
  }

  function mkHeadBtn(label, onClick, danger) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (danger) b.className = 'danger-btn';
    b.addEventListener('click', onClick);
    return b;
  }

  let subsGroupSearch = '';

  function updateSubsStats(store) {
    const el = $('subs-stats');
    if (!el) return;
    const groups = Object.keys(store.groups || {});
    let channels = 0;
    groups.forEach((g) => {
      channels += (store.groups[g] || []).length;
    });
    el.textContent = groups.length ? groups.length + ' group' + (groups.length === 1 ? '' : 's') + ' · ' + channels + ' channel' + (channels === 1 ? '' : 's') : '';
  }

  function groupMatchesSearch(store, g, q) {
    if (!q) return true;
    if (g.toLowerCase().indexOf(q) !== -1) return true;
    return (store.groups[g] || []).some((key) => {
      const lbl = ((store.names && store.names[key]) || key).toLowerCase();
      return lbl.indexOf(q) !== -1 || key.toLowerCase().indexOf(q) !== -1;
    });
  }

  var subsAutoEnrichDone = false;
  function maybeAutoEnrichSubs(store) {
    if (subsAutoEnrichDone || !store) return;
    if (!SG().unresolvedChannelIds(store).length) return;
    subsAutoEnrichDone = true;
    enrichNames();
  }

  function renderSubs() {
    loadSubs((store, thumbs) => {
      const list = $('group-list');
      if (!list) return;
      list.textContent = '';
      updateSubsStats(store);
      const names = Object.keys(store.groups || {});
      const q = subsGroupSearch.trim().toLowerCase();
      if (!names.length) {
        list.appendChild(
          mkEmptyState('No groups yet. Create one above, import bundled PocketTube subs, or add channels from YouTube.', [
            ['Import bundled PocketTube…', () => $('import-groups-bundled').click(), true],
            ['Connect YouTube', () => activateTab('account')]
          ])
        );
        return;
      }
      const visible = names.filter((g) => groupMatchesSearch(store, g, q));
      if (!visible.length) {
        list.appendChild(mkEmptyState('No groups match “' + subsGroupSearch.trim() + '”.', []));
        return;
      }
      const allGroups = names.slice();
      visible.forEach((g) => {
        const wrap = document.createElement('div');
        wrap.className = 'group-card';
        wrap.dataset.group = g;

        const head = document.createElement('div');
        head.className = 'group-head';
        const title = document.createElement('b');
        title.textContent = g + '  (' + store.groups[g].length + ')';
        const headActs = document.createElement('div');
        headActs.className = 'group-head-actions';
        headActs.appendChild(
          mkHeadBtn('Rename', async () => {
            const nn = await uiPrompt('Rename group', g);
            if (!nn || nn.trim() === g) return;
            SG().renameGroup(store, g, nn.trim());
            saveSubs(store, () => {
              renderSubs();
              flash($('subs-status'), 'Renamed.');
            });
          })
        );
        headActs.appendChild(
          mkHeadBtn('Delete', async () => {
            if (!(await uiConfirm('Delete group "' + g + '"? Channels are not unsubscribed.', 'Delete'))) return;
            SG().deleteGroup(store, g);
            saveSubs(store, renderSubs);
          }, true)
        );
        head.appendChild(title);
        head.appendChild(headActs);
        wrap.appendChild(head);

        const addRow = document.createElement('div');
        addRow.className = 'group-add-row bar';
        const addInp = document.createElement('input');
        addInp.type = 'text';
        addInp.placeholder = 'Add channel — @handle, UC… id, or URL';
        addInp.className = 'flex-input';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'primary';
        addBtn.textContent = 'Add';
        const doAdd = () => {
          const parsed = SG().parseChannelInput(addInp.value);
          if (!parsed) {
            flash($('subs-status'), 'Could not parse channel — try @handle or youtube.com/channel/UC…', false);
            return;
          }
          SG().addToGroup(store, g, parsed.key, parsed.label || parsed.key);
          saveSubs(store, () => {
            addInp.value = '';
            renderSubs();
            flash($('subs-status'), 'Channel added.');
          });
        };
        addBtn.addEventListener('click', doAdd);
        addInp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            doAdd();
          }
        });
        addRow.appendChild(addInp);
        addRow.appendChild(addBtn);
        wrap.appendChild(addRow);

        const members = document.createElement('div');
        members.className = 'group-members';
        if (!store.groups[g].length) {
          members.appendChild(mkEmptyState('Empty group — add a channel above or use ＋ Group on YouTube.', []));
        }
        store.groups[g].forEach((key, idx) => {
          const chip = document.createElement('span');
          chip.className = 'chan-chip';
          chip.draggable = true;
          chip.dataset.key = key;
          chip.dataset.idx = String(idx);

          const grip = document.createElement('span');
          grip.className = 'chan-grip';
          grip.textContent = '⋮⋮';
          grip.title = 'Drag to reorder';
          chip.appendChild(grip);

          if (channelThumbUrl(thumbs, store, key)) chip.appendChild(mkDashChanAvatar(thumbs, store, key));

          const lbl = document.createElement('span');
          lbl.textContent = SG().channelDisplayLabel(store, key);
          chip.appendChild(lbl);

          if (allGroups.length > 1) {
            const mv = document.createElement('select');
            mv.className = 'chan-move';
            mv.title = 'Move to group';
            const opt0 = document.createElement('option');
            opt0.value = '';
            opt0.textContent = 'Move…';
            mv.appendChild(opt0);
            allGroups.forEach((gn) => {
              if (gn === g) return;
              const o = document.createElement('option');
              o.value = gn;
              o.textContent = gn;
              mv.appendChild(o);
            });
            mv.addEventListener('change', () => {
              if (!mv.value) return;
              SG().moveChannelToGroup(store, key, g, mv.value);
              saveSubs(store, () => {
                renderSubs();
                flash($('subs-status'), 'Moved to "' + mv.value + '".');
              });
            });
            chip.appendChild(mv);
          }

          const x = document.createElement('button');
          x.type = 'button';
          x.textContent = '×';
          x.title = 'Remove';
          x.setAttribute('aria-label', x.title);
          x.addEventListener('click', () => {
            SG().removeFromGroup(store, g, key);
            saveSubs(store, renderSubs);
          });
          chip.appendChild(x);

          chip.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', String(idx));
            chip.classList.add('dragging');
          });
          chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
          chip.addEventListener('dragover', (e) => {
            e.preventDefault();
            chip.classList.add('drag-over');
          });
          chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
          chip.addEventListener('drop', (e) => {
            e.preventDefault();
            chip.classList.remove('drag-over');
            const fromIdx = Number(e.dataTransfer.getData('text/plain'));
            const toIdx = idx;
            if (isNaN(fromIdx) || fromIdx === toIdx) return;
            SG().reorderInGroup(store, g, fromIdx, toIdx);
            saveSubs(store, renderSubs);
          });

          members.appendChild(chip);
        });
        wrap.appendChild(members);
        list.appendChild(wrap);
      });
      maybeAutoEnrichSubs(store);
    });
  }

  function addSmartChannelToGroup(sub, groupName) {
    if (!sub || !groupName) return;
    loadSubs((store, thumbs) => {
      const key = 'channel:' + sub.channelId;
      SG().createGroup(store, groupName);
      SG().addToGroup(store, groupName, key, sub.title || key);
      const handle = SG().handleKey(sub.handle);
      if (handle) {
        SG().setAlias(store, key, handle);
        store.names[handle] = sub.title || handle;
      }
      if (sub.thumb && SCT()) SCT().remember(thumbs, key, sub.thumb);
      saveSubThumbs(thumbs, () => saveSubs(store, () => {
        renderSubs();
        renderSubSmartRows();
        flash($('sub-smart-status'), 'Added ' + (sub.title || 'channel') + ' to ' + groupName + '.');
      }));
    });
  }

  function smartChannelRow(sub, groups) {
    const row = document.createElement('div');
    row.className = 'sub-smart-item';
    if (sub.thumb) {
      const img = document.createElement('img');
      img.src = sub.thumb;
      img.alt = '';
      row.appendChild(img);
    }
    const text = document.createElement('div');
    text.className = 'sub-smart-copy';
    const title = document.createElement('b');
    title.textContent = sub.title || sub.handle || sub.channelId;
    text.appendChild(title);
    if (sub.score) {
      const score = document.createElement('span');
      score.textContent = sub.score + '% taste match';
      text.appendChild(score);
    }
    row.appendChild(text);
    if (groups.length) {
      const select = document.createElement('select');
      const first = document.createElement('option');
      first.value = '';
      first.textContent = 'Add to…';
      select.appendChild(first);
      groups.forEach((group) => {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group;
        select.appendChild(option);
      });
      select.addEventListener('change', () => {
        if (select.value) addSmartChannelToGroup(sub, select.value);
      });
      row.appendChild(select);
    }
    return row;
  }

  function renderSmartSection(root, titleText, description, items, groups) {
    const section = document.createElement('section');
    section.className = 'sub-smart-section';
    const title = document.createElement('h4');
    title.textContent = titleText;
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = description;
    section.append(title, hint);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'sub-smart-empty';
      empty.textContent = 'Nothing to show yet.';
      section.appendChild(empty);
    } else items.forEach((item) => section.appendChild(smartChannelRow(item, groups)));
    root.appendChild(section);
  }

  function renderSubSmartRows() {
    const root = $('sub-smart-rows');
    if (!root || !window.UNSubSmartRows) return;
    chrome.storage.local.get(
      { subscribedChannels: { items: [], updatedAt: 0 }, subStore: { groups: {}, names: {} }, unTasteProfile: null, subSmartVideos: [] },
      (data) => {
        root.textContent = '';
        const subs = (data.subscribedChannels && data.subscribedChannels.items) || [];
        const groups = Object.keys((data.subStore && data.subStore.groups) || {});
        const suggested = UNSubSmartRows.suggestedChannels(subs, data.subStore, data.unTasteProfile, 8);
        const news = UNSubSmartRows.newsChannels(subs, 8);
        renderSmartSection(root, 'Suggested', 'Subscribed channels that fit your viewing and are not in a manual group.', suggested, groups);
        renderSmartSection(root, 'News', 'News and current-events subscriptions detected from your account list.', news, groups);

        const discover = document.createElement('section');
        discover.className = 'sub-smart-section';
        const heading = document.createElement('h4');
        heading.textContent = 'Discover';
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = 'Strong taste matches from channels you do not subscribe to, collected from videos YouTube already loaded.';
        discover.append(heading, hint);
        const videos = data.subSmartVideos || [];
        if (!videos.length) {
          const empty = document.createElement('div');
          empty.className = 'sub-smart-empty';
          empty.textContent = 'Browse YouTube Home with taste tracking on to fill this row.';
          discover.appendChild(empty);
        } else videos.slice(0, 8).forEach((video) => {
          const link = document.createElement('a');
          link.className = 'sub-smart-video';
          link.href = 'https://www.youtube.com/watch?v=' + video.videoId;
          link.target = '_blank';
          link.rel = 'noreferrer';
          const title = document.createElement('b');
          title.textContent = video.title;
          const meta = document.createElement('span');
          meta.textContent = (video.channelName || 'Unknown channel') + ' · ' + video.score + '% match';
          link.append(title, meta);
          discover.appendChild(link);
        });
        root.appendChild(discover);
      }
    );
  }

  if ($('refresh-sub-smart')) {
    $('refresh-sub-smart').addEventListener('click', () => {
      flash($('sub-smart-status'), 'Refreshing your subscription list…');
      send(UNMSG.YT_SUBSCRIPTIONS_MINE).then((result) => {
        if (!result || !result.ok) return flash($('sub-smart-status'), 'Refresh failed: ' + ((result && result.error) || 'not connected'), false);
        renderSubSmartRows();
        renderSubs();
        flash($('sub-smart-status'), (result.subs || []).length + ' subscriptions refreshed.');
      });
    });
  }
  $('add-group').addEventListener('click', () => {
    const name = $('new-group').value.trim();
    if (!name) return;
    loadSubs((store) => {
      SG().createGroup(store, name);
      saveSubs(store, () => {
        $('new-group').value = '';
        renderSubs();
        flash($('subs-status'), 'Created.');
      });
    });
  });
  if ($('subs-group-search')) {
    $('subs-group-search').addEventListener('input', (e) => {
      subsGroupSearch = e.target.value;
      renderSubs();
    });
  }
  if ($('subs-delete-empty')) {
    $('subs-delete-empty').addEventListener('click', () => {
      loadSubs(async (store) => {
        const empty = Object.keys(store.groups || {}).filter((g) => !(store.groups[g] || []).length);
        if (!empty.length) {
          flash($('subs-status'), 'No empty groups to delete.', false);
          return;
        }
        if (!(await uiConfirm('Delete ' + empty.length + ' empty group(s)?\n\n' + empty.join(', '), 'Delete'))) return;
        empty.forEach((g) => SG().deleteGroup(store, g));
        saveSubs(store, () => {
          renderSubs();
          flash($('subs-status'), 'Removed ' + empty.length + ' empty group(s).');
        });
      });
    });
  }
  $('export-groups').addEventListener('click', () => {
    loadSubs((store) => {
      const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'unsynth-sub-groups.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  });
  function parseGroupsRaw(raw) {
    const SubG = SG();
    const PF = window.UNPlaylistFolders;
    const kind = SubG.pocketTubeKind(raw);
    if (kind === 'playlists') {
      return { type: 'playlists', store: PF.fromPocketTube(raw) };
    }
    if (kind === 'subs' || SubG.isPocketTube(raw)) {
      return { type: 'subs', store: SubG.fromPocketTube(raw) };
    }
    if (raw && raw.folders && !raw.groups) {
      return { type: 'playlists', store: raw };
    }
    return { type: 'subs', store: raw };
  }
  function confirmSubsImport(store, sourceLabel) {
    const names = Object.keys((store && store.groups) || {});
    const n = names.length;
    if (!n) {
      flash($('subs-status'), 'No subscription groups in file.', false);
      return Promise.resolve(false);
    }
    const merge = $('import-groups-merge') && $('import-groups-merge').checked;
    const msg = merge
      ? 'Merge ' + n + ' group(s) from ' + sourceLabel + '?\n\n' + names.join(', ') + '\n\nChannels are added to matching group names.'
      : 'Replace ALL subscription groups with ' + n + ' group(s) from ' + sourceLabel + '?\n\n' + names.join(', ') + '\n\nExport first if you want a backup.';
    return uiConfirm(msg, merge ? 'Merge' : 'Replace');
  }
  function confirmPlImport(store, sourceLabel) {
    const PF = window.UNPlaylistFolders;
    const names = Object.keys((store && store.folders) || {});
    const n = names.length;
    if (!n) {
      flash(
        $('pl-folder-status'),
        'No playlist groups in file. Create folders in the dashboard or import valid JSON.',
        false
      );
      return Promise.resolve(false);
    }
    const merge = $('import-pl-folders-merge') && $('import-pl-folders-merge').checked;
    const total = PF.playlistCount(store);
    const emptyNote = total === 0 ? '\n\n(Folders have no playlists yet — add playlists in the dashboard.)' : '';
    const msg = merge
      ? 'Merge ' + n + ' folder(s) (' + total + ' playlists) from ' + sourceLabel + '?\n\n' + names.join(', ') + emptyNote
      : 'Replace ALL playlist groups with ' + n + ' folder(s) from ' + sourceLabel + '?\n\n' + names.join(', ') + emptyNote;
    return uiConfirm(msg, merge ? 'Merge' : 'Replace');
  }
  async function applyGroupsImport(raw, sourceLabel) {
    const parsed = parseGroupsRaw(raw);
    if (parsed.type === 'playlists') {
      return applyPlFoldersImport(parsed.store, sourceLabel || 'file');
    }
    const incoming = parsed.store;
    if (!(await confirmSubsImport(incoming, sourceLabel || 'file'))) return;
    const merge = $('import-groups-merge') && $('import-groups-merge').checked;
    const finish = (store) => {
      const n = Object.keys((store && store.groups) || {}).length;
      saveSubs(store, () => {
        renderSubs();
        flash($('subs-status'), 'Imported ' + n + ' group(s). Looking up names…');
        enrichNames();
      });
    };
    if (merge) {
      loadSubs((existing) => finish(SG().mergeStores(existing, incoming)));
    } else {
      finish(incoming);
    }
  }
  $('import-groups').addEventListener('click', () => $('import-groups-file').click());
  $('import-groups-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        applyGroupsImport(JSON.parse(r.result), f.name || 'file');
      } catch (err) {
        flash($('subs-status'), 'Bad file', false);
      }
    };
    r.readAsText(f);
    e.target.value = '';
  });
  if ($('import-groups-bundled')) {
    $('import-groups-bundled').addEventListener('click', () => {
      flash($('subs-status'), 'Loading bundled PocketTube…');
      fetch(chrome.runtime.getURL('youtube-history-to-import/pockettube-subscription-manager.json'))
        .then((r) => {
          if (!r.ok) throw new Error('missing');
          return r.json();
        })
        .then((raw) => applyGroupsImport(raw, 'bundled PocketTube subs'))
        .catch(() => flash($('subs-status'), 'Bundled PocketTube file not found in extension folder.', false));
    });
  }
  // Look up real channel names for imported "channel:UC…" keys via the worker.
  function syncGroupedSubsTitles() {
    send(UNMSG.YT_SUBSCRIPTIONS_MINE).then((r) => {
      if (!r || !r.ok || !(r.subs && r.subs.length)) return;
      loadSubs((store, thumbs) => {
        const idsInGroups = {};
        Object.values(store.groups || {}).forEach((arr) =>
          (arr || []).forEach((k) => {
            if (k.indexOf('channel:') === 0) idsInGroups[k.slice(8)] = true;
          })
        );
        let touched = false;
        store.names = store.names || {};
        const sct = SCT();
        (r.subs || []).forEach((s) => {
          if (!s.channelId || !idsInGroups[s.channelId]) return;
          const key = 'channel:' + s.channelId;
          if (!store.names[key] || SG().isUnresolvedLabel(store.names[key], key)) {
            store.names[key] = s.title;
            touched = true;
          }
          if (sct && s.thumb) sct.remember(thumbs, key, s.thumb);
        });
        if (!touched) return;
        saveSubThumbs(thumbs, () => saveSubs(store, renderSubs));
      });
    });
  }

  function enrichNames(then) {
    loadSubs((store, thumbs) => {
      const allIds = SG().unresolvedChannelIds(store);
      if (!allIds.length) {
        flash($('subs-status'), 'All channel names are resolved.');
        then && then();
        return;
      }
      const total = allIds.length;
      let rounds = 0;
      const maxRounds = Math.min(12, Math.ceil(total / 50) + 2);

      (async function run() {
        try {
        let ids = SG().unresolvedChannelIds(store);
        while (ids.length && rounds < maxRounds) {
          rounds++;
          const batch = ids.slice(0, 50);
          const done = total - ids.length + batch.length;
          flash($('subs-status'), 'Fetching names… ' + Math.min(done, total) + '/' + total);
          const r = await send(UNMSG.YT_CHANNEL_NAMES, { ids: batch });
          if (!r.ok || !r.names || !Object.keys(r.names).length) {
            subsAutoEnrichDone = false;
            flash(
              $('subs-status'),
              'Name lookup failed' + (r.error ? ': ' + r.error : '') + ' — reload extension and try again.',
              false
            );
            then && then();
            return;
          }
          SG().applyChannelNames(store, r.names, r.thumbs, r.handles);
          const sct = SCT();
          let thumbTouched = false;
          if (sct && r.thumbs) {
            for (const id in r.thumbs) {
              if (sct.remember(thumbs, 'channel:' + id, r.thumbs[id])) thumbTouched = true;
            }
          }
          if (thumbTouched) await new Promise((res) => saveSubThumbs(thumbs, res));
          await new Promise((res) => saveSubs(store, res));
          ids = SG().unresolvedChannelIds(store);
        }
        renderSubs();
        const left = SG().unresolvedChannelIds(store).length;
        if (left) {
          subsAutoEnrichDone = false;
          flash($('subs-status'), 'Updated names — ' + left + ' still unresolved.', false);
        } else {
          flash($('subs-status'), 'Names updated.');
        }
        then && then();
        } catch (e) {
          // Without this the status stayed on "Fetching names…" forever and
          // subsAutoEnrichDone stayed true, silently blocking every later
          // auto-enrich attempt until the page was reloaded.
          subsAutoEnrichDone = false;
          flash($('subs-status'), 'Could not fetch names: ' + ((e && e.message) || 'unexpected error'), false);
          then && then();
        }
      })();
    });
  }
  $('fetch-names').addEventListener('click', () => enrichNames());

  // ---- playlist groups (built-in; PocketTube import optional) ----
  const PF = () => window.UNPlaylistFolders;
  function loadPlFolders(cb) {
    chrome.storage.local.get({ plFolderStore: PF().empty() }, (d) => cb(d.plFolderStore || PF().empty()));
  }
  function savePlFolders(store, then) {
    const api = PF();
    if (api && api.persistFolders) {
      // Dashboard holds the authoritative edited store (renames/deletes).
      api.persistFolders(store, function (_merged, err) {
        if (then) then(err);
      }, { authoritative: true });
      return;
    }
    chrome.storage.local.set({ plFolderStore: store }, then || function () {});
  }
  function renderPlFolders() {
    const list = $('pl-folder-list');
    if (!list) return;
    loadPlFolders((store) => {
      list.textContent = '';
      const names = Object.keys(store.folders || {});
      if (!names.length) {
        list.appendChild(
          mkEmptyState('No playlist groups yet. Create a folder above, paste a playlist URL, or add from your YouTube account.', [
            ['Add from YouTube', () => $('import-pl-from-yt').click(), true],
            ['Create folder', () => $('new-pl-folder').focus()]
          ])
        );
        return;
      }
      const allFolders = names.slice();
      names.forEach((f) => {
        const wrap = document.createElement('div');
        wrap.className = 'group-card pl';
        const head = document.createElement('div');
        head.className = 'group-head';
        const title = document.createElement('b');
        title.textContent = f + '  (' + (store.folders[f] || []).length + ')';
        const headActs = document.createElement('div');
        headActs.className = 'group-head-actions';
        headActs.appendChild(
          mkHeadBtn('Rename', async () => {
            const nn = await uiPrompt('Rename folder', f);
            if (!nn || nn.trim() === f) return;
            PF().renameFolder(store, f, nn.trim());
            savePlFolders(store, () => {
              renderPlFolders();
              flash($('pl-folder-status'), 'Renamed.');
            });
          })
        );
        headActs.appendChild(
          mkHeadBtn('Delete', async () => {
            if (!(await uiConfirm('Delete folder "' + f + '"? Playlists are not deleted from YouTube.', 'Delete'))) return;
            PF().deleteFolder(store, f);
            savePlFolders(store, renderPlFolders);
          }, true)
        );
        head.appendChild(title);
        head.appendChild(headActs);
        wrap.appendChild(head);

        const addRow = document.createElement('div');
        addRow.className = 'group-add-row bar';
        const addInp = document.createElement('input');
        addInp.type = 'text';
        addInp.placeholder = 'Add playlist — PL… id or youtube.com/playlist?list=…';
        addInp.className = 'flex-input';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'primary';
        addBtn.textContent = 'Add';
        const doAdd = () => {
          const plId = PF().parsePlaylistInput(addInp.value);
          if (!plId) {
            flash($('pl-folder-status'), 'Could not parse playlist — need a PL… id or playlist URL', false);
            return;
          }
          PF().addToFolder(store, f, plId);
          savePlFolders(store, () => {
            addInp.value = '';
            renderPlFolders();
            flash($('pl-folder-status'), 'Playlist added.');
          });
        };
        addBtn.addEventListener('click', doAdd);
        addInp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            doAdd();
          }
        });
        addRow.appendChild(addInp);
        addRow.appendChild(addBtn);
        wrap.appendChild(addRow);

        const members = document.createElement('div');
        members.className = 'group-members';
        if (!(store.folders[f] || []).length) {
          members.appendChild(mkEmptyState('Empty folder — add a playlist above or use ＋ Folder on YouTube.', []));
        }
        (store.folders[f] || []).forEach((plId, idx) => {
          const chip = document.createElement('span');
          chip.className = 'chan-chip pl';
          chip.draggable = true;
          chip.dataset.plId = plId;
          chip.dataset.idx = String(idx);

          const grip = document.createElement('span');
          grip.className = 'chan-grip';
          grip.textContent = '⋮⋮';
          chip.appendChild(grip);

          const lbl = document.createElement('span');
          const label = (store.names && store.names[plId]) || plId;
          lbl.textContent = label;
          if (store.names && store.names[plId]) chip.title = plId;
          chip.appendChild(lbl);

          if (allFolders.length > 1) {
            const mv = document.createElement('select');
            mv.className = 'chan-move';
            const opt0 = document.createElement('option');
            opt0.value = '';
            opt0.textContent = 'Move…';
            mv.appendChild(opt0);
            allFolders.forEach((fn) => {
              if (fn === f) return;
              const o = document.createElement('option');
              o.value = fn;
              o.textContent = fn;
              mv.appendChild(o);
            });
            mv.addEventListener('change', () => {
              if (!mv.value) return;
              PF().movePlaylistToFolder(store, plId, f, mv.value);
              savePlFolders(store, () => {
                renderPlFolders();
                flash($('pl-folder-status'), 'Moved to "' + mv.value + '".');
              });
            });
            chip.appendChild(mv);
          }

          const x = document.createElement('button');
          x.type = 'button';
          x.textContent = '×';
          x.title = 'Remove';
          x.setAttribute('aria-label', x.title);
          x.addEventListener('click', () => {
            PF().removeFromFolder(store, f, plId);
            savePlFolders(store, renderPlFolders);
          });
          chip.appendChild(x);

          chip.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', String(idx));
            chip.classList.add('dragging');
          });
          chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
          chip.addEventListener('dragover', (e) => {
            e.preventDefault();
            chip.classList.add('drag-over');
          });
          chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
          chip.addEventListener('drop', (e) => {
            e.preventDefault();
            chip.classList.remove('drag-over');
            const fromIdx = Number(e.dataTransfer.getData('text/plain'));
            const toIdx = idx;
            if (isNaN(fromIdx) || fromIdx === toIdx) return;
            const arr = store.folders[f];
            if (!arr) return;
            const item = arr.splice(fromIdx, 1)[0];
            arr.splice(toIdx, 0, item);
            savePlFolders(store, renderPlFolders);
          });

          members.appendChild(chip);
        });
        wrap.appendChild(members);
        list.appendChild(wrap);
      });
    });
  }
  async function applyPlFoldersImport(raw, sourceLabel) {
    const incoming = raw.folders ? raw : PF().fromPocketTube(raw);
    if (!PF().folderCount(incoming) && PF().isEmptyPocketTubePlaylistExport(raw)) {
      flash(
        $('pl-folder-status'),
        'Import has no playlist folders. Create groups in the dashboard, add from YouTube, or use a valid JSON / PocketTube export.',
        false
      );
      return;
    }
    if (!(await confirmPlImport(incoming, sourceLabel || 'file'))) return;
    const merge = $('import-pl-folders-merge') && $('import-pl-folders-merge').checked;
    const finish = (store) => {
      const n = PF().folderCount(store);
      const p = PF().playlistCount(store);
      savePlFolders(store, () => {
        renderPlFolders();
        flash($('pl-folder-status'), 'Imported ' + n + ' folder(s), ' + p + ' playlist(s).');
        enrichPlTitles();
      });
    };
    if (merge) {
      loadPlFolders((existing) => finish(PF().mergeFolders(existing, incoming)));
    } else {
      finish(incoming);
    }
  }
  function enrichPlTitles(then) {
    loadPlFolders((store) => {
      const need = new Set();
      Object.values(store.folders || {}).forEach((arr) =>
        (arr || []).forEach((id) => {
          if (!store.names || !store.names[id]) need.add(id);
        })
      );
      if (!need.size) {
        flash($('pl-folder-status'), 'All playlist titles already known.');
        return then && then();
      }
      flash($('pl-folder-status'), 'Fetching playlist titles…');
      send(UNMSG.YT_PLAYLISTS_MINE).then((r) => {
        if (!r || !r.ok) {
          flash(
            $('pl-folder-status'),
            'Folders saved — connect YouTube on Account tab, then Fetch playlist titles.',
            false
          );
          return then && then();
        }
        store.names = store.names || {};
        (r.playlists || []).forEach((p) => {
          if (p.id && need.has(p.id)) store.names[p.id] = p.title || p.id;
        });
        savePlFolders(store, () => {
          renderPlFolders();
          flash($('pl-folder-status'), 'Playlist titles updated.');
          then && then();
        });
      });
    });
  }
  if ($('export-pl-folders')) {
    $('export-pl-folders').addEventListener('click', () => {
      loadPlFolders((store) => {
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'unsynth-playlist-folders.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
    });
  }
  if ($('import-pl-folders')) {
    $('import-pl-folders').addEventListener('click', () => $('import-pl-folders-file').click());
  }
  if ($('import-pl-folders-file')) {
    $('import-pl-folders-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          applyPlFoldersImport(JSON.parse(r.result), f.name || 'file');
        } catch (err) {
          flash($('pl-folder-status'), 'Bad file', false);
        }
      };
      r.readAsText(f);
      e.target.value = '';
    });
  }
  if ($('import-pl-folders-bundled')) {
    $('import-pl-folders-bundled').addEventListener('click', () => {
      flash($('pl-folder-status'), 'Loading bundled playlist map…');
      Promise.all([
        fetch(chrome.runtime.getURL('youtube-history-to-import/pockettube-playlist-manager.json')),
        fetch(chrome.runtime.getURL('youtube-history-to-import/pockettube-subscription-manager.json'))
      ])
        .then(([plRes, subRes]) => {
          if (!plRes.ok) throw new Error('missing');
          return Promise.all([plRes.json(), subRes.ok ? subRes.json() : null]);
        })
        .then(async ([plRaw, subRaw]) => {
          const incoming = PF().resolveBundledImport(plRaw, subRaw);
          if (!PF().folderCount(incoming)) {
            flash(
              $('pl-folder-status'),
              'Bundled playlist map is empty — create groups in the dashboard or add playlists from YouTube.',
              false
            );
            return;
          }
          if (!(await confirmPlImport(incoming, 'bundled PocketTube playlists'))) return;
          const merge = $('import-pl-folders-merge') && $('import-pl-folders-merge').checked;
          const finish = (store) => {
            const n = PF().folderCount(store);
            const p = PF().playlistCount(store);
            savePlFolders(store, () => {
              renderPlFolders();
              flash($('pl-folder-status'), 'Imported ' + n + ' folder(s), ' + p + ' playlist(s).');
              enrichPlTitles();
            });
          };
          if (merge) loadPlFolders((existing) => finish(PF().mergeFolders(existing, incoming)));
          else finish(incoming);
        })
        .catch(() => flash($('pl-folder-status'), 'Bundled playlist file not found.', false));
    });
  }
  if ($('fetch-pl-titles')) $('fetch-pl-titles').addEventListener('click', () => enrichPlTitles());
  function loadPlPins(cb) {
    chrome.storage.local.get({ plPins: PF().emptyPins() }, (d) => cb(PF().normalizePins(d.plPins)));
  }
  function savePlPins(pins, then) {
    if (PF() && PF().persistPins) PF().persistPins(pins, then);
    else chrome.storage.local.set({ plPins: pins }, then || function () {});
  }
  function renderPlYtImport(playlists) {
    const box = $('pl-yt-import');
    if (!box) return;
    box.textContent = '';
    if (!playlists.length) {
      flash($('pl-folder-status'), 'No playlists found on your channel.');
      return;
    }
    loadPlFolders((store) => {
      loadPlPins((pins) => {
        const folderNames = Object.keys(store.folders || {});
        flash($('pl-folder-status'), playlists.length + ' playlists loaded — pin to the sidebar (or optionally add to a folder).');
        const ctl = document.createElement('div');
        ctl.className = 'bar';
        ctl.style.margin = '12px 0';
        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.textContent = 'Select all';
        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'primary';
        pinBtn.textContent = 'Pin selected to sidebar';
        ctl.appendChild(allBtn);
        ctl.appendChild(pinBtn);
        if (folderNames.length) {
          const folderSel = document.createElement('select');
          folderSel.id = 'pl-yt-folder-sel';
          folderSel.style.flex = '1';
          folderNames.forEach((fn) => {
            const o = document.createElement('option');
            o.value = fn;
            o.textContent = fn;
            folderSel.appendChild(o);
          });
          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.textContent = 'Also add to folder';
          ctl.appendChild(folderSel);
          ctl.appendChild(addBtn);
          addBtn.addEventListener('click', () => {
            const folder = folderSel.value;
            const checked = Array.prototype.slice.call(list.querySelectorAll('input[type=checkbox]:checked'));
            if (!folder || !checked.length) {
              flash($('pl-folder-status'), 'Select playlists and a folder first', false);
              return;
            }
            store.names = store.names || {};
            let added = 0;
            checked.forEach((cb) => {
              const before = (store.folders[folder] || []).length;
              PF().addToFolder(store, folder, cb.value, cb.dataset.title);
              if ((store.folders[folder] || []).length > before) added++;
            });
            savePlFolders(store, () => {
              renderPlFolders();
              flash($('pl-folder-status'), 'Added ' + added + ' playlist(s) to "' + folder + '".');
            });
          });
        }
        box.appendChild(ctl);

        const list = document.createElement('div');
        list.className = 'subimport-list';
        playlists.forEach((p) => {
          const row = document.createElement('label');
          row.className = 'subimport-row';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = p.id;
          cb.dataset.title = p.title || p.id;
          if (PF().isPinned(pins, p.id)) cb.checked = true;
          const name = document.createElement('span');
          const count = p.count != null ? ' (' + p.count + ')' : '';
          name.textContent = (p.title || p.id) + count + (PF().isPinned(pins, p.id) ? ' · pinned' : '');
          row.appendChild(cb);
          row.appendChild(name);
          list.appendChild(row);
        });
        box.appendChild(list);

        allBtn.addEventListener('click', () => {
          const cbs = list.querySelectorAll('input[type=checkbox]');
          const anyUnchecked = Array.prototype.some.call(cbs, (c) => !c.checked);
          cbs.forEach((c) => (c.checked = anyUnchecked));
        });
        pinBtn.addEventListener('click', () => {
          const checked = Array.prototype.slice.call(list.querySelectorAll('input[type=checkbox]:checked'));
          if (!checked.length) {
            flash($('pl-folder-status'), 'Select at least one playlist', false);
            return;
          }
          let added = 0;
          checked.forEach((cb) => {
            const before = pins.ids.length;
            pins = PF().pinPlaylist(pins, cb.value, cb.dataset.title);
            if (pins.ids.length > before) added++;
          });
          savePlPins(pins, () => {
            box.textContent = '';
            flash($('pl-folder-status'), 'Pinned ' + added + ' playlist(s) to the YouTube sidebar.');
          });
        });
      });
    });
  }
  if ($('import-pl-from-yt')) {
    $('import-pl-from-yt').addEventListener('click', () => {
      flash($('pl-folder-status'), 'Fetching your playlists…');
      send(UNMSG.YT_PLAYLISTS_MINE).then((r) => {
        if (!r || !r.ok) {
          flash($('pl-folder-status'), 'Failed: ' + ((r && r.error) || '') + ' (Connect YouTube first)', false);
          return;
        }
        renderPlYtImport(r.playlists || []);
      });
    });
  }
  if ($('add-pl-folder')) {
    $('add-pl-folder').addEventListener('click', () => {
      const name = ($('new-pl-folder') && $('new-pl-folder').value || '').trim();
      if (!name) return;
      loadPlFolders((store) => {
        PF().createFolder(store, name);
        savePlFolders(store, () => {
          if ($('new-pl-folder')) $('new-pl-folder').value = '';
          renderPlFolders();
          flash($('pl-folder-status'), 'Folder created.');
        });
      });
    });
  }
  renderPlFolders();

  // ---- playlist-group sidebar display prefs ----
  function loadPlPrefs(cb) {
    chrome.storage.local.get({ plFolderPrefs: null }, (d) => cb(PF().normalizePrefs(d.plFolderPrefs)));
  }
  function renderPlPrefs() {
    if (!$('pl-folder-prefs')) return;
    loadPlPrefs((p) => {
      if ($('pl-pref-sidebar')) $('pl-pref-sidebar').checked = p.sidebar;
      if ($('pl-pref-showall')) $('pl-pref-showall').checked = p.showAll;
      if ($('pl-pref-hideempty')) $('pl-pref-hideempty').checked = p.hideEmpty;
      if ($('pl-pref-sort')) $('pl-pref-sort').value = p.sort;
      if ($('pl-pref-showhistory')) $('pl-pref-showhistory').checked = p.showHistory;
      if ($('pl-pref-showliked')) $('pl-pref-showliked').checked = p.showLiked;
      if ($('pl-pref-showwatchlater')) $('pl-pref-showwatchlater').checked = p.showWatchLater;
    });
  }
  function savePlPrefsFromForm() {
    const prefs = PF().normalizePrefs({
      sidebar: $('pl-pref-sidebar') ? $('pl-pref-sidebar').checked : true,
      showAll: $('pl-pref-showall') ? $('pl-pref-showall').checked : true,
      hideEmpty: $('pl-pref-hideempty') ? $('pl-pref-hideempty').checked : false,
      sort: $('pl-pref-sort') ? $('pl-pref-sort').value : 'manual',
      // normalizePrefs() rebuilds the whole prefs object, so these have to be
      // read back here — omitting one resets it to its default on every save.
      showHistory: $('pl-pref-showhistory') ? $('pl-pref-showhistory').checked : true,
      showLiked: $('pl-pref-showliked') ? $('pl-pref-showliked').checked : true,
      showWatchLater: $('pl-pref-showwatchlater') ? $('pl-pref-showwatchlater').checked : true
    });
    chrome.storage.local.set({ plFolderPrefs: prefs }, () => flash($('pl-folder-status'), 'Sidebar display updated.'));
  }
  [
    'pl-pref-sidebar',
    'pl-pref-showall',
    'pl-pref-hideempty',
    'pl-pref-sort',
    'pl-pref-showhistory',
    'pl-pref-showliked',
    'pl-pref-showwatchlater'
  ].forEach((id) => {
    if ($(id)) $(id).addEventListener('change', savePlPrefsFromForm);
  });
  renderPlPrefs();

  // ---- import all subscriptions (via the Data API) and group them fast ----
  $('import-subs').addEventListener('click', () => {
    flash($('subs-status'), 'Fetching your subscriptions…');
    send(UNMSG.YT_SUBSCRIPTIONS_MINE).then((r) => {
      if (!r || !r.ok) {
        flash($('subs-status'), 'Failed: ' + ((r && r.error) || '') + ' (Connect YouTube first)', false);
        return;
      }
      send(UNMSG.SUBS_CACHE_REFRESH);
      renderSubImport(r.subs || []);
    });
  });
  function renderSubImport(subs) {
    const box = $('subs-import');
    box.textContent = '';
    if (!subs.length) {
      flash($('subs-status'), 'No subscriptions found.');
      return;
    }
    flash($('subs-status'), subs.length + ' subscriptions loaded — pick channels and a group.');
    const ctl = document.createElement('div');
    ctl.className = 'bar';
    ctl.style.margin = '12px 0';
    const grpInput = document.createElement('input');
    grpInput.type = 'text';
    grpInput.placeholder = 'Group name';
    grpInput.style.flex = '1';
    const allBtn = document.createElement('button');
    allBtn.textContent = 'Select all';
    const addBtn = document.createElement('button');
    addBtn.className = 'primary';
    addBtn.textContent = 'Add selected to group';
    ctl.appendChild(grpInput);
    ctl.appendChild(allBtn);
    ctl.appendChild(addBtn);
    box.appendChild(ctl);

    const list = document.createElement('div');
    list.className = 'subimport-list';
    subs.forEach((s) => {
      const row = document.createElement('label');
      row.className = 'subimport-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.channelId;
      cb.dataset.title = s.title;
      cb.dataset.handle = s.handle || '';
      const img = document.createElement('img');
      img.className = 'subimport-thumb';
      img.src = s.thumb || '';
      img.alt = '';
      const name = document.createElement('span');
      name.textContent = s.title;
      row.appendChild(cb);
      row.appendChild(img);
      row.appendChild(name);
      list.appendChild(row);
    });
    box.appendChild(list);

    allBtn.addEventListener('click', () => {
      const cbs = list.querySelectorAll('input[type=checkbox]');
      const anyUnchecked = Array.prototype.some.call(cbs, (c) => !c.checked);
      cbs.forEach((c) => (c.checked = anyUnchecked));
    });
    addBtn.addEventListener('click', () => {
      const gname = grpInput.value.trim();
      if (!gname) {
        flash($('subs-status'), 'Enter a group name first', false);
        return;
      }
      const checked = Array.prototype.slice.call(list.querySelectorAll('input[type=checkbox]:checked'));
      if (!checked.length) {
        flash($('subs-status'), 'Select some channels first', false);
        return;
      }
      loadSubs((store, thumbs) => {
        store.groups = store.groups || {};
        store.names = store.names || {};
        store.groups[gname] = store.groups[gname] || [];
        const sct = SCT();
        checked.forEach((cb) => {
          const key = 'channel:' + cb.value;
          if (store.groups[gname].indexOf(key) === -1) store.groups[gname].push(key);
          store.names[key] = cb.dataset.title;
          if (sct) {
            const row = cb.closest('.subimport-row');
            const img = row && row.querySelector('.subimport-thumb');
            const src = img && (img.getAttribute('src') || img.src);
            if (src) sct.remember(thumbs, key, src);
          }
          // map channelId ⇄ @handle so the feed filter matches handle-linked tiles
          const hk = SG().handleKey(cb.dataset.handle);
          if (hk) {
            window.UNSubGroups.setAlias(store, key, hk);
            store.names[hk] = cb.dataset.title;
          }
        });
        saveSubThumbs(thumbs, () => {
          saveSubs(store, () => {
            renderSubs();
            flash($('subs-status'), 'Added ' + checked.length + ' to "' + gname + '".');
          });
        });
      });
    });
  }

  renderSubs();
  renderSubSmartRows();
  // live-refresh when stores change from YouTube UI
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.subStore || changes.subChannelThumbs) renderSubs();
    if (changes.subStore || changes.subscribedChannels || changes.unTasteProfile || changes.subSmartVideos) renderSubSmartRows();
    if (changes.plFolderStore) renderPlFolders();
    if (changes.plFolderPrefs) renderPlPrefs();
    if (changes.subActive || changes.plFolderActive) refreshActiveFilters();
    if (changes.watchStats || changes.searchStats || changes.forgeLastSync || changes.forgeSync) refreshForgeCards();
  });
