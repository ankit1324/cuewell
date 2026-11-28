'use strict';
// The pages' side of provider fallback and window opacity: the note under
// an answer in the answer window (answer-page.js) and chat (chat-page.js),
// the backup list order in Settings (settings-window.js), and the controls
// in the HTML. Functions are compiled from the page scripts with small DOM
// stand-ins.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunction, loadConstant, readSource, extractFunctionSource } = require('./helpers/source');

const NOTE = 'Answered by Claude because Gemini failed: rate limit reached';

describe('answer window note (answer-page.js)', () => {
  const PAGE = 'src/ui/answer-page.js';
  const MAX_NOTE_LENGTH = loadConstant(PAGE, 'MAX_NOTE_LENGTH');
  const providerNoteOf = loadFunction(PAGE, 'providerNoteOf', { MAX_NOTE_LENGTH });

  it('reads only a string note from the metadata, trimmed and capped', () => {
    assert.equal(providerNoteOf({ providerNote: `  ${NOTE} ` }), NOTE);
    assert.equal(providerNoteOf({ providerNote: 'x'.repeat(500) }).length, MAX_NOTE_LENGTH);
    for (const metadata of [null, undefined, {}, { providerNote: 7 }, { providerNote: { html: '<b>' } }]) {
      assert.equal(providerNoteOf(metadata), '');
    }
  });

  it('shows the note as plain text and hides it when empty', () => {
    const note = { id: 'answer-note', hidden: true, textContent: '', title: '' };
    const document = { getElementById: (id) => (id === 'answer-note' ? note : null) };
    const setAnswerNote = loadFunction(PAGE, 'setAnswerNote', { document });
    setAnswerNote('<img src=x onerror=alert(1)>');
    assert.equal(note.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(note.hidden, false);
    setAnswerNote(NOTE);
    assert.equal(note.title, NOTE);
    setAnswerNote('');
    assert.equal(note.hidden, true);
    setAnswerNote(null);
    assert.equal(note.hidden, true);
    assert.doesNotMatch(extractFunctionSource(readSource(PAGE), 'setAnswerNote'), /innerHTML/);
  });

  it('counts the note in the height the window needs', () => {
    const rect = (height) => ({ getBoundingClientRect: () => ({ height }) });
    const els = {
      'answer-note': { hidden: false, ...rect(33) },
      'full-markdown': rect(200),
    };
    const document = {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === '.window-header' ? rect(44) : sel === '.full-content-inner' ? {} : null),
    };
    const getComputedStyle = () => ({ paddingTop: '10', paddingBottom: '10' });
    const needed = () => loadFunction(PAGE, 'neededWindowHeight', { document, getComputedStyle, view: 'answer', layout: 'full' })();
    assert.equal(needed(), 44 + 33 + 220);
    els['answer-note'].hidden = true;
    assert.equal(needed(), 44 + 220);
  });

  it('clears the note for every new question and sets it with the final answer', () => {
    const source = readSource(PAGE);
    const start = source.slice(source.indexOf('function onStreamStart'), source.indexOf('function onStreamChunk'));
    assert.match(start, /setAnswerNote\(''\)/);
    assert.match(source, /api\.onShowLoading\([^]*?setAnswerNote\(''\)/);
    assert.match(source, /api\.onTranscriptionLlmResponse\([^]*?setAnswerNote\(providerNoteOf\(data\.metadata\)\)/);
    assert.match(source, /api\.onLlmError\([^]*?setAnswerNote\(''\)/);
    assert.match(source, /if \(endsStream\) setAnswerNote\(metadata\.isError \? '' : providerNoteOf\(metadata\)\)/);
  });

  it('has the note in the page, hidden, below the answer', () => {
    const html = readSource('llm-response.html');
    assert.match(html, /<p id="answer-note" class="answer-note" role="note" hidden><\/p>/);
    assert.ok(html.indexOf('id="answer-note"') > html.indexOf('id="answer-body"'));
  });
});

describe('chat note (chat-page.js)', () => {
  const PAGE = 'src/ui/chat-page.js';

  function fakeRow() {
    const children = [];
    const head = { className: 'message-head', after: (node) => children.splice(children.indexOf(head) + 1, 0, node) };
    children.push(head, { className: 'message-text' });
    const document = { createElement: () => ({ className: '', textContent: '' }) };
    const row = {
      children,
      querySelector: (sel) => (sel === '.message-head' ? head
        : sel === '.message-note' ? children.find((c) => c.className === 'message-note') || null : null),
      prepend: (node) => children.unshift(node),
    };
    return { row, document };
  }

  it('adds the note once, under the row head, as plain text', () => {
    const { row, document } = fakeRow();
    const addRowNote = loadFunction(PAGE, 'addRowNote', { document });
    addRowNote(row, NOTE);
    addRowNote(row, 'second');
    addRowNote(row, '');
    assert.deepEqual(row.children.map((c) => c.className), ['message-head', 'message-note', 'message-text']);
    assert.equal(row.children[1].textContent, NOTE);
  });

  it('passes the note from the final answer to the row', () => {
    const source = readSource(PAGE);
    assert.match(source, /note: providerNoteOf\(data\.metadata\)/);
    assert.match(source, /addRowNote\(entry\.el, note\)/);
    const MAX_NOTE_LENGTH = loadConstant(PAGE, 'MAX_NOTE_LENGTH');
    const providerNoteOf = loadFunction(PAGE, 'providerNoteOf', { MAX_NOTE_LENGTH });
    assert.equal(providerNoteOf({ providerNote: NOTE }), NOTE);
    assert.equal(providerNoteOf({ providerNote: ['x'] }), '');
  });
});

describe('Settings (settings-window.js, settings.html)', () => {
  const PAGE = 'src/ui/settings-window.js';

  it('moves a backup past its visible neighbour, keeping hidden providers in place', () => {
    const all = ['anthropic', 'openai', 'gemini', 'groq', 'ollama'].map((id) => ({ id, enabled: true }));
    const visible = new Set(['anthropic', 'gemini', 'groq']); // openai: no key; ollama: not set up
    const saved = [];
    const globals = {
      fallbackItems: () => all,
      shownFallback: () => all.filter((item) => visible.has(item.id)),
      saveFallback: (next, focus) => saved.push({ order: next.map((item) => item.id), focus }),
    };
    const moveFallback = loadFunction(PAGE, 'moveFallback', globals);
    moveFallback('gemini', 'up');
    assert.deepEqual(saved.pop(), { order: ['gemini', 'openai', 'anthropic', 'groq', 'ollama'], focus: { id: 'gemini', act: 'up' } });
    moveFallback('gemini', 'down');
    assert.deepEqual(saved.pop().order, ['anthropic', 'openai', 'groq', 'gemini', 'ollama']);
    moveFallback('anthropic', 'up');
    moveFallback('groq', 'down');
    moveFallback('openai', 'up');
    assert.deepEqual(saved, [], 'a move past the ends, or of a hidden provider, was saved');
  });

  it('has the backup list in AI provider and the opacity slider (40 to 100) in Privacy & appearance', () => {
    const html = readSource('settings.html');
    const ai = html.slice(html.indexOf('data-section="ai"'), html.indexOf('data-section="you"'));
    assert.match(ai, /If the provider fails, try/);
    assert.match(ai, /id="fallbackList"/);
    const privacy = html.slice(html.indexOf('data-section="privacy"'), html.indexOf('data-section="about"'));
    assert.match(privacy, /<input type="range"[^>]*id="windowOpacity"[^>]*min="40" max="100"/);
  });

  it('disables the slider where window opacity is not supported', () => {
    const source = readSource(PAGE);
    assert.match(source, /opacityInput\.disabled = !supported;/);
    assert.match(source, /state\.info\.windowOpacity !== false/);
  });
});
