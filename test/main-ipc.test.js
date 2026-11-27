'use strict';
// main.js IPC: every channel checks its sender against IPC_ALLOWED_WINDOWS,
// get-settings never returns a key, and save-settings / save-profile only
// accept what each window may change.
//
// main.js runs in a child process (test/helpers/main-harness.js) with a
// mocked electron module, a temp userData folder and a minimal environment
// holding only fake keys. app.whenReady() never resolves there, so no window
// opens; the handlers are called directly with fake senders.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { loadConstant } = require('./helpers/source');
const { RESULT_MARKER } = require('./helpers/main-harness');

const HARNESS = path.join(__dirname, 'helpers', 'main-harness.js');
const WINDOW_TYPES = ['main', 'chat', 'llmResponse', 'settings', 'onboarding'];
const BAD_SENDERS = ['unregistered', 'subframe', 'foreign-url', 'wrong-page', 'destroyed'];
const IPC_ALLOWED_WINDOWS = loadConstant('main.js', 'IPC_ALLOWED_WINDOWS', { Object });
const isPosix = process.platform !== 'win32';

// Fake keys. They must never appear in anything main.js returns or logs.
const KEYS = {
  GEMINI_API_KEY: 'AIzaFAKEgeminiKEY0000wxyz',
  AZURE_SPEECH_KEY: 'fakeAzureSpeechKey00abcd',
  OPENAI_API_KEY: 'sk-short', // under 12 characters: no last4
  ANTHROPIC_API_KEY: 'your_anthropic_api_key_here', // template value: not set
};
const NEW_GROQ_KEY = 'gsk_FAKEnewGroqKey00007890';
const ENV_FILE = [
  `GEMINI_API_KEY=${KEYS.GEMINI_API_KEY}`,
  `AZURE_SPEECH_KEY=${KEYS.AZURE_SPEECH_KEY}`,
  'AZURE_SPEECH_REGION=eastus',
  'SPEECH_PROVIDER=azure',
  `OPENAI_API_KEY=${KEYS.OPENAI_API_KEY}`,
  `ANTHROPIC_API_KEY=${KEYS.ANTHROPIC_API_KEY}`,
  '',
].join('\n');
const SECRET_FIELDS = ['geminiKey', 'azureKey', 'anthropicKey', 'openaiKey', 'openrouterKey', 'groqKey', 'deepseekKey'];

// Allowed calls with no side effects outside the temp folder (no network,
// no child processes, no installs).
const SAFE_ALLOWED_CHANNELS = ['get-settings', 'get-profile', 'get-first-run-status', 'get-speech-availability', 'get-window-stats'];

function runHarness(root, calls) {
  fs.mkdirSync(path.join(root, 'userData'));
  fs.writeFileSync(path.join(root, 'userData', '.env'), ENV_FILE, { mode: 0o644 });
  if (isPosix) fs.chmodSync(path.join(root, 'userData', '.env'), 0o644);
  const requestPath = path.join(root, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify({ root, calls }));

  // Only what Node needs to run, with every home and temp folder in `root`,
  // so the developer's keys, userData and logs are out of reach.
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TMPDIR: root, TEMP: root, TMP: root, NODE_ENV: 'test' };
  for (const name of ['SystemRoot', 'windir', 'ComSpec']) if (process.env[name]) env[name] = process.env[name];

  const child = spawnSync(process.execPath, [HARNESS, requestPath], {
    cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
  });
  const report = `exit ${child.status}${child.error ? `, ${child.error.message}` : ''}\n` +
    `${(child.stdout || '').slice(-2000)}\n${(child.stderr || '').slice(-2000)}`;
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith(RESULT_MARKER));
  assert.ok(line, `harness printed no result: ${report}`);
  const output = JSON.parse(line.slice(RESULT_MARKER.length));
  assert.equal(output.fatal, undefined, output.fatal);
  assert.equal(child.status, 0, report);
  output.byLabel = Object.fromEntries(output.results.map((r) => [r.label, r]));
  return output;
}

function assertRejected(result) {
  assert.ok(result, 'missing result');
  assert.equal(result.rejectedBySender, true, `${result.label}: sender was not rejected`);
  if (result.ok === false) assert.match(result.error, /is not available to this window/, result.label);
  else assert.equal(result.value, undefined, `${result.label}: a rejected send must not run`);
}

function assertAccepted(result) {
  assert.ok(result, 'missing result');
  assert.equal(result.rejectedBySender, false, `${result.label}: sender was rejected`);
  assert.equal(result.ok, true, `${result.label}: ${result.error}`);
}

describe('main.js IPC', () => {
  let out;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuewell-main-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  before(() => {
    // What get-settings returns for a saved key; Settings sends it back unchanged.
    const masked = Object.fromEntries(SECRET_FIELDS.map((f) => [f, { set: true, last4: 'wxyz' }]));
    const calls = [];
    // Every channel from every window type that may not use it, and from senders that are not app pages.
    for (const [channel, allowed] of Object.entries(IPC_ALLOWED_WINDOWS)) {
      for (const from of WINDOW_TYPES.filter((type) => !allowed.includes(type))) {
        calls.push({ label: `deny ${channel} from ${from}`, channel, from, args: [{}] });
      }
      for (const from of BAD_SENDERS) calls.push({ label: `deny ${channel} from ${from}`, channel, from, args: [{}] });
    }
    // Allowed, side-effect-free reads from every window type that may use them.
    for (const channel of SAFE_ALLOWED_CHANNELS) {
      for (const from of IPC_ALLOWED_WINDOWS[channel]) calls.push({ label: `allow ${channel} from ${from}`, channel, from });
    }
    calls.push(
      // Toolbar may save only its language picker.
      { label: 'main saves a key', channel: 'save-settings', from: 'main', args: [{ geminiKey: 'AIzaFAKEotherKEY11112222' }] },
      { label: 'main saves codingLanguage', channel: 'save-settings', from: 'main', args: [{ codingLanguage: 'python' }] },
      { label: 'main get-settings after save', channel: 'get-settings', from: 'main' },
      // Onboarding may not change the coding language.
      { label: 'onboarding saves codingLanguage', channel: 'save-settings', from: 'onboarding', args: [{ codingLanguage: 'java' }] },
      // Settings: field validation.
      { label: 'settings saves non-object', channel: 'save-settings', from: 'settings', args: ['geminiKey=x'] },
      { label: 'settings saves unknown language', channel: 'save-settings', from: 'settings', args: [{ codingLanguage: 'cobol' }] },
      { label: 'settings saves key with space', channel: 'save-settings', from: 'settings', args: [{ geminiKey: 'has a space' }] },
      { label: 'settings saves remote http Ollama', channel: 'save-settings', from: 'settings', args: [{ ollamaBaseUrl: 'http://evil.example/v1' }] },
      { label: 'settings saves local Ollama', channel: 'save-settings', from: 'settings', args: [{ ollamaBaseUrl: 'http://localhost:11434/v1' }] },
      // Saving the masked key objects get-settings returned keeps the saved keys.
      { label: 'settings saves masked keys back', channel: 'save-settings', from: 'settings', args: [{ ...masked, answerLength: 'short' }] },
      { label: 'settings saves a new Groq key', channel: 'save-settings', from: 'settings', args: [{ groqKey: NEW_GROQ_KEY }] },
      { label: 'settings get after new key', channel: 'get-settings', from: 'settings' },
      { label: 'onboarding status', channel: 'get-first-run-status', from: 'onboarding' },
      // Interview context.
      { label: 'save profile', channel: 'save-profile', from: 'settings', args: [{ role: ' Backend engineer ', company: 'Acme' }] },
      { label: 'save profile unknown field', channel: 'save-profile', from: 'settings', args: [{ role: 'x', salary: '1' }] },
      { label: 'save profile too long', channel: 'save-profile', from: 'settings', args: [{ role: 'x'.repeat(201) }] },
      { label: 'get profile', channel: 'get-profile', from: 'settings' },
    );
    out = runHarness(root, calls);
  });

  describe('channel table', () => {
    it('registers exactly the channels in IPC_ALLOWED_WINDOWS', () => {
      const registered = [...out.handleChannels, ...out.onChannels].sort();
      assert.deepEqual(registered, Object.keys(IPC_ALLOWED_WINDOWS).sort());
    });

    it('only names real window types', () => {
      for (const [channel, allowed] of Object.entries(IPC_ALLOWED_WINDOWS)) {
        assert.ok(allowed.length > 0, channel);
        for (const type of allowed) assert.ok(WINDOW_TYPES.includes(type), `${channel}: ${type}`);
      }
    });

    it('keeps key-bearing and system channels away from the content windows', () => {
      for (const channel of ['get-settings', 'save-settings', 'get-profile', 'save-profile', 'test-provider',
        'install-whisper', 'download-whisper-model', 'get-first-run-status', 'quit-app']) {
        for (const type of ['chat', 'llmResponse']) {
          assert.ok(!IPC_ALLOWED_WINDOWS[channel].includes(type), `${type} may use ${channel}`);
        }
      }
    });
  });

  describe('sender checks', () => {
    it('rejects every channel from every window type not on its list', () => {
      let checked = 0;
      for (const [channel, allowed] of Object.entries(IPC_ALLOWED_WINDOWS)) {
        for (const from of WINDOW_TYPES.filter((type) => !allowed.includes(type))) {
          assertRejected(out.byLabel[`deny ${channel} from ${from}`]);
          checked++;
        }
      }
      assert.ok(checked > 50, `only ${checked} combinations checked`);
    });

    for (const from of BAD_SENDERS) {
      it(`rejects every channel from a ${from} sender`, () => {
        for (const channel of Object.keys(IPC_ALLOWED_WINDOWS)) {
          assertRejected(out.byLabel[`deny ${channel} from ${from}`]);
        }
      });
    }

    it('accepts allowed windows', () => {
      for (const channel of SAFE_ALLOWED_CHANNELS) {
        for (const from of IPC_ALLOWED_WINDOWS[channel]) assertAccepted(out.byLabel[`allow ${channel} from ${from}`]);
      }
    });
  });

  describe('get-settings', () => {
    it('returns every secret masked as { set, last4 }', () => {
      const settings = out.byLabel['allow get-settings from settings'].value;
      for (const field of SECRET_FIELDS) {
        assert.deepEqual(Object.keys(settings[field]).sort(), ['last4', 'set'], field);
      }
      assert.deepEqual(settings.geminiKey, { set: true, last4: 'wxyz' });
      assert.deepEqual(settings.azureKey, { set: true, last4: 'abcd' });
      assert.deepEqual(settings.openaiKey, { set: true, last4: '' }, 'short keys show no characters');
      assert.deepEqual(settings.anthropicKey, { set: false, last4: '' }, 'a template key is not set');
      assert.deepEqual(settings.groqKey, { set: false, last4: '' });
      assert.equal(settings.azureRegion, 'eastus');
    });

    it('never returns a key value to any window', () => {
      for (const result of out.results.filter((r) => r.ok)) {
        const json = JSON.stringify(result.value);
        for (const key of [...Object.values(KEYS).filter((k) => k.length > 8), NEW_GROQ_KEY]) {
          assert.ok(!json || !json.includes(key), `${result.label} returned a key`);
        }
      }
    });

    it('gives the toolbar only its language, mode and mode list', () => {
      const settings = out.byLabel['allow get-settings from main'].value;
      assert.deepEqual(Object.keys(settings).sort(), ['activeSkill', 'codingLanguage', 'modes']);
      assert.equal(settings.activeSkill, 'auto');
    });

    it('masks the key in the onboarding status', () => {
      const status = out.byLabel['onboarding status'].value;
      assert.deepEqual(status.geminiKey, { set: true, last4: 'wxyz' });
      assert.equal(status.llmConfigured, true);
    });
  });

  describe('save-settings', () => {
    it('rejects fields a window may not change, and saves nothing', () => {
      const fromMain = out.byLabel['main saves a key'].value;
      assert.equal(fromMain.success, false);
      assert.equal(fromMain.field, 'geminiKey');
      const fromOnboarding = out.byLabel['onboarding saves codingLanguage'].value;
      assert.equal(fromOnboarding.success, false);
      assert.equal(fromOnboarding.field, 'codingLanguage');
      assert.ok(!out.envFile.text.includes('AIzaFAKEotherKEY11112222'));
    });

    it('lets the toolbar save the coding language', () => {
      assert.equal(out.byLabel['main saves codingLanguage'].value.success, true);
      assert.equal(out.byLabel['main get-settings after save'].value.codingLanguage, 'python');
    });

    it('rejects invalid values with the field name and a plain message', () => {
      const cases = {
        'settings saves non-object': null,
        'settings saves unknown language': 'codingLanguage',
        'settings saves key with space': 'geminiKey',
        'settings saves remote http Ollama': 'ollamaBaseUrl',
      };
      for (const [label, field] of Object.entries(cases)) {
        const value = out.byLabel[label].value;
        assert.equal(value.success, false, label);
        assert.equal(typeof value.error, 'string', label);
        assert.ok(value.error.length > 0 && value.error.length < 200, label);
        if (field) assert.equal(value.field, field, label);
      }
      assert.match(out.byLabel['settings saves remote http Ollama'].value.error, /https/);
    });

    it('accepts a local Ollama URL', () => {
      assert.equal(out.byLabel['settings saves local Ollama'].value.success, true);
      assert.match(out.envFile.text, /^OLLAMA_BASE_URL=http:\/\/localhost:11434\/v1$/m);
    });

    it('keeps saved keys when the masked values are sent back', () => {
      assert.equal(out.byLabel['settings saves masked keys back'].value.success, true);
      assert.match(out.envFile.text, new RegExp(`^GEMINI_API_KEY=${KEYS.GEMINI_API_KEY}$`, 'm'));
      assert.match(out.envFile.text, new RegExp(`^AZURE_SPEECH_KEY=${KEYS.AZURE_SPEECH_KEY}$`, 'm'));
      assert.match(out.envFile.text, /^ANSWER_LENGTH=short$/m);
      assert.ok(!out.envFile.text.includes('[object Object]'));
    });

    it('stores a new key and only shows its last 4 characters', () => {
      assert.equal(out.byLabel['settings saves a new Groq key'].value.success, true);
      assert.match(out.envFile.text, new RegExp(`^GROQ_API_KEY=${NEW_GROQ_KEY}$`, 'm'));
      assert.deepEqual(out.byLabel['settings get after new key'].value.groqKey, { set: true, last4: '7890' });
    });

    it('keeps .env readable by the owner only', { skip: !isPosix && 'POSIX file modes only' }, () => {
      assert.equal(out.envFile.mode, 0o600);
    });
  });

  describe('interview context', () => {
    it('saves a valid profile and returns the clean copy', () => {
      const saved = out.byLabel['save profile'].value;
      assert.equal(saved.success, true);
      assert.equal(saved.profile.role, 'Backend engineer');
      assert.deepEqual(out.byLabel['get profile'].value.profile, saved.profile);
      assert.deepEqual(JSON.parse(out.profileFile.text), saved.profile);
    });

    it('rejects an unknown field or a value over the limit, keeping the saved profile', () => {
      for (const [label, field] of [['save profile unknown field', 'salary'], ['save profile too long', 'role']]) {
        const value = out.byLabel[label].value;
        assert.equal(value.success, false, label);
        assert.equal(value.field, field, label);
      }
      assert.equal(out.byLabel['get profile'].value.profile.role, 'Backend engineer');
    });

    it('returns the field limits for the form', () => {
      assert.deepEqual(out.byLabel['get profile'].value.limits,
        { role: 200, company: 200, jobDescription: 20000, resume: 20000, notes: 20000 });
    });

    it('writes profile.json readable by the owner only', { skip: !isPosix && 'POSIX file modes only' }, () => {
      assert.equal(out.profileFile.mode, 0o600);
    });
  });

  describe('side effects', () => {
    it('never contain a key or interview context values', () => {
      const json = JSON.stringify(out.logs);
      for (const key of [...Object.values(KEYS).filter((k) => k.length > 8), NEW_GROQ_KEY, 'AIzaFAKEotherKEY11112222']) {
        assert.ok(!json.includes(key), `a key reached the log: ${key.slice(0, 6)}...`);
      }
      assert.ok(!json.includes('Backend engineer'), 'interview context reached the log');
    });

    it('show no attempt to start a process or open a connection', () => {
      assert.deepEqual(out.blocked, []);
    });

    it('report no errors while loading and handling these calls', () => {
      assert.deepEqual(out.logs.filter((log) => log.level === 'error'), []);
    });
  });
});
