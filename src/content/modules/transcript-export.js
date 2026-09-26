/**
 * Transcript export — copy or download the current video's transcript as
 * plain text. Reuses shared/transcript.js's canonical parsePanelText (the
 * same parser ai-assistant.js/fact-check.js already rely on) rather than
 * re-implementing panel scraping.
 *
 * Deliberately simpler than ai-bridge.js's invisible open/scrape/restore
 * dance: that exists because ai-assistant gathers context in the background
 * without the user asking for a panel. Here the user explicitly clicked
 * "Export transcript", so YouTube's own transcript panel opening visibly is
 * expected, normal behavior, not something to hide.
 */
(function () {
  'use strict';

  let core = null;
  const TX_PANEL_SEL = 'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]';

  function el(tag, cls, text) {
    return window.UNSYNTH.el(tag, cls, text);
  }

  function findToggle(rx) {
    const buttons = document.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim();
      if (rx.test(label)) return b;
    }
    const rends = document.querySelectorAll('ytd-button-renderer, yt-button-shape');
    for (let i = 0; i < rends.length; i++) {
      const label = (rends[i].textContent || '').trim();
      if (rx.test(label)) return rends[i].querySelector('button') || rends[i];
    }
    return null;
  }

  function scrapeDom() {
    const out = [];
    document.querySelectorAll('ytd-transcript-segment-renderer').forEach((seg) => {
      const tEl = seg.querySelector('.segment-text') || seg.querySelector('yt-formatted-string.segment-text');
      const tsEl = seg.querySelector('.segment-timestamp');
      const text = (tEl ? tEl.textContent : seg.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      out.push({ startSec: tsEl ? (window.UNTranscript.secondsFromTs(tsEl.textContent) || 0) : 0, dur: 0, text });
    });
    if (out.length) return out;
    let best = null;
    let bestLen = 0;
    document.querySelectorAll(TX_PANEL_SEL).forEach((p) => {
      const len = (p.innerText || '').length;
      if (len > bestLen) {
        bestLen = len;
        best = p;
      }
    });
    return best ? window.UNTranscript.parsePanelText(best.innerText || '') : [];
  }

  async function ensurePanelOpenAndScrape() {
    let segs = scrapeDom();
    if (segs.length) return segs;
    const openBtn = findToggle(/^show transcript$/i);
    if (openBtn) openBtn.click();
    const start = Date.now();
    while (Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 300));
      segs = scrapeDom();
      if (segs.length) return segs;
    }
    return [];
  }

  let panelEl = null;
  function closePopup() {
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function segsToText(segs) {
    return segs.map((s) => '[' + window.UNTranscript.formatTimestamp(s.startSec) + '] ' + s.text).join('\n');
  }

  function safeFilename() {
    const title = document.title.replace(/ - YouTube$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    return (title || 'transcript') + '.txt';
  }

  async function openExportPopup() {
    closePopup();
    const host = document.getElementById('movie_player') || document.body;
    panelEl = el('div', 'un-tx-export-panel');
    panelEl.appendChild(el('div', 'un-tx-export-title', 'Fetching transcript…'));
    host.appendChild(panelEl);

    const segs = await ensurePanelOpenAndScrape();
    if (!panelEl) return; // closed while fetching
    panelEl.textContent = '';
    if (!segs.length) {
      panelEl.appendChild(el('div', 'un-tx-export-title', 'No transcript available for this video.'));
      const close = el('button', 'un-tx-export-btn', 'Close');
      close.addEventListener('click', closePopup);
      panelEl.appendChild(close);
      return;
    }

    const text = segsToText(segs);
    panelEl.appendChild(el('div', 'un-tx-export-title', segs.length + ' segments'));
    const actions = el('div', 'un-tx-export-actions');
    const copyBtn = el('button', 'un-tx-export-btn', 'Copy to clipboard');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = 'Copy to clipboard';
          }, 1500);
        })
        .catch(() => {
          copyBtn.textContent = 'Copy failed';
        });
    });
    const downloadBtn = el('button', 'un-tx-export-btn', 'Download .txt');
    downloadBtn.addEventListener('click', () => downloadText(text, safeFilename()));
    const close = el('button', 'un-tx-export-btn un-tx-export-close', 'Close');
    close.addEventListener('click', closePopup);
    actions.append(copyBtn, downloadBtn, close);
    panelEl.appendChild(actions);
  }

  function isWatch() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }

  // Moved from a standalone player button into the Unsynth tools overflow
  // menu — an occasional action, not a single-tap frequently-used control
  // (see docs/LESSONS.md for why the player bar was reorganized). The
  // export popup itself isn't anchored to the button's position, so this
  // move is purely cosmetic for the trigger.
  function ensureButton() {
    if (!window.UNSYNTH || !window.UNSYNTH.addMenuItem) return;
    if (!isWatch()) {
      if (window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem('un-tx-export-btn-player');
      return;
    }
    window.UNSYNTH.addMenuItem({
      id: 'un-tx-export-btn-player',
      svg: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
      label: 'Export transcript',
      onClick: openExportPopup,
      priority: 45
    });
  }

  const mod = {
    id: 'transcriptExport',
    moduleKey: 'transcriptExport',
    init: function (c) {
      core = c;
      ensureButton();
    },
    scan: function () {
      ensureButton();
    },
    onNavigate: function () {
      closePopup();
      ensureButton();
    },
    onSettings: function (s) {
      core.settings = s;
      ensureButton();
    },
    teardown: function () {
      closePopup();
      if (window.UNSYNTH && window.UNSYNTH.removeMenuItem) window.UNSYNTH.removeMenuItem('un-tx-export-btn-player');
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
