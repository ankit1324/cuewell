'use strict';
// A fetch stand-in for the provider SDKs: answers every request with a
// server-sent-events body that sends one event every `intervalMs`, so a
// test can stop a request part way through. No sockets. Each call records
// its URL, whether its signal fired and how many events went out after
// that (always 0 when the stream honors the abort).
const { setTimeout: sleep } = require('node:timers/promises');

/** OpenAI chat-completions events for `pieces`, then [DONE]. */
function openAiEvents(pieces) {
  return [
    ...pieces.map((text) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

/** Anthropic Messages stream events for `pieces`. */
function anthropicEvents(pieces) {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    event('message_start', {
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...pieces.map((text) => event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: pieces.length } }),
    event('message_stop', {}),
  ];
}

/**
 * fetch(url, init) that streams `events` (strings) one per `intervalMs`.
 * `json` (optional) answers non-streamed requests with that body after
 * `jsonDelayMs`, honoring the signal the same way.
 */
function createSseFetch({ events, intervalMs = 25, json = null, jsonDelayMs = 200 }) {
  const calls = [];
  const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  async function fetch(url, init = {}) {
    const signal = init.signal || null;
    const call = { url: String(url), aborted: false, sentAfterAbort: 0, sent: 0 };
    calls.push(call);
    if (signal) signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    const streamed = typeof init.body === 'string' && /"stream":\s*true/.test(init.body);

    if (!streamed && json) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, jsonDelayMs);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
      });
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        for (const text of events) {
          await sleep(intervalMs);
          if (signal && signal.aborted) {
            controller.error(abortError());
            return;
          }
          controller.enqueue(encoder.encode(text));
          call.sent++;
          if (call.aborted) call.sentAfterAbort++;
        }
        controller.close();
      },
    });
    if (signal) {
      signal.addEventListener('abort', () => {
        try { body.cancel(abortError()).catch(() => {}); } catch (_) { /* locked by the reader */ }
      }, { once: true });
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  fetch.calls = calls;
  return fetch;
}

module.exports = { createSseFetch, openAiEvents, anthropicEvents };
