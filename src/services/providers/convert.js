/**
 * Convert the Gemini-shaped request that LLMService builds into a
 * provider-neutral shape the non-Gemini providers consume:
 *
 *   {
 *     system: string,
 *     messages: [{ role: 'user'|'assistant',
 *                  parts: [{ type: 'text', text } | { type: 'image', mimeType, data }] }],
 *     maxTokens: number
 *   }
 *
 * Messages always alternate roles, start with a user turn and end with a user
 * turn: providers such as Anthropic reject anything else, and no provider here
 * supports an assistant prefill.
 */

const DEFAULT_MAX_TOKENS = 4096;

function resolveMaxTokens(generationConfig) {
  const requested = Number(generationConfig && generationConfig.maxOutputTokens);
  if (!Number.isFinite(requested) || requested < 1) {
    return DEFAULT_MAX_TOKENS;
  }
  // An explicit limit is honored as-is, including small values such as the
  // 64-token connection test. Every regular request carries the 4096 default
  // from LLMService.getGenerationConfig(), so nothing else lands below 1024.
  return Math.floor(requested);
}

function toNeutralPart(part) {
  if (!part || typeof part !== 'object') {
    return null;
  }
  if (typeof part.text === 'string') {
    return part.text.trim() ? { type: 'text', text: part.text } : null;
  }
  const inline = part.inlineData;
  if (inline && typeof inline.data === 'string' && inline.data) {
    return { type: 'image', mimeType: inline.mimeType || 'image/png', data: inline.data };
  }
  return null;
}

function fromGeminiRequest(req) {
  const request = req || {};

  const systemParts = request.systemInstruction && Array.isArray(request.systemInstruction.parts)
    ? request.systemInstruction.parts
    : [];
  const system = systemParts
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text.trim())
    .join('\n\n');

  const messages = [];
  const contents = Array.isArray(request.contents) ? request.contents : [];
  for (const content of contents) {
    if (!content) continue;
    const role = content.role === 'model' ? 'assistant' : 'user';
    const parts = (Array.isArray(content.parts) ? content.parts : [])
      .map(toNeutralPart)
      .filter(Boolean);
    if (!parts.length) continue;

    const previous = messages[messages.length - 1];
    if (previous && previous.role === role) {
      previous.parts.push(...parts);
    } else {
      messages.push({ role, parts });
    }
  }

  // After merging, roles alternate, so at most one message is dropped at each end.
  if (messages.length && messages[0].role === 'assistant') {
    messages.shift();
  }
  if (messages.length && messages[messages.length - 1].role === 'assistant') {
    messages.pop();
  }

  return { system, messages, maxTokens: resolveMaxTokens(request.generationConfig) };
}

module.exports = { fromGeminiRequest, DEFAULT_MAX_TOKENS };
