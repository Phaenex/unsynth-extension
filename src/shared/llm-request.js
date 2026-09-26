/**
 * Pure builder for LLM chat requests — no fetch, no keys, no DOM. Centralizes
 * the provider-specific shapes so they can be unit-tested (the service worker
 * keeps only the auth headers + fetch). This is where the "OpenAI rejects
 * max_tokens" class of bug is caught by tests instead of in production.
 *
 *   PROVIDER_DEFAULT_MODEL  per-provider fallback model
 *   resolveModel            user/config model, else provider default
 *   llmEndpoint             POST URL per provider
 *   buildLLMBody            the JSON request body per provider
 *
 * UMD: module.exports for tests; attaches UNLLMRequest to the worker global.
 */
(function (root) {
  'use strict';

  const PROVIDER_DEFAULT_MODEL = {
    openrouter: 'openai/gpt-4o-mini',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5'
  };

  function resolveModel(provider, model) {
    let m = model || PROVIDER_DEFAULT_MODEL[provider] || PROVIDER_DEFAULT_MODEL.openrouter;
    // OpenRouter requires vendor-prefixed ids ("openai/gpt-4o-mini"). A bare id
    // carried over from an OpenAI/ChatGPT setup ("gpt-4o-mini") is rejected as
    // "invalid model ID", so prefix the common OpenAI shapes and fall back to the
    // working default for anything else that's unprefixed.
    if (provider === 'openrouter' && m && m.indexOf('/') === -1) {
      m = /^(gpt-|o\d|chatgpt)/i.test(m) ? 'openai/' + m : PROVIDER_DEFAULT_MODEL.openrouter;
    }
    // OpenAI / Anthropic want BARE ids; strip an OpenRouter-style vendor prefix
    // that leaked in ("openai/gpt-4o-mini" -> "gpt-4o-mini"), which OpenAI rejects.
    if (provider === 'openai' && m.indexOf('openai/') === 0) m = m.slice(7);
    if (provider === 'anthropic' && m.indexOf('anthropic/') === 0) m = m.slice(10);
    return m;
  }

  function llmEndpoint(provider) {
    if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
    if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
    return 'https://api.openai.com/v1/chat/completions';
  }

  /**
   * Build the request body. opts: { provider, model, maxTokens, system, messages, stream }
   * - Anthropic: native shape (top-level system, max_tokens).
   * - OpenAI-compatible: system folded into messages. OpenAI uses
   *   max_completion_tokens (o-series / newer models reject max_tokens);
   *   OpenRouter keeps max_tokens and normalizes it.
   */
  function buildLLMBody(opts) {
    opts = opts || {};
    const provider = opts.provider;
    const model = resolveModel(provider, opts.model);
    const maxTokens = opts.maxTokens || 1024;

    if (provider === 'anthropic') {
      const body = { model, max_tokens: maxTokens, messages: opts.messages || [] };
      if (opts.system) body.system = opts.system;
      if (opts.stream) body.stream = true;
      return body;
    }

    const messages = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    for (const m of opts.messages || []) messages.push(m);

    const body = { model, messages };
    if (provider === 'openai') body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (opts.stream) body.stream = true;
    return body;
  }

  const api = { PROVIDER_DEFAULT_MODEL, resolveModel, llmEndpoint, buildLLMBody };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNLLMRequest = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
