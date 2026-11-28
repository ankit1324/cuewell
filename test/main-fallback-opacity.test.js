'use strict';
// main.js settings for provider fallback (llmFallback) and the answer and
// chat window opacity (windowOpacity): who may save them, what is accepted,
// what lands in .env, and what a restart reads back. main.js runs in a child
// process (test/helpers/main-harness.js) with a temp userData folder and
// fake keys only.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { RESULT_MARKER } = require('./helpers/main-harness');

const HARNESS = path.join(__dirname, 'helpers', 'main-harness.js');
const KEYS = {
  GEMINI_API_KEY: 'AIzaFAKEgeminiKEY0000wxyz',
  ANTHROPIC_API_KEY: 'sk-ant-FAKEanthropicKEY00wxyz',
  GROQ_API_KEY: 'your_groq_api_key_here', // template value: not set
};
const ENV_FILE = Object.entries(KEYS).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';

function runHarness(calls, { envText = ENV_FILE, platform } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuewell-fallback-'));
  try {
    fs.mkdirSync(path.join(root, 'userData'));
    fs.writeFileSync(path.join(root, 'userData', '.env'), envText, { mode: 0o600 });
    const requestPath = path.join(root, 'request.json');
    fs.writeFileSync(requestPath, JSON.stringify({ root, calls, platform }));
    const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      TMPDIR: root, TEMP: root, TMP: root, NODE_ENV: 'test' };
    for (const name of ['SystemRoot', 'windir', 'ComSpec']) if (process.env[name]) env[name] = process.env[name];
    const child = spawnSync(process.execPath, [HARNESS, requestPath], {
      cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
    });
    const report = `exit ${child.status}\n${(child.stdout || '').slice(-2000)}\n${(child.stderr || '').slice(-2000)}`;
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith(RESULT_MARKER));
    assert.ok(line, `harness printed no result: ${report}`);
    const output = JSON.parse(line.slice(RESULT_MARKER.length));
    assert.equal(output.fatal, undefined, output.fatal);
    output.byLabel = Object.fromEntries(output.results.map((r) => [r.label, r]));
    return output;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const save = (label, from, settings) => ({ label, channel: 'save-settings', from, args: [settings] });
const get = (label, from = 'settings') => ({ label, channel: 'get-settings', from });

describe('main.js: backup providers and window opacity', () => {
  let out;

  before(() => {
    out = runHarness([
      get('initial'),
      get('toolbar', 'main'),
      { label: 'info', channel: 'get-settings-info', from: 'settings' },
      // Opacity
      save('main opacity', 'main', { windowOpacity: 70 }),
      save('onboarding opacity', 'onboarding', { windowOpacity: 70 }),
      save('opacity 39', 'settings', { windowOpacity: 39 }),
      save('opacity 101', 'settings', { windowOpacity: 101 }),
      save('opacity fraction', 'settings', { windowOpacity: '70.5' }),
      save('opacity negative', 'settings', { windowOpacity: '-50' }),
      save('opacity text', 'settings', { windowOpacity: 'half' }),
      save('opacity object', 'settings', { windowOpacity: { value: 70 } }),
      save('opacity 70', 'settings', { windowOpacity: 70 }),
      get('after opacity'),
      save('opacity 40 as text', 'settings', { windowOpacity: ' 40 ' }),
      get('after opacity 40'),
      // Backup providers
      save('main fallback', 'main', { llmFallback: [{ id: 'anthropic', enabled: false }] }),
      save('onboarding fallback', 'onboarding', { llmFallback: [{ id: 'anthropic', enabled: false }] }),
      save('fallback string', 'settings', { llmFallback: 'anthropic,openai' }),
      save('fallback unknown', 'settings', { llmFallback: [{ id: 'evil', enabled: true }] }),
      save('fallback duplicate', 'settings', { llmFallback: [{ id: 'openai', enabled: true }, { id: 'openai', enabled: false }] }),
      save('fallback not boolean', 'settings', { llmFallback: [{ id: 'openai', enabled: 'on' }] }),
      save('fallback extra field', 'settings', { llmFallback: [{ id: 'openai', enabled: true, apiKey: 'sk-x' }] }),
      save('fallback ok', 'settings', {
        llmFallback: [{ id: 'openai', enabled: true }, { id: 'anthropic', enabled: false }, { id: 'groq', enabled: true }],
      }),
      get('after fallback'),
    ]);
  });

  describe('window opacity', () => {
    it('defaults to 100% and is not sent to the toolbar', () => {
      assert.equal(out.byLabel.initial.value.windowOpacity, 100);
      assert.ok(!('windowOpacity' in out.byLabel.toolbar.value));
    });

    it('tells Settings whether this system supports it', () => {
      const supported = process.platform === 'darwin' || process.platform === 'win32';
      assert.equal(out.byLabel.info.value.windowOpacity, supported);
      for (const [platform, expected] of [['linux', false], ['darwin', true], ['win32', true]]) {
        const run = runHarness([{ label: 'info', channel: 'get-settings-info', from: 'settings' }], { platform });
        assert.equal(run.byLabel.info.value.windowOpacity, expected, platform);
      }
    });

    it('may be saved only from Settings', () => {
      for (const label of ['main opacity', 'onboarding opacity']) {
        assert.equal(out.byLabel[label].value.success, false, label);
        assert.equal(out.byLabel[label].value.field, 'windowOpacity', label);
      }
    });

    it('accepts only whole numbers from 40 to 100', () => {
      for (const label of ['opacity 39', 'opacity 101', 'opacity fraction', 'opacity negative', 'opacity text', 'opacity object']) {
        const value = out.byLabel[label].value;
        assert.equal(value.success, false, label);
        assert.equal(value.field, 'windowOpacity', label);
      }
      assert.match(out.byLabel['opacity 39'].value.error, /from 40 to 100/);
    });

    it('saves WINDOW_OPACITY and returns it', () => {
      assert.equal(out.byLabel['opacity 70'].value.success, true);
      assert.equal(out.byLabel['after opacity'].value.windowOpacity, 70);
      assert.equal(out.byLabel['opacity 40 as text'].value.success, true);
      assert.equal(out.byLabel['after opacity 40'].value.windowOpacity, 40);
      assert.match(out.envFile.text, /^WINDOW_OPACITY=40$/m);
      assert.equal((out.envFile.text.match(/^WINDOW_OPACITY=/gm) || []).length, 1);
    });

    it('reads the saved value on the next start, and ignores one out of range', () => {
      for (const [saved, expected] of [['55', 55], ['100', 100], ['20', 100], ['abc', 100], ['', 100]]) {
        const run = runHarness([get('get')], { envText: `${ENV_FILE}WINDOW_OPACITY=${saved}\n` });
        assert.equal(run.byLabel.get.value.windowOpacity, expected, saved);
      }
    });
  });

  describe('backup providers', () => {
    it('lists every provider in order, on, with whether it is set up, and no key', () => {
      const list = out.byLabel.initial.value.llmFallback;
      assert.deepEqual(list.map((item) => item.id), ['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'groq', 'ollama']);
      assert.ok(list.every((item) => item.enabled === true));
      const available = Object.fromEntries(list.map((item) => [item.id, item.available]));
      assert.deepEqual(available, {
        anthropic: true, openai: false, gemini: true, openrouter: false, deepseek: false, groq: false, ollama: false,
      });
      const text = JSON.stringify(out.byLabel.initial.value.llmFallback);
      for (const key of Object.values(KEYS)) assert.ok(!text.includes(key));
      assert.ok(!('llmFallback' in out.byLabel.toolbar.value));
    });

    it('may be saved only from Settings', () => {
      for (const label of ['main fallback', 'onboarding fallback']) {
        assert.equal(out.byLabel[label].value.success, false, label);
        assert.equal(out.byLabel[label].value.field, 'llmFallback', label);
      }
    });

    it('rejects anything but a list of known providers, each on or off once', () => {
      for (const label of ['fallback string', 'fallback unknown', 'fallback duplicate', 'fallback not boolean', 'fallback extra field']) {
        const value = out.byLabel[label].value;
        assert.equal(value.success, false, label);
        assert.equal(value.field, 'llmFallback', label);
      }
    });

    it('saves the order and the providers turned off to .env', () => {
      assert.equal(out.byLabel['fallback ok'].value.success, true);
      assert.match(out.envFile.text, /^LLM_FALLBACK_ORDER=openai,anthropic,groq$/m);
      assert.match(out.envFile.text, /^LLM_FALLBACK_DISABLED=anthropic$/m);
      const list = out.byLabel['after fallback'].value.llmFallback;
      assert.deepEqual(list.slice(0, 3), [
        { id: 'openai', enabled: true, available: false },
        { id: 'anthropic', enabled: false, available: true },
        { id: 'groq', enabled: true, available: false },
      ]);
      assert.equal(list.length, 7);
    });

    it('counts Ollama as set up once its URL or model is saved', () => {
      const run = runHarness([get('get')], { envText: `${ENV_FILE}OLLAMA_MODEL=llama3.2\n` });
      const ollama = run.byLabel.get.value.llmFallback.find((item) => item.id === 'ollama');
      assert.equal(ollama.available, true);
    });

    it('reads the saved order on the next start', () => {
      const run = runHarness([get('get')], {
        envText: `${ENV_FILE}LLM_FALLBACK_ORDER=gemini,anthropic\nLLM_FALLBACK_DISABLED=gemini\n`,
      });
      const list = run.byLabel.get.value.llmFallback;
      assert.deepEqual(list.slice(0, 2), [
        { id: 'gemini', enabled: false, available: true },
        { id: 'anthropic', enabled: true, available: true },
      ]);
    });
  });
});

describe('main.js: the provider note reaches the answer window', () => {
  it('passes metadata.providerNote with every final answer it shows', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const shows = source.match(/windowManager\.showLLMResponse\(llmResult\.response, \{[\s\S]*?\}\);/g) || [];
    assert.equal(shows.length, 3, 'screenshot, typed and voice answers');
    for (const call of shows) assert.match(call, /providerNote: llmResult\.metadata\.providerNote/);
  });
});
