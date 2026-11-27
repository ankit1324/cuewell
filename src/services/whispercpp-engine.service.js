// Local speech-to-text with the bundled whisper.cpp `whisper-server`.
//
// One server process holds the model in memory between requests, so only
// the first request after a start pays the model load. It stops after
// `idleUnloadMs` without work (and on app quit) and starts again on the next
// request. Requests run one at a time.
//
// Transport: on macOS and Linux the server listens on a Unix socket in a
// private temp folder (owner-only), so web pages and other users cannot
// reach it. On Windows it listens on 127.0.0.1 with a free port. When a
// `fetchFn` is injected (tests), TCP on 127.0.0.1 is used everywhere. Every
// URL also starts with a random secret path (--request-path): the server
// allows any web origin (CORS *), so a page in the user's browser must not
// be able to guess /inference or /load.
//
// Privacy: the server prints transcripts on stdout, so stdout is discarded
// and stderr is kept only until the model has loaded (for start errors).
// Transcript text is never logged.

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { childProcessEnv } = require('../core/whisper-installer');

const START_TIMEOUT_MS = 120000;
const REQUEST_TIMEOUT_MS = 120000;
const HEALTH_POLL_MS = 100;
const STOP_GRACE_MS = 2000;
const MAX_START_ATTEMPTS = 3;
const STDERR_LINES_KEPT = 20;

// Server children still running; killed when the main process exits, even
// if the app never called unload().
const liveChildren = new Set();
let exitHookInstalled = false;
function trackChild(child) {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const c of liveChildren) {
        try { c.kill('SIGKILL'); } catch (_) { /* already gone */ }
      }
    });
  }
}

// Errors carry a `code` and a message written for the user (userFacing).
// Socket folders are named SOCKET_DIR_PREFIX + random and hold OWNER_FILE:
// { owner: <app pid>, server: <whisper-server pid> }.
const SOCKET_DIR_PREFIX = 'cuewell-wcpp-';
const OWNER_FILE = 'owner.json';
let staleSwept = false;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // alive, but not ours
  }
}

function isWhisperServerProcess(pid) {
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 });
    return result.status === 0 && path.basename(String(result.stdout || '').trim()) === 'whisper-server';
  } catch (_) {
    return false;
  }
}

/**
 * Once per app run (macOS and Linux): stop whisper-server processes whose
 * Cuewell is gone (it crashed or was killed before it could stop them) and
 * remove their socket folders.
 */
function sweepStaleServers(logger) {
  if (staleSwept || process.platform === 'win32') return;
  staleSwept = true;
  const tmp = os.tmpdir();
  let names;
  try {
    names = fs.readdirSync(tmp);
  } catch (_) {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SOCKET_DIR_PREFIX)) continue;
    const dir = path.join(tmp, name);
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
    } catch (_) {
      info = null;
    }
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      // No owner file yet: maybe a start in another Cuewell right now.
      if (!info && Date.now() - fs.statSync(dir).mtimeMs < 5 * 60 * 1000) continue;
    } catch (_) {
      continue;
    }
    if (info && isAlive(info.owner)) continue; // a running Cuewell owns it
    if (info && isAlive(info.server) && isWhisperServerProcess(info.server)) {
      try {
        process.kill(info.server, 'SIGKILL');
        logger.warn('Stopped a whisper.cpp server left over from an earlier run', { pid: info.server });
      } catch (_) { /* gone or not ours */ }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) { /* the OS cleans temp folders up */ }
  }
}

function engineError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.userFacing = true;
  if (cause) error.cause = cause;
  return error;
}

/** Threads for the encoder: about one per physical core, 1 to 8. */
function defaultThreads() {
  const cpus = (os.cpus() || []).length || 2;
  return Math.max(1, Math.min(8, Math.floor(cpus / 2) || 1));
}

/** A free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * fetch() subset over node:http that can also use a Unix socket
 * (init.socketPath). Returns { ok, status, json(), text() }. FormData and
 * Buffer bodies are supported.
 */
async function localFetch(url, init = {}) {
  const target = new URL(url);
  let body = init.body;
  const headers = { ...(init.headers || {}) };
  if (body && typeof FormData !== 'undefined' && body instanceof FormData) {
    const encoded = new Response(body);
    headers['Content-Type'] = encoded.headers.get('content-type');
    body = Buffer.from(await encoded.arrayBuffer());
  }
  if (body) headers['Content-Length'] = String(body.length);

  return new Promise((resolve, reject) => {
    const req = http.request({
      method: init.method || 'GET',
      path: `${target.pathname}${target.search}`,
      headers: { Host: 'localhost', ...headers },
      ...(init.socketPath
        ? { socketPath: init.socketPath }
        : { hostname: target.hostname, port: Number(target.port) || 80 }),
      signal: init.signal,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => buffer.toString('utf8'),
          json: async () => JSON.parse(buffer.toString('utf8')),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Markers whisper.cpp writes for silence or noise ("[BLANK_AUDIO]",
// "[ Silence ]", "(music)"), which are not speech.
const NON_SPEECH_RE = /\[[^\]]{0,40}\]|\((?:[^)]{0,20})(?:music|silence|blank|noise|applause|laugh|inaudible)(?:[^)]{0,20})\)|[♪♫]+/gi;

function cleanTranscript(text) {
  return String(text || '')
    .replace(NON_SPEECH_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class WhisperCppEngine {
  /**
   * @param {object} options
   * @param {string} options.serverPath whisper-server program (from resolveWhisperServer)
   * @param {string} options.serverDir folder with the program and its libraries
   * @param {string} options.modelPath ggml model file
   * @param {number} [options.threads]
   * @param {number} [options.idleUnloadMs] stop the server after this long without work
   * @param {object} [options.logger] { debug, info, warn, error }
   * @param {() => boolean} [options.isBusy] when true at idle time, wait another period
   * @param {() => Promise<boolean>} [options.verifyModel] after a failed model load: false
   *   when the model file is damaged
   * @param {Function} [options.spawnFn] child_process.spawn-compatible, for tests
   * @param {Function} [options.fetchFn] fetch-compatible, for tests
   */
  constructor({
    serverPath, serverDir, modelPath, threads, idleUnloadMs = 60000,
    logger, isBusy, verifyModel, spawnFn, fetchFn, startTimeoutMs = START_TIMEOUT_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  } = {}) {
    this.serverPath = serverPath;
    this.serverDir = serverDir || (serverPath ? path.dirname(serverPath) : '');
    this.modelPath = modelPath;
    this.threads = Number.isInteger(threads) && threads > 0 ? threads : defaultThreads();
    this.idleUnloadMs = Math.max(1000, Number(idleUnloadMs) || 60000);
    this.logger = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.isBusy = typeof isBusy === 'function' ? isBusy : () => false;
    this.verifyModel = typeof verifyModel === 'function' ? verifyModel : async () => true;
    this.spawnFn = spawnFn || spawn;
    this.fetchFn = fetchFn || localFetch;
    this.useSocket = !fetchFn && process.platform !== 'win32';
    this.startTimeoutMs = startTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;

    this.child = null;
    this.endpoint = null; // { base, socketPath, socketDir }
    this.starting = null; // promise while a start runs
    this.generation = 0; // bumped by unload() so a start in flight gives up
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.lastStartMs = null;
    // Set by close(): the engine is retired and never starts a server again.
    this.closed = false;
  }

  isConfigured() {
    return Boolean(
      this.serverPath && this.modelPath &&
      fs.existsSync(this.serverPath) && fs.existsSync(this.modelPath)
    );
  }

  isRunning() {
    return Boolean(this.child && this.endpoint);
  }

  /** Start the server and load the model now, so the next request is fast. */
  async warmup() {
    if (this.closed) throw this._closedError();
    this._clearIdleTimer();
    try {
      await this._ensureServer();
      return { ready: true, startMs: this.lastStartMs };
    } finally {
      this._scheduleIdleUnload();
    }
  }

  /**
   * Transcribe a 16 kHz WAV file path or WAV buffer.
   * @param {string|Buffer} input
   * @param {{ language?: string, prompt?: string }} [options]
   * @returns {Promise<{ text: string }>}
   */
  transcribe(input, { language = 'auto', prompt = '' } = {}) {
    if (this.closed) return Promise.reject(this._closedError());
    const run = () => this._transcribeNow(input, { language, prompt });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async _transcribeNow(input, { language, prompt }) {
    if (this.closed) throw this._closedError();
    this._clearIdleTimer();
    const generation = this.generation;
    try {
      const audio = Buffer.isBuffer(input) ? input : await fs.promises.readFile(input);
      if (!audio.length) return { text: '' };
      try {
        return await this._inference(audio, { language, prompt });
      } catch (error) {
        // The server died between requests or during this one: start it
        // again once and retry.
        // Not after unload()/close() stopped it on purpose.
        if (error.code !== 'SERVER_GONE' || this.closed || this.generation !== generation) throw error;
        this.logger.warn('whisper.cpp server was not reachable; restarting it', {
          reason: error.cause ? error.cause.message : error.message,
        });
        await this._stopChild();
        return await this._inference(audio, { language, prompt });
      }
    } finally {
      this._scheduleIdleUnload();
    }
  }

  async _inference(audio, { language, prompt }) {
    await this._ensureServer();
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('no_timestamps', 'true');
    form.append('language', language || 'auto');
    if (prompt) form.append('prompt', prompt);

    const startedAt = Date.now();
    let response;
    try {
      response = await this._fetch('/inference', { method: 'POST', body: form, timeoutMs: this.requestTimeoutMs });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.code === 'ABORT_ERR' || error.name === 'AbortError') {
        // A request that hangs this long means the server is stuck: stop it.
        await this._stopChild();
        throw engineError('REQUEST_TIMEOUT', 'Local speech recognition took too long and was stopped. Try again.', error);
      }
      throw engineError('SERVER_GONE', 'The speech engine stopped unexpectedly. Try again.', error);
    }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 200); } catch (_) { /* none */ }
      this.logger.warn('whisper.cpp request failed', { status: response.status, detail });
      throw engineError('REQUEST_FAILED', `Local speech recognition failed (error ${response.status}).`);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw engineError('REQUEST_FAILED', 'Local speech recognition returned an unreadable answer.', error);
    }
    if (data && data.error) {
      throw engineError('REQUEST_FAILED', `Local speech recognition failed: ${String(data.error).slice(0, 200)}`);
    }
    const text = cleanTranscript(data && data.text);
    this.logger.info('whisper.cpp transcription completed', {
      processingTime: Date.now() - startedAt,
      audioBytes: audio.length,
      characters: text.length,
    });
    return { text };
  }

  _fetch(pathname, { method = 'GET', body, timeoutMs }) {
    const endpoint = this.endpoint;
    if (!endpoint) return Promise.reject(engineError('SERVER_GONE', 'The speech engine is not running.'));
    const init = { method, body, signal: AbortSignal.timeout(timeoutMs) };
    if (endpoint.socketPath) init.socketPath = endpoint.socketPath;
    return this.fetchFn(`${endpoint.base}${pathname}`, init);
  }

  /** Resolve once a server with the model loaded is running. */
  _ensureServer() {
    if (this.closed) return Promise.reject(this._closedError());
    if (this.child && this.endpoint && !this.starting) return Promise.resolve();
    if (!this.starting) {
      const generation = this.generation;
      this.starting = this._start(generation).finally(() => {
        if (this.generation === generation) this.starting = null;
      });
    }
    return this.starting;
  }

  async _start(generation) {
    if (!this.serverPath || !fs.existsSync(this.serverPath)) {
      throw engineError('NO_BINARY', 'The built-in speech engine is missing from this copy of Cuewell.');
    }
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      throw engineError('NO_MODEL', 'The voice model is not downloaded yet. Download it in Settings.');
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      try {
        await this._startOnce(generation);
        return;
      } catch (error) {
        lastError = error;
        // Only a busy port is worth another try.
        if (error.code !== 'BIND_FAILED' || this.generation !== generation) break;
      }
    }
    throw lastError;
  }

  async _startOnce(generation) {
    const startedAt = Date.now();
    sweepStaleServers(this.logger);
    const endpoint = await this._newEndpoint();
    if (this.generation !== generation) {
      this._removeEndpoint(endpoint);
      throw engineError('CANCELLED', 'The speech engine was stopped while it started.');
    }
    // The model is opened relative to cwd by its ASCII file name: on Windows
    // the server's argv uses the ANSI code page, so a full path under a
    // non-ASCII user folder would not open. Libraries are found next to the
    // program (Windows) or through LD_LIBRARY_PATH (Linux), not via cwd.
    const args = [
      '-m', path.basename(this.modelPath),
      '--host', endpoint.host,
      '--port', String(endpoint.port),
      '--request-path', endpoint.requestPath,
      '-t', String(this.threads),
      '-nt',
    ];
    const env = childProcessEnv();
    if (process.platform === 'linux' && this.serverDir) {
      env.LD_LIBRARY_PATH = [this.serverDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }

    let child;
    try {
      child = this.spawnFn(this.serverPath, args, {
        cwd: path.dirname(this.modelPath),
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this._removeEndpoint(endpoint);
      throw engineError('SPAWN_FAILED', this._spawnMessage(error), error);
    }
    trackChild(child);
    if (endpoint.socketDir && child.pid) {
      try {
        fs.writeFileSync(path.join(endpoint.socketDir, OWNER_FILE),
          JSON.stringify({ owner: process.pid, server: child.pid }), { mode: 0o600 });
      } catch (_) { /* only used to clean up after a crash */ }
    }

    // stderr until the model has loaded, for start errors only.
    const stderrLines = [];
    let ready = false;
    let partial = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (ready) return; // drained, never kept: it may describe requests
        partial += chunk.toString();
        const lines = partial.split(/\r?\n/);
        partial = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          stderrLines.push(line.slice(0, 300));
          if (stderrLines.length > STDERR_LINES_KEPT) stderrLines.shift();
        }
      });
    }

    let exited = null;
    const exitPromise = new Promise((resolve) => {
      child.once('error', (error) => {
        exited = { error };
        resolve();
      });
      child.once('exit', (code, signal) => {
        exited = exited || { code, signal };
        resolve();
      });
    });
    exitPromise.then(() => {
      liveChildren.delete(child);
      this._removeEndpoint(endpoint);
      if (this.child === child) {
        this.child = null;
        this.endpoint = null;
        if (ready) {
          this.logger.warn('whisper.cpp server stopped', {
            code: exited && exited.code, signal: exited && exited.signal,
          });
        }
      }
    });

    this.child = child;
    this.endpoint = endpoint;

    const deadline = Date.now() + this.startTimeoutMs;
    while (!exited) {
      if (this.generation !== generation) {
        await this._kill(child);
        throw engineError('CANCELLED', 'The speech engine was stopped while it started.');
      }
      if (Date.now() > deadline) {
        await this._stopChild();
        throw engineError('START_TIMEOUT', 'The speech engine took too long to start. Try again.');
      }
      let healthy = false;
      try {
        const res = await this._fetch('/health', { timeoutMs: 2000 });
        healthy = res.ok;
      } catch (_) {
        healthy = false; // not listening yet
      }
      if (healthy && !exited) {
        ready = true;
        stderrLines.length = 0;
        this.lastStartMs = Date.now() - startedAt;
        this.logger.info('whisper.cpp server ready', {
          startMs: this.lastStartMs,
          threads: this.threads,
          model: path.basename(this.modelPath),
          transport: endpoint.socketPath ? 'unix socket' : 'tcp',
        });
        return;
      }
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, HEALTH_POLL_MS))]);
    }

    // The process ended before it answered.
    if (this.generation !== generation) {
      throw engineError('CANCELLED', 'The speech engine was stopped while it started.');
    }
    const tail = stderrLines.slice(-8).join('\n');
    if (exited.error) {
      throw engineError('SPAWN_FAILED', this._spawnMessage(exited.error), exited.error);
    }
    this.logger.warn('whisper.cpp server exited during start', {
      code: exited.code, signal: exited.signal, stderr: tail,
    });
    if (/couldn't bind/i.test(tail)) {
      throw engineError('BIND_FAILED', 'The speech engine could not open its local connection.');
    }
    if (exited.code === 3 || /failed to (initialize|load)|invalid model|failed to open/i.test(tail)) {
      // A damaged file is removed by verifyModel so it can be downloaded again.
      let intact = true;
      try {
        intact = await this.verifyModel();
      } catch (_) {
        intact = true;
      }
      if (!intact) {
        throw engineError('MODEL_CORRUPT', 'The voice model file was damaged. Download it again in Settings.');
      }
      throw engineError('MODEL_LOAD_FAILED',
        'The voice model could not be loaded. Restart Cuewell and try again.');
    }
    throw engineError('SERVER_EXITED',
      `The speech engine stopped while starting (exit ${exited.code === null ? exited.signal : exited.code}).`);
  }

  _spawnMessage(error) {
    if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
      return 'The speech engine is not allowed to run. Reinstall Cuewell, or allow it in your security settings.';
    }
    if (error && error.code === 'ENOENT') {
      return 'The built-in speech engine is missing from this copy of Cuewell.';
    }
    if (error && error.code === 'EBADARCH') {
      return 'The built-in speech engine does not run on this computer.';
    }
    return `The speech engine could not start: ${error && error.message ? error.message : 'unknown error'}`;
  }

  async _newEndpoint() {
    const requestPath = `/${crypto.randomBytes(16).toString('hex')}`;
    if (this.useSocket) {
      const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), SOCKET_DIR_PREFIX));
      fs.chmodSync(socketDir, 0o700);
      const socketPath = path.join(socketDir, 'whisper.sock');
      // AF_UNIX ignores the port; whisper-server still wants one.
      return { host: socketPath, port: 8080, socketPath, socketDir, requestPath, base: `http://localhost${requestPath}` };
    }
    const port = await freePort();
    return { host: '127.0.0.1', port, requestPath, base: `http://127.0.0.1:${port}${requestPath}` };
  }

  _removeEndpoint(endpoint) {
    if (endpoint && endpoint.socketDir) {
      try {
        fs.rmSync(endpoint.socketDir, { recursive: true, force: true });
      } catch (_) { /* temp folder; the OS cleans it up */ }
    }
  }

  /** Stop the server process (the next request starts it again). */
  async unload() {
    this.generation += 1;
    this.starting = null;
    this._clearIdleTimer();
    await this._stopChild();
  }

  /**
   * Stop the server for good: later calls fail with CANCELLED and never
   * start a new process. For an engine the speech service replaces or shuts
   * down.
   */
  close() {
    this.closed = true;
    return this.unload();
  }

  _closedError() {
    return engineError('CANCELLED', 'Local voice settings changed. Try again.');
  }

  /** Schedule the idle stop now (after a recording ends). */
  releaseWhenIdle() {
    if (this.child) this._scheduleIdleUnload();
  }

  async _stopChild() {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    await this._kill(child);
  }

  /** Stop `child`: a polite kill, then SIGKILL after STOP_GRACE_MS. */
  async _kill(child) {
    if (!child) return;
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    if (child.signalCode) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
        finish();
      }, STOP_GRACE_MS);
      child.once('exit', finish);
      try {
        child.kill();
      } catch (_) {
        finish();
      }
    });
  }

  _scheduleIdleUnload() {
    this._clearIdleTimer();
    if (!this.child && !this.starting) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isBusy()) {
        this._scheduleIdleUnload();
        return;
      }
      this.unload()
        .then(() => this.logger.info('whisper.cpp server stopped after idle timeout'))
        .catch((error) => this.logger.warn('Could not stop the idle whisper.cpp server', { error: error.message }));
    }, this.idleUnloadMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

module.exports = WhisperCppEngine;
module.exports.WhisperCppEngine = WhisperCppEngine;
module.exports.cleanTranscript = cleanTranscript;
module.exports.defaultThreads = defaultThreads;
