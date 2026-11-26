// Use electronAPI from preload script instead of direct require
const whysperAPI = window.electronAPI;

const chatMessages = document.getElementById('chatMessages');
const recordingIndicator = document.getElementById('recordingIndicator');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const micButton = document.getElementById('micButton');
const chatContainer = document.getElementById('chatContainer');
const listeningIndicator = document.getElementById('listeningIndicator');
const listeningDuration = document.getElementById('listeningDuration');
const interimOverlay = document.getElementById('interimOverlay');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

let isRecording = false;
let isInteractive = true;
let listeningStartTime = null;
let listeningTimer = null;
let speechAvailable = false;

// Chat history lives in memory for this app session only, so nothing is
// written to disk. Builds before this kept it in localStorage indefinitely.
const LEGACY_CHAT_HISTORY_KEY = 'superinterview_chat_history_v1';
const CHAT_HISTORY_LIMIT = 500;
let chatHistory = [];
const recentResponseHashes = new Set();
const RECENT_HASH_LIMIT = 50;

function hashString(str) {
  try {
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  } catch (_) {
    return String(str?.length || 0);
  }
}

function saveHistory() {
  if (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory = chatHistory.slice(-CHAT_HISTORY_LIMIT);
}

// Drop the history older builds stored at rest.
function removeLegacyHistory() {
  try {
    localStorage.removeItem(LEGACY_CHAT_HISTORY_KEY);
  } catch (e) {
    console.warn('Failed to remove stored chat history', e);
  }
}

function clearChatHistory(skipConfirm = false) {
  if (!skipConfirm) {
    const ok = confirm('Clear chat history?');
    if (!ok) return;
  }
  chatHistory = [];
  saveHistory();
  // Clear DOM
  if (chatMessages) chatMessages.innerHTML = '';
}

function applyMicVisibility() {
  if (micButton) {
    micButton.style.display = speechAvailable ? '' : 'none';
  }
}

async function initSpeechAvailability() {
  try {
    if (window.electronAPI && window.electronAPI.getSpeechAvailability) {
      speechAvailable = await window.electronAPI.getSpeechAvailability();
      applyMicVisibility();
    }
  } catch (e) {
    speechAvailable = false;
    applyMicVisibility();
  }
}

// Listen for availability changes
if (whysperAPI && whysperAPI.onSpeechAvailability) {
  whysperAPI.onSpeechAvailability((event, data) => {
    speechAvailable = !!(data && data.available);
    applyMicVisibility();
  });
}

// Also capture generic LLM responses (from OCR/screenshot flows)
if (whysperAPI && whysperAPI.onLlmResponse) {
  whysperAPI.onLlmResponse((event, data) => {
    try { hideThinkingIndicator(); } catch (_) {}
    if (data && data.response) {
      renderAssistantResponse(data.response);
    }
  });
}

// Clear on session-cleared from main
if (whysperAPI && whysperAPI.onSessionCleared) {
  whysperAPI.onSessionCleared(() => {
    clearChatHistory(true);
  });
}

// Initialize availability and clear stored history
removeLegacyHistory();
initSpeechAvailability();

// Small head row above heard and assistant messages: a label (plus the
// brand mark for assistant) and the timestamp.
function buildMessageHead(type, timeDiv) {
  const head = document.createElement('div');
  head.className = 'message-head';
  if (type !== 'transcription') {
    const mark = document.createElement('span');
    mark.className = 'oc-mark';
    mark.setAttribute('aria-hidden', 'true');
    head.appendChild(mark);
  }
  const label = document.createElement('span');
  label.className = 'oc-label';
  label.textContent = type === 'transcription' ? 'Heard' : 'Super Interview';
  head.appendChild(label);
  head.appendChild(timeDiv);
  return head;
}

// Basic message function with markdown support for assistant messages
function addMessage(text, type = 'user', skipPersist = false) {
  if (!chatMessages) {
    console.error('Chat messages element not found!');
    return;
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;
  // Rise in only for new messages, not when replaying saved history.
  if (!skipPersist) messageDiv.classList.add('oc-rise');

  const timeDiv = document.createElement('div');
  timeDiv.className = 'message-time';
  timeDiv.textContent = new Date().toLocaleTimeString();

  const textDiv = document.createElement('div');
  textDiv.className = 'message-text';

  // Format assistant messages as markdown
  if (type === 'assistant') {
    textDiv.classList.add('oc-prose');
    textDiv.innerHTML = sanitizeHtml(formatMarkdown(text));
    if (window.renderMathInElement) window.renderMathInElement(textDiv);
  } else {
    textDiv.textContent = text;
  }

  if (type === 'assistant' || type === 'transcription') {
    messageDiv.appendChild(buildMessageHead(type, timeDiv));
  } else {
    messageDiv.appendChild(timeDiv);
  }
  messageDiv.appendChild(textDiv);

  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (!skipPersist) {
    chatHistory.push({ kind: 'message', type, text });
    saveHistory();
  }
}

// Markdown formatter (src/ui/markdown-render.js, backed by marked)
function formatMarkdown(text) {
  if (!text) return '';
  if (typeof window.renderMarkdown === 'function') return window.renderMarkdown(text);
  console.warn('Markdown renderer not loaded, showing plain text');
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// Show thinking indicator. One at a time: voice can send several
// fragments for one answer, and each would otherwise add its own.
function showThinkingIndicator() {
  if (chatMessages.querySelector('.message.thinking')) return;
  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'message assistant thinking';
  thinkingDiv.id = 'thinking-indicator';

  const timeDiv = document.createElement('div');
  timeDiv.className = 'message-time';
  timeDiv.textContent = new Date().toLocaleTimeString();

  const textDiv = document.createElement('div');
  textDiv.className = 'message-text';
  const shimmer = document.createElement('span');
  shimmer.className = 'oc-shimmer';
  shimmer.textContent = 'Thinking…';
  textDiv.appendChild(shimmer);

  thinkingDiv.appendChild(buildMessageHead('assistant', timeDiv));
  thinkingDiv.appendChild(textDiv);

  chatMessages.appendChild(thinkingDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Hide thinking indicator
function hideThinkingIndicator() {
  chatMessages.querySelectorAll('.message.thinking').forEach(el => el.remove());
}

// Minimalist Listening Animation Functions
function showListeningAnimation() {
  if (listeningIndicator) {
    listeningIndicator.classList.add('active');

    // Start timer (replacing any running one, so it never leaks)
    if (listeningTimer) clearInterval(listeningTimer);
    listeningStartTime = Date.now();
    listeningTimer = setInterval(() => {
      if (listeningStartTime && listeningDuration) {
        const elapsed = Math.floor((Date.now() - listeningStartTime) / 1000);
        listeningDuration.textContent = `${elapsed}s`;
      }
    }, 1000);
  }
}

function hideListeningAnimation() {
  if (listeningIndicator) {
    listeningIndicator.classList.remove('active');
  }

  // Hide interim overlay
  if (interimOverlay) {
    interimOverlay.classList.remove('active');
  }

  // Clear timer
  if (listeningTimer) {
    clearInterval(listeningTimer);
    listeningTimer = null;
  }

  listeningStartTime = null;
}

function showInterimText(text) {
  if (!interimOverlay) return;

  // The bar sits in the layout above the input, so showing it shrinks the
  // message list; keep the list pinned to the bottom if it was there.
  const atBottom = chatMessages &&
    chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 24;

  if (text && text.trim()) {
    interimOverlay.textContent = text;
    interimOverlay.classList.add('active');
  } else {
    interimOverlay.classList.remove('active');
  }

  if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Recording Event Handlers
function handleRecordingStarted() {
  isRecording = true;

  if (recordingIndicator) {
    recordingIndicator.style.display = 'block';
  }
  if (micButton) {
    micButton.classList.add('recording');
  }

  showListeningAnimation();
}

function handleRecordingStopped() {
  const wasRecording = isRecording;
  isRecording = false;

  if (recordingIndicator) {
    recordingIndicator.style.display = 'none';
  }
  if (micButton) {
    micButton.classList.remove('recording');
  }

  hideListeningAnimation();
  if (wasRecording) addMessage('Stopped Listening', 'system');
}

function handleTranscription(text) {
  if (text && typeof text === 'string' && text.trim().length > 0) {
    // Hide listening animation first
    hideListeningAnimation();

    // Shown right away: a delayed indicator could appear after a fast
    // error or answer had already cleared it, and then never go away.
    addMessage(text.trim(), 'transcription');
    showThinkingIndicator();
  } else {
    console.warn('Invalid or empty transcription text - ignoring:', text);
  }
}

// Helpers to capture AI response into chat (text + snippets)

// Split an answer into its prose and its fenced code blocks (``` or ~~~
// on their own lines, possibly indented inside a list). When a coding
// language is set, the main process retags only opening fence lines
// (enforceProgrammingLanguage in llm.service.js) and leaves closing ones as
// written, normally a plain ```. A closing fence that ends in one word
// (```cpp) is accepted too. A fence leaves nothing in the prose: its lines
// and the blank lines around it are dropped and the text on either side is
// rejoined. A fence that is never closed, as in a cut-off answer, runs to
// the end.
// Keep in sync with splitCodeBlocks in src/ui/chat-window.js and src/ui/answer-page.js.
function splitCodeBlocks(text) {
  const prose = [];
  const blocks = [];
  const listLine = /^(?:[ \t]|[-*+][ \t]|\d+[.)][ \t])/; // list item or indented line
  let fence = null; // the block being read
  let cut = false;  // a block was removed after the last prose line
  const endBlock = () => {
    const lines = fence.lines;
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) blocks.push({ language: fence.language, code: lines.join('\n') });
    fence = null;
    cut = true;
  };
  String(text || '').split(/\r\n?|\n/).forEach(line => {
    if (fence) {
      const close = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size &&
          !close[2].includes(fence.char)) {
        endBlock();
      } else {
        // Drop the fence's own indentation, keep the code's.
        const lead = line.match(/^[ \t]*/)[0].length;
        fence.lines.push(line.slice(Math.min(lead, fence.indent)));
      }
      return;
    }
    const open = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
    // A backtick fence's info string has no backticks, so ```x``` stays inline code.
    if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
      while (prose.length && !prose[prose.length - 1].trim()) prose.pop();
      fence = {
        char: open[2][0],
        size: open[2].length,
        indent: open[1].length,
        language: open[3].trim().split(/\s+/)[0] || 'text',
        lines: []
      };
      return;
    }
    if (cut) {
      if (!line.trim()) return;
      cut = false;
      // A blank line keeps paragraphs apart; inside a list the two sides
      // are joined directly so the list stays tight.
      const before = prose[prose.length - 1];
      if (before !== undefined && !(listLine.test(before) && listLine.test(line))) prose.push('');
    }
    prose.push(line);
  });
  if (fence) endBlock();
  return { text: prose.join('\n').replace(/\n\s*\n\s*\n/g, '\n\n').trim(), blocks };
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function attachCopy(btn, codeText) {
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      let ok = false;
      if (window.electronAPI && typeof window.electronAPI.copyToClipboard === 'function') {
        ok = await window.electronAPI.copyToClipboard(codeText);
      }
      if (!ok) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(codeText);
          ok = true;
        } else {
          const ta = document.createElement('textarea');
          ta.value = codeText;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          ok = true;
        }
      }
      if (ok) {
        btn.classList.add('copied');
        const original = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.classList.remove('copied'); btn.textContent = original || 'Copy'; }, 1200);
      }
    } catch (err) {
      console.warn('Copy failed', err);
    }
  });
}
function addCodeSnippet(language, code, skipPersist = false) {
  if (!chatMessages) return;
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant snippet';
  if (!skipPersist) messageDiv.classList.add('oc-rise');
  const timeDiv = document.createElement('div');
  timeDiv.className = 'message-time';
  timeDiv.textContent = new Date().toLocaleTimeString();
  const textDiv = document.createElement('div');
  textDiv.className = 'message-text oc-prose';

  const lang = (language || 'text').toLowerCase();
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.className = `language-${lang}`;
  codeEl.innerHTML = escapeHtml(code || '');

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.type = 'button';
  copyBtn.setAttribute('aria-label', 'Copy code');
  copyBtn.textContent = 'Copy';
  attachCopy(copyBtn, code || '');

  pre.appendChild(codeEl);

  const label = document.createElement('span');
  label.className = 'oc-label';
  label.textContent = lang;

  const head = document.createElement('div');
  head.className = 'code-head';
  head.appendChild(label);
  head.appendChild(copyBtn);

  const block = document.createElement('div');
  block.className = 'code-block';
  block.appendChild(head);
  block.appendChild(pre);

  textDiv.appendChild(block);

  messageDiv.appendChild(buildMessageHead('assistant', timeDiv));
  messageDiv.appendChild(textDiv);
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try { if (window.Prism && Prism.highlightElement) { Prism.highlightElement(codeEl); } } catch (_) {}

  if (!skipPersist) {
    chatHistory.push({ kind: 'snippet', language: lang, code: code || '' });
    saveHistory();
  }
}
function renderAssistantResponse(response) {
  if (!response || typeof response !== 'string') return;
  // Deduplication: avoid processing the same response twice
  const normalized = response.trim();
  const h = hashString(normalized);
  if (recentResponseHashes.has(h)) return;
  recentResponseHashes.add(h);
  if (recentResponseHashes.size > RECENT_HASH_LIMIT) {
    const first = recentResponseHashes.values().next().value;
    recentResponseHashes.delete(first);
  }

  const { text: textOnly, blocks } = splitCodeBlocks(response);
  // Add text response first (if any)
  if (textOnly && textOnly.trim().length) {
    addMessage(textOnly, 'assistant');
  }
  // Add each code snippet separately
  blocks.forEach(b => addCodeSnippet(b.language, b.code));
}

// Basic IPC Event Listeners - simplified

// Listen for transcription events
if (whysperAPI) {
  whysperAPI.onTranscriptionReceived((event, data) => {
    if (data && data.text) {
      handleTranscription(data.text);
    } else {
      console.warn('Invalid transcription data received:', data);
    }
  });

  whysperAPI.onInterimTranscription((event, data) => {
    if (data && data.text) {
      showInterimText(data.text);
    }
  });

  // Listen for speech status
  whysperAPI.onSpeechStatus((event, data) => {
    // Only a message. Recording state follows recording-started and
    // recording-stopped: matching words here turned the final
    // "Recording stopped" status back into "recording".
    if (data && data.status) {
      addMessage(data.status, 'system');
    }
  });

  // Listen for speech errors
  whysperAPI.onSpeechError((event, data) => {
    if (data && data.error) {
      addMessage(`Speech error: ${data.error}`, 'error');
      handleRecordingStopped();
    }
  });

  // Listen for other events
  whysperAPI.onRecordingStarted(() => {
    handleRecordingStarted();
  });

  whysperAPI.onRecordingStopped(() => {
    handleRecordingStopped();
  });

  whysperAPI.onSessionCleared(() => {
    addMessage('Session memory has been cleared', 'system');
  });

  // A request failed: say why instead of leaving "Thinking…" forever.
  if (whysperAPI.onLlmError) {
    whysperAPI.onLlmError((event, data) => {
      try { hideThinkingIndicator(); } catch (_) {}
      addMessage((data && data.error) || 'The AI request failed.', 'error');
    });
  }

  // Replace transcription LLM handler to store text + snippets
  whysperAPI.onTranscriptionLlmResponse((event, data) => {
    if (data && data.response) {
      try { hideThinkingIndicator(); } catch (_) {}
      renderAssistantResponse(data.response);
    }
  });
}

// UI Event Listeners
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', () => clearChatHistory());
}

if (micButton) {
  micButton.addEventListener('click', async () => {
    if (!isInteractive) {
      addMessage('Window is in non-interactive mode. Press Alt+A to enable interaction.', 'error');
      return;
    }
    if (!speechAvailable) {
      addMessage('Speech recognition is not configured.', 'system');
      return;
    }

    try {
      if (isRecording) {
        if (whysperAPI) {
          const result = await whysperAPI.stopSpeechRecognition();
        }
      } else {
        if (whysperAPI) {
          const result = await whysperAPI.startSpeechRecognition();
        }
      }
    } catch (error) {
      addMessage("Error in recognizing speech", 'error');
    }
  });
}

if (sendButton) {
  sendButton.addEventListener('click', async () => {
    const text = messageInput.value.trim();
    if (text) {
      addMessage(text, 'user');
      messageInput.value = '';

      showThinkingIndicator();

      // Send to main process for session memory storage and LLM processing
      try {
        if (whysperAPI && whysperAPI.sendChatMessage) {
          await whysperAPI.sendChatMessage(text);
        }
      } catch (error) {
        console.error('Failed to send chat message to main process:', error);
      }
    }
  });
}

// Auto-resize for multiline textarea
function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  const max = 140; // keep within container limits
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
}
if (messageInput) {
  autoGrow(messageInput);
  messageInput.addEventListener('input', () => autoGrow(messageInput));
}

// Replace keypress with keydown to support Shift+Enter for newline and Enter to send
if (messageInput) {
  messageInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = messageInput.value.trim();
      if (text) {
        addMessage(text, 'user');
        messageInput.value = '';
        autoGrow(messageInput);
        showThinkingIndicator();
        try {
          if (whysperAPI && whysperAPI.sendChatMessage) {
            await whysperAPI.sendChatMessage(text);
          }
        } catch (error) {
          console.error('Failed to send chat message to main process:', error);
        }
      }
    }
    // If Shift+Enter, allow default to insert newline
  });
}

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'r') {
    e.preventDefault();
    if (!isInteractive || !speechAvailable) return;
    micButton && micButton.click();
  }
});

// Initialize
if (!chatHistory || chatHistory.length === 0) {
  addMessage('Recording in Progress. press Alt+R to stop recording.', 'system');
}
