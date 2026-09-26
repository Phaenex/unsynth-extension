/**
 * Pure transcript helpers — no DOM, no chrome APIs.
 *   - parseJson3      YouTube timedtext json3 → [{startSec, dur, text}]
 *   - formatTimestamp seconds → "M:SS" / "H:MM:SS"
 *   - secondsFromTs   "1:23" / "1:02:03" → seconds
 *   - buildContext    segments → "[M:SS] text" lines for the LLM (length-capped)
 *   - linkifyParts    split text on [M:SS] refs → parts for clickable rendering
 *   - pickTrack       choose the best caption track (prefer English, non-asr)
 *   - parseGetTranscript  Innertube get_transcript JSON → segments
 *   - parsePanelText  rendered transcript-panel text → segments
 *
 * CANONICAL transcript parsing lives here. Callers (ai-assistant.js, fact-check.js
 * via ai-bridge.js) MUST delegate to UNTranscript.parsePanelText /
 * UNTranscript.parseGetTranscript rather than re-implementing panel scraping, so
 * the parser stays in one unit-tested place when YouTube renames its DOM again.
 *
 * UMD: attaches UNTranscript to the global (content script) + exports for tests.
 */
(function (g) {
  'use strict';

  function parseJson3(data) {
    const events = (data && data.events) || [];
    const out = [];
    for (const e of events) {
      if (!e.segs) continue;
      const text = e.segs
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      out.push({ startSec: Math.round((e.tStartMs || 0) / 1000), dur: Math.round((e.dDurationMs || 0) / 1000), text });
    }
    return out;
  }

  function formatTimestamp(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function secondsFromTs(str) {
    const parts = String(str).split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  }

  /**
   * Serialize segments as "[M:SS] text" lines, capped to ~maxChars. If the full
   * transcript fits, use all of it. If it's too long (e.g. a multi-hour video),
   * SAMPLE evenly across the whole thing so the summary covers the entire video,
   * not just the first stretch.
   */
  function buildContext(segs, maxChars) {
    maxChars = maxChars || 48000;
    const lines = (segs || []).map((s) => `[${formatTimestamp(s.startSec)}] ${s.text}`);
    const full = lines.join('\n');
    if (full.length <= maxChars) return { text: full, truncated: false };
    // too long — keep every Nth line so coverage spans the full duration
    const step = Math.max(2, Math.ceil(full.length / maxChars));
    const kept = [];
    let len = 0;
    for (let i = 0; i < lines.length; i += step) {
      const line = lines[i];
      if (len + line.length + 1 > maxChars) break;
      kept.push(line);
      len += line.length + 1;
    }
    return { text: kept.join('\n'), truncated: true };
  }

  // [[wikiterm]] OR [M:SS] timestamp
  const LINK_RE = /\[\[([^\]]+)\]\]|\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

  /** Split text into parts: {text} | {ts,label,sec} | {wiki,term} for rendering. */
  function linkifyParts(text) {
    const parts = [];
    let last = 0;
    let m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(text)) !== null) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index) });
      if (m[1] != null) {
        parts.push({ wiki: true, term: m[1].trim() });
      } else {
        const sec = secondsFromTs(m[2]);
        if (sec == null) parts.push({ text: m[0] });
        else parts.push({ ts: true, label: m[0], sec });
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts;
  }

  function deepFindKey(obj, key, depth) {
    depth = depth || 0;
    if (!obj || depth > 16 || typeof obj !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const k in obj) {
      const v = deepFindKey(obj[k], key, depth + 1);
      if (v != null) return v;
    }
    return null;
  }

  /** get_transcript Innertube response → [{startSec, dur, text}]. */
  function parseGetTranscript(json) {
    const list = deepFindKey(json, 'initialSegments') || [];
    const out = [];
    for (const it of list) {
      const r = it && it.transcriptSegmentRenderer;
      if (!r) continue;
      const runs = (r.snippet && r.snippet.runs) || [];
      const text = runs.map((x) => x.text || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({ startSec: Math.round((parseInt(r.startMs, 10) || 0) / 1000), dur: 0, text });
    }
    return out;
  }

  /**
   * Parse a rendered transcript panel's TEXT into [{startSec, dur, text}].
   * Element-agnostic on purpose: it reads "[timestamp] line" pairs out of the
   * text, so it survives YouTube renaming the segment elements (which it has
   * done — the old ytd-transcript-segment-renderer vs the modern panel view).
   */
  function parsePanelText(text) {
    const out = [];
    if (!text) return out;
    const re = /(\d{1,2}:\d{2}(?::\d{2})?)[\s ]+([\s\S]*?)(?=\d{1,2}:\d{2}(?::\d{2})?[\s ]|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const sec = secondsFromTs(m[1]);
      const t = (m[2] || '').replace(/\s+/g, ' ').trim();
      if (sec != null && t && t.length > 1) out.push({ startSec: sec, dur: 0, text: t });
    }
    return out;
  }

  /** Pick the best caption track: prefer English, prefer human over asr. */
  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const en = tracks.filter((t) => (t.languageCode || '').toLowerCase().startsWith('en'));
    const pool = en.length ? en : tracks;
    const human = pool.find((t) => t.kind !== 'asr');
    return human || pool[0];
  }

  const api = { parseJson3, formatTimestamp, secondsFromTs, buildContext, linkifyParts, pickTrack, parseGetTranscript, parsePanelText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNTranscript = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
