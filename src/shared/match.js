/**
 * Pure AI-match logic — no DOM, no chrome APIs. Decides whether a video's
 * title or channel matches the user's keyword/regex/channel block rules.
 */
(function (g) {
  'use strict';

  function buildRegex(keywords) {
    const out = [];
    for (const k of keywords || []) {
      try {
        out.push(new RegExp(k, 'i'));
      } catch (e) {
        /* skip invalid pattern */
      }
    }
    return out;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Compiled-regex cache. compileKeyword is pure — the same keyword always
  // produces the same pattern — so the RegExp can be built once and reused.
  //
  // Without this it was rebuilt on every call, and the callers are hot: the AI
  // scorer's allHits() compiles once per TERM, scoreVideo() calls allHits()
  // about seven times per tile, and the term lists total ~92 entries. Measured
  // on a real channel page with 270 loaded tiles that came to ~174,000 RegExp
  // constructions per scan, and the scan runs on every debounced mutation —
  // i.e. continuously while scrolling a long channel feed. Caching measured 4.1x
  // faster on that path (35.4ms -> 8.7ms).
  //
  // The cache is keyed by the raw keyword and holds a null for a pattern that
  // failed to compile, so an invalid keyword is not retried on every call
  // either. Bounded because an unbounded map fed by user keywords is a slow
  // leak on a long-lived tab; the cap is far above any real keyword list and
  // clearing wholesale is fine since every entry is cheap to rebuild.
  var KW_CACHE = new Map();
  var KW_CACHE_MAX = 5000;
  function compileKeyword(k) {
    const raw = String(k == null ? '' : k);
    if (!raw) return null;
    if (KW_CACHE.has(raw)) return KW_CACHE.get(raw);
    const startsWord = /\w/.test(raw.charAt(0));
    const endsWord = /\w/.test(raw.charAt(raw.length - 1));
    const pat = (startsWord ? '\\b' : '') + escapeRe(raw) + (endsWord ? '\\b' : '');
    let re;
    try {
      re = new RegExp(pat, 'i');
    } catch (e) {
      re = null;
    }
    if (KW_CACHE.size >= KW_CACHE_MAX) KW_CACHE.clear();
    KW_CACHE.set(raw, re);
    return re;
  }

  /**
   * @param {object} settings  needs { useRegex, keywords[], channels[] }
   * @returns {{ match(title, channel): {hit, reason?, value?} }}
   */
  function makeMatcher(settings) {
    settings = settings || {};
    const useRegex = !!settings.useRegex;
    const keywords = settings.keywords || [];
    const channels = settings.channels || [];
    const titleRegex = useRegex ? buildRegex(keywords) : [];
    const channelRegex = useRegex ? buildRegex(channels) : [];
    // Literal-mode matching uses precompiled word-boundary regexes (not raw
    // substring includes) so short tokens don't false-positive inside words.
    const kwBoundary = useRegex ? [] : keywords.map(compileKeyword);
    const chBoundary = useRegex ? [] : channels.map(compileKeyword);

    function titleMatch(title) {
      const original = title || '';
      if (useRegex) {
        for (const re of titleRegex) if (re.test(original)) return { hit: true, reason: 'keyword', value: re.source };
        return { hit: false };
      }
      for (let i = 0; i < kwBoundary.length; i++) {
        if (kwBoundary[i] && kwBoundary[i].test(original)) return { hit: true, reason: 'keyword', value: keywords[i] };
      }
      return { hit: false };
    }

    function channelMatch(channel) {
      const original = channel || '';
      if (!original) return { hit: false };
      if (useRegex) {
        for (const re of channelRegex) if (re.test(original)) return { hit: true, reason: 'channel', value: re.source };
        return { hit: false };
      }
      for (let i = 0; i < chBoundary.length; i++) {
        if (chBoundary[i] && chBoundary[i].test(original)) return { hit: true, reason: 'channel', value: channels[i] };
      }
      return { hit: false };
    }

    return {
      match(title, channel) {
        const t = titleMatch(title);
        if (t.hit) return t;
        return channelMatch(channel);
      },
      titleMatch,
      channelMatch
    };
  }

  /** True when a channel name or normalized tile key is on the allow list. */
  function isChannelAllowed(settings, channel, chKey) {
    const list = (settings && settings.allowedChannels) || [];
    if (!list.length) return false;
    const c = (channel || '').toLowerCase();
    const nk = chKey ? String(chKey).toLowerCase() : '';
    for (let i = 0; i < list.length; i++) {
      const entry = String(list[i] || '').trim();
      if (!entry) continue;
      if (entry.charAt(0) === '@') {
        const h = '@' + entry.slice(1).toLowerCase();
        if (nk && nk === h) return true;
        // Callers with no DOM tile to derive a real chKey from (e.g. Forge
        // search results, which only carry a channel display name from the
        // backend) used to pass chKey:'' here, which made this branch
        // unreachable — an @handle allow-list entry could never match
        // anywhere outside a normal feed/watch page. A handle's slug is
        // usually a close match for the channel's display name (e.g.
        // @mkbhd / "MKBHD"), so fall back to comparing it against the name too.
        if (!nk && c && c === entry.slice(1).toLowerCase()) return true;
        continue;
      }
      if (/^UC[\w-]+$/i.test(entry)) {
        if (nk && nk === entry.toLowerCase()) return true;
        continue;
      }
      if (entry.indexOf('channel:') === 0) {
        if (nk && nk === entry.slice(8).toLowerCase()) return true;
        continue;
      }
      const frag = entry.toLowerCase();
      if (c && (c === frag || c.includes(frag))) return true;
    }
    return false;
  }

  const api = { buildRegex, compileKeyword, makeMatcher, isChannelAllowed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNMatch = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
