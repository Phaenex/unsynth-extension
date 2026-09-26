  // ---- tune (UI/UX) ----
  function loadTune(ui) {
    document.querySelectorAll('[data-ui]').forEach((el) => {
      el.checked = !!ui[el.dataset.ui];
    });
    const shelves = (ui && ui.hideShelves) || {};
    document.querySelectorAll('[data-ui-shelf]').forEach((el) => {
      el.checked = !!shelves[el.dataset.uiShelf];
    });
    $('ui-vpr').value = ui.videosPerRow || 0;
    $('ui-speed').value = ui.defaultSpeed || 0;
    $('ui-vol').value = typeof ui.defaultVolume === 'number' ? ui.defaultVolume : -1;
    if ($('ui-channelDefaultTab')) $('ui-channelDefaultTab').value = ui.channelDefaultTab || 'videos';
  }
  function gatherTune() {
    const ui = {};
    document.querySelectorAll('[data-ui]').forEach((el) => (ui[el.dataset.ui] = el.checked));
    ui.hideShelves = Object.assign({}, (D.ui && D.ui.hideShelves) || {});
    document.querySelectorAll('[data-ui-shelf]').forEach((el) => {
      ui.hideShelves[el.dataset.uiShelf] = el.checked;
    });
    ui.videosPerRow = Number($('ui-vpr').value) || 0;
    ui.defaultSpeed = Number($('ui-speed').value) || 0;
    ui.defaultVolume = Number($('ui-vol').value);
    if ($('ui-channelDefaultTab')) ui.channelDefaultTab = $('ui-channelDefaultTab').value || 'videos';
    return ui;
  }
  chrome.storage.sync.get({ ui: D.ui }, (s) => loadTune(Object.assign({}, D.ui, s.ui)));
  $('save-tune').addEventListener('click', () => {
    const ui = Object.assign({}, D.ui, gatherTune(), { preset: 'custom' });
    chrome.storage.sync.set({ ui }, () => flash($('tune-status'), 'Saved.'));
  });
  // Scope to Tune's preset cards only — Watched-display buttons also use
  // class "preset" and must not trigger UNUI.applyPreset (which would wipe ui).
  document.querySelectorAll('.preset-cards .preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      chrome.storage.sync.get({ ui: D.ui }, (s) => {
        const base = Object.assign({}, D.ui); // presets apply over all-off defaults
        const next = window.UNUI.applyPreset(btn.dataset.preset, base);
        chrome.storage.sync.set({ ui: next }, () => {
          loadTune(next);
          flash($('tune-status'), 'Applied "' + btn.dataset.preset + '".');
        });
      });
    });
  });

// ---- Tune: live preview on hover + settings search ----
(function () {
  const mock = document.getElementById('ytmock');
  const cap = document.getElementById('tunecap');
  const search = document.getElementById('tune-search');
  const labels = Array.prototype.slice.call(document.querySelectorAll('.tune-list label[data-ui-label]'));

  if (mock) {
    const show = (pv, text) => {
      mock.className = 'ytm' + (pv ? ' pv-' + pv : '');
      if (text && cap) cap.textContent = text;
    };
    labels.forEach((l) => {
      const pv = l.getAttribute('data-pv') || '';
      const text = l.getAttribute('data-cap') || '';
      l.addEventListener('mouseenter', () => show(pv, text));
      l.addEventListener('focusin', () => show(pv, text));
    });
  }

  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      labels.forEach((l) => {
        l.style.display = !q || l.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
      // hide a group header when all of its toggles are filtered out
      document.querySelectorAll('.tune-list .tune-group').forEach((g) => {
        let n = g.nextElementSibling;
        let any = false;
        while (n && n.matches && n.matches('label[data-ui-label]')) {
          if (n.style.display !== 'none') any = true;
          n = n.nextElementSibling;
        }
        g.style.display = any ? '' : 'none';
      });
    });
  }
})();
