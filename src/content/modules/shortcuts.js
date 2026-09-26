/**
 * In-page keyboard shortcuts. chrome.commands only supports 4 global bindings
 * (already used by mark-watched/mark-unwatched/toggle-filter/popout-player in
 * manifest.json) and needs the tab/window focused anyway for anything
 * player-related, so this uses a plain document-level keydown listener
 * instead — unlimited bindings, dashboard-configurable.
 *
 * Every action here either (a) mutates the real <video> element directly
 * (speed), or (b) clicks a real, already-rendered Unsynth button (screenshot),
 * or (c) flips a module's own `enabled` setting via chrome.storage.sync,
 * which core.js's existing storage.onChanged -> onSettings propagation
 * already handles — never a guessed internal function call into another
 * module.
 */
(function () {
  'use strict';

  let core = null;
  let bound = false;

  function prefs() {
    return (core && core.settings && core.settings.shortcuts) || {};
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function currentVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('#shorts-player video')
    );
  }

  function eventCombo(e) {
    const parts = [];
    if (e.shiftKey) parts.push('shift');
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.metaKey) parts.push('meta');
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    parts.push(key);
    return parts.join('+');
  }

  function currentChannelKey() {
    const a = document.querySelector(
      'ytd-watch-metadata #owner ytd-channel-name a[href], #channel-name a[href], a[href*="/@"]'
    );
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    if (href.indexOf('/@') !== -1) return href.split('/')[1] || null;
    return (a.textContent || '').trim() || null;
  }

  function rememberChannelSpeed(speed) {
    const ch = currentChannelKey();
    if (!ch) return;
    try {
      chrome.storage.local.get({ channelSpeeds: {} }, (d) => {
        const speeds = Object.assign({}, d.channelSpeeds || {});
        speeds[ch] = speed;
        chrome.storage.local.set({ channelSpeeds: speeds });
      });
    } catch (e) {}
  }

  function autoRestoreChannelSpeed() {
    const v = currentVideo();
    if (!v) return;
    const ch = currentChannelKey();
    if (!ch) return;
    try {
      chrome.storage.local.get({ channelSpeeds: {} }, (d) => {
        const speed = d.channelSpeeds && d.channelSpeeds[ch];
        if (speed && typeof speed === 'number' && speed >= 0.25 && speed <= 4) {
          if (Math.abs(v.playbackRate - speed) > 0.01) {
            v.playbackRate = speed;
            if (window.UNSYNTH && window.UNSYNTH.showToast) {
              window.UNSYNTH.showToast('Speed: ' + speed.toFixed(2) + 'x (' + ch + ')', {
                id: 'un-channel-speed',
                duration: 1500
              });
            }
          }
        }
      });
    } catch (e) {}
  }

  function nudgeSpeed(delta) {
    const v = currentVideo();
    if (!v) return;
    const next = Math.max(0.1, Math.min(4, Math.round((v.playbackRate + delta) * 100) / 100));
    v.playbackRate = next;
    rememberChannelSpeed(next);
    if (window.UNSYNTH && window.UNSYNTH.showToast) {
      window.UNSYNTH.showToast('Speed: ' + next.toFixed(2) + 'x', { id: 'un-shortcut-speed', duration: 1200 });
    }
  }

  function clickButton(id) {
    const btn = document.getElementById(id);
    if (btn) btn.click();
  }

  // qualityLock has a REAL second control (the chip's own click handler
  // writes qualityLock.enabled directly) — mirror that exact toggle.
  function toggleSettingsEnabled(settingsKey) {
    const effective = (core.settings && core.settings[settingsKey]) || {};
    const nextEnabled = !effective.enabled;
    chrome.storage.sync.get({ [settingsKey]: {} }, (cur) => {
      const sub = Object.assign({}, cur[settingsKey], { enabled: nextEnabled });
      chrome.storage.sync.set({ [settingsKey]: sub });
    });
  }

  // ambientMode has NO second control — its own dashboard checkbox IS the
  // real gate (core.settings.modules.ambientMode). Toggle that directly,
  // not a settings sub-object nothing else reads (see docs/LESSONS.md).
  function toggleModuleFlag(moduleKey) {
    const effective = !(core.settings && core.settings.modules && core.settings.modules[moduleKey] === false);
    chrome.storage.sync.get({ modules: {} }, (cur) => {
      const modules = Object.assign({}, cur.modules, { [moduleKey]: !effective });
      chrome.storage.sync.set({ modules });
    });
  }

  function boostVolume(deltaPct) {
    if (!window.UNVolume) return;
    const max = window.UNVolume.getMax ? window.UNVolume.getMax() : 600;
    const cur = window.UNVolume.getGain ? window.UNVolume.getGain() : 100;
    const next = Math.max(0, Math.min(max, cur + deltaPct));
    if (window.UNVolume.setGain) window.UNVolume.setGain(next, true);
    if (window.UNSYNTH && window.UNSYNTH.showToast) {
      window.UNSYNTH.showToast('Volume: ' + next + '%', { id: 'un-shortcut-volume', duration: 1200 });
    }
  }

  function runAction(action) {
    if (action === 'ambientMode') toggleModuleFlag('ambientMode');
    else if (action === 'qualityLock') toggleSettingsEnabled('qualityLock');
    else if (action === 'screenshot') clickButton('un-ss-btn');
    else if (action === 'speedDown') nudgeSpeed(-0.1);
    else if (action === 'speedUp') nudgeSpeed(0.1);
    else if (action === 'openDashboard') {
      if (window.UNSYNTH && window.UNSYNTH.openDashboard) window.UNSYNTH.openDashboard();
    } else if (action === 'volumeBoostDown') boostVolume(-10);
    else if (action === 'volumeBoostUp') boostVolume(10);
  }

  function onKeydown(e) {
    if (!prefs().enabled) return;
    if (isTypingTarget(e.target)) return;
    if (!window.UNSYNTH || !window.UNSYNTH.isWatch || !window.UNSYNTH.isWatch()) {
      if (location.pathname.indexOf('/shorts/') !== 0) return;
    }
    const combo = eventCombo(e);
    const p = prefs();
    const actions = [
      'ambientMode',
      'screenshot',
      'qualityLock',
      'speedDown',
      'speedUp',
      'openDashboard',
      'volumeBoostDown',
      'volumeBoostUp'
    ];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (p[action] && p[action].toLowerCase() === combo) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        runAction(action);
        return;
      }
    }
  }

  function onWheel(e) {
    if (isTypingTarget(e.target)) return;
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    if (!player || !player.contains(e.target)) return;

    // Volume scroll on volume slider or with Alt/Option key
    if (e.altKey || (e.target && e.target.closest && e.target.closest('.ytp-volume-area, .ytp-volume-panel, .ytp-mute-button'))) {
      e.preventDefault();
      e.stopPropagation();
      const vDelta = e.deltaY < 0 ? 10 : -10;
      boostVolume(vDelta);
      return;
    }

    if (!e.shiftKey) return;
    const v = currentVideo();
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    nudgeSpeed(delta);
  }

  function bind() {
    if (bound) return;
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('wheel', onWheel, { passive: false });
    bound = true;
  }
  function unbind() {
    if (!bound) return;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('wheel', onWheel, { passive: false });
    bound = false;
  }

  const mod = {
    id: 'shortcuts',
    moduleKey: 'shortcuts',
    init: function (c) {
      core = c;
      bind();
      setTimeout(autoRestoreChannelSpeed, 800);
    },
    onNavigate: function () {
      setTimeout(autoRestoreChannelSpeed, 800);
    },
    onSettings: function (s) {
      core.settings = s;
    },
    teardown: unbind
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { eventCombo };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
