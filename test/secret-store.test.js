'use strict';
// src/core/secret-store.js: the encrypted key store (with a fake safeStorage),
// moving keys out of .env, and which backends count as secure. Everything
// runs in temp folders; no real keychain is touched.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, silentLogger, clearAppEnv } = require('./helpers/env');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');

clearAppEnv();
const {
  SecretStore, SECRETS_FILE, MESSAGE_ENCRYPTED, MESSAGE_PLAIN,
  isUsableSecret, removeEnvKeys, migrateEnvSecrets, applySecretsToEnv, initializeSecrets,
} = require('../src/core/secret-store');

const isPosix = process.platform !== 'win32';
const GEMINI_KEY = 'AIzaFAKEgeminiKEY0000wxyz';
const AZURE_KEY = 'fakeAzureSpeechKey00abcd';
const GROQ_KEY = 'gsk_FAKEgroqKey000000007890';
const KEYS = ['GEMINI_API_KEY', 'AZURE_SPEECH_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY'];

const ENV_TEXT = [
  '# Cuewell settings',
  'LLM_PROVIDER=gemini',
  '# Google Gemini key',
  `GEMINI_API_KEY=${GEMINI_KEY}`,
  'ANTHROPIC_API_KEY=your_anthropic_api_key_here',
  'OPENAI_API_KEY=',
  'GEMINI_MODEL=gemini-2.5-flash',
  `AZURE_SPEECH_KEY="${AZURE_KEY}" # saved by Settings`,
  'AZURE_SPEECH_REGION=eastus',
  "WHISPER_COMMAND='C:\\Users\\Jane Doe\\python.exe' -m whisper",
  '',
].join('\n');

function makeStore(t, { safeStorage = createFakeSafeStorage(), platform = 'linux', dir = tempDir(t) } = {}) {
  const filePath = path.join(dir, SECRETS_FILE);
  return { dir, filePath, safeStorage, store: new SecretStore({ filePath, safeStorage, platform, logger: silentLogger }) };
}

function recordingLogger() {
  const lines = [];
  const record = (level) => (message, meta) => lines.push({ level, message, meta });
  return { lines, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

describe('SecretStore', () => {
  it('round-trips keys through an encrypted file', (t) => {
    const { filePath, safeStorage, store } = makeStore(t);
    store.load();
    store.set('GEMINI_API_KEY', GEMINI_KEY);
    store.setMany({ AZURE_SPEECH_KEY: AZURE_KEY, GROQ_API_KEY: GROQ_KEY });
    assert.equal(store.get('GEMINI_API_KEY'), GEMINI_KEY);
    assert.deepEqual(store.all(), { GEMINI_API_KEY: GEMINI_KEY, AZURE_SPEECH_KEY: AZURE_KEY, GROQ_API_KEY: GROQ_KEY });

    const raw = fs.readFileSync(filePath, 'latin1');
    for (const key of [GEMINI_KEY, AZURE_KEY, GROQ_KEY, 'GEMINI_API_KEY']) assert.ok(!raw.includes(key), 'plain text in the file');

    const again = new SecretStore({ filePath, safeStorage, platform: 'linux', logger: silentLogger });
    assert.deepEqual(again.load(), { ok: true, count: 3 });
    assert.equal(again.get('AZURE_SPEECH_KEY'), AZURE_KEY);
    assert.deepEqual(again.readFromDisk(), store.all());
  });

  it('deletes a key, also when it is saved as empty', (t) => {
    const { store, filePath, safeStorage } = makeStore(t);
    store.setMany({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY });
    store.delete('GEMINI_API_KEY');
    store.set('GROQ_API_KEY', '');
    assert.deepEqual(store.all(), {});
    const again = new SecretStore({ filePath, safeStorage, platform: 'linux', logger: silentLogger });
    again.load();
    assert.deepEqual(again.all(), {});
  });

  it('loads what is on disk before the first write, so a write never drops saved keys', (t) => {
    const { store, filePath, safeStorage } = makeStore(t);
    store.set('GEMINI_API_KEY', GEMINI_KEY);
    const fresh = new SecretStore({ filePath, safeStorage, platform: 'linux', logger: silentLogger });
    fresh.set('GROQ_API_KEY', GROQ_KEY); // no load() first
    assert.deepEqual(fresh.readFromDisk(), { GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY });
  });

  it('writes the file owner-only, through a temp file', { skip: !isPosix && 'POSIX file modes only' }, (t) => {
    const { store, filePath, dir } = makeStore(t);
    store.set('GEMINI_API_KEY', GEMINI_KEY);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), [SECRETS_FILE]);
  });

  it('rejects bad key names and non-text values without writing', (t) => {
    const { store, filePath } = makeStore(t);
    assert.throws(() => store.set('../evil', 'x'), /Not a key name/);
    assert.throws(() => store.set('GEMINI_API_KEY', { value: 1 }), /must be text/);
    assert.equal(fs.existsSync(filePath), false);
  });

  it('keeps the memory copy when the encrypted write fails', (t) => {
    const safeStorage = createFakeSafeStorage();
    const { store } = makeStore(t, { safeStorage });
    store.set('GEMINI_API_KEY', GEMINI_KEY);
    safeStorage.state.failEncrypt = true;
    assert.throws(() => store.set('GEMINI_API_KEY', 'AIzaOTHERkey000000000000'));
    assert.equal(store.get('GEMINI_API_KEY'), GEMINI_KEY);
  });

  it('keeps a file it cannot read, and refuses to replace it', (t) => {
    const { store, filePath, dir } = makeStore(t);
    fs.writeFileSync(filePath, 'not encrypted by this keychain');
    const loaded = store.load();
    assert.equal(loaded.ok, false);
    assert.equal(store.status().unreadable, true);
    assert.throws(() => store.set('GROQ_API_KEY', GROQ_KEY), /cannot be read now/);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'not encrypted by this keychain');
    assert.deepEqual(fs.readdirSync(dir), [SECRETS_FILE]);
  });

  it('writes again once the file can be read', (t) => {
    const safeStorage = createFakeSafeStorage();
    const { store } = makeStore(t, { safeStorage });
    store.set('GEMINI_API_KEY', GEMINI_KEY);
    safeStorage.state.tamper = () => 'locked';
    store.load();
    assert.equal(store.status().unreadable, true);
    safeStorage.state.tamper = null; // the keyring was unlocked
    store.set('GROQ_API_KEY', GROQ_KEY);
    assert.deepEqual(store.readFromDisk(), { GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY });
    assert.equal(store.status().unreadable, false);
  });

  it('reports saved keys as unreadable when secure storage is gone', (t) => {
    const safeStorage = createFakeSafeStorage();
    const { store } = makeStore(t, { safeStorage });
    store.set('GEMINI_API_KEY', GEMINI_KEY);
    safeStorage.state.backend = 'basic_text';
    assert.equal(store.status().encrypted, false);
    assert.equal(store.status().unreadable, true);
  });
});

describe('SecretStore.status', () => {
  const cases = [
    { platform: 'darwin', available: true, backend: 'unknown', encrypted: true, label: 'macOS Keychain' },
    { platform: 'win32', available: true, backend: 'unknown', encrypted: true, label: 'Windows Data Protection' },
    { platform: 'linux', available: true, backend: 'gnome_libsecret', encrypted: true, label: 'Secret Service (GNOME Keyring)' },
    { platform: 'linux', available: true, backend: 'kwallet5', encrypted: true, label: 'KWallet' },
    { platform: 'linux', available: true, backend: 'kwallet6', encrypted: true, label: 'KWallet' },
    // Chromium "encrypts" with a fixed key when no keyring is found.
    { platform: 'linux', available: true, backend: 'basic_text', encrypted: false, label: '' },
    // Before the ready event.
    { platform: 'linux', available: true, backend: 'unknown', encrypted: false, label: '' },
    { platform: 'linux', available: false, backend: 'gnome_libsecret', encrypted: false, label: '' },
    { platform: 'darwin', available: false, backend: 'unknown', encrypted: false, label: '' },
    { platform: 'win32', available: false, backend: 'unknown', encrypted: false, label: '' },
  ];
  for (const c of cases) {
    it(`${c.platform}, ${c.available ? 'available' : 'unavailable'}, ${c.backend}: ${c.encrypted ? 'encrypted' : 'plain file'}`, (t) => {
      const safeStorage = createFakeSafeStorage({ available: c.available, backend: c.backend });
      const { store } = makeStore(t, { safeStorage, platform: c.platform });
      const status = store.status();
      assert.equal(status.encrypted, c.encrypted);
      assert.equal(store.isAvailable(), c.encrypted);
      assert.equal(status.label, c.label);
      assert.equal(status.message, c.encrypted ? MESSAGE_ENCRYPTED : MESSAGE_PLAIN);
      for (const value of Object.values(status)) assert.ok(['string', 'boolean'].includes(typeof value));
      if (!c.encrypted) assert.throws(() => store.set('GEMINI_API_KEY', GEMINI_KEY), /not available/);
    });
  }

  it('treats a safeStorage that returns something other than true as unavailable', (t) => {
    const odd = { isEncryptionAvailable: () => ({}), getSelectedStorageBackend: () => 'gnome_libsecret' };
    const { store } = makeStore(t, { safeStorage: odd, platform: 'linux' });
    assert.equal(store.isAvailable(), false);
    const throwing = { isEncryptionAvailable: () => { throw new Error('no'); } };
    assert.equal(makeStore(t, { safeStorage: throwing, platform: 'darwin' }).store.isAvailable(), false);
    assert.equal(makeStore(t, { safeStorage: null, platform: 'darwin' }).store.isAvailable(), false);
  });
});

describe('removeEnvKeys', () => {
  it('drops only the named keys, keeping comments, blank lines and line endings', () => {
    const text = '# keep\r\nA=1\r\n\r\nexport B=2\r\n  C = 3\r\n# B=commented\r\n';
    assert.equal(removeEnvKeys(text, ['B', 'C']), '# keep\r\nA=1\r\n\r\n# B=commented\r\n');
    assert.equal(removeEnvKeys('A=1\nA=2\nB=3', ['A']), 'B=3');
  });
});

describe('migrateEnvSecrets', () => {
  function setup(t, { env = ENV_TEXT, safeStorage } = {}) {
    const { dir, store, filePath } = makeStore(t, { safeStorage });
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, env, { mode: 0o600 });
    return { dir, envPath, store, filePath };
  }

  it('moves real keys into the store and removes only their lines', (t) => {
    const { envPath, store } = setup(t);
    const logger = recordingLogger();
    const result = migrateEnvSecrets({ envPath, store, keys: KEYS, logger });
    assert.deepEqual(result.migrated.sort(), ['AZURE_SPEECH_KEY', 'GEMINI_API_KEY']);
    assert.deepEqual(result.kept, []);
    assert.deepEqual(store.readFromDisk(), { GEMINI_API_KEY: GEMINI_KEY, AZURE_SPEECH_KEY: AZURE_KEY });

    const expected = ENV_TEXT.split('\n')
      .filter((line) => !line.startsWith('GEMINI_API_KEY=') && !line.startsWith('AZURE_SPEECH_KEY='))
      .join('\n');
    assert.equal(fs.readFileSync(envPath, 'utf8'), expected);
    assert.ok(!JSON.stringify(logger.lines).includes(GEMINI_KEY));
    assert.ok(!JSON.stringify(logger.lines).includes(AZURE_KEY));
  });

  it('keeps .env owner-only after the rewrite', { skip: !isPosix && 'POSIX file modes only' }, (t) => {
    const { envPath, store } = setup(t);
    migrateEnvSecrets({ envPath, store, keys: KEYS, logger: silentLogger });
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  });

  it('replaces an older stored value with the one in .env', (t) => {
    const { envPath, store } = setup(t);
    store.set('GEMINI_API_KEY', 'AIzaOLDstoredKEY000000000');
    migrateEnvSecrets({ envPath, store, keys: KEYS, logger: silentLogger });
    assert.equal(store.get('GEMINI_API_KEY'), GEMINI_KEY);
  });

  it('leaves .env untouched when the store reads back a different value', (t) => {
    const safeStorage = createFakeSafeStorage();
    const { envPath, store } = setup(t, { safeStorage });
    safeStorage.state.tamper = (text) => text.replace(GEMINI_KEY, 'AIzaCHANGED').replace(AZURE_KEY, 'changed');
    const logger = recordingLogger();
    const result = migrateEnvSecrets({ envPath, store, keys: KEYS, logger });
    assert.deepEqual(result.migrated, []);
    assert.deepEqual(result.kept.sort(), ['AZURE_SPEECH_KEY', 'GEMINI_API_KEY']);
    assert.equal(fs.readFileSync(envPath, 'utf8'), ENV_TEXT);
    assert.ok(logger.lines.some((l) => l.level === 'warn'));
    assert.ok(!JSON.stringify(logger.lines).includes(GEMINI_KEY));
  });

  it('removes only the keys that read back correctly', (t) => {
    const safeStorage = createFakeSafeStorage();
    const { envPath, store } = setup(t, { safeStorage });
    safeStorage.state.tamper = (text) => text.replace(AZURE_KEY, 'changed');
    const result = migrateEnvSecrets({ envPath, store, keys: KEYS, logger: silentLogger });
    assert.deepEqual(result.migrated, ['GEMINI_API_KEY']);
    const text = fs.readFileSync(envPath, 'utf8');
    assert.ok(!text.includes(GEMINI_KEY));
    assert.ok(text.includes(`AZURE_SPEECH_KEY="${AZURE_KEY}"`));
  });

  it('leaves .env untouched when encryption fails', (t) => {
    const { envPath, store, filePath } = setup(t, { safeStorage: createFakeSafeStorage({ failEncrypt: true }) });
    const result = migrateEnvSecrets({ envPath, store, keys: KEYS, logger: silentLogger });
    assert.deepEqual(result.migrated, []);
    assert.match(result.error, /encrypting/);
    assert.equal(fs.readFileSync(envPath, 'utf8'), ENV_TEXT);
    assert.equal(fs.existsSync(filePath), false);
  });

  it('leaves .env untouched when the store file cannot be read back', (t) => {
    const { envPath, store } = setup(t);
    store.readFromDisk = () => { throw new Error('read back failed'); };
    const result = migrateEnvSecrets({ envPath, store, keys: KEYS, logger: silentLogger });
    assert.deepEqual(result.migrated, []);
    assert.equal(fs.readFileSync(envPath, 'utf8'), ENV_TEXT);
  });

  it('leaves a key whose value spans lines where it is', (t) => {
    const env = `GEMINI_API_KEY="AIzaFIRSTline\nsecond"\nGROQ_API_KEY=${GROQ_KEY}\n`;
    const { envPath, store } = setup(t, { env });
    const result = migrateEnvSecrets({ envPath, store, keys: KEYS, logger: silentLogger });
    assert.deepEqual(result.migrated, ['GROQ_API_KEY']);
    assert.deepEqual(result.kept, ['GEMINI_API_KEY']);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'GEMINI_API_KEY="AIzaFIRSTline\nsecond"\n');
  });

  it('does nothing without a .env or without real keys in it', (t) => {
    const { dir, store, filePath } = makeStore(t);
    assert.deepEqual(migrateEnvSecrets({ envPath: path.join(dir, '.env'), store, keys: KEYS, logger: silentLogger }),
      { migrated: [], kept: [] });
    const envPath = path.join(dir, '.env');
    const template = 'GEMINI_API_KEY=your_gemini_api_key_here\nOPENAI_API_KEY=\n';
    fs.writeFileSync(envPath, template);
    migrateEnvSecrets({ envPath, store, keys: KEYS, logger: silentLogger });
    assert.equal(fs.readFileSync(envPath, 'utf8'), template);
    assert.equal(fs.existsSync(filePath), false);
  });
});

describe('initializeSecrets', () => {
  function setup(t, { safeStorage, platform = 'linux', env = ENV_TEXT } = {}) {
    const { dir, store, filePath } = makeStore(t, { safeStorage, platform });
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, env, { mode: 0o600 });
    return { dir, envPath, store, filePath };
  }

  it('with secure storage: migrates the userData .env and fills process.env', (t) => {
    const { envPath, store } = setup(t);
    store.set('GROQ_API_KEY', GROQ_KEY);
    const env = { GEMINI_API_KEY: GEMINI_KEY, AZURE_SPEECH_KEY: AZURE_KEY };
    const result = initializeSecrets({ store, envPath, migrate: true, keys: KEYS, env, logger: silentLogger });
    assert.equal(result.encrypted, true);
    assert.deepEqual(result.migrated.sort(), ['AZURE_SPEECH_KEY', 'GEMINI_API_KEY']);
    assert.deepEqual(result.applied, ['GROQ_API_KEY']);
    assert.equal(env.GROQ_API_KEY, GROQ_KEY);
    assert.ok(!fs.readFileSync(envPath, 'utf8').includes(GEMINI_KEY));
  });

  for (const [name, options] of [
    ['a weak Linux backend (basic_text)', { safeStorage: createFakeSafeStorage({ backend: 'basic_text' }) }],
    ['an unknown Linux backend', { safeStorage: createFakeSafeStorage({ backend: 'unknown' }) }],
    ['no encryption at all', { safeStorage: createFakeSafeStorage({ available: false }), platform: 'darwin' }],
  ]) {
    it(`with ${name}: keeps keys in .env and writes no key file`, (t) => {
      const { envPath, store, filePath } = setup(t, options);
      const result = initializeSecrets({ store, envPath, migrate: true, keys: KEYS, env: {}, logger: silentLogger });
      assert.deepEqual(result, { encrypted: false, migrated: [], kept: [], applied: [] });
      assert.equal(fs.readFileSync(envPath, 'utf8'), ENV_TEXT);
      assert.equal(fs.existsSync(filePath), false);
      assert.equal(store.status().message, MESSAGE_PLAIN);
    });
  }

  it('running from source: never rewrites a project .env, and its keys win', (t) => {
    const { envPath, store } = setup(t);
    store.setMany({ GEMINI_API_KEY: 'AIzaSTOREDkey00000000000', GROQ_API_KEY: GROQ_KEY });
    // What dotenv loaded from the project .env.
    const env = { GEMINI_API_KEY: GEMINI_KEY, ANTHROPIC_API_KEY: 'your_anthropic_api_key_here' };
    const result = initializeSecrets({ store, envPath, migrate: false, keys: KEYS, env, logger: silentLogger });
    assert.deepEqual(result.migrated, []);
    assert.equal(fs.readFileSync(envPath, 'utf8'), ENV_TEXT);
    assert.equal(env.GEMINI_API_KEY, GEMINI_KEY, 'the project .env key wins');
    assert.equal(env.GROQ_API_KEY, GROQ_KEY, 'the store fills keys the project .env lacks');
  });

  it('does not migrate into a store it could not read', (t) => {
    const { envPath, store, filePath } = setup(t);
    fs.writeFileSync(filePath, 'garbage');
    const result = initializeSecrets({ store, envPath, migrate: true, keys: KEYS, env: {}, logger: silentLogger });
    assert.deepEqual(result.migrated, []);
    assert.equal(fs.readFileSync(envPath, 'utf8'), ENV_TEXT);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'garbage');
  });
});

describe('applySecretsToEnv', () => {
  it('fills empty and template values only', (t) => {
    const { store } = makeStore(t);
    store.setMany({ GEMINI_API_KEY: GEMINI_KEY, AZURE_SPEECH_KEY: AZURE_KEY, GROQ_API_KEY: GROQ_KEY });
    const env = { GEMINI_API_KEY: 'your_gemini_api_key_here', AZURE_SPEECH_KEY: '', GROQ_API_KEY: 'gsk_SHELLkey' };
    assert.deepEqual(applySecretsToEnv({ store, keys: KEYS, env }).sort(), ['AZURE_SPEECH_KEY', 'GEMINI_API_KEY']);
    assert.equal(env.GEMINI_API_KEY, GEMINI_KEY);
    assert.equal(env.GROQ_API_KEY, 'gsk_SHELLkey');
  });

  it('isUsableSecret ignores empty and template values', () => {
    for (const v of ['', '  ', undefined, null, 'your_gemini_api_key_here', 'your-api-key-here']) assert.equal(isUsableSecret(v), false, String(v));
    assert.equal(isUsableSecret(GEMINI_KEY), true);
  });
});
