const OpenAI = require('openai');
const { normalizeSdkError, noTextAtLimitError } = require('./errors');
const { resolveIdleTimeoutMs, startIdleTimeout } = require('./idle-timeout');

// Per-request fetch option that hands a stream's idle-timer reset to the
// client fetch below. A symbol, so it cannot clash with a RequestInit field.
const ON_RESPONSE_DATA = Symbol('onResponseData');

/**
 * Client fetch that calls the request's ON_RESPONSE_DATA callback when the
 * response headers and each body chunk arrive. The SDK drops SSE comment
 * lines (OpenRouter's ": OPENROUTER PROCESSING", DeepSeek's ": keep-alive")
 * before the stream iterator sees them, so reading the body is the only way
 * to count those keepalives as activity. Other requests pass straight through.
 */
function activityFetch(baseFetch) {
  return async (url, init) => {
    const onData = init && init[ON_RESPONSE_DATA];
    if (typeof onData !== 'function') return baseFetch(url, init);
    const fetchInit = { ...init };
    delete fetchInit[ON_RESPONSE_DATA];
    const response = await baseFetch(url, fetchInit);
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

function toChatMessages(neutral) {
  const messages = [];
  if (neutral.system) {
    messages.push({ role: 'system', content: neutral.system });
  }
  for (const message of neutral.messages) {
    const hasImage = message.parts.some((part) => part.type === 'image');
    if (!hasImage) {
      messages.push({ role: message.role, content: message.parts.map((part) => part.text).join('\n\n') });
      continue;
    }
    messages.push({
      role: message.role,
      content: message.parts.map((part) => (part.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
        : { type: 'text', text: part.text }))
    });
  }
  return messages;
}

/**
 * One client for every OpenAI-compatible chat-completions API (OpenAI,
 * OpenRouter, Groq, DeepSeek, Ollama), configured by a preset from index.js.
 */
class OpenAICompatibleProvider {
  constructor({ apiKey, baseURL, headers, tokenParam = 'max_tokens', label = 'OpenAI', timeout, idleTimeoutMs, clientOptions } = {}) {
    // LLMService owns retries, so the SDK must not retry on its own.
    const options = { ...(clientOptions || {}), apiKey, baseURL, maxRetries: 0 };
    options.fetch = activityFetch(options.fetch || globalThis.fetch);
    if (headers) options.defaultHeaders = { ...headers };
    if (timeout) options.timeout = timeout;
    this.client = new OpenAI(options);
    this.tokenParam = tokenParam;
    this.label = label;
    this.requestTimeoutMs = timeout || 0;
    this.idleTimeoutMs = resolveIdleTimeoutMs(idleTimeoutMs ?? process.env.LLM_STREAM_IDLE_TIMEOUT_MS);
  }

  _params(neutral, model) {
    // No temperature: some OpenAI reasoning models reject it.
    return {
      model,
      messages: toChatMessages(neutral),
      [this.tokenParam]: neutral.maxTokens
    };
  }

  _finish(text, finishReason, maxTokens) {
    if (!text && finishReason === 'length') {
      throw noTextAtLimitError(this.label, maxTokens);
    }
    return text;
  }

  async generate(neutral, model) {
    let completion;
    try {
      completion = await this.client.chat.completions.create(this._params(neutral, model));
    } catch (error) {
      throw normalizeSdkError(OpenAI, error, this.label);
    }
    const choice = completion && Array.isArray(completion.choices) ? completion.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : null;
    return this._finish(typeof content === 'string' ? content : '', choice && choice.finish_reason, neutral.maxTokens);
  }

  async stream(neutral, model, onDelta) {
    const idle = startIdleTimeout(this.idleTimeoutMs, this.label, this.requestTimeoutMs);
    let text = '';
    let finishReason = null;
    try {
      // The SDK's stream iterator ends quietly when aborted, so the timeout
      // has to reject through idle.run() rather than through the loop.
      await idle.run(async () => {
        const stream = await this.client.chat.completions.create(
          { ...this._params(neutral, model), stream: true },
          { signal: idle.signal, fetchOptions: { [ON_RESPONSE_DATA]: idle.reset } }
        );
        idle.reset();
        for await (const chunk of stream) {
          idle.reset();
          const choice = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
          if (!choice) continue;
          const delta = choice.delta && choice.delta.content;
          if (typeof delta === 'string' && delta) {
            text += delta;
            onDelta(delta);
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      });
    } catch (error) {
      throw idle.timedOut ? idle.error : normalizeSdkError(OpenAI, error, this.label);
    } finally {
      idle.clear();
    }
    return this._finish(text, finishReason, neutral.maxTokens);
  }
}

module.exports = OpenAICompatibleProvider;
