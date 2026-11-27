const fs = require('fs');
const path = require('path');
const os = require('os');
const { getActiveProviderId, isConfigured } = require('../services/providers');

const SENTINEL_NAME = '.cuewell-firstrun-completed';
// Builds released under the old names (Super Interview, OpenCluely) wrote
// these markers. They still count as completed so a user who finished
// onboarding never sees it again.
const LEGACY_SENTINEL_NAMES = ['.superinterview-firstrun-completed', '.opencluely-firstrun-completed'];

/**
 * Whether files in the launch folder (process.cwd()) may be used. Only when
 * running from source: a packaged app is launched from any folder, which must
 * not be able to supply its config. `options.allowLaunchFolder` overrides.
 */
function launchFolderAllowed(options) {
  if (typeof options.allowLaunchFolder === 'boolean') return options.allowLaunchFolder;
  try {
    const { app } = require('electron');
    if (app && typeof app.isPackaged === 'boolean') return !app.isPackaged;
  } catch (_) { /* not running under Electron */ }
  return true;
}

/** Default folder for .env and the marker in packaged builds: Electron's userData. */
function defaultDataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (_) { /* not running under Electron */ }
  return path.join(os.homedir(), '.Cuewell');
}

/**
 * First-run detection and onboarding helper.
 *
 * Responsibilities:
 *   - Decide whether this is the user's first launch of Cuewell
 *   - Auto-create a default `.env` from `env.example` if one is missing
 *   - Report whether the selected AI provider (LLM_PROVIDER, Gemini by
 *     default) has its API key configured (the only required setting)
 *   - Persist a "first-run completed" sentinel so we don't nag on every launch
 *
 * The settings UI is the source of truth for API-key entry. This module
 * only handles the bootstrap so the user has something to edit on first
 * launch.
 */
class FirstRunManager {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.allowLaunchFolder = launchFolderAllowed(options);
    const defaultDir = this.allowLaunchFolder ? this.cwd : defaultDataDir();
    this.envPath = options.envPath || path.join(defaultDir, '.env');
    this.sentinelPath = options.sentinelPath || path.join(defaultDir, SENTINEL_NAME);
    // Old-name markers that also mean "completed": the ones next to the new
    // marker, plus any the caller lists (main.js passes the markers in the
    // userData folders used before the renames).
    this.legacySentinelPaths = [
      ...LEGACY_SENTINEL_NAMES.map((name) => path.join(path.dirname(this.sentinelPath), name)),
      ...(options.legacySentinelPaths || []),
    ];
    this.logger = options.logger || console;
  }

  /**
   * Returns true if this looks like a fresh install — no .env, no
   * sentinel file, or .env exists but the selected AI provider has no key.
   */
  needsOnboarding() {
    if (!this._sentinelExists()) return true;
    if (!fs.existsSync(this.envPath)) return true;
    return !this._isLlmConfigured(this._readEnv());
  }

  /** A first-run marker exists, under the current or the old name. */
  _sentinelExists() {
    return [this.sentinelPath, ...this.legacySentinelPaths].some((p) => fs.existsSync(p));
  }

  /** The provider chosen by LLM_PROVIDER (Gemini by default) has a usable key. */
  _isLlmConfigured(env) {
    return isConfigured(getActiveProviderId(env), env);
  }

  /**
   * Ensures a .env file exists. If not, copies env.example (if available)
   * or writes a minimal template.
   */
  ensureEnv() {
    if (fs.existsSync(this.envPath)) {
      return { created: false, path: this.envPath };
    }

    const template = this._readTemplate();
    const dir = path.dirname(this.envPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.envPath, template, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(this.envPath, 0o600);
      } catch (_) { /* best effort */ }
      return { created: true, path: this.envPath };
    } catch (e) {
      this.logger.error && this.logger.error('Failed to create .env', { error: e.message });
      return { created: false, path: this.envPath, error: e.message };
    }
  }

  /**
   * Mark the first-run as completed so we don't keep prompting.
   */
  markCompleted() {
    try {
      fs.writeFileSync(this.sentinelPath, new Date().toISOString(), 'utf8');
    } catch (e) {
      this.logger.warn && this.logger.warn('Could not write first-run sentinel', {
        error: e.message
      });
    }
  }

  /**
   * Get a snapshot of the current setup state for UI / logging.
   */
  getStatus() {
    const env = this._readEnv();
    const gemini = (env.GEMINI_API_KEY || '').trim();
    return {
      envExists: fs.existsSync(this.envPath),
      sentinelExists: this._sentinelExists(),
      // Kept for the onboarding wizard's Gemini step.
      geminiConfigured: !!gemini && gemini !== 'your_gemini_api_key_here',
      llmProvider: getActiveProviderId(env),
      llmConfigured: this._isLlmConfigured(env),
      azureConfigured: !!(env.AZURE_SPEECH_KEY || '').trim() && !!(env.AZURE_SPEECH_REGION || '').trim(),
      whisperConfigured: !!(env.WHISPER_COMMAND || '').trim(),
      needsOnboarding: this.needsOnboarding()
    };
  }

  _readEnv() {
    try {
      const content = fs.readFileSync(this.envPath, 'utf8');
      const result = {};
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();

        // If the value is quoted, find the matching closing quote and
        // take everything between. Anything after the closing quote is
        // treated as trailing whitespace/comment.
        if (value.startsWith('"') || value.startsWith("'")) {
          const quote = value[0];
          const closeIdx = value.indexOf(quote, 1);
          if (closeIdx !== -1) {
            value = value.slice(1, closeIdx);
          }
        } else {
          // Unquoted: strip trailing inline comment (a " #" sequence).
          const hashIdx = value.indexOf(' #');
          if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
        }

        result[key] = value;
      }
      return result;
    } catch (_) {
      return {};
    }
  }

  _readTemplate() {
    // Prefer env.example if it ships in the project; otherwise write a
    // minimal template that the user can extend. The launch folder's copy is
    // only read when running from source; packaged builds use the one inside
    // the app.
    const candidates = [
      ...(this.allowLaunchFolder ? [path.join(this.cwd, 'env.example')] : []),
      path.join(__dirname, '..', '..', 'env.example'),
    ];
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch (_) { /* try next */ }
    }
    return [
      '# Cuewell configuration',
      '# Add your Google Gemini API key below — the app picks it up immediately.',
      '# Get a key from: https://aistudio.google.com/',
      '',
      'GEMINI_API_KEY=your_gemini_api_key_here',
      '',
      '# Speech provider: "whisper" (local) or "azure" (cloud).',
      '# WHISPER_COMMAND is auto-set to the project-local venv when you',
      '# install Whisper through the onboarding wizard, so no PATH change',
      '# or restart is needed.',
      'SPEECH_PROVIDER=whisper',
      'WHISPER_COMMAND=whisper',
      '# WHISPER_MODEL_DIR is optional. Leave it unset and the app stores model',
      '# weights in a stable app-data folder. Set an absolute path to override.',
      '# WHISPER_MODEL_DIR=',
      'WHISPER_MODEL=small',
      'WHISPER_LANGUAGE=auto',
      'WHISPER_DEVICE=auto',
      'WHISPER_PYTHON=',
      'WHISPER_CAPTURE_MODE=vad',
      'WHISPER_RESPONSE_TARGET=both',
      'WHISPER_MANUAL_MAX_MS=90000',
      'WHISPER_GPU_IDLE_MS=60000',
      'WHISPER_SEGMENT_MS=4000',
      ''
    ].join(os.EOL);
  }
}

module.exports = FirstRunManager;
module.exports.FirstRunManager = FirstRunManager;
