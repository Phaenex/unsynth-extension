(function (g) {
  'use strict';

  function createBrowserEnv(nav) {
    const n = nav || {};
    const ua = String(n.userAgent || '');
    const platform = String(n.platform || '');
    const uaData = n.userAgentData || {};
    const brands = Array.isArray(uaData.brands)
      ? uaData.brands.map((entry) => String(entry && entry.brand || '')).join(' ')
      : '';
    const identity = (brands + ' ' + ua).trim();
    const isMac = /Mac|iPhone|iPod|iPad/i.test(platform) || uaData.platform === 'macOS';

    // Atlas may omit a distinctive UA token, so compatibility must never depend
    // on this label. Keep detection precise when a build does expose its name.
    function isAtlas() {
      return /\b(?:ChatGPT[\s_-]+)?Atlas\b/i.test(identity);
    }

    function browserName() {
      if (isAtlas()) return 'ChatGPT Atlas';
      if (/\bEdg(?:e|A|iOS)?\//i.test(identity)) return 'Microsoft Edge';
      if (/\bOPR\//i.test(identity)) return 'Opera';
      if (/\bVivaldi\//i.test(identity)) return 'Vivaldi';
      if (/\bBrave\b/i.test(identity)) return 'Brave';
      if (/\b(?:Chrome|Chromium|CriOS)\//i.test(identity)) return 'Chromium';
      return 'Unknown Chromium browser';
    }

    function extensionsUrl() {
      if (/\bEdg(?:e|A|iOS)?\//i.test(identity)) return 'edge://extensions';
      if (/\bOPR\//i.test(identity)) return 'opera://extensions';
      if (/\bBrave\b/i.test(identity)) return 'brave://extensions';
      // Atlas is Chromium-based, but OpenAI only documents the Settings route,
      // not a public atlas:// URL. chrome://extensions is the safe Chromium URL.
      return 'chrome://extensions';
    }

    function extensionCapabilities(chromeApi) {
      const c = chromeApi || {};
      const required = {
        'runtime.getURL': !!(c.runtime && c.runtime.getURL),
        'runtime.sendMessage': !!(c.runtime && c.runtime.sendMessage),
        'storage.local': !!(c.storage && c.storage.local),
        'storage.sync': !!(c.storage && c.storage.sync),
        'tabs.query': !!(c.tabs && c.tabs.query),
        'identity.launchWebAuthFlow': !!(c.identity && c.identity.launchWebAuthFlow),
        'alarms': !!c.alarms,
        'notifications': !!c.notifications,
        'contextMenus': !!c.contextMenus,
        'downloads.download': !!(c.downloads && c.downloads.download),
        'offscreen.createDocument': !!(c.offscreen && c.offscreen.createDocument),
        'scripting.registerContentScripts': !!(c.scripting && c.scripting.registerContentScripts)
      };
      const missing = Object.keys(required).filter((key) => !required[key]);
      return { supported: missing.length === 0, required, missing };
    }

    function modClickLabel() {
      return isMac ? '⌘-click' : 'Ctrl+click';
    }

    function altKeyLabel() {
      return isMac ? 'Option' : 'Alt';
    }

    function altShiftLabel(key) {
      return (isMac ? 'Option' : 'Alt') + '+Shift+' + String(key || '').toUpperCase();
    }

    /** Replace [data-env] placeholders in extension pages. */
    function applyCopy(root) {
      const scope = root || (typeof document !== 'undefined' ? document : null);
      if (!scope) return;
      scope.querySelectorAll('[data-env="extensions-url"]').forEach((el) => {
        el.textContent = extensionsUrl();
      });
      scope.querySelectorAll('[data-env="mod-click"]').forEach((el) => {
        el.textContent = modClickLabel();
      });
      scope.querySelectorAll('[data-env="alt-key"]').forEach((el) => {
        el.textContent = altKeyLabel();
      });
      ['w', 'u', 'f', 'p'].forEach((key) => {
        scope.querySelectorAll('[data-env="alt-shift-' + key + '"]').forEach((el) => {
          el.textContent = altShiftLabel(key);
        });
      });
    }

    return {
      isMac,
      isAtlas,
      browserName,
      extensionsUrl,
      extensionCapabilities,
      modClickLabel,
      altKeyLabel,
      altShiftLabel,
      applyCopy
    };
  }

  const api = createBrowserEnv(typeof navigator !== 'undefined' ? navigator : {});
  api.createBrowserEnv = createBrowserEnv;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNBrowserEnv = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
