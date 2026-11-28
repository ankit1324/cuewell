'use strict';
// Answer and chat window opacity in the window manager: applied to those two
// windows only, live, clamped to 40% to 100%, kept through the macOS fade-in,
// and skipped where setOpacity does nothing (Linux).
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { tempDir, stubLogger, clearAppEnv } = require('./helpers/env');
const { repoPath, readSource } = require('./helpers/source');
const { createElectronMock, installElectronMock } = require('./helpers/electron-mock');

let nextId = 1;
function fakeWindow(wm, type) {
  const id = nextId++;
  const win = {
    id,
    type,
    opacity: 1,
    opacityCalls: [],
    destroyed: false,
    isDestroyed: () => win.destroyed,
    setOpacity: (value) => { win.opacity = value; win.opacityCalls.push(value); },
    webContents: { id: 9000 + id, isDestroyed: () => false, send: () => {} },
  };
  wm.webContentsTypes.set(win.webContents.id, type);
  return win;
}

describe('window opacity (window manager)', () => {
  let wm;

  before((t) => {
    clearAppEnv();
    stubLogger();
    const root = tempDir(t);
    const { electron } = createElectronMock({ userData: path.join(root, 'userData'), appData: root, appPath: repoPath() });
    installElectronMock(electron);
    wm = require('../src/managers/window.manager');
  });

  beforeEach(() => {
    wm.windows = new Map(['main', 'chat', 'llmResponse', 'settings', 'onboarding'].map((type) => [type, fakeWindow(wm, type)]));
    wm.windowFades = new Map();
    wm.supportsWindowOpacity = () => true;
    wm.contentOpacity = 1;
  });

  it('starts opaque', () => {
    assert.equal(wm.getContentOpacityPercent(), 100);
  });

  it('applies to the answer and chat windows only, live', () => {
    assert.equal(wm.setContentOpacity(70), 70);
    assert.equal(wm.windows.get('llmResponse').opacity, 0.7);
    assert.equal(wm.windows.get('chat').opacity, 0.7);
    for (const type of ['main', 'settings', 'onboarding']) {
      assert.deepEqual(wm.windows.get(type).opacityCalls, [], `${type} was made see-through`);
    }
    wm.setContentOpacity(100);
    assert.equal(wm.windows.get('llmResponse').opacity, 1);
    assert.equal(wm.windows.get('chat').opacity, 1);
  });

  it('never goes below 40% or above 100%, and ignores a value that is not a number', () => {
    assert.equal(wm.setContentOpacity(10), 40);
    assert.equal(wm.windows.get('chat').opacity, 0.4);
    assert.equal(wm.setContentOpacity(250), 100);
    assert.equal(wm.setContentOpacity(64.6), 65);
    assert.equal(wm.setContentOpacity('abc'), 65);
    assert.equal(wm.setContentOpacity(NaN), 65);
    assert.equal(wm.setContentOpacity(undefined), 65);
    assert.equal(wm.windows.get('llmResponse').opacity, 0.65);
  });

  it('skips destroyed windows', () => {
    wm.windows.get('chat').destroyed = true;
    wm.setContentOpacity(50);
    assert.deepEqual(wm.windows.get('chat').opacityCalls, []);
    assert.equal(wm.windows.get('llmResponse').opacity, 0.5);
  });

  it('remembers the value but calls nothing where setOpacity does nothing (Linux)', () => {
    wm.supportsWindowOpacity = () => false;
    assert.equal(wm.setContentOpacity(60), 60);
    assert.deepEqual(wm.windows.get('chat').opacityCalls, []);
    assert.deepEqual(wm.windows.get('llmResponse').opacityCalls, []);
  });

  it('is supported on macOS and Windows only', () => {
    delete wm.supportsWindowOpacity; // the class method
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      for (const [platform, expected] of [['darwin', true], ['win32', true], ['linux', false]]) {
        Object.defineProperty(process, 'platform', { value: platform });
        assert.equal(wm.supportsWindowOpacity(), expected, platform);
      }
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it('the macOS fade-in ends at the setting, and a hide mid-fade restores it', async () => {
    wm.setContentOpacity(60);
    const answer = wm.windows.get('llmResponse');
    answer.opacityCalls.length = 0;
    wm.fadeInWindow(answer);
    await sleep(320);
    assert.ok(answer.opacityCalls.length > 2, 'no fade');
    assert.ok(answer.opacityCalls.every((value) => value <= 0.6 + 1e-9), `went above the setting: ${answer.opacityCalls}`);
    assert.equal(answer.opacity, 0.6);

    wm.fadeInWindow(answer);
    await sleep(20);
    wm.stopWindowFade(answer);
    assert.equal(answer.opacity, 0.6);

    // A change during the fade is where the fade ends; it is not applied over it.
    wm.fadeInWindow(answer);
    await sleep(20);
    const callsBefore = answer.opacityCalls.length;
    wm.setContentOpacity(80);
    assert.equal(answer.opacityCalls.length, callsBefore, 'set during the fade');
    await sleep(320);
    assert.equal(answer.opacity, 0.8);

    // Other windows still fade to full opacity.
    const main = wm.windows.get('main');
    wm.fadeInWindow(main);
    await sleep(320);
    assert.equal(main.opacity, 1);
  });

  it('new answer and chat windows get the setting when they are created', () => {
    const source = readSource('src/managers/window.manager.js');
    assert.match(source, /this\.windows\.set\('chat', window\);\s*\n\s*this\.applyContentOpacity\(window, 'chat'\);/);
    assert.match(source, /this\.windows\.set\('llmResponse', window\);\s*\n\s*this\.applyContentOpacity\(window, 'llmResponse'\);/);
  });

  it('leaves content protection and click-through alone', () => {
    const source = readSource('src/managers/window.manager.js');
    const body = source.slice(source.indexOf('  setContentOpacity(percent)'), source.indexOf('  applyContentOpacity(win, type)') + 600);
    assert.doesNotMatch(body, /setContentProtection|setIgnoreMouseEvents|setBackgroundColor/);
  });
});
