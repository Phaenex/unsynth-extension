/**
 * Storage helpers (classic script, attaches UNStore to the global).
 *
 * Routing rule: chrome.storage.sync for small synced settings only; everything
 * large/sensitive (auth tokens, API key, group/folder data, caches, quota) in
 * chrome.storage.local. Also provides a TTL cache and a daily Data-API quota
 * counter.
 */
(function (g) {
  'use strict';

  const local = chrome.storage.local;
  const sync = chrome.storage.sync;

  function call(area, method, arg) {
    return new Promise((resolve, reject) => {
      area[method](arg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

  function today() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  // Schema version for one-time data migrations. Bump when adding a migration
  // and append the migration fn to MIGRATIONS (index n runs to reach version n+1).
  const SCHEMA_VERSION = 10;

  // Both used to resolve unconditionally without checking chrome.runtime.lastError
  // (e.g. QUOTA_BYTES_PER_ITEM/MAX_WRITE_OPERATIONS_PER_MINUTE exceeded) — a failed
  // sync write inside a migration looked identical to a successful one, so
  // runMigrations() below would mark the migration done even though nothing was
  // actually persisted. Route through call() so failures reject like every other
  // storage op in this file.
  function syncGet(defaults) {
    return call(sync, 'get', defaults).then((r) => r || {});
  }
  function syncSet(obj) {
    return call(sync, 'set', obj);
  }

  /**
   * v0 -> v1
   *   - derive watchedDisplay from the legacy watchedMode (keep watchedMode for
   *     back-compat reads)
   *   - seed playlistFolders / playlistBulk from legacy playlistManager when ON
   *     (legacy OFF must not disable the split modules — see migrateV2)
   *   - copy a sync-only statsSections into local (its real home)
   */
  async function migrateV1() {
    const s = await syncGet({ watchedMode: undefined, watchedDisplay: undefined, modules: undefined, statsSections: undefined });
    const patch = {};

    const wd = s.watchedDisplay;
    const wdEmpty = !wd || (typeof wd === 'object' && Object.keys(wd).length === 0);
    if (s.watchedMode !== undefined && wdEmpty) {
      const wm = s.watchedMode;
      patch.watchedDisplay = {
        badges: true,
        finished: wm === 'hide' ? 'hide' : wm === 'dim' ? 'dim' : 'show',
        feedFilter: 'all',
        hidePartial: false
      };
    }

    if (s.modules && s.modules.playlistManager === true) {
      const modules = Object.assign({}, s.modules);
      let changed = false;
      if (modules.playlistFolders === undefined) { modules.playlistFolders = true; changed = true; }
      if (modules.playlistBulk === undefined) { modules.playlistBulk = true; changed = true; }
      if (changed) patch.modules = modules;
    }

    if (Object.keys(patch).length) await syncSet(patch);

    const localStats = await UNStore.getLocal('statsSections', undefined);
    if (localStats === undefined && s.statsSections !== undefined) {
      await UNStore.setLocal('statsSections', s.statsSections);
    }
  }

  /**
   * v1 -> v2
   * Undo stale v1 inheritance: users who had playlistManager:false ended up with
   * playlistFolders/playlistBulk:false too. Delete those keys so runtime
   * normalizeModules + defaults keep the split modules on.
   */
  async function migrateV2() {
    const s = await syncGet({ modules: undefined });
    if (!s.modules || s.modules.playlistManager !== false) return;
    const modules = Object.assign({}, s.modules);
    let changed = false;
    if (modules.playlistFolders === false) {
      delete modules.playlistFolders;
      changed = true;
    }
    if (modules.playlistBulk === false) {
      delete modules.playlistBulk;
      changed = true;
    }
    if (changed) await syncSet({ modules });
  }

  /**
   * v2 -> v3
   * Drop empty PocketTube playlist-folder shells (Main/Night/Streamers with 0 PLs)
   * so the sidebar can show pinned real playlists instead. Also force hideEmpty on.
   */
  async function migrateV3() {
    const PF = g.UNPlaylistFolders;
    const store = await UNStore.getLocal('plFolderStore', null);
    if (store && PF && PF.pruneEmptyFolders) {
      const before = PF.folderCount(store);
      const pruned = PF.pruneEmptyFolders(store);
      if (PF.folderCount(pruned) !== before) {
        await UNStore.setLocal('plFolderStore', pruned);
      }
    }
    const prefs = await UNStore.getLocal('plFolderPrefs', null);
    if (!prefs || prefs.hideEmpty !== true) {
      const next = PF && PF.normalizePrefs ? PF.normalizePrefs(Object.assign({}, prefs || {}, { hideEmpty: true })) : Object.assign({}, prefs || {}, { hideEmpty: true });
      await UNStore.setLocal('plFolderPrefs', next);
    }
    // Ensure pins store exists (empty is fine — user pins via ＋ Pin).
    const pins = await UNStore.getLocal('plPins', undefined);
    if (pins === undefined && PF && PF.emptyPins) {
      await UNStore.setLocal('plPins', PF.emptyPins());
    }
  }

  /** v3 -> v4: external Forge history/taste sharing now requires consent. */
  async function migrateV4() {
    const current = await UNStore.getLocal('forgeSync', undefined);
    if (current === undefined) {
      await UNStore.setLocal('forgeSync', { enabled: false, sharedAt: 0, requestAt: 0 });
    }
  }

  /** v4 -> v5: cross-device watch-history sync now requires consent. */
  async function migrateV5() {
    const current = await UNStore.getLocal('historySync', undefined);
    if (current === undefined) {
      await UNStore.setLocal('historySync', { enabled: false, lastSyncAt: 0, lastError: null });
    }
  }

  /**
   * v5 -> v6: the watch queue panel now FLAGS items that look finished, stale
   * or unplayable, and every item carries an addedAt so it has an age to judge
   * (see classifyQueue in shared/watch-queue.js).
   *
   * Existing items have no real age — nothing recorded when they were queued,
   * and there is no way to recover it. The policy is to stamp them all at
   * MIGRATION TIME rather than at 0 or at some invented past date, so the
   * staleness clock starts NOW. The alternative (treating an unstamped item as
   * ancient) would flag the user's entire current queue on the very first open.
   * Cost of this choice: a genuinely months-old item gets one more grace
   * period. That is the right side to err on.
   *
   * Nothing is removed here, and nothing acts on the flags without a click —
   * that is the standing rule after the queue-emptying incident that reverted
   * commit 39b5df3.
   */
  async function migrateV6() {
    const list = await UNStore.getLocal('unWatchQueue', null);
    if (!Array.isArray(list) || !list.length) return;
    const at = Date.now();
    let changed = false;
    const next = list.map((it) => {
      if (!it || typeof it !== 'object') return it;
      // A real timestamp already there (queued after this shipped, or synced
      // from a migrated device) is left alone.
      if (Number(it.addedAt) > 0) return it;
      changed = true;
      return Object.assign({}, it, { addedAt: at });
    });
    if (changed) await UNStore.setLocal('unWatchQueue', next);
  }

  /**
   * v7 — retire the player-bar chips that duplicate a native control.
   *
   * The control bar was measured live carrying 480px of Unsynth buttons
   * against YouTube's own 240px. The quality chip, speed chip, volume button
   * and miniplayer button all duplicate something YouTube already provides
   * (its settings gear holds Quality and Playback speed, its left controls
   * hold volume, and it ships its own miniplayer), so their defaults went to
   * false and the pickers moved into the Unsynth tools menu.
   *
   * A default only reaches a profile that never stored the key. Anyone who
   * used the extension before this shipped has `showChip: true` written to
   * their settings and keeps the cluttered bar forever — which is exactly
   * what was observed: three of the four buttons vanished on upgrade while
   * the quality chip stayed, because only that one had been persisted.
   *
   * Clearing the stored value once lets the new default apply. It is not a
   * forced setting: anyone who genuinely wants a chip re-enables it in the
   * dashboard, and that choice is then stored again and survives.
   */
  async function migrateV7() {
    const s = await syncGet({ qualityLock: undefined, speedChip: undefined });
    const patch = {};
    ['qualityLock', 'speedChip'].forEach((key) => {
      const block = s && s[key];
      if (!block || typeof block !== 'object') return;
      if (!Object.prototype.hasOwnProperty.call(block, 'showChip')) return;
      const next = Object.assign({}, block);
      delete next.showChip;
      patch[key] = next;
    });
    if (Object.keys(patch).length) await syncSet(patch);
  }

  /**
   * v7 again, because v7 ran too early to stick.
   *
   * The timeline, from the history: migrateV7 shipped 2026-09-04 and deleted the
   * stored showChip, but quality-lock.js still read it as `d.showChip !== false`
   * at that point — and `undefined !== false` is TRUE. So the chip came back on
   * immediately, and the dashboard's save path then wrote `showChip: true`
   * straight back into sync. The read was corrected to `=== true` the next day,
   * 2026-09-05, but schemaVersion was already 7 by then and a migration never
   * runs twice. Anyone who had the extension across those two days keeps a
   * quality chip that the defaults say should not exist — reported as "why is
   * there still a quality button in the player bar when it's in YouTube's
   * native thing".
   *
   * Clearing it once more is safe now that the read is right: the key goes
   * away, `=== true` resolves to false, and nothing writes it back unless the
   * user deliberately re-enables the chip in the dashboard — which is stored
   * again and survives every later migration.
   */
  async function migrateV8() {
    return migrateV7();
  }

  /**
   * v8 -> v9: KEEP WHAT EXISTING INSTALLS HAD (2026-09-24).
   *
   * 0.9.17-0.9.20 (PR #2, the quieter-defaults campaign) flipped these
   * modules' defaultOn from true to false. A module the user never toggled
   * has no key in storage and follows the default, so on update they all
   * switched off: the owner lost the sidebar hub, the thumbnail and playlist
   * tools, volume, pop-out, screenshot, the downloader and the AI features,
   * and was told (wrongly, at first) that he had picked a preset.
   *
   * The quieter defaults were meant for NEW installs. So an install that had
   * already run migrations before this one (from > 0) gets the old default
   * written explicitly for every one of these keys it never set. A key the
   * user did set, true or false, is left alone; a fresh install (from === 0)
   * gets the new defaults untouched.
   */
  const PRE_QUIET_DEFAULT_ON = [
    'subManager', 'playlistFolders', 'playlistBulk', 'forgeLink', 'volumeMaster', 'popoutPlayer',
    'factCheck', 'analytics', 'aiAssistant', 'screenshot', 'ambientMode'
  ];
  async function restoreFormerDefaults(from, keys) {
    if (!(from > 0)) return;
    const s = await syncGet({ modules: undefined });
    const cur = s.modules && typeof s.modules === 'object' ? s.modules : {};
    const next = Object.assign({}, cur);
    let changed = false;
    keys.forEach((k) => {
      if (cur[k] === undefined) { next[k] = true; changed = true; }
    });
    if (changed) await syncSet({ modules: next });
  }
  async function migrateV9(from) {
    return restoreFormerDefaults(from, PRE_QUIET_DEFAULT_ON);
  }

  /**
   * v9 -> v10: THE REST OF THEM (2026-09-24).
   *
   * v9's list came from diffing the defaults against main just before PR #2,
   * but the owner had been running the feature branch, and the defaults changed on
   * the BRANCH on 2026-09-06: 26 modules went from on to off in one commit.
   * He asked what happened to "our pause feature where it pause video playing
   * if i open another" (crossTabPlayback), and "i feel like you stripped away
   * alot of our features". He was right. This list is every module that was
   * defaultOn:true in any commit of src/build/modules.manifest.js and is off
   * by default now (scanned across all 26 commits that touched it), so a
   * second partial list cannot happen the same way.
   */
  const FORMER_DEFAULT_ON = [
    'abLoop', 'aiAssistant', 'ambientMode', 'analytics', 'chapters', 'clipCapture', 'crossTabPlayback',
    'descDigest', 'factCheck', 'forgeLink', 'liveNow', 'playlistBulk', 'playlistFolders', 'popoutPlayer',
    'queueAdvance', 'quickSwitcher', 'screenshot', 'scrollMiniplayer', 'shortcuts', 'skipSeconds',
    'speedChip', 'subManager', 'tasteRank', 'transcriptExport', 'volumeMaster'
  ];
  async function migrateV10(from) {
    return restoreFormerDefaults(from, FORMER_DEFAULT_ON);
  }

  const MIGRATIONS = [migrateV1, migrateV2, migrateV3, migrateV4, migrateV5, migrateV6, migrateV7, migrateV8, migrateV9, migrateV10];

  const UNStore = {
    async getLocal(key, def) {
      const r = await call(local, 'get', { [key]: def });
      return r[key];
    },
    setLocal(key, val) {
      return call(local, 'set', { [key]: val });
    },
    removeLocal(key) {
      return new Promise((resolve, reject) => {
        local.remove(key, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve();
        });
      });
    },
    async getSync(key, def) {
      const r = await call(sync, 'get', { [key]: def });
      return r[key];
    },
    setSync(key, val) {
      return call(sync, 'set', { [key]: val });
    },

    // ---- bulk variants (whole-object get/set, lastError-checked like the rest) ----
    getSyncAll() {
      return call(sync, 'get', null);
    },
    setSyncAll(obj) {
      return call(sync, 'set', obj);
    },
    setLocalAll(obj) {
      return call(local, 'set', obj);
    },

    // ---- TTL cache (in local) ----
    async cacheGet(key) {
      const c = await this.getLocal('cache_' + key, null);
      if (!c) return null;
      if (Date.now() > c.exp) return null;
      return c.data;
    },
    cacheSet(key, data, ttlMs) {
      return this.setLocal('cache_' + key, { data, exp: Date.now() + ttlMs });
    },

    /**
     * Drop expired `cache_*` entries from storage.local.
     *
     * cacheGet only *ignores* a stale entry — it never deletes it, and every
     * distinct query string (a 50-id channels batch, a playlistItems page…)
     * mints its own key. Without a sweep, local storage grows without bound
     * with data that can never be read again. Called on startup/install and
     * from the daily alarm.
     *
     * @returns {Promise<{removed: number, kept: number}>}
     */
    pruneCaches() {
      return new Promise((resolve) => {
        local.get(null, (all) => {
          if (chrome.runtime.lastError || !all) {
            resolve({ removed: 0, kept: 0 });
            return;
          }
          const now = Date.now();
          const stale = [];
          let kept = 0;
          Object.keys(all).forEach((key) => {
            if (key.indexOf('cache_') !== 0) return;
            const entry = all[key];
            // Malformed entries (no numeric exp) can never expire on their own —
            // treat them as stale rather than leaving them wedged forever.
            if (!entry || typeof entry.exp !== 'number' || entry.exp <= now) stale.push(key);
            else kept++;
          });
          if (!stale.length) {
            resolve({ removed: 0, kept });
            return;
          }
          local.remove(stale, () => {
            void chrome.runtime.lastError;
            resolve({ removed: stale.length, kept });
          });
        });
      });
    },

    // ---- daily Data-API quota counter (serialized to avoid lost increments) ----
    async quotaToday() {
      const day = today();
      const q = await this.getLocal('quota', { day, used: 0 });
      return q.day === day ? q : { day, used: 0 };
    },
    async quotaAdd(cost) {
      if (!this._quotaChain) this._quotaChain = Promise.resolve();
      const op = this._quotaChain.then(async () => {
        const day = today();
        let q = await this.getLocal('quota', { day, used: 0 });
        if (q.day !== day) q = { day, used: 0 };
        q.used += cost;
        await this.setLocal('quota', q);
        return q;
      });
      this._quotaChain = op.catch(() => {});
      return op;
    },
    // Atomically check-then-reserve within the SAME serialized chain quotaAdd
    // uses, so concurrent callers (e.g. the YT_VIDEO_PLAYLISTS handler firing
    // several UNApi.call()s at once) can't all read "used" before any of them
    // writes. api.js used to call quotaToday() (a plain unlocked read) to
    // decide whether to proceed, entirely separate from the quotaAdd() call
    // made only after a real fetch() completed — every concurrent caller
    // could pass the check before any of them incremented "used", so the cap
    // provided no actual ceiling on concurrent requests. Returns
    // { ok, used } — ok:false means the cap would be exceeded and nothing
    // was reserved.
    async quotaReserve(cost, cap) {
      if (!this._quotaChain) this._quotaChain = Promise.resolve();
      const op = this._quotaChain.then(async () => {
        const day = today();
        let q = await this.getLocal('quota', { day, used: 0 });
        if (q.day !== day) q = { day, used: 0 };
        if (q.used + cost > cap) return { ok: false, used: q.used };
        q.used += cost;
        await this.setLocal('quota', q);
        return { ok: true, used: q.used };
      });
      this._quotaChain = op.catch(() => {});
      return op;
    },

    // ---- one-time schema migrations (run from the SW on install/startup) ----
    SCHEMA_VERSION: SCHEMA_VERSION,
    PRE_QUIET_DEFAULT_ON: PRE_QUIET_DEFAULT_ON,
    FORMER_DEFAULT_ON: FORMER_DEFAULT_ON,
    async runMigrations() {
      const from = Number(await this.getLocal('schemaVersion', 0)) || 0;
      if (from >= SCHEMA_VERSION) return { migrated: false, version: from };
      let reached = from;
      for (let v = from; v < SCHEMA_VERSION; v++) {
        const fn = MIGRATIONS[v];
        if (!fn) { reached = v + 1; continue; }
        try {
          await fn(from);
          reached = v + 1;
        } catch (e) {
          // Stop advancing schemaVersion past a migration that actually failed —
          // it used to be swallowed here and schemaVersion still got bumped to
          // SCHEMA_VERSION unconditionally below, so a failed migration was
          // permanently marked done and never retried on the next startup.
          break;
        }
      }
      if (reached > from) await this.setLocal('schemaVersion', reached);
      return { migrated: reached > from, version: reached };
    }
  };

  g.UNStore = UNStore;
})(typeof self !== 'undefined' ? self : window);
