'use strict';

/** AI provider config + prompt library + startup kickoff. */
// Extracted from dashboard-core.js. Runs at global scope (classic script),
// loaded AFTER dashboard-core.js so its shared vars ($, send, flash, D, UNMSG)
// are already defined. Functions here are global and resolved by name.
  // ---- AI ----
  // Default model per provider — mirrors shared/llm-request.js PROVIDER_DEFAULT_MODEL
  // (inline so the dashboard page needs no extra script load).
  const AI_DEFAULT_MODEL = { openrouter: 'openai/gpt-4o-mini', openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5' };
  function updateModelPlaceholder() {
    const p = $('ai-provider').value;
    $('ai-model').placeholder = (AI_DEFAULT_MODEL[p] || 'model id') + '  (used if blank)';
  }
  async function refreshAI() {
    const r = await send(UNMSG.AI_CONFIG_GET);
    if (!r.ok) return;
    $('ai-provider').value = r.provider || 'openrouter';
    $('ai-model').value = r.model || '';
    updateModelPlaceholder();
    $('k-openrouter').textContent = r.hasKey.openrouter ? '(saved)' : '';
    $('k-openai').textContent = r.hasKey.openai ? '(saved)' : '';
    $('k-anthropic').textContent = r.hasKey.anthropic ? '(saved)' : '';
  }
  $('ai-provider').addEventListener('change', updateModelPlaceholder);
  $('save-ai').addEventListener('click', async () => {
    const keys = {};
    ['openrouter', 'openai', 'anthropic'].forEach((p) => {
      const v = $('key-' + p).value.trim();
      if (v) keys[p] = v;
    });
    const r = await send(UNMSG.AI_CONFIG_SET, { provider: $('ai-provider').value, model: $('ai-model').value.trim(), keys });
    ['openrouter', 'openai', 'anthropic'].forEach((p) => ($('key-' + p).value = ''));
    flash($('ai-status'), r.ok ? 'Saved.' : 'Error', r.ok);
    refreshAI();
    refreshSetupChecklist();
  });
  $('test-ai').addEventListener('click', async () => {
    // This fires a real request against the user's own BYOK key, so a
    // double-click costs them quota twice. Disable for the round trip, and
    // restore in finally so a thrown error can't leave the button dead.
    const btn = $('test-ai');
    if (btn.disabled) return;
    btn.disabled = true;
    flash($('ai-status'), 'Testing…');
    try {
      const r = await send(UNMSG.AI_LLM, { system: 'You are a test.', messages: [{ role: 'user', content: 'Reply with exactly: AI_OK' }], max_tokens: 16 });
      if (r.ok) {
        $('ai-test-out').textContent = `Reply: ${r.content}  (${r.model || ''})`;
        flash($('ai-status'), 'Works ✓');
      } else {
        $('ai-test-out').textContent = '';
        flash($('ai-status'), 'Failed: ' + (r.error || '') + (r.message ? ' — ' + r.message : ''), false);
      }
    } catch (e) {
      $('ai-test-out').textContent = '';
      flash($('ai-status'), 'Failed: ' + ((e && e.message) || 'unexpected error'), false);
    } finally {
      btn.disabled = false;
    }
  });

  function loadAiPromptsForm() {
    chrome.storage.sync.get({ aiPrompts: D.aiPrompts }, (s) => {
      if ($('ai-prompts-json')) $('ai-prompts-json').value = JSON.stringify(s.aiPrompts || D.aiPrompts, null, 2);
    });
  }
  loadAiPromptsForm();
  if ($('save-ai-prompts')) {
    $('save-ai-prompts').addEventListener('click', () => {
      try {
        const raw = JSON.parse($('ai-prompts-json').value || '[]');
        if (!Array.isArray(raw) || !raw.length) throw new Error('empty');
        raw.forEach((p) => {
          if (!p.name || !p.prompt) throw new Error('invalid');
        });
        chrome.storage.sync.set({ aiPrompts: raw }, () => {
          // A handful of long prompts easily exceeds chrome.storage.sync's 8 KB
          // per-item quota; without this the editor claimed success and the
          // prompts reverted on the next load.
          const err = chrome.runtime.lastError;
          if (err) {
            flash(
              $('ai-prompts-status'),
              window.UNFilterForm ? UNFilterForm.describeSyncError(err) : 'Not saved — browser storage error.',
              false
            );
            return;
          }
          flash($('ai-prompts-status'), 'Prompts saved.');
        });
      } catch (e) {
        flash($('ai-prompts-status'), 'Invalid JSON — need [{name,prompt},…]', false);
      }
    });
  }
  if ($('reset-ai-prompts')) {
    $('reset-ai-prompts').addEventListener('click', () => {
      chrome.storage.sync.set({ aiPrompts: D.aiPrompts }, () => {
        loadAiPromptsForm();
        flash($('ai-prompts-status'), 'Reset to defaults.');
      });
    });
  }

  if ($('forge-subs-open')) $('forge-subs-open').addEventListener('click', openForgeTab);
  if ($('forge-account-open')) $('forge-account-open').addEventListener('click', openForgeTab);

  refreshForgeCards();
  refreshAccount();
  refreshAI();
  refreshSetupChecklist();
