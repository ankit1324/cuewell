'use strict';
// Encrypted storage for API keys (Electron safeStorage).
//
// Keys are kept as one encrypted JSON object, { ENV_KEY: value }, in
// userData/secrets.bin (owner-only, written atomically). main.js loads it
// once the app is ready and copies the keys into process.env, so the rest of
// the app reads keys from process.env as before. Non-secret settings stay in
// .env.
//
// The store is only used when the system offers real protection:
//   macOS    Keychain
//   Windows  DPAPI (Windows Data Protection, tied to the user account)
//   Linux    Secret Service (GNOME Keyring and others) or KWallet
// The macOS Keychain item and the Linux keyring entry are named after the
// app name when Electron starts (main.js sets "Terminal " in its constructor,
// before that point). Changing that early name makes saved keys unreadable;
// later renames (the app icon setting) do not matter.
// On Linux without one of those, Chromium falls back to "basic_text", which
// encrypts with a fixed, public key. That is no protection, so Cuewell does
// not pretend: keys stay in .env (mode 0600) and Settings says so.
//
// Precedence when a key is set in more than one place, highest first:
//   1. the shell environment that started Cuewell
//   2. the .env file in use (dotenv never overrides 1)
//   3. this store, for keys still empty or a template value after 1 and 2
// A key found in the userData .env is moved into the store at startup (see
// migrateEnvSecrets), so 2 only keeps a key there when moving it failed, when
// the system has no secure storage, or for a project .env when running from
// source (never rewritten by the migration).
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { isPlaceholderKey } = require('../services/providers');

const SECRETS_FILE = 'secrets.bin';
const FORMAT_VERSION = 1;
const KEY_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Linux backends that give no protection: no keyring was found, or the app
// is not ready yet.
const WEAK_LINUX_BACKENDS = ['basic_text', 'unknown'];
const BACKEND_LABELS = {
  keychain: 'macOS Keychain',
  dpapi: 'Windows Data Protection',
  gnome_libsecret: 'Secret Service (GNOME Keyring)',
  kwallet: 'KWallet',
  kwallet5: 'KWallet',
  kwallet6: 'KWallet',
};

const MESSAGE_ENCRYPTED = 'Keys are encrypted with your system keychain';
const MESSAGE_PLAIN = 'Your system has no secure key storage, so keys are saved in a file only your user can read';

/** A real key: not empty and not a template value such as your_gemini_api_key_here. */
function isUsableSecret(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 0 && !isPlaceholderKey(v);
}

/** Write `data` to `file` through a temp file and a rename, owner-only. */
function writeFileAtomic(file, data, fsImpl = fs) {
  const tmp = `${file}.tmp`;
  // `mode` only applies when the file is created, so a temp file left by an
  // interrupted write (which keeps its old mode) is removed first.
  try { fsImpl.unlinkSync(tmp); } catch (_) { /* normally absent */ }
  try {
    fsImpl.writeFileSync(tmp, data, { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    try { fsImpl.unlinkSync(tmp); } catch (_) { /* already gone */ }
    throw err;
  }
  if (process.platform !== 'win32') {
    try { fsImpl.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
  }
}

const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=/;

/** `text` (a .env file) without the lines that set any of `keys`. Comments and every other line stay. */
function removeEnvKeys(text, keys) {
  const drop = new Set(keys);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.split(/\r?\n/).filter((line) => {
    const m = line.match(ENV_LINE_RE);
    return !(m && drop.has(m[1]));
  }).join(eol);
}

/**
 * The value `key` has in .env `text` when the file is read line by line, or
 * null when the file sets it in a way a single line cannot hold (a quoted
 * value spanning lines). Only such keys are safe to remove by line.
 */
function singleLineValue(text, key, parsed) {
  const lines = text.split(/\r?\n/).filter((line) => {
    const m = line.match(ENV_LINE_RE);
    return m && m[1] === key;
  });
  if (!lines.length) return null;
  const value = dotenv.parse(lines[lines.length - 1])[key];
  return value === parsed[key] && !/[\r\n]/.test(value) ? value : null;
}

class SecretStore {
  /**
   * @param {object} options
   * @param {string} options.filePath    the encrypted file (userData/secrets.bin)
   * @param {object} options.safeStorage Electron's safeStorage, or a stand-in in tests
   * @param {string} [options.platform]  process.platform
   * @param {object} [options.logger]
   * @param {object} [options.fs]        fs, replaceable in tests
   */
  constructor(options = {}) {
    if (!options.filePath) throw new Error('SecretStore needs a filePath');
    this.filePath = options.filePath;
    this.safeStorage = options.safeStorage || null;
    this.platform = options.platform || process.platform;
    this.logger = options.logger || console;
    this.fs = options.fs || fs;
    this.secrets = {};
    this.loaded = false;
    // Set when secrets.bin exists but could not be read (wrong keychain,
    // locked keyring, damaged file). The file is never replaced, see setMany().
    this.readError = null;
  }

  /** The storage backend: 'keychain', 'dpapi', a Linux backend name, or 'unknown'. */
  backend() {
    if (this.platform === 'darwin') return 'keychain';
    if (this.platform === 'win32') return 'dpapi';
    if (this.platform === 'linux') {
      try {
        const name = this.safeStorage && this.safeStorage.getSelectedStorageBackend();
        return typeof name === 'string' && name ? name : 'unknown';
      } catch (_) {
        return 'unknown';
      }
    }
    return 'unknown';
  }

  /** Whether keys can be encrypted with real protection now (see the file comment). */
  isAvailable() {
    let available = false;
    try {
      available = !!this.safeStorage && this.safeStorage.isEncryptionAvailable() === true;
    } catch (_) {
      available = false;
    }
    if (!available) return false;
    return !(this.platform === 'linux' && WEAK_LINUX_BACKENDS.includes(this.backend()));
  }

  /**
   * What Settings shows: booleans and labels only, never a key.
   * encrypted        keys are saved in this store
   * backend, label   which system storage protects them ('' label when none)
   * unreadable       secrets.bin exists but could not be read
   */
  status() {
    const encrypted = this.isAvailable();
    const backend = this.backend();
    return {
      encrypted,
      backend: encrypted ? backend : (this.platform === 'linux' ? backend : 'none'),
      label: encrypted ? (BACKEND_LABELS[backend] || backend) : '',
      message: encrypted ? MESSAGE_ENCRYPTED : MESSAGE_PLAIN,
      // Also when keys were saved with secure storage that is missing now.
      unreadable: !!this.readError || (!encrypted && this._fileExists()),
    };
  }

  _fileExists() {
    try {
      return this.fs.existsSync(this.filePath);
    } catch (_) {
      return false;
    }
  }

  /** Read secrets.bin into memory. A missing file is an empty store. */
  load() {
    this.secrets = {};
    this.readError = null;
    this.loaded = true;
    if (!this.fs.existsSync(this.filePath)) return { ok: true, count: 0 };
    try {
      this.secrets = this.readFromDisk();
      return { ok: true, count: Object.keys(this.secrets).length };
    } catch (err) {
      this.readError = err.message;
      this.logger.warn && this.logger.warn('Saved API keys could not be read; the file is kept', { error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /** Decrypt secrets.bin as it is on disk now. Throws when it cannot. */
  readFromDisk() {
    if (!this.safeStorage) throw new Error('No secure storage');
    const data = this.fs.readFileSync(this.filePath);
    const json = this.safeStorage.decryptString(data);
    const parsed = JSON.parse(json);
    if (!parsed || parsed.version !== FORMAT_VERSION || !parsed.secrets || typeof parsed.secrets !== 'object') {
      throw new Error('Unknown key file format');
    }
    // Key names are checked (A-Z, 0-9, _), so __proto__ and the like never get in.
    const out = {};
    for (const [key, value] of Object.entries(parsed.secrets)) {
      if (KEY_NAME_RE.test(key) && typeof value === 'string' && value) out[key] = value;
    }
    return out;
  }

  get(key) {
    return Object.prototype.hasOwnProperty.call(this.secrets, key) ? this.secrets[key] : undefined;
  }

  /** A copy of every saved key, for applying to process.env in the main process only. */
  all() {
    return { ...this.secrets };
  }

  set(key, value) {
    this.setMany({ [key]: value });
  }

  delete(key) {
    this.setMany({ [key]: '' });
  }

  /**
   * Save several keys in one write. An empty value deletes the key. The
   * memory copy changes only when the file was written.
   */
  setMany(updates) {
    if (!updates || typeof updates !== 'object') throw new Error('Nothing to save');
    if (!this.isAvailable()) throw new Error('Secure key storage is not available');
    // Keys that cannot be read now (a locked keyring, a denied Keychain
    // prompt) may become readable again. Writing would replace them, so the
    // file is left alone and the caller keeps the new key elsewhere (.env).
    if (!this.loaded || this.readError) this.load();
    if (this.readError) throw new Error('Saved keys cannot be read now, so the key file is left unchanged');
    const next = { ...this.secrets };
    for (const [key, value] of Object.entries(updates)) {
      if (!KEY_NAME_RE.test(key)) throw new Error(`Not a key name: ${key}`);
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new Error(`Key ${key} must be text`);
      }
      if (value) next[key] = value;
      else delete next[key];
    }
    this._write(next);
  }

  _write(secrets) {
    if (!this.isAvailable()) throw new Error('Secure key storage is not available');
    const encrypted = this.safeStorage.encryptString(JSON.stringify({ version: FORMAT_VERSION, secrets }));
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('Encryption returned no data');
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileAtomic(this.filePath, encrypted, this.fs);
    this.secrets = { ...secrets };
  }
}

/**
 * Move the keys in `envPath` into `store`. For each key in `keys` with a real
 * value in the file: save it to the store, read the store back from disk,
 * and only when the decrypted value matches remove that key's line from the
 * file (rewritten atomically, comments and every other line kept). Any
 * failure leaves the file as it was. Logs key names, never values.
 *
 * @returns {{ migrated: string[], kept: string[], error?: string }}
 */
function migrateEnvSecrets({ envPath, store, keys, logger = console, fs: fsImpl = fs }) {
  const result = { migrated: [], kept: [] };
  let text;
  try {
    text = fsImpl.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      result.error = err.message;
      logger.warn && logger.warn('Could not read .env to move API keys into secure storage', { error: err.message });
    }
    return result;
  }
  const parsed = dotenv.parse(text);
  const candidates = {};
  for (const key of keys) {
    if (!isUsableSecret(parsed[key])) continue;
    const value = singleLineValue(text, key, parsed);
    if (value === null) {
      result.kept.push(key);
      continue;
    }
    candidates[key] = value;
  }
  const names = Object.keys(candidates);
  if (!names.length) {
    if (result.kept.length) logger.warn && logger.warn('API keys left in .env: their lines could not be moved', { keys: result.kept });
    return result;
  }

  const fail = (message, error) => {
    result.kept.push(...names);
    result.error = error;
    logger.warn && logger.warn(message, { keys: names, error });
    return result;
  };

  try {
    store.setMany(candidates);
  } catch (err) {
    return fail('API keys left in .env: secure storage could not save them', err.message);
  }
  let onDisk;
  try {
    onDisk = store.readFromDisk();
  } catch (err) {
    return fail('API keys left in .env: secure storage could not read them back', err.message);
  }
  const verified = names.filter((key) => onDisk[key] === candidates[key]);
  const mismatched = names.filter((key) => !verified.includes(key));
  if (mismatched.length) {
    result.kept.push(...mismatched);
    logger.warn && logger.warn('API keys left in .env: secure storage returned a different value', { keys: mismatched });
  }
  if (!verified.length) return result;

  const nextText = removeEnvKeys(text, verified);
  // The rewrite must remove exactly the moved keys and keep every other value.
  const nextParsed = dotenv.parse(nextText);
  const expected = { ...parsed };
  for (const key of verified) delete expected[key];
  if (JSON.stringify(nextParsed) !== JSON.stringify(expected)) {
    result.kept.push(...verified);
    result.error = 'rewrite check failed';
    logger.warn && logger.warn('API keys left in .env: removing their lines would change other settings', { keys: verified });
    return result;
  }
  try {
    // A change made since the file was read (another editor) wins.
    if (fsImpl.readFileSync(envPath, 'utf8') !== text) throw new Error('.env changed while moving keys');
    writeFileAtomic(envPath, nextText, fsImpl);
  } catch (err) {
    result.kept.push(...verified);
    result.error = err.message;
    logger.warn && logger.warn('API keys saved in secure storage but left in .env: .env could not be rewritten', {
      keys: verified, error: err.message,
    });
    return result;
  }
  result.migrated = verified;
  logger.info && logger.info('Moved API keys from .env into secure storage', { keys: verified });
  return result;
}

/**
 * Copy keys from the store into `env` where `env` has no real value (see the
 * precedence in the file comment). Returns the names applied.
 */
function applySecretsToEnv({ store, keys, env = process.env }) {
  const applied = [];
  for (const key of keys) {
    const value = store.get(key);
    if (isUsableSecret(value) && !isUsableSecret(env[key])) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/**
 * Startup: load the store, move the keys out of `envPath` when `migrate` is
 * true (the userData .env only, never a project .env), then fill `env`.
 * With no secure storage nothing happens: keys stay in .env.
 *
 * @returns {{ encrypted: boolean, migrated: string[], kept: string[], applied: string[] }}
 */
function initializeSecrets({ store, envPath, migrate, keys, env = process.env, logger = console, fs: fsImpl = fs }) {
  const result = { encrypted: store.isAvailable(), migrated: [], kept: [], applied: [] };
  if (!result.encrypted) return result;
  store.load();
  if (migrate && envPath && !store.readError) {
    const moved = migrateEnvSecrets({ envPath, store, keys, logger, fs: fsImpl });
    result.migrated = moved.migrated;
    result.kept = moved.kept;
  }
  result.applied = applySecretsToEnv({ store, keys, env });
  return result;
}

module.exports = {
  SecretStore,
  SECRETS_FILE,
  MESSAGE_ENCRYPTED,
  MESSAGE_PLAIN,
  isUsableSecret,
  removeEnvKeys,
  singleLineValue,
  migrateEnvSecrets,
  applySecretsToEnv,
  initializeSecrets,
  writeFileAtomic,
};
