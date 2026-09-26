/**
 * Offscreen update fetcher.
 *
 * Fetches the Unsynth release ZIP, hashes it against the published sha256 and
 * only then turns the bytes into a blob: URL for chrome.downloads. The service
 * worker can't call URL.createObjectURL, so this runs in an offscreen document.
 */
(function () {
  'use strict';

  const urls = new Map(); // token -> { objUrl, timer }
  const FETCH_TIMEOUT_MS = 30000;
  const TOKEN_TTL_MS = 15 * 60 * 1000;

  // The only host this document fetches from: our own release artifacts, so the
  // update ZIP can be hashed and verified before it reaches chrome.downloads.
  // Video streams used to be allowed here for the downloader, which was removed
  // on purpose (tag archive/with-video-downloader). Keep this list at one host.
  const RELEASE_HOST = 'unsynth.vercel.app';

  function isAllowedHost(hostname) {
    return String(hostname || '').toLowerCase() === RELEASE_HOST;
  }

  /** Lowercase hex SHA-256 of an ArrayBuffer. */
  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  function isTrustedOffscreenSender(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    const url = sender.url || '';
    try {
      const senderUrl = new URL(url);
      const runtimeUrl = new URL(chrome.runtime.getURL('/'));
      return senderUrl.protocol === runtimeUrl.protocol && senderUrl.host === runtimeUrl.host;
    } catch (e) {
      return false;
    }
  }

  function revokeToken(token) {
    const entry = urls.get(token);
    if (!entry) return;
    try { URL.revokeObjectURL(entry.objUrl); } catch (e) { /* ignore */ }
    if (entry.timer) clearTimeout(entry.timer);
    urls.delete(token);
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.target !== 'offscreen-download') return; // not ours — ignore
    if (!isTrustedOffscreenSender(sender)) {
      sendResponse({ ok: false, error: 'forbidden' });
      return false;
    }

    if (msg.action === 'fetch') {
      (async function () {
        try {
          let host = '';
          try { host = new URL(msg.url).hostname; } catch (e) {
            sendResponse({ ok: false, error: 'bad_url' });
            return;
          }
          if (!isAllowedHost(host)) {
            sendResponse({ ok: false, error: 'bad_url' });
            return;
          }
          const ctrl = new AbortController();
          const timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
          let res;
          try {
            res = await fetch(msg.url, {
              credentials: 'omit',
              redirect: 'follow',
              signal: ctrl.signal
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok && res.status !== 206) {
            sendResponse({ ok: false, error: 'http_' + res.status });
            return;
          }
          const ct = res.headers.get('content-type') || '';
          // The ZIP must not come back as text/HTML — that's an error page, not
          // the archive. Fail loudly instead of saving junk.
          if (/^(text\/|application\/(json|xml))/i.test(ct)) {
            sendResponse({ ok: false, error: 'not_media:' + ct.split(';')[0] });
            return;
          }
          const blob = await res.blob();
          if (!blob.size) {
            sendResponse({ ok: false, error: 'empty' });
            return;
          }
          // Optional integrity gate (used by the update fetch). Hash the bytes we
          // actually received and refuse to hand back a blob URL on mismatch —
          // otherwise a tampered or truncated release ZIP lands in Downloads
          // looking exactly like a good one, ready to be sideloaded.
          const expected = String(msg.sha256 || '').toLowerCase();
          let digest = '';
          if (expected) {
            if (!/^[a-f0-9]{64}$/.test(expected)) {
              sendResponse({ ok: false, error: 'bad_sha256' });
              return;
            }
            digest = await sha256Hex(await blob.arrayBuffer());
            if (digest !== expected) {
              sendResponse({ ok: false, error: 'sha256_mismatch', sha256: digest });
              return;
            }
          }
          const objUrl = URL.createObjectURL(blob);
          const token = 'o' + Date.now() + Math.random().toString(36).slice(2, 8);
          const ttl = setTimeout(function () { revokeToken(token); }, TOKEN_TTL_MS);
          urls.set(token, { objUrl: objUrl, timer: ttl });
          sendResponse({ ok: true, objUrl: objUrl, token: token, size: blob.size, type: ct, sha256: digest, verified: !!expected });
        } catch (e) {
          sendResponse({ ok: false, error: (e && e.message) || String(e) });
        }
      })();
      return true; // async response
    }

    if (msg.action === 'revoke') {
      revokeToken(msg.token);
      sendResponse({ ok: true });
      return false;
    }
  });
})();
