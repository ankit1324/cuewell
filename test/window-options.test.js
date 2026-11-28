'use strict';
// BrowserWindow options from the window manager: no vibrancy, opaque native
// windows only where the page is an opaque card with no see-through parts,
// the paper color of the current theme as their background, --si-theme for
// the preload, and live theme changes sent to every window.
//
// The window manager is loaded in this process under the electron mock with
// a BrowserWindow that records its options; loadFile rejects, so createWindow
// stops right after the window is set up.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT } = require('./helpers/source');
const { createElectronMock, installElectronMock } = require('./helpers/electron-mock');

const TYPES = ['main', 'chat', 'llmResponse', 'settings', 'onboarding'];
const PAPER = { light: '#f6f1e7', dark: '#211f1a' };
const PAPER_2 = { light: '#efe8db', dark: '#2a2822' }; // onboarding's card

const created = [];
class RecordingWindow {
  constructor(options) {
    this.options = options;
    this.handlers = {};
    this.sent = [];
    this.webContents = {
      id: created.length + 1,
      once: () => {},
      on: (name, fn) => { this.handlers[name] = fn; },
      setWindowOpenHandler: () => {},
      send: (channel, data) => this.sent.push([channel, data]),
    };
    created.push(this);
  }
  isDestroyed() { return false; }
  setBackgroundColor(color) { this.backgrounds = [...(this.backgrounds || []), color]; }
  loadFile() { return Promise.reject(new Error('stop: test window')); }
  static getAllWindows() { return []; }
}

let windowManager;
let electron;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const setPlatform = (value) => Object.defineProperty(process, 'platform', { ...realPlatform, value });

before(() => {
  const loggerFile = require.resolve(path.join(ROOT, 'src', 'core', 'logger.js'));
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  require.cache[loggerFile] = {
    id: loggerFile, filename: loggerFile, loaded: true, children: [], paths: [],
    exports: { createServiceLogger: () => quiet, ...quiet },
  };
  ({ electron } = createElectronMock({ userData: path.join(ROOT, 'no-user-data'), appData: ROOT, appPath: ROOT }));
  electron.BrowserWindow = RecordingWindow;
  electron.nativeTheme.shouldUseDarkColors = false;
  electron.nativeTheme.on = () => {};
  installElectronMock(electron);
  windowManager = require(path.join(ROOT, 'src', 'managers', 'window.manager.js'));
});

after(() => Object.defineProperty(process, 'platform', realPlatform));

async function optionsFor(type, platform) {
  setPlatform(platform);
  try {
    const before = created.length;
    await assert.rejects(windowManager.createWindow(type), /stop: test window/);
    assert.equal(created.length, before + 1);
    return created[created.length - 1];
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
  }
}

describe('window options', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    describe(platform, () => {
      it('asks for no vibrancy or visual effect state', async () => {
        for (const type of TYPES) {
          const { options } = await optionsFor(type, platform);
          assert.equal(options.vibrancy, undefined, type);
          assert.equal(options.visualEffectState, undefined, type);
        }
      });

      it('keeps the toolbar transparent (tab margin, popover, notice)', async () => {
        const { options } = await optionsFor('main', platform);
        assert.equal(options.transparent, true);
        assert.equal(options.backgroundColor, '#00000000');
      });

      it('draws Settings on an opaque window filled with the paper color', async () => {
        windowManager.setTheme('light');
        const { options } = await optionsFor('settings', platform);
        assert.equal(options.transparent, false);
        assert.equal(options.backgroundColor, PAPER.light);
      });

      it('passes the window type and theme to the preload', async () => {
        windowManager.setTheme('dark');
        const { options } = await optionsFor('chat', platform);
        assert.deepEqual(options.webPreferences.additionalArguments, ['--si-window=chat', '--si-theme=dark']);
        assert.equal(options.webPreferences.sandbox, true);
        assert.equal(options.webPreferences.contextIsolation, true);
        assert.equal(options.webPreferences.nodeIntegration, false);
        windowManager.setTheme('system');
      });
    });
  }

  it('makes the chat, answer and onboarding windows opaque on macOS, with native corners and shadow', async () => {
    windowManager.setTheme('dark');
    for (const type of ['chat', 'llmResponse', 'onboarding']) {
      const { options } = await optionsFor(type, 'darwin');
      assert.equal(options.transparent, false, type);
      assert.equal(options.backgroundColor, type === 'onboarding' ? PAPER_2.dark : PAPER.dark, type);
      assert.equal(options.hasShadow, true, type);
      assert.equal(options.roundedCorners, true, type);
    }
    windowManager.setTheme('system');
  });

  it('keeps them transparent on Windows and Linux, for the card\'s rounded corners', async () => {
    for (const platform of ['win32', 'linux']) {
      for (const type of ['chat', 'llmResponse', 'onboarding']) {
        const { options } = await optionsFor(type, platform);
        assert.equal(options.transparent, true, `${platform} ${type}`);
        assert.ok([undefined, '#00000000'].includes(options.backgroundColor), `${platform} ${type}: ${options.backgroundColor}`);
      }
    }
  });

  it('resolves "system" from the OS appearance', async () => {
    windowManager.setTheme('system');
    electron.nativeTheme.shouldUseDarkColors = true;
    assert.equal(windowManager.getPaperColor(), PAPER.dark);
    electron.nativeTheme.shouldUseDarkColors = false;
    assert.equal(windowManager.getPaperColor(), PAPER.light);
    const { options } = await optionsFor('settings', 'darwin');
    assert.equal(options.backgroundColor, PAPER.light);
  });

  it('sends the current theme again when a page loads (reload)', async () => {
    windowManager.setTheme('dark');
    const win = await optionsFor('llmResponse', 'darwin');
    assert.equal(typeof win.handlers['dom-ready'], 'function');
    win.handlers['dom-ready']();
    assert.deepEqual(win.sent, [['theme-changed', { theme: 'dark' }]]);
    assert.deepEqual(win.backgrounds, [PAPER.dark], 'the opaque window is repainted too');
    windowManager.setTheme('system');
  });
});

describe('setTheme', () => {
  function fakeWindow() {
    const win = { sent: [], backgrounds: [], destroyed: false };
    win.isDestroyed = () => win.destroyed;
    win.setBackgroundColor = (color) => win.backgrounds.push(color);
    win.webContents = { send: (channel, data) => win.sent.push([channel, data]) };
    return win;
  }

  it('broadcasts theme-changed to every window and repaints the opaque ones', () => {
    setPlatform('darwin');
    const saved = new Map(windowManager.windows);
    try {
      const wins = Object.fromEntries(TYPES.map((type) => [type, fakeWindow()]));
      windowManager.windows = new Map(Object.entries(wins));
      assert.equal(windowManager.setTheme('dark'), 'dark');
      for (const type of TYPES) assert.deepEqual(wins[type].sent, [['theme-changed', { theme: 'dark' }]], type);
      assert.deepEqual(wins.main.backgrounds, [], 'the toolbar stays transparent');
      for (const type of ['chat', 'llmResponse', 'settings']) {
        assert.deepEqual(wins[type].backgrounds, [PAPER.dark], type);
      }
      assert.deepEqual(wins.onboarding.backgrounds, [PAPER_2.dark]);
      assert.equal(windowManager.setTheme('light'), 'light');
      assert.deepEqual(wins.settings.backgrounds, [PAPER.dark, PAPER.light]);
    } finally {
      windowManager.windows = saved;
      Object.defineProperty(process, 'platform', realPlatform);
      windowManager.setTheme('system');
    }
  });

  it('repaints only Settings on Windows and Linux (the other panels are transparent)', () => {
    const saved = new Map(windowManager.windows);
    try {
      for (const platform of ['win32', 'linux']) {
        setPlatform(platform);
        const wins = Object.fromEntries(TYPES.map((type) => [type, fakeWindow()]));
        windowManager.windows = new Map(Object.entries(wins));
        windowManager.setTheme('dark');
        assert.deepEqual(wins.settings.backgrounds, [PAPER.dark], platform);
        for (const type of ['main', 'chat', 'llmResponse', 'onboarding']) {
          assert.deepEqual(wins[type].backgrounds, [], `${platform} ${type}`);
          assert.deepEqual(wins[type].sent, [['theme-changed', { theme: 'dark' }]], `${platform} ${type}`);
        }
        windowManager.setTheme('system');
      }
    } finally {
      windowManager.windows = saved;
      Object.defineProperty(process, 'platform', realPlatform);
      windowManager.setTheme('system');
    }
  });

  it('reaches a window whose page is still loading (not yet in the window list)', () => {
    const saved = new Map(windowManager.windows);
    const savedAll = RecordingWindow.getAllWindows;
    try {
      setPlatform('darwin');
      const loading = fakeWindow();
      loading.webContents.id = 4242;
      windowManager.webContentsTypes.set(4242, 'onboarding');
      RecordingWindow.getAllWindows = () => [loading];
      windowManager.windows = new Map();
      windowManager.setTheme('dark');
      assert.deepEqual(loading.sent, [['theme-changed', { theme: 'dark' }]]);
      assert.deepEqual(loading.backgrounds, [PAPER_2.dark]);
    } finally {
      RecordingWindow.getAllWindows = savedAll;
      windowManager.webContentsTypes.delete(4242);
      windowManager.windows = saved;
      Object.defineProperty(process, 'platform', realPlatform);
      windowManager.setTheme('system');
    }
  });

  it('ignores an unknown theme and skips destroyed windows', () => {
    const saved = new Map(windowManager.windows);
    try {
      const live = fakeWindow();
      const gone = fakeWindow();
      gone.destroyed = true;
      windowManager.windows = new Map([['settings', live], ['chat', gone]]);
      windowManager.setTheme('light');
      for (const bad of ['sepia', '', undefined, { theme: 'dark' }]) {
        assert.equal(windowManager.setTheme(bad), 'light', String(bad));
      }
      assert.equal(windowManager.theme, 'light');
      assert.deepEqual(live.sent, [['theme-changed', { theme: 'light' }]]);
      assert.deepEqual(gone.sent, []);
    } finally {
      windowManager.windows = saved;
      windowManager.setTheme('system');
    }
  });
});
