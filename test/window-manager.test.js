'use strict';
// src/managers/window.manager.js with a mocked electron module and fake
// windows: hiding and showing, Settings and the answer window work with no
// screen-sharing state, and no background capture probe is left.
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir, stubLogger, clearAppEnv } = require('./helpers/env');
const { repoPath, readSource } = require('./helpers/source');
const { createElectronMock, installElectronMock } = require('./helpers/electron-mock');

function fakeWindow(type, { visible = false } = {}) {
  const sent = [];
  const win = {
    type,
    visible,
    sent,
    hideCalls: 0,
    isDestroyed: () => false,
    isVisible: () => win.visible,
    isFocused: () => false,
    hide: () => { win.hideCalls += 1; win.visible = false; },
    getPosition: () => [0, 0],
    getSize: () => [400, 300],
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  };
  return win;
}

describe('WindowManager', () => {
  let wm;
  let shown;

  before((t) => {
    clearAppEnv();
    stubLogger();
    const root = tempDir(t);
    const { electron } = createElectronMock({ userData: path.join(root, 'userData'), appData: root, appPath: repoPath() });
    installElectronMock(electron);
    wm = require('../src/managers/window.manager');
  });

  beforeEach(() => {
    shown = [];
    wm.windows = new Map(['main', 'chat', 'llmResponse', 'settings'].map((type) => [type, fakeWindow(type)]));
    wm.hiddenWindowTypes = null;
    wm.isVisible = false;
    wm._answerState = null;
    wm.showOnCurrentDesktop = (win, options = {}) => { shown.push({ type: win.type, focus: options.focus }); win.visible = true; };
  });

  it('has no screen-sharing mode or capture availability probe', () => {
    for (const name of ['isScreenBeingShared', 'wasVisibleBeforeSharing', 'screenCaptureStatus',
      'screenCaptureAvailabilityWatcher', 'isCheckingScreenCaptureStatus']) {
      assert.equal(name in wm, false, name);
    }
    for (const name of ['startScreenSharingMode', 'stopScreenSharingMode', 'enableScreenSharingMode',
      'disableScreenSharingMode', 'isInScreenSharingMode', 'handleScreenSharingStarted',
      'handleScreenSharingStopped', 'setupScreenCaptureAvailabilityWatcher', 'checkScreenCaptureAvailability']) {
      assert.equal(typeof wm[name], 'undefined', name);
    }
    // The 5-second desktopCapturer.getSources() probe is gone with it.
    assert.doesNotMatch(readSource('src/managers/window.manager.js'), /desktopCapturer/);
  });

  it('reports window stats without screen-sharing fields', () => {
    wm.windows = new Map([['main', fakeWindow('main', { visible: true })]]);
    const stats = wm.getWindowStats();
    assert.deepEqual(Object.keys(stats).sort(), ['activeWindow', 'isInteractive', 'isVisible', 'windows']);
    assert.deepEqual(stats.windows.main, { isVisible: true, isFocused: false, position: [0, 0], size: [400, 300] });
  });

  it('toggleVisibility hides every window, then restores the ones that were visible', () => {
    wm.windows.get('main').visible = true;
    wm.windows.get('chat').visible = true;
    wm.isVisible = true;

    assert.equal(wm.toggleVisibility(), false);
    for (const win of wm.windows.values()) assert.equal(win.visible, false, win.type);

    assert.equal(wm.toggleVisibility(), true);
    assert.deepEqual(shown, [{ type: 'main', focus: false }, { type: 'chat', focus: false }]);
  });

  it('showAllWindows brings back only the toolbar when nothing was recorded', () => {
    wm.showAllWindows();
    assert.deepEqual(shown, [{ type: 'main', focus: false }]);
    assert.equal(wm.isVisible, true);
  });

  it('showSettings reveals Settings and tells the page to reload', () => {
    const revealed = [];
    wm.windows.get('settings').visible = true; // already open: not re-centered
    wm.revealSettingsWindow = (win, options) => revealed.push({ type: win.type, ...options });
    wm.showSettings();
    assert.deepEqual(revealed, [{ type: 'settings', focus: true }]);
    assert.deepEqual(wm.windows.get('settings').sent.map((m) => m.channel), ['settings-window-shown']);
  });

  it('showLLMResponse sends the answer to a visible answer window', () => {
    const answer = wm.windows.get('llmResponse');
    answer.visible = true;
    wm.showLLMResponse('Hello', { skill: 'dsa' });
    assert.equal(answer.sent.length, 1);
    assert.equal(answer.sent[0].channel, 'display-llm-response');
    assert.equal(answer.sent[0].payload.content, 'Hello');
    assert.equal(answer.sent[0].payload.appearing, false);
  });

  it('revealAnswerWindow shows the answer unless every window was hidden meanwhile', () => {
    wm.isVisible = true;
    wm.answerState().revealWhileVisible = true;
    wm.revealAnswerWindow();
    assert.deepEqual(shown, [{ type: 'llmResponse', focus: false }]);

    shown.length = 0;
    wm.windows.get('llmResponse').visible = false;
    wm.isVisible = false;
    wm.answerState().revealWhileVisible = true;
    wm.revealAnswerWindow();
    assert.deepEqual(shown, []);
  });
});
