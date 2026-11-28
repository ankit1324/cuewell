/**
 * What happens when something goes wrong that nothing else handled.
 *
 * - isRecoverableRecorderError: the one uncaught exception the app survives,
 *   a missing microphone recorder (see main.js).
 * - The local crash record, userData/last-crash.json: when the app, a window
 *   or a helper process crashes, the error name, message and stack are saved
 *   with the time, app version, platform and arch. Nothing else: no
 *   transcripts, prompts, answers, clipboard, screenshots or settings. The
 *   home folder and user name are replaced with ~ and <user>, and anything
 *   that looks like a key or token is removed. Nothing is sent anywhere; on
 *   the next launch the user is offered once to open a prefilled GitHub
 *   issue (error-reporter.js), and the record is deleted either way.
 * - createFatalErrorHandler: logs a fatal error, saves the record and asks
 *   the user to restart or quit, with one dialog per run at most.
 *
 * Kept free of Electron so it can be tested in plain Node.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// node-record-lpcm16 recorders (node_modules/node-record-lpcm16/recorders):
// speech.service.js starts `sox` or `arecord`; `rec` is the library's third.
const RECORDER_PROGRAMS = Object.freeze(['sox', 'arecord', 'rec']);

const CRASH_RECORD_FILE = 'last-crash.json';
// Marks a run that the fatal-error handler restarted without asking.
const CRASH_RECORD_FIELDS = Object.freeze(['time', 'appVersion', 'platform', 'arch', 'kind', 'name', 'message', 'stack']);
// fatal: the app had to stop. error: an unhandled rejection from app code
// (the app kept running). renderer / helper: a window or Chromium helper
// process crashed and was restarted.
const CRASH_KINDS = Object.freeze(['fatal', 'error', 'renderer', 'helper']);

const MAX_NAME = 100;
const MAX_MESSAGE = 1000;
const MAX_STACK = 8000;
// Text is cut to this before it is scrubbed, so the patterns stay fast on a
// huge message (an error can carry a whole response body).
const MAX_SCRUB_INPUT = 64 * 1024;
const MAX_SHORT = 64; // time, version, platform, arch
// A record is a few KB; anything much larger was not written by the app.
const MAX_RECORD_BYTES = 64 * 1024;

// render-process-gone / child-process-gone reasons that mean a crash. Not
// 'clean-exit', 'killed' (by the user or the system) or 'memory-eviction'.
const CRASH_REASONS = new Set(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure']);

const REDACTED = '<redacted>';

/** `value` as text. Never throws, even for objects that cannot become text. */
function asText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return String(value);
  } catch (_) {
    return '[unreadable]';
  }
}

/** Replace lone surrogates, which encodeURIComponent rejects. */
function wellFormed(text) {
  return typeof text.toWellFormed === 'function'
    ? text.toWellFormed()
    : text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** The first `max` UTF-16 units of `text`, without cutting a character in half. */
function safeSlice(text, max) {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function programName(file) {
  return path.basename(asText(file).replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();
}

/**
 * True only for Node's spawn ENOENT for one of the recorder programs: the
 * recorder is not installed. Every other error, including ENOENT for any
 * other program or file, is false.
 */
function isRecoverableRecorderError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code !== 'ENOENT') return false;
  if (typeof error.path !== 'string' || error.syscall !== `spawn ${error.path}`) return false;
  return RECORDER_PROGRAMS.includes(programName(error.path));
}

function defaultHome() {
  try { return os.homedir(); } catch (_) { return ''; }
}

function defaultUser() {
  try { return os.userInfo().username; } catch (_) { return ''; }
}

// Applied in order. Each removes a value, never the text around it. Every
// repeat before the value is bounded, so a long input cannot make a pattern
// retry from each position to the end (quadratic time).
const SECRET_RULES = [
  // Screenshots and other inline data.
  [/data:[^;,\s]{0,100};base64,[A-Za-z0-9+/=]+/g, `data:${REDACTED}`],
  [/\bBearer\s{1,5}[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  // Authorization schemes. Capitalized only, so the English words stay.
  [/\b(Basic|Digest|Token)\s{1,5}[A-Za-z0-9._~+/=-]+/g, (_m, scheme) => `${scheme} ${REDACTED}`],
  // OpenAI, Anthropic (sk-ant-), OpenRouter (sk-or-), DeepSeek.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Gemini / Google.
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  // Groq.
  [/\bgsk_[A-Za-z0-9]{10,}/g, REDACTED],
  // GitHub tokens.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{1,8000}\.[A-Za-z0-9_-]+/g, REDACTED],
  // key=..., api_key: "...", token=..., password=..., Authorization: ...
  [/\b([A-Za-z0-9_-]{0,40}(?:key|token|secret|password|passwd|auth)[A-Za-z0-9_-]{0,40})(["']?\s{0,5}[:=]\s{0,5}["']?)([^\s"'&,;)]+)/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`],
];

// The folder after Users or home is a user name, whoever it belongs to,
// including Windows short names such as JOHNAT~1.
const USER_FOLDER_RE = /([\\/](?:Users|home|Documents and Settings))([\\/])[^\\/\s:*?"<>|]+/gi;

// Long runs of letters and digits (Azure keys, hex secrets, base64). Words
// and file names have no digits, or are shorter.
const OPAQUE_RE = /[A-Za-z0-9_+=-]{32,}/g;

/**
 * Cut `text` to at most `max` units at the last whitespace, so a secret is
 * never split into a part the patterns no longer recognize. Text with no
 * whitespace in range is one opaque token and is dropped.
 */
function cutAtWhitespace(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const match = cut.match(/[\s\S]*\s/);
  return match ? match[0] : REDACTED;
}

/**
 * `value` as text, with the home folder replaced by ~, other user folders
 * and the user name by <user>, and anything that looks like a key or token
 * removed. Input longer than `maxLength` is cut first (see cutAtWhitespace).
 */
function scrubText(value, { homeDir = defaultHome(), username = defaultUser(), maxLength = MAX_SCRUB_INPUT } = {}) {
  let out = cutAtWhitespace(wellFormed(asText(value)), maxLength);
  if (!out) return out;

  const home = asText(homeDir).replace(/[\\/]+$/, '');
  if (home.length > 1) {
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
    for (const variant of variants) {
      out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
    }
  }

  out = out.replace(USER_FOLDER_RE, (_m, folder, sep) => `${folder}${sep}<user>`);

  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement);
  out = out.replace(OPAQUE_RE, (run) => (/[0-9]/.test(run) && /[A-Za-z]/.test(run) ? REDACTED : run));

  // Shorter names would match ordinary words; their folders are caught above.
  const user = asText(username);
  if (user.length >= 3) {
    out = out.replace(new RegExp(`(?<![A-Za-z])${escapeRegExp(user)}(?![A-Za-z])`, 'gi'), '<user>');
  }
  return out;
}

/** { name, message, stack } of anything that was thrown or rejected. Never throws. */
function errorFields(value) {
  try {
    if (value && typeof value === 'object') {
      const { name, message, stack } = value;
      return {
        name: typeof name === 'string' && name ? name : 'Error',
        message: asText(message),
        stack: typeof stack === 'string' ? stack : '',
      };
    }
    return { name: 'Error', message: value === undefined ? 'undefined' : asText(value), stack: '' };
  } catch (_) {
    return { name: 'Error', message: '[unreadable]', stack: '' };
  }
}

/**
 * True when `error` is an Error whose stack runs through the app's own code
 * (under `appRoot`, outside node_modules).
 */
function isAppCodeError(error, appRoot) {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return false;
  const root = asText(appRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return false;
  return error.stack.split('\n').slice(1).some((line) => {
    const frame = line.replace(/\\/g, '/');
    const at = frame.indexOf(`${root}/`);
    return at !== -1 && !frame.slice(at + root.length + 1).startsWith('node_modules/');
  });
}

function capLines(text, max) {
  if (text.length <= max) return text;
  const cut = safeSlice(text, max);
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

function shortText(value) {
  return asText(value).replace(/[^\w .:+-]/g, '').slice(0, MAX_SHORT);
}

/**
 * The record saved to last-crash.json. Only CRASH_RECORD_FIELDS; any other
 * property of `fields` is ignored.
 */
function buildCrashRecord(fields = {}, { appVersion, platform, arch, homeDir, username, now = new Date() } = {}) {
  const scrub = (value, max) => scrubText(value, { homeDir, username, maxLength: max * 4 });
  const time = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : '';
  return {
    time,
    appVersion: shortText(appVersion),
    platform: shortText(platform),
    arch: shortText(arch),
    kind: CRASH_KINDS.includes(fields.kind) ? fields.kind : 'error',
    name: safeSlice(scrub(fields.name || 'Error', MAX_NAME), MAX_NAME),
    message: safeSlice(scrub(fields.message, MAX_MESSAGE), MAX_MESSAGE),
    stack: capLines(scrub(fields.stack, MAX_STACK), MAX_STACK),
  };
}

function writeRecordFile(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) { /* never created */ }
    throw error;
  }
}

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) { /* already gone */ }
}

/**
 * Read last-crash.json and delete it. Returns the record (normalized and
 * scrubbed again), or null when there is none or it is not a valid record.
 */
function takeCrashRecord(filePath, { homeDir, username } = {}) {
  let raw;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    raw = stat.size <= MAX_RECORD_BYTES ? fs.readFileSync(filePath, 'utf8') : null;
  } catch (_) {
    return null;
  }
  removeFile(filePath);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.message !== 'string' || !parsed.message.trim()) return null;
  const time = new Date(typeof parsed.time === 'string' ? parsed.time : NaN);
  return buildCrashRecord(
    { kind: parsed.kind, name: typeof parsed.name === 'string' ? parsed.name : 'Error', message: parsed.message,
      stack: typeof parsed.stack === 'string' ? parsed.stack : '' },
    { appVersion: parsed.appVersion, platform: parsed.platform, arch: parsed.arch, homeDir, username, now: time },
  );
}

/**
 * Saves this run's crash record and hands over the last run's. Within a run
 * the first record is kept, except that a fatal one replaces an earlier
 * non-fatal one. `context`: appVersion, platform, arch, homeDir, username.
 */
function createCrashRecorder({ filePath, context = {}, logger = null }) {
  let savedKind = null;
  let taken = false;
  return {
    filePath,
    /** Save a record. True when it was written. Never throws. */
    save(kind, fields = {}) {
      if (savedKind && (savedKind === 'fatal' || kind !== 'fatal')) return false;
      try {
        writeRecordFile(filePath, buildCrashRecord({ ...fields, kind }, { ...context, now: new Date() }));
        savedKind = kind;
        return true;
      } catch (error) {
        if (logger) logger.warn('Could not save the crash record', { error: error.message });
        return false;
      }
    },
    /** The last run's record, once; it is deleted from disk. */
    takePrevious() {
      if (taken || savedKind) return null;
      taken = true;
      return takeCrashRecord(filePath, context);
    },
    /**
     * Put back a record from takePrevious() that could not be offered, so
     * the next launch offers it. Not when this run saved its own record.
     */
    restore(record) {
      if (!record || typeof record !== 'object' || savedKind) return false;
      try {
        writeRecordFile(filePath, Object.fromEntries(CRASH_RECORD_FIELDS.map((key) => [key, asText(record[key])])));
        return true;
      } catch (error) {
        if (logger) logger.warn('Could not keep the crash record', { error: error.message });
        return false;
      }
    },
  };
}

/**
 * Fields for a crashed window (source 'window', type = window type) or
 * Chromium helper process (source 'helper'), or null when `reason` is not
 * a crash. Only fixed labels, the reason and the exit code: no page data.
 */
function processCrashFields({ source, type, name, reason, exitCode } = {}) {
  if (!CRASH_REASONS.has(reason)) return null;
  const label = asText(name || type).replace(/[^\w .-]/g, '').replace(/\.{2,}/g, '').trim().slice(0, 60) || 'unknown';
  const code = Number.isInteger(exitCode) ? `, exit code ${exitCode}` : '';
  if (source === 'helper') {
    return { name: 'HelperProcessCrash', message: `The ${label} helper process stopped (${reason}${code})`, stack: '' };
  }
  return { name: 'WindowCrash', message: `The ${label} window stopped (${reason}${code})`, stack: '' };
}

/** Title and body (dialog, notification) of the next-launch offer to report `record`. */
function crashOfferText(record) {
  const kind = record && record.kind;
  const title = kind === 'fatal'
    ? 'Cuewell quit unexpectedly last time'
    : kind === 'renderer' || kind === 'helper'
      ? 'Part of Cuewell stopped working last time'
      : 'Cuewell ran into an error last time';
  return {
    title,
    body: 'Report a problem? The report opens in your browser with the error details, and nothing is sent until you submit it.',
    // Notifications show two lines or so.
    notificationBody: 'Click to report a problem. Nothing is sent until you submit the report.',
  };
}

/**
 * How to offer the report: 'none' (no record, or reporting is not set up),
 * 'notification', or 'dialog' when notifications are not supported.
 */
function crashOfferPlan(record, { reportConfigured, notificationsSupported } = {}) {
  if (!record || !reportConfigured) return 'none';
  return notificationsSupported ? 'notification' : 'dialog';
}

const FATAL_TITLE = 'Cuewell could not continue';
const FATAL_DETAIL = 'Something went wrong inside Cuewell. The error was saved on this computer, ' +
  'and the next time Cuewell opens you can choose to report it.';

/**
 * The fatal-error path: log with the stack, save a crash record, then ask
 * "Restart Cuewell" or "Quit". One dialog per run: an error while it is
 * open, or after the choice, is only logged. When the dialog cannot be
 * shown, the app exits. Before the app is ready only the error box works,
 * so that is shown and the app exits.
 */
function createFatalErrorHandler({ app, dialog, logger, saveCrash, beforeDialog = () => {}, isQuitting = () => false }) {
  let handled = false;
  const exit = (code) => {
    try { app.exit(code); } catch (_) { process.exit(code); }
  };

  return function handleFatalError(error) {
    const fields = errorFields(error);
    try {
      logger.error(handled ? 'Another uncaught exception after a fatal error' : 'Uncaught exception', {
        error: fields.message, name: fields.name, stack: fields.stack,
      });
    } catch (_) { /* logging must not stop the exit */ }
    if (handled) return;
    handled = true;

    try { saveCrash('fatal', fields); } catch (_) { /* the dialog still matters */ }

    if (isQuitting()) {
      exit(1);
      return;
    }


    if (!app.isReady()) {
      try { dialog.showErrorBox(FATAL_TITLE, `${FATAL_DETAIL}\n\nOpen Cuewell again.`); } catch (_) { /* exiting anyway */ }
      exit(1);
      return;
    }

    Promise.resolve()
      .then(() => {
        // The overlay windows float above everything and would cover it.
        try { beforeDialog(); } catch (_) { /* show the dialog anyway */ }
        return dialog.showMessageBox({
          type: 'error',
          title: 'Cuewell',
          message: FATAL_TITLE,
          detail: FATAL_DETAIL,
          buttons: ['Restart Cuewell', 'Quit'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
      })
      .then((result) => {
        if (result && result.response === 0) {
          try { app.relaunch(); } catch (_) { /* exit anyway */ }
          exit(0);
        } else {
          exit(1);
        }
      })
      .catch(() => exit(1));
  };
}

module.exports = {
  RECORDER_PROGRAMS,
  CRASH_RECORD_FILE,
  CRASH_RECORD_FIELDS,
  CRASH_KINDS,
  isRecoverableRecorderError,
  scrubText,
  safeSlice,
  errorFields,
  isAppCodeError,
  buildCrashRecord,
  createCrashRecorder,
  takeCrashRecord,
  processCrashFields,
  crashOfferText,
  crashOfferPlan,
  createFatalErrorHandler,
};
