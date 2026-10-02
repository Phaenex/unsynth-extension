/**
 * Unsynth AI Assistant — watch-page panel: transcript summary, clickable
 * timestamped chapters, Q&A chat with timestamps cited as clickable jumps, and
 * a one-click prompt library. Transcript via the MAIN-world bridge + json3;
 * LLM via the service worker's multi-provider proxy. Transcript cached locally.
 */
(function () {
  'use strict';

  const T = window.UNTranscript;
  const FL = window.UNForgeLinks;
  const WS = window.UNWatchStats;
  const YT = window.UNYtDom || null;
  let core = null;
  let panel = null;
  let state = { videoId: null, segs: null, context: '', messages: [], busy: false };
  let activeStreamStop = null; // resolves the current stream early (Stop button)
  let stopRequested = false; // set by Stop during the transcript-loading phase
  let escHandle = null; // UNSYNTH panel-stack handle, popped in destroyPanel
  let panelSetOpen = null; // buildPanel's setOpen(open), exposed so other open paths reuse it
  // Named listener refs stored so destroyPanel / teardown can remove them.
  let onStorageChangedAI = null;
  let onAiOpen = null;
  // Monotonically-increasing generation counter — collectByScroll captures the
  // value at call time and bails if it changes (onNavigate / destroyPanel bump it).
  let scrollGen = 0;
  const AI_CACHE_INDEX = 'unsynthAiCacheIndex';
  const AI_CACHE_MAX_PER_KIND = 20;
  const AI_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const activeFetches = new Set();

  function fetchWithTimeout(url, init, timeoutMs) {
    const ctrl = new AbortController();
    activeFetches.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
    return fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal })).finally(() => {
      clearTimeout(timer);
      activeFetches.delete(ctrl);
    });
  }

  function abortFetches() {
    activeFetches.forEach((ctrl) => { try { ctrl.abort(); } catch (e) {} });
    activeFetches.clear();
  }

  function cacheKind(key) {
    return String(key || '').split(':')[0];
  }

  function cacheGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (d) => {
        const value = d && d[key];
        const at = Number(value && value.at) || 0;
        if (!value || !at || Date.now() - at > AI_CACHE_TTL) {
          if (value) chrome.storage.local.remove(key);
          resolve(null);
          return;
        }
        resolve(value);
      });
    });
  }

  function cachePut(key, value) {
    chrome.storage.local.get({ [AI_CACHE_INDEX]: [] }, (d) => {
      let index = Array.isArray(d[AI_CACHE_INDEX]) ? d[AI_CACHE_INDEX].filter((x) => x && x.key !== key) : [];
      const now = Date.now();
      const remove = index.filter((x) => now - (Number(x.at) || 0) > AI_CACHE_TTL).map((x) => x.key);
      index = index.filter((x) => now - (Number(x.at) || 0) <= AI_CACHE_TTL);
      index.unshift({ key, at: now, kind: cacheKind(key) });
      const seenByKind = {};
      const keep = [];
      index.forEach((entry) => {
        const kind = entry.kind || cacheKind(entry.key);
        seenByKind[kind] = (seenByKind[kind] || 0) + 1;
        if (seenByKind[kind] <= AI_CACHE_MAX_PER_KIND) keep.push(entry);
        else remove.push(entry.key);
      });
      const payload = { [AI_CACHE_INDEX]: keep, [key]: Object.assign({}, value, { at: now }) };
      chrome.storage.local.set(payload, () => {
        if (remove.length) chrome.storage.local.remove(remove);
      });
    });
  }

  const DEFAULT_PROMPTS = [
    { name: 'Key insights', prompt: 'List the 6 most important insights from this video as bullet points.' },
    { name: 'Action items', prompt: 'List every actionable recommendation or task mentioned, as a checklist.' },
    { name: 'Counterpoints', prompt: "What are the weakest claims or strongest counter-arguments to this video's points?" },
    { name: 'ELI5', prompt: 'Explain the main idea of this video simply, as if to a smart 12-year-old.' },
    { name: 'Obsidian note', prompt: 'Write a Markdown note with ## headings, bullets, and [[wikilinks]] for key concepts, ready to paste into Obsidian.' }
  ];

  const isWatch = () =>
    WS && WS.isTrackableWatchPage ? WS.isTrackableWatchPage(location.pathname) : (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch');
  function videoId() {
    if (WS && WS.videoIdFromUrl) return WS.videoIdFromUrl(location.pathname, location.search);
    const m = location.search.match(/[?&]v=([^&]+)/);
    return m ? m[1] : null;
  }
  function jumpTo(sec) {
    const v = document.querySelector('video');
    if (v) {
      try {
        v.currentTime = sec;
        v.play && v.play();
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---- transcript ----
  let reqSeq = 0;
  function requestTracks() {
    return new Promise((resolve) => {
      const reqId = 'r' + ++reqSeq;
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.type !== 'UN_AI_TRACKS' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'UN_AI_REQ_TRACKS', reqId }, '*');
      setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ tracks: [] });
      }, 4000);
    });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Strategy A — direct caption fetch from the content script (often PO-blocked).
  async function fetchJson3Segs() {
    try {
      const info = await requestTracks();
      const track = T.pickTrack(info.tracks);
      if (!track || !track.baseUrl) return null;
      const url = new URL(track.baseUrl);
      url.searchParams.set('fmt', 'json3');
      const res = await fetchWithTimeout(url.toString(), { credentials: 'include' }, 10000);
      if (!res.ok) return null;
      const raw = await res.text();
      if (!raw || raw.length < 5) return null;
      const segs = T.parseJson3(JSON.parse(raw));
      return segs.length ? segs : null;
    } catch (e) {
      return null;
    }
  }

  // Strategy A2 (primary) — YouTube's own get_transcript Innertube endpoint via
  // the MAIN-world bridge. No PO token required, so it survives the gate that
  // makes the bare timedtext URL return an empty body.
  function requestGetTranscript() {
    return new Promise((resolve) => {
      const reqId = 'g' + ++reqSeq;
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.type !== 'UN_AI_TX' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'UN_AI_GET_TRANSCRIPT', reqId, videoId: videoId() }, '*');
      setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false });
      }, 8000);
    });
  }
  // Tier 2 — server-side transcript via the Playlist Forge backend (Supadata).
  // Last resort: only runs when every in-browser method came up empty, since it
  // spends a backend credit. Handles videos where YouTube blocks our session.
  async function fetchViaBackend() {
    try {
      const vid = videoId();
      if (!vid) return null;
      // Proxied through the SW (content scripts can't fetch playlist-forge — CORS).
      const res = await window.UNForgeLinks.apiFetch('/api/transcript?videoId=' + encodeURIComponent(vid));
      if (!res.ok) return null;
      const data = res.data || {};
      return data.segments && data.segments.length ? data.segments : null;
    } catch (e) {
      return null;
    }
  }

  async function fetchViaGetTranscript() {
    try {
      const res = await requestGetTranscript();
      return res.ok && res.segs && res.segs.length ? res.segs : null;
    } catch (e) {
      return null;
    }
  }

  // Strategy B — scrape YouTube's own transcript panel. YouTube fetches it with
  // a valid token, so this survives the PO-token gate that blocks Strategy A.
  // The transcript engagement panel. YouTube NEW modern transcript view
  // (target-id PAmodern_transcript_view) replaced per-segment renderers,
  // so match the panel by target-id, not by the now-dead segment element.
  function wordCount(s) {
    return ((s || '').match(/[A-Za-z']{2,}/g) || []).length;
  }
  function allTranscriptPanels() {
    return Array.prototype.slice
      .call(document.querySelectorAll(YT ? YT.TRANSCRIPT_ENGAGEMENT_PANEL_SEL : 'none'))
      .filter((p) => /transcript/i.test(p.getAttribute('target-id') || ''));
  }
  // Pick the transcript panel that ACTUALLY has text. YouTube ships more than one
  // transcript-ish panel (e.g. an empty "PAmodern_transcript_view" placeholder vs
  // the populated "engagement-panel-searchable-transcript"); grabbing the first
  // match read the empty one. Choose by word count, preferring the searchable one
  // before anything is populated.
  function findTranscriptPanel() {
    const panels = allTranscriptPanels();
    if (panels.length) {
      panels.sort((a, b) => wordCount(b.innerText) - wordCount(a.innerText));
      if (wordCount(panels[0].innerText) > 0) return panels[0];
      return panels.find((p) => /searchable-transcript/i.test(p.getAttribute('target-id') || '')) || panels[0];
    }
    return document.querySelector(YT ? YT.TRANSCRIPT_RENDERER_SEL : 'none');
  }
  // Element-name-agnostic: parse the panel's rendered text into [time, line]
  // pairs. Survives YouTube renaming the segment elements (which it just did).
  // Delegates to the shared, unit-tested parser (src/shared/transcript.js).
  function parsePanelText(text) {
    return T && T.parsePanelText ? T.parsePanelText(text) : [];
  }
  function readPanelSegments(panel) {
    if (!panel) return [];
    // older layout: explicit per-segment elements (kept for back-compat)
    const els = panel.querySelectorAll(YT ? YT.TRANSCRIPT_SEGMENT_FALLBACK_SEL : 'none');
    if (els.length) {
      const out = [];
      els.forEach((seg) => {
        const whole = (seg.textContent || '').trim().replace(/\s+/g, ' ');
        const m = whole.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/);
        if (m) {
          const sec = T.secondsFromTs(m[1]);
          if (sec != null) out.push({ startSec: sec, dur: 0, text: m[2].trim() });
        }
      });
      if (out.length) return out;
    }
    // modern layout: split the rendered text into [timestamp, line] pairs
    return parsePanelText(panel.innerText || panel.textContent || '');
  }
  function findTranscriptButton() {
    // Prefer the dedicated transcript section in the description.
    const section = document.querySelector(YT ? YT.TRANSCRIPT_DESC_BUTTON_SEL : 'none');
    if (section) return section.querySelector('button') || section;
    const nodes = document.querySelectorAll(YT ? YT.TRANSCRIPT_TOGGLE_BUTTON_SEL : 'button');
    for (const n of nodes) {
      const t = (n.getAttribute('aria-label') || n.textContent || '').toLowerCase();
      if (t.includes('show transcript')) return n.querySelector('button') || n;
    }
    return null;
  }
  function transcriptDiag(stage) {
    // Diagnostic console output is opt-in (set localStorage 'unsynth-debug') so
    // it doesn't spam every user's console on a transcript miss.
    try {
      if (typeof localStorage === 'undefined' || !localStorage.getItem('unsynth-debug')) return;
    } catch (e) {
      return;
    }
    try {
      // enumerate EVERY engagement panel so we can see which one holds the text
      const panels = Array.prototype.slice
        .call(document.querySelectorAll(YT ? YT.TRANSCRIPT_ENGAGEMENT_PANEL_SEL : 'none'))
        .map((p) => ({ id: p.getAttribute('target-id') || p.tagName.toLowerCase(), words: wordCount(p.innerText), len: (p.innerText || '').length }));
      const chosen = findTranscriptPanel();
      const ctxt = chosen ? chosen.innerText || '' : '';
      console.log(
        'UNSYNTH-TX ' + stage,
        JSON.stringify({
          chosen: chosen ? chosen.getAttribute('target-id') || chosen.tagName.toLowerCase() : 'none',
          chosenWords: wordCount(ctxt),
          parsed: parsePanelText(ctxt).length,
          buttonFound: !!findTranscriptButton(),
          panels: panels,
          sample: ctxt.replace(/\s+/g, ' ').trim().slice(0, 180)
        })
      );
    } catch (e) {
      console.log('UNSYNTH-TX diag-error', String(e));
    }
  }

  // Scroll the panel to force-render virtualized rows, merging by timestamp so
  // we get the whole transcript, not just the visible window.
  async function collectByScroll(panel, seed) {
    const gen = scrollGen; // capture at call time; bail if onNavigate/teardown increments it
    const map = new Map();
    const add = (arr) => arr.forEach((s) => { if (!map.has(s.startSec) || s.text.length > map.get(s.startSec).length) map.set(s.startSec, s.text); });
    add(seed);
    let lastText = panel ? panel.innerText || panel.textContent || '' : '';
    if (panel) {
      const scroller = panel.querySelector('#content, #contents, [id*="content"]') || panel;
      let stable = 0;
      for (let i = 0; i < 80 && stable < 5; i++) {
        if (scrollGen !== gen) return null; // cancelled by navigation or teardown
        const before = map.size;
        try {
          scroller.scrollTop = scroller.scrollHeight;
        } catch (e) {
          /* ignore */
        }
        await wait(150);
        if (scrollGen !== gen) return null; // cancelled after wait
        add(readPanelSegments(panel));
        lastText = panel.innerText || panel.textContent || lastText;
        stable = map.size === before ? stable + 1 : 0;
      }
    }
    // got real timestamped segments → use them
    if (map.size >= 2) {
      return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([startSec, text]) => ({ startSec, dur: 0, text }));
    }
    // no parseable timestamps but the panel has real prose → summarize the text
    // itself (no clickable jumps). Word gate rejects an empty/bot-blocked panel.
    const clean = lastText.replace(/\s+/g, ' ').trim();
    const words = (clean.match(/[A-Za-z']{2,}/g) || []).length;
    if (words >= 20) return [{ startSec: 0, dur: 0, text: clean }];
    const segs = [...map.entries()].map(([startSec, text]) => ({ startSec, dur: 0, text }));
    return segs.length ? segs : null;
  }

  // Close YouTube's native transcript panel once we've read it, so it doesn't
  // sit open behind our AI panel. Only called when WE opened it.
  function closeTranscriptPanel() {
    const panel = findTranscriptPanel();
    if (!panel) return;
    const btn =
      panel.querySelector(YT ? YT.TRANSCRIPT_PANEL_HEADER_BTN_SEL : '#visibility-button button');
    if (btn) {
      try {
        btn.click();
      } catch (e) {
        /* ignore */
      }
    }
  }

  // does the panel have real rendered transcript text (vs collapsed/empty)?
  const panelHasText = (pn) => pn && (pn.innerText || '').replace(/\s+/g, ' ').trim().length > 40;

  // short panel inventory (id:words) surfaced in the UI on failure, so the user
  // can see — and screenshot — where the transcript text is without the console
  function transcriptDiagInfo() {
    try {
      return (
        Array.prototype.slice
          .call(document.querySelectorAll(YT ? YT.TRANSCRIPT_ENGAGEMENT_PANEL_SEL : 'none'))
          .map((p) => (p.getAttribute('target-id') || '?') + ':' + wordCount(p.innerText) + 'w')
          .filter((s) => /transcript/i.test(s))
          .join(', ') || 'no transcript panel found'
      );
    } catch (e) {
      return 'diag-error';
    }
  }

  async function scrapeTranscriptPanelSegs() {
    let panel = findTranscriptPanel();
    // already open with content (the user opened it) — read it, leave it as-is
    if (panelHasText(panel)) {
      const segs = await collectByScroll(panel, readPanelSegments(panel));
      if (segs && segs.length) return segs;
    }
    // expand the description (the "Show transcript" button lives there)
    const expand = document.querySelector(YT ? YT.WATCH_DESC_EXPAND_SEL : '#expand');
    if (expand) {
      try {
        expand.click();
      } catch (e) {
        /* ignore */
      }
      await wait(350);
    }
    const btn = findTranscriptButton();
    if (!btn) {
      transcriptDiag('failed');
      return null;
    }
    // NOTE: we deliberately do NOT hide the panel while reading — hiding it can
    // stop YouTube from lazy-loading the transcript rows. It opens, we read it,
    // then we close it (below) so it doesn't linger behind our panel.
    try {
      btn.click();
    } catch (e) {
      return null;
    }
    for (let i = 0; i < 40; i++) {
      await wait(250);
      panel = findTranscriptPanel();
      if (panelHasText(panel)) {
        const segs = await collectByScroll(panel, readPanelSegments(panel));
        if (segs && segs.length) {
          closeTranscriptPanel();
          return segs;
        }
      }
    }
    transcriptDiag('failed'); // prints panel enumeration for diagnosis
    closeTranscriptPanel(); // opened but couldn't read it — don't leave it in the background
    return null;
  }

  async function loadTranscript() {
    if (state.segs) return state.segs;
    const vid = videoId();
    const cached = await cacheGet('transcript:' + vid);
    if (cached && cached.segs) {
      state.segs = cached.segs;
      state.txSource = cached.source || 'cache';
      const ctx = T.buildContext(cached.segs);
      state.context = ctx.text;
      state.truncated = ctx.truncated;
      updateTranscriptMeta();
      return state.segs;
    }
    // get_transcript (clean when it works) → panel scrape (reliable in-browser,
    // reads YouTube's own rendered transcript) → bare caption fetch (PO-gated)
    let segs = await fetchViaGetTranscript();
    let source = 'get_transcript';
    // backend BEFORE the panel scrape — it needs no DOM, so YouTube's transcript
    // panel never has to open/close (no flash) in the common case.
    if (!segs || !segs.length) {
      setStatus('Fetching transcript from the backend…');
      segs = await fetchViaBackend();
      source = 'backend';
    }
    if (!segs || !segs.length) {
      setStatus('Reading transcript from the panel…');
      segs = await scrapeTranscriptPanelSegs();
      source = 'panel';
    }
    if (!segs || !segs.length) {
      segs = await fetchJson3Segs();
      source = 'caption-fetch';
    }
    if (!segs || !segs.length) {
      const err = new Error('transcript_blocked');
      err.diag = transcriptDiagInfo();
      throw err;
    }
    // A LATE ANSWER MUST NOT BECOME ANOTHER VIDEO'S CONTEXT. Four sequential
    // network/DOM attempts run above, and only one of them (fetchJson3Segs)
    // goes through fetchWithTimeout, so onNavigate's abortFetches() cannot
    // cancel the other three. resetForVideo() replaces `state` wholesale on
    // navigation, so a late write lands on the NEW state object — video A's
    // transcript silently becomes the context every answer about video B is
    // generated from. Same guard resetForVideo() already uses at :1240.
    //
    // The cache write stays: it is keyed by the video the transcript actually
    // belongs to, so storing it is correct even when it arrived too late to use.
    cachePut('transcript:' + vid, { segs, source });
    if (vid !== videoId()) return segs;
    state.segs = segs;
    state.txSource = source;
    const ctx = T.buildContext(segs);
    state.context = ctx.text;
    state.truncated = ctx.truncated;
    updateTranscriptMeta();
    return segs;
  }

  function videoTitle() {
    const h = document.querySelector(YT ? YT.WATCH_TITLE_HEADING_SEL : 'h1');
    return h ? h.textContent.trim() : document.title.replace(/ - YouTube$/, '');
  }
  function channelTitle() {
    // The NAME, not the first link (yt-dom.watchChannelName: the first link is
    // the avatar, which has no text).
    return YT && YT.watchChannelName ? YT.watchChannelName() : '';
  }
  function systemPrompt() {
    const longNote = state.truncated
      ? 'This is a LONG video, so the transcript below is SAMPLED evenly across its full duration (not just the start). Cover the whole video, beginning to end. '
      : '';
    return (
      `You are a precise assistant answering about a YouTube video titled "${videoTitle()}". ` +
      longNote +
      'The transcript below is timestamped as [M:SS]. Answer ONLY from the transcript. ' +
      'Whenever you reference a moment, cite it as [M:SS] using the transcript timestamps.\n\nTranscript:\n' +
      state.context
    );
  }

  function llm(messages, max_tokens) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'UNSYNTH/AI/LLM', system: systemPrompt(), messages, max_tokens: max_tokens || 1024 }, (r) => resolve(r || { ok: false, error: 'no_response' }));
    });
  }
  // Streaming LLM over a port. Calls onDelta(fullTextSoFar) as tokens arrive;
  // resolves with { ok, content }. Falls back to non-streaming on connect error.
  function llmStream(messages, max_tokens, onDelta) {
    return new Promise((resolve) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'ai-stream' });
      } catch (e) {
        llm(messages, max_tokens).then(resolve);
        return;
      }
      let full = '';
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        activeStreamStop = null;
        try {
          port.disconnect();
        } catch (e) {
          /* ignore */
        }
        resolve(r);
      };
      // Let the Stop button end this stream early, keeping the partial text.
      activeStreamStop = () => finish(full ? { ok: true, content: full } : { ok: false, error: 'stopped' });
      port.onMessage.addListener((m) => {
        if (m.delta) {
          full += m.delta;
          onDelta(full);
        } else if (m.done) {
          finish({ ok: true, content: m.content || full });
        } else if (m.error) {
          finish({ ok: false, error: m.error, message: m.message });
        }
      });
      port.onDisconnect.addListener(() => finish(full ? { ok: true, content: full } : { ok: false, error: 'disconnected' }));
      port.postMessage({ type: 'stream', system: systemPrompt(), messages, max_tokens: max_tokens || 1024 });
    });
  }

  // Stop an in-flight generation; keeps whatever text already streamed in.
  function stopGeneration() {
    stopRequested = true; // covers the transcript-loading phase before a stream starts
    if (activeStreamStop) {
      const stop = activeStreamStop;
      activeStreamStop = null;
      stop();
    }
  }

  // human-readable LLM error (so a missing key says what to do, not "no_key")
  function llmErrorMsg(r) {
    if (!r) return 'No response from the AI.';
    if (r.error === 'stopped') return 'Stopped.';
    if (r.error === 'no_key') return 'No AI key set yet — open the Unsynth dashboard → AI tab and paste your key.';
    if (r.error === 'api_error') return 'AI provider error' + (r.status ? ' (' + r.status + ')' : '') + (r.message ? ': ' + r.message : '');
    if (r.error === 'network_error' || r.error === 'disconnected') return 'Network error reaching the AI provider — try again.';
    return 'Failed: ' + (r.error || 'unknown') + (r.message ? ' — ' + r.message : '');
  }

  // ---- rendering helpers (DOM methods — Trusted-Types safe) ----
  function el(tag, cls, text) { return window.UNSYNTH.el(tag, cls, text); }
  // Small "Copy" button appended to an assistant reply bubble (hover to reveal).
  function addCopyAction(bubble, content) {
    const cp = el('button', 'un-ai-msg-copy', 'Copy');
    cp.title = 'Copy this reply';
    cp.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        navigator.clipboard.writeText(content);
      } catch (err) {
        /* ignore */
      }
      cp.textContent = 'Copied';
      setTimeout(() => {
        cp.textContent = 'Copy';
      }, 1200);
    });
    bubble.appendChild(cp);
  }
  function renderLinked(container, text) {
    container.textContent = '';
    for (const part of T.linkifyParts(text)) {
      if (part.ts) {
        const b = el('button', 'un-ts', part.label);
        b.addEventListener('click', () => jumpTo(part.sec));
        container.appendChild(b);
      } else if (part.wiki) {
        const w = el('button', 'un-wiki', part.term);
        w.title = 'Search YouTube for "' + part.term + '"';
        w.setAttribute('aria-label', w.title);
        w.addEventListener('click', () => {
          chrome.runtime.sendMessage({
            type: 'UNSYNTH/OPEN_URL',
            url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(part.term)
          });
        });
        container.appendChild(w);
      } else {
        container.appendChild(document.createTextNode(part.text));
      }
    }
  }
  // render light Markdown (## headings, - bullets) with inline [M:SS] + [[wiki]]
  function renderStructured(container, text) {
    container.textContent = '';
    const lines = (text || '').split('\n');
    let ul = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        ul = null;
        continue;
      }
      const h = line.match(/^#{1,4}\s+(.*)$/);
      if (h) {
        ul = null;
        const hd = el('div', 'un-st-h');
        hd.textContent = h[1].replace(/\*\*/g, '');
        container.appendChild(hd);
        continue;
      }
      const b = line.match(/^[-•*]\s+(.*)$/);
      if (b) {
        if (!ul) {
          ul = el('ul', 'un-st-ul');
          container.appendChild(ul);
        }
        const li = document.createElement('li');
        renderLinked(li, b[1].replace(/\*\*/g, ''));
        ul.appendChild(li);
        continue;
      }
      ul = null;
      const p = el('div', 'un-st-p');
      renderLinked(p, line.replace(/\*\*/g, ''));
      container.appendChild(p);
    }
  }
  function setStatus(msg) {
    const s = panel.querySelector('.un-ai-status');
    if (s) s.textContent = msg || '';
  }
  // disable the controls while a request runs so they don't look dead / double-fire
  function setBusy(b) {
    if (!panel) return;
    panel.classList.toggle('un-busy', b);
    panel.querySelectorAll('.un-ai-btn, .un-ai-pill, .un-ai-send, .un-ai-input').forEach((c) => {
      c.disabled = b;
    });
    // Swap Send → Stop while generating (Stop stays enabled).
    const stop = panel.querySelector('.un-ai-stop');
    const send = panel.querySelector('.un-ai-send');
    if (stop) stop.style.display = b ? 'flex' : 'none';
    if (send) send.style.display = b ? 'none' : 'flex';
  }

  const PROVIDER_LABELS = { openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic' };

  function updateProviderHint() {
    if (!panel) return;
    const hint = panel.querySelector('.un-ai-provider');
    if (!hint) return;
    // When the hint is a clickable "open dashboard" affordance, make it a real
    // keyboard-reachable button; otherwise it is a passive status line.
    const setInteractive = (on) => {
      if (on) {
        hint.setAttribute('role', 'button');
        hint.setAttribute('tabindex', '0');
        hint.setAttribute('aria-label', 'Open Unsynth dashboard AI settings');
      } else {
        hint.setAttribute('role', 'status');
        hint.removeAttribute('tabindex');
        hint.removeAttribute('aria-label');
      }
    };
    chrome.runtime.sendMessage({ type: 'UNSYNTH/AI/CONFIG_GET' }, (r) => {
      if (!hint.isConnected) return;
      if (!r || !r.ok) {
        hint.textContent = 'AI provider unavailable';
        hint.classList.add('un-ai-no-key');
        setInteractive(true);
        return;
      }
      const prov = PROVIDER_LABELS[r.provider] || r.provider || 'AI';
      const hasKey = r.hasKey && r.hasKey[r.provider];
      const modelShort = r.model ? String(r.model).split('/').pop() : '';
      hint.textContent = hasKey ? prov + (modelShort ? ' · ' + modelShort : '') : 'No API key — open dashboard → AI';
      hint.classList.toggle('un-ai-no-key', !hasKey);
      hint.title = hasKey ? 'Active AI provider' : 'Click to open Unsynth dashboard → AI tab';
      setInteractive(!hasKey);
    });
  }

  function openDashboardAi() {
    try {
      chrome.runtime.sendMessage({
        type: 'UNSYNTH/OPEN_EXT_PAGE',
        path: 'src/dashboard/dashboard.html',
        hash: 'ai'
      });
    } catch (e) {
      /* ignore */
    }
  }

  // ---- actions ----
  async function withTranscript(fn) {
    if (state.busy) return;
    state.busy = true;
    stopRequested = false;
    setBusy(true);
    setStatus('Reading transcript…');
    try {
      await loadTranscript();
      // Stop may have been pressed while the transcript was still loading.
      if (stopRequested) { setStatus('Stopped.'); return; }
      setStatus('');
      await fn();
    } catch (e) {
      const msg =
        e.message === 'transcript_blocked'
          ? "Couldn't read the transcript — panels seen: " + (e.diag || 'none') + '.'
          : 'Error: ' + e.message;
      setStatus(msg);
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  async function doSummarize() {
    await withTranscript(async () => {
      setStatus('Summarizing…');
      const out = panel.querySelector('.un-ai-output');
      out.textContent = '';
      const hrow = el('div', 'un-ai-hrow');
      hrow.appendChild(el('div', 'un-ai-h', 'Summary'));
      out.appendChild(hrow);
      const body = el('div', 'un-ai-body');
      out.appendChild(body);
      const r = await llmStream(
        [
          {
            role: 'user',
            content:
              'Summarize this video for someone deciding whether to watch it. Output a 2-sentence TL;DR, then the 5-7 most important points as bullets. Use the actual claims, examples, and numbers from the transcript — be specific, never vague. End each bullet with the timestamp it comes from, like [3:24], using only timestamps that appear in the transcript. Wrap the most important named concepts, people, places, products, or terms in [[double brackets]] so the key topics stand out (e.g. [[Coalition of Ordered Governments]]).'
          }
        ],
        900,
        (text) => {
          body.textContent = text; // live, plain text
        }
      );
      setStatus('');
      if (r.ok) {
        renderLinked(body, r.content); // final pass makes [M:SS] clickable
        const copy = el('button', 'un-ai-copy', 'Copy');
        copy.addEventListener('click', () => {
          navigator.clipboard.writeText(r.content).then(() => {
            copy.textContent = 'Copied';
            setTimeout(() => (copy.textContent = 'Copy'), 1000);
          }).catch(() => {
            copy.textContent = 'Failed';
            setTimeout(() => (copy.textContent = 'Copy'), 1500);
          });
        });
        hrow.appendChild(copy);
        state.summary = r.content;
        state.outputKind = 'summary';
        saveSession();
      } else body.textContent = llmErrorMsg(r);
    });
  }

  const OVERVIEW_PROMPT =
    'Produce a STRUCTURED overview of this video, adapting to its type. First silently decide the type (lecture/tutorial, news/opinion/debate, review, story/lore, music, vlog, etc.). Then output Markdown with these sections, OMITTING any that do not apply:\n\n' +
    '## Topic\nOne line on what the video is about.\n\n' +
    '## Key points\n4-6 bullets of the most important content, each ending with its [M:SS] timestamp. Wrap key named concepts, people, or places in [[brackets]].\n\n' +
    '## Perspectives\n(ONLY for opinion/debate/news/argumentative videos — otherwise skip this whole section.) Bullets for: the stance the video takes; counterpoints or other sides it engages; and a "Blindspot:" bullet for what it leaves out or is one-sided on.\n\n' +
    '## Worth watching\nWho it is for, a one-line verdict, and an approximate read/watch-time note.\n\n' +
    'Be specific and concrete, never vague. Only use timestamps that appear in the transcript.';

  async function doOverview() {
    await withTranscript(async () => {
      setStatus('Building overview…');
      const out = panel.querySelector('.un-ai-output');
      out.textContent = '';
      const hrow = el('div', 'un-ai-hrow');
      hrow.appendChild(el('div', 'un-ai-h', 'Overview'));
      out.appendChild(hrow);
      const body = el('div', 'un-ai-body un-ai-structured');
      out.appendChild(body);
      const r = await llmStream([{ role: 'user', content: OVERVIEW_PROMPT }], 1200, (text) => {
        body.textContent = text;
      });
      setStatus('');
      if (r.ok) {
        renderStructured(body, r.content);
        const copy = el('button', 'un-ai-copy', 'Copy');
        copy.addEventListener('click', () => {
          navigator.clipboard.writeText(r.content).then(() => {
            copy.textContent = 'Copied';
            setTimeout(() => (copy.textContent = 'Copy'), 1000);
          }).catch(() => {
            copy.textContent = 'Failed';
            setTimeout(() => (copy.textContent = 'Copy'), 1500);
          });
        });
        hrow.appendChild(copy);
        state.summary = r.content;
        state.outputKind = 'overview';
        saveSession();
      } else body.textContent = llmErrorMsg(r);
    });
  }

  async function doChapters() {
    await withTranscript(async () => {
      setStatus('Finding chapters…');
      // Stream (even though we only use the final text) so the Stop button works.
      const r = await llmStream(
        [
          {
            role: 'user',
            content:
              'Divide this video into 5-10 chapters. Output ONLY a JSON array: [{"title":"...","startSec":N,"summary":"one sentence"}]. Use the transcript timestamps for startSec.'
          }
        ],
        900,
        function () {}
      );
      setStatus('');
      const out = panel.querySelector('.un-ai-output');
      out.textContent = '';
      out.appendChild(el('div', 'un-ai-h', 'Chapters'));
      if (!r.ok) {
        out.appendChild(el('div', 'un-ai-body', llmErrorMsg(r)));
        return;
      }
      let chapters = [];
      try {
        const m = r.content.match(/\[[\s\S]*\]/);
        chapters = JSON.parse(m ? m[0] : r.content);
      } catch (e) {
        out.appendChild(el('div', 'un-ai-body', 'Could not parse chapters.'));
        return;
      }
      for (const c of chapters) {
        const row = el('div', 'un-ai-chapter');
        const jump = el('button', 'un-ts', T.formatTimestamp(c.startSec || 0));
        jump.addEventListener('click', () => jumpTo(c.startSec || 0));
        row.appendChild(jump);
        row.appendChild(el('span', 'un-ch-title', ' ' + (c.title || '')));
        if (c.summary) row.appendChild(el('div', 'un-ch-sum', c.summary));
        out.appendChild(row);
      }
    });
  }

  async function sendChat(text) {
    if (!text) return;
    await withTranscript(async () => {
      const log = panel.querySelector('.un-ai-chat-log');
      const userMsg = el('div', 'un-ai-msg un-user');
      userMsg.textContent = text;
      log.appendChild(userMsg);
      state.messages.push({ role: 'user', content: text });
      if (state.messages.length > 40) state.messages = state.messages.slice(-40);
      setStatus('Thinking…');
      const a = el('div', 'un-ai-msg un-assistant');
      log.appendChild(a);
      const r = await llmStream(state.messages, 1024, (txt) => {
        a.textContent = txt; // stream tokens into the bubble
        log.scrollTop = log.scrollHeight;
      });
      setStatus('');
      if (r.ok) {
        renderLinked(a, r.content); // final pass for clickable timestamps
        addCopyAction(a, r.content);
        state.messages.push({ role: 'assistant', content: r.content });
        if (state.messages.length > 40) state.messages = state.messages.slice(-40);
        saveSession();
      } else {
        a.textContent = llmErrorMsg(r);
      }
      log.scrollTop = log.scrollHeight;
    });
  }


  // THE LAUNCHER LIVES IN THE MASTHEAD, NOT ON THE RIGHT EDGE.
  //
  // As a fixed tab at right:0 it painted over whatever the related column put
  // under it — measured at 100 percent zoom by zoom-reflow.spec.js, visible in
  // the 2026-09-21 captures as the tab sitting on the Stats card's corner — and
  // it stayed stranded mid-page when a panel opened. The masthead bar already
  // hosts every other module control (Select, Download, Pause), scrolls with
  // fades when it overflows, and is the one place a user looks for Unsynth.
  // Moved on every scan because YouTube rebuilds the masthead on navigation.
  //
  // FROM A KEPT REFERENCE, NOT A SELECTOR. The first version looked the tab up
  // with querySelector on each scan; when YouTube tore the masthead down the
  // old #un-synth-masthead-extra went with it, the tab inside it left the
  // document, and there was nothing left to find — both launchers vanished on
  // the first navigation (probed 2026-09-21: roots present, tabs absent, no
  // errors). The Download button survives the same rebuild because its module
  // keeps the element and re-appends it. Same here.
  let tabEl = null;
  let mountRetries = 0;
  // HOSTED IN THE SIDE PANEL on a watch page (2026-09-21): the AI tab body
  // lives in UNSidePanel's 'ai' tab, beside the video, and the masthead chip
  // opens that tab. Off /watch this module renders nothing anyway.
  let aiPanelEl = null;   // .un-ai-panel, the body this module renders
  let aiSetOpen = null;   // buildPanel's setOpen, so the host can drive it
  function hosted() {
    return !!(panel && panel.closest && panel.closest('#un-side-panel, #un-side-panel-float'));
  }
  function mountInHost() {
    const sp = window.UNSidePanel && window.UNSidePanel.register ? window.UNSidePanel : null;
    if (!sp || !aiPanelEl || !isWatch()) return;
    sp.register({
      id: 'ai', label: 'AI', order: 30,
      onShow: function () { if (aiSetOpen) aiSetOpen(true, true); },
      onHide: function () { if (aiSetOpen) aiSetOpen(false, true); }
    });
    // The whole root moves: the module finds its parts with panel.querySelector
    // on the root, so moving only the body would orphan every lookup.
    const hb = sp.body('ai');
    if (hb && panel && panel.parentElement !== hb) hb.appendChild(panel);
    // A door under the video too (2026-09-22). The masthead chip alone put
    // the AI tab 700px from where a watcher is looking.
    const deck = window.UNWatchDeck;
    if (deck && deck.slot && deck.setLauncher) {
      deck.slot('ai');
      deck.setLauncher('ai', function () { sp.toggle('ai'); });
      if (deck.setSummary) deck.setSummary('ai', 'Summarize or ask anything about this video');
      if (deck.syncEmpty) deck.syncEmpty();
      if (deck.syncCollapse) deck.syncCollapse();
    }
  }
  function mountTab() {
    const t = tabEl || document.querySelector('.un-ai-tab');
    const extra = document.getElementById('un-synth-masthead-extra');
    if (!t) return;
    if (!extra) {
      // On a quiet cold load (signed-out home, no feed) the first scan can run
      // before core has built the masthead slot, and a page with no further
      // mutations never scans again — the tab then sits hidden in its root
      // for good (playlist-picker-auth.spec.js timed out on exactly that).
      // Bounded: a page with no masthead at all stops asking after ~10s.
      if (mountRetries < 20) { mountRetries++; setTimeout(mountTab, 500); }
      return;
    }
    mountRetries = 0;
    if (t.parentElement !== extra) extra.appendChild(t);
  }

  // ---- panel ----
  function buildPanel() {
    const root = el('div', 'un-ai-root');
    const tab = el('button', 'un-wft-btn un-ai-tab');
    tabEl = tab;
    const tabDot = el('span', 'un-ai-tab-dot');
    tabDot.setAttribute('aria-hidden', 'true');
    tab.appendChild(tabDot);
    tab.appendChild(el('span', 'un-ai-tab-label', 'AI'));
    tab.title = 'Unsynth AI Assistant';
    tab.setAttribute('aria-label', tab.title);
    tab.setAttribute('aria-expanded', 'false');
    tab.setAttribute('aria-controls', 'un-ai-panel');
    const body = el('div', 'un-ai-panel');
    body.id = 'un-ai-panel';
    aiPanelEl = body;
    const resize = el('div', 'un-ai-resize');
    resize.title = 'Drag to resize';
    body.appendChild(resize);

    const header = el('header', 'un-ai-header');
    const brand = el('div', 'un-ai-brand');
    brand.appendChild(el('span', 'un-ai-dot'));
    brand.appendChild(el('span', 'un-ai-title', 'AI Assistant'));
    header.appendChild(brand);
    const headerActions = el('div', 'un-ai-header-actions');
    const collapse = el('button', 'un-ai-collapse', '−');
    collapse.setAttribute('aria-label', 'Collapse panel');
    collapse.title = 'Collapse';
    const close = el('button', 'un-ai-close', '×');
    close.setAttribute('aria-label', 'Close panel');
    close.title = 'Close';
    headerActions.appendChild(collapse);
    headerActions.appendChild(close);
    header.appendChild(headerActions);
    body.appendChild(header);

    const provider = el('div', 'un-ai-provider');
    provider.setAttribute('role', 'status');
    provider.addEventListener('click', () => {
      if (provider.classList.contains('un-ai-no-key')) openDashboardAi();
    });
    provider.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && provider.classList.contains('un-ai-no-key')) {
        e.preventDefault();
        openDashboardAi();
      }
    });
    body.appendChild(provider);

    const wrap = el('div', 'un-ai-body-wrap');

    const actions = el('div', 'un-ai-actions');
    const sumBtn = el('button', 'un-ai-btn', 'Summarize');
    const ovBtn = el('button', 'un-ai-btn', 'Overview');
    const chBtn = el('button', 'un-ai-btn', 'Chapters');
    sumBtn.addEventListener('click', doSummarize);
    ovBtn.addEventListener('click', doOverview);
    chBtn.addEventListener('click', doChapters);
    actions.appendChild(sumBtn);
    actions.appendChild(ovBtn);
    actions.appendChild(chBtn);
    if (FL && FL.similarSearchQuery) {
      const forgeBtn = el('button', 'un-ai-forge', 'Find similar in Forge');
      forgeBtn.type = 'button';
      forgeBtn.title = 'Search for similar videos in the Forge panel';
      forgeBtn.setAttribute('aria-label', forgeBtn.title);
      forgeBtn.addEventListener('click', function () {
        const vid = videoId() || '';
        const title = videoTitle();
        const channel = channelTitle();
        if (window.UNForge && window.UNForge.openSimilar) {
          window.UNForge.openSimilar(vid, title, channel);
        } else if (FL.forgeSeed) {
          window.open(FL.forgeSeed(vid, { title: title, auto: true }), '_blank', 'noopener');
        }
      });
      actions.appendChild(forgeBtn);
    }
    wrap.appendChild(actions);

    const toolbar = el('div', 'un-ai-toolbar');
    const tools = el('div', 'un-ai-tools');
    const clearBtn = el('button', 'un-ai-tool', 'Clear cache');
    clearBtn.title = 'Clear transcript and chat for this video';
    clearBtn.setAttribute('aria-label', clearBtn.title);
    clearBtn.addEventListener('click', clearVideoCache);
    const exportBtn = el('button', 'un-ai-tool', 'Export chat');
    exportBtn.addEventListener('click', exportChat);
    tools.appendChild(clearBtn);
    tools.appendChild(exportBtn);
    toolbar.appendChild(tools);
    toolbar.appendChild(el('div', 'un-ai-tx-meta'));
    wrap.appendChild(toolbar);

    const promptsSection = el('div', 'un-ai-prompts');
    promptsSection.appendChild(el('span', 'un-ai-section-label', 'Quick prompts'));
    const pills = el('div', 'un-ai-pills');
    promptsSection.appendChild(pills);
    wrap.appendChild(promptsSection);

    wrap.appendChild(el('div', 'un-ai-status'));

    const scroll = el('div', 'un-ai-scroll');
    scroll.appendChild(el('div', 'un-ai-output'));
    const log = el('div', 'un-ai-chat-log');
    scroll.appendChild(log);
    wrap.appendChild(scroll);

    const inputFooter = el('footer', 'un-ai-input-footer');
    const inputRow = el('div', 'un-ai-input-row');
    const ta = el('textarea', 'un-ai-input');
    ta.placeholder = 'Ask about this video…';
    ta.rows = 1;
    const send = el('button', 'un-ai-send');
    send.setAttribute('aria-label', 'Send message');
    const sendIco = el('span', 'un-ai-send-ico', '↑');
    sendIco.setAttribute('aria-hidden', 'true');
    send.appendChild(sendIco);
    const submit = () => {
      const v = ta.value.trim();
      if (!v) return;
      ta.value = '';
      sendChat(v);
    };
    send.addEventListener('click', submit);
    // Stop button — shown in place of Send while a generation streams.
    const stop = el('button', 'un-ai-stop');
    stop.setAttribute('aria-label', 'Stop generating');
    stop.title = 'Stop generating';
    stop.style.display = 'none';
    stop.appendChild(el('span', 'un-ai-stop-ico', '■'));
    stop.addEventListener('click', stopGeneration);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    inputRow.appendChild(ta);
    inputRow.appendChild(send);
    inputRow.appendChild(stop);
    inputFooter.appendChild(inputRow);
    wrap.appendChild(inputFooter);
    body.appendChild(wrap);

    const setOpen = (open, viaHost) => {
      // Hosted: the side panel owns open/close and Escape; we only mirror it.
      if (hosted() && !viaHost) {
        if (open) window.UNSidePanel.open('ai'); else window.UNSidePanel.close();
        return;
      }
      root.classList.toggle('open', open);
      tab.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        body.classList.remove('un-ai-collapsed');
        collapse.setAttribute('aria-label', 'Collapse panel');
        collapse.textContent = '−';
        // Push onto the LIFO Escape stack. Guard double-push. Not when hosted.
        if (!escHandle && !viaHost) {
          escHandle = window.UNSYNTH.pushPanel(() => {
            if (!root.classList.contains('un-ai-docked')) setOpen(false);
          });
        }
      } else {
        if (escHandle) { window.UNSYNTH.popPanel(escHandle); escHandle = null; }
      }
      chrome.storage.local.set({ aiPanelOpen: open });
      if (window.UNSideDock && window.UNSideDock.schedule) window.UNSideDock.schedule();
    };
    panelSetOpen = setOpen; // reused by the storage-restore and unsynth-ai-open paths

    aiSetOpen = setOpen;
    tab.setAttribute('data-un-sp-launch', 'ai');
    tab.addEventListener('click', () => {
      const isOpen = hosted()
        ? (window.UNSidePanel.isOpen() && window.UNSidePanel.active() === 'ai')
        : root.classList.contains('open');
      setOpen(!isOpen);
    });
    collapse.addEventListener('click', () => {
      body.classList.toggle('un-ai-collapsed');
      collapse.setAttribute('aria-label', body.classList.contains('un-ai-collapsed') ? 'Expand panel' : 'Collapse panel');
      collapse.textContent = body.classList.contains('un-ai-collapsed') ? '+' : '−';
    });
    close.addEventListener('click', () => setOpen(false));

    chrome.storage.local.get('aiPanelOpen', (d) => {
      // setOpen (not a bare classList.add) so the Esc-stack handle is pushed too.
      if (d && d.aiPanelOpen) setOpen(true);
    });

    chrome.storage.local.get('aiPanelWidth', (d) => {
      if (d && d.aiPanelWidth) {
        const w = d.aiPanelWidth;
        root.style.setProperty('--un-ai-w', typeof w === 'number' ? w + 'px' : String(w));
      }
    });
    updateProviderHint();
    (function () {
      let startX = 0;
      let startW = 0;
      const onMove = (e) => {
        const w = Math.min(720, Math.max(300, startW + (startX - e.clientX)));
        root.style.setProperty('--un-ai-w', w + 'px');
        if (window.UNSideDock && window.UNSideDock.schedule) window.UNSideDock.schedule();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        const w = root.style.getPropertyValue('--un-ai-w');
        if (w) chrome.storage.local.set({ aiPanelWidth: w.trim() });
        if (window.UNSideDock && window.UNSideDock.schedule) window.UNSideDock.schedule();
      };
      resize.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = body.getBoundingClientRect().width;
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    })();

    root.appendChild(tab);
    root.appendChild(body);
    return root;
  }

  function enabled() {
    return core && core.isModuleEnabled({ moduleKey: 'aiAssistant' });
  }

  function destroyPanel() {
    abortFetches();
    scrollGen++; // cancel any in-flight collectByScroll loop
    if (panel && panel.parentElement) panel.parentElement.removeChild(panel);
    panel = null;
    panelSetOpen = null; // closes over the removed panel; ensurePanel() reassigns it
    if (escHandle) { window.UNSYNTH.popPanel(escHandle); escHandle = null; }
    if (window.UNSideDock && window.UNSideDock.schedule) window.UNSideDock.schedule();
  }

  // Module-level teardown only — ensurePanel() also calls destroyPanel() when
  // the panel is disabled by prefs, and removing the init()-time listeners
  // there would leave prompt-sync and unsynth-ai-open dead after a re-enable.
  function teardownModule() {
    destroyPanel();
    if (onStorageChangedAI) {
      chrome.storage.onChanged.removeListener(onStorageChangedAI);
      onStorageChangedAI = null;
    }
    if (onAiOpen) {
      window.removeEventListener('unsynth-ai-open', onAiOpen);
      onAiOpen = null;
    }
  }

  function updateTranscriptMeta() {
    if (!panel) return;
    const meta = panel.querySelector('.un-ai-tx-meta');
    if (!meta) return;
    const parts = [];
    if (state.txSource) parts.push('Source: ' + state.txSource);
    if (state.truncated) parts.push('sampled for length');
    meta.textContent = parts.length ? parts.join(' · ') : '';
  }

  function clearVideoCache() {
    const vid = videoId();
    if (!vid) return;
    state.segs = null;
    state.context = '';
    state.truncated = false;
    state.txSource = '';
    chrome.storage.local.remove(['transcript:' + vid, 'session:' + vid]);
    if (panel) {
      panel.querySelector('.un-ai-output').textContent = '';
      panel.querySelector('.un-ai-chat-log').textContent = '';
      setStatus('Cache cleared for this video.');
      updateTranscriptMeta();
    }
    state.messages = [];
    state.summary = '';
    state.outputKind = '';
  }

  function exportChat() {
    const lines = [];
    const title = videoTitle();
    if (title) lines.push('# ' + title);
    if (state.summary) {
      lines.push('\n## ' + (state.outputKind === 'overview' ? 'Overview' : 'Summary') + '\n');
      lines.push(state.summary);
    }
    (state.messages || []).forEach((m) => {
      lines.push('\n**' + (m.role === 'user' ? 'You' : 'AI') + ':**\n' + m.content);
    });
    const text = lines.join('\n').trim();
    navigator.clipboard.writeText(text);
    setStatus('Chat copied as Markdown.');
  }

  let customPrompts = [];
  function loadPrompts(cb) {
    chrome.storage.sync.get({ aiPrompts: DEFAULT_PROMPTS }, (s) => {
      customPrompts = Array.isArray(s.aiPrompts) && s.aiPrompts.length ? s.aiPrompts : DEFAULT_PROMPTS;
      cb && cb();
    });
  }
  function renderPills() {
    if (!panel) return;
    const pills = panel.querySelector('.un-ai-pills');
    if (!pills) return;
    pills.textContent = '';
    customPrompts.forEach((p) => {
      const pill = el('button', 'un-ai-pill', p.name);
      pill.addEventListener('click', () => sendChat(p.prompt));
      pills.appendChild(pill);
    });
  }

  function ensurePanel() {
    if (!enabled()) {
      destroyPanel();
      return;
    }
    if (!isWatch()) {
      if (panel) panel.style.display = 'none';
      return;
    }
    if (!panel || !document.body.contains(panel)) {
      panel = buildPanel();
      document.body.appendChild(panel);
      loadPrompts(renderPills);
      updateProviderHint();
    }
    panel.style.display = '';
    mountInHost();
  }

  // persist the chat + summary per video so they survive navigation
  function saveSession() {
    const vid = state.videoId;
    if (!vid) return;
    cachePut('session:' + vid, {
      messages: (state.messages || []).slice(-40).map((m) => ({
        role: m && m.role === 'user' ? 'user' : 'assistant',
        content: String((m && m.content) || '').slice(0, 12000)
      })),
      summary: String(state.summary || '').slice(0, 50000),
      outputKind: state.outputKind || 'summary'
    });
  }
  function restoreChatMsg(log, m) {
    const d = el('div', 'un-ai-msg ' + (m.role === 'user' ? 'un-user' : 'un-assistant'));
    if (m.role === 'user') {
      d.textContent = m.content;
    } else {
      renderLinked(d, m.content);
      addCopyAction(d, m.content);
    }
    log.appendChild(d);
  }
  function resetForVideo() {
    const vid = videoId();
    if (vid === state.videoId) return;
    state = { videoId: vid, segs: null, context: '', messages: [], busy: false, summary: '', outputKind: '', txSource: '', truncated: false };
    if (panel) {
      panel.querySelector('.un-ai-output').textContent = '';
      panel.querySelector('.un-ai-chat-log').textContent = '';
      setStatus('');
    }
    if (!vid) return;
    cacheGet('session:' + vid).then((s) => {
      if (!s || vid !== videoId()) return; // navigated away while loading
      state.messages = s.messages || [];
      state.summary = s.summary || '';
      state.outputKind = s.outputKind || 'summary';
      if (!panel) return;
      if (s.summary) {
        const out = panel.querySelector('.un-ai-output');
        out.textContent = '';
        const hrow = el('div', 'un-ai-hrow');
        hrow.appendChild(el('div', 'un-ai-h', state.outputKind === 'overview' ? 'Overview' : 'Summary'));
        out.appendChild(hrow);
        const b = el('div', 'un-ai-body');
        renderLinked(b, s.summary);
        out.appendChild(b);
      }
      const log = panel.querySelector('.un-ai-chat-log');
      log.textContent = '';
      (s.messages || []).forEach((m) => restoreChatMsg(log, m));
      log.scrollTop = log.scrollHeight;
    });
  }

  const mod = {
    id: 'aiAssistant',
    moduleKey: 'aiAssistant',
    init(c) {
      core = c;
      loadPrompts(() => {
        if (enabled()) {
          ensurePanel();
          resetForVideo();
        }
      });
      onStorageChangedAI = (ch, area) => {
        if (area === 'sync' && ch.aiPrompts) loadPrompts(renderPills);
      };
      chrome.storage.onChanged.addListener(onStorageChangedAI);
      // Let other modules (e.g. the Stats card) open the panel + kick off a summary.
      onAiOpen = (e) => {
        if (!enabled()) return;
        ensurePanel();
        if (!panel) return;
        // Route through setOpen so the Esc-stack handle + aria-expanded sync fire.
        if (panelSetOpen) panelSetOpen(true);
        else panel.classList.add('open');
        if (e.detail && e.detail.summarize) doSummarize();
      };
      window.addEventListener('unsynth-ai-open', onAiOpen);
    },
    scan() {
      mountTab();
      mountInHost();
      ensurePanel();
    },
    onNavigate() {
      mountTab();
      mountInHost();
      scrollGen++; // cancel any in-flight collectByScroll loop for the previous page
      abortFetches();
      ensurePanel();
      resetForVideo();
    },
    onSettings(s) {
      if (!core.isModuleEnabled({ moduleKey: 'aiAssistant' })) destroyPanel();
      else ensurePanel();
    },
    // Core skips onSettings for a just-disabled module, so remove the panel here.
    teardown: teardownModule
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
