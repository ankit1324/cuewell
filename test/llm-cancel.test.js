'use strict';
// Stopping an answer: the AbortSignal main.js passes to LLMService stops
// every provider path, streamed and not, during retry waits and before
// fallback models, with no chunk after the stop and no error or fallback
// response. Providers talk to fake fetch / https stand-ins; nothing leaves
// this process.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { stubLogger, clearAppEnv } = require('./helpers/env');
const { createSseFetch, openAiEvents, anthropicEvents } = require('./helpers/fake-sse');

stubLogger();
clearAppEnv();
const cancellation = require('../src/services/cancellation');
const OpenAICompatibleProvider = require('../src/services/providers/openai-compatible.provider');
const AnthropicProvider = require('../src/services/providers/anthropic.provider');
const llmService = require('../src/services/llm.service');

const { isCancelledError } = cancellation;
// A regression (a stop that is ignored) would otherwise hang on the slow fakes.
const TEST_TIMEOUT_MS = 10000;
const PIECES = ['One ', 'two ', 'three ', 'four ', 'five ', 'six ', 'seven ', 'eight '];
const NEUTRAL = { system: 'Be brief.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }], maxTokens: 64 };
const GEMINI_REQUEST = { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 64 } };

const assertCancelled = (error) => {
  assert.ok(isCancelledError(error), `expected the cancelled error, got: ${error && error.message}`);
  return true;
};

/** Run `start(signal, onDelta)`, abort once `abortAfter` deltas arrived, and report what happened. */
async function abortMidStream(start, abortAfter = 2) {
  const controller = new AbortController();
  const deltas = [];
  let deltasAtAbort = null;
  const onDelta = (delta) => {
    deltas.push(delta);
    if (deltas.length === abortAfter && deltasAtAbort === null) {
      deltasAtAbort = deltas.length;
      controller.abort();
    }
  };
  const startedAt = Date.now();
  let error = null;
  let value;
  try {
    value = await start(controller.signal, onDelta);
  } catch (e) {
    error = e;
  }
  const settledAt = Date.now();
  // Give a stream that ignored the abort the chance to send more.
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { error, value, deltas, deltasAtAbort, ms: settledAt - startedAt };
}

describe('cancellation helpers', { timeout: TEST_TIMEOUT_MS }, () => {
  it('cancelledError is recognized, other errors are not', () => {
    assert.ok(isCancelledError(cancellation.cancelledError()));
    assert.equal(isCancelledError(new Error('Answer stopped')), false);
    assert.equal(isCancelledError(Object.assign(new Error('x'), { name: 'AbortError' })), false);
    assert.equal(isCancelledError(null), false);
  });

  it('raceCancel rejects at the stop and drops the late result', async () => {
    const controller = new AbortController();
    let lateReject;
    const late = new Promise((_, reject) => { lateReject = reject; });
    const raced = cancellation.raceCancel(late, controller.signal);
    controller.abort();
    await assert.rejects(raced, assertCancelled);
    lateReject(new Error('late')); // swallowed, not unhandled
    await assert.rejects(cancellation.raceCancel(Promise.resolve(1), controller.signal), assertCancelled);
    assert.equal(await cancellation.raceCancel(Promise.resolve(2), null), 2);
    assert.equal(await cancellation.raceCancel(Promise.resolve(3), new AbortController().signal), 3);
  });

  it('raceCancel turns a failure after the stop into the cancelled error', async () => {
    const controller = new AbortController();
    const failing = new Promise((_, reject) => setTimeout(() => reject(new Error('network error')), 5));
    controller.abort();
    await assert.rejects(cancellation.raceCancel(failing, controller.signal), assertCancelled);
  });

  it('cancellableDelay waits, or ends at the stop', async () => {
    const started = Date.now();
    await cancellation.cancellableDelay(20, null);
    assert.ok(Date.now() - started >= 15);
    const controller = new AbortController();
    const waiting = cancellation.cancellableDelay(5000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const t0 = Date.now();
    await assert.rejects(waiting, assertCancelled);
    assert.ok(Date.now() - t0 < 500, 'the wait did not end at the stop');
    await assert.rejects(cancellation.cancellableDelay(10, controller.signal), assertCancelled);
  });

  it('anySignal fires for either signal', () => {
    const a = new AbortController();
    const b = new AbortController();
    assert.equal(cancellation.anySignal(null, undefined), null);
    assert.equal(cancellation.anySignal(a.signal, null), a.signal);
    const both = cancellation.anySignal(a.signal, b.signal);
    assert.equal(both.aborted, false);
    b.abort();
    assert.equal(both.aborted, true);
  });
});

describe('OpenAI-compatible provider', { timeout: TEST_TIMEOUT_MS }, () => {
  const make = (fetch) => new OpenAICompatibleProvider({
    apiKey: 'test-key', baseURL: 'http://127.0.0.1:9/v1', label: 'Test', timeout: 5000, idleTimeoutMs: 5000,
    clientOptions: { fetch },
  });

  it('streams the whole answer without a signal', async () => {
    const fetch = createSseFetch({ events: openAiEvents(['a', 'b', 'c']), intervalMs: 2 });
    const deltas = [];
    const text = await make(fetch).stream(NEUTRAL, 'm', (d) => deltas.push(d));
    assert.equal(text, 'abc');
    assert.deepEqual(deltas, ['a', 'b', 'c']);
  });

  it('stops mid-stream: aborts the request, sends no later chunk, rejects as cancelled', async () => {
    const fetch = createSseFetch({ events: openAiEvents(PIECES) });
    const run = await abortMidStream((signal, onDelta) => make(fetch).stream(NEUTRAL, 'm', onDelta, { signal }));
    assertCancelled(run.error);
    assert.equal(run.deltas.length, run.deltasAtAbort, 'a chunk arrived after the stop');
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].aborted, true, 'the HTTP request was not aborted');
    assert.equal(fetch.calls[0].sentAfterAbort, 0);
    assert.ok(fetch.calls[0].sent < openAiEvents(PIECES).length, 'the server sent everything anyway');
  });

  it('stops a non-streamed request', async () => {
    const fetch = createSseFetch({ events: [], json: { choices: [{ message: { content: 'late' }, finish_reason: 'stop' }] } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(make(fetch).generate(NEUTRAL, 'm', { signal: controller.signal }), assertCancelled);
    assert.equal(fetch.calls[0].aborted, true);
  });

  it('sends nothing when already stopped', async () => {
    const fetch = createSseFetch({ events: openAiEvents(['x']) });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(make(fetch).stream(NEUTRAL, 'm', () => {}, { signal: controller.signal }), assertCancelled);
    await assert.rejects(make(fetch).generate(NEUTRAL, 'm', { signal: controller.signal }), assertCancelled);
    assert.equal(fetch.calls.length, 0);
  });
});

describe('Anthropic provider', { timeout: TEST_TIMEOUT_MS }, () => {
  const make = (fetch) => new AnthropicProvider({
    apiKey: 'test-key', baseURL: 'http://127.0.0.1:9', label: 'Claude', timeout: 5000, idleTimeoutMs: 5000,
    clientOptions: { fetch },
  });

  it('streams the whole answer without a signal', async () => {
    const fetch = createSseFetch({ events: anthropicEvents(['a', 'b']), intervalMs: 2 });
    const deltas = [];
    const text = await make(fetch).stream(NEUTRAL, 'm', (d) => deltas.push(d));
    assert.equal(text, 'ab');
    assert.deepEqual(deltas, ['a', 'b']);
  });

  it('stops mid-stream: aborts the request, sends no later chunk, rejects as cancelled', async () => {
    const fetch = createSseFetch({ events: anthropicEvents(PIECES) });
    const run = await abortMidStream((signal, onDelta) => make(fetch).stream(NEUTRAL, 'm', onDelta, { signal }));
    assertCancelled(run.error);
    assert.equal(run.deltas.length, run.deltasAtAbort, 'a chunk arrived after the stop');
    assert.equal(fetch.calls.length, 1, 'the stop started another request');
    assert.equal(fetch.calls[0].aborted, true, 'the HTTP request was not aborted');
    assert.equal(fetch.calls[0].sentAfterAbort, 0);
  });

  it('stops a non-streamed request', async () => {
    const fetch = createSseFetch({
      events: [],
      json: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'late' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(make(fetch).generate(NEUTRAL, 'm', { signal: controller.signal }), assertCancelled);
    assert.equal(fetch.calls[0].aborted, true);
  });
});

// LLMService with a stand-in for one piece (provider, Gemini SDK client or
// https.request); restored after each test.
describe('LLMService', { timeout: TEST_TIMEOUT_MS }, () => {
  let saved;
  let savedRequest;
  beforeEach(() => {
    saved = {
      providerId: llmService.providerId, provider: llmService.provider, client: llmService.client,
      model: llmService.model, isInitialized: llmService.isInitialized, errorCount: llmService.errorCount,
    };
    savedRequest = https.request;
  });
  afterEach(() => {
    Object.assign(llmService, saved);
    // Methods a test replaced on the instance; the class methods show again.
    for (const name of ['processTextWithSkill', 'processTranscriptionWithIntelligentResponse', 'processImageWithSkill', '_streamRequestForModel']) {
      delete llmService[name];
    }
    https.request = savedRequest;
  });

  const useProvider = (provider, id = 'openai') => {
    llmService.providerId = id;
    llmService.provider = provider;
    llmService.client = null;
    llmService.model = 'test-model';
    llmService.isInitialized = true;
  };
  const useGemini = (client = null) => {
    llmService.providerId = 'gemini';
    llmService.provider = null;
    llmService.client = client;
    llmService.model = 'gemini-test';
    llmService.isInitialized = true;
  };

  describe('provider path (OpenAI-compatible and Claude)', () => {
    for (const [id, Provider, events] of [
      ['openai', OpenAICompatibleProvider, openAiEvents],
      ['anthropic', AnthropicProvider, anthropicEvents],
    ]) {
      it(`${id}: a stopped stream keeps its text, with no reset, no fallback and no error`, async () => {
        const fetch = createSseFetch({ events: events(PIECES) });
        useProvider(new Provider({ apiKey: 'k', baseURL: 'http://127.0.0.1:9', timeout: 5000, idleTimeoutMs: 5000, clientOptions: { fetch } }), id);
        let resets = 0;
        let fallbacks = 0;
        llmService.processTextWithSkill = async () => { fallbacks++; return { response: 'fallback' }; };
        const errorsBefore = llmService.errorCount;
        const run = await abortMidStream((signal, onDelta) =>
          llmService.processTextWithSkillStream('Hi', 'technical', [], null, onDelta, () => { resets++; }, { signal }));
        assertCancelled(run.error);
        assert.equal(run.error.isUserFacing, undefined, 'turned into an error message');
        assert.equal(run.deltas.length, run.deltasAtAbort, 'a chunk arrived after the stop');
        assert.equal(resets, 0, 'the text shown so far was cleared');
        assert.equal(fallbacks, 0, 'the non-streaming fallback ran');
        assert.equal(fetch.calls.length, 1, 'retried after the stop');
        assert.equal(llmService.errorCount, errorsBefore);
      });
    }

    it('a stop during the retry wait ends it at once and makes no further attempt', async () => {
      let attempts = 0;
      useProvider({
        stream: async () => {
          attempts++;
          throw Object.assign(new Error('503 service unavailable: busy'), { status: 503 });
        },
        generate: async () => { attempts++; return 'never'; },
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50); // the first retry waits at least 1.5 s
      const t0 = Date.now();
      await assert.rejects(
        llmService.executeProviderRequest(GEMINI_REQUEST, () => {}, { signal: controller.signal }),
        assertCancelled
      );
      assert.ok(Date.now() - t0 < 1000, `the retry wait ran out instead (${Date.now() - t0} ms)`);
      assert.equal(attempts, 1);
    });

    it('drops chunks and the result of a provider that ignores the stop', async () => {
      let finish;
      let streamStart = 0;
      let streamEndMs = Infinity; // ms from the stream's start to its own end
      useProvider({
        // Ignores options.signal: keeps sending and then resolves.
        stream: (neutral, model, onDelta) => new Promise((resolve) => {
          streamStart = Date.now();
          let i = 0;
          const timer = setInterval(() => {
            onDelta(PIECES[i++ % PIECES.length]);
            if (i === 12) {
              clearInterval(timer);
              streamEndMs = Date.now() - streamStart;
              resolve('everything');
            }
          }, 10);
          finish = () => clearInterval(timer);
        }),
        generate: async () => 'never',
      });
      const run = await abortMidStream((signal, onDelta) =>
        llmService.executeStreamingRequest(GEMINI_REQUEST, onDelta, null, signal));
      finish();
      assertCancelled(run.error);
      assert.equal(run.deltas.length, run.deltasAtAbort, 'a late chunk got through');
      // Settled by the stop, before the provider would have finished on its own
      // (a fixed ms limit flaked on Windows, whose timers tick in ~15 ms steps).
      assert.ok(run.ms < streamEndMs, `settled after ${run.ms} ms, the stream ended by itself after ${streamEndMs} ms`);
    });

    it('a stopped non-streamed request tries neither method again', async () => {
      let calls = 0;
      useProvider({
        stream: async () => 'never',
        generate: (neutral, model, options) => new Promise((resolve, reject) => {
          calls++;
          options.signal.addEventListener('abort', () => reject(new Error('Test request was aborted')));
        }),
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const errorsBefore = llmService.errorCount;
      await assert.rejects(
        llmService.processTranscriptionWithIntelligentResponse('Tell me about yourself', 'hr', [], null, { signal: controller.signal }),
        assertCancelled
      );
      assert.equal(calls, 1, 'the secondary request method ran after the stop');
      assert.equal(llmService.errorCount, errorsBefore);
    });
  });

  describe('Gemini SDK path (executeRequest)', () => {
    it('passes the signal to the SDK and tries no fallback model after the stop', async () => {
      const seen = [];
      useGemini({
        models: {
          generateContent: (params) => new Promise((resolve, reject) => {
            seen.push({ model: params.model, signal: params.config.abortSignal });
            params.config.abortSignal.addEventListener('abort', () => reject(new Error('503 UNAVAILABLE: aborted')));
          }),
        },
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(llmService.executeRequest(GEMINI_REQUEST, controller.signal), assertCancelled);
      assert.equal(seen.length, 1, `models tried: ${seen.map((s) => s.model).join(', ')}`);
      assert.equal(seen[0].signal, controller.signal);
      assert.equal(GEMINI_REQUEST.generationConfig.abortSignal, undefined, 'the shared request was changed');
    });

    it('ends at the stop even when the SDK ignores the signal', async () => {
      useGemini({ models: { generateContent: () => new Promise(() => {}) } });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const t0 = Date.now();
      await assert.rejects(llmService.executeRequest(GEMINI_REQUEST, controller.signal), assertCancelled);
      assert.ok(Date.now() - t0 < 500);
    });
  });

  describe('Gemini HTTPS paths', () => {
    // https.request stand-in: answers 200 and sends one SSE line (or, for
    // generateContent, the JSON body) every 20 ms until destroyed.
    function fakeHttps() {
      const requests = [];
      https.request = (url, options, callback) => {
        const req = new EventEmitter();
        const record = { url: String(url), destroyed: false, sentAfterDestroy: 0 };
        requests.push(record);
        req.write = () => true;
        req.destroy = () => {
          record.destroyed = true;
          setImmediate(() => req.emit('close'));
          return req;
        };
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.setEncoding = () => {};
          setImmediate(() => callback(res));
          const streamed = record.url.includes('streamGenerateContent');
          let i = 0;
          const timer = setInterval(() => {
            if (record.destroyed) {
              clearInterval(timer);
              return;
            }
            if (!streamed) {
              clearInterval(timer);
              if (i++ < 5) return;
            }
            if (streamed && i < PIECES.length) {
              res.emit('data', `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: PIECES[i++] }] } }] })}\n`);
            } else {
              clearInterval(timer);
              res.emit('data', streamed ? '' : JSON.stringify({ candidates: [{ content: { parts: [{ text: 'late' }] } }] }));
              res.emit('end');
            }
          }, 20);
        };
        return req;
      };
      return requests;
    }

    it('a stopped stream closes the connection, sends no later chunk and is not retried', async () => {
      const requests = fakeHttps();
      useGemini();
      let resets = 0;
      const run = await abortMidStream((signal, onDelta) =>
        llmService.executeStreamingRequest(GEMINI_REQUEST, onDelta, () => { resets++; }, signal));
      assertCancelled(run.error);
      assert.equal(run.deltas.length, run.deltasAtAbort, 'a chunk arrived after the stop');
      assert.equal(requests.length, 1, 'retried or tried another model after the stop');
      assert.equal(requests[0].destroyed, true, 'the connection stayed open');
      assert.equal(resets, 1, 'only the first attempt start ran'); // onAttemptStart before attempt 1
    });

    it('a stop while a model is unavailable tries no fallback model', async () => {
      useGemini();
      const models = [];
      llmService._streamRequestForModel = async (request, model, _key, _onDelta, _signal) => {
        models.push(model);
        controller.abort(); // the stop lands while this model fails
        throw new Error('HTTP 503: UNAVAILABLE high demand');
      };
      const controller = new AbortController();
      await assert.rejects(llmService.executeStreamingRequest(GEMINI_REQUEST, () => {}, null, controller.signal), assertCancelled);
      assert.deepEqual(models, ['gemini-test']);
    });

    it('a stopped non-streamed request (alternative HTTPS method) is closed and not retried', async () => {
      const requests = fakeHttps();
      useGemini({ models: { generateContent: () => { throw new Error('the SDK path ran after the stop'); } } });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(llmService.executeAlternativeRequest(GEMINI_REQUEST, controller.signal), assertCancelled);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].destroyed, true);
    });

    it('voice and screenshot streams stop without the non-streaming fallback', async () => {
      fakeHttps();
      useGemini();
      const fallbacks = [];
      llmService.processTranscriptionWithIntelligentResponse = async () => { fallbacks.push('voice'); return {}; };
      llmService.processImageWithSkill = async () => { fallbacks.push('image'); return {}; };
      {
        const voice = await abortMidStream((signal, onDelta) =>
          llmService.processTranscriptionWithIntelligentResponseStream('What is a hash map', 'technical', [], null, onDelta, null, { signal }));
        assertCancelled(voice.error);
        assert.equal(voice.deltas.length, voice.deltasAtAbort);
        const image = await abortMidStream((signal, onDelta) =>
          llmService.processImageWithSkillStream(Buffer.from('png'), 'image/png', 'dsa', [], 'cpp', onDelta, null, { signal }));
        assertCancelled(image.error);
        assert.equal(image.deltas.length, image.deltasAtAbort);
      }
      assert.deepEqual(fallbacks, []);
    });
  });
});
