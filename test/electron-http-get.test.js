'use strict';
// src/core/electron-http-get.js: the https.get stand-in over Electron's
// net.request, which downloadModel uses in the app so downloads honor the
// system proxy. A fake electron.net is injected; no real Electron.
//
// The fake follows Electron's ClientRequest: setHeader(), end(), abort()
// (emits 'abort'), and in redirect: 'manual' mode a 'redirect' event that
// cancels the request with an error unless followRedirect() is called or the
// request is aborted during the event.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { tempDir } = require('./helpers/env');

const { createElectronHttpGet, normalizeHeaders } = require('../src/core/electron-http-get');
const models = require('../src/core/whisper-models');

const BASE = models.MODELS.find((m) => m.id === 'base-q5_1');
const URL_BASE = models.DOWNLOAD_BASE_URL;
const CDN = 'https://cdn-lfs.hf.co/repos/ab/cd/blob';
const SESSION = { name: 'fake default session' };

class FakeIncoming extends EventEmitter {
  constructor(statusCode, headers) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
    this.paused = false;
    this.pauses = 0;
  }

  pause() {
    this.paused = true;
    this.pauses += 1;
  }

  resume() {
    this.paused = false;
    this.emit('resumed');
  }
}

class FakeNetRequest extends EventEmitter {
  constructor(options, handler) {
    super();
    this.options = options;
    this.handler = handler;
    this.headers = {};
    this.ended = false;
    this.aborted = false;
    this.followed = false;
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  end() {
    this.ended = true;
    setImmediate(() => {
      if (!this.aborted) this.handler(this);
    });
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.emit('abort');
    this.emit('close');
  }

  followRedirect() {
    this.followed = true;
  }

  /** Electron's manual-mode redirect. */
  redirect(statusCode, location, headers = {}) {
    this.emit('redirect', statusCode, 'GET', location, { Location: [location], ...headers });
    if (!this.followed && !this.aborted) this.emit('error', new Error('Redirect was cancelled'));
  }

  /** Answer with `body`, in chunks on later ticks; stops after `stallAfter` bytes. */
  respond(statusCode, headers = {}, body = Buffer.alloc(0), { chunkSize = 1024 * 1024, stallAfter, gapMs } = {}) {
    const res = new FakeIncoming(statusCode, headers);
    this.emit('response', res);
    let offset = 0;
    const next = (fn) => (gapMs ? setTimeout(fn, gapMs) : setImmediate(fn));
    const pump = () => {
      if (this.aborted) return;
      if (res.paused) {
        res.once('resumed', pump);
        return;
      }
      if (stallAfter !== undefined && offset >= stallAfter) return;
      if (offset >= body.length) {
        res.emit('end');
        return;
      }
      let end = Math.min(offset + chunkSize, body.length);
      if (stallAfter !== undefined) end = Math.min(end, stallAfter);
      res.emit('data', body.subarray(offset, end));
      offset = end;
      next(pump);
    };
    next(pump);
    return res;
  }
}

function createFakeNet(handler) {
  const requests = [];
  return {
    requests,
    request(options) {
      const req = new FakeNetRequest(options, (r) => handler(r, requests.length));
      requests.push(req);
      return req;
    },
  };
}

function get(net, url = 'https://huggingface.co/x', headers = {}) {
  const httpGet = createElectronHttpGet({ net, session: SESSION });
  return new Promise((resolve) => {
    const req = httpGet(url, { headers }, (res) => resolve({ req, res }));
    req.on('error', () => {});
  });
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

describe('electron-http-get', () => {
  it('requests through net with the default session, manual redirects, no cache and no cookies or credentials', async () => {
    const net = createFakeNet((r) => r.respond(200, { 'Content-Length': '5' }, Buffer.from('hello')));
    const { res } = await get(net, 'https://huggingface.co/a', { 'User-Agent': 'Cuewell', Range: 'bytes=10-' });
    assert.equal((await readAll(res)).toString(), 'hello');
    const [req] = net.requests;
    assert.deepEqual(req.options, {
      method: 'GET',
      url: 'https://huggingface.co/a',
      redirect: 'manual',
      useSessionCookies: false,
      credentials: 'omit',
      cache: 'no-store',
      session: SESSION,
    });
    assert.deepEqual(req.headers, { 'User-Agent': 'Cuewell', Range: 'bytes=10-' });
    assert.equal(req.ended, true);
  });

  it('maps the status and lowercases headers, joining Electron\'s arrays', async () => {
    const net = createFakeNet((r) => r.respond(206, {
      'Content-Range': ['bytes 1-4/5'],
      'Content-Length': ['4'],
      'Set-Cookie': ['a=1', 'b=2'],
      'X-Single': 'v',
      'X-Empty': [],
    }, Buffer.from('ello')));
    const { res } = await get(net);
    assert.equal(res.statusCode, 206);
    assert.deepEqual(res.headers, {
      'content-range': 'bytes 1-4/5',
      'content-length': '4',
      'set-cookie': 'a=1, b=2',
      'x-single': 'v',
    });
    assert.equal((await readAll(res)).toString(), 'ello');
  });

  it('normalizeHeaders keeps one location and merges duplicate names', () => {
    assert.deepEqual(normalizeHeaders({ Location: ['https://a/1', 'https://b/2'], location: 'https://c/3' }),
      { location: 'https://a/1' });
    assert.deepEqual(normalizeHeaders({ 'X-A': '1', 'x-a': ['2', '3'] }), { 'x-a': '1, 2, 3' });
    assert.deepEqual(normalizeHeaders(null), {});
    assert.deepEqual(normalizeHeaders({ 'X-N': 5, 'X-U': undefined }), { 'x-n': '5' });
  });

  it('drops content-length for a body Chromium decoded', async () => {
    const net = createFakeNet((r) => r.respond(200, { 'Content-Encoding': 'gzip', 'Content-Length': '3' }, Buffer.from('decoded')));
    const { res } = await get(net);
    assert.equal(res.headers['content-length'], undefined);
    assert.equal((await readAll(res)).toString(), 'decoded');
  });

  it('a manual redirect is a 3xx response with location, and the net request is aborted, not followed', async () => {
    const net = createFakeNet((r) => r.redirect(302, `${CDN}/x`, { 'X-Linked-Size': ['5'] }));
    const errors = [];
    const httpGet = createElectronHttpGet({ net, session: SESSION });
    const { res, req } = await new Promise((resolve) => {
      const r = httpGet('https://huggingface.co/x', {}, (response) => resolve({ res: response, req: r }));
      r.on('error', (e) => errors.push(e));
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `${CDN}/x`);
    assert.equal(res.headers['x-linked-size'], '5');
    assert.equal(net.requests.length, 1);
    assert.equal(net.requests[0].aborted, true);
    assert.equal(net.requests[0].followed, false);
    res.resume();
    await once(res, 'end');
    req.destroy();
    assert.deepEqual(errors, [], '"Redirect was cancelled" is not reported');
  });

  it('a redirect is not reported once the request was destroyed', async () => {
    let req;
    const net = createFakeNet((r) => {
      r.redirect(302, `${CDN}/x`);
      req.destroy(); // before the deferred callback runs
    });
    let called = false;
    req = createElectronHttpGet({ net, session: SESSION })('https://huggingface.co/x', {}, () => { called = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, false);
    assert.equal(net.requests[0].aborted, true);
  });

  it('a net error reaches req "error" with the Node code whisper-models knows', async () => {
    const net = createFakeNet((r) => r.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED')));
    const httpGet = createElectronHttpGet({ net, session: SESSION });
    const req = httpGet('https://huggingface.co/x', {}, () => assert.fail('no response'));
    const [error] = await once(req, 'error');
    assert.equal(error.code, 'ENOTFOUND');
    assert.match(error.message, /ERR_NAME_NOT_RESOLVED/);

    const other = createFakeNet((r) => r.emit('error', new Error('net::ERR_SOMETHING_NEW')));
    const req2 = createElectronHttpGet({ net: other, session: SESSION })('https://huggingface.co/x', {}, () => {});
    const [error2] = await once(req2, 'error');
    assert.equal(error2.code, 'ERR_SOMETHING_NEW');
  });

  it('a net error during the body reaches res "error"', async () => {
    const net = createFakeNet((r) => {
      const res = r.respond(200, {}, Buffer.alloc(10), { stallAfter: 4 });
      setTimeout(() => res.emit('error', new Error('net::ERR_CONNECTION_RESET')), 20);
    });
    const { res } = await get(net);
    await assert.rejects(readAll(res), { code: 'ECONNRESET' });
  });

  it('an aborted response emits "aborted"', async () => {
    const net = createFakeNet((r) => {
      const res = r.respond(200, {}, Buffer.alloc(10), { stallAfter: 4 });
      setTimeout(() => res.emit('aborted'), 20);
    });
    const { res } = await get(net);
    res.on('data', () => {});
    res.on('error', () => {});
    await once(res, 'aborted');
  });

  it('login is answered with no credentials', async () => {
    const answers = [];
    const net = createFakeNet((r) => {
      r.emit('login', { isProxy: true }, (...args) => answers.push(args));
      r.respond(407, {});
    });
    const { res } = await get(net);
    assert.equal(res.statusCode, 407);
    assert.deepEqual(answers, [[]]);
  });

  it('setTimeout fires when no bytes arrive, before or during the body', async () => {
    const silent = createFakeNet(() => {}); // never answers
    const httpGet = createElectronHttpGet({ net: silent, session: SESSION });
    const req = httpGet('https://huggingface.co/x', {}, () => assert.fail('no response'));
    const started = Date.now();
    await new Promise((resolve) => req.setTimeout(50, resolve));
    assert.ok(Date.now() - started >= 45);
    req.destroy();
    assert.equal(silent.requests[0].aborted, true);

    const stalls = createFakeNet((r) => r.respond(200, {}, Buffer.alloc(100), { chunkSize: 10, stallAfter: 30 }));
    const { req: req2, res } = await get(stalls);
    let timedOut = false;
    req2.setTimeout(60, () => { timedOut = true; });
    res.on('data', () => {});
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(timedOut, true);
    req2.destroy();
  });

  it('setTimeout does not fire while data flows', async () => {
    // 15 chunks, 20 ms apart: 300 ms in all, more than the 60 ms timeout.
    const net = createFakeNet((r) => r.respond(200, {}, Buffer.alloc(150), { chunkSize: 10, gapMs: 20 }));
    const { req, res } = await get(net);
    let timedOut = false;
    req.setTimeout(60, () => { timedOut = true; });
    const body = await readAll(res);
    assert.equal(body.length, 150);
    await new Promise((r) => setTimeout(r, 100)); // and not after the end
    assert.equal(timedOut, false);
  });

  it('destroy(error) aborts the net request and fails the response with the error', async () => {
    const net = createFakeNet((r) => r.respond(200, {}, Buffer.alloc(10), { stallAfter: 4 }));
    const { req, res } = await get(net);
    const reqErrors = [];
    req.on('error', (e) => reqErrors.push(e));
    const failed = assert.rejects(readAll(res), { code: 'ETIMEDOUT' });
    const error = new Error('Download timed out');
    error.code = 'ETIMEDOUT';
    req.destroy(error);
    await failed;
    assert.equal(net.requests[0].aborted, true);
    assert.deepEqual(reqErrors, [error]);
  });

  it('abort() and res.destroy() stop the net request', async () => {
    const net = createFakeNet((r) => r.respond(200, {}, Buffer.alloc(10), { stallAfter: 4 }));
    const first = await get(net);
    first.res.on('data', () => {});
    const aborted = once(first.res, 'aborted');
    first.req.abort();
    await aborted;
    assert.equal(net.requests[0].aborted, true);

    const second = await get(net);
    second.res.destroy();
    assert.equal(net.requests[1].aborted, true);
  });

  it('pauses the net response while the reader is behind', async () => {
    const body = crypto.randomBytes(256 * 1024);
    let source;
    const net = createFakeNet((r) => { source = r.respond(200, {}, body, { chunkSize: 64 * 1024 }); });
    const { res } = await get(net);
    await new Promise((r) => setTimeout(r, 50)); // nobody reads yet
    assert.ok(source.pauses > 0, 'source was paused');
    assert.ok(Buffer.compare(await readAll(res), body) === 0);
  });

  it('loads and runs in plain Node without requiring electron when net is injected', async () => {
    const Module = require('node:module');
    const realLoad = Module._load;
    const loaded = [];
    Module._load = function load(request, ...rest) {
      if (request === 'electron') loaded.push(request);
      return realLoad.call(this, request, ...rest);
    };
    try {
      const file = require.resolve('../src/core/electron-http-get');
      delete require.cache[file];
      const fresh = require(file);
      const net = createFakeNet((r) => r.respond(200, {}, Buffer.from('ok')));
      const res = await new Promise((resolve) => {
        fresh.createElectronHttpGet({ net, session: SESSION })('https://huggingface.co/x', {}, resolve);
      });
      assert.equal((await readAll(res)).toString(), 'ok');
    } finally {
      Module._load = realLoad;
    }
    assert.deepEqual(loaded, []);
  });
});

describe('downloadModel through electron-http-get', () => {
  // Stand-in content of the Base model's exact size: only its own digest is
  // reported as the catalog SHA-256 (see test/whisper-models.test.js).
  const FIXTURE = crypto.randomBytes(BASE.bytes);
  const FIXTURE_SHA = crypto.createHash('sha256').update(FIXTURE).digest('hex');
  const realCreateHash = crypto.createHash;
  crypto.createHash = function createHash(algorithm, ...rest) {
    const hash = realCreateHash.call(crypto, algorithm, ...rest);
    if (String(algorithm).toLowerCase() !== 'sha256') return hash;
    const digest = hash.digest.bind(hash);
    hash.digest = (encoding) => {
      const out = digest(encoding);
      return encoding === 'hex' && out === FIXTURE_SHA ? BASE.sha256 : out;
    };
    return hash;
  };

  it('follows a redirect to the CDN itself and resumes with a 206', async (t) => {
    const dir = tempDir(t);
    const final = path.join(dir, BASE.file);
    const start = 1234567;
    fs.writeFileSync(`${final}.part`, FIXTURE.subarray(0, start));
    const net = createFakeNet((r) => {
      if (r.options.url === `${URL_BASE}${BASE.file}`) {
        r.redirect(302, `${CDN}/${BASE.file}?sig=1`);
        return;
      }
      if (r.options.url.startsWith(CDN)) {
        r.respond(206, {
          'Content-Range': [`bytes ${start}-${BASE.bytes - 1}/${BASE.bytes}`],
          'Content-Length': [String(BASE.bytes - start)],
        }, FIXTURE.subarray(start), { chunkSize: 4 * 1024 * 1024 });
        return;
      }
      throw new Error(`unexpected request to ${r.options.url}`);
    });
    const progress = [];
    const result = await models.downloadModel('base-q5_1', {
      modelDir: dir,
      httpGet: createElectronHttpGet({ net, session: SESSION }),
      onProgress: (received, total) => progress.push([received, total]),
    });
    assert.equal(result, final);
    assert.deepEqual(net.requests.map((r) => r.options.url), [`${URL_BASE}${BASE.file}`, `${CDN}/${BASE.file}?sig=1`]);
    assert.equal(net.requests[0].aborted, true, 'the redirect was not followed by net');
    assert.equal(net.requests[0].followed, false);
    for (const r of net.requests) {
      assert.equal(r.options.redirect, 'manual');
      assert.equal(r.options.session, SESSION);
      assert.equal(r.headers.Range, `bytes=${start}-`);
    }
    assert.equal(fs.existsSync(`${final}.part`), false);
    assert.equal(Buffer.compare(fs.readFileSync(final), FIXTURE), 0);
    assert.deepEqual(progress[progress.length - 1], [BASE.bytes, BASE.bytes]);
  });

  it('rejects a redirect to a host outside the allowlist without requesting it', async (t) => {
    const dir = tempDir(t);
    const final = path.join(dir, BASE.file);
    fs.writeFileSync(`${final}.part`, FIXTURE.subarray(0, 1000));
    const net = createFakeNet((r) => r.redirect(302, 'https://evil.example/ggml-base-q5_1.bin'));
    await assert.rejects(models.downloadModel('base-q5_1', {
      modelDir: dir,
      httpGet: createElectronHttpGet({ net, session: SESSION }),
    }), { code: 'BAD_HOST' });
    assert.deepEqual(net.requests.map((r) => r.options.url), [`${URL_BASE}${BASE.file}`]);
    assert.equal(net.requests[0].aborted, true);
    // A valid part file is kept for the next try.
    assert.equal(fs.statSync(`${final}.part`).size, 1000);
  });

  it('an offline net error is reported as OFFLINE', async (t) => {
    const dir = tempDir(t);
    const net = createFakeNet((r) => r.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED')));
    await assert.rejects(models.downloadModel('base-q5_1', {
      modelDir: dir,
      httpGet: createElectronHttpGet({ net, session: SESSION }),
    }), { code: 'OFFLINE' });
  });

  it('cancel keeps the part file and stops the net request', async (t) => {
    const dir = tempDir(t);
    const final = path.join(dir, BASE.file);
    const net = createFakeNet((r) => {
      if (r.options.url.startsWith(URL_BASE)) r.redirect(302, `${CDN}/f`);
      else r.respond(200, { 'Content-Length': String(BASE.bytes) }, FIXTURE, { stallAfter: 2 * 1024 * 1024 });
    });
    const controller = new AbortController();
    const done = models.downloadModel('base-q5_1', {
      modelDir: dir,
      signal: controller.signal,
      httpGet: createElectronHttpGet({ net, session: SESSION }),
      onProgress: (received) => { if (received >= 2 * 1024 * 1024) controller.abort(); },
    });
    await assert.rejects(done, { code: 'ABORTED' });
    assert.equal(fs.statSync(`${final}.part`).size, 2 * 1024 * 1024);
    assert.equal(net.requests[1].aborted, true);
  });

  it('too many redirects give up after five, with every net request aborted', async (t) => {
    const dir = tempDir(t);
    const net = createFakeNet((r) => r.redirect(302, 'https://huggingface.co/elsewhere'));
    const seen = [];
    const httpGet = createElectronHttpGet({ net, session: SESSION });
    const wrapped = (url, options, cb) => { seen.push(url); return httpGet(url, options, cb); };
    // Every hop redirects again: request() gives up after five.
    await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet: wrapped }), { code: 'HTTP' });
    assert.equal(seen.length, 6);
    assert.ok(net.requests.every((r) => r.aborted));
  });
});
