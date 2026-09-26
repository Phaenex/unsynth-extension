/**
 * Search filters — a toolbar on the results page for the things YouTube's own
 * search cannot do.
 *
 * All logic lives in shared/search-filters.js (pure, unit-tested). This file
 * is the DOM half: read each result tile, hide what fails, and render the
 * controls.
 *
 * Two mechanisms, chosen per filter by what YouTube itself can be made to do:
 *   - Date range and sort rewrite the URL, so YouTube filters and every page
 *     of results obeys.
 *   - Everything else reads the tile, so it costs nothing and needs no API.
 *
 * Never uses search.list: it costs 100 quota units against a 9,000/day cap
 * shared with playlist reads, which would cap the user at ~90 searches a day
 * and break the seen-import when it ran out.
 */
(function () {
  'use strict';

  var core = null;
  var SF = window.UNSearchFilters;
  var YT = window.UNYtDom;

  var PANEL_ID = 'un-sf-panel';
  var BAR_ID = 'un-sf-bar';
  var HIDDEN_ATTR = 'data-un-sf-hidden';

  var filters = null;          // lazily loaded from storage
  var loaded = false;
  var lastCounts = { shown: 0, hidden: 0 };

  function prefs() {
    var d = (core && core.settings && core.settings.searchFilters) || {};
    return { enabled: d.enabled !== false };
  }

  function onSearchPage() {
    return location.pathname.indexOf('/results') === 0;
  }

  function currentQuery() {
    var m = location.search.match(/[?&]search_query=([^&]*)/);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  // ---- reading a result tile ----------------------------------------------

  // Every YouTube selector comes from shared/yt-dom.js. Inlining them here
  // would put this module on the wrong side of the drift problem: a renderer
  // rename would need finding and fixing in one more place.
  function tileSel() { return YT ? YT.SEARCH_TILES : ''; }
  function metaTexts(tile) { return YT ? YT.tileMetaTexts(tile) : []; }
  function tileDurationText(tile) { return YT ? YT.tileDurationText(tile) : ''; }

  function readTile(tile, watchedSet) {
    var meta = metaTexts(tile);
    // Through the adapter: the compact tile drops the word "views" (see
    // yt-dom viewsText), and a /view/ test then found nothing, so every
    // views filter silently passed every tile.
    var viewsText = YT && YT.viewsText ? YT.viewsText(meta) || null : null;
    var ageText = null;
    meta.forEach(function (m) {
      if (viewsText === null && /view/i.test(m)) viewsText = m;
      if (ageText === null && (YT && YT.isAgeText ? YT.isAgeText(m) : /ago/i.test(m))) ageText = m;
    });

    var titleEl = YT ? tile.querySelector(YT.TILE_TITLE_TEXT_SEL) : null;
    var chanEl = YT ? tile.querySelector(YT.TILE_CHANNEL_TEXT_SEL) : null;
    var descText = YT ? YT.tileDescription(tile) : '';

    var href = '';
    var a = tile.querySelector('a#video-title, a#thumbnail, a[href*="/watch"], a[href*="/shorts/"]');
    if (a) href = a.getAttribute('href') || '';
    var idm = href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
    var videoId = idm ? idm[1] : null;

    return {
      videoId: videoId,
      title: titleEl ? (titleEl.textContent || '').trim() : '',
      channel: chanEl ? (chanEl.textContent || '').trim() : '',
      description: descText,
      views: SF.parseViews(viewsText),
      ageDays: SF.parseAgeDays(ageText),
      seconds: SF.parseDuration(tileDurationText(tile)),
      isShort: /\/shorts\//.test(href),
      watched: !!(videoId && watchedSet && watchedSet.has(videoId))
    };
  }

  // ---- applying ------------------------------------------------------------

  var watchedSet = null;

  function loadWatched(cb) {
    if (watchedSet) return cb(watchedSet);
    try {
      chrome.storage.local.get({ watchedVideos: [] }, function (d) {
        watchedSet = new Set((d && d.watchedVideos) || []);
        cb(watchedSet);
      });
    } catch (e) {
      watchedSet = new Set();
      cb(watchedSet);
    }
  }

  function apply() {
    if (!SF || !onSearchPage() || !prefs().enabled) return;
    if (!loaded) return;

    var active = SF.isActive(filters);
    var sel = tileSel();
    if (!sel) return; // yt-dom missing; nothing to read tiles with
    var tiles = document.querySelectorAll(sel);
    var shown = 0;
    var hidden = 0;

    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!active) {
        if (tile.hasAttribute(HIDDEN_ATTR)) {
          tile.removeAttribute(HIDDEN_ATTR);
          tile.style.display = '';
        }
        shown++;
        continue;
      }
      var reason = SF.hideReason(readTile(tile, watchedSet), filters);
      if (reason) {
        // Attribute + inline display, so removing the filter restores exactly
        // what YouTube had rather than guessing at its original value.
        tile.setAttribute(HIDDEN_ATTR, reason);
        tile.style.display = 'none';
        hidden++;
      } else {
        if (tile.hasAttribute(HIDDEN_ATTR)) tile.removeAttribute(HIDDEN_ATTR);
        tile.style.display = '';
        shown++;
      }
    }

    lastCounts = { shown: shown, hidden: hidden };
    updateBar();
  }

  // ---- UI ------------------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function numInput(placeholder, value, onChange) {
    var i = document.createElement('input');
    i.type = 'number';
    i.min = '0';
    i.className = 'un-sf-num';
    i.placeholder = placeholder;
    i.value = (value === null || value === undefined) ? '' : String(value);
    i.addEventListener('change', function () {
      onChange(i.value === '' ? null : Number(i.value));
    });
    return i;
  }

  function dateInput(label, value, onChange) {
    var i = document.createElement('input');
    i.type = 'date';
    i.className = 'un-sf-date';
    i.setAttribute('aria-label', label);
    i.value = value || '';
    i.addEventListener('change', function () { onChange(i.value); });
    return i;
  }

  function field(labelText, control) {
    var wrap = el('label', 'un-sf-field');
    wrap.appendChild(el('span', 'un-sf-label', labelText));
    wrap.appendChild(control);
    return wrap;
  }

  function save(patch, opts) {
    Object.assign(filters, patch);
    try {
      chrome.storage.local.set({ searchFilterState: filters });
    } catch (e) { /* storage unavailable; filters still apply this session */ }
    if (opts && opts.reload) {
      // Date and sort are YouTube's job, so the page has to be re-fetched.
      location.href = SF.buildUrl(currentQuery(), filters);
      return;
    }
    apply();
    renderPanel();
  }

  function updateBar() {
    var bar = document.getElementById(BAR_ID);
    if (!bar) return;
    var chip = bar.querySelector('.un-sf-count');
    if (!chip) return;
    var summary = SF.summarize(filters);
    if (!SF.isActive(filters)) {
      chip.textContent = 'No filters';
      chip.classList.remove('on');
      return;
    }
    chip.classList.add('on');
    chip.textContent = lastCounts.hidden
      ? lastCounts.hidden + ' hidden · ' + summary
      : summary;
  }

  function renderPanel() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = '';

    // --- YouTube-side: needs a reload, so it is visually separated ---
    var yt = el('div', 'un-sf-group');
    yt.appendChild(el('div', 'un-sf-group-title', 'Applies to all results'));

    var dates = el('div', 'un-sf-row');
    dates.appendChild(field('After', dateInput('Uploaded after', filters.after, function (v) {
      save({ after: v }, { reload: true });
    })));
    dates.appendChild(field('Before', dateInput('Uploaded before', filters.before, function (v) {
      save({ before: v }, { reload: true });
    })));
    yt.appendChild(dates);

    var sortSel = document.createElement('select');
    sortSel.className = 'un-sf-select';
    [['', 'Relevance (default)'], ['date', 'Upload date'], ['views', 'View count'], ['rating', 'Rating']]
      .forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0];
        o.textContent = pair[1];
        if (filters.sort === pair[0]) o.selected = true;
        sortSel.appendChild(o);
      });
    sortSel.addEventListener('change', function () { save({ sort: sortSel.value }, { reload: true }); });
    var sortRow = el('div', 'un-sf-row');
    sortRow.appendChild(field('Sort', sortSel));
    yt.appendChild(sortRow);
    panel.appendChild(yt);

    // --- client side: instant ---
    var cs = el('div', 'un-sf-group');
    cs.appendChild(el('div', 'un-sf-group-title', 'Applies to loaded results'));

    var views = el('div', 'un-sf-row');
    views.appendChild(field('Views', numInput('min', filters.minViews, function (v) { save({ minViews: v }); })));
    views.appendChild(field('to', numInput('max', filters.maxViews, function (v) { save({ maxViews: v }); })));
    cs.appendChild(views);

    var dur = el('div', 'un-sf-row');
    dur.appendChild(field('Minutes', numInput('min', filters.minMinutes, function (v) { save({ minMinutes: v }); })));
    dur.appendChild(field('to', numInput('max', filters.maxMinutes, function (v) { save({ maxMinutes: v }); })));
    cs.appendChild(dur);

    var age = el('div', 'un-sf-row');
    age.appendChild(field('Newer than (days)', numInput('any', filters.maxAgeDays, function (v) { save({ maxAgeDays: v }); })));
    age.appendChild(field('Older than (days)', numInput('any', filters.minAgeDays, function (v) { save({ minAgeDays: v }); })));
    cs.appendChild(age);

    var words = document.createElement('input');
    words.type = 'text';
    words.className = 'un-sf-text';
    words.placeholder = 'reaction, tier list';
    words.value = (filters.excludeWords || []).join(', ');
    words.addEventListener('change', function () {
      save({ excludeWords: words.value.split(',') });
    });
    cs.appendChild(field('Exclude words', words));

    var chans = document.createElement('input');
    chans.type = 'text';
    chans.className = 'un-sf-text';
    chans.placeholder = 'channel name, another';
    chans.value = (filters.excludeChannels || []).join(', ');
    chans.addEventListener('change', function () {
      save({ excludeChannels: chans.value.split(',') });
    });
    cs.appendChild(field('Exclude channels', chans));

    var toggles = el('div', 'un-sf-row');
    [['hideShorts', 'Hide Shorts'], ['hideWatched', 'Hide watched']].forEach(function (pair) {
      var lab = el('label', 'un-sf-check');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!filters[pair[0]];
      cb.addEventListener('change', function () {
        var patch = {};
        patch[pair[0]] = cb.checked;
        save(patch);
      });
      lab.appendChild(cb);
      lab.appendChild(el('span', null, pair[1]));
      toggles.appendChild(lab);
    });
    cs.appendChild(toggles);
    panel.appendChild(cs);

    var clear = el('button', 'un-sf-clear', 'Clear all filters');
    clear.type = 'button';
    clear.addEventListener('click', function () {
      var wasUrlFiltered = !!(filters.after || filters.before || filters.sort);
      filters = SF.empty();
      save({}, { reload: wasUrlFiltered });
    });
    panel.appendChild(clear);
  }

  function ensureBar() {
    if (!onSearchPage() || !prefs().enabled) {
      var stale = document.getElementById(BAR_ID);
      if (stale) stale.remove();
      return;
    }
    if (document.getElementById(BAR_ID)) return;

    // Mount above the results list so it reads as part of the page's own
    // filter chrome rather than floating over content.
    if (!YT) return;
    var host = document.querySelector(YT.SEARCH_RESULTS_HOST);
    if (!host) return;

    var bar = el('div', null);
    bar.id = BAR_ID;

    var toggle = el('button', 'un-sf-toggle', 'Filters');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', PANEL_ID);

    var count = el('span', 'un-sf-count', 'No filters');

    var panel = el('div', 'un-sf-panel');
    panel.id = PANEL_ID;
    panel.hidden = true;

    toggle.addEventListener('click', function () {
      var open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) renderPanel();
    });

    bar.appendChild(toggle);
    bar.appendChild(count);
    bar.appendChild(panel);
    host.insertBefore(bar, host.firstChild);

    renderPanel();
    updateBar();
  }

  function load(cb) {
    try {
      chrome.storage.local.get({ searchFilterState: null }, function (d) {
        filters = SF.normalize((d && d.searchFilterState) || {});
        loaded = true;
        loadWatched(function () { cb && cb(); });
      });
    } catch (e) {
      filters = SF.empty();
      loaded = true;
      cb && cb();
    }
  }

  var mod = {
    id: 'searchFilters',
    init: function (c) {
      core = c;
      SF = window.UNSearchFilters;
      YT = window.UNYtDom;
      if (!SF) return;
      load(function () {
        ensureBar();
        apply();
      });
    },
    scan: function () {
      if (!SF || !onSearchPage() || !prefs().enabled) return;
      if (!loaded) return;
      ensureBar();
      apply();
    },
    onNavigate: function () {
      // A new search means new results; watched state can be reused.
      var bar = document.getElementById(BAR_ID);
      if (bar && !onSearchPage()) bar.remove();
      if (loaded) {
        ensureBar();
        apply();
      }
    },
    onSettings: function (s) {
      core.settings = s;
      if (!prefs().enabled) {
        var bar = document.getElementById(BAR_ID);
        if (bar) bar.remove();
        // Restore anything this module hid, or disabling it would leave
        // results missing with no visible cause.
        document.querySelectorAll('[' + HIDDEN_ATTR + ']').forEach(function (t) {
          t.removeAttribute(HIDDEN_ATTR);
          t.style.display = '';
        });
        return;
      }
      ensureBar();
      apply();
    },
    teardown: function () {
      var bar = document.getElementById(BAR_ID);
      if (bar) bar.remove();
      document.querySelectorAll('[' + HIDDEN_ATTR + ']').forEach(function (t) {
        t.removeAttribute(HIDDEN_ATTR);
        t.style.display = '';
      });
      watchedSet = null;
      loaded = false;
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readTile: readTile };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
