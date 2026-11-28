'use strict';
// preload.js and preload-content.js: each window type gets only its own
// methods, and every channel they reach is allowed for that window type in
// main.js's IPC_ALLOWED_WINDOWS. The preloads are run as Electron runs a
// sandboxed preload: a script with require('electron'), process and document.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readSource, loadConstant } = require('./helpers/source');

const IPC_ALLOWED_WINDOWS = loadConstant('main.js', 'IPC_ALLOWED_WINDOWS', { Object });
const PRELOAD_BY_TYPE = {
  main: 'preload.js',
  settings: 'preload.js',
  onboarding: 'preload.js',
  chat: 'preload-content.js',
  llmResponse: 'preload-content.js',
};

function runPreload(file, type, extraArgs = []) {
  const exposed = {};
  const calls = []; // { kind: 'invoke' | 'send' | 'on', channel }
  const handlers = new Map();
  const errors = [];
  const ipcRenderer = {
    invoke: (channel, ...args) => { calls.push({ kind: 'invoke', channel, args }); return Promise.resolve(); },
    send: (channel, ...args) => { calls.push({ kind: 'send', channel, args }); },
    on: (channel, fn) => { calls.push({ kind: 'on', channel }); handlers.set(channel, fn); },
    removeListener: (channel) => handlers.delete(channel),
  };
  const electron = {
    ipcRenderer,
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
  };
  const fakeRequire = (name) => {
    if (name !== 'electron') throw new Error(`preload may not require ${name}`);
    return electron;
  };
  const fakeProcess = { platform: 'darwin', argv: ['electron', '.', ...(type ? [`--si-window=${type}`] : []), ...extraArgs] };
  const fakeDocument = { documentElement: { dataset: {} }, addEventListener: () => {}, removeEventListener: () => {} };
  const fakeConsole = { log: () => {}, warn: () => {}, error: (...args) => errors.push(args.join(' ')) };
  const body = readSource(file);
  new Function('require', 'process', 'document', 'console', body)(fakeRequire, fakeProcess, fakeDocument, fakeConsole);
  return { exposed, calls, handlers, errors, document: fakeDocument };
}

/**
 * Call every exposed method once, then deliver every event the preload
 * listens for once (a preload may answer an event itself, e.g. the quit
 * flush ack), and return the channels each kind reached.
 */
function exercise(file, type) {
  const run = runPreload(file, type);
  const received = [];
  for (const api of Object.values(run.exposed)) {
    for (const [name, value] of Object.entries(api)) {
      if (typeof value !== 'function') continue;
      if (/^on[A-Z]/.test(name)) value((...args) => received.push({ name, args }));
      else value({}, {});
    }
  }
  // window.api.send only passes its own channels; try every channel there is.
  if (run.exposed.api && run.exposed.api.send) {
    for (const channel of [...Object.keys(IPC_ALLOWED_WINDOWS), 'evil-channel']) run.exposed.api.send(channel, {});
  }
  for (const handler of [...run.handlers.values()]) handler({ sender: {} }, { id: 1 });
  const outgoing = run.calls.filter((c) => c.kind !== 'on').map((c) => c.channel);
  return { ...run, outgoing: [...new Set(outgoing)].sort(), received };
}

describe('preloads', () => {
  for (const [type, file] of Object.entries(PRELOAD_BY_TYPE)) {
    describe(`${file} as ${type}`, () => {
      const run = exercise(file, type);

      it('exposes an API', () => {
        assert.ok(Object.keys(run.exposed).length > 0);
        assert.ok(run.exposed.electronAPI);
        assert.deepEqual(run.errors, []);
      });

      it('only reaches channels main.js allows for this window', () => {
        assert.ok(run.outgoing.length > 0);
        for (const channel of run.outgoing) {
          assert.ok(IPC_ALLOWED_WINDOWS[channel], `${channel} is not in IPC_ALLOWED_WINDOWS`);
          assert.ok(IPC_ALLOWED_WINDOWS[channel].includes(type), `${type} may not use ${channel}`);
        }
      });

      it('exposes no raw ipcRenderer or Node objects', () => {
        for (const api of Object.values(run.exposed)) {
          for (const [name, value] of Object.entries(api)) {
            assert.equal(typeof value, 'function', `${name} is not a function`);
          }
          assert.ok(!('ipcRenderer' in api));
          assert.ok(!('invoke' in api));
        }
      });

      it('never passes the IPC event to page callbacks', () => {
        const fakeEvent = { sender: { secret: 'ipcRenderer' } };
        for (const [channel, handler] of run.handlers) handler(fakeEvent, { channel });
        assert.ok(run.received.length > 0);
        for (const { name, args } of run.received) {
          assert.ok(!args.includes(fakeEvent), `${name} got the IPC event`);
        }
      });
    });
  }

  it('IPC_ALLOWED_WINDOWS grants no window a channel its preload never uses', () => {
    const used = Object.fromEntries(Object.entries(PRELOAD_BY_TYPE).map(([type, file]) => [type, exercise(file, type).outgoing]));
    for (const [channel, types] of Object.entries(IPC_ALLOWED_WINDOWS)) {
      for (const type of types) {
        assert.ok(used[type].includes(channel), `${type} is allowed ${channel} but its preload never sends it`);
      }
    }
  });

  it('preload.js gives each control page only its own methods', () => {
    const names = (type) => Object.keys(runPreload('preload.js', type).exposed.electronAPI).sort();
    assert.ok(!names('main').includes('getProfile'));
    assert.ok(!names('main').includes('testProvider'));
    assert.ok(!names('settings').includes('takeScreenshot'));
    assert.ok(!names('onboarding').includes('getSettings'));
    assert.ok(names('settings').includes('saveProfile'));
  });

  // window.api is the toolbar's receive-only channel API (main-window.js
  // listens through it). Settings calls electronAPI only, so it has none.
  it('window.api only receives its own channels and sends nothing', () => {
    const run = runPreload('preload.js', 'main');
    assert.deepEqual(Object.keys(run.exposed.api), ['receive']);
    // Only the preload's own theme listener is registered before the page asks.
    assert.deepEqual(run.calls, [{ kind: 'on', channel: 'theme-changed' }]);
    const before = run.calls.length;
    run.exposed.api.receive('install-progress', () => {});
    run.exposed.api.receive('skill-updated', 'not a function');
    run.exposed.api.receive('skill-updated', () => {});
    assert.deepEqual(run.calls.slice(before), [{ kind: 'on', channel: 'skill-updated' }]);
    for (const type of ['settings', 'onboarding']) assert.equal(runPreload('preload.js', type).exposed.api, undefined, type);
  });

  describe('Settings quit flush', () => {
    const acks = (run) => run.calls.filter((c) => c.channel === 'flush-before-quit-done').map((c) => c.args);

    it('acks on the next task when the page set no callback', async () => {
      const run = runPreload('preload.js', 'settings');
      run.handlers.get('flush-before-quit')({ sender: {} }, { id: 7 });
      assert.deepEqual(acks(run), []);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(acks(run), [[7]]);
    });

    it('acks once, after the page\'s save settles, with the request id', async () => {
      const run = runPreload('preload.js', 'settings');
      let finish;
      run.exposed.electronAPI.onFlushBeforeQuit(() => new Promise((resolve) => { finish = resolve; }));
      run.handlers.get('flush-before-quit')({ sender: {} }, { id: 3 });
      await Promise.resolve();
      assert.deepEqual(acks(run), [], 'acked before the save finished');
      finish();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(acks(run), [[3]]);
    });

    it('still acks when the page\'s save throws or rejects, and sends no bad id', async () => {
      const run = runPreload('preload.js', 'settings');
      const off = run.exposed.electronAPI.onFlushBeforeQuit(() => { throw new Error('boom'); });
      run.handlers.get('flush-before-quit')({ sender: {} }, { id: 1 });
      off();
      run.exposed.electronAPI.onFlushBeforeQuit(() => Promise.reject(new Error('nope')));
      run.handlers.get('flush-before-quit')({ sender: {} }, { id: '2; evil' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(acks(run), [[1], [null]]);
      assert.equal(run.errors.length, 1);
    });
  });

  for (const file of ['preload.js', 'preload-content.js']) {
    it(`${file} exposes nothing for an unknown or missing window type`, () => {
      for (const type of ['', 'evil', 'Main', 'settings ']) {
        const run = runPreload(file, type);
        assert.deepEqual(run.exposed, {}, `type "${type}"`);
        assert.equal(run.errors.length, 1);
      }
    });

    // The window type comes from --si-window, which only the window manager
    // sets, so this is hardening: the PAGES lookup is own-property only, so
    // inherited names such as "constructor" or "__proto__" expose nothing.
    it(`${file} ignores inherited names as window types`, () => {
      for (const type of ['constructor', '__proto__', 'toString']) {
        let run;
        assert.doesNotThrow(() => { run = runPreload(file, type); }, `type "${type}"`);
        assert.deepEqual(run.exposed, {}, `type "${type}"`);
      }
    });
  }

  it('each preload exposes nothing for the other preload\'s window types', () => {
    for (const type of ['chat', 'llmResponse']) assert.deepEqual(runPreload('preload.js', type).exposed, {});
    for (const type of ['main', 'settings', 'onboarding']) assert.deepEqual(runPreload('preload-content.js', type).exposed, {});
  });

  it('sets the platform hook for CSS', () => {
    assert.equal(runPreload('preload.js', 'main').document.documentElement.dataset.platform, 'darwin');
  });

  describe('theme hook for CSS', () => {
    const PAGES = [['preload.js', 'main'], ['preload.js', 'settings'], ['preload.js', 'onboarding'],
      ['preload-content.js', 'chat'], ['preload-content.js', 'llmResponse']];
    const themeOf = (run) => run.document.documentElement.dataset.theme;

    for (const [file, type] of PAGES) {
      it(`${file} as ${type} sets html[data-theme] from --si-theme and follows theme-changed`, () => {
        const run = runPreload(file, type, ['--si-theme=dark']);
        assert.equal(themeOf(run), 'dark');
        const onTheme = run.handlers.get('theme-changed');
        assert.equal(typeof onTheme, 'function');
        onTheme({ sender: {} }, { theme: 'light' });
        assert.equal(themeOf(run), 'light');
        onTheme({ sender: {} }, { theme: 'system' });
        assert.equal(themeOf(run), 'system');
      });
    }

    for (const file of ['preload.js', 'preload-content.js']) {
      it(`${file} ignores unknown themes and defaults to system`, () => {
        assert.equal(themeOf(runPreload(file, 'main')), 'system', 'no --si-theme');
        assert.equal(themeOf(runPreload(file, 'main', ['--si-theme=sepia'])), 'system');
        const run = runPreload(file, 'chat', ['--si-theme=light']);
        const onTheme = run.handlers.get('theme-changed');
        for (const bad of [null, 'dark', { theme: 'Dark' }, { theme: 'dark" onload="x' }, { theme: ['dark'] }, { id: 1 }]) {
          onTheme({ sender: {} }, bad);
          assert.equal(themeOf(run), 'light', JSON.stringify(bad));
        }
      });
    }

    it('exposes nothing for the theme to the page', () => {
      for (const [file, type] of PAGES) {
        for (const api of Object.values(runPreload(file, type).exposed)) {
          assert.ok(!Object.keys(api).some((name) => /theme/i.test(name)), `${type} exposes a theme method`);
        }
      }
    });
  });
});
