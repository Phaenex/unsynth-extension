/**
 * Unsynth Speed Chip — a visible playback-speed control in the player bar.
 *
 * Before this, the [ / ] shortcuts (shortcuts.js) changed speed ±0.1 with no
 * on-screen readout, and changing it any other way meant YouTube's own
 * settings menu, two clicks deep. This chip shows the current rate at a
 * glance and opens a picker on click.
 *
 * Unlike Quality Lock (quality-lock.js), this is NOT a persisted setting and
 * needs NO MAIN-world bridge: video.playbackRate is a standard DOM property
 * on the <video> element itself, not a page-script expando like YouTube's
 * player API methods (setPlaybackQualityRange etc.) — the isolated content
 * script world can read and write it directly. shortcuts.js's nudgeSpeed()
 * already proves this (`v.playbackRate = next`), confirmed by reading it
 * before writing this module.
 *
 * The chip must reflect the rate no matter what changed it — this picker,
 * the [ / ] shortcuts, or YouTube's own settings menu — so it listens to the
 * video element's native 'ratechange' event rather than only updating on its
 * own clicks. A chip that only tracks its own picks would silently lie the
 * moment someone used a shortcut or YouTube's menu instead.
 */
(function () {
  'use strict';

  // The exact rate set requested, in order. 1 sits in the middle, the
  // "quiet" state the chip returns to whenever nothing is unusual.
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  let core = null;
  let chipEl = null;
  let attachedVideo = null;

  function onPlayerPage() {
    return !!(window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch());
  }

  // Matches the shape every other player-button module uses (qualityLock's
  // showChip, popoutPlayer/scrollMiniplayer's showPlayerButton, screenshot's
  // showButton) so the dashboard toggle works the same way. Defaults to false
  // — see defaults.js speedChip.showChip for why.
  function prefs() {
    const d = (core && core.settings && core.settings.speedChip) || {};
    return { showChip: d.showChip === true };
  }

  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('#shorts-player video')
    );
  }

  function formatRate(r) {
    // Whole numbers render without a decimal ("2×"); everything else keeps
    // exactly the precision the rate set uses (one decimal place, "1.25×"
    // etc still needs two for the quarter-steps).
    const rounded = Math.round(r * 100) / 100;
    const s = Number.isInteger(rounded) ? String(rounded) : String(rounded);
    return s + '×';
  }

  // ---- chip -------------------------------------------------------------

  function ensureChip() {
    if (!window.UNSYNTH || !window.UNSYNTH.addPlayerButton) return null;
    window.UNSYNTH.addPlayerButton({
      id: 'un-sp-chip',
      svg: '',
      title: 'Playback speed (Unsynth)',
      ariaLabel: 'Playback speed',
      onClick: function (e) {
        if (e) {
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
        }
        const anchor = document.getElementById('un-sp-chip') || (e && e.currentTarget) || null;
        openMenu(anchor);
      },
      cls: 'un-sp-chip',
      priority: 46
    });
    chipEl = document.getElementById('un-sp-chip');
    return chipEl;
  }

  function removeChip() {
    closeMenu();
    if (window.UNSYNTH && window.UNSYNTH.removePlayerButton) window.UNSYNTH.removePlayerButton('un-sp-chip');
    chipEl = null;
  }

  // ---- Speed picker in the "Unsynth tools" menu ----
  // The chip is hidden by default (defaults.js speedChip.showChip: false)
  // because YouTube's own settings gear already carries a Playback speed row,
  // and the control bar was measured live holding 480px of Unsynth buttons
  // against YouTube's 240px. Hiding the chip must not remove the picker, so it
  // gets a home in the overflow menu, which costs no bar width. The [ and ]
  // shortcuts still nudge speed either way (shortcuts.js nudgeSpeed), but they
  // step ±0.1 rather than offering the exact rate set, so they are not a
  // substitute for the picker. Only one surface exists at a time.
  const MENU_ROW_ID = 'speed-picker';
  const SPEED_MENU_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 4a9 9 0 0 0-9 9h2a7 7 0 1 1 14 0h2a9 9 0 0 0-9-9z"/>' +
    '<path fill="currentColor" d="M12 13.5 16.5 9 13 14.5a1.5 1.5 0 1 1-1-1z"/>' +
    '</svg>';

  function syncMenuRow(rate) {
    if (!window.UNSYNTH || !window.UNSYNTH.addMenuItem) return;
    // Chip visible = the picker is already one click away in the bar.
    if ((prefs().showChip && onPlayerPage()) || !onPlayerPage()) {
      if (window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem(MENU_ROW_ID);
      return;
    }
    const r = typeof rate === 'number' && rate > 0 ? rate : currentRate();
    // The current value goes in the label here — this surface has the room.
    window.UNSYNTH.addMenuItem({
      id: MENU_ROW_ID,
      svg: SPEED_MENU_SVG,
      label: 'Playback speed (' + formatRate(r) + ')',
      onClick: function (e) {
        // Anchor to the clicked row — the chip does not exist here.
        openMenu((e && e.currentTarget) || null);
      },
      priority: 46
    });
  }

  function removeMenuRow() {
    if (window.UNSYNTH && window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem(MENU_ROW_ID);
  }

  function updateChip(rate) {
    // The menu row is the fallback surface whenever the chip is not in the
    // bar, so it tracks the same rate on the same path.
    syncMenuRow(rate);
    if (!onPlayerPage() || !prefs().showChip) { removeChip(); return; }
    const chip = ensureChip();
    if (!chip) return;
    const r = typeof rate === 'number' && rate > 0 ? rate : 1;
    const nonDefault = Math.abs(r - 1) > 0.001;
    chip.textContent = formatRate(r);
    chip.classList.toggle('un-sp-nondefault', nonDefault);
    chip.title = nonDefault
      ? 'Playback speed: ' + formatRate(r) + ' (click to change)'
      : 'Playback speed: normal (click to change)';
    chip.setAttribute('aria-label', 'Playback speed ' + formatRate(r) + ', click to change');
    chip.setAttribute('aria-haspopup', 'menu');
    if (!chip.hasAttribute || !chip.hasAttribute('aria-expanded')) chip.setAttribute('aria-expanded', 'false');
  }

  // ---- track the real rate, however it changes ---------------------------

  function onRateChange(e) {
    const v = (e && e.target) || findVideo();
    if (!v) return;
    updateChip(v.playbackRate);
  }

  function attachToVideo() {
    const v = findVideo();
    if (v === attachedVideo) {
      // Same element — still refresh the label in case something changed the
      // rate before this module got a chance to attach (fresh page load).
      if (v) updateChip(v.playbackRate);
      return;
    }
    if (attachedVideo) attachedVideo.removeEventListener('ratechange', onRateChange);
    attachedVideo = v || null;
    if (attachedVideo) {
      attachedVideo.addEventListener('ratechange', onRateChange);
      updateChip(attachedVideo.playbackRate);
    } else {
      updateChip(1);
    }
  }

  // ---- picker menu (structure mirrors quality-lock.js's openMenu/closeMenu) ----

  const MENU_ID = 'un-sp-menu';
  let menuDocClick = null;
  let menuEsc = null;
  let menuKey = null;

  function closeMenu() {
    const menu = document.getElementById(MENU_ID);
    if (menu && menu.remove) menu.remove();
    if (menuDocClick) {
      document.removeEventListener('click', menuDocClick, true);
      menuDocClick = null;
    }
    if (menuKey) {
      document.removeEventListener('keydown', menuKey, true);
      menuKey = null;
    }
    if (menuEsc && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(menuEsc);
      menuEsc = null;
    }
    const chip = document.getElementById('un-sp-chip');
    if (chip && chip.setAttribute) chip.setAttribute('aria-expanded', 'false');
  }

  function currentRate() {
    const v = attachedVideo || findVideo();
    return v && typeof v.playbackRate === 'number' && v.playbackRate > 0 ? v.playbackRate : 1;
  }

  function selectRate(rate) {
    const v = findVideo();
    if (!v) return;
    // A direct DOM write — video.playbackRate is a real property on the
    // isolated world's own element, unlike YouTube's player-API expandos
    // (see quality-lock.js). Writing it fires 'ratechange' natively, which
    // onRateChange() picks up and uses to update the chip — no separate
    // updateChip() call needed here, matching how the [ / ] shortcuts and
    // YouTube's own menu already drive this chip.
    try {
      v.playbackRate = rate;
    } catch (e) {
      /* ignore */
    }
  }

  function openMenu(anchor) {
    if (document.getElementById(MENU_ID)) {
      closeMenu();
      return;
    }
    const active = currentRate();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    // Reuses the same visual language as quality-lock.js's picker.
    menu.className = 'un-home-menu un-sp-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Playback speed');

    RATES.forEach(function (rate) {
      const on = Math.abs(active - rate) < 0.001;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'un-sub-guide-item un-sp-item' + (on ? ' on' : '');
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.textContent = (on ? '✓ ' : '') + formatRate(rate);
      row.title = rate === 1 ? 'Normal speed' : 'Play at ' + formatRate(rate);
      row.addEventListener('click', function (e) {
        if (e) {
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
        }
        closeMenu();
        selectRate(rate);
      });
      menu.appendChild(row);
    });

    document.body.appendChild(menu);
    menu.style.position = 'fixed';
    // Player controls sit at the bottom of the video — open upward when
    // there isn't room below, same reasoning as quality-lock.js's picker.
    const el = (anchor && anchor.getBoundingClientRect) ? anchor : null;
    const r = el ? el.getBoundingClientRect() : null;
    const vw = (typeof window.innerWidth === 'number') ? window.innerWidth : 1280;
    const vh = (typeof window.innerHeight === 'number') ? window.innerHeight : 720;
    const w = menu.offsetWidth || 160;
    const h = menu.offsetHeight || 320;
    if (r) {
      const below = vh - r.bottom;
      const top = below >= h + 8 ? r.bottom + 6 : Math.max(8, r.top - h - 6);
      menu.style.top = Math.round(Math.min(Math.max(8, top), Math.max(8, vh - h - 8))) + 'px';
      menu.style.left = Math.round(Math.max(8, Math.min(r.left, vw - w - 8))) + 'px';
    } else {
      menu.style.top = Math.round(Math.max(8, (vh - h) / 2)) + 'px';
      menu.style.left = Math.round(Math.max(8, (vw - w) / 2)) + 'px';
    }
    menu.style.right = 'auto';

    const chip = document.getElementById('un-sp-chip');
    if (chip && chip.setAttribute) chip.setAttribute('aria-expanded', 'true');

    menuDocClick = function (e) {
      // The extension synthesises clicks elsewhere (autoplay toggles,
      // download links, other player buttons) and every one bubbles to
      // document — see queue-advance.js's docClickHandler and
      // quality-lock.js's menuDocClick for the same guard.
      if (e && e.isTrusted === false) return;
      const t = e && e.target;
      if (menu.contains && menu.contains(t)) return;
      if (el && (t === el || (el.contains && el.contains(t)))) return;
      closeMenu();
    };
    menuEsc = (window.UNSYNTH && window.UNSYNTH.pushPanel) ? window.UNSYNTH.pushPanel(closeMenu) : null;
    menuKey = menuEsc ? null : function (e) { if (e && e.key === 'Escape') closeMenu(); };
    setTimeout(function () {
      document.addEventListener('click', menuDocClick, true);
      if (menuKey) document.addEventListener('keydown', menuKey, true);
    }, 0);
    const first = menu.querySelector('.un-sub-guide-item.on') || menu.querySelector('.un-sub-guide-item');
    if (first && first.focus) first.focus();
  }

  // ---- module interface ---------------------------------------------------

  function teardown() {
    if (attachedVideo) {
      attachedVideo.removeEventListener('ratechange', onRateChange);
      attachedVideo = null;
    }
    removeChip();
    removeMenuRow();
  }

  const mod = {
    id: 'speedChip',
    moduleKey: 'speedChip',
    init: function (c) {
      core = c;
      attachToVideo();
    },
    scan: function () {
      // Cheap to re-check on every scan: attachToVideo() no-ops when the
      // element hasn't changed, and picks up a freshly-created <video> (ad
      // break ending, SPA re-render) the moment it appears.
      if (onPlayerPage()) attachToVideo();
      else { removeChip(); removeMenuRow(); }
    },
    onNavigate: function () {
      attachToVideo();
    },
    onSettings: function (s) {
      core.settings = s;
      // showChip can be toggled from the dashboard at runtime — re-render so
      // the chip and the menu row swap places immediately instead of on the
      // next ratechange.
      updateChip(currentRate());
    },
    teardown: teardown
  };

  // Exposed for unit tests, same convention as quality-lock.js.
  if (typeof window !== 'undefined') {
    window.UNSpeedChipInternals = {
      RATES: RATES,
      formatRate: formatRate
    };
  }

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
