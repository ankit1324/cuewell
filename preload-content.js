const { contextBridge, ipcRenderer } = require('electron')

// Preload for the windows that render AI output: the chat window (chat.html)
// and the answer window (llm-response.html). A bug in how they render an
// answer must not reach settings, API keys or anything that runs programs,
// so they get only the few methods their pages call. The window manager
// passes the window type as --si-window=<type>, and main.js checks the
// sender of every IPC message against its own list as well.

// Platform and theme hooks for CSS: html[data-platform] and html[data-theme].
// Same as in preload.js (a sandboxed preload cannot require a shared file).
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

// Subscribe to a main-process event. The IPC event object (whose `sender` is
// the raw ipcRenderer) never reaches the page. The pages' handlers are
// written as (event, data), so the first argument is a null placeholder and
// the data follows it. Returns an unsubscribe function.
const listen = (channel) => (callback) => {
  if (typeof callback !== 'function') return () => {}
  const wrapped = (_event, ...args) => {
    try { callback(null, ...args) } catch (e) { console.error(`${channel} listener error:`, e) }
  }
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const copyToClipboard = (text) => ipcRenderer.invoke('copy-to-clipboard', String(text ?? ''))
// Stop button: stops the answer with this id (main checks it is the one
// being written). Anything but a string id is sent as "the current answer".
const stopAnswer = (messageId) => ipcRenderer.invoke('stop-answer', typeof messageId === 'string' ? messageId : undefined)

const PAGES = {
  // chat.html
  chat: () => ({
    getSpeechAvailability: invoke('get-speech-availability'),
    startSpeechRecognition: invoke('start-speech-recognition'),
    stopSpeechRecognition: invoke('stop-speech-recognition'),
    sendChatMessage: (text) => ipcRenderer.invoke('send-chat-message', text),
    stopAnswer,
    copyToClipboard,
    onTranscriptionReceived: listen('transcription-received'),
    onInterimTranscription: listen('interim-transcription'),
    onTranscriptionLlmResponse: listen('transcription-llm-response'),
    onTranscriptionLlmResponseStart: listen('transcription-llm-response-start'),
    onTranscriptionLlmResponseChunk: listen('transcription-llm-response-chunk'),
    onLlmResponse: listen('llm-response'),
    onLlmError: listen('llm-error'),
    onSpeechStatus: listen('speech-status'),
    onSpeechError: listen('speech-error'),
    onSpeechAvailability: listen('speech-availability'),
    onRecordingStarted: listen('recording-started'),
    onRecordingStopped: listen('recording-stopped'),
    onSessionCleared: listen('session-cleared')
  }),

  // llm-response.html
  llmResponse: () => ({
    closeWindow: invoke('close-window'),
    stopAnswer,
    copyToClipboard,
    resizeLlmWindowForContent: (contentMetrics) => ipcRenderer.invoke('resize-llm-window-for-content', contentMetrics),
    // The button under a Screen Recording error; main decides what opens.
    openScreenRecordingSettings: () => ipcRenderer.invoke('open-screen-recording-settings'),
    onDisplayLlmResponse: listen('display-llm-response'),
    onShowLoading: listen('show-loading'),
    // Live answer: start/chunk while it streams, then the final text or an
    // error, all tied together by messageId.
    onTranscriptionLlmResponseStart: listen('transcription-llm-response-start'),
    onTranscriptionLlmResponseChunk: listen('transcription-llm-response-chunk'),
    onTranscriptionLlmResponse: listen('transcription-llm-response'),
    onLlmError: listen('llm-error')
  })
}

// Own properties only: "constructor" or "__proto__" must expose nothing.
const type = windowType()
const build = Object.hasOwn(PAGES, type) ? PAGES[type] : null
if (build) {
  contextBridge.exposeInMainWorld('electronAPI', build())
} else {
  console.error('preload-content: unknown window type; no API exposed')
}
