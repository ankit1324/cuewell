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
// Readiness: /health answering is not enough, because on Windows another
// local process could take the port between freePort() and the server's
// bind and answer /health itself (and then receive the audio). whisper-server
// b5907 prints "whisper server listening at http://<host>:<port>" when it has
// bound, but on stdout with printf, which is fully buffered into a pipe: the
// line only arrives when the process exits, so it cannot be waited for. A
// start therefore counts only when our child is still running, its stderr has
// no "couldn't bind" line, and the listener is shown to be the child's own,
// before any request (the URL holds the secret path) and again after /health
// answers: on TCP every process listening on the port must be the child
// (netstat -ano on Windows), for a Unix socket the socket file must exist in
// our owner-only folder. A child that exits during the start is a failed
// start even if /health answered; a bind failure or a foreign listener is
// retried once on a new port.
//
// Crash cleanup: each start records { owner app pid, server pid } in an
// owner-only temp folder, removed when the server stops. The first start of
// the next run stops servers whose Cuewell is gone. On macOS and Linux the
// record sits in the socket folder and the process name is checked. On
// Windows (TCP, no socket folder) the record folder also holds the server's
// full program path and creation time, and a server is stopped only when its
// pid, path and creation time all still match, so a later process that got
// the same pid is never touched.
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
const { spawn, spawnSync, execFile } = require('child_process');
const { childProcessEnv } = require('../core/whisper-installer');

const START_TIMEOUT_MS = 120000;
const REQUEST_TIMEOUT_MS = 120000;
const HEALTH_POLL_MS = 100;
const STOP_GRACE_MS = 2000;
// One start, plus one retry on a new port after a bind failure.
const MAX_START_ATTEMPTS = 2;
const STDERR_LINES_KEPT = 20;
const LISTENER_CHECK_TIMEOUT_MS = 5000;
// Listener checks that may fail in a row (netstat timed out) before a start fails.
const LISTENER_CHECK_ATTEMPTS = 2;
// whisper-server's stderr line when the port or socket is taken.
const BIND_FAILED_RE = /couldn't bind/i;

// Server children still running; killed when the main process exits, even
// if the app never called unload().
const liveChildren = new Set();
// Child -> its Windows record folder, removed once the exit hook stopped it.
const childRecordDirs = new Map();
let exitHookInstalled = false;
function trackChild(child) {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const c of liveChildren) {
        let killed = false;
        try { killed = c.kill('SIGKILL'); } catch (_) { /* already gone */ }
        const recordDir = childRecordDirs.get(c);
        if (killed && recordDir) {
          try { fs.rmSync(recordDir, { recursive: true, force: true }); } catch (_) { /* swept next run */ }
        }
      }
    });
  }
}

// Errors carry a `code` and a message written for the user (userFacing).
// Socket folders are named SOCKET_DIR_PREFIX + random and hold OWNER_FILE:
// { owner: <app pid>, server: <whisper-server pid> }. On Windows a record
// folder with the same name pattern holds { owner, server, path, created }:
// the server's full program path and its creation time (see
// inspectWindowsProcess), or null while not known.
const SOCKET_DIR_PREFIX = 'cuewell-wcpp-';
const OWNER_FILE = 'owner.json';
let staleSwept = false;
// The Windows sweep of this app run, once started.
let windowsSweep = null;
const WINDOWS_SERVER_EXE = 'whisper-server.exe';
// PowerShell can take a few seconds to start on a slow or busy PC.
const WINDOWS_INSPECT_TIMEOUT_MS = 10000;
const WINDOWS_KILL_TIMEOUT_MS = 10000;
// Leftover servers checked per sweep, so a pile of records cannot keep
// PowerShell busy for long.
const MAX_WINDOWS_SWEEP_CHECKS = 5;
// A folder with no readable record yet may belong to a start in progress.
const RECORD_GRACE_MS = 5 * 60 * 1000;

function isPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

function isAlive(pid) {
  if (!isPid(pid)) return false;
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

/** A program in Windows' System32 folder, by absolute path (never from PATH). */
function system32(file) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', file);
}

/**
 * Parse inspectWindowsProcess's PowerShell output: "gone", or
 * "found|<base64 UTF-8 path>|<ISO creation time>". Throws on anything else.
 */
function parseWindowsProcessInfo(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const text = line.trim();
    if (text === 'gone') return null;
    const match = /^found\|([A-Za-z0-9+/=]*)\|(\S*)$/.exec(text);
    if (match) {
      return { path: Buffer.from(match[1], 'base64').toString('utf8'), created: match[2] };
    }
  }
  throw new Error('Unexpected output from the process check');
}

/**
 * Windows: the full program path and creation time of process `pid`, or
 * null when no such process runs. Uses the system's own PowerShell and
 * Get-CimInstance; throws when the check cannot run. The path is sent as
 * base64 so a non-ASCII folder name survives the console code page.
 */
async function inspectWindowsProcess(pid) {
  if (!isPid(pid)) throw new Error('Not a process id');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'`,
    "if (-not $p) { 'gone'; exit 0 }",
    '$exe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.ExecutablePath))',
    "$created = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }",
    "'found|' + $exe + '|' + $created",
  ].join('\n');
  const powershell = system32(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const { code, stdout } = await runTool(powershell, [
    '-NoProfile', '-NonInteractive', '-NoLogo',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], WINDOWS_INSPECT_TIMEOUT_MS);
  if (code !== 0) throw new Error(`PowerShell exited with code ${code}`);
  return parseWindowsProcessInfo(stdout);
}

/**
 * Windows: stop process `pid`, only if it still has program path
 * `expected.path` and creation time `expected.created`. One PowerShell run
 * opens a handle to the process first (Windows does not reuse a pid while a
 * handle is open), checks it, and kills through that handle, so a process
 * that got the pid after the check is never hit. Resolves true when it
 * stopped the process, false when it was gone or did not match; throws when
 * the check or kill could not run.
 */
async function killWindowsProcess(pid, expected) {
  if (!isPid(pid)) throw new Error('Not a process id');
  if (!expected || typeof expected.path !== 'string' || !expected.path ||
      typeof expected.created !== 'string' || !expected.created) {
    throw new Error('No process to compare with');
  }
  // Values from the record go in as base64, never as script text.
  const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$wantPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(expected.path)}'))`,
    `$wantCreated = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(expected.created)}'))`,
    `$h = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if (-not $h) { 'gone'; exit 0 }",
    '$null = $h.Handle',
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'`,
    "if (-not $p -or $h.HasExited) { 'gone'; exit 0 }",
    "$created = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }",
    '$exe = [string]$p.ExecutablePath',
    "if (-not $exe -or -not [string]::Equals([IO.Path]::GetFullPath($exe), [IO.Path]::GetFullPath($wantPath), [StringComparison]::OrdinalIgnoreCase) -or $created -cne $wantCreated) { 'mismatch'; exit 0 }",
    '$h.Kill()',
    '$null = $h.WaitForExit(3000)',
    "'killed'",
  ].join('\n');
  const powershell = system32(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const { code, stdout } = await runTool(powershell, [
    '-NoProfile', '-NonInteractive', '-NoLogo',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], WINDOWS_KILL_TIMEOUT_MS);
  if (code !== 0) throw new Error(`PowerShell exited with code ${code}`);
  const result = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (result === 'killed') return true;
  if (result === 'gone' || result === 'mismatch') return false;
  throw new Error('Unexpected output from the process stop');
}

/** Same Windows path, ignoring case and separators. */
function sameWindowsPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}

/** A Windows record a server can be checked against: our bundled program, with a creation time. */
function isCheckableRecord(record) {
  return isPid(record.server) &&
    typeof record.path === 'string' && path.win32.isAbsolute(record.path) &&
    path.win32.basename(record.path).toLowerCase() === WINDOWS_SERVER_EXE &&
    typeof record.created === 'string' && record.created.length > 0;
}

/** The record in `dir`, or null when it is missing or malformed. */
function readServerRecord(dir) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
  } catch (_) {
    return null;
  }
  if (!record || typeof record !== 'object' || !isPid(record.owner)) return null;
  return record;
}

/** Write `record` into `dir` in one step (a reader never sees half a file). */
function writeServerRecord(dir, record) {
  const file = path.join(dir, OWNER_FILE);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Windows: stop whisper-server.exe processes whose Cuewell is gone, from the
 * record folders in `tmpdir`. A server is stopped only when its pid, full
 * program path and creation time all match the record (checked by
 * `inspectProcessFn`, then again by `killProcessFn` on the process handle it
 * kills); never by name. A check that fails is logged and the server left alone. Each handled record
 * is removed. The inspection and kill functions are injectable for tests.
 */
async function sweepWindowsServers({
  logger, tmpdir = os.tmpdir(), isAliveFn = isAlive,
  inspectProcessFn = inspectWindowsProcess, killProcessFn = killWindowsProcess, now = Date.now,
} = {}) {
  const log = logger || { info() {}, warn() {} };
  let names;
  try {
    names = fs.readdirSync(tmpdir);
  } catch (_) {
    return;
  }
  let checks = 0;
  for (const name of names) {
    if (!name.startsWith(SOCKET_DIR_PREFIX)) continue;
    const dir = path.join(tmpdir, name);
    let stats;
    try {
      stats = fs.lstatSync(dir);
    } catch (_) {
      continue;
    }
    if (!stats.isDirectory()) continue;
    const record = readServerRecord(dir);
    if (!record) {
      if (now() - stats.mtimeMs >= RECORD_GRACE_MS) removeRecordDir(dir);
      continue;
    }
    if (isAliveFn(record.owner)) continue; // a running Cuewell owns it
    if (isCheckableRecord(record)) {
      if (checks >= MAX_WINDOWS_SWEEP_CHECKS) break;
      checks += 1;
      await stopRecordedServer(record, { log, inspectProcessFn, killProcessFn });
    }
    removeRecordDir(dir);
  }
}

async function stopRecordedServer(record, { log, inspectProcessFn, killProcessFn }) {
  const pid = record.server;
  let info;
  try {
    info = await inspectProcessFn(pid);
  } catch (error) {
    log.warn('Could not check a whisper.cpp server left over from an earlier run', {
      pid, error: error && error.message,
    });
    return;
  }
  if (!info) return; // already gone
  if (!sameWindowsPath(info.path, record.path) || info.created !== record.created) {
    // Another program, or a later process that got the same pid.
    log.info('Left a process alone: it is not the whisper.cpp server an earlier run started', { pid });
    return;
  }
  try {
    // Checked again inside the kill, bound to the process handle.
    if (await killProcessFn(pid, { path: record.path, created: record.created })) {
      log.warn('Stopped a whisper.cpp server left over from an earlier run', { pid });
    } else {
      log.info('A whisper.cpp server left over from an earlier run had already gone or changed', { pid });
    }
  } catch (error) {
    log.warn('Could not stop a whisper.cpp server left over from an earlier run', {
      pid, error: error && error.message,
    });
  }
}

function removeRecordDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* the OS cleans temp folders up */ }
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
 * PIDs of the processes with a TCP socket listening on `port`, on any local
 * address, from `netstat -ano` output. A listening row has a foreign address
 * of 0.0.0.0:0 or [::]:0; the state column is translated on non-English
 * Windows, so it is not read.
 */
function parseNetstatListeners(output, port) {
  const pids = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue;
    const local = /:(\d+)$/.exec(cols[1]);
    if (!local || Number(local[1]) !== port) continue;
    if (!/^(?:0\.0\.0\.0|\[::\]):0$/.test(cols[2])) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** PIDs from `lsof -F p` output ("p1234" lines). */
function parseLsofPids(output) {
  const pids = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^p(\d+)$/.exec(line.trim());
    if (match) pids.add(Number(match[1]));
  }
  return [...pids];
}

function runTool(file, args, timeout = LISTENER_CHECK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      // A numeric code is the tool's exit status; anything else (not found,
      // timed out) means it did not run.
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error ? error.code : 0, stdout: String(stdout || '') });
    });
  });
}

/**
 * PIDs listening on TCP `port` (any address). Uses the system's own netstat
 * (Windows) or lsof (macOS and Linux); never a program found on PATH. Throws
 * when the tool cannot run. The app uses TCP only on Windows: lsof, which may
 * not show other users' sockets without root, is for tests.
 */
async function tcpListenerPids(port) {
  if (process.platform === 'win32') {
    const netstat = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'netstat.exe');
    const { code, stdout } = await runTool(netstat, ['-ano']);
    if (code !== 0) throw new Error(`netstat exited with code ${code}`);
    return parseNetstatListeners(stdout, port);
  }
  const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((file) => fs.existsSync(file));
  if (!lsof) throw new Error('lsof was not found');
  const { code, stdout } = await runTool(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  // lsof exits 1 when nothing matches.
  if (code !== 0 && code !== 1) throw new Error(`lsof exited with code ${code}`);
  return parseLsofPids(stdout);
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
// "[ Silence ]", "[MUSIC]", "(upbeat music)", "(coughs)"), which are not
// speech. Only a bracket or parenthesis that holds nothing but words and a
// known non-speech word is removed, and not one glued to a name before it, so
// spoken code such as "arr[i]", "a[0]", "f(x)" or "(n log n)" is kept.
const NON_SPEECH_WORDS = [
  'blank_audio', 'blank audio', 'silence', 'silent', 'music', 'musical', 'noise', 'noises',
  'applause', 'laugh', 'laughs', 'laughing', 'laughter', 'inaudible', 'no speech',
  'sound', 'sounds', 'beep', 'beeping', 'typing', 'cough', 'coughs', 'coughing',
  'sigh', 'sighs', 'sighing', 'breath', 'breathing', 'breathes', 'clears throat',
  'static', 'pause', 'click', 'clicking', 'clicks', 'keyboard', 'rustling', 'wind',
];
const NON_SPEECH_RE = new RegExp(
  String.raw`(?<![\w\])])[\[(]\s*(?:[a-z_ -]{0,30}\s)?(?:` +
  NON_SPEECH_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|') +
  String.raw`)(?:\s[a-z_ -]{0,30})?\s*[\])]|[♪♫]+`,
  'gi',
);

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
   * @param {(port: number) => Promise<number[]>} [options.listenerPidsFn] PIDs
   *   listening on a TCP port, for tests (default: netstat or lsof)
   * @param {string} [options.platform] process.platform, for tests
   * @param {(pid: number) => Promise<{path: string, created: string}|null>} [options.inspectProcessFn]
   *   Windows: a process's program path and creation time, for tests
   * @param {(pid: number, expected: {path: string, created: string}) => Promise<boolean>} [options.killProcessFn]
   *   Windows: stop a leftover server if it still matches, for tests
   */
  constructor({
    serverPath, serverDir, modelPath, threads, idleUnloadMs = 60000,
    logger, isBusy, verifyModel, spawnFn, fetchFn, listenerPidsFn, startTimeoutMs = START_TIMEOUT_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS, platform = process.platform, inspectProcessFn, killProcessFn,
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
    this.listenerPidsFn = typeof listenerPidsFn === 'function' ? listenerPidsFn : tcpListenerPids;
    this.platform = platform;
    this.inspectProcessFn = typeof inspectProcessFn === 'function' ? inspectProcessFn : inspectWindowsProcess;
    this.killProcessFn = typeof killProcessFn === 'function' ? killProcessFn : killWindowsProcess;
    this.useSocket = !fetchFn && platform !== 'win32';
    this.startTimeoutMs = startTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;

    this.child = null;
    this.endpoint = null; // { base, socketPath, socketDir, recordDir }
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
        // Only a busy port (or another process on it) is worth another try.
        if (error.code !== 'BIND_FAILED' || this.generation !== generation) break;
        this.logger.warn('whisper.cpp server could not take its port; trying a new one', { attempt });
      }
    }
    throw lastError;
  }

  async _startOnce(generation) {
    const startedAt = Date.now();
    // Windows: PowerShell is slow to start, so the sweep runs beside the start.
    if (this.platform === 'win32') this._sweepWindows();
    else sweepStaleServers(this.logger);
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
    } else if (this.platform === 'win32' && child.pid) {
      endpoint.recordDir = this._recordWindowsServer(child);
      if (endpoint.recordDir) childRecordDirs.set(child, endpoint.recordDir);
    }

    // stderr until the model has loaded, for start errors only.
    const stderrLines = [];
    let ready = false;
    let bindFailed = false;
    let partial = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (ready) return; // drained, never kept: it may describe requests
        partial += chunk.toString();
        const lines = partial.split(/\r?\n/);
        partial = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          if (BIND_FAILED_RE.test(line)) bindFailed = true;
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
      childRecordDirs.delete(child);
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
    // Set once /health answered: if the child then exits, the start failed.
    let answered = false;
    let failedChecks = 0;
    while (!exited) {
      if (this.generation !== generation) {
        await this._kill(child);
        throw engineError('CANCELLED', 'The speech engine was stopped while it started.');
      }
      if (Date.now() > deadline) {
        await this._stopChild();
        throw engineError('START_TIMEOUT', 'The speech engine took too long to start. Try again.');
      }
      if (bindFailed) {
        // whisper-server exits right after this line; do not wait for it.
        await this._stopChild();
        throw engineError('BIND_FAILED', 'The speech engine could not open its local connection.');
      }
      // Nothing is sent, not even /health with the secret path, before the
      // listener is shown to be the child's; it is checked again after
      // /health answers.
      const owner = await this._listenerOwner(child, endpoint);
      if (this.generation !== generation || exited || bindFailed) continue;
      if (owner === 'foreign') {
        this.logger.warn('Another program is listening on the speech engine port', { port: endpoint.port });
        await this._stopChild();
        throw engineError('BIND_FAILED', 'The speech engine could not open its local connection.');
      }
      if (owner === 'unknown') {
        failedChecks += 1;
        if (failedChecks >= LISTENER_CHECK_ATTEMPTS) {
          await this._stopChild();
          throw engineError('LISTENER_UNVERIFIED',
            'The speech engine could not check its local connection. Try again.');
        }
      } else {
        failedChecks = 0;
      }
      if (owner === 'ours' && answered) {
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
      if (owner === 'ours') {
        let healthy = false;
        try {
          const res = await this._fetch('/health', { timeoutMs: 2000 });
          healthy = res.ok;
        } catch (_) {
          healthy = false; // not answering yet
        }
        if (healthy) {
          answered = true;
          continue; // check the listener again, then ready
        }
      }
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, HEALTH_POLL_MS))]);
    }

    // The process ended before it was ready.
    if (this.generation !== generation) {
      throw engineError('CANCELLED', 'The speech engine was stopped while it started.');
    }
    const tail = stderrLines.slice(-8).join('\n');
    if (exited.error) {
      throw engineError('SPAWN_FAILED', this._spawnMessage(exited.error), exited.error);
    }
    this.logger.warn('whisper.cpp server exited during start', {
      code: exited.code, signal: exited.signal, stderr: bindFailed ? 'could not bind' : tail,
    });
    if (bindFailed || BIND_FAILED_RE.test(tail)) {
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
    if (answered) {
      // /health answered, but not from a server that stayed up: treat the
      // port as taken and try a new one.
      throw engineError('BIND_FAILED', 'The speech engine could not open its local connection.');
    }
    throw engineError('SERVER_EXITED',
      `The speech engine stopped while starting (exit ${exited.code === null ? exited.signal : exited.code}).`);
  }

  /**
   * Whose listener answered /health: 'ours' when only `child` can be it,
   * 'pending' when that is not shown yet, 'foreign' when another process
   * listens on the port, 'unknown' when it cannot be checked.
   */
  async _listenerOwner(child, endpoint) {
    if (endpoint.socketPath) {
      // bind() creates the socket file, and only this user can create files
      // in the owner-only folder made for this start.
      try {
        return fs.lstatSync(endpoint.socketPath).isSocket() ? 'ours' : 'foreign';
      } catch (_) {
        return 'pending';
      }
    }
    let pids;
    try {
      pids = await this.listenerPidsFn(endpoint.port);
    } catch (error) {
      this.logger.warn('Could not check which program listens on the speech engine port', {
        error: error && error.message,
      });
      return 'unknown';
    }
    if (!Array.isArray(pids) || !pids.length) return 'pending';
    return pids.every((pid) => pid === child.pid) ? 'ours' : 'foreign';
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
    if (endpoint && endpoint.recordDir) removeRecordDir(endpoint.recordDir);
  }

  /**
   * Once per app run on Windows: stop servers an earlier, crashed run left
   * (see sweepWindowsServers). Never rejects; the promise is kept for tests.
   */
  _sweepWindows() {
    if (!windowsSweep) {
      windowsSweep = sweepWindowsServers({
        logger: this.logger,
        inspectProcessFn: this.inspectProcessFn,
        killProcessFn: this.killProcessFn,
      }).catch((error) => {
        this.logger.warn('Could not look for leftover whisper.cpp servers', { error: error && error.message });
      });
    }
    return windowsSweep;
  }

  /**
   * Windows: record the server just started, for the next run's sweep. The
   * record gets the program path and creation time once they are read (a
   * record without them is never acted on). Returns the record folder, or
   * null when it could not be made.
   */
  _recordWindowsServer(child) {
    const base = { owner: process.pid, server: child.pid };
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), SOCKET_DIR_PREFIX));
      writeServerRecord(dir, { ...base, path: null, created: null });
    } catch (_) {
      if (dir) removeRecordDir(dir);
      return null; // only used to clean up after a crash
    }
    Promise.resolve()
      .then(() => this.inspectProcessFn(child.pid))
      .then((info) => {
        const running = child.exitCode === null && !child.signalCode;
        if (!info || !running || !fs.existsSync(dir)) return;
        writeServerRecord(dir, { ...base, path: info.path, created: info.created });
      })
      .catch((error) => {
        this.logger.warn('Could not record the whisper.cpp server for cleanup after a crash', {
          error: error && error.message,
        });
      });
    return dir;
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
module.exports.parseNetstatListeners = parseNetstatListeners;
module.exports.parseLsofPids = parseLsofPids;
module.exports.tcpListenerPids = tcpListenerPids;
module.exports.sweepWindowsServers = sweepWindowsServers;
module.exports.parseWindowsProcessInfo = parseWindowsProcessInfo;
module.exports.inspectWindowsProcess = inspectWindowsProcess;
module.exports.killWindowsProcess = killWindowsProcess;
