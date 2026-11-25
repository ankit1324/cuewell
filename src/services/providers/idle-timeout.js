/**
 * Idle timeout for streamed provider responses.
 *
 * The SDK `timeout` option only bounds the wait for response headers. A
 * stream that sends headers and an event or two and then goes silent would
 * otherwise leave `stream()` pending forever and the overlay spinning.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 60000;
// setTimeout() fires after 1 ms for delays above 2^31 - 1 ms.
const MAX_TIMER_MS = 2147483647;

/** A positive timeout in ms; unset or invalid values fall back to 60 s. */
function resolveIdleTimeoutMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMER_MS) : DEFAULT_IDLE_TIMEOUT_MS;
}

/**
 * Arm an idle timer for one streaming request, starting now. Pass `signal` to
 * the SDK call and call `reset()` whenever data arrives (headers included).
 * After `ms` without a reset the request is aborted and `run()` rejects with a
 * "request timeout" error, which LLMService classifies as a retryable
 * timeout. That error wins over the SDK's abort error, and over SDK streams
 * that simply end when aborted. Call `clear()` on every exit path.
 *
 * Until the first reset the window is at least `firstResponseMs`, so the wait
 * for response headers keeps the SDK request timeout (which is longer than
 * the idle timeout to allow for cold local models).
 */
function startIdleTimeout(ms, label, firstResponseMs = 0) {
  const controller = new AbortController();
  let timer = null;
  let error = null;
  let rejectTimedOut;
  const timedOutPromise = new Promise((_, reject) => {
    rejectTimedOut = reject;
  });
  timedOutPromise.catch(() => {}); // surfaced through run(), never unhandled

  function arm(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      error = new Error(`request timeout: ${label} stopped sending data for ${Math.round(delay / 100) / 10}s`);
      rejectTimedOut(error);
      controller.abort();
    }, delay);
  }

  arm(Math.min(Math.max(ms, Number(firstResponseMs) || 0), MAX_TIMER_MS));

  return {
    signal: controller.signal,
    get error() {
      return error;
    },
    get timedOut() {
      return error !== null;
    },
    reset() {
      if (!error) arm(ms);
    },
    clear() {
      clearTimeout(timer);
      timer = null;
    },
    /** Settle with `task()`, or reject with the timeout error as soon as it fires. */
    run(task) {
      return Promise.race([task(), timedOutPromise]);
    }
  };
}

module.exports = { DEFAULT_IDLE_TIMEOUT_MS, resolveIdleTimeoutMs, startIdleTimeout };
