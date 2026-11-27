'use strict';
// A stand-in for the `electron` module, enough for main.js and the window
// manager to load in plain Node. app.whenReady() never resolves, so no
// window is ever created; ipcMain records handlers so tests can call them
// with fake senders. Unknown members are no-op stubs.
const Module = require('node:module');
const path = require('node:path');

/** A callable that returns itself for any call or property, e.g. app.dock.hide(). */
function stub(name = 'stub') {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(target, prop) {
      if (prop === 'then') return undefined; // not a thenable
      if (prop === Symbol.toPrimitive) return () => name;
      if (prop === 'toString') return () => name;
      if (!(prop in target)) target[prop] = stub(`${name}.${String(prop)}`);
      return target[prop];
    },
    apply() { return proxy; },
    construct() { return proxy; },
  });
  return proxy;
}

/** Fill in missing members of `object` with stubs. */
function withStubs(object, name) {
  return new Proxy(object, {
    get(target, prop) {
      if (prop in target || typeof prop === 'symbol') return target[prop];
      target[prop] = stub(`${name}.${String(prop)}`);
      return target[prop];
    },
  });
}

function createElectronMock({ userData, appData, appPath, isPackaged = false }) {
  const handlers = new Map();
  const listeners = new Map();
  const paths = { userData, appData, home: path.dirname(userData), temp: path.dirname(userData), logs: userData };

  const app = withStubs({
    isPackaged,
    getPath: (name) => {
      if (!paths[name]) throw new Error(`No mock path for ${name}`);
      return paths[name];
    },
    getAppPath: () => appPath,
    getName: () => 'Cuewell',
    setName: () => {},
    getVersion: () => '0.0.0-test',
    whenReady: () => new Promise(() => {}),
    isReady: () => false,
    on: () => app,
    once: () => app,
    quit: () => {},
    exit: () => {},
    requestSingleInstanceLock: () => true,
    disableHardwareAcceleration: () => {},
    commandLine: { appendSwitch: () => {}, hasSwitch: () => false },
  }, 'app');

  const ipcMain = withStubs({
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error(`Second handler for ${channel}`);
      handlers.set(channel, fn);
    },
    on: (channel, fn) => {
      if (listeners.has(channel)) throw new Error(`Second listener for ${channel}`);
      listeners.set(channel, fn);
    },
    removeHandler: (channel) => handlers.delete(channel),
  }, 'ipcMain');

  class BrowserWindow {
    static getAllWindows() { return []; }
    static getFocusedWindow() { return null; }
    static fromWebContents() { return null; }
  }

  const electron = withStubs({
    app,
    ipcMain,
    BrowserWindow,
    globalShortcut: withStubs({ register: () => true, isRegistered: () => false, unregister: () => {} }, 'globalShortcut'),
    nativeTheme: withStubs({ themeSource: 'system' }, 'nativeTheme'),
    session: stub('session'),
    Menu: stub('Menu'),
    screen: stub('screen'),
    desktopCapturer: stub('desktopCapturer'),
    shell: stub('shell'),
    clipboard: withStubs({ writeText: () => {}, readText: () => '' }, 'clipboard'),
  }, 'electron');

  return { electron, handlers, listeners };
}

/** Make require('electron') return `electron` from now on. */
function installElectronMock(electron) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
}

module.exports = { createElectronMock, installElectronMock };
