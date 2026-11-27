// Global variables
let currentLayout = 'split';
let hasCode = false;
let currentSkill = 'dsa';
let isInteractive = false;
let scrollableElements = [];
let initialized = false;

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
// re-rendered at most every STREAM_RENDER_INTERVAL_MS; Prism, copy buttons
// and the window resize wait for the final answer.
const STREAM_RENDER_INTERVAL_MS = 80;
let stream = null;            // { id, text, rendered, finished }
let streamRenderTimer = null;
let lastStreamRenderAt = 0;
// What the last final render showed. The final answer (or error) arrives
// on two channels; the second one is not rendered again.
let shownFinalKey = null;

// Immediate logging to verify script execution
console.log('[LLM-RESPONSE] Script tag executed');

window.onerror = function(msg, url, line, col, error) {
    console.error('[LLM-RESPONSE] Window error:', msg, 'at line', line);
    return false;
};

document.addEventListener('DOMContentLoaded', function() {
    console.log('[LLM-RESPONSE] DOMContentLoaded fired');
    initLLMResponseWindow();
});

// Also try immediate init in case DOMContentLoaded already fired
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    console.log('[LLM-RESPONSE] Document already ready, initializing now');
    setTimeout(initLLMResponseWindow, 0);
}

function initLLMResponseWindow() {
    if (initialized) return;
    initialized = true;

    console.log('[LLM-RESPONSE] Initializing window...');

    // Markdown comes from src/ui/markdown-render.js (marked); Prism
    // highlighting runs afterwards on the sanitized DOM (scheduleHighlight).
    if (typeof window.renderMarkdown !== 'function') {
        console.error('[LLM-RESPONSE] no markdown renderer available, falling back to plain text');
    }

    console.log('[LLM-RESPONSE] electronAPI exists:', !!window.electronAPI);
    console.log('[LLM-RESPONSE] onDisplayLlmResponse method:', typeof window.electronAPI?.onDisplayLlmResponse);

    // Set up event listeners using electronAPI from preload script
    if (window.electronAPI) {
        console.log('[LLM-RESPONSE] Setting up IPC listeners...');

        // Set up show-loading event listener
        window.electronAPI.onShowLoading(() => {
            console.log('[LLM-RESPONSE] show-loading received');
            showLoadingState();
        });

        window.electronAPI.onTranscriptionLlmResponseStart((_event, data) => onStreamStart(data));
        window.electronAPI.onTranscriptionLlmResponseChunk((_event, data) => onStreamChunk(data));

        // Final answer and errors tied to the current request. They arrive
        // before (or, while the screen is shared, instead of) the
        // display-llm-response below.
        window.electronAPI.onTranscriptionLlmResponse((_event, data) => {
            if (!data || !isOpenStream(data.messageId)) return;
            if (typeof data.response === 'string' && data.response) {
                showFinal(data.response, false);
            } else {
                endStream();
                hideLoadingState();
            }
        });
        window.electronAPI.onLlmError((_event, data) => {
            if (!data || !isOpenStream(data.messageId)) return;
            showFinal(String(data.error || 'The AI request failed.'), true);
        });

        // The final answer or error to show (also for screenshot errors that
        // have no stream).
        window.electronAPI.onDisplayLlmResponse((_event, data) => {
            try {
                if (!data || typeof data !== 'object') return;
                const metadata = data.metadata || {};
                // An answer to an older request than the one being shown.
                if (metadata.messageId && stream && metadata.messageId !== stream.id) return;

                const response = data.content || data.response;
                if (!response || typeof response !== 'string') {
                    console.error('[LLM-RESPONSE] No response content found!');
                    if (metadata.messageId) endStream();
                    hideLoadingState();
                    return;
                }
                // Without a messageId (a screenshot that failed before it
                // started) the message is shown, but an answer still
                // streaming keeps going and replaces it.
                const endsStream = !!metadata.messageId || !stream || stream.finished;
                showFinal(response, !!metadata.isError, endsStream);
            } catch (err) {
                console.error('[LLM-RESPONSE] Error in handler:', err.message, err.stack);
                hideLoadingState();
            }
        });

        console.log('[LLM-RESPONSE] IPC listeners set up successfully');
    } else {
        console.error('[LLM-RESPONSE] electronAPI not available!');
    }
} // end initLLMResponseWindow

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
}

function onStreamStart(data) {
    const id = data && typeof data.messageId === 'string' ? data.messageId : '';
    if (!id) return;
    cancelStreamRender();
    // A trailing highlight from the previous answer must not run on this one.
    if (highlightTimer) {
        clearTimeout(highlightTimer);
        highlightTimer = null;
    }
    stream = { id, text: '', rendered: false, finished: false };
    shownFinalKey = null;
}

function onStreamChunk(data) {
    if (!data || typeof data.delta !== 'string' || !data.delta) return;
    const id = typeof data.messageId === 'string' ? data.messageId : '';
    // No start seen (e.g. the page loaded mid-answer): follow this stream.
    if (!stream && id) stream = { id, text: '', rendered: false, finished: false };
    if (!isOpenStream(id)) return;
    stream.text += data.delta;
    if (streamRenderTimer) return;
    const wait = STREAM_RENDER_INTERVAL_MS - (Date.now() - lastStreamRenderAt);
    if (wait <= 0) renderStreamNow();
    else streamRenderTimer = setTimeout(renderStreamNow, wait);
}

function renderStreamNow() {
    streamRenderTimer = null;
    if (!stream || stream.finished || !stream.text) return;
    lastStreamRenderAt = Date.now();
    const first = !stream.rendered;
    const hadCode = hasCode;
    if (first) {
        // The first text replaces "Thinking…".
        stream.rendered = true;
        hideLoadingState();
    }
    setStatusLabel('Writing');
    renderAnswer(stream.text, { isError: false, final: false, follow: true });
    // Keyboard scrolling follows the layout (text only, or text + code).
    if (first || hadCode !== hasCode) setupScrolling(false);
}

// Show the final answer or error. Replaces whatever is on screen: the
// streamed text, "Thinking…" (a request that sent no chunks) or an older answer.
function showFinal(text, isError, endsStream = true) {
    const streamed = !!(stream && !stream.finished && stream.rendered);
    if (endsStream) endStream();
    const key = (isError ? 'error:' : 'answer:') + text;
    const responseElement = document.getElementById('response-content');
    const visible = !!responseElement && !responseElement.classList.contains('hidden');
    hideLoadingState();
    if (key === shownFinalKey && visible) return;
    shownFinalKey = key;
    // A streamed answer keeps the reader's scroll position; a new one starts at the top.
    renderAnswer(text, { isError, final: true, follow: streamed });
    setupScrolling(!streamed);
    setTimeout(verifyDisplayState, 500);
}

function showLoadingState() {
    const loadingElement = document.getElementById('loading');
    const responseElement = document.getElementById('response-content');

    if (loadingElement) {
        loadingElement.classList.remove('hidden');
        loadingElement.style.display = ''; // Remove any forced display styles
    }

    if (responseElement) {
        responseElement.classList.add('hidden');
    }

    shownFinalKey = null;
    setStatusLabel('Thinking');
    console.log('Loading state shown - should see Thinking...');
}

function hideLoadingState() {
    const loadingElement = document.getElementById('loading');
    if (loadingElement) {
        loadingElement.classList.add('hidden');
        loadingElement.style.display = 'none'; // Force hide
        console.log('Loading state hidden');
    } else {
        console.error('Loading element not found!');
    }
    setStatusLabel(null);
}

// Header status label: "Thinking" while #loading shows, "Writing" while an
// answer streams, hidden otherwise.
function setStatusLabel(text) {
    const status = document.getElementById('answer-status');
    if (!status) return;
    if (text) status.textContent = text;
    status.classList.toggle('hidden', !text);
}

// The panels that scroll: text and code (split layout) and the full view.
function scrollContainers() {
    return [
        document.querySelector('.text-panel .panel-content'),
        document.querySelector('.code-panel .panel-content'),
        document.querySelector('.full-content-inner')
    ].filter(el => el !== null);
}

// Hidden panels count as at the bottom, so one that appears mid-stream
// follows the text from the start.
function isAtBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

// One gentle rise-in when an answer first appears (not on re-renders).
function playRise(element) {
    if (!element) return;
    element.classList.remove('oc-rise');
    void element.offsetWidth; // restart the animation
    element.classList.add('oc-rise');
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
    // plain blocks for no visual gain.
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

// Display name for the code panel header; "CODE" when no language is given.
function languageLabel(lang) {
    const l = String(lang || '').toLowerCase();
    if (!l || l === 'text' || l === 'plain' || l === 'plaintext' || l === 'txt') return 'Code';
    const names = { 'cpp': 'C++', 'c++': 'C++', 'cs': 'C#', 'csharp': 'C#', 'js': 'JavaScript', 'ts': 'TypeScript', 'py': 'Python' };
    return names[l] || l;
}

// Not named renderMarkdown: a top-level function here would replace
// window.renderMarkdown from markdown-render.js.
function renderAnswerMarkdown(text) {
    if (typeof window.renderMarkdown === 'function') {
        return window.renderMarkdown(text);
    }

    return escapeHtml(text).replace(/\n/g, '<br>');
}

function calculateContentMetrics(response, codeBlocks) {
    // Count lines in the response
    const lineCount = response.split('\n').length;

    // Check for long lines (over 80 characters)
    const hasLongLines = response.split('\n').some(line => line.length > 80);

    // Count code blocks
    const codeBlockCount = codeBlocks.length;

    // Estimate content complexity
    const hasCode = codeBlockCount > 0;
    const isLongContent = lineCount > 30;
    const hasMultipleCodeBlocks = codeBlockCount > 2;

    return {
        lineCount,
        hasLongLines,
        codeBlocks: codeBlockCount,
        hasCode,
        isLongContent,
        hasMultipleCodeBlocks,
        complexity: isLongContent || hasMultipleCodeBlocks ? 'high' : hasCode ? 'medium' : 'low'
    };
}

// Render an answer: prose on the left and code on the right, or one panel
// when there is no code. While streaming (final false) the code is shown
// as plain text and nothing else runs; the final render adds copy buttons,
// Prism highlighting and the window resize. With follow, panels that were
// scrolled to the bottom stay there.
function renderAnswer(response, { isError = false, final = true, follow = false } = {}) {
    const responseElement = document.getElementById('response-content');
    if (!responseElement || !response) return;

    // Measured before the DOM changes.
    const pinned = follow ? scrollContainers().filter(isAtBottom) : [];

    if (responseElement.classList.contains('hidden')) {
        responseElement.classList.remove('hidden');
        playRise(responseElement);
    }

    // Split the response into its prose and its code blocks. A fence that
    // is still open (mid-stream) runs to the end of the text.
    const { text: prose, blocks: codeBlocks } = splitCodeBlocks(response);
    hasCode = codeBlocks.length > 0;

    if (hasCode) {
        // Split layout: text on left, code on right
        displaySplitLayout(prose, codeBlocks, final);
    } else {
        // Full layout: all content in one panel
        displayFullLayout(prose, final);
    }

    // Errors (e.g. screen capture failures) render as a callout.
    const errorTarget = document.getElementById(hasCode ? 'text-content' : 'full-markdown');
    ['text-content', 'full-markdown'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const on = isError && el === errorTarget;
        el.classList.toggle('answer-error', on);
        if (on) el.setAttribute('role', 'alert'); else el.removeAttribute('role');
    });

    pinned.forEach(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));

    if (!final) return;

    // Request dynamic window sizing based on content
    const contentMetrics = calculateContentMetrics(response, codeBlocks);
    setTimeout(() => {
        window.electronAPI.resizeLlmWindowForContent(contentMetrics)
            .then(() => {
                pinned.forEach(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
            })
            .catch(error => {
                console.error('Failed to resize window:', error);
            });
    }, 200);
}

// resetPosition: scroll the panels back to the top (a new answer). A
// streamed answer keeps where the reader is.
function setupScrolling(resetPosition = true) {
    // Set up scrollable elements based on current layout
    setTimeout(() => {
        if (hasCode) {
            scrollableElements = [
                document.querySelector('.text-panel .panel-content'),
                document.querySelector('.code-panel .panel-content')
            ].filter(el => el !== null);
        } else {
            scrollableElements = [
                document.querySelector('.full-content-inner')
            ].filter(el => el !== null);
        }
        // Reset scroll positions and ensure elements are focusable
        scrollableElements.forEach(element => {
            if (resetPosition) {
                element.scrollTop = 0;
                element.scrollLeft = 0;
            }
            element.setAttribute('tabindex', '0');
        });

        // Enable scrolling if interactive mode is on
        if (isInteractive) {
            enableScrolling();
        }
    }, 100);
}

function enableScrolling() {
    scrollableElements.forEach(element => {
        if (element) {
            // Enable mouse/trackpad scrolling with smooth behavior
            element.style.scrollBehavior = 'smooth';

            // Add mouse enter handler to ensure focus for scrolling
            element.addEventListener('mouseenter', handleMouseEnter, { passive: true });
            element.addEventListener('mouseleave', handleMouseLeave, { passive: true });

            // Add wheel event for enhanced scrolling
            element.addEventListener('wheel', handleWheelScroll, { passive: false });

        }
    });
}

function disableScrolling() {
    scrollableElements.forEach(element => {
        if (element) {
            element.removeEventListener('mouseenter', handleMouseEnter);
            element.removeEventListener('mouseleave', handleMouseLeave);
            element.removeEventListener('wheel', handleWheelScroll);
        }
    });
}

function handleMouseEnter(e) {
    // Focus the element for keyboard scrolling and ensure it's ready for mouse scrolling
    e.target.focus({ preventScroll: true });
    e.target.style.cursor = 'grab';
}

function handleMouseLeave(e) {
    e.target.style.cursor = 'default';
}

function handleWheelScroll(e) {
    // Allow natural scrolling behavior
    // Don't prevent default to maintain smooth native scrolling
    console.log('Wheel scroll detected on element');
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
// Keep in sync with splitCodeBlocks in src/ui/chat-page.js and src/ui/chat-window.js.
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

function attachCopy(btn, text) {
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            let ok = false;
            if (window.electronAPI && typeof window.electronAPI.copyToClipboard === 'function') {
                ok = await window.electronAPI.copyToClipboard(text);
            }
            if (!ok) {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                    ok = true;
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = text;
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
        } catch (err) { console.warn('Copy failed', err); }
    })
}

function renderCopyButtonsInFullMarkdown(container) {
    // Add copy buttons to all code blocks in full markdown view
    const pres = container.querySelectorAll('pre');
    pres.forEach(pre => {
        // Avoid duplicate buttons
        if (pre.querySelector('.copy-btn')) return;
        const code = pre.querySelector('code');
        const text = code ? code.textContent : pre.textContent;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-btn oc-btn oc-btn--ghost';
        btn.textContent = 'Copy';
        btn.setAttribute('aria-label', 'Copy code');
        attachCopy(btn, text || '');
        pre.style.position = 'relative';
        pre.appendChild(btn);
    });
}

function displaySplitLayout(textContent, codeBlocks, final = true) {
    // Show split layout, hide full layout
    document.getElementById('split-layout').classList.remove('hidden');
    document.getElementById('full-content').classList.add('hidden');

    // Render text content (the prose from splitCodeBlocks, fences already removed)
    const textHtml = sanitizeHtml(renderAnswerMarkdown(textContent));
    document.getElementById('text-content').innerHTML = textHtml;
    if (window.renderMathInElement) window.renderMathInElement(document.getElementById('text-content'));

    // Render code blocks
    const codeContainer = document.getElementById('code-content');
    codeContainer.innerHTML = '';

    if (codeBlocks.length === 0) {
        codeContainer.innerHTML = '<div class="no-code">No code examples found</div>';
    } else {
        codeBlocks.forEach((block, index) => {
            const codeBlock = document.createElement('div');
            codeBlock.className = 'code-block';
            codeBlock.innerHTML = `
                <div class="code-header"><span class="oc-label">${escapeHtml(languageLabel(block.language))}</span></div>
                <div class="code-content">
                    <pre><code class="language-${escapeHtml(normalizeLanguage(block.language))}">${escapeHtml(block.code)}</code></pre>
                </div>
            `;
            // Copy buttons only on the final answer: mid-stream the code
            // is still incomplete.
            if (final) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'copy-btn oc-btn oc-btn--ghost';
                btn.textContent = 'Copy';
                btn.setAttribute('aria-label', 'Copy code');
                attachCopy(btn, block.code || '');
                codeBlock.querySelector('.code-header').appendChild(btn);
            }

            codeContainer.appendChild(codeBlock);
        });
    }

    // Highlight code once, on the final answer (throttled)
    if (final) scheduleHighlight();
}

function displayFullLayout(text, final = true) {
    // Show full layout, hide split layout
    document.getElementById('split-layout').classList.add('hidden');
    document.getElementById('full-content').classList.remove('hidden');

    // Render full markdown (the prose from splitCodeBlocks, so an empty
    // fence leaves no stray language word here either)
    const html = sanitizeHtml(renderAnswerMarkdown(text));
    const full = document.getElementById('full-markdown');
    full.innerHTML = html;
    if (window.renderMathInElement) window.renderMathInElement(full);

    if (!final) return;

    // Highlight any code if Prism is available (throttled)
    scheduleHighlight();

    // Add copy buttons to code blocks in full view
    const pres = full.querySelectorAll('pre');
    pres.forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        const code = pre.querySelector('code');
        const text = code ? code.textContent : pre.textContent;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-btn oc-btn oc-btn--ghost';
        btn.textContent = 'Copy';
        btn.setAttribute('aria-label', 'Copy code');
        attachCopy(btn, text || '');
        pre.style.position = 'relative';
        pre.appendChild(btn);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    // innerHTML leaves quotes as-is; escape them so the result is also
    // safe inside attribute values.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// Handle window focus
window.addEventListener('focus', () => {
    console.log('LLM Response window focused');
});

// Handle window close
window.addEventListener('beforeunload', () => {
    console.log('LLM Response window closing');
});

// Add keyboard scrolling support for when interactive
document.addEventListener('keydown', (e) => {
    if (!isInteractive) return;

    const activeElement = document.activeElement;
    let targetElement = null;

    // Find the currently focused scrollable element
    for (let element of scrollableElements) {
        if (element === activeElement || element.contains(activeElement)) {
            targetElement = element;
            break;
        }
    }

    // Default to first scrollable element if none focused
    if (!targetElement && scrollableElements.length > 0) {
        targetElement = scrollableElements[0];
    }

    if (!targetElement) return;

    const scrollAmount = 50; // Pixels to scroll

    switch(e.key) {
        case 'ArrowUp':
            e.preventDefault();
            targetElement.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
            break;
        case 'ArrowDown':
            e.preventDefault();
            targetElement.scrollBy({ top: scrollAmount, behavior: 'smooth' });
            break;
        case 'ArrowLeft':
            e.preventDefault();
            targetElement.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            break;
        case 'ArrowRight':
            e.preventDefault();
            targetElement.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            break;
        case 'PageUp':
            e.preventDefault();
            targetElement.scrollBy({ top: -targetElement.clientHeight * 0.8, behavior: 'smooth' });
            break;
        case 'PageDown':
            e.preventDefault();
            targetElement.scrollBy({ top: targetElement.clientHeight * 0.8, behavior: 'smooth' });
            break;
        case 'Home':
            e.preventDefault();
            targetElement.scrollTo({ top: 0, behavior: 'smooth' });
            break;
        case 'End':
            e.preventDefault();
            targetElement.scrollTo({ top: targetElement.scrollHeight, behavior: 'smooth' });
            break;
    }
});

// Add verification function to ensure content is properly displayed
function verifyDisplayState() {
    // A newer request is loading or streaming; its own events set the display.
    if (stream && !stream.finished) return;
    const loadingElement = document.getElementById('loading');
    const responseElement = document.getElementById('response-content');

    const isLoadingHidden = loadingElement ? loadingElement.classList.contains('hidden') : true;
    const isContentVisible = responseElement ? !responseElement.classList.contains('hidden') : false;

    console.log('Display state verification:', {
        loadingHidden: isLoadingHidden,
        contentVisible: isContentVisible,
        windowVisible: !document.hidden
    });

    if (!isLoadingHidden || !isContentVisible) {
        console.warn('Display state inconsistent - forcing correction');
        if (loadingElement) {
            loadingElement.classList.add('hidden');
            loadingElement.style.display = 'none';
        }
        if (responseElement) {
            responseElement.classList.remove('hidden');
        }
        setStatusLabel(null);
    }
}

// Add global debugging function
window.debugLLMWindow = function() {
    console.log('=== LLM Window Debug Info ===');
    console.log('Current layout:', currentLayout);
    console.log('Has code:', hasCode);
    console.log('Is interactive:', isInteractive);
    console.log('Scrollable elements:', scrollableElements.length);

    const loadingElement = document.getElementById('loading');
    const responseElement = document.getElementById('response-content');
};

// Close button handler
(function(){
    const btn = document.getElementById('close-window-btn');
    if (btn) {
        btn.addEventListener('click', () => {
            try {
                if (window.electronAPI && window.electronAPI.closeWindow) {
                    window.electronAPI.closeWindow();
                } else if (window.api && window.api.send) {
                    window.api.send('quit-app');
                } else {
                    window.close();
                }
            } catch (e) {
                try { window.close(); } catch (_) {}
            }
        });
    }
})();
