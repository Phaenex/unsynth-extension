/**
 * Shared AI filter form load/gather — used by dashboard Filter tab and legacy options page.
 */
(function (g) {
  'use strict';

  const linesToArr = (s) =>
    String(s || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
  const arrToLines = (a) => (a || []).join('\n');

  // Separate debounce timers per key so a channels-chip removal can't cancel a
  // pending allowedChannels write (and vice versa).
  let chanSaveTimer = null;
  let allowSaveTimer = null;

  /**
   * Turn a chrome.runtime.lastError into a message worth showing.
   *
   * chrome.storage.sync caps a single item at QUOTA_BYTES_PER_ITEM (8 KB). The
   * block list is the one list here that grows without bound — every "Block AI
   * channel" appends to it — so a heavy user eventually crosses that line, and
   * an unchecked set() then drops the write while the UI happily shows the chip
   * as saved. Name the real problem instead of losing the entry silently.
   */
  function describeSyncError(err) {
    const msg = String((err && err.message) || err || '');
    if (/quota/i.test(msg)) {
      return 'Not saved — this list is too large for browser sync (8 KB limit). Remove some entries.';
    }
    return 'Not saved — ' + (msg || 'browser storage error') + '.';
  }

  /**
   * Write one sync-backed list and report failure. cb(ok, message).
   */
  function saveList(key, arr, cb) {
    const payload = {};
    payload[key] = arr;
    chrome.storage.sync.set(payload, () => {
      const err = chrome.runtime.lastError;
      if (err) cb && cb(false, describeSyncError(err));
      else cb && cb(true, '');
    });
  }

  /** Show a save failure next to the list the user just edited. */
  function reportListError(root, key, message) {
    const id = key === 'allowedChannels' ? 'filter-allow-save-error' : 'filter-channel-save-error';
    let box = root.querySelector('#' + id);
    if (!box) {
      const anchor = root.querySelector(key === 'allowedChannels' ? '#filter-allow-chips' : '#filter-channel-chips');
      if (!anchor || !anchor.parentElement) return;
      box = document.createElement('p');
      box.id = id;
      box.className = 'chips-error';
      box.setAttribute('role', 'alert');
      anchor.parentElement.insertBefore(box, anchor.nextSibling);
    }
    box.textContent = message || '';
    box.hidden = !message;
  }

  function loadFilterForm(root, D, s) {
    const $ = (id) => root.querySelector('#' + id) || document.getElementById(id);
    if ($('filter-enabled')) $('filter-enabled').checked = !!s.enabled;
    if ($('filter-respectDisclosure')) $('filter-respectDisclosure').checked = !!s.respectDisclosure;
    if ($('filter-blockPlayback')) $('filter-blockPlayback').checked = !!s.blockPlayback;
    if ($('filter-hideSummaries')) $('filter-hideSummaries').checked = !!s.hideSummaries;
    if ($('filter-useRegex')) $('filter-useRegex').checked = !!s.useRegex;

    const modeEl = root.querySelector(`input[name="filter-mode"][value="${s.mode || 'hide'}"]`);
    if (modeEl) modeEl.checked = true;

    if ($('filter-minscore')) {
      const ms = typeof s.minScore === 'number' ? s.minScore : 45;
      $('filter-minscore').value = String(ms);
      const out = $('filter-minscore-out');
      if (out) out.textContent = ms + '%';
    }

    const surfaces = s.surfaces || {};
    root.querySelectorAll('input[data-filter-surface]').forEach((el) => {
      el.checked = surfaces[el.dataset.filterSurface] !== false;
    });

    if ($('filter-keywords')) $('filter-keywords').value = arrToLines(s.keywords);
    if ($('filter-channels')) $('filter-channels').value = arrToLines(s.channels);
    if ($('filter-allowedChannels')) $('filter-allowedChannels').value = arrToLines(s.allowedChannels);
    if ($('filter-allowSubscribedChannels')) $('filter-allowSubscribedChannels').checked = s.allowSubscribedChannels !== false;
    if ($('filter-communityList')) $('filter-communityList').checked = !!(s.communityList && s.communityList.enabled);

    const f = s.focus || (D && D.focus) || {};
    if ($('filter-focusEnabled')) $('filter-focusEnabled').checked = !!f.enabled;
    if ($('filter-focusStart')) $('filter-focusStart').value = f.start || '09:00';
    if ($('filter-focusEnd')) $('filter-focusEnd').value = f.end || '17:00';
    const days = f.days || [];
    root.querySelectorAll('#filter-focusDays input').forEach((el) => {
      el.checked = days.includes(Number(el.value));
    });

    if ($('filter-stat-hidden')) $('filter-stat-hidden').textContent = (s.stats && s.stats.hidden) || 0;
  }

  function gatherFilterForm(root) {
    const $ = (id) => root.querySelector('#' + id) || document.getElementById(id);
    const surfaces = {};
    root.querySelectorAll('input[data-filter-surface]').forEach((el) => {
      surfaces[el.dataset.filterSurface] = el.checked;
    });
    const days = [];
    root.querySelectorAll('#filter-focusDays input:checked').forEach((el) => days.push(Number(el.value)));
    return {
      enabled: $('filter-enabled') ? $('filter-enabled').checked : true,
      respectDisclosure: $('filter-respectDisclosure') ? $('filter-respectDisclosure').checked : true,
      blockPlayback: $('filter-blockPlayback') ? $('filter-blockPlayback').checked : true,
      hideSummaries: $('filter-hideSummaries') ? $('filter-hideSummaries').checked : true,
      useRegex: $('filter-useRegex') ? $('filter-useRegex').checked : false,
      mode: (root.querySelector('input[name="filter-mode"]:checked') || {}).value || 'hide',
      // Must be gathered here even though it's a newer field: this object
      // REPLACES the stored filter settings wholesale, so any field omitted is
      // silently reset to undefined every time the form is saved.
      minScore: (function () {
        const el = $('filter-minscore');
        const n = el ? Number(el.value) : NaN;
        return isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 45;
      })(),
      surfaces,
      keywords: linesToArr($('filter-keywords') && $('filter-keywords').value),
      channels: linesToArr($('filter-channels') && $('filter-channels').value),
      allowedChannels: linesToArr($('filter-allowedChannels') && $('filter-allowedChannels').value),
      allowSubscribedChannels: $('filter-allowSubscribedChannels') ? $('filter-allowSubscribedChannels').checked : true,
      communityList: { enabled: $('filter-communityList') ? $('filter-communityList').checked : false },
      focus: {
        enabled: $('filter-focusEnabled') ? $('filter-focusEnabled').checked : false,
        start: ($('filter-focusStart') && $('filter-focusStart').value) || '09:00',
        end: ($('filter-focusEnd') && $('filter-focusEnd').value) || '17:00',
        days
      }
    };
  }

  function renderChannelChips(root) {
    const box = root.querySelector('#filter-channel-chips');
    const ta = root.querySelector('#filter-channels');
    if (!box || !ta) return;
    const arr = linesToArr(ta.value);
    box.textContent = '';
    if (!arr.length) {
      const empty = document.createElement('span');
      empty.className = 'chips-empty';
      empty.textContent = 'No channels blocked yet.';
      box.appendChild(empty);
      return;
    }
    arr.forEach((name, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.appendChild(document.createTextNode(name));
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = 'Remove';
      x.setAttribute('aria-label', x.title);
      x.addEventListener('click', () => {
        const cur = linesToArr(ta.value);
        cur.splice(i, 1);
        ta.value = arrToLines(cur);
        // Debounce the sync write — rapid chip removals could otherwise brush
        // against chrome.storage.sync's write-rate quota. The flush re-reads
        // the textarea so it always persists the latest state.
        clearTimeout(chanSaveTimer);
        chanSaveTimer = setTimeout(() => {
          saveList('channels', linesToArr(ta.value), (okSave, message) => {
            reportListError(root, 'channels', okSave ? '' : message);
          });
        }, 350);
        renderChannelChips(root);
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  function renderAllowChips(root) {
    const box = root.querySelector('#filter-allow-chips');
    const ta = root.querySelector('#filter-allowedChannels');
    if (!box || !ta) return;
    const arr = linesToArr(ta.value);
    box.textContent = '';
    if (!arr.length) {
      const empty = document.createElement('span');
      empty.className = 'chips-empty';
      empty.textContent = 'No allowed channels yet.';
      box.appendChild(empty);
      return;
    }
    arr.forEach((name, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip chip-allow';
      chip.appendChild(document.createTextNode(name));
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = 'Remove';
      x.setAttribute('aria-label', x.title);
      x.addEventListener('click', () => {
        const cur = linesToArr(ta.value);
        cur.splice(i, 1);
        ta.value = arrToLines(cur);
        clearTimeout(allowSaveTimer);
        allowSaveTimer = setTimeout(() => {
          saveList('allowedChannels', linesToArr(ta.value), (okSave, message) => {
            reportListError(root, 'allowedChannels', okSave ? '' : message);
          });
        }, 350);
        renderAllowChips(root);
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  const api = {
    linesToArr,
    arrToLines,
    loadFilterForm,
    gatherFilterForm,
    renderChannelChips,
    renderAllowChips,
    describeSyncError,
    saveList,
    reportListError
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNFilterForm = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
