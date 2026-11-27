'use strict';
// Child process for test/main-ipc.test.js: loads main.js under a mocked
// electron module inside a temp folder, then calls IPC handlers with fake
// senders and prints the results as one JSON line after RESULT_MARKER.
//
// Usage: node main-harness.js <request.json>
//   { "root": "<temp dir>", "calls": [{ "label", "channel", "from", "args" }] }
// `from` is a window type ("main", "chat", ...) or a bad sender:
//   "unregistered"  webContents that is not one of the app's windows (showing settings.html)
//   "subframe"      the settings window, but from a frame inside the page
//   "foreign-url"   the settings window showing a web page
//   "wrong-page"    the settings window showing chat.html
//   "destroyed"     the settings window after it was destroyed
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RESULT_MARKER = '@@CUEWELL_HARNESS_RESULT@@';
const ROOT = path.resolve(__dirname, '..', '..');

async function run(request) {
  const root = request.root;
  const userData = path.join(root, 'userData');
  const appData = path.join(root, 'appData');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  process.chdir(root); // main.js prefers a .env in the launch folder when run from source

  // Silent logger that records what main.js reports.
  const logs = [];
  const record = (level) => (message, meta) => logs.push({ level, message: String(message), meta: meta || null });
  const serviceLogger = { debug: () => {}, info: record('info'), warn: record('warn'), error: record('error') };
  const loggerFile = require.resolve(path.join(ROOT, 'src', 'core', 'logger.js'));
  require.cache[loggerFile] = {
    id: loggerFile, filename: loggerFile, loaded: true, children: [], paths: [],
    exports: { createServiceLogger: () => serviceLogger, ...serviceLogger, logPerformance: () => 0 },
  };

  // No child processes and no network, even if a sender check were broken
  // and a handler such as install-whisper or test-provider ran. Patched
  // before main.js loads, so modules that destructure these get the stubs.
  const blocked = [];
  const block = (name) => function blockedInTests() {
    blocked.push(name);
    throw new Error(`${name} is blocked in tests`);
  };
  const childProcess = require('node:child_process');
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[fn] = block(`child_process.${fn}`);
  }
  for (const [name, mod] of [['http', require('node:http')], ['https', require('node:https')]]) {
    mod.request = block(`${name}.request`);
    mod.get = block(`${name}.get`);
  }
  const net = require('node:net');
  net.connect = block('net.connect');
  net.createConnection = block('net.createConnection');
  net.Socket.prototype.connect = block('net.Socket.connect'); // also covers TLS sockets
  require('node:tls').connect = block('tls.connect');
  const dns = require('node:dns');
  dns.lookup = block('dns.lookup');
  dns.promises.lookup = block('dns.promises.lookup');
  globalThis.fetch = async (url) => {
    blocked.push(`fetch ${String(url).split('?')[0]}`);
    throw new Error('fetch is blocked in tests');
  };

  const { createElectronMock, installElectronMock } = require('./electron-mock');
  const { electron, handlers, listeners } = createElectronMock({ userData, appData, appPath: ROOT });
  installElectronMock(electron);

  require(path.join(ROOT, 'main.js'));
  const windowManager = require(path.join(ROOT, 'src', 'managers', 'window.manager.js'));

  const pageUrl = (type) => pathToFileURL(path.join(ROOT, windowManager.windowConfigs[type].file)).href;
  let nextId = 1000;
  const sender = (type, overrides = {}) => {
    const id = nextId++;
    if (type) windowManager.webContentsTypes.set(id, type);
    return {
      sender: {
        id,
        isDestroyed: () => false,
        // An unregistered webContents still shows an app page, so only the
        // window check can reject it.
        getURL: () => pageUrl(type || 'settings'),
        send: () => {},
        ...overrides.sender,
      },
      senderFrame: { parent: null, ...overrides.senderFrame },
    };
  };
  const eventFrom = (from) => {
    switch (from) {
      case 'unregistered': return sender(null);
      case 'subframe': return sender('settings', { senderFrame: { parent: {} } });
      case 'foreign-url': return sender('settings', { sender: { getURL: () => 'https://evil.example/settings.html' } });
      case 'wrong-page': return sender('settings', { sender: { getURL: () => pageUrl('chat') } });
      case 'destroyed': return sender('settings', { sender: { isDestroyed: () => true } });
      default:
        if (!windowManager.windowConfigs[from]) throw new Error(`Unknown window type ${from}`);
        return sender(from);
    }
  };

  const results = [];
  for (const call of request.calls || []) {
    const logStart = logs.length;
    const entry = { label: call.label || call.channel, channel: call.channel, from: call.from };
    try {
      const event = eventFrom(call.from);
      if (handlers.has(call.channel)) {
        entry.value = await handlers.get(call.channel)(event, ...(call.args || []));
        entry.ok = true;
      } else if (listeners.has(call.channel)) {
        listeners.get(call.channel)(event, ...(call.args || []));
        entry.ok = true;
      } else {
        throw new Error(`No handler for ${call.channel}`);
      }
    } catch (error) {
      entry.ok = false;
      entry.error = error && error.message;
    }
    entry.rejectedBySender = logs.slice(logStart)
      .some((log) => log.level === 'warn' && /^Rejected IPC message/.test(log.message));
    results.push(entry);
  }

  const readFile = (name) => {
    const file = path.join(userData, name);
    return fs.existsSync(file)
      ? { mode: fs.statSync(file).mode & 0o777, text: fs.readFileSync(file, 'utf8') }
      : null;
  };
  return {
    userDataFiles: fs.readdirSync(userData).sort(),
    profileFile: readFile('profile.json'),
    handleChannels: [...handlers.keys()].sort(),
    onChannels: [...listeners.keys()].sort(),
    results,
    envFile: readFile('.env'),
    logs,
    blocked,
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
