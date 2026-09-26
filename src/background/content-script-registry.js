/**
 * Content-script registry (Phase 2 — lazy content scripts).
 *
 * Classic worker script (loaded via importScripts from the service worker,
 * AFTER src/build/injection-table.js which assigns self.UNInjectionTable).
 *
 * The core content-script block (shared/ + core.js + boot.js) stays declared
 * statically in the manifest. Every feature module is registered/unregistered
 * here through chrome.scripting so a module only loads on YouTube when its
 * moduleKey is enabled. Registered scripts persist across browser sessions.
 */
'use strict';

(function (g) {
  const ID_PREFIX = 'unsynth-mod-';

  function scriptId(mod) {
    return ID_PREFIX + mod.id;
  }

  function specFor(mod, matches) {
    const spec = {
      id: scriptId(mod),
      matches: matches,
      js: [mod.entry],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true
    };
    if (mod.css && mod.css.length) spec.css = mod.css.slice();
    return spec;
  }

  /**
   * Register/unregister lazy content scripts to match the current module
   * settings. A regular module follows moduleKey. A shared helper may declare
   * moduleKeys and stays registered while at least one owning feature is on.
   *
   * @param {Object} modulesSettings effective settings.modules map
   */
  async function syncLazyContentScriptsImpl(modulesSettings) {
    if (!g.chrome || !chrome.scripting || !chrome.scripting.registerContentScripts) return;
    const table = g.UNInjectionTable || {};
    const matches = table.matches || ['*://*.youtube.com/*', '*://music.youtube.com/*'];
    const lazy = table.lazyModules || [];
    const mods = modulesSettings || {};

    let existing = [];
    try {
      existing = await chrome.scripting.getRegisteredContentScripts();
    } catch (e) {
      console.warn('[Unsynth][registry.list]', e);
      existing = [];
    }
    const existingIds = new Set((existing || []).map((s) => s.id));

    const toRegister = [];
    const toUpdate = [];
    const wanted = new Set();

    lazy.forEach((mod) => {
      // Missing keys use the product default of on. Shared helpers are removed
      // only when every owning feature is explicitly disabled.
      const keys = Array.isArray(mod.moduleKeys) && mod.moduleKeys.length ? mod.moduleKeys : [mod.moduleKey];
      if (keys.every((key) => mods[key] === false)) return;
      const id = scriptId(mod);
      wanted.add(id);
      const spec = specFor(mod, matches);
      if (existingIds.has(id)) toUpdate.push(spec);
      else toRegister.push(spec);
    });

    const toUnregister = (existing || [])
      .map((s) => s.id)
      .filter((id) => id.indexOf(ID_PREFIX) === 0 && !wanted.has(id));

    if (toUnregister.length) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: toUnregister });
      } catch (e) {
        console.warn('[Unsynth][registry.unregister]', e);
      }
    }
    if (toRegister.length) {
      try {
        await chrome.scripting.registerContentScripts(toRegister);
      } catch (e) {
        // A racing register can report "already registered" — fall back to update.
        try {
          await chrome.scripting.updateContentScripts(toRegister);
        } catch (e2) {
          console.warn('[Unsynth][registry.register]', e, e2);
        }
      }
    }
    if (toUpdate.length) {
      try {
        await chrome.scripting.updateContentScripts(toUpdate);
      } catch (e) {
        console.warn('[Unsynth][registry.update]', e);
      }
    }
  }

  // syncLazyContentScripts reads chrome.scripting.getRegisteredContentScripts()
  // then decides what to register/update/unregister from that snapshot. It
  // fires on every chrome.storage.onChanged for `modules` (service-worker.js)
  // — a settings screen that toggles several modules in quick succession, or
  // an onInstalled+onStartup race at browser launch, can call this again
  // before the previous call's writes land. Two overlapping calls both read
  // the same stale "existing" snapshot and can make conflicting
  // register/update/unregister decisions for the same script id. Chain every
  // call through one promise so each full read-decide-write cycle finishes
  // before the next one reads, same serialization pattern as
  // UNStore.quotaAdd (shared/storage.js) and withSubscribedCacheLock
  // (service-worker.js).
  let _syncChain = Promise.resolve();
  function syncLazyContentScripts(modulesSettings) {
    const op = _syncChain.then(() => syncLazyContentScriptsImpl(modulesSettings));
    _syncChain = op.catch(() => {});
    return op;
  }

  /**
   * Load a feature into a tab that is already open, so "Turn on" in the watch
   * guide works without a reload (2026-09-24). Registering a content script
   * only affects the NEXT page load; the tab the user is looking at would keep
   * showing the feature as missing.
   *
   * Injects exactly what the registry would register for this key (the same
   * entry file and CSS, from specFor), skipping any file the tab already has.
   * A module switched off earlier in this tab is still loaded, and core
   * re-inits it from the storage change on its own; injecting the file again
   * would run its top-level code twice. Registered modules are detected by id
   * in UNSYNTH's registry; the three helper files that register nothing set a
   * global instead.
   *
   * @param {number} tabId
   * @param {string} key moduleKey being switched on
   * @param {Object} before effective modules map BEFORE the change
   * @returns {Promise<{ok:boolean, injected:string[], error?:string}>}
   */
  const HELPER_GLOBALS = {
    forgeSearchPanel: 'UNForgeSearchPanel',
    watchQueuePanel: 'UNWatchQueuePanel',
    statsCompareUi: 'UNStatsCompareUI'
  };

  function entriesForKey(key, before) {
    const lazy = ((g.UNInjectionTable || {}).lazyModules) || [];
    const mods = before || {};
    return lazy.filter((mod) => {
      const keys = Array.isArray(mod.moduleKeys) && mod.moduleKeys.length ? mod.moduleKeys : [mod.moduleKey];
      if (keys.indexOf(key) === -1) return false;
      // A shared helper another enabled feature already owns was registered
      // at page load, so it is in the tab.
      return keys.every((k) => k === key || mods[k] === false);
    });
  }

  async function injectModuleNow(tabId, key, before) {
    if (!g.chrome || !chrome.scripting || typeof tabId !== 'number') return { ok: false, injected: [], error: 'no_scripting' };
    const wanted = entriesForKey(key, before);
    if (!wanted.length) return { ok: false, injected: [], error: 'unknown_module' };
    let present = [];
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (ids, globals) => {
          const core = window.UNSYNTH;
          const reg = core && core._moduleIds;
          return ids.filter((id) => (reg && reg.has && reg.has(id)) || (globals[id] && window[globals[id]]));
        },
        args: [wanted.map((m) => m.id), HELPER_GLOBALS]
      });
      present = (probe && probe.result) || [];
    } catch (e) {
      return { ok: false, injected: [], error: 'tab_unreachable' };
    }
    const injected = [];
    for (const mod of wanted) {
      if (present.indexOf(mod.id) !== -1) continue;
      try {
        if (mod.css && mod.css.length) await chrome.scripting.insertCSS({ target: { tabId }, files: mod.css.slice() });
        await chrome.scripting.executeScript({ target: { tabId }, files: [mod.entry] });
        injected.push(mod.id);
      } catch (e) {
        console.warn('[Unsynth][registry.injectNow]', mod.id, e);
        return { ok: false, injected, error: 'inject_failed' };
      }
    }
    return { ok: true, injected };
  }

  g.syncLazyContentScripts = syncLazyContentScripts;
  g.UNModuleInject = { injectModuleNow, entriesForKey, HELPER_GLOBALS };
})(typeof self !== 'undefined' ? self : this);
