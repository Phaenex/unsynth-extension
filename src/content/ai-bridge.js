/**
 * AI bridge — runs in the page's MAIN world (see manifest content_scripts
 * "world": "MAIN"). The isolated content script can't read
 * window.ytInitialPlayerResponse or call the player object, so this tiny bridge
 * does, and hands the caption tracks back over window.postMessage.
 */
(function () {
  'use strict';

  // IMPORTANT: window.UNYtDom is NOT reliably present in this MAIN-world
  // script, even though yt-dom.js is listed alongside this file in the same
  // manifest content_scripts entry. Measured on a live watch page and
  // reproduced in the harness: ai-bridge.js runs (it answers UN_STATS_REQ with
  // real player data) while UNYtDom and UNSubGroups are both undefined in the
  // page world.
  //
  // Every selector below used to fall back to the literal string 'none', which
  // matches no element and throws nothing. So the queue row count was ALWAYS
  // zero, `native` was always false, and every single "+Q" reported
  // "Couldn't reach YouTube's queue" — while the add itself had actually
  // succeeded. Confirmed by driving resolveCommand() by hand on a real watch
  // page and watching the queue grow 0 -> 2 with the UI still claiming failure.
  // Transcripts and the row menus were silently broken the same way.
  //
  // The fallbacks are now the real selectors, so this file is correct whether
  // or not yt-dom loads. Keep them in sync with src/shared/yt-dom.js —
  // test/ai-bridge-selector-parity.test.js fails if they drift.
  const YD = typeof window !== 'undefined' && window.UNYtDom ? window.UNYtDom : null;
  const TX_PANEL_SEL = (YD && YD.TRANSCRIPT_PANEL_SEL) || 'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]';

  const bridgeRequests = Object.create(null);
  const BRIDGE_LIMITS = {
    UN_AI_REQ_TRACKS: [8, 1000],
    UN_STATS_REQ: [30, 1000],
    UN_DL_REQ: [3, 10000],
    UN_AI_GET_TRANSCRIPT: [2, 10000],
    UN_CHANNEL_NAMES_REQ: [2, 10000],
    UN_VOL_SET: [90, 1000],
    // Queueing is a direct response to a click, and clicking "+Q" down a row of
    // tiles is normal use — 3-per-10s throttled real usage and silently dropped
    // the 4th click. Dispatching a DOM event is cheap, so this is only a
    // runaway-loop guard, not a usage limit.
    UN_YT_QUEUE_ADD: [40, 10000],
    UN_YT_QUEUE_REMOVE: [40, 10000]
  };

  function allowBridgeRequest(type) {
    const limit = BRIDGE_LIMITS[type];
    if (!limit) return false;
    const now = Date.now();
    const times = (bridgeRequests[type] || []).filter((at) => now - at < limit[1]);
    if (times.length >= limit[0]) { bridgeRequests[type] = times; return false; }
    times.push(now);
    bridgeRequests[type] = times;
    return true;
  }

  function validReqId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 80;
  }

  // Breadth-first search for the first occurrence of `key` anywhere in a nested
  // object/array. Used to dig transcript params + segments out of YouTube's
  // sprawling response objects without depending on their exact path (which
  // changes between layout versions).
  function deepFindKey(root, key) {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (Object.prototype.hasOwnProperty.call(cur, key)) return cur[key];
      for (const k in cur) {
        const v = cur[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return null;
  }

  function ytConfig(name) {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') return window.ytcfg.get(name);
      if (window.ytcfg && window.ytcfg.data_) return window.ytcfg.data_[name];
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // The "Show transcript" command carries an opaque base64 `params` blob. It is
  // usually in ytInitialData while the panel is collapsed, but on some sessions
  // it's absent (hasParams:false) — then we fetch it from the next endpoint.
  // ---- DOM transcript fallback ----
  // YouTube's get_transcript API now returns FAILED_PRECONDITION and the
  // timedtext caption URLs are empty without a PO token (generated internally by
  // BotGuard, not exposed to us). But YouTube's OWN "Show transcript" panel
  // fetches the transcript with the page's session token and renders it. So we
  // trigger that panel and scrape the rendered segments — the robust path.
  function tsToSec(s) {
    const parts = String(s || '').trim().split(':').map(function (n) { return parseInt(n, 10) || 0; });
    return parts.reduce(function (a, b) { return a * 60 + b; }, 0);
  }
  // Element-agnostic panel-text parser, mirrored from src/shared/transcript.js
  // (unit-tested there as parsePanelText). Inlined because ai-bridge runs in the
  // page MAIN world, which can't see the isolated-world UNTranscript global.
  function parsePanelText(text) {
    const out = [];
    if (!text) return out;
    const re = /(\d{1,2}:\d{2}(?::\d{2})?)[\s ]+([\s\S]*?)(?=\d{1,2}:\d{2}(?::\d{2})?[\s ]|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = (m[2] || '').replace(/\s+/g, ' ').trim();
      if (t && t.length > 1) out.push({ startSec: tsToSec(m[1]), dur: 0, text: t });
    }
    return out;
  }
  function scrapeTranscriptDom() {
    const out = [];
    document.querySelectorAll((YD && YD.TRANSCRIPT_SEGMENT_SEL) || 'ytd-transcript-segment-renderer').forEach(function (seg) {
      const tEl = seg.querySelector((YD && YD.TRANSCRIPT_SEGMENT_TEXT_SEL) || '.segment-text, yt-formatted-string.segment-text') ||
        seg.querySelector('yt-formatted-string.segment-text');
      const tsEl = seg.querySelector((YD && YD.TRANSCRIPT_SEGMENT_TIMESTAMP_SEL) || '.segment-timestamp');
      const text = (tEl ? tEl.textContent : seg.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      out.push({ startSec: tsEl ? tsToSec(tsEl.textContent) : 0, dur: 0, text: text });
    });
    if (out.length) return out;
    // Modern layout dropped the per-segment elements — parse the populated panel
    // rendered text (picks the panel WITH text, since an empty
    // PAmodern_transcript_view placeholder coexists with the real one).
    let best = null;
    let bestLen = 0;
    document.querySelectorAll(TX_PANEL_SEL).forEach(function (p) {
      const len = (p.innerText || '').length;
      if (len > bestLen) { bestLen = len; best = p; }
    });
    if (best) return parsePanelText(best.innerText || '');
    return out;
  }
  function findTranscriptToggle(rx) {
    // Prefer a real <button> — clicking a ytd-button-renderer/yt-button-shape
    // wrapper does NOT fire the YouTube handler, so the panel never opens.
    const buttons = document.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const label = ((b.getAttribute('aria-label') || b.textContent || '')).trim();
      if (rx.test(label)) return b;
    }
    // Fallback: a renderer whose text matches — click its inner button.
    const rendSel = (YD && YD.TRANSCRIPT_BUTTON_RENDERER_SEL) || 'ytd-button-renderer, yt-button-shape';
    const rends = document.querySelectorAll(rendSel);
    for (let i = 0; i < rends.length; i++) {
      const label = (rends[i].textContent || '').trim();
      if (rx.test(label)) return rends[i].querySelector('button') || rends[i];
    }
    return null;
  }
  // Match the transcript engagement panel resiliently. YouTube target-id
  // ("engagement-panel-searchable-transcript") has shifted across layout versions,
  // but it always contains "transcript" — a substring match survives renames that
  // an exact match silently misses (which is what makes the panel flash visible).
  function transcriptPanel() {
    return document.querySelector(TX_PANEL_SEL);
  }
  // Keep the transcript panel invisible while we scrape it, so it never visibly
  // swaps in over the related videos. We use opacity:0 (NOT off-screen/display:
  // none) on purpose: the segment list is viewport-virtualized, so the panel must
  // stay in the viewport geometrically to render its rows — opacity:0 satisfies
  // that while hiding it, and the related videos remain visible behind it. The
  // injected stylesheet covers panels that mount later (after we click "Show
  // transcript"); the inline stamp covers any panel already present, so the hide
  // wins even if the stylesheet loses a specificity/timing race.
  function stampPanels(hide) {
    document.querySelectorAll(TX_PANEL_SEL).forEach(function (p) {
      if (hide) {
        p.style.setProperty('opacity', '0', 'important');
        p.style.setProperty('pointer-events', 'none', 'important');
      } else {
        p.style.removeProperty('opacity');
        p.style.removeProperty('pointer-events');
      }
    });
  }
  function setTranscriptHidden(on) {
    let st = document.getElementById('un-fc-tx-hide');
    if (on) {
      if (!st) {
        st = document.createElement('style');
        st.id = 'un-fc-tx-hide';
        st.textContent = TX_PANEL_SEL + '{opacity:0!important;pointer-events:none!important;}';
        (document.head || document.documentElement).appendChild(st);
      }
      stampPanels(true);
    } else if (st) {
      st.remove();
      stampPanels(false);
    }
  }
  function closeTranscriptPanel() {
    const btn = findTranscriptToggle(/^hide transcript$/i);
    if (btn) { btn.click(); return; }
    const panel = transcriptPanel();
    if (panel) panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  }
  async function getTranscriptViaDom(timeoutMs) {
    let segs = scrapeTranscriptDom();
    if (segs.length) return segs; // already open — leave the user's panel as-is
    const start = Date.now();
    let clicked = false;
    let weOpened = false;
    setTranscriptHidden(true); // suppress the visible panel swap before opening
    try {
      // Keep trying to open the panel: right after navigation the "Show transcript"
      // button may not exist yet, so re-attempt until it appears (or we time out).
      while (Date.now() - start < (timeoutMs || 9000)) {
        if (!clicked) {
          const btn = findTranscriptToggle(/^show transcript$/i);
          if (btn) {
            btn.click();
            clicked = true;
            weOpened = true;
          } else {
            const panel = transcriptPanel();
            if (panel && panel.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
              panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
              weOpened = true;
            }
          }
        }
        await new Promise(function (r) { setTimeout(r, 300); });
        stampPanels(true); // panel mounts after the click — stamp it inline each tick too
        segs = scrapeTranscriptDom();
        if (segs.length) break;
      }
      if (weOpened) {
        closeTranscriptPanel(); // restore — we opened it
        // let the close settle while still hidden, so it never flashes out
        await new Promise(function (r) { setTimeout(r, 350); });
      }
    } finally {
      setTranscriptHidden(false);
    }
    return segs;
  }

  function getPlayerResponse() {
    try {
      let pr = window.ytInitialPlayerResponse;
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.getPlayerResponse === 'function') {
        try {
          pr = mp.getPlayerResponse() || pr;
        } catch (e) {
          /* fall back */
        }
      }
      return pr || null;
    } catch (e) {
      return null;
    }
  }

  /** Count formats with a direct (non-cipher) URL — modern WEB player often has none. */
  function countDirectUrls(streamingData) {
    if (!streamingData) return 0;
    return []
      .concat(streamingData.formats || [], streamingData.adaptiveFormats || [])
      .filter(function (f) {
        return f && f.url;
      }).length;
  }

  /**
   * Mobile Innertube clients return direct playback URLs (downloader-site pattern).
   * Note: clientVersion strings below are fixed pins of unverified freshness that
   * should be periodically checked against current mobile releases if mobile
   * streaming endpoints change.
   */
  const INNERTUBE_DL_CLIENTS = [
    {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 30,
      hl: 'en',
      gl: 'US',
      platform: 'MOBILE'
    },
    {
      clientName: 'IOS',
      clientVersion: '19.45.4',
      deviceModel: 'iPhone14,3',
      hl: 'en',
      gl: 'US'
    }
  ];

  async function fetchPlayerViaInnertubeClient(videoId, clientSpec) {
    const key = ytConfig('INNERTUBE_API_KEY');
    if (!key || !videoId || !clientSpec) return null;
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + encodeURIComponent(key), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: clientSpec },
          videoId: videoId,
          contentCheckOk: true,
          racyCheckOk: true
        })
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || countDirectUrls(json.streamingData) === 0) return null;
      return json;
    } catch (err) {
      return null;
    }
  }

  async function fetchDirectStreaming(videoId) {
    for (let i = 0; i < INNERTUBE_DL_CLIENTS.length; i++) {
      const json = await fetchPlayerViaInnertubeClient(videoId, INNERTUBE_DL_CLIENTS[i]);
      if (json) {
        return {
          json: json,
          source: 'innertube-' + String(INNERTUBE_DL_CLIENTS[i].clientName).toLowerCase()
        };
      }
    }
    return null;
  }

  function mergeVideoDetails(target, source) {
    const vd = (source && source.videoDetails) || {};
    if (!target.videoId && vd.videoId) target.videoId = vd.videoId;
    if (!target.title && vd.title) target.title = vd.title;
    if (!target.author && vd.author) target.author = vd.author;
    if (!target.lengthSeconds && vd.lengthSeconds) target.lengthSeconds = Number(vd.lengthSeconds) || 0;
  }

  async function fetchPlayerViaInnertube(videoId) {
    const ctx = ytConfig('INNERTUBE_CONTEXT');
    const key = ytConfig('INNERTUBE_API_KEY');
    if (!ctx || !videoId) return null;
    const endpoints = [
      '/youtubei/v1/player?prettyPrint=false',
      '/youtubei/v1/player?key=' + encodeURIComponent(key || '')
    ];
    for (let i = 0; i < endpoints.length; i++) {
      try {
        const res = await fetch(endpoints[i], {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: ctx,
            videoId: videoId,
            contentCheckOk: true,
            racyCheckOk: true
          })
        });
        if (!res.ok) continue;
        const json = await res.json();
        if (json && (json.streamingData || json.videoDetails)) return json;
      } catch (err) {
        /* try next endpoint */
      }
    }
    return null;
  }

  /** /watch?v= or /shorts/<id> — Shorts SPA often omits videoDetails until Innertube. */
  function videoIdFromLocation() {
    try {
      const sm = String(location.pathname || '').match(/^\/shorts\/([\w-]{11})/);
      if (sm) return sm[1];
      const q = new URLSearchParams(location.search).get('v');
      return q && /^[\w-]{11}$/.test(q) ? q : '';
    } catch (e) {
      return '';
    }
  }

  async function getDownloadPayload() {
    const pr = getPlayerResponse();
    const vd = (pr && pr.videoDetails) || {};
    let videoId = vd.videoId || videoIdFromLocation();
    let streamingData = pr && pr.streamingData;
    let source = countDirectUrls(streamingData) > 0 ? 'player' : '';
    let title = vd.title || '';
    let author = vd.author || '';
    let lengthSeconds = Number(vd.lengthSeconds) || 0;
    if (countDirectUrls(streamingData) === 0 && videoId) {
      const direct = await fetchDirectStreaming(videoId);
      if (direct) {
        streamingData = direct.json.streamingData;
        source = direct.source;
        mergeVideoDetails({ videoId: videoId, title: title, author: author, lengthSeconds: lengthSeconds }, direct.json);
        videoId = videoId || direct.json.videoDetails?.videoId || '';
        title = title || direct.json.videoDetails?.title || '';
        author = author || direct.json.videoDetails?.author || '';
        lengthSeconds = lengthSeconds || Number(direct.json.videoDetails?.lengthSeconds) || 0;
      } else if (!streamingData) {
        const fresh = await fetchPlayerViaInnertube(videoId);
        if (fresh) {
          if (fresh.streamingData) {
            streamingData = fresh.streamingData;
            source = countDirectUrls(streamingData) > 0 ? 'innertube-web' : 'innertube';
          }
          mergeVideoDetails({ videoId: videoId, title: title, author: author, lengthSeconds: lengthSeconds }, fresh);
          if (!videoId && fresh.videoDetails?.videoId) videoId = fresh.videoDetails.videoId;
          if (!title && fresh.videoDetails?.title) title = fresh.videoDetails.title;
          if (!author && fresh.videoDetails?.author) author = fresh.videoDetails.author;
          if (!lengthSeconds && fresh.videoDetails?.lengthSeconds) {
            lengthSeconds = Number(fresh.videoDetails.lengthSeconds) || 0;
          }
        }
      }
    }
    const playability = (pr && pr.playabilityStatus) || {};
    return {
      videoId: videoId,
      title: title,
      author: author,
      lengthSeconds: lengthSeconds,
      streamingData: streamingData || null,
      source: source,
      playable: playability.status === 'OK' || !!streamingData,
      status: playability.status || (streamingData ? 'OK' : 'UNKNOWN')
    };
  }

  // Video stats straight from the page's player response — zero API quota.
  function getStats() {
    try {
      const pr = getPlayerResponse();
      const vd = (pr && pr.videoDetails) || {};
      const mf = (pr && pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
      return {
        videoId: vd.videoId || '',
        title: vd.title || '',
        author: vd.author || '',
        channelId: vd.channelId || '',
        lengthSeconds: Number(vd.lengthSeconds) || 0,
        viewCount: Number(vd.viewCount) || 0,
        keywords: vd.keywords || [],
        description: String(vd.shortDescription || '').slice(0, 8000),
        descriptionLen: (vd.shortDescription || '').length,
        publishDate: mf.publishDate || mf.uploadDate || '',
        category: mf.category || ''
      };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function getInfo() {
    try {
      const pr = getPlayerResponse();
      const tracks =
        (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      const details = (pr && pr.videoDetails) || {};
      return {
        tracks: tracks.map((t) => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind, name: t.name && t.name.simpleText })),
        videoId: details.videoId || '',
        title: details.title || ''
      };
    } catch (e) {
      return { tracks: [], error: String(e) };
    }
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data) return;
    const type = e.data.type;
    if (!Object.prototype.hasOwnProperty.call(BRIDGE_LIMITS, type)) return;
    if (!allowBridgeRequest(type)) return;
    if (type !== 'UN_VOL_SET' && !validReqId(e.data.reqId)) return;

    if (e.data.type === 'UN_AI_REQ_TRACKS') {
      const info = getInfo();
      window.postMessage({ type: 'UN_AI_TRACKS', reqId: e.data.reqId, ...info }, location.origin);
      return;
    }

    if (e.data.type === 'UN_STATS_REQ') {
      window.postMessage({ type: 'UN_STATS', reqId: e.data.reqId, ...getStats() }, location.origin);
      return;
    }

    if (e.data.type === 'UN_DL_REQ') {
      let payload = { type: 'UN_DL_RES', reqId: e.data.reqId, ok: false, formats: [] };
      try {
        const dl = await getDownloadPayload();
        payload = Object.assign(payload, dl);
        payload.ok = !!(dl.streamingData && dl.playable !== false);
      } catch (dlErr) {
        payload.error = String(dlErr);
      }
      window.postMessage(payload, location.origin);
      return;
    }

    // Transcript scrape path. The get_transcript Innertube API is dead (always
    // 400s now), so we go straight to scraping YouTube's own transcript panel,
    // which renders with the page's PO token. The isolated-world caller tries a
    // non-disruptive backend transcript before falling back to this.
    if (e.data.type === 'UN_AI_GET_TRANSCRIPT') {
      let segs = [];
      let source = '';
      const paramsSource = '';
      let apiErr = null;
      // Scrape YouTube's own transcript panel — it fetches with the page's PO
      // token, so it works where the get_transcript Innertube API now always
      // 400s (deprecated/blocked). The panel scrape is the path that works today;
      // the isolated-world side tries a non-disruptive backend transcript first.
      try {
        segs = await getTranscriptViaDom(8000);
        if (segs.length) source = 'dom';
      } catch (err) {
        apiErr = String(err);
      }
      window.postMessage({
        type: 'UN_AI_TX',
        reqId: e.data.reqId,
        ok: segs.length > 0,
        segs: segs,
        count: segs.length,
        paramsSource: paramsSource,
        source: source,
        error: segs.length ? undefined : (apiErr || 'no_transcript')
      }, location.origin);
    }

    // Resolve channel titles via Innertube browse (no OAuth) — PocketTube imports use UC ids.
    if (e.data.type === 'UN_CHANNEL_NAMES_REQ') {
      var cnPayload = { type: 'UN_CHANNEL_NAMES_RES', reqId: e.data.reqId, ok: false, names: {}, thumbs: {} };
      try {
        var cnCtx = ytConfig('INNERTUBE_CONTEXT');
        var cnKey = ytConfig('INNERTUBE_API_KEY');
        var cnIds = (Array.isArray(e.data.ids) ? e.data.ids.slice(0, 50) : []).filter(function (id) {
          return id && /^UC[\w-]+$/.test(id);
        });
        if (cnCtx && cnIds.length) {
          var cnNames = {};
          var cnThumbs = {};
          for (var ci = 0; ci < cnIds.length && ci < 50; ci++) {
            var cid = cnIds[ci];
            try {
              var cnRes = await fetch(
                '/youtubei/v1/browse' + (cnKey ? '?key=' + encodeURIComponent(cnKey) : ''),
                {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ context: cnCtx, browseId: cid })
                }
              );
              if (!cnRes.ok) continue;
              var cnJson = await cnRes.json();
              var meta = deepFindKey(cnJson, 'channelMetadataRenderer');
              if (meta && meta.title) {
                var t = meta.title;
                if (typeof t === 'string') cnNames[cid] = t;
                else if (t.simpleText) cnNames[cid] = t.simpleText;
                else if (t.runs && t.runs.length) {
                  cnNames[cid] = t.runs
                    .map(function (r) {
                      return r.text || '';
                    })
                    .join('');
                }
              }
              if (!cnNames[cid]) {
                var hdr = deepFindKey(cnJson, 'c4TabbedHeaderRenderer');
                if (hdr && hdr.title) {
                  var ht = hdr.title;
                  cnNames[cid] = typeof ht === 'string' ? ht : ht.simpleText || '';
                }
              }
              if (meta && meta.avatar && meta.avatar.thumbnails && meta.avatar.thumbnails.length) {
                var ths = meta.avatar.thumbnails;
                cnThumbs[cid] = ths[ths.length - 1].url;
              }
            } catch (cnErr) {
              /* try next id */
            }
          }
          if (Object.keys(cnNames).length) {
            cnPayload.ok = true;
            cnPayload.names = cnNames;
            cnPayload.thumbs = cnThumbs;
          }
        }
      } catch (cnOuter) {
        cnPayload.error = String(cnOuter);
      }
      window.postMessage(cnPayload, location.origin);
      return;
    }

    // Drive YouTube's NATIVE volume from the isolated world. Setting
    // <video>.volume directly moves the audio but not YouTube's own slider —
    // YouTube renders the slider from the player's internal state and will
    // re-assert that stale value back onto the element (the desync + "fighting"
    // the user hit with scroll-to-volume). movie_player.setVolume updates both
    // the slider and the element, so the extension's boost bar, the scroll HUD,
    // and YouTube's native control all stay in lockstep. pct is clamped 0–100;
    // boost above 100 is carried by the extension's Web Audio gain node, not here.
    if (e.data.type === 'UN_VOL_SET') {
      try {
        const mp = document.getElementById('movie_player');
        let p = Number(e.data.pct);
        if (mp && typeof mp.setVolume === 'function' && isFinite(p)) {
          p = Math.max(0, Math.min(100, Math.round(p)));
          // Unmute when raising off silence so a previously-muted player follows.
          if (p > 0 && typeof mp.unMute === 'function') mp.unMute();
          mp.setVolume(p);
        }
      } catch (err) {
        /* ignore — player API not present (e.g. YouTube Music) */
      }
      return;
    }

    // Add to the YouTube native queue — the list its Add-to-queue menu item writes
    // to and the player actually plays from.
    //
    // Two earlier attempts failed here, so the mechanism below is the one that
    // was confirmed against a live signed-in session rather than inferred:
    //
    //   1. POSTing to /youtubei/v1/queue/add and /youtubei/v1/player/queue_add.
    //      Neither endpoint exists; every request 404 while the caller was
    //      told the video had been queued.
    //   2. Dispatching yt-append-to-queue / yt-play-next-to-queue on
    //      the ytd-app root. Observed on a watch page holding a live 2-item queue: the
    //      events fire and the queue does not change. The native menu item
    //      emits NO custom events at all.
    //
    // What YouTube actually does, read directly off a real menu item bound
    // data: it resolves a signalServiceEndpoint wrapping an addToPlaylistCommand
    // with listType PLAYLIST_EDIT_LIST_TYPE_QUEUE, and lets the app create the
    // backing temp playlist via /youtubei/v1/playlist/create. Feeding that same
    // command to ytd-app.resolveCommand() queues an arbitrary video — verified
    // live, queue grew 0 -> 2 -> 3 with the expected titles in order.
    //
    // Front-insert (Play next) is NOT supported here: tile menus
    // expose no Play next item, and INSERT_AFTER_CURRENT_VIDEO /
    // listPosition variants were tried live and all appended. So toFront only
    // steers the extension own local list; the native queue always appends.
    //
    // Also verified live: this only takes effect on a WATCH page. Off /watch
    // there is no queue panel renderer for YouTube to build the queue
    // into — resolveCommand returns true, no rows appear, and the add does not
    // survive navigating to a watch page. That is a real YouTube constraint,
    // not a bug here, and the row-count check below reports it truthfully so
    // the caller falls back to (extension queue) instead of claiming a write.
    //
    // native is set from a real before/after row count, never from the call
    // returning — that is what kept both earlier bugs invisible.
    if (e.data.type === 'UN_YT_QUEUE_ADD') {
      var qPayload = { type: 'UN_YT_QUEUE_RESULT', reqId: e.data.reqId, ok: false, native: false, added: 0 };
      var qRows = function () {
        var rowSel = (YD && YD.PLAYLIST_PANEL_VIDEO_SEL) || 'ytd-playlist-panel-video-renderer';
        return document.querySelectorAll(rowSel).length;
      };
      // Rebuilds the native Add-to-queue command for an arbitrary id.
      var qCommand = function (videoId) {
        return {
          commandMetadata: { webCommandMetadata: { sendPost: true } },
          signalServiceEndpoint: {
            signal: 'CLIENT_SIGNAL',
            actions: [
              {
                addToPlaylistCommand: {
                  openMiniplayer: false,
                  videoId: videoId,
                  listType: 'PLAYLIST_EDIT_LIST_TYPE_QUEUE',
                  onCreateListCommand: {
                    commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/playlist/create' } },
                    // params CAQ%3D is what the native menu item carries —
                    // it selects the queue list type on creation.
                    createPlaylistServiceEndpoint: { videoIds: [videoId], params: 'CAQ%3D' }
                  },
                  videoIds: [videoId]
                }
              }
            ]
          }
        };
      };
      try {
        // Validate IDs before acting — any page script can post this message,
        // so only accept real 11-char video IDs.
        var qIds = (Array.isArray(e.data.videoIds) ? e.data.videoIds.slice(0, 50) : []).filter(function (id) {
          return typeof id === 'string' && /^[\w-]{11}$/.test(id);
        });
        var qApp = document.querySelector((YD && YD.YTD_APP_SEL) || 'ytd-app');
        if (qIds.length && qApp && typeof qApp.resolveCommand === 'function') {
          var qBefore = qRows();
          for (var qi = 0; qi < qIds.length; qi++) {
            qApp.resolveCommand(qCommand(qIds[qi]));
          }
          qPayload.ok = true;
          // The queue panel renders asynchronously, and the FIRST add also has
          // to create the backing playlist server-side, so the row count lags
          // the call by a variable amount. Poll until the expected rows appear
          // rather than sleeping a fixed interval — a fixed wait was observed
          // failing under parallel test load, which would make the bridge
          // report `native:false` on a queue write that actually succeeded.
          // 24 x 125ms = 3s, but the caller in src/shared/native-queue.js
          // waits TIMEOUT_MS (3500) + 150ms per id before giving up, so this
          // loop gave up FIRST and reported queue_unavailable for a write that
          // had actually landed — the row appears a moment after the poll
          // stops. Verified live on a watch page: the queue really did grow
          // 2 -> 3 while the UI showed "Couldn't reach YouTube's queue".
          // The first add is the slow one because YouTube also has to create
          // the backing queue playlist server-side. Poll past the caller's
          // deadline so the result reflects the queue, not the stopwatch;
          // the loop still exits as soon as the rows show up.
          var qWant = qBefore + qIds.length;
          var qAfter = qBefore;
          var qTries = 48 + Math.min(qIds.length, 50) * 2;
          for (var qTry = 0; qTry < qTries; qTry++) {
            await new Promise(function (r) {
              setTimeout(r, 125);
            });
            qAfter = qRows();
            if (qAfter >= qWant) break;
          }
          qPayload.added = Math.max(0, qAfter - qBefore);
          qPayload.native = qAfter > qBefore;
          if (!qPayload.native) qPayload.error = 'queue_unavailable';
        } else if (!qIds.length) {
          qPayload.error = 'no_valid_ids';
        } else {
          // No ytd-app / no resolveCommand: YouTube Music, an embed, or a
          // signed-out session with no queue feature.
          qPayload.error = 'queue_unavailable';
        }
      } catch (qErr) {
        qPayload.error = String(qErr);
      }
      window.postMessage(qPayload, location.origin);
    }

    // Remove video(s) from the native queue — the Remove-from-playlist
    // item on a queue-panel row action menu.
    //
    // Replicating the command via ytd-app.resolveCommand() (the approach
    // UN_YT_QUEUE_ADD uses for Add-to-queue) does NOT work here — confirmed
    // live, repeatedly: resolveCommand() returns true and the network request
    // fires, but the row never disappears, even given 6+ seconds. The real
    // Remove-from-playlist menu item does more than resolve that command
    // (it drives Polymer tap-gesture handling on the menu item, which
    // updates the panel local state), so this instead finds that exact
    // list-item element in the currently-open menu — opened by a real
    // click on the row action-menu button — and clicks it directly.
    //
    // Also confirmed live: an await-based loop inside THIS handler (polling
    // row count every 125ms in a bounded for-loop) reproducibly hung forever
    // and no reply was ever posted, even past 8s on a loop bounded to ~3s —
    // removing the loop entirely fixed it. Root cause not fully isolated, but
    // the fix is to never await inside this listener: do the click
    // synchronously, then verify via ONE deferred setTimeout check rather
    // than a poll loop.
    if (e.data.type === 'UN_YT_QUEUE_REMOVE') {
      var qrPayload = { type: 'UN_YT_QUEUE_RESULT', reqId: e.data.reqId, ok: false, native: false, removed: 0 };
      // YouTube does NOT remove a queue-panel row from the document when it is
      // taken out of the queue — it hides it (display:none) instead, likely
      // as a pooled/recycled template instance or leftover exit-animation
      // state. Confirmed live: after a successful removal, the native Queue
      // panel visibly showed 1 / 1 with one real row, while
      // querySelectorAll on queue panel video rows still
      // returned it PLUS two hidden, isConnected:true ghost rows for the
      // video that had just been removed. Every count/lookup in this handler
      // was reading those ghosts as still-queued, which made a genuinely
      // successful removal look like a failure (or, worse, made the retry
      // pass click a real visible row belonging to a DIFFERENT video because
      // the ghost stale data confused the is-this-id-still-present
      // check). Always filter to rows YouTube is actually still showing.
      var qrIsLiveRow = function (row) {
        return row.offsetParent !== null;
      };
      var qrLiveRows = function () {
        var rowSel = (YD && YD.PLAYLIST_PANEL_VIDEO_SEL) || 'ytd-playlist-panel-video-renderer';
        return Array.prototype.slice.call(document.querySelectorAll(rowSel)).filter(qrIsLiveRow);
      };
      try {
        var qrIds = (Array.isArray(e.data.videoIds) ? e.data.videoIds.slice(0, 50) : []).filter(function (id) {
          return typeof id === 'string' && /^[\w-]{11}$/.test(id);
        });
        var qrPanel = document.querySelector((YD && YD.PLAYLIST_PANEL_SEL) || 'ytd-playlist-panel-renderer');
        if (!qrIds.length) {
          qrPayload.error = 'no_valid_ids';
          window.postMessage(qrPayload, location.origin);
          return;
        }
        if (!qrPanel) {
          qrPayload.error = 'queue_unavailable';
          window.postMessage(qrPayload, location.origin);
          return;
        }
        var qrWantedIds = {};
        qrIds.forEach(function (id) {
          qrWantedIds[id] = true;
        });
        var qrRowsAll = qrLiveRows().filter(function (row) {
          return qrPanel.contains(row);
        });
        var qrTargetRows = qrRowsAll.filter(function (row) {
          return row.data && qrWantedIds[row.data.videoId] && row.data.playlistSetVideoId;
        });
        if (!qrTargetRows.length) {
          // Either genuinely not queued, or (observed live) it is a row whose
          // data has not hydrated playlistSetVideoId yet — e.g. the entry that
          // matches the watch page own URL renders a reduced data shape
          // with no menu/setVideoId at all. Both report the same way to the
          // caller; a stuck row here isn't retryable from this bridge.
          qrPayload.error = 'not_in_queue';
          window.postMessage(qrPayload, location.origin);
          return;
        }
        // Track by setVideoId, not by a before/after ROW COUNT — the panel
        // can transiently duplicate an unrelated row while YouTube
        // reconciles the removal (observed live: removing one row left the
        // total count unchanged because a different video's row appeared
        // twice for a moment), so a total-count comparison reports a false
        // failure on a removal that actually succeeded.
        var qrTargetSetIdList = qrTargetRows.map(function (row) {
          return row.data.playlistSetVideoId;
        });
        var qrTargetSetIds = {};
        qrTargetSetIdList.forEach(function (id) {
          qrTargetSetIds[id] = true;
        });
        var qrWantedCount = Object.keys(qrTargetSetIds).length;
        // Re-find the live row by setVideoId at the moment each removal
        // starts, rather than reusing the element reference captured in the
        // initial snapshot above. Confirmed live: the panel reflows between
        // removals (rows shift position, sometimes visibly duplicate for a
        // moment while YouTube reconciles), which can leave an earlier
        // snapshot's element stale/detached — a click routed through a
        // detached node does nothing, which is what made removing 2+ videos
        // in one batch remove only some of them.
        var qrFindRowBySetId = function (setVideoId) {
          var current = qrLiveRows();
          for (var i = 0; i < current.length; i++) {
            if (current[i].data && current[i].data.playlistSetVideoId === setVideoId) return current[i];
          }
          return null;
        };
        var qrRealClick = function (el) {
          var r = el.getBoundingClientRect();
          var opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window, button: 0 };
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        };
        // Remove rows one at a time — each open/click/close cycle needs the
        // menu from the PREVIOUS row gone before the next row's button can be
        // found (YouTube reuses one ytd-popup-container for every row's menu).
        // One retry pass for anything still present after the main loop —
        // confirmed live, reproducibly: the SECOND row in a 2+ item batch
        // sometimes reads as still-present even after the stability wait,
        // because YouTube's click-to-remove round trip for that row hadn't
        // actually completed yet, not because the click missed. A single
        // extra attempt at whatever's left, rather than reporting a partial
        // batch as fully failed, matches what actually happens if the user
        // just waits a moment and looks again.
        var qrRetried = false;
        var qrFinish = function () {
          setTimeout(function () {
            var qrStillThereIds = qrLiveRows()
              .filter(function (row) {
                return row.data && qrTargetSetIds[row.data.playlistSetVideoId];
              })
              .map(function (row) {
                return row.data.playlistSetVideoId;
              });
            if (qrStillThereIds.length && !qrRetried) {
              qrRetried = true;
              qrTargetSetIdList = qrStillThereIds;
              qrRemoveNext(0);
              return;
            }
            qrPayload.removed = Math.max(0, qrWantedCount - qrStillThereIds.length);
            qrPayload.native = qrPayload.removed > 0;
            qrPayload.ok = qrPayload.native;
            if (!qrPayload.ok) qrPayload.error = 'queue_unavailable';
            window.postMessage(qrPayload, location.origin);
          }, 900);
        };
        var qrRemoveNext = function (idx) {
          if (idx >= qrTargetSetIdList.length) {
            qrFinish();
            return;
          }
          var row = qrFindRowBySetId(qrTargetSetIdList[idx]);
          if (!row) {
            // Already gone (e.g. removed by a previous iteration whose
            // duplicate row briefly confused the initial snapshot) — nothing
            // left to click for this one.
            qrRemoveNext(idx + 1);
            return;
          }
          // The "Action menu" button is lazy-rendered — its container sits
          // at rect (0,0,0,0) until the row is actually hovered, confirmed
          // live: a click computed from that zero rect lands nowhere real
          // and silently does nothing, which is what made this fail
          // intermittently despite the button existing in the DOM.
          // Dispatch a real hover sequence on the row first so YouTube lays
          // it out, matching what a user's mouse does before they can click it.
          var rowRect = row.getBoundingClientRect();
          if (rowRect.width && rowRect.height) {
            var hoverOpts = { bubbles: true, cancelable: true, clientX: rowRect.left + rowRect.width / 2, clientY: rowRect.top + rowRect.height / 2, view: window };
            row.dispatchEvent(new PointerEvent('pointerover', hoverOpts));
            row.dispatchEvent(new PointerEvent('pointerenter', hoverOpts));
            row.dispatchEvent(new MouseEvent('mouseover', hoverOpts));
            row.dispatchEvent(new MouseEvent('mouseenter', hoverOpts));
          }
          setTimeout(function () {
            var menuBtn = row.querySelector('button[aria-label="Action menu"]');
            var menuRect = menuBtn && menuBtn.getBoundingClientRect();
            if (!menuBtn || !menuRect || !menuRect.width) {
              // Row genuinely has no reachable menu (e.g. it IS the current
              // watch page's own video, which YouTube renders without one) —
              // move on rather than clicking at a meaningless (0,0).
              qrRemoveNext(idx + 1);
              return;
            }
            qrRealClick(menuBtn);
            setTimeout(function () {
              var items = Array.prototype.slice.call(document.querySelectorAll((YD && YD.MENU_SERVICE_ITEM_SEL) || 'ytd-menu-service-item-renderer, yt-list-item-view-model'));
              var removeItem = items.find(function (item) {
                return (item.textContent || '').indexOf('Remove from playlist') !== -1;
              });
              var clickTarget = removeItem && (removeItem.querySelector('tp-yt-paper-item, [role="menuitem"]') || removeItem);
              if (clickTarget) qrRealClick(clickTarget);
              // Force-close whatever popup is left open — clicking the menu
              // item should dismiss it, but leaving a stale one around risks
              // the NEXT row's "Remove from playlist" lookup matching a
              // leftover node from this row's now-closed menu instead of the
              // fresh one, since YouTube reuses one ytd-popup-container for
              // every row.
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              // Wait for the panel to report the SAME row count twice in a
              // row before starting the next removal, instead of a fixed
              // delay. Confirmed live: a fixed 800ms gap was not always
              // enough — YouTube's own panel re-render after a removal can
              // still be reflowing then, and starting the next row's click
              // mid-reflow caught it rendering a transient duplicate of an
              // unrelated row, which made the second removal in a batch
              // silently fail while looking like it targeted a real row.
              var qrWaitStable = function (lastCount, stableStreak, attemptsLeft) {
                if (attemptsLeft <= 0) {
                  qrRemoveNext(idx + 1);
                  return;
                }
                setTimeout(function () {
                  var count = qrLiveRows().length;
                  if (count === lastCount) {
                    if (stableStreak + 1 >= 2) {
                      qrRemoveNext(idx + 1);
                      return;
                    }
                    qrWaitStable(count, stableStreak + 1, attemptsLeft - 1);
                    return;
                  }
                  qrWaitStable(count, 0, attemptsLeft - 1);
                }, 300);
              };
              qrWaitStable(qrLiveRows().length, 0, 8);
            }, 400);
          }, 200);
        };
        qrRemoveNext(0);
      } catch (qrErr) {
        qrPayload.error = String(qrErr);
        window.postMessage(qrPayload, location.origin);
      }
    }
  });
})();
