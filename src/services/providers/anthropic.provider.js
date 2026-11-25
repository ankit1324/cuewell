const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../core/logger').createServiceLogger('LLM');
const { normalizeSdkError, noTextAtLimitError } = require('./errors');
const { resolveIdleTimeoutMs, startIdleTimeout } = require('./idle-timeout');

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Low effort keeps answers fast, which matters more than depth on a live overlay.
const DEFAULT_EFFORT = 'low';

// Server-side refusal fallback is on until the API rejects it once; after
// that every request in this session goes out without it.
let serverFallbackEnabled = true;

function resolveEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  return EFFORT_LEVELS.has(effort) ? effort : DEFAULT_EFFORT;
}

function toContentBlocks(parts) {
  const images = parts
    .filter((part) => part.type === 'image')
    .map((part) => ({ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }));
  const texts = parts
    .filter((part) => part.type === 'text')
    .map((part) => ({ type: 'text', text: part.text }));
  return images.concat(texts);
}

function isFallbackRejection(error) {
  return error instanceof Anthropic.BadRequestError &&
    /fallback/i.test(String(error.apiMessage || error.message || ''));
}

/**
 * Per-request middleware that calls `onData` when the response headers and
 * each body chunk arrive. The SDK drops `ping` events before MessageStream
 * sees them, so no stream event reports pings; reading the body is the only
 * way to count them as activity.
 */
function onResponseData(onData) {
  return async (request, next) => {
    const response = await next(request);
    onData();
    if (!response.body) return response;
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        onData();
        controller.enqueue(chunk);
      }
    }));
    return new Response(body, response);
  };
}

function textOf(message) {
  return (Array.isArray(message && message.content) ? message.content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

class AnthropicProvider {
  constructor({ apiKey, baseURL, effort, label = 'Anthropic Claude', timeout, idleTimeoutMs, clientOptions } = {}) {
    // LLMService owns retries, so the SDK must not retry on its own.
    const options = { ...(clientOptions || {}), apiKey, maxRetries: 0 };
    if (baseURL) options.baseURL = baseURL;
    if (timeout) options.timeout = timeout;
    this.client = new Anthropic(options);
    this.effort = resolveEffort(effort);
    this.label = label;
    this.requestTimeoutMs = timeout || 0;
    this.idleTimeoutMs = resolveIdleTimeoutMs(idleTimeoutMs ?? process.env.LLM_STREAM_IDLE_TIMEOUT_MS);
  }

  _params(neutral, model) {
    // No temperature/top_p/top_k/thinking: current Claude models reject
    // sampling parameters, and the overlay never sends an assistant prefill.
    const params = {
      model,
      max_tokens: neutral.maxTokens,
      messages: neutral.messages.map((message) => ({
        role: message.role,
        content: toContentBlocks(message.parts)
      })),
      output_config: { effort: this.effort }
    };
    if (neutral.system) {
      params.system = neutral.system;
    }
    return params;
  }

  /**
   * Send through the beta endpoint with server-side refusal fallback, or the
   * plain endpoint once the API has said it does not accept fallbacks.
   * `call(messagesApi, params)` performs the actual create/stream call.
   */
  async _send(params, call) {
    try {
      if (serverFallbackEnabled) {
        try {
          return await call(this.client.beta.messages, { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' });
        } catch (error) {
          if (!isFallbackRejection(error)) throw error;
          serverFallbackEnabled = false;
          logger.info('Claude server-side fallback rejected; continuing without it for this session', {
            status: error.status
          });
        }
      }
      return await call(this.client.messages, params);
    } catch (error) {
      throw normalizeSdkError(Anthropic, error, this.label);
    }
  }

  _finish(message, maxTokens) {
    if (message && message.stop_reason === 'refusal') {
      throw new Error('Claude declined this request');
    }
    const text = textOf(message);
    if (!text && message && message.stop_reason === 'max_tokens') {
      throw noTextAtLimitError(this.label, maxTokens);
    }
    return text;
  }

  async generate(neutral, model) {
    const message = await this._send(this._params(neutral, model), (api, params) => api.create(params));
    return this._finish(message, neutral.maxTokens);
  }

  async stream(neutral, model, onDelta) {
    const idle = startIdleTimeout(this.idleTimeoutMs, this.label, this.requestTimeoutMs);
    try {
      const message = await idle.run(() => this._send(this._params(neutral, model), (api, params) => {
        const stream = api.stream(params, { signal: idle.signal, middleware: [onResponseData(idle.reset)] });
        // Backup for the middleware: every parsed event except `ping`.
        stream.on('streamEvent', idle.reset);
        stream.on('text', (delta) => {
          if (delta) onDelta(delta);
        });
        return stream.finalMessage();
      }));
      return this._finish(message, neutral.maxTokens);
    } catch (error) {
      throw idle.timedOut ? idle.error : error;
    } finally {
      idle.clear();
    }
  }
}

module.exports = AnthropicProvider;
