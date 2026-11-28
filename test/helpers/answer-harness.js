'use strict';
// Child process for test/answer-flow.test.js: loads main.js under the
// mocked electron module (as main-harness.js does), with the real
// LLMService talking to an OpenAI-compatible provider whose fetch streams
// slowly from memory. Runs the scenarios below through main.js's own entry
// points (IPC handlers, the voice fragment handler, the screenshot
// trigger) and prints what reached each window and session memory as one
// JSON line after RESULT_MARKER.
//
// Usage: node answer-harness.js <root dir>
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: sleep } = require('node:timers/promises');

const RESULT_MARKER = '@@CUEWELL_ANSWER_HARNESS_RESULT@@';
const ROOT = path.resolve(__dirname, '..', '..');
const PIECES = ['Say ', 'this ', 'first. ', 'Then ', 'the ', 'details ', 'follow ', 'here.'];

async function run(root) {
  const userData = path.join(root, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(root, 'appData'), { recursive: true });
  process.chdir(root);

  const logs = [];
  const record = (level) => (message, meta) => logs.push({ level, message: String(message), meta: meta || null });
  const serviceLogger = { debug: () => {}, info: record('info'), warn: record('warn'), error: record('error'), logPerformance: () => 0 };
  const loggerFile = require.resolve(path.join(ROOT, 'src', 'core', 'logger.js'));
  require.cache[loggerFile] = {
    id: loggerFile, filename: loggerFile, loaded: true, children: [], paths: [],
    exports: { createServiceLogger: () => serviceLogger, ...serviceLogger, logPerformance: () => 0 },
  };

  // No child processes and no network: the provider's fetch below is the
  // only way out, and it never opens a socket.
  const childProcess = require('node:child_process');
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[fn] = () => { throw new Error(`child_process.${fn} is blocked in tests`); };
  }
  for (const mod of [require('node:http'), require('node:https')]) {
    mod.request = () => { throw new Error('http requests are blocked in tests'); };
    mod.get = mod.request;
  }
  require('node:net').Socket.prototype.connect = () => { throw new Error('sockets are blocked in tests'); };
  globalThis.fetch = async () => { throw new Error('fetch is blocked in tests'); };

  const { createElectronMock, installElectronMock } = require('./electron-mock');
  const { electron, handlers } = createElectronMock({ userData, appData: path.join(root, 'appData'), appPath: ROOT });
  installElectronMock(electron);

  // Global shortcuts as the system sees them: what this app holds now, and
  // every call main.js made. `heldElsewhere` is an accelerator another app
  // owns, so registering it fails.
  const STOP = 'CommandOrControl+Shift+X';
  const owned = new Map();
  let shortcutCalls = [];
  let heldElsewhere = null;
  Object.assign(electron.globalShortcut, {
    register(accelerator, handler) {
      shortcutCalls.push(['register', accelerator]);
      if (accelerator === heldElsewhere || owned.has(accelerator)) return false;
      owned.set(accelerator, handler);
      return true;
    },
    unregister(accelerator) {
      shortcutCalls.push(['unregister', accelerator]);
      owned.delete(accelerator);
    },
    unregisterAll() {
      shortcutCalls.push(['unregisterAll']);
      owned.clear();
    },
    isRegistered: (accelerator) => owned.has(accelerator),
  });
  const stopCalls = () => shortcutCalls.filter((c) => c[1] === STOP || c[0] === 'unregisterAll').map((c) => c[0]);
  const stopHeld = () => owned.has(STOP);

  // main.js keeps its controller to itself. Its constructor assigns
  // this._utteranceCoalesceMs, which this accessor catches once to learn
  // the instance, then turns into a plain property.
  let controller = null;
  Object.defineProperty(Object.prototype, '_utteranceCoalesceMs', {
    configurable: true,
    set(value) {
      if (!controller) controller = this;
      Object.defineProperty(this, '_utteranceCoalesceMs', { value, writable: true, configurable: true, enumerable: true });
    },
  });
  try {
    require(path.join(ROOT, 'main.js'));
  } finally {
    delete Object.prototype._utteranceCoalesceMs;
  }
  if (!controller) throw new Error('main.js controller not found');

  const windowManager = require(path.join(ROOT, 'src', 'managers', 'window.manager.js'));
  const sessionManager = require(path.join(ROOT, 'src', 'managers', 'session.manager.js'));
  const llmService = require(path.join(ROOT, 'src', 'services', 'llm.service.js'));
  const speechService = require(path.join(ROOT, 'src', 'services', 'speech.service.js'));
  const captureService = require(path.join(ROOT, 'src', 'services', 'capture.service.js'));
  const OpenAICompatibleProvider = require(path.join(ROOT, 'src', 'services', 'providers', 'openai-compatible.provider.js'));
  const { createSseFetch, openAiEvents } = require('./fake-sse');

  // What reaches each window.
  let events = [];
  const fakeWindow = (type) => ({
    isDestroyed: () => false,
    webContents: { send: (channel, data) => events.push({ to: type, channel, data: data || null }) },
  });
  const windows = { chat: fakeWindow('chat'), llmResponse: fakeWindow('llmResponse') };
  windowManager.getWindow = (type) => windows[type] || null;
  windowManager.showLLMLoading = () => events.push({ to: 'llmResponse', channel: 'show-loading', data: null });
  windowManager.showLLMResponse = (content, metadata) =>
    events.push({ to: 'llmResponse', channel: 'display-llm-response', data: { content, metadata } });
  windowManager.broadcastToAllWindows = (channel, data) => events.push({ to: 'all', channel, data: data || null });
  speechService.isManualCaptureMode = () => false;
  captureService.captureAndProcess = async () => ({ imageBuffer: Buffer.from('fake png'), mimeType: 'image/png' });
  controller.isReady = true;
  controller._utteranceCoalesceMs = 40;

  // The real LLMService and provider code; only the HTTP layer is fake.
  let fetch = null;
  const useProvider = ({ intervalMs = 25, events: sse = openAiEvents(PIECES) } = {}) => {
    fetch = createSseFetch({ events: sse, intervalMs });
    llmService.providerId = 'openai';
    llmService.model = 'test-model';
    llmService.provider = new OpenAICompatibleProvider({
      apiKey: 'test-key', baseURL: 'http://127.0.0.1:9/v1', label: 'OpenAI', timeout: 5000, idleTimeoutMs: 5000,
      clientOptions: { fetch },
    });
    llmService.isInitialized = true;
  };

  const pageUrl = (type) => pathToFileURL(path.join(ROOT, windowManager.windowConfigs[type].file)).href;
  let nextId = 5000;
  const ipc = async (channel, from, ...args) => {
    const id = nextId++;
    windowManager.webContentsTypes.set(id, from);
    const event = { sender: { id, isDestroyed: () => false, getURL: () => pageUrl(from), send: () => {} }, senderFrame: { parent: null } };
    try {
      return { ok: true, value: await handlers.get(channel)(event, ...args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  // Text chunks of answer `id` as one window got them (chat, or the answer
  // window for voice answers shown only there).
  const chunksFor = (id, to = 'chat') => events.filter((e) => e.to === to && e.channel === 'transcription-llm-response-chunk' &&
    e.data.messageId === id && e.data.delta);
  const startedIds = () => [...new Set(events.filter((e) => e.channel === 'transcription-llm-response-start').map((e) => e.data.messageId))];
  const waitFor = async (check, what, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (check()) return;
      await sleep(5);
    }
    const error = new Error(`timed out waiting for ${what}`);
    error.debug = { events: events.slice(-30), logs: logs.slice(-20) };
    throw error;
  };
  const waitForChunks = (id, count) => waitFor(() => chunksFor(id).length >= count, `${count} chunks of ${id}`);
  const waitForFinal = (id) => waitFor(() => events.some((e) => e.channel === 'transcription-llm-response' && e.data.messageId === id && e.to !== 'llmResponse'), `the final answer to ${id}`);
  const memory = () => sessionManager.sessionMemory
    .filter((e) => e.role !== 'system')
    .map((e) => ({ role: e.role, content: e.content, stopped: !!(e.metadata && e.metadata.stopped), stopReason: e.metadata && e.metadata.stopReason }));
  const snapshot = (extra = {}) => ({
    events: events.map((e) => ({ to: e.to, channel: e.channel, data: e.data })),
    memory: memory(),
    started: startedIds(),
    fetchCalls: fetch ? fetch.calls.map((c) => ({ aborted: c.aborted, sentAfterAbort: c.sentAfterAbort })) : [],
    stopShortcut: stopCalls(),
    stopShortcutHeld: stopHeld(),
    ...extra,
  });
  const reset = () => {
    sessionManager.clear();
    events = [];
    shortcutCalls = [];
  };
  const stopInfo = () => {
    const entry = controller.getSettingsInfo().shortcuts.find((s) => s.accelerator === STOP);
    return entry ? { scope: entry.scope, registered: entry.registered, action: entry.action } : null;
  };

  const scenarios = {};

  // Startup: the global shortcuts, without the Stop shortcut.
  controller.setupGlobalShortcuts();
  const startupInfo = controller.getSettingsInfo().shortcuts;
  scenarios.startup = {
    registered: shortcutCalls.filter((c) => c[0] === 'register').map((c) => c[1]),
    shortcuts: startupInfo.map((s) => ({ accelerator: s.accelerator, scope: s.scope, registered: s.registered })),
    stop: stopInfo(),
  };

  // Typed chat: a second message while the first answer streams.
  reset();
  useProvider();
  await ipc('send-chat-message', 'chat', 'What is a hash map?');
  let [first] = startedIds();
  await waitForChunks(first, 2);
  const firstChunks = chunksFor(first).length;
  await ipc('send-chat-message', 'chat', 'And a tree map?');
  let second = startedIds()[1];
  await waitForFinal(second);
  await sleep(150);
  scenarios.typed = snapshot({ first, second, firstChunksAtStop: firstChunks });

  // Voice: a second utterance (after the debounce) while the first answer streams.
  reset();
  useProvider();
  controller.handleTranscriptionFragment('Tell me about yourself');
  await waitFor(() => startedIds().length === 1, 'the first voice answer');
  [first] = startedIds();
  await waitForChunks(first, 2);
  const firstVoiceChunks = chunksFor(first).length;
  controller.handleTranscriptionFragment('Why this company?');
  await waitFor(() => startedIds().length === 2, 'the second voice answer');
  second = startedIds()[1];
  await waitForFinal(second);
  await sleep(150);
  scenarios.voice = snapshot({ first, second, firstChunksAtStop: firstVoiceChunks });

  // Screenshot while a typed answer streams.
  reset();
  useProvider();
  await ipc('send-chat-message', 'chat', 'Explain recursion');
  [first] = startedIds();
  await waitForChunks(first, 2);
  const firstShotChunks = chunksFor(first).length;
  await controller.triggerScreenshotOCR();
  second = startedIds()[1];
  await sleep(150);
  scenarios.screenshot = snapshot({ first, second, firstChunksAtStop: firstShotChunks });

  // Stop button: stop-answer from the answer window mid-stream.
  reset();
  useProvider();
  await ipc('send-chat-message', 'chat', 'Design a URL shortener');
  [first] = startedIds();
  await waitForChunks(first, 3);
  const stopChunks = chunksFor(first).length;
  const ipcResults = {};
  ipcResults.wrongId = await ipc('stop-answer', 'llmResponse', 'chat-1-1');
  ipcResults.stop = await ipc('stop-answer', 'llmResponse', first);
  await sleep(250);
  ipcResults.again = await ipc('stop-answer', 'chat');
  for (const [label, value] of Object.entries({
    object: { id: first }, number: 7, empty: '', path: '../../etc/passwd', long: `chat-${'1'.repeat(40)}-1`, proto: '__proto__',
  })) {
    ipcResults[`bad ${label}`] = await ipc('stop-answer', 'chat', value);
  }
  scenarios.userStop = snapshot({ first, chunksAtStop: stopChunks, ipc: ipcResults });

  // Stop before any text arrived ("Thinking…"), from chat without an id.
  reset();
  useProvider({ intervalMs: 400 });
  await ipc('send-chat-message', 'chat', 'Slow question');
  [first] = startedIds();
  await sleep(50);
  const early = await ipc('stop-answer', 'chat');
  await sleep(500);
  scenarios.stopEarly = snapshot({ first, ipc: { early } });

  // The stop shortcut's handler.
  reset();
  useProvider();
  controller.handleTranscriptionFragment('What are your strengths?');
  await waitFor(() => startedIds().length === 1, 'the voice answer');
  [first] = startedIds();
  await waitForChunks(first, 2);
  const stoppedByShortcut = controller.stopActiveAnswer('user');
  await sleep(250);
  scenarios.shortcut = snapshot({ first, stoppedByShortcut });

  // Voice answered in chat only (WHISPER_RESPONSE_TARGET=chat) replaces a
  // typed answer: the answer window is not told about the new one, so it
  // gets the stopped answer instead of staying on "Writing".
  reset();
  useProvider();
  process.env.WHISPER_RESPONSE_TARGET = 'chat';
  await ipc('send-chat-message', 'chat', 'What is sharding?');
  [first] = startedIds();
  await waitForChunks(first, 2);
  controller.handleTranscriptionFragment('And replication?');
  await waitFor(() => startedIds().length === 2, 'the chat-only voice answer');
  second = startedIds()[1];
  await waitForFinal(second);
  delete process.env.WHISPER_RESPONSE_TARGET;
  scenarios.voiceChatOnly = snapshot({ first, second });

  // A voice utterance too short to answer does not stop the running answer.
  reset();
  useProvider();
  await ipc('send-chat-message', 'chat', 'What is a mutex?');
  [first] = startedIds();
  await waitForChunks(first, 2);
  controller.handleTranscriptionFragment('a');
  await sleep(120);
  await waitForFinal(first);
  scenarios.shortUtterance = snapshot({ first });

  // The Stop shortcut through one answer's life, and the next answer's.
  const terminal = (id) => events.some((e) => idOf(e) === id &&
    ((e.to === 'chat' && e.channel === 'transcription-llm-response') || e.channel === 'llm-error'));
  const idOf = (e) => e.data && (e.data.messageId || (e.data.metadata && e.data.metadata.messageId));
  const lifecycle = {};
  reset();
  useProvider();
  lifecycle.idle = stopHeld();
  await ipc('send-chat-message', 'chat', 'What is a heap?');
  [first] = startedIds();
  await waitForChunks(first, 2);
  lifecycle.firstStreaming = stopHeld();
  await ipc('send-chat-message', 'chat', 'And a stack?');
  second = startedIds()[1];
  await waitForChunks(second, 2);
  lifecycle.replacedStreaming = stopHeld();
  lifecycle.callsWhileReplacing = stopCalls();
  await waitForFinal(second);
  await sleep(20);
  lifecycle.finished = stopHeld();
  lifecycle.callsAfterFinish = stopCalls();

  // Stop button.
  reset();
  await ipc('send-chat-message', 'chat', 'What is a trie?');
  [first] = startedIds();
  await waitForChunks(first, 2);
  lifecycle.nextAnswerStreaming = stopHeld();
  await ipc('stop-answer', 'chat', first);
  await sleep(20);
  lifecycle.afterStopButton = stopHeld();
  lifecycle.callsStopButton = stopCalls();

  // The shortcut itself, as the system would call it.
  reset();
  await ipc('send-chat-message', 'chat', 'What is a B-tree?');
  [first] = startedIds();
  await waitForChunks(first, 2);
  owned.get(STOP)();
  await sleep(20);
  lifecycle.shortcutStopped = events.some((e) => e.channel === 'transcription-llm-response' && idOf(e) === first && e.data.stopped === true);
  lifecycle.afterShortcut = stopHeld();
  lifecycle.callsShortcut = stopCalls();

  // The provider fails part way: an error ends the answer.
  reset();
  const errorLogsFrom = logs.length;
  llmService.provider = new OpenAICompatibleProvider({
    apiKey: 'test-key', baseURL: 'http://127.0.0.1:9/v1', label: 'OpenAI', timeout: 5000, idleTimeoutMs: 5000,
    clientOptions: {
      // A rejected key: not retried.
      fetch: async () => {
        await sleep(80);
        return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }),
          { status: 401, headers: { 'content-type': 'application/json' } });
      },
    },
  });
  await ipc('send-chat-message', 'chat', 'What is a graph?');
  [first] = startedIds();
  await sleep(20);
  lifecycle.failingStreaming = stopHeld();
  await waitFor(() => terminal(first), 'the failed answer to end');
  await sleep(20);
  lifecycle.afterError = stopHeld();
  lifecycle.callsError = stopCalls();
  logs.splice(errorLogsFrom); // the failure's own error logs are expected

  // Another app owns the keys: both answers work, the failure is logged
  // once, and nothing is unregistered.
  reset();
  useProvider({ intervalMs: 5 });
  heldElsewhere = STOP;
  const warnsFrom = logs.length;
  for (const question of ['What is a queue?', 'What is a deque?']) {
    await ipc('send-chat-message', 'chat', question);
    const id = startedIds().slice(-1)[0];
    await waitForFinal(id);
  }
  await sleep(20);
  lifecycle.heldFinals = startedIds().filter((id) => events.some((e) => e.channel === 'transcription-llm-response' &&
    idOf(e) === id && e.to !== 'llmResponse' && !e.data.stopped)).length;
  lifecycle.heldCalls = stopCalls();
  lifecycle.heldWarnings = logs.slice(warnsFrom).filter((l) => l.level === 'warn' && /Stop shortcut/.test(l.message)).length;
  lifecycle.heldInfo = stopInfo();
  // The other app lets go: the next answer gets the shortcut again.
  heldElsewhere = null;
  reset();
  await ipc('send-chat-message', 'chat', 'What is a ring buffer?');
  [first] = startedIds();
  await waitForChunks(first, 2);
  lifecycle.releasedStreaming = stopHeld();
  await waitForFinal(first);
  await sleep(20);
  lifecycle.releasedInfo = stopInfo();
  lifecycle.releasedAfter = stopHeld();

  // Quitting while an answer is written: everything is released, and the
  // answer ending afterwards registers nothing.
  reset();
  useProvider();
  await ipc('send-chat-message', 'chat', 'What is a skip list?');
  [first] = startedIds();
  await waitForChunks(first, 2);
  lifecycle.beforeQuit = stopHeld();
  controller.isQuitting = true; // onBeforeQuit sets this first
  try {
    controller.onWillQuit();
  } catch (error) {
    lifecycle.quitError = error.message;
  }
  lifecycle.afterQuit = stopHeld();
  await waitForFinal(first);
  await sleep(20);
  lifecycle.afterQuitAnswerEnded = stopHeld();
  lifecycle.callsQuit = stopCalls();
  scenarios.stopShortcut = lifecycle;

  return {
    scenarios,
    errors: logs.filter((l) => l.level === 'error'),
    stopLogs: logs.filter((l) => l.message === 'Answer stopped').map((l) => l.meta),
  };
}

const root = process.argv[2];
if (root) {
  run(root)
    .then((output) => {
      process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(output)}\n`, () => process.exit(0));
    })
    .catch((error) => {
      const fatal = { fatal: error && error.stack, debug: error && error.debug };
      process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(fatal)}\n`, () => process.exit(1));
    });
}

module.exports = { RESULT_MARKER, PIECES };
