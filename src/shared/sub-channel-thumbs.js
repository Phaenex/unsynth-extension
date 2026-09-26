/**
 * Channel thumbnail cache helpers — lookup, scrape selectors, avatar DOM.
 * Cache shape: chrome.storage.local subChannelThumbs { channelKey: imageUrl }.
 */
(function (g) {
  'use strict';

  function validUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.indexOf('data:') === 0) return false;
    return /^https?:\/\//i.test(url);
  }

  function lookup(cache, store, key) {
    if (!cache || !key) return null;
    var SG = g.UNSubGroups;
    var forms = SG && store ? SG.keyForms(store, key) : [key];
    for (var i = 0; i < forms.length; i++) {
      var u = cache[forms[i]];
      if (validUrl(u)) return u;
    }
    return null;
  }

  function remember(cache, key, url) {
    if (!key || !validUrl(url)) return false;
    cache[key] = url;
    return true;
  }

  function imgSrc(img) {
    if (!img) return null;
    var src = img.getAttribute('src') || img.src || '';
    return validUrl(src) ? src : null;
  }

  /** Avatar on a subscriptions-feed video tile. */
  function thumbFromFeedTile(tile) {
    if (!tile) return null;
    var selectors = [
      'ytd-channel-name yt-img-shadow img',
      'ytd-channel-name img',
      '#channel-name yt-img-shadow img',
      '#channel-name img',
      '.ytd-channel-name yt-img-shadow img'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var src = imgSrc(tile.querySelector(selectors[i]));
      if (src) return src;
    }
    return null;
  }

  /** Avatar on a YouTube guide / mini-guide entry. */
  function thumbFromGuideEntry(entry) {
    if (!entry) return null;
    var selectors = ['yt-img-shadow img', '#thumbnail img', 'img.yt-img-shadow', 'img'];
    for (var i = 0; i < selectors.length; i++) {
      var src = imgSrc(entry.querySelector(selectors[i]));
      if (src) return src;
    }
    return null;
  }

  /**
   * Rounded avatar element with lazy-loaded img; falls back to initial letter on error.
   * opts: { className, label, initial, thumbUrl }
   */
  function mkAvatar(opts) {
    opts = opts || {};
    var el = document.createElement('span');
    el.className = opts.className || 'un-hub-panel-avatar';
    var initial = opts.initial || '?';
    el.title = opts.label || '';
    el.textContent = initial;
    if (opts.thumbUrl && validUrl(opts.thumbUrl)) {
      var img = document.createElement('img');
      img.className = 'un-chan-avatar-img';
      img.loading = 'lazy';
      img.alt = '';
      img.src = opts.thumbUrl;
      img.addEventListener('error', function () {
        img.remove();
        el.textContent = initial;
      });
      el.textContent = '';
      el.appendChild(img);
    }
    return el;
  }

  var api = {
    validUrl: validUrl,
    lookup: lookup,
    remember: remember,
    thumbFromFeedTile: thumbFromFeedTile,
    thumbFromGuideEntry: thumbFromGuideEntry,
    mkAvatar: mkAvatar
  };

  g.UNSubChannelThumbs = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : global);
