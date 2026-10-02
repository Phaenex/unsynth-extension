/**
 * Unsynth AI-filter module.
 *
 * Hides AI-generated / AI-voiced content across YouTube and YouTube Music
 * (tiles on home/subscriptions/channel/search/shorts/sidebar, AI music tracks,
 * AI summaries) and blocks the watch player for matching videos. This is the
 * Phase 0 logic, restructured as a core module (no longer owns the observer,
 * navigation hook, or storage wiring — core drives those).
 */
(function () {
  'use strict';

  let core = null;
  let settings = window.UNSYNTH_DEFAULTS || {};
  const YT = window.UNYtDom || null;
  // Defer matcher creation until init() when real settings are available from core.
  // Guard window.UNMatch — if the shared script failed to load, the module degrades
  // gracefully (no filtering) rather than crashing the entire IIFE at parse time.
  let matcher = null;
  let pageHidden = 0;
  // Named listener refs — stored so teardown can remove them on disable.
  let onDefaultFeedChanged = null;
  let onStorageChanged = null;
  const AI_KW = window.UNAIKeywords || null;

  const IS_MUSIC = location.host === 'music.youtube.com';
  const lc = (s) => (s || '').toLowerCase();
  // Shared "show YouTube default feed" peek — toggled by watch-history's masthead
  // button via an <html> class. While on, the AI filter reveals everything on
  // feeds (watch-page blocking is unaffected; that's a separate path).
  const defaultFeedOn = () => document.documentElement.classList.contains('un-default-feed');
  function rebuildMatcher() {
    if (!window.UNMatch) return; // guard: shared script may not be loaded yet
    matcher = window.UNMatch.makeMatcher(settings);
  }

  // community AI-channel blocklist (AiSList) — a Set of '@handle'/'uc…' keys
  let aiSet = null;
  let subscribedCache = { keys: [], names: [] };
  let subscribedCacheOAuthUpdated = 0;

  function loadSubscribedCache(cb) {
    try {
      chrome.storage.local.get(
        {
          subscribedChannelCache: { keys: [], names: [] },
          subscribedChannelsOAuthUpdated: 0,
          subscribedChannelsUpdated: 0
        },
        (d) => {
          subscribedCache = d.subscribedChannelCache || { keys: [], names: [] };
          subscribedCacheOAuthUpdated = d.subscribedChannelsOAuthUpdated || d.subscribedChannelsUpdated || 0;
          subscribedCacheReady = true;
          cb && cb();
        }
      );
    } catch (e) {
      subscribedCacheReady = true; // treat as ready even on error — don't silently block forever
      cb && cb();
    }
  }

  function scrapeGuideSubscriptionKeys() {
    const keys = [];
    const seen = new Set();
    // Locale-agnostic: find guide sections that actually contain channel links
    // (i.e. the Subscriptions section), regardless of the section title language.
    document.querySelectorAll(YT ? YT.GUIDE_SECTION_SEL : '#sections').forEach((sec) => {
      const channelLinks = sec.querySelectorAll('a[href*="/@"], a[href*="/channel/"]');
      if (!channelLinks.length) return;
      // Sanity check: if the section title contains a non-subscription keyword in English,
      // skip it (e.g. "Explore" or "You" sections also have channel links in some layouts).
      const titleEl = sec.querySelector('#guide-section-title, #title, yt-formatted-string#title');
      const title = titleEl ? lc(titleEl.textContent.trim()) : '';
      // Skip "Explore", "You", "More from YouTube" sections
      if (title && (title === 'explore' || title === 'you' || title.includes('from youtube'))) return;
      channelLinks.forEach((a) => {
        const k = channelKeyFromHref(a.getAttribute('href'));
        if (!k || seen.has(k)) return;
        seen.add(k);
        keys.push(k);
      });
    });
    return keys;
  }

  function mergeGuideSubsIntoCache() {
    if (!settings.allowSubscribedChannels || IS_MUSIC) return;
    const scraped = scrapeGuideSubscriptionKeys();
    if (!scraped.length) return;
    chrome.runtime.sendMessage({ type: 'UNSYNTH/SUBS/CACHE_MERGE', keys: scraped }, () => { if (chrome.runtime.lastError) return; });
  }

  function maybeRefreshSubscribedCache() {
    if (!settings.allowSubscribedChannels || IS_MUSIC) return;
    const stale = !subscribedCacheOAuthUpdated || Date.now() - subscribedCacheOAuthUpdated > 6 * 3600 * 1000;
    if (!stale) return;
    chrome.runtime.sendMessage({ type: 'UNSYNTH/SUBS/CACHE_REFRESH' }, () => { if (chrome.runtime.lastError) return; });
  }

  // Whether the subscribed-channel cache has finished its first load.
  let subscribedCacheReady = false;

  function isAllowedChannel(channel, chKey) {
    if (window.UNMatch && window.UNMatch.isChannelAllowed(settings, channel, chKey)) return true;
    if (settings.allowSubscribedChannels) {
      // If the cache has never loaded yet, do NOT silently allow everything —
      // return false so the normal keyword/block rules still apply. The cache
      // will populate shortly and trigger a re-scan.
      if (!subscribedCacheReady) return false;
      if (!subscribedCache.keys || !subscribedCache.keys.length) return false;
      if (window.UNSubGroups && window.UNSubGroups.isSubscribedInCache(subscribedCache, channel, chKey)) return true;
    }
    return false;
  }
  function loadAiSet(cb) {
    try {
      chrome.storage.local.get('aislist', (d) => {
        const keys = (d && d.aislist && d.aislist.keys) || [];
        aiSet = keys.length ? new Set(keys) : null;
        cb && cb();
      });
    } catch (e) {
      cb && cb();
    }
  }
  function communityOn() {
    return !!(settings.communityList && settings.communityList.enabled);
  }
  function normalizeListKey(k) {
    if (!k) return null;
    if (k.indexOf('channel:') === 0) return k.slice(8).toLowerCase();
    return k.toLowerCase();
  }
  function channelKeyFromHref(href) {
    if (YT) return YT.channelKeyFromHref(href);
    if (!href || !window.UNSubGroups) return null;
    return normalizeListKey(window.UNSubGroups.channelKey(href));
  }
  function isOnCommunityList(key) {
    return !!(communityOn() && aiSet && key && aiSet.has(key));
  }
  const matchInfo = (title, channel) => {
    if (!matcher) return { hit: false }; // guard until init() builds the matcher
    return matcher.match(title, channel);
  };

  // ---- effective on/off (master toggle + Focus Mode schedule) ----
  function withinFocusWindow() {
    const f = settings.focus || {};
    if (!f.enabled) return true;
    const now = new Date();
    if (Array.isArray(f.days) && f.days.length && !f.days.includes(now.getDay())) return false;
    const [sh, sm] = (f.start || '00:00').split(':').map(Number);
    const [eh, em] = (f.end || '23:59').split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
  }
  function active() {
    return !!settings.enabled && withinFocusWindow();
  }

  // ---- surfaces ----
  function pageSurface() {
    return YT ? YT.pageSurface(location.pathname, location.host) : 'home';
  }
  function surfaceForTile(tile, fallback) {
    return YT ? YT.surfaceForTile(tile, fallback) : fallback;
  }
  function surfaceEnabled(name) {
    const s = settings.surfaces || {};
    return s[name] !== false;
  }

  // ---- selectors (shared yt-dom) ----
  function forEachTile(fn) {
    if (!YT) return;
    // On watch/shorts, only walk the related rail — primary feed is not present
    // and full-document QSA competes with the player during playback.
    const onWatch =
      (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.indexOf('/shorts/') === 0;
    if (onWatch) {
      const root = YT.watchRelatedRoot && YT.watchRelatedRoot();
      if (!root) return;
      YT.forEachFeedTile(fn, { root: root });
      return;
    }
    // Per-tile scoring and hiding: changed tiles are enough (core DIRTY-TILE
    // SCANNING). pageHidden counts up in hideEl, so it stays whole.
    YT.forEachFeedTile(fn, { dirtyOk: true });
  }
  function ytTitle(tile) {
    return YT ? YT.tileTitle(tile) : '';
  }
  function ytChannel(tile) {
    return YT ? YT.tileChannel(tile) : '';
  }
  function ytChannelKey(tile) {
    if (YT) return YT.tileChannelKey(tile);
    const a = tile.querySelector(YT ? YT.CHANNEL_KEY_LINK_SEL : '#channel-name a');
    return channelKeyFromHref(a && a.getAttribute('href'));
  }

  const MUSIC_SELECTORS = [
    'ytmusic-responsive-list-item-renderer',
    'ytmusic-two-row-item-renderer',
    'ytmusic-card-shelf-renderer',
    'ytmusic-playlist-shelf-renderer ytmusic-responsive-list-item-renderer'
  ];
  function musicTitle(tile) {
    const el = tile.querySelector('.title, yt-formatted-string.title, a.yt-formatted-string');
    return el ? (el.textContent || '').trim() : '';
  }
  function musicArtist(tile) {
    const el = tile.querySelector('.subtitle, yt-formatted-string.subtitle, .secondary-flex-columns');
    return el ? (el.textContent || '').trim() : '';
  }

  // ---- hide / unhide + stats ----
  let pendingHidden = 0;
  let statsTimer = null;
  function scheduleStats() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      if (pendingHidden <= 0) return;
      const delta = pendingHidden;
      pendingHidden = 0;
      // Send an atomic increment to the service worker so concurrent tabs don't race.
      // The SW does a serialized read-modify-write; content scripts never write stats directly.
      chrome.runtime.sendMessage({ type: 'UNSYNTH/STATS/INCR', delta }, () => {
        if (chrome.runtime.lastError) {
          // Fallback: write directly if SW is unavailable (e.g. during dev reload)
          chrome.storage.sync.get({ stats: { hidden: 0 } }, (d) => {
            const stats = d.stats || { hidden: 0 };
            stats.hidden = (stats.hidden || 0) + delta;
            chrome.storage.sync.set({ stats });
          });
        }
      });
    }, 1500);
  }
  function hideEl(el) {
    if (el.dataset.unsynth) return;
    el.dataset.unsynth = '1';
    el.classList.add(settings.mode === 'blur' ? 'unsynth-blur' : 'unsynth-hidden');
    pendingHidden++;
    pageHidden++;
    scheduleStats();
  }

  // ---- label mode: badge a matching tile as AI instead of hiding it ----
  function badgeReasonText(info) {
    switch (info && info.reason) {
      case 'community':
        return 'On the community AiSList (' + (info.value || 'flagged') + ')';
      case 'channel':
        return 'Channel is on your block list';
      case 'channel-keyword':
        return 'Channel name matches an AI keyword' + (info.value ? ' ("' + info.value + '")' : '');
      case 'score':
        // Spell out exactly WHICH signals fired and how much confidence they
        // add up to, so a flagged tile can be judged rather than just trusted.
        return (
          (info.reasons && info.reasons.length ? info.reasons.join('; ') : 'Matched AI signals') +
          ' — confidence ' + (info.score != null ? info.score + '%' : 'unknown')
        );
      default:
        return 'Title matches an AI keyword' + (info && info.value ? ' ("' + info.value + '")' : '');
    }
  }
  function tileThumb(tile) {
    return (YT && YT.TILE_THUMB_SEL && tile.querySelector(YT.TILE_THUMB_SEL)) || tile;
  }
  function labelTile(tile, info) {
    if (tile.dataset.unsynthLabel === '1') return;
    tile.dataset.unsynthLabel = '1';
    tile.classList.add('unsynth-labeled');
    const thumb = tileThumb(tile);
    try {
      if (thumb && thumb !== tile && getComputedStyle(thumb).position === 'static') {
        thumb.style.position = 'relative';
      }
    } catch (e) {
      /* detached node */
    }
    const badge = document.createElement('span');
    const level = (info && info.level) || 'high';
    badge.className = 'unsynth-ai-badge lvl-' + level;
    badge.setAttribute('aria-label', 'Unsynth: ' + badgeReasonText(info));
    badge.title = 'Unsynth — likely AI: ' + badgeReasonText(info);
    const dot = document.createElement('span');
    dot.className = 'unsynth-ai-badge-dot';
    dot.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span');
    txt.textContent = info && typeof info.score === 'number' ? 'AI ' + info.score + '%' : 'AI';
    badge.append(dot, txt);
    if (info && typeof info.score === 'number') badge.dataset.unScore = String(info.score);
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    if (thumb && thumb !== tile) {
      thumb.appendChild(badge);
    } else {
      const container = tile.querySelector(YT ? YT.TILE_THUMB_BADGE_HOST_SEL : 'img') || tile;
      try {
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      } catch (e) {}
      container.appendChild(badge);
    }
    publishBadgeWidth(tile, badge);
  }
  // The head strip's checkbox starts where this badge ends (playlist-bulk.css),
  // and the badge sizes to its text ("AI 30%" vs "AI 100%"). Same contract as
  // --un-taste-w: measured after paint, set on the TILE, the nearest element
  // both the badge and the checkbox's overlay inherit from.
  function publishBadgeWidth(tile, badge) {
    requestAnimationFrame(() => {
      const w = Math.round(badge.getBoundingClientRect().width);
      if (w > 0 && badge.isConnected) tile.style.setProperty('--un-ai-w', w + 'px');
    });
  }
  function unlabelTile(tile) {
    if (tile.dataset.unsynthLabel !== '1') return;
    delete tile.dataset.unsynthLabel;
    tile.classList.remove('unsynth-labeled');
    tile.querySelectorAll('.unsynth-ai-badge').forEach((b) => b.remove());
    tile.style.removeProperty('--un-ai-w');
  }
  // Route a matched tile to the configured display mode.
  function applyTileAction(tile, info) {
    if (settings.mode === 'label') {
      labelTile(tile, info);
    } else {
      hideEl(tile);
    }
  }
  function clearAll() {
    document.querySelectorAll('[data-unsynth]').forEach((el) => {
      delete el.dataset.unsynth;
      el.classList.remove('unsynth-blur', 'unsynth-hidden', 'unsynth-summary');
    });
    // Drop the per-tile score memo too. The epoch key in scoreEpoch() already
    // invalidates it on a settings change, but clearAll() is also the "start
    // over from nothing" path (peek toggled, module re-enabled), and leaving
    // stale memos behind there would keep tiles from being re-evaluated.
    document.querySelectorAll('[data-unsynth-scored]').forEach((el) => {
      delete el.dataset.unsynthScored;
    });
    document.querySelectorAll('[data-unsynth-label]').forEach((el) => unlabelTile(el));
    document.querySelectorAll('.unsynth-ai-badge').forEach((b) => b.remove());
  }

  // ---- AI summaries / shelves ----
  let lastSummaryPass = 0;
  function hideSummaries() {
    if (!settings.hideSummaries) return;
    // Layout-forcing; coalesce to at most once per 2s while the player mutates.
    const now = Date.now();
    if (now - lastSummaryPass < 2000) return;
    lastSummaryPass = now;
    const phrases = (AI_KW && AI_KW.SUMMARY_PHRASES) || ['ai-generated', 'ai generated', 'generated by ai', 'ai summary'];
    document
      .querySelectorAll(YT ? YT.WATCH_AI_SUMMARY_SEL : '[class*="generative-summary"]')
      .forEach((el) => {
        if (el.dataset.unsynth) return;
        // textContent avoids forced layout that innerText triggers
        const text = lc(el.textContent || '');
        const byPhrase = phrases.some((p) => text.includes(p));
        const byStructure =
          YT &&
          YT.WATCH_AI_TRANSCRIPT_SEL &&
          el.matches(YT.WATCH_AI_TRANSCRIPT_SEL) &&
          el.querySelector('[class*="generative"], [class*="Generative"]');
        if (byPhrase || byStructure) {
          el.dataset.unsynth = '1';
          el.classList.add('unsynth-hidden');
        }
      });
  }

  // Minimum confidence (0–100) before a tile counts as AI. Below this the
  // signals are too weak to act on. See scoreVideo() in shared/ai-keywords.js
  // for the weighting; 45 sits deliberately above a single "weak" hit so one
  // topical mention of ChatGPT/Sora no longer flags ordinary commentary — the
  // reported false-positive class.
  function minScore() {
    const n = Number(settings.minScore);
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : 45;
  }

  // Every input that can change a tile's verdict, folded into one short string.
  // The per-tile score memo in scanImpl() is keyed on this, so any settings
  // change re-scores the whole feed on the next pass instead of serving a stale
  // verdict. Deliberately covers the community list and the subscribed-channel
  // allowlist too: both arrive asynchronously after first paint, and a memo that
  // ignored them would freeze the pre-load answer in place.
  function scoreEpoch() {
    const kw = settings.keywords || [];
    const ch = settings.channels || [];
    return [
      settings.mode || '',
      minScore(),
      settings.useRegex ? 1 : 0,
      kw.length,
      ch.length,
      settings.allowSubscribedChannels ? 1 : 0,
      subscribedCacheReady ? (subscribedCache.keys || []).length : -1,
      communityOn() ? (aiSet ? aiSet.size : 0) : -1
    ].join(':');
  }

  function tileShouldHide(title, channel, chKey) {
    if (isAllowedChannel(channel, chKey)) return { hit: false };

    // The community AiSList and the user's own block list are explicit human
    // judgements — they outrank any heuristic and always score 100.
    if (chKey && isOnCommunityList(chKey)) {
      return { hit: true, reason: 'community', value: channel || chKey, score: 100, level: 'high' };
    }

    // User-supplied custom keywords keep their original all-or-nothing
    // behaviour: the user typed them, so a match is intent, not a guess.
    const custom = settings.keywords && settings.keywords.length ? matchInfo(title, channel) : { hit: false };
    if (custom.hit) return Object.assign({ score: 100, level: 'high' }, custom);

    // Built-in heuristics, weighted.
    const AK = window.UNAIKeywords;
    if (AK && AK.scoreVideo) {
      const s = AK.scoreVideo({ title: title, channelTitle: channel });
      if (s.score >= minScore()) {
        return {
          hit: true,
          reason: 'score',
          value: (s.matched && s.matched[0]) || '',
          score: s.score,
          level: s.level,
          reasons: s.reasons
        };
      }
      return { hit: false, score: s.score, level: s.level };
    }

    // Fallback if the shared helper failed to load — original behaviour.
    const m = matchInfo(title, channel);
    if (m.hit) return m;
    if (channel && matcher && matcher.titleMatch) {
      const cn = matcher.titleMatch(channel);
      if (cn.hit) return { hit: true, reason: 'channel-keyword', value: cn.value };
    }
    return { hit: false };
  }

  // True once we've revealed everything for the current YT Default peek, so the
  // observer-driven scans don't re-run clearAll() on every mutation. New tiles
  // loaded mid-peek are simply never hidden (scanImpl returns before hiding).
  let defaultCleared = false;
  function scanImpl() {
    // YT Default peek: reveal everything on feeds, skip hiding this pass.
    if (defaultFeedOn()) {
      if (!defaultCleared) {
        clearAll();
        pageHidden = 0;
        defaultCleared = true;
      }
      return;
    }
    defaultCleared = false;
    if (!active()) return;
    const fallback = pageSurface();

    const labelMode = settings.mode === 'label';

    if (IS_MUSIC) {
      if (!surfaceEnabled('music')) return;
      for (const sel of MUSIC_SELECTORS) {
        document.querySelectorAll(sel).forEach((tile) => {
          if (tile.dataset.unsynth) return;
          const title = musicTitle(tile);
          const artist = musicArtist(tile);
          if (!title && !artist) {
            if (labelMode) unlabelTile(tile);
            return;
          }
          const m = matchInfo(title, artist);
          if (labelMode) {
            if (m.hit) labelTile(tile, m);
            else unlabelTile(tile);
          } else if (m.hit) {
            hideEl(tile);
          }
        });
      }
      return;
    }

    const scoredKey = scoreEpoch();
    forEachTile((tile) => {
      if (tile.dataset.unsynth) return;
      const surface = surfaceForTile(tile, fallback);
      if (!surfaceEnabled(surface)) {
        if (labelMode) unlabelTile(tile);
        return;
      }
      const title = ytTitle(tile);
      const channel = ytChannel(tile);
      const chKey = ytChannelKey(tile);
      if (!title && !channel && !chKey) return;
      // Skip re-scoring a tile that has already been scored against this exact
      // content and this exact settings epoch. Previously the only memo was
      // `data-unsynth`, which is set solely when a tile is HIDDEN (see hideEl),
      // so every tile that did NOT match — the overwhelming majority on any
      // normal feed — was fully re-scored on every scan, and the scan re-runs
      // on every debounced mutation. On a long channel feed that meant
      // scoreVideo() over hundreds of tiles continuously while scrolling, which
      // measured as the single most expensive module on the page (776ms total,
      // p95 50ms, against watchHistory's 176ms / 13ms).
      //
      // The key includes the title/channel, not just the node, because YouTube
      // virtualizes its feeds and recycles a tile element for a different video
      // — keying on the node alone would pin a stale verdict to the new
      // content. It includes the settings epoch so changing keywords, mode or
      // threshold re-scores everything, which is what onSettings already
      // forces via clearAll().
      const memo = scoredKey + '\u0000' + title + '\u0000' + (channel || chKey || '');
      if (tile.dataset.unsynthScored === memo) return;
      tile.dataset.unsynthScored = memo;
      const info = tileShouldHide(title, channel, chKey);
      if (labelMode) {
        // Reconcile every pass so recycled (virtual-scroll) tiles never keep a
        // stale badge from the previous video that occupied the node.
        if (info.hit) labelTile(tile, info);
        else unlabelTile(tile);
      } else if (info.hit) {
        applyTileAction(tile, info);
      }
    });
    hideSummaries();
  }

  // ---- watch-page playback blocking ----
  const isWatch = () => (YT ? YT.isWatchPage(location.pathname) : (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.startsWith('/shorts/'));
  function watchTitle() {
    const h = document.querySelector(YT ? YT.WATCH_TITLE_HEADING_SEL : 'h1');
    return h ? h.textContent.trim() : document.title.replace(/ - YouTube(?: Shorts)?$/, '');
  }
  function watchChannelHref() {
    const a = document.querySelector(YT ? YT.WATCH_CHANNEL_LINK_SEL : '#owner a');
    return a ? a.getAttribute('href') : '';
  }
  function watchChannelKey() {
    return channelKeyFromHref(watchChannelHref());
  }
  function hasSyntheticDisclosure() {
    if (!settings.respectDisclosure) return false;
    const phrases = (AI_KW && AI_KW.DISCLOSURE_PHRASES) || ['altered or synthetic content'];
    const containers = (YT && YT.WATCH_DISCLOSURE_HOST_SEL
      ? YT.WATCH_DISCLOSURE_HOST_SEL.split(/\s*,\s*/)
      : ['#description']
    ).map((sel) => document.querySelector(sel));
    if (containers.some((c) => c && AI_KW && AI_KW.disclosureInText(c.textContent))) return true;
    return containers.some((c) => c && phrases.some((p) => lc(c.textContent).includes(p)));
  }

  let overlayShown = false;
  function pauseVideo() {
    const v = document.querySelector('video');
    if (v) {
      try {
        v.pause();
      } catch (e) {
        /* ignore */
      }
    }
  }
  function onPlayWhileBlocked() {
    if (overlayShown) pauseVideo();
  }
  let overlayEscHandle = null;
  let scanEscHandle = null;
  function removeOverlay() {
    overlayShown = false;
    overlayKey = '';
    if (overlayEscHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(overlayEscHandle);
      overlayEscHandle = null;
    }
    const ov = document.getElementById('unsynth-overlay');
    if (ov) ov.remove();
    const v = document.querySelector('video');
    if (v) v.removeEventListener('play', onPlayWhileBlocked);
  }
  let overlayKey = '';
  function overlayWhy(info) {
    return info.reason === 'disclosure'
      ? 'This video is flagged for altered or synthetic narration/voice.'
      : info.reason === 'community'
        ? 'This channel is on the community AiSList (' + (info.value || 'blocked') + ').'
        : info.reason === 'channel'
          ? `This channel is on your block list ("${info.value}").`
          : info.reason === 'channel-keyword'
            ? `The channel name matched an AI keyword ("${info.value}").`
            : `The title matched an AI keyword ("${info.value}").`;
  }
  function showOverlay(info) {
    const key = info.reason + '|' + (info.value || '');
    // If an overlay is already up (e.g. carried over from the previous video
    // during an SPA navigation), refresh its reason text instead of leaving the
    // stale one — otherwise it can name the wrong channel/reason.
    const existing = document.getElementById('unsynth-overlay');
    if (overlayShown && existing) {
      if (key !== overlayKey) {
        const stale = existing.querySelector('.unsynth-why');
        if (stale) stale.textContent = overlayWhy(info);
        overlayKey = key;
      }
      pauseVideo();
      return;
    }
    const player = document.querySelector('#movie_player') || document.querySelector(YT ? YT.YTD_PLAYER_SEL : '#player');
    if (!player) return;
    if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
    pauseVideo();
    overlayShown = true;
    overlayKey = key;
    const why = overlayWhy(info);
    // Built with DOM methods (not innerHTML) so it's safe under YouTube's
    // Trusted Types CSP.
    const ov = document.createElement('div');
    ov.id = 'unsynth-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Video blocked by Unsynth');
    const card = document.createElement('div');
    card.className = 'unsynth-card';
    const badge = document.createElement('div');
    badge.className = 'unsynth-badge';
    badge.textContent = 'Hidden by Unsynth';
    const whyEl = document.createElement('p');
    whyEl.className = 'unsynth-why';
    whyEl.textContent = why;
    const actions = document.createElement('div');
    actions.className = 'unsynth-actions';
    const watchBtn = document.createElement('button');
    watchBtn.id = 'unsynth-watch-anyway';
    watchBtn.textContent = 'Watch anyway';
    const notAiBtn = document.createElement('button');
    notAiBtn.id = 'unsynth-not-ai';
    notAiBtn.textContent = '✓ Not AI — never flag';
    notAiBtn.title = 'This channel was flagged by mistake — allow it and stop flagging it';
    const blockBtn = document.createElement('button');
    blockBtn.id = 'unsynth-block-channel';
    blockBtn.textContent = 'Block AI channel';
    const backBtn = document.createElement('button');
    backBtn.id = 'unsynth-back';
    backBtn.textContent = 'Go back';
    actions.append(watchBtn, notAiBtn, blockBtn, backBtn);
    card.append(badge, whyEl, actions);
    ov.appendChild(card);
    player.appendChild(ov);
    if (window.UNSYNTH && window.UNSYNTH.pushPanel) {
      overlayEscHandle = window.UNSYNTH.pushPanel(removeOverlay);
    }
    try { watchBtn.focus(); } catch (e) { /* ignore */ }
    watchBtn.addEventListener('click', removeOverlay);
    notAiBtn.addEventListener('click', () => {
      const ch = watchChannel();
      notAiBtn.disabled = true;
      notAiBtn.textContent = 'Allowed ✓';
      addChannelToAllowList(ch, () => {
        removeOverlay();
        clearAll();
        pageHidden = 0;
        scanImpl();
      });
    });
    blockBtn.addEventListener('click', () => {
      const ch = watchChannel();
      if (!ch) return;
      addChannelToBlockList(ch, () => {
        removeOverlay();
        clearAll();
        pageHidden = 0;
        scanImpl();
      });
    });
    backBtn.addEventListener('click', () => {
      if (history.length > 1) history.back();
      else location.assign('https://www.youtube.com');
    });
    const v = document.querySelector('video');
    if (v) v.addEventListener('play', onPlayWhileBlocked);
  }
  // The NAME (yt-dom.watchChannelName). Reading the first link's text got
  // the avatar's "" and disabled Block channel on every watch page
  // (measured 2026-09-22, 3 of 3 videos).
  function watchChannel() {
    return YT && YT.watchChannelName ? YT.watchChannelName() : '';
  }

  // #upload-info (inside ytd-video-owner-renderer) is a flex-direction:column
  // container holding just the channel name + subscriber count — confirmed
  // live. Appending here puts the button on its own line below that text,
  // matching the CSS's own stated intent ("lives below channel name").
  // #owner itself (the fallback path below) is a flex ROW shared with the
  // Join button and the subscribe-bell dropdown — inserting there via
  // insertAdjacentElement('afterend', ...) was confirmed live to land the
  // button crammed between Join and the bell as a fourth row item instead,
  // not on a wrapped line (that row has no flex-wrap), despite the CSS
  // already carrying a margin-top meant for a line that never actually
  // wrapped. See docs/LESSONS.md.
  function findWatchInfoColumn() {
    return document.querySelector('#upload-info');
  }
  function findWatchActionRow() {
    // Fallback only — used when #upload-info isn't present (Shorts' reel
    // header has a different structure not yet verified against this same
    // column layout, so it keeps the original insertion point).
    return (
      document.querySelector(YT ? YT.WATCH_OWNER_RENDERER_SEL : '#owner') ||
      document.querySelector(YT ? YT.WATCH_REEL_HEADER_SEL : '#owner') ||
      document.querySelector('#owner')
    );
  }

  function isChannelBlocked(name) {
    if (!name) return false;
    const low = lc(name);
    return (settings.channels || []).some((c) => lc(c) === low);
  }

  function addChannelToBlockList(channel, cb) {
    if (!channel) {
      cb && cb(false);
      return;
    }
    chrome.storage.sync.get({ channels: [] }, (d) => {
      const channels = d.channels || [];
      const have = new Set(channels.map((c) => lc(c)));
      if (have.has(lc(channel))) {
        cb && cb(true);
        return;
      }
      channels.push(channel);
      chrome.storage.sync.set({ channels }, () => {
        // The block list is the one setting that grows forever, so it is the one
        // that eventually trips chrome.storage.sync's 8 KB per-item quota. On
        // failure the write did NOT land — don't mirror it into the live
        // settings, or the channel looks blocked until the next page load.
        const err = chrome.runtime.lastError;
        if (err) {
          core && core.reportError('aiFilter.blockList', err);
          if (core && core.showToast) {
            core.showToast(
              /quota/i.test(String(err.message || ''))
                ? 'Block list is full (browser sync limit) — remove some channels in the dashboard.'
                : 'Could not save the block list.',
              { duration: 5000 }
            );
          }
          cb && cb(false);
          return;
        }
        settings.channels = channels;
        if (core) core.settings.channels = channels;
        rebuildMatcher();
        scanImpl();
        updateWatchBlockButton();
        cb && cb(true);
      });
    });
  }

  // Mark a wrongly-flagged channel as NOT AI — add it to the allow list so it's
  // never flagged again (the "false accusation" fix, e.g. a real publisher
  // caught by a keyword). Allowed channels short-circuit isAllowedChannel().
  function addChannelToAllowList(channel, cb) {
    if (!channel) {
      cb && cb(false);
      return;
    }
    chrome.storage.sync.get({ allowedChannels: [] }, (d) => {
      const allowed = d.allowedChannels || [];
      const have = new Set(allowed.map((c) => lc(c)));
      if (have.has(lc(channel))) {
        cb && cb(true);
        return;
      }
      allowed.push(channel);
      chrome.storage.sync.set({ allowedChannels: allowed }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          core && core.reportError('aiFilter.allowList', err);
          if (core && core.showToast) core.showToast('Could not save the allow list.', { duration: 5000 });
          cb && cb(false);
          return;
        }
        settings.allowedChannels = allowed;
        if (core) core.settings.allowedChannels = allowed;
        rebuildMatcher();
        scanImpl();
        cb && cb(true);
      });
    });
  }

  let watchBlockTimer = null;
  let watchBlockObs = null;

  function updateWatchBlockButton() {
    const btn = document.getElementById('un-watch-blockbtn');
    if (!btn) return;
    const ch = watchChannel();
    const blocked = isChannelBlocked(ch);
    btn.disabled = blocked || !ch;
    btn.classList.toggle('on', blocked);
    // Icon-only when blocked (a small checkmark); icon + label when not blocked
    if (blocked) {
      btn.innerHTML = '<span class="un-wbb-icon" aria-hidden="true">✓</span>';
      btn.setAttribute('aria-label', ch + ' is blocked');
      btn.title = ch + ' is in your block list — AI-style content hidden';
    } else {
      btn.innerHTML =
        '<span class="un-wbb-icon" aria-hidden="true">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>' +
        '</span>' +
        '<span class="un-wbb-label">Block channel</span>';
      btn.setAttribute('aria-label', 'Block ' + (ch || 'channel') + ' from AI filter');
      btn.title = ch
        ? 'Block ' + ch + ' — hide AI-narration & synthetic content from this channel'
        : 'Open a video to block its channel';
    }
  }

  function removeWatchBlockButton() {
    if (watchBlockTimer) {
      clearTimeout(watchBlockTimer);
      watchBlockTimer = null;
    }
    const btn = document.getElementById('un-watch-blockbtn');
    if (btn) btn.remove();
  }

  function ensureWatchBlockButton() {
    if (!isWatch() || IS_MUSIC) {
      removeWatchBlockButton();
      return;
    }
    if (core && !core.isModuleEnabled(mod)) {
      removeWatchBlockButton();
      return;
    }
    let btn = document.getElementById('un-watch-blockbtn');
    const infoColumn = findWatchInfoColumn();
    const host = infoColumn || findWatchActionRow();
    if (!host) return;
    const place = infoColumn
      ? function () {
          infoColumn.appendChild(btn);
        }
      : function () {
          host.insertAdjacentElement('afterend', btn);
        };
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'un-watch-blockbtn';
      btn.type = 'button';
      btn.className = 'un-watch-blockbtn';
      btn.addEventListener('click', () => {
        const ch = watchChannel();
        if (!ch || isChannelBlocked(ch)) return;
        btn.disabled = true;
        btn.innerHTML = '<span class="un-wbb-icon" aria-hidden="true">…</span>';
        addChannelToBlockList(ch, (ok) => {
          if (!ok) updateWatchBlockButton();
        });
      });
      place();
    } else if (!document.contains(btn)) {
      place();
    }
    updateWatchBlockButton();
  }

  function scheduleWatchBlockButton() {
    if (!isWatch() || IS_MUSIC) return;
    if (watchBlockTimer) clearTimeout(watchBlockTimer);
    watchBlockTimer = setTimeout(function () {
      watchBlockTimer = null;
      ensureWatchBlockButton();
    }, 150);
  }

  function ensureWatchBlockObserver() {
    if (watchBlockObs) return;
    watchBlockObs = new MutationObserver(scheduleWatchBlockButton);
    const targets = [
      document.querySelector('#above-the-fold'),
      document.querySelector('#actions'),
      document.querySelector('#actions-inner'),
      document.querySelector(YT ? YT.WATCH_METADATA_SEL : '#above-the-fold')
    ].filter(Boolean);
    if (!targets.length) {
      watchBlockObs.observe(document.documentElement, { childList: true, subtree: true });
      return;
    }
    targets.forEach(function (t) {
      watchBlockObs.observe(t, { childList: true, subtree: true });
    });
  }

  function stopWatchBlockObserver() {
    if (watchBlockTimer) {
      clearTimeout(watchBlockTimer);
      watchBlockTimer = null;
    }
    if (watchBlockObs) {
      watchBlockObs.disconnect();
      watchBlockObs = null;
    }
    removeWatchBlockButton();
  }

  function evaluateWatch() {
    if (!active() || IS_MUSIC || !isWatch()) {
      removeOverlay();
      return;
    }
    if (!settings.blockPlayback) return;
    const title = watchTitle();
    const channel = watchChannel();
    const chKey = watchChannelKey();
    if (isAllowedChannel(channel, chKey)) {
      removeOverlay();
      return;
    }
    const m = matchInfo(title, channel);
    if (m.hit) return showOverlay(m);
    if (chKey && isOnCommunityList(chKey)) return showOverlay({ reason: 'community', value: channel || chKey });
    if (channel && matcher && matcher.titleMatch) {
      const cn = matcher.titleMatch(channel);
      if (cn.hit) return showOverlay({ hit: true, reason: 'channel-keyword', value: cn.value });
    }
    if (hasSyntheticDisclosure()) return showOverlay({ reason: 'disclosure' });
    removeOverlay();
  }

  function reasonSummary(reasons) {
    const parts = [];
    if (reasons.community) parts.push('AiSList');
    if (reasons.title) parts.push(reasons.title + ' AI title' + (reasons.title > 1 ? 's' : ''));
    if (reasons['channel-name']) parts.push('AI-style channel name');
    if (reasons.blocked) parts.push('on your block list');
    return parts.join(' · ') || 'matched';
  }

  // ---- AI-channel scan: score channels on the current page ----
  function scanAiChannels() {
    const blocked = new Set((settings.channels || []).map((c) => lc(c)));
    const byChannel = {};
    forEachTile((tile) => {
      const channel = ytChannel(tile);
      const title = ytTitle(tile);
      const chKey = ytChannelKey(tile);
      if (!channel && !chKey) return;
      const name = channel || chKey;
      const rec = byChannel[name] || (byChannel[name] = { hits: 0, total: 0, samples: [], reasons: {}, chKey: chKey || '' });
      rec.total++;
      let flagged = false;
      const tm = matcher && matcher.titleMatch ? matcher.titleMatch(title) : matchInfo(title, '');
      if (tm.hit && tm.reason === 'keyword') {
        rec.hits++;
        rec.reasons.title = (rec.reasons.title || 0) + 1;
        flagged = true;
        if (rec.samples.length < 2 && rec.samples.indexOf(title) === -1) rec.samples.push(title);
      }
      const cm = matchInfo('', channel);
      if (cm.hit && cm.reason === 'channel') {
        rec.hits++;
        rec.reasons.blocked = (rec.reasons.blocked || 0) + 1;
        flagged = true;
      }
      if (channel && matcher && matcher.titleMatch) {
        const ckw = matcher.titleMatch(channel);
        if (ckw.hit) {
          if (!flagged) rec.hits++;
          rec.reasons['channel-name'] = (rec.reasons['channel-name'] || 0) + 1;
          flagged = true;
        }
      }
      if (chKey && isOnCommunityList(chKey)) {
        if (!flagged) rec.hits++;
        rec.reasons.community = (rec.reasons.community || 0) + 1;
      }
    });
    return Object.keys(byChannel)
      .filter((name) => {
        const r = byChannel[name];
        if (blocked.has(lc(name))) return false;
        if (r.reasons.community) return true;
        return r.hits > 0;
      })
      .map((name) => {
        const r = byChannel[name];
        return { channel: name, hits: r.hits, total: r.total, samples: r.samples, reasons: r.reasons, chKey: r.chKey };
      })
      .sort((a, b) => b.hits - a.hits || (b.reasons.community || 0) - (a.reasons.community || 0));
  }

  function showScanOverlay(flagged) {
    const old = document.getElementById('unsynth-scan');
    if (old) old.remove();
    if (scanEscHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(scanEscHandle);
      scanEscHandle = null;
    }
    const closeScan = () => {
      if (scanEscHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
        window.UNSYNTH.popPanel(scanEscHandle);
        scanEscHandle = null;
      }
      const n = document.getElementById('unsynth-scan');
      if (n) n.remove();
    };
    const ov = document.createElement('div');
    ov.id = 'unsynth-scan';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'AI channel scan');
    const card = document.createElement('div');
    card.className = 'un-scan-card';
    const h = document.createElement('div');
    h.className = 'un-scan-h';
    h.textContent = flagged.length ? 'AI scan — ' + flagged.length + ' channel' + (flagged.length === 1 ? '' : 's') + ' flagged here' : 'AI scan — nothing flagged on this page';
    card.appendChild(h);
    const sub = document.createElement('div');
    sub.className = 'un-scan-sub';
    sub.textContent = flagged.length
      ? 'Channels flagged by AI titles, AI-style names, your block list, or the community AiSList. Uncheck any to keep, then add the rest. Scroll and scan again for more.'
      : 'No AI signals on visible videos. Scroll to load more, try Subscriptions or Home, then scan again.';
    card.appendChild(sub);

    const list = document.createElement('div');
    list.className = 'un-scan-list';
    flagged.forEach((f) => {
      const row = document.createElement('label');
      row.className = 'un-scan-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.value = f.channel;
      const main = document.createElement('div');
      main.className = 'un-scan-main';
      const name = document.createElement('div');
      name.className = 'un-scan-name';
      name.textContent = f.channel;
      const meta = document.createElement('div');
      meta.className = 'un-scan-meta';
      meta.textContent = f.hits + ' of ' + f.total + ' shown · ' + reasonSummary(f.reasons || {});
      main.appendChild(name);
      main.appendChild(meta);
      if (f.samples[0]) {
        const s = document.createElement('div');
        s.className = 'un-scan-sample';
        s.textContent = '“' + f.samples[0] + '”';
        main.appendChild(s);
      }
      row.appendChild(cb);
      row.appendChild(main);
      list.appendChild(row);
    });
    card.appendChild(list);

    const bar = document.createElement('div');
    bar.className = 'un-scan-bar';
    const addBtn = document.createElement('button');
    addBtn.className = 'un-scan-add';
    addBtn.textContent = 'Add selected to block list';
    addBtn.disabled = !flagged.length;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'un-scan-close';
    closeBtn.textContent = 'Close';
    bar.appendChild(addBtn);
    if (flagged.length) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'un-scan-close';
      toggleBtn.textContent = 'Uncheck all';
      toggleBtn.addEventListener('click', () => {
        const cbs = list.querySelectorAll('input[type=checkbox]');
        const anyChecked = Array.prototype.some.call(cbs, (c) => c.checked);
        cbs.forEach((c) => (c.checked = !anyChecked));
        toggleBtn.textContent = anyChecked ? 'Check all' : 'Uncheck all';
      });
      bar.appendChild(toggleBtn);
    }
    const note = document.createElement('span');
    note.className = 'un-scan-note';
    bar.appendChild(closeBtn);
    bar.appendChild(note);
    card.appendChild(bar);
    ov.appendChild(card);
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeScan();
    });
    document.body.appendChild(ov);
    if (window.UNSYNTH && window.UNSYNTH.pushPanel) {
      scanEscHandle = window.UNSYNTH.pushPanel(closeScan);
    }
    try { closeBtn.focus(); } catch (e) { /* ignore */ }

    closeBtn.addEventListener('click', closeScan);
    addBtn.addEventListener('click', () => {
      const picked = Array.prototype.slice.call(list.querySelectorAll('input:checked')).map((c) => c.value);
      if (!picked.length) {
        note.textContent = 'Nothing selected';
        return;
      }
      chrome.storage.sync.get({ channels: [] }, (d) => {
        const channels = d.channels || [];
        const have = new Set(channels.map((c) => lc(c)));
        let added = 0;
        picked.forEach((name) => {
          if (!have.has(lc(name))) {
            channels.push(name);
            added++;
          }
        });
        chrome.storage.sync.set({ channels }, () => {
          note.textContent = 'Added ' + added + ' to block list';
          addBtn.disabled = true;
          setTimeout(() => closeScan(), 1300);
        });
      });
    });
  }

  // ---- module interface ----
  const mod = {
    id: 'aiFilter',
    moduleKey: 'aiFilter',
    init(c) {
      core = c;
      settings = c.settings;
      // Build matcher now with the real settings provided by core — this is the
      // definitive initialization (replaces the placeholder null set at parse time).
      rebuildMatcher();
      loadSubscribedCache(() => {
        mergeGuideSubsIntoCache();
        maybeRefreshSubscribedCache();
        loadAiSet(() => {
          scanImpl();
          setTimeout(function () {
            evaluateWatch();
            ensureWatchBlockButton();
            ensureWatchBlockObserver();
          }, 400);
        });
      });
      // "YT Default" peek toggled in the masthead — reset the clear flag and
      // re-run: scanImpl reveals (clearAll, once) when on, or re-hides when off.
      onDefaultFeedChanged = () => {
        defaultCleared = false;
        scanImpl();
      };
      document.addEventListener('unsynth-default-feed-changed', onDefaultFeedChanged);
      onStorageChanged = (ch, area) => {
        if (area === 'local' && ch.aislist) {
          loadAiSet(() => {
            scanImpl();
            evaluateWatch();
          });
        }
        if (area === 'local' && (ch.subscribedChannelCache || ch.subscribedChannelsOAuthUpdated || ch.subscribedChannelsUpdated)) {
          loadSubscribedCache(() => {
            scanImpl();
            evaluateWatch();
          });
        }
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
    },
    scan() {
      settings = core.settings;
      // Guide scrape is for navigate/init — not every MutationObserver pass.
      scanImpl();
      if (isWatch()) scheduleWatchBlockButton();
    },
    onNavigate() {
      settings = core.settings;
      // Always tear down any stale watch-page observer before re-evaluating on the new URL.
      stopWatchBlockObserver();
      removeOverlay();
      pageHidden = 0;
      mergeGuideSubsIntoCache();
      maybeRefreshSubscribedCache();
      scanImpl();
      setTimeout(function () {
        evaluateWatch();
        ensureWatchBlockButton();
        ensureWatchBlockObserver();
      }, 600);
    },
    onSettings(s) {
      settings = s;
      rebuildMatcher();
      clearAll();
      pageHidden = 0;
      scanImpl();
      evaluateWatch();
      if (core && core.isModuleEnabled(mod) && isWatch()) {
        ensureWatchBlockButton();
        ensureWatchBlockObserver();
      } else {
        stopWatchBlockObserver();
      }
    },
    onMessage(msg, sendResponse) {
      if (msg && msg.type === 'unsynth-ping') {
        try {
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        } catch (e) {
          sendResponse({ ok: false });
        }
        return;
      }
      if (msg && msg.type === 'unsynth-get-context') {
        sendResponse({
          music: IS_MUSIC,
          watch: isWatch(),
          title: IS_MUSIC ? '' : watchTitle(),
          channel: IS_MUSIC ? '' : watchChannel(),
          pageHidden
        });
        return true;
      }
      if (msg && msg.type === 'unsynth-scan-ai') {
        settings = core ? core.settings : settings;
        rebuildMatcher();
        const run = () => {
          const flagged = scanAiChannels();
          showScanOverlay(flagged);
          sendResponse({ ok: true, found: flagged.length });
        };
        if (communityOn() && !aiSet) loadAiSet(run);
        else run();
        return true;
      }
      if (msg && msg.type === 'unsynth-block-channel') {
        const ch = IS_MUSIC ? '' : watchChannel();
        if (!ch) {
          sendResponse({ ok: false, error: 'no_channel' });
          return true;
        }
        addChannelToBlockList(ch, (ok) => {
          sendResponse({ ok: ok, channel: ch });
        });
        return true;
      }
    },
    // Module switched off: un-hide everything and remove the watch-page block UI.
    teardown() {
      if (onDefaultFeedChanged) { document.removeEventListener('unsynth-default-feed-changed', onDefaultFeedChanged); onDefaultFeedChanged = null; }
      if (onStorageChanged) { chrome.storage.onChanged.removeListener(onStorageChanged); onStorageChanged = null; }
      if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
      clearAll();
      stopWatchBlockObserver();
      removeWatchBlockButton();
      removeOverlay();
      if (scanEscHandle && window.UNSYNTH && window.UNSYNTH.popPanel) {
        window.UNSYNTH.popPanel(scanEscHandle);
        scanEscHandle = null;
      }
      const scan = document.getElementById('unsynth-scan');
      if (scan) scan.remove();
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
