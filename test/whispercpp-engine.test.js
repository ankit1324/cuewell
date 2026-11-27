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
const path = require('node:path');
const { spawn } = require('node:child_process');
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
const { cleanTranscript } = require('../src/services/whispercpp-engine.service');

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

/**
 * A fake install: a placeholder whisper-server file, a model file, a log
 * file the fake server writes to, and a spawnFn that runs the fake server
 * with node instead of the placeholder.
 */
function setup(t, { modelContent = 'ggml', engineOptions = {}, env = {} } = {}) {
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
    const child = spawn(process.execPath, [FAKE_SERVER, ...args], {
      ...options,
      env: {
        ...options.env,
        FAKE_WHISPER_LOG: logFile,
        FAKE_WHISPER_TEXT: TRANSCRIPT,
        FAKE_WHISPER_MARKER: marker,
        ...env,
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

  const engine = new WhisperCppEngine({
    serverPath,
    serverDir: binDir,
    modelPath,
    threads: 2,
    idleUnloadMs: 60000,
    logger,
    spawnFn,
    fetchFn,
    ...engineOptions,
  });
  t.after(() => engine.close());

  const events = () => {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  return { engine, spawns, urls, events, serverPath, modelPath, marker, dir };
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
  for (const child of allChildren) {
    if (!exited(child)) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
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
  });
});
