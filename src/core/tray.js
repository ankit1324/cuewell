/**
 * Menu bar icon (macOS) and tray icon (Windows, Linux).
 *
 * The overlay windows have no Dock icon or taskbar button, so this icon is
 * the one place that always works to bring Cuewell back, take a screenshot,
 * open chat or Settings, and quit.
 *
 * - macOS: a monochrome template image (trayTemplate.png and @2x), which
 *   the system tints for light and dark menu bars. A click opens the menu.
 * - Windows: the color app icon (.ico, 16 to 256 px). Left or right click
 *   opens the menu.
 * - Linux: the color PNG. Linux trays only show a menu set in advance, so
 *   the menu is set again whenever its contents change (refresh()). GNOME
 *   shows tray icons only with an AppIndicator extension.
 *
 * The tooltip and the Show/Hide and Quit items use the name the app shows
 * right now (the app icon setting can show Cuewell as Terminal, Activity
 * Monitor or System Settings).
 *
 * Electron is passed in, so the menu template can be checked in plain Node.
 */

const path = require('path');

const ELLIPSIS = '\u2026';

/** Icon file for the tray on `platform`, relative to the app folder. */
function trayIconFile(platform) {
  if (platform === 'darwin') return path.join('assests', 'icons', 'trayTemplate.png');
  if (platform === 'win32') return path.join('assests', 'icons', 'app-icon.ico');
  return path.join('assests', 'icons', 'tray-icon.png');
}

/**
 * Menu template for the tray icon.
 *
 * @param {object} options
 * @param {string} options.appName              name the app shows now
 * @param {boolean} options.updatesConfigured   UPDATE_REPO is set
 * @param {boolean} [options.setupNeeded]       onboarding is not finished
 * @param {boolean} [options.screenShared]      windows are hidden for screen sharing
 * @param {Function} [options.isShortcutRegistered] globalShortcut.isRegistered
 * @param {object} options.actions              toggleWindows, screenshot, openChat,
 *                                              settings, checkForUpdates, finishSetup, quit
 */
function buildTrayMenuTemplate({
  appName, updatesConfigured, setupNeeded = false, screenShared = false,
  isShortcutRegistered = () => false, actions,
}) {
  const name = String(appName || '').trim() || 'Cuewell';
  const call = (action) => () => actions[action]();
  // Shows the global shortcut next to the item only when it works. The tray
  // never registers it (registerAccelerator: false): the global shortcut
  // already does.
  const shortcut = (accelerator) => (isShortcutRegistered(accelerator)
    ? { accelerator, registerAccelerator: false }
    : {});

  const template = [];
  if (setupNeeded) {
    template.push(
      { label: `Finish Setup${ELLIPSIS}`, click: call('finishSetup') },
      { type: 'separator' },
    );
  } else {
    if (screenShared) {
      template.push({ label: 'Hidden while your screen is shared', enabled: false });
    }
    template.push(
      {
        label: `Show/Hide ${name}`,
        enabled: !screenShared,
        click: call('toggleWindows'),
        ...shortcut('CommandOrControl+Shift+V'),
      },
      { type: 'separator' },
      { label: 'Take Screenshot', click: call('screenshot'), ...shortcut('CommandOrControl+Shift+S') },
      { label: 'Open Chat', enabled: !screenShared, click: call('openChat'), ...shortcut('CommandOrControl+Shift+C') },
      { type: 'separator' },
    );
  }
  template.push({ label: `Settings${ELLIPSIS}`, click: call('settings') });
  if (updatesConfigured) {
    template.push({ label: `Check for Updates${ELLIPSIS}`, click: call('checkForUpdates') });
  }
  template.push(
    { type: 'separator' },
    { label: `Quit ${name}`, click: call('quit') },
  );
  return template;
}

class AppTray {
  /**
   * @param {object} deps
   * @param {object} deps.electron  { Tray, Menu, nativeImage }
   * @param {string} deps.platform  process.platform
   * @param {string} deps.appRoot   folder the icon paths are relative to
   * @param {Function} deps.getMenuOptions () => options for buildTrayMenuTemplate
   * @param {Function} [deps.onMenuOpen]  called before the menu opens (macOS, Windows)
   * @param {Function} [deps.onMenuClose] called when that menu closes
   * @param {object} [deps.logger]
   */
  constructor({ electron, platform, appRoot, getMenuOptions, onMenuOpen, onMenuClose, logger }) {
    this.electron = electron;
    this.onMenuOpen = onMenuOpen || (() => {});
    this.onMenuClose = onMenuClose || (() => {});
    this.platform = platform;
    this.appRoot = appRoot;
    this.getMenuOptions = getMenuOptions;
    this.logger = logger || console;
    this.tray = null;
  }

  /** Create the icon. Returns false (and logs) when this system has no tray. */
  create() {
    if (this.tray) return true;
    const { Tray, nativeImage } = this.electron;
    try {
      const iconPath = path.join(this.appRoot, trayIconFile(this.platform));
      const image = nativeImage.createFromPath(iconPath);
      if (image.isEmpty()) throw new Error(`Tray icon not found: ${iconPath}`);
      if (this.platform === 'darwin') image.setTemplateImage(true);
      this.tray = new Tray(image);
      if (this.platform === 'darwin' || this.platform === 'win32') {
        // Built when opened, so it always shows the current state.
        const open = () => this.popUp();
        this.tray.on('click', open);
        this.tray.on('right-click', open);
      }
      this.refresh();
      return true;
    } catch (error) {
      this.logger.warn('Could not create the tray icon', { error: error.message });
      this.destroy();
      return false;
    }
  }

  buildMenu() {
    return this.electron.Menu.buildFromTemplate(buildTrayMenuTemplate(this.getMenuOptions()));
  }

  popUp() {
    if (!this.tray || this.tray.isDestroyed()) return;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { this.onMenuClose(); } catch (_) { /* nothing to undo */ }
    };
    try {
      const menu = this.buildMenu();
      if (typeof menu.once === 'function') menu.once('menu-will-close', close);
      this.onMenuOpen();
      this.tray.popUpContextMenu(menu);
    } catch (error) {
      close();
      this.logger.warn('Could not open the tray menu', { error: error.message });
    }
  }

  /** Update the tooltip, and on Linux the menu, after the app name or state changed. */
  refresh() {
    if (!this.tray || this.tray.isDestroyed()) return;
    try {
      const { appName } = this.getMenuOptions();
      this.tray.setToolTip(String(appName || '').trim() || 'Cuewell');
      if (this.platform !== 'darwin' && this.platform !== 'win32') {
        this.tray.setContextMenu(this.buildMenu());
      }
    } catch (error) {
      this.logger.warn('Could not update the tray icon', { error: error.message });
    }
  }

  destroy() {
    try {
      if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    } catch (_) { /* quitting anyway */ }
    this.tray = null;
  }
}

module.exports = { AppTray, buildTrayMenuTemplate, trayIconFile };
