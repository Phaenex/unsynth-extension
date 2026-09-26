'use strict';

/**
 * Watch-history cross-device sync card (Watched tab). Loaded AFTER
 * dashboard-core.js so its shared globals ($, send, flash, UNMSG) are
 * already defined — same pattern as dashboard-account.js's Forge card.
 */

function refreshHistorySyncCard() {
  chrome.storage.local.get(
    { auth_tokens: null, historySync: { enabled: false, lastSyncAt: 0, lastError: null } },
    (d) => {
      const authed = !!(d.auth_tokens && d.auth_tokens.access_token);
      const cfg = d.historySync || { enabled: false, lastSyncAt: 0, lastError: null };
      const checkbox = $('history-sync-enabled');
      const nowBtn = $('history-sync-now');
      const revokeBtn = $('history-sync-revoke');
      const statusEl = $('history-sync-status');

      if (checkbox) {
        checkbox.checked = !!cfg.enabled;
        checkbox.disabled = !authed;
      }
      if (nowBtn) nowBtn.disabled = !authed || !cfg.enabled;
      // Also available while a server delete is still owed, so it can be retried.
      if (revokeBtn) revokeBtn.disabled = !cfg.enabled && !cfg.deletePending;

      if (statusEl) {
        if (!authed) {
          statusEl.textContent = 'Complete the Google OAuth setup (Account tab) on this device first.';
        } else if (!cfg.enabled && cfg.deletePending) {
          statusEl.textContent = 'Sync off. The copy on the server has not been deleted yet: use “Turn off & delete” to try again.';
        } else if (!cfg.enabled) {
          statusEl.textContent = 'Sync off — data stays on this device.';
        } else if (cfg.lastError) {
          statusEl.textContent = 'Last sync failed: ' + cfg.lastError;
        } else if (cfg.lastSyncAt) {
          statusEl.textContent = 'Last synced ' + new Date(cfg.lastSyncAt).toLocaleString() + '.';
        } else {
          statusEl.textContent = 'Sync on — not synced yet. Click “Sync now.”';
        }
      }
    }
  );
}

function setHistorySyncEnabled(enabled) {
  chrome.storage.local.get({ historySync: { enabled: false, lastSyncAt: 0, lastError: null } }, (d) => {
    const next = Object.assign({}, d.historySync, { enabled: enabled === true, lastError: null });
    chrome.storage.local.set({ historySync: next }, () => {
      refreshHistorySyncCard();
      if (enabled) runHistorySyncNow();
    });
  });
}

async function runHistorySyncNow() {
  const btn = $('history-sync-now');
  if (btn) btn.disabled = true;
  const r = await send(UNMSG.SYNC_NOW);
  if (btn) btn.disabled = false;
  refreshHistorySyncCard();
  if (r && r.ok) {
    flash($('history-sync-action-status'), 'Synced — ' + (r.count || 0) + ' watched videos.', true);
  } else {
    flash($('history-sync-action-status'), 'Sync failed: ' + ((r && r.error) || 'unknown error'), false);
  }
}

if ($('history-sync-enabled')) {
  $('history-sync-enabled').addEventListener('change', () => {
    setHistorySyncEnabled($('history-sync-enabled').checked);
  });
}
if ($('history-sync-now')) $('history-sync-now').addEventListener('click', () => runHistorySyncNow());
if ($('history-sync-revoke')) {
  $('history-sync-revoke').addEventListener('click', async () => {
    if (!(await uiConfirm('Turn off sync and delete the copy stored on the server? This cannot be undone (your local watch history is unaffected).', 'Turn off & delete'))) return;
    const btn = $('history-sync-revoke');
    btn.disabled = true;
    const r = await send(UNMSG.SYNC_DELETE);
    btn.disabled = false;
    refreshHistorySyncCard();
    // Say what actually happened (code review on PR #2: this used to claim the
    // server copy was deleted whether or not the delete succeeded).
    if (r && r.serverDeleted) {
      flash($('history-sync-action-status'), 'Sync turned off and server copy deleted.', true);
    } else {
      flash($('history-sync-action-status'), 'Sync turned off, but the server copy was not deleted' + (r && r.error ? ' (' + r.error + ')' : '') + '. Try again.', false);
    }
  });
}

refreshHistorySyncCard();

// ---- watch-queue sync (separate opt-in from watch history) ----
// Kept distinct because the queue necessarily carries titles, channels and
// thumbnails, which the watch-history sync deliberately does not — consenting
// to one is not consenting to the other.
function refreshQueueSyncCard() {
  const box = $('queue-sync-enabled');
  if (!box) return;
  chrome.storage.local.get({ queueSync: { enabled: false, lastSyncAt: 0, lastError: null } }, (d) => {
    const cfg = (d && d.queueSync) || {};
    box.checked = !!cfg.enabled;
    const line = $('queue-sync-status');
    if (!line) return;
    if (!cfg.enabled) {
      line.textContent = 'Off — the queue still syncs through Chrome, limited to about the first 25 items.';
      return;
    }
    if (cfg.lastError) {
      line.textContent = 'Last attempt failed: ' + cfg.lastError;
      return;
    }
    line.textContent = cfg.lastSyncAt
      ? 'On — last synced ' + new Date(cfg.lastSyncAt).toLocaleString() + '.'
      : 'On — not synced yet.';
  });
}

if ($('queue-sync-enabled')) {
  $('queue-sync-enabled').addEventListener('change', () => {
    const on = $('queue-sync-enabled').checked;
    chrome.storage.local.get({ queueSync: { enabled: false, lastSyncAt: 0, lastError: null } }, (d) => {
      const next = Object.assign({}, (d && d.queueSync) || {}, { enabled: on, lastError: null });
      chrome.storage.local.set({ queueSync: next }, () => refreshQueueSyncCard());
    });
  });
}

refreshQueueSyncCard();

function refreshLibrarySyncCard() {
  const box = $('library-sync-enabled');
  if (!box) return;
  chrome.storage.local.get({ librarySync: { enabled: false, lastSyncAt: 0, lastError: null } }, (d) => {
    const cfg = (d && d.librarySync) || {};
    box.checked = !!cfg.enabled;
    const line = $('library-sync-status');
    if (!line) return;
    if (!cfg.enabled) {
      line.textContent = 'Off — groups and folders stay on this device.';
      return;
    }
    if (cfg.lastError) {
      line.textContent = 'Last attempt failed: ' + cfg.lastError;
      return;
    }
    line.textContent = cfg.lastSyncAt
      ? 'On — last synced ' + new Date(cfg.lastSyncAt).toLocaleString() + '.'
      : 'On — not synced yet.';
  });
}

if ($('library-sync-enabled')) {
  $('library-sync-enabled').addEventListener('change', () => {
    const on = $('library-sync-enabled').checked;
    chrome.storage.local.get({ librarySync: { enabled: false, lastSyncAt: 0, lastError: null } }, (d) => {
      const next = Object.assign({}, (d && d.librarySync) || {}, { enabled: on, lastError: null });
      chrome.storage.local.set({ librarySync: next }, () => refreshLibrarySyncCard());
    });
  });
}

refreshLibrarySyncCard();
