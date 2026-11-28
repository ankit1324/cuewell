// Answer window (llm-response.html).
//
// The page shows one of three views, stacked in the same place so switching
// never changes the layout: "empty" (nothing asked yet), "loading"
// ("Thinking…") and "answer". Views and the two answer layouts (text + code
// side by side, or one full-width panel) cross-fade instead of popping in.
//
// Main numbers every show-loading and display-llm-response message (seq).
// After drawing one, the page reports back through resizeLlmWindowForContent
// ({ phase, seq, height }): a hidden window is revealed only once its new
// state is on screen, and the final answer's height lets main fit the window
// once. Nothing is resized while text streams.

let hasCode = false;
let view = 'empty';
let layout = null;            // 'split' | 'full' | null (nothing rendered yet)
let lastSeq = null;           // seq of the latest message from main

// Syntax highlighting is throttled so repeated renders stay smooth:
// at most once every HIGHLIGHT_INTERVAL_MS, plus a trailing run after
// the last render.
const HIGHLIGHT_INTERVAL_MS = 250;
let highlightTimer = null;
let lastHighlightAt = 0;

// Live answers. For each request main sends a start event (messageId), text
// chunks, then the final answer (transcription-llm-response and
// display-llm-response) or an error (llm-error and an isError
// display-llm-response). The window shows the latest request that started
// and ignores events for older ones. While text streams, the markdown is
// re-rendered at most every STREAM_RENDER_INTERVAL_MS, and only the blocks
// that changed are replaced; Prism and the copy buttons wait for the final
// answer.
const STREAM_RENDER_INTERVAL_MS = 80;
let stream = null;            // { id, text, rendered, finished, source, skill }
let streamRenderTimer = null;
let lastStreamRenderAt = 0;
// What the last final render showed. The final answer (or error) arrives
// on two channels; the second one is not rendered again.
let shownFinalKey = null;

// "Thinking…" turns into a note that the provider is slow after this long.
const SLOW_PROVIDER_MS = 15000;
let slowTimer = null;

const EMPTY_ANSWER_MESSAGE = 'No answer came back from the AI provider. Try asking again.';
const FAILED_REQUEST_MESSAGE = 'The AI request failed. Try asking again.';
// A stopped answer keeps its text; this shows when none had arrived yet.
const STOPPED_EMPTY_MESSAGE = 'Stopped before any text arrived.';
// Longest provider note shown under an answer ("Answered by Claude because ...").
const MAX_NOTE_LENGTH = 200;
// The buttons main may ask for under an error (metadata.action).
const SCREEN_RECORDING_ACTION = 'screen-recording-settings';
const MAX_COPY_TEXT_LENGTH = 200;

window.addEventListener('error', (event) => {
    console.error('[LLM-RESPONSE] Page error:', event.message, 'at line', event.lineno);
});

initAnswerWindow();

function initAnswerWindow() {
    if (typeof window.renderMarkdown !== 'function') {
        console.error('[LLM-RESPONSE] Markdown renderer missing; answers are shown as plain text');
    }

    const api = window.electronAPI;
    if (!api) {
        console.error('[LLM-RESPONSE] electronAPI not available');
        return;
    }

    api.onShowLoading((_event, data) => {
        const info = messageInfo(data);
        if (info.appearing) holdAppear();
        resetStreamDisplay();
        setAnswerNote('');
        showLoadingState({ instant: info.appearing });
        reportDrawn('loading');
    });

    api.onTranscriptionLlmResponseStart((_event, data) => onStreamStart(data));
    api.onTranscriptionLlmResponseChunk((_event, data) => onStreamChunk(data));

    // Final answer and errors tied to the current request. They arrive
    // before the display-llm-response below.
    api.onTranscriptionLlmResponse((_event, data) => {
        if (!data || !isOpenStream(data.messageId)) return;
        const response = typeof data.response === 'string' ? data.response : '';
        setAnswerNote(providerNoteOf(data.metadata));
        if (showFinal(response, false, { stopped: data.stopped === true })) reportDrawn('final');
    });
    api.onLlmError((_event, data) => {
        if (!data || !isOpenStream(data.messageId)) return;
        setAnswerNote('');
        if (showFinal(String(data.error || FAILED_REQUEST_MESSAGE), true)) reportDrawn('final');
    });

    // The final answer or error to show (also for screenshot errors that
    // have no stream). Always reported, even when nothing changes, because
    // a hidden window waits for it.
    api.onDisplayLlmResponse((_event, data) => {
        const info = messageInfo(data);
        if (info.appearing) holdAppear();
        // The height is reported only when this message is what the window
        // now shows for good; main fits the window to it.
        let settled = false;
        try {
            if (!data || typeof data !== 'object') return;
            const metadata = data.metadata || {};
            // An answer to an older request than the one being shown.
            if (metadata.messageId && stream && metadata.messageId !== stream.id) return;
            const response = typeof data.content === 'string' ? data.content : '';
            // Without a messageId (a screenshot that failed before it
            // started) the message is shown, but an answer still
            // streaming keeps going and replaces it.
            const endsStream = !!metadata.messageId || !stream || stream.finished;
            if (endsStream) setAnswerNote(metadata.isError ? '' : providerNoteOf(metadata));
            showFinal(response, !!metadata.isError, {
                endsStream,
                instant: info.appearing,
                stopped: metadata.stopped === true,
                action: metadata.action,
                copyText: metadata.copyText
            });
            settled = endsStream;
        } catch (err) {
            console.error('[LLM-RESPONSE] Could not show the answer:', err && err.message);
        } finally {
            reportDrawn('final', { measure: settled });
        }
    });
}

// The note main adds when a backup provider answered, or ''.
function providerNoteOf(metadata) {
    const note = metadata && typeof metadata.providerNote === 'string' ? metadata.providerNote.trim() : '';
    return note.slice(0, MAX_NOTE_LENGTH);
}

// Show `text` in the note under the answer, or hide the note when empty.
// Plain text only (textContent).
function setAnswerNote(text) {
    const note = document.getElementById('answer-note');
    if (!note) return;
    const value = typeof text === 'string' ? text : '';
    if (note.textContent !== value) note.textContent = value;
    note.title = value; // the whole note when it is cut off
    note.hidden = !value;
}

// seq and appearing from a show-loading or display-llm-response message.
function messageInfo(data) {
    if (data && Number.isSafeInteger(data.seq)) lastSeq = data.seq;
    return { appearing: !!(data && data.appearing === true) };
}

// ---------- Views ----------

// Switch the visible view. `instant` skips the cross-fade (the window is
// not on screen yet, so there is nothing to fade from).
function setView(next, { instant = false } = {}) {
    const ids = { empty: 'empty-state', loading: 'loading', answer: 'response-content' };
    const els = Object.keys(ids).map(name => document.getElementById(ids[name]));
    if (instant) suspendTransitions(els.concat(document.getElementById('answer-status')));
    Object.keys(ids).forEach((name, index) => {
        const el = els[index];
        if (!el) return;
        const on = name === next;
        el.classList.toggle('is-off', !on);
        if (on) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true');
    });
    view = next;
}

// Text + code side by side ('split'), or one full-width panel ('full').
function setLayout(next, { instant = false } = {}) {
    if (layout === next) return;
    const split = document.getElementById('split-layout');
    const full = document.getElementById('full-content');
    if (instant) suspendTransitions([split, full]);
    if (split) split.classList.toggle('is-off', next !== 'split');
    if (full) full.classList.toggle('is-off', next !== 'full');
    layout = next;
}

// Apply the class changes made to `elements` in this task without
// transitions: they keep .no-motion until the new state has been styled.
function suspendTransitions(elements) {
    const list = elements.filter(Boolean);
    list.forEach(el => el.classList.add('no-motion'));
    requestAnimationFrame(() => {
        void document.body.offsetHeight; // apply the new state first
        list.forEach(el => el.classList.remove('no-motion'));
    });
}

function showLoadingState({ instant = false } = {}) {
    shownFinalKey = null;
    setLoadingText(false);
    setView('loading', { instant });
    setStatusLabel('Thinking');
    startSlowHint();
}

function startSlowHint() {
    stopSlowHint();
    slowTimer = setTimeout(() => {
        slowTimer = null;
        if (view === 'loading') setLoadingText(true);
    }, SLOW_PROVIDER_MS);
}

function stopSlowHint() {
    if (slowTimer) {
        clearTimeout(slowTimer);
        slowTimer = null;
    }
}

function setLoadingText(slow) {
    const text = document.getElementById('loading-text');
    const hint = document.getElementById('loading-hint');
    if (text) text.textContent = slow ? 'Still thinking…' : 'Thinking…';
    if (hint) hint.classList.toggle('is-off', !slow);
}

// Header status label: "Thinking" while loading, "Writing" while an answer
// streams, "Stopped" on an answer that was stopped, faded out otherwise
// (the last text stays so it can fade).
function setStatusLabel(text, { stopped = false } = {}) {
    const status = document.getElementById('answer-status');
    if (!status) return;
    if (text) status.textContent = text;
    status.classList.toggle('is-off', !text);
    status.classList.toggle('is-stopped', !!text && stopped);
}

// ---------- Stop ----------

// The Stop button shows while the request on screen is still running
// ("Thinking…" or "Writing"), and hides once it ends in any way.
function syncStopButton() {
    const btn = document.getElementById('stop-answer-btn');
    if (!btn) return;
    const running = !!(stream && !stream.finished);
    if (btn.hidden === running) {
        // Keyboard focus on the button moves to the answer once it hides
        // (not to Close, where the next Enter would close the window).
        if (!running && document.activeElement === btn) {
            const region = document.querySelector(layout === 'split'
                ? '.text-panel .panel-content'
                : '.full-content-inner');
            if (region) region.focus(); else btn.blur();
        }
        btn.hidden = !running;
    }
    if (!running) btn.disabled = false;
}

function stopCurrentAnswer() {
    const btn = document.getElementById('stop-answer-btn');
    const api = window.electronAPI;
    if (!stream || stream.finished || !api || typeof api.stopAnswer !== 'function') return;
    // Main answers with the stopped answer's final text, which hides the button.
    if (btn) btn.disabled = true;
    Promise.resolve()
        .then(() => api.stopAnswer(stream.id))
        .then(result => {
            if (!result || result.stopped !== true) {
                if (btn) btn.disabled = false;
                syncStopButton();
            }
        })
        .catch(error => {
            console.error('[LLM-RESPONSE] Could not stop the answer:', error && error.message);
            if (btn) btn.disabled = false;
        });
}

(function () {
    const btn = document.getElementById('stop-answer-btn');
    if (!btn) return;
    const mac = document.documentElement.dataset.platform === 'darwin';
    btn.title = 'Stop the answer (' + (mac ? '\u2318\u21e7X' : 'Ctrl+Shift+X') + ')';
    btn.addEventListener('click', stopCurrentAnswer);
})();

// ---------- Window appear ----------

// The window is about to appear: put the page in the first frame of the
// appear animation and hold it there until main has shown the window.
let appearReleaseTimer = null;
function holdAppear() {
    const surface = document.querySelector('.main-container');
    if (!surface) return;
    surface.classList.remove('oc-appear', 'is-held');
    void surface.offsetWidth; // restart the animation
    surface.classList.add('oc-appear', 'is-held');
    if (appearReleaseTimer) clearTimeout(appearReleaseTimer);
    // Never stay held, even if main does not answer.
    appearReleaseTimer = setTimeout(releaseAppear, 400);
}

function releaseAppear() {
    if (appearReleaseTimer) {
        clearTimeout(appearReleaseTimer);
        appearReleaseTimer = null;
    }
    const surface = document.querySelector('.main-container');
    if (surface) surface.classList.remove('is-held');
}

document.addEventListener('animationend', (event) => {
    const surface = document.querySelector('.main-container');
    if (!surface || !surface.classList.contains('oc-appear')) return;
    if (event.target === surface || event.target.parentElement === surface) {
        surface.classList.remove('oc-appear', 'is-held');
    }
});

// Tell main that the current state is drawn: after two animation frames the
// new frame has been produced. A final answer that is on screen for good
// (`measure`) also carries the window height its content needs; without it
// main only reveals a window that is waiting, and resizes nothing.
function reportDrawn(phase, { measure = phase === 'final' } = {}) {
    const seq = lastSeq;
    const api = window.electronAPI;
    if (seq === null || !api || typeof api.resizeLlmWindowForContent !== 'function') {
        releaseAppear();
        return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const report = { phase, seq };
        if (phase === 'final' && measure) report.height = neededWindowHeight();
        Promise.resolve()
            .then(() => api.resizeLlmWindowForContent(report))
            .catch(error => console.error('[LLM-RESPONSE] Could not report the answer size:', error && error.message))
            .finally(releaseAppear);
    }));
}

// Height of the title bar, the provider note (when shown) and what the
// visible view needs, in CSS pixels.
function neededWindowHeight() {
    const header = document.querySelector('.window-header');
    const headerHeight = header ? header.getBoundingClientRect().height : 40;
    const note = document.getElementById('answer-note');
    const noteHeight = note && !note.hidden ? note.getBoundingClientRect().height : 0;
    const measure = (content, scroller) => {
        if (!content || !scroller) return 0;
        const style = getComputedStyle(scroller);
        return content.getBoundingClientRect().height +
            (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    };
    let contentHeight;
    if (view === 'answer' && layout === 'split') {
        contentHeight = Math.max(
            measure(document.getElementById('text-content'), document.querySelector('.text-panel .panel-content')),
            measure(document.getElementById('code-content'), document.querySelector('.code-panel .panel-content'))
        );
    } else if (view === 'answer') {
        contentHeight = measure(document.getElementById('full-markdown'), document.querySelector('.full-content-inner'));
    } else {
        const el = document.getElementById(view === 'loading' ? 'loading' : 'empty-state');
        contentHeight = el ? el.scrollHeight : 0;
    }
    return Math.ceil(headerHeight + noteHeight + contentHeight);
}

// ---------- Streams ----------

// True when messageId is the request being shown and it has not ended yet.
function isOpenStream(messageId) {
    return !!(stream && !stream.finished && messageId && stream.id === messageId);
}

function cancelStreamRender() {
    if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
    }
}

function endStream() {
    cancelStreamRender();
    if (stream) stream.finished = true;
    syncStopButton();
}

// A new loading state: whatever the previous request still had queued must
// not draw over it.
function resetStreamDisplay() {
    cancelStreamRender();
    if (highlightTimer) {
        clearTimeout(highlightTimer);
        highlightTimer = null;
    }
}

function onStreamStart(data) {
    const id = data && typeof data.messageId === 'string' ? data.messageId : '';
    if (!id) return;
    resetStreamDisplay();
    // source ('screenshot', ...) and skill (the mode) shape the streaming layout.
    const source = typeof data.source === 'string' ? data.source : '';
    const skill = typeof data.skill === 'string' ? data.skill : '';
    stream = { id, text: '', rendered: false, finished: false, source, skill };
    shownFinalKey = null;
    setAnswerNote('');
    syncStopButton();
}

function onStreamChunk(data) {
    if (data && data.reset === true) {
        resetStream(data.messageId);
        return;
    }
    if (!data || typeof data.delta !== 'string' || !data.delta) return;
    const id = typeof data.messageId === 'string' ? data.messageId : '';
    // No start seen (e.g. the page loaded mid-answer): follow this stream.
    if (!stream && id) {
        stream = { id, text: '', rendered: false, finished: false, source: '', skill: '' };
        syncStopButton();
    }
    if (!isOpenStream(id)) return;
    stream.text += data.delta;
    if (streamRenderTimer) return;
    const wait = STREAM_RENDER_INTERVAL_MS - (Date.now() - lastStreamRenderAt);
    if (wait <= 0) renderStreamNow();
    else streamRenderTimer = setTimeout(renderStreamNow, wait);
}

// A retry or fallback in main starts the answer over: drop the text shown
// so far and go back to "Thinking…" until the new text arrives.
function resetStream(messageId) {
    if (!isOpenStream(messageId)) return;
    cancelStreamRender();
    stream.text = '';
    if (!stream.rendered) return;
    stream.rendered = false;
    showLoadingState();
}

function renderStreamNow() {
    streamRenderTimer = null;
    if (!stream || stream.finished || !stream.text) return;
    lastStreamRenderAt = Date.now();
    const first = !stream.rendered;
    stream.rendered = true;
    // The first text replaces "Thinking…" and starts at the top.
    renderAnswer(stream.text, {
        isError: false,
        final: false,
        fresh: first,
        screen: stream.source === 'screenshot',
        codingMode: stream.skill === 'dsa'
    });
    if (first) {
        stopSlowHint();
        setView('answer');
    }
    setStatusLabel('Writing');
}

// Show the final answer or error. Replaces whatever is on screen: the
// streamed text, "Thinking…" (a request that sent no chunks) or an older
// answer. A stopped answer (`stopped`) keeps the text received so far and
// is marked "Stopped" in the header. An error may carry an `action` (the
// buttons under it) and the `copyText` its Copy button copies. Returns false
// when it was already on screen.
function showFinal(text, isError, { endsStream = true, instant = false, stopped = false, action = null, copyText = null } = {}) {
    const streamed = !!(stream && !stream.finished && stream.rendered);
    if (endsStream) endStream();
    stopSlowHint();
    let body = typeof text === 'string' ? text : '';
    if (stopped) isError = false;
    if (!body.trim()) {
        body = stopped ? STOPPED_EMPTY_MESSAGE : EMPTY_ANSWER_MESSAGE;
        isError = !stopped;
    }
    const status = stopped ? 'Stopped' : null;
    const actions = isError ? errorActions(action, copyText) : null;
    const key = (stopped ? 'stopped:' : isError ? 'error:' : 'answer:') +
        (actions ? `${actions.action}:${actions.copyText || ''}:` : '') + body;
    if (key === shownFinalKey && view === 'answer') {
        setStatusLabel(status, { stopped });
        return false;
    }
    shownFinalKey = key;
    // A streamed answer keeps the reader's scroll position; a new one starts at the top.
    renderAnswer(body, { isError, final: true, fresh: !streamed, instant });
    if (actions) appendErrorActions(actions);
    setView('answer', { instant });
    setStatusLabel(status, { stopped });
    return true;
}

// ---------- Rendering ----------

// The panels that scroll: text and code (split layout) and the full view.
function scrollContainers() {
    return [
        document.querySelector('.text-panel .panel-content'),
        document.querySelector('.code-panel .panel-content'),
        document.querySelector('.full-content-inner')
    ].filter(el => el !== null);
}

// A panel the reader has scrolled to the bottom of keeps following the
// text. One still at the top stays there, so the first line (the one to
// say first) does not scroll away while the rest streams in.
function isFollowing(el) {
    return el.scrollTop > 0 && el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

// Make target's children match `html`, keeping the leading children that
// are already identical. While an answer streams only the last block or two
// change, so the blocks above are never redrawn and cannot jump.
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

function scheduleHighlight() {
    if (typeof Prism === 'undefined') return;
    const wait = HIGHLIGHT_INTERVAL_MS - (Date.now() - lastHighlightAt);
    if (wait <= 0) {
        runHighlight();
    } else if (!highlightTimer) {
        highlightTimer = setTimeout(runHighlight, wait);
    }
}

function runHighlight() {
    if (highlightTimer) {
        clearTimeout(highlightTimer);
        highlightTimer = null;
    }
    lastHighlightAt = Date.now();
    const root = document.getElementById('response-content');
    if (!root || typeof Prism === 'undefined' || !Prism.highlightElement) return;
    // Only blocks that name a language; Prism would otherwise rewrite
    // plain blocks for no visual gain. The page styles code the same before
    // and after highlighting, so line heights do not change.
    root.querySelectorAll('pre code[class*="language-"]').forEach(codeEl => {
        try { Prism.highlightElement(codeEl); } catch (_) {}
    });
}

// Normalize a fence info string into a Prism language id.
function normalizeLanguage(lang) {
    const l = String(lang || 'text').toLowerCase();
    const aliases = { 'c++': 'cpp', 'golang': 'go', 'py3': 'python', 'python3': 'python', 'node': 'javascript' };
    return aliases[l] || l.replace(/[^\w-]/g, '') || 'text';
}

// Display name for the code panel header; "Code" when no language is given.
function languageLabel(lang) {
    const l = String(lang || '').toLowerCase();
    if (!l || l === 'text' || l === 'plain' || l === 'plaintext' || l === 'txt') return 'Code';
    const names = { 'cpp': 'C++', 'c++': 'C++', 'cs': 'C#', 'csharp': 'C#', 'js': 'JavaScript', 'ts': 'TypeScript', 'py': 'Python' };
    return names[l] || l;
}

// Not named renderMarkdown: a top-level function here would replace
// window.renderMarkdown from markdown-render.js. Screen Help section labels
// are normalized first (normalizeSectionHeadings).
function renderAnswerMarkdown(text) {
    if (typeof window.renderMarkdown === 'function') {
        return window.renderMarkdown(normalizeSectionHeadings(text));
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
}

// Render an answer: prose on the left and code on the right, or one panel
// when there is no code. While streaming (final false) code is plain text;
// the final render adds copy buttons and Prism highlighting. `fresh` (a new
// answer) scrolls the panels back to the top before drawing; `instant`
// switches the layout without a cross-fade. A screenshot answer (`screen`)
// to a coding question writes its code last; while it streams, the split
// layout opens early with a pending code card (from the first text in
// Coding mode, `codingMode`, otherwise once expectsCodePanel sees a coding
// section), so the text does not re-wrap into the left panel at the end.
function renderAnswer(response, { isError = false, final = true, fresh = false, instant = false, screen = false, codingMode = false } = {}) {
    const responseElement = document.getElementById('response-content');
    if (!responseElement || !response) return;
    // Buttons belong to the error they were shown with.
    responseElement.querySelectorAll('.answer-actions').forEach(el => el.remove());

    // Measured before the DOM changes.
    const containers = scrollContainers();
    const following = fresh ? [] : containers.filter(isFollowing);
    if (fresh) {
        containers.forEach(el => {
            el.scrollTop = 0;
            el.scrollLeft = 0;
        });
    }

    // Split the response into its prose and its code blocks. A fence that
    // is still open (mid-stream) runs to the end of the text.
    const { text: prose, blocks: codeBlocks } = splitCodeBlocks(response);
    hasCode = codeBlocks.length > 0;
    const codePending = screen && !final && !hasCode && (codingMode || expectsCodePanel(prose));
    const split = hasCode || codePending;

    if (split) {
        renderSplitLayout(prose, codeBlocks, final, { pending: codePending });
    } else {
        renderFullLayout(prose, final);
    }
    // The first code fence of a streamed answer switches to the split
    // layout with a short cross-fade; behind "Thinking…" it is instant.
    setLayout(split ? 'split' : 'full', { instant: instant || view !== 'answer' });

    // Errors (e.g. screen capture failures) render as a callout.
    const errorTarget = document.getElementById(split ? 'text-content' : 'full-markdown');
    ['text-content', 'full-markdown'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const on = isError && el === errorTarget;
        el.classList.toggle('answer-error', on);
        if (on) el.setAttribute('role', 'alert'); else el.removeAttribute('role');
    });

    following.forEach(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
}

// Split an answer into its prose and its fenced code blocks (``` or ~~~
// on their own lines, possibly indented inside a list). When a coding
// language is set, the main process retags only opening fence lines
// (enforceProgrammingLanguage in llm.service.js) and leaves closing ones as
// written, normally a plain ```. A closing fence that ends in one word
// (```cpp) is accepted too. A fence leaves nothing in the prose: its lines
// and the blank lines around it are dropped and the text on either side is
// rejoined. A fence that is never closed, as in a cut-off answer, runs to
// the end.
// Keep in sync with splitCodeBlocks in src/ui/chat-page.js.
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
// Components, Trade-offs, ...), which answer.css styles as section labels.
// Models also write them as other heading levels, "**Steps:**" on its own
// line or with numbers ("### 3. Steps"); those become "#### Steps" too. A
// "Say this" label is dropped (the card shows it already) and so is a
// "Code" heading (the code panel has its own). Other lines, and lines
// inside fences or indented code, are kept as written.
// Keep in sync with normalizeSectionHeadings in src/ui/chat-page.js.
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

// True when streamed prose has a section only a coding Screen Help answer
// has (Approach, Dry run, Complexity, Edge cases), so its code is still to
// come. Design answers (Problem, Steps, Components, ...) never match.
function expectsCodePanel(prose) {
    return /^#### (?:approach|dry[- ]run|(?:time (?:and|&) space )?complexity|edge cases?|corner cases?)\b/im
        .test(normalizeSectionHeadings(prose));
}

function attachCopy(btn, text) {
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        let ok = false;
        try {
            if (window.electronAPI && typeof window.electronAPI.copyToClipboard === 'function') {
                ok = await window.electronAPI.copyToClipboard(text);
            }
            if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                ok = true;
            }
        } catch (err) {
            console.warn('[LLM-RESPONSE] Copy failed', err && err.message);
            ok = false;
        }
        flashButton(btn, ok ? 'Copied' : 'Copy failed', ok);
    });
}

function flashButton(btn, label, ok, restoreLabel = 'Copy') {
    if (btn._resetTimer) clearTimeout(btn._resetTimer);
    btn.classList.toggle('copied', ok);
    btn.textContent = label;
    btn._resetTimer = setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = restoreLabel;
        btn._resetTimer = null;
    }, 1200);
}

// The buttons an error asked for, or null. Only known actions, and only
// when this window's API has the method behind them.
function errorActions(action, copyText) {
    const api = window.electronAPI;
    if (action !== SCREEN_RECORDING_ACTION || !api || typeof api.openScreenRecordingSettings !== 'function') return null;
    const copy = typeof copyText === 'string' && copyText.length > 0 && copyText.length <= MAX_COPY_TEXT_LENGTH ? copyText : null;
    return { action, copyText: copy };
}

// Screen Recording error: "Open Screen Recording Settings" (main opens the
// one System Settings page it allows) and, for installed builds, a button
// that copies the Terminal command from the message.
function appendErrorActions({ copyText }) {
    const target = document.getElementById(hasCode ? 'text-content' : 'full-markdown');
    if (!target) return;
    const row = document.createElement('div');
    row.className = 'answer-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'oc-btn oc-btn--primary';
    open.textContent = 'Open Screen Recording Settings';
    open.addEventListener('click', async (e) => {
        e.stopPropagation();
        let ok = false;
        try {
            ok = await window.electronAPI.openScreenRecordingSettings();
        } catch (err) {
            console.warn('[LLM-RESPONSE] Could not open Screen Recording settings', err && err.message);
        }
        if (!ok) flashButton(open, 'Could not open System Settings', false, 'Open Screen Recording Settings');
    });
    row.appendChild(open);
    if (copyText) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'oc-btn';
        copy.textContent = 'Copy Terminal command';
        copy.addEventListener('click', async (e) => {
            e.stopPropagation();
            let ok = false;
            try {
                ok = await window.electronAPI.copyToClipboard(copyText);
            } catch (_) {
                ok = false;
            }
            flashButton(copy, ok ? 'Copied' : 'Copy failed', ok, 'Copy Terminal command');
        });
        row.appendChild(copy);
    }
    target.appendChild(row);
}

function makeCopyButton(text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn oc-btn oc-btn--ghost';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    attachCopy(btn, text || '');
    return btn;
}

// The code panel's markup. Identical while streaming and at the end, so
// blocks that are already complete are kept as they are.
function codeBlocksHtml(codeBlocks) {
    return codeBlocks.map(block =>
        '<div class="code-block">' +
            '<div class="code-header"><span class="oc-label">' + escapeHtml(languageLabel(block.language)) + '</span></div>' +
            '<div class="code-content"><pre><code class="language-' + escapeHtml(normalizeLanguage(block.language)) + '">' +
                escapeHtml(block.code) +
            '</code></pre></div>' +
        '</div>'
    ).join('');
}

// Stands in the code panel while a coding answer's code is still to come.
// The same 40 px bar as a code card, so the real card replaces it in place.
const PENDING_CODE_HTML =
    '<div class="code-block code-block--pending" aria-hidden="true">' +
        '<div class="code-header"><span class="oc-label">Code</span></div>' +
        '<div class="code-content"><pre><code>The code follows the steps\u2026</code></pre></div>' +
    '</div>';

function renderSplitLayout(textContent, codeBlocks, final, { pending = false } = {}) {
    const textEl = document.getElementById('text-content');
    const codeEl = document.getElementById('code-content');
    if (!textEl || !codeEl) return;

    // The prose from splitCodeBlocks, fences already removed.
    patchChildren(textEl, sanitizeHtml(renderAnswerMarkdown(textContent)), { math: true });
    patchChildren(codeEl, pending ? PENDING_CODE_HTML : codeBlocksHtml(codeBlocks));

    if (!final) return;
    // Copy buttons only on the final answer: mid-stream the code is still
    // incomplete. The header is as tall as the button, so nothing shifts.
    codeEl.querySelectorAll('.code-block').forEach((blockEl, index) => {
        const header = blockEl.querySelector('.code-header');
        if (!header || header.querySelector('.copy-btn') || !codeBlocks[index]) return;
        header.appendChild(makeCopyButton(codeBlocks[index].code));
    });
    scheduleHighlight();
}

function renderFullLayout(text, final) {
    const full = document.getElementById('full-markdown');
    if (!full) return;
    // The prose from splitCodeBlocks, so an empty fence leaves no stray
    // language word here either.
    patchChildren(full, sanitizeHtml(renderAnswerMarkdown(text)), { math: true });

    if (!final) return;
    scheduleHighlight();
    // Copy buttons for indented code blocks, placed over the block.
    full.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        const code = pre.querySelector('code');
        pre.appendChild(makeCopyButton(code ? code.textContent : pre.textContent));
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    // innerHTML leaves quotes as-is; escape them so the result is also
    // safe inside attribute values.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- Closing ----------

function closeAnswerWindow() {
    try {
        if (window.electronAPI && window.electronAPI.closeWindow) {
            Promise.resolve(window.electronAPI.closeWindow()).catch(() => window.close());
        } else {
            window.close();
        }
    } catch (_) {
        try { window.close(); } catch (__) {}
    }
}

(function () {
    const btn = document.getElementById('close-window-btn');
    if (btn) btn.addEventListener('click', closeAnswerWindow);
    // Escape closes the panel when it has keyboard focus.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            closeAnswerWindow();
        }
    });
})();
