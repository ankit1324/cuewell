'use strict';
// LLMService.enforceProgrammingLanguage: retags code fence openers with the
// selected coding language (Coding mode) and leaves everything else alone.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stubLogger, clearAppEnv } = require('./helpers/env');

stubLogger();
clearAppEnv();
const llmService = require('../src/services/llm.service');

const FENCE = '```';
const retag = (text, language = 'python') => llmService.enforceProgrammingLanguage(text, language);

describe('enforceProgrammingLanguage', () => {
  it('tags an untagged opener and leaves the closer plain', () => {
    assert.equal(retag(`${FENCE}\ncode\n${FENCE}`), `${FENCE}python\ncode\n${FENCE}`);
  });

  it('replaces another language tag', () => {
    assert.equal(retag(`${FENCE}js\nlet x = 1;\n${FENCE}`, 'cpp'), `${FENCE}cpp\nlet x = 1;\n${FENCE}`);
  });

  it('maps js to javascript and passes other languages through', () => {
    assert.equal(retag(`${FENCE}\nx\n${FENCE}`, 'js'), `${FENCE}javascript\nx\n${FENCE}`);
    assert.equal(retag(`${FENCE}\nx\n${FENCE}`, 'Rust'), `${FENCE}rust\nx\n${FENCE}`);
  });

  it('keeps a matching tag and its info string', () => {
    const text = `${FENCE}python title=a.py\nx\n${FENCE}`;
    assert.equal(retag(text), text);
  });

  it('retags every opener and no closer', () => {
    const text = `a\n${FENCE}js\nx\n${FENCE}\nb\n${FENCE}\ny\n${FENCE}`;
    assert.equal(retag(text, 'java'), `a\n${FENCE}java\nx\n${FENCE}\nb\n${FENCE}java\ny\n${FENCE}`);
  });

  it('never changes inline triple backticks', () => {
    for (const text of [
      `Call ${FENCE}solve()${FENCE} once.`,
      `${FENCE}solve()${FENCE} is the entry point.`,
      'Use `x` and ``y`` inline.',
    ]) {
      assert.equal(retag(text), text);
    }
  });

  it('never changes code inside a fence, including fence-like lines', () => {
    const text = `${FENCE}\`\n${FENCE}js\nx\n${FENCE}\n${FENCE}\``;
    assert.equal(retag(text), `${FENCE}\`python\n${FENCE}js\nx\n${FENCE}\n${FENCE}\``);
  });

  it('keeps CRLF line endings', () => {
    assert.equal(retag(`${FENCE}js\r\nx\r\n${FENCE}\r\n`), `${FENCE}python\r\nx\r\n${FENCE}\r\n`);
    assert.equal(retag(`intro\r\n${FENCE}\r\nx\r\n${FENCE}`), `intro\r\n${FENCE}python\r\nx\r\n${FENCE}`);
  });

  it('turns a tilde fence into a backtick fence', () => {
    assert.equal(retag('~~~js\nx\n~~~'), `${FENCE}python\nx\n${FENCE}`);
  });

  it('makes a converted tilde fence longer than the backtick runs inside it', () => {
    assert.equal(retag(`~~~\n${FENCE}\nx\n${FENCE}\n~~~`), `${FENCE}\`python\n${FENCE}\nx\n${FENCE}\n${FENCE}\``);
  });

  it('retags the opener of a fence that is never closed', () => {
    assert.equal(retag(`${FENCE}js\nx`), `${FENCE}python\nx`);
    assert.equal(retag('~~~js\nx'), `${FENCE}python\nx`);
  });

  it('leaves openers indented 4 or more spaces as written', () => {
    const text = `    ${FENCE}js\n    x\n    ${FENCE}`;
    assert.equal(retag(text), text);
  });

  it('is idempotent', () => {
    const samples = [
      `${FENCE}\ncode\n${FENCE}`,
      `${FENCE}js\r\nx\r\n${FENCE}\r\n`,
      `~~~\n${FENCE}\nx\n${FENCE}\n~~~`,
      '~~~js\nx',
      `text ${FENCE}inline${FENCE}\n${FENCE}c\nint main() {}\n${FENCE}\nmore`,
      `- item\n  ${FENCE}\n  nested\n  ${FENCE}`,
    ];
    for (const language of ['python', 'cpp', 'js']) {
      for (const sample of samples) {
        const once = retag(sample, language);
        assert.equal(retag(once, language), once, `not idempotent for ${JSON.stringify(sample)}`);
      }
    }
  });

  it('returns the input unchanged without text or language', () => {
    assert.equal(retag('', 'python'), '');
    assert.equal(retag(null, 'python'), null);
    assert.equal(retag(undefined, 'python'), undefined);
    const text = `${FENCE}js\nx\n${FENCE}`;
    assert.equal(retag(text, ''), text);
    assert.equal(retag(text, null), text);
  });

  it('handles a long answer quickly', () => {
    const block = `Some prose with ${FENCE}inline${FENCE}.\n${FENCE}js\nconst a = 1;\n${FENCE}\n`;
    const text = block.repeat(5000);
    const started = process.hrtime.bigint();
    const out = retag(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms`);
    assert.equal(out, block.replace(`${FENCE}js`, `${FENCE}python`).repeat(5000));
  });
});

describe('shouldRetagCode', () => {
  it('retags only in Coding mode with a language', () => {
    assert.equal(llmService.shouldRetagCode('dsa', 'python'), true);
    assert.equal(llmService.shouldRetagCode('auto', 'python'), false);
    assert.equal(llmService.shouldRetagCode('technical', 'python'), false);
    assert.equal(llmService.shouldRetagCode('dsa', null), false);
    assert.equal(llmService.shouldRetagCode('dsa', ''), false);
  });
});
