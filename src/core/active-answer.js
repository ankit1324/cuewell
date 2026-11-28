/**
 * The one answer the main process is producing now.
 *
 * Every question (typed chat, a voice transcript once the coalesce debounce
 * fires, a screenshot) starts an answer with begin(). Only one answer runs
 * at a time: begin() stops the one still running first, so two quick
 * questions never stream into each other. stop() ends the running answer on
 * request (the Stop button or shortcut).
 *
 * Each answer carries an AbortController whose signal goes to LLMService,
 * and the text streamed so far. A stopped answer is reported to `onStop`
 * exactly once, synchronously, before begin() or stop() returns, so the
 * caller can store its partial text in session memory before the next
 * question is stored.
 */

const STOP_REASONS = Object.freeze(['user', 'replaced']);

class ActiveAnswer {
  /**
   * @param {{ onStop?: (answer: object, reason: 'user' | 'replaced') => void }} options
   */
  constructor({ onStop = null } = {}) {
    this.current = null;
    this.onStop = typeof onStop === 'function' ? onStop : null;
  }

  /**
   * Start answer `id`, stopping the one still running (reason "replaced").
   * `info` is kept on the answer for the caller (source, skill, targets...).
   */
  begin(id, info = {}) {
    this.stop('replaced');
    const controller = new AbortController();
    const answer = {
      ...info,
      id,
      controller,
      signal: controller.signal,
      text: '',
      stopped: false,
      stopReason: null,
      done: false
    };
    this.current = answer;
    return answer;
  }

  /** True while `answer` is the running answer and has not been stopped. */
  isActive(answer) {
    return !!answer && this.current === answer && !answer.stopped && !answer.done;
  }

  /** Add streamed text to `answer`; ignored once it stopped or ended. */
  append(answer, delta) {
    if (!this.isActive(answer) || typeof delta !== 'string') return false;
    answer.text += delta;
    return true;
  }

  /** A retry or fallback starts `answer` over: drop its text so far. */
  reset(answer) {
    if (!this.isActive(answer)) return false;
    answer.text = '';
    return true;
  }

  /**
   * Stop the running answer. With `messageId`, only when that is the running
   * one, so a Stop pressed for an answer that just ended cannot stop the
   * next. Returns the stopped answer, or null when nothing was stopped.
   */
  stop(reason = 'user', messageId = null) {
    const answer = this.current;
    if (!answer || answer.stopped || answer.done) return null;
    if (messageId !== null && messageId !== undefined && messageId !== answer.id) return null;
    answer.stopped = true;
    answer.stopReason = STOP_REASONS.includes(reason) ? reason : 'user';
    this.current = null;
    try {
      answer.controller.abort();
    } finally {
      if (this.onStop) this.onStop(answer, answer.stopReason);
    }
    return answer;
  }

  /** `answer` ended (answered, failed or stopped); it is no longer running. */
  finish(answer) {
    if (!answer) return;
    answer.done = true;
    if (this.current === answer) this.current = null;
  }
}

module.exports = { ActiveAnswer, STOP_REASONS };
