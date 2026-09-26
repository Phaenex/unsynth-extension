/**
 * Popout player — open the current YouTube video in a resizable popup window.
 */
(function () {
  'use strict';

  let core = null;

  function prefs() {
    const d = (core && core.settings && core.settings.popoutPlayer) || {};
    return {
      width: d.width || 853,
      height: d.height || 480,
      showPlayerButton: d.showPlayerButton !== false
    };
  }

  function videoId() { return window.UNSYNTH.videoId(); }

  function playlistId() {
    const m = location.search.match(/[?&]list=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function currentTime() {
    const v = document.querySelector('video');
    return v ? Math.floor(v.currentTime || 0) : 0;
  }

  // Brief on-screen toast (reuses the screenshot OSD style from media-tools/ambient CSS).
  function showOsd(msg) { window.UNSYNTH.showToast(msg, { id: 'un-po-osd' }); }

  function openPopout(opts) {
    const vid = (opts && opts.videoId) || videoId();
    const list = opts && opts.listId;
    const t = opts && opts.time != null ? opts.time : currentTime();
    if (!vid && !list) {
      showOsd('No video to pop out');
      return;
    }
    chrome.runtime.sendMessage({
      type: 'UNSYNTH/POPOUT/OPEN',
      videoId: vid,
      listId: list,
      time: t,
      width: prefs().width,
      height: prefs().height
    });
  }

  const POPOUT_SVG =
    '<svg height="22" viewBox="0 0 36 36" width="22" aria-hidden="true">' +
    '<path fill="currentColor" d="M25 11h-6V9h6v2zm0 4h-6v-2h6v2zM13 9h6v2h-6V9zm6 4h-6v-2h6v2zM11 9H9v6H7V7h4v2zm0 8H9v6H7v-8h4v2zm8 0h-2v6h2v-6zm4 0h-2v6h6v-2h-4v-4z"/></svg>';

  function ensurePlayerButton() {
    if (!prefs().showPlayerButton || !window.UNSYNTH.isWatch()) return;
    window.UNSYNTH.addPlayerButton({
      id: 'un-po-btn',
      svg: POPOUT_SVG,
      title: 'Pop out player (Unsynth)',
      ariaLabel: 'Pop out player',
      onClick: function () {
        openPopout({ listId: playlistId() });
      },
      cls: 'un-popout-btn',
      priority: 20
    });
  }

  function removePlayerButton() {
    window.UNSYNTH.removePlayerButton('un-po-btn');
  }

  const mod = {
    id: 'popoutPlayer',
    moduleKey: 'popoutPlayer',
    init: function (c) {
      core = c;
      ensurePlayerButton();
    },
    scan: ensurePlayerButton,
    onNavigate: ensurePlayerButton,
    onSettings: function (s) {
      if (s) core.settings = s;
      removePlayerButton();
      ensurePlayerButton();
    },
    onMessage: function (msg, sendResponse) {
      if (msg.type === 'unsynth-popout-open') {
        openPopout(msg);
        sendResponse({ ok: true });
        return false;
      }
    },
    teardown: removePlayerButton
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
