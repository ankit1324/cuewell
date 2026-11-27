/**
 * Plain-English text for failures the user notices (voice, screenshots, AI
 * requests), and the prefilled "Report a Problem" link. The raw error is
 * still logged by the caller; only the text shown in the windows changes.
 * Messages that are already written for users pass through unchanged.
 */

const { isRepoConfigured } = require('./update-checker');

const GENERIC_SPEECH = 'Voice input stopped because of an error. Try again.';
const GENERIC_AI = 'The AI request failed. Try again.';

const OS_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Raw speech.service messages mapped to what the user should do. Anything
// not listed is already user-facing (Azure key, network, missing sox, ...).
const SPEECH_RULES = [
  [/^Speech provider ".*" is not available$/,
    'Voice input is not set up. Open Settings and choose Local Whisper or Azure Speech.'],
  [/^Whisper transcription failed/,
    'Local Whisper could not turn your speech into text. Try again. If it keeps failing, check the Whisper setup in Settings.'],
  [/^Speech recognition failed to start/,
    'Voice input could not start. Try again. If it keeps failing, check the speech settings.'],
  [/^Audio configuration failed/,
    'Could not open the microphone. Check that a microphone is connected and that Cuewell may use it.'],
  [/^Recognition (startup failed|error)/,
    'Azure Speech stopped with an error. Try again in a moment.'],
  [/^Could not start microphone capture with any available audio program/,
    'Could not start the microphone. Check that a microphone is connected, then try again.'],
];

/** User-facing text for a speech service error. */
function friendlySpeechError(raw) {
  const message = text(raw);
  if (!message) return GENERIC_SPEECH;
  for (const [pattern, friendly] of SPEECH_RULES) {
    if (pattern.test(message)) return friendly;
  }
  return message;
}

/** True when the OS blocks access ('denied', or 'restricted' by a policy). */
function isMediaAccessBlocked(status) {
  return status === 'denied' || status === 'restricted';
}

/** What to do when the OS blocks the microphone. */
function microphoneBlockedMessage(platform = process.platform) {
  if (platform === 'darwin') {
    return 'Microphone access is off. Turn on Cuewell in System Settings > Privacy & Security > Microphone ' +
      '(when running from source, turn on your terminal or editor), then try again.';
  }
  if (platform === 'win32') {
    return 'Microphone access is off. Turn it on in Windows Settings > Privacy & security > Microphone, ' +
      'including "Let desktop apps access your microphone", then try again.';
  }
  return 'Cuewell cannot use the microphone. Check that a microphone is connected and not used by another app, then try again.';
}

/**
 * User-facing text for a failed screen capture. `screenAccess` is macOS's
 * Screen Recording status (systemPreferences.getMediaAccessStatus('screen')).
 */
function friendlyCaptureError(raw, { platform = process.platform, screenAccess } = {}) {
  const message = text(raw);
  if (message === 'Capture already in progress') return 'A screenshot is already being taken.';
  if (platform === 'darwin') {
    if (isMediaAccessBlocked(screenAccess) || message === 'No screen sources available for capture') {
      return 'Screen capture failed. Allow Screen Recording for Cuewell (or, when running from source, the app that ' +
        'launched it) in System Settings > Privacy & Security > Screen & System Audio Recording, then restart Cuewell.';
    }
    return 'Screen capture failed. Try again. If it keeps failing, check that Cuewell may record the screen in ' +
      'System Settings > Privacy & Security > Screen & System Audio Recording.';
  }
  if (platform === 'linux') {
    return 'Screen capture failed. On Wayland, allow screen sharing when your desktop asks. ' +
      'If no prompt appears, sign in with an X11 session and try again.';
  }
  return 'Screen capture failed. Try again. If it keeps failing, restart Cuewell.';
}

const NOT_INITIALIZED_RE = /^LLM service not initialized\. Check (?:the )?(.+?) (?:API key configuration|settings)\.$/;

/** User-facing text for a failed AI request; llm.service already words most of them. */
function friendlyLlmError(raw) {
  const message = text(raw);
  if (!message) return GENERIC_AI;
  const notReady = message.match(NOT_INITIALIZED_RE);
  if (notReady) {
    const label = notReady[1];
    return /ollama/i.test(label)
      ? `Cuewell is not connected to ${label}. Check the server URL and model in Settings.`
      : `Add your ${label} API key in Settings to get answers.`;
  }
  return message;
}

/**
 * Prefilled https://github.com/<repo>/issues/new link, or null while the repo
 * is the TODO placeholder. Only the app version and OS go in the body: no
 * logs, keys, questions or interview context.
 */
function buildProblemReportUrl(repo, { appVersion, platform, osVersion, arch, electronVersion } = {}) {
  if (!isRepoConfigured(repo)) return null;
  const os = [OS_NAMES[platform] || platform || 'Unknown OS', osVersion].filter(Boolean).join(' ');
  const system = [
    `Cuewell ${appVersion || 'unknown version'}`,
    arch ? `${os} (${arch})` : os,
    electronVersion ? `Electron ${electronVersion}` : null,
  ].filter(Boolean).join(' · ');
  const body = [
    '**What happened?**',
    '',
    '',
    '**What did you expect to happen?**',
    '',
    '',
    '**Steps to reproduce**',
    '1. ',
    '',
    '---',
    system,
    '',
    'Logs can help: in Cuewell, choose Help > View Logs Folder. Remove anything private before you attach a log.',
  ].join('\n');
  return `https://github.com/${repo}/issues/new?body=${encodeURIComponent(body)}`;
}

module.exports = {
  friendlySpeechError,
  friendlyCaptureError,
  friendlyLlmError,
  microphoneBlockedMessage,
  isMediaAccessBlocked,
  buildProblemReportUrl,
};
