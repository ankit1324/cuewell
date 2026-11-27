/**
 * Menu templates for Menu.buildFromTemplate. Kept free of Electron so they
 * can be checked without starting the app.
 *
 * - macOS gets a full menu bar: Cuewell, Edit, Window, Help.
 * - Windows and Linux windows are frameless, so their menu bar is never
 *   drawn. The same menus are set anyway (Edit roles keep text editing
 *   standard), minus the app menu and Ctrl+Q.
 * - The toolbar menu holds the app commands (About, updates, Settings, help,
 *   Quit) for Windows and Linux, where the menu bar cannot be reached.
 * - Reload and Developer Tools only exist when running from source.
 *
 * Accelerators shown here that are also global shortcuts (registered in
 * main.js) must not run twice: Windows and Linux skip registering them
 * (registerAccelerator: false), and on macOS a key press that reaches the
 * menu is ignored while the global shortcut is registered. When another app
 * owns the shortcut, the menu handles the key instead.
 *
 * Hide and Quit carry no app name: the app icon setting can show Cuewell
 * under another name.
 */

const ELLIPSIS = '\u2026';

/**
 * @param {object} options
 * @param {string} options.platform           process.platform
 * @param {boolean} options.isPackaged        app.isPackaged
 * @param {boolean} options.updatesConfigured UPDATE_REPO is set
 * @param {boolean} options.reportConfigured  the issues link is set
 * @param {object} options.actions            about, checkForUpdates, settings, hide, quit,
 *                                            reportProblem, openLogsFolder, toggleWindows, toggleChat
 * @param {Function} [options.isShortcutRegistered] globalShortcut.isRegistered
 */
function buildAppMenuTemplate({ platform, isPackaged, updatesConfigured, reportConfigured, actions,
  isShortcutRegistered = () => false }) {
  const isMac = platform === 'darwin';
  const call = (name) => () => actions[name]();
  // An item whose accelerator is a global shortcut: shown, never run twice.
  const globalItem = (label, accelerator, name) => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: (_item, _window, event) => {
      if (event && event.triggeredByAccelerator && isShortcutRegistered(accelerator)) return;
      actions[name]();
    },
  });

  const template = [];

  if (isMac) {
    template.push({
      label: 'Cuewell',
      submenu: [
        { label: 'About Cuewell', click: call('about') },
        ...(updatesConfigured ? [{ label: `Check for Updates${ELLIPSIS}`, click: call('checkForUpdates') }] : []),
        { type: 'separator' },
        globalItem(`Settings${ELLIPSIS}`, 'CommandOrControl+,', 'settings'),
        { type: 'separator' },
        { role: 'hide', label: 'Hide' },
        { role: 'hideOthers', label: 'Hide Others' },
        { role: 'unhide', label: 'Show All' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CommandOrControl+Q', click: call('quit') },
      ],
    });
  }

  template.push({ role: 'editMenu' });

  if (!isPackaged) {
    // Source runs only: packaged builds have no way to open DevTools.
    template.push({
      label: 'Developer',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
      ],
    });
  }

  // No Close or Minimize: the overlay windows have no frame to bring them
  // back, and Ctrl+W would close them for good on Windows and Linux.
  template.push({
    label: 'Window',
    submenu: [
      globalItem('Show or Hide All Windows', 'CommandOrControl+Shift+V', 'toggleWindows'),
      globalItem('Show or Hide Chat', 'CommandOrControl+Shift+C', 'toggleChat'),
      ...(isMac ? [{ type: 'separator' }, { role: 'front', label: 'Bring All to Front' }] : []),
    ],
  });

  template.push({
    role: 'help',
    label: 'Help',
    submenu: [
      ...(reportConfigured ? [{ label: `Report a Problem${ELLIPSIS}`, click: call('reportProblem') }] : []),
      { label: 'View Logs Folder', click: call('openLogsFolder') },
      ...(isMac ? [] : [{ type: 'separator' }, { label: 'About Cuewell', click: call('about') }]),
    ],
  });

  return template;
}

/** The app commands as a pop-up menu for the toolbar (every platform). */
function buildToolbarMenuTemplate({ updatesConfigured, reportConfigured, actions }) {
  const call = (name) => () => actions[name]();
  return [
    { label: 'About Cuewell', click: call('about') },
    ...(updatesConfigured ? [{ label: `Check for Updates${ELLIPSIS}`, click: call('checkForUpdates') }] : []),
    { type: 'separator' },
    { label: `Settings${ELLIPSIS}`, click: call('settings') },
    { type: 'separator' },
    ...(reportConfigured ? [{ label: `Report a Problem${ELLIPSIS}`, click: call('reportProblem') }] : []),
    { label: 'View Logs Folder', click: call('openLogsFolder') },
    { type: 'separator' },
    { label: 'Quit', click: call('quit') },
  ];
}

module.exports = { buildAppMenuTemplate, buildToolbarMenuTemplate };
