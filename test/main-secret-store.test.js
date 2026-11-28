'use strict';
// main.js with the encrypted key store: keys in the userData .env move into
// userData/secrets.bin, Settings saves keys there and everything else to
// .env, a project .env is never rewritten, systems without secure storage
// keep keys in .env, and no key ever reaches a window or the log.
//
// Like test/main-ipc.test.js, main.js runs in a child process
// (test/helpers/main-harness.js) with a mocked electron module whose
// safeStorage is test/helpers/fake-safe-storage.js.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { RESULT_MARKER } = require('./helpers/main-harness');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');

const HARNESS = path.join(__dirname, 'helpers', 'main-harness.js');
const isPosix = process.platform !== 'win32';

const GEMINI_KEY = 'AIzaFAKEgeminiKEY0000wxyz';
const AZURE_KEY = 'fakeAzureSpeechKey00abcd';
const NEW_GROQ_KEY = 'gsk_FAKEnewGroqKey00007890';
const NEW_GEMINI_KEY = 'AIzaFAKEnewGeminiKEY0000';
const ALL_KEYS = [GEMINI_KEY, AZURE_KEY, NEW_GROQ_KEY, NEW_GEMINI_KEY];

const ENV_FILE = [
  '# Cuewell settings (comments survive)',
  'LLM_PROVIDER=gemini',
  `GEMINI_API_KEY=${GEMINI_KEY}`,
  'GEMINI_MODEL=gemini-2.5-flash',
  `AZURE_SPEECH_KEY=${AZURE_KEY}`,
  'AZURE_SPEECH_REGION=eastus',
  'SPEECH_PROVIDER=azure',
  'GROQ_API_KEY=',
  '',
].join('\n');

const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

/** Run main.js once. `userDataEnv` / `projectEnv`: .env text for userData / the launch folder. */
function runHarness({ userDataEnv, projectEnv, secrets, secretsFileText, safeStorage, platform = 'linux', ready = true, calls }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuewell-secrets-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'userData'));
  if (userDataEnv !== undefined) fs.writeFileSync(path.join(root, 'userData', '.env'), userDataEnv, { mode: 0o600 });
  if (projectEnv !== undefined) fs.writeFileSync(path.join(root, '.env'), projectEnv, { mode: 0o600 });
  if (secretsFileText !== undefined) fs.writeFileSync(path.join(root, 'userData', 'secrets.bin'), secretsFileText);
  if (secrets) {
    const encrypted = createFakeSafeStorage().encryptString(JSON.stringify({ version: 1, secrets }));
    fs.writeFileSync(path.join(root, 'userData', 'secrets.bin'), encrypted, { mode: 0o600 });
  }
  const requestPath = path.join(root, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify({ root, calls, safeStorage, platform, ready }));

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
  assert.equal(child.status, 0, report);
  output.byLabel = Object.fromEntries(output.results.map((r) => [r.label, r]));
  const projectFile = path.join(root, '.env');
  output.projectEnvText = fs.existsSync(projectFile) ? fs.readFileSync(projectFile, 'utf8') : null;
  return output;
}

/** The keys in the harness's secrets.bin, decrypted with the fake. */
function storedSecrets(output) {
  assert.ok(output.secretsFile, 'no secrets.bin');
  const decrypted = createFakeSafeStorage().decryptString(Buffer.from(output.secretsFile.text, 'latin1'));
  return JSON.parse(decrypted).secrets;
}

/** No key in any IPC result or log line. */
function assertNoKeyLeaks(output) {
  for (const result of output.results) {
    const json = JSON.stringify(result.value) || '';
    for (const key of ALL_KEYS) assert.ok(!json.includes(key), `${result.label} returned a key`);
  }
  const logs = JSON.stringify(output.logs);
  for (const key of ALL_KEYS) assert.ok(!logs.includes(key), `a key reached the log: ${key.slice(0, 6)}...`);
  assert.deepEqual(output.logs.filter((log) => log.level === 'error'), []);
  assert.deepEqual(output.blocked, []);
}

const SETTINGS_CALLS = [
  { label: 'info', channel: 'get-settings-info', from: 'settings' },
  { label: 'settings', channel: 'get-settings', from: 'settings' },
  { label: 'status', channel: 'get-first-run-status', from: 'onboarding' },
  { label: 'save groq', channel: 'save-settings', from: 'settings', args: [{ groqKey: NEW_GROQ_KEY, answerLength: 'short' }] },
  { label: 'settings after save', channel: 'get-settings', from: 'settings' },
  { label: 'remove azure', channel: 'remove-secret', from: 'settings', args: ['azureKey'] },
  { label: 'settings after remove', channel: 'get-settings', from: 'settings' },
  { label: 'info after', channel: 'get-settings-info', from: 'settings' },
];

describe('main.js key storage: secure storage, userData .env', () => {
  const out = runHarness({ userDataEnv: ENV_FILE, safeStorage: { backend: 'gnome_libsecret' }, calls: SETTINGS_CALLS });

  it('moves the keys out of .env, keeping comments and every other setting', () => {
    const text = out.envFile.text;
    for (const key of ALL_KEYS) assert.ok(!text.includes(key), 'a key is still in .env');
    assert.ok(!/^GEMINI_API_KEY=/m.test(text));
    assert.ok(!/^AZURE_SPEECH_KEY=/m.test(text));
    assert.ok(!/^GROQ_API_KEY=/m.test(text), 'the saved key\'s empty line is removed too');
    for (const kept of ['# Cuewell settings (comments survive)', 'LLM_PROVIDER=gemini', 'GEMINI_MODEL=gemini-2.5-flash',
      'AZURE_SPEECH_REGION=eastus', 'SPEECH_PROVIDER=azure', 'ANSWER_LENGTH=short']) {
      assert.ok(text.split('\n').includes(kept), `missing: ${kept}`);
    }
  });

  it('keeps the keys encrypted in secrets.bin, owner-only', () => {
    for (const key of ALL_KEYS) assert.ok(!out.secretsFile.text.includes(key), 'plain key in secrets.bin');
    assert.deepEqual(storedSecrets(out), { GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: NEW_GROQ_KEY });
    if (isPosix) {
      assert.equal(out.secretsFile.mode, 0o600);
      assert.equal(out.envFile.mode, 0o600);
    }
  });

  it('applies the moved and saved keys to the running app', () => {
    assert.equal(out.processEnvKeys.GEMINI_API_KEY, GEMINI_KEY);
    assert.equal(out.processEnvKeys.GROQ_API_KEY, NEW_GROQ_KEY);
    assert.equal(out.processEnvKeys.AZURE_SPEECH_KEY, '');
  });

  it('shows keys to windows only masked', () => {
    assert.deepEqual(out.byLabel.settings.value.geminiKey, { set: true, last4: 'wxyz' });
    assert.deepEqual(out.byLabel.settings.value.azureKey, { set: true, last4: 'abcd' });
    assert.deepEqual(out.byLabel['settings after save'].value.groqKey, { set: true, last4: '7890' });
    assert.deepEqual(out.byLabel['settings after remove'].value.azureKey, { set: false, last4: '' });
    assert.equal(out.byLabel['save groq'].value.success, true);
    assert.equal(out.byLabel['save groq'].value.persisted, undefined);
    assert.equal(out.byLabel['remove azure'].value.success, true);
    assert.equal(out.byLabel['remove azure'].value.persisted, undefined);
  });

  it('counts a key moved into the store for onboarding', () => {
    const status = out.byLabel.status.value;
    assert.equal(status.llmConfigured, true);
    assert.equal(status.azureConfigured, true);
    assert.deepEqual(status.geminiKey, { set: true, last4: 'wxyz' });
  });

  it('reports encrypted storage to Settings with booleans and labels only', () => {
    const storage = out.byLabel.info.value.keyStorage;
    assert.deepEqual(storage, {
      encrypted: true,
      backend: 'gnome_libsecret',
      label: 'Secret Service (GNOME Keyring)',
      message: 'Keys are encrypted with your system keychain',
      unreadable: false,
      plainTextKeys: false,
      projectEnv: false,
    });
  });

  it('never sends or logs a key', () => assertNoKeyLeaks(out));
});

describe('main.js key storage: no secure storage', () => {
  for (const [name, safeStorage] of [
    ['Linux basic_text', { backend: 'basic_text' }],
    ['encryption unavailable', { available: false }],
  ]) {
    describe(name, () => {
      const out = runHarness({ userDataEnv: ENV_FILE, safeStorage, calls: SETTINGS_CALLS });

      it('keeps keys in .env and writes no secrets.bin', () => {
        assert.equal(out.secretsFile, null);
        assert.match(out.envFile.text, new RegExp(`^GEMINI_API_KEY=${GEMINI_KEY}$`, 'm'));
        assert.match(out.envFile.text, new RegExp(`^GROQ_API_KEY=${NEW_GROQ_KEY}$`, 'm'));
        assert.match(out.envFile.text, /^AZURE_SPEECH_KEY=$/m);
        assert.equal(out.byLabel['save groq'].value.success, true);
        assert.equal(out.byLabel['save groq'].value.persisted, undefined);
      });

      it('says so in Settings', () => {
        const storage = out.byLabel.info.value.keyStorage;
        assert.equal(storage.encrypted, false);
        assert.equal(storage.label, '');
        assert.equal(storage.message, 'Your system has no secure key storage, so keys are saved in a file only your user can read');
        assert.equal(storage.plainTextKeys, true);
      });

      it('never sends or logs a key', () => assertNoKeyLeaks(out));
    });
  }
});

describe('main.js key storage: secure storage but encryption fails', () => {
  const out = runHarness({ userDataEnv: ENV_FILE, safeStorage: { failEncrypt: true }, calls: SETTINGS_CALLS.slice(0, 5) });

  it('leaves the keys in .env and saves a new key there instead of losing it', () => {
    assert.equal(out.secretsFile, null);
    assert.match(out.envFile.text, new RegExp(`^GEMINI_API_KEY=${GEMINI_KEY}$`, 'm'));
    assert.match(out.envFile.text, new RegExp(`^AZURE_SPEECH_KEY=${AZURE_KEY}$`, 'm'));
    assert.match(out.envFile.text, new RegExp(`^GROQ_API_KEY=${NEW_GROQ_KEY}$`, 'm'));
    assert.equal(out.byLabel['save groq'].value.success, true);
    assert.equal(out.byLabel.info.value.keyStorage.plainTextKeys, true);
    assert.ok(out.logs.some((log) => log.level === 'warn' && /left in \.env/.test(log.message)));
  });

  it('never sends or logs a key', () => assertNoKeyLeaks(out));
});

describe('main.js key storage: running from source with a project .env', () => {
  const projectEnv = ENV_FILE;
  const out = runHarness({
    projectEnv,
    safeStorage: { backend: 'kwallet5' },
    calls: [
      { label: 'info', channel: 'get-settings-info', from: 'settings' },
      { label: 'settings', channel: 'get-settings', from: 'settings' },
      // GROQ_API_KEY is empty in the project .env: goes to the store.
      { label: 'save groq', channel: 'save-settings', from: 'settings', args: [{ groqKey: NEW_GROQ_KEY }] },
      // GEMINI_API_KEY is set there and would win over the store: updated in place.
      { label: 'save gemini', channel: 'save-settings', from: 'settings', args: [{ geminiKey: NEW_GEMINI_KEY }] },
    ],
  });

  it('uses the project .env keys and never moves them', () => {
    assert.deepEqual(out.byLabel.settings.value.geminiKey, { set: true, last4: 'wxyz' });
    assert.equal(out.envFile, null, 'no userData .env is created');
    const expected = projectEnv.replace(`GEMINI_API_KEY=${GEMINI_KEY}`, `GEMINI_API_KEY=${NEW_GEMINI_KEY}`);
    assert.equal(out.projectEnvText, expected);
  });

  it('saves a key the project .env does not set in the store', () => {
    assert.deepEqual(storedSecrets(out), { GROQ_API_KEY: NEW_GROQ_KEY });
    assert.equal(out.processEnvKeys.GROQ_API_KEY, NEW_GROQ_KEY);
    assert.equal(out.processEnvKeys.GEMINI_API_KEY, NEW_GEMINI_KEY);
  });

  it('tells Settings that keys are in the project .env', () => {
    const storage = out.byLabel.info.value.keyStorage;
    assert.equal(storage.encrypted, true);
    assert.equal(storage.label, 'KWallet');
    assert.equal(storage.projectEnv, true);
    assert.equal(storage.plainTextKeys, true);
  });

  it('never sends or logs a key', () => assertNoKeyLeaks(out));
});

describe('main.js key storage: the next start', () => {
  const out = runHarness({
    userDataEnv: 'LLM_PROVIDER=gemini\nAZURE_SPEECH_REGION=eastus\n',
    secrets: { GEMINI_API_KEY: GEMINI_KEY, AZURE_SPEECH_KEY: AZURE_KEY },
    safeStorage: {},
    calls: [
      { label: 'settings', channel: 'get-settings', from: 'settings' },
      { label: 'status', channel: 'get-first-run-status', from: 'onboarding' },
    ],
  });

  it('loads the saved keys from secrets.bin', () => {
    assert.deepEqual(out.byLabel.settings.value.geminiKey, { set: true, last4: 'wxyz' });
    assert.deepEqual(out.byLabel.settings.value.azureKey, { set: true, last4: 'abcd' });
    assert.equal(out.byLabel.status.value.llmConfigured, true);
    // No SPEECH_PROVIDER: the speech service picks Azure once its key is loaded.
    assert.equal(out.byLabel.settings.value.speechProvider, 'azure');
    assert.equal(out.envFile.text, 'LLM_PROVIDER=gemini\nAZURE_SPEECH_REGION=eastus\n');
  });

  it('never sends or logs a key', () => assertNoKeyLeaks(out));
});

describe('main.js key storage: before the app is ready', () => {
  const out = runHarness({
    userDataEnv: ENV_FILE,
    safeStorage: {},
    ready: false,
    calls: [{ label: 'info', channel: 'get-settings-info', from: 'settings' }],
  });

  it('does not touch .env or the store (safeStorage needs the ready event)', () => {
    assert.equal(out.envFile.text, ENV_FILE);
    assert.equal(out.secretsFile, null);
  });
});

describe('main.js key storage: a key file that cannot be read', () => {
  const out = runHarness({
    userDataEnv: ENV_FILE,
    safeStorage: {},
    calls: [
      { label: 'info', channel: 'get-settings-info', from: 'settings' },
      { label: 'save groq', channel: 'save-settings', from: 'settings', args: [{ groqKey: NEW_GROQ_KEY }] },
    ],
    secretsFileText: 'encrypted with another keychain',
  });

  it('keeps the file, leaves the keys in .env and saves a new key there', () => {
    assert.equal(out.secretsFile.text, 'encrypted with another keychain');
    assert.match(out.envFile.text, new RegExp(`^GEMINI_API_KEY=${GEMINI_KEY}$`, 'm'));
    assert.match(out.envFile.text, new RegExp(`^GROQ_API_KEY=${NEW_GROQ_KEY}$`, 'm'));
    assert.equal(out.byLabel['save groq'].value.success, true);
    assert.equal(out.byLabel.info.value.keyStorage.unreadable, true);
  });

  it('never sends or logs a key', () => assertNoKeyLeaks(out));
});

describe('main.js key storage: removing a key while secure storage is missing', () => {
  const out = runHarness({
    userDataEnv: 'LLM_PROVIDER=gemini\n',
    secrets: { GEMINI_API_KEY: GEMINI_KEY },
    safeStorage: { backend: 'basic_text' },
    calls: [
      { label: 'info', channel: 'get-settings-info', from: 'settings' },
      { label: 'remove gemini', channel: 'remove-secret', from: 'settings', args: ['geminiKey'] },
    ],
  });

  it('says the removal is not saved, because the key would come back from secrets.bin', () => {
    const removed = out.byLabel['remove gemini'].value;
    assert.equal(removed.success, true);
    assert.equal(removed.persisted, false);
    assert.equal(out.byLabel.info.value.keyStorage.unreadable, true);
    assert.equal(out.byLabel.info.value.keyStorage.encrypted, false);
  });
});
