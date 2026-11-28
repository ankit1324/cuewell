// Use electronAPI from preload script instead of direct require
const whysperAPI = window.electronAPI;

const chatMessages = document.getElementById('chatMessages');
const recordingIndicator = document.getElementById('recordingIndicator');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const stopButton = document.getElementById('stopButton');
const micButton = document.getElementById('micButton');
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

// Live answers. Main sends transcription-llm-response-start, then -chunk
// events, then transcription-llm-response (or llm-error), all with the same
// messageId. Each request gets one assistant row: the "Thinking…" row
// becomes the streaming text, with its code split out into snippet cards
// below it as it arrives, which is also how the final answer looks, so the
// end of a stream moves nothing. Markdown is re-rendered at most every
// STREAM_RENDER_INTERVAL_MS and only the blocks that changed are replaced;
// copy buttons and Prism wait for the final answer.
const STREAM_RENDER_INTERVAL_MS = 80;
const streams = new Map(); // messageId -> { el, text, timer, lastRenderAt, live, cards }
const finishedStreamIds = new Set();
const FINISHED_ID_LIMIT = 100;

const EMPTY_ANSWER_MESSAGE = 'No answer came back from the AI provider. Try asking again.';
// A stopped answer keeps its text; this shows when none had arrived yet.
const STOPPED_EMPTY_MESSAGE = 'Stopped before any text arrived.';
// Longest provider note shown with an answer ("Answered by Claude because ...").
const MAX_NOTE_LENGTH = 200;

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
  // Answers still streaming continue in a new row if more text arrives.
  streams.forEach(entry => { if (entry.timer) clearTimeout(entry.timer); });
  streams.clear();
  syncStopButton();
  // Clear DOM
  if (chatMessages) chatMessages.innerHTML = '';
}

function applyMicVisibility() {
  if (micButton) {
    micButton.style.display = speechAvailable ? '' : 'none';
  }
  // Shown by CSS while the message list is empty.
  if (chatMessages) {
    chatMessages.dataset.empty = speechAvailable
      ? 'Type a question below, or press Alt+R to ask by voice.'
      : 'Type a question below to ask the AI.';
  }
}

async function initSpeechAvailability() {
  try {
    if (window.electronAPI && window.electronAPI.getSpeechAvailability) {
      speechAvailable = await window.electronAPI.getSpeechAvailability();
      applyMicVisibility();
    }
  } catch (_) {
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
  label.textContent = type === 'transcription' ? 'Heard' : 'Cuewell';
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

  chatMessages.appendChild(buildMessage(text, type, !skipPersist));
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (!skipPersist) {
    chatHistory.push({ kind: 'message', type, text });
    saveHistory();
  }
}

// One message row; `rise` plays the entry animation.
function buildMessage(text, type, rise) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;
  // Rise in only for new messages, not when replaying saved history.
  if (rise) messageDiv.classList.add('oc-rise');

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
  return messageDiv;
}

// Markdown formatter (src/ui/markdown-render.js, backed by marked)
function formatMarkdown(text) {
  if (!text) return '';
  if (typeof window.renderMarkdown === 'function') return window.renderMarkdown(normalizeSectionHeadings(text));
  console.warn('Markdown renderer not loaded, showing plain text');
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// A "Thinking…" row that no request has claimed yet, added by a typed send
// (origin "chat") or a heard fragment ("voice"). Claimed rows carry
// data-message-id and belong to that request's stream. The oldest one is
// returned: requests from one origin start in the order they were asked.
function unclaimedThinking(origin) {
  return chatMessages.querySelector(`.message.thinking[data-origin="${origin}"]:not([data-message-id])`);
}

// Show thinking indicator for a question. Each typed message gets its own
// row. Voice keeps one unclaimed row, since several fragments can make one
// question; it moves below the newest fragment.
function showThinkingIndicator(origin = 'chat') {
  const waiting = origin === 'voice' ? unclaimedThinking('voice') : null;
  if (waiting) {
    chatMessages.appendChild(waiting);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return waiting;
  }
  return addThinkingRow(origin);
}

function addThinkingRow(origin) {
  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'message assistant thinking';
  thinkingDiv.id = 'thinking-indicator';
  if (origin) thinkingDiv.dataset.origin = origin;

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
  return thinkingDiv;
}

// Hide the unclaimed thinking indicators. A claimed one is replaced by its
// own request's answer or error.
function hideThinkingIndicator() {
  chatMessages.querySelectorAll('.message.thinking:not([data-message-id])').forEach(el => el.remove());
}

function isNearBottom() {
  return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 24;
}

function rememberFinished(messageId) {
  finishedStreamIds.add(messageId);
  if (finishedStreamIds.size > FINISHED_ID_LIMIT) {
    finishedStreamIds.delete(finishedStreamIds.values().next().value);
  }
}

function rememberResponseHash(h) {
  recentResponseHashes.add(h);
  if (recentResponseHashes.size > RECENT_HASH_LIMIT) {
    recentResponseHashes.delete(recentResponseHashes.values().next().value);
  }
}

// The stream for messageId, opened on its start event (or its first chunk
// if the start was missed). Claims the "Thinking…" row its question added
// (source "chat" or "voice"), or adds one at the end (screenshots).
function openStream(messageId, source) {
  if (!chatMessages || typeof messageId !== 'string' || !messageId) return null;
  if (streams.has(messageId)) return streams.get(messageId);
  if (finishedStreamIds.has(messageId)) return null;
  const claimable = source === 'chat' || source === 'voice';
  const el = (claimable && unclaimedThinking(source)) || addThinkingRow(null);
  el.dataset.messageId = messageId;
  el.removeAttribute('id');
  const entry = { el, text: '', timer: null, lastRenderAt: 0, live: false, cards: [] };
  streams.set(messageId, entry);
  syncStopButton();
  return entry;
}

// Close the stream: its row is replaced by the caller.
function closeStream(messageId) {
  const entry = streams.get(messageId);
  if (!entry) return null;
  if (entry.timer) clearTimeout(entry.timer);
  streams.delete(messageId);
  rememberFinished(messageId);
  syncStopButton();
  return entry;
}

// ---------- Stop ----------

// The Stop button shows while an answer in this list is still running
// ("Thinking…" or streaming) and hides once every one has ended.
function syncStopButton() {
  if (!stopButton) return;
  const running = streams.size > 0;
  if (stopButton.hidden === running) {
    // Keyboard focus on the button goes back to the message box once it hides.
    if (!running && document.activeElement === stopButton && messageInput) messageInput.focus();
    stopButton.hidden = !running;
  }
  if (!running) stopButton.disabled = false;
}

// The newest running answer: main writes one answer at a time, so that is
// the one to stop.
function latestStreamId() {
  let last = null;
  streams.forEach((_entry, id) => { last = id; });
  return last;
}

async function stopCurrentAnswer() {
  const id = latestStreamId();
  if (!id || !whysperAPI || typeof whysperAPI.stopAnswer !== 'function') return;
  // Main answers with the stopped answer's final text, which hides the button.
  if (stopButton) stopButton.disabled = true;
  try {
    const result = await whysperAPI.stopAnswer(id);
    if (!result || result.stopped !== true) {
      if (stopButton) stopButton.disabled = false;
      syncStopButton();
    }
  } catch (error) {
    console.error('Failed to stop the answer:', error);
    if (stopButton) stopButton.disabled = false;
  }
}

// "Stopped" after the time in an answer row's head.
function markStopped(row) {
  const head = row && row.querySelector('.message-head');
  if (!head || head.querySelector('.message-stopped')) return;
  const mark = document.createElement('span');
  mark.className = 'message-stopped';
  mark.textContent = 'Stopped';
  head.appendChild(mark);
}

function appendStreamDelta(messageId, delta) {
  if (typeof delta !== 'string' || !delta) return;
  const entry = openStream(messageId);
  if (!entry) return;
  entry.text += delta;
  if (entry.timer) return;
  const wait = STREAM_RENDER_INTERVAL_MS - (Date.now() - entry.lastRenderAt);
  if (wait <= 0) renderStream(entry);
  else entry.timer = setTimeout(() => renderStream(entry), wait);
}

// A retry or fallback in main starts the answer over: drop the text shown
// so far and put the row back to "Thinking…" until the new text arrives.
function resetStream(messageId) {
  const entry = streams.get(messageId);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.text = '';
  if (!entry.live) return;
  entry.live = false;
  removeCards(entry);
  entry.el.classList.remove('streaming', 'no-text');
  entry.el.classList.add('thinking');
  const textDiv = entry.el.querySelector('.message-text');
  if (!textDiv) return;
  textDiv.classList.remove('oc-prose', 'oc-fade-in');
  const shimmer = document.createElement('span');
  shimmer.className = 'oc-shimmer';
  shimmer.textContent = 'Thinking…';
  textDiv.replaceChildren(shimmer);
}

function renderStream(entry) {
  entry.timer = null;
  if (!entry.el.isConnected || !entry.text) return;
  entry.lastRenderAt = Date.now();
  const follow = isNearBottom();
  makeRowLive(entry);
  const { text: prose, blocks } = splitCodeBlocks(entry.text);
  showRowProse(entry, prose, blocks.length > 0);
  syncCards(entry, blocks);
  if (follow) chatMessages.scrollTop = chatMessages.scrollHeight;
}

// The first text replaces "Thinking…" with a short fade, in place.
function makeRowLive(entry) {
  if (entry.live) return;
  entry.live = true;
  entry.el.classList.remove('thinking');
  entry.el.classList.add('streaming');
  const textDiv = entry.el.querySelector('.message-text');
  if (!textDiv) return;
  textDiv.classList.add('oc-prose', 'oc-fade-in');
  textDiv.replaceChildren();
}

// The row's prose. An answer that is only code keeps just the row's head
// above its snippet cards.
function showRowProse(entry, prose, hasBlocks) {
  const textDiv = entry.el.querySelector('.message-text');
  if (!textDiv) return;
  const hasProse = !!(prose && prose.trim());
  entry.el.classList.toggle('no-text', !hasProse && hasBlocks);
  patchChildren(textDiv, hasProse ? sanitizeHtml(formatMarkdown(prose)) : '', { math: true });
}

// Make the snippet cards after the row match `blocks`: new blocks get a
// card, the growing last block has its text updated, and cards for blocks
// that are gone (a retry) are removed.
function syncCards(entry, blocks) {
  blocks.forEach((block, index) => {
    const lang = (block.language || 'text').toLowerCase();
    let card = entry.cards[index];
    if (!card) {
      const after = index > 0 ? entry.cards[index - 1] : entry.el;
      card = buildSnippet(lang, block.code, { rise: false, copy: false });
      chatMessages.insertBefore(card, after.nextSibling);
      entry.cards.push(card);
      return;
    }
    const label = card.querySelector('.code-head .oc-label');
    if (label && label.textContent !== codeLabel(lang)) label.textContent = codeLabel(lang);
    const codeEl = card.querySelector('pre code');
    if (codeEl && codeEl.textContent !== block.code) {
      codeEl.className = `language-${lang}`;
      codeEl.textContent = block.code;
    }
  });
  removeCards(entry, blocks.length);
}

function removeCards(entry, keep = 0) {
  while (entry.cards.length > keep) entry.cards.pop().remove();
}

// Make target's children match `html`, keeping the leading children that
// are already identical, so the start of a streaming answer is not redrawn.
function patchChildren(target, html, { math = false } = {}) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  if (math && window.renderMathInElement) window.renderMathInElement(fragment);
  const current = Array.from(target.childNodes);
  const next = Array.from(fragment.childNodes);
  let same = 0;
  while (same < current.length && same < next.length && current[same].isEqualNode(next[same])) same++;
  for (let i = current.length - 1; i >= same; i--) target.removeChild(current[i]);
  for (let i = same; i < next.length; i++) target.appendChild(next[i]);
}

// The note main adds when a backup provider answered, or ''.
function providerNoteOf(metadata) {
  const note = metadata && typeof metadata.providerNote === 'string' ? metadata.providerNote.trim() : '';
  return note.slice(0, MAX_NOTE_LENGTH);
}

// The provider note under an answer row's head (plain text).
function addRowNote(row, note) {
  if (!row || !note || row.querySelector('.message-note')) return;
  const head = row.querySelector('.message-head');
  const p = document.createElement('p');
  p.className = 'message-note';
  p.textContent = note;
  if (head) head.after(p);
  else row.prepend(p);
}

// The final answer for messageId: the row keeps its place and becomes the
// answer's prose, and its snippet cards get copy buttons and highlighting.
// A stopped answer (`stopped`) keeps the text received so far and is
// marked "Stopped". `note` says which provider answered when the selected
// one failed.
function finishStream(messageId, response, { stopped = false, note = '' } = {}) {
  const entry = closeStream(messageId);
  if (!entry) {
    // No row for this request (e.g. the page loaded mid-answer).
    if (!finishedStreamIds.has(messageId)) {
      hideThinkingIndicator();
      rememberFinished(messageId);
      renderAssistantResponse(response);
      if (note) addMessage(note, 'system');
    }
    return;
  }
  const text = typeof response === 'string' ? response : '';
  // Recorded so the same answer arriving again without an id is skipped.
  if (text.trim()) rememberResponseHash(hashString(text.trim()));

  const follow = isNearBottom();
  const { text: prose, blocks } = splitCodeBlocks(text);
  if (stopped && !(prose && prose.trim()) && !blocks.length) {
    // Stopped before any text: the row says so, marked "Stopped".
    removeCards(entry);
    makeRowLive(entry);
    entry.el.classList.remove('streaming', 'no-text');
    entry.el.classList.add('stopped-empty');
    const textDiv = entry.el.querySelector('.message-text');
    if (textDiv) {
      textDiv.classList.remove('oc-prose');
      textDiv.textContent = STOPPED_EMPTY_MESSAGE;
    }
    markStopped(entry.el);
    chatHistory.push({ kind: 'message', type: 'system', text: STOPPED_EMPTY_MESSAGE });
    saveHistory();
    if (follow) chatMessages.scrollTop = chatMessages.scrollHeight;
    return;
  }
  if (!(prose && prose.trim()) && !blocks.length) {
    // Nothing came back: say so instead of leaving an empty row.
    removeCards(entry);
    entry.el.replaceWith(buildMessage(EMPTY_ANSWER_MESSAGE, 'error', false));
    chatHistory.push({ kind: 'message', type: 'error', text: EMPTY_ANSWER_MESSAGE });
    saveHistory();
    if (follow) chatMessages.scrollTop = chatMessages.scrollHeight;
    return;
  }
  makeRowLive(entry);
  entry.el.classList.remove('streaming');
  showRowProse(entry, prose, blocks.length > 0);
  syncCards(entry, blocks);
  if (stopped) markStopped(entry.el);
  addRowNote(entry.el, note);
  if (prose && prose.trim()) {
    chatHistory.push({ kind: 'message', type: 'assistant', text: prose });
  }
  entry.cards.forEach((card, index) => {
    const lang = (blocks[index].language || 'text').toLowerCase();
    finishSnippet(card, blocks[index].code);
    chatHistory.push({ kind: 'snippet', language: lang, code: blocks[index].code || '' });
  });
  saveHistory();
  if (follow) chatMessages.scrollTop = chatMessages.scrollHeight;
}

// The request failed: its row (thinking or half streamed) becomes the error.
function failStream(messageId, message) {
  const entry = closeStream(messageId);
  if (!entry) {
    // An error after this request's answer was shown changes nothing.
    if (messageId && finishedStreamIds.has(messageId)) return;
    hideThinkingIndicator();
    addMessage(message, 'error');
    return;
  }
  const follow = isNearBottom();
  removeCards(entry);
  entry.el.replaceWith(buildMessage(message, 'error', false));
  chatHistory.push({ kind: 'message', type: 'error', text: message });
  saveHistory();
  if (follow) chatMessages.scrollTop = chatMessages.scrollHeight;
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
  if (wasRecording) addMessage('Stopped listening', 'system');
}

function handleTranscription(text) {
  if (text && typeof text === 'string' && text.trim().length > 0) {
    // Hide listening animation first
    hideListeningAnimation();

    // Shown right away: a delayed indicator could appear after a fast
    // error or answer had already cleared it, and then never go away.
    addMessage(text.trim(), 'transcription');
    // Main skips utterances shorter than 2 characters without a reply, so
    // they get no "Thinking…" row that nothing would remove.
    if (text.trim().length >= 2) showThinkingIndicator('voice');
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
// Keep in sync with splitCodeBlocks in src/ui/answer-page.js.
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

// Screen Help sections. The prompt asks for "#### <Heading>" lines (Problem,
// Approach, Steps, Dry run, Complexity, Edge cases; for design Steps,
// Components, Trade-offs, ...), which chat.css styles as section labels.
// Models also write them as other heading levels, "**Steps:**" on its own
// line or with numbers ("### 3. Steps"); those become "#### Steps" too. A
// "Say this" label is dropped (the answer card shows it) and so is a
// "Code" heading (the code goes in its own card). Other lines, and lines
// inside fences or indented code, are kept as written.
// Keep in sync with normalizeSectionHeadings in src/ui/answer-page.js.
function normalizeSectionHeadings(text) {
  const SECTION = /^(?:(?:the )?problem(?: in plain words| statement| restated)?|understanding the problem|approach|(?:key )?idea|intuition|steps|step[- ]by[- ]step(?: breakdown)?|algorithm|dry[- ]run(?: on the example)?|(?:example )?walkthrough|(?:time (?:and|&) space )?complexity(?: analysis)?|edge cases?|corner cases?|follow[- ]ups?|requirements|estimates|(?:high[- ]level )?design|components|data model|api|scaling|reliability|trade[- ]?offs)$/i;
  const CODE = /^(?:(?:final|solution|the) )?code(?: \([^)]*\)| in [\w+#]+)?$/i;
  const SAY = /^say this(?: first)?$/i;
  // "**Say this:**", "**Say this**" or "Say this:" in front of the first line.
  const SAY_PREFIX = /^[ \t]*(?:(?:\*\*|__)say this[ \t]*:?[ \t]*(?:\*\*|__)[ \t]*:?|say this[ \t]*:)[ \t]*(?=\S)/i;
  const label = (raw) => raw
    .replace(/^(\*\*|__)(.*)\1$/, '$2')
    .trim()
    .replace(/:$/, '')
    .replace(/^(?:step[ \t]+)?\d+[ \t]*[.):]?[ \t]+/i, '')
    .trim();
  const out = [];
  let fence = null;
  let started = false;
  String(text || '').split(/\r\n?|\n/).forEach(line => {
    const marker = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      out.push(line);
      return;
    }
    if (marker) {
      fence = marker[1];
      started = true;
      out.push(line);
      return;
    }
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    const bold = heading ? null : line.match(/^ {0,3}(\*\*|__)(.+?)\1[ \t]*:?[ \t]*$/);
    const name = heading ? label(heading[1]) : bold ? label(bold[2]) : '';
    const first = !started && line.trim() !== '';
    if (line.trim()) started = true;
    if (name && name.length <= 40) {
      if (CODE.test(name) || (first && SAY.test(name))) {
        if (first) started = false;
        return;
      }
      if (SECTION.test(name)) {
        out.push('#### ' + name);
        return;
      }
    }
    out.push(first ? line.replace(SAY_PREFIX, '') : line);
  });
  return out.join('\n');
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
// A snippet card. `rise` plays the entry animation (not for cards that
// appear while an answer streams); `copy` adds the copy button and
// highlights the code, which a streaming card gets from finishSnippet.
// Display name for a code block's language (same names as the answer window).
function codeLabel(lang) {
  const names = { cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#', js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', py: 'Python', python: 'Python', java: 'Java', c: 'C', go: 'Go', rust: 'Rust', sql: 'SQL', bash: 'Bash', sh: 'Shell' };
  const key = String(lang || '').toLowerCase();
  return names[key] || lang;
}

function buildSnippet(language, code, { rise = true, copy = true } = {}) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant snippet';
  if (rise) messageDiv.classList.add('oc-rise');
  const timeDiv = document.createElement('div');
  timeDiv.className = 'message-time';
  timeDiv.textContent = new Date().toLocaleTimeString();
  const textDiv = document.createElement('div');
  textDiv.className = 'message-text oc-prose';

  const lang = (language || 'text').toLowerCase();
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.className = `language-${lang}`;
  codeEl.textContent = code || '';

  pre.appendChild(codeEl);

  const label = document.createElement('span');
  label.className = 'oc-label';
  label.textContent = codeLabel(lang);

  const head = document.createElement('div');
  head.className = 'code-head';
  head.appendChild(label);

  const block = document.createElement('div');
  block.className = 'code-block';
  block.appendChild(head);
  block.appendChild(pre);

  textDiv.appendChild(block);

  messageDiv.appendChild(buildMessageHead('assistant', timeDiv));
  messageDiv.appendChild(textDiv);
  if (copy) finishSnippet(messageDiv, code);
  return messageDiv;
}

// Add the copy button (the head bar is as tall as the button, so nothing
// moves) and highlight the code. Prism keeps the code's font and line
// height, so the card does not change size.
function finishSnippet(card, code) {
  const head = card.querySelector('.code-head');
  if (head && !head.querySelector('.copy-btn')) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.type = 'button';
    copyBtn.setAttribute('aria-label', 'Copy code');
    copyBtn.textContent = 'Copy';
    attachCopy(copyBtn, code || '');
    head.appendChild(copyBtn);
  }
  const codeEl = card.querySelector('pre code');
  try { if (codeEl && window.Prism && Prism.highlightElement) { Prism.highlightElement(codeEl); } } catch (_) {}
}

function addCodeSnippet(language, code, skipPersist = false) {
  if (!chatMessages) return;
  const lang = (language || 'text').toLowerCase();
  chatMessages.appendChild(buildSnippet(lang, code, { rise: !skipPersist, copy: true }));
  chatMessages.scrollTop = chatMessages.scrollHeight;

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
  rememberResponseHash(h);

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

  // Main kept the answer on screen instead of answering what was heard
  // (it sounded like thinking aloud, not a new question): drop its
  // "Thinking…" row and say why.
  if (whysperAPI.onTranscriptionIgnored) {
    whysperAPI.onTranscriptionIgnored((event, data) => {
      const waiting = unclaimedThinking('voice');
      if (waiting) waiting.remove();
      if (data && typeof data.message === 'string' && data.message) addMessage(data.message, 'system');
    });
  }

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
    addMessage('Conversation history cleared', 'system');
  });

  // A request failed: say why instead of leaving "Thinking…" forever.
  if (whysperAPI.onLlmError) {
    whysperAPI.onLlmError((event, data) => {
      const message = String((data && data.error) || 'The AI request failed.');
      failStream(data && data.messageId, message);
    });
  }

  if (whysperAPI.onTranscriptionLlmResponseStart) {
    whysperAPI.onTranscriptionLlmResponseStart((event, data) => {
      if (data) openStream(data.messageId, data.source);
    });
  }
  if (whysperAPI.onTranscriptionLlmResponseChunk) {
    whysperAPI.onTranscriptionLlmResponseChunk((event, data) => {
      if (!data) return;
      if (data.reset === true) resetStream(data.messageId);
      else appendStreamDelta(data.messageId, data.delta);
    });
  }

  // Final answer: text + snippets, replacing the streamed row.
  whysperAPI.onTranscriptionLlmResponse((event, data) => {
    if (!data) return;
    if (typeof data.messageId === 'string' && data.messageId) {
      finishStream(data.messageId, data.response, {
        stopped: data.stopped === true,
        note: providerNoteOf(data.metadata)
      });
    } else if (data.response) {
      try { hideThinkingIndicator(); } catch (_) {}
      renderAssistantResponse(data.response);
    }
  });
}

// UI Event Listeners
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', () => clearChatHistory());
}

if (stopButton) {
  const mac = document.documentElement.dataset.platform === 'darwin';
  stopButton.title = `Stop the answer (${mac ? '\u2318\u21e7X' : 'Ctrl+Shift+X'}, or Esc)`;
  stopButton.addEventListener('click', () => stopCurrentAnswer());
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
          await whysperAPI.stopSpeechRecognition();
        }
      } else {
        if (whysperAPI) {
          await whysperAPI.startSpeechRecognition();
        }
      }
    } catch (_) {
      addMessage('Voice input could not start. Check the microphone permission and the speech settings.', 'error');
    }
  });
}

// Send a typed message to the main process (session memory + LLM). The
// answer arrives as stream events; a rejected message ends "Thinking…" here.
// thinkingRow is the row showThinkingIndicator added for this message.
async function sendTypedMessage(text, thinkingRow) {
  const fail = (message) => {
    // Removed only if no answer has claimed it.
    if (thinkingRow && !thinkingRow.dataset.messageId) thinkingRow.remove();
    addMessage(message, 'error');
  };
  try {
    if (whysperAPI && whysperAPI.sendChatMessage) {
      const result = await whysperAPI.sendChatMessage(text);
      if (result && result.success === false) {
        fail(String(result.error || 'The message could not be sent.'));
      }
    }
  } catch (error) {
    console.error('Failed to send chat message to main process:', error);
    fail('The message could not be sent.');
  }
}

if (sendButton) {
  sendButton.addEventListener('click', async () => {
    const text = messageInput.value.trim();
    if (text) {
      addMessage(text, 'user');
      messageInput.value = '';

      await sendTypedMessage(text, showThinkingIndicator('chat'));
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
        await sendTypedMessage(text, showThinkingIndicator('chat'));
      }
    }
    // If Shift+Enter, allow default to insert newline
  });
}

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Esc stops the answer being written, from anywhere in the window.
  if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && streams.size > 0) {
    e.preventDefault();
    stopCurrentAnswer();
    return;
  }
  if (e.altKey && e.key === 'r') {
    e.preventDefault();
    if (!isInteractive || !speechAvailable) return;
    micButton && micButton.click();
  }
});

// The empty message list shows a hint (see applyMicVisibility).
applyMicVisibility();
