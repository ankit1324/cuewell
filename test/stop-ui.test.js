'use strict';
// The Stop control and the "Stopped" marker in the answer window
// (src/ui/answer-page.js) and chat (src/ui/chat-page.js). The functions are
// compiled from the page scripts with small DOM stand-ins.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunction, loadConstant, readSource } = require('./helpers/source');

function fakeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, on) => {
      const next = on === undefined ? !set.has(name) : !!on;
      if (next) set.add(name); else set.delete(name);
      return next;
    },
    contains: (name) => set.has(name),
    list: () => [...set].sort(),
  };
}

function fakeElement(id, { hidden = false } = {}) {
  return { id, hidden, disabled: false, textContent: '', classList: fakeClassList(), focused: 0, focus() { this.focused++; } };
}

function fakeDocument(elements) {
  const byId = Object.fromEntries(elements.map((el) => [el.id, el]));
  return { activeElement: null, getElementById: (id) => byId[id] || null };
}

describe('answer window (answer-page.js)', () => {
  const PAGE = 'src/ui/answer-page.js';

  it('shows Stop only while the request on screen is running', () => {
    const btn = fakeElement('stop-answer-btn', { hidden: true });
    const close = fakeElement('close-window-btn');
    const region = fakeElement('full-content-inner');
    const document = fakeDocument([btn, close]);
    document.querySelector = (sel) => (sel === '.full-content-inner' ? region : null);
    const state = { stream: null };
    const sync = () => loadFunction(PAGE, 'syncStopButton', { document, stream: state.stream, layout: 'full' })();

    sync();
    assert.equal(btn.hidden, true, 'shown with nothing running');
    state.stream = { id: 'chat-1-1', finished: false };
    sync();
    assert.equal(btn.hidden, false);
    btn.disabled = true; // a stop is on its way
    document.activeElement = btn;
    state.stream = { id: 'chat-1-1', finished: true };
    sync();
    assert.equal(btn.hidden, true);
    assert.equal(btn.disabled, false);
    assert.equal(region.focused, 1, 'keyboard focus was lost with the button');
    assert.equal(close.focused, 0, 'focus on Close: the next Enter would close the window');
  });

  it('marks the header "Stopped" without the live state', () => {
    const status = fakeElement('answer-status');
    const document = fakeDocument([status]);
    const setStatusLabel = loadFunction(PAGE, 'setStatusLabel', { document });
    setStatusLabel('Writing');
    assert.deepEqual(status.classList.list(), []);
    setStatusLabel('Stopped', { stopped: true });
    assert.equal(status.textContent, 'Stopped');
    assert.deepEqual(status.classList.list(), ['is-stopped']);
    setStatusLabel(null);
    assert.deepEqual(status.classList.list(), ['is-off']);
    setStatusLabel('Thinking');
    assert.deepEqual(status.classList.list(), []);
  });

  describe('showFinal', () => {
    const EMPTY_ANSWER_MESSAGE = loadConstant(PAGE, 'EMPTY_ANSWER_MESSAGE');
    const STOPPED_EMPTY_MESSAGE = loadConstant(PAGE, 'STOPPED_EMPTY_MESSAGE');
    const load = () => {
      const calls = { render: [], status: [], ended: 0 };
      const showFinal = loadFunction(PAGE, 'showFinal', {
        stream: { id: 'chat-1-1', finished: false, rendered: true },
        endStream: () => { calls.ended++; },
        stopSlowHint: () => {},
        renderAnswer: (body, options) => calls.render.push({ body, ...options }),
        setView: () => {},
        setStatusLabel: (text, options) => calls.status.push({ text, stopped: !!(options && options.stopped) }),
        shownFinalKey: null,
        view: 'answer',
        EMPTY_ANSWER_MESSAGE,
        STOPPED_EMPTY_MESSAGE,
      });
      return { showFinal, calls };
    };

    it('keeps a stopped answer\'s text and marks it Stopped', () => {
      const { showFinal, calls } = load();
      assert.equal(showFinal('Say this first.', false, { stopped: true }), true);
      assert.deepEqual(calls.render[0], { body: 'Say this first.', isError: false, final: true, fresh: false, instant: false });
      assert.deepEqual(calls.status, [{ text: 'Stopped', stopped: true }]);
      assert.equal(calls.ended, 1);
    });

    it('says so when it was stopped before any text, without an error', () => {
      const { showFinal, calls } = load();
      showFinal('   ', false, { stopped: true });
      assert.equal(calls.render[0].body, STOPPED_EMPTY_MESSAGE);
      assert.equal(calls.render[0].isError, false);
      assert.deepEqual(calls.status, [{ text: 'Stopped', stopped: true }]);
    });

    it('still treats an empty finished answer as an error', () => {
      const { showFinal, calls } = load();
      showFinal('', false);
      assert.equal(calls.render[0].body, EMPTY_ANSWER_MESSAGE);
      assert.equal(calls.render[0].isError, true);
      assert.deepEqual(calls.status, [{ text: null, stopped: false }]);
    });
  });

  it('has a Stop button that starts hidden and is a real button', () => {
    const html = readSource('llm-response.html');
    assert.match(html, /<button id="stop-answer-btn" class="answer-stop oc-btn oc-btn--ghost" type="button" aria-label="Stop the answer"[^>]* hidden>/);
    assert.match(readSource('src/styles/answer.css'), /\.answer-stop\[hidden\] \{ display: none; \}/);
  });
});

describe('chat (chat-page.js)', () => {
  const PAGE = 'src/ui/chat-page.js';

  it('shows Stop while any answer in the list is running', () => {
    const stopButton = fakeElement('stopButton', { hidden: true });
    const messageInput = fakeElement('messageInput');
    const document = { activeElement: null };
    const streams = new Map();
    const sync = loadFunction(PAGE, 'syncStopButton', { stopButton, streams, document, messageInput });
    sync();
    assert.equal(stopButton.hidden, true);
    streams.set('chat-1-1', {});
    sync();
    assert.equal(stopButton.hidden, false);
    document.activeElement = stopButton;
    streams.clear();
    sync();
    assert.equal(stopButton.hidden, true);
    assert.equal(messageInput.focused, 1, 'keyboard focus was lost with the button');
  });

  it('stops the newest running answer', () => {
    const latestStreamId = (streams) => loadFunction(PAGE, 'latestStreamId', { streams })();
    assert.equal(latestStreamId(new Map()), null);
    assert.equal(latestStreamId(new Map([['chat-1-1', {}], ['tr-2-2', {}]])), 'tr-2-2');
  });

  it('marks a row "Stopped" once', () => {
    const appended = [];
    const head = {
      querySelector: (sel) => (sel === '.message-stopped' ? appended[0] || null : null),
      appendChild: (el) => appended.push(el),
    };
    const row = { querySelector: (sel) => (sel === '.message-head' ? head : null) };
    const document = { createElement: () => ({ className: '', textContent: '' }) };
    const markStopped = loadFunction(PAGE, 'markStopped', { document });
    markStopped(row);
    markStopped(row);
    markStopped(null);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].className, 'message-stopped');
    assert.equal(appended[0].textContent, 'Stopped');
  });

  it('has a Stop button that starts hidden and is a real button', () => {
    const html = readSource('chat.html');
    assert.match(html, /<button class="stop-button oc-btn oc-btn--ghost" id="stopButton" type="button"[^>]*aria-label="Stop the answer" hidden>/);
    assert.match(readSource('src/styles/chat.css'), /\.stop-button\[hidden\] \{ display: none; \}/);
  });
});
