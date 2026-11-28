'use strict';
// src/core/active-answer.js: one answer at a time. A new answer stops the
// running one, a stop with an id only stops that answer, and every stopped
// answer is reported exactly once, before begin() or stop() returns.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ActiveAnswer } = require('../src/core/active-answer');

function tracker() {
  const stops = [];
  const answers = new ActiveAnswer({ onStop: (answer, reason) => stops.push({ id: answer.id, reason, text: answer.text }) });
  return { answers, stops };
}

describe('ActiveAnswer', () => {
  it('begin() stops the running answer first and reports it as replaced', () => {
    const { answers, stops } = tracker();
    const first = answers.begin('chat-1-1', { source: 'chat' });
    answers.append(first, 'Partial ');
    const second = answers.begin('tr-2-2', { source: 'voice' });
    assert.equal(first.signal.aborted, true);
    assert.equal(first.stopped, true);
    assert.equal(first.stopReason, 'replaced');
    assert.deepEqual(stops, [{ id: 'chat-1-1', reason: 'replaced', text: 'Partial ' }]);
    assert.equal(answers.current, second);
    assert.equal(second.signal.aborted, false);
    assert.equal(second.source, 'voice');
  });

  it('reports the stop before begin() returns, so the caller can store it first', () => {
    const order = [];
    const answers = new ActiveAnswer({ onStop: (answer) => order.push(`stopped ${answer.id}`) });
    answers.begin('a', {});
    order.push('begin b');
    answers.begin('b', {});
    order.push('b started');
    assert.deepEqual(order, ['begin b', 'stopped a', 'b started']);
  });

  it('stop() with an id stops only that answer', () => {
    const { answers, stops } = tracker();
    const answer = answers.begin('img-1-1');
    assert.equal(answers.stop('user', 'chat-9-9'), null);
    assert.equal(answer.signal.aborted, false);
    assert.equal(answers.stop('user', 'img-1-1'), answer);
    assert.equal(answer.signal.aborted, true);
    assert.deepEqual(stops.map((s) => s.reason), ['user']);
    assert.equal(answers.current, null);
  });

  it('reports each answer once, and nothing when no answer is running', () => {
    const { answers, stops } = tracker();
    assert.equal(answers.stop('user'), null);
    const answer = answers.begin('a');
    answers.stop('user');
    answers.stop('user');
    answers.begin('b');
    assert.deepEqual(stops.map((s) => s.id), ['a']);
    assert.equal(answer.stopped, true);
  });

  it('an answer that ended is not stopped by a later Stop or question', () => {
    const { answers, stops } = tracker();
    const answer = answers.begin('a');
    answers.finish(answer);
    assert.equal(answers.current, null);
    assert.equal(answers.stop('user', 'a'), null);
    answers.begin('b');
    assert.deepEqual(stops, []);
    assert.equal(answer.signal.aborted, false);
  });

  it('finish() of an older answer leaves the running one alone', () => {
    const { answers } = tracker();
    const first = answers.begin('a');
    const second = answers.begin('b');
    answers.finish(first);
    assert.equal(answers.current, second);
    assert.equal(answers.isActive(second), true);
  });

  it('keeps the text while running and ignores text after the stop', () => {
    const { answers } = tracker();
    const answer = answers.begin('a');
    assert.equal(answers.append(answer, 'one '), true);
    assert.equal(answers.reset(answer), true);
    answers.append(answer, 'two ');
    answers.stop('user');
    assert.equal(answers.append(answer, 'late'), false);
    assert.equal(answers.reset(answer), false);
    assert.equal(answer.text, 'two ');
    assert.equal(answers.append(null, 'x'), false);
  });

  it('treats an unknown reason as a user stop', () => {
    const { answers, stops } = tracker();
    answers.begin('a');
    answers.stop('whatever');
    assert.equal(stops[0].reason, 'user');
  });
});
