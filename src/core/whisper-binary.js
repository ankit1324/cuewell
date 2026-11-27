// Finds the bundled whisper.cpp `whisper-server` program.
//
// Packaged builds: process.resourcesPath/whisper/ (electron-builder
// extraResources, outside the asar archive so it can run).
// From source: <repo>/vendor/whisper/<platform>-<arch>/.
//
// The path is fixed by the app; nothing from a renderer or from .env goes
// into it.

const fs = require('fs');
const path = require('path');

// Platforms a whisper-server build ships for.
const SUPPORTED_PLATFORMS = Object.freeze(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']);

// Sub-folders the official release archives use, so an unflattened copy
// works too: whisper-bin-x64.zip has Release/, the Ubuntu tarball has
// whisper-bin-ubuntu-x64/.
const SUB_FOLDERS = ['', 'Release', 'whisper-bin-ubuntu-x64', 'bin'];

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function isPlatformSupported(platform = process.platform, arch = process.arch) {
  return SUPPORTED_PLATFORMS.includes(platformKey(platform, arch));
}

function executableName(platform = process.platform) {
  return platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
}

/** Folders to look in, most preferred first. */
function searchRoots({ platform, arch, resourcesPath, appRoot }) {
  const roots = [];
  if (resourcesPath) roots.push(path.join(resourcesPath, 'whisper'));
  if (appRoot && !appRoot.includes('app.asar')) {
    roots.push(path.join(appRoot, 'vendor', 'whisper', platformKey(platform, arch)));
  }
  return roots;
}

function isRunnable(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The bundled whisper-server for this platform: { path, dir }, where `dir`
 * holds the program and the libraries it loads (LD_LIBRARY_PATH on Linux,
 * the DLL folder on Windows). null when there is none or it cannot run.
 *
 * Options exist for tests; the app uses the defaults.
 */
function resolveWhisperServer({
  platform = process.platform,
  arch = process.arch,
  resourcesPath = process.resourcesPath,
  appRoot = path.resolve(__dirname, '..', '..'),
} = {}) {
  if (!isPlatformSupported(platform, arch)) return null;
  const name = executableName(platform);
  for (const root of searchRoots({ platform, arch, resourcesPath, appRoot })) {
    for (const sub of SUB_FOLDERS) {
      const dir = sub ? path.join(root, sub) : root;
      const file = path.join(dir, name);
      if (isRunnable(file, platform)) return { path: file, dir };
    }
  }
  return null;
}

module.exports = {
  SUPPORTED_PLATFORMS,
  platformKey,
  isPlatformSupported,
  executableName,
  resolveWhisperServer,
};
