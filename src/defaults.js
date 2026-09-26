/**
 * Shared default settings. Loaded both as a content script (where it lives in
 * the extension's isolated world and shares `window` with content.js) and via
 * <script> in the popup/options pages. Single source of truth.
 */
(function () {
  'use strict';
  const UNSYNTH_DEFAULTS = {
    // Suite module switches (which feature areas are active).
    modules: {
      // @unsynth-codegen-modules-begin
      playlistManager: true, // legacy — mirrored by playlistFolders + playlistBulk
      aiFilter: true,
      uiTune: true,
      aiAssistant: false,
      subManager: false,
      playlistFolders: false,
      playlistBulk: false,
      forgeLink: false,
      tasteRank: false,
      queueAdvance: false,
      dislikeRestore: true,
      volumeMaster: false,
      popoutPlayer: false,
      scrollMiniplayer: false,
      factCheck: false,
      descDigest: false,
      analytics: false,
      sponsorBlock: true,
      discoverShelf: false,
      watchHistory: true,
      crossTabPlayback: false,
      qualityLock: true,
      speedChip: false,
      screenshot: false,
      titleCleaner: false, // off by default — opt in; rewrites feed titles
      ambientMode: false,
      adSkip: true,
      deArrow: false,
      shortcuts: false,
      transcriptExport: false,
      abLoop: false,
      tabTitle: false,
      chapters: false,
      searchFilters: false,
      commentFilter: false,
      playlistDebt: false,
      channelCompletion: false,
      clipCapture: false,
      skipSeconds: false,
      liveNow: false,
      quickSwitcher: false
      // @unsynth-codegen-modules-end
    },

    // Popout player — floating window for current video
    popoutPlayer: {
      width: 853,
      height: 480,
      showPlayerButton: true
    },

    // Scroll miniplayer — dock the player into a corner while scrolling the
    // same watch page. Stays docked however far you scroll; it never hands
    // off to YouTube's own native miniplayer, which would navigate away.
    scrollMiniplayer: {
      enabled: true,
      // Off by default: YouTube already ships its own miniplayer button, and
      // ours auto-docks on scroll without needing a bar button at all. The
      // control bar was measured live carrying 480px of Unsynth buttons
      // against YouTube's own 240px — ten of ours at 48px each versus their
      // six — so a button that duplicates a native control AND an automatic
      // behaviour is the clearest 48px to give back. Docking still works;
      // re-enable the button in Settings › Scroll miniplayer.
      showPlayerButton: false
    },

    // Auto Quality Lock — force minimum/exact video quality
    qualityLock: {
      enabled: true,
      // Ask for 4K when the video actually has it. YouTube caps the request at
      // whatever the video offers, so this is "best available up to 4K" rather
      // than a demand that breaks 1080p-only videos.
      quality: '2160p',   // '4320p'|'2160p'|'1440p'|'1080p'|'720p'|'480p'|'360p'|'auto'
      // Off by default: YouTube's own settings gear already contains a
      // Quality row, and the chip cost 48px of the 480px Unsynth footprint
      // measured live against YouTube's 240px of native controls. The lock
      // still applies, and the resolution PICKER moves into the "Unsynth
      // tools" overflow menu (see quality-lock.js syncMenuRow) so hiding
      // the chip hides a duplicate rather than deleting a feature —
      // shift+q toggles the lock, it does not open the picker.
      showChip: false,
      // Adaptive downgrade: if the connection or machine can't sustain the
      // locked quality, step down instead of buffering forever. Measured from
      // the player's own dropped-frame and buffering stats, and it steps back
      // UP once playback has been smooth for a while, so a brief hiccup
      // doesn't permanently pin you to 480p.
      adaptive: true,
      // Consecutive unhealthy checks before dropping a tier. Low enough to
      // react during real stalling, high enough that one blip is ignored.
      adaptiveStrikes: 2,
      // Never drop below this, however bad things get — a "smart" downgrade
      // that lands on 144p is worse than a little buffering.
      adaptiveFloor: '720p'
    },

    // Playback speed chip on the player bar.
    speedChip: {
      // Off by default: YouTube's own settings gear already contains a
      // Playback speed row, and the control bar was measured live carrying
      // 480px of Unsynth buttons against YouTube's 240px of native controls.
      // The module keeps running (it still tracks the real rate however it
      // changes), and the picker moves into the "Unsynth tools" overflow menu
      // — see speed-chip.js syncMenuRow. The [ and ] shortcuts also still
      // nudge speed. Re-enable the chip in Settings › Speed chip.
      showChip: false
    },

    // Video frame screenshot — camera button on player
    screenshot: {
      enabled: true,
      showButton: true,
      includeTimestamp: true
    },

    // Clickbait title cleaner
    titleCleaner: {
      enabled: false,
      deAllCaps: true,
      stripExclamation: true,
      stripEmoji: false
    },

    // Ambient glow — opt-in via the module toggle itself (modules.ambientMode,
    // defaultOn: false in modules.manifest.js). No separate inner enabled
    // flag — see ambient-mode.js's prefs() and docs/LESSONS.md.
    ambientMode: {
      intensity: 0.7,
      radius: 90,
      sampleRate: 2000
    },

    // Ad skip — auto-click YouTube's own skip button, mute non-skippable ads,
    // hide banner/overlay ad slots.
    adSkip: {
      autoSkip: true,
      muteNonSkippable: true,
      hideOverlayAds: true
    },

    // DeArrow — crowd-sourced neutral titles (opt-in; replaces the actual
    // title text, a bigger behavior change than the existing AI title
    // cleaner). Only touches elements where a real submission exists —
    // title-cleaner.js, if separately enabled, naturally keeps cleaning
    // anything DeArrow didn't, with no coupling between the two modules.
    deArrow: {
      titles: true,
      thumbnails: true
    },

    // Comment filter — hide comments matching keywords (word-boundary-aware,
    // same matcher as the AI content filter). Empty by default = no-op.
    commentFilter: {
      keywords: [],
      useRegex: false
    },

    // Clip capture — record a short WebM clip (video + audio) via
    // HTMLVideoElement.captureStream() + MediaRecorder, up to 20s.
    clipCapture: {
      enabled: true
    },

    // Skip seconds — back/forward player buttons that seek by a
    // configurable number of seconds (mirrors what a keyboard shortcut
    // like J/L already does).
    skipSeconds: {
      enabled: true,
      showButtons: true,
      seconds: 10
    },

    // In-page keyboard shortcuts. Bindings are "modifier+key" strings; blank
    // disables that action's hotkey. Native YouTube shortcuts are left alone.
    shortcuts: {
      enabled: true,
      ambientMode: 'shift+a',
      screenshot: 'shift+s',
      qualityLock: 'shift+q',
      speedDown: '[',
      speedUp: ']',
      openDashboard: 'shift+u',
      volumeBoostDown: 'shift+arrowdown',
      volumeBoostUp: 'shift+arrowup',
      // Playlist quick switcher. NOT ctrl+k, which is what this shipped as
      // first: Chrome consumes ctrl+k for address-bar search and the keydown
      // never reaches the page, so the feature was unreachable in the browser
      // it targets. Every binding above is shift-based for the same reason.
      // Unlike them it is not watch-page only — it is how you LEAVE a page.
      quickSwitcher: 'shift+p'
    },

    // Taste ranking — scores the watch-page suggestion rail against the taste
    // profile learned from what you actually watch (src/shared/taste-profile.js).
    tasteRank: {
      enabled: true,
      badges: true, // show the ★ match score on strong suggestions
      reorder: true, // float strong matches to the top of the rail
      // Minimum match score to badge/promote. Below this the overlap is too
      // weak to be worth acting on and promoting it would just be noise.
      minScore: 35
    },

    // Watch queue (src/shared/watch-queue.js) behavior
    watchQueue: {
      autoAdvance: true, // play the next queued video when the current one ends
      // Days an UNWATCHED item may sit before the panel FLAGS it as stale. It
      // is only ever a flag: nothing leaves the queue without the user clicking
      // a button that names the count and shows the titles first. There is
      // deliberately no autoSweep switch here — an automatic version of this
      // shipped once (39b5df3) and silently emptied a real user's queue, so the
      // capability to remove without a gesture does not exist any more.
      //
      // A week still covers "I'll get to it tonight" without letting the queue
      // silt up into a second Watch Later. "Watched" reuses the existing
      // top-level watchedThreshold — deliberately NOT a second number, so the
      // two can never disagree.
      staleDays: 7
    },

    // Catch-up digest — "what did I miss" for one subscription folder, and the
    // smart queue fill that empties it into the watch queue in one action.
    // Both read src/shared/catch-up.js; nothing here hits the network.
    catchUp: {
      // How far back the digest looks. A week matches how most people think
      // about "what did I miss" and keeps a large folder's digest readable.
      days: 7,
      // Shorts are opt-in. A folder of channels that post Shorts daily would
      // otherwise bury the long-form uploads the digest exists to surface.
      includeShorts: false,
      // Default time budget for the queue fill's "fill to N minutes" mode —
      // roughly an evening's watching.
      fillMinutes: 90
    },

    // Per-tab volume boost (Web Audio, up to 600%)
    volumeMaster: {
      boostMax: 600,
      // Off by default: YouTube's own volume slider already lives in the LEFT
      // player controls, and the bar was measured live carrying 480px of
      // Unsynth buttons against YouTube's 240px of native ones. Hiding this
      // button does NOT disable boost — the module keeps running, so per-tab
      // boost up to 600% and the EQ presets stay live, reachable through the
      // inline bar under the video (inlineBar below), the toolbar popup, and
      // the shift+arrow shortcuts. Re-enable in Settings › Volume master.
      showPlayerControl: false,
      inlineBar: true, // always-visible volume + EQ bar under the video
      rememberLevel: true,
      // Starting level for a video when there's no remembered level to restore
      // (rememberLevel off, or the first video of a fresh profile). YouTube
      // itself starts at 100%, which is jarringly loud on most setups.
      // Configurable in Settings › Volume master.
      defaultLevel: 50,
      // Off until the user picks EQ/boost — avoids createMediaElementSource on load
      audioPreset: 'cinematic'
    },

    // AI fact-check (BYOK — uses same keys as AI assistant)
    factCheck: {
      autoVideo: false,
      commentButtons: true,
      showVideoPanel: true
    },

    // Return YouTube Dislike — show counts on watch page + feed tiles
    dislikeRestore: {
      feedTiles: true,
      watchMetaRow: true,
      watchButtons: true,
      showRatio: true,
      // VIEWS OFF, DATE ON — and the split is deliberate.
      //
      // Measured on a real watch page at 1440x900: YouTube's metadata line
      // reads "24M views  8y ago" directly under the title, and this strip
      // repeated "24.4M views · Oct 5, 2017 · 9y ago" a hundred pixels below.
      // The VIEW COUNT is a true duplicate — same fact, same precision, from
      // the host, right there — so it defaults off.
      //
      // The DATE is not. YouTube prints a relative age ("8 years ago"); this
      // prints the exact publication date ("Oct 5, 2017") alongside it, which
      // is a different fact and the only place on the page it appears. Turning
      // it off deleted information rather than a repetition.
      //
      // Two specs caught that and they were right: watch-date-in-stats-row.spec
      // exists solely to assert the date renders once, and session-regression
      // asserts the same. Both failed in authoritative run 3 at
      // run_2026-09-19T02-35-19-613Z_bed562. A default that makes a dedicated
      // spec unsatisfiable is a product decision overreaching, not a stale test.
      //
      // Neither is deleted: the settings UI is unchanged and either can be
      // switched back.
      showViews: false,
      showDate: true,
      statsPosition: 'wide',
      statsStyle: 'card',
      statsFactCheck: true
    },

    // Where the watch guide sits on a two-column watch page: 'side' (top of the
    // related column, beside the video) or 'below' (under the player, above
    // the description). The owner asked for it to be a choice, 2026-09-24.
    watchGuide: {
      placement: 'side'
    },

    // Percent watched to count as "finished" (badge, dim, hide rules).
    watchedThreshold: 75,

    // Let YouTube's own red resume bar supplement the local watched store when
    // filtering feeds. The local store only holds what this extension observed
    // (plus imports), so without this a video finished on a phone or before
    // install shows a full red bar and is never hidden. Read for display and
    // filtering only — never written to the persisted watched store, which
    // would require inventing a watch date (see shared/watch-queue.js).
    watchedUseNativeProgress: true,

    // SponsorBlock: community ("actual") segments + personal on-device skips.
    // Per-category skip modes: auto | manual | overlay | disabled (full parity).
    sponsorBlock: {
      autoSkip: true,
      useCommunity: true,
      usePersonal: true,
      communityDirect: true,
      hideChapters: false,
      categoryModes: {
        sponsor: 'auto',
        selfpromo: 'auto',
        interaction: 'auto',
        music_offtopic: 'auto',
        intro: 'disabled',
        outro: 'disabled',
        preview: 'disabled',
        hook: 'disabled',
        filler: 'disabled',
        poi_highlight: 'manual',
        exclusive_access: 'overlay',
        chapter: 'overlay'
      },
      // Legacy boolean map kept for back-compat with pre-modes profiles.
      categories: { sponsor: true, selfpromo: true, interaction: true, music_offtopic: true, intro: false, outro: false, preview: false }
    },

    // UI/UX customization ("Tune" module). preset is informational; the
    // individual flags below are what actually apply.
    // Defaults favor a clean home feed + focused watch page (community Tune picks).
    ui: {
      preset: 'classic',
      hideShorts: true,
      hideRecommendations: false,
      hideComments: false,
      hideLiveChat: false,
      hideEndCards: true,
      hideMerch: true,
      hidePremiumUpsell: true,
      hideNotificationBell: false,
      hideTrending: true,
      hideHomeFeed: false,
      disableHoverPreview: true,
      squareThumbnails: true,
      dimWatched: false,
      oledTheme: false,
      fullWidth: false,
      untruncatedTitles: true,
      videosPerRow: 4,
      disableAutoplay: true,
      blockStillWatching: true,
      logoToSubscriptions: true,
      defaultSpeed: 0,
      defaultVolume: -1,
      loopVideo: false,
      theaterMode: false,
      // New v2 behaviors
      autoPauseOnTabSwitch: false,
      scrollToVolume: true,
      channelDefaultTab: 'videos', // 'home'|'videos'|'shorts'|'live'|'playlists'
      // Feed shelf hiders (each independently togglable)
      hideShelves: {
        forYou: false,
        mixes: false,
        news: false,
        shopping: false,
        communityPosts: false,
        continueWatching: false
      }
    },

    enabled: true,
    // Watched-video display: 'off' | 'dim' | 'hide' (hide watched) | 'only' (hide
    // unwatched). The watched videoId set lives in storage.local 'watchedVideos'
    // (imported from Google Takeout + auto-marked as you watch).
    watchedMode: 'dim', // legacy preset id — prefer watchedDisplay
    // Combinable watched feed settings (see shared/watched-display.js).
    watchedDisplay: {
      badges: true,
      finished: 'dim', // show | dim | hide — fully watched (75%+)
      feedFilter: 'all', // all | only-watched | only-unseen
      hidePartial: false // hide in-progress (started but not finished)
    },
    // 'hide' removes matching tiles; 'blur' dims them with a hover-to-reveal;
    // 'label' keeps tiles visible but stamps an "AI" badge on the thumbnail.
    mode: 'hide',
    // Minimum confidence (0–100) from shared/ai-keywords.js scoreVideo()
    // before a tile is treated as AI. Signals are weighted: a disclosure is
    // 100, "ai voiceover" is 70, a named tool 40, a topical mention 20.
    // 45 sits above a single weak hit on purpose, so a video merely ABOUT
    // ChatGPT/Sora is no longer flagged as AI-generated. Lower it to catch
    // more (with more false positives); raise it to only act on strong signals.
    minScore: 45,
    // Hide/redirect videos YouTube flags as altered/synthetic on the watch page.
    respectDisclosure: true,
    // Throw a block screen over the player when you open a matching video.
    blockPlayback: true,
    // Hide YouTube's AI-generated summaries / "AI" shelves in search & watch.
    hideSummaries: true,
    // Treat each keyword as a JS regular expression instead of plain text.
    useRegex: false,

    // Per-surface switches. Turn blocking off for individual YouTube areas.
    surfaces: {
      home: true,
      subscriptions: true,
      search: true,
      related: true, // sidebar recommendations on the watch page
      shorts: true,
      channel: true,
      music: true, // music.youtube.com
      // OFF by default, unlike every other surface: the library surfaces
      // (history, saved playlists, an open playlist, Watch Later) show content
      // the user deliberately saved or already watched. Filtering them with
      // the recommendation-feed rules deletes exactly what the user opened the
      // page to find. Still listed here so it remains user-togglable.
      library: false
    },

    // Focus Mode: when enabled, filtering is only active inside the schedule
    // window (local time). When disabled, filtering follows `enabled` always.
    focus: {
      enabled: false,
      start: '09:00',
      end: '17:00',
      days: [1, 2, 3, 4, 5] // 0=Sun … 6=Sat
    },

    // Community AI-channel blocklist (AiSList): when enabled, hide tiles whose
    // channel @handle/ID is on the community list (synced + cached locally).
    communityList: { enabled: true },

    // Case-insensitive substring (or regex) match against the video TITLE.
    // Sourced from shared/ai-keywords.js when that script is loaded first.
    keywords: [],
    // Substring/regex match against the CHANNEL or artist name. Grows via the
    // popup's "Block this channel" button.
    channels: [],
    // Channels always shown — bypass AI keywords, block list, and AiSList (by name, @handle, or UC id).
    allowedChannels: [],
    // When true, subscribed channels skip the slop filter (non-subs still filtered).
    allowSubscribedChannels: true,

    // Custom AI assistant prompt pills (name + prompt). Shown on watch-page panel.
    aiPrompts: [
      { name: 'Key insights', prompt: 'List the 6 most important insights from this video as bullet points.' },
      { name: 'Action items', prompt: 'List every actionable recommendation or task mentioned, as a checklist.' },
      { name: 'Counterpoints', prompt: "What are the weakest claims or strongest counter-arguments to this video's points?" },
      { name: 'ELI5', prompt: 'Explain the main idea of this video simply, as if to a smart 12-year-old.' },
      { name: 'Obsidian note', prompt: 'Write a Markdown note with ## headings, bullets, and [[wikilinks]] for key concepts, ready to paste into Obsidian.' },
      { name: 'Claim review', prompt: 'List factual claims in this video and rate each Supported / Mixed / Unsupported / Unverifiable with brief notes.' }
    ],

    stats: { hidden: 0 },

    // Watch-page analytics overlay (chrome.storage.local; mirrored on migrate).
    statsSections: { engagement: true, compare: true, seo: true, tags: true, creator: true },
    statsCollapsed: false,

    // When true, the service worker reloads open YouTube tabs automatically after
    // an extension update (instead of only showing the "reload tabs" notification).
    // Default on: after an update, lazily-injected modules (sidebar hub, masthead
    // filters, SponsorBlock, etc.) only re-attach on a fresh page load, so an
    // auto-reload is what makes the side panel come back without manual action.
    autoReloadTabsOnUpdate: true
  };
  (function fillDefaultKeywords() {
    const g = typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null;
    if (g && g.UNAIKeywords && g.UNAIKeywords.KEYWORDS && g.UNAIKeywords.KEYWORDS.length) {
      UNSYNTH_DEFAULTS.keywords = g.UNAIKeywords.KEYWORDS.slice();
    }
  })();
  if (typeof window !== 'undefined') window.UNSYNTH_DEFAULTS = UNSYNTH_DEFAULTS;
  if (typeof self !== 'undefined') self.UNSYNTH_DEFAULTS = UNSYNTH_DEFAULTS;
})();
