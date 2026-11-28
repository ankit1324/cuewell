'use strict';
// src/services/whispercpp-engine.service.js against a fake whisper-server
// (test/helpers/fake-whisper-server.js) run as a real child process through
// the engine's spawnFn seam. fetchFn is injected, which also makes the
// engine use TCP on 127.0.0.1 (the app uses a Unix socket on macOS and
// Linux). No real binary, model or network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

// The engine sweeps os.tmpdir() for socket folders left by a crashed run.
// Point it at a private folder so the test never touches the real one.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cuewell-enginetest-'));
const TMP = path.join(ROOT, 'tmp');
fs.mkdirSync(TMP);
process.env.TMPDIR = TMP;
process.env.TMP = TMP;
process.env.TEMP = TMP;

const WhisperCppEngine = require('../src/services/whispercpp-engine.service');
const {
  cleanTranscript, parseNetstatListeners, parseLsofPids, tcpListenerPids,
} = require('../src/services/whispercpp-engine.service');

const FAKE_SERVER = path.join(__dirname, 'helpers', 'fake-whisper-server.js');
const TRANSCRIPT = 'SECRET-TRANSCRIPT-do-not-log';

// Every log call any engine in this file makes; checked at the end.
const logs = [];
const logger = {};
for (const level of ['debug', 'info', 'warn', 'error']) {
  logger[level] = (message, meta) => logs.push({ level, message: String(message), meta: meta || null });
}

const allChildren = [];
let caseNo = 0;

// Ports held by a "foreign" program in a test (this test process), as the
// listener lookup below reports them.
const foreignListeners = new Map();
const foreignServers = new Set();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/** A local HTTP server that answers 200 {"status":"ok"} to everything and records the requests. */
async function foreignResponder(port, { visible = true } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', text: 'from the foreign responder' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  if (visible) foreignListeners.set(port, process.pid);
  const responder = {
    requests,
    close: () => {
      foreignListeners.delete(port);
      foreignServers.delete(responder);
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections(); // fetch keeps connections alive
      return closed;
    },
  };
  foreignServers.add(responder);
  return responder;
}

/**
 * A fake install: a placeholder whisper-server file, a model file, a log
 * file the fake server writes to, and a spawnFn that runs the fake server
 * with node instead of the placeholder. `spawnEnv(n)` adds environment for
 * the n-th spawn (0-based); `onSpawn(args, n)` runs before it.
 *
 * The engine's listener lookup is answered from the fake servers' own
 * "listening" log lines and the foreign responders above, like netstat would.
 */
function setup(t, { modelContent = 'ggml', engineOptions = {}, env = {}, spawnEnv, onSpawn } = {}) {
  caseNo += 1;
  const dir = path.join(ROOT, `case-${caseNo}`);
  const binDir = path.join(dir, 'bin');
  const modelDir = path.join(dir, 'models');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });
  const serverPath = path.join(binDir, 'whisper-server');
  fs.writeFileSync(serverPath, 'placeholder');
  const modelPath = path.join(modelDir, 'ggml-test.bin');
  if (modelContent !== null) fs.writeFileSync(modelPath, modelContent);
  const logFile = path.join(dir, 'server.log');
  const marker = path.join(dir, 'crash.marker');

  const spawns = [];
  const spawnFn = (command, args, options) => {
    if (onSpawn) onSpawn(args, spawns.length);
    const child = spawn(process.execPath, [FAKE_SERVER, ...args], {
      ...options,
      env: {
        ...options.env,
        FAKE_WHISPER_LOG: logFile,
        FAKE_WHISPER_TEXT: TRANSCRIPT,
        FAKE_WHISPER_MARKER: marker,
        ...env,
        ...(spawnEnv ? spawnEnv(spawns.length) : {}),
      },
    });
    spawns.push({ command, args, options, child });
    allChildren.push(child);
    return child;
  };
  const urls = [];
  const fetchFn = (url, init) => {
    urls.push(String(url));
    return fetch(url, init);
  };
  const events = () => {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const listenerPidsFn = async (port) => {
    const pids = events()
      .filter((e) => e.event === 'listening' && e.port === port && isAlive(e.pid))
      .map((e) => e.pid);
    if (foreignListeners.has(port)) pids.push(foreignListeners.get(port));
    return pids;
  };

  const engine = new WhisperCppEngine({
    serverPath,
    serverDir: binDir,
    modelPath,
    threads: 2,
    idleUnloadMs: 60000,
    logger,
    spawnFn,
    fetchFn,
    listenerPidsFn,
    ...engineOptions,
  });
  t.after(() => engine.close());

  return { engine, spawns, urls, events, listenerPidsFn, serverPath, modelPath, marker, dir };
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitFor(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

after(async () => {
  for (const responder of [...foreignServers]) await responder.close();
  for (const child of allChildren) {
    if (!exited(child)) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  // Retries: on Windows a virus scanner can still hold a file for a moment.
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('WhisperCppEngine server lifecycle', { concurrency: true }, () => {
  it('warmup starts one server, bound to 127.0.0.1, and keeps it for later requests', async (t) => {
    const { engine, spawns, urls, serverPath, modelPath } = setup(t);
    const [a, b] = await Promise.all([engine.warmup(), engine.warmup()]);
    assert.equal(a.ready, true);
    assert.equal(b.ready, true);
    assert.equal(typeof a.startMs, 'number');
    assert.equal(spawns.length, 1, 'two warmups at once start one server');
    assert.equal(engine.isRunning(), true);

    const { command, args, options } = spawns[0];
    assert.equal(command, serverPath, 'runs the resolved whisper-server');
    const opt = (name) => args[args.indexOf(name) + 1];
    assert.equal(opt('--host'), '127.0.0.1');
    assert.match(opt('--port'), /^\d+$/);
    assert.equal(opt('-m'), path.basename(modelPath), 'model by file name');
    assert.equal(options.cwd, path.dirname(modelPath), 'from the model folder');
    assert.equal(opt('-t'), '2');
    assert.ok(args.includes('-nt'), 'no timestamps');
    assert.match(opt('--request-path'), /^\/[0-9a-f]{32}$/, 'random secret request path');
    assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe'], 'stdout (transcripts) is discarded');
    assert.equal(options.windowsHide, true);

    const base = `http://127.0.0.1:${opt('--port')}${opt('--request-path')}/`;
    assert.ok(urls.length > 0);
    for (const url of urls) assert.ok(url.startsWith(base), `${url} is on 127.0.0.1 behind the secret path`);

    const first = await engine.transcribe(Buffer.from('audio-1'));
    await engine.warmup();
    const second = await engine.transcribe(Buffer.from('audio-2'));
    assert.equal(first.text, TRANSCRIPT);
    assert.equal(second.text, TRANSCRIPT);
    assert.equal(spawns.length, 1, 'later calls reuse the running server');
  });

  it('transcribe starts the server on demand and sends the audio, language and prompt', async (t) => {
    const { engine, spawns, events, dir } = setup(t);
    const wav = path.join(dir, 'clip.wav');
    fs.writeFileSync(wav, 'RIFF-fake-wav-data');
    const prompt = 'Haan, main is approach ko explain karta hoon.';
    const result = await engine.transcribe(wav, { language: 'hi', prompt });
    assert.deepEqual(result, { text: TRANSCRIPT }, 'whitespace around the text is trimmed');
    assert.equal(spawns.length, 1);

    const [request] = events().filter((e) => e.event === 'inference');
    assert.equal(request.audio, 'RIFF-fake-wav-data', 'the file content is uploaded');
    assert.equal(request.fileName, 'audio.wav');
    assert.equal(request.language, 'hi');
    assert.equal(request.prompt, prompt);
    assert.equal(request.response_format, 'json');
    assert.equal(Number(request.temperature), 0);
    assert.equal(request.no_timestamps, 'true');

    await engine.transcribe(Buffer.from('x'));
    const second = events().filter((e) => e.event === 'inference')[1];
    assert.equal(second.language, 'auto', 'language defaults to auto');
    assert.equal(second.prompt, null, 'no prompt field without a prompt');
  });

  it('runs concurrent requests one at a time, in order', async (t) => {
    const { engine, spawns, events } = setup(t);
    const results = await Promise.all([
      engine.transcribe(Buffer.from('delay:120')),
      engine.transcribe(Buffer.from('delay:10')),
      engine.transcribe(Buffer.from('delay:60')),
    ]);
    assert.deepEqual(results.map((r) => r.text), [TRANSCRIPT, TRANSCRIPT, TRANSCRIPT]);
    assert.equal(spawns.length, 1);
    const requests = events().filter((e) => e.event === 'inference');
    assert.deepEqual(requests.map((r) => r.audio), ['delay:120', 'delay:10', 'delay:60'], 'in call order');
    assert.ok(requests.every((r) => r.inflight === 0), 'no request overlapped another');
  });

  it('a failed request does not block the next one', async (t) => {
    const { engine } = setup(t);
    await assert.rejects(engine.transcribe(Buffer.from('ERROR')), (error) => {
      assert.equal(error.code, 'REQUEST_FAILED');
      assert.equal(error.userFacing, true);
      assert.match(error.message, /500/);
      return true;
    });
    assert.equal((await engine.transcribe(Buffer.from('ok'))).text, TRANSCRIPT);
  });

  it('empty audio returns no text without starting a server', async (t) => {
    const { engine, spawns } = setup(t);
    assert.deepEqual(await engine.transcribe(Buffer.alloc(0)), { text: '' });
    assert.equal(spawns.length, 0);
  });

  it('stops after the idle time and starts again on the next request', async (t) => {
    const { engine, spawns } = setup(t, { engineOptions: { idleUnloadMs: 1000 } });
    await engine.transcribe(Buffer.from('a'));
    const first = spawns[0].child;
    assert.equal(engine.isRunning(), true);
    await waitFor(() => exited(first), 3000);
    await waitFor(() => !engine.isRunning());
    assert.equal(logs.some((l) => /stopped after idle timeout/.test(l.message)), true);

    assert.equal((await engine.transcribe(Buffer.from('b'))).text, TRANSCRIPT);
    assert.equal(spawns.length, 2, 'a new server for the next request');
    assert.notEqual(spawns[1].child.pid, first.pid);
  });

  it('restarts a server that crashed between requests', async (t) => {
    const { engine, spawns } = setup(t);
    await engine.warmup();
    const first = spawns[0].child;
    first.kill('SIGKILL');
    await once(first, 'exit');
    await waitFor(() => !engine.isRunning());

    assert.equal((await engine.transcribe(Buffer.from('a'))).text, TRANSCRIPT);
    assert.equal(spawns.length, 2);
    assert.equal(exited(spawns[1].child), false);
  });

  it('restarts once and retries when the server dies during a request', async (t) => {
    const { engine, spawns, marker } = setup(t);
    const result = await engine.transcribe(Buffer.from('CRASH_ONCE'));
    assert.equal(fs.existsSync(marker), true, 'the first server crashed');
    assert.equal(result.text, TRANSCRIPT, 'the retry on a new server answered');
    assert.equal(spawns.length, 2);
    assert.equal(exited(spawns[0].child), true);
  });

  it('unload stops the child, and the next request starts a new one', async (t) => {
    const { engine, spawns } = setup(t);
    await engine.warmup();
    const first = spawns[0].child;
    await engine.unload();
    assert.equal(exited(first), true, 'unload waits for the process to end');
    assert.equal(engine.isRunning(), false);
    await engine.transcribe(Buffer.from('a'));
    assert.equal(spawns.length, 2);
  });

  it('close stops the child for good and later calls fail without a new process', async (t) => {
    const { engine, spawns } = setup(t);
    await engine.warmup();
    await engine.close();
    assert.equal(exited(spawns[0].child), true);
    await assert.rejects(engine.transcribe(Buffer.from('a')), { code: 'CANCELLED' });
    await assert.rejects(engine.warmup(), { code: 'CANCELLED' });
    assert.equal(spawns.length, 1);
  });

  it('unload during a start cancels it and leaves no process', async (t) => {
    const { engine, spawns } = setup(t, { env: { FAKE_WHISPER_LOAD_MS: '2000' } });
    const warm = engine.warmup();
    await waitFor(() => spawns.length === 1);
    await engine.unload();
    await assert.rejects(warm, { code: 'CANCELLED' });
    await waitFor(() => exited(spawns[0].child));
  });
});

describe('WhisperCppEngine start errors', { concurrency: true }, () => {
  it('reports a missing program without spawning', async (t) => {
    const { engine, spawns, serverPath } = setup(t);
    fs.rmSync(serverPath);
    assert.equal(engine.isConfigured(), false);
    await assert.rejects(engine.warmup(), (error) => {
      assert.equal(error.code, 'NO_BINARY');
      assert.equal(error.userFacing, true);
      return true;
    });
    assert.equal(spawns.length, 0);
  });

  it('reports a missing model with a "download" message, without spawning', async (t) => {
    const { engine, spawns } = setup(t, { modelContent: null });
    await assert.rejects(engine.transcribe(Buffer.from('a')), (error) => {
      assert.equal(error.code, 'NO_MODEL');
      assert.match(error.message, /Download/);
      return true;
    });
    assert.equal(spawns.length, 0);
  });

  it('a model that fails to load gives MODEL_LOAD_FAILED, or MODEL_CORRUPT when its checksum fails', async (t) => {
    const intact = setup(t, { modelContent: 'BAD model' });
    await assert.rejects(intact.engine.warmup(), { code: 'MODEL_LOAD_FAILED' });
    assert.equal(intact.spawns.length, 1, 'no retry loop for a bad model');

    let verified = 0;
    const damaged = setup(t, {
      modelContent: 'BAD model',
      engineOptions: { verifyModel: async () => { verified += 1; return false; } },
    });
    await assert.rejects(damaged.engine.warmup(), (error) => {
      assert.equal(error.code, 'MODEL_CORRUPT');
      assert.match(error.message, /Download it again/);
      return true;
    });
    assert.equal(verified, 1);
    assert.equal(damaged.engine.isRunning(), false);
  });

  it('a program that cannot be spawned gives a user-facing error', async (t) => {
    const { engine } = setup(t, {
      engineOptions: {
        spawnFn: () => {
          const error = new Error('spawn EACCES');
          error.code = 'EACCES';
          throw error;
        },
      },
    });
    await assert.rejects(engine.warmup(), (error) => {
      assert.equal(error.code, 'SPAWN_FAILED');
      assert.match(error.message, /not allowed to run/);
      return true;
    });
  });
});

describe('WhisperCppEngine proves the listener is its own child', { concurrency: true }, () => {
  const portOf = (spawn) => Number(spawn.args[spawn.args.indexOf('--port') + 1]);

  it('a foreign responder on the port and a child that exits on bind failure: retries on a new port, no audio to the foreign one', async (t) => {
    let foreign = null;
    let ready = null;
    const { engine, spawns, events } = setup(t, {
      // The child binds late, so the foreign responder holds the port first.
      // The lookup does not show it (visible: false): only the child's bind
      // failure and exit stop this start.
      env: { FAKE_WHISPER_BIND_DELAY_MS: '300' },
      onSpawn: (args, n) => {
        if (n === 0) ready = foreignResponder(Number(args[args.indexOf('--port') + 1]), { visible: false });
      },
    });
    t.after(async () => { if (foreign) await foreign.close(); });
    const warm = engine.warmup();
    await waitFor(() => ready);
    foreign = await ready;
    await warm;

    assert.equal(spawns.length, 2, 'one retry');
    assert.equal(exited(spawns[0].child), true, 'the first child exited on its bind failure');
    assert.notEqual(portOf(spawns[1]), portOf(spawns[0]), 'the retry uses a new port');
    assert.ok(events().some((e) => e.event === 'bind-failed' && e.port === portOf(spawns[0])));

    assert.equal((await engine.transcribe(Buffer.from('audio'))).text, TRANSCRIPT);
    assert.deepEqual(foreign.requests, [], 'nothing, not even /health with the secret path, went to the foreign responder');
    const requests = events().filter((e) => e.event === 'inference');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].pid, spawns[1].child.pid, 'the audio went to the retried child');
  });

  it('a foreign listener on the port while the child runs is never trusted', async (t) => {
    let foreign = null;
    let ready = null;
    const { engine, spawns, events } = setup(t, {
      // The first child stays up without a listener of its own.
      spawnEnv: (n) => (n === 0 ? { FAKE_WHISPER_NO_BIND: '1' } : {}),
      onSpawn: (args, n) => {
        if (n === 0) ready = foreignResponder(Number(args[args.indexOf('--port') + 1]));
      },
    });
    t.after(async () => { if (foreign) await foreign.close(); });
    const warm = engine.warmup();
    await waitFor(() => ready);
    foreign = await ready;
    await warm;

    assert.equal(spawns.length, 2, 'stopped and retried');
    await waitFor(() => exited(spawns[0].child));
    assert.ok(logs.some((l) => /Another program is listening/.test(l.message)));
    assert.equal((await engine.transcribe(Buffer.from('audio'))).text, TRANSCRIPT);
    assert.deepEqual(foreign.requests, [], 'no request at all to the foreign responder');
    assert.equal(events().filter((e) => e.event === 'inference')[0].pid, spawns[1].child.pid);
  });

  it('a second foreign hit on the retry port gives up with BIND_FAILED', async (t) => {
    const foreigns = [];
    const pending = [];
    const { engine, spawns } = setup(t, {
      env: { FAKE_WHISPER_BIND_DELAY_MS: '300' },
      onSpawn: (args) => pending.push(foreignResponder(Number(args[args.indexOf('--port') + 1]), { visible: false })),
    });
    t.after(async () => { for (const f of foreigns) await f.close(); });
    const warm = engine.warmup();
    await assert.rejects(warm, { code: 'BIND_FAILED', userFacing: true });
    foreigns.push(...(await Promise.all(pending)));
    assert.equal(spawns.length, 2, 'one retry only');
    assert.equal(engine.isRunning(), false);
    for (const f of foreigns) assert.deepEqual(f.requests, []);
  });

  it('a running, listening child gets no request and is not ready until it is shown to own the listener', async (t) => {
    let proven = false;
    let checks = 0;
    const ctx = setup(t, {
      engineOptions: {
        listenerPidsFn: async (port) => {
          checks += 1;
          return proven ? ctx.listenerPidsFn(port) : [];
        },
      },
    });
    const { engine, spawns, events, urls } = ctx;
    let done = false;
    const warm = engine.warmup().then((r) => { done = true; return r; });
    await waitFor(() => checks >= 3, 5000);
    assert.equal(done, false, 'not ready while the listener is unproven');
    assert.equal(exited(spawns[0].child), false);
    // Waited for, not assumed: a new node process can take longer than
    // three polls to start (Windows runners in particular).
    await waitFor(() => events().some((e) => e.event === 'listening'), 5000);
    assert.equal(done, false, 'still not ready once the child is listening');
    assert.deepEqual(urls, [], 'not even /health is sent before the proof');

    proven = true;
    const result = await warm;
    assert.equal(result.ready, true);
    assert.equal(spawns.length, 1, 'the same child, no restart');
    assert.equal((await engine.transcribe(Buffer.from('a'))).text, TRANSCRIPT);
  });

  it('a listener check that cannot run fails the start closed, without a retry', async (t) => {
    let checks = 0;
    const { engine, spawns, urls } = setup(t, {
      engineOptions: { listenerPidsFn: async () => { checks += 1; throw new Error('netstat was not found'); } },
    });
    await assert.rejects(engine.warmup(), { code: 'LISTENER_UNVERIFIED', userFacing: true });
    assert.equal(checks, 2, 'one more try after a failed check');
    assert.deepEqual(urls, []);
    assert.equal(spawns.length, 1);
    await waitFor(() => exited(spawns[0].child));
    assert.equal(engine.isRunning(), false);
  });

  it('parses netstat -ano listeners for one port, in any language', () => {
    const output = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1060',
      '  TCP    127.0.0.1:51234        0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:51234        127.0.0.1:51300        ESTABLISHED     4242',
      '  TCP    127.0.0.1:51300        127.0.0.1:51234        ESTABLISHED     9000',
      '  TCP    0.0.0.0:51234          0.0.0.0:0              ABHÖREN         7777',
      '  TCP    [::]:51234             [::]:0                 LISTENING       8888',
      '  TCP    127.0.0.1:512345       0.0.0.0:0              LISTENING       1',
      '  UDP    127.0.0.1:51234        *:*                                    5555',
    ].join('\r\n');
    assert.deepEqual(parseNetstatListeners(output, 51234).sort(), [4242, 7777, 8888]);
    assert.deepEqual(parseNetstatListeners(output, 135), [1060]);
    assert.deepEqual(parseNetstatListeners(output, 9), []);
    assert.deepEqual(parseNetstatListeners('', 9), []);
    assert.deepEqual(parseLsofPids('p123\nf7\np456\n'), [123, 456]);
  });

  it('the default lookup finds this process listening on a port', {
    skip: process.platform !== 'win32' && !['/usr/sbin/lsof', '/usr/bin/lsof'].some((f) => fs.existsSync(f))
      ? 'no lsof here' : false,
  }, async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const pids = await tcpListenerPids(server.address().port);
      assert.deepEqual(pids, [process.pid]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('WhisperCppEngine on Windows records its server for crash cleanup', () => {
  // platform: 'win32' with injected process tools, so this runs on any OS.
  const WIN_EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Cuewell\\resources\\whisper\\win32-x64\\whisper-server.exe';
  const CREATED = '2025-02-03T04:05:06.7000000Z';

  function records() {
    return fs.readdirSync(TMP)
      .filter((name) => name.startsWith('cuewell-wcpp-'))
      .map((name) => {
        const dir = path.join(TMP, name);
        try {
          return { dir, ...JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) };
        } catch (_) {
          return { dir };
        }
      });
  }

  it('sweeps an earlier crashed run\'s server at the first start, and records the new one until it stops', async (t) => {
    // A record from a crashed run: its Cuewell (an exited process) is gone.
    const deadOwner = spawnSync(process.execPath, ['-e', '']).pid;
    const stalePid = 2147480000;
    const staleDir = fs.mkdtempSync(path.join(TMP, 'cuewell-wcpp-'));
    fs.writeFileSync(path.join(staleDir, 'owner.json'),
      JSON.stringify({ owner: deadOwner, server: stalePid, path: WIN_EXE, created: CREATED }));

    const inspected = [];
    const killed = [];
    const { engine, spawns } = setup(t, {
      engineOptions: {
        platform: 'win32',
        inspectProcessFn: async (pid) => {
          inspected.push(pid);
          return { path: WIN_EXE, created: CREATED };
        },
        killProcessFn: async (pid) => {
          killed.push(pid);
          return true;
        },
      },
    });
    await engine.warmup();
    await engine._sweepWindows(); // runs beside the start
    assert.deepEqual(killed, [stalePid], 'the leftover server was stopped');
    assert.equal(fs.existsSync(staleDir), false, 'and its record removed');

    const childPid = spawns[0].child.pid;
    assert.ok(inspected.includes(childPid), 'the new server was inspected right after it started');
    let mine;
    await waitFor(() => {
      mine = records().find((r) => r.server === childPid && r.created);
      return Boolean(mine);
    });
    assert.equal(mine.owner, process.pid);
    assert.equal(mine.path, WIN_EXE);
    assert.equal(mine.created, CREATED);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(mine.dir, 'owner.json')).mode & 0o077, 0, 'owner-only');
    }

    await engine.unload();
    await waitFor(() => !fs.existsSync(mine.dir));
    assert.deepEqual(killed, [stalePid], 'the sweep runs once per app run');
  });
});

describe('WhisperCppEngine privacy', () => {
  before(async () => {
    // One more run that fails a request after a good one, so error paths log too.
    const { engine } = setup({ after() {} });
    await engine.transcribe(Buffer.from('a'));
    await engine.transcribe(Buffer.from('ERROR')).catch(() => {});
    await engine.close();
  });

  it('never logs transcript text', () => {
    assert.ok(logs.length > 0, 'the engine did log events');
    assert.ok(logs.some((l) => /transcription completed/.test(l.message)));
    const all = JSON.stringify(logs);
    assert.equal(all.includes(TRANSCRIPT), false);
    assert.equal(all.includes('SECRET-TRANSCRIPT'), false);
  });

  it('cleanTranscript drops whisper.cpp non-speech markers', () => {
    assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
    assert.equal(cleanTranscript('(music) hello  [ Silence ]  world ♪'), 'hello world');
    assert.equal(cleanTranscript(null), '');
    assert.equal(cleanTranscript('[MUSIC] next [ MUSIC PLAYING ] one (upbeat music)'), 'next one');
    assert.equal(cleanTranscript('(coughs) yes (clears throat) [inaudible] ok [Sound effect]'), 'yes ok');
  });

  it('cleanTranscript keeps brackets and parentheses that are spoken code', () => {
    assert.equal(cleanTranscript('arr[i] plus a[0]'), 'arr[i] plus a[0]');
    assert.equal(cleanTranscript('dp[i][j] is O(n log n)'), 'dp[i][j] is O(n log n)');
    assert.equal(cleanTranscript('f(x) and (n) items in list(range(10))'), 'f(x) and (n) items in list(range(10))');
    assert.equal(cleanTranscript('map[key] or [1, 2, 3] or [left, right]'), 'map[key] or [1, 2, 3] or [left, right]');
    // A marker word glued to a name is code, not a marker.
    assert.equal(cleanTranscript('arr[music] and sounds(x)'), 'arr[music] and sounds(x)');
  });
});
