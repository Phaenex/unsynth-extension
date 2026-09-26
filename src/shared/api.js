/**
 * YouTube Data API v3 wrapper (classic script, attaches UNApi to the global).
 * Runs in the service worker. Adds TTL caching and a quota circuit-breaker on
 * top of raw fetch. Depends on UNStore (load storage.js first).
 *
 * Quota: the free tier is 10,000 units/day per Cloud project. We stop at
 * QUOTA_CAP to leave headroom. Most reads cost 1 unit; search.list costs 100.
 */
(function (g) {
  'use strict';

  const QUOTA_CAP = 9000;
  const BASE = 'https://www.googleapis.com/youtube/v3/';

  const UNApi = {
    QUOTA_CAP,

    /**
     * @param {object} opts
     * @param {string} opts.path        e.g. "channels", "subscriptions"
     * @param {object} [opts.params]    query params (part, mine, id, etc.)
     * @param {string} [opts.accessToken] OAuth bearer token (for mine=true, writes)
     * @param {string} [opts.apiKey]    public API key (for public reads, no OAuth)
     * @param {number} [opts.ttlMs]     cache TTL; 0 = no cache
     * @param {number} [opts.cost]      quota cost (default 1; search = 100)
     */
    async call(opts) {
      const { path, params = {}, accessToken, apiKey, ttlMs = 0, cost = 1 } = opts;
      const usp = new URLSearchParams(params);
      const cacheKey = path + '?' + usp.toString() + (accessToken ? '#me' : '');

      if (ttlMs > 0) {
        const cached = await UNStore.cacheGet(cacheKey);
        if (cached) return cached;
      }

      // Reserve the cost atomically (inside UNStore's serialized quota chain)
      // BEFORE issuing the request, not just check-then-fetch-then-add — a
      // plain check here separate from the eventual quotaAdd() left a window
      // (the whole fetch() below) where every concurrent caller could see
      // the same pre-request "used" value and all proceed, letting combined
      // cost blow past QUOTA_CAP.
      const reservation = await UNStore.quotaReserve(cost, QUOTA_CAP);
      if (!reservation.ok) {
        const err = new Error('quota_exceeded');
        err.code = 'quota_exceeded';
        throw err;
      }

      let url = BASE + path + '?' + usp.toString();
      const headers = {};
      if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
      else if (apiKey) url += '&key=' + encodeURIComponent(apiKey);

      try {
        const r = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body });
        if (!r.ok) {
          const text = await r.text();
          const quota = r.status === 403 && /quota/i.test(text);
          const err = new Error(quota ? 'yt_quota' : 'yt_api_' + r.status);
          err.status = r.status;
          err.detail = text;
          if (quota) err.code = 'yt_quota';
          throw err;
        }
        const data = await r.json();
        if (ttlMs > 0) await UNStore.cacheSet(cacheKey, data, ttlMs);
        return data;
      } catch (e) {
        // The reservation already charged `cost` — a request that never
        // reached YouTube (network failure) or came back non-2xx didn't
        // actually spend real API quota, so give it back rather than
        // permanently burning it on a failed attempt.
        UNStore.quotaAdd(-cost).catch(() => {});
        throw e;
      }
    }
  };

  g.UNApi = UNApi;
})(typeof self !== 'undefined' ? self : window);
