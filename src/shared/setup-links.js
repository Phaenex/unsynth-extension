/** Public setup guide — https://unsynth.vercel.app */
(function (g) {
  'use strict';

  const SETUP_SITE_URL = 'https://unsynth.vercel.app';

  function setupSiteUrl(hash) {
    const h = hash ? String(hash).replace(/^#/, '') : '';
    return h ? SETUP_SITE_URL + '#' + h : SETUP_SITE_URL;
  }

  function openSetupSite(hash) {
    const url = setupSiteUrl(hash);
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  const api = { SETUP_SITE_URL, setupSiteUrl, openSetupSite };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNSetupLinks = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
