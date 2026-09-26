/**
 * GitHub manifest version check + update command templates.
 * Used by the service worker; semver display helpers are in semver.js.
 */
(function (g) {
  'use strict';

  const REPO = 'Phaenex/unsynth';
  const MANIFEST_API = 'https://api.github.com/repos/' + REPO + '/contents/manifest.json?ref=main';
  const RELEASE_MANIFEST_URL = 'https://unsynth.vercel.app/downloads/update.json';
  const RELEASE_DOWNLOAD_URL = 'https://unsynth.vercel.app/downloads/unsynth-latest.zip';

  function validRelease(data) {
    if (!data || !/^\d+\.\d+\.\d+$/.test(String(data.version || ''))) throw new Error('no_version');
    const downloadUrl = String(data.downloadUrl || RELEASE_DOWNLOAD_URL);
    if (downloadUrl !== RELEASE_DOWNLOAD_URL) throw new Error('bad_download_url');
    return {
      ok: true,
      remoteVersion: String(data.version),
      downloadUrl,
      sha256: /^[a-f0-9]{64}$/i.test(String(data.sha256 || '')) ? String(data.sha256).toLowerCase() : '',
      source: 'deployment'
    };
  }

  async function fetchDeployedRelease(fetchFn) {
    const fetchImpl = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('no_fetch');
    const response = await fetchImpl(RELEASE_MANIFEST_URL, { cache: 'no-cache', credentials: 'omit' });
    if (!response.ok) throw new Error('release_http_' + response.status);
    return validRelease(await response.json());
  }

  function decodeGitHubContent(data) {
    if (!data || !data.content) throw new Error('no_content');
    const raw = data.content.replace(/\n/g, '');
    const json = typeof atob === 'function' ? atob(raw) : Buffer.from(raw, 'base64').toString('utf8');
    const manifest = JSON.parse(json);
    if (!manifest || !manifest.version) throw new Error('no_version');
    return String(manifest.version);
  }

  /**
   * @param {string} pat GitHub PAT (repo scope for private repo; optional for public)
   * @param {typeof fetch} fetchFn
   */
  async function fetchRemoteManifestVersion(pat, fetchFn) {
    const fetchImpl = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('no_fetch');

    const baseHeaders = {
      Accept: 'application/vnd.github+json',
      // GitHub's only released API version — an unsupported value gets HTTP 400.
      'X-GitHub-Api-Version': '2022-11-28'
    };

    async function parseOkResponse(r) {
      const data = await r.json();
      const version = decodeGitHubContent(data);
      return { ok: true, remoteVersion: version };
    }

    // Public repo: unauthenticated GitHub API access works
    const publicRes = await fetchImpl(MANIFEST_API, { headers: baseHeaders, cache: 'no-cache' });
    if (publicRes.ok) {
      try {
        return await parseOkResponse(publicRes);
      } catch (e) {
        return { ok: false, error: 'parse_failed', message: (e && e.message) || String(e) };
      }
    }

    const trimmedPat = (pat || '').trim();
    if (!trimmedPat) {
      if (publicRes.status === 404 || publicRes.status === 403) {
        return {
          ok: false,
          needsPat: true,
          error: 'no_pat',
          message: 'Private repo requires a GitHub token with repo scope.'
        };
      }
      const body = await publicRes.json().catch(() => ({}));
      return {
        ok: false,
        error: 'http_' + publicRes.status,
        message: (body && body.message) || 'GitHub API error ' + publicRes.status
      };
    }

    const authHeaders = Object.assign({}, baseHeaders, { Authorization: 'Bearer ' + trimmedPat });
    const r = await fetchImpl(MANIFEST_API, { headers: authHeaders, cache: 'no-cache' });
    if (r.status === 401) return { ok: false, error: 'auth_failed', message: 'Invalid or expired GitHub token.' };
    if (r.status === 403) {
      const body = await r.json().catch(() => ({}));
      const msg = (body && body.message) || 'GitHub API forbidden — check token repo scope.';
      return { ok: false, error: 'forbidden', message: msg };
    }
    if (r.status === 404) {
      return { ok: false, error: 'not_found', message: 'Repository or manifest not found — token may lack repo access.' };
    }
    if (!r.ok) {
      return { ok: false, error: 'http_' + r.status, message: 'GitHub API error ' + r.status };
    }
    try {
      return await parseOkResponse(r);
    } catch (e) {
      return { ok: false, error: 'parse_failed', message: (e && e.message) || String(e) };
    }
  }

  function detectPlatform(ua) {
    const s = String(ua || (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '');
    if (/Win/i.test(s)) return 'win';
    if (/Mac/i.test(s)) return 'mac';
    if (/Linux/i.test(s)) return 'linux';
    return 'generic';
  }

  function extensionsReloadUrl(ua) {
    const s = String(ua || (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '');
    if (/\bEdg(?:e|A|iOS)?\//i.test(s)) return 'edge://extensions';
    if (/\bOPR\//i.test(s)) return 'opera://extensions';
    if (/\bBrave\b/i.test(s)) return 'brave://extensions';
    return 'chrome://extensions';
  }

  /** Prefer the public deployed release; private GitHub is a fallback. */
  async function fetchLatestRelease(pat, fetchFn) {
    try {
      return await fetchDeployedRelease(fetchFn);
    } catch (releaseError) {
      const github = await fetchRemoteManifestVersion(pat, fetchFn);
      if (github.ok) {
        github.source = 'github';
        github.downloadUrl = RELEASE_DOWNLOAD_URL;
      } else {
        github.releaseError = (releaseError && releaseError.message) || String(releaseError);
      }
      return github;
    }
  }

  function updateCommand(platform, clonePath, ua) {
    const p = platform || detectPlatform(ua);
    const extUrl = extensionsReloadUrl(ua);
    if (p === 'win') {
      const dir = clonePath || 'C:\\path\\to\\unsynth';
      return 'cd ' + dir + '\r\nnpm run update\r\necho Reload extension at ' + extUrl;
    }
    const dir = clonePath || '~/Projects/Unsynth';
    return 'cd ' + dir + ' && npm run update && echo "Reload extension at ' + extUrl + '"';
  }

  function genericUpdateCommand() {
    return 'git pull';
  }

  const api = {
    REPO,
    MANIFEST_API,
    RELEASE_MANIFEST_URL,
    RELEASE_DOWNLOAD_URL,
    validRelease,
    fetchDeployedRelease,
    decodeGitHubContent,
    fetchRemoteManifestVersion,
    fetchLatestRelease,
    detectPlatform,
    extensionsReloadUrl,
    updateCommand,
    genericUpdateCommand
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNUpdateCheck = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
