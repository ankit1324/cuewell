'use strict';
// Provider fallback (src/services/providers/fallback.js and LLMService):
// which failures send the question to a backup provider, in which order,
// and what the answer says about it. Providers are in-memory fakes; nothing
// leaves this process.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { stubLogger, clearAppEnv, silentLogger } = require('./helpers/env');

stubLogger();
// LLMService logs the time of each answer it gets.
silentLogger.logPerformance = () => 0;
clearAppEnv();
const fallback = require('../src/services/providers/fallback');
const { refusedError, noTextAtLimitError } = require('../src/services/providers/errors');
const { cancelledError, isCancelledError } = require('../src/services/cancellation');
const llmService = require('../src/services/llm.service');

const LLMService = llmService.constructor;
const TEST_TIMEOUT_MS = 10000;

const withStatus = (message, status) => Object.assign(new Error(message), { status });
// What LLMService throws after its own retries: the user-facing text, with the raw error as cause.
const userFacing = (cause) => Object.assign(new Error('Something friendly.'), { cause, isUserFacing: true });

describe('classifyFailure', () => {
  const falls = (error, kind) => {
    const result = fallback.classifyFailure(error);
    assert.equal(result.fallback, true, `${error.message}: no fallback`);
    assert.equal(result.kind, kind, error.message);
    assert.ok(result.reason, 'no reason');
    return result;
  };
  const stays = (error, kind) => {
    const result = fallback.classifyFailure(error);
    assert.equal(result.fallback, false, `${error && error.message}: fell back`);
    if (kind) assert.equal(result.kind, kind);
  };

  it('falls back on network errors and timeouts', () => {
    falls(new Error('network error: could not connect to OpenAI: ECONNREFUSED'), 'network');
    falls(new Error('Streaming request failed: getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), 'network');
    falls(new Error('Alternative request failed: socket hang up'), 'network');
    falls(new Error('fetch failed'), 'network');
    falls(new Error('request timeout: Anthropic Claude did not respond in time'), 'timeout');
    falls(new Error('Request timeout'), 'timeout');
    falls(new Error('request timeout: OpenAI stopped sending data for 60s'), 'timeout');
  });

  it('falls back on 5xx, overload and rate limits', () => {
    assert.equal(falls(withStatus('500 server error: boom', 500), 'server').reason, 'server error (500)');
    falls(withStatus('502 bad gateway: x', 502), 'server');
    falls(new Error('HTTP 503: {"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}'), 'overloaded');
    falls(withStatus('529 overloaded: Overloaded', 529), 'overloaded');
    assert.equal(falls(withStatus('429 rate limit exceeded: slow down', 429), 'rate').reason, 'rate limit reached');
    falls(withStatus('429 rate limit exceeded: You exceeded your current quota, check your plan and billing', 429), 'quota');
    falls(new Error('HTTP 429: {"error":{"status":"RESOURCE_EXHAUSTED"}}'), 'rate');
    falls(withStatus('402 payment required: no credits', 402), 'quota');
  });

  it('falls back on a bad or expired key and an unavailable model', () => {
    falls(withStatus('401 invalid API key: invalid x-api-key', 401), 'auth');
    falls(withStatus('403 forbidden: no access', 403), 'auth');
    // Gemini says 400 for a bad or expired key.
    falls(withStatus('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', 400), 'auth');
    falls(new Error('HTTP 400: {"error":{"code":400,"message":"API key expired. Please renew the API key."}}'), 'auth');
    falls(withStatus('404 model or endpoint not found: no such model', 404), 'model');
  });

  it('reads the raw error behind the user-facing one, including Gemini\'s wrapped errors', () => {
    const gemini = Object.assign(new Error('Gemini API failed after trying a, b: Request timeout'), {
      originalError: new Error('Request timeout'),
    });
    falls(userFacing(gemini), 'timeout');
    falls(userFacing(withStatus('401 invalid API key: bad', 401)), 'auth');
    // The friendly text alone ("Rate limit or quota exceeded...") is not read.
    stays(Object.assign(new Error('Rate limit or quota exceeded. Wait a moment.'), { isUserFacing: true }));
  });

  it('never falls back on a stop, a refusal, the token limit or an unknown error', () => {
    stays(cancelledError(), 'cancelled');
    stays(userFacing(cancelledError()), 'cancelled');
    stays(refusedError('Claude declined this request'), 'refused');
    stays(userFacing(refusedError('OpenAI declined this request (content filter)')), 'refused');
    stays(new Error('No text parts in candidates. Finish reasons: SAFETY'), 'refused');
    stays(new Error('No text parts in candidates. Finish reasons: PROHIBITED_CONTENT'), 'refused');
    stays(noTextAtLimitError('OpenAI', 64), 'limit');
    stays(withStatus('400 bad request: messages: text content blocks must be non-empty', 400));
    stays(withStatus('413 request too large: image too big', 413));
    stays(new Error('Groq does not support screenshots. Choose Gemini, ...'));
    stays(new Error('LLM service not initialized. Check Gemini API key configuration.'));
    stays(new Error('Empty response from OpenAI'));
    stays(null);
    stays(undefined);
  });

  it('a refusal anywhere in the chain wins over a status', () => {
    stays(Object.assign(withStatus('500 server error', 500), { cause: refusedError('declined') }), 'refused');
  });
});

describe('fallback settings', () => {
  it('defaults to every provider, on, in the default order', () => {
    const list = fallback.getFallbackSettings({});
    assert.deepEqual(list.map((item) => item.id), [...fallback.DEFAULT_FALLBACK_ORDER]);
    assert.ok(list.every((item) => item.enabled === true));
  });

  it('keeps the saved order, then the rest, and turns off the disabled ones', () => {
    const list = fallback.getFallbackSettings({
      LLM_FALLBACK_ORDER: ' groq, OPENAI,nope,groq,../x ',
      LLM_FALLBACK_DISABLED: 'openai,unknown',
    });
    assert.deepEqual(list.slice(0, 3), [
      { id: 'groq', enabled: true }, { id: 'openai', enabled: false }, { id: 'anthropic', enabled: true },
    ]);
    assert.equal(list.length, 7);
    assert.equal(new Set(list.map((item) => item.id)).size, 7);
  });

  it('writes the order and the disabled ids', () => {
    assert.deepEqual(fallback.fallbackEnvValues([
      { id: 'openai', enabled: true }, { id: 'groq', enabled: false }, { id: 'gemini', enabled: false },
    ]), { LLM_FALLBACK_ORDER: 'openai,groq,gemini', LLM_FALLBACK_DISABLED: 'groq,gemini' });
    assert.deepEqual(fallback.fallbackEnvValues([{ id: 'openai', enabled: true }]),
      { LLM_FALLBACK_ORDER: 'openai', LLM_FALLBACK_DISABLED: '' });
  });

  it('validates the list Settings sends', () => {
    const ok = fallback.validateFallbackSettings([{ id: 'anthropic', enabled: true }, { id: 'groq', enabled: false }]);
    assert.deepEqual(ok, { list: [{ id: 'anthropic', enabled: true }, { id: 'groq', enabled: false }] });
    assert.deepEqual(fallback.validateFallbackSettings([]), { list: [] });
    for (const bad of [
      'anthropic,groq', null, {}, 3,
      [{ id: 'nope', enabled: true }],
      [{ id: '__proto__', enabled: true }],
      [{ id: 'constructor', enabled: true }],
      [{ id: 'anthropic', enabled: 'yes' }],
      [{ id: 'anthropic' }],
      [{ id: 'anthropic', enabled: true, key: 'sk-x' }],
      [{ id: 'anthropic', enabled: true }, { id: 'anthropic', enabled: false }],
      ['anthropic'],
      [null],
      new Array(8).fill(0).map((_, i) => ({ id: ['gemini', 'anthropic', 'openai', 'openrouter', 'groq', 'deepseek', 'ollama', 'gemini'][i], enabled: true })),
    ]) {
      assert.ok(fallback.validateFallbackSettings(bad).error, JSON.stringify(bad));
    }
  });

  it('chains only providers that are on, set up and not the selected one, in order', () => {
    const env = {
      GEMINI_API_KEY: 'AIza-test', ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test',
      GROQ_API_KEY: 'your_groq_api_key_here', // template value: not set
      DEEPSEEK_API_KEY: 'sk-deep',
    };
    assert.deepEqual(fallback.getFallbackChain('gemini', env), ['anthropic', 'openai', 'deepseek']);
    assert.deepEqual(fallback.getFallbackChain('anthropic', env), ['openai', 'gemini', 'deepseek']);
    assert.deepEqual(fallback.getFallbackChain('gemini', { ...env, LLM_FALLBACK_ORDER: 'deepseek,openai' }),
      ['deepseek', 'openai', 'anthropic']);
    assert.deepEqual(fallback.getFallbackChain('gemini', { ...env, LLM_FALLBACK_DISABLED: 'anthropic,deepseek' }), ['openai']);
    assert.deepEqual(fallback.getFallbackChain('gemini', { GEMINI_API_KEY: 'AIza-test' }), []);
  });

  it('chains only vision providers for a screenshot', () => {
    const env = { GEMINI_API_KEY: 'k', GROQ_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k', LLM_FALLBACK_ORDER: 'groq,deepseek,openai' };
    assert.deepEqual(fallback.getFallbackChain('gemini', env), ['groq', 'deepseek', 'openai']);
    assert.deepEqual(fallback.getFallbackChain('gemini', env, { needsImages: true }), ['openai']);
  });

  it('uses Ollama only once its server URL or model is set', () => {
    const env = { GEMINI_API_KEY: 'k' };
    assert.deepEqual(fallback.getFallbackChain('gemini', env), []);
    assert.deepEqual(fallback.getFallbackChain('gemini', { ...env, OLLAMA_MODEL: 'llama3.2' }), ['ollama']);
    assert.deepEqual(fallback.getFallbackChain('gemini', { ...env, OLLAMA_BASE_URL: 'http://localhost:11434/v1' }), ['ollama']);
    assert.deepEqual(fallback.getFallbackChain('ollama', { ...env, OLLAMA_MODEL: 'x' }), ['gemini']);
  });

  it('words the note with short provider names', () => {
    assert.equal(fallback.fallbackNote('gemini', 'anthropic', 'rate limit reached'),
      'Answered by Claude because Gemini failed: rate limit reached');
    assert.equal(fallback.fallbackNote('openai', 'ollama', ''), 'Answered by Ollama because OpenAI failed');
  });
});

describe('LLMService provider fallback', { timeout: TEST_TIMEOUT_MS }, () => {
  const ENV_KEYS = ['LLM_PROVIDER', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY',
    'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'LLM_FALLBACK_ORDER', 'LLM_FALLBACK_DISABLED'];
  let savedEnv;
  let created;
  let fakes;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    created = [];
    fakes = {};
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * A provider whose every call runs `behavior({ streaming, onDelta, signal })`:
   * return the answer text, or throw.
   */
  const fakeProvider = (behavior) => {
    const provider = {
      calls: [],
      async generate(_neutral, _model, { signal } = {}) {
        provider.calls.push('generate');
        return behavior({ streaming: false, signal });
      },
      async stream(_neutral, _model, onDelta, { signal } = {}) {
        provider.calls.push('stream');
        return behavior({ streaming: true, onDelta, signal });
      },
    };
    return provider;
  };
  const answering = (pieces) => fakeProvider(async ({ streaming, onDelta }) => {
    if (streaming) for (const piece of pieces) onDelta(piece);
    return pieces.join('');
  });
  const failing = (error) => fakeProvider(async () => { throw error; });

  /** The selected provider (LLM_PROVIDER=primaryId) with `provider`; backups come from `fakes`. */
  const service = (primaryId, provider) => {
    process.env.LLM_PROVIDER = primaryId;
    const s = new LLMService();
    s.provider = provider;
    s.model = 'test-model';
    s.isInitialized = true;
    s.delay = async () => {};
    s._isOllamaReachable = async () => true;
    s._createFallbackService = (id) => {
      created.push(id);
      const backup = new LLMService({ providerId: id });
      backup.provider = fakes[id] || null;
      backup.isInitialized = !!fakes[id];
      backup.delay = async () => {};
      backup.promptContext = s.promptContext;
      return backup;
    };
    return s;
  };
  const keys = (...ids) => ids.forEach((id) => { process.env[`${id.toUpperCase()}_API_KEY`] = `test-${id}-key`; });

  for (const [label, error] of [
    ['a 503', withStatus('503 service unavailable: overloaded', 503)],
    ['a 429', withStatus('429 rate limit exceeded: slow down', 429)],
    ['a bad key', withStatus('401 invalid API key: nope', 401)],
    ['no connection', new Error('network error: could not connect to OpenAI: ECONNREFUSED')],
    ['a timeout', new Error('request timeout: OpenAI did not respond in time')],
    ['a missing model', withStatus('404 model or endpoint not found: gpt-x', 404)],
  ]) {
    it(`answers from the backup after ${label}, and says so`, async () => {
      keys('openai', 'anthropic');
      fakes.anthropic = answering(['Backup ', 'answer.']);
      const primary = failing(error);
      const deltas = [];
      const result = await service('openai', primary)
        .processTextWithSkillStream('What is a heap?', 'technical', [], null, (d) => deltas.push(d), () => {}, {});
      assert.equal(result.response, 'Backup answer.');
      assert.deepEqual(created, ['anthropic']);
      assert.equal(result.metadata.provider, 'anthropic');
      assert.equal(result.metadata.providerFallback.from, 'openai');
      assert.equal(result.metadata.providerFallback.to, 'anthropic');
      assert.match(result.metadata.providerNote, /^Answered by Claude because OpenAI failed: .+/);
      assert.deepEqual(deltas, ['Backup ', 'answer.']);
      assert.ok(primary.calls.includes('stream') && primary.calls.includes('generate'),
        'the selected provider\'s own retries and non-streaming fallback ran first');
    });
  }

  it('asks the first backup that is on, in the saved order, once', async () => {
    keys('openai', 'anthropic', 'gemini');
    process.env.LLM_FALLBACK_ORDER = 'gemini,anthropic';
    process.env.LLM_FALLBACK_DISABLED = 'gemini';
    fakes.anthropic = answering(['From Claude']);
    const result = await service('openai', failing(withStatus('500 server error: x', 500)))
      .processTextWithSkill('Hi', 'technical', [], null, {});
    assert.equal(result.response, 'From Claude');
    assert.deepEqual(created, ['anthropic']);
    assert.equal(result.metadata.providerNote, 'Answered by Claude because OpenAI failed: server error (500)');

    created = [];
    delete process.env.LLM_FALLBACK_DISABLED;
    process.env.LLM_FALLBACK_ORDER = 'anthropic,gemini';
    const second = await service('openai', failing(withStatus('500 server error: x', 500)))
      .processTextWithSkill('Hi', 'technical', [], null, {});
    assert.equal(second.response, 'From Claude');
    assert.deepEqual(created, ['anthropic']);
  });

  it('when the backup fails too, says both failed and tries no third provider', async () => {
    keys('openai', 'anthropic', 'groq');
    fakes.anthropic = failing(withStatus('529 overloaded: busy', 529));
    fakes.groq = answering(['never']);
    await assert.rejects(
      service('openai', failing(withStatus('503 service unavailable: x', 503)))
        .processTranscriptionWithIntelligentResponseStream('Tell me about yourself', 'hr', [], null, () => {}, () => {}, {}),
      (error) => {
        assert.equal(error.isUserFacing, true);
        assert.match(error.message, /Claude was tried instead and failed too\.$/);
        return true;
      });
    assert.deepEqual(created, ['anthropic']);
    assert.equal(fakes.groq.calls.length, 0);
  });

  it('does not fall back on a refusal, an unknown error or with nothing else set up', async () => {
    keys('openai', 'anthropic');
    fakes.anthropic = answering(['never']);
    await assert.rejects(service('openai', failing(refusedError('OpenAI declined this request (content filter)')))
      .processTextWithSkillStream('Hi', 'technical', [], null, () => {}, () => {}, {}));
    await assert.rejects(service('openai', failing(withStatus('400 bad request: bad', 400)))
      .processTextWithSkill('Hi', 'technical', [], null, {}));
    assert.deepEqual(created, []);

    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(service('openai', failing(withStatus('503 service unavailable: x', 503)))
      .processTextWithSkill('Hi', 'technical', [], null, {}));
    assert.deepEqual(created, []);
  });

  it('does not fall back when the answer is stopped, mid-stream or during the retry wait', async () => {
    keys('openai', 'anthropic');
    fakes.anthropic = answering(['never']);
    const controller = new AbortController();
    const primary = fakeProvider(async ({ streaming, onDelta, signal }) => {
      if (streaming) {
        onDelta('Partial ');
        controller.abort();
        if (signal && signal.aborted) throw cancelledError();
      }
      throw withStatus('503 service unavailable: x', 503);
    });
    let resets = 0;
    await assert.rejects(service('openai', primary).processTextWithSkillStream('Hi', 'technical', [], null,
      () => {}, () => { resets++; }, { signal: controller.signal }), (error) => isCancelledError(error));
    assert.equal(resets, 0, 'the text shown so far was cleared');

    const late = new AbortController();
    const s = service('openai', failing(withStatus('503 service unavailable: x', 503)));
    s.delay = async () => { late.abort(); throw cancelledError(); };
    await assert.rejects(s.processTextWithSkill('Hi', 'technical', [], null, { signal: late.signal }),
      (error) => isCancelledError(error));
    assert.deepEqual(created, []);
    assert.equal(fakes.anthropic.calls.length, 0);
  });

  it('clears text the failed provider streamed before the backup streams', async () => {
    keys('openai', 'anthropic');
    const log = [];
    fakes.anthropic = fakeProvider(async ({ streaming, onDelta }) => {
      if (streaming) ['Fresh ', 'answer.'].forEach((piece) => onDelta(piece));
      return 'Fresh answer.';
    });
    const primary = fakeProvider(async ({ streaming, onDelta }) => {
      if (streaming) {
        onDelta('Half an ');
        onDelta('answer');
      }
      throw new Error('network error: could not connect to OpenAI: ECONNRESET');
    });
    // The non-streaming fallback inside the selected provider clears it once
    // already; the backup must never stream after uncleared text.
    const s = service('openai', primary);
    const result = await s.processTextWithSkillStream('Hi', 'technical', [], null,
      (d) => log.push(`delta:${d}`), () => log.push('reset'), {});
    assert.equal(result.response, 'Fresh answer.');
    const firstBackup = log.indexOf('delta:Fresh ');
    assert.ok(firstBackup > 0);
    assert.equal(log.lastIndexOf('reset', firstBackup), firstBackup - 1, `no reset right before the backup: ${log.join(' | ')}`);
    assert.deepEqual(log.slice(firstBackup), ['delta:Fresh ', 'delta:answer.']);
  });

  it('resets before the backup when text is still on screen', async () => {
    const log = [];
    const s = new LLMService();
    const live = s._trackLiveText((d) => log.push(`delta:${d}`), () => log.push('reset'));
    live.clear();
    assert.deepEqual(log, [], 'reset with nothing on screen');
    live.onDelta('text');
    live.clear();
    live.clear();
    assert.deepEqual(log, ['delta:text', 'reset']);
    // Without callbacks it still works.
    const bare = s._trackLiveText(null, null);
    bare.onDelta('x');
    bare.clear();
  });

  it('sends a screenshot only to a backup that reads images', async () => {
    keys('openai', 'groq', 'anthropic');
    process.env.LLM_FALLBACK_ORDER = 'groq,anthropic';
    fakes.groq = answering(['text only']);
    fakes.anthropic = answering(['I see code.']);
    const result = await service('openai', failing(withStatus('503 service unavailable: x', 503)))
      .processImageWithSkillStream(Buffer.from('png'), 'image/png', 'dsa', [], 'cpp', () => {}, () => {}, {});
    assert.equal(result.response, 'I see code.');
    assert.deepEqual(created, ['anthropic']);
    assert.equal(result.metadata.isImageAnalysis, true);

    created = [];
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(service('openai', failing(withStatus('503 service unavailable: x', 503)))
      .processImageWithSkill(Buffer.from('png'), 'image/png', 'dsa', [], 'cpp', {}));
    assert.deepEqual(created, [], 'a text-only provider got a screenshot');

    // A typed question may still go to the text-only one.
    const typed = await service('openai', failing(withStatus('503 service unavailable: x', 503)))
      .processTextWithSkill('Hi', 'technical', [], null, {});
    assert.equal(typed.response, 'text only');
  });

  it('skips an Ollama backup whose server does not answer', async () => {
    keys('openai', 'anthropic');
    process.env.OLLAMA_MODEL = 'llama3.2';
    process.env.LLM_FALLBACK_ORDER = 'ollama,anthropic';
    fakes.ollama = answering(['never']);
    fakes.anthropic = answering(['From Claude']);
    const s = service('openai', failing(withStatus('503 service unavailable: x', 503)));
    s._isOllamaReachable = async () => false;
    const result = await s.processTextWithSkill('Hi', 'technical', [], null, {});
    assert.equal(result.response, 'From Claude');
    assert.deepEqual(created, ['anthropic']);

    created = [];
    const reachable = service('openai', failing(withStatus('503 service unavailable: x', 503)));
    const viaOllama = await reachable.processTextWithSkill('Hi', 'technical', [], null, {});
    assert.equal(viaOllama.response, 'never');
    assert.match(viaOllama.metadata.providerNote, /^Answered by Ollama because OpenAI failed/);
  });

  it('probes the Ollama server with a short connection attempt', async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}/v1`;
    const s = new LLMService();
    assert.equal(await s._isOllamaReachable(), true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(await s._isOllamaReachable(), false);
  });

  it('a backup service never falls back itself, and answers through its own provider', async () => {
    keys('anthropic', 'openai');
    const backup = new LLMService({ providerId: 'anthropic' });
    assert.equal(backup.providerId, 'anthropic');
    assert.equal(backup.isInitialized, true);
    backup.provider = failing(withStatus('503 service unavailable: x', 503));
    backup.delay = async () => {};
    let created2 = 0;
    backup._createFallbackService = () => { created2++; return null; };
    await assert.rejects(backup.processTextWithSkill('Hi', 'technical', [], null, {}));
    assert.equal(created2, 0);
  });

  it('a Gemini failure falls back too, with Gemini named in the note', async () => {
    keys('gemini', 'anthropic');
    fakes.anthropic = answering(['From Claude']);
    process.env.LLM_PROVIDER = 'gemini';
    const s = service('gemini', null);
    s.client = { models: { generateContent: async () => { throw withStatus('{"error":{"code":503,"status":"UNAVAILABLE"}}', 503); } } };
    s._streamRequestForModel = async () => { throw new Error('HTTP 503: {"error":{"status":"UNAVAILABLE"}}'); };
    s._executeAlternativeRequestForModel = async () => { throw new Error('HTTP 503: {"error":{"status":"UNAVAILABLE"}}'); };
    const result = await s.processTextWithSkillStream('Hi', 'technical', [], null, () => {}, () => {}, {});
    assert.equal(result.response, 'From Claude');
    assert.equal(result.metadata.providerNote, 'Answered by Claude because Gemini failed: overloaded');
  });

  it('builds a real backup service for the chosen provider, sharing the prompt settings', () => {
    keys('openai', 'anthropic');
    process.env.LLM_PROVIDER = 'openai';
    const s = new LLMService();
    s.setPromptContext({ answerLength: 'short' });
    const backup = s._createFallbackService('anthropic');
    assert.equal(backup.providerId, 'anthropic');
    assert.equal(backup.fixedProviderId, 'anthropic');
    assert.equal(backup.isInitialized, true);
    assert.ok(backup.provider);
    assert.equal(backup.promptContext.answerLength, 'short');
  });
});
