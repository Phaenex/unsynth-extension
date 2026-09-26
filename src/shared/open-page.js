(function () {
  'use strict';

  /** Open an extension page in a browser tab (Atlas opens options in a window otherwise). */
  function focusTab(tab) {
    if (!tab || tab.id == null) return;
    chrome.tabs.update(tab.id, { active: true }, () => {
      if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
    });
  }

  function openExtPage(relativePath, done) {
    const url = chrome.runtime.getURL(relativePath);
    chrome.tabs.query({ url }, (tabs) => {
      const existing = tabs && tabs[0];
      if (existing) {
        focusTab(existing);
        if (done) done(existing);
        return;
      }
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (done) done(tab);
      });
    });
  }

  function openExternal(url, done) {
    if (!url || !/^https:\/\//i.test(url)) return;
    chrome.tabs.create({ url, active: true }, (tab) => {
      if (done) done(tab);
    });
  }

  /** Route through the service worker when called from a content script. */
  function openExternalSafe(url, done) {
    if (!url || !/^https:\/\//i.test(url)) return;
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      openExternal(url, done);
      return;
    }
    chrome.runtime.sendMessage({ type: 'UNSYNTH/OPEN_URL', url }, () => {
      if (done) done();
    });
  }

  function openExtensionsAdmin() {
    const url = window.UNBrowserEnv ? UNBrowserEnv.extensionsUrl() : 'chrome://extensions';
    chrome.tabs.create({ url, active: true });
  }

  /** Atlas may turn target=_blank into a new window; open https links in tabs instead. */
  function bindExternalLinks(root) {
    const scope = root || document;
    scope.querySelectorAll('a[target="_blank"]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href || !/^https:\/\//i.test(href)) return;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openExternal(href);
      });
    });
  }

  window.UNOpenPage = {
    dashboard: (done) => openExtPage('src/dashboard/dashboard.html', done),
    filter: (done) => openExtPage('src/dashboard/dashboard.html#filter', done),
    stats: (done) => openExtPage('src/stats/stats.html', done),
    open: openExtPage,
    openExternal,
    openExternalSafe,
    openExtensionsAdmin,
    bindExternalLinks
  };
})();
