/**
 * Cross-tab single-playback enforcement. When a video starts playing in this
 * tab, the service worker asks every other YouTube tab whether it is playing
 * and pauses those older players. New module (not folded into watch-history.js
 * — that module gates on data persistence settings, this has none, and a
 * privacy-motivated user disabling watch history shouldn't silently lose an
 * unrelated live-messaging feature).
 */
(function () {
  'use strict';

  var core = null;
  var video = null;
  var localStartedAt = 0;

  function prefs() {
    return { enabled: !(core && core.settings && core.settings.modules && core.settings.modules.crossTabPlayback === false) };
  }

  // Same selector cascade volume-master.js uses — more robust than a bare
  // `document.querySelector('video')`, which can pick up an ad or hover-preview.
  // Deliberately excludes '#shorts-player video': YouTube's Shorts feed
  // autoplays continuously as the user scrolls, and each autoplay is a
  // genuine 'play' event — nothing distinguishes that from a deliberate next
  // video, so treating it as "playback started" here caused Shorts scrolling
  // in one tab to silently, repeatedly pause an unrelated video in another
  // tab. Single-playback enforcement stays for long-form video and YouTube
  // Music, where a 'play' event actually means what this feature assumes.
  function findVideo() {
    var selectors = ['#movie_player video.html5-main-video', '#movie_player video', 'ytmusic-player-bar video'];
    for (var i = 0; i < selectors.length; i++) {
      var v = document.querySelector(selectors[i]);
      if (v) return v;
    }
    return null;
  }

  function onPlay() {
    localStartedAt = Date.now();
    document.documentElement.setAttribute('data-unsynth-cross-tab', 'playing');
    var vid = window.UNSYNTH && window.UNSYNTH.videoId ? window.UNSYNTH.videoId() : null;
    var title = document.title.replace(/ - YouTube$/, '');
    try {
      chrome.runtime.sendMessage({ type: window.UNMSG.VIDEO_PLAYING, videoId: vid || '', title: title });
    } catch (e) {
      /* extension context gone (reload mid-navigation) */
    }
  }

  function attach() {
    if (!prefs().enabled) return;
    var v = findVideo();
    if (!v || v === video) return;
    detach();
    video = v;
    video.addEventListener('play', onPlay);
    // The module is lazy and can arrive after autoplay has already fired its
    // play event. Announce an already-playing player immediately too.
    if (!video.paused && !video.ended) onPlay();
  }
  function detach() {
    if (video) video.removeEventListener('play', onPlay);
    video = null;
  }

  function onMessage(msg, sendResponse) {
    if (msg.type === window.UNMSG.PLAYBACK_QUERY) {
      attach();
      var playing = !!(video && !video.paused && !video.ended);
      var vid = playing && window.UNSYNTH && window.UNSYNTH.videoId ? window.UNSYNTH.videoId() : null;
      sendResponse({ playing: playing, videoId: vid, startedAt: localStartedAt });
      return false; // synchronous — no need to keep the message channel open
    }
    if (msg.type === window.UNMSG.PLAYBACK_PAUSE) {
      if (!prefs().enabled) return false;
      attach();
      if (video && !video.paused && !video.ended) video.pause();
      document.documentElement.setAttribute('data-unsynth-cross-tab', 'paused');
      sendResponse({ paused: !!(video && video.paused) });
      return false;
    }
  }

  var mod = {
    id: 'crossTabPlayback',
    moduleKey: 'crossTabPlayback',
    init: function (c) {
      core = c;
      document.documentElement.setAttribute('data-unsynth-cross-tab', 'ready');
      attach();
    },
    scan: function () {
      attach();
    },
    onNavigate: function () {
      detach();
      attach();
    },
    onSettings: function (s) {
      core.settings = s;
      if (!prefs().enabled) detach();
      else attach();
    },
    onMessage: onMessage,
    teardown: function () {
      detach();
      document.documentElement.removeAttribute('data-unsynth-cross-tab');
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
