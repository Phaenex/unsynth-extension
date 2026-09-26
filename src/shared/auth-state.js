'use strict';

/**
 * ONE READING OF "IS THE ACCOUNT CONNECTED?"
 *
 * authStatus() in the service worker already returns the three facts that
 * answer this properly, and its own comment records the bug that made them
 * necessary: the dashboard printed a green "Connected ✓" for a token that was
 * expired with no refresh_token, or one Google had already revoked, and every
 * API call then failed while the UI insisted the account was fine.
 *
 * That was fixed IN THE DASHBOARD and nowhere else. Measured 2026-09-19 across
 * the four consumers of AUTH_STATUS:
 *
 *   dashboard-account.js:232   authed && usable !== false     CORRECT
 *   forge-bridge.js:53         authed                          reports CONNECTED
 *   organizer.js:72            authed && write                 reports CONNECTED
 *   stats.js:522               authed && write                 reports CONNECTED
 *
 * So with a dead token the account reads connected everywhere except the
 * dashboard — and forge-bridge.js:57 answers the website HTTP 200 with
 * connected:true, after which every call fails. That is "connected but nothing
 * works", which is indistinguishable from a disconnection to anyone using it.
 *
 * Four copies of a predicate is how they drifted. One copy, here, with each
 * question named separately, because they ARE separate questions:
 *
 *   isConnected     a usable authorization exists  (not merely a stored token)
 *   canWrite        that authorization may modify playlists
 *   needsReconnect  a token is present but dead — a DIFFERENT message from
 *                   "not connected", because the user already did the setup
 *   needsSetup      no OAuth credentials configured at all
 *
 * Node-safe and browser-safe: attaches to window when there is one, exports for
 * the unit tests when there is not.
 */
(function (root) {
  /**
   * COULD WE EVEN ASK?
   *
   * A failed status CHECK is not a failed AUTHORIZATION. The service worker
   * asleep, a dropped message, an offline machine, a 500 from Google, a quota
   * refusal — none of those say anything about whether the stored credential is
   * good, and treating them as "not connected" sends a user to re-authorize an
   * account that was never broken.
   *
   * The same principle is already applied to storage in dashboard-core.js:
   * "Never claim an empty library when the store simply could not be read — '0
   * pinned' reads as data loss." A false "sign in again" is the auth version of
   * that.
   *
   * A reply is only an ANSWER when it carries the shape authStatus() returns.
   * `{ok:false}`, undefined, or a transport error is a non-answer.
   */
  function isAnswer(status) {
    if (!status || typeof status !== 'object') return false;
    if (status.ok === false) return false;
    // authStatus() always sets authed, even when false. Its absence means this
    // object did not come from authStatus().
    return typeof status.authed === 'boolean';
  }

  /**
   * A live authorization, not merely a stored token.
   *
   * `usable` is deliberately compared against `false` rather than trusted as
   * truthy: a caller holding an older status object has no `usable` field at
   * all, and treating that absence as "unusable" would report a working account
   * as broken. Absent means unknown, and unknown falls back to `authed`.
   *
   * Returns false for a non-answer — but callers must NOT render that as
   * "disconnected". Use describe(), which separates the two.
   */
  function isConnected(status) {
    if (!isAnswer(status)) return false;
    if (!status.authed) return false;
    return status.usable !== false;
  }

  /**
   * May this authorization modify playlists?
   *
   * Write capability is a property OF a connection, so a dead token cannot
   * write regardless of the scopes it was granted — checking scopeKeys alone
   * says yes for an expired grant.
   */
  function canWrite(status) {
    if (!isConnected(status)) return false;
    return (status.scopeKeys || []).indexOf('write') !== -1;
  }

  /**
   * A token exists but cannot be used. The user has already connected once, so
   * "Not connected" is the wrong thing to tell them — they need Reconnect, and
   * the difference matters because the actions are different.
   */
  function needsReconnect(status) {
    return !!(status && status.authed && status.usable === false);
  }

  /** No OAuth credentials configured — a setup problem, not a session problem. */
  function needsSetup(status) {
    return !!(status && !status.hasConfig);
  }

  /**
   * One reading for every surface that shows connection state.
   *
   * SIX states, and the sixth is the one that stops false sign-in prompts:
   *
   *   setup          no OAuth credentials configured at all
   *   disconnected   answered, and there is no credential
   *   expired        a credential exists and is provably dead — reconnect
   *   read-only      a LIVE connection that cannot write
   *   ready          live, and may write
   *   unverified     we could not ask. Says nothing about the credential.
   *
   * `unverified` deliberately carries `last`, the previous known-good status,
   * so a surface can keep showing what it knew and mark it as unconfirmed
   * rather than flipping to "not connected" the moment a message drops.
   *
   * @param status  the reply from AUTH_STATUS
   * @param last    optional: the last status that WAS an answer
   */
  function describe(status, last) {
    if (!isAnswer(status)) {
      // A check that could not complete is not a verdict on the account. The
      // only honest label mentions the check, never the connection.
      return {
        state: 'unverified',
        label: 'Could not check your YouTube connection',
        // No action: offering "Connect" here is what makes a user
        // re-authorize a perfectly good account after a dropped message.
        action: null,
        retry: true,
        last: isAnswer(last) ? describe(last) : null
      };
    }
    if (needsSetup(status)) {
      return { state: 'setup', label: 'YouTube setup needed', action: 'setup' };
    }
    if (needsReconnect(status)) {
      return { state: 'expired', label: 'YouTube connection expired', action: 'reconnect' };
    }
    if (!isConnected(status)) {
      return { state: 'disconnected', label: 'YouTube not connected', action: 'connect' };
    }
    if (!canWrite(status)) {
      // A live connection that cannot write. NOT a disconnection — the
      // organizer and stats page rendered this as "not connected", which sends
      // the user to reconnect a connection that is working.
      //
      // `action: 'upgrade'` is offered but must be requested only for an action
      // that actually needs write. Browsing playlists read-only is not a
      // permission problem, and prompting there trains users to grant scopes
      // they do not need.
      return { state: 'read-only', label: 'Connected · read-only', action: 'upgrade', upgradeOnDemand: true };
    }
    return { state: 'ready', label: 'Connected', action: null };
  }

  /**
   * NEWER ANSWERS WIN; NON-ANSWERS NEVER OVERWRITE ONE.
   *
   * Two independent failure modes this closes:
   *
   *   1. An older in-flight check resolving after a newer one — the classic
   *      stale-async defect that has produced three P0s in this codebase.
   *      Monotonic sequence numbers, not timestamps: two checks in the same
   *      millisecond are ordinary.
   *   2. A failed check clobbering a good status. `{ok:false}` arriving after a
   *      successful read must leave the good status in place and only mark it
   *      unconfirmed.
   *
   * @param current  { status, seq } already held, or null
   * @param incoming { status, seq } just received
   * @returns the record to keep
   */
  function reconcile(current, incoming) {
    if (!incoming) return current || null;
    if (!current) return incoming;
    // Stale: an older request resolving late. Discard regardless of content.
    if (typeof incoming.seq === 'number' && typeof current.seq === 'number'
        && incoming.seq < current.seq) {
      return current;
    }
    // A non-answer never replaces an answer. It marks it stale instead, so the
    // surface can show "last known: connected" rather than "not connected".
    if (!isAnswer(incoming.status) && isAnswer(current.status)) {
      return { status: current.status, seq: incoming.seq, stale: true };
    }
    return incoming;
  }

  var api = {
    isAnswer: isAnswer,
    reconcile: reconcile,
    isConnected: isConnected,
    canWrite: canWrite,
    needsReconnect: needsReconnect,
    needsSetup: needsSetup,
    describe: describe
  };

  if (root) root.UNAuthState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
