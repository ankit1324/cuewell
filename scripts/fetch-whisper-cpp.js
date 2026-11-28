#!/usr/bin/env node
/**
 * `npm run fetch:whisper`: put a whisper.cpp `whisper-server` for one or more
 * targets into vendor/whisper/<platform>-<arch>/. electron-builder copies that
 * folder to the app's resources as `whisper/` (see build.extraResources).
 *
 *   node scripts/fetch-whisper-cpp.js                      this machine
 *   node scripts/fetch-whisper-cpp.js --platform darwin --arch arm64,x64
 *   node scripts/fetch-whisper-cpp.js --platform win32 --all-arches
 *
 * Every target uses whisper.cpp build tag b5907:
 * - win32-x64 and linux-x64: the official release asset, checked against a
 *   pinned SHA-256. Only whisper-server, the libraries it loads and LICENSE
 *   are kept.
 * - darwin-arm64 and darwin-x64: built here from the pinned source tarball
 *   with cmake. Static libraries, so the binary needs only system frameworks.
 *   arm64 embeds the Metal shaders; x64 runs on the CPU (Accelerate).
 *
 * The Windows asset links the Visual C++ runtime (msvcp140, vcruntime140,
 * vcomp140), which a clean Windows install does not have. On Windows with
 * Visual Studio installed, those DLLs are copied next to whisper-server.exe
 * (Microsoft allows app-local deployment of the redistributable files). The
 * Linux asset needs libgomp.so.1; on Linux it is copied from the system.
 * --require-runtime makes a missing runtime an error (the release workflow
 * uses it); otherwise it is a warning.
 *
 * Running it again is cheap: a target whose VERSION file matches the pinned
 * tag and whose files match the recorded hashes is skipped. Those hashes are
 * written by this script, so they only show the folder was not changed since;
 * --force ignores VERSION (and, for macOS, any earlier build folder) and
 * makes every target again from the pinned downloads. Release builds use it.
 * Downloads are cached in vendor/whisper/.cache, mac builds in
 * vendor/whisper/.build; both stay out of the app.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const TAG = 'b5907';
const COMMIT = '5eaee0cc9024eb9e9a99469199920c8b7f5cb9ec';

const SOURCE = {
  url: `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${TAG}.tar.gz`,
  file: `whisper.cpp-${TAG}.tar.gz`,
  sha256: '6896da37782405144d9c26160d51bac9eca265dfe6b15c744b25342aa46fd56b',
  root: `whisper.cpp-${TAG}`,
};

const ASSETS = {
  'win32-x64': {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-bin-x64.zip`,
    file: `whisper-bin-x64-${TAG}.zip`,
    sha256: 'ecca07b277d943e9b9f4712856a144b857271a6b333104e511e1988e80db582b',
    kind: 'zip',
    root: 'Release/',
  },
  'linux-x64': {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-bin-ubuntu-x64.tar.gz`,
    file: `whisper-bin-ubuntu-x64-${TAG}.tar.gz`,
    sha256: 'a6199027fe5b4239c84171d2bca4c0ff44ec86a515494d5a39b237b212d429bd',
    kind: 'tgz',
    root: 'whisper-bin-ubuntu-x64/',
  },
};

const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];
const ARCHES_BY_PLATFORM = { darwin: ['arm64', 'x64'], win32: ['x64'], linux: ['x64'] };
const PLATFORM_ALIASES = { mac: 'darwin', macos: 'darwin', osx: 'darwin', win: 'win32', windows: 'win32' };

// The asset hosts GitHub serves releases and source archives from. Every
// redirect is checked; the pinned hash is the real guarantee.
const ALLOWED_HOSTS = ['github.com', 'codeload.github.com'];
const ALLOWED_HOST_SUFFIXES = ['.githubusercontent.com'];

// Matches README: macOS 13 (Ventura) or later.
const MACOS_DEPLOYMENT_TARGET = '13.0';

const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'];

const ROOT_DIR = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ROOT_DIR, 'vendor', 'whisper');
const CACHE_DIR = path.join(VENDOR_DIR, '.cache');
const BUILD_DIR = path.join(VENDOR_DIR, '.build');

class FetchError extends Error {}

function log(message) {
  console.log(`[whisper.cpp] ${message}`);
}

function warn(message) {
  console.warn(`[whisper.cpp] Warning: ${message}`);
}

function usage() {
  return [
    'Usage: node scripts/fetch-whisper-cpp.js [options]',
    '',
    'Puts whisper.cpp whisper-server (tag ' + TAG + ') into vendor/whisper/<platform>-<arch>/.',
    '',
    'Options:',
    '  --platform <p>       darwin, win32 or linux (default: this machine)',
    '  --arch <a>           x64 or arm64, or a comma list (default: this machine;',
    '                       for another OS with one supported arch, that arch)',
    '  --all-arches         every supported arch for the platform (darwin: arm64,x64)',
    '  --force              fetch or build again even if the folder is up to date',
    '                       (macOS: a clean build from the pinned source)',
    '  --require-runtime    fail if the compiler runtime (Windows VC++, Linux libgomp) cannot be bundled',
    '  --help               show this help',
    '',
    'Targets: ' + TARGETS.join(', '),
  ].join('\n');
}

function parseArgs(argv) {
  const options = { platform: process.platform, arches: null, allArches: false, force: false, requireRuntime: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new FetchError(`${arg} needs a value.\n\n${usage()}`);
      i += 1;
      return value;
    };
    if (arg === '--platform') options.platform = takeValue();
    else if (arg.startsWith('--platform=')) options.platform = arg.slice('--platform='.length);
    else if (arg === '--arch') options.arches = takeValue();
    else if (arg.startsWith('--arch=')) options.arches = arg.slice('--arch='.length);
    else if (arg === '--all-arches') options.allArches = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--require-runtime') options.requireRuntime = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new FetchError(`Unknown option: ${arg}\n\n${usage()}`);
  }

  const platform = PLATFORM_ALIASES[String(options.platform).toLowerCase()] || String(options.platform).toLowerCase();
  if (!ARCHES_BY_PLATFORM[platform]) {
    throw new FetchError(`Unsupported platform "${options.platform}". Use darwin, win32 or linux.`);
  }
  let arches;
  if (options.allArches) {
    arches = ARCHES_BY_PLATFORM[platform];
  } else if (options.arches) {
    arches = String(options.arches).split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  } else if (platform !== process.platform && ARCHES_BY_PLATFORM[platform].length === 1) {
    // Fetching for another OS: use its only supported arch (win32 and linux: x64).
    arches = ARCHES_BY_PLATFORM[platform];
  } else {
    arches = [process.arch];
  }
  const targets = [];
  for (const arch of arches) {
    const target = `${platform}-${arch}`;
    if (!TARGETS.includes(target)) {
      throw new FetchError(`whisper.cpp is not available for ${target}. Supported targets: ${TARGETS.join(', ')}.`);
    }
    if (!targets.includes(target)) targets.push(target);
  }
  return { ...options, platform, targets };
}

// ---------------------------------------------------------------------------
// Files and hashes

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function binaryName(target) {
  return target.startsWith('win32-') ? 'whisper-server.exe' : 'whisper-server';
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8'));
  } catch {
    return null;
  }
}

// A target is up to date when VERSION names the pinned tag and every listed
// file is present with the recorded hash.
function isUpToDate(target, { requireRuntime }) {
  const dir = path.join(VENDOR_DIR, target);
  const manifest = readManifest(dir);
  if (!manifest || manifest.tag !== TAG || manifest.commit !== COMMIT || manifest.target !== target) return false;
  if (!manifest.files || !manifest.files[binaryName(target)]) return false;
  if (requireRuntime && manifest.runtime === 'missing') return false;
  for (const [name, info] of Object.entries(manifest.files)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).size !== info.bytes) return false;
    } catch {
      return false;
    }
    if (sha256File(file) !== info.sha256) return false;
  }
  // A folder restored from a CI cache is also checked like a fresh build.
  if (target.startsWith('darwin-') && process.platform === 'darwin') {
    try {
      checkMacBinary(path.join(dir, binaryName(target)), target.split('-')[1]);
    } catch (error) {
      warn(`${target}: ${error.message} Building it again.`);
      return false;
    }
  }
  return true;
}

function writeFile(dir, name, data, executable) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data, { mode: executable ? 0o755 : 0o644 });
  return file;
}

function copyFile(from, dir, name, executable) {
  const file = path.join(dir, name);
  fs.copyFileSync(from, file);
  fs.chmodSync(file, executable ? 0o755 : 0o644);
  return file;
}

// Build the target in a staging folder, then swap it in, so an interrupted
// run never leaves a half-filled vendor/whisper/<target>.
function stageTarget(target, fill) {
  const finalDir = path.join(VENDOR_DIR, target);
  const stagingDir = path.join(VENDOR_DIR, `.staging-${target}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  return Promise.resolve()
    .then(() => fill(stagingDir))
    .then((details) => {
      const files = {};
      for (const name of fs.readdirSync(stagingDir).sort()) {
        const file = path.join(stagingDir, name);
        if (!fs.statSync(file).isFile()) continue;
        files[name] = { bytes: fs.statSync(file).size, sha256: sha256File(file) };
      }
      const manifest = {
        tag: TAG,
        commit: COMMIT,
        target,
        source: details.source,
        sourceSha256: details.sourceSha256,
        runtime: details.runtime,
        files,
      };
      fs.writeFileSync(path.join(stagingDir, 'VERSION'), `${JSON.stringify(manifest, null, 2)}\n`);
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(stagingDir, finalDir);
      return { dir: finalDir, manifest };
    })
    .catch((error) => {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    });
}

// ---------------------------------------------------------------------------
// Download

function isAllowedUrl(url) {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.includes(host) || ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// Resolves once the file is complete and closed. Rejects with FetchError for
// failures a retry cannot fix (refused host, 404) and a plain Error for ones
// it may (network errors, HTTP 5xx or 429, a cut-off body). It always waits
// for the file to close first, so the caller can delete or reuse the path.
function downloadOnce(urlString, destination) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let out = null;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (!out || out.closed) {
        if (error) reject(error);
        else resolve();
        return;
      }
      out.once('close', () => (error ? reject(error) : resolve()));
      if (error) out.destroy();
    };
    const get = (current) => {
      let url;
      try {
        url = new URL(current);
      } catch {
        settle(new FetchError(`Bad download address: ${current}`));
        return;
      }
      if (!isAllowedUrl(url)) {
        settle(new FetchError(`Refusing to download from ${url.protocol}//${url.host}: only HTTPS from GitHub is allowed.`));
        return;
      }
      const request = https.get(url, { headers: { 'User-Agent': 'cuewell-fetch-whisper-cpp' }, timeout: 60000 }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          redirects += 1;
          if (redirects > 5) {
            settle(new FetchError(`Too many redirects for ${urlString}`));
            return;
          }
          get(new URL(response.headers.location, url).toString());
          return;
        }
        if (status !== 200) {
          response.resume();
          const message = `HTTP ${status} for ${urlString}`;
          settle(status >= 500 || status === 429 ? new Error(message) : new FetchError(`Download failed: ${message}`));
          return;
        }
        const total = Number(response.headers['content-length']) || 0;
        out = fs.createWriteStream(destination, { mode: 0o644 });
        let received = 0;
        let lastShown = -1;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (!total) return;
          const percent = Math.floor((received / total) * 100);
          const step = process.stdout.isTTY ? 1 : 25;
          if (percent >= lastShown + step) {
            lastShown = percent;
            const line = `  ${percent}% of ${formatBytes(total)}`;
            if (process.stdout.isTTY) process.stdout.write(`\r${line}`);
            else console.log(line);
          }
        });
        response.on('aborted', () => settle(new Error('the connection was closed early')));
        response.on('error', settle);
        out.on('error', settle);
        out.on('finish', () => {
          if (process.stdout.isTTY && total) process.stdout.write('\n');
          settle(total && received !== total ? new Error(`the download ended early (${received} of ${total} bytes)`) : null);
        });
        response.pipe(out);
      });
      request.on('timeout', () => request.destroy(new Error('the server stopped responding')));
      request.on('error', settle);
    };
    get(urlString);
  });
}

// Returns the cached file, downloading it first if it is missing or does not
// match the pinned hash. A wrong hash is never accepted.
async function fetchPinned({ url, file, sha256 }) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, file);
  if (fs.existsSync(cached)) {
    if (sha256File(cached) === sha256) {
      log(`Using cached ${file}`);
      return cached;
    }
    warn(`cached ${file} does not match the pinned SHA-256; downloading it again.`);
    fs.rmSync(cached, { force: true });
  }

  const part = `${cached}.part`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    fs.rmSync(part, { force: true });
    log(`Downloading ${url}${attempt > 1 ? ` (attempt ${attempt} of 3)` : ''}`);
    try {
      await downloadOnce(url, part);
      const actual = sha256File(part);
      if (actual !== sha256) {
        fs.rmSync(part, { force: true });
        throw new FetchError(`SHA-256 mismatch for ${file}: expected ${sha256}, got ${actual}. The file was deleted.`);
      }
      fs.renameSync(part, cached);
      return cached;
    } catch (error) {
      fs.rmSync(part, { force: true });
      if (error instanceof FetchError) throw error;
      lastError = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new FetchError(
    `Could not download ${url}: ${lastError && lastError.message}. Check your internet connection and run "npm run fetch:whisper" again.`
  );
}

// ---------------------------------------------------------------------------
// Archives. Only named entries are read and they are written under names this
// script chooses, so archive paths never decide where a file goes.

function readZip(buffer) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FetchError('The zip file is damaged (no end of central directory).');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new FetchError('The zip file is damaged (bad central directory).');
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    entries.set(name, () => {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new FetchError(`The zip entry ${name} is damaged.`);
      const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const raw = buffer.subarray(start, start + compressedSize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new FetchError(`The zip entry ${name} uses an unsupported compression method (${method}).`);
      if (data.length !== size || zlib.crc32(data) !== crc) throw new FetchError(`The zip entry ${name} failed its checksum.`);
      return data;
    });
  }
  return { names: [...entries.keys()], read: (name) => entries.get(name)() };
}

function readTarGz(buffer) {
  const tar = zlib.gunzipSync(buffer);
  const entries = new Map();
  const field = (block, start, length) => {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.toString('utf8', 0, end < 0 ? raw.length : end);
  };
  const octal = (block, start, length) => parseInt(field(block, start, length).trim() || '0', 8);
  let offset = 0;
  let longName = null;
  let longLink = null;
  let pax = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') { longName = field(data, 0, data.length); continue; }
    if (type === 'K') { longLink = field(data, 0, data.length); continue; }
    if (type === 'x') {
      pax = {};
      for (const line of data.toString('utf8').split('\n')) {
        const match = /^\d+ ([^=]+)=(.*)$/.exec(line);
        if (match) pax[match[1]] = match[2];
      }
      continue;
    }
    if (type === 'g') continue;

    const prefix = field(header, 345, 155);
    let name = longName || pax.path || (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const linkName = longLink || pax.linkpath || field(header, 157, 100);
    longName = null;
    longLink = null;
    pax = {};
    name = name.replace(/^\.\//, '');
    if (type === '0' || type === '\0' || type === '7') entries.set(name, { type: 'file', data });
    else if (type === '2') entries.set(name, { type: 'symlink', linkName });
  }

  const resolve = (name, depth = 0) => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.type === 'file') return entry.data;
    if (depth > 8 || entry.linkName.startsWith('/')) return null;
    return resolve(path.posix.normalize(path.posix.join(path.posix.dirname(name), entry.linkName)), depth + 1);
  };
  return { names: [...entries.keys()], read: (name) => resolve(name), entries };
}

// ---------------------------------------------------------------------------
// Runtime libraries the prebuilt binaries need but a clean system may lack.

function findVcRuntimeDir() {
  const candidates = [];
  if (process.env.VCToolsRedistDir) candidates.push(path.join(process.env.VCToolsRedistDir, 'x64'));

  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const installs = [];
  if (fs.existsSync(vswhere)) {
    const result = spawnSync(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' });
    if (result.status === 0) installs.push(...result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  }
  for (const install of installs) {
    const msvc = path.join(install, 'VC', 'Redist', 'MSVC');
    let versions = [];
    try {
      versions = fs.readdirSync(msvc).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    } catch {
      continue;
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) candidates.push(path.join(msvc, version, 'x64'));
  }

  for (const dir of candidates) {
    let subdirs;
    try {
      subdirs = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const crt = subdirs.find((d) => /^Microsoft\.VC\d+\.CRT$/i.test(d));
    const omp = subdirs.find((d) => /^Microsoft\.VC\d+\.OpenMP$/i.test(d));
    if (!crt || !omp) continue;
    const files = {};
    for (const dll of VC_RUNTIME_DLLS) {
      const from = path.join(dir, dll === 'vcomp140.dll' ? omp : crt, dll);
      if (fs.existsSync(from)) files[dll] = from;
    }
    if (Object.keys(files).length === VC_RUNTIME_DLLS.length) return files;
  }
  return null;
}

function findLibgomp() {
  const result = spawnSync('ldconfig', ['-p'], { encoding: 'utf8' });
  if (result.status === 0) {
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*libgomp\.so\.1 \(([^)]*)\) => (\S+)/.exec(line);
      if (match && /x86-64/.test(match[1]) && fs.existsSync(match[2])) return match[2];
    }
  }
  for (const dir of ['/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/lib/x86_64-linux-gnu', '/usr/lib']) {
    const file = path.join(dir, 'libgomp.so.1');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The newest GLIBC_x.y symbol version an ELF file asks for. A crude scan of
// the version strings, which is all that is needed to compare two files.
function compareGlibc(a, b) {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  return a[0] - b[0] || a[1] - b[1];
}

function glibcFloor(buffer) {
  let best = null;
  for (const match of buffer.toString('latin1').matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const version = [Number(match[1]), Number(match[2])];
    if (compareGlibc(version, best) > 0) best = version;
  }
  return best;
}

function formatGlibc(version) {
  return version ? `${version[0]}.${version[1]}` : 'none';
}

function bundleRuntime(target, dir, { requireRuntime }) {
  const host = `${process.platform}-${process.arch}`;
  if (target === 'win32-x64') {
    const files = process.platform === 'win32' ? findVcRuntimeDir() : null;
    if (files) {
      for (const [name, from] of Object.entries(files)) copyFile(from, dir, name, false);
      log(`Bundled the Visual C++ runtime (${Object.keys(files).join(', ')})`);
      return 'bundled';
    }
    const reason = process.platform === 'win32'
      ? 'the Visual C++ redistributable files were not found (install Visual Studio or Build Tools with the C++ workload)'
      : 'the Visual C++ runtime can only be bundled when this script runs on Windows';
    if (requireRuntime) throw new FetchError(`Cannot bundle the Visual C++ runtime: ${reason}.`);
    warn(`${reason}. whisper-server.exe will need the Visual C++ Redistributable on the user's PC.`);
    return 'missing';
  }
  if (target === 'linux-x64') {
    const from = host === 'linux-x64' ? findLibgomp() : null;
    let reason;
    if (from) {
      // A libgomp from a newer distribution than the whisper.cpp asset was
      // built on would raise the glibc the app needs (Ubuntu 24.04's needs
      // 2.38; the asset needs 2.34), and it would be loaded ahead of the
      // user's own libgomp. Bundle it only if it does not.
      const floor = fs.readdirSync(dir)
        .filter((name) => name === 'whisper-server' || name.endsWith('.so') || /\.so\.\d+$/.test(name))
        .map((name) => glibcFloor(fs.readFileSync(path.join(dir, name))))
        .reduce((a, b) => (compareGlibc(b, a) > 0 ? b : a), null);
      const needs = glibcFloor(fs.readFileSync(from));
      if (compareGlibc(needs, floor) <= 0) {
        copyFile(from, dir, 'libgomp.so.1', true);
        log(`Bundled libgomp.so.1 from ${from} (needs glibc ${formatGlibc(needs)}, whisper.cpp needs ${formatGlibc(floor)})`);
        return 'bundled';
      }
      reason = `${from} needs glibc ${formatGlibc(needs)}, newer than the ${formatGlibc(floor)} whisper.cpp needs ` +
        '(run this on Ubuntu 22.04 to bundle a compatible one)';
    } else {
      reason = host === 'linux-x64'
        ? 'libgomp.so.1 was not found (install libgomp1)'
        : 'libgomp.so.1 can only be bundled when this script runs on Linux x64';
    }
    if (requireRuntime) throw new FetchError(`Cannot bundle libgomp: ${reason}.`);
    warn(`${reason}. whisper-server will need libgomp1 installed on the user's system.`);
    return 'missing';
  }
  return 'not needed';
}

// ---------------------------------------------------------------------------
// Targets

function smokeTest(target, dir) {
  const host = `${process.platform}-${process.arch}`;
  const runnable = host === target || (target === 'darwin-x64' && host === 'darwin-arm64');
  if (!runnable) return;
  const env = { ...process.env };
  if (target.startsWith('linux-')) env.LD_LIBRARY_PATH = dir;
  const result = spawnSync(path.join(dir, binaryName(target)), ['--help'], { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status === 0 && /usage/i.test(output)) {
    log(`${binaryName(target)} --help works on this machine`);
    return;
  }
  const reason = result.error ? result.error.message : `exit code ${result.status}`;
  if (host === target) {
    throw new FetchError(`${binaryName(target)} --help failed (${reason}):\n${output.slice(0, 2000)}`);
  }
  // darwin-x64 on Apple silicon needs Rosetta; without it the run fails.
  warn(`could not run the x64 binary here (${reason}); Rosetta may not be installed.`);
}

async function fetchPrebuilt(target, options) {
  const asset = ASSETS[target];
  const archivePath = await fetchPinned(asset);
  const archive = asset.kind === 'zip' ? readZip(fs.readFileSync(archivePath)) : readTarGz(fs.readFileSync(archivePath));
  const inRoot = archive.names
    .filter((name) => name.startsWith(asset.root) && !name.slice(asset.root.length).includes('/'))
    .map((name) => name.slice(asset.root.length));

  let wanted;
  if (target === 'win32-x64') {
    const required = ['whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll'];
    const cpu = inRoot.filter((name) => /^ggml-cpu-[a-z0-9_]+\.dll$/i.test(name));
    wanted = [...required, ...cpu].map((name) => ({ from: name, to: name, executable: name.endsWith('.exe') }));
    for (const name of required) if (!inRoot.includes(name)) throw new FetchError(`${asset.file} has no ${name}.`);
    if (!cpu.length) throw new FetchError(`${asset.file} has no ggml-cpu backend.`);
  } else {
    // SONAME names only (what the loader asks for), written as real files so
    // no symlinks have to survive packaging.
    const required = ['whisper-server', 'libwhisper.so.1', 'libggml.so.1', 'libggml-base.so.1', 'LICENSE'];
    const cpu = inRoot.filter((name) => /^libggml-cpu-[a-z0-9_]+\.so$/i.test(name));
    wanted = [...required, ...cpu].map((name) => ({ from: name, to: name, executable: name !== 'LICENSE' }));
    for (const name of required) if (!inRoot.includes(name)) throw new FetchError(`${asset.file} has no ${name}.`);
    if (!cpu.length) throw new FetchError(`${asset.file} has no ggml-cpu backend.`);
  }

  return stageTarget(target, async (dir) => {
    for (const item of wanted) {
      const data = archive.read(asset.root + item.from);
      if (!data) throw new FetchError(`Could not read ${item.from} from ${asset.file}.`);
      writeFile(dir, item.to, data, item.executable);
    }
    if (target === 'win32-x64') {
      // The Windows zip has no LICENSE; take it from the pinned source.
      const source = readTarGz(fs.readFileSync(await fetchPinned(SOURCE)));
      const license = source.read(`${SOURCE.root}/LICENSE`);
      if (!license) throw new FetchError('The whisper.cpp source has no LICENSE.');
      writeFile(dir, 'LICENSE', license, false);
    }
    const runtime = bundleRuntime(target, dir, options);
    smokeTest(target, dir);
    return { source: asset.url, sourceSha256: asset.sha256, runtime };
  });
}

function run(command, args, { cwd, label }) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error && result.error.code === 'ENOENT') {
    throw new FetchError(`${command} was not found.`);
  }
  if (result.status !== 0) {
    throw new FetchError(`${label} failed (exit code ${result.status === null ? result.signal : result.status}). See the output above.`);
  }
}

function requireMacBuildTools() {
  const cmake = spawnSync('cmake', ['--version'], { encoding: 'utf8' });
  if (cmake.error || cmake.status !== 0) {
    throw new FetchError(
      'cmake is required to build whisper.cpp for macOS but was not found. Install it with "brew install cmake" ' +
        '(or from https://cmake.org/download/), then run "npm run fetch:whisper" again.'
    );
  }
  const clang = spawnSync('xcrun', ['--find', 'clang'], { encoding: 'utf8' });
  if (clang.error || clang.status !== 0) {
    throw new FetchError('The Xcode Command Line Tools are required. Install them with "xcode-select --install", then run again.');
  }
}

// Only system libraries and frameworks may be linked, so the binary runs on
// any Mac without Homebrew.
function checkMacBinary(file, arch) {
  const lipo = spawnSync('lipo', ['-archs', file], { encoding: 'utf8' });
  const archs = (lipo.stdout || '').trim();
  const expected = arch === 'x64' ? 'x86_64' : 'arm64';
  if (lipo.status !== 0 || archs !== expected) {
    throw new FetchError(`The built whisper-server is for "${archs || 'unknown'}", expected ${expected}.`);
  }
  const otool = spawnSync('otool', ['-L', file], { encoding: 'utf8' });
  if (otool.status !== 0) throw new FetchError('otool -L failed on the built whisper-server.');
  const libs = otool.stdout.split('\n').slice(1).map((line) => line.trim().split(' (')[0]).filter(Boolean);
  const foreign = libs.filter((lib) => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/Library/'));
  if (foreign.length) {
    throw new FetchError(`The built whisper-server links libraries a user's Mac may not have: ${foreign.join(', ')}`);
  }
}

async function buildMac(target, options) {
  if (process.platform !== 'darwin') {
    throw new FetchError(`${target} is built from source and needs a Mac (this is ${process.platform}).`);
  }
  requireMacBuildTools();
  const arch = target.split('-')[1];
  const tarball = await fetchPinned(SOURCE);

  const workDir = path.join(BUILD_DIR, target);
  const sourceDir = path.join(workDir, SOURCE.root);
  const cmakeDir = path.join(workDir, 'build');
  const stamp = path.join(workDir, '.source-sha256');
  let stampValue = '';
  try {
    stampValue = fs.readFileSync(stamp, 'utf8').trim();
  } catch {}
  // --force: a clean build. The stamp is written here, not pinned, so an
  // earlier build folder is not trusted.
  if (options.force || stampValue !== SOURCE.sha256 || !fs.existsSync(path.join(sourceDir, 'CMakeLists.txt'))) {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    log(`Extracting ${SOURCE.file}`);
    run('tar', ['-xzf', tarball, '-C', workDir], { cwd: workDir, label: 'Extracting the source' });
    fs.writeFileSync(stamp, `${SOURCE.sha256}\n`);
  }

  const cmakeArgs = [
    '-S', sourceDir,
    '-B', cmakeDir,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_DEPLOYMENT_TARGET}`,
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_NATIVE=OFF',
    // Apple clang has no OpenMP; a Homebrew libomp must not be picked up.
    '-DGGML_OPENMP=OFF',
    '-DGGML_CCACHE=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
    '-DWHISPER_BUILD_SERVER=ON',
    '-DWHISPER_SDL2=OFF',
    '-DWHISPER_CURL=OFF',
    '-DWHISPER_COREML=OFF',
  ];
  if (arch === 'arm64') {
    cmakeArgs.push('-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON');
  } else {
    // Every Intel Mac that runs macOS 13 has AVX2, FMA and F16C. Set them
    // explicitly: ggml turns them off by default when not building natively.
    cmakeArgs.push(
      '-DGGML_METAL=OFF',
      '-DGGML_SSE42=ON', '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON', '-DGGML_BMI2=ON'
    );
  }

  log(`Configuring whisper.cpp ${TAG} for ${target}`);
  run('cmake', cmakeArgs, { cwd: workDir, label: 'cmake configure' });
  log(`Building whisper-server for ${target}`);
  const jobs = String(Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length)));
  run('cmake', ['--build', cmakeDir, '--config', 'Release', '--target', 'whisper-server', '--parallel', jobs], {
    cwd: workDir,
    label: 'cmake build',
  });

  const built = path.join(cmakeDir, 'bin', 'whisper-server');
  if (!fs.existsSync(built)) throw new FetchError(`The build finished but ${built} is missing.`);
  checkMacBinary(built, arch);

  return stageTarget(target, (dir) => {
    copyFile(built, dir, 'whisper-server', true);
    copyFile(path.join(sourceDir, 'LICENSE'), dir, 'LICENSE', false);
    smokeTest(target, dir);
    return { source: SOURCE.url, sourceSha256: SOURCE.sha256, runtime: 'not needed' };
  });
}

async function fetchTarget(target, options) {
  if (!options.force && isUpToDate(target, options)) {
    log(`${target} is up to date (${TAG})`);
    return;
  }
  const { dir, manifest } = target.startsWith('darwin-') ? await buildMac(target, options) : await fetchPrebuilt(target, options);
  const total = Object.values(manifest.files).reduce((sum, f) => sum + f.bytes, 0);
  const server = manifest.files[binaryName(target)];
  log(
    `${target} ready in ${path.relative(ROOT_DIR, dir)}: ${binaryName(target)} ${formatBytes(server.bytes)}, ` +
      `${Object.keys(manifest.files).length} files, ${formatBytes(total)} total`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  for (const target of options.targets) {
    await fetchTarget(target, options);
  }
}

// electron-builder beforePack hook (build.beforePack in package.json). The
// npm pre-scripts normally fetch first; this also covers `npx electron-builder`
// and extra --arch flags, so no build ships without whisper-server. An arch
// whisper.cpp has no build for is packaged without it, with a warning; the
// app then reports local voice as unavailable on that system.
const BUILDER_ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

async function beforePack(context) {
  const arch = BUILDER_ARCH_NAMES[context.arch] || String(context.arch);
  const target = `${context.electronPlatformName}-${arch}`;
  if (!TARGETS.includes(target)) {
    warn(`whisper.cpp has no build for ${target}; this package will have no local voice.`);
    return;
  }
  await fetchTarget(target, { force: false, requireRuntime: false });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[whisper.cpp] ${error instanceof FetchError ? error.message : error.stack || error}`);
    process.exit(1);
  });
}

module.exports = { TAG, COMMIT, TARGETS, beforePack, compareGlibc, glibcFloor, isAllowedUrl, parseArgs };
