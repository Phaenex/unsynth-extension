'use strict';

/**
 * "Mark a playlist as already watched" card (Watched tab).
 *
 * Loaded AFTER dashboard-core.js, so its shared globals ($, send, flash,
 * uiConfirm, UNMSG) already exist — the same arrangement dashboard-account.js
 * and dashboard-history-sync.js use.
 *
 * Flow, deliberately in this order:
 *   1. list the user's playlists and pre-tick the ones whose names look like
 *      "already watched" lists (UNSeenPlaylists.looksWatched — which knows
 *      that "unseen picks" is the OPPOSITE and must never match)
 *   2. read the ticked ones and show the REAL video count
 *   3. only then, on an explicit confirm, write
 *
 * Reads go through the extension's own OAuth handlers (YT_PLAYLISTS_MINE /
 * YT_PLAYLIST_ITEMS in the service worker) rather than scraping. The scrape
 * path is not viable here: YouTube now returns lockupViewModel instead of
 * playlistVideoRenderer, and a page-world Innertube probe against this
 * account returned zero items for two of the three playlists with no
 * explanation. The OAuth handler pages properly to 5,000 items and is already
 * the path playlist-bulk uses.
 *
 * All writing goes through UNSeenPlaylists.mergeSeenIds, which owns the
 * additive-only and approximate-date rules. There is no second write path
 * here on purpose.
 */
(function () {
  const SP = window.UNSeenPlaylists;
  const openBtn = $('seen-playlists-open');
  if (!openBtn || !SP) return;

  const panel = $('seen-playlists-panel');
  const listEl = $('seen-playlists-list');
  const statusEl = $('seen-playlists-status');
  const scanStatusEl = $('seen-playlists-scan-status');
  const progressEl = $('seen-playlists-progress');
  const scanBtn = $('seen-playlists-scan');
  const cancelBtn = $('seen-playlists-cancel');

  let playlists = [];
  let busy = false;

  const esc = (s) =>
    String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const SCAN_LABEL = 'Count videos in selected';

  /**
   * One place that owns the busy state. Two separate exit paths re-enable the
   * scan button (read failure, and the storage.set callback); resetting the
   * label at each of them by hand is how a button ends up stuck on "Reading…"
   * forever the one time a path is missed.
   */
  function setBusy(on) {
    busy = on;
    scanBtn.disabled = on;
    openBtn.disabled = on;
    scanBtn.textContent = on ? 'Reading…' : SCAN_LABEL;
  }

  function setProgress(text) {
    if (!progressEl) return;
    if (!text) {
      progressEl.hidden = true;
      progressEl.textContent = '';
      return;
    }
    progressEl.hidden = false;
    progressEl.textContent = text;
  }

  // Persistent outcome panel. flash() clears itself after 2600ms, which is
  // fine for "Saved" on a checkbox and useless for an import that runs for
  // minutes: the user looks away, it finishes, and the only report of what
  // happened erases itself. This stays on screen until the next run.
  const resultEl = document.getElementById('seen-playlists-result');
  function setResult(html) {
    if (!resultEl) return;
    if (!html) {
      resultEl.hidden = true;
      resultEl.innerHTML = '';
      return;
    }
    resultEl.hidden = false;
    resultEl.innerHTML = html;
  }

  // One row per playlist read, so the user can see WHICH list gave what, and
  // in particular which came back empty. The live progress line is overwritten
  // by the next playlist, so without this the detail is gone by the end.
  function resultTable(rows) {
    return (
      '<table class="un-seen-tbl"><thead><tr><th>Playlist</th><th>Videos read</th></tr></thead><tbody>' +
      rows
        .map(
          (r) =>
            '<tr><td>' +
            esc(r.title) +
            '</td><td>' +
            (r.error
              ? '<span class="un-seen-bad">' + esc(r.error) + '</span>'
              : r.n === 0
                ? '<span class="un-seen-bad">0 — empty</span>'
                : r.n.toLocaleString()) +
            '</td></tr>'
        )
        .join('') +
      '</tbody></table>'
    );
  }

  function renderList() {
    if (!listEl) return;
    if (!playlists.length) {
      listEl.innerHTML = '<p class="hint">No playlists found on this account.</p>';
      return;
    }
    const suggested = Object.create(null);
    SP.suggestPlaylists(playlists).forEach((pl) => {
      suggested[pl.id] = true;
    });
    // noneSuggested: the pre-tick is a NAME heuristic. When it matches nothing
    // the panel opened with every box clear and the only feedback was a generic
    // "Tick at least one playlist first" after the user pressed scan, which
    // reads as the feature being broken rather than as "pick your lists".
    const noneSuggested = !Object.keys(suggested).length;
    const notice = noneSuggested
      ? '<p class="hint">Nothing here looked like an already-watched list, so none are ticked. Tick the ones you want treated as watched.</p>'
      : '';
    listEl.innerHTML = notice + playlists
      .map((pl) => {
        const id = esc(pl.id);
        const on = suggested[pl.id] ? ' checked' : '';
        const n = Number(pl.count) || 0;
        return (
          '<label class="row"><input type="checkbox" class="seen-pl-box" value="' +
          id +
          '"' +
          on +
          ' /> ' +
          esc(pl.title || '(untitled)') +
          ' <span class="hint">(' +
          n.toLocaleString() +
          (n === 1 ? ' video)' : ' videos)') +
          '</span></label>'
        );
      })
      .join('');
  }

  function chosenIds() {
    return Array.from(document.querySelectorAll('.seen-pl-box'))
      .filter((b) => b.checked)
      .map((b) => b.value);
  }

  function titleOf(id) {
    const hit = playlists.filter((p) => p.id === id)[0];
    return (hit && hit.title) || id;
  }

  openBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    openBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Loading your playlists…';
    const r = await send(UNMSG.YT_PLAYLISTS_MINE);
    busy = false;
    openBtn.disabled = false;
    if (!r || !r.ok) {
      const why = (r && r.error) || 'unknown error';
      flash(
        statusEl,
        why === 'no_token' || /auth|token/i.test(why)
          ? 'Connect your Google account on the Account tab first.'
          : 'Could not load playlists: ' + why,
        false
      );
      return;
    }
    playlists = r.playlists || [];
    if (statusEl) statusEl.textContent = '';
    renderList();
    if (panel) panel.hidden = false;
  });

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (busy) return;
      if (panel) panel.hidden = true;
      setProgress('');
      if (scanStatusEl) scanStatusEl.textContent = '';
    });
  }

  scanBtn.addEventListener('click', async () => {
    if (busy) return;
    const ids = chosenIds();
    if (!ids.length) {
      flash(scanStatusEl, 'Tick at least one playlist first.', false);
      return;
    }

    // A few thousand videos pages in 50s, so this can run for minutes. A
    // disabled button alone reads as "stuck"; say what it is doing.
    setBusy(true);
    if (scanStatusEl) scanStatusEl.textContent = '';
    setResult('');

    // ---- read phase ----------------------------------------------------
    // Collected across playlists, deduplicated, and NOT written yet. A
    // failure part-way through leaves the store untouched; whatever was read
    // before the failure is still offered, because ids from a playlist that
    // did read are perfectly good watched state. Nothing is invented to
    // stand in for a playlist that failed.
    const collected = Object.create(null);
    const failures = [];
    const empties = [];
    const perPlaylist = [];
    let done = 0;

    for (const plId of ids) {
      done++;
      setProgress('Reading ' + done + ' of ' + ids.length + ' — ' + titleOf(plId) + '…');
      let r;
      try {
        r = await send(UNMSG.YT_PLAYLIST_ITEMS, { playlistId: plId, fresh: true });
      } catch (e) {
        r = { ok: false, error: (e && e.message) || 'read_failed' };
      }
      if (!r || !r.ok) {
        const why = (r && r.error) || 'failed';
        failures.push(titleOf(plId) + ' (' + why + ')');
        perPlaylist.push({ title: titleOf(plId), n: 0, error: why });
        continue;
      }
      perPlaylist.push({ title: titleOf(plId), n: (r.items || []).length, error: null });
      // ok:true with zero items is NOT a failure, so it used to fall through
      // in complete silence. That is how an import can report a total far
      // below what the user knows is in their playlists and give no clue
      // which list came back empty. Name them.
      if (!(r.items || []).length) empties.push(titleOf(plId));
      (r.items || []).forEach((it) => {
        const v = it && it.videoId;
        if (v) collected[v] = true;
      });
      setProgress(
        'Read ' + done + ' of ' + ids.length + ' — ' + Object.keys(collected).length.toLocaleString() + ' videos so far…'
      );
    }

    const found = Object.keys(collected);
    setProgress('');
    setBusy(false);

    if (!found.length) {
      const why = [];
      if (failures.length) why.push('Could not read: ' + failures.join('; '));
      if (empties.length) why.push('Read but empty: ' + empties.join('; '));
      flash(
        scanStatusEl,
        why.length ? why.join(' — ') : 'Those playlists contain no videos.',
        false
      );
      setResult(
        '<p class="un-seen-head un-seen-bad">No videos were read.</p>' +
          resultTable(perPlaylist) +
          '<p class="hint">Nothing was changed. A playlist reading 0 is usually private to another account, or empty.</p>'
      );
      return;
    }

    // ---- confirm phase -------------------------------------------------
    // How many are genuinely new is computed against the live store, so the
    // number the user confirms is the number that will actually change.
    const cur = await new Promise((resolve) =>
      chrome.storage.local.get(
        { watchedVideos: [], watchedDates: {}, watchedDatesApprox: {} },
        (d) => resolve(d || {})
      )
    );
    const preview = SP.mergeSeenIds(cur, found, { now: Date.now() });

    if (!preview.added) {
      const noteEmpty = empties.length
        ? ' (' + empties.length + ' playlist(s) read as empty: ' + empties.join('; ') + ')'
        : '';
      flash(
        scanStatusEl,
        'Already up to date — all ' + found.length.toLocaleString() +
          ' of those videos are marked watched.' + noteEmpty,
        true
      );

      setResult(
        '<p class="un-seen-head">Already up to date.</p>' +
          resultTable(perPlaylist) +
          '<p class="hint">All ' + found.length.toLocaleString() +
          ' videos from those playlists were already marked watched. Nothing needed changing.</p>'
      );
      return;
    }

    // alreadyKnown: zero NEW ids is the success case, not a broken import.
    // Offering to "mark 0 videos" reads as failure, so it is named.
    const alreadyKnown = found.length - preview.added;
    // Both partial-read cases are warned about HERE rather than after the
    // write, because this is the only moment the user can still say no. An
    // empty read is the quieter of the two and the easier one to miss.
    let warn = failures.length ? '\n\n' + failures.length + ' playlist(s) could not be read: ' + failures.join('; ') : '';
    if (empties.length) {
      warn += '\n\n' + empties.length + ' playlist(s) read as empty: ' + empties.join('; ') +
        '\nIf you expected videos there, cancel and check the playlist still has them.';
    }
    if (alreadyKnown) {
      warn += '\n\n' + alreadyKnown.toLocaleString() + ' were already marked watched.';
    }
    const ok = await uiConfirm(
      'Found ' +
        found.length.toLocaleString() +
        ' videos across ' +
        (ids.length - failures.length) +
        ' playlist(s). ' +
        preview.added.toLocaleString() +
        ' are not marked watched yet.\n\nMark those ' +
        preview.added.toLocaleString() +
        ' as watched? Nothing is unmarked, and your playlists are not changed.' +
        warn,
      'Mark ' + preview.added.toLocaleString() + ' watched'
    );
    if (!ok) {
      flash(scanStatusEl, 'Cancelled — nothing was changed.', false);
      return;
    }

    // ---- write phase ---------------------------------------------------
    // Re-read immediately before writing rather than reusing `cur`. The read
    // phase can take minutes on a few thousand videos, and watch-history.js
    // may have marked something in the meantime; merging against a stale
    // snapshot would drop it. mergeSeenIds is additive, so re-merging is safe.
    setBusy(true);
    setProgress('Saving…');
    const fresh = await new Promise((resolve) =>
      chrome.storage.local.get(
        { watchedVideos: [], watchedDates: {}, watchedDatesApprox: {}, watchStats: null },
        (d) => resolve(d || {})
      )
    );
    const merged = SP.mergeSeenIds(fresh, found, { now: Date.now() });

    const toSet = {
      watchedVideos: merged.watchedVideos,
      watchedDates: merged.watchedDates,
      watchedDatesApprox: merged.watchedDatesApprox
    };
    // Keep the stats card's distinct count in step with the list, the same
    // way the Takeout importer does.
    const WS = window.UNWatchStats;
    if (WS) {
      toSet.watchStats = fresh.watchStats
        ? WS.reconcileWatchStats(fresh.watchStats, merged.watchedVideos.length)
        : WS.buildIdOnlyStats(merged.watchedVideos.length);
    }

    chrome.storage.local.set(toSet, () => {
      setBusy(false);
      setProgress('');
      if (chrome.runtime.lastError) {
        flash(scanStatusEl, 'Could not save: ' + chrome.runtime.lastError.message, false);
        // The worst case to lose to a 2.6s timer: the read succeeded, the
        // write did not, and nothing was marked. Say so permanently.
        setResult(
          '<p class="un-seen-head un-seen-bad">Could not save.</p>' +
            '<p class="hint">' + esc(chrome.runtime.lastError.message) +
            '</p><p class="hint">' + found.length.toLocaleString() +
            ' videos were read successfully, but nothing was marked watched. Re-run to try again.</p>'
        );
        return;
      }
      flash(
        scanStatusEl,
        'Marked ' + merged.added.toLocaleString() + ' more videos as watched.' + (failures.length ? ' Some playlists failed — re-run to catch them.' : ''),
        true
      );
      // The permanent record of the run. Everything the 2.6s flash used to
      // say and then erase, plus the per-playlist breakdown and the totals
      // the user needs to judge whether it actually covered everything.
      const notes = [];
      if (failures.length) {
        notes.push(
          '<p class="un-seen-bad">' + failures.length +
            ' playlist(s) could not be read: ' + esc(failures.join('; ')) +
            '. Re-run to catch them.</p>'
        );
      }
      if (empties.length) {
        notes.push(
          '<p class="un-seen-bad">' + empties.length +
            ' playlist(s) read as empty: ' + esc(empties.join('; ')) +
            '. If you expected videos there, check the playlist still has them.</p>'
        );
      }
      setResult(
        '<p class="un-seen-head un-seen-good">Marked ' +
          merged.added.toLocaleString() +
          ' more videos as watched.</p>' +
          resultTable(perPlaylist) +
          '<p class="hint">' +
          found.length.toLocaleString() + ' unique videos read across ' +
          perPlaylist.length + ' playlist(s). ' +
          (found.length - merged.added).toLocaleString() +
          ' were already marked. Your watched total is now ' +
          merged.watchedVideos.length.toLocaleString() + '.</p>' +
          notes.join('') +
          '<p class="hint">Reload any open YouTube tabs to see the filter apply.</p>'
      );
      // No manual refresh call here: dashboard-core.js's storage.onChanged
      // listener already re-runs setCount() and refreshLiveCard() whenever
      // watchedVideos or watchStats changes, and both are in this write.
      // Those two functions live inside that file's IIFE and are genuinely
      // not reachable from here, so a `typeof setCount === 'function'` guard
      // would look like an update path while never once firing.
    });
  });
})();
