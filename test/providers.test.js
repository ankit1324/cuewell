'use strict';
// src/services/providers: provider selection, key checks, endpoints, and the
// base URL rule main.js applies when Settings saves an endpoint. No request
// is ever sent: clients are only constructed.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { clearAppEnv, stubLogger } = require('./helpers/env');
const { loadFunction, loadConstant } = require('./helpers/source');

stubLogger(); // anthropic.provider.js loads the logger, which writes to ~/.Cuewell/logs
clearAppEnv();
const providers = require('../src/services/providers');
const { resolveIdleTimeoutMs } = require('../src/services/providers/idle-timeout');

const IDS = ['gemini', 'anthropic', 'openai', 'openrouter', 'groq', 'deepseek', 'ollama'];

describe('getActiveProviderId', () => {
  it('defaults to Gemini', () => {
    assert.equal(providers.getActiveProviderId({}), 'gemini');
    assert.equal(providers.getActiveProviderId({ LLM_PROVIDER: '' }), 'gemini');
    assert.equal(providers.getActiveProviderId({ LLM_PROVIDER: '   ' }), 'gemini');
  });

  it('accepts every provider, ignoring case and spaces', () => {
    for (const id of IDS) {
      assert.equal(providers.getActiveProviderId({ LLM_PROVIDER: id }), id);
      assert.equal(providers.getActiveProviderId({ LLM_PROVIDER: ` ${id.toUpperCase()} ` }), id);
    }
  });

  it('falls back to Gemini for unknown values, including prototype keys', () => {
    for (const value of ['claude', 'azure', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal(providers.getActiveProviderId({ LLM_PROVIDER: value }), 'gemini', value);
    }
  });

  it('reads process.env by default', (t) => {
    process.env.LLM_PROVIDER = 'groq';
    t.after(() => delete process.env.LLM_PROVIDER);
    assert.equal(providers.getActiveProviderId(), 'groq');
  });
});

describe('getProviderConfig', () => {
  it('returns null for unknown ids and inherited names', () => {
    for (const id of ['nope', '__proto__', 'constructor', 'toString', '', undefined, null]) {
      assert.equal(providers.getProviderConfig(id), null, String(id));
    }
  });

  it('is frozen so callers cannot change a preset', () => {
    assert.ok(Object.isFrozen(providers.PROVIDERS));
    for (const id of IDS) assert.ok(Object.isFrozen(providers.PROVIDERS[id]), id);
  });
});

describe('isPlaceholderKey', () => {
  it('recognizes template values', () => {
    for (const value of ['your_gemini_api_key_here', 'your-api-key-here', 'YOUR_KEY_HERE', ' your_openai_api_key_here ']) {
      assert.equal(providers.isPlaceholderKey(value), true, value);
    }
  });

  it('does not flag real-looking keys', () => {
    for (const value of ['', null, undefined, 'AIzaSyA-real', 'sk-ant-api03-x', 'yourkey', 'your_here_key']) {
      assert.equal(providers.isPlaceholderKey(value), false, String(value));
    }
  });
});

describe('isConfigured', () => {
  it('needs a non-placeholder key for providers with keys', () => {
    const keyEnv = {
      gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
    };
    for (const [id, name] of Object.entries(keyEnv)) {
      assert.equal(providers.isConfigured(id, {}), false, `${id} without key`);
      assert.equal(providers.isConfigured(id, { [name]: '   ' }), false, `${id} blank key`);
      assert.equal(providers.isConfigured(id, { [name]: 'your_api_key_here' }), false, `${id} placeholder`);
      assert.equal(providers.isConfigured(id, { [name]: 'real-key-123' }), true, `${id} with key`);
    }
  });

  it('does not accept another provider\'s key', () => {
    assert.equal(providers.isConfigured('anthropic', { GEMINI_API_KEY: 'real-key-123' }), false);
  });

  it('treats Ollama as configured without a key', () => {
    assert.equal(providers.isConfigured('ollama', {}), true);
  });

  it('is false for unknown providers', () => {
    assert.equal(providers.isConfigured('nope', { NOPE_API_KEY: 'x' }), false);
    assert.equal(providers.isConfigured('__proto__', {}), false);
  });
});

describe('getModel and getApiKey', () => {
  it('uses the override when set, else the preset', () => {
    assert.equal(providers.getModel('openai', { OPENAI_MODEL: ' gpt-x ' }), 'gpt-x');
    assert.equal(providers.getModel('openai', {}), providers.PROVIDERS.openai.defaultModel);
    assert.equal(providers.getModel('ollama', {}), 'llama3.2-vision');
    assert.equal(providers.getModel('nope', {}), null);
    for (const id of IDS) assert.ok(providers.getModel(id, {}), `${id} has a default model`);
  });

  it('trims keys and returns empty for Ollama and unknown ids', () => {
    assert.equal(providers.getApiKey('groq', { GROQ_API_KEY: '  gsk_1  ' }), 'gsk_1');
    assert.equal(providers.getApiKey('ollama', { OLLAMA_API_KEY: 'x' }), '');
    assert.equal(providers.getApiKey('nope', {}), '');
  });
});

describe('getBaseURL', () => {
  it('has HTTPS presets for every cloud provider and localhost for Ollama', () => {
    assert.equal(providers.getBaseURL('gemini', {}), null);
    assert.equal(providers.getBaseURL('anthropic', {}), 'https://api.anthropic.com');
    assert.equal(providers.getBaseURL('openai', {}), 'https://api.openai.com/v1');
    assert.equal(providers.getBaseURL('openrouter', {}), 'https://openrouter.ai/api/v1');
    assert.equal(providers.getBaseURL('groq', {}), 'https://api.groq.com/openai/v1');
    assert.equal(providers.getBaseURL('deepseek', {}), 'https://api.deepseek.com/v1');
    assert.equal(providers.getBaseURL('ollama', {}), 'http://localhost:11434/v1');
    assert.equal(providers.getBaseURL('nope', {}), null);
  });

  it('uses <NAME>_BASE_URL when set', () => {
    assert.equal(providers.getBaseURL('ollama', { OLLAMA_BASE_URL: 'http://127.0.0.1:9999/v1' }), 'http://127.0.0.1:9999/v1');
    assert.equal(providers.getBaseURL('anthropic', { ANTHROPIC_BASE_URL: 'https://proxy.example/a' }), 'https://proxy.example/a');
    assert.equal(providers.getBaseURL('openai', { OPENAI_BASE_URL: ' https://proxy.example/v1 ' }), 'https://proxy.example/v1');
  });

  it('never applies one provider\'s override to another', () => {
    assert.equal(providers.getBaseURL('groq', { OPENAI_BASE_URL: 'https://evil.example' }), 'https://api.groq.com/openai/v1');
  });
});

describe('listProviders', () => {
  it('lists every provider with its UI fields and no secrets', () => {
    const list = providers.listProviders();
    assert.deepEqual(list.map((p) => p.id), IDS);
    for (const p of list) {
      assert.deepEqual(Object.keys(p).sort(),
        ['defaultModel', 'id', 'keyEnv', 'label', 'modelEnv', 'noKey', 'supportsImages']);
    }
    const images = Object.fromEntries(list.map((p) => [p.id, p.supportsImages]));
    assert.deepEqual(images, {
      gemini: true, anthropic: true, openai: true, openrouter: true, groq: false, deepseek: false, ollama: true,
    });
  });
});

describe('createProvider (no network)', () => {
  it('returns null for Gemini and unknown ids', () => {
    assert.equal(providers.createProvider('gemini', { GEMINI_API_KEY: 'k' }), null);
    assert.equal(providers.createProvider('nope', {}), null);
  });

  it('builds a client with generate and stream for every other provider', () => {
    for (const id of IDS.filter((i) => i !== 'gemini')) {
      const provider = providers.createProvider(id, { [`${id.toUpperCase()}_API_KEY`]: 'test-key-123' });
      assert.equal(typeof provider.generate, 'function', id);
      assert.equal(typeof provider.stream, 'function', id);
    }
  });

  it('points OpenAI-compatible clients at the provider endpoint', () => {
    const groq = providers.createProvider('groq', { GROQ_API_KEY: 'k' });
    assert.equal(groq.client.baseURL, 'https://api.groq.com/openai/v1');
    const ollama = providers.createProvider('ollama', { OLLAMA_BASE_URL: 'http://127.0.0.1:1234/v1' });
    assert.equal(ollama.client.baseURL, 'http://127.0.0.1:1234/v1');
  });

  it('does not send OpenAI organization or project ids to other hosts', (t) => {
    process.env.OPENAI_ORG_ID = 'org-test';
    process.env.OPENAI_PROJECT_ID = 'proj-test';
    t.after(() => {
      delete process.env.OPENAI_ORG_ID;
      delete process.env.OPENAI_PROJECT_ID;
    });
    for (const id of ['openrouter', 'groq', 'deepseek', 'ollama']) {
      const provider = providers.createProvider(id, { [`${id.toUpperCase()}_API_KEY`]: 'k' });
      assert.equal(provider.client.organization, null, id);
      assert.equal(provider.client.project, null, id);
    }
    const openai = providers.createProvider('openai', { OPENAI_API_KEY: 'k' });
    assert.equal(openai.client.organization, 'org-test');
  });
});

describe('nodeRuntimeClientOptions', () => {
  const NodeURL = require('node:url').URL;
  const options = loadFunction('src/services/providers/index.js', 'nodeRuntimeClientOptions', { NodeURL });

  it('waives the SDK browser guard only while browser stand-ins are installed', (t) => {
    assert.equal(typeof globalThis.window, 'undefined');
    assert.deepEqual(options(), {});

    globalThis.window = {};
    t.after(() => { delete globalThis.window; });
    assert.deepEqual(options(), {}, 'window without a document');

    globalThis.window.document = {};
    assert.deepEqual(options(), { dangerouslyAllowBrowser: true });
  });
});

describe('resolveIdleTimeoutMs', () => {
  it('uses the value when positive and 60 s otherwise', () => {
    assert.equal(resolveIdleTimeoutMs('5000'), 5000);
    assert.equal(resolveIdleTimeoutMs(1), 1);
    for (const value of [undefined, '', '0', '-1', 'abc', NaN, Infinity]) {
      assert.equal(resolveIdleTimeoutMs(value), 60000, String(value));
    }
    assert.equal(resolveIdleTimeoutMs(1e12), 2147483647);
  });
});

// main.js validates OLLAMA_BASE_URL (and any other endpoint) on save with
// baseUrlProblem(). main.js cannot be required outside Electron, so the
// function and its host list are compiled from its source.
describe('baseUrlProblem (main.js)', () => {
  const { URL } = require('node:url');
  const LOCAL_HOSTNAMES = loadConstant('main.js', 'LOCAL_HOSTNAMES');
  const baseUrlProblem = loadFunction('main.js', 'baseUrlProblem', { URL, LOCAL_HOSTNAMES });

  it('allows https anywhere and http only on this machine', () => {
    for (const url of [
      'https://api.example.com/v1',
      'https://10.0.0.5:8443/v1',
      'http://localhost:11434/v1',
      'http://LOCALHOST:11434',
      'http://127.0.0.1:11434/v1',
      'http://[::1]:11434/v1',
    ]) {
      assert.equal(baseUrlProblem(url), null, url);
    }
  });

  it('rejects http to other hosts, including look-alikes', () => {
    for (const url of [
      'http://example.com/v1',
      'http://192.168.1.10:11434',
      'http://localhost.example.com',
      'http://127.0.0.1.nip.io',
      'http://0.0.0.0:11434',
    ]) {
      assert.match(baseUrlProblem(url), /must use https/, url);
    }
  });

  it('rejects other schemes, credentials and junk', () => {
    assert.match(baseUrlProblem('ftp://example.com'), /must start with https/);
    assert.match(baseUrlProblem('file:///etc/passwd'), /must start with https/);
    assert.match(baseUrlProblem('javascript:alert(1)'), /must start with https/);
    assert.match(baseUrlProblem('https://user:pass@example.com'), /user name or password/);
    assert.match(baseUrlProblem('http://user@localhost:11434'), /user name or password/);
    for (const junk of ['', 'localhost:11434', 'not a url', '//example.com']) {
      assert.ok(baseUrlProblem(junk), JSON.stringify(junk));
    }
  });
});
