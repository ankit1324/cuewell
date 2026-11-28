const { contextBridge, ipcRenderer } = require('electron')

// Preload for the app's own control pages: the toolbar (index.html), Settings
// and the onboarding wizard. The chat and answer windows render AI output and
// use the smaller preload-content.js instead.
//
// Each page gets only the methods it calls. The window manager passes the
// window type as --si-window=<type>; a page cannot change its own argv. The
// main process checks the sender of every IPC message as well, so this list
// narrows what a page can reach and main enforces it.

// Platform and theme hooks for CSS: html[data-platform="darwin" | "win32" |
// "linux"] and html[data-theme="light" | "dark" | "system"] (theme.css). The
// DOM is shared with the page under contextIsolation, so neither needs a
// contextBridge exposure. process.platform is available in sandboxed
// preloads. The window manager passes the saved theme as --si-theme=<theme>,
// so the first frame already has it, and main sends theme-changed with
// { theme } when it changes. Anything else is ignored.
;(() => {
  const THEMES = ['light', 'dark', 'system']
  const isTheme = (value) => typeof value === 'string' && THEMES.includes(value)
  const argTheme = argValue('--si-theme=')
  let theme = isTheme(argTheme) ? argTheme : 'system'
  let applied = false
  const setTheme = () => {
    try {
      const root = document.documentElement
      if (root) root.dataset.theme = theme
    } catch (_) {}
  }
  const apply = () => {
    if (applied) return true
    try {
      const root = document.documentElement
      if (!root) return false
      const platform = typeof process !== 'undefined' && process.platform
      if (typeof platform === 'string' && platform) root.dataset.platform = platform
      root.dataset.theme = theme
      applied = true
    } catch (_) {}
    return applied
  }
  try {
    ipcRenderer.on('theme-changed', (_event, data) => {
      const next = data && typeof data === 'object' ? data.theme : null
      if (!isTheme(next)) return
      theme = next
      if (applied) setTheme()
    })
  } catch (_) {}
  try {
    if (apply()) return
    const onReady = () => {
      if (!apply()) return
      document.removeEventListener('readystatechange', onReady)
      document.removeEventListener('DOMContentLoaded', onReady)
    }
    document.addEventListener('readystatechange', onReady)
    document.addEventListener('DOMContentLoaded', onReady)
  } catch (_) {}
})()

// Value of the --<name>=<value> argument the window manager passed, or ''.
function argValue(prefix) {
  const argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : []
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : ''
}

function windowType() {
  return argValue('--si-window=')
}

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)

// Subscribe to a main-process event. The callback gets the data only, never
// the IPC event (whose `sender` is the raw ipcRenderer). Returns an
// unsubscribe function.
const listen = (channel) => (callback) => {
  if (typeof callback !== 'function') return () => {}
  const wrapped = (_event, ...args) => {
    try { callback(...args) } catch (e) { console.error(`${channel} listener error:`, e) }
  }
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const quit = () => {
  try {
    ipcRenderer.send('quit-app')
  } catch (error) {
    console.error('Error in quit:', error)
  }
}

// window.api: receive by channel name, limited to the given channels. The
// toolbar only listens through it; it sends nothing.
function receiveApi(receiveChannels) {
  return {
    receive: (channel, func) => {
      if (receiveChannels.includes(channel) && typeof func === 'function') {
        ipcRenderer.on(channel, (_event, ...args) => func(...args))
      }
    }
  }
}

// Quit: main sends flush-before-quit and waits up to 1 s for
// flush-before-quit-done before it closes the windows. The page's callback
// (set with onFlushBeforeQuit) saves whatever is still pending; the ack goes
// out when its promise settles. With no callback, a blur event runs the
// page's own "focus left the window" save instead and the ack follows on the
// next task: the page's save messages are sent first, and main handles IPC
// messages from one page in order, so they are saved before the ack arrives.
// Returns the onFlushBeforeQuit method.
function flushBeforeQuit() {
  let pageCallback = null
  ipcRenderer.on('flush-before-quit', (_event, request) => {
    const id = request && Number.isInteger(request.id) ? request.id : null
    let acked = false
    const ack = () => {
      if (acked) return
      acked = true
      ipcRenderer.send('flush-before-quit-done', id)
    }
    if (!pageCallback) {
      try {
        if (typeof window !== 'undefined' && typeof Event === 'function') window.dispatchEvent(new Event('blur'))
      } catch (_) {}
      setTimeout(ack, 0)
      return
    }
    let result
    try {
      result = pageCallback()
    } catch (e) {
      console.error('flush-before-quit listener error:', e)
    }
    if (result && typeof result.then === 'function') result.then(ack, ack)
    else ack()
  })
  return (callback) => {
    if (typeof callback !== 'function') return () => {}
    pageCallback = callback
    return () => {
      if (pageCallback === callback) pageCallback = null
    }
  }
}

// Built-in voice engine (whisper.cpp), for Settings and onboarding. Model
// ids are checked in main against its model list.
function voiceApi() {
  return {
    // { engine, binaryAvailable, platformSupported, models: [{ id, label, bytes, downloaded }],
    //   selectedModel, language, pythonConfigured, ready, downloading, problemMessage, ... }
    getVoiceStatus: invoke('get-voice-status'),
    // -> { success, error?, cancelled? }; progress arrives through onVoiceModelProgress.
    downloadVoiceModel: (id) => ipcRenderer.invoke('download-voice-model', { id }),
    cancelVoiceModelDownload: (id) => ipcRenderer.invoke('cancel-voice-model-download', { id }),
    // engine: 'whispercpp' | 'python'; model: optional id for the built-in engine.
    setVoiceEngine: (engine, model) => ipcRenderer.invoke('set-voice-engine', { engine, model }),
    // callback({ id, received, total }); returns an unsubscribe function.
    onVoiceModelProgress: listen('voice-model-progress')
  }
}

const PAGES = {
  // Toolbar overlay (index.html, src/ui/main-window.js)
  main: () => ({
    electronAPI: {
      takeScreenshot: invoke('take-screenshot'),
      startSpeechRecognition: invoke('start-speech-recognition'),
      stopSpeechRecognition: invoke('stop-speech-recognition'),
      sendAudioChunk: (buffer) => ipcRenderer.send('audio-chunk', { buffer }),
      getSpeechAvailability: invoke('get-speech-availability'),
      resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', { width, height }),
      moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('move-window', { deltaX, deltaY }),
      getWindowStats: invoke('get-window-stats'),
      getSettings: invoke('get-settings'),
      // main.js accepts only { codingLanguage } from the toolbar.
      saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
      showSettings: invoke('show-settings'),
      updateActiveSkill: (skill) => ipcRenderer.invoke('update-active-skill', skill),
      // Native menu with About, Check for Updates, Settings, Report a
      // Problem, View Logs Folder and Quit (the only way to reach them on
      // Windows and Linux). x and y are optional, in window coordinates.
      showAppMenu: (x, y) => ipcRenderer.invoke('show-app-menu', { x, y }),
      notifyMainWindowReady: () => {
        try {
          ipcRenderer.send('main-window-ready')
        } catch (error) {
          console.error('Error notifying main window ready:', error)
        }
      },
      quit,
      onInteractionModeChanged: listen('interaction-mode-changed'),
      onRecordingStarted: listen('recording-started'),
      onRecordingStopped: listen('recording-stopped'),
      onSkillChanged: listen('skill-changed'),
      onSpeechAvailability: listen('speech-availability'),
      onCodingLanguageChanged: listen('coding-language-changed'),
      onMainWindowShown: listen('main-window-shown')
    },
    api: receiveApi(['interaction-mode-changed', 'skill-updated'])
  }),

  // Settings (settings.html, src/ui/settings-window.js)
  settings: () => ({
    electronAPI: {
      // Keys come back masked as { set, last4 }; main never sends a key.
      getSettings: invoke('get-settings'),
      // main.js validates every field (SETTINGS_FIELDS_BY_WINDOW.settings).
      saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
      // Version, platform, shortcuts and file locations (read-only).
      getSettingsInfo: invoke('get-settings-info'),
      // Remove one saved key by its settings field, e.g. 'openaiKey'.
      removeSecret: (field) => ipcRenderer.invoke('remove-secret', field),
      // { provider, apiKey, baseUrl, model } -> { ok, message }; saves nothing.
      // An empty apiKey tests the saved key.
      testProvider: (input) => ipcRenderer.invoke('test-provider', input),
      getWhisperStatus: invoke('get-whisper-status'),
      installWhisper: invoke('install-whisper'),
      downloadWhisperModel: (modelName) => ipcRenderer.invoke('download-whisper-model', modelName),
      onInstallProgress: listen('install-progress'),
      ...voiceApi(),
      // Interview context (userData/profile.json); main validates on save.
      getProfile: invoke('get-profile'),
      saveProfile: (profile) => ipcRenderer.invoke('save-profile', profile),
      closeSettings: () => ipcRenderer.send('close-settings'),
      quit,
      // callback() -> optional promise: save what is pending before the app
      // quits. Main waits for it at most 1 s. Returns an unsubscribe function.
      onFlushBeforeQuit: flushBeforeQuit(),
      onCodingLanguageChanged: listen('coding-language-changed'),
      onSkillUpdated: listen('skill-updated'),
      onSpeechAvailability: listen('speech-availability'),
      onSettingsWindowShown: listen('settings-window-shown')
    }
  }),

  // First-run wizard (onboarding.html, onboarding.js)
  onboarding: () => ({
    electronAPI: {
      getFirstRunStatus: invoke('get-first-run-status'),
      completeFirstRun: invoke('complete-first-run'),
      closeOnboarding: invoke('close-onboarding'),
      saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
      // { provider, apiKey, baseUrl, model } -> { ok, message }; saves nothing.
      testProvider: (input) => ipcRenderer.invoke('test-provider', input),
      detectWhisper: invoke('detect-whisper'),
      installWhisper: invoke('install-whisper'),
      downloadWhisperModel: (modelName) => ipcRenderer.invoke('download-whisper-model', modelName),
      onInstallProgress: listen('install-progress'),
      ...voiceApi()
    }
  })
}

// Own properties only: "constructor" or "__proto__" must expose nothing.
const type = windowType()
const build = Object.hasOwn(PAGES, type) ? PAGES[type] : null
if (build) {
  const exposed = build()
  for (const [name, value] of Object.entries(exposed)) {
    contextBridge.exposeInMainWorld(name, value)
  }
} else {
  console.error('preload: unknown window type; no API exposed')
}
