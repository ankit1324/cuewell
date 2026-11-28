// An https.get-compatible GET built on Electron's net.request, so voice
// model downloads use the session's proxy settings (system proxy, PAC,
// --proxy-server) like the update checker's net.fetch. Node's https.get
// ignores them.
//
// Main process only. 'electron' is required lazily, on the first request
// without injected `net`, so this module loads in plain Node (tests,
// scripts), which keep using https.get.
//
// What whisper-models.js's request() and writeBody() use, as https.get gives
// it: callback(res) with res.statusCode, lowercase string res.headers, and a
// readable res (data, end, error, aborted, pause, resume, destroy); a req with
// on('error'), setTimeout(ms, cb), destroy(error) and abort().
//
// Redirects are never followed here (redirect: 'manual'). A redirect reaches
// the callback as a 3xx response with headers.location, and the net request
// is aborted, so request() checks every hop against its host allowlist
// before anything is sent to it. No cookies and no credentials are sent.

const { EventEmitter } = require('events');
const { Readable } = require('stream');

// Chromium network errors (net::ERR_*) as the Node codes whisper-models.js
// turns into messages (offline, connection dropped).
const NET_ERROR_CODES = Object.freeze({
  ERR_NAME_NOT_RESOLVED: 'ENOTFOUND',
  ERR_NAME_RESOLUTION_FAILED: 'EAI_AGAIN',
  ERR_INTERNET_DISCONNECTED: 'ENETDOWN',
  ERR_NETWORK_ACCESS_DENIED: 'ENETUNREACH',
  ERR_ADDRESS_UNREACHABLE: 'EHOSTUNREACH',
  ERR_CONNECTION_REFUSED: 'ECONNREFUSED',
  ERR_CONNECTION_RESET: 'ECONNRESET',
  ERR_CONNECTION_CLOSED: 'ECONNRESET',
  ERR_CONNECTION_ABORTED: 'ECONNABORTED',
  ERR_CONNECTION_FAILED: 'ECONNREFUSED',
  ERR_CONNECTION_TIMED_OUT: 'ETIMEDOUT',
  ERR_TIMED_OUT: 'ETIMEDOUT',
  ERR_NETWORK_CHANGED: 'ECONNRESET',
  ERR_NETWORK_IO_SUSPENDED: 'ECONNRESET',
  ERR_EMPTY_RESPONSE: 'ECONNRESET',
  ERR_INCOMPLETE_CHUNKED_ENCODING: 'ECONNRESET',
  ERR_CONTENT_LENGTH_MISMATCH: 'ECONNRESET',
  ERR_PROXY_CONNECTION_FAILED: 'ECONNREFUSED',
  ERR_TUNNEL_CONNECTION_FAILED: 'ECONNREFUSED',
});

/** Electron's headers ({ Name: string | string[] }) as lowercase string values. */
function normalizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined || raw === null) continue;
    const key = String(name).toLowerCase();
    const values = (Array.isArray(raw) ? raw : [raw]).map(String);
    if (!values.length) continue;
    if (key === 'location') {
      // One target only; a joined list would be a different URL.
      if (!(key in out)) out[key] = values[0];
      continue;
    }
    const value = values.join(', ');
    out[key] = key in out ? `${out[key]}, ${value}` : value;
  }
  return out;
}

/** A net error with the Node `code` whisper-models.js knows, when there is one. */
function toNodeError(error) {
  if (!error || typeof error !== 'object') return new Error(String(error || 'Network error'));
  if (typeof error.code === 'string' && error.code) return error;
  const match = /net::(ERR_[A-Z_]+)/.exec(String(error.message || ''));
  const out = new Error(error.message || 'Network error');
  out.code = match ? (NET_ERROR_CODES[match[1]] || match[1]) : 'ERR_NETWORK';
  out.cause = error;
  return out;
}

function connectionReset(message) {
  const error = new Error(message);
  error.code = 'ECONNRESET';
  return error;
}

/** Destroy `stream` with `error` only if someone listens for it (an unheard 'error' throws). */
function destroyQuietly(stream, error) {
  if (stream.destroyed) return;
  if (error && stream.listenerCount('error') > 0) stream.destroy(error);
  else stream.destroy();
}

class ElectronGetRequest extends EventEmitter {
  constructor() {
    super();
    this.netRequest = null;
    this.response = null; // our Readable, once a response arrived
    this.done = false; // finished, failed, redirected or destroyed
    this.destroyed = false;
    this.timeoutMs = 0;
    this.timer = null;
  }

  /** Node's idle timeout: `cb` runs after `ms` without response bytes. */
  setTimeout(ms, cb) {
    this.timeoutMs = Number(ms) > 0 ? Number(ms) : 0;
    if (typeof cb === 'function') this.once('timeout', cb);
    this._armTimer();
    return this;
  }

  _armTimer() {
    this._clearTimer();
    if (!this.timeoutMs || this.done) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.done) this.emit('timeout');
    }, this.timeoutMs);
  }

  _clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Stop the request (and its response); `error`, if given, is emitted as on Node. */
  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    const wasDone = this.done;
    this.done = true;
    this._clearTimer();
    this._abortNet();
    const res = this.response;
    if (res && !res.readableEnded && !res.destroyed) {
      if (!error) res.emit('aborted');
      destroyQuietly(res, error);
    }
    if (error && !wasDone && this.listenerCount('error') > 0) this.emit('error', error);
    this.emit('close');
    return this;
  }

  abort() {
    return this.destroy();
  }

  _abortNet() {
    if (!this.netRequest) return;
    try {
      this.netRequest.abort();
    } catch (_) { /* already closed */ }
  }

  _fail(error) {
    if (this.done) return;
    this.done = true;
    this._clearTimer();
    const res = this.response;
    if (res && !res.readableEnded) destroyQuietly(res, error);
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }
}

/** Our readable for an Electron IncomingMessage, with backpressure. */
function wrapResponse(request, response) {
  let sourcePaused = false;
  const res = new Readable({
    read() {
      if (!sourcePaused) return;
      sourcePaused = false;
      try { response.resume(); } catch (_) { /* closed */ }
    },
    destroy(error, callback) {
      // The consumer gave up on the body: stop downloading it.
      if (!request.done) {
        request.done = true;
        request._clearTimer();
        request._abortNet();
      }
      callback(error);
    },
  });
  res.statusCode = Number(response.statusCode) || 0;
  res.statusMessage = response.statusMessage || '';
  res.headers = normalizeHeaders(response.headers);
  // Chromium decodes gzip/br bodies; content-length is then the encoded size.
  const encoding = res.headers['content-encoding'];
  if (encoding && encoding.toLowerCase() !== 'identity') delete res.headers['content-length'];

  response.on('data', (chunk) => {
    if (request.done || res.destroyed) return;
    request._armTimer();
    if (!res.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) && typeof response.pause === 'function') {
      sourcePaused = true;
      try { response.pause(); } catch (_) { /* closed */ }
    }
  });
  response.on('end', () => {
    if (request.done || res.destroyed) return;
    request.done = true;
    request._clearTimer();
    res.push(null);
  });
  response.on('aborted', () => {
    if (request.done || res.destroyed) return;
    request.done = true;
    request._clearTimer();
    res.emit('aborted');
    destroyQuietly(res, connectionReset('Connection closed during the download'));
  });
  response.on('error', (error) => {
    if (request.done || res.destroyed) return;
    request._fail(toNodeError(error));
  });
  return res;
}

/** A 3xx response with no body, for a redirect that is not followed. */
function redirectResponse(statusCode, redirectUrl, responseHeaders) {
  const res = new Readable({ read() {} });
  res.statusCode = Number(statusCode) || 302;
  res.statusMessage = '';
  res.headers = normalizeHeaders(responseHeaders);
  if (typeof redirectUrl === 'string' && redirectUrl) res.headers.location = redirectUrl;
  res.push(null);
  return res;
}

/**
 * An https.get(url, options, callback) stand-in over Electron's net module.
 *
 * @param {object} [deps]
 * @param {object} [deps.net] Electron's net module (default: require('electron').net)
 * @param {object} [deps.session] the Session to use (default: session.defaultSession)
 */
function createElectronHttpGet(deps = {}) {
  let electron = null;
  const lazyElectron = () => {
    if (!electron) electron = require('electron');
    return electron;
  };

  return function electronHttpGet(url, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const net = deps.net || lazyElectron().net;
    const session = 'session' in deps ? deps.session : (lazyElectron().session || {}).defaultSession;
    const request = new ElectronGetRequest();

    const netOptions = {
      method: 'GET',
      url: String(url),
      redirect: 'manual',
      useSessionCookies: false,
      credentials: 'omit',
      // Not through the HTTP cache: a 190 MB file would push out the app's
      // entries, and a resume must come from the server.
      cache: 'no-store',
    };
    if (session) netOptions.session = session;
    const netRequest = net.request(netOptions);
    request.netRequest = netRequest;

    const headers = (options && options.headers) || {};
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) netRequest.setHeader(name, String(value));
    }

    netRequest.on('response', (response) => {
      if (request.done) {
        response.on('error', () => {}); // a later net error must not throw
        try { response.resume(); } catch (_) { /* closed */ }
        return;
      }
      request.response = wrapResponse(request, response);
      request._armTimer();
      if (typeof callback === 'function') callback(request.response);
    });
    netRequest.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      if (request.done) return;
      // Not calling followRedirect() cancels it; abort() makes that a clean
      // stop instead of a "Redirect was cancelled" error.
      request.done = true;
      request._clearTimer();
      request._abortNet();
      const res = redirectResponse(statusCode, redirectUrl, responseHeaders);
      request.response = res;
      process.nextTick(() => {
        if (!request.destroyed && typeof callback === 'function') callback(res);
      });
    });
    netRequest.on('login', (_authInfo, answer) => {
      // No credentials: empty ones cancel the request.
      try { answer(); } catch (_) { /* closed */ }
    });
    netRequest.on('error', (error) => request._fail(toNodeError(error)));
    netRequest.on('abort', () => {
      if (!request.done) {
        const error = new Error('The request was aborted');
        error.code = 'ECONNABORTED';
        request._fail(error);
      }
    });
    netRequest.end();
    return request;
  };
}

module.exports = { createElectronHttpGet, normalizeHeaders, NET_ERROR_CODES };
