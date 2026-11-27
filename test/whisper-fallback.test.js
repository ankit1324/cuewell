'use strict';
// Which local voice engine the speech service picks (src/services/
// speech.service.js), what it reports when the built-in engine cannot run,
// how voice languages reach the engine, and how src/core/whisper-binary.js
// finds the bundled whisper-server.
//
// The speech service runs with a mocked electron (temp userData), a stub
// whisper-binary (so the developer's vendor/whisper folder does not matter),
// a stubbed Python Whisper probe, and child processes blocked: nothing is
// spawned, and no real HOME, userData or .env is read.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { tempDir, stubLogger, clearAppEnv } = require('./helpers/env');
const { repoPath } = require('./helpers/source');
const { createElectronMock, installElectronMock } = require('./helpers/electron-mock');

// Real resolver, loaded before the stub below replaces it for the service.
const binary = require('../src/core/whisper-binary');
const models = require('../src/core/whisper-models');

const isPosix = process.platform !== 'win32';

describe('whisper-binary resolveWhisperServer', () => {
  function install(dir, name = 'whisper-server', mode = 0o755) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, mode);
    return file;
  }

  it('prefers Resources/whisper over vendor/whisper/<platform>-<arch>', (t) => {
    const root = tempDir(t);
    const resourcesPath = path.join(root, 'Resources');
    const appRoot = path.join(root, 'repo');
    const packaged = install(path.join(resourcesPath, 'whisper'));
    install(path.join(appRoot, 'vendor', 'whisper', 'darwin-arm64'));
    assert.deepEqual(
      binary.resolveWhisperServer({ platform: 'darwin', arch: 'arm64', resourcesPath, appRoot }),
      { path: packaged, dir: path.join(resourcesPath, 'whisper') },
    );
  });

  it('falls back to vendor/whisper/<platform>-<arch> when running from source', (t) => {
    const root = tempDir(t);
    const appRoot = path.join(root, 'repo');
    const dir = path.join(appRoot, 'vendor', 'whisper', 'linux-x64');
    const file = install(dir);
    install(path.join(appRoot, 'vendor', 'whisper', 'darwin-arm64')); // other platforms are ignored
    assert.deepEqual(
      binary.resolveWhisperServer({ platform: 'linux', arch: 'x64', resourcesPath: path.join(root, 'none'), appRoot }),
      { path: file, dir },
    );
    assert.equal(
      binary.resolveWhisperServer({ platform: 'darwin', arch: 'x64', resourcesPath: undefined, appRoot }),
      null,
      'no darwin-x64 build there',
    );
  });

  it('finds the program inside the official archive folders (Release/, whisper-bin-ubuntu-x64/)', (t) => {
    const root = tempDir(t);
    const appRoot = path.join(root, 'repo');
    const winDir = path.join(appRoot, 'vendor', 'whisper', 'win32-x64', 'Release');
    const winFile = install(winDir, 'whisper-server.exe');
    assert.deepEqual(binary.resolveWhisperServer({ platform: 'win32', arch: 'x64', appRoot }), { path: winFile, dir: winDir });

    const resourcesPath = path.join(root, 'Resources');
    const linuxDir = path.join(resourcesPath, 'whisper', 'whisper-bin-ubuntu-x64');
    const linuxFile = install(linuxDir);
    assert.deepEqual(binary.resolveWhisperServer({ platform: 'linux', arch: 'x64', resourcesPath, appRoot }), { path: linuxFile, dir: linuxDir });
  });

  it('returns null on unsupported platforms, even when a program is present', (t) => {
    const root = tempDir(t);
    const resourcesPath = path.join(root, 'Resources');
    install(path.join(resourcesPath, 'whisper'));
    for (const [platform, arch] of [['linux', 'arm64'], ['win32', 'arm64'], ['win32', 'ia32'], ['freebsd', 'x64'], ['darwin', 'ppc']]) {
      assert.equal(binary.isPlatformSupported(platform, arch), false, `${platform}-${arch}`);
      assert.equal(binary.resolveWhisperServer({ platform, arch, resourcesPath, appRoot: root }), null, `${platform}-${arch}`);
    }
    assert.deepEqual([...binary.SUPPORTED_PLATFORMS].sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  });

  it('returns null when there is no program, or the name is a folder', (t) => {
    const root = tempDir(t);
    const resourcesPath = path.join(root, 'Resources');
    assert.equal(binary.resolveWhisperServer({ platform: 'darwin', arch: 'arm64', resourcesPath, appRoot: root }), null);
    fs.mkdirSync(path.join(resourcesPath, 'whisper', 'whisper-server'), { recursive: true });
    assert.equal(binary.resolveWhisperServer({ platform: 'darwin', arch: 'arm64', resourcesPath, appRoot: root }), null);
  });

  it('skips a program that is not executable', { skip: !isPosix && 'execute bits are POSIX only' }, (t) => {
    const root = tempDir(t);
    const resourcesPath = path.join(root, 'Resources');
    install(path.join(resourcesPath, 'whisper'), 'whisper-server', 0o644);
    assert.equal(binary.resolveWhisperServer({ platform: 'linux', arch: 'x64', resourcesPath, appRoot: root }), null);
  });

  it('never looks for vendor/ inside the asar archive', (t) => {
    const root = tempDir(t);
    const appRoot = path.join(root, 'app.asar');
    install(path.join(appRoot, 'vendor', 'whisper', 'linux-x64'));
    assert.equal(binary.resolveWhisperServer({ platform: 'linux', arch: 'x64', appRoot }), null);
  });

  it('names the program per platform', () => {
    assert.equal(binary.executableName('win32'), 'whisper-server.exe');
    assert.equal(binary.executableName('darwin'), 'whisper-server');
    assert.equal(binary.executableName('linux'), 'whisper-server');
    assert.equal(binary.platformKey('darwin', 'arm64'), 'darwin-arm64');
  });
});

describe('speech service engine choice', () => {
  const ROOT = tempDir(null, 'cuewell-voice-');
  const userData = path.join(ROOT, 'userData');
  const modelDir = path.join(ROOT, 'models');
  const binDir = path.join(ROOT, 'bin');
  const serverPath = path.join(binDir, 'whisper-server');
  const fakePython = path.join(ROOT, 'venv', 'bin', 'python');
  const small = models.getModel('small-q5_1');
  const base = models.getModel('base-q5_1');

  const binaryState = { supported: true, server: { path: serverPath, dir: binDir } };
  const python = { works: false, probes: [] };
  const blocked = [];
  const statuses = [];
  const errors = [];
  let service;
  let savedSpawn;

  before(() => {
    clearAppEnv();
    stubLogger();
    for (const dir of [userData, modelDir, binDir, path.dirname(fakePython)]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(serverPath, 'placeholder');
    fs.writeFileSync(fakePython, 'placeholder');

    const { electron } = createElectronMock({ userData, appData: path.join(ROOT, 'appData'), appPath: repoPath() });
    installElectronMock(electron);

    // Nothing in these tests may start a process.
    savedSpawn = {};
    for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
      savedSpawn[fn] = childProcess[fn];
      childProcess[fn] = (command) => {
        blocked.push(`${fn} ${command}`);
        throw new Error(`${fn} is blocked in tests`);
      };
    }

    const binaryFile = require.resolve(repoPath('src', 'core', 'whisper-binary.js'));
    require.cache[binaryFile] = {
      id: binaryFile, filename: binaryFile, loaded: true, children: [], paths: [],
      exports: {
        ...binary,
        isPlatformSupported: () => binaryState.supported,
        resolveWhisperServer: () => (binaryState.supported ? binaryState.server : null),
      },
    };

    process.env.SPEECH_PROVIDER = 'whisper';
    process.env.WHISPER_MODEL_DIR = modelDir;
    service = require('../src/services/speech.service');
    service.on('status', (message) => statuses.push(message));
    service.on('error', (message) => errors.push(message));
    service._probeWhisperCandidate = (candidate) => {
      python.probes.push(candidate.command);
      return python.works && path.normalize(candidate.command) === fakePython ? candidate : null;
    };
  });

  after(() => {
    if (service) service.shutdown();
    for (const [fn, original] of Object.entries(savedSpawn || {})) childProcess[fn] = original;
  });

  beforeEach(() => {
    for (const key of ['WHISPER_ENGINE', 'WHISPER_COMMAND', 'WHISPER_CPP_MODEL', 'WHISPER_LANGUAGE']) delete process.env[key];
    for (const name of fs.readdirSync(modelDir)) fs.rmSync(path.join(modelDir, name), { force: true });
    binaryState.supported = true;
    binaryState.server = { path: serverPath, dir: binDir };
    python.works = false;
    python.probes.length = 0;
    statuses.length = 0;
    errors.length = 0;
  });

  /** Put a model file of the right size in place (sparse; never read). */
  function downloadModel(model = small) {
    const file = path.join(modelDir, model.file);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, model.bytes);
    return file;
  }

  function init({ engine, pythonCommand, pythonWorks = false, model, language } = {}) {
    if (engine !== undefined) process.env.WHISPER_ENGINE = engine;
    if (pythonCommand) process.env.WHISPER_COMMAND = pythonCommand;
    if (model) process.env.WHISPER_CPP_MODEL = model;
    if (language) process.env.WHISPER_LANGUAGE = language;
    python.works = pythonWorks;
    service.runtimeSettings = {};
    service._pythonWhisperFound = null;
    service._pythonCommandCache = null;
    service.initializeClient();
    return service;
  }

  const PY = () => `${fakePython} -m whisper`;

  it('WHISPER_ENGINE unset with a working Python WHISPER_COMMAND keeps Python', () => {
    downloadModel();
    init({ pythonCommand: PY(), pythonWorks: true });
    assert.equal(service.whisperEngine, 'python');
    assert.equal(service.whisperEngineChoice, 'python');
    assert.equal(service.whisperCpp, null);
    assert.equal(service.isAvailable(), true);
    assert.equal(service.whisperCommand.command, fakePython);
    assert.ok(python.probes.every((c) => path.isAbsolute(c)), 'no PATH scan for the automatic choice');
    assert.equal(service.getWhisperEngineState().choice, 'python');
    assert.equal(service.getStatus().effectiveSettings.whisperEngine, 'python');
  });

  it('WHISPER_ENGINE unset with a broken Python WHISPER_COMMAND uses the built-in engine', () => {
    downloadModel();
    init({ pythonCommand: PY(), pythonWorks: false });
    assert.equal(service.whisperEngine, 'whispercpp');
    assert.equal(service.whisperEngineChoice, 'whispercpp');
    assert.equal(service.isAvailable(), true);
  });

  it('WHISPER_ENGINE unset with no Python setup uses the built-in engine without probing', () => {
    downloadModel();
    init();
    assert.equal(service.whisperEngine, 'whispercpp');
    assert.equal(service.isAvailable(), true);
    assert.deepEqual(python.probes, []);
    assert.ok(statuses.includes('Local Whisper ready'));
  });

  it('WHISPER_ENGINE=whispercpp uses the built-in engine even when Python works', () => {
    const file = downloadModel();
    init({ engine: 'whispercpp', pythonCommand: PY(), pythonWorks: true });
    assert.equal(service.whisperEngine, 'whispercpp');
    assert.equal(service.whisperEngineChoice, 'whispercpp');
    assert.equal(service.whisperCommand, null);
    assert.equal(service.whisperCpp.serverPath, serverPath, 'the resolved program, not a setting');
    assert.equal(service.whisperCpp.serverDir, binDir);
    assert.equal(service.whisperCpp.modelPath, file);
    assert.equal(service.isAvailable(), true);
    assert.equal(service.getUnavailableReason(), '');
    assert.deepEqual(python.probes, [], 'Python is not probed while the built-in engine works');
  });

  it('WHISPER_ENGINE=python uses Python', () => {
    downloadModel();
    init({ engine: 'python', pythonCommand: PY(), pythonWorks: true });
    assert.equal(service.whisperEngine, 'python');
    assert.equal(service.whisperCpp, null);
  });

  it('an unknown WHISPER_ENGINE value is treated as unset', () => {
    downloadModel();
    init({ engine: '../../bin/sh', pythonCommand: PY(), pythonWorks: true });
    assert.equal(service.whisperEngine, 'python', 'the automatic choice for an existing Python setup');
    init({ engine: 'evil' });
    assert.equal(service.whisperEngine, 'whispercpp');
  });

  it('with no model downloaded it reports "download a model" instead of failing silently', () => {
    init({ engine: 'whispercpp' });
    assert.equal(service.isAvailable(), false);
    assert.equal(service.whisperEngine, null);
    const reason = service.getUnavailableReason();
    assert.match(reason, /Download a voice model in Settings/);
    assert.ok(statuses.includes(reason), 'the status event carries the reason');

    const state = service.getWhisperEngineState();
    assert.equal(state.choice, 'whispercpp');
    assert.equal(state.problem, 'no-model');
    assert.equal(state.problemMessage, reason);
    assert.equal(state.binaryAvailable, true);
    assert.equal(state.platformSupported, true);
    assert.equal(state.selectedModel, 'small-q5_1');
    assert.equal(state.modelDir, modelDir);

    service.startRecording();
    assert.deepEqual(errors, [reason], 'pressing the mic shows the same reason');
    assert.equal(service.isRecording, false);

    // A partial file of the wrong size is not a model.
    fs.writeFileSync(path.join(modelDir, `${small.file}.part`), 'partial');
    fs.writeFileSync(path.join(modelDir, small.file), 'partial');
    init({ engine: 'whispercpp' });
    assert.equal(service.getWhisperEngineState().problem, 'no-model');

    downloadModel();
    init({ engine: 'whispercpp' });
    assert.equal(service.isAvailable(), true, 'ready once the model is there');
  });

  it('with no model but a working Python setup, voice keeps working on Python and Settings still offers the download', () => {
    init({ engine: 'whispercpp', pythonCommand: PY(), pythonWorks: true });
    assert.equal(service.whisperEngine, 'python');
    assert.equal(service.isAvailable(), true);
    assert.equal(service.whisperEngineChoice, 'whispercpp');
    assert.equal(service.getWhisperEngineState().problem, 'no-model');
  });

  it('reports a missing binary and an unsupported system in words', () => {
    downloadModel();
    binaryState.server = null;
    init({ engine: 'whispercpp' });
    assert.equal(service.isAvailable(), false);
    assert.match(service.getUnavailableReason(), /missing from this copy of Cuewell/);
    assert.equal(service.getWhisperEngineState().binaryAvailable, false);
    assert.equal(service.getWhisperEngineState().problem, 'no-binary');

    binaryState.supported = false;
    init({ engine: 'whispercpp' });
    assert.equal(service.isAvailable(), false);
    assert.match(service.getUnavailableReason(), /does not run on this system.*Azure Speech/);
    const state = service.getWhisperEngineState();
    assert.equal(state.platformSupported, false);
    assert.equal(state.problem, 'unsupported');
  });

  it('a missing Python Whisper says how to switch to the built-in engine', () => {
    init({ engine: 'python', pythonCommand: PY(), pythonWorks: false });
    assert.equal(service.isAvailable(), false);
    assert.match(service.getUnavailableReason(), /Python Whisper was not found.*built-in voice engine/);
  });

  it('WHISPER_CPP_MODEL picks a catalog model; anything else falls back to Small', () => {
    const file = downloadModel(base);
    init({ engine: 'whispercpp', model: 'base-q5_1' });
    assert.equal(service.getWhisperCppModelId(), 'base-q5_1');
    assert.equal(service.whisperCpp.modelPath, file);

    for (const value of ['../../../etc/passwd', 'ggml-base-q5_1.bin', 'large']) {
      process.env.WHISPER_CPP_MODEL = value;
      assert.equal(service.getWhisperCppModelId(), 'small-q5_1', value);
    }
  });

  describe('voice language', () => {
    function engineSpy() {
      const calls = [];
      service.whisperCpp = {
        transcribe: async (input, options) => {
          calls.push({ input, options });
          return { text: 'Haan, binary search use karenge' };
        },
        close: async () => {},
        warmup: async () => ({ ready: true }),
        releaseWhenIdle() {},
      };
      return calls;
    }

    it('Hinglish is Hindi plus a Roman-script prompt for the built-in engine', async () => {
      downloadModel();
      init({ engine: 'whispercpp', language: 'hinglish' });
      const calls = engineSpy();
      const text = await service._transcribeWhisperBuffer(Buffer.alloc(3200));
      assert.equal(text, 'Haan, binary search use karenge');
      assert.equal(calls.length, 1);
      const { input, options } = calls[0];
      assert.ok(Buffer.isBuffer(input) && input.subarray(0, 4).toString() === 'RIFF', 'sent as a WAV buffer, no temp file');
      assert.equal(options.language, 'hi');
      assert.ok(options.prompt.length > 0);
      assert.match(options.prompt, /^[\x20-\x7E]+$/, 'the prompt is plain Latin script');
      assert.doesNotMatch(options.prompt, /[\u0900-\u097F]/, 'no Devanagari');
      assert.match(options.prompt, /Haan|karta|hai/);
    });

    it('auto, English and Hindi pass through; codes are lower-cased for whisper.cpp', async () => {
      downloadModel();
      for (const [language, expected] of [['auto', 'auto'], ['en', 'en'], ['hi', 'hi'], ['EN', 'en'], ['detect', 'auto']]) {
        init({ engine: 'whispercpp', language });
        const calls = engineSpy();
        await service._transcribeWhisperFile(path.join(ROOT, 'clip.wav'));
        assert.deepEqual(calls[0].options, { language: expected, prompt: '' }, language);
      }
      delete process.env.WHISPER_LANGUAGE;
      assert.deepEqual(service._getWhisperCppDecodeOptions(), { language: 'auto', prompt: '' }, 'unset is auto');
    });

    it('Hinglish sends language hi and the same prompt to the Python worker', async () => {
      init({ engine: 'python', pythonCommand: PY(), pythonWorks: true, language: 'hinglish' });
      assert.equal(service.whisperEngine, 'python');
      const worker = service.whisperWorker;
      const requests = [];
      const saved = { isConfigured: worker.isConfigured, _request: worker._request, _scheduleIdleUnload: worker._scheduleIdleUnload };
      worker.isConfigured = () => true;
      worker._scheduleIdleUnload = () => {};
      worker._request = async (request) => {
        requests.push(request);
        return { text: 'Haan, main explain karta hoon', language: 'hi' };
      };
      try {
        const text = await service._transcribeWhisperFile(path.join(ROOT, 'clip.wav'));
        assert.equal(text, 'Haan, main explain karta hoon');
        assert.equal(requests.length, 1);
        const [request] = requests;
        assert.equal(request.action, 'transcribe');
        assert.equal(request.language, 'hi');
        assert.equal(request.initial_prompt, service._getWhisperCppDecodeOptions().prompt, 'the whisper.cpp prompt');
        assert.match(request.initial_prompt, /^[\x20-\x7E]+$/);

        // Other languages send no prompt, so older workers see the same request as before.
        init({ engine: 'python', pythonCommand: PY(), pythonWorks: true, language: 'en' });
        await service._transcribeWhisperFile(path.join(ROOT, 'clip.wav'));
        assert.equal(requests[1].language, 'en');
        assert.equal('initial_prompt' in requests[1], false);
      } finally {
        Object.assign(worker, saved);
      }
    });

    it('Hinglish gives the Python CLI the same language and prompt (--language hi --initial_prompt)', () => {
      process.env.WHISPER_LANGUAGE = 'Hinglish';
      const decode = service._getWhisperDecodeOptions();
      assert.equal(decode.language, 'hi');
      assert.match(decode.prompt, /^[\x20-\x7E]+$/);
    });
  });

  it('started no process', () => {
    assert.deepEqual(blocked, []);
  });
});
