/**
 * Cancellation for AI requests. main.js gives every answer an
 * AbortController and passes its signal down through LLMService to the
 * provider calls. When the signal fires, every layer stops with the same
 * "cancelled" error: no retry, no fallback model, no non-streaming fallback,
 * and no error message for the user, because the user (or a newer question)
 * asked for the stop.
 */

const CANCELLED = 'ANSWER_CANCELLED';

/** The error a stopped request ends with. */
function cancelledError() {
  const error = new Error('Answer stopped');
  error.name = 'AbortError';
  error.code = CANCELLED;
  error.isCancelled = true;
  return error;
}

/** True for the error cancelledError() makes. */
function isCancelledError(error) {
  return !!(error && error.code === CANCELLED && error.isCancelled === true);
}

/** True when `signal` is an AbortSignal that has fired. */
function isAborted(signal) {
  return !!(signal && signal.aborted);
}

/** Throw the cancelled error when `signal` has fired. */
function throwIfCancelled(signal) {
  if (isAborted(signal)) throw cancelledError();
}

/**
 * Settle with `promise`, or reject with the cancelled error as soon as
 * `signal` fires. For calls that ignore the signal: their late result is
 * dropped (a rejection after the stop is swallowed, never unhandled).
 */
function raceCancel(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(cancelledError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? cancelledError() : error);
      }
    );
  });
}

/** Wait `ms`, or reject with the cancelled error as soon as `signal` fires. */
function cancellableDelay(ms, signal) {
  if (isAborted(signal)) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One signal that fires when any of `signals` does (null entries are
 * skipped). Returns null when none is given.
 */
function anySignal(...signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

module.exports = {
  cancelledError,
  isCancelledError,
  isAborted,
  throwIfCancelled,
  raceCancel,
  cancellableDelay,
  anySignal
};
