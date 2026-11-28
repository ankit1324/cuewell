/**
 * Provider fallback: when the selected AI provider fails for a reason on its
 * side (offline, timeout, 5xx, 429, overloaded, bad or expired key, model
 * unavailable), LLMService asks the next configured provider once.
 *
 * Settings (process.env, saved in .env by main.js):
 *   LLM_FALLBACK_ORDER     comma-separated provider ids, the order to try
 *   LLM_FALLBACK_DISABLED  comma-separated provider ids that are turned off
 * Providers missing from the order follow it in DEFAULT_FALLBACK_ORDER, on
 * unless disabled, so a newly added key is used as a backup by default.
 *
 * Only this module decides which failures fall back (classifyFailure); it
 * reads error messages and statuses, never a key.
 */
const { PROVIDERS, getProviderConfig, isConfigured } = require('./index');
const { MAX_TOKENS_NO_TEXT, CONTENT_REFUSED } = require('./errors');
const { isCancelledError } = require('../cancellation');

const ORDER_ENV = 'LLM_FALLBACK_ORDER';
const DISABLED_ENV = 'LLM_FALLBACK_DISABLED';

// Vision-capable and widely used first; the text-only and local ones last.
const DEFAULT_FALLBACK_ORDER = Object.freeze(['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'groq', 'ollama']);

// Short names for the note under a fallback answer.
const SHORT_LABELS = Object.freeze({
  gemini: 'Gemini', anthropic: 'Claude', openai: 'OpenAI', openrouter: 'OpenRouter',
  groq: 'Groq', deepseek: 'DeepSeek', ollama: 'Ollama'
});

// Failure kind -> the short reason in "Answered by X because Y failed: <reason>".
const REASONS = Object.freeze({
  auth: 'invalid or expired API key',
  quota: 'quota or billing limit reached',
  rate: 'rate limit reached',
  overloaded: 'overloaded',
  server: 'server error',
  network: 'could not connect',
  timeout: 'timed out',
  model: 'model unavailable'
});

function readEnv(env, name) {
  return String((env && env[name]) || '').trim();
}

/** Known provider ids from a comma-separated list, lowercased, without duplicates. */
function parseIdList(raw) {
  const seen = new Set();
  for (const part of String(raw || '').split(',')) {
    const id = part.trim().toLowerCase();
    if (id && getProviderConfig(id) && !seen.has(id)) seen.add(id);
  }
  return [...seen];
}

/** Every provider in fallback order with its on/off state: [{ id, enabled }]. */
function getFallbackSettings(env = process.env) {
  const order = parseIdList(readEnv(env, ORDER_ENV));
  for (const id of DEFAULT_FALLBACK_ORDER) if (!order.includes(id)) order.push(id);
  for (const id of Object.keys(PROVIDERS)) if (!order.includes(id)) order.push(id);
  const disabled = new Set(parseIdList(readEnv(env, DISABLED_ENV)));
  return order.map((id) => ({ id, enabled: !disabled.has(id) }));
}

/** .env values for a [{ id, enabled }] list that validateFallbackSettings accepted. */
function fallbackEnvValues(list) {
  return {
    [ORDER_ENV]: list.map((item) => item.id).join(','),
    [DISABLED_ENV]: list.filter((item) => !item.enabled).map((item) => item.id).join(',')
  };
}

/**
 * Check a Settings payload for the fallback list. Returns
 * { list: [{ id, enabled }] } or { error }. Accepts an array of distinct
 * known provider ids, each with a boolean `enabled`, and nothing else.
 */
function validateFallbackSettings(value) {
  const error = (text) => ({ error: text });
  if (!Array.isArray(value)) return error('The backup provider list must be a list.');
  if (value.length > Object.keys(PROVIDERS).length) return error('The backup provider list is too long.');
  const seen = new Set();
  const list = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return error('Each backup provider must be an object.');
    const keys = Object.keys(item);
    if (keys.some((key) => key !== 'id' && key !== 'enabled')) return error('Unknown field in the backup provider list.');
    if (typeof item.id !== 'string' || !Object.prototype.hasOwnProperty.call(PROVIDERS, item.id)) {
      return error('Unknown AI provider in the backup provider list.');
    }
    if (typeof item.enabled !== 'boolean') return error('Each backup provider must be on or off.');
    if (seen.has(item.id)) return error('A provider is listed twice in the backup provider list.');
    seen.add(item.id);
    list.push({ id: item.id, enabled: item.enabled });
  }
  return { list };
}

/**
 * Whether `id` can stand in for another provider: a usable key, or for
 * Ollama (no key) a server URL or model the user set, so a machine without
 * Ollama is never probed.
 */
function isFallbackCandidate(id, env = process.env) {
  const provider = getProviderConfig(id);
  if (!provider) return false;
  if (provider.noKey) return !!(readEnv(env, 'OLLAMA_BASE_URL') || readEnv(env, 'OLLAMA_MODEL'));
  return isConfigured(id, env);
}

/**
 * Provider ids to try, in order, after `primaryId` failed: on, configured,
 * not the primary, and able to read images when the request has one.
 */
function getFallbackChain(primaryId, env = process.env, { needsImages = false } = {}) {
  return getFallbackSettings(env)
    .filter((item) => item.enabled && item.id !== primaryId)
    .filter((item) => isFallbackCandidate(item.id, env))
    .filter((item) => !needsImages || getProviderConfig(item.id).supportsImages !== false)
    .map((item) => item.id);
}

/** The error and what it wraps (cause, originalError), outermost first. */
function errorChain(error) {
  const out = [];
  const seen = new Set();
  const queue = [error];
  while (queue.length && out.length < 10) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    queue.push(current.cause, current.originalError);
  }
  return out;
}

const REFUSAL_RE = /declined this request|finish reasons?:[^\n]*\b(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY)\b|blockReason|content[_ ]filter/i;

function statusOf(error) {
  const candidates = [error.status, error.statusCode, error.code];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 400 && n <= 599) return n;
  }
  const message = String(error.message || '');
  const match = message.match(/^(\d{3})\s/) || message.match(/\bHTTP (\d{3})\b/) ||
    message.match(/"code"\s*:\s*(\d{3})\b/) || message.match(/\bstatus(?: code)?:? (\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function kindFromStatus(status, message) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400) {
    return /api[ _-]?key (?:not valid|invalid|expired)|API_KEY_INVALID|key (?:has )?expired/i.test(message) ? 'auth' : null;
  }
  if (status === 402) return 'quota';
  if (status === 404) return 'model';
  if (status === 408) return 'timeout';
  if (status === 429) return /quota|billing|RESOURCE_EXHAUSTED.*(?:plan|billing)/i.test(message) ? 'quota' : 'rate';
  if (status === 529 || status === 503) return 'overloaded';
  if (status >= 500) return 'server';
  return null;
}

function kindFromMessage(message) {
  if (/network error|fetch failed|could not connect|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|Streaming request failed|Alternative request failed|Streaming response error/i.test(message)) {
    return 'network';
  }
  if (/timeout|timed out|ETIMEDOUT|DEADLINE_EXCEEDED/i.test(message)) return 'timeout';
  if (/UNAUTHENTICATED|PERMISSION_DENIED|invalid api key|api key not valid|API_KEY_INVALID/i.test(message)) return 'auth';
  if (/RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(message)) return 'rate';
  if (/quota/i.test(message)) return 'quota';
  if (/UNAVAILABLE|high demand|overloaded/i.test(message)) return 'overloaded';
  return null;
}

/**
 * Why a request failed, and whether another provider should try it:
 * { fallback, kind, reason }. Only failures on the provider's side fall
 * back; a stop, a refusal, the token limit and anything unrecognized do not.
 */
function classifyFailure(error) {
  const chain = errorChain(error);
  if (!chain.length) return { fallback: false, kind: 'unknown', reason: '' };
  for (const item of chain) {
    if (isCancelledError(item)) return { fallback: false, kind: 'cancelled', reason: '' };
    if (item.code === CONTENT_REFUSED || REFUSAL_RE.test(String(item.message || ''))) {
      return { fallback: false, kind: 'refused', reason: '' };
    }
    if (item.code === MAX_TOKENS_NO_TEXT) return { fallback: false, kind: 'limit', reason: '' };
  }
  // The outer error is LLMService's user-facing text; classify what it wraps.
  for (const item of chain) {
    if (item.isUserFacing) continue;
    const message = String(item.message || '');
    const status = statusOf(item);
    const kind = (status && kindFromStatus(status, message)) || kindFromMessage(message);
    if (kind) {
      const reason = kind === 'server' && status ? `${REASONS.server} (${status})` : REASONS[kind];
      return { fallback: true, kind, reason };
    }
  }
  return { fallback: false, kind: 'unknown', reason: '' };
}

function shortLabel(id) {
  return SHORT_LABELS[id] || (getProviderConfig(id) ? getProviderConfig(id).label : String(id));
}

/** "Answered by Claude because Gemini failed: rate limit reached" */
function fallbackNote(fromId, toId, reason) {
  return `Answered by ${shortLabel(toId)} because ${shortLabel(fromId)} failed${reason ? `: ${reason}` : ''}`;
}

module.exports = {
  ORDER_ENV,
  DISABLED_ENV,
  DEFAULT_FALLBACK_ORDER,
  getFallbackSettings,
  fallbackEnvValues,
  validateFallbackSettings,
  isFallbackCandidate,
  getFallbackChain,
  classifyFailure,
  shortLabel,
  fallbackNote
};
