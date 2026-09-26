  // ---- Creator Studio ----
  function initCreatorStudio() {
    const CS = window.UNCreatorStudio;
    if (!CS || $('creator-rank-list')?.dataset.ready) return;
    if ($('creator-rank-list')) $('creator-rank-list').dataset.ready = '1';

    function loadCreatorData(cb) {
      chrome.storage.local.get(
        {
          creatorRankTracks: [],
          creatorSchedule: [],
          creatorThumbnailTests: []
        },
        cb
      );
    }

    function renderRankList(tracks) {
      const box = $('creator-rank-list');
      if (!box) return;
      box.innerHTML = '';
      if (!tracks.length) {
        box.innerHTML = '<p class="hint">No rank tracks yet. Add from here or from the watch-page stats overlay.</p>';
        return;
      }
      tracks.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'creator-row';
        const rank = t.lastRank != null ? '#' + t.lastRank : 'Not in top 50';
        row.innerHTML =
          '<div><b>' +
          escHtml(t.videoTitle || t.videoId) +
          '</b><br><span class="hint">' +
          escHtml(t.keyword) +
          ' · ' +
          rank +
          '</span></div>';
        const actions = document.createElement('div');
        actions.className = 'bar';
        const check = document.createElement('button');
        check.type = 'button';
        check.textContent = 'Check rank';
        check.addEventListener('click', () => {
          flash($('creator-rank-status'), 'Checking…');
          send(UNMSG.CREATOR_RANK_CHECK, { keyword: t.keyword, videoId: t.videoId }).then((r) => {
            if (!r.ok) return flash($('creator-rank-status'), r.error || 'Check failed', false);
            loadCreatorData((d) => {
              const next = CS.recordRank(d.creatorRankTracks, t.id, r.rank);
              chrome.storage.local.set({ creatorRankTracks: next }, () => {
                flash($('creator-rank-status'), r.rank != null ? 'Rank #' + r.rank : 'Not in top 50');
                renderRankList(next);
              });
            });
          });
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ghost-btn sm';
        del.textContent = 'Remove';
        del.addEventListener('click', () => {
          loadCreatorData((d) => {
            const next = d.creatorRankTracks.filter((x) => x.id !== t.id);
            chrome.storage.local.set({ creatorRankTracks: next }, () => renderRankList(next));
          });
        });
        actions.append(check, del);
        row.appendChild(actions);
        box.appendChild(row);
      });
    }

    function renderSchedList(items) {
      const box = $('creator-sched-list');
      if (!box) return;
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<p class="hint">No scheduled items.</p>';
        return;
      }
      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'creator-row';
        const when = item.publishAt ? new Date(item.publishAt).toLocaleString() : 'No date';
        row.innerHTML = '<div><b>' + escHtml(item.title) + '</b><br><span class="hint">' + escHtml(when) + '</span></div>';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ghost-btn sm';
        del.textContent = 'Remove';
        del.addEventListener('click', () => {
          loadCreatorData((d) => {
            const next = d.creatorSchedule.filter((x) => x.id !== item.id);
            chrome.storage.local.set({ creatorSchedule: next }, () => renderSchedList(next));
          });
        });
        row.appendChild(del);
        box.appendChild(row);
      });
    }

    function renderThumbList(tests) {
      const box = $('creator-thumb-list');
      if (!box) return;
      box.innerHTML = '';
      if (!tests.length) {
        box.innerHTML = '<p class="hint">No thumbnail tests yet.</p>';
        return;
      }
      tests.forEach((test) => {
        const row = document.createElement('div');
        row.className = 'creator-row';
        row.innerHTML =
          '<div><b>' +
          escHtml(test.videoTitle || test.videoId) +
          '</b><br><span class="hint">' +
          test.variants.length +
          ' variant(s)</span></div>';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ghost-btn sm';
        del.textContent = 'Remove';
        del.addEventListener('click', () => {
          loadCreatorData((d) => {
            const next = d.creatorThumbnailTests.filter((x) => x.id !== test.id);
            chrome.storage.local.set({ creatorThumbnailTests: next }, () => renderThumbList(next));
          });
        });
        row.appendChild(del);
        box.appendChild(row);
      });
    }

    loadCreatorData((d) => {
      const tracks = CS.normalizeRankTracks(d.creatorRankTracks);
      const sched = CS.normalizeSchedule(d.creatorSchedule);
      const thumbs = CS.normalizeThumbnailTests(d.creatorThumbnailTests);
      renderRankList(tracks);
      renderSchedList(sched);
      renderThumbList(thumbs);
      renderCreatorNext(tracks, sched, thumbs);
    });

    function renderCreatorNext(tracks, sched, thumbs) {
      const list = $('creator-next-list');
      if (!list) return;
      list.innerHTML = '';
      const due = CS.dueScheduleItems(sched);
      const tips = [];
      if (!tracks.length) tips.push('Add a rank track or open a watch page and use the stats overlay keyword tools.');
      else tips.push('Check ranks weekly — use “Check all ranks” below.');
      if (due.length) tips.push(due.length + ' video(s) scheduled in the next 7 days.');
      if (!thumbs.length) tips.push('Start a thumbnail A/B test when you swap creatives.');
      tips.forEach((t) => {
        const li = document.createElement('li');
        li.textContent = t;
        list.appendChild(li);
      });
    }

    if ($('creator-rank-check-all')) {
      $('creator-rank-check-all').addEventListener('click', async () => {
        const btn = $('creator-rank-check-all');
        if (btn.disabled) return; // guard against concurrent runs stacking
        btn.disabled = true;
        loadCreatorData(async (d) => {
          let tracks = CS.normalizeRankTracks(d.creatorRankTracks);
          if (!tracks.length) {
            btn.disabled = false;
            return flash($('creator-rank-status'), 'No tracks to check', false);
          }
          flash($('creator-rank-status'), 'Checking ' + tracks.length + '…');
          for (const t of tracks) {
            const r = await send(UNMSG.CREATOR_RANK_CHECK, { keyword: t.keyword, videoId: t.videoId });
            if (r && r.ok) tracks = CS.recordRank(tracks, t.id, r.rank);
            await new Promise((res) => setTimeout(res, 400));
          }
          chrome.storage.local.set({ creatorRankTracks: tracks }, () => {
            renderRankList(tracks);
            renderCreatorNext(tracks, CS.normalizeSchedule(d.creatorSchedule), CS.normalizeThumbnailTests(d.creatorThumbnailTests));
            flash($('creator-rank-status'), 'All ranks updated');
            btn.disabled = false;
          });
        });
      });
    }

    if ($('creator-export')) {
      $('creator-export').addEventListener('click', () => {
        loadCreatorData((d) => {
          const blob = new Blob([CS.exportCreatorBundle(d.creatorRankTracks, d.creatorSchedule, d.creatorThumbnailTests)], {
            type: 'application/json'
          });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'unsynth-creator-' + new Date().toISOString().slice(0, 10) + '.json';
          a.click();
          URL.revokeObjectURL(a.href);
          flash($('creator-rank-status'), 'Exported');
        });
      });
    }

    if ($('creator-rank-add')) {
      $('creator-rank-add').addEventListener('click', () => {
        loadCreatorData((d) => {
          const res = CS.addRankTrack(d.creatorRankTracks, {
            keyword: $('creator-rank-kw').value,
            videoId: $('creator-rank-vid').value,
            videoTitle: $('creator-rank-title').value
          });
          if (!res.ok) return flash($('creator-rank-status'), 'Keyword and video ID required', false);
          chrome.storage.local.set({ creatorRankTracks: res.tracks }, () => {
            flash($('creator-rank-status'), res.duplicate ? 'Already tracking' : 'Track added');
            renderRankList(res.tracks);
          });
        });
      });
    }

    if ($('creator-sched-add')) {
      $('creator-sched-add').addEventListener('click', () => {
        loadCreatorData((d) => {
          const res = CS.addScheduleItem(d.creatorSchedule, {
            title: $('creator-sched-title').value,
            publishAt: $('creator-sched-at').value ? new Date($('creator-sched-at').value).toISOString() : null,
            notes: $('creator-sched-notes').value,
            videoId: $('creator-sched-vid').value
          });
          chrome.storage.local.set({ creatorSchedule: res.items }, () => {
            flash($('creator-sched-status'), 'Scheduled');
            renderSchedList(res.items);
          });
        });
      });
    }

    if ($('creator-thumb-add')) {
      $('creator-thumb-add').addEventListener('click', () => {
        loadCreatorData((d) => {
          const res = CS.addThumbnailTest(d.creatorThumbnailTests, {
            videoId: $('creator-thumb-vid').value,
            videoTitle: $('creator-thumb-title').value
          });
          if (!res.ok) return flash($('creator-thumb-status'), 'Video ID required', false);
          chrome.storage.local.set({ creatorThumbnailTests: res.tests }, () => {
            flash($('creator-thumb-status'), 'Test created');
            renderThumbList(res.tests);
          });
        });
      });
    }
  }
