const { contextBridge, ipcRenderer } = require('electron')

// Preload for the app's own control pages: the toolbar (index.html), Settings
// and the onboarding wizard. The chat and answer windows render AI output and
// use the smaller preload-content.js instead.
//
// Each page gets only the methods it calls. The window manager passes the
// window type as --si-window=<type>; a page cannot change its own argv. The
// main process checks the sender of every IPC message as well, so this list
// narrows what a page can reach and main enforces it.

// Platform hook for CSS: html[data-platform="darwin" | "win32" | "linux"].
// The DOM is shared with the page under contextIsolation, so this needs no
// contextBridge exposure. process.platform is available in sandboxed preloads.
;(() => {
  let applied = false
  const apply = () => {
    if (applied) return true
    try {
      const root = document.documentElement
      if (!root) return false
      const platform = typeof process !== 'undefined' && process.platform
      if (typeof platform === 'string' && platform) root.dataset.platform = platform
      applied = true
    } catch (_) {}
    return applied
  }
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

function windowType() {
  const prefix = '--si-window='
  const argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : []
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : ''
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

// window.api: a named send/receive pair, limited to the given channels.
function channelApi(sendChannels, receiveChannels) {
  return {
    send: (channel, data) => {
      if (sendChannels.includes(channel)) {
        ipcRenderer.send(channel, data)
      } else {
        console.warn('Invalid IPC channel:', channel)
      }
    },
    receive: (channel, func) => {
      if (receiveChannels.includes(channel) && typeof func === 'function') {
        ipcRenderer.on(channel, (_event, ...args) => func(...args))
      }
    }
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
    api: channelApi([], ['interaction-mode-changed', 'skill-updated'])
  }),

  // Settings (settings.html, src/ui/settings-window.js)
  settings: () => ({
    electronAPI: {
      getSettings: invoke('get-settings'),
      saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
      quit,
      onCodingLanguageChanged: listen('coding-language-changed'),
      onSettingsWindowShown: listen('settings-window-shown')
    },
    api: channelApi(['close-settings', 'quit-app', 'update-skill'], ['load-settings'])
  }),

  // First-run wizard (onboarding.html, onboarding.js)
  onboarding: () => ({
    electronAPI: {
      getFirstRunStatus: invoke('get-first-run-status'),
      completeFirstRun: invoke('complete-first-run'),
      closeOnboarding: invoke('close-onboarding'),
      saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
      detectWhisper: invoke('detect-whisper'),
      installWhisper: invoke('install-whisper'),
      downloadWhisperModel: (modelName) => ipcRenderer.invoke('download-whisper-model', modelName),
      onInstallProgress: listen('install-progress')
    }
  })
}

const build = PAGES[windowType()]
if (build) {
  const exposed = build()
  for (const [name, value] of Object.entries(exposed)) {
    contextBridge.exposeInMainWorld(name, value)
  }
} else {
  console.error('preload: unknown window type; no API exposed')
}
