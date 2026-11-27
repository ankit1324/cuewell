/**
 * Update notifier. Builds are unsigned, so nothing is downloaded or
 * installed: this only asks GitHub for the latest release of UPDATE_REPO and
 * reports whether it is newer than the running version. The main process
 * shows the result (a notification on launch, a dialog on demand) and opens
 * the release page in the user's browser.
 *
 * No app data is sent: the request is a plain GET to api.github.com with a
 * User-Agent naming the app version (GitHub requires a User-Agent).
 */

const fs = require('fs');
const path = require('path');
// Node's URL on purpose: speech.service.js replaces globalThis.URL with a
// stand-in that reports every URL as https:.
const { URL } = require('url');

// TODO(owner): set to the GitHub "owner/repo" that publishes Cuewell
// releases. While this is the placeholder, update checks are skipped and the
// update and problem-report menu items are hidden.
const UPDATE_REPO = 'TODO-owner/cuewell';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10000;
// A release JSON is a few KB; anything this large is not one.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const OFF_VALUES = ['off', 'false', '0', 'no', 'disabled'];

/** True when `repo` is a real "owner/repo", not the TODO placeholder. */
function isRepoConfigured(repo) {
  if (typeof repo !== 'string') return false;
  if (repo.toLowerCase().startsWith('todo')) return false;
  if (!REPO_RE.test(repo)) return false;
  return !repo.split('/').some((part) => part === '.' || part === '..');
}

/** Automatic checks are on unless UPDATE_CHECKS is off (or false, 0, no). */
function isUpdateCheckEnabled(env = process.env) {
  const value = String((env && env.UPDATE_CHECKS) || '').trim().toLowerCase();
  return !OFF_VALUES.includes(value);
}

/**
 * { major, minor, patch, prerelease: string[] } for "1.2.3", "v1.2.3-rc.1",
 * "1.2" (missing parts are 0), or null when it is not a version.
 */
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(VERSION_RE);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((id) => id === '')) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    prerelease,
  };
}

/** Semver precedence of two prerelease identifier lists. */
function comparePrerelease(a, b) {
  // A version without a prerelease ranks above one with it.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const aNum = /^\d+$/.test(a[i]);
    const bNum = /^\d+$/.test(b[i]);
    if (aNum && bNum) {
      const diff = Number(a[i]) - Number(b[i]);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (aNum !== bNum) {
      // Numeric identifiers rank below alphanumeric ones.
      return aNum ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] > b[i] ? 1 : -1;
    }
  }
  return 0;
}

/** -1, 0 or 1 as `a` is older than, equal to or newer than `b`; null when either is not a version. */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }
  return comparePrerelease(va.prerelease, vb.prerelease);
}

/** "1.2.3" or "1.2.3-rc.1" for a parsed version. */
function formatVersion(v) {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${core}-${v.prerelease.join('.')}` : core;
}

/** The repo's "latest release" page; always safe to open. */
function releasesPageUrl(repo) {
  return `https://github.com/${repo}/releases/latest`;
}

/** True only for an https://github.com page under /<repo>/releases/. */
function isSafeReleaseUrl(value, repo) {
  if (typeof value !== 'string' || !isRepoConfigured(repo)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return false;
  if (parsed.username || parsed.password || parsed.port) return false;
  // URL() has already resolved any "..", so the prefix check is on the real path.
  return parsed.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/`);
}

class UpdateChecker {
  /**
   * @param {object} options
   * @param {string} options.repo            GitHub "owner/repo"
   * @param {string} options.currentVersion  app.getVersion()
   * @param {string} options.cachePath       JSON file in userData for the 24 h limit
   * @param {Function} options.fetch         fetch-compatible function (Electron net.fetch)
   * @param {object} [options.logger]
   * @param {boolean} [options.enabled]      automatic checks on (UPDATE_CHECKS)
   */
  constructor({ repo, currentVersion, cachePath, fetch, logger, enabled = true,
    now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DAY_MS } = {}) {
    this.repo = repo;
    this.currentVersion = currentVersion;
    this.cachePath = cachePath;
    this.fetch = fetch;
    this.logger = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.enabled = enabled;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.intervalMs = intervalMs;
    this._inFlight = null;
  }

  isConfigured() {
    return isRepoConfigured(this.repo);
  }

  /**
   * Ask GitHub now. Never throws. Resolves to { status, currentVersion,
   * latestVersion, releaseUrl, error } where status is 'available',
   * 'up-to-date', 'error' or 'not-configured'. A check already running is
   * shared instead of starting a second request.
   */
  check() {
    if (!this._inFlight) {
      this._inFlight = this._check().finally(() => { this._inFlight = null; });
    }
    return this._inFlight;
  }

  /**
   * The automatic launch check: null when it is turned off, not configured
   * or the last successful check was less than 24 hours ago; else check().
   */
  async checkIfDue() {
    if (!this.enabled || !this.isConfigured()) return null;
    const last = this._readLastCheckedAt();
    const now = this.now();
    // A time in the future (clock changed) counts as stale.
    if (last !== null && last <= now && now - last < this.intervalMs) {
      this.logger.debug('Update check skipped: checked recently', { lastCheckedAt: new Date(last).toISOString() });
      return null;
    }
    return this.check();
  }

  async _check() {
    const base = { currentVersion: this.currentVersion, latestVersion: null, releaseUrl: null, error: null };
    if (!this.isConfigured()) return { ...base, status: 'not-configured' };
    try {
      const release = await this._fetchLatestRelease();
      const result = this._evaluate(release);
      this._recordCheck(result);
      this.logger.info('Update check finished', {
        status: result.status, currentVersion: this.currentVersion, latestVersion: result.latestVersion,
      });
      return { ...base, ...result };
    } catch (error) {
      // Offline, proxy, rate limit, GitHub down: not the user's problem
      // during a launch check. The on-demand check reports it.
      this.logger.debug('Update check failed', { error: error.message });
      return { ...base, status: 'error', error: error.message || 'Update check failed' };
    }
  }

  /** The latest release JSON, or null when the repo has no published release. */
  async _fetchLatestRelease() {
    if (typeof this.fetch !== 'function') throw new Error('No fetch function');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Cuewell/${this.currentVersion} (update check)`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'follow',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub answered with status ${response.status}`);
      const length = Number(response.headers && response.headers.get && response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Release response is too large');
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('Release response is too large');
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        throw new Error('Release response is not JSON');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Release response has an unexpected shape');
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`No answer from GitHub within ${this.timeoutMs / 1000} seconds`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  _evaluate(release) {
    // No published release, or only drafts and prereleases: nothing newer.
    if (release === null || release.draft === true || release.prerelease === true) {
      return { status: 'up-to-date', latestVersion: null, releaseUrl: null };
    }
    const latest = parseVersion(typeof release.tag_name === 'string' ? release.tag_name : '');
    if (!latest) throw new Error('Latest release tag is not a version');
    const latestVersion = formatVersion(latest);
    const order = compareVersions(latestVersion, this.currentVersion);
    if (order === null) throw new Error(`Current version "${this.currentVersion}" is not a version`);
    if (order <= 0) return { status: 'up-to-date', latestVersion, releaseUrl: null };
    const releaseUrl = isSafeReleaseUrl(release.html_url, this.repo) ? release.html_url : releasesPageUrl(this.repo);
    return { status: 'available', latestVersion, releaseUrl };
  }

  _readLastCheckedAt() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      const value = Number(data && data.lastCheckedAt);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch (_) {
      return null;
    }
  }

  /** Remember a successful check. A failed write only means checking again next launch. */
  _recordCheck(result) {
    if (!this.cachePath) return;
    const tmpPath = `${this.cachePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify({
        lastCheckedAt: this.now(),
        latestVersion: result.latestVersion,
      }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, this.cachePath);
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* not created */ }
      this.logger.debug('Could not save the update check time', { error: error.message });
    }
  }
}

module.exports = {
  UPDATE_REPO,
  UpdateChecker,
  isRepoConfigured,
  isUpdateCheckEnabled,
  isSafeReleaseUrl,
  releasesPageUrl,
  parseVersion,
  compareVersions,
};
