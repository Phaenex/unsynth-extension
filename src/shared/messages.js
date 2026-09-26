/**
 * Shared message-type constants. Loaded as a classic script in the service
 * worker (via importScripts), extension pages (via <script>), and content
 * scripts. Attaches UNMSG to the global (self/window).
 */
(function (g) {
  'use strict';
  g.UNMSG = {
    // Auth / OAuth (handled by the service worker)
    AUTH_START: 'UNSYNTH/AUTH/START', // { scopes?: ('readonly'|'write')[] }
    AUTH_STATUS: 'UNSYNTH/AUTH/STATUS',
    AUTH_SIGNOUT: 'UNSYNTH/AUTH/SIGNOUT',
    OAUTH_SET_CONFIG: 'UNSYNTH/AUTH/SET_CONFIG', // { clientId, clientSecret }
    OAUTH_GET_CONFIG: 'UNSYNTH/AUTH/GET_CONFIG',

    // YouTube Data API (proxied through the worker)
    YT_CHANNELS_MINE: 'UNSYNTH/YT/CHANNELS_MINE',
    YT_CHANNEL_NAMES: 'UNSYNTH/YT/CHANNEL_NAMES', // { ids: [channelId...] } -> { names, thumbs }
    YT_SUBSCRIPTIONS_MINE: 'UNSYNTH/YT/SUBSCRIPTIONS_MINE', // -> { subs: [{channelId,title,thumb}] }
    SUBS_CACHE_REFRESH: 'UNSYNTH/SUBS/CACHE_REFRESH', // OAuth fetch -> local subscribedChannelCache
    SUBS_CACHE_MERGE: 'UNSYNTH/SUBS/CACHE_MERGE', // { keys: [] } merge guide-scraped @handles
    YT_PLAYLISTS_MINE: 'UNSYNTH/YT/PLAYLISTS_MINE', // -> { playlists: [{id,title,count,thumb}] }
    YT_PLAYLIST_ITEMS: 'UNSYNTH/YT/PLAYLIST_ITEMS', // { playlistId } -> { items: [{itemId,videoId,title,thumb}] }
    YT_PLAYLIST_ADD: 'UNSYNTH/YT/PLAYLIST_ADD', // { playlistId, videoIds } -> { added, failed }
    YT_WATCH_LATER_ADD: 'UNSYNTH/YT/WATCH_LATER_ADD', // { videoIds } -> { added, failed }
    YT_PLAYLIST_CREATE: 'UNSYNTH/YT/PLAYLIST_CREATE', // { title, description?, videoIds?, privacyStatus? } -> { playlistId, url, added }
    YT_PLAYLIST_REMOVE: 'UNSYNTH/YT/PLAYLIST_REMOVE', // { itemIds } -> { removed, failed }
    YT_PLAYLIST_RENAME: 'UNSYNTH/YT/PLAYLIST_RENAME', // { playlistId, title, privacy? }
    YT_PLAYLIST_REORDER: 'UNSYNTH/YT/PLAYLIST_REORDER', // { itemId, playlistId, videoId, position }
    // playlistItems returns videoPublishedAt under contentDetails, NOT duration,
    // so anything that budgets time over a playlist needs a separate videos.list
    // sweep. 50 ids per call, 1 quota unit each: 2,445 videos is 49 units, about
    // 0.5% of a day. Durations never change, so the cache is permanent.
    YT_VIDEO_DURATIONS: 'UNSYNTH/YT/VIDEO_DURATIONS', // { videoIds } -> { durations: { id: seconds } }
    YT_VIDEO_PLAYLISTS: 'UNSYNTH/YT/VIDEO_PLAYLISTS', // { videoId, playlistIds } -> { inIds: [playlistIds], itemIds: { playlistId: playlistItemId } }
    RYD_VOTES: 'UNSYNTH/RYD/VOTES', // { videoId } -> { ok, likes, dislikes, viewCount, rating }
    QUOTA_GET: 'UNSYNTH/QUOTA/GET',

    // Community AI-channel blocklist (AiSList — github.com/Override92/AiSList)
    AISLIST_SYNC: 'UNSYNTH/AISLIST/SYNC', // fetch + cache the list -> { count, updated }
    AISLIST_GET: 'UNSYNTH/AISLIST/GET', // -> { count, updated }

    // AI (BYOK, multi-provider: OpenRouter / OpenAI / Anthropic)
    AI_CONFIG_GET: 'UNSYNTH/AI/CONFIG_GET',
    AI_CONFIG_SET: 'UNSYNTH/AI/CONFIG_SET', // { provider, model, keys: {openrouter, openai, anthropic} }
    AI_LLM: 'UNSYNTH/AI/LLM', // { system, messages, max_tokens, provider?, model? }

    // Extension lifecycle (handled by the service worker)
    RELOAD_YOUTUBE_TABS: 'UNSYNTH/TABS/RELOAD',
    TAB_RELOAD_STATUS: 'UNSYNTH/TABS/STATUS', // -> { needsTabReload, version }
    OPEN_URL: 'UNSYNTH/OPEN_URL', // { url } — open https link in a tab (content scripts / Atlas)
    OPEN_EXT_PAGE: 'UNSYNTH/OPEN_EXT_PAGE', // { path, hash? } — open/focus an extension page tab
    GUIDE_ENABLE_MODULE: 'UNSYNTH/GUIDE/ENABLE_MODULE', // { key } — switch a watch-guide feature on and load it into the sender's tab
    OPEN_FORGE_PANEL: 'UNSYNTH/FORGE/OPEN_PANEL', // { tab?: 'suggest'|'search'|'page'|'options' }
    FORGE_FETCH: 'UNSYNTH/FORGE/FETCH', // { path, method?, body? } -> { ok, status, data } — SW proxies playlist-forge (content-script fetches hit CORS)
    PROXY_FETCH: 'UNSYNTH/PROXY/FETCH', // { url, method? } -> { ok, status, data } — SW proxies allowlisted hosts (sponsor.ajay.app) past content-script CORS
    POPOUT_OPEN: 'UNSYNTH/POPOUT/OPEN', // { videoId?, listId?, time?, width?, height? }
    VOL_BADGE: 'UNSYNTH/VOL/BADGE', // { gain } — update toolbar badge for active tab
    PLAYLIST_NOTIFY: 'UNSYNTH/PLAYLIST/NOTIFY', // { title, message, url } — desktop notification w/ open link
    PROFILE_APPLY: 'UNSYNTH/PROFILE/APPLY', // run mergeSync + bundled imports if needed
    UPDATE_CHECK: 'UNSYNTH/UPDATE/CHECK', // optional { pat } -> { localVersion, remoteVersion, status, ... }
    UPDATE_FETCH: 'UNSYNTH/UPDATE/FETCH', // download deployed unsynth-latest.zip; unpack/reload remains manual

    // Hidden-gems discovery shelf. Candidate gathering only — all scoring and
    // ranking is local (shared/discover.js). Reads uploads playlists (1 unit)
    // rather than search.list (100 units), so a refresh costs ~15 quota units.
    DISCOVER_CANDIDATES: 'UNSYNTH/DISCOVER/CANDIDATES', // { channelIds, playlistIds?, maxChannels? } -> { videos, quota, degraded }

    // Creator Studio
    CREATOR_KEYWORD_SUGGEST: 'UNSYNTH/CREATOR/KEYWORD_SUGGEST', // { query } -> { suggestions: string[] }
    CREATOR_RANK_CHECK: 'UNSYNTH/CREATOR/RANK_CHECK', // { keyword, videoId } -> { rank|null, inTop50 }

    // Stats counter (ai-filter -> service worker). NOTE: content scripts do not
    // load this file, so ai-filter.js sends the raw string; this entry documents
    // the contract for the service-worker side.
    STATS_INCR: 'UNSYNTH/STATS/INCR', // { delta } — increment hidden-count stat

    // Cross-tab single-playback enforcement (cross-tab-playback.js)
    VIDEO_PLAYING: 'UNSYNTH/PLAYBACK/VIDEO_PLAYING', // content -> SW: { videoId, title }
    PLAYBACK_QUERY: 'UNSYNTH/PLAYBACK/QUERY', // SW -> content: {} -> { playing, videoId, startedAt }
    PLAYBACK_PAUSE: 'UNSYNTH/PLAYBACK/PAUSE', // SW -> content: pause the active player

    // Cross-device watch-history sync (opt-in; dashboard-history-sync.js)
    SYNC_NOW: 'UNSYNTH/SYNC/NOW', // -> { ok, watchedVideos?, watchProgress?, lastSyncAt?, error? }
    QUEUE_SYNC_PUSH: 'UNSYNTH/SYNC/QUEUE_PUSH', // { items, v } -> { ok, items?, v?, stale?, error? }
    QUEUE_SYNC_PULL: 'UNSYNTH/SYNC/QUEUE_PULL', // -> { ok, items?, v?, error? }
    LIBRARY_SYNC_PUSH: 'UNSYNTH/SYNC/LIBRARY_PUSH', // { subs, folders, v } -> { ok, subs?, folders?, v?, stale?, error? }
    LIBRARY_SYNC_PULL: 'UNSYNTH/SYNC/LIBRARY_PULL', // -> { ok, subs?, folders?, v?, error? }
    SYNC_DELETE: 'UNSYNTH/SYNC/DELETE', // turn off + delete server-side synced data -> { ok }

    // Player quality control (quality-lock.js -> SW -> MAIN world).
    // YouTube's player API lives on #movie_player as PAGE-script expando
    // properties, and expandos never cross into a content script's isolated
    // world — so the content script sees the element but none of its methods,
    // permanently. The SW re-enters the tab with world:'MAIN' to make the call
    // where those methods actually exist. See quality-lock.js for the full
    // write-up of the defect this exists to work around.
    PLAYER_SET_QUALITY: 'UNSYNTH/PLAYER/SET_QUALITY' // { min, max } -> { ok, current? }
  };
})(typeof self !== 'undefined' ? self : window);
