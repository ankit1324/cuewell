'use strict';
// Child process for test/main-crash.test.js: loads main.js under a mocked
// electron module in a temp folder, then emits process-level errors
// (uncaughtException, unhandledRejection) and reports what main.js did:
// dialogs, relaunch/exit calls, logs and the crash record on disk.
//
// Usage: node crash-harness.js <request.json>
//   { "root": "<temp dir>", "seedRecord": "<text for userData/last-crash.json>" | null,
//     "scenario": "errors" | "process-gone" | "quit" | null }
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RESULT_MARKER = '@@CUEWELL_CRASH_HARNESS_RESULT@@';
const ROOT = path.resolve(__dirname, '..', '..');

function spawnEnoent(program) {
  const error = new Error(`spawn ${program} ENOENT`);
  return Object.assign(error, { errno: -2, code: 'ENOENT', syscall: `spawn ${program}`, path: program, spawnargs: [] });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function run(request) {
  const root = request.root;
  const userData = path.join(root, 'userData');
  const appData = path.join(root, 'appData');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  const recordPath = path.join(userData, 'last-crash.json');
  if (typeof request.seedRecord === 'string') fs.writeFileSync(recordPath, request.seedRecord);
  process.chdir(root);

  const logs = [];
  const record = (level) => (message, meta) => logs.push({ level, message: String(message), meta: meta || null });
  const serviceLogger = { debug: () => {}, info: record('info'), warn: record('warn'), error: record('error') };
  const loggerFile = require.resolve(path.join(ROOT, 'src', 'core', 'logger.js'));
  require.cache[loggerFile] = {
    id: loggerFile, filename: loggerFile, loaded: true, children: [], paths: [],
    exports: { createServiceLogger: () => serviceLogger, ...serviceLogger, logPerformance: () => 0 },
  };

  // No child processes and no network.
  const block = (name) => function blockedInTests() { throw new Error(`${name} is blocked in tests`); };
  const childProcess = require('node:child_process');
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[fn] = block(`child_process.${fn}`);
  }
  for (const mod of [require('node:http'), require('node:https')]) {
    mod.request = block('request');
    mod.get = block('get');
  }
  require('node:net').Socket.prototype.connect = block('net.Socket.connect');
  globalThis.fetch = async () => { throw new Error('fetch is blocked in tests'); };

  const { createElectronMock, installElectronMock } = require('./electron-mock');
  const { electron, listeners } = createElectronMock({ userData, appData, appPath: ROOT });
  const appListeners = new Map();
  electron.app.on = (name, fn) => {
    if (!appListeners.has(name)) appListeners.set(name, []);
    appListeners.get(name).push(fn);
    return electron.app;
  };
  const emitApp = (name, ...args) => (appListeners.get(name) || []).forEach((fn) => fn(...args));
  const calls = [];
  const dialogs = [];
  let ready = false;
  electron.app.isReady = () => ready;
  electron.app.exit = (code) => calls.push(`exit ${code}`);
  electron.app.relaunch = () => calls.push('relaunch');
  electron.app.focus = () => {};
  electron.dialog = {
    showMessageBox: async (options) => {
      calls.push('dialog');
      dialogs.push({ message: options.message, buttons: options.buttons });
      return { response: 0 };
    },
    showErrorBox: (title) => calls.push(`errorBox ${title}`),
  };
  installElectronMock(electron);

  require(path.join(ROOT, 'main.js'));
  const recordAfterLoad = fs.existsSync(recordPath);
  const steps = [];
  const step = async (label, emit) => {
    const callStart = calls.length;
    emit();
    await settle();
    await settle();
    steps.push({
      label,
      calls: calls.slice(callStart),
      record: fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : null,
    });
  };

  if (request.scenario === 'errors') {
    ready = true;
    await step('recorder ENOENT', () => process.emit('uncaughtException', spawnEnoent('sox'), 'uncaughtException'));
    await step('arecord ENOENT', () => process.emit('uncaughtException', spawnEnoent('arecord'), 'uncaughtException'));
    const libraryError = new Error('socket hang up');
    libraryError.stack = `Error: socket hang up\n    at f (${path.join(ROOT, 'node_modules', 'ws', 'index.js')}:1:1)`;
    await step('library rejection', () => process.emit('unhandledRejection', libraryError, Promise.resolve()));
    await step('string rejection', () => process.emit('unhandledRejection', 'aborted', Promise.resolve()));
    const appError = new Error(`app bug in ${process.env.HOME}/x`);
    appError.stack = `Error: ${appError.message}\n    at g (${path.join(ROOT, 'main.js')}:10:1)`;
    await step('app rejection', () => process.emit('unhandledRejection', appError, Promise.resolve()));
    await step('whisper ENOENT', () => process.emit('uncaughtException', spawnEnoent('whisper'), 'uncaughtException'));
    await step('second fatal', () => process.emit('uncaughtException', new TypeError('again'), 'uncaughtException'));
  }

  if (request.scenario === 'process-gone') {
    ready = true;
    const windowManager = require(path.join(ROOT, 'src', 'managers', 'window.manager.js'));
    windowManager.webContentsTypes.set(77, 'chat');
    const webContents = { id: 77, isDestroyed: () => false, reload: () => {} };
    await step('window killed', () => emitApp('render-process-gone', {}, webContents, { reason: 'killed', exitCode: 9 }));
    await step('helper clean exit', () => emitApp('child-process-gone', {}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 }));
    await step('helper crash', () => emitApp('child-process-gone', {}, { type: 'Utility', name: 'Audio Service', reason: 'crashed', exitCode: 5 }));
    await step('window crash', () => emitApp('render-process-gone', {}, webContents, { reason: 'crashed', exitCode: 11 }));

    // A window message whose handler throws is logged, not fatal.
    windowManager.webContentsTypes.set(78, 'main');
    const event = {
      sender: { id: 78, isDestroyed: () => false, getURL: () => pathToFileURL(path.join(ROOT, windowManager.windowConfigs.main.file)).href, send: () => {} },
      senderFrame: { parent: null },
    };
    await step('bad audio chunk', () => listeners.get('audio-chunk')(event, { buffer: 1 }));
  }

  if (request.scenario === 'quit') {
    await step('will-quit', () => emitApp('will-quit'));
  }

  return {
    recordAfterLoad,
    recordMode: fs.existsSync(recordPath) ? fs.statSync(recordPath).mode & 0o777 : null,
    userDataFiles: fs.readdirSync(userData).sort(),
    steps,
    dialogs,
    logs,
  };
}

const requestPath = process.argv[2];
if (requestPath) {
  run(JSON.parse(fs.readFileSync(requestPath, 'utf8')))
    .then((output) => {
      process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(output)}\n`, () => process.exit(0));
    })
    .catch((error) => {
      process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({ fatal: error && error.stack })}\n`, () => process.exit(1));
    });
}

module.exports = { RESULT_MARKER };
