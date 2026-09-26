'use strict';
// Popout player bootstrap. Lives in its own file because MV3's default CSP
// (script-src 'self') blocks inline scripts on extension pages.
(function () {
  var p = new URLSearchParams(location.search);
  var v = p.get('v');
  var list = p.get('list');
  var t = p.get('t') || '0';
  var src;
  if (list) {
    src = 'https://www.youtube.com/embed/videoseries?list=' + encodeURIComponent(list) + '&autoplay=1';
  } else if (v) {
    src =
      'https://www.youtube.com/embed/' +
      encodeURIComponent(v) +
      '?autoplay=1&start=' +
      encodeURIComponent(t) +
      '&rel=0';
  } else {
    document.body.textContent = 'No video ID';
    return;
  }
  var f = document.createElement('iframe');
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.src = src;
  document.body.appendChild(f);
  document.title = 'Unsynth Popout';
})();
