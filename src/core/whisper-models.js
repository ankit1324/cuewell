// whisper.cpp (ggml) speech models: the catalog, where each is stored, and a
// resumable, checksum-verified download from Hugging Face.
//
// Main process only. Ids come from the renderer; every function checks the
// id against MODELS, so a file name is never built from renderer input.
//
// Download: writes <file>.part next to the final file, resumes with a Range
// request when a part file exists and the server answers 206 (restarts from
// zero otherwise), checks the size and SHA-256, then renames the part file
// into place. A bad checksum deletes the part file. Cancelling keeps it so
// the next try resumes.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const MODELS = Object.freeze([
  Object.freeze({
    id: 'small-q5_1',
    file: 'ggml-small-q5_1.bin',
    bytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    label: 'Small (recommended, best for Hindi and Hinglish)',
  }),
  Object.freeze({
    id: 'base-q5_1',
    file: 'ggml-base-q5_1.bin',
    bytes: 59707625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    label: 'Base (faster, smaller)',
  }),
]);

const DEFAULT_MODEL_ID = 'small-q5_1';
const DOWNLOAD_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MAX_REDIRECTS = 5;
// No bytes for this long: treat the connection as dead.
const IDLE_TIMEOUT_MS = 30000;
// Room left on the disk after the download, so it never fills the disk.
const DISK_HEADROOM_BYTES = 50 * 1024 * 1024;

/** The catalog entry for `id`, or null when it is not one of MODELS. */
function getModel(id) {
  if (typeof id !== 'string') return null;
  return MODELS.find((model) => model.id === id) || null;
}

function isModelId(id) {
  return getModel(id) !== null;
}

function requireModel(id) {
  const model = getModel(id);
  if (!model) {
    throw downloadError('UNKNOWN_MODEL', 'Unknown voice model.');
  }
  return model;
}

function requireModelDir(modelDir) {
  if (typeof modelDir !== 'string' || !modelDir || !path.isAbsolute(modelDir)) {
    throw downloadError('NO_MODEL_DIR', 'Cuewell could not find its model folder.');
  }
  return modelDir;
}

/** Absolute path of model `id` in `modelDir`. Throws for an unknown id. */
function modelPath(id, modelDir) {
  return path.join(requireModelDir(modelDir), requireModel(id).file);
}

function modelUrl(id) {
  return DOWNLOAD_BASE_URL + requireModel(id).file;
}

/**
 * Whether model `id` is in `modelDir` with the expected size. The checksum
 * was checked before the file got its final name, so the size is enough
 * here (hashing 190 MB on every status read would be slow).
 */
function isModelDownloaded(id, modelDir) {
  try {
    return fs.statSync(modelPath(id, modelDir)).size === requireModel(id).bytes;
  } catch (_) {
    return false;
  }
}

/**
 * Whether model `id` in `modelDir` matches its SHA-256 (reads the whole
 * file). For a model that failed to load.
 */
async function verifyModel(id, modelDir) {
  const model = requireModel(id);
  const file = modelPath(id, modelDir);
  if (fileSize(file) !== model.bytes) return false;
  const hash = await hashExisting(file, model.bytes);
  return hash.digest('hex') === model.sha256;
}

/** Delete model `id` from `modelDir` (and any part file). */
function removeModel(id, modelDir) {
  const file = modelPath(id, modelDir);
  removeFile(file);
  removeFile(`${file}.part`);
}

/** HTTPS on huggingface.co, *.huggingface.co or *.hf.co only. */
function isAllowedDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co');
}

function downloadError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function abortError() {
  const error = downloadError('ABORTED', 'Download cancelled.');
  error.name = 'AbortError';
  return error;
}

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH',
  'EHOSTUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH']);
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT']);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/** A download error with a short message a user can act on. */
function friendlyError(error) {
  if (!error) return downloadError('FAILED', 'The download failed. Try again.');
  if (error.name === 'AbortError' || error.code === 'ABORTED') return abortError();
  if (typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) && error.userFacing) return error;
  const code = error.code;
  if (OFFLINE_CODES.has(code)) {
    return downloadError('OFFLINE', 'You seem to be offline. Check your internet connection and try again.', error);
  }
  if (NETWORK_CODES.has(code)) {
    return downloadError('NETWORK', 'The connection to the download server dropped. Try again to resume.', error);
  }
  if (DISK_CODES.has(code)) {
    return downloadError('DISK_FULL', 'Not enough free disk space for this model.', error);
  }
  if (PERMISSION_CODES.has(code)) {
    return downloadError('NO_ACCESS', 'Cuewell cannot write to its model folder.', error);
  }
  return downloadError('FAILED', 'The download failed. Try again.', error);
}

function userError(code, message) {
  const error = downloadError(code, message);
  error.userFacing = true;
  return error;
}

/** SHA-256 of the first `length` bytes already in `file`, as a running hash. */
function hashExisting(file, length, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    if (length === 0) {
      resolve(hash);
      return;
    }
    const stream = fs.createReadStream(file, { start: 0, end: length - 1 });
    const onAbort = () => stream.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    stream.on('end', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(hash);
    });
  });
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (_) {
    // A part file that cannot be removed is overwritten on the next try.
  }
}

/** Throws DISK_FULL when `needed` bytes plus headroom do not fit in `dir`. */
function checkFreeSpace(dir, needed) {
  if (typeof fs.statfsSync !== 'function') return;
  let stats;
  try {
    stats = fs.statfsSync(dir);
  } catch (_) {
    return; // Unknown: let the write itself fail if it must.
  }
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (Number.isFinite(free) && free < needed + DISK_HEADROOM_BYTES) {
    const mb = Math.ceil((needed + DISK_HEADROOM_BYTES) / (1024 * 1024));
    throw userError('DISK_FULL', `Not enough free disk space. This model needs about ${mb} MB free.`);
  }
}

/**
 * GET `url` following up to MAX_REDIRECTS redirects, each checked with
 * isAllowedDownloadUrl. Resolves with the final response (status < 300 or
 * any error status); the caller reads or discards its body.
 */
function request(url, { headers, signal, httpGet }) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let settled = false;
    let currentRequest = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => {
      if (currentRequest) {
        try { currentRequest.destroy(); } catch (_) { /* already closed */ }
      }
      fail(abortError());
    };
    if (signal) {
      if (signal.aborted) {
        fail(abortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const go = (target) => {
      if (!isAllowedDownloadUrl(target)) {
        fail(userError('BAD_HOST', 'The download was redirected to an unexpected server, so Cuewell stopped it.'));
        return;
      }
      let req;
      try {
        req = httpGet(target, { headers }, (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers && res.headers.location) {
            res.resume();
            redirects += 1;
            if (redirects > MAX_REDIRECTS) {
              fail(userError('HTTP', 'The download server redirected too many times. Try again later.'));
              return;
            }
            let next;
            try {
              next = new URL(res.headers.location, target).toString();
            } catch (_) {
              fail(userError('BAD_HOST', 'The download server sent an invalid redirect.'));
              return;
            }
            go(next);
            return;
          }
          if (settled) {
            res.resume();
            return;
          }
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve({ res, req });
        });
      } catch (error) {
        fail(error);
        return;
      }
      currentRequest = req;
      if (req && typeof req.on === 'function') {
        req.on('error', (error) => fail(error));
        if (typeof req.setTimeout === 'function') {
          req.setTimeout(IDLE_TIMEOUT_MS, () => {
            const error = new Error('Download timed out');
            error.code = 'ETIMEDOUT';
            req.destroy(error);
          });
        }
      }
    };
    go(url);
  });
}

/** Write the response body to `file`, hashing as it goes. Resolves with the bytes written. */
function writeBody(res, req, file, { flags, hash, startAt, total, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    let received = startAt;
    let settled = false;
    // A write can still fail after end() (ENOSPC on the last buffered
    // chunks), so success waits for 'close' and checks this.
    let writeError = null;
    const out = fs.createWriteStream(file, { flags });
    // Settle only once the file is closed, so the caller can delete or
    // rename it (Windows cannot rename an open file).
    const afterClose = (fn) => {
      if (out.closed) fn();
      else out.once('close', fn);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) {
        destroyResponse(res, req);
        out.destroy();
        afterClose(() => reject(error));
        return;
      }
      out.end();
      afterClose(() => (writeError ? reject(writeError) : resolve(received)));
    };
    const onAbort = () => finish(abortError());
    if (signal) {
      if (signal.aborted) {
        finish(abortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    out.on('error', (error) => {
      writeError = writeError || error;
      finish(error);
    });
    res.on('error', (error) => finish(error));
    res.on('aborted', () => {
      const error = new Error('Connection closed during the download');
      error.code = 'ECONNRESET';
      finish(error);
    });
    res.on('data', (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > total) {
        finish(userError('SIZE', 'The downloaded file is larger than expected, so Cuewell deleted it. Try again.'));
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        res.pause();
        out.once('drain', () => res.resume());
      }
      if (typeof onProgress === 'function') {
        try { onProgress(received, total); } catch (_) { /* a progress handler never stops the download */ }
      }
    });
    res.on('end', () => {
      if (received < total && !settled) {
        const error = new Error('Connection closed before the download finished');
        error.code = 'ECONNRESET';
        finish(error);
        return;
      }
      finish(null);
    });
  });
}

/** Stop a response whose body is not wanted (resume() would download all of it). */
function destroyResponse(res, req) {
  try { res.destroy(); } catch (_) { /* already closed */ }
  if (req && typeof req.destroy === 'function') {
    try { req.destroy(); } catch (_) { /* already closed */ }
  }
}

/** Parse "bytes <start>-<end>/<total>" from a 206 response. */
function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) };
}

/**
 * Download model `id` into `modelDir` and return its path. Resolves at once
 * when it is already there. Errors carry a `code` (OFFLINE, NETWORK, HTTP,
 * CHECKSUM, SIZE, DISK_FULL, NO_ACCESS, BAD_HOST, ABORTED, UNKNOWN_MODEL,
 * NO_MODEL_DIR, FAILED) and a message that can be shown as is.
 *
 * @param {string} id one of MODELS
 * @param {object} options
 * @param {string} options.modelDir absolute folder
 * @param {(received: number, total: number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.httpGet] https.get-compatible, for tests
 */
async function downloadModel(id, { modelDir, onProgress, signal, httpGet = https.get } = {}) {
  const model = requireModel(id);
  const dir = requireModelDir(modelDir);
  const finalPath = path.join(dir, model.file);
  const partPath = `${finalPath}.part`;

  if (isModelDownloaded(id, dir)) {
    if (typeof onProgress === 'function') {
      try { onProgress(model.bytes, model.bytes); } catch (_) { /* ignore */ }
    }
    return finalPath;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw friendlyError(error);
  }

  // A part file at least as big as the model cannot be resumed.
  let startAt = fileSize(partPath);
  if (startAt > model.bytes) {
    removeFile(partPath);
    startAt = 0;
  }

  // At most two passes: a resume the server refuses restarts from zero once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal && signal.aborted) throw abortError();
    try {
      checkFreeSpace(dir, model.bytes - startAt);
    } catch (error) {
      throw friendlyError(error);
    }

    let hash;
    try {
      hash = await hashExisting(partPath, startAt, signal);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      removeFile(partPath);
      startAt = 0;
      hash = crypto.createHash('sha256');
    }

    let received = startAt;
    if (startAt < model.bytes) {
      const headers = { 'User-Agent': 'Cuewell', Accept: 'application/octet-stream' };
      if (startAt > 0) headers.Range = `bytes=${startAt}-`;

      let response;
      try {
        response = await request(modelUrl(id), { headers, signal, httpGet });
      } catch (error) {
        throw friendlyError(error);
      }
      const { res, req } = response;
      const status = res.statusCode || 0;

      let flags = 'w';
      if (status === 206 && startAt > 0) {
        const range = parseContentRange(res.headers && res.headers['content-range']);
        if (!range || range.start !== startAt || (range.total !== null && range.total !== model.bytes)) {
          // A range we did not ask for: start over cleanly.
          destroyResponse(res, req);
          removeFile(partPath);
          startAt = 0;
          continue;
        }
        flags = 'a';
      } else if (status === 416 && startAt > 0) {
        destroyResponse(res, req);
        removeFile(partPath);
        startAt = 0;
        continue;
      } else if (status === 200) {
        // The server ignored the Range header: the body starts at byte 0.
        if (startAt > 0) {
          startAt = 0;
          hash = crypto.createHash('sha256');
        }
        const length = Number(res.headers && res.headers['content-length']);
        if (Number.isFinite(length) && length > 0 && length !== model.bytes) {
          destroyResponse(res, req);
          throw userError('SIZE', 'The download server sent a file of the wrong size. Try again later.');
        }
      } else {
        destroyResponse(res, req);
        if (status === 404 || status === 410) {
          throw userError('HTTP', 'This model is no longer available for download.');
        }
        if (status === 429 || status >= 500) {
          throw userError('HTTP', `The download server is busy (error ${status}). Try again in a few minutes.`);
        }
        throw userError('HTTP', `The download server refused the request (error ${status}).`);
      }

      if (typeof onProgress === 'function') {
        try { onProgress(startAt, model.bytes); } catch (_) { /* ignore */ }
      }
      try {
        received = await writeBody(res, req, partPath, {
          flags, hash, startAt, total: model.bytes, onProgress, signal,
        });
      } catch (error) {
        if (error && error.code === 'SIZE') removeFile(partPath);
        throw friendlyError(error);
      }
    }

    if (received !== model.bytes || fileSize(partPath) !== model.bytes) {
      removeFile(partPath);
      throw userError('SIZE', 'The downloaded file has the wrong size, so Cuewell deleted it. Try again.');
    }
    if (hash.digest('hex') !== model.sha256) {
      removeFile(partPath);
      throw userError('CHECKSUM', 'The downloaded file was damaged, so Cuewell deleted it. Try again.');
    }
    try {
      fs.renameSync(partPath, finalPath);
    } catch (error) {
      throw friendlyError(error);
    }
    return finalPath;
  }

  throw userError('HTTP', 'The download server did not resume the download. Try again.');
}

module.exports = {
  MODELS,
  DEFAULT_MODEL_ID,
  DOWNLOAD_BASE_URL,
  getModel,
  isModelId,
  modelPath,
  modelUrl,
  isModelDownloaded,
  verifyModel,
  removeModel,
  isAllowedDownloadUrl,
  downloadModel,
};
