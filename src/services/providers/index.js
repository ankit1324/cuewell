/**
 * AI provider registry and factory.
 *
 * Gemini stays on LLMService's original code path (createProvider returns
 * null for it). Every other provider gets an object with
 * `generate(neutral, model)` and `stream(neutral, model, onDelta)`, where
 * `neutral` is the output of convert.fromGeminiRequest().
 *
 * Settings live in process.env (persisted to .env). Each helper takes an
 * optional `env` so callers that read the .env file directly (first-run)
 * apply the same rules.
 */
const { URL: NodeURL } = require('url');
const config = require('../../core/config');

// Generous enough for a cold local model, short enough that a dead
// connection does not hang the overlay for the SDK default of 10 minutes.
const REQUEST_TIMEOUT_MS = 120000;
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

const PROVIDERS = Object.freeze({
  gemini: Object.freeze({
    label: 'Google Gemini', keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL',
    defaultModel: config.get('llm.gemini.model'), kind: 'gemini', supportsImages: true
  }),
  anthropic: Object.freeze({
    label: 'Anthropic Claude', keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-opus-5-5', kind: 'anthropic', supportsImages: true
  }),
  openai: Object.freeze({
    label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-5-mini', baseURL: 'https://api.openai.com/v1',
    tokenParam: 'max_completion_tokens', kind: 'openai', supportsImages: true
  }),
  openrouter: Object.freeze({
    label: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'openrouter/auto', baseURL: 'https://openrouter.ai/api/v1',
    tokenParam: 'max_tokens', headers: Object.freeze({ 'X-Title': 'OpenCluely' }),
    kind: 'openai', supportsImages: true
  }),
  groq: Object.freeze({
    label: 'Groq', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile', baseURL: 'https://api.groq.com/openai/v1',
    tokenParam: 'max_tokens', kind: 'openai', supportsImages: false
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1',
    tokenParam: 'max_tokens', kind: 'openai', supportsImages: false
  }),
  ollama: Object.freeze({
    label: 'Ollama (local)', keyEnv: null, modelEnv: 'OLLAMA_MODEL',
    defaultModel: 'llama3.2-vision', baseURL: 'http://localhost:11434/v1',
    tokenParam: 'max_tokens', kind: 'openai', noKey: true, supportsImages: true
  })
});

function readEnv(env, name) {
  return name ? String((env && env[name]) || '').trim() : '';
}

function getProviderConfig(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

function getActiveProviderId(env = process.env) {
  const id = readEnv(env, 'LLM_PROVIDER').toLowerCase();
  return getProviderConfig(id) ? id : 'gemini';
}

function getModel(id, env = process.env) {
  const provider = getProviderConfig(id);
  if (!provider) return null;
  return readEnv(env, provider.modelEnv) || provider.defaultModel;
}

function getApiKey(id, env = process.env) {
  const provider = getProviderConfig(id);
  return provider ? readEnv(env, provider.keyEnv) : '';
}

/** Template values such as "your_gemini_api_key_here" or "your-api-key-here". */
function isPlaceholderKey(value) {
  return /^your[_-].*[_-]here$/i.test(String(value || '').trim());
}

function isConfigured(id, env = process.env) {
  const provider = getProviderConfig(id);
  if (!provider) return false;
  if (provider.noKey) return true;
  const key = getApiKey(id, env);
  return !!key && !isPlaceholderKey(key);
}

/** Endpoint a provider talks to; `<NAME>_BASE_URL` overrides the preset. */
function getBaseURL(id, env = process.env) {
  const provider = getProviderConfig(id);
  if (!provider || provider.kind === 'gemini') return null;
  if (provider.kind === 'anthropic') {
    return readEnv(env, 'ANTHROPIC_BASE_URL') || ANTHROPIC_DEFAULT_BASE_URL;
  }
  return readEnv(env, `${id.toUpperCase()}_BASE_URL`) || provider.baseURL;
}

/**
 * Prepare Electron's main process for the provider SDKs and return the SDK
 * client options that go with it.
 *
 * speech.service.js installs browser stand-ins for the Azure Speech SDK:
 * window, document, navigator and a URL class that cannot parse URLs. The
 * SDKs (and Node's fetch) build request URLs with the global URL, so the real
 * one is put back. The stand-ins also trip the SDKs' "browser environment"
 * guard; API keys never leave the main process, so under Node that guard is a
 * false positive and is waived. Gemini-only sessions never call this.
 */
function nodeRuntimeClientOptions() {
  if (globalThis.URL !== NodeURL) {
    globalThis.URL = NodeURL;
  }
  const inMainProcess = typeof process !== 'undefined' && !!(process.versions && process.versions.node) &&
    process.type !== 'renderer';
  const browserGuardTripped = typeof window !== 'undefined' &&
    typeof window.document !== 'undefined' && typeof navigator !== 'undefined';
  return inMainProcess && browserGuardTripped ? { dangerouslyAllowBrowser: true } : {};
}

function createProvider(id, env = process.env) {
  const provider = getProviderConfig(id);
  if (!provider || provider.kind === 'gemini') return null;

  const runtimeOptions = nodeRuntimeClientOptions();

  // SDKs are loaded lazily so Gemini-only sessions never pay for them.
  if (provider.kind === 'anthropic') {
    const AnthropicProvider = require('./anthropic.provider');
    return new AnthropicProvider({
      apiKey: getApiKey(id, env),
      // Only pass baseURL when overridden; otherwise the SDK default applies.
      baseURL: readEnv(env, 'ANTHROPIC_BASE_URL') || undefined,
      effort: readEnv(env, 'ANTHROPIC_EFFORT'),
      label: provider.label,
      timeout: REQUEST_TIMEOUT_MS,
      clientOptions: runtimeOptions
    });
  }

  const OpenAICompatibleProvider = require('./openai-compatible.provider');
  return new OpenAICompatibleProvider({
    apiKey: provider.noKey ? 'ollama' : getApiKey(id, env),
    baseURL: getBaseURL(id, env),
    headers: provider.headers,
    tokenParam: provider.tokenParam,
    label: provider.label,
    timeout: REQUEST_TIMEOUT_MS,
    // The SDK reads OPENAI_ORG_ID / OPENAI_PROJECT_ID from the environment;
    // those belong to OpenAI and must not be sent to other hosts.
    clientOptions: id === 'openai'
      ? runtimeOptions
      : { ...runtimeOptions, organization: null, project: null }
  });
}

function listProviders() {
  return Object.keys(PROVIDERS).map((id) => {
    const provider = PROVIDERS[id];
    return {
      id,
      label: provider.label,
      keyEnv: provider.keyEnv,
      modelEnv: provider.modelEnv,
      defaultModel: provider.defaultModel,
      noKey: !!provider.noKey,
      supportsImages: provider.supportsImages !== false
    };
  });
}

module.exports = {
  PROVIDERS,
  getActiveProviderId,
  getProviderConfig,
  getModel,
  getApiKey,
  getBaseURL,
  isPlaceholderKey,
  isConfigured,
  createProvider,
  listProviders
};
