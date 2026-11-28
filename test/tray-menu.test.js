'use strict';
// src/core/tray.js: the menu template of the menu bar / tray icon.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildTrayMenuTemplate, trayIconFile } = require('../src/core/tray');

const ACTIONS = ['toggleWindows', 'screenshot', 'openChat', 'settings', 'checkForUpdates', 'finishSetup', 'quit'];

function menu(options = {}) {
  const called = [];
  const actions = Object.fromEntries(ACTIONS.map((name) => [name, () => called.push(name)]));
  const template = buildTrayMenuTemplate({ appName: 'Cuewell', updatesConfigured: true, actions, ...options });
  return { template, called, labels: template.filter((item) => item.label).map((item) => item.label) };
}

describe('buildTrayMenuTemplate', () => {
  it('lists the everyday commands, all enabled, once setup is done', () => {
    const { template, labels, called } = menu();
    assert.deepEqual(labels, [
      'Show/Hide Cuewell', 'Take Screenshot', 'Open Chat', 'Settings\u2026', 'Check for Updates\u2026', 'Quit Cuewell',
    ]);
    // Electron treats a missing `enabled` as true.
    for (const item of template) assert.notEqual(item.enabled, false, `${item.label || item.type} is disabled`);
    template.filter((item) => item.click).forEach((item) => item.click());
    assert.deepEqual(called, ['toggleWindows', 'screenshot', 'openChat', 'settings', 'checkForUpdates', 'quit']);
  });

  it('ignores the removed screenShared option', () => {
    assert.deepEqual(menu({ screenShared: true }).labels, menu().labels);
  });

  it('offers Finish Setup instead of the window commands during onboarding', () => {
    const { labels } = menu({ setupNeeded: true, updatesConfigured: false });
    assert.deepEqual(labels, ['Finish Setup\u2026', 'Settings\u2026', 'Quit Cuewell']);
  });

  it('uses the name the app shows now, and Cuewell when it is blank', () => {
    assert.ok(menu({ appName: 'Terminal' }).labels.includes('Quit Terminal'));
    assert.ok(menu({ appName: '  ' }).labels.includes('Show/Hide Cuewell'));
  });

  it('shows a shortcut only when the global shortcut works, and never registers it', () => {
    const { template } = menu({ isShortcutRegistered: (accelerator) => accelerator === 'CommandOrControl+Shift+S' });
    const screenshot = template.find((item) => item.label === 'Take Screenshot');
    assert.equal(screenshot.accelerator, 'CommandOrControl+Shift+S');
    assert.equal(screenshot.registerAccelerator, false);
    assert.equal(template.find((item) => item.label === 'Open Chat').accelerator, undefined);
  });
});

describe('trayIconFile', () => {
  it('picks the icon for each system', () => {
    assert.equal(trayIconFile('darwin'), path.join('assests', 'icons', 'trayTemplate.png'));
    assert.equal(trayIconFile('win32'), path.join('assests', 'icons', 'app-icon.ico'));
    assert.equal(trayIconFile('linux'), path.join('assests', 'icons', 'tray-icon.png'));
  });
});
