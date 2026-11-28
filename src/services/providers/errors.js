/**
 * Turn SDK errors into plain Errors whose message starts with the HTTP status
 * (e.g. "401 invalid API key: ...") or a network/timeout marker, so
 * LLMService.analyzeError() and the retry policy can classify them. Both the
 * Anthropic and OpenAI SDKs are Stainless-generated and expose the same error
 * classes, so one helper serves both: pass the SDK namespace in.
 */

const MAX_TOKENS_NO_TEXT = 'MAX_TOKENS_NO_TEXT';
// A refusal on content grounds: another provider is never asked instead.
const CONTENT_REFUSED = 'CONTENT_REFUSED';

const STATUS_TEXT = {
  400: 'bad request',
  401: 'invalid API key',
  402: 'payment required',
  403: 'forbidden',
  404: 'model or endpoint not found',
  408: 'request timeout',
  413: 'request too large',
  422: 'unprocessable request',
  429: 'rate limit exceeded',
  500: 'server error',
  502: 'bad gateway',
  503: 'service unavailable',
  504: 'gateway timeout',
  529: 'overloaded'
};

// Errors sent inside an open stream carry an error type but no HTTP status.
const STREAM_ERROR_STATUS = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429,
  api_error: 500,
  server_error: 500,
  overloaded_error: 529
};

function statusOf(error) {
  if (Number.isInteger(error.status)) return error.status;
  // OpenRouter reports mid-stream failures with a numeric `code`.
  if (Number.isInteger(error.code)) return error.code;
  const type = error.type || (error.error && error.error.type);
  return STREAM_ERROR_STATUS[type] || null;
}

function apiDetail(error) {
  const candidates = [
    error.apiMessage, // Anthropic
    error.error && error.error.message, // OpenAI
    error.error && error.error.error && error.error.error.message // Anthropic body without apiMessage
  ];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  if (found) return found.trim();
  return String(error.message || 'no details').replace(/^\d{3}\s+/, '');
}

function causeCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (typeof current.code === 'string' && current.code) return current.code;
    current = current.cause;
  }
  return null;
}

function withCause(message, cause, status) {
  const err = new Error(message);
  if (status) err.status = status;
  err.cause = cause;
  return err;
}

function normalizeSdkError(sdk, error, label) {
  if (!(error instanceof sdk.APIError)) {
    // Our own errors (refusals, empty answers) and non-HTTP failures pass through.
    return error instanceof Error ? error : new Error(`${label} request failed: ${String(error)}`);
  }
  if (error instanceof sdk.APIUserAbortError) {
    return withCause(`${label} request was aborted`, error);
  }
  if (error instanceof sdk.APIConnectionTimeoutError) {
    return withCause(`request timeout: ${label} did not respond in time`, error);
  }
  if (error instanceof sdk.APIConnectionError) {
    const code = causeCode(error.cause);
    return withCause(`network error: could not connect to ${label}${code ? `: ${code}` : ''}`, error);
  }

  const status = statusOf(error);
  const detail = apiDetail(error);
  if (!status) {
    return withCause(`${label} error: ${detail}`, error);
  }
  const text = STATUS_TEXT[status] || (status >= 500 ? 'server error' : 'request failed');
  return withCause(`${status} ${text}: ${detail}`, error, status);
}

/**
 * A response that stopped at the token limit before any visible text, which
 * happens when a reasoning model spends the whole budget thinking.
 */
function noTextAtLimitError(label, maxTokens) {
  const err = new Error(`${label} reached the ${maxTokens}-token limit before writing any text`);
  err.code = MAX_TOKENS_NO_TEXT;
  return err;
}

/** The model declined the request (a safety or content refusal). */
function refusedError(message) {
  const err = new Error(message);
  err.code = CONTENT_REFUSED;
  return err;
}

module.exports = { normalizeSdkError, noTextAtLimitError, refusedError, MAX_TOKENS_NO_TEXT, CONTENT_REFUSED };
