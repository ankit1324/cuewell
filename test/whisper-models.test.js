'use strict';
// src/core/whisper-models.js: the model catalog and the resumable, checked
// download. The network is a fake https.get (test/helpers/fake-https.js)
// passed through the httpGet seam; files go to temp folders.
//
// The catalog's SHA-256 values are for the real models, which these tests
// cannot download. A random fixture of the Base model's exact size stands in
// for it: sha256 hashes still run on the real bytes, and only a digest that
// equals the fixture's own is reported as the catalog value. Any other
// content (a bad resume, a damaged byte) still fails the check.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('./helpers/env');
const { createFakeHttpGet } = require('./helpers/fake-https');

const models = require('../src/core/whisper-models');

const BASE = models.MODELS.find((m) => m.id === 'base-q5_1');
const FIXTURE = crypto.randomBytes(BASE.bytes);
const FIXTURE_SHA = crypto.createHash('sha256').update(FIXTURE).digest('hex');
const URL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const CDN = 'https://cdn-lfs.hf.co/repos/ab/cd/blob';

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

/** huggingface.co redirects to the CDN, which serves `serve(headers, n)`. */
function hfServer(serve) {
  return createFakeHttpGet((url, headers, n) => {
    if (url.startsWith(URL_BASE)) {
      return { status: 302, headers: { location: `${CDN}?file=${encodeURIComponent(url.slice(URL_BASE.length))}` } };
    }
    if (url.startsWith(CDN)) return serve(headers, n);
    throw new Error(`unexpected request to ${url}`);
  });
}

function full(body = FIXTURE) {
  return { status: 200, headers: { 'content-length': String(body.length) }, body };
}

function partial(start, body = FIXTURE) {
  return {
    status: 206,
    headers: {
      'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
      'content-length': String(body.length - start),
    },
    body: body.subarray(start),
  };
}

function paths(dir) {
  const final = path.join(dir, BASE.file);
  return { final, part: `${final}.part` };
}

function cdnCalls(httpGet) {
  return httpGet.calls.filter((c) => c.url.startsWith(CDN));
}

async function waitFor(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function assertMonotonic(progress, total) {
  assert.ok(progress.length > 1, 'progress was reported');
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i][0] >= progress[i - 1][0], `progress went back at ${i}`);
  }
  for (const [received, t] of progress) {
    assert.equal(t, total);
    assert.ok(received >= 0 && received <= total);
  }
}

describe('whisper model catalog', () => {
  it('has Small (default) and Base with the pinned sizes and SHA-256', () => {
    assert.equal(models.DEFAULT_MODEL_ID, 'small-q5_1');
    assert.deepEqual(models.MODELS.map((m) => m.id), ['small-q5_1', 'base-q5_1']);
    const small = models.getModel('small-q5_1');
    assert.equal(small.file, 'ggml-small-q5_1.bin');
    assert.equal(small.bytes, 190085487);
    assert.equal(small.sha256, 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb');
    assert.match(small.label, /recommended/i);
    const base = models.getModel('base-q5_1');
    assert.equal(base.file, 'ggml-base-q5_1.bin');
    assert.equal(base.bytes, 59707625);
    assert.equal(base.sha256, '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898');
    assert.ok(Object.isFrozen(models.MODELS) && models.MODELS.every(Object.isFrozen), 'catalog is read-only');
  });

  it('downloads from huggingface.co over HTTPS', () => {
    assert.equal(models.modelUrl('small-q5_1'), `${URL_BASE}ggml-small-q5_1.bin`);
    assert.equal(models.DOWNLOAD_BASE_URL, URL_BASE);
  });

  it('only accepts catalog ids, so no path is built from other input', (t) => {
    const dir = tempDir(t);
    for (const id of ['../../etc/passwd', 'ggml-small-q5_1.bin', '__proto__', 'constructor', '', null, 42, {}]) {
      assert.equal(models.isModelId(id), false, `${String(id)} is not a model id`);
      assert.throws(() => models.modelPath(id, dir), { code: 'UNKNOWN_MODEL' });
    }
    assert.equal(models.modelPath('base-q5_1', dir), path.join(dir, 'ggml-base-q5_1.bin'));
    assert.throws(() => models.modelPath('base-q5_1', 'relative/dir'), { code: 'NO_MODEL_DIR' });
    assert.throws(() => models.modelPath('base-q5_1', ''), { code: 'NO_MODEL_DIR' });
  });

  it('isModelDownloaded checks the file size', (t) => {
    const dir = tempDir(t);
    const { final } = paths(dir);
    assert.equal(models.isModelDownloaded('base-q5_1', dir), false);
    fs.writeFileSync(final, 'short');
    assert.equal(models.isModelDownloaded('base-q5_1', dir), false);
    fs.truncateSync(final, BASE.bytes);
    assert.equal(models.isModelDownloaded('base-q5_1', dir), true);
    assert.equal(models.isModelDownloaded('nope', dir), false);
    assert.equal(models.isModelDownloaded('base-q5_1', 'relative'), false);
  });
});

describe('download host checks', () => {
  it('allows only HTTPS on huggingface.co, *.huggingface.co and *.hf.co', () => {
    const allowed = [
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
      'https://cdn-lfs.hf.co/repos/x',
      'https://cas-bridge.xethub.hf.co/xet-bridge-us/x',
      'https://cdn-lfs-us-1.huggingface.co/x',
      'https://HUGGINGFACE.CO/x',
      'https://cdn-lfs.hf.co:443/x',
    ];
    const rejected = [
      'http://huggingface.co/x',
      'http://cdn-lfs.hf.co/x',
      'https://evil.example/x',
      'https://huggingface.co.evil.example/x',
      'https://evilhuggingface.co/x',
      'https://evilhf.co/x',
      'https://hf.co.evil.example/x',
      'https://cdn-lfs.hf.co:8443/x',
      'https://user:pass@cdn-lfs.hf.co/x',
      'ftp://huggingface.co/x',
      'file:///etc/passwd',
      'not a url',
      '',
    ];
    for (const url of allowed) assert.equal(models.isAllowedDownloadUrl(url), true, url);
    for (const url of rejected) assert.equal(models.isAllowedDownloadUrl(url), false, url);
  });

  for (const location of [
    'https://evil.example/ggml-base-q5_1.bin',
    'http://cdn-lfs.hf.co/ggml-base-q5_1.bin',
    'https://huggingface.co.evil.example/x',
    'https://user:pass@cdn-lfs.hf.co/x',
  ]) {
    it(`stops at a redirect to ${location} without requesting it`, async (t) => {
      const dir = tempDir(t);
      const httpGet = createFakeHttpGet(() => ({ status: 302, headers: { location } }));
      await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), (error) => {
        assert.equal(error.code, 'BAD_HOST');
        assert.match(error.message, /unexpected server/);
        return true;
      });
      assert.deepEqual(httpGet.calls.map((c) => c.url), [`${URL_BASE}ggml-base-q5_1.bin`]);
      assert.equal(fs.existsSync(paths(dir).part), false);
    });
  }

  it('gives up after too many redirects', async (t) => {
    const dir = tempDir(t);
    const httpGet = createFakeHttpGet(() => ({ status: 302, headers: { location: 'https://huggingface.co/again' } }));
    await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), { code: 'HTTP' });
    assert.equal(httpGet.calls.length, 6, 'the first request and 5 redirects');
  });
});

describe('downloadModel', { concurrency: true }, () => {
  it('writes a .part file, verifies it and renames it into place', async (t) => {
    const dir = tempDir(t);
    const { final, part } = paths(dir);
    const httpGet = hfServer(() => full());
    const progress = [];
    let sawPart = false;
    let finalDuringDownload = false;
    const result = await models.downloadModel('base-q5_1', {
      modelDir: dir,
      httpGet,
      onProgress: (received, total) => {
        progress.push([received, total]);
        if (fs.existsSync(part)) sawPart = true;
        if (fs.existsSync(final)) finalDuringDownload = true;
      },
    });
    assert.equal(result, final);
    assert.equal(sawPart, true, 'data went to the .part file');
    assert.equal(finalDuringDownload, false, 'the final name appears only after the check');
    assert.equal(fs.existsSync(part), false);
    assert.equal(fs.statSync(final).size, BASE.bytes);
    assert.ok(realCreateHash('sha256').update(fs.readFileSync(final)).digest('hex') === FIXTURE_SHA);
    assertMonotonic(progress, BASE.bytes);
    assert.deepEqual(progress.at(-1), [BASE.bytes, BASE.bytes]);

    const [first] = httpGet.calls;
    assert.equal(first.url, `${URL_BASE}ggml-base-q5_1.bin`);
    assert.equal(first.headers.Range, undefined, 'a fresh download asks for the whole file');
    assert.equal(first.headers['User-Agent'], 'Cuewell');
    assert.equal(models.isModelDownloaded('base-q5_1', dir), true);
    assert.equal(await models.verifyModel('base-q5_1', dir), true);

    // Already there: no request, progress reports it complete.
    const again = [];
    const httpGet2 = hfServer(() => full());
    assert.equal(await models.downloadModel('base-q5_1', {
      modelDir: dir, httpGet: httpGet2, onProgress: (r, tot) => again.push([r, tot]),
    }), final);
    assert.equal(httpGet2.calls.length, 0);
    assert.deepEqual(again, [[BASE.bytes, BASE.bytes]]);

    // A damaged final file fails verifyModel; removeModel clears it and its part.
    const fd = fs.openSync(final, 'r+');
    fs.writeSync(fd, Buffer.from([FIXTURE[1000] ^ 0xff]), 0, 1, 1000);
    fs.closeSync(fd);
    assert.equal(await models.verifyModel('base-q5_1', dir), false);
    fs.writeFileSync(part, 'x');
    models.removeModel('base-q5_1', dir);
    assert.equal(fs.existsSync(final), false);
    assert.equal(fs.existsSync(part), false);
  });

  it('resumes a part file with a Range request and appends the 206 body', async (t) => {
    const dir = tempDir(t);
    const { final, part } = paths(dir);
    const have = 20 * 1024 * 1024 + 7;
    fs.writeFileSync(part, FIXTURE.subarray(0, have));
    const httpGet = hfServer((headers) => {
      assert.equal(headers.Range, `bytes=${have}-`);
      return partial(have);
    });
    const progress = [];
    await models.downloadModel('base-q5_1', {
      modelDir: dir, httpGet, onProgress: (r, tot) => progress.push([r, tot]),
    });
    assert.equal(cdnCalls(httpGet).length, 1);
    assert.equal(cdnCalls(httpGet)[0].sent, BASE.bytes - have, 'only the missing bytes were sent');
    assert.equal(fs.existsSync(part), false);
    assert.equal(realCreateHash('sha256').update(fs.readFileSync(final)).digest('hex'), FIXTURE_SHA);
    assert.deepEqual(progress[0], [have, BASE.bytes], 'progress starts at the resumed size');
    assertMonotonic(progress, BASE.bytes);
  });

  it('restarts from zero when the server answers 200 to a Range request', async (t) => {
    const dir = tempDir(t);
    const { final, part } = paths(dir);
    fs.writeFileSync(part, Buffer.alloc(1024 * 1024, 0x41)); // not the start of the file
    const httpGet = hfServer((headers) => {
      assert.equal(headers.Range, `bytes=${1024 * 1024}-`);
      return full();
    });
    const progress = [];
    await models.downloadModel('base-q5_1', {
      modelDir: dir, httpGet, onProgress: (r, tot) => progress.push([r, tot]),
    });
    assert.equal(fs.statSync(final).size, BASE.bytes);
    assert.equal(realCreateHash('sha256').update(fs.readFileSync(final)).digest('hex'), FIXTURE_SHA);
    assert.deepEqual(progress[0], [0, BASE.bytes]);
    assertMonotonic(progress, BASE.bytes);
  });

  it('starts over without Range when a 206 is for the wrong range, or the server answers 416', async (t) => {
    for (const reply of [
      (have) => ({ ...partial(0), headers: { 'content-range': `bytes 0-${BASE.bytes - 1}/${BASE.bytes}` }, body: FIXTURE.subarray(0, have) }),
      () => ({ status: 416, headers: {} }),
    ]) {
      const dir = tempDir(t);
      const { final, part } = paths(dir);
      const have = 4096;
      fs.writeFileSync(part, FIXTURE.subarray(0, have));
      // The second (restarted) request gets a 404 so the test ends cheaply.
      const httpGet = hfServer((headers, n) => (n <= 2 ? reply(have) : { status: 404, headers: {} }));
      await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), (error) => {
        assert.equal(error.code, 'HTTP');
        assert.match(error.message, /no longer available/);
        return true;
      });
      const cdn = cdnCalls(httpGet);
      assert.equal(cdn.length, 2);
      assert.equal(cdn[0].headers.Range, `bytes=${have}-`);
      assert.equal(cdn[1].headers.Range, undefined, 'the second try starts from zero');
      assert.equal(fs.existsSync(part), false, 'the unusable part file was removed');
      assert.equal(fs.existsSync(final), false);
    }
  });

  it('deletes the part file and fails when the SHA-256 is wrong', async (t) => {
    const dir = tempDir(t);
    const { final, part } = paths(dir);
    const damaged = Buffer.from(FIXTURE);
    damaged[12345] ^= 0x01;
    const httpGet = hfServer(() => full(damaged));
    await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), (error) => {
      assert.equal(error.code, 'CHECKSUM');
      assert.match(error.message, /damaged.*deleted.*Try again/);
      return true;
    });
    assert.equal(fs.existsSync(part), false);
    assert.equal(fs.existsSync(final), false);
  });

  it('checks the resumed bytes too: a part file with wrong content fails the SHA-256', async (t) => {
    const dir = tempDir(t);
    const { final, part } = paths(dir);
    const have = 1024 * 1024;
    fs.writeFileSync(part, Buffer.alloc(have, 0x41)); // right size, wrong bytes
    const httpGet = hfServer(() => partial(have));
    await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), { code: 'CHECKSUM' });
    assert.equal(fs.existsSync(part), false);
    assert.equal(fs.existsSync(final), false);
  });

  it('fails without writing when the server announces the wrong size', async (t) => {
    const dir = tempDir(t);
    const { final, part } = paths(dir);
    const httpGet = hfServer(() => ({ status: 200, headers: { 'content-length': '1234' }, body: FIXTURE.subarray(0, 1234) }));
    await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), { code: 'SIZE' });
    assert.equal(fs.existsSync(part), false);
    assert.equal(fs.existsSync(final), false);
    assert.equal(cdnCalls(httpGet)[0].destroyed, true, 'the unwanted body is not downloaded');
  });

  it('deletes the part file when the server sends more bytes than the model has', async (t) => {
    const dir = tempDir(t);
    const { final, part } = paths(dir);
    const have = BASE.bytes - 10;
    fs.writeFileSync(part, '');
    fs.truncateSync(part, have); // sparse: quick to create
    const httpGet = hfServer(() => ({
      status: 206,
      headers: { 'content-range': `bytes ${have}-${BASE.bytes - 1}/${BASE.bytes}` },
      body: Buffer.alloc(20, 0x42),
    }));
    await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), (error) => {
      assert.equal(error.code, 'SIZE');
      assert.match(error.message, /larger than expected/);
      return true;
    });
    assert.equal(fs.existsSync(part), false);
    assert.equal(fs.existsSync(final), false);
  });

  it('a dropped connection fails with a "try again to resume" error', async (t) => {
    const dir = tempDir(t);
    const httpGet = hfServer(() => ({ ...full(), endEarly: 1024 * 1024 }));
    await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), (error) => {
      assert.equal(error.code, 'NETWORK');
      assert.match(error.message, /resume/);
      return true;
    });
    assert.equal(fs.existsSync(paths(dir).final), false);
  });

  it('cancel keeps a resumable part file, and the next try resumes it', async (t) => {
    const dir = tempDir(t);
    const { final, part } = paths(dir);
    const stallAt = 8 * 1024 * 1024;
    const controller = new AbortController();
    const httpGet = hfServer(() => ({ ...full(), pauseAfter: stallAt }));
    const progress = [];
    const download = models.downloadModel('base-q5_1', {
      modelDir: dir,
      httpGet,
      signal: controller.signal,
      onProgress: (r, tot) => progress.push([r, tot]),
    });
    // Cancel once the stalled server's bytes are on disk.
    await waitFor(() => fs.existsSync(part) && fs.statSync(part).size === stallAt);
    controller.abort();
    await assert.rejects(download, (error) => {
      assert.equal(error.code, 'ABORTED');
      assert.equal(error.name, 'AbortError');
      return true;
    });
    assert.equal(fs.statSync(part).size, stallAt, 'the part file is kept');
    assert.equal(fs.existsSync(final), false);
    assert.equal(cdnCalls(httpGet)[0].destroyed, true, 'the request was stopped');
    assertMonotonic(progress, BASE.bytes);

    const resumed = hfServer((headers) => {
      assert.equal(headers.Range, `bytes=${stallAt}-`);
      return partial(stallAt);
    });
    await models.downloadModel('base-q5_1', { modelDir: dir, httpGet: resumed });
    assert.equal(realCreateHash('sha256').update(fs.readFileSync(final)).digest('hex'), FIXTURE_SHA);
    assert.equal(fs.existsSync(part), false);
  });

  it('an already cancelled signal makes no request', async (t) => {
    const dir = tempDir(t);
    const httpGet = hfServer(() => full());
    await assert.rejects(
      models.downloadModel('base-q5_1', { modelDir: dir, httpGet, signal: AbortSignal.abort() }),
      { code: 'ABORTED' },
    );
    assert.equal(httpGet.calls.length, 0);
  });

  it('maps network and server errors to short messages', async (t) => {
    const cases = [
      [{ error: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }, 'OFFLINE', /offline/],
      [{ error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }, 'NETWORK', /dropped/],
      [{ status: 503, headers: {} }, 'HTTP', /busy \(error 503\)/],
      [{ status: 429, headers: {} }, 'HTTP', /busy/],
      [{ status: 403, headers: {} }, 'HTTP', /refused the request \(error 403\)/],
      [{ status: 404, headers: {} }, 'HTTP', /no longer available/],
    ];
    for (const [reply, code, message] of cases) {
      const dir = tempDir(t);
      const httpGet = createFakeHttpGet(() => reply);
      await assert.rejects(models.downloadModel('base-q5_1', { modelDir: dir, httpGet }), (error) => {
        assert.equal(error.code, code, `${code} for ${JSON.stringify(reply.status || reply.error.code)}`);
        assert.match(error.message, message);
        return true;
      });
      assert.equal(fs.existsSync(paths(dir).final), false);
    }
  });

  it('rejects unknown ids and relative folders before any request', async (t) => {
    const dir = tempDir(t);
    const httpGet = hfServer(() => full());
    await assert.rejects(models.downloadModel('../../evil', { modelDir: dir, httpGet }), { code: 'UNKNOWN_MODEL' });
    await assert.rejects(models.downloadModel('base-q5_1', { modelDir: 'models', httpGet }), { code: 'NO_MODEL_DIR' });
    await assert.rejects(models.downloadModel('base-q5_1', { httpGet }), { code: 'NO_MODEL_DIR' });
    assert.equal(httpGet.calls.length, 0);
  });

  it('a progress handler that throws does not stop the download', async (t) => {
    const dir = tempDir(t);
    const httpGet = hfServer(() => full());
    await models.downloadModel('base-q5_1', {
      modelDir: dir, httpGet, onProgress: () => { throw new Error('renderer gone'); },
    });
    assert.equal(models.isModelDownloaded('base-q5_1', dir), true);
  });
});
