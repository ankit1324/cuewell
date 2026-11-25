const OpenAI = require('openai');
const { normalizeSdkError, noTextAtLimitError } = require('./errors');

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
  constructor({ apiKey, baseURL, headers, tokenParam = 'max_tokens', label = 'OpenAI', timeout, clientOptions } = {}) {
    // LLMService owns retries, so the SDK must not retry on its own.
    const options = { ...(clientOptions || {}), apiKey, baseURL, maxRetries: 0 };
    if (headers) options.defaultHeaders = { ...headers };
    if (timeout) options.timeout = timeout;
    this.client = new OpenAI(options);
    this.tokenParam = tokenParam;
    this.label = label;
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
    let text = '';
    let finishReason = null;
    try {
      const stream = await this.client.chat.completions.create({ ...this._params(neutral, model), stream: true });
      for await (const chunk of stream) {
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
    } catch (error) {
      throw normalizeSdkError(OpenAI, error, this.label);
    }
    return this._finish(text, finishReason, neutral.maxTokens);
  }
}

module.exports = OpenAICompatibleProvider;
