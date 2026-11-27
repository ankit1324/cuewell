const { app, BrowserWindow, screen, desktopCapturer, shell, systemPreferences } = require('electron');
const path = require('path');
// Node's URL on purpose: speech.service.js replaces globalThis.URL with a
// stand-in that reports every URL as https:.
const { URL, fileURLToPath } = require('url');
const logger = require('../core/logger').createServiceLogger('WINDOW');
const config = require('../core/config');

// The chat and answer windows render AI output, so they get the minimal
// preload. The toolbar, Settings and onboarding pages use preload.js, which
// picks each page's methods from the --si-window argument.
const APP_ROOT = path.join(__dirname, '..', '..');
const PRELOAD_BY_TYPE = {
  main: path.join(APP_ROOT, 'preload.js'),
  settings: path.join(APP_ROOT, 'preload.js'),
  onboarding: path.join(APP_ROOT, 'preload.js'),
  chat: path.join(APP_ROOT, 'preload-content.js'),
  llmResponse: path.join(APP_ROOT, 'preload-content.js'),
};

// Motion and sizing for the chat and answer windows.
const WINDOW_FADE_MS = 160;          // window appear: fade (plus a 4 px rise in the page)
const ANSWER_REVEAL_TIMEOUT_MS = 150; // longest wait for the answer page's first frame
const ANSWER_MIN_HEIGHT = 120;       // title bar plus a line or two
const ANSWER_SCREEN_MARGIN = 12;     // kept free below the answer window

/** Open http(s) URLs in the system browser and drop every other scheme. */
function openExternalHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  shell.openExternal(parsed.href).catch((error) => {
    logger.warn('Failed to open external URL', { error: error.message });
  });
}

/** Move a window only when its position actually changes. */
function setPositionIfMoved(win, x, y) {
  const [currentX, currentY] = win.getPosition();
  const nextX = Math.round(x);
  const nextY = Math.round(y);
  if (currentX !== nextX || currentY !== nextY) win.setPosition(nextX, nextY);
}

class WindowManager {
  constructor() {
    this.windows = new Map();
    // webContents id -> window type, recorded when each BrowserWindow is
    // created (before its page loads) so main.js can tell which window sent
    // an IPC message, including messages sent while the page is loading.
    this.webContentsTypes = new Map();
    this.activeWindow = 'main';
    this.isInteractive = true; // default to interactive so windows are clickable/drag-able
    this.isVisible = false;
    this.currentDisplay = null;
    this.screenWatcher = null;
    this.desktopWatcher = null;
    this.lastActiveSpace = null;
    this.screenCaptureAvailabilityWatcher = null;
    this.isScreenBeingShared = false;
    this.wasVisibleBeforeSharing = false;
    this.screenCaptureStatus = {
      available: null,
      lastError: null,
      lastCheckedAt: null
    };
    this.isCheckingScreenCaptureStatus = false;
    this.isInitialized = false;
    this.isInitializing = false;
    this.isRecording = false;
    
    // Add debouncing to prevent excessive operations
    this.lastEnforceTime = 0;
    this.enforceDebounceMs = 1000; // Only enforce once per second
    this.focusLocked = false; // Prevent focus loops
    
    // Window binding properties
    this.bindWindows = true; // Enable window binding by default
    this.windowGap = 10; // Small gap between windows
    this.boundWindowsPosition = { x: 0, y: 0 }; // Track position of bound windows
    
    this.windowConfigs = {
      main: {
        width: 520,
        height: 35,
        useContentSize: true,
        file: 'index.html',
        title: 'Cuewell'
      },
      chat: {
        width: 500,
        height: 700,
        file: 'chat.html',
        title: 'Chat'
      },
      llmResponse: {
        width: 840,
        height: 480,
        file: 'llm-response.html',
        title: 'AI Response',
        alwaysOnTop: true
      },
      // A normal app window (see createWindow): resizable, centered when it
      // opens, on top only while it has focus, never click-through.
      settings: {
        width: 860,
        height: 600,
        minWidth: 720,
        minHeight: 520,
        file: 'settings.html',
        title: 'Settings'
      },
      onboarding: {
        width: 560,
        height: 680,
        file: 'onboarding.html',
        title: 'Welcome to Cuewell',
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: true,
        alwaysOnTop: true,
        visibleOnAllWorkspaces: true,
        fullscreenable: false
      }
    };

    this.init();
  }

  init() {
    // ... existing initialization code ...
  }

  async initializeWindows(options = {}) {
    const { showMainWindow = true } = options;
    if (this.isInitialized || this.isInitializing) {
      logger.warn('Windows already initialized or initializing');
      return;
    }

    this.isInitializing = true;
    logger.info('Initializing application windows', { showMainWindow });
    
    try {
      // Pass autoShow so the main window doesn't flash visible during
      // first-run onboarding before the user has configured API keys.
      await this.createMainWindow({ autoShow: showMainWindow });
      await this.createChatWindow();
      await this.createLLMResponseWindow();
      await this.createSettingsWindow();
      
      this.setupWindowEventHandlers();
      this.setupScreenTracking();
      this.setupScreenCaptureAvailabilityWatcher();

      // Make windows interactive by default so they are not click-through
      this.setInteractive(true);
      
      // Optionally show the main window (deferred during onboarding)
      if (showMainWindow) {
        await this.showMainWindow();
      }
      
      this.isInitialized = true;
      this.isInitializing = false;
      logger.info('All windows initialized successfully');
    } catch (error) {
      this.isInitializing = false;
      logger.error('Failed to initialize windows', { error: error.message });
      throw error;
    }
  }

  async showMainWindow() {
    const mainWindow = this.windows.get('main');
    if (!mainWindow) return;
    
    // Immediate always-on-top enforcement for main window
    if (process.platform === 'darwin') {
      try {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 2);
      } catch (error) {
        mainWindow.setAlwaysOnTop(true, 'floating', 2);
      }
    } else {
      mainWindow.setAlwaysOnTop(true);
    }
    
    // Wait for app to fully initialize and detect current desktop
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.showOnCurrentDesktop(mainWindow);
    
    // Additional enforcement after showing
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!mainWindow.isDestroyed()) {
      if (process.platform === 'darwin') {
        try {
          mainWindow.setAlwaysOnTop(true, 'screen-saver', 2);
        } catch (error) {
          mainWindow.setAlwaysOnTop(true, 'floating', 2);
        }
      } else {
        mainWindow.setAlwaysOnTop(true);
      }
    }
    
    this.isVisible = true;
    logger.info('Main window displayed');
    // Notify renderer to refresh speech availability
    mainWindow.webContents.send('main-window-shown', {});
  }

  async createMainWindow(options = {}) {
    const { autoShow = true } = options;
    if (this.windows.has('main')) {
      return this.windows.get('main');
    }
    const window = await this.createWindow('main', false); // Don't show during creation
    this.windows.set('main', window);

    // Always-on-top must be set even when we're deferring the visual
    // show — it persists into the future showOnCurrentDesktop call.
    if (process.platform === 'darwin') {
      try {
        window.setAlwaysOnTop(true, 'screen-saver', 2);
      } catch (error) {
        window.setAlwaysOnTop(true, 'floating', 2);
      }
    } else {
      window.setAlwaysOnTop(true);
    }

    // Only auto-show when explicitly allowed (e.g. not during first-run
    // onboarding). The single entry point for showing the overlay is
    // `showMainWindow()` — callers control timing via the flag below.
    if (autoShow) {
      // Wait for app to fully initialize and detect current desktop
      setTimeout(() => {
        this.showOnCurrentDesktop(window);
        // Additional enforcement after showing
        setTimeout(() => {
          if (!window.isDestroyed()) {
            if (process.platform === 'darwin') {
              try {
                window.setAlwaysOnTop(true, 'screen-saver', 2);
              } catch (error) {
                window.setAlwaysOnTop(true, 'floating', 2);
              }
            } else {
              window.setAlwaysOnTop(true);
            }
          }
        }, 200);
      }, 100);
    }

    return window;
  }

  async createChatWindow() {
    if (this.windows.has('chat')) {
      return this.windows.get('chat');
    }
    const window = await this.createWindow('chat');
    this.windows.set('chat', window);
    window.hide();
    return window;
  }

  async createLLMResponseWindow() {
    if (this.windows.has('llmResponse')) {
      return this.windows.get('llmResponse');
    }
    const window = await this.createWindow('llmResponse');
    this.windows.set('llmResponse', window);
    
    // Forward the answer page's own debug lines to the main log. Electron 35+
    // passes the details on the event object; the positional
    // (level, message, line, sourceId) arguments are deprecated.
    window.webContents.on('console-message', (details) => {
      const message = details && typeof details.message === 'string' ? details.message : '';
      if (message.includes('LLM-RESPONSE')) {
        logger.info(`[RENDERER] ${message}`);
      }
    });
    
    window.hide();
    return window;
  }

  async createSettingsWindow() {
    if (this.windows.has('settings')) {
      return this.windows.get('settings');
    }
    const window = await this.createWindow('settings');
    this.windows.set('settings', window);

    // The close button, Cmd+W and Alt+F4 hide Settings so it keeps its state;
    // quitting the app still closes it.
    if (!this._watchingQuit) {
      this._watchingQuit = true;
      app.on('before-quit', () => { this.appQuitting = true; });
    }
    window.on('close', (event) => {
      if (this.appQuitting) return;
      event.preventDefault();
      window.hide();
    });

    window.hide();
    return window;
  }

  /** True when `win` is the Settings window. */
  isSettingsWindow(win) {
    const settingsWindow = this.windows.get('settings');
    return !!win && !!settingsWindow && settingsWindow === win;
  }

  /** True while the Settings window is visible and has keyboard focus. */
  isSettingsFocused() {
    const win = this.windows.get('settings');
    return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
  }

  /**
   * Settings counterpart of applyStealthMeasures: hidden from screen capture
   * like every other window, but only raised above other windows (the
   * overlay included) while it has focus. When focus moves to another app it
   * drops back like any normal window.
   */
  applySettingsWindowMeasures(window) {
    try {
      window.setContentProtection(true);
    } catch (error) {
      logger.debug('Content protection not supported on this platform');
    }
    window.setSkipTaskbar(true);

    const raise = () => {
      if (window.isDestroyed() || !window.isFocused()) return;
      try {
        if (process.platform === 'darwin') {
          // One step above the overlay's level (screen-saver, 2).
          window.setAlwaysOnTop(true, 'screen-saver', 3);
        } else {
          window.setAlwaysOnTop(true);
        }
      } catch (error) {
        logger.debug('Could not raise the settings window', { error: error.message });
      }
    };
    const lower = () => {
      if (window.isDestroyed()) return;
      try {
        window.setAlwaysOnTop(false);
      } catch (error) {
        logger.debug('Could not lower the settings window', { error: error.message });
      }
    };
    window.on('focus', raise);
    window.on('blur', lower);
    window.on('hide', lower);
    this._raiseSettingsWindow = raise;
  }

  /**
   * On Windows and Linux every always-on-top window shares one band, so an
   * overlay window raised while Settings has focus would cover it. Put
   * Settings back on top. (macOS uses a higher level instead.)
   */
  keepSettingsOnTop() {
    if (process.platform === 'darwin' || !this.isSettingsFocused() || !this._raiseSettingsWindow) return;
    this._raiseSettingsWindow();
  }

  /** Center `win` on the display under the pointer, shrunk to fit its work area. */
  centerSettingsWindow(win) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
    const area = display.workArea;
    const config = this.windowConfigs.settings;
    const [currentWidth, currentHeight] = win.getSize();
    const width = Math.max(Math.min(config.minWidth, area.width), Math.min(currentWidth, area.width));
    const height = Math.max(Math.min(config.minHeight, area.height), Math.min(currentHeight, area.height));
    win.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height
    });
  }

  /**
   * Show Settings on the current desktop. On macOS it briefly joins every
   * Space (as the overlay windows do) so it opens on the one in use instead
   * of switching Spaces.
   */
  revealSettingsWindow(win, { focus = true } = {}) {
    if (!win || win.isDestroyed()) return;
    // Back on screen if its display was removed or it was moved off screen.
    try {
      const b = win.getBounds();
      const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
        b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 &&
        b.y < a.y + a.height - 40 && b.y + b.height > a.y);
      if (!onScreen) this.centerSettingsWindow(win);
    } catch (error) {
      logger.debug('Could not check the settings window position', { error: error.message });
    }
    const reveal = () => {
      if (win.isDestroyed()) return;
      if (focus) {
        win.show();
        win.focus();
      } else {
        win.showInactive();
      }
    };
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      reveal();
      setTimeout(() => {
        if (!win.isDestroyed()) win.setVisibleOnAllWorkspaces(false);
      }, 300);
    } else {
      reveal();
    }
  }

  /**
   * True when `url` is a file: URL of one of the app's own pages
   * (windowConfigs). With `type`, only that window type's own page counts.
   */
  isAppPageUrl(url, type = null) {
    let pagePath;
    try {
      pagePath = fileURLToPath(url);
    } catch (_) {
      return false; // not a local file URL
    }
    const normalize = (value) => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const appRoot = app.getAppPath();
    const configs = type ? [this.windowConfigs[type]].filter(Boolean) : Object.values(this.windowConfigs);
    return configs
      .some(({ file }) => normalize(path.join(appRoot, file)) === normalize(pagePath));
  }

  /** Window type ('main', 'chat', ...) that owns `webContents`, or null. */
  getWindowTypeForWebContents(webContents) {
    if (!webContents || typeof webContents.id !== 'number') return null;
    const type = this.webContentsTypes.get(webContents.id);
    if (!type) return null;
    const win = this.windows.get(type);
    // A window that has not been added to `windows` yet (its page is still
    // loading) is still identified by the id recorded at creation.
    if (win && !win.isDestroyed() && win.webContents.id !== webContents.id) return null;
    return type;
  }

  async createWindow(type, showOnCreate = false) {
    const windowConfig = this.windowConfigs[type];
    if (!windowConfig) {
      throw new Error(`Unknown window type: ${type}`);
    }

    // Base options
    const baseOptions = {
      width: windowConfig.width,
      height: windowConfig.height,
      webPreferences: {
        ...config.get('window.webPreferences'),
        preload: PRELOAD_BY_TYPE[type] || config.get('window.webPreferences').preload,
        // Tells the preload which page's API to expose.
        additionalArguments: [`--si-window=${type}`],
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        // DevTools only when running from source.
        devTools: !app.isPackaged,
      },
      show: false, // Never show during creation, use showOnCurrentDesktop instead
      title: windowConfig.title,
      skipTaskbar: true,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      fullscreenable: false,
      // Platform-specific always-on-top settings
      ...(process.platform === 'darwin' && {
        level: 'floating' // Start with floating level for macOS
      })
    };

    // Type-specific window configurations
    let browserWindowOptions;
    
    if (type === 'settings') {
      // A regular window, unlike the overlay panels: not pinned above other
      // apps (applySettingsWindowMeasures raises it only while focused) and
      // resizable. macOS keeps a hidden title bar with the traffic lights
      // inset over the page; Windows and Linux are frameless and the page
      // draws its own close button. Closing only hides it.
      const { level: _level, ...regular } = baseOptions;
      browserWindowOptions = {
        ...regular,
        alwaysOnTop: false,
        visibleOnAllWorkspaces: false,
        minWidth: windowConfig.minWidth,
        minHeight: windowConfig.minHeight,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: true,
        hasShadow: true,
        ...(process.platform === 'darwin'
          ? {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 18, y: 18 }
          }
          : {
            frame: false,
            transparent: false,
            backgroundColor: '#121317'
          })
      };
  } else if (type === 'onboarding') {
      // First-run onboarding wizard — same frameless/panel style as
      // settings, but closable from its own UI and slightly larger.
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: true,
        hasShadow: true,
        backgroundColor: '#00000000',
        level: process.platform === 'darwin' ? 'floating' : undefined,
        ...(process.platform === 'darwin' && {
          type: 'panel',
          // 'hidden' still draws the macOS traffic lights; park them
          // off-screen like the toolbar, chat and answer windows do.
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        })
      };
  } else if (type === 'main') {
      // Main window configuration - fit to content, completely frameless
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: false,
        transparent: true,
        backgroundColor: '#00000000',
  // Allow resizing so users can adjust width; we will lock height in handlers
  resizable: true,
    // Keep the original max width as cap; allow small min width so it can collapse to one icon
    minWidth: 60,
    maxWidth: this.windowConfigs.main.width,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        useContentSize: windowConfig.useContentSize || false,
        thickFrame: false,
        focusable: true,
        ...(process.platform === 'darwin' && {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else if (type === 'llmResponse') {
      // LLM Response window - completely frameless, just content
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        backgroundColor: '#00000000',
        resizable: true,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        thickFrame: false,
        ...(process.platform === 'darwin' && {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else if (type === 'chat') {
      // Chat window - frameless without window controls
      browserWindowOptions = {
        ...baseOptions,
        minWidth: config.get('window.minWidth'),
        minHeight: config.get('window.minHeight'),
        maxWidth: config.get('window.maxWidth'),
        maxHeight: config.get('window.maxHeight'),
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: true,
        ...(process.platform === 'darwin' && {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else {
      // Other windows (skills)
      browserWindowOptions = {
        ...baseOptions,
        minWidth: config.get('window.minWidth'),
        minHeight: config.get('window.minHeight'),
        maxWidth: config.get('window.maxWidth'),
        maxHeight: config.get('window.maxHeight'),
        frame: true,
        titleBarStyle: 'default',
        transparent: false,
        resizable: true,
        minimizable: false,
        maximizable: true,
        closable: true,
        hasShadow: true,
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    }

    // macOS native glass for the panel windows. The 'main' toolbar is left
    // out on purpose: its window has transparent gaps around the pill and the
    // shortcuts popover, which vibrancy would fill with blur.
    if (process.platform === 'darwin' &&
        ['llmResponse', 'chat', 'settings', 'onboarding'].includes(type)) {
      browserWindowOptions = {
        ...browserWindowOptions,
        vibrancy: 'hud',
        visualEffectState: 'active',
        backgroundColor: '#00000000',
        hasShadow: true,
        roundedCorners: true,
      };
    }

    // Windows-specific settings
    if (process.platform === 'win32') {
      browserWindowOptions = {
        ...browserWindowOptions,
        parent: null,
        modal: false,
        thickFrame: false,
      };
    }

    // Frameless Windows windows need the thick frame for resize borders,
    // snapping and the system shadow.
    if (type === 'settings' && process.platform === 'win32') {
      browserWindowOptions.thickFrame = true;
    }

    browserWindowOptions.kiosk = false;
    browserWindowOptions.simpleFullscreen = false;

  const window = new BrowserWindow(browserWindowOptions);

    // Belt and braces for the onboarding panel: hide the macOS window
    // buttons outright in case the off-screen position is not honoured.
    if (type === 'onboarding' && process.platform === 'darwin' &&
        typeof window.setWindowButtonVisibility === 'function') {
      window.setWindowButtonVisibility(false);
    }

    const webContentsId = window.webContents.id;
    this.webContentsTypes.set(webContentsId, type);
    window.webContents.once('destroyed', () => {
      if (this.webContentsTypes.get(webContentsId) === type) {
        this.webContentsTypes.delete(webContentsId);
      }
    });

    // External links (GitHub, the website, Google AI Studio, links in AI
    // answers, etc.) must open in the user's real browser, never inside the
    // frameless overlay windows. Deny any in-app window.open, and keep every
    // window on its own page: other navigations are cancelled and http(s)
    // targets go to the OS browser instead.
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternalHttpUrl(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (this.isAppPageUrl(url, type)) return;
      event.preventDefault();
      if (!this.isAppPageUrl(url)) openExternalHttpUrl(url);
    });

  // Load the HTML file
    await window.loadFile(windowConfig.file);
    
  // Position the window
    this.positionWindow(window, type);
    
  // Apply simplified stealth measures (Settings: capture protection only)
    if (type === 'settings') {
      this.applySettingsWindowMeasures(window);
    } else {
      this.applyStealthMeasures(window, type);
    }
    
  // Initialize interaction mode based on current state for ALL windows
  // except Settings, which is never click-through.
    if (this.isInteractive || type === 'settings') {
      window.setIgnoreMouseEvents(false);
    } else {
      window.setIgnoreMouseEvents(true, { forward: true });
    }

    // Horizontal-only resize behavior for main overlay window
    if (type === 'main') {
      try {
        // Small practical minimum width so it can collapse to roughly one icon width
        // Height is managed dynamically; don't lock here to allow programmatic changes
        if (typeof window.setMinimumSize === 'function') {
          // Set a conservative minimum width; height will be adjusted via IPC as needed
          window.setMinimumSize(60, windowConfig.height);
        }

        // Intercept user-initiated resizes to lock height and allow width changes only
        window.on('will-resize', (event, newBounds) => {
          try {
            // Keep current content height; only apply the new width
            const [_, currentContentHeight] = window.getContentSize();
            event.preventDefault();
            // Enforce width within min/max bounds
            const minW = 60;
            const maxW = this.windowConfigs.main.width;
            const desiredW = Math.max(minW, Math.min(maxW, Math.round(newBounds.width || minW)));
            window.setContentSize(desiredW, Math.max(1, currentContentHeight));
          } catch (e) {
            // Fallback: lock window height using window size
            try {
              const [__w, currentWindowHeight] = window.getSize();
              event.preventDefault();
              const minW = 60;
              const maxW = this.windowConfigs.main.width;
              const desiredW = Math.max(minW, Math.min(maxW, Math.round(newBounds.width || minW)));
              window.setSize(desiredW, Math.max(1, currentWindowHeight));
            } catch { /* noop */ }
          }
        });

        // When resized (by user or programmatically), keep bound windows aligned at top
        window.on('resize', () => {
          if (this.bindWindows) {
            this.positionBoundWindows();
          }
        });
      } catch { /* ignore */ }
    }
    
    // Show window on current desktop if requested
    if (showOnCreate) {
      this.showOnCurrentDesktop(window);
    }

    logger.debug('Window created successfully', {
      type,
      title: windowConfig.title,
      dimensions: `${windowConfig.width}x${windowConfig.height}`,
      showOnCreate: showOnCreate
    });

    return window;
  }

  applyStealthMeasures(window, type) {
    // Enhanced always-on-top enforcement for all platforms
    if (process.platform === 'darwin') {
      // macOS: Use native window level constants for maximum effectiveness
      try {
        // Try the most aggressive levels first
        const levels = [
          'screen-saver',    // Highest level
          'pop-up-menu',     // Menu level
          'modal-panel',     // Modal panel level
          'floating',        // Floating level
          'normal'           // Fallback to normal with alwaysOnTop
        ];
        
        let levelSet = false;
        for (const level of levels) {
          try {
            window.setAlwaysOnTop(true, level, 1);
            levelSet = true;
            logger.debug(`Successfully set always-on-top with level: ${level}`, { type });
            break;
          } catch (levelError) {
            logger.debug(`Failed to set level: ${level}`, { error: levelError.message });
          }
        }
        
        if (!levelSet) {
          // Final fallback
          window.setAlwaysOnTop(true);
        }
        
        // Additional macOS-specific enforcement
        setTimeout(() => {
          if (!window.isDestroyed()) {
            try {
              // Force re-application of always-on-top
              window.setAlwaysOnTop(false);
              setTimeout(() => {
                if (!window.isDestroyed()) {
                  window.setAlwaysOnTop(true, 'floating', 1);
                }
              }, 50);
            } catch (error) {
              logger.warn('Error in macOS re-enforcement', { error: error.message });
            }
          }
        }, 200);
        
      } catch (error) {
        logger.warn('Error setting always-on-top for macOS', { error: error.message });
        // Absolute fallback
        window.setAlwaysOnTop(true);
      }
    } else if (process.platform === 'win32') {
      // Windows: Multiple enforcement attempts
      window.setAlwaysOnTop(true);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 100);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 500);
      
    } else {
      // Linux and other platforms
      window.setAlwaysOnTop(true);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 100);
    }

    // Ensure window appears on all workspaces/desktops initially
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    
    // Hide from taskbar to maintain stealth
    window.setSkipTaskbar(true);
    
    // Make window undetectable by screen capture (if supported)
    try {
      window.setContentProtection(true);
      if (process.platform === 'linux' && !this._warnedNoContentProtection) {
        this._warnedNoContentProtection = true;
        logger.warn('Screen-capture protection is unavailable on Linux (Electron limitation). The overlay WILL be visible in screen shares. This stealth feature only works on macOS and Windows.');
      }
    } catch (error) {
      logger.debug('Content protection not supported on this platform');
    }
    
    // More aggressive event listeners to maintain always-on-top behavior
    const enforceAlwaysOnTop = () => {
      // The overlay stays put while Settings has focus, so it never covers it.
      if (this.isSettingsFocused()) return;
      if (!window.isDestroyed()) {
        try {
          if (process.platform === 'darwin') {
            // Try multiple levels on macOS
            window.setAlwaysOnTop(true, 'floating', 1);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'screen-saver', 1);
              }
            }, 50);
          } else {
            window.setAlwaysOnTop(true);
          }
        } catch (error) {
          logger.debug('Error in enforceAlwaysOnTop', { error: error.message });
        }
      }
    };
    
    // Event-based enforcement
    window.on('blur', () => {
      setTimeout(enforceAlwaysOnTop, 50);
      setTimeout(enforceAlwaysOnTop, 200);
      setTimeout(enforceAlwaysOnTop, 500);
    });
    
    window.on('show', () => {
      setTimeout(enforceAlwaysOnTop, 50);
      setTimeout(enforceAlwaysOnTop, 200);
    });
    
    window.on('focus', () => {
      setTimeout(enforceAlwaysOnTop, 50);
    });
    
    window.on('restore', () => {
      setTimeout(enforceAlwaysOnTop, 50);
    });
    
    // Periodic enforcement every 3 seconds (more frequent)
    const periodicEnforcement = setInterval(() => {
      if (window.isDestroyed()) {
        clearInterval(periodicEnforcement);
        return;
      }
      enforceAlwaysOnTop();
    }, 3000);
    
    logger.debug('Applied enhanced stealth measures with aggressive always-on-top', {
      type,
      platform: process.platform,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true
    });
  }

  positionWindow(window, type) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    
    if (this.bindWindows && (type === 'main' || type === 'llmResponse')) {
      // Position bound windows together
      this.positionBoundWindows();
      return;
    }
    
    // All windows positioned at top of screen with small margin
    const topMargin = 20;
    const [windowWidth] = window.getSize();
    
    const positions = {
      main: { x: displayX + 50, y: displayY + topMargin },
      chat: { x: displayX + screenWidth - windowWidth - 50, y: displayY + topMargin },
      llmResponse: { x: displayX + (screenWidth - windowWidth) / 2, y: displayY + topMargin },
      settings: { x: displayX + (screenWidth - windowWidth) / 2, y: displayY + topMargin }
    };

    const position = positions[type] || { x: displayX + 100, y: displayY + topMargin };
    window.setPosition(position.x, position.y);
    
    logger.debug('Positioned window at top', {
      type,
      position: `${position.x},${position.y}`,
      topMargin,
      display: display.id || 'primary'
    });
  }

  // New method to position bound windows (vertical column layout) - Always at top
  positionBoundWindows() {
    const mainWindow = this.windows.get('main');
    const llmWindow = this.windows.get('llmResponse');
    
    if (!mainWindow || !llmWindow) return;
    
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;
    
    const [mainWidth, mainHeight] = mainWindow.getSize();
    const [llmWidth, llmHeight] = llmWindow.getSize();
    
    // Always position at the top of the screen with small margin
    const topMargin = 20;
    const startY = displayY + topMargin;
    
    // Use the wider window for horizontal centering
    const maxWidth = Math.max(mainWidth, llmWidth);
    
    // Center horizontally on the display
    const xPosition = displayX + Math.round((screenWidth - maxWidth) / 2);
    
    // Ensure windows don't go outside screen bounds horizontally
    const adjustedMainX = Math.max(displayX, Math.min(displayX + screenWidth - mainWidth, xPosition));
    const adjustedLlmX = Math.max(displayX, Math.min(displayX + screenWidth - llmWidth, xPosition));
    
    // Position main window (top)
    const mainX = adjustedMainX;
    const mainY = startY;
    setPositionIfMoved(mainWindow, mainX, mainY);
    
    // Position LLM response window below with gap
    const llmX = adjustedLlmX;
    const llmY = startY + mainHeight + this.windowGap;
    setPositionIfMoved(llmWindow, llmX, llmY);
    
    // Update stored position (use main window position as reference)
    this.boundWindowsPosition = { x: adjustedMainX, y: startY };
    
    logger.debug('Positioned bound windows at top (column layout)', {
      mainPosition: `${mainX},${mainY}`,
      llmPosition: `${llmX},${llmY}`,
      gap: this.windowGap,
      topMargin: topMargin,
      display: display.id
    });
  }

  // New method to move bound windows (column layout) - Maintains top positioning preference
  moveBoundWindows(deltaX, deltaY) {
    if (!this.bindWindows) return;
    
    const mainWindow = this.windows.get('main');
    const llmWindow = this.windows.get('llmResponse');
    
    if (!mainWindow || !llmWindow) return;
    
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;
    
    // Get current positions and sizes
    const [mainX, mainY] = mainWindow.getPosition();
    const [llmX, llmY] = llmWindow.getPosition();
    const [mainWidth, mainHeight] = mainWindow.getSize();
    const [llmWidth, llmHeight] = llmWindow.getSize();
    
    // Calculate total height for bounds checking
    const totalHeight = mainHeight + this.windowGap + llmHeight;
    const topMargin = 20;
    const minY = displayY + topMargin;
    
    // Calculate new positions with bounds checking
    const newMainX = Math.max(displayX, Math.min(displayX + screenWidth - mainWidth, mainX + deltaX));
    // Ensure we don't go above the top margin or below screen bounds
    const newMainY = Math.max(minY, Math.min(displayY + screenHeight - totalHeight, mainY + deltaY));
    
    // LLM window follows the same horizontal movement but maintains vertical relationship
    const newLlmX = Math.max(displayX, Math.min(displayX + screenWidth - llmWidth, llmX + deltaX));
    const newLlmY = newMainY + mainHeight + this.windowGap;
    
    // Move both windows
    mainWindow.setPosition(newMainX, newMainY);
    llmWindow.setPosition(newLlmX, newLlmY);
    
    // Update stored position (use main window as reference)
    this.boundWindowsPosition.x = newMainX;
    this.boundWindowsPosition.y = newMainY;
    
    logger.debug('Moved bound windows (maintaining top preference)', {
      delta: `${deltaX},${deltaY}`,
      newMainPosition: `${newMainX},${newMainY}`,
      newLlmPosition: `${newLlmX},${newLlmY}`,
      topMargin: topMargin,
      totalHeight: totalHeight
    });
  }

  /**
   * Show a window on the current desktop, above other apps. Pass
   * { focus: false } for windows the user did not ask to type into (answers,
   * the loading state, restored or repositioned windows): they appear without
   * taking keyboard focus from the app the user is working in.
   *
   * The workspace and window-level settings are applied only when the window
   * goes from hidden to shown. This method never hides and re-shows a window
   * that is already on screen, or changes its level: on macOS that made it
   * blink. setVisibleOnAllWorkspaces is always called with
   * skipTransformProcessType, because without it Electron switches the app
   * between a Dock app and a UI-element app on every call, which hides every
   * window and the Dock icon for a moment. The app stays the UI-element app
   * that applyStealthMeasures makes it when the windows are created (no Dock
   * icon), which is what lets the windows float over full-screen apps.
   */
  showOnCurrentDesktop(win, { focus = true } = {}) {
    if (!win || win.isDestroyed()) return;
    // Settings is a regular window with its own rules.
    if (this.isSettingsWindow(win)) {
      this.revealSettingsWindow(win, { focus });
      return;
    }
    this.watchShownWindow(win);
    const type = this.getWindowTypeForWebContents(win.webContents);
    const isLLM = type === 'llmResponse';
    const workspaceOptions = { visibleOnFullScreen: true, skipTransformProcessType: true };
    const canUseWorkspaces = process.platform === 'darwin' || process.platform === 'linux';

    if (win.isVisible()) {
      if (!focus) return;
      // A window kept on one macOS Space would switch the user to that Space
      // when focused; let it join the current one first (no hide, no flash).
      if (process.platform === 'darwin' && !isLLM && !win.isVisibleOnAllWorkspaces()) {
        win.setVisibleOnAllWorkspaces(true, workspaceOptions);
        this.pinToCurrentWorkspaceLater(win);
      }
      win.focus();
      return;
    }

    if (canUseWorkspaces) win.setVisibleOnAllWorkspaces(true, workspaceOptions);
    if (process.platform === 'darwin') {
      try {
        win.setAlwaysOnTop(true, 'screen-saver', 2);
      } catch {
        try { win.setAlwaysOnTop(true, 'floating', 2); } catch { win.setAlwaysOnTop(true); }
      }
    } else {
      win.setAlwaysOnTop(true);
    }

    // The chat and answer windows fade in. On macOS the native glass is drawn
    // by the system, so the fade is done on the window; the pages add the
    // 4 px rise (and, on Windows and Linux, the fade) in CSS.
    const fade = process.platform === 'darwin' &&
      (type === 'llmResponse' || type === 'chat') && !this.prefersReducedMotion();
    if (fade) win.setOpacity(0);
    if (focus) {
      win.show();
      win.focus();
    } else {
      win.showInactive();
    }
    if (fade) this.fadeInWindow(win);
    // An open Settings window stays above the overlay on Windows and Linux.
    if (process.platform !== 'darwin') this.keepSettingsOnTop();

    // The answer window stays on every Space; the others are pinned to the
    // Space they were shown on.
    if (!isLLM && canUseWorkspaces) this.pinToCurrentWorkspaceLater(win);

    logger.debug('Window shown on current desktop', {
      type,
      platform: process.platform,
      windowId: win.id,
      faded: fade
    });
  }

  /** Stop a window following every Space shortly after it was shown. */
  pinToCurrentWorkspaceLater(win) {
    setTimeout(() => {
      if (win.isDestroyed() || !win.isVisible()) return;
      win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    }, process.platform === 'darwin' ? 300 : 500);
  }

  /** True when the OS asks for reduced motion. */
  prefersReducedMotion() {
    try {
      const settings = systemPreferences.getAnimationSettings();
      return !!(settings && settings.prefersReducedMotion);
    } catch (_) {
      return false;
    }
  }

  /**
   * Fade a window's opacity from 0 to 1 over WINDOW_FADE_MS with the theme's
   * ease-out curve. A hide or close during the fade ends it at full opacity,
   * so the next show never starts from an invisible window.
   */
  fadeInWindow(win) {
    this.stopWindowFade(win);
    const start = Date.now();
    const step = () => {
      if (win.isDestroyed()) return;
      const t = Math.min(1, (Date.now() - start) / WINDOW_FADE_MS);
      win.setOpacity(1 - Math.pow(1 - t, 3));
      if (t < 1) {
        this.windowFades.set(win.id, setTimeout(step, 16));
      } else {
        this.windowFades.delete(win.id);
      }
    };
    this.windowFades.set(win.id, setTimeout(step, 16));
  }

  stopWindowFade(win) {
    const timer = this.windowFades.get(win.id);
    if (!timer) return;
    clearTimeout(timer);
    this.windowFades.delete(win.id);
    if (!win.isDestroyed()) win.setOpacity(1);
  }

  /**
   * One-time listeners for a window shown by showOnCurrentDesktop: a hide
   * ends its fade, and for the answer window cancels a reveal still waiting
   * for the page and records the height the user drags it to.
   */
  watchShownWindow(win) {
    if (!this.windowFades) this.windowFades = new Map();
    if (!this.watchedWindows) this.watchedWindows = new WeakSet();
    if (this.watchedWindows.has(win)) return;
    this.watchedWindows.add(win);
    const id = win.id;
    win.on('hide', () => this.stopWindowFade(win));
    win.on('closed', () => {
      const timer = this.windowFades.get(id);
      if (timer) clearTimeout(timer);
      this.windowFades.delete(id);
    });
    if (this.getWindowTypeForWebContents(win.webContents) === 'llmResponse') {
      win.on('hide', () => this.cancelAnswerReveal());
      // Only emitted for resizes the user makes (macOS and Windows).
      win.on('will-resize', (_event, newBounds) => {
        if (newBounds && Number.isFinite(newBounds.height)) {
          this.answerState().preferredHeight = Math.round(newBounds.height);
        }
      });
    }
  }
  
  setupWindowEventHandlers() {
    this.windows.forEach((window, type) => {
      window.on('closed', () => {
        logger.debug('Window closed', { type });
        this.windows.delete(type);
      });

      window.on('focus', () => {
        this.activeWindow = type;
        logger.debug('Window focused', { type });
      });

      // SIMPLIFIED blur handler - no aggressive re-focusing
      window.on('blur', () => {
        // Only log, don't force focus back
        logger.debug('Window blurred', { type });
      });

      window.on('show', () => {
        logger.debug('Window shown', { type });
      });

      window.on('hide', () => {
        logger.debug('Window hidden', { type });
      });

      // Handle window minimize attempts
      window.on('minimize', (event) => {
        event.preventDefault();
        logger.debug('Prevented window minimize', { type });
      });

      window.on('restore', () => {
        // Simplified restore handling
        logger.debug('Window restored', { type });
      });
    });
  }

  setupScreenCaptureAvailabilityWatcher() {
    // Avoid screencast portal errors on Linux/Wayland by disabling periodic detection
    if (process.platform === 'linux') {
      logger.info('Skipping screen capture availability watcher on Linux to avoid portal screencast errors');
      return;
    }

    if (this.screenCaptureAvailabilityWatcher) {
      clearInterval(this.screenCaptureAvailabilityWatcher);
    }

    // This is only a capture availability probe. desktopCapturer.getSources()
    // cannot tell whether another app is currently sharing the screen.
    this.screenCaptureAvailabilityWatcher = setInterval(async () => {
      await this.checkScreenCaptureAvailability();
    }, 5000); // Check every 5 seconds instead of 1

    logger.info('Screen capture availability watcher initialized');
  }

  async checkScreenCaptureAvailability() {
    if (this.isCheckingScreenCaptureStatus) {
      logger.debug('Skipping overlapping screen capture availability check');
      return;
    }

    this.isCheckingScreenCaptureStatus = true;
    const previousAvailability = this.screenCaptureStatus.available;
    const checkedAt = new Date().toISOString();

    try {
      await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1, height: 1 }
      });

      this.screenCaptureStatus = {
        available: true,
        lastError: null,
        lastCheckedAt: checkedAt
      };

      if (previousAvailability === false) {
        logger.info('Screen capture enumeration recovered');
      }
    } catch (error) {
      this.screenCaptureStatus = {
        available: false,
        lastError: error.message,
        lastCheckedAt: checkedAt
      };

      const logContext = {
        error: error.message,
        isScreenBeingShared: this.isScreenBeingShared
      };

      if (previousAvailability === false) {
        logger.debug('Screen capture enumeration still unavailable', logContext);
      } else {
        logger.warn('Screen capture enumeration unavailable; leaving screen sharing mode unchanged', logContext);
      }
    } finally {
      this.isCheckingScreenCaptureStatus = false;
    }
  }

  startScreenSharingMode() {
    if (!this.isScreenBeingShared) {
      this.isScreenBeingShared = true;
      this.wasVisibleBeforeSharing = this.isVisible;
      this.handleScreenSharingStarted();
    }
  }

  stopScreenSharingMode() {
    if (this.isScreenBeingShared) {
      this.isScreenBeingShared = false;
      this.handleScreenSharingStopped();
    }
  }

  handleScreenSharingStarted() {
    logger.info('Screen sharing mode enabled - hiding windows');
    this.rememberVisibleWindows();

    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.hide();
        window.setPosition(-10000, -10000);
      }
    });
  }

  handleScreenSharingStopped() {
    logger.info('Screen sharing mode disabled - restoring windows');
    
    if (this.wasVisibleBeforeSharing) {
      this.moveWindowsToActiveScreen();
      this.showAllWindows();
    }
  }

  switchToWindow(windowType) {
    if (this.windows.has('chat') && this.windows.get('chat').isVisible()) {
      this.hideChatWindow();
      return;
    }

    if (!this.windowConfigs[windowType]) {
      logger.warn('Attempted to switch to unknown window type', { windowType });
      return;
    }

    if (this.isScreenBeingShared) {
      return;
    }

    const targetWindow = this.windows.get(windowType);
    if (targetWindow) {
      this.showOnCurrentDesktop(targetWindow);

      this.activeWindow = windowType;
      
      logger.info('Switched to window', {
        windowType,
        isVisible: this.isVisible
      });
    }
  }

  /**
   * Restore the windows that were visible when they were last hidden (by the
   * hide shortcut or by screen sharing), without taking focus. With no record,
   * only the toolbar comes back; Settings, Chat and onboarding are never
   * opened by this.
   */
  showAllWindows() {
    if (this.isScreenBeingShared) {
      return;
    }

    const types = this.hiddenWindowTypes && this.hiddenWindowTypes.length
      ? this.hiddenWindowTypes
      : ['main'];
    this.hiddenWindowTypes = null;

    types.forEach((type) => {
      const window = this.windows.get(type);
      if (window && !window.isDestroyed()) {
        this.showOnCurrentDesktop(window, { focus: false });
      }
    });

    this.isVisible = true;

    logger.info('Windows restored on current desktop', {
      restored: types,
      windowCount: this.windows.size
    });
  }

  /** Remember which windows are on screen, so showAllWindows can restore them. */
  rememberVisibleWindows() {
    const visible = [];
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed() && window.isVisible()) visible.push(type);
    });
    // A second hide (nothing visible) must not forget the first one's list.
    if (visible.length) this.hiddenWindowTypes = visible;
  }

  hideAllWindows() {
    this.rememberVisibleWindows();
    // Every window, the answer included: this is the panic-hide.
    this.windows.forEach((window) => {
      if (!window.isDestroyed()) window.hide();
    });

    this.isVisible = false;
    logger.info('All windows hidden', { willRestore: this.hiddenWindowTypes });
  }

  toggleVisibility() {
    if (this.isScreenBeingShared) {
      return this.isVisible;
    }

    if (this.isVisible) {
      this.hideAllWindows();
    } else {
      this.showAllWindows();
    }
    
    return this.isVisible;
  }

  setInteractive(interactive) {
    this.isInteractive = interactive;
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        if (interactive || type === 'settings') {
          // Interactive mode: allow mouse events for all windows. Settings
          // is never click-through.
          window.setIgnoreMouseEvents(false);
        } else {
          // Non-interactive mode: enable click-through with forwarding for all windows
          window.setIgnoreMouseEvents(true, { forward: true });
        }
        window.webContents.send('interaction-mode-changed', interactive);
      }
    });
    
    logger.info('Window interaction mode changed', { 
      interactive,
      clickThrough: !interactive,
      affectedWindows: Array.from(this.windows.keys())
    });
  }

  toggleInteraction() {
    this.setInteractive(!this.isInteractive);
    
    // Ensure all windows remain always-on-top after interaction mode change
    this.enforceAlwaysOnTopForAllWindows();
    
    return this.isInteractive;
  }

  // New method to enforce always-on-top for all windows
  enforceAlwaysOnTopForAllWindows() {
    this.windows.forEach((window, type) => {
      // Settings is only on top while focused (applySettingsWindowMeasures).
      if (type === 'settings') return;
      if (!window.isDestroyed()) {
        try {
          if (process.platform === 'darwin') {
            // Try multiple levels for macOS
            window.setAlwaysOnTop(true, 'pop-up-menu', 1);
            
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'floating', 1);
              }
            }, 100);
            
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'screen-saver', 1);
              }
            }, 200);
          } else {
            // Windows and Linux
            window.setAlwaysOnTop(true);
            
            // Additional enforcement after a short delay
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true);
              }
            }, 100);
          }
        } catch (error) {
          logger.warn('Error enforcing always-on-top', { 
            type, 
            error: error.message 
          });
          // Fallback to basic always-on-top
          try {
            window.setAlwaysOnTop(true);
          } catch (fallbackError) {
            logger.error('Fallback always-on-top failed', { 
              type, 
              error: fallbackError.message 
            });
          }
        }
      }
    });
    
    logger.debug('Enforced always-on-top for all windows with aggressive strategy', {
      platform: process.platform,
      windowCount: this.windows.size
    });
  }

  // Public method to manually enforce always-on-top for all windows
  forceAlwaysOnTopForAllWindows() {
    this.enforceAlwaysOnTopForAllWindows();
    logger.info('Manually enforced always-on-top for all windows');
  }

  // Debug method to test and verify always-on-top functionality
  testAlwaysOnTopForAllWindows() {
    const results = {};
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        try {
          const isAlwaysOnTop = window.isAlwaysOnTop();
          
          if (process.platform === 'darwin') {
            // Test different levels on macOS
            window.setAlwaysOnTop(true, 'screen-saver', 2);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'pop-up-menu', 2);
                setTimeout(() => {
                  if (!window.isDestroyed()) {
                    window.setAlwaysOnTop(true, 'floating', 2);
                  }
                }, 50);
              }
            }, 50);
          } else {
            // For other platforms
            window.setAlwaysOnTop(true);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true);
              }
            }, 50);
          }
          
          results[type] = {
            success: true,
            isAlwaysOnTop: isAlwaysOnTop,
            isVisible: window.isVisible(),
            isDestroyed: window.isDestroyed()
          };
          
        } catch (error) {
          results[type] = {
            success: false,
            error: error.message,
            isDestroyed: window.isDestroyed()
          };
        }
      } else {
        results[type] = {
          success: false,
          error: 'Window is destroyed'
        };
      }
    });
    
    logger.info('Always-on-top test results', { 
      platform: process.platform,
      results 
    });
    
    return results;
  }

  /**
   * Answer window state: `seq` numbers each loading/answer message sent to the
   * page, `pendingSeq` is the message whose first frame the window waits for
   * before it is revealed, and `preferredHeight` is the height the user last
   * dragged the window to.
   */
  answerState() {
    if (!this._answerState) {
      this._answerState = { seq: 0, pendingSeq: null, revealTimer: null, revealWhileVisible: true, preferredHeight: null };
    }
    return this._answerState;
  }

  /** Work area of the display the answer window is (or will be) on. */
  answerWorkArea(llmWindow) {
    try {
      return screen.getDisplayMatching(llmWindow.getBounds()).workArea;
    } catch (_) {
      return (this.currentDisplay || screen.getPrimaryDisplay()).workArea;
    }
  }

  /** Tallest the answer window may be at its current position. */
  answerMaxHeight(llmWindow) {
    const workArea = this.answerWorkArea(llmWindow);
    const [, y] = llmWindow.getPosition();
    return Math.max(ANSWER_MIN_HEIGHT, workArea.y + workArea.height - y - ANSWER_SCREEN_MARGIN);
  }

  /** Height a new answer starts at: the user's last height, or the default. */
  answerStandardHeight(llmWindow) {
    const preferred = this.answerState().preferredHeight;
    const wanted = Number.isFinite(preferred) && preferred > 0 ? preferred : this.windowConfigs.llmResponse.height;
    return Math.max(ANSWER_MIN_HEIGHT, Math.min(wanted, this.answerMaxHeight(llmWindow)));
  }

  /** Change only the height, keeping the width and the top edge. */
  setAnswerHeight(llmWindow, height) {
    const [width, currentHeight] = llmWindow.getSize();
    const next = Math.round(height);
    if (!Number.isFinite(next) || Math.abs(next - currentHeight) < 2) return false;
    llmWindow.setSize(width, next);
    return true;
  }

  /**
   * Put the hidden answer window under the toolbar, where the toolbar is now,
   * so the toolbar does not move when an answer appears.
   */
  placeAnswerWindow(llmWindow) {
    if (!this.bindWindows) return;
    const mainWindow = this.windows.get('main');
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
      this.positionBoundWindows();
      return;
    }
    const [mainX, mainY] = mainWindow.getPosition();
    const [, mainHeight] = mainWindow.getSize();
    const [llmWidth] = llmWindow.getSize();
    let workArea;
    try {
      workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    } catch (_) {
      workArea = (this.currentDisplay || screen.getPrimaryDisplay()).workArea;
    }
    const y = mainY + mainHeight + this.windowGap;
    if (workArea.y + workArea.height - y - ANSWER_SCREEN_MARGIN < ANSWER_MIN_HEIGHT) {
      // No room under the toolbar: use the default column at the top.
      this.positionBoundWindows();
      return;
    }
    const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - llmWidth, mainX));
    setPositionIfMoved(llmWindow, x, y);
  }

  /**
   * Number the next message for the answer page. A hidden window is sized and
   * placed now, before its first frame, and is revealed once the page reports
   * that it has drawn the new state (handleAnswerContentReport) or after
   * ANSWER_REVEAL_TIMEOUT_MS. A window already on screen is never hidden,
   * moved or re-leveled here.
   */
  prepareAnswerWindow(llmWindow) {
    const state = this.answerState();
    state.seq += 1;
    const appearing = !llmWindow.isVisible();
    // Shown some other way (e.g. restored by showAllWindows) while waiting.
    if (!appearing) this.cancelAnswerReveal();
    if (appearing) {
      this.placeAnswerWindow(llmWindow);
      this.setAnswerHeight(llmWindow, this.answerStandardHeight(llmWindow));
    }
    return { seq: state.seq, appearing };
  }

  revealAnswerWindowWhenDrawn(llmWindow, seq) {
    const state = this.answerState();
    if (state.pendingSeq === null) state.revealWhileVisible = this.isVisible;
    state.pendingSeq = seq;
    if (!state.revealTimer) {
      state.revealTimer = setTimeout(() => {
        state.revealTimer = null;
        logger.debug('Answer page did not report its first frame in time; showing the window anyway');
        this.revealAnswerWindow();
      }, ANSWER_REVEAL_TIMEOUT_MS);
    }
  }

  cancelAnswerReveal() {
    const state = this.answerState();
    if (state.revealTimer) clearTimeout(state.revealTimer);
    state.revealTimer = null;
    state.pendingSeq = null;
  }

  revealAnswerWindow() {
    const state = this.answerState();
    const hiddenMeanwhile = state.revealWhileVisible && !this.isVisible;
    this.cancelAnswerReveal();
    // Screen sharing began, or every window was hidden, while the page drew.
    if (this.isScreenBeingShared || hiddenMeanwhile) return;
    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || llmWindow.isDestroyed()) return;
    this.showOnCurrentDesktop(llmWindow, { focus: false });
  }

  showLLMResponse(content, metadata = {}) {
    logger.debug('showLLMResponse called', {
      isScreenBeingShared: this.isScreenBeingShared,
      contentLength: content.length,
      skill: metadata.skill
    });

    if (this.isScreenBeingShared) {
      logger.warn('LLM response blocked due to screen sharing mode');
      return;
    }

    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || llmWindow.isDestroyed()) {
      logger.error('LLM response window not available');
      return;
    }

    const { seq, appearing } = this.prepareAnswerWindow(llmWindow);
    llmWindow.webContents.send('display-llm-response', {
      content,
      metadata,
      seq,
      appearing,
      timestamp: new Date().toISOString()
    });
    if (appearing) this.revealAnswerWindowWhenDrawn(llmWindow, seq);

    logger.info('LLM response displayed', {
      contentLength: content.length,
      skill: metadata.skill,
      appearing,
      boundWindows: this.bindWindows
    });
  }

  showLLMLoading() {
    if (this.isScreenBeingShared) {
      logger.warn('LLM loading blocked due to screen sharing mode');
      return;
    }

    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || llmWindow.isDestroyed()) {
      logger.error('LLM window not available for loading state');
      return;
    }

    const { seq, appearing } = this.prepareAnswerWindow(llmWindow);
    llmWindow.webContents.send('show-loading', { seq, appearing });
    if (appearing) {
      this.revealAnswerWindowWhenDrawn(llmWindow, seq);
    } else {
      // A window left small by a short answer grows back while it shows
      // "Thinking", so the new answer has room. The top edge stays put.
      const standard = this.answerStandardHeight(llmWindow);
      if (llmWindow.getSize()[1] < standard) this.setAnswerHeight(llmWindow, standard);
    }
    logger.debug('LLM loading state shown', { appearing });
  }

  hideLLMResponse() {
    this.cancelAnswerReveal();
    const llmWindow = this.windows.get('llmResponse');
    if (llmWindow && !llmWindow.isDestroyed()) {
      llmWindow.hide();
    }
  }

  /**
   * The answer page reports after it has drawn a state:
   *   { phase: 'loading' | 'final', seq, height }
   * `seq` is the number of the message it drew, `height` (final only) the
   * window height its content needs. A report for the message the hidden
   * window waits for reveals it. A final answer fits the window once: a
   * window on screen only shrinks (content never moves), a window not yet
   * shown is sized either way. Nothing is resized while text streams.
   */
  handleAnswerContentReport(report) {
    if (!report || typeof report !== 'object') return { success: false };
    const phase = report.phase === 'loading' || report.phase === 'final' ? report.phase : null;
    const seq = Number.isSafeInteger(report.seq) ? report.seq : null;
    const height = typeof report.height === 'number' && Number.isFinite(report.height) &&
      report.height > 0 && report.height < 20000 ? report.height : null;
    if (!phase || seq === null) return { success: false };

    const state = this.answerState();
    // A report for an older message than the latest one changes nothing.
    if (seq !== state.seq) return { success: true, applied: false };
    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || llmWindow.isDestroyed()) return { success: false };

    const revealing = state.pendingSeq === seq;
    if (phase === 'final' && height !== null && (revealing || llmWindow.isVisible())) {
      this.fitAnswerWindowToContent(llmWindow, height, { canGrow: revealing });
    }
    if (revealing) this.revealAnswerWindow();
    return { success: true, applied: true };
  }

  fitAnswerWindowToContent(llmWindow, neededHeight, { canGrow = false } = {}) {
    const [, currentHeight] = llmWindow.getSize();
    const ceiling = canGrow ? this.answerStandardHeight(llmWindow) : currentHeight;
    const target = Math.max(ANSWER_MIN_HEIGHT, Math.min(Math.ceil(neededHeight), ceiling));
    // Small differences are left alone, so the edge does not twitch.
    if (Math.abs(target - currentHeight) < 8) return;
    this.setAnswerHeight(llmWindow, target);
    logger.debug('Answer window fitted to its content', { from: currentHeight, to: target });
  }

  /**
   * Open Settings, centered on the display under the pointer. When it is
   * already open it keeps its place and only comes to the front. The page
   * reloads its values on settings-window-shown.
   */
  showSettings() {
    if (this.isScreenBeingShared) return;

    const settingsWindow = this.windows.get('settings');
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      logger.warn('Settings window not available');
      return;
    }
    if (!settingsWindow.isVisible()) {
      this.centerSettingsWindow(settingsWindow);
    }
    this.revealSettingsWindow(settingsWindow, { focus: true });
    if (!settingsWindow.webContents.isDestroyed()) {
      settingsWindow.webContents.send('settings-window-shown');
    }
    logger.info('Settings window shown');
  }

  hideSettings() {
    const settingsWindow = this.windows.get('settings');
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.hide();
    }
  }

  async showOnboarding() {
    if (this.isScreenBeingShared) return null;

    let onboardingWindow = this.windows.get('onboarding');
    if (!onboardingWindow) {
      onboardingWindow = await this.createWindow('onboarding');
      this.windows.set('onboarding', onboardingWindow);

      // Once the wizard renderer signals it's ready, send it the
      // current first-run status so it can pre-populate correctly.
      onboardingWindow.webContents.once('did-finish-load', () => {
        logger.info('Onboarding window loaded');
      });
    }

    this.showOnCurrentDesktop(onboardingWindow);
    this.centerWindow(onboardingWindow);
    onboardingWindow.focus();
    logger.info('Onboarding window displayed');
    return onboardingWindow;
  }

  hideOnboarding() {
    const onboardingWindow = this.windows.get('onboarding');
    if (onboardingWindow) {
      onboardingWindow.hide();
    }
  }

  closeOnboarding() {
    const onboardingWindow = this.windows.get('onboarding');
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
    this.windows.delete('onboarding');
  }

  centerWindow(window) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    const [windowWidth, windowHeight] = window.getSize();
    
    // Center horizontally but position at top
    const topMargin = 20;
    const x = displayX + Math.round((screenWidth - windowWidth) / 2);
    const y = displayY + topMargin;
    
    window.setPosition(x, y);
    
    logger.debug('Positioned window at top-center', {
      position: `${x},${y}`,
      topMargin,
      display: display.id || 'primary'
    });
  }

  broadcastToAllWindows(channel, data) {
    const windowStates = {};
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
        windowStates[type] = {
          isVisible: window.isVisible(),
          isDestroyed: window.isDestroyed(),
          hasWebContents: !!window.webContents
        };
      } else {
        windowStates[type] = { isDestroyed: true };
      }
    });
    
    logger.info('Broadcast sent to all windows', { 
      channel, 
      windowCount: this.windows.size,
      windowStates,
      dataKeys: data ? Object.keys(data) : [],
      // Length only: content/response carry the AI answer, which must not reach log files.
      contentLength: data && typeof data.content === 'string' ? data.content.length :
                     data && typeof data.response === 'string' ? data.response.length : 0
    });
  }

  getWindow(type) {
    return this.windows.get(type);
  }

  getActiveWindow() {
    return this.windows.get(this.activeWindow);
  }

  getWindowStats() {
    const stats = {};
    
    this.windows.forEach((window, type) => {
      stats[type] = {
        isVisible: window.isVisible(),
        isFocused: window.isFocused(),
        position: window.getPosition(),
        size: window.getSize()
      };
    });
    
    return {
      windows: stats,
      activeWindow: this.activeWindow,
      isInteractive: this.isInteractive,
      isVisible: this.isVisible,
      isScreenBeingShared: this.isScreenBeingShared,
      screenCaptureStatus: { ...this.screenCaptureStatus }
    };
  }

  destroyAllWindows() {
    this.windows.forEach((window, type) => {
      logger.debug('Destroying window', { type });
      if (!window.isDestroyed()) {
        window.destroy();
      }
    });
    
    this.windows.clear();
    
    // Clean up all watchers
    if (this.screenWatcher) {
      clearInterval(this.screenWatcher);
      this.screenWatcher = null;
    }
    
    if (this.desktopWatcher) {
      clearInterval(this.desktopWatcher);
      this.desktopWatcher = null;
    }

    if (this.screenCaptureAvailabilityWatcher) {
      clearInterval(this.screenCaptureAvailabilityWatcher);
      this.screenCaptureAvailabilityWatcher = null;
    }
    
    logger.info('All windows destroyed');
  }

  setupScreenTracking() {
    // Initialize with current cursor position to get the active display
    const cursorPoint = screen.getCursorScreenPoint();
    this.currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
    
    screen.on('display-added', () => {
      logger.debug('Display added');
      this.handleDisplayChange();
    });

    screen.on('display-removed', () => {
      logger.debug('Display removed');
      this.handleDisplayChange();
    });

    screen.on('display-metrics-changed', () => {
      logger.debug('Display metrics changed');
      this.handleDisplayChange();
    });

    // More frequent tracking during initialization
    this.screenWatcher = setInterval(() => {
      this.trackActiveScreen();
    }, 2000);

    // SIMPLIFIED desktop tracking
    this.setupDesktopTracking();

    logger.info('Screen and desktop tracking initialized', {
      currentDisplay: this.currentDisplay.id,
      cursorPosition: cursorPoint
    });
  }

  handleDisplayChange() {
    setTimeout(() => {
      this.moveWindowsToActiveScreen();
    }, 500);
  }

  trackActiveScreen() {
    if (this.isScreenBeingShared) return;

    const cursorPoint = screen.getCursorScreenPoint();
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);
    
    if (!this.currentDisplay || activeDisplay.id !== this.currentDisplay.id) {
      this.currentDisplay = activeDisplay;
      this.moveWindowsToActiveScreen();
      
      logger.debug('Active screen changed', {
        displayId: activeDisplay.id,
        bounds: activeDisplay.bounds
      });
    }
  }

  moveWindowsToActiveScreen() {
    if (!this.currentDisplay || this.isScreenBeingShared) return;

    const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = this.currentDisplay.workArea;
    
    // Handle bound windows specially
    if (this.bindWindows) {
      const mainWindow = this.windows.get('main');
      const llmWindow = this.windows.get('llmResponse');
      
      if (mainWindow && llmWindow && !mainWindow.isDestroyed() && !llmWindow.isDestroyed()) {
        // Position bound windows on the new screen and ensure they appear on current desktop
        this.positionBoundWindows();
        if (mainWindow.isVisible()) this.showOnCurrentDesktop(mainWindow, { focus: false });
        if (llmWindow.isVisible()) this.showOnCurrentDesktop(llmWindow, { focus: false });
      }
    }
    
    this.windows.forEach((window, type) => {
      if (window && !window.isDestroyed()) {
        // Skip main and llmResponse if they're bound (already handled above)
        if (this.bindWindows && (type === 'main' || type === 'llmResponse')) {
          return;
        }
        // Settings stays where the user put it, like any app window.
        if (type === 'settings') {
          return;
        }
        
        const [windowWidth, windowHeight] = window.getSize();
        
        let newX, newY;
        
        // All windows positioned at top of screen
        const topMargin = 20;
        
        switch (type) {
          case 'main':
            newX = displayX + 50;
            newY = displayY + topMargin;
            break;
          case 'chat':
            newX = displayX + displayWidth - windowWidth - 50;
            newY = displayY + topMargin;
            break;
          case 'skills':
            newX = displayX + 50;
            newY = displayY + topMargin + 100; // Slightly lower to avoid overlap
            break;
          case 'llmResponse':
            newX = displayX + (displayWidth - windowWidth) / 2;
            newY = displayY + topMargin;
            break;
          case 'settings':
            newX = displayX + (displayWidth - windowWidth) / 2;
            newY = displayY + topMargin;
            break;
          default:
            newX = displayX + 100;
            newY = displayY + topMargin;
        }
        
        window.setPosition(Math.round(newX), Math.round(newY));
        
        // Ensure always-on-top is maintained after moving
        if (process.platform === 'darwin') {
          window.setAlwaysOnTop(true, 'screen-saver', 1);
        } else {
          window.setAlwaysOnTop(true);
        }
        
        // Ensure window appears on current desktop if it's visible
        if (window.isVisible()) {
          this.showOnCurrentDesktop(window, { focus: false });
        }
        
        logger.debug('Window moved to active screen and shown on current desktop', {
          type,
          position: `${newX},${newY}`,
          isVisible: window.isVisible(),
          displayId: this.currentDisplay.id
        });
      }
    });
  }

  setupDesktopTracking() {
    // MUCH less aggressive desktop tracking
    this.desktopWatcher = setInterval(() => {
      this.trackDesktopChanges();
    }, 10000); // Changed from 1500ms to 10000ms (10 seconds)

    logger.info('Desktop tracking initialized');
  }

  trackDesktopChanges() {
    if (this.isScreenBeingShared) return;

    // Simplified tracking - just log changes
    if (process.platform === 'darwin') {
      const cursorPoint = screen.getCursorScreenPoint();
      const currentSpaceSignature = `${cursorPoint.x}_${cursorPoint.y}`;
      
      if (this.lastActiveSpace && this.lastActiveSpace !== currentSpaceSignature) {
        logger.debug('Desktop space might have changed');
      }
      
      this.lastActiveSpace = currentSpaceSignature;
    }
  }

  // REMOVED all the aggressive enforcement methods that were causing flickering:
  // - handlePossibleSpaceChange()
  // - handleSpaceChange() 
  // - ensureWindowVisibility()
  // - enforceWindowProperties()
  // - enforceAllWindowProperties()
  // - enforceAlwaysOnTop()

  // Public methods for manual screen sharing control
  enableScreenSharingMode() {
    this.startScreenSharingMode();
  }

  disableScreenSharingMode() {
    this.stopScreenSharingMode();
  }

  isInScreenSharingMode() {
    return this.isScreenBeingShared;
  }

  // Window binding management methods
  setWindowBinding(enabled) {
    this.bindWindows = enabled;
    
    if (enabled) {
      // Position bound windows when binding is enabled
      const mainWindow = this.windows.get('main');
      const llmWindow = this.windows.get('llmResponse');
      
      if (mainWindow && llmWindow) {
        this.positionBoundWindows();
      }
      
      logger.info('Window binding enabled');
    } else {
      logger.info('Window binding disabled');
    }
    
    return this.bindWindows;
  }

  toggleWindowBinding() {
    return this.setWindowBinding(!this.bindWindows);
  }

  getWindowBindingStatus() {
    return {
      enabled: this.bindWindows,
      gap: this.windowGap,
      position: this.boundWindowsPosition
    };
  }

  setWindowGap(gap) {
    this.windowGap = Math.max(0, gap);
    
    // Re-position if currently bound
    if (this.bindWindows) {
      this.positionBoundWindows();
    }
    
    logger.debug('Window gap updated', { gap: this.windowGap });
    return this.windowGap;
  }

  showChatWindow() {
    const chatWindow = this.windows.get('chat');
    if (chatWindow && !chatWindow.isDestroyed()) {
      this.showOnCurrentDesktop(chatWindow);
      logger.debug('Chat window shown');
    }
  }

  hideChatWindow() {
    const chatWindow = this.windows.get('chat');
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.hide();
      logger.debug('Chat window hidden');
    }
  }

  handleRecordingStarted() {
    this.isRecording = true;
    this.showChatWindow();
    // Notify all windows about recording state
    this.broadcastToAllWindows('recording-started');
    logger.debug('Recording started, chat window shown');
  }

  handleRecordingStopped() {
    this.isRecording = false;
    // Notify all windows about recording state
    this.broadcastToAllWindows('recording-stopped');
    logger.debug('Recording stopped, chat window kept visible for the response');
  }

  broadcastSkillChange(skill) {
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.webContents.send('skill-changed', { skill });
      }
    });
    
    logger.info('Skill change broadcasted to all windows', { 
      skill,
      windowCount: this.windows.size 
    });
    }
}

module.exports = new WindowManager();
