/**
 * Unsynth suite — background service worker.
 *
 * Owns everything that must not live in a content script:
 *   - Google OAuth via chrome.identity.launchWebAuthFlow + token refresh
 *   - YouTube Data API proxy (through UNApi, with caching + quota)
 *   - Claude LLM proxy (BYOK; key stored in chrome.storage.local)
 *
 * MV3 service workers terminate when idle, so token/config/key are always read
 * fresh from storage at the start of each handler — never cached in memory.
 *
 * Classic worker (not a module) so importScripts works.
 */
importScripts('../shared/storage.js', '../shared/api.js', '../shared/messages.js', '../shared/semver.js', '../shared/update-check.js', '../shared/sub-groups.js', '../shared/playlist-folders.js', '../shared/playlist-library.js', '../shared/recommended-profile.js', '../shared/channel-scrape.js', '../shared/creator-studio.js', '../shared/llm-request.js', '../shared/dev-reload.js', '../build/injection-table.js', '../shared/discover.js', './content-script-registry.js');

// ---- Lazy content-script sync (Phase 2) ----
// The core content-script block is declared statically; feature modules are
// registered via chrome.scripting only when their moduleKey is enabled. Read
// the effective modules map (injection-table defaults merged over stored sync
// settings) and hand it to the registry.
async function syncLazyModules() {
  try {
    const base = (self.UNInjectionTable && self.UNInjectionTable.defaultModules) || {};
    const stored = await new Promise((resolve) => chrome.storage.sync.get({ modules: {} }, resolve));
    const modules = Object.assign({}, base, stored.modules || {});
    if (typeof self.syncLazyContentScripts === 'function') {
      await self.syncLazyContentScripts(modules);
    }
  } catch (e) {
    console.warn('[Unsynth][registry.sync]', e);
  }
}

const OAUTH_SCOPES = {
  readonly: 'https://www.googleapis.com/auth/youtube.readonly',
  write: 'https://www.googleapis.com/auth/youtube',
};

// ---- OAuth config ----
// Public installs: user pastes their own Web client in the dashboard.
// This machine: gitignored src/oauth-local.json seeds empty storage once,
// same pattern as ai-local.json. The file is excluded from every public zip.
let _localOAuth;
async function loadLocalOAuth() {
  if (_localOAuth !== undefined) return _localOAuth;
  try {
    const r = await fetch(chrome.runtime.getURL('src/oauth-local.json'));
    _localOAuth = r.ok ? await r.json() : null;
  } catch (e) {
    _localOAuth = null;
  }
  return _localOAuth;
}

async function getOAuthConfig() {
  let clientId = await UNStore.getLocal('oauth_client_id', '');
  let clientSecret = await UNStore.getLocal('oauth_client_secret', '');
  // The seed used to run once, guarded by an 'oauth_local_migrated' flag that
  // was set even when the seed file was missing or the keys were still empty.
  // That flag is what broke this install: the client used to live in the
  // manifest's oauth2 block, so storage was empty, and the run that moved it
  // here set the flag without ever writing a key. Every later call then took
  // the skip path and startAuth() threw no_oauth_config — reported as the
  // account simply not being connected. Gate on the keys actually being
  // present instead, so an empty slot always re-reads the seed.
  if (!clientId || !clientSecret) {
    const local = await loadLocalOAuth();
    if (local && local.clientId && local.clientSecret) {
      if (!clientId) {
        clientId = String(local.clientId);
        await UNStore.setLocal('oauth_client_id', clientId);
      }
      if (!clientSecret) {
        clientSecret = String(local.clientSecret);
        await UNStore.setLocal('oauth_client_secret', clientSecret);
      }
    }
    // Kept only so an existing install stops re-fetching once it is seeded;
    // it no longer suppresses the seed.
    await UNStore.setLocal('oauth_local_migrated', true);
  }
  return { clientId, clientSecret };
}

function redirectUri() {
  return chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/
}

/** Run the interactive consent flow for the given scope keys; persist tokens. */
async function startAuth(scopeKeys) {
  const cfg = await getOAuthConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error('no_oauth_config');
  }
  const existing = await UNStore.getLocal('auth_tokens', null);
  const wantScopes = new Set((existing && existing.scopeKeys) || []);
  (scopeKeys || ['readonly']).forEach((k) => wantScopes.add(k));
  const scopeList = [...wantScopes].map((k) => OAUTH_SCOPES[k]).filter(Boolean);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', cfg.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri());
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopeList.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  const code = new URL(redirect).searchParams.get('code');
  if (!code) throw new Error('no_code');

  // Same 15s cap as the refresh exchange below — an unresponsive token endpoint
  // would otherwise leave the dashboard's "Connect" spinner hanging forever.
  const tok = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    })
  }, 15000).then((r) => r.json());

  if (!tok.access_token) throw new Error('token_exchange_failed: ' + JSON.stringify(tok));

  const tokens = {
    access_token: tok.access_token,
    // Google only returns refresh_token on first consent; keep the old one otherwise.
    refresh_token: tok.refresh_token || (existing && existing.refresh_token),
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
    scopeKeys: [...wantScopes],
    // MONOTONIC WRITE GENERATION — ordering, not content.
    //
    // A refresh in flight must be able to tell that a NEWER grant landed while
    // it was waiting. Comparing refresh_token cannot do that: the line above
    // says why — Google returns no refresh_token on re-consent, so the old one
    // is carried forward and the two records compare equal. A user
    // re-consenting to add the write scope keeps the same refresh_token, and a
    // content-based guard sees no change and overwrites the new grant anyway.
    //
    // Executed against the shipped function by an independent reviewer:
    // same-token consent was still destroyed. The generation makes the
    // comparison about WHEN a record was written, which is the actual question.
    authGen: ((existing && existing.authGen) || 0) + 1
  };
  await UNStore.setLocal('auth_tokens', tokens);
  return { authed: true, scopeKeys: tokens.scopeKeys };
}

/** Return a valid access token, refreshing if needed. Dedupes in-flight refreshes. */
let refreshPromise = null;
/**
 * ISO 8601 duration -> seconds. YouTube returns "PT4M13S" and videos.list will
 * not give you anything else.
 *
 * Inlined rather than imported: the service worker does not load catch-up.js,
 * and pulling a whole module in for one pure function is worse than the
 * duplication. UNCatchUp.parseIsoDuration is the same function, kept there for
 * content-script callers and covered by the unit tests.
 *
 * Cases that bite: a live stream returns "P0D" and must be 0 rather than NaN;
 * hours appear only when non-zero, so "PT2H" has no minutes or seconds at all;
 * days appear on genuinely long uploads ("P1DT2H").
 */
function parseIsoDuration(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const total = Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600
    + Number(m[3] || 0) * 60 + Number(m[4] || 0);
  return isFinite(total) && total > 0 ? Math.round(total) : 0;
}

async function getAccessToken() {
  const t = await UNStore.getLocal('auth_tokens', null);
  if (!t || !t.access_token) throw new Error('not_authed');
  if (Date.now() < t.expires_at - 300000) return t.access_token;
  if (!t.refresh_token) throw new Error('no_refresh_token');

  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const cur = await UNStore.getLocal('auth_tokens', null);
    if (!cur || !cur.refresh_token) throw new Error('no_refresh_token');
    const cfg = await getOAuthConfig();
    const r = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cur.refresh_token,
        grant_type: 'refresh_token'
      })
    }, 15000).then((res) => res.json());

    if (!r.access_token) throw new Error('refresh_failed: ' + JSON.stringify(r));

    // RE-READ BEFORE WRITING: `cur` is up to 15 seconds stale by now.
    //
    // `cur` was snapshotted before a network call capped at 15s, and
    // UNStore.setLocal replaces the WHOLE record. startAuth() also writes the
    // whole record, and refreshPromise serialises refreshes against each other
    // but NOT against a consent grant. So a refresh that began before the user
    // completed OAuth and finished after it would overwrite the fresh grant
    // with the old refresh_token and the old scopeKeys.
    //
    // Reproduced in a harness by an independent reviewer:
    //   after consent : access FRESH_CONSENT, refresh R_NEW, scopes [readonly, write]
    //   after refresh : access REFRESHED_FROM_OLD, refresh R_OLD, scopes [readonly]
    //
    // The write grant vanishes with no error anywhere, and if the old
    // refresh_token was the revoked one, the result is a token that can neither
    // be used nor renewed — which presents as a disconnected account. The
    // window opens on exactly the action a user takes when auth looks wrong.
    //
    // NOT claimed as the cause of the reported incident: there is no evidence
    // tying it to that timeline. It is a real defect found on the way.
    const latest = await UNStore.getLocal('auth_tokens', null);
    if (!latest || !latest.access_token) {
      // Signed out mid-refresh. Honour that rather than resurrecting tokens.
      throw new Error('signed_out_during_refresh');
    }
    // ORDERING, NOT CONTENT. The first version of this compared refresh_token
    // and was insufficient: startAuth() carries the old refresh_token forward
    // when Google omits it, which is every re-consent after the first. A user
    // re-consenting to add the write scope therefore produced two records with
    // an IDENTICAL refresh_token, the comparison saw no change, and the fresh
    // grant was overwritten exactly as before. Proven by executing the shipped
    // function, not by review.
    //
    // authGen increments on every consent write, so "did something newer land"
    // is answered by sequence — which is the real question — and works whether
    // or not Google rotated anything.
    const curGen = cur.authGen || 0;
    const latestGen = latest.authGen || 0;
    if (latestGen > curGen || latest.refresh_token !== cur.refresh_token) {
      // A newer grant landed while this refresh was in flight. Abandon this
      // write entirely and hand back what that grant provided.
      return latest.access_token;
    }
    // Merge onto the LATEST record, not the stale snapshot, so any field the
    // newer write added (scopeKeys in particular) survives.
    latest.access_token = r.access_token;
    latest.expires_at = Date.now() + (r.expires_in || 3600) * 1000;
    await UNStore.setLocal('auth_tokens', latest);
    return latest.access_token;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function authStatus() {
  const t = await UNStore.getLocal('auth_tokens', null);
  const cfg = await getOAuthConfig();
  const hasToken = !!(t && t.access_token);
  // A token being PRESENT is not the same as it being usable, and the
  // difference is exactly what "is my account still connected?" is asking.
  // This used to report authed purely on `!!access_token`, so the dashboard
  // printed a green "Connected ✓" for a token that was expired with no
  // refresh_token to renew it, or one Google had already revoked — every API
  // call then failed while the UI insisted the account was fine.
  const expired = !!(t && t.expires_at && Date.now() >= t.expires_at - 300000);
  const renewable = !!(t && t.refresh_token);
  return {
    authed: hasToken,
    // True only when the token can actually be used right now, either because
    // it is still valid or because it can be refreshed.
    usable: hasToken && (!expired || renewable),
    expired: hasToken && expired,
    renewable: renewable,
    expiresAt: (t && t.expires_at) || 0,
    scopeKeys: (t && t.scopeKeys) || [],
    hasConfig: !!(cfg.clientId && cfg.clientSecret)
  };
}

/** Fetch subscribed channels via Data API (requires OAuth). */
async function fetchMySubscriptions() {
  const token = await getAccessToken();
  const subs = [];
  let pageToken = '';
  for (let i = 0; i < 40; i++) {
    const data = await UNApi.call({
      path: 'subscriptions',
      params: Object.assign({ part: 'snippet', mine: 'true', maxResults: '50', order: 'alphabetical' }, pageToken ? { pageToken } : {}),
      accessToken: token,
      ttlMs: 6 * 3600 * 1000
    });
    (data.items || []).forEach((s) => {
      const sn = s.snippet || {};
      const th = (sn.thumbnails && (sn.thumbnails.default || sn.thumbnails.medium)) || {};
      subs.push({ channelId: (sn.resourceId && sn.resourceId.channelId) || '', title: sn.title || '', thumb: th.url || '' });
    });
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  const clean = subs.filter((s) => s.channelId);
  try {
    const ids = clean.map((s) => s.channelId);
    const handleById = {};
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const cd = await UNApi.call({
        path: 'channels',
        params: { part: 'snippet', id: batch.join(','), maxResults: '50' },
        accessToken: token,
        ttlMs: 24 * 3600 * 1000
      });
      (cd.items || []).forEach((c) => {
        const cu = (c.snippet && c.snippet.customUrl) || '';
        if (cu) handleById[c.id] = cu;
      });
    }
    clean.forEach((s) => {
      s.handle = handleById[s.channelId] || '';
    });
  } catch (e) {
    /* handle enrichment is best-effort */
  }
  // Keep the complete, normalized account list locally. Smart rows and the
  // group manager can now load from one authoritative OAuth snapshot instead
  // of trying to reconstruct subscriptions from whichever guide rows happen
  // to be visible in YouTube's virtualized sidebar.
  await UNStore.setLocal('subscribedChannels', { items: clean, updatedAt: Date.now() });
  // Reconcile manual groups against the account snapshot. Imports often store
  // channel IDs while YouTube feed tiles expose handles; preserving both forms
  // prevents valid group members from disappearing during virtualized loads.
  try {
    const store = await UNStore.getLocal('subStore', { groups: {}, names: {}, aliases: {} });
    let changed = false;
    clean.forEach((sub) => {
      const idKey = 'channel:' + sub.channelId;
      const handleKey = UNSubGroups.handleKey(sub.handle);
      const groupedById = UNSubGroups.groupsForChannel(store, idKey).length > 0;
      const groupedByHandle = handleKey && UNSubGroups.groupsForChannel(store, handleKey).length > 0;
      if (!groupedById && !groupedByHandle) return;
      store.names = store.names || {};
      if (sub.title && store.names[idKey] !== sub.title) {
        store.names[idKey] = sub.title;
        changed = true;
      }
      if (handleKey) {
        if (sub.title && store.names[handleKey] !== sub.title) {
          store.names[handleKey] = sub.title;
          changed = true;
        }
        if (!store.aliases || store.aliases[idKey] !== handleKey || store.aliases[handleKey] !== idKey) {
          UNSubGroups.setAlias(store, idKey, handleKey);
          changed = true;
        }
      }
    });
    if (changed) await UNStore.setLocal('subStore', store);
  } catch (e) {
    /* group reconciliation is best-effort */
  }
  return clean;
}

// refreshSubscribedChannelCache() (OAuth-backed full refresh) and the
// SUBS_CACHE_MERGE handler (guide-scrape incremental merge) both do an
// unlocked get-then-set on the same subscribedChannelCache key. A guide-scrape
// merge landing while a refresh is mid-flight (or two refreshes overlapping,
// e.g. an alarm firing while a manual one is already running) let the later
// writer's read-before-the-earlier-write silently drop the earlier write.
// Chain every read-modify-write to this key through one promise, same
// serialization pattern as UNStore.quotaAdd in shared/storage.js.
let _subCacheChain = Promise.resolve();
function withSubscribedCacheLock(fn) {
  const op = _subCacheChain.then(fn);
  _subCacheChain = op.catch(() => {});
  return op;
}

async function refreshSubscribedChannelCache() {
  try {
    const tokens = await UNStore.getLocal('auth_tokens', null);
    if (!tokens) return { ok: false, error: 'not_authed' };
    const subs = await fetchMySubscriptions();
    const built = UNSubGroups.buildSubscribedCache(subs);
    const cache = await withSubscribedCacheLock(async () => {
      const prev = await UNStore.getLocal('subscribedChannelCache', { keys: [], names: [] });
      const merged = UNSubGroups.mergeSubscribedCaches(prev, built);
      await UNStore.setLocal('subscribedChannelCache', merged);
      return merged;
    });
    await UNStore.setLocal('subscribedChannelsOAuthUpdated', Date.now());
    return { ok: true, count: cache.keys.length, subs: subs.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

const HISTORY_SYNC_URL = 'https://unsynth.vercel.app/api/sync/watch-history';
const QUEUE_SYNC_URL = 'https://unsynth.vercel.app/api/sync/queue';
const LIBRARY_SYNC_URL = 'https://unsynth.vercel.app/api/sync/library';

/**
 * Push local watch-history state, merge with the server, pull the merged
 * result back into local storage. No-ops if sync isn't enabled. Reuses the
 * same Google access token already held for the YouTube Data API — the sync
 * backend verifies it server-side, so this needs no separate consent screen.
 * Never throws — always returns { ok, ... } like refreshSubscribedChannelCache().
 */
/**
 * Push the local watch queue to the backend.
 *
 * chrome.storage.sync remains the always-on fallback (no account, no network
 * needed) but caps a key at 8KB — roughly 26 queue items with real titles,
 * after which Chrome rejects the whole write. This path has no such cap and
 * works regardless of browser sign-in, so the two together cover both the
 * offline single-browser case and a large queue across devices.
 */
async function pushQueueToCloud(items, version) {
  const cfg = await UNStore.getLocal('queueSync', { enabled: false, lastSyncAt: 0, lastError: null });
  if (!cfg.enabled) return { ok: false, error: 'sync_disabled' };
  try {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(
      QUEUE_SYNC_URL,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ items: items || [], v: version || Date.now() })
      },
      15000
    ).then((r) => r.json());
    if (!res || !res.ok) throw new Error((res && res.error) || 'sync_failed');
    await UNStore.setLocal('queueSync', { enabled: true, lastSyncAt: Date.now(), lastError: null });
    // `stale` means another device had a newer queue — hand it back so the
    // caller adopts it rather than assuming its own write won.
    return { ok: true, items: res.items || [], v: res.v || 0, stale: !!res.stale };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await UNStore.setLocal('queueSync', Object.assign({}, cfg, { lastError: msg }));
    return { ok: false, error: msg };
  }
}

async function pullQueueFromCloud() {
  const cfg = await UNStore.getLocal('queueSync', { enabled: false, lastSyncAt: 0, lastError: null });
  if (!cfg.enabled) return { ok: false, error: 'sync_disabled' };
  try {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(
      QUEUE_SYNC_URL,
      { method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      15000
    ).then((r) => r.json());
    if (!res || !res.ok) throw new Error((res && res.error) || 'sync_failed');
    await UNStore.setLocal('queueSync', { enabled: true, lastSyncAt: Date.now(), lastError: null });
    return { ok: true, items: res.items || [], v: res.v || 0 };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await UNStore.setLocal('queueSync', Object.assign({}, cfg, { lastError: msg }));
    return { ok: false, error: msg };
  }
}

async function pushLibraryToCloud(subs, folders, version) {
  const cfg = await UNStore.getLocal('librarySync', { enabled: false, lastSyncAt: 0, lastError: null });
  if (!cfg.enabled) return { ok: false, error: 'sync_disabled' };
  try {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(
      LIBRARY_SYNC_URL,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ subs: subs || {}, folders: folders || {}, v: version || Date.now() })
      },
      15000
    ).then((r) => r.json());
    if (!res || !res.ok) throw new Error((res && res.error) || 'sync_failed');
    await UNStore.setLocal('librarySync', { enabled: true, lastSyncAt: Date.now(), lastError: null });
    return { ok: true, subs: res.subs || {}, folders: res.folders || {}, v: res.v || 0, stale: !!res.stale };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await UNStore.setLocal('librarySync', Object.assign({}, cfg, { lastError: msg }));
    return { ok: false, error: msg };
  }
}

async function pullLibraryFromCloud() {
  const cfg = await UNStore.getLocal('librarySync', { enabled: false, lastSyncAt: 0, lastError: null });
  if (!cfg.enabled) return { ok: false, error: 'sync_disabled' };
  try {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(
      LIBRARY_SYNC_URL,
      { method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      15000
    ).then((r) => r.json());
    if (!res || !res.ok) throw new Error((res && res.error) || 'sync_failed');
    await UNStore.setLocal('librarySync', { enabled: true, lastSyncAt: Date.now(), lastError: null });
    return { ok: true, subs: res.subs || {}, folders: res.folders || {}, v: res.v || 0 };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await UNStore.setLocal('librarySync', Object.assign({}, cfg, { lastError: msg }));
    return { ok: false, error: msg };
  }
}

let _libraryPushTimer = null;
let _applyingLibraryRemote = false;
let _lastLibrarySyncVersion = 0;

function scheduleLibraryPush() {
  if (_applyingLibraryRemote) return;
  if (_libraryPushTimer) clearTimeout(_libraryPushTimer);
  _libraryPushTimer = setTimeout(() => {
    _libraryPushTimer = null;
    pushLibraryNow().catch(() => {});
  }, 400);
}

async function pushLibraryNow() {
  const cfg = await UNStore.getLocal('librarySync', { enabled: false, lastSyncAt: 0, lastError: null });
  if (!cfg.enabled) return { ok: false, error: 'sync_disabled' };
  const loc = await new Promise((resolve) => chrome.storage.local.get(['subStore', 'plFolderStore'], resolve));
  const v = Date.now();
  _lastLibrarySyncVersion = v;
  const res = await pushLibraryToCloud(loc.subStore || {}, loc.plFolderStore || {}, v);
  if (res && res.stale) {
    await applyRemoteLibrary(res);
  }
  return res;
}

async function applyRemoteLibrary(payload) {
  if (!payload || !payload.ok) return false;
  // MV3 kills this worker after ~30s idle, which resets the module-level
  // _lastLibrarySyncVersion to 0 — so on a cold wake this guard compared
  // against 0 and accepted ANY remote payload, including an older one.
  // pullLibraryNow() is called from onInstalled, onStartup and the storage
  // change handler, all wake triggers, so that path is normal rather than an
  // edge case. The write below is unconditional once the guard passes: a stale
  // remote silently reverts subStore / plFolderStore with no merge and no
  // recovery. Rehydrate the high-water mark from storage before comparing.
  const _cfgV = await UNStore.getLocal('librarySync', {});
  const _knownV = Math.max(_lastLibrarySyncVersion, Number(_cfgV && _cfgV.lastVersion) || 0);
  if (payload.v && payload.v <= _knownV) return false;
  _applyingLibraryRemote = true;
  _lastLibrarySyncVersion = payload.v || Date.now();
  // Persist it so the next wake starts from the real high-water mark.
  try {
    await UNStore.setLocal('librarySync',
      Object.assign({}, _cfgV || {}, { lastVersion: _lastLibrarySyncVersion }));
  } catch (e) { /* a failed bookkeeping write must not block the apply */ }
  try {
    const writes = {};
    if (payload.subs && typeof payload.subs === 'object') writes.subStore = payload.subs;
    if (payload.folders && typeof payload.folders === 'object') writes.plFolderStore = payload.folders;
    // EMPTY_REMOTE_OK: nothing to write means the two sides already agree.
    // That is a successful sync, not a failure — returning false here made a
    // working first-time sync render as "not synced yet".
    if (!Object.keys(writes).length) return true;
    await new Promise((resolve) => chrome.storage.local.set(writes, resolve));
    return true;
  } finally {
    _applyingLibraryRemote = false;
  }
}

async function pullLibraryNow() {
  const res = await pullLibraryFromCloud();
  if (!res || !res.ok) return res;
  await applyRemoteLibrary(res);
  return res;
}

async function runHistorySync() {
  const cfg = await UNStore.getLocal('historySync', { enabled: false, lastSyncAt: 0, lastError: null });
  if (!cfg.enabled) return { ok: false, error: 'sync_disabled' };
  try {
    const token = await getAccessToken();
    const local = await new Promise((resolve) =>
      chrome.storage.local.get(['watchedVideos', 'watchProgress', 'watchedDates'], resolve)
    );
    const res = await fetchWithTimeout(
      HISTORY_SYNC_URL,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          watchedVideos: (local && local.watchedVideos) || [],
          watchProgress: (local && local.watchProgress) || {},
          // Without this a video watched on another device arrived marked
          // watched but undated, so its thumbnail badge showed "seen" instead
          // of when it was watched.
          watchedDates: (local && local.watchedDates) || {}
        })
      },
      15000
    ).then((r) => r.json());
    if (!res || !res.ok) throw new Error((res && res.error) || 'sync_failed');
    // The server already merged our push with whatever the other device sent —
    // writing this back locally is what makes newly-watched videos on the OTHER
    // device show up here. watch-history.js already listens for exactly this
    // change (chrome.storage.onChanged on 'local') and refreshes badges itself.
    await new Promise((resolve) =>
      chrome.storage.local.set(
        {
          watchedVideos: res.watchedVideos || [],
          watchProgress: res.watchProgress || {},
          // Merge rather than overwrite: an older server blob (written before
          // dates were synced) returns {} here, and blindly assigning it would
          // wipe dates this device already had on disk.
          watchedDates: Object.assign({}, (local && local.watchedDates) || {}, res.watchedDates || {})
        },
        resolve
      )
    );
    const next = { enabled: true, lastSyncAt: Date.now(), lastError: null };
    await UNStore.setLocal('historySync', next);
    return { ok: true, lastSyncAt: next.lastSyncAt, count: (res.watchedVideos || []).length };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await UNStore.setLocal('historySync', Object.assign({}, cfg, { lastError: msg }));
    return { ok: false, error: msg };
  }
}

/**
 * Turn sync off, and delete the server-side copy, reporting whether that
 * delete actually happened.
 *
 * It used to swallow every failure, never look at the status, and return
 * {ok:true}, and the dashboard then said "server copy deleted" regardless
 * (code review on PR #2, confirmed 2026-09-23): a false privacy claim. Sync
 * still turns off locally either way; a failed delete is remembered as
 * deletePending so the dashboard can say so and offer a retry. A 404 means
 * there was nothing stored, which is deleted as far as the user is concerned.
 */
async function deleteHistorySync() {
  let serverDeleted = false;
  let error = null;
  try {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(HISTORY_SYNC_URL, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }, 15000);
    serverDeleted = !!(res && (res.ok || res.status === 404));
    if (!serverDeleted) error = 'the server replied ' + (res ? res.status : 'nothing');
  } catch (e) {
    error = e && e.name === 'AbortError' ? 'the server did not answer in time' : (e && e.message) || 'network error';
  }
  await UNStore.setLocal('historySync', { enabled: false, lastSyncAt: 0, lastError: null, deletePending: !serverDeleted });
  return { ok: true, serverDeleted, error };
}

/**
 * Run `items` through `worker` with at most `limit` in flight at once,
 * calling onProgress(doneCount, total) after each settles. Stops launching
 * new work as soon as a worker's result carries `{stop: true}` (set by a
 * worker hitting a 401) so an expired token doesn't burn through the rest of
 * a large batch.
 *
 * NOT safe for concurrent WRITES to the same YouTube playlist resource — see
 * the addVideosToPlaylist/removePlaylistItems comments below for why those
 * two stay serial (limit=1) despite this helper supporting concurrency.
 * Kept general-purpose for callers where the items are independent resources
 * (e.g. reads, or writes to N different playlists).
 */
async function runBounded(items, limit, worker, onProgress) {
  let cursor = 0;
  let done = 0;
  let stopped = false;
  const total = items.length;
  const results = new Array(total);
  async function lane() {
    while (!stopped) {
      const i = cursor++;
      if (i >= total) return;
      results[i] = await worker(items[i], i);
      done++;
      if (onProgress) onProgress(done, total);
      if (results[i] && results[i].stop) stopped = true;
    }
  }
  const lanes = [];
  for (let i = 0; i < Math.min(limit, total); i++) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

/**
 * Add videos to a playlist; optional progress callback(current, total, added).
 *
 * Previously this ran one POST at a time with a flat 110ms sleep after EVERY
 * item — for a 100-video move that's 100 sequential round-trips plus 11s of
 * pure dead time, and the *whole* batch (add phase, then a second equally
 * serial remove phase) had to finish inside one chrome.runtime.sendMessage
 * call with no timeout on the content-script side. Large selections routinely
 * outlived the MV3 service worker's idle/lifetime limits: the worker got
 * killed mid-loop, whatever had already been added/removed stayed that way,
 * and the caller just saw a generic "Failed" with no indication which videos
 * actually moved. Reported live as "doesn't move them all / takes too long /
 * errors" on large multi-select moves.
 *
 * An earlier version of this fix ran these POSTs with concurrency 4 via
 * runBounded. Confirmed live against a real account: firing 3+ concurrent
 * playlistItems.insert calls at the SAME playlist silently drops writes —
 * every request returned r.ok, but only 1 of 3 videos actually landed,
 * reproduced twice with a different single survivor each time. YouTube's
 * playlist mutation apparently isn't safely concurrent server-side (likely an
 * optimistic-concurrency/position conflict on the playlist resource that the
 * REST response doesn't surface as an error). So adds to ONE playlist stay
 * serial — runBulkPlaylistOp below still parallelizes ACROSS destination
 * playlists for a multi-destination move, which is a genuinely independent
 * resource per destination and was the actual slow case in the original bug
 * report, without reintroducing the write-loss race within a single playlist.
 * A short pacing gap between requests (not the old flat 110ms, but not zero)
 * avoids tripping a burst rate limit on rapid serial writes.
 */
async function addVideosToPlaylist(token, playlistId, ids, onProgress) {
  playlistId = String(playlistId || '');
  ids = (Array.isArray(ids) ? ids : [])
    .slice(0, 200)
    .map((id) => String(id || ''))
    .filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id));
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(playlistId)) {
    return { added: 0, failed: ids, authExpired: false, error: 'bad_playlist_id' };
  }
  if (!ids.length) return { added: 0, failed: [], authExpired: false };
  let added = 0;
  const failed = [];
  let authExpired = false;
  let needsWriteScope = false;
  for (let i = 0; i < ids.length; i++) {
    const videoId = ids[i];
    try {
      const r = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } })
      });
      if (r.ok) {
        added++;
      } else {
        failed.push(videoId);
        if (r.status === 401) {
          authExpired = true;
          break;
        }
        // A token carrying only the readonly scope fails writes with 403, not
        // 401. This used to fall through to "failed" with no reason attached,
        // so adding to a playlist did nothing at all and said nothing about
        // why — indistinguishable from the feature being broken. Surface it as
        // its own state so the UI can tell the user to reconnect for write
        // access instead of silently dropping the write.
        if (r.status === 403) {
          needsWriteScope = true;
          break;
        }
      }
    } catch (e) {
      failed.push(videoId);
    }
    if (onProgress) onProgress(i + 1, ids.length, added);
    if (i < ids.length - 1) await new Promise((d) => setTimeout(d, 60));
  }
  return { added, failed, authExpired, needsWriteScope };
}

/**
 * Remove playlistItems by itemId; optional progress callback(current, total,
 * removed). Kept serial for the same reason addVideosToPlaylist is — not
 * confirmed safe to parallelize writes against the same playlist's item list,
 * and a silently dropped removal (a video that looks gone in the UI but is
 * still actually queued/still in the playlist) is worse than a slower delete.
 */
async function removePlaylistItems(token, itemIds, onProgress) {
  const ids = (Array.isArray(itemIds) ? itemIds : []).filter(Boolean).map(String);
  if (!ids.length) return { removed: 0, failed: [], authExpired: false };
  let removed = 0;
  const failed = [];
  let authExpired = false;
  let needsWriteScope = false;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const r = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?id=' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      if (r.ok || r.status === 204) {
        removed++;
      } else {
        failed.push(id);
        if (r.status === 401) {
          authExpired = true;
          break;
        }
        // Same readonly-scope 403 as the insert path above: a delete rejected
        // for lack of write scope looked identical to a video that simply
        // could not be removed.
        if (r.status === 403) {
          needsWriteScope = true;
          break;
        }
      }
    } catch (e) {
      failed.push(id);
    }
    if (onProgress) onProgress(i + 1, ids.length, removed);
    if (i < ids.length - 1) await new Promise((d) => setTimeout(d, 60));
  }
  return { removed, failed, authExpired, needsWriteScope };
}

/** Create a YouTube playlist and populate it. onProgress(current, total, added, phase). */
async function createYouTubePlaylist(msg, onProgress) {
  const tokens = await UNStore.getLocal('auth_tokens', null);
  if (!tokens || !tokens.scopeKeys || tokens.scopeKeys.indexOf('write') === -1) {
    return { ok: false, error: 'needs_write_scope' };
  }
  const token = await getAccessToken();
  const title = String(msg.title || 'Playlist').slice(0, 150);
  const description = String(msg.description || 'Built with Unsynth Playlist Forge').slice(0, 5000);
  const privacy = ['public', 'private', 'unlisted'].indexOf(msg.privacyStatus) >= 0 ? msg.privacyStatus : 'public';
  const ids = (Array.isArray(msg.videoIds) ? msg.videoIds : [])
    .slice(0, 200)
    .map((id) => String(id || ''))
    .filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id));

  if (onProgress) onProgress(0, ids.length || 1, 0, 'creating');
  const createRes = await fetch('https://www.googleapis.com/youtube/v3/playlists?part=snippet,status', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({
      snippet: { title, description },
      status: { privacyStatus: privacy }
    })
  });
  const pl = await createRes.json();
  if (!createRes.ok) {
    if (createRes.status === 401) return { ok: false, error: 'auth_expired' };
    return { ok: false, error: (pl.error && pl.error.message) || 'create_failed' };
  }
  const playlistId = pl.id;
  if (!ids.length) {
    return {
      ok: true,
      playlistId,
      title,
      added: 0,
      failed: [],
      url: 'https://www.youtube.com/playlist?list=' + playlistId
    };
  }

  const result = await addVideosToPlaylist(token, playlistId, ids, (cur, tot, added) => {
    if (onProgress) onProgress(cur, tot, added, 'adding');
  });
  if (result.authExpired) {
    return {
      ok: false,
      playlistId,
      title,
      added: result.added,
      failed: result.failed,
      url: 'https://www.youtube.com/playlist?list=' + playlistId,
      partial: true,
      error: 'auth_expired'
    };
  }
  return {
    ok: true,
    playlistId,
    title,
    added: result.added,
    failed: result.failed,
    url: 'https://www.youtube.com/playlist?list=' + playlistId
  };
}

// ---- Hidden-gems candidate gathering ----
// Deliberately never calls search.list: at 100 quota units it would burn the
// daily 10k cap in ~90 refreshes. A channel's uploads playlist is UU+<id minus
// UC>, and playlistItems/videos/channels are 1 unit per call (50 ids each), so a
// full refresh costs roughly maxChannels + 2 units. Scoring happens in the
// content script via shared/discover.js — this only collects raw facts.
const DISCOVER_TTL_MS = 6 * 3600 * 1000;

async function gatherDiscoverCandidates(msg) {
  const maxChannels = Math.max(1, Math.min(20, Number(msg && msg.maxChannels) || 12));
  const channelIds = (Array.isArray(msg && msg.channelIds) ? msg.channelIds : [])
    .map((id) => String(id || ''))
    .filter((id) => /^UC[\w-]{20,}$/.test(id))
    .slice(0, maxChannels);
  const playlistIds = (Array.isArray(msg && msg.playlistIds) ? msg.playlistIds : [])
    .map((id) => String(id || ''))
    .filter((id) => /^[A-Za-z0-9_-]{2,100}$/.test(id))
    .slice(0, 5);

  if (!channelIds.length && !playlistIds.length) return { ok: true, videos: [], degraded: 'no_sources' };

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    // Not connected: the shelf still works from purely local signals.
    return { ok: true, videos: [], degraded: 'not_authed' };
  }

  // Leave clear headroom for the rest of the day's features before spending.
  const quota = await UNStore.quotaToday();
  if (quota.used + channelIds.length + playlistIds.length + 2 > UNApi.QUOTA_CAP) {
    return { ok: true, videos: [], degraded: 'quota_exhausted', quota: quota.used };
  }

  const byId = new Map();
  const addItems = (items, source) => {
    (items || []).forEach((it) => {
      const sn = it.snippet || {};
      const vid = (sn.resourceId && sn.resourceId.videoId) || (it.contentDetails && it.contentDetails.videoId) || '';
      if (!/^[A-Za-z0-9_-]{11}$/.test(vid) || byId.has(vid)) return;
      // A private/deleted entry keeps its slot in the playlist but has no usable
      // title — skip rather than render a "Private video" tile.
      const title = String(sn.title || '');
      if (!title || title === 'Private video' || title === 'Deleted video') return;
      const th = (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default)) || {};
      byId.set(vid, {
        videoId: vid,
        title,
        channelId: sn.videoOwnerChannelId || sn.channelId || '',
        channelTitle: sn.videoOwnerChannelTitle || sn.channelTitle || '',
        publishedAt: sn.publishedAt || '',
        thumb: th.url || '',
        source
      });
    });
  };

  // Recent uploads from the channels the caller flagged as drifted.
  for (const chId of channelIds) {
    const uploads = UNDiscover.uploadsPlaylistId(chId);
    if (!uploads) continue;
    try {
      const data = await UNApi.call({
        path: 'playlistItems',
        params: { part: 'snippet', playlistId: uploads, maxResults: '10' },
        accessToken: token,
        ttlMs: DISCOVER_TTL_MS
      });
      addItems(data.items, 'drifted-sub');
    } catch (e) {
      // A channel with no uploads playlist (or a 404) must not abort the batch.
    }
  }

  // Videos the user saved and may never have returned to.
  for (const plId of playlistIds) {
    try {
      const data = await UNApi.call({
        path: 'playlistItems',
        params: { part: 'snippet', playlistId: plId, maxResults: '25' },
        accessToken: token,
        ttlMs: DISCOVER_TTL_MS
      });
      addItems(data.items, 'saved');
    } catch (e) {
      /* skip an unreadable playlist */
    }
  }

  const ids = Array.from(byId.keys());
  if (!ids.length) return { ok: true, videos: [] };

  // View counts + exact publish dates — the inputs the age/views rule needs.
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const data = await UNApi.call({
        path: 'videos',
        params: { part: 'statistics,snippet', id: batch.join(','), maxResults: '50' },
        accessToken: token,
        ttlMs: DISCOVER_TTL_MS
      });
      (data.items || []).forEach((v) => {
        const entry = byId.get(v.id);
        if (!entry) return;
        entry.viewCount = Number((v.statistics && v.statistics.viewCount) || 0) || 0;
        if (v.snippet && v.snippet.publishedAt) entry.publishedAt = v.snippet.publishedAt;
        if (v.snippet && v.snippet.channelId) entry.channelId = v.snippet.channelId;
        if (v.snippet && v.snippet.channelTitle) entry.channelTitle = v.snippet.channelTitle;
      });
    } catch (e) {
      /* stats are best-effort — the local rules still score without them */
    }
  }

  // Subscriber counts drive the "small channel" rule.
  const chIds = Array.from(new Set(Array.from(byId.values()).map((v) => v.channelId).filter(Boolean)));
  const subsByChannel = {};
  for (let i = 0; i < chIds.length; i += 50) {
    const batch = chIds.slice(i, i + 50);
    try {
      const data = await UNApi.call({
        path: 'channels',
        params: { part: 'statistics', id: batch.join(','), maxResults: '50' },
        accessToken: token,
        ttlMs: 24 * 3600 * 1000
      });
      (data.items || []).forEach((c) => {
        const st = c.statistics || {};
        if (st.hiddenSubscriberCount) return;
        subsByChannel[c.id] = Number(st.subscriberCount || 0) || 0;
      });
    } catch (e) {
      /* best-effort */
    }
  }
  byId.forEach((v) => {
    if (subsByChannel[v.channelId] != null) v.subscriberCount = subsByChannel[v.channelId];
  });

  const after = await UNStore.quotaToday();
  return { ok: true, videos: Array.from(byId.values()), subsByChannel, quota: after.used };
}

// fetch() with a hard timeout. Third-party endpoints we proxy (RYD, playlist-
// forge, sponsor.ajay.app) go down or hang; without this an unresponsive host
// leaves the awaiting caller (e.g. fact-check's transcript request) stuck
// forever instead of falling back. On timeout the fetch rejects (AbortError),
// which our callers already handle as a normal failure.
function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 10000);
  return fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal })).finally(function () {
    clearTimeout(timer);
  });
}

const rydCache = new Map();
// Return YouTube Dislike rate-limits aggressively. Serialize requests through a
// single chain with a small gap so a feed full of tiles doesn't fire a burst
// that trips 429s (which is why most thumbnails used to come back empty).
let rydChain = Promise.resolve();
let rydNextAt = 0;
const RYD_OK_TTL = 30 * 60 * 1000;   // cache good data 30 min
const RYD_NEG_TTL = 5 * 60 * 1000;   // cache "not found" briefly (don't refetch dead ids)
const RYD_MIN_GAP = 110;             // ms between outgoing requests (~9/sec)
const RYD_STORE_KEY = 'rydCacheV1';

// Persist the cache to session storage so a terminated/restarted MV3 worker
// keeps it — otherwise every wake re-hammers the rate-limited API for tiles the
// user already saw. session storage clears on browser restart, which matches the
// 30-min TTL intent. Hydrate on startup; debounce writes.
try {
  chrome.storage.session.get({ [RYD_STORE_KEY]: {} }, function (d) {
    const saved = (d && d[RYD_STORE_KEY]) || {};
    const now = Date.now();
    Object.keys(saved).forEach(function (id) {
      if (saved[id] && saved[id].expires > now) rydCache.set(id, saved[id]);
    });
  });
} catch (e) { /* session storage unavailable — fall back to in-memory only */ }

let rydPersistTimer = null;
function persistRydCache() {
  if (rydPersistTimer) return;
  rydPersistTimer = setTimeout(function () {
    rydPersistTimer = null;
    const obj = {};
    const now = Date.now();
    rydCache.forEach(function (v, k) { if (v && v.expires > now) obj[k] = v; });
    try { chrome.storage.session.set({ [RYD_STORE_KEY]: obj }); } catch (e) { /* ignore */ }
  }, 1500);
}

function rydSleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function rydDoFetch(id, attempt) {
  // Re-check the cache: a duplicate request may have resolved while we queued.
  const hit = rydCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.data;
  const wait = rydNextAt - Date.now();
  if (wait > 0) await rydSleep(wait);
  rydNextAt = Date.now() + RYD_MIN_GAP;
  try {
    const r = await fetchWithTimeout('https://returnyoutubedislikeapi.com/votes?videoId=' + encodeURIComponent(id), null, 8000);
    if (r.status === 404) {
      const d = { ok: false, error: 'not_found' };
      rydCache.set(id, { data: d, expires: Date.now() + RYD_NEG_TTL });
      persistRydCache();
      return d;
    }
    if (r.status === 429) {
      if (attempt < 4) {
        const ra = parseInt(r.headers.get('retry-after') || '', 10);
        const backoff = ra > 0 ? ra * 1000 : Math.min(8000, 500 * Math.pow(2, attempt));
        rydNextAt = Date.now() + backoff; // hold the whole queue back
        await rydSleep(backoff);
        return rydDoFetch(id, attempt + 1);
      }
      return { ok: false, error: 'rate_limited' };
    }
    if (!r.ok) return { ok: false, error: 'fetch_failed', status: r.status };
    const j = await r.json();
    const data = {
      ok: true,
      videoId: id,
      likes: j.likes,
      dislikes: j.dislikes,
      viewCount: j.viewCount,
      rating: j.rating
    };
    rydCache.set(id, { data, expires: Date.now() + RYD_OK_TTL });
    persistRydCache();
    return data;
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'network_error' };
  }
}

async function fetchRydVotes(videoId) {
  const id = String(videoId || '').trim();
  if (!/^[\w-]{11}$/.test(id)) return { ok: false, error: 'bad_id' };
  const hit = rydCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.data;
  // Queue behind the chain so requests are spaced out, not bursted.
  const job = rydChain.then(function () { return rydDoFetch(id, 0); });
  // Keep the chain alive past failures, but do not swallow silently.
  rydChain = job.catch(function (err) {
    try {
      console.warn('[unsynth] RYD fetch failed', id, (err && err.message) || err);
    } catch (e) { /* ignore */ }
  });
  return job;
}

// ---- LLM proxy (BYOK, multi-provider) ----
const AI_DEFAULTS = {
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  keys: { openrouter: '', openai: '', anthropic: '' }
};
// Sensible default model per provider when the user hasn't picked one.
// Single source of truth lives in shared/llm-request.js (also unit-tested there).

let _localAI;
// Bundled, gitignored src/ai-local.json — lets AI work out of the box without
// pasting a key into the dashboard. Returns null if the file isn't present.
async function loadLocalAI() {
  if (_localAI !== undefined) return _localAI;
  try {
    const r = await fetch(chrome.runtime.getURL('src/ai-local.json'));
    _localAI = r.ok ? await r.json() : null;
  } catch (e) {
    _localAI = null;
  }
  return _localAI;
}

async function getAIConfig() {
  const cfg = await UNStore.getLocal('ai_config', AI_DEFAULTS);
  const merged = Object.assign({}, AI_DEFAULTS, cfg, { keys: Object.assign({}, AI_DEFAULTS.keys, cfg.keys) });
  // Seed the local key only where the user hasn't set one — dashboard always wins.
  // If the saved provider has no key but the local one does, switch to it so the
  // request actually carries credentials (and the cross-provider fallback works).
  // src/ai-local.json is a one-time SEED, not a permanent dependency.
  //
  // It holds a real key so the extension works out of the box during
  // development. It is gitignored and excluded from every packaging path, so
  // it has never shipped -- but a live credential sitting in the working tree
  // is a standing risk anyway: a hand-rolled zip, a shared folder or a backup
  // sync all pick it up. It does not need to be there.
  //
  // So it is copied into chrome.storage.local once, where the user's own keys
  // already live, and a flag records that it happened. After that the file can
  // be deleted with no loss of function -- which is the point.
  const alreadySeeded = await UNStore.getLocal('ai_local_migrated', false);
  if (!alreadySeeded) {
    const local = await loadLocalAI();
    if (local && local.key) {
      const prov = local.provider || 'openrouter';
      // Only ever fills an EMPTY slot. A key the user typed into the dashboard
      // must never be replaced by this one.
      if (!merged.keys[prov]) merged.keys[prov] = local.key;
      if (!merged.keys[merged.provider]) {
        merged.provider = prov;
        if (local.model) merged.model = local.model;
      }
      await UNStore.setLocal('ai_config', merged);
    }
    // Set the flag even when there was no file, so a profile without one does
    // not re-fetch a missing URL on every getAIConfig() call.
    await UNStore.setLocal('ai_local_migrated', true);
  }
  return merged;
}

function normalizeLLMRequest(req) {
  req = req && typeof req === 'object' ? req : {};
  const providers = ['openrouter', 'openai', 'anthropic'];
  const messages = (Array.isArray(req.messages) ? req.messages : [])
    .slice(-40)
    .map((message) => ({
      role: message && message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message && message.content != null ? message.content : '').slice(0, 50000)
    }))
    .filter((message) => message.content);
  return {
    provider: providers.indexOf(req.provider) >= 0 ? req.provider : '',
    model: String(req.model || '').slice(0, 160),
    system: String(req.system || '').slice(0, 20000),
    messages,
    max_tokens: Math.max(16, Math.min(4096, Number(req.max_tokens) || 1024)),
    _noFallback: req._noFallback === true
  };
}

/**
 * Provider-agnostic chat call. OpenRouter + OpenAI share the OpenAI chat
 * format (system folded in as a message); Anthropic uses its own shape.
 */
async function callLLM(req) {
  req = normalizeLLMRequest(req);
  const cfg = await getAIConfig();
  let provider = req.provider || cfg.provider;
  // If the configured provider has no key but another does, use the one that has
  // a key (e.g. set up for ChatGPT but only the OpenRouter key was actually added).
  if (!cfg.keys[provider]) {
    const alt = ['openrouter', 'openai', 'anthropic'].find((p) => cfg.keys[p]);
    if (alt) provider = alt;
  }
  const model = UNLLMRequest.resolveModel(provider, req.model || cfg.model);
  const key = cfg.keys[provider];
  if (!key) return { ok: false, error: 'no_key', provider };

  // On a model/config api_error, retry once on OpenRouter (vendor-prefixed ids,
  // broad model availability) when its key is present — so a stale/invalid model
  // saved in settings still yields an answer instead of a dead "invalid model ID".
  async function fallbackOr(errObj) {
    if (!req._noFallback && provider !== 'openrouter' && cfg.keys.openrouter) {
      const retry = await callLLM(Object.assign({}, req, { provider: 'openrouter', model: 'openai/gpt-4o-mini', _noFallback: true }));
      if (retry && retry.ok) return retry;
    }
    return errObj;
  }

  try {
    if (provider === 'anthropic') {
      const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json'
        },
        body: JSON.stringify(UNLLMRequest.buildLLMBody({ provider, model, maxTokens: req.max_tokens, system: req.system, messages: req.messages }))
      }, 60000);
      const data = await r.json();
      if (!r.ok) return fallbackOr({ ok: false, error: 'api_error', status: r.status, model, provider, message: (data.error && data.error.message) || '' });
      return { ok: true, content: (data.content || []).map((b) => b.text || '').join(''), usage: data.usage, model: data.model };
    }

    // OpenAI-compatible (OpenRouter, OpenAI). Endpoint + body shape (including the
    // OpenAI max_completion_tokens switch and system folding) are built and
    // unit-tested in shared/llm-request.js.
    const endpoint = UNLLMRequest.llmEndpoint(provider);
    const headers = { Authorization: 'Bearer ' + key, 'content-type': 'application/json' };
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/Phaenex/unsynth';
      headers['X-Title'] = 'Unsynth';
    }
    const r = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(UNLLMRequest.buildLLMBody({ provider, model, maxTokens: req.max_tokens, system: req.system, messages: req.messages }))
    }, 60000);
    const data = await r.json();
    if (!r.ok) return fallbackOr({ ok: false, error: 'api_error', status: r.status, model, provider, message: (data.error && data.error.message) || JSON.stringify(data.error || {}) });
    const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    return { ok: true, content: text, usage: data.usage, model: data.model };
  } catch (e) {
    return { ok: false, error: 'network_error', message: String(e) };
  }
}

/**
 * Streaming variant of callLLM — pushes token deltas back over a Port so the
 * UI can render the answer as it arrives. Supports OpenAI-compatible SSE
 * (OpenRouter/OpenAI) and Anthropic's event stream.
 */
async function streamLLM(req, port) {
  req = normalizeLLMRequest(req);
  const cfg = await getAIConfig();
  let provider = req.provider || cfg.provider;
  // Same key-based provider fallback as callLLM — stream with whichever
  // provider actually has a key configured.
  if (!cfg.keys[provider]) {
    const alt = ['openrouter', 'openai', 'anthropic'].find((p) => cfg.keys[p]);
    if (alt) provider = alt;
  }
  const model = UNLLMRequest.resolveModel(provider, req.model || cfg.model);
  const key = cfg.keys[provider];
  if (!key) {
    port.postMessage({ error: 'no_key', provider });
    return;
  }
  const anthropic = provider === 'anthropic';
  // Idle timeout: a hung SSE connection would otherwise never resolve and the
  // panel would spin forever. Re-armed on every chunk so long answers still work.
  const controller = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 30000);
  };
  const onPortGone = () => controller.abort();
  port.onDisconnect.addListener(onPortGone);
  armIdle();
  try {
    // Endpoint + body shape (system folding, OpenAI max_completion_tokens) are
    // built and unit-tested in shared/llm-request.js.
    const endpoint = UNLLMRequest.llmEndpoint(provider);
    const headers = anthropic
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' }
      : { Authorization: 'Bearer ' + key, 'content-type': 'application/json' };
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/Phaenex/unsynth';
      headers['X-Title'] = 'Unsynth';
    }
    const body = JSON.stringify(UNLLMRequest.buildLLMBody({ provider, model, maxTokens: req.max_tokens, system: req.system, messages: req.messages, stream: true }));
    const r = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
    if (!r.ok || !r.body) {
      const errText = await r.text().catch(() => '');
      port.postMessage({ error: 'api_error', status: r.status, message: errText.slice(0, 240) });
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const { value, done } = await reader.read();
      armIdle();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          let delta = '';
          if (anthropic) {
            if (j.type === 'content_block_delta' && j.delta && j.delta.text) delta = j.delta.text;
          } else if (j.choices && j.choices[0] && j.choices[0].delta) {
            delta = j.choices[0].delta.content || '';
          }
          if (delta) {
            full += delta;
            port.postMessage({ delta });
          }
        } catch (e) {
          /* ignore a partial/non-JSON SSE line */
        }
      }
    }
    port.postMessage({ done: true, content: full });
  } catch (e) {
    try {
      port.postMessage({ error: 'network_error', message: String(e) });
    } catch (e2) {
      /* port already disconnected */
    }
  } finally {
    clearTimeout(idleTimer);
    port.onDisconnect.removeListener(onPortGone);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-stream') return;
  port.onMessage.addListener((msg) => {
    if (!isTrustedSender(port.sender)) {
      port.postMessage({ error: 'forbidden' });
      return;
    }
    if (msg && msg.type === 'stream') streamLLM(msg, port);
  });
});

/** True for YouTube tabs and our own extension pages. Rejects youtube.com.evil.com. */
// Single source of truth for "what counts as a YouTube tab" — was duplicated
// 3x (one copy inconsistently scoped to www.youtube.com only, missing e.g.
// m.youtube.com), which the cross-tab playback broadcast needs to not miss.
const YT_TAB_PATTERNS = ['*://*.youtube.com/*', '*://music.youtube.com/*'];

function isYouTubeHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'music.youtube.com';
}

function comparableOrigin(url) {
  const parsed = new URL(url);
  return parsed.origin === 'null' ? parsed.protocol + '//' + parsed.host : parsed.origin;
}

function isTrustedSender(sender) {
  if (!sender) return false;
  const url = (sender.tab && sender.tab.url) || sender.url || '';
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const extensionOrigin = comparableOrigin(chrome.runtime.getURL('/'));
    return comparableOrigin(parsed.href) === extensionOrigin || isYouTubeHost(parsed.hostname);
  } catch (e) {
    return false;
  }
}

function isForgeSender(sender) {
  if (!sender) return false;
  const url = (sender.tab && sender.tab.url) || sender.url || '';
  try {
    return new URL(url).origin === 'https://playlist-forge.vercel.app';
  } catch (e) {
    return false;
  }
}

// Features the watch guide can switch on in place (UNSYNTH/GUIDE/ENABLE_MODULE).
// Kept in step with FEATURES in src/shared/watch-deck.js by test/guide-more-tools.test.js.
const GUIDE_MODULE_KEYS = new Set(['sponsorBlock', 'dislikeRestore', 'analytics', 'factCheck', 'aiAssistant', 'forgeLink', 'descDigest']);

const FORGE_PAGE_MESSAGE_TYPES = new Set([
  UNMSG.AUTH_STATUS,
  UNMSG.YT_PLAYLISTS_MINE,
  UNMSG.YT_PLAYLIST_ITEMS,
  UNMSG.YT_PLAYLIST_ADD,
  UNMSG.YT_PLAYLIST_CREATE,
  UNMSG.YT_PLAYLIST_REMOVE,
  UNMSG.YT_PLAYLIST_RENAME,
  UNMSG.YT_PLAYLIST_REORDER
]);

function isExtensionSender(sender) {
  if (!sender || !sender.url) return false;
  try {
    return comparableOrigin(sender.url) === comparableOrigin(chrome.runtime.getURL('/'));
  } catch (e) {
    return false;
  }
}

/** Config / secret / sync-delete ops must come from extension pages, not youtube.com tabs. */
const EXT_ONLY_MESSAGE_TYPES = new Set([
  UNMSG.OAUTH_SET_CONFIG,
  UNMSG.AI_CONFIG_SET,
  UNMSG.PROFILE_APPLY,
  UNMSG.SYNC_DELETE,
  UNMSG.UPDATE_CHECK,
  UNMSG.UPDATE_FETCH,
  // SIGNING OUT DESTROYS CREDENTIALS, SO IT BELONGS HERE.
  //
  // AUTH_SIGNOUT is the ONLY handler that removes auth_tokens — it is the
  // single code path by which this extension can disconnect a YouTube account.
  // It was guarded by isTrustedSender(), which deliberately accepts any
  // youtube.com page as well as extension pages, so any content script could
  // have erased the user's tokens with one message.
  //
  // Nothing sends it from a content script today: the only caller is the
  // dashboard's Sign out button (dashboard-account.js), behind an explicit
  // click. So this was latent rather than active, and no evidence says it
  // caused the reported disconnection.
  //
  // It is being closed now because the unified panel changes the risk: that
  // panel runs IN a youtube.com content script and owns auth-adjacent UI, which
  // turns "no content script happens to send this" into a property that could
  // be broken by an ordinary mistake in new code. A credential-destroying
  // operation should not rely on nobody calling it.
  //
  // The dashboard is an extension page, so the real sign-out path is unaffected.
  UNMSG.AUTH_SIGNOUT
]);

// ---- message router ----
// ---- Offscreen document (update ZIP) ----
// The updater pulls the release ZIP through an offscreen document, which hashes
// the bytes against the published sha256 before handing back a blob: URL. The
// SW can't createObjectURL itself. Video downloading was removed on purpose
// (tag archive/with-video-downloader); this path only serves our release host.
let offscreenReady = null;
async function ensureOffscreenDoc() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctxs && ctxs.length) return true;
      // Doc gone but SW still alive — drop the stale resolved promise so we recreate.
      offscreenReady = null;
    }
    if (!offscreenReady) {
      offscreenReady = chrome.offscreen
        .createDocument({
          url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
          reasons: ['BLOBS'],
          justification: 'Verify the Unsynth update ZIP against its published checksum before saving it.'
        })
        .catch((e) => {
          // Racing/"only one offscreen document" errors are fine — it exists.
          if (!/single offscreen|already/i.test(String(e && e.message))) throw e;
        });
    }
    await offscreenReady;
    return true;
  } catch (e) {
    offscreenReady = null;
    return false;
  }
}

function askOffscreen(payload, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'offscreen_timeout' }), timeoutMs || 30000);
    try {
      chrome.runtime.sendMessage(Object.assign({ target: 'offscreen-download' }, payload), (res) => {
        if (chrome.runtime.lastError) { done({ ok: false, error: chrome.runtime.lastError.message }); return; }
        done(res || { ok: false, error: 'no_response' });
      });
    } catch (e) {
      done({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

function onMessage(msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;
  const forgeSender = isForgeSender(sender);
  if ((!isTrustedSender(sender) && !forgeSender) || (forgeSender && !FORGE_PAGE_MESSAGE_TYPES.has(msg.type))) {
    try { sendResponse({ ok: false, error: 'forbidden' }); } catch (e) { /* sender already gone */ }
    return false;
  }
  if (EXT_ONLY_MESSAGE_TYPES.has(msg.type) && !isExtensionSender(sender)) {
    try { sendResponse({ ok: false, error: 'forbidden' }); } catch (e) { /* sender already gone */ }
    return false;
  }
  (async () => {
    try {
      switch (msg.type) {
        case UNMSG.OAUTH_SET_CONFIG:
          await UNStore.setLocal('oauth_client_id', msg.clientId || '');
          await UNStore.setLocal('oauth_client_secret', msg.clientSecret || '');
          return sendResponse({ ok: true });

        case UNMSG.OAUTH_GET_CONFIG: {
          const cfg = await getOAuthConfig();
          const local = await loadLocalOAuth();
          return sendResponse({
            ok: true,
            clientId: cfg.clientId,
            hasSecret: !!cfg.clientSecret,
            redirectUri: redirectUri(),
            devSeed: !!(local && local.clientId && local.clientSecret)
          });
        }

        case UNMSG.AUTH_START: {
          const res = await startAuth(msg.scopes);
          return sendResponse({ ok: true, ...res });
        }

        case UNMSG.AUTH_STATUS:
          return sendResponse({ ok: true, ...(await authStatus()) });

        case UNMSG.AUTH_SIGNOUT:
          await UNStore.removeLocal('auth_tokens');
          await UNStore.removeLocal('yt_channel_mine');
          return sendResponse({ ok: true });

        case UNMSG.YT_CHANNELS_MINE: {
          const cached = await UNStore.getLocal('yt_channel_mine', null);
          try {
            const token = await getAccessToken();
            let data = await UNApi.call({
              path: 'channels',
              params: { part: 'snippet,statistics', mine: 'true' },
              accessToken: token,
              ttlMs: 6 * 3600 * 1000
            });
            if (!(data.items && data.items[0])) {
              data = await UNApi.call({
                path: 'channels',
                params: { part: 'snippet,statistics', managedByMe: 'true' },
                accessToken: token,
                ttlMs: 6 * 3600 * 1000
              });
            }
            const channel = (data.items && data.items[0]) || null;
            if (channel) await UNStore.setLocal('yt_channel_mine', { channel, savedAt: Date.now() });
            return sendResponse({ ok: true, channel: channel || (cached && cached.channel) || null, stale: !channel && !!(cached && cached.channel) });
          } catch (e) {
            const detail = (e && e.detail) || '';
            const quota = (e && e.code === 'yt_quota') || (e && e.message === 'yt_quota') || (e && e.code === 'quota_exceeded') || /quota/i.test((e && e.message) || '') || /quota/i.test(detail);
            return sendResponse({
              ok: false,
              error: quota ? 'quota' : (e && e.message) || String(e),
              channel: (cached && cached.channel) || null,
              stale: !!(cached && cached.channel)
            });
          }
        }

        case UNMSG.YT_CHANNEL_NAMES: {
          const ids = (msg.ids || []).filter(Boolean);
          if (!ids.length) return sendResponse({ ok: true, names: {}, thumbs: {} });
          const names = {};
          const thumbs = {};
          const handles = {};
          let apiError = null;
          try {
            const token = await getAccessToken();
            for (let i = 0; i < ids.length; i += 50) {
              const batch = ids.slice(i, i + 50);
              const data = await UNApi.call({
                path: 'channels',
                params: { part: 'snippet', id: batch.join(','), maxResults: '50' },
                accessToken: token,
                ttlMs: 24 * 3600 * 1000
              });
              (data.items || []).forEach((c) => {
                const sn = c.snippet || {};
                names[c.id] = sn.title;
                const th = (sn.thumbnails && (sn.thumbnails.default || sn.thumbnails.medium)) || {};
                if (th.url) thumbs[c.id] = th.url;
                const cu = sn.customUrl || '';
                if (cu) handles[c.id] = cu;
              });
            }
          } catch (e) {
            apiError = (e && e.message) || String(e);
          }
          const missing = ids.filter((id) => id && !names[id]);
          if (missing.length && UNChannelScrape && UNChannelScrape.scrapeChannelNames) {
            const scraped = await UNChannelScrape.scrapeChannelNames(missing, { batch: 8 });
            Object.assign(names, scraped.names || {});
            Object.assign(thumbs, scraped.thumbs || {});
          }
          const ok = Object.keys(names).length > 0;
          return sendResponse({
            ok,
            names,
            thumbs,
            handles,
            error: ok ? null : apiError || 'no_names'
          });
        }

        case UNMSG.YT_SUBSCRIPTIONS_MINE: {
          const clean = await fetchMySubscriptions();
          return sendResponse({ ok: true, subs: clean });
        }

        case UNMSG.SUBS_CACHE_REFRESH:
          return sendResponse(await refreshSubscribedChannelCache());

        case UNMSG.SUBS_CACHE_MERGE: {
          const incoming = (msg.keys || []).filter(Boolean);
          const merged = await withSubscribedCacheLock(async () => {
            const prev = await UNStore.getLocal('subscribedChannelCache', { keys: [], names: [] });
            const next = UNSubGroups.mergeSubscribedKeys(prev, incoming);
            await UNStore.setLocal('subscribedChannelCache', next);
            return next;
          });
          await UNStore.setLocal('subscribedChannelsGuideMerged', Date.now());
          return sendResponse({ ok: true, count: merged.keys.length });
        }

        case UNMSG.YT_PLAYLISTS_MINE: {
          const token = await getAccessToken();
          const out = [];
          let pageToken = '';
          const listTtl = msg.fresh ? 0 : 5 * 60 * 1000;
          for (let i = 0; i < 10; i++) {
            const data = await UNApi.call({
              path: 'playlists',
              params: Object.assign({ part: 'snippet,contentDetails', mine: 'true', maxResults: '50' }, pageToken ? { pageToken } : {}),
              accessToken: token,
              ttlMs: listTtl
            });
            (data.items || []).forEach((pl) => {
              const th = (pl.snippet.thumbnails && (pl.snippet.thumbnails.medium || pl.snippet.thumbnails.default)) || {};
              out.push({
                id: pl.id,
                title: pl.snippet.title,
                count: (pl.contentDetails && pl.contentDetails.itemCount) || 0,
                thumb: th.url || ''
              });
            });
            pageToken = data.nextPageToken || '';
            if (!pageToken) break;
          }
          let related = {};
          try {
            const ch = await UNApi.call({
              path: 'channels',
              params: { part: 'contentDetails', mine: 'true' },
              accessToken: token,
              ttlMs: msg.fresh ? 0 : 24 * 3600 * 1000
            });
            const rp = (ch.items && ch.items[0] && ch.items[0].contentDetails && ch.items[0].contentDetails.relatedPlaylists) || {};
            related = { watchLater: rp.watchLater || '', likes: rp.likes || '' };
            if (related.watchLater) await UNStore.setLocal('ytWatchLaterId', related.watchLater);
          } catch (e) {
            related = {};
          }
          const Lib = self.UNPlaylistLibrary;
          const merged = Lib ? Lib.orderPlaylists(Lib.mergeStandardPlaylists(out, related)) : out;
          return sendResponse({ ok: true, playlists: merged });
        }

        case UNMSG.YT_PLAYLIST_ITEMS: {
          const playlistId = String(msg.playlistId || '');
          if (!/^[A-Za-z0-9_-]{2,100}$/.test(playlistId)) return sendResponse({ ok: false, error: 'bad_playlist_id' });
          const token = await getAccessToken();
          const out = [];
          let pageToken = '';
          // YouTube playlists can contain up to 5,000 items. The old eight-page
          // ceiling silently chopped the organizer's view at 400 videos.
          for (let i = 0; i < 100; i++) {
            const data = await UNApi.call({
              path: 'playlistItems',
              params: Object.assign({ part: 'snippet,contentDetails', playlistId, maxResults: '50' }, pageToken ? { pageToken } : {}),
              accessToken: token,
              ttlMs: msg.fresh ? 0 : 60 * 1000
            });
            (data.items || []).forEach((it) => {
              const sn = it.snippet || {};
              const th = (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default)) || {};
              out.push({
                itemId: it.id,
                videoId: (sn.resourceId && sn.resourceId.videoId) || '',
                title: sn.title || '',
                thumb: th.url || '',
                channel: sn.videoOwnerChannelTitle || '',
                position: Number.isInteger(sn.position) ? sn.position : out.length
              });
            });
            pageToken = data.nextPageToken || '';
            if (!pageToken) break;
          }
          return sendResponse({ ok: true, items: out });
        }

        case UNMSG.YT_VIDEO_DURATIONS: {
          /**
           * Duration for a set of video ids.
           *
           * WHY THIS EXISTS SEPARATELY FROM YT_PLAYLIST_ITEMS
           * playlistItems.list with part=contentDetails returns
           * `videoPublishedAt` and nothing else useful — there is no duration on
           * a playlist item at all. So every feature that wants to budget time
           * over a playlist ("I have 90 minutes", "this playlist is 312 hours")
           * silently had nothing to work with.
           *
           * videos.list takes 50 ids per call at 1 quota unit, so a
           * 2,445-video playlist costs 49 units — about 0.5% of a day. And
           * durations never change, so the cache below is permanent rather than
           * TTL'd: only ids we have never seen cost anything.
           */
          const ids = Array.isArray(msg.videoIds) ? msg.videoIds.filter(Boolean) : [];
          if (!ids.length) return sendResponse({ ok: true, durations: {}, fetched: 0, cached: 0 });

          const CACHE_KEY = 'ytVideoDurations';
          const store = (await UNStore.getLocal(CACHE_KEY, null)) || {};
          const out = {};
          const missing = [];
          ids.forEach((id) => {
            const v = store[id];
            if (typeof v === 'number' && isFinite(v) && v > 0) out[id] = v;
            else missing.push(id);
          });

          if (missing.length) {
            const token = await getAccessToken();
            // 50 is the API's hard per-call limit, not a tuning choice.
            for (let i = 0; i < missing.length; i += 50) {
              const batch = missing.slice(i, i + 50);
              const data = await UNApi.call({
                path: 'videos',
                params: { part: 'contentDetails', id: batch.join(','), maxResults: '50' },
                accessToken: token,
                ttlMs: 0
              });
              (data.items || []).forEach((it) => {
                const iso = it.contentDetails && it.contentDetails.duration;
                const secs = parseIsoDuration(iso);
                if (secs > 0) {
                  out[it.id] = secs;
                  store[it.id] = secs;
                }
              });
            }
            await UNStore.setLocal(CACHE_KEY, store);
          }

          return sendResponse({
            ok: true,
            durations: out,
            fetched: missing.length,
            cached: ids.length - missing.length
          });
        }

        case UNMSG.YT_VIDEO_PLAYLISTS: {
          // Which of these playlists already contain the video? playlistItems.list
          // with a videoId filter is 1 quota unit each, so this is cheap. Bounded
          // concurrency + a cap so a huge playlist count can't stall the picker.
          const token = await getAccessToken();
          const vid = msg.videoId;
          // 40 was too low for a real library: anything past the cap was never
          // checked, so playlists the video WAS in silently failed to float to
          // the top. Each check is 1 quota unit and they run 6-wide, so 200 is
          // still fast and cheap.
          const ids = (msg.playlistIds || []).filter(Boolean).slice(0, 200);
          if (!vid || !ids.length) return sendResponse({ ok: true, inIds: [] });
          const inIds = [];
          const itemIds = {}; // playlistId -> playlistItem id, for removal
          const CONC = 6;
          for (let i = 0; i < ids.length; i += CONC) {
            const batch = ids.slice(i, i + CONC);
            const res = await Promise.all(
              batch.map(async (plId) => {
                try {
                  const data = await UNApi.call({
                    path: 'playlistItems',
                    params: { part: 'id', playlistId: plId, videoId: vid, maxResults: '1' },
                    accessToken: token,
                    ttlMs: 30 * 1000
                  });
                  // Return the playlistItem id alongside the playlist id.
                  // Removal needs the ITEM id, and this response already
                  // carries it — without passing it back, a caller that knows
                  // the video is in a playlist still has to re-query before it
                  // can offer to take it out.
                  return data.items && data.items.length
                    ? { plId: plId, itemId: data.items[0].id }
                    : null;
                } catch (e) {
                  return null;
                }
              })
            );
            res.forEach((r) => {
              if (r) {
                inIds.push(r.plId);
                itemIds[r.plId] = r.itemId;
              }
            });
          }
          return sendResponse({ ok: true, inIds, itemIds });
        }

        case UNMSG.YT_PLAYLIST_ADD: {
          const token = await getAccessToken();
          let targetPlId = msg.playlistId;
          if (targetPlId === 'WL' || targetPlId === 'watchlater') {
            let wlId = await UNStore.getLocal('ytWatchLaterId', '');
            if (!wlId) {
              const ch = await UNApi.call({
                path: 'channels',
                params: { part: 'contentDetails', mine: 'true' },
                accessToken: token,
                ttlMs: 24 * 3600 * 1000
              });
              wlId = (ch.items && ch.items[0] && ch.items[0].contentDetails && ch.items[0].contentDetails.relatedPlaylists && ch.items[0].contentDetails.relatedPlaylists.watchLater) || '';
              if (wlId) await UNStore.setLocal('ytWatchLaterId', wlId);
            }
            if (wlId) targetPlId = wlId;
          }
          const ids = (msg.videoIds || []).filter(Boolean);
          const result = await addVideosToPlaylist(token, targetPlId, ids);
          if (!result.added && result.authExpired) return sendResponse({ ok: false, error: 'auth_expired' });
          // Most specific first: a readonly token adds nothing, and
          // 'needs_write_scope' tells the UI to ask for permission rather than
          // showing a generic failure. Below it, main's broader guard — a total
          // add failure must not report ok, because "Move" adds first and then
          // deletes the originals, and treating a failed add as success would
          // delete the source rows and lose the videos from both playlists.
          if (!result.added && result.needsWriteScope) {
            return sendResponse({ ok: false, error: 'needs_write_scope' });
          }
          if (!result.added && ids.length) {
            return sendResponse({ ok: false, error: 'add_failed', added: 0, failed: result.failed });
          }
          return sendResponse({
            ok: true,
            added: result.added,
            failed: result.failed,
            needsWriteScope: !!result.needsWriteScope
          });
        }

        case UNMSG.YT_WATCH_LATER_ADD: {
          const token = await getAccessToken();
          let wlId = await UNStore.getLocal('ytWatchLaterId', '');
          if (!wlId) {
            const ch = await UNApi.call({
              path: 'channels',
              params: { part: 'contentDetails', mine: 'true' },
              accessToken: token,
              ttlMs: 24 * 3600 * 1000
            });
            wlId = (ch.items && ch.items[0] && ch.items[0].contentDetails && ch.items[0].contentDetails.relatedPlaylists && ch.items[0].contentDetails.relatedPlaylists.watchLater) || '';
            if (wlId) await UNStore.setLocal('ytWatchLaterId', wlId);
          }
          if (!wlId) return sendResponse({ ok: false, error: 'no_watch_later' });
          const ids = (msg.videoIds || []).filter(Boolean);
          const result = await addVideosToPlaylist(token, wlId, ids);
          if (!result.added && result.authExpired) return sendResponse({ ok: false, error: 'auth_expired' });
          if (!result.added && result.needsWriteScope) {
            return sendResponse({ ok: false, error: 'needs_write_scope' });
          }
          return sendResponse({
            ok: true,
            added: result.added,
            failed: result.failed,
            playlistId: wlId,
            needsWriteScope: !!result.needsWriteScope
          });
        }

        case UNMSG.YT_PLAYLIST_CREATE:
          return sendResponse(await createYouTubePlaylist(msg, null));

        case UNMSG.RYD_VOTES:
          return sendResponse(await fetchRydVotes(msg.videoId));

        case UNMSG.YT_PLAYLIST_REMOVE: {
          const token = await getAccessToken();
          const ids = (msg.itemIds || []).filter(Boolean);
          const result = await removePlaylistItems(token, ids);
          if (!result.removed && result.authExpired) return sendResponse({ ok: false, error: 'auth_expired' });
          if (!result.removed && result.needsWriteScope) {
            return sendResponse({ ok: false, error: 'needs_write_scope' });
          }
          // Report a total failure as a failure. This used to return ok:true with
          // removed:0, so a caller checking only `ok` announced a successful move
          // while every delete had 404'd (usually stale playlistItem ids) and the
          // videos were still sitting in the source playlist.
          if (!result.removed && ids.length) {
            return sendResponse({ ok: false, error: 'remove_failed', removed: 0, failed: result.failed });
          }
          return sendResponse({
            ok: true,
            removed: result.removed,
            failed: result.failed,
            needsWriteScope: !!result.needsWriteScope
          });
        }

        case UNMSG.YT_PLAYLIST_RENAME: {
          const token = await getAccessToken();
          const playlistId = String(msg.playlistId || '');
          const title = String(msg.title || '').trim().slice(0, 150);
          if (!/^[A-Za-z0-9_-]{2,100}$/.test(playlistId) || !title) {
            return sendResponse({ ok: false, error: 'bad_playlist_update' });
          }
          const body = { id: playlistId, snippet: { title } };
          let part = 'snippet';
          if (['public', 'private', 'unlisted'].indexOf(msg.privacy) !== -1) {
            body.status = { privacyStatus: msg.privacy };
            part += ',status';
          }
          const r = await fetch('https://www.googleapis.com/youtube/v3/playlists?part=' + encodeURIComponent(part), {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!r.ok) return sendResponse({ ok: false, error: r.status === 401 ? 'auth_expired' : 'rename_failed' });
          return sendResponse({ ok: true, action: 'rename', title });
        }

        case UNMSG.YT_PLAYLIST_REORDER: {
          const token = await getAccessToken();
          const itemId = String(msg.itemId || '');
          const playlistId = String(msg.playlistId || '');
          const videoId = String(msg.videoId || '');
          const position = Number(msg.position);
          if (!itemId || !/^[A-Za-z0-9_-]{2,100}$/.test(playlistId) || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || !Number.isInteger(position) || position < 0) {
            return sendResponse({ ok: false, error: 'bad_playlist_reorder' });
          }
          const r = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify({ id: itemId, snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId }, position } })
          });
          if (!r.ok) return sendResponse({ ok: false, error: r.status === 401 ? 'auth_expired' : 'reorder_failed' });
          return sendResponse({ ok: true, action: 'reorder', position });
        }

        case UNMSG.QUOTA_GET:
          return sendResponse({ ok: true, quota: await UNStore.quotaToday(), cap: UNApi.QUOTA_CAP });

        case UNMSG.AI_CONFIG_SET: {
          // Only our own extension pages (dashboard/popup) may write AI config or
          // keys — never a content script injected into a web page.
          if (!sender.url || !isTrustedSender({ url: sender.url }) ||
              comparableOrigin(sender.url) !== comparableOrigin(chrome.runtime.getURL('/'))) {
            return sendResponse({ ok: false, error: 'forbidden' });
          }
          const cur = await getAIConfig();
          const providers = ['openrouter', 'openai', 'anthropic'];
          const provider = providers.indexOf(msg.provider) >= 0 ? msg.provider : cur.provider;
          const incomingKeys = msg.keys && typeof msg.keys === 'object' ? msg.keys : {};
          const keys = Object.assign({}, cur.keys);
          providers.forEach((name) => {
            if (Object.prototype.hasOwnProperty.call(incomingKeys, name)) {
              keys[name] = String(incomingKeys[name] || '').slice(0, 5000);
            }
          });
          const next = {
            provider,
            model: msg.model !== undefined ? String(msg.model || '').slice(0, 160) : cur.model,
            keys
          };
          // AI provider hosts are optional_host_permissions — request at first key save.
          const needsAiHost =
            !!(keys.openrouter || keys.openai || keys.anthropic);
          if (needsAiHost && chrome.permissions && chrome.permissions.request) {
            try {
              await chrome.permissions.request({
                origins: [
                  'https://openrouter.ai/*',
                  'https://api.openai.com/*',
                  'https://api.anthropic.com/*'
                ]
              });
            } catch (e) {
              console.warn('[unsynth] AI host permission request failed', (e && e.message) || e);
            }
          }
          await UNStore.setLocal('ai_config', next);
          return sendResponse({ ok: true });
        }

        case UNMSG.AI_CONFIG_GET: {
          const cfg = await getAIConfig();
          // Never return raw keys to the UI — only which providers have one.
          return sendResponse({
            ok: true,
            provider: cfg.provider,
            model: cfg.model,
            hasKey: {
              openrouter: !!cfg.keys.openrouter,
              openai: !!cfg.keys.openai,
              anthropic: !!cfg.keys.anthropic
            }
          });
        }

        case UNMSG.AI_LLM: {
          // Only honor LLM requests from a youtube.com tab or our own pages.
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          return sendResponse(await callLLM(msg));
        }

        case UNMSG.FORGE_FETCH: {
          // Content scripts can't fetch playlist-forge.vercel.app directly (CORS).
          // Proxy through the worker, which has the host permission. Locked to that
          // single host (path must start with '/') and to our own callers.
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          // The trailing group allows a query string. Without it this rejected
          // /api/transcript?videoId=<id>, which is the AI assistant's only
          // working transcript source (the Innertube API 400s, the panel scrape
          // yields 0 segments, and json3 returns an empty body behind YouTube's
          // PO-token gate). Every call failed as `bad_path` before leaving the
          // browser, and fetchViaBackend reports a failure as null — so it read
          // as "the backend has no transcript" while the backend was healthy.
          //
          // The charset stays deliberately narrow rather than [^#]*: a dot-dot
          // traversal, an angle bracket or a raw space must still be rejected
          // after the '?', not just before it. See test/forge-fetch-path.test.js.
          if (typeof msg.path !== 'string' || msg.path.length > 300 ||
              !/^\/api\/[a-z0-9/_-]+(?:\?(?:[a-z0-9_\-.=&]|%[0-9a-f]{2})*)?$/i.test(msg.path) ||
              msg.path.indexOf('..') >= 0 ||
              /%(?:2e|00|2f|5c)/i.test(msg.path)) {
            return sendResponse({ ok: false, error: 'bad_path' });
          }
          const method = String(msg.method || 'GET').toUpperCase();
          if (method !== 'GET' && method !== 'POST') return sendResponse({ ok: false, error: 'bad_method' });
          try {
            const init = { method, headers: {} };
            if (msg.body != null) {
              init.headers['content-type'] = 'application/json';
              init.body = JSON.stringify(msg.body);
              if (init.body.length > 500000) return sendResponse({ ok: false, error: 'body_too_large' });
            }
            const r = await fetchWithTimeout('https://playlist-forge.vercel.app' + msg.path, init, 9000);
            let data = null;
            try { data = await r.json(); } catch (e) { /* non-JSON body */ }
            return sendResponse({ ok: r.ok, status: r.status, data });
          } catch (e) {
            return sendResponse({ ok: false, status: 0, error: String(e) });
          }
        }

        case UNMSG.PROXY_FETCH: {
          // Generic SW proxy for a small host allowlist — content-script fetches
          // to these get CORS-blocked (sponsor.ajay.app drops its CORS header on
          // error responses). The worker isn't subject to page CORS.
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          let target;
          try { target = new URL(String(msg.url || '')); } catch (e) { return sendResponse({ ok: false, error: 'bad_url' }); }
          if (target.protocol !== 'https:' || target.href.length > 3000) return sendResponse({ ok: false, error: 'bad_url' });
          if (target.hostname !== 'sponsor.ajay.app' && target.hostname !== 'playlist-forge.vercel.app') {
            return sendResponse({ ok: false, error: 'forbidden_host' });
          }
          const method = String(msg.method || 'GET').toUpperCase();
          if (method !== 'GET' && method !== 'POST') return sendResponse({ ok: false, error: 'bad_method' });
          try {
            const init = { method };
            // Allow a JSON body for POST (e.g. submitting a SponsorBlock segment).
            if (msg.body != null) {
              init.body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body);
              if (init.body.length > 500000) return sendResponse({ ok: false, error: 'body_too_large' });
              init.headers = { 'Content-Type': 'application/json' };
            }
            const r = await fetchWithTimeout(target.href, init, 9000);
            let data = null;
            let text = '';
            try {
              text = await r.text();
              data = text ? JSON.parse(text) : null;
            } catch (e) {
              /* non-JSON body — keep raw text for error messages */
            }
            return sendResponse({ ok: r.ok, status: r.status, data, text: data == null ? text.slice(0, 300) : '' });
          } catch (e) {
            return sendResponse({ ok: false, status: 0, error: String(e) });
          }
        }

        case UNMSG.AISLIST_SYNC: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const data = await syncAisList();
          return sendResponse({ ok: true, count: data.count, updated: data.updated });
        }

        case UNMSG.AISLIST_GET: {
          const d = await UNStore.getLocal('aislist', null);
          return sendResponse({ ok: true, count: (d && d.count) || 0, updated: (d && d.updated) || 0 });
        }

        // Drive YouTube's player quality from the MAIN world on the caller's
        // own tab.
        //
        // Why this has to round-trip through the service worker at all:
        // content scripts run in an ISOLATED world, and YouTube attaches its
        // player API (setPlaybackQualityRange / setPlaybackQuality /
        // getPlaybackQuality) to #movie_player as plain JS expando properties
        // set by PAGE script. Expandos do not cross the isolated-world
        // boundary — the content script gets the same DOM element with none of
        // those methods, and no amount of waiting changes that. Measured live
        // on a 4K watch page: the main world had
        // `typeof setPlaybackQualityRange === 'function'` while the extension's
        // own world reported it undefined on every poll for 20s. So quality
        // lock silently did nothing on every real page. chrome.scripting with
        // world:'MAIN' is the only way to reach the real methods, and only the
        // SW can call it.
        case UNMSG.PLAYER_SET_QUALITY: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const tabId = sender && sender.tab && sender.tab.id;
          if (!tabId) return sendResponse({ ok: false, error: 'no tab' });
          const min = String((msg && msg.min) || '');
          const max = String((msg && msg.max) || '');
          if (!min || !max) return sendResponse({ ok: false, error: 'bad args' });
          try {
            const [res] = await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              // args, never string interpolation — this runs in the page's own
              // world, so a template-built function body would be a genuine
              // injection sink for anything that ever reaches these values.
              // `skipIfAtLeast` is the ordered quality list the caller ranks
              // by. Passing it lets the "already compliant, don't re-set"
              // check run HERE, where getPlaybackQuality() is actually
              // readable — the content script cannot read it at all, so doing
              // the check there would need a full round-trip before every
              // first call and would re-buffer on page load every time.
              args: [min, max, (msg && Array.isArray(msg.levels) ? msg.levels : [])],
              func: (minQ, maxQ, levels) => {
                const el = document.getElementById('movie_player');
                if (!el || typeof el.setPlaybackQualityRange !== 'function') return { ok: false, error: 'no player' };
                let current = null;
                try {
                  current = typeof el.getPlaybackQuality === 'function' ? el.getPlaybackQuality() : null;
                } catch (e) {
                  /* reading the current level is best effort */
                }
                // Lower index = higher resolution. Already at or above target
                // means re-setting the range would only cause a rebuffer.
                if (levels && levels.length && current) {
                  const curIdx = levels.indexOf(current);
                  const tgtIdx = levels.indexOf(minQ);
                  if (curIdx >= 0 && tgtIdx >= 0 && curIdx <= tgtIdx) {
                    return { ok: true, current, skipped: true };
                  }
                }
                try {
                  el.setPlaybackQualityRange(minQ, maxQ);
                  // Older player builds honour only the legacy single-quality
                  // setter; calling both is what the in-world code always did.
                  if (typeof el.setPlaybackQuality === 'function') el.setPlaybackQuality(minQ);
                } catch (e) {
                  return { ok: false, error: String(e) };
                }
                return { ok: true, current, skipped: false };
              }
            });
            const out = (res && res.result) || { ok: false, error: 'no result' };
            return sendResponse(out);
          } catch (e) {
            return sendResponse({ ok: false, error: String(e) });
          }
        }

        case UNMSG.RELOAD_YOUTUBE_TABS:
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          await reloadYouTubeTabs();
          return sendResponse({ ok: true });

        // Serialized stats increment — prevents read-modify-write races across concurrent tabs.
        case 'UNSYNTH/STATS/INCR': {
          const delta = Number(msg.delta) || 0;
          if (delta <= 0) return sendResponse({ ok: true });
          
          if (!self._statsChain) self._statsChain = Promise.resolve();
          const statsOp = self._statsChain.then(async () => {
            const cur = await new Promise((resolve) => chrome.storage.sync.get({ stats: { hidden: 0 } }, resolve));
            const stats = cur.stats || { hidden: 0 };
            stats.hidden = (stats.hidden || 0) + delta;
            await new Promise((resolve, reject) =>
              chrome.storage.sync.set({ stats }, () => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve();
              })
            );
            return stats.hidden;
          });
          // Keep the chain alive even when this op rejects (e.g. sync quota) —
          // otherwise one failure would poison every later increment.
          self._statsChain = statsOp.catch(() => {});
          const hidden = await statsOp;
          return sendResponse({ ok: true, hidden });
        }

        // Cross-tab single-playback enforcement. Never caches who's
        // playing — every VIDEO_PLAYING triggers a fresh tabs.query() + a
        // fresh live PLAYBACK_QUERY to each candidate tab, matching this
        // file's own no-memory-caching design (service workers can be killed
        // at any time, so a stale in-memory "who's playing" registry would be
        // wrong as often as it's right).
        case UNMSG.VIDEO_PLAYING: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const tabId = sender && sender.tab && sender.tab.id;
          if (!tabId) return sendResponse({ ok: false });
          self._playbackGeneration = (self._playbackGeneration || 0) + 1;
          const generation = self._playbackGeneration;
          let paused = 0;

          const tabs = await chrome.tabs.query({ url: YT_TAB_PATTERNS });
          const others = tabs.filter((t) => t.id !== tabId);

          await Promise.all(
            others.map(async (t) => {
              let reply;
              try {
                reply = await chrome.tabs.sendMessage(t.id, { type: UNMSG.PLAYBACK_QUERY });
              } catch (e) {
                return; // content script not ready / tab isn't a real watch context — skip
              }
              if (!reply || !reply.playing) return;
              // A newer VIDEO_PLAYING event arrived while this query was in
              // flight. Let that newer tab win instead of both handlers
              // pausing each other during near-simultaneous starts.
              if (generation !== self._playbackGeneration) return;
              try {
                const pauseResult = await chrome.tabs.sendMessage(t.id, {
                  type: UNMSG.PLAYBACK_PAUSE
                });
                if (pauseResult && pauseResult.paused) paused++;
              } catch (e) {
                /* tab closed mid-flight */
              }
            })
          );
          return sendResponse({ ok: true, paused });
        }

        case UNMSG.PROFILE_APPLY: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const profileResult = await applySuiteProfile('update');
          return sendResponse(profileResult && profileResult.ok === false ? { ok: false, error: profileResult.reason } : { ok: true });
        }

        case UNMSG.TAB_RELOAD_STATUS: {
          const needsTabReload = await UNStore.getLocal('needsTabReload', false);
          const version = await UNStore.getLocal('lastExtensionVersion', '');
          return sendResponse({ ok: true, needsTabReload: !!needsTabReload, version: version || chrome.runtime.getManifest().version });
        }

        case UNMSG.PLAYLIST_NOTIFY: {
          const url = String(msg.url || '');
          const title = String(msg.title || 'Playlist created');
          const message = String(msg.message || 'Tap to open on YouTube');
          if (url) await UNStore.setLocal('lastPlaylistNotifyUrl', url);
          await chrome.notifications
            .create('unsynth-playlist-created', {
              type: 'basic',
              iconUrl: NOTIFY_ICON,
              title,
              message
            })
            .catch(() => {});
          return sendResponse({ ok: true });
        }

        case UNMSG.OPEN_URL: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const url = String(msg.url || '');
          if (!/^https:\/\//i.test(url)) return sendResponse({ ok: false, error: 'bad_url' });
          await chrome.tabs.create({ url, active: true });
          return sendResponse({ ok: true });
        }

        case UNMSG.POPOUT_OPEN: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const vid = String(msg.videoId || '').match(/^[\w-]{11}$/) ? msg.videoId : '';
          const list = String(msg.listId || '').replace(/[^\w-]/g, '');
          if (!vid && !list) return sendResponse({ ok: false, error: 'no_video' });
          const params = new URLSearchParams();
          if (list) params.set('list', list);
          else {
            params.set('v', vid);
            if (msg.time != null && msg.time > 0) params.set('t', String(Math.floor(msg.time)));
          }
          const popUrl = chrome.runtime.getURL('src/popout.html?' + params.toString());
          const w = Math.max(320, Math.min(1920, Number(msg.width) || 853));
          const h = Math.max(240, Math.min(1080, Number(msg.height) || 480));
          await chrome.windows.create({ url: popUrl, type: 'popup', width: w, height: h, focused: true });
          return sendResponse({ ok: true });
        }

        case UNMSG.VOL_BADGE: {
          const gain = Number(msg.gain);
          const tabId = sender && sender.tab && sender.tab.id;
          if (tabId && isFinite(gain)) {
            if (gain === 100) await chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
            else await chrome.action.setBadgeText({ text: String(gain), tabId }).catch(() => {});
            await chrome.action.setBadgeBackgroundColor({ color: gain > 100 ? '#2e7d32' : '#555', tabId }).catch(() => {});
          }
          return sendResponse({ ok: true });
        }

        case UNMSG.OPEN_FORGE_PANEL: {
          const tabName = String(msg.tab || 'suggest');
          const ytTabs = await chrome.tabs.query({ url: YT_TAB_PATTERNS });
          const payload = { type: UNMSG.OPEN_FORGE_PANEL, tab: tabName };
          for (const t of ytTabs) {
            try {
              await chrome.tabs.sendMessage(t.id, payload);
              await chrome.tabs.update(t.id, { active: true });
              if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
              return sendResponse({ ok: true, tabId: t.id });
            } catch (_) {
              /* content script not ready on this tab */
            }
          }
          const created = await chrome.tabs.create({ url: 'https://www.youtube.com/', active: true });
          const tryOpen = async (attempts) => {
            let lastErr = null;
            for (let i = 0; i < attempts; i++) {
              await new Promise((r) => setTimeout(r, 400 + i * 300));
              try {
                await chrome.tabs.sendMessage(created.id, payload);
                return { ok: true };
              } catch (e) {
                lastErr = (e && e.message) || String(e);
              }
            }
            return { ok: false, detail: lastErr || 'content_script_not_ready' };
          };
          const opened = await tryOpen(8);
          return sendResponse({
            ok: !!opened.ok,
            tabId: created.id,
            error: opened.ok ? null : 'panel_unreachable',
            detail: opened.ok ? null : opened.detail
          });
        }

        case UNMSG.OPEN_EXT_PAGE: {
          const rel = String(msg.path || '').replace(/^\/+/, '');
          if (!rel || rel.indexOf('..') >= 0) return sendResponse({ ok: false, error: 'bad_path' });
          const base = chrome.runtime.getURL(rel);
          const hash = msg.hash ? String(msg.hash).replace(/^#/, '') : '';
          const url = hash ? base + '#' + hash : base;
          const tabs = await chrome.tabs.query({ url: base + '*' });
          const existing = tabs && tabs[0];
          if (existing) {
            await chrome.tabs.update(existing.id, { active: true, url });
            if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
            return sendResponse({ ok: true, tabId: existing.id });
          }
          const tab = await chrome.tabs.create({ url, active: true });
          return sendResponse({ ok: true, tabId: tab.id });
        }

        // "Turn on" from the watch guide's More tools list (2026-09-24). Only
        // the features the guide offers can be switched on this way; the rest
        // of the modules map stays the settings screens' business.
        case UNMSG.GUIDE_ENABLE_MODULE: {
          const key = String(msg.key || '');
          if (!GUIDE_MODULE_KEYS.has(key)) return sendResponse({ ok: false, error: 'not_offered' });
          const tabId = sender && sender.tab && sender.tab.id;
          const base = (self.UNInjectionTable && self.UNInjectionTable.defaultModules) || {};
          const stored = await new Promise((resolve) => chrome.storage.sync.get({ modules: {} }, resolve));
          const before = Object.assign({}, base, stored.modules || {});
          const next = Object.assign({}, before, { [key]: true });
          await new Promise((resolve) => chrome.storage.sync.set({ modules: next }, resolve));
          await syncLazyModules();
          if (typeof tabId !== 'number' || !self.UNModuleInject) return sendResponse({ ok: true, injected: [], reload: true });
          const res = await self.UNModuleInject.injectModuleNow(tabId, key, before);
          // Stored as on either way: if the tab could not take it, the next
          // page load will. Say which, so the guide can tell the user.
          return sendResponse({ ok: res.ok, injected: res.injected, reload: !res.ok, error: res.error || null });
        }

        case UNMSG.UPDATE_CHECK: {
          const localVersion = chrome.runtime.getManifest().version;
          const pat = (msg.pat !== undefined ? msg.pat : await UNStore.getLocal('githubPat', '')) || '';
          const checkedAt = Date.now();
          await UNStore.setLocal('updateLastCheck', checkedAt);

          const fetched = await UNUpdateCheck.fetchLatestRelease(pat.trim());
          if (!fetched.ok) {
            clearUpdateBadge().catch(() => {});
            return sendResponse(Object.assign({ localVersion, checkedAt }, fetched));
          }

          const remoteVersion = fetched.remoteVersion;
          await UNStore.setLocal('updateRemoteVersion', remoteVersion);
          const status = UNSemver.isNewer(remoteVersion, localVersion) ? 'available' : 'up_to_date';
          if (status === 'available') {
            applyUpdateBadge(remoteVersion, localVersion).catch(() => {});
          } else {
            clearUpdateBadge().catch(() => {});
          }
          return sendResponse({
            ok: true,
            localVersion,
            remoteVersion,
            status,
            checkedAt,
            source: fetched.source || 'github',
            downloadUrl: fetched.downloadUrl || UNUpdateCheck.RELEASE_DOWNLOAD_URL,
            sha256: fetched.sha256 || ''
          });
        }

        case UNMSG.UPDATE_FETCH: {
          if (!isExtensionSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const pat = (await UNStore.getLocal('githubPat', '')) || '';
          const fetched = await UNUpdateCheck.fetchLatestRelease(pat.trim());
          if (!fetched.ok) return sendResponse(fetched);
          const expectedSha = fetched.sha256 || '';
          const saveArgs = { filename: 'unsynth-latest.zip', conflictAction: 'overwrite', saveAs: true };

          // Preferred path: pull the ZIP through the offscreen document, which
          // hashes the bytes and refuses to produce a blob URL unless they match
          // the published sha256. Saving first and checking never (the old
          // behaviour) meant a tampered archive reached Downloads indistinguishable
          // from a good one — and this file gets sideloaded as an extension.
          if (expectedSha && (await ensureOffscreenDoc())) {
            const got = await askOffscreen(
              { action: 'fetch', url: UNUpdateCheck.RELEASE_DOWNLOAD_URL, sha256: expectedSha },
              120000
            );
            if (got && got.ok && got.objUrl) {
              try {
                const downloadId = await chrome.downloads.download(Object.assign({ url: got.objUrl }, saveArgs));
                setTimeout(() => askOffscreen({ action: 'revoke', token: got.token }), 60 * 1000);
                return sendResponse({
                  ok: true,
                  downloadId,
                  remoteVersion: fetched.remoteVersion,
                  sha256: expectedSha,
                  verified: true
                });
              } catch (e) {
                askOffscreen({ action: 'revoke', token: got.token });
                return sendResponse({ ok: false, error: 'download_failed', message: (e && e.message) || String(e) });
              }
            }
            if (got && got.error === 'sha256_mismatch') {
              return sendResponse({
                ok: false,
                error: 'sha256_mismatch',
                message: 'Downloaded archive does not match the published checksum — nothing was saved.',
                expected: expectedSha,
                sha256: got.sha256 || ''
              });
            }
            // Any other offscreen failure (unsupported API, transient network)
            // falls through to the unverified path below, flagged as such.
          }

          try {
            const downloadId = await chrome.downloads.download(
              Object.assign({ url: UNUpdateCheck.RELEASE_DOWNLOAD_URL }, saveArgs)
            );
            return sendResponse({
              ok: true,
              downloadId,
              remoteVersion: fetched.remoteVersion,
              sha256: expectedSha,
              // No checksum published, or the verifying path was unavailable —
              // say so instead of implying the archive was checked.
              verified: false,
              unverifiedReason: expectedSha ? 'verify_unavailable' : 'no_published_checksum'
            });
          } catch (e) {
            return sendResponse({ ok: false, error: 'download_failed', message: (e && e.message) || String(e) });
          }
        }

        case UNMSG.DISCOVER_CANDIDATES: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          return sendResponse(await gatherDiscoverCandidates(msg));
        }

        case UNMSG.CREATOR_KEYWORD_SUGGEST: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const q = String(msg.query || '').trim().slice(0, 200);
          if (!q) return sendResponse({ ok: true, suggestions: [] });
          const res = await fetchWithTimeout(
            'https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=' + encodeURIComponent(q),
            { credentials: 'omit' },
            8000
          );
          const text = await res.text();
          return sendResponse({ ok: true, suggestions: UNCreatorStudio.parseSuggestBody(text) });
        }

        case UNMSG.CREATOR_RANK_CHECK: {
          if (!isTrustedSender(sender)) return sendResponse({ ok: false, error: 'forbidden' });
          const keyword = String(msg.keyword || '').trim().slice(0, 200);
          const videoId = String(msg.videoId || '').trim();
          if (!keyword || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return sendResponse({ ok: false, error: 'missing_fields' });
          const res = await fetchWithTimeout(
            'https://www.youtube.com/results?search_query=' + encodeURIComponent(keyword),
            { credentials: 'omit' },
            12000
          );
          const html = await res.text();
          const rank = UNCreatorStudio.parseSearchRanks(html, videoId);
          return sendResponse({ ok: true, rank, inTop50: rank != null });
        }

        case UNMSG.SYNC_NOW:
          return sendResponse(await runHistorySync());

        case UNMSG.SYNC_DELETE:
          return sendResponse(await deleteHistorySync());

        case UNMSG.QUEUE_SYNC_PUSH:
          return sendResponse(await pushQueueToCloud(msg.items, msg.v));

        case UNMSG.QUEUE_SYNC_PULL:
          return sendResponse(await pullQueueFromCloud());

        case UNMSG.LIBRARY_SYNC_PUSH:
          return sendResponse(await pushLibraryNow());

        case UNMSG.LIBRARY_SYNC_PULL:
          return sendResponse(await pullLibraryNow());

        default:
          // Unknown type: still close the channel — the outer `return true`
          // keeps it open, and never responding leaves the sender's promise
          // pending until the worker dies ("message port closed" errors).
          return sendResponse({ ok: false, error: 'unknown_message_type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true; // async
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'forge-create') return;
  if (!isTrustedSender(port.sender)) {
    try { port.postMessage({ type: 'done', ok: false, error: 'forbidden' }); } catch (e) { /* disconnected */ }
    try { port.disconnect(); } catch (e) { /* disconnected */ }
    return;
  }
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'create') return;
    (async () => {
      try {
        const result = await createYouTubePlaylist(msg, (current, total, added, phase) => {
          port.postMessage({ type: 'progress', current, total, added, phase });
        });
        port.postMessage(Object.assign({ type: 'done' }, result));
      } catch (e) {
        port.postMessage({ type: 'done', ok: false, error: (e && e.message) || String(e) });
      }
    })();
  });
});

/**
 * Run a bulk playlist add/move/remove for the picker's Port-based path
 * (playlist-bulk.js's applyDestinationsViaPort). Reports progress per phase
 * so a large multi-select doesn't sit behind one silent chrome.runtime.
 * sendMessage call with no timeout on the caller side — see addVideosToPlaylist
 * and removePlaylistItems above for why that broke on big selections.
 *
 * msg: { destIds: string[], move: boolean, videoIds: string[], sourcePlaylistId?: string }
 * For move, sourcePlaylistId must be provided so the originals can be removed
 * by itemId after the adds succeed (mirrors applyDestinations' one-shot path).
 */
async function runBulkPlaylistOp(msg, port) {
  const token = await getAccessToken();
  const destIds = (Array.isArray(msg.destIds) ? msg.destIds : []).filter(Boolean);
  const videoIds = (Array.isArray(msg.videoIds) ? msg.videoIds : []).filter(Boolean);
  const move = !!msg.move;
  if (!destIds.length || !videoIds.length) {
    return { ok: false, error: 'nothing_to_do' };
  }
  // Each destination playlist is an independent YouTube resource, unlike the
  // items WITHIN one playlist (see addVideosToPlaylist's comment for why
  // those stay serial — concurrent writes to the SAME playlist silently drop
  // some, confirmed live). Parallelizing ACROSS destinations is what actually
  // speeds up a multi-destination "Add to N playlists" without touching that
  // same-resource risk: each destination's own add run is internally serial,
  // but up to 3 destinations run their serial runs at the same time.
  const perDest = {};
  let sawAuthExpired = false;
  await runBounded(
    destIds,
    3,
    async (dest) => {
      const result = await addVideosToPlaylist(token, dest, videoIds, (cur, tot, added) => {
        port.postMessage({ type: 'progress', phase: 'adding', dest, current: cur, total: tot, added });
      });
      perDest[dest] = result;
      if (result.authExpired) sawAuthExpired = true;
      return { stop: false };
    }
  );
  const okDests = Object.values(perDest).filter((r) => r.added).length;
  if (!okDests) return { ok: false, error: sawAuthExpired ? 'auth_expired' : 'add_failed', perDest };
  if (!move) return { ok: true, okDests, perDest };

  // Move: remove the originals from the source playlist once, after every
  // destination add attempt above (matches applyDestinations' semantics —
  // partial add failures still remove from source as long as at least one
  // destination succeeded).
  // The caller already resolved its own videoId->itemId map for these exact
  // videoIds before opening the port (see ensureItemMap in playlist-bulk.js)
  // and sends itemIds directly — no need to re-fetch/paginate the source
  // playlist here.
  if (!String(msg.sourcePlaylistId || '')) return { ok: true, okDests, perDest, moveIncomplete: true, error: 'no_source_playlist' };
  const itemIds = (Array.isArray(msg.itemIds) ? msg.itemIds : []).filter(Boolean);
  if (!itemIds.length) return { ok: true, okDests, perDest, moveIncomplete: true, error: 'no_item_ids' };

  // ONLY DELETE ORIGINALS THAT ACTUALLY LANDED SOMEWHERE.
  //
  // okDests above vetoes the total failure — no destination took anything, so
  // nothing is removed. It does NOT cover the partial failure: two videos land,
  // a third 500s, okDests is 1, and a blanket delete of every itemId loses that
  // third video from the destination AND the source.
  //
  // The one-shot path in playlist-bulk.js has always filtered this correctly
  // (addFailedEverywhere -> safeToRemove). This path did not, because its
  // itemIds are resolved before the port opens and so cannot be filtered by the
  // caller. The pairing has to happen here, where the add results exist.
  //
  // The caller sends itemPairs — explicit {videoId, itemId} — because the flat
  // itemIds array is COMPACTED (its builder filters out videos with no known
  // item id), so index i of itemIds does not reliably refer to index i of
  // videoIds. Pairing by position against a compacted array deletes the wrong
  // rows. itemIds is still accepted and still zipped positionally as a fallback
  // for a content script older than this worker, which is a real case during a
  // reload: the worker restarts before the page does.
  //
  // A video counts as safe only if it is absent from the failed list of at
  // least one destination that added something.
  const landedSomewhere = new Set();
  Object.keys(perDest).forEach((dest) => {
    const r = perDest[dest];
    if (!r || !r.added) return;
    const failedHere = new Set(Array.isArray(r.failed) ? r.failed : []);
    videoIds.forEach((v) => {
      if (!failedHere.has(v)) landedSomewhere.add(v);
    });
  });
  const keptBack = videoIds.filter((v) => !landedSomewhere.has(v));
  const rawPairs = Array.isArray(msg.itemPairs) ? msg.itemPairs : null;
  const pairs = rawPairs
    ? rawPairs.filter((pr) => pr && pr.videoId && pr.itemId)
    : itemIds.map((itemId, i) => ({ videoId: videoIds[i], itemId }));
  const safeItemIds = pairs
    .filter((pr) => landedSomewhere.has(pr.videoId))
    .map((pr) => pr.itemId);
  if (!safeItemIds.length) {
    return { ok: true, okDests, perDest, removed: 0, removeFailed: [], keptBack, moveIncomplete: true };
  }
  const removeResult = await removePlaylistItems(token, safeItemIds, (cur, tot, removed) => {
    port.postMessage({ type: 'progress', phase: 'removing', current: cur, total: tot, removed });
  });
  return {
    ok: true,
    okDests,
    perDest,
    removed: removeResult.removed,
    removeFailed: removeResult.failed,
    keptBack
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'playlist-bulk') return;
  if (!isTrustedSender(port.sender)) {
    try { port.postMessage({ type: 'done', ok: false, error: 'forbidden' }); } catch (e) { /* disconnected */ }
    try { port.disconnect(); } catch (e) { /* disconnected */ }
    return;
  }
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'apply') return;
    (async () => {
      try {
        const result = await runBulkPlaylistOp(msg, port);
        port.postMessage(Object.assign({ type: 'done' }, result));
      } catch (e) {
        port.postMessage({ type: 'done', ok: false, error: (e && e.message) || String(e) });
      }
    })();
  });
});

chrome.runtime.onMessage.addListener(onMessage);

// ---- YouTube tab reload after extension update ----
const NOTIFY_ICON = chrome.runtime.getURL('src/icons/icon128.png');
const UPDATE_RELOAD_PAUSE_SCRIPT_ID = 'unsynth-update-reload-pause';

function notifyReloadYouTube(title, message) {
  chrome.notifications
    .create('unsynth-reload-youtube', {
      type: 'basic',
      iconUrl: NOTIFY_ICON,
      title,
      message
    })
    .catch(() => {});
}

async function openLastPlaylistNotify() {
  const url = await UNStore.getLocal('lastPlaylistNotifyUrl', '');
  if (url && /^https:\/\//i.test(url)) await chrome.tabs.create({ url, active: true });
}

async function setNeedsTabReload(reason) {
  const version = chrome.runtime.getManifest().version;
  await UNStore.setLocal('needsTabReload', true);
  await UNStore.setLocal('lastExtensionVersion', version);
  if (reason) await UNStore.setLocal('tabReloadReason', reason);
}

// A sync-storage write silently swallowed a quota/lastError failure here for
// as long as this function used raw chrome.storage.sync callbacks directly —
// profileVersion still got stamped as "done", so a failed write never
// retried. UNStore.getSyncAll/setSyncAll (storage.js) already check
// chrome.runtime.lastError and reject; route through those instead, and only
// stamp success once the write is actually confirmed.
function estimateSyncBytes(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch (e) {
    return 0;
  }
}
function classifySyncFailure(err) {
  return /quota/i.test((err && err.message) || '') ? 'quota' : 'error';
}
function profileApplyNotifyFailed(reason) {
  chrome.notifications
    .create('unsynth-profile-apply-failed', {
      type: 'basic',
      iconUrl: NOTIFY_ICON,
      title: 'Unsynth setup needs attention',
      message:
        reason === 'quota'
          ? 'Your saved keywords/blocked channels are too large to sync. Trim them in the dashboard, then reopen it to retry.'
          : 'Some settings failed to save. Reopen the dashboard to retry.'
    })
    .catch(() => {});
}

let applyProfilePromise = null;
async function applySuiteProfile(reason) {
  if (applyProfilePromise) return applyProfilePromise;
  applyProfilePromise = (async () => {
  const localVer = await UNStore.getLocal('profileVersion', 0);
  const shouldMigrate = reason === 'install' || localVer < UNProfile.VERSION;
  let syncFailed = false;
  let syncFailReason = '';

  if (shouldMigrate) {
    const cur = await UNStore.getSyncAll();
    const next = UNProfile.mergeSync(cur);
    if (localVer < UNProfile.VERSION && UNProfile.isStockWatchedDisplay(cur)) {
      next.watchedDisplay = Object.assign({}, UNProfile.RECOMMENDED_SYNC.watchedDisplay);
      next.watchedMode = UNProfile.RECOMMENDED_SYNC.watchedMode;
    }
    const cap = (chrome.storage.sync.QUOTA_BYTES || 102400) * 0.9;
    if (estimateSyncBytes(next) > cap) {
      // Predictably over quota — don't even attempt the write, and don't
      // touch the user's existing sync settings at all.
      syncFailed = true;
      syncFailReason = 'quota';
    } else {
      try {
        await UNStore.setSyncAll(next);
      } catch (e) {
        syncFailed = true;
        syncFailReason = classifySyncFailure(e);
      }
    }
  }

  const loc = await new Promise((resolve) => chrome.storage.local.get(['subStore', 'plFolderStore'], resolve));
  const subEmpty = !loc.subStore || !Object.keys((loc.subStore.groups || {})).length;
  const plEmpty = !loc.plFolderStore || !UNPlaylistFolders.folderCount(loc.plFolderStore);
  // The bundled PocketTube seeds live in youtube-history-to-import/, which
  // pack-release.js deliberately leaves out of the ZIP (it carries personal
  // subscription data and ships manifest.json + src/ only). On a sideloaded
  // install they are therefore permanently absent — and because subEmpty/plEmpty
  // stay true forever, this used to re-request two 404s on every browser start.
  // Remember the miss per extension version: a later build may add them back.
  const seedVersion = chrome.runtime.getManifest().version;
  const seedMissingFor = await UNStore.getLocal('bundledSeedMissingFor', '');
  const seedAvailable = seedMissingFor !== seedVersion;
  const shouldImportSubs = (reason === 'install' || subEmpty) && seedAvailable;
  const shouldImportPl = (reason === 'install' || plEmpty) && seedAvailable;

  if (!shouldMigrate && !shouldImportSubs && !shouldImportPl) return { ok: true };

  let seedMissing = false;
  /** Read a bundled JSON seed. Returns null (and records the miss) when absent. */
  async function readBundledSeed(rel) {
    try {
      const r = await fetch(chrome.runtime.getURL(rel));
      if (!r.ok) {
        seedMissing = true;
        return null;
      }
      return await r.json();
    } catch (e) {
      seedMissing = true;
      return null;
    }
  }

  // Local subStore/plFolderStore imports are independent of the sync outcome
  // above — a failed sync write shouldn't block these from completing.
  if (shouldImportSubs) {
    const raw = await readBundledSeed('youtube-history-to-import/pockettube-subscription-manager.json');
    if (raw) {
      try {
        const incoming = UNSubGroups.fromPocketTube(raw);
        if (Object.keys((incoming.groups || {})).length) {
          const merged = subEmpty
            ? incoming
            : UNSubGroups.mergeStores(loc.subStore, incoming);
          await UNStore.setLocal('subStore', merged);
        }
      } catch (e) {
        /* malformed seed — ignore, the dashboard import still works */
      }
    }
  }

  if (shouldImportPl) {
    try {
      const [plRaw, subRaw] = await Promise.all([
        readBundledSeed('youtube-history-to-import/pockettube-playlist-manager.json'),
        readBundledSeed('youtube-history-to-import/pockettube-subscription-manager.json')
      ]);
      const incoming = UNPlaylistFolders.resolveBundledImport(plRaw, subRaw);
      // Only import when the map actually contains playlist IDs — never seed
      // empty Main/Night/Streamers shells that aren't the user's playlists.
      if (UNPlaylistFolders.playlistCount(incoming) > 0) {
        const merged = plEmpty
          ? incoming
          : UNPlaylistFolders.mergeFolders(loc.plFolderStore, incoming);
        await UNStore.setLocal('plFolderStore', merged);
      }
    } catch (e) {
      /* optional */
    }
  }

  // Don't re-request seeds this build doesn't ship on every subsequent startup.
  if (seedMissing && seedMissingFor !== seedVersion) {
    await UNStore.setLocal('bundledSeedMissingFor', seedVersion);
  }

  if (shouldMigrate && UNProfile.RECOMMENDED_SYNC.communityList.enabled && !syncFailed) {
    syncAisList().catch(() => {});
  }

  if (shouldMigrate) {
    if (syncFailed) {
      // Deliberately do NOT stamp profileVersion — the next PROFILE_APPLY
      // trigger (dashboard load, next install/update) retries the sync merge.
      // Local imports above already ran regardless (gated on subEmpty/plEmpty,
      // not profileVersion), so they won't be lost or repeated. Notifying the
      // user is the CALLER's job (see call sites below) — onInstalled/
      // onStartup show an OS notification since nothing else is on screen;
      // the dashboard-triggered PROFILE_APPLY case shows an inline flash
      // instead, so this function doesn't double-notify either way.
    } else {
      await UNStore.setLocal('profileVersion', UNProfile.VERSION);
      const locOverlay = await UNStore.getLocal('statsSections', null);
      if (!locOverlay) {
        // setLocal is (key, val) — passing one object wrote `{ '[object Object]': undefined }`
        // and silently dropped both defaults. Write them as separate keys.
        await UNStore.setLocal('statsSections', { engagement: true, seo: true, tags: true });
        // Collapsed on first install (2026-09-21). The expanded card is a full
        // dashboard at the top of the related column; the header carries a
        // one-line summary so closed still reads. Stored values are untouched.
        await UNStore.setLocal('statsCollapsed', true);
      }
    }
  }
  return syncFailed ? { ok: false, reason: syncFailReason } : { ok: true };
  })().finally(() => { applyProfilePromise = null; });
  return applyProfilePromise;
}

function waitForTabReload(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let timer = null;
    function cleanup() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (timer) clearTimeout(timer);
      resolve();
    }
    function onUpdated(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') cleanup();
    }
    function onRemoved(id) {
      if (id === tabId) cleanup();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(cleanup, timeoutMs);
  });
}

async function registerUpdateReloadPauseGuard() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [UPDATE_RELOAD_PAUSE_SCRIPT_ID] });
  } catch (e) {
    /* no stale registration */
  }
  await chrome.scripting.registerContentScripts([
    {
      id: UPDATE_RELOAD_PAUSE_SCRIPT_ID,
      matches: YT_TAB_PATTERNS,
      js: ['src/content/update-reload-pause.js'],
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: false
    }
  ]);
}

/**
 * A /watch, /shorts or channel live URL — reloading one of these restarts
 * playback. The live pattern mirrors LIVE_CHANNEL_PATH_RE in shared/yt-dom.js
 * (not imported here: the worker does not load the DOM adapter). YouTube serves
 * the live stream's watch page at /@name/live without redirecting, so a parked
 * live tab was being reloaded on update and started playing (2026-09-23).
 */
function isPlayableYouTubeUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (!isYouTubeHost(u.hostname)) return false;
    const liveChannel = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/;
    return u.pathname === '/watch' || u.pathname.indexOf('/shorts/') === 0 || liveChannel.test(u.pathname);
  } catch (e) {
    return false;
  }
}

/**
 * Decide what to do with one tab on an extension update.
 *
 * Reloading a background /watch tab makes YouTube autoplay it, so a set of
 * videos parked for later would all start playing at once — several at the same
 * time, from tabs the user isn't even looking at. Feed and library pages have no
 * such cost, so they still reload immediately and pick the new code up.
 *
 * A parked video is instead marked stale: content scripts there are orphaned
 * until the user returns to it, which is a far better trade than hijacking the
 * tab. Discarded (unloaded) tabs are skipped entirely — reloading one wakes it
 * and defeats the memory saving Chrome just made.
 *
 * @returns {'skip'|'reload'|'defer'}
 */
function tabReloadAction(tab) {
  if (!tab || !tab.id) return 'skip';
  // Chrome unloaded it to save memory; it reloads itself when next focused.
  if (tab.discarded) return 'skip';
  // The tab the user is actually looking at is safe to reload — they can see
  // it happen, and it's the one most likely to need the new code right now.
  if (tab.active) return 'reload';
  // Any background video tab, playing or paused — reloading either one starts
  // playback. Paused-and-parked is the exact case the user hit.
  if (isPlayableYouTubeUrl(tab.url)) return 'defer';
  return 'reload';
}

async function reloadYouTubeTabs() {
  const tabs = await chrome.tabs.query({ url: YT_TAB_PATTERNS });
  const decided = tabs.map((tab) => ({ tab, action: tabReloadAction(tab) }));
  const reloadable = decided.filter((d) => d.action === 'reload' && d.tab.id != null).map((d) => d.tab);
  const deferredTabs = decided.filter((d) => d.action === 'defer');
  let reloaded = 0;
  let deferred = 0;

  // Parked video tabs are never yanked — they are told they are stale and
  // show their own banner when the user comes back to them.
  for (const { tab } of deferredTabs) {
    deferred++;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'unsynth-mark-stale' });
    } catch (e) {
      /* no content script there yet — nothing to notify */
    }
  }

  if (reloadable.length) {
    await registerUpdateReloadPauseGuard();
    // Pause the old documents first, then let the temporary document-start
    // registration catch any playback YouTube restores in the new documents.
    await Promise.allSettled(
      reloadable.map((tab) =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content/update-reload-pause.js'],
          injectImmediately: true
        })
      )
    );
    const completed = reloadable.map((tab) => waitForTabReload(tab.id));
    await Promise.allSettled(
      reloadable.map(async (tab) => {
        try {
          await chrome.tabs.reload(tab.id);
          reloaded++;
        } catch (e) {
          /* tab may have closed */
        }
      })
    );
    await Promise.allSettled(completed);
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [UPDATE_RELOAD_PAUSE_SCRIPT_ID] });
    } catch (e) {
      /* service worker cleanup is best-effort */
    }
  }
  // Only clear the flag once nothing is left waiting; a deferred video tab still
  // needs the user's own reload before it is running current code.
  await UNStore.setLocal('needsTabReload', deferred > 0);
  return { reloaded, deferred };
}

chrome.runtime.onInstalled.addListener((details) => {
  setupContextMenus();
  setNeedsTabReload(details.reason).catch(() => {});
  UNStore.runMigrations().catch(() => {}).finally(() => { syncLazyModules(); });
  UNStore.pruneCaches().catch(() => {});
  applySuiteProfile(details.reason).then((r) => { if (r && r.ok === false) profileApplyNotifyFailed(r.reason); }).catch(() => profileApplyNotifyFailed('error'));
  if (self.UNPlaylistFolders && self.UNPlaylistFolders.hydratePinsFromSync) {
    self.UNPlaylistFolders.hydratePinsFromSync();
  }
  pullLibraryNow().catch(() => {});
  if (details.reason === 'install') {
    const dash = chrome.runtime.getURL('src/dashboard/dashboard.html');
    chrome.tabs.create({ url: dash, active: true }).catch(() => {});
    notifyReloadYouTube('Welcome to Unsynth', 'Use One-click setup in the dashboard, then browse YouTube.');
  } else if (details.reason === 'update') {
    // Opt-in: reload open YouTube tabs automatically instead of only notifying.
    chrome.storage.sync.get({ autoReloadTabsOnUpdate: true }, (s) => {
      if (s && s.autoReloadTabsOnUpdate) {
        reloadYouTubeTabs().catch(() => {});
      } else {
        notifyReloadYouTube('Unsynth updated', 'Reload open YouTube tabs to resume tracking and filtering.');
      }
    });
    chrome.permissions.contains({ permissions: ['downloads'] }, (ok) => {
      if (!ok) {
        notifyReloadYouTube(
          'Unsynth — accept new permission',
          'Open your extensions page, reload Unsynth, and accept the Downloads permission so updates can be saved.'
        );
      }
    });
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'unsynth-playlist-created') {
    openLastPlaylistNotify().catch(() => {});
    return;
  }
  if (id === 'unsynth-profile-apply-failed') {
    // The dashboard re-sends PROFILE_APPLY on every load while profileVersion
    // is stale (dashboard-core.js) — reopening it IS the retry action.
    const dash = chrome.runtime.getURL('src/dashboard/dashboard.html');
    chrome.tabs.create({ url: dash, active: true }).catch(() => {});
    return;
  }
  if (id !== 'unsynth-reload-youtube') return;
  reloadYouTubeTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  UNStore.runMigrations().catch(() => {}).finally(() => { syncLazyModules(); });
  UNStore.pruneCaches().catch(() => {});
  applySuiteProfile('update').then((r) => { if (r && r.ok === false) profileApplyNotifyFailed(r.reason); }).catch(() => profileApplyNotifyFailed('error'));
  if (self.UNPlaylistFolders && self.UNPlaylistFolders.hydratePinsFromSync) {
    self.UNPlaylistFolders.hydratePinsFromSync();
  }
  pullLibraryNow().catch(() => {});
  refreshUpdateBadge().catch(() => {});
  UNStore.getLocal('needsTabReload', false).then((flag) => {
    if (flag) {
      notifyReloadYouTube('Unsynth needs a tab reload', 'Reload open YouTube tabs to resume tracking.');
    }
  });
});

// Re-register/unregister lazy content scripts whenever the module toggles change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes && changes.modules) {
    syncLazyModules();
  }
  if (area === 'sync' && changes && changes.unPlPinsSync && self.UNPlaylistFolders && self.UNPlaylistFolders.applyRemotePinSync) {
    self.UNPlaylistFolders.applyRemotePinSync(changes.unPlPinsSync.newValue);
  }
  if (area === 'local' && changes && (changes.subStore || changes.plFolderStore || changes.librarySync)) {
    if (changes.librarySync && changes.librarySync.newValue && changes.librarySync.newValue.enabled &&
        !(changes.librarySync.oldValue && changes.librarySync.oldValue.enabled)) {
      // Pull first so an existing remote library merges in rather than being
      // clobbered, then push so THIS device is backed up immediately. Enabling
      // used to pull only, which on a first-ever enable found nothing, wrote
      // nothing, and stamped nothing — the card read "not synced yet" forever
      // and the local library stayed unbacked-up until an unrelated edit
      // happened to trigger a push.
      pullLibraryNow().then(() => pushLibraryNow()).catch(() => {});
    } else {
      scheduleLibraryPush();
    }
  }
});

// ---- context menus + keyboard shortcuts ----
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'unsynth-mark-watched',
      title: 'Mark as watched (Unsynth)',
      contexts: ['page', 'link'],
      documentUrlPatterns: YT_TAB_PATTERNS,
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://music.youtube.com/watch*', '*://*.youtube.com/shorts*']
    });
    chrome.contextMenus.create({
      id: 'unsynth-mark-unwatched',
      title: 'Mark as unwatched (Unsynth)',
      contexts: ['page', 'link'],
      documentUrlPatterns: YT_TAB_PATTERNS,
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://music.youtube.com/watch*', '*://*.youtube.com/shorts*']
    });
    chrome.contextMenus.create({
      id: 'unsynth-block-channel',
      title: 'Block AI channel (Unsynth filter)',
      contexts: ['page'],
      documentUrlPatterns: ['*://*.youtube.com/*']
    });
    chrome.contextMenus.create({
      id: 'unsynth-sb-personal',
      title: 'Save personal sponsor skip — last 30s (Unsynth)',
      contexts: ['page', 'video'],
      documentUrlPatterns: YT_TAB_PATTERNS,
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://music.youtube.com/watch*', '*://*.youtube.com/shorts*']
    });
    chrome.contextMenus.create({
      id: 'unsynth-popout-player',
      title: 'Pop out player (Unsynth)',
      contexts: ['page', 'video', 'link'],
      documentUrlPatterns: YT_TAB_PATTERNS,
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://music.youtube.com/watch*', '*://*.youtube.com/shorts*']
    });
  });
}

function videoIdFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/[?&]v=([\w-]{11})/);
  if (m) return m[1];
  const sm = s.match(/\/shorts\/([\w-]{11})/);
  return sm ? sm[1] : null;
}

async function activeYouTubeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id || !tab.url) return null;
  if (!/youtube\.com/.test(tab.url)) return null;
  return tab;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'unsynth-mark-watched') {
    const vid = videoIdFromUrl(info.linkUrl) || videoIdFromUrl(tab.url);
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-mark-watched', videoId: vid }).catch(() => {});
  } else if (info.menuItemId === 'unsynth-mark-unwatched') {
    const vid = videoIdFromUrl(info.linkUrl) || videoIdFromUrl(tab.url);
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-mark-unwatched', videoId: vid }).catch(() => {});
  } else if (info.menuItemId === 'unsynth-block-channel') {
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-block-channel' }).catch(() => {});
  } else if (info.menuItemId === 'unsynth-sb-personal') {
    const vid = videoIdFromUrl(tab.url);
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-sb-personal-recent', videoId: vid, seconds: 30 }).catch(() => {});
  } else if (info.menuItemId === 'unsynth-popout-player') {
    const vid = videoIdFromUrl(info.linkUrl);
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-popout-open', videoId: vid }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeYouTubeTab();
  if (!tab) return;
  if (command === 'mark-watched') {
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-mark-watched' }).catch(() => {});
  } else if (command === 'mark-unwatched') {
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-mark-unwatched' }).catch(() => {});
  } else if (command === 'toggle-filter') {
    const cur = await chrome.storage.sync.get({ enabled: true, modules: {} });
    const next = !cur.enabled;
    const modules = Object.assign({}, cur.modules || {}, { aiFilter: next });
    chrome.storage.sync.set({ enabled: next, modules });
  } else if (command === 'popout-player') {
    chrome.tabs.sendMessage(tab.id, { type: 'unsynth-popout-open' }).catch(() => {});
  }
});

/**
 * Community AI-channel blocklist (AiSList): fetch the raw list, parse @handles
 * and UC ids (lowercased), cache in storage.local. github.com/Override92/AiSList
 */
const AISLIST_URL = 'https://raw.githubusercontent.com/Override92/AiSList/main/AiSList/aislist_blocklist.txt';
async function syncAisList() {
  const r = await fetch(AISLIST_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error('fetch_' + r.status);
  const text = await r.text();
  const keys = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '!') continue;
    if (line[0] === '@') keys.push('@' + line.slice(1).toLowerCase());
    else if (/^UC[\w-]{20,}$/i.test(line)) keys.push(line.toLowerCase());
  }
  const data = { keys, count: keys.length, updated: Date.now() };
  await UNStore.setLocal('aislist', data);
  return data;
}

// refresh the community list daily, but only while it's enabled.
// Only create an alarm when it doesn't already exist — chrome.alarms.create
// with an existing name replaces it and RESTARTS the timer, so creating at
// top level on every SW wake meant these periodic alarms could never fire.
function ensureAlarm(name, periodInMinutes) {
  chrome.alarms.get(name, (a) => {
    if (!a) chrome.alarms.create(name, { periodInMinutes });
  });
}
const UPDATE_BADGE_DEFAULT_TITLE = 'Unsynth';

async function applyUpdateBadge(remoteVersion, localVersion) {
  await chrome.action.setBadgeText({ text: '↑' });
  await chrome.action.setBadgeBackgroundColor({ color: '#c4870a' });
  await chrome.action.setTitle({
    title: 'Unsynth update available — v' + remoteVersion + ' (installed v' + localVersion + ')'
  });
}

async function clearUpdateBadge() {
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: UPDATE_BADGE_DEFAULT_TITLE });
}

/** Light background check — sets toolbar badge when a newer release is published. */
async function refreshUpdateBadge() {
  const localVersion = chrome.runtime.getManifest().version;
  const pat = (await UNStore.getLocal('githubPat', '')) || '';
  const checkedAt = Date.now();
  await UNStore.setLocal('updateLastCheck', checkedAt);

  const fetched = await UNUpdateCheck.fetchLatestRelease(pat.trim());
  if (!fetched.ok) {
    await clearUpdateBadge();
    return;
  }

  const remoteVersion = fetched.remoteVersion;
  await UNStore.setLocal('updateRemoteVersion', remoteVersion);
  if (UNSemver.isNewer(remoteVersion, localVersion)) {
    await applyUpdateBadge(remoteVersion, localVersion);
  } else {
    await clearUpdateBadge();
  }
}

ensureAlarm('aislist-refresh', 1440);
ensureAlarm('subs-cache-refresh', 360);
ensureAlarm('unsynth-history-sync', 15);
ensureAlarm('unsynth-update-check', 360);
// ---- Dev-only auto-reload --------------------------------------------
// Eliminates the manual chrome://extensions reload click during local
// development (`npm run dev:watch`; see scripts/dev-watch.js). Gated so
// it can NEVER activate for a real install:
//   1. chrome.management.getSelf().installType must be 'development' —
//      Chrome's own signal for "loaded unpacked via Developer Mode",
//      requires no extra permission (confirmed against Chrome's own docs
//      before adding this — getSelf/getPermissionWarningsByManifest/
//      uninstallSelf are the specific management.* calls exempted from
//      needing the "management" permission). A Chrome Web Store or
//      offline-installed copy never reports this value.
//   2. Even in dev mode, this only does anything if scripts/dev-watch.js
//      happens to be running locally — a real install (or a dev session
//      that just hasn't started the watcher) has no server to reach, so
//      the fetch fails silently every poll, forever. Both gates must pass
//      — see src/shared/dev-reload.js's shouldReload() — before
//      chrome.runtime.reload() is ever called.
// Sub-minute chrome.alarms periods are only honored for unpacked/dev-mode
// extensions in the first place (Chrome enforces a 1-minute floor
// otherwise), so this is a fast ~3s poll purely while it's relevant and a
// harmless once-a-minute no-op check everywhere else.
const UNSYNTH_DEV_RELOAD_PORT = 8971;
const UNSYNTH_DEV_RELOAD_KEY = 'devReloadKnownVersion';
ensureAlarm('unsynth-dev-reload', 0.05);
// MV3 clamps chrome.alarms to a 30s floor, so the 0.05 (3s) period above is
// really ~30s AND only fires while the worker happens to be awake — which in
// practice meant saving a file and then waiting, refreshing, and still getting
// the old build. Anything that wakes the worker (a page load, a message) is a
// far better trigger than the alarm, so check on wake too. shouldReload() is
// still the only thing that decides, so this cannot reload-loop: it needs a
// recorded baseline AND a different token.
unsynthDevReloadTick();
chrome.runtime.onStartup.addListener(() => {
  unsynthDevReloadTick();
});
// The baseline lives in chrome.storage.session, NOT a module variable. An MV3
// service worker is evicted after a few seconds idle and this poll is what
// wakes it, so a module-scoped baseline was null on essentially every tick —
// and shouldReload() returns false against a null baseline. The net effect was
// that the watcher recorded a version, slept, woke with no memory, recorded
// again, and never once reloaded unless something else happened to keep the
// worker alive across two consecutive 3s ticks. Session storage survives
// eviction but is cleared when the browser closes, which is exactly the right
// lifetime: a brand new browser session correctly starts with no baseline and
// takes one tick to establish it, instead of reloading on first contact.
async function unsynthDevReloadTick() {
  try {
    const info = await chrome.management.getSelf();
    if (info.installType !== 'development') return;
    const res = await fetch('http://127.0.0.1:' + UNSYNTH_DEV_RELOAD_PORT + '/version', { cache: 'no-store' });
    if (!res.ok) return;
    const v = (await res.text()).trim();
    const stored = await chrome.storage.session.get(UNSYNTH_DEV_RELOAD_KEY);
    const known = stored ? stored[UNSYNTH_DEV_RELOAD_KEY] || null : null;
    if (self.UNDevReload.shouldReload(info.installType, known, v)) {
      console.log('[Unsynth][dev-reload] source changed on disk — reloading extension');
      // Record the new version BEFORE reloading, or the worker comes back up,
      // reads the old baseline, and reloads again on the very next tick.
      await chrome.storage.session.set({ [UNSYNTH_DEV_RELOAD_KEY]: v });
      chrome.runtime.reload();
      return;
    }
    if (known !== v) await chrome.storage.session.set({ [UNSYNTH_DEV_RELOAD_KEY]: v });
  } catch (e) {
    /* no dev-watch server reachable — expected whenever it isn't running, silent */
  }
}
// Expired UNApi TTL entries are only skipped on read, never deleted — sweep them
// twice a day so storage.local doesn't grow forever with unreadable data.
ensureAlarm('cache-prune', 720);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'cache-prune') {
    UNStore.pruneCaches().catch(() => {});
    return;
  }
  if (a.name === 'unsynth-update-check') {
    refreshUpdateBadge().catch(() => {});
    return;
  }
  if (a.name === 'subs-cache-refresh') {
    UNStore.getLocal('auth_tokens', null).then((tokens) => {
      if (tokens) refreshSubscribedChannelCache().catch(() => {});
    });
    return;
  }
  if (a.name === 'unsynth-history-sync') {
    UNStore.getLocal('auth_tokens', null).then((tokens) => {
      if (tokens) runHistorySync().catch(() => {});
    });
    return;
  }
  if (a.name === 'unsynth-dev-reload') {
    unsynthDevReloadTick();
    return;
  }
  if (a.name !== 'aislist-refresh') return;
  chrome.storage.sync.get({ communityList: { enabled: false } }, (s) => {
    if (s.communityList && s.communityList.enabled) syncAisList().catch(() => {});
  });
});
