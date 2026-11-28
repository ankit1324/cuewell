const path = require("path");
const fs = require("fs");
// Node's URL on purpose: speech.service.js replaces globalThis.URL with a
// stand-in that reports every URL as https:.
const { URL, fileURLToPath } = require("url");
const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, session, ipcMain, nativeTheme, dialog, shell, Notification, net, systemPreferences, powerMonitor } = require("electron");

// ── Carry data over from the folders used before the renames ──
// Electron names the userData folder after package.json, so each rename gave
// the app a new, empty folder. Builds released as Super Interview used
// <appData>/super-interview or <appData>/Super Interview, and builds released
// as OpenCluely used <appData>/opencluely or <appData>/OpenCluely (source runs
// use the package name, packaged builds the product name). Before anything
// reads userData, bring over the .env, the interview context (profile.json),
// the first-run marker and the downloaded Whisper models. Each step is skipped
// when the new folder already has the item, so it acts once, and the newest
// old folder that has the item wins. The old folders are only read, apart
// from moving the models out of them, and a failure is logged (once the
// logger loads) instead of blocking startup.
const FIRST_RUN_MARKER = ".cuewell-firstrun-completed";
// Markers written under the old names. Either one means onboarding finished.
const LEGACY_FIRST_RUN_MARKERS = [".superinterview-firstrun-completed", ".opencluely-firstrun-completed"];

function legacyUserDataDirs() {
  try {
    const appData = app.getPath("appData");
    // Newest name first. Each pair is the package name (source runs) and the
    // product name (packaged builds).
    const names = ["super-interview", "Super Interview", "opencluely", "OpenCluely"];
    return names.map((name) => path.join(appData, name));
  } catch (_) {
    return [];
  }
}

// Every place an old first-run marker may be, newest folder first.
function legacyFirstRunMarkerPaths() {
  const paths = [];
  for (const dir of legacyUserDataDirs()) {
    for (const marker of LEGACY_FIRST_RUN_MARKERS) paths.push(path.join(dir, marker));
  }
  return paths;
}

// Copy a small private file (.env holds API keys). The copy is created 0600,
// never replaces an existing file, and a half-written copy is removed so the
// next launch can retry.
function copyPrivateFile(from, to) {
  const data = fs.readFileSync(from);
  try {
    fs.writeFileSync(to, data, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") {
      try { fs.unlinkSync(to); } catch (_) { /* nothing was created */ }
    }
    throw err;
  }
}

function migrateLegacyUserData() {
  const log = [];
  let userData;
  try {
    userData = app.getPath("userData");
  } catch (err) {
    log.push({ level: "warn", message: "Skipped data folder migration: userData path unavailable", meta: { error: err.message } });
    return log;
  }
  const oldDirs = legacyUserDataDirs();
  const steps = [
    { item: ".env", from: [".env"], to: ".env", isDir: false },
    // Interview context; src/core/profile-store.js reads it from userData.
    { item: "interview context", from: ["profile.json"], to: "profile.json", isDir: false },
    { item: "first-run marker", from: LEGACY_FIRST_RUN_MARKERS, to: FIRST_RUN_MARKER, isDir: false },
    // The folder src/core/whisper-installer.js downloads weights into.
    { item: "Whisper models", from: [".whisper-models"], to: ".whisper-models", isDir: true },
  ];
  for (const step of steps) {
    try {
      const target = path.join(userData, step.to);
      if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
      // A marker under an old name in userData itself also counts.
      const searchDirs = step.to === FIRST_RUN_MARKER ? [userData, ...oldDirs] : oldDirs;
      const source = searchDirs
        .flatMap((dir) => step.from.map((name) => path.join(dir, name)))
        .find((candidate) => {
          const stat = fs.statSync(candidate, { throwIfNoEntry: false });
          return !!stat && (step.isDir ? stat.isDirectory() : stat.isFile());
        });
      if (!source) continue;
      if (step.isDir) {
        // Moved, not copied, so the model is not downloaded or stored twice.
        fs.renameSync(source, target);
      } else {
        copyPrivateFile(source, target);
      }
      log.push({ level: "info", message: `Migrated ${step.item} from a previous data folder`, meta: { from: source, to: target } });
    } catch (err) {
      log.push({ level: "warn", message: `Could not migrate ${step.item} from a previous data folder`, meta: { error: err.message } });
    }
  }
  return log;
}
const userDataMigrationLog = migrateLegacyUserData();

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), and it is whatever folder
// the app was launched from, so packaged builds only ever use Electron's
// userData directory. When running from source (npm start) an existing
// project-local .env is still preferred so the dev workflow is unchanged.
// Both onboarding (FirstRunManager) and persistEnvUpdates() write to this
// same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    if (!app.isPackaged) {
      const projectEnv = path.join(process.cwd(), ".env");
      // Prefer a project .env only when it already exists and userData has
      // none (i.e. a developer running from the repo).
      if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
        return projectEnv;
      }
    }
    return userDataEnv;
  } catch (_) {
    try {
      return path.join(app.getPath("userData"), ".env");
    } catch (e2) {
      if (!app.isPackaged) return path.join(process.cwd(), ".env");
      const dir = path.join(require("os").homedir(), ".Cuewell");
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
      return path.join(dir, ".env");
    }
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// .env holds API keys, so only the current user may read it. Files made by
// `cp env.example .env` or by older builds are 0644; tighten them once here.
// Windows has no POSIX modes, and a failure here must never block startup.
if (process.platform !== "win32") {
  try {
    if (fs.existsSync(ENV_PATH) && (fs.statSync(ENV_PATH).mode & 0o077) !== 0) {
      fs.chmodSync(ENV_PATH, 0o600);
    }
  } catch (_) { /* best effort */ }
}

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). Cuewell's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
  // Global shortcuts on Wayland go through the desktop's GlobalShortcuts
  // portal (the desktop may ask the user to allow them once). Ignored on X11.
  // Must be set before the app is ready.
  app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
for (const entry of userDataMigrationLog) logger[entry.level](entry.message, entry.meta);
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");
const {
  UPDATE_REPO, UpdateChecker, isRepoConfigured, isUpdateCheckEnabled, isSafeReleaseUrl, releasesPageUrl,
} = require("./src/core/update-checker");
const {
  friendlySpeechError, friendlyCaptureError, friendlyLlmError, microphoneBlockedMessage,
  isMediaAccessBlocked, buildProblemReportUrl,
} = require("./src/core/error-reporter");
const { buildAppMenuTemplate, buildToolbarMenuTemplate } = require("./src/core/app-menu");
const { AppTray } = require("./src/core/tray");

// The launch update check waits until startup work has settled.
const LAUNCH_UPDATE_CHECK_DELAY_MS = 15000;
// The same speech error is shown in the answer window at most this often.
const SPEECH_ERROR_REPEAT_MS = 5000;
// A crashed window is reloaded at most this many times in a minute; after
// that it is left alone and the user is told to restart.
const MAX_RENDERER_RELOADS_PER_MINUTE = 3;
// On quit, the longest wait for Settings to save what is still pending.
const QUIT_FLUSH_TIMEOUT_MS = 1000;
// If quitting still has not finished this long after it started, exit.
const QUIT_FORCE_EXIT_MS = QUIT_FLUSH_TIMEOUT_MS + 3000;
// A tray click closes the menu first; the screenshot waits for it to fade.
const TRAY_SCREENSHOT_DELAY_MS = 250;

// ── Global crash guard ──
// The speech path spawns external processes (Whisper CLI, and on macOS/Linux
// the sox/rec/arecord recorders via node-record-lpcm16). A missing recorder
// binary makes that library emit an 'error' on its child process with no
// listener, which would otherwise become an uncaughtException and quit the
// entire app the moment the user clicks the mic. We log and stay alive — the
// speech service surfaces a friendly status to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const whisperModels = require("./src/core/whisper-models");
// A relative WHISPER_MODEL_DIR (setup.sh writes `.whisper-models`) is
// resolved against the folder of the .env loaded above.
speechService.setEnvPath(ENV_PATH);
const llmService = require("./src/services/llm.service");
const { promptLoader } = require("./prompt-loader");
const profileStore = require("./src/core/profile-store");
const {
  getActiveProviderId, getProviderConfig, listProviders, isPlaceholderKey,
  isConfigured, getApiKey, getModel, getBaseURL, createProvider,
} = require("./src/services/providers");

// AI-provider fields the Settings window edits, mapped to their .env keys.
// geminiKey (GEMINI_API_KEY) and llmProvider (LLM_PROVIDER) are handled
// separately in saveSettings().
const LLM_SETTING_ENV_KEYS = {
  anthropicKey: "ANTHROPIC_API_KEY",
  openaiKey: "OPENAI_API_KEY",
  openrouterKey: "OPENROUTER_API_KEY",
  groqKey: "GROQ_API_KEY",
  deepseekKey: "DEEPSEEK_API_KEY",
  geminiModel: "GEMINI_MODEL",
  anthropicModel: "ANTHROPIC_MODEL",
  openaiModel: "OPENAI_MODEL",
  openrouterModel: "OPENROUTER_MODEL",
  groqModel: "GROQ_MODEL",
  deepseekModel: "DEEPSEEK_MODEL",
  ollamaModel: "OLLAMA_MODEL",
  ollamaBaseUrl: "OLLAMA_BASE_URL",
};

// Settings fields that hold secrets, mapped to their .env keys. Their values
// never leave the main process: get-settings returns maskSecret() for each,
// and an empty value on save means "keep the saved key".
const SECRET_SETTING_ENV_KEYS = {
  geminiKey: "GEMINI_API_KEY",
  azureKey: "AZURE_SPEECH_KEY",
  anthropicKey: "ANTHROPIC_API_KEY",
  openaiKey: "OPENAI_API_KEY",
  openrouterKey: "OPENROUTER_API_KEY",
  groqKey: "GROQ_API_KEY",
  deepseekKey: "DEEPSEEK_API_KEY",
};

const MODEL_SETTING_FIELDS = [
  "geminiModel", "anthropicModel", "openaiModel", "openrouterModel",
  "groqModel", "deepseekModel", "ollamaModel",
];

const CODING_LANGUAGES = ["cpp", "c", "python", "java", "javascript"];
const APP_ICON_KEYS = ["cuewell", "terminal", "activity", "settings"];
// Icon keys saved under an old app name, mapped to the current key.
const LEGACY_APP_ICON_KEYS = { superinterview: "cuewell" };
function normalizeAppIconKey(key) {
  return Object.prototype.hasOwnProperty.call(LEGACY_APP_ICON_KEYS, key) ? LEGACY_APP_ICON_KEYS[key] : key;
}

// Window gap (toolbar to answer panel) in pixels, saved as WINDOW_GAP.
const MAX_WINDOW_GAP = 100;
/** The gap as a whole number of pixels, or null when `raw` is not one in range. */
function parseWindowGap(raw) {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const gap = Number(text);
  return gap <= MAX_WINDOW_GAP ? gap : null;
}

const WHISPER_DEVICES = ["auto", "cpu", "cuda"];
const WHISPER_CAPTURE_MODES = ["vad", "manual"];
const WHISPER_RESPONSE_TARGETS = ["both", "chat", "overlay"];
// Whisper model aliases and the weights file each downloads (<name>.pt).
const WHISPER_MODEL_FILES = { large: "large-v3", turbo: "large-v3-turbo" };
// Local voice engines: the bundled whisper.cpp server or Python openai-whisper.
const WHISPER_ENGINES = ["whispercpp", "python"];
// voice-model-progress events go to the window at most this often.
const VOICE_PROGRESS_INTERVAL_MS = 150;

// What each shortcut does, for the Settings shortcuts table. Keys are the
// accelerators registered in setupGlobalShortcuts / setupFocusShortcuts.
const SHORTCUT_ACTIONS = Object.freeze({
  "CommandOrControl+Shift+S": "Capture the screen under the pointer and ask about it",
  "Alt+R": "Start or stop voice input",
  "CommandOrControl+Shift+V": "Show or hide all windows",
  "CommandOrControl+Shift+I": "Turn click-through on or off",
  "Alt+A": "Turn click-through on or off",
  "CommandOrControl+Shift+C": "Show or hide the chat window",
  "CommandOrControl+Shift+\\": "Clear the conversation history",
  "CommandOrControl+,": "Open Settings",
  "CommandOrControl+Up": "Previous interview mode, or move the windows up when click-through is on",
  "CommandOrControl+Down": "Next interview mode, or move the windows down when click-through is on",
  "CommandOrControl+Left": "Move the windows left when click-through is on",
  "CommandOrControl+Right": "Move the windows right when click-through is on",
});

// Which settings fields each window may save. Anything else in the payload
// rejects the whole save. The toolbar only saves its language picker.
const SETTINGS_FIELDS_BY_WINDOW = {
  main: ["codingLanguage"],
  settings: [
    "speechProvider", "azureKey", "azureRegion",
    "whisperCommand", "whisperModel", "whisperLanguage", "whisperDevice",
    "whisperCaptureMode", "whisperResponseTarget", "whisperSegmentMs",
    "whisperEngine", "whisperCppModel",
    "geminiKey", "llmProvider", ...Object.keys(LLM_SETTING_ENV_KEYS),
    "windowGap", "codingLanguage", "activeSkill", "answerLength", "selectedIcon",
  ],
  // whisperModelDownload is recorded by the wizard but not stored.
  onboarding: [
    "geminiKey", "llmProvider", ...Object.keys(LLM_SETTING_ENV_KEYS),
    "speechProvider", "azureKey", "azureRegion",
    "whisperCommand", "whisperModelDownload",
    "whisperEngine", "whisperCppModel", "whisperLanguage",
  ],
};

// IPC channel -> window types allowed to use it (see windowManager.windowConfigs
// for the types). Every ipcMain.handle/on goes through handleIpc()/onIpc(),
// which reject senders not listed here.
const IPC_ALLOWED_WINDOWS = Object.freeze({
  // Toolbar (index.html)
  "take-screenshot": ["main"],
  "audio-chunk": ["main"],
  "main-window-ready": ["main"],
  "resize-window": ["main"],
  "move-window": ["main"],
  "get-window-stats": ["main"],
  "show-settings": ["main"],
  "update-active-skill": ["main"],
  // Pop-up app menu (About, updates, Settings, help, Quit)
  "show-app-menu": ["main"],
  // Toolbar and chat mic buttons
  "get-speech-availability": ["main", "chat"],
  "start-speech-recognition": ["main", "chat"],
  "stop-speech-recognition": ["main", "chat"],
  // Settings reads; the toolbar reads codingLanguage/activeSkill/modes only
  "get-settings": ["main", "settings"],
  // Field-level limits per window are in SETTINGS_FIELDS_BY_WINDOW
  "save-settings": ["main", "settings", "onboarding"],
  "quit-app": ["main", "settings"],
  // Chat (chat.html) and answer (llm-response.html)
  "send-chat-message": ["chat"],
  "copy-to-clipboard": ["chat", "llmResponse"],
  "close-window": ["llmResponse"],
  "resize-llm-window-for-content": ["llmResponse"],
  // Settings (settings.html)
  "close-settings": ["settings"],
  // Ack for flush-before-quit: Settings saved what was pending (see onBeforeQuit)
  "flush-before-quit-done": ["settings"],
  // Read-only facts for Settings: version, platform, shortcuts, file paths
  "get-settings-info": ["settings"],
  // Removes one saved key (a save with an empty key keeps it)
  "remove-secret": ["settings"],
  "get-whisper-status": ["settings"],
  // Interview context (userData/profile.json)
  "get-profile": ["settings"],
  "save-profile": ["settings"],
  // Onboarding (onboarding.html)
  "get-first-run-status": ["onboarding"],
  "complete-first-run": ["onboarding"],
  "close-onboarding": ["onboarding"],
  // Whisper setup and Test connection: the wizard and Settings. Settings
  // reads the Whisper state with get-whisper-status instead of detect-whisper.
  "detect-whisper": ["onboarding"],
  "install-whisper": ["onboarding", "settings"],
  "download-whisper-model": ["onboarding", "settings"],
  // Built-in voice (whisper.cpp): engine state, model downloads, engine choice.
  // Progress arrives as voice-model-progress events on the requesting window.
  "get-voice-status": ["settings", "onboarding"],
  "download-voice-model": ["settings", "onboarding"],
  "cancel-voice-model-download": ["settings", "onboarding"],
  "set-voice-engine": ["settings", "onboarding"],
  "test-provider": ["onboarding", "settings"],
});

/** Masked form of a secret for the renderer: whether it is set, and its last 4 characters for long keys. */
function maskSecret(value) {
  const v = String(value || "").trim();
  if (!v || isPlaceholderKey(v)) return { set: false, last4: "" };
  return { set: true, last4: v.length >= 12 ? v.slice(-4) : "" };
}

class SettingsValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

// Bounds for the toolbar's resize-window and move-window requests.
const MAX_MAIN_WINDOW_HEIGHT = 800;
const MAX_MOVE_DELTA = 200;
const MAX_CHAT_MESSAGE_LENGTH = 100000;
// Onboarding's Test connection; a cold local Ollama model can take a while.
const PROVIDER_TEST_TIMEOUT_MS = 60000;

const MODEL_NAME_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
// Whisper model names (tiny, small, large-v3, turbo, ...). No "/" so a name
// can never become a file path in the model folder.
const WHISPER_MODEL_NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const isWhisperModelName = (name) => WHISPER_MODEL_NAME_RE.test(name) && !name.includes("..");
const AZURE_REGION_RE = /^[a-z0-9]+$/;
// Interview modes are the prompt-loader's mode ids ('dsa' is Coding).
const isInterviewMode = (value) => promptLoader.isMode(value);
// Printable ASCII without spaces: what every provider's API keys use.
const SECRET_VALUE_RE = /^[\x21-\x7E]{1,1000}$/;
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** null when `value` is an allowed provider base URL, else the reason. */
function baseUrlProblem(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return "is not a valid URL";
  }
  if (parsed.username || parsed.password) return "must not contain a user name or password";
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:") {
    return LOCAL_HOSTNAMES.includes(parsed.hostname)
      ? null
      : "must use https:// (http:// is only allowed for localhost, 127.0.0.1 or [::1])";
  }
  return "must start with https:// (or http:// for localhost)";
}

// Same tokenizer as speech.service.js _parseCommand and the Whisper
// installer: double-quoted segments keep paths with spaces in one argument.
function splitCommand(raw) {
  const parts = String(raw || "").trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return parts.map((p) => p.replace(/^"|"$/g, "")).filter(Boolean);
}

const WHISPER_EXECUTABLE_NAME_RE = /^(whisper[\w.-]*|python[\d.]*|py)(\.exe)?$/i;

/**
 * null when `raw` is an allowed WHISPER_COMMAND, else the reason. Allowed:
 *   - one of the Whisper installer's own bare commands, exactly as it probes
 *     them (e.g. `whisper`, `python3 -m whisper`)
 *   - an absolute path to an existing executable whisper or python file,
 *     alone or followed by `-m whisper`
 */
function whisperCommandProblem(raw, knownBareCommands, platform = process.platform) {
  const tokens = splitCommand(raw);
  if (tokens.length === 0) return null; // empty: auto-detect
  if (/["\0\r\n]/.test(tokens.join(""))) return "contains characters that are not allowed";
  const [cmd, ...args] = tokens;
  if (!path.isAbsolute(cmd)) {
    const matches = knownBareCommands.some((known) =>
      known.length === tokens.length && known.every((part, i) => part === tokens[i]));
    if (matches) return null;
    const names = knownBareCommands.map((known) => known.join(" ")).join(", ");
    return `must be an absolute path to the Whisper program, or one of: ${names}`;
  }
  const extraArgsOk = args.length === 0 || (args.length === 2 && args[0] === "-m" && args[1] === "whisper");
  if (!extraArgsOk) return "may only be followed by \"-m whisper\"";
  if (!WHISPER_EXECUTABLE_NAME_RE.test(path.basename(cmd))) {
    return "must point to a whisper or python program";
  }
  let stat;
  try {
    stat = fs.statSync(cmd);
  } catch (_) {
    return "points to a file that does not exist";
  }
  if (!stat.isFile()) return "must point to a file, not a folder";
  if (platform === "win32") {
    if (!/\.exe$/i.test(cmd)) return "must point to an .exe file";
  } else {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
    } catch (_) {
      return "points to a file that is not executable";
    }
  }
  return null;
}

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    // Interview mode, persisted in .env as INTERVIEW_MODE. Auto when unset,
    // for new and existing users (earlier builds never saved a mode).
    this.activeSkill = isInterviewMode(process.env.INTERVIEW_MODE)
      ? process.env.INTERVIEW_MODE
      : promptLoader.getDefaultMode();
    // Answer length (auto | short | standard | detailed), in .env as ANSWER_LENGTH.
    this.answerLength = promptLoader.isAnswerLength(process.env.ANSWER_LENGTH) ? process.env.ANSWER_LENGTH : "auto";
    // Interview context, stored in userData/profile.json.
    this.profilePath = path.join(app.getPath("userData"), "profile.json");
    this.profile = this.loadProfile();
    llmService.setPromptContext({ answerLength: this.answerLength, profile: this.profile });
  // Coding language, persisted in .env as CODING_LANGUAGE. C++ when unset.
  this.codingLanguage = CODING_LANGUAGES.includes(process.env.CODING_LANGUAGE) ? process.env.CODING_LANGUAGE : "cpp";
    // Saved window gap (WINDOW_GAP); the window manager's default otherwise.
    const savedWindowGap = parseWindowGap(process.env.WINDOW_GAP);
    if (savedWindowGap !== null) windowManager.setWindowGap(savedWindowGap);
    this.speechAvailable = false;

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), FIRST_RUN_MARKER),
      // Onboarding finished under an old name also counts: the migration
      // above normally copies that marker, this covers a failed copy.
      legacySentinelPaths: legacyFirstRunMarkerPaths(),
      // Packaged builds never read env.example from the launch folder.
      allowLaunchFolder: !app.isPackaged,
    });
    // Lazily-initialised in getWhisperInstaller() so tests can mock
    // the constructor without polluting main-process startup.
    this._whisperInstaller = null;
    // "install" or "download" while one runs; see install-whisper.
    this._whisperJob = null;
    // The voice model download that runs now: { id, controller, received, total }.
    this._voiceDownload = null;
    this.isFirstRun = false;
    this.isQuitting = false;
    // Quit sequence (onBeforeQuit): true once Settings had its chance to save.
    this._quitPrepared = false;
    this._quitPreparing = false;
    // The flush-before-quit request Settings is answering: { id, finish }.
    this._quitFlushWaiter = null;
    this._quitFlushSeq = 0;
    this._quitForceExitTimer = null;
    // Menu bar / tray icon (src/core/tray.js), created when the app is ready.
    this.tray = null;
    // The name the app shows now (Cuewell, or the app icon setting's disguise).
    this.appDisplayName = "Cuewell";

    // Update notifier: reads the latest GitHub release, never installs.
    // Automatic checks follow UPDATE_CHECKS in .env (read only, default on).
    this.updateChecker = new UpdateChecker({
      repo: UPDATE_REPO,
      currentVersion: app.getVersion(),
      cachePath: path.join(app.getPath("userData"), "update-check.json"),
      // Electron's fetch uses the system proxy settings; it needs the app
      // to be ready, which every check is.
      fetch: (url, init) => net.fetch(url, init),
      logger: require("./src/core/logger").createServiceLogger("UPDATES"),
      enabled: isUpdateCheckEnabled(process.env),
    });
    // Held so the click handler is not garbage collected with it.
    this.updateNotification = null;
    // Last speech error shown in the answer window, to avoid repeats.
    this._lastSpeechError = { message: "", at: 0 };
    // webContents id -> reload times, for crashed-window recovery.
    this._rendererReloads = new Map();

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "Cuewell" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());
    app.on("before-quit", (event) => this.onBeforeQuit(event));

    this.setupCrashRecovery();
    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        // During first-run setup the wizard is the window to bring back
        // (showOnboarding opens it again if it was closed).
        if (this.isFirstRun) {
          // Still starting: startup opens the wizard itself.
          if (!this.isReady) return;
          windowManager.showOnboarding().catch((e) => {
            logger.warn("Could not show the onboarding window", { error: e.message });
          });
          return;
        }

        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // The UI is dark-only: make native materials (vibrancy) render dark.
    try {
      nativeTheme.themeSource = "dark";
    } catch (e) {
      logger.warn("Failed to set dark native theme", { error: e.message });
    }

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();
      this.setupApplicationMenu();
      this.watchSystemShutdown();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding;
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      this.setupGlobalShortcuts();

      // App icon and name: the one saved in Settings (APP_ICON), else the
      // default Terminal disguise.
      const savedIcon = normalizeAppIconKey(String(process.env.APP_ICON || "").trim());
      this.updateAppIcon(APP_ICON_KEYS.includes(savedIcon) ? savedIcon : "terminal");
      this.setupTray();

      this.starting = false;
      this.isReady = true;

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fall back to Settings, where the same keys can be entered.
            try { windowManager.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
      this.scheduleLaunchUpdateCheck();
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
        stack: error.stack,
      });
      // Say why the app is closing instead of quitting without a word.
      try {
        dialog.showErrorBox(
          "Cuewell could not start",
          `Something went wrong while starting: ${error.message}\n\n` +
          `Try opening Cuewell again. If this keeps happening, the log files in ${this.logsFolder()} have the details.`
        );
      } catch (_) { /* quitting anyway */ }
      app.quit();
    }
  }

  /**
   * Menu bar (see src/core/app-menu.js). Packaged builds have no Reload or
   * Developer Tools; source runs get a Developer menu with them.
   */
  setupApplicationMenu() {
    try {
      const template = buildAppMenuTemplate({
        platform: process.platform,
        isPackaged: app.isPackaged,
        ...this.menuOptions(),
      });
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } catch (e) {
      logger.warn("Failed to set the application menu", { error: e.message });
    }
  }

  /** What the menus need: which optional items exist, and what each item does. */
  menuOptions() {
    return {
      updatesConfigured: this.updateChecker.isConfigured(),
      reportConfigured: !!this.problemReportUrl(),
      isShortcutRegistered: (accelerator) => {
        try {
          return globalShortcut.isRegistered(accelerator);
        } catch (_) {
          return false;
        }
      },
      actions: {
        about: () => this.showAbout(),
        checkForUpdates: () => this.checkForUpdatesNow(),
        settings: () => this.showSettings(),
        quit: () => this.quitApp(),
        reportProblem: () => this.reportProblem(),
        openLogsFolder: () => this.openLogsFolder(),
        toggleWindows: () => windowManager.toggleVisibility(),
        toggleChat: () => windowManager.switchToWindow("chat"),
      },
    };
  }

  /**
   * Menu bar icon (macOS) or tray icon (Windows, Linux). The overlay has no
   * Dock icon or taskbar button, so this is how the app is always reachable.
   * A desktop without a tray only loses the icon; it is logged.
   */
  setupTray() {
    if (this.tray) return;
    this.tray = new AppTray({
      electron: { Tray, Menu, nativeImage },
      platform: process.platform,
      appRoot: __dirname,
      logger,
      // macOS: keep the overlay from covering the menu while it is open.
      onMenuOpen: () => windowManager.setOverlayBelowMenus(true),
      onMenuClose: () => windowManager.setOverlayBelowMenus(false),
      getMenuOptions: () => ({
        appName: this.appDisplayName,
        updatesConfigured: this.updateChecker.isConfigured(),
        setupNeeded: this.isFirstRun,
        screenShared: !!windowManager.isScreenBeingShared,
        isShortcutRegistered: (accelerator) => this.isGlobalShortcutWorking(accelerator),
        actions: {
          toggleWindows: () => windowManager.toggleVisibility(),
          screenshot: () => setTimeout(() => this.triggerScreenshotOCR(), TRAY_SCREENSHOT_DELAY_MS),
          openChat: () => windowManager.showChatWindow(),
          settings: () => this.showSettings(),
          checkForUpdates: () => this.checkForUpdatesNow(),
          finishSetup: () => {
            windowManager.showOnboarding().catch((e) => {
              logger.warn("Could not show the onboarding window", { error: e.message });
            });
          },
          quit: () => this.quitApp(),
        },
      }),
    });
    if (!this.tray.create()) this.tray = null;
  }

  /** True when `accelerator` is a global shortcut that registered. */
  isGlobalShortcutWorking(accelerator) {
    if (!this.globalShortcutStatus || !this.globalShortcutStatus[accelerator]) return false;
    try {
      return globalShortcut.isRegistered(accelerator);
    } catch (_) {
      return false;
    }
  }

  /** Open Settings and send it the current values. */
  showSettings() {
    windowManager.showSettings();
    const settingsWindow = windowManager.getWindow("settings");
    if (settingsWindow) {
      const currentSettings = this.getSettings("settings");
      setTimeout(() => {
        if (!settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }
      }, 100);
    }
  }

  /** Quit from the menus, the tray or Settings. onBeforeQuit does the rest. */
  quitApp() {
    logger.info("Quit requested");
    this.isQuitting = true;
    this.armForceExit();
    try {
      app.quit();
    } catch (error) {
      logger.error("Error during quit", { error: error.message });
      process.exit(1);
    }
  }

  /**
   * On shutdown, restart or log out, quit at once: delaying the quit (as
   * onBeforeQuit does to let Settings save) would make macOS cancel the log
   * out. Settings already saves when it loses focus.
   */
  watchSystemShutdown() {
    try {
      powerMonitor.on("shutdown", () => {
        logger.info("System is shutting down; quitting without waiting");
        this.isQuitting = true;
        this._quitPrepared = true;
        try {
          globalShortcut.unregisterAll();
          windowManager.destroyAllWindows();
        } catch (_) { /* quitting anyway */ }
        app.quit();
      });
    } catch (e) {
      logger.debug("Shutdown events are not available here", { error: e.message });
    }
  }

  /** Exit anyway if quitting stalls (a window that will not close, a hung page). */
  armForceExit() {
    if (this._quitForceExitTimer) return;
    this._quitForceExitTimer = setTimeout(() => {
      logger.warn("Quit did not finish in time; exiting");
      process.exit(0);
    }, QUIT_FORCE_EXIT_MS);
  }

  /**
   * Every quit (Cmd+Q, the menus, the tray, Settings, the Dock, logging out)
   * comes here first. The quit waits until Settings has saved anything still
   * pending, at most QUIT_FLUSH_TIMEOUT_MS, then closes the windows and
   * quits for real. The overlay windows cannot be closed by the user
   * (closable: false), which on macOS would cancel a plain app.quit(), so
   * they are destroyed here.
   */
  onBeforeQuit(event) {
    this.isQuitting = true;
    if (this._quitPrepared) return;
    event.preventDefault();
    if (this._quitPreparing) return;
    this._quitPreparing = true;
    this.armForceExit();
    this.flushSettingsBeforeQuit()
      .then((outcome) => logger.info("Quitting", { settingsFlush: outcome }))
      .catch((error) => logger.warn("Settings flush before quit failed", { error: error.message }))
      .finally(() => {
        this._quitPrepared = true;
        this._quitPreparing = false;
        try {
          globalShortcut.unregisterAll();
          windowManager.destroyAllWindows();
        } catch (error) {
          logger.warn("Could not close the windows before quitting", { error: error.message });
        }
        app.quit();
      });
  }

  /**
   * Ask the Settings page to save what is still pending and wait for its ack
   * (flush-before-quit-done) or QUIT_FLUSH_TIMEOUT_MS, whichever comes
   * first. Resolves with "saved", "timeout", "no-settings" or "gone".
   */
  flushSettingsBeforeQuit() {
    const win = windowManager.getWindow("settings");
    const contents = win && !win.isDestroyed() ? win.webContents : null;
    if (!contents || contents.isDestroyed() || contents.isLoading() ||
        (typeof contents.isCrashed === "function" && contents.isCrashed())) {
      return Promise.resolve("no-settings");
    }
    return new Promise((resolve) => {
      const id = ++this._quitFlushSeq;
      let timer = null;
      const finish = (outcome) => {
        if (!this._quitFlushWaiter || this._quitFlushWaiter.id !== id) return;
        this._quitFlushWaiter = null;
        clearTimeout(timer);
        try { contents.removeListener("destroyed", onGone); } catch (_) { /* already gone */ }
        resolve(outcome);
      };
      const onGone = () => finish("gone");
      this._quitFlushWaiter = { id, finish };
      timer = setTimeout(() => finish("timeout"), QUIT_FLUSH_TIMEOUT_MS);
      contents.once("destroyed", onGone);
      try {
        contents.send("flush-before-quit", { id });
      } catch (_) {
        finish("gone");
      }
    });
  }

  logsFolder() {
    return require("./src/core/logger").logDir;
  }

  showAbout() {
    const version = app.getVersion();
    const author = "By Ankit Chaudhary";
    const license = "Released under the Apache License 2.0.";
    const credits = "Based on OpenCluely by TechyCSR.";
    try {
      if (process.platform === "win32") {
        // Windows has no native about panel: use a message box.
        dialog.showMessageBox({
          type: "info",
          title: "About Cuewell",
          message: `Cuewell ${version}`,
          detail: `${author}\n${license}\n${credits}`,
          buttons: ["OK"],
          noLink: true,
        }).catch((e) => logger.warn("About box failed", { error: e.message }));
        return;
      }
      const iconPath = path.join(__dirname, "assests", "icons", "app-icon.png");
      app.setAboutPanelOptions({
        // Set every time: the app icon setting changes the app's name.
        applicationName: "Cuewell",
        applicationVersion: version,
        // macOS: no build number in parentheses.
        version: "",
        copyright: `${author}. ${license}`,
        credits,
        authors: ["Ankit Chaudhary"],
        ...(isRepoConfigured(UPDATE_REPO) ? { website: `https://github.com/${UPDATE_REPO}` } : {}),
        ...(fs.existsSync(iconPath) ? { iconPath } : {}),
      });
      app.showAboutPanel();
    } catch (e) {
      logger.warn("Could not show the About panel", { error: e.message });
    }
  }

  /** Open a GitHub release page in the browser. Anything else opens the releases page. */
  openReleasePage(url) {
    const target = isSafeReleaseUrl(url, UPDATE_REPO) ? url : releasesPageUrl(UPDATE_REPO);
    shell.openExternal(target).catch((e) => {
      logger.warn("Could not open the release page", { error: e.message });
    });
  }

  /**
   * Launch check: at most once per 24 hours, silent unless an update exists.
   * Skipped while UPDATE_REPO is the placeholder or UPDATE_CHECKS=off.
   */
  scheduleLaunchUpdateCheck() {
    if (!this.updateChecker.isConfigured() || !isUpdateCheckEnabled(process.env)) {
      logger.debug("Automatic update check skipped", {
        configured: this.updateChecker.isConfigured(),
        enabled: isUpdateCheckEnabled(process.env),
      });
      return;
    }
    setTimeout(async () => {
      try {
        const result = await this.updateChecker.checkIfDue();
        if (result && result.status === "available") this.showUpdateNotification(result);
      } catch (e) {
        logger.debug("Automatic update check failed", { error: e.message });
      }
    }, LAUNCH_UPDATE_CHECK_DELAY_MS);
  }

  showUpdateNotification(result) {
    // Notifications are not hidden from screen sharing like the windows are.
    if (windowManager.isScreenBeingShared) {
      logger.info("Update notification skipped while the screen is shared", { latestVersion: result.latestVersion });
      return;
    }
    try {
      if (!Notification.isSupported()) {
        logger.info("Update available; notifications are not supported here", { latestVersion: result.latestVersion });
        return;
      }
      const notification = new Notification({
        title: `Cuewell ${result.latestVersion} is available`,
        body: "Click to open the download page.",
        silent: true,
      });
      notification.on("click", () => this.openReleasePage(result.releaseUrl));
      notification.on("close", () => {
        if (this.updateNotification === notification) this.updateNotification = null;
      });
      this.updateNotification = notification;
      notification.show();
    } catch (e) {
      logger.warn("Could not show the update notification", { error: e.message });
    }
  }

  /** Check for Updates…: always asks GitHub (UPDATE_CHECKS only turns off the automatic check) and says what it found. */
  async checkForUpdatesNow() {
    const result = await this.updateChecker.check();
    const current = app.getVersion();
    let options;
    if (result.status === "available") {
      options = {
        type: "info",
        message: "Update available",
        detail: `Cuewell ${result.latestVersion} is available. You have ${current}.`,
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      };
    } else if (result.status === "up-to-date") {
      options = {
        type: "info",
        message: "You're up to date",
        detail: `Cuewell ${current} is the latest version.`,
        buttons: ["OK"],
      };
    } else if (result.status === "not-configured") {
      return;
    } else {
      logger.warn("Update check failed", { error: result.error });
      options = {
        type: "warning",
        message: "Could not check for updates",
        detail: "Check your internet connection and try again.",
        buttons: ["OK"],
      };
    }
    try {
      const { response } = await dialog.showMessageBox({ title: "Check for Updates", noLink: true, ...options });
      if (result.status === "available" && response === 0) this.openReleasePage(result.releaseUrl);
    } catch (e) {
      logger.warn("Could not show the update dialog", { error: e.message });
    }
  }

  /** Prefilled new-issue page, or null while UPDATE_REPO is the placeholder. */
  problemReportUrl() {
    return buildProblemReportUrl(UPDATE_REPO, {
      appVersion: app.getVersion(),
      platform: process.platform,
      osVersion: typeof process.getSystemVersion === "function" ? process.getSystemVersion() : "",
      arch: process.arch,
      electronVersion: process.versions.electron,
    });
  }

  reportProblem() {
    const url = this.problemReportUrl();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return;
    } catch (_) {
      return;
    }
    shell.openExternal(url).catch((e) => {
      logger.warn("Could not open the problem report page", { error: e.message });
    });
  }

  async openLogsFolder() {
    const dir = this.logsFolder();
    let problem = "";
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      problem = await shell.openPath(dir);
    } catch (e) {
      problem = e.message;
    }
    if (!problem) return;
    logger.warn("Could not open the logs folder", { error: problem });
    try {
      await dialog.showMessageBox({
        type: "warning",
        title: "View Logs Folder",
        message: "Could not open the logs folder",
        detail: `The logs are in ${dir}`,
        buttons: ["OK"],
        noLink: true,
      });
    } catch (_) { /* nothing else to show */ }
  }

  /**
   * A crashed or killed window would stay blank: log it and reload the page
   * (same file, same preload), at most a few times a minute so a page that
   * crashes on load does not loop.
   */
  setupCrashRecovery() {
    app.on("render-process-gone", (_event, webContents, details) => {
      const reason = details && details.reason;
      if (this.isQuitting || reason === "clean-exit") return;
      const type = windowManager.getWindowTypeForWebContents(webContents) || "unknown";
      logger.error("Window process stopped", { windowType: type, reason, exitCode: details && details.exitCode });
      if (type === "unknown" || !webContents || webContents.isDestroyed()) return;
      const now = Date.now();
      const history = this._rendererReloads.get(webContents.id);
      if (history === "gave-up") return;
      const recent = (history || []).filter((t) => now - t < 60000);
      if (recent.length >= MAX_RENDERER_RELOADS_PER_MINUTE) {
        // Reloading again would only crash again; leave it for a restart.
        this._rendererReloads.set(webContents.id, "gave-up");
        logger.error("Window keeps stopping; not reloading it again", { windowType: type });
        dialog.showMessageBox({
          type: "warning",
          title: "Cuewell",
          message: "A Cuewell window stopped working",
          detail: "Quit Cuewell and open it again.",
          buttons: ["OK"],
          noLink: true,
        }).catch(() => { /* logged above */ });
        return;
      }
      recent.push(now);
      this._rendererReloads.set(webContents.id, recent);
      setTimeout(() => {
        try {
          if (!webContents.isDestroyed()) webContents.reload();
        } catch (e) {
          logger.warn("Could not reload the window", { windowType: type, error: e.message });
        }
      }, 500);
    });
    app.on("child-process-gone", (_event, details) => {
      if (this.isQuitting || !details || details.reason === "clean-exit") return;
      logger.warn("Helper process stopped", { type: details.type, reason: details.reason, name: details.name });
    });
  }

  setupPermissions() {
    const appSession = session.defaultSession;
    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) {
        return false;
      }
      try {
        const pagePath = path.resolve(fileURLToPath(webContents.getURL()));
        const appRoot = path.resolve(__dirname);
        const normalizeForComparison = (value) => process.platform === "win32"
          ? value.toLowerCase()
          : value;
        const page = normalizeForComparison(pagePath);
        const root = normalizeForComparison(appRoot + path.sep);
        return page.startsWith(root);
      } catch (_) {
        return false;
      }
    };

    // Electron exposes camera/microphone access as the single `media`
    // permission. The requested device type is provided separately in details.
    appSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details = {}) => {
        if (!isTrustedAppContents(webContents)) {
          return false;
        }
        if (permission === "media") {
          return !details.mediaType || details.mediaType === "audio";
        }
        return permission === "display-capture";
      }
    );

    appSession.setPermissionRequestHandler(
      (webContents, permission, callback, details = {}) => {
        let granted = false;
        if (isTrustedAppContents(webContents)) {
          if (permission === "media") {
            const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
            granted = mediaTypes.length === 0 || mediaTypes.includes("audio");
          } else {
            granted = permission === "display-capture";
          }
        }

        logger.debug("Permission request", {
          permission,
          mediaTypes: details.mediaTypes || [],
          granted
        });
        callback(granted);
      }
    );
  }

  setupGlobalShortcuts() {
    // Global shortcuts work in every app, so they only use combinations that
    // editors and browsers leave alone. Cmd/Ctrl+arrows (line and word jumps)
    // and Cmd/Ctrl+, (every app's Settings) would be swallowed system-wide,
    // so they are registered only while one of this app's windows has focus.
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
    };

    // accelerator -> whether it registered, for the Settings shortcuts table
    // and the tray menu. register() returns false when another app owns the
    // keys, and can throw where the system refuses global shortcuts (some
    // Wayland desktops); either way the shortcut is marked as not working
    // and the app carries on.
    this.globalShortcutStatus = {};
    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      let success = false;
      let error = null;
      try {
        success = !!globalShortcut.register(accelerator, handler);
      } catch (e) {
        error = e.message;
      }
      this.globalShortcutStatus[accelerator] = success;
      if (success) {
        logger.debug("Global shortcut registered", { accelerator });
      } else {
        logger.warn("Global shortcut unavailable", {
          accelerator,
          reason: error || "another app owns it, or the system does not allow it",
        });
      }
    });

    this.setupFocusShortcuts();
  }

  /**
   * Shortcuts that only apply while a Cuewell window is focused.
   * They are registered on focus and released as soon as focus leaves the
   * app, so other apps keep these keys.
   */
  setupFocusShortcuts() {
    // accelerator -> false once registering it failed; true once it worked.
    this.focusShortcutStatus = {};
    this.focusShortcuts = {
      "CommandOrControl+,": () => windowManager.showSettings(),
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };
    this.focusShortcutsActive = false;

    // Not while Settings has focus: its text fields need Cmd/Ctrl+arrows for
    // moving the caret, and it is already open.
    const wanted = () => {
      const focused = BrowserWindow.getFocusedWindow();
      return !!focused && focused !== windowManager.getWindow("settings");
    };
    app.on("browser-window-focus", () => this.setFocusShortcutsActive(wanted()));
    app.on("browser-window-blur", () => {
      // Focus may be moving to another window of this app; check after the
      // focus change has settled.
      setTimeout(() => {
        this.setFocusShortcutsActive(wanted());
      }, 0);
    });
    this.setFocusShortcutsActive(wanted());
  }

  setFocusShortcutsActive(active) {
    if (!this.focusShortcuts || active === this.focusShortcutsActive) return;
    this.focusShortcutsActive = active;
    Object.entries(this.focusShortcuts).forEach(([accelerator, handler]) => {
      try {
        if (active) {
          const success = !!globalShortcut.register(accelerator, handler);
          if (!success && this.focusShortcutStatus[accelerator] !== false) {
            logger.warn("Shortcut unavailable while Cuewell has focus", { accelerator });
          }
          this.focusShortcutStatus[accelerator] = success;
        } else if (globalShortcut.isRegistered(accelerator)) {
          globalShortcut.unregister(accelerator);
        }
      } catch (e) {
        if (active) {
          if (this.focusShortcutStatus[accelerator] !== false) {
            logger.warn("Shortcut unavailable while Cuewell has focus", { accelerator, reason: e.message });
          }
          this.focusShortcutStatus[accelerator] = false;
        }
      }
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      windowManager.handleRecordingStarted();
    });

    speechService.on("recording-stopped", () => {
      windowManager.handleRecordingStopped();
    });

    speechService.on("transcription", (text) => {
      this.handleTranscriptionFragment(text);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      this.reportSpeechError(friendlySpeechError(typeof error === "string" ? error : error && error.message));
    });
  }

  /**
   * Show a speech problem. Chat lists speech-error events. When chat is
   * hidden the message still has to be seen, so pressing the mic (or Alt+R)
   * never fails without a word: it goes to the answer window when that is
   * hidden, otherwise chat is shown without taking focus, so an answer on
   * screen is never replaced by an error.
   */
  reportSpeechError(message) {
    const available = this.speechAvailable;
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send("speech-error", { error: message, available });
    });
    const chat = windowManager.getWindow("chat");
    if (chat && !chat.isDestroyed() && chat.isVisible()) return;
    if (windowManager.isScreenBeingShared) return;
    const now = Date.now();
    if (this._lastSpeechError.message === message && now - this._lastSpeechError.at < SPEECH_ERROR_REPEAT_MS) return;
    this._lastSpeechError = { message, at: now };
    const answer = windowManager.getWindow("llmResponse");
    if (answer && !answer.isDestroyed() && answer.isVisible()) {
      if (chat && !chat.isDestroyed()) windowManager.showOnCurrentDesktop(chat, { focus: false });
      return;
    }
    windowManager.showLLMResponse(message, { skill: this.activeSkill, isError: true });
  }

  /** The reason voice input cannot use the microphone, or null when the OS allows it (or cannot tell). */
  microphoneProblem() {
    if (process.platform !== "darwin" && process.platform !== "win32") return null;
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return isMediaAccessBlocked(status) ? microphoneBlockedMessage(process.platform) : null;
    } catch (_) {
      return null;
    }
  }

  /** Start voice input unless the OS blocks the microphone; then say how to allow it. */
  startSpeech() {
    const problem = this.microphoneProblem();
    if (problem) {
      logger.warn("Voice input not started: microphone access is blocked");
      this.reportSpeechError(problem);
      return false;
    }
    speechService.startRecording();
    return true;
  }

  /**
   * Window type ('main', 'chat', 'llmResponse', 'settings', 'onboarding')
   * that sent an IPC message, or null when it is not one of the app's
   * windows, not their top frame, or not on an app page.
   */
  windowTypeForSender(event) {
    const sender = event && event.sender;
    if (!sender || (typeof sender.isDestroyed === "function" && sender.isDestroyed())) return null;
    // Only the page itself, never a subframe inside it.
    const frame = event.senderFrame;
    if (!frame || frame.parent) return null;
    const type = windowManager.getWindowTypeForWebContents(sender);
    if (!type) return null;
    try {
      if (!windowManager.isAppPageUrl(sender.getURL(), type)) return null;
    } catch (_) {
      return null;
    }
    return type;
  }

  /** The sender's window type when it may use `channel`; logs and returns null otherwise. */
  authorizeIpc(channel, event) {
    const allowed = IPC_ALLOWED_WINDOWS[channel];
    const type = this.windowTypeForSender(event);
    if (allowed && type && allowed.includes(type)) return type;
    logger.warn("Rejected IPC message from a window not allowed to use this channel", {
      channel,
      windowType: type || "unknown",
      allowed: allowed || [],
    });
    return null;
  }

  /** ipcMain.handle that only runs for the windows in IPC_ALLOWED_WINDOWS[channel]. */
  handleIpc(channel, handler) {
    if (!IPC_ALLOWED_WINDOWS[channel]) throw new Error(`No window list for IPC channel ${channel}`);
    ipcMain.handle(channel, (event, ...args) => {
      if (!this.authorizeIpc(channel, event)) {
        throw new Error(`IPC channel "${channel}" is not available to this window`);
      }
      return handler(event, ...args);
    });
  }

  /** ipcMain.on that only runs for the windows in IPC_ALLOWED_WINDOWS[channel]. */
  onIpc(channel, handler) {
    if (!IPC_ALLOWED_WINDOWS[channel]) throw new Error(`No window list for IPC channel ${channel}`);
    ipcMain.on(channel, (event, ...args) => {
      if (!this.authorizeIpc(channel, event)) return;
      handler(event, ...args);
    });
  }

  setupIPCHandlers() {
    this.handleIpc("take-screenshot", () => this.triggerScreenshotOCR());

    // Provide reliable clipboard write via main process. clipboard.writeText
    // returns a Promise since Electron 44, so failures arrive as rejections.
    this.handleIpc("copy-to-clipboard", async (event, text) => {
      try {
        const { clipboard } = require("electron");
        await clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });

    this.handleIpc("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    this.handleIpc("start-speech-recognition", () => {
      this.startSpeech();
      return speechService.getStatus();
    });

    this.handleIpc("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Raw PCM audio captured by the renderer's Web Audio API (Windows Whisper path)
    this.onIpc("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        speechService.handleAudioChunkFromRenderer(Buffer.from(data.buffer));
      }
    });

    this.onIpc("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    this.handleIpc("resize-window", (event, size) => {
      const { width, height } = size || {};
      if (typeof width !== "number" || typeof height !== "number" ||
          !Number.isFinite(width) || !Number.isFinite(height)) {
        return { success: false, error: "width and height must be numbers" };
      }
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width.
        // Height covers the bar plus the open shortcuts popover.
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width)));
        const clampedHeight = Math.max(1, Math.min(MAX_MAIN_WINDOW_HEIGHT, Math.round(height)));
        try {
          // Match content size to the DOM so no extra transparent area remains
          mainWindow.setContentSize(clampedWidth, clampedHeight);
        } catch (e) {
          // Fallback in case setContentSize isn’t available on some platform
          mainWindow.setSize(clampedWidth, clampedHeight);
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height: clampedHeight });
      }
      return { success: true };
    });

    this.handleIpc("move-window", (event, delta) => {
      const { deltaX, deltaY } = delta || {};
      if (typeof deltaX !== "number" || typeof deltaY !== "number" ||
          !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        return { success: false, error: "deltaX and deltaY must be numbers" };
      }
      const clampDelta = (d) => Math.max(-MAX_MOVE_DELTA, Math.min(MAX_MOVE_DELTA, Math.round(d)));
      const dx = clampDelta(deltaX);
      const dy = clampDelta(deltaY);
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + dx;
        const newY = currentY + dy;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX: dx,
          deltaY: dy,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    this.handleIpc("send-chat-message", async (event, text) => {
      if (typeof text !== "string" || !text.trim()) {
        return { success: false, error: "Message must be non-empty text" };
      }
      if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
        return { success: false, error: "Message is too long" };
      }
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });

      // Typed messages need the full skill pipeline (with history context),
      // NOT the voice "intelligent filter" pipeline. Voice keeps its filter
      // behaviour; typed chat goes through processWithLLM so it gets real
      // answers using the active skill prompt and recent conversation history.
      (async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            textLength: text.length
          });
          // processWithLLM reports its own errors; this is a failure before
          // it ran, so chat would otherwise wait forever.
          this.broadcastLLMError(friendlyLlmError(""), null);
        }
      })();

      return { success: true };
    });

    this.handleIpc("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    // Settings handlers. The page loads its own values when it is shown
    // (settings-window-shown -> get-settings).
    this.handleIpc("show-settings", () => {
      this.showSettings();
      return { success: true };
    });

    this.handleIpc("get-settings-info", () => this.getSettingsInfo());

    this.handleIpc("remove-secret", (_event, field) => this.removeSecret(field));

    this.handleIpc("get-whisper-status", () => this.getWhisperStatus());

    // The toolbar's pop-up app menu: the menu bar's commands, which Windows
    // and Linux cannot reach otherwise. Optional { x, y } in window pixels.
    this.handleIpc("show-app-menu", (event, position) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { success: false };
      const coord = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10000 ? Math.round(v) : undefined);
      const x = coord(position && position.x);
      const y = coord(position && position.y);
      try {
        const menu = Menu.buildFromTemplate(buildToolbarMenuTemplate(this.menuOptions()));
        // macOS: the overlay windows sit above menus; lower them while it is open.
        windowManager.setOverlayBelowMenus(true);
        menu.popup({
          window: win,
          ...(x !== undefined && y !== undefined ? { x, y } : {}),
          callback: () => windowManager.setOverlayBelowMenus(false),
        });
        return { success: true };
      } catch (e) {
        windowManager.setOverlayBelowMenus(false);
        logger.warn("Could not show the app menu", { error: e.message });
        return { success: false };
      }
    });

    this.handleIpc("get-settings", (event) => {
      return this.getSettings(this.windowTypeForSender(event));
    });

    // First-run onboarding status. The wizard uses it to mark a Gemini key
    // that is already saved; the key itself is only returned masked.
    this.handleIpc("get-first-run-status", () => {
      try {
        return {
          ...this.firstRunManager.getStatus(),
          geminiKey: maskSecret(process.env.GEMINI_API_KEY),
        };
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    this.handleIpc("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        if (this.tray) this.tray.refresh();
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    this.handleIpc("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Detect an installed Whisper CLI across common locations.
    this.handleIpc("detect-whisper", async () => {
      try {
        const installer = this.getWhisperInstaller();
        return await installer.detect();
      } catch (e) {
        logger.warn("Whisper detection failed", { error: e.message });
        return { found: false, command: null, version: null, error: e.message };
      }
    });

    // Install Whisper. Streams progress lines back via `webContents.send`
    // so the renderer can paint them as they arrive.
    this.handleIpc("install-whisper", async (event) => {
      // One Whisper install or download at a time (the wizard and Settings
      // can both start one).
      if (this._whisperJob) {
        return { ok: false, command: null, message: "Whisper setup is already running. Wait for it to finish.", logs: "" };
      }
      this._whisperJob = "install";
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.install({
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper install failed", { error: e.message });
        return { ok: false, command: null, message: e.message, logs: "" };
      } finally {
        this._whisperJob = null;
      }
    });

    // Download Whisper model. Streams progress lines back via `webContents.send`
    this.handleIpc("download-whisper-model", async (event, modelName) => {
      const name = modelName === undefined || modelName === null || modelName === "" ? "small" : modelName;
      if (typeof name !== "string" || !isWhisperModelName(name)) {
        return { ok: false, message: "Invalid Whisper model name", path: null };
      }
      if (this._whisperJob) {
        return { ok: false, message: "Whisper setup is already running. Wait for it to finish.", path: null };
      }
      this._whisperJob = "download";
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.downloadModel(name, {
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper model download failed", { error: e.message });
        return { ok: false, message: e.message, path: null };
      } finally {
        this._whisperJob = null;
      }
    });

    // Built-in voice engine (whisper.cpp). Ids are checked against
    // whisperModels.MODELS; the renderer never names a file or folder.
    this.handleIpc("get-voice-status", () => this.getVoiceStatus());
    this.handleIpc("download-voice-model", (event, input) => this.downloadVoiceModel(event, input));
    this.handleIpc("cancel-voice-model-download", (_event, input) => this.cancelVoiceModelDownload(input));
    this.handleIpc("set-voice-engine", (_event, input) => this.setVoiceEngine(input));

    // Test an AI provider from the wizard or Settings without saving it or
    // changing the running provider.
    this.handleIpc("test-provider", (_event, input) => this.testProvider(input));

    this.handleIpc("save-settings", (event, settings) => {
      return this.saveSettings(settings, this.windowTypeForSender(event));
    });

    this.handleIpc("update-active-skill", (event, skill) => {
      if (!isInterviewMode(skill)) {
        return { success: false, error: "Invalid skill" };
      }
      this.setActiveMode(skill);
      return { success: true };
    });

    this.handleIpc("get-profile", () => {
      // limits: interview context fields; aboutLimits: About you text fields.
      return {
        success: true,
        profile: { ...this.profile },
        limits: profileStore.PROFILE_FIELD_LIMITS,
        aboutLimits: profileStore.ABOUT_FIELD_LIMITS,
      };
    });

    this.handleIpc("save-profile", (event, profile) => {
      try {
        this.profile = profileStore.writeProfile(this.profilePath, profile);
      } catch (error) {
        if (error instanceof profileStore.ProfileValidationError) {
          logger.warn("Interview context rejected", { field: error.field, reason: error.message });
          return { success: false, error: error.message, field: error.field };
        }
        logger.error("Failed to save interview context", { error: error.message });
        return { success: false, error: "Could not save your details to this computer. Try again." };
      }
      llmService.setPromptContext({ profile: this.profile });
      // Field names only: the values are personal data.
      logger.info("Interview context saved", {
        fields: Object.keys(this.profile).filter((field) => this.profile[field]),
      });
      return { success: true, profile: { ...this.profile } };
    });

    this.handleIpc("close-window", (event) => {
      const webContents = event.sender;
      windowManager.windows.forEach((win) => {
        if (!win.isDestroyed() && win.webContents === webContents) {
          win.hide();
        }
      });
      return { success: true };
    });

    // The answer page reports each state it has drawn ({ phase, seq, height }).
    // The window manager validates it, reveals a window waiting for its first
    // frame and fits the height once per final answer.
    this.handleIpc("resize-llm-window-for-content", (event, report) => {
      return windowManager.handleAnswerContentReport(report);
    });

    // Handle close settings
    this.onIpc("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Settings saved what was pending after flush-before-quit.
    this.onIpc("flush-before-quit-done", (_event, id) => {
      const waiter = this._quitFlushWaiter;
      if (waiter && id === waiter.id) waiter.finish("saved");
    });

    this.onIpc("quit-app", () => {
      logger.info("Quit app requested via IPC");
      this.quitApp();
    });
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
        // Alt+R works even when the mic buttons are hidden: say why nothing happens.
        const reason = typeof speechService.getUnavailableReason === "function" ? speechService.getUnavailableReason() : "";
        this.reportSpeechError(reason || friendlySpeechError(`Speech provider "${speechService.provider || "none"}" is not available`));
      } catch (e) {
        logger.warn("Could not report that voice input is unavailable", { error: e.message });
      }
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        speechService.stopRecording();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
        this.reportSpeechError(friendlySpeechError(""));
      }
    } else {
      try {
        // Chat first, so a start error lands in the window the user sees.
        windowManager.showChatWindow();
        if (this.startSpeech()) {
          logger.info("Speech recognition started via global shortcut");
        }
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
        this.reportSpeechError(friendlySpeechError(`Speech recognition failed to start: ${error.message}`));
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = promptLoader.getAvailableSkills();

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    this.setActiveMode(newSkill);
  }

  /**
   * Switch the interview mode: update the session, persist it to .env as
   * INTERVIEW_MODE and tell every window. `mode` must be a known mode id.
   */
  setActiveMode(mode) {
    if (!isInterviewMode(mode)) return false;
    const changed = mode !== this.activeSkill;
    this.activeSkill = mode;
    if (changed) {
      sessionManager.setActiveSkill(mode);
    }
    if (process.env.INTERVIEW_MODE !== mode) {
      this.persistEnvUpdates({ INTERVIEW_MODE: mode });
    }
    // The toolbar listens to both; the settings window to skill-updated.
    windowManager.broadcastToAllWindows("skill-updated", { skill: mode });
    windowManager.broadcastToAllWindows("skill-changed", { skill: mode });
    return true;
  }

  /** The saved interview context, or an empty one when there is none or it cannot be read. */
  loadProfile() {
    const { profile, error } = profileStore.readProfile(this.profilePath);
    if (error) logger.warn("Could not read the interview context; using an empty one", { error });
    return profile;
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();
    // Hoisted so the catch block can end the stream the start event opened.
    let messageId = null;

    try {
      // Capture first: on Linux windows can't be hidden from capture, so a
      // loading window shown before it would be in the screenshot.
      let capture;
      try {
        capture = await captureService.captureAndProcess();
        if (!capture || !capture.imageBuffer || !capture.imageBuffer.length) {
          throw new Error("Failed to capture screenshot image");
        }
      } catch (error) {
        const captureError = error instanceof Error ? error : new Error(String(error));
        captureError.isCaptureError = true;
        throw captureError;
      }

      // Use image directly with LLM and active skill; do not send chat messages here
      const sessionHistory = sessionManager.getOptimizedHistory();

      // Auto and Coding take the coding language.
      const needsProgrammingLanguage = promptLoader.requiresProgrammingLanguage(this.activeSkill);

      // The start event goes out before show-loading, as in the chat and
      // voice paths, so the answer window knows which request it is waiting
      // for before any chunk can arrive.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `img-${Date.now()}-${this._responseSeq}`;
      this.sendToAnswerWindows("transcription-llm-response-start", {
        messageId,
        source: "screenshot",
        skill: this.activeSkill
      });
      windowManager.showLLMLoading();

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.sendToAnswerWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        },
        // A retry or fallback starts over: clear this answer's live text.
        () => {
          this.sendToAnswerWindows("transcription-llm-response-chunk", {
            messageId,
            reset: true
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true,
        messageId
      });
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        capture: !!error.isCaptureError,
        duration: Date.now() - startTime,
      });

      const message = error.isCaptureError
        ? friendlyCaptureError(error.message, {
          platform: process.platform,
          screenAccess: this.screenAccessStatus(),
        })
        : friendlyLlmError(error.message);

      // A capture that is already running will update the response window
      // itself, so a second press must not cover it with an error.
      if (error.message !== "Capture already in progress") {
        this.showScreenshotError(message, messageId);
      }
      this.broadcastOCRError(message);
      // The answer was already announced (and may be half streamed): end
      // its chat bubble with the error instead of leaving it open.
      if (messageId) {
        this.broadcastLLMError(message, messageId);
      }
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  /**
   * Replace the response window's "Analyzing" state with a short error. That
   * window only listens for display-llm-response, so the message is sent as
   * a regular response. `message` is already user-facing.
   */
  showScreenshotError(message, messageId = null) {
    windowManager.showLLMResponse(message || "Screenshot failed.", {
      skill: this.activeSkill,
      isImageAnalysis: true,
      isError: true,
      messageId,
    });
  }

  /** macOS Screen Recording status ('granted', 'denied', ...), or undefined elsewhere. */
  screenAccessStatus() {
    if (process.platform !== "darwin") return undefined;
    try {
      return systemPreferences.getMediaAccessStatus("screen");
    } catch (_) {
      return undefined;
    }
  }

  async processWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tell chat which request failed.
    let messageId = null;
    try {
      // The send-chat-message handler has already stored `text` in session memory.

      // Check if current skill needs programming language context
      // Auto and Coding take the coding language.
      const needsProgrammingLanguage = promptLoader.requiresProgrammingLanguage(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `chat-${Date.now()}-${this._responseSeq}`;
      this.sendToAnswerWindows("transcription-llm-response-start", {
        messageId,
        source: "chat",
        skill: this.activeSkill
      });
      windowManager.showLLMLoading();

      const llmResult = await llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.sendToAnswerWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        },
        // A retry or fallback starts over: clear this answer's live text.
        () => {
          this.sendToAnswerWindows("transcription-llm-response-chunk", {
            messageId,
            reset: true
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        messageId,
      });
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      // Show why there is no answer, in the answer window and in chat.
      const message = friendlyLlmError(error.message);
      windowManager.showLLMResponse(message, {
        skill: this.activeSkill,
        isError: true,
        messageId,
      });
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(message, messageId);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    // Route speech UI events according to the user's response-target setting.
    // Session memory gets the coalesced utterance once, when it is sent.
    this.sendToVoiceResponseWindows("transcription-received", { text: fragment });

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
      this._utteranceTimer = null;
    }

    // Manual capture emits one complete transcript after the user presses stop,
    // so no debounce/coalescing delay is needed.
    if (speechService.isManualCaptureMode()) {
      this.dispatchCoalescedUtterance();
      return;
    }

    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";
    this._utteranceDispatchInFlight = true;

    try {
      // Stored here rather than per fragment: the history then holds what was
      // actually asked, once, after any answer that was still streaming, and
      // the request builder can drop it as the trailing copy of this message.
      sessionManager.addUserInput(combined, 'speech');
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        textLength: combined.length
      });
      // processTranscriptionWithLLM reports its own errors; this one came
      // before it ran.
      this.sendToVoiceResponseWindows("llm-error", {
        error: friendlyLlmError(""),
        messageId: null,
        timestamp: new Date().toISOString(),
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tie the error to the same request the
    // streaming start event announced.
    let messageId = null;
    // Read once so start, chunks and the final answer or error all go to the
    // same windows even if the setting changes mid-answer.
    const voiceTarget = this.getVoiceResponseTarget();
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          textLength: cleanText.length
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length
      });

      // Check if current skill needs programming language context
      // Auto and Coding take the coding language.
      const needsProgrammingLanguage = promptLoader.requiresProgrammingLanguage(this.activeSkill);

      // Stream the answer progressively to the configured speech target.
      // A unique messageId ties the start/chunk/final events to one bubble so
      // the UI never duplicates or interleaves concurrent responses.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this._responseSeq}`;
      this.sendToVoiceResponseWindows("transcription-llm-response-start", {
        messageId,
        source: "voice",
        skill: this.activeSkill
      }, voiceTarget);
      if (this.shouldShowVoiceOverlay(voiceTarget)) {
        windowManager.showLLMLoading();
      }
      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.sendToVoiceResponseWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          }, voiceTarget);
        },
        // A retry or fallback starts over: clear this answer's live text.
        () => {
          this.sendToVoiceResponseWindows("transcription-llm-response-chunk", {
            messageId,
            reset: true
          }, voiceTarget);
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      this.sendTranscriptionLLMResponseToVoiceTargets(llmResult, voiceTarget);
      if (this.shouldShowVoiceOverlay(voiceTarget)) {
        windowManager.showLLMResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
          isTranscriptionResponse: true,
          messageId
        });
      }

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        textLength: typeof text === 'string' ? text.length : 0
      });

      // Show why there is no answer where voice answers go. Nothing is
      // stored as a model reply, so the next question's history stays clean.
      const message = friendlyLlmError(error.message);
      this.sendToVoiceResponseWindows("llm-error", {
        error: message,
        messageId,
        timestamp: new Date().toISOString(),
      }, voiceTarget);
      if (this.shouldShowVoiceOverlay(voiceTarget)) {
        windowManager.showLLMResponse(message, {
          skill: this.activeSkill,
          isTranscriptionResponse: true,
          isError: true,
          messageId,
        });
      }

      sessionManager.addConversationEvent({
        role: 'system',
        content: `Transcription LLM processing failed: ${error.message}`,
        action: 'transcription_llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });
    }
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMError(errorMessage, messageId = null) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      messageId,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  /**
   * Streaming events (start/chunk) for typed chat and screenshots go only to
   * the two windows that render answers, not to the toolbar, settings or
   * onboarding, and without broadcastToAllWindows' per-send log line.
   */
  sendToAnswerWindows(channel, data) {
    for (const type of ["chat", "llmResponse"]) {
      const win = windowManager.getWindow(type);
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    }
  }

  sendToChatWindow(channel, data) {
    const chatWindow = windowManager.getWindow("chat");
    if (!chatWindow || chatWindow.isDestroyed()) {
      logger.warn("Chat window unavailable for speech event", { channel });
      return;
    }
    chatWindow.webContents.send(channel, data);
  }

  getVoiceResponseTarget() {
    const configured = String(process.env.WHISPER_RESPONSE_TARGET || 'both').trim().toLowerCase();
    return ['chat', 'overlay', 'both'].includes(configured) ? configured : 'both';
  }

  shouldShowVoiceOverlay(target = this.getVoiceResponseTarget()) {
    return ['overlay', 'both'].includes(target);
  }

  sendToVoiceResponseWindows(channel, data, target = this.getVoiceResponseTarget()) {
    if (target === 'chat' || target === 'both') {
      this.sendToChatWindow(channel, data);
    }
    if (target === 'overlay' || target === 'both') {
      const responseWindow = windowManager.getWindow("llmResponse");
      if (responseWindow && !responseWindow.isDestroyed()) {
        responseWindow.webContents.send(channel, data);
      }
    }
  }

  sendTranscriptionLLMResponseToVoiceTargets(llmResult, target = this.getVoiceResponseTarget()) {
    const data = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };
    this.sendToVoiceResponseWindows("transcription-llm-response", data, target);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    globalShortcut.unregisterAll();
    if (this._speechReinitTimer) {
      clearInterval(this._speechReinitTimer);
      this._speechReinitTimer = null;
    }
    // A model download stops here; its .part file is resumed next time.
    if (this._voiceDownload) {
      try { this._voiceDownload.controller.abort(); } catch (_) { /* already stopped */ }
    }
    // Also stops the whisper.cpp server process.
    speechService.shutdown();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getWhisperInstaller() {
    if (!this._whisperInstaller) {
      const WhisperInstaller = require("./src/core/whisper-installer");
      const { app } = require("electron");
      this._whisperInstaller = new WhisperInstaller({
        cwd: process.cwd(),
        dataDir: app.getPath("userData"),
        platform: process.platform,
        // Download weights into the folder transcription reads them from.
        getModelDir: () => speechService.getWhisperModelDir(),
      });
    }
    return this._whisperInstaller;
  }

  /**
   * Settings for the renderer. Secrets are only returned masked
   * ({ set, last4 }); their values never leave the main process. The toolbar
   * only gets the values it reads (language, mode and the mode list).
   */
  getSettings(windowType = "settings") {
    if (windowType === "main") {
      return {
        codingLanguage: this.codingLanguage || "cpp",
        activeSkill: this.activeSkill || promptLoader.getDefaultMode(),
        modes: promptLoader.getModes(),
      };
    }

    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    const llmSettings = {};
    for (const [field, envKey] of Object.entries(LLM_SETTING_ENV_KEYS)) {
      llmSettings[field] = SECRET_SETTING_ENV_KEYS[field]
        ? maskSecret(process.env[envKey])
        : process.env[envKey] || "";
    }

    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || promptLoader.getDefaultMode(),
      modes: promptLoader.getModes(),
      answerLength: this.answerLength || "auto",
      appIcon: this.appIcon || "cuewell",
      selectedIcon: this.appIcon || "cuewell",
      windowGap: windowManager.windowGap,

      speechProvider: speechService.provider || "whisper",
      azureKey: maskSecret(process.env.AZURE_SPEECH_KEY),
      azureRegion: process.env.AZURE_SPEECH_REGION || "",
      whisperCommand: process.env.WHISPER_COMMAND || "",
      whisperModel: process.env.WHISPER_MODEL || "small",
      whisperLanguage: process.env.WHISPER_LANGUAGE || "auto",
      whisperDevice: process.env.WHISPER_DEVICE || "auto",
      whisperCaptureMode: process.env.WHISPER_CAPTURE_MODE ||
        (process.env.WHISPER_MANUAL_CAPTURE === "true" ? "manual" : "vad"),
      whisperResponseTarget: process.env.WHISPER_RESPONSE_TARGET || "both",
      whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",
      // As saved: "" means Cuewell picks (see speech.service _initializeWhisperClient).
      whisperEngine: process.env.WHISPER_ENGINE || "",
      // The engine that choice resolves to now: whispercpp or python.
      whisperEngineEffective: speechService.getWhisperEngineState().choice || "whispercpp",
      whisperCppModel: speechService.getWhisperCppModelId(),
      geminiKey: maskSecret(process.env.GEMINI_API_KEY),
      llmProvider: getActiveProviderId(),
      llmProviders: listProviders(),
      ...llmSettings,

      azureConfigured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
      speechAvailable: this.speechAvailable
    };
  }

  /**
   * Read-only facts for the Settings window: app version, platform, whether
   * screen-capture protection exists here, every shortcut with its scope and
   * whether it registered, and where settings, the profile and logs live.
   */
  getSettingsInfo() {
    const global = this.globalShortcutStatus || {};
    const focus = this.focusShortcuts ? Object.keys(this.focusShortcuts) : [];
    const shortcuts = [
      ...Object.keys(global).map((accelerator) => ({
        accelerator, scope: "global", registered: global[accelerator],
      })),
      // Focus shortcuts are only registered while a window has focus: false
      // once registering one failed, otherwise null (not known yet).
      ...focus.map((accelerator) => ({
        accelerator,
        scope: "focus",
        registered: this.focusShortcutStatus && this.focusShortcutStatus[accelerator] === false ? false : null,
      })),
    ].map((entry) => ({ ...entry, action: SHORTCUT_ACTIONS[entry.accelerator] || "" }));
    let logs = "";
    try {
      logs = require("./src/core/logger").logDir || "";
    } catch (_) { /* shown as unknown */ }
    return {
      version: app.getVersion(),
      platform: process.platform,
      versions: {
        electron: process.versions.electron || "",
        chrome: process.versions.chrome || "",
        node: process.versions.node || "",
      },
      // setContentProtection only has an effect on macOS and Windows.
      contentProtection: process.platform === "darwin" || process.platform === "win32",
      shortcuts,
      paths: { settingsFile: ENV_PATH, profile: this.profilePath, logs },
    };
  }

  /**
   * Remove one saved secret (an API key or the Azure key). Saving an empty
   * key keeps the saved one, so this is the only way to clear it. Returns
   * { success, field }, plus { persisted: false, warning } when only the
   * running app changed, or { success: false, error }.
   */
  removeSecret(field) {
    if (typeof field !== "string" || !Object.prototype.hasOwnProperty.call(SECRET_SETTING_ENV_KEYS, field)) {
      return { success: false, error: "Unknown key." };
    }
    const envKey = SECRET_SETTING_ENV_KEYS[field];
    const persisted = this.persistEnvUpdates({ [envKey]: "" });
    // The running app picks the change up either way (process.env is updated first).
    try {
      if (field === "azureKey") {
        if (speechService.provider === "azure") {
          speechService.initializeClient();
          this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
          windowManager.broadcastToAllWindows("speech-availability", { available: this.speechAvailable });
        }
      } else {
        llmService.initializeClient();
      }
    } catch (e) {
      logger.warn("Service reinitialization after removing a key failed", { field, error: e.message });
    }
    logger.info("Saved key removed", { field, persisted: persisted.includes(envKey) });
    if (!persisted.includes(envKey)) {
      return {
        success: true,
        persisted: false,
        field,
        warning: "Removed for now, but Cuewell could not write its settings file, so the key comes back when it restarts.",
      };
    }
    return { success: true, field };
  }

  /**
   * Local Whisper status for Settings: whether a Whisper program is found
   * (and its command and version), the configured model and whether its
   * weights are already downloaded.
   */
  async getWhisperStatus() {
    let detected;
    try {
      detected = await this.getWhisperInstaller().detect();
    } catch (e) {
      logger.warn("Whisper detection failed", { error: e.message });
      detected = { found: false, command: null, version: null, error: e.message };
    }
    const model = String(process.env.WHISPER_MODEL || "small").trim() || "small";
    const fileName = WHISPER_MODEL_FILES[model] || model;
    let modelDir = "";
    let modelDownloaded = false;
    try {
      modelDir = speechService.getWhisperModelDir() || "";
      modelDownloaded = !!modelDir && isWhisperModelName(fileName) &&
        fs.existsSync(path.join(modelDir, `${fileName}.pt`));
    } catch (_) { /* reported as not downloaded */ }
    return {
      found: !!detected.found,
      command: detected.command || null,
      version: detected.version || null,
      error: detected.error || null,
      model,
      modelDownloaded,
      modelDir,
      busy: this._whisperJob || null,
    };
  }

  /**
   * Built-in voice state for Settings and onboarding. Reads files only (no
   * process, no network), so it is cheap to call whenever a page shows.
   */
  getVoiceStatus() {
    const state = speechService.getWhisperEngineState();
    const modelDir = state.modelDir;
    const download = this._voiceDownload;
    return {
      engine: state.choice,
      activeEngine: state.active,
      binaryAvailable: state.binaryAvailable,
      platformSupported: state.platformSupported,
      models: whisperModels.MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        bytes: model.bytes,
        downloaded: !!modelDir && whisperModels.isModelDownloaded(model.id, modelDir),
      })),
      selectedModel: state.selectedModel,
      language: String(process.env.WHISPER_LANGUAGE || "auto").trim() || "auto",
      pythonConfigured: speechService.hasPythonWhisper(),
      speechProvider: speechService.provider,
      // Local voice works now (the mic button shows).
      ready: speechService.provider === "whisper" && speechService.isAvailable(),
      // Why the built-in engine is not in use, in words for the user.
      problem: state.problem,
      problemMessage: state.problemMessage,
      downloading: download ? { id: download.id, received: download.received, total: download.total } : null,
    };
  }

  /** The model id from a { id } payload when it is one of whisperModels.MODELS, else null. */
  voiceModelIdFrom(input) {
    const id = input && typeof input === "object" && !Array.isArray(input) ? input.id : undefined;
    return typeof id === "string" && whisperModels.isModelId(id) ? id : null;
  }

  /**
   * Download a voice model. One download at a time; progress goes to the
   * requesting window as voice-model-progress { id, received, total }.
   * Returns { success, id } or { success: false, error, code, cancelled? }.
   */
  async downloadVoiceModel(event, input) {
    const id = this.voiceModelIdFrom(input);
    if (!id) return { success: false, error: "Unknown voice model.", code: "UNKNOWN_MODEL" };
    if (this._voiceDownload) {
      return this._voiceDownload.id === id
        ? { success: false, error: "This model is already downloading.", code: "BUSY" }
        : { success: false, error: "Another voice model is downloading. Wait for it to finish or cancel it.", code: "BUSY" };
    }
    let modelDir = "";
    try {
      modelDir = speechService.getWhisperModelDir() || "";
    } catch (_) { /* handled below */ }
    if (!modelDir || !path.isAbsolute(modelDir)) {
      return { success: false, error: "Cuewell could not find its voice model folder.", code: "NO_MODEL_DIR" };
    }

    const model = whisperModels.getModel(id);
    const controller = new AbortController();
    const job = { id, controller, received: 0, total: model.bytes };
    this._voiceDownload = job;
    const sender = event && event.sender;
    let lastSent = 0;
    const send = (received, total, force = false) => {
      job.received = received;
      job.total = total;
      const now = Date.now();
      if (!force && now - lastSent < VOICE_PROGRESS_INTERVAL_MS) return;
      lastSent = now;
      try {
        if (sender && !sender.isDestroyed()) sender.send("voice-model-progress", { id, received, total });
      } catch (_) { /* window closed */ }
    };

    logger.info("Voice model download started", { id });
    const startedAt = Date.now();
    try {
      await whisperModels.downloadModel(id, {
        modelDir,
        signal: controller.signal,
        onProgress: (received, total) => send(received, total, received >= total),
      });
      send(model.bytes, model.bytes, true);
      logger.info("Voice model downloaded", { id, ms: Date.now() - startedAt });
    } catch (error) {
      const cancelled = error && error.code === "ABORTED";
      if (cancelled) {
        logger.info("Voice model download cancelled", { id, received: job.received });
      } else {
        logger.warn("Voice model download failed", {
          id, code: error && error.code, error: error && error.message,
          cause: error && error.cause ? error.cause.code || error.cause.message : undefined,
        });
      }
      return {
        success: false,
        cancelled,
        code: (error && error.code) || "FAILED",
        error: (error && error.message) || "The download failed. Try again.",
      };
    } finally {
      if (this._voiceDownload === job) this._voiceDownload = null;
    }

    // The selected model arrived for the built-in engine that is not running
    // yet: start using it (after any recording in progress).
    if (speechService.provider === "whisper" &&
        speechService.whisperEngineChoice === "whispercpp" &&
        speechService.whisperEngine !== "whispercpp" &&
        id === speechService.getWhisperCppModelId()) {
      this.reinitializeSpeechWhenIdle("voice model downloaded");
    }
    return { success: true, id };
  }

  cancelVoiceModelDownload(input) {
    const id = this.voiceModelIdFrom(input);
    if (!id) return { success: false, error: "Unknown voice model." };
    if (!this._voiceDownload || this._voiceDownload.id !== id) {
      return { success: false, error: "This model is not downloading." };
    }
    this._voiceDownload.controller.abort();
    return { success: true };
  }

  /**
   * Choose the local voice engine, and for the built-in one optionally the
   * model. Saved to .env as WHISPER_ENGINE and WHISPER_CPP_MODEL. Returns
   * { success, available } or { success: false, error }.
   */
  setVoiceEngine(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { success: false, error: "Choose a voice engine." };
    }
    const engine = typeof input.engine === "string" ? input.engine.trim().toLowerCase() : "";
    if (!WHISPER_ENGINES.includes(engine)) {
      return { success: false, error: "Voice engine must be Built-in or Python Whisper." };
    }
    const hasModel = input.model !== undefined && input.model !== null && input.model !== "";
    if (hasModel && (typeof input.model !== "string" || !whisperModels.isModelId(input.model))) {
      return { success: false, error: "Unknown voice model." };
    }
    if (hasModel && engine !== "whispercpp") {
      return { success: false, error: "A voice model can only be chosen for the built-in engine." };
    }
    if (engine === "python" && !speechService.findPythonWhisper()) {
      return {
        success: false,
        error: "Python Whisper is not installed. Install it first, or use the built-in engine.",
      };
    }

    const updates = { WHISPER_ENGINE: engine };
    if (hasModel) updates.WHISPER_CPP_MODEL = input.model;
    const persisted = this.persistEnvUpdates(updates);
    this.reinitializeSpeech("voice engine changed");
    const available = speechService.provider === "whisper" && speechService.isAvailable();
    logger.info("Voice engine set", { engine, model: hasModel ? input.model : undefined, available });
    const result = { success: true, available };
    if (persisted.length < Object.keys(updates).length) {
      result.persisted = false;
      result.warning = "Changed for now, but Cuewell could not write its settings file, so the change is lost when it restarts.";
    }
    return result;
  }

  /**
   * reinitializeSpeech once no recording or transcription runs (a reinit
   * would cut it off). Checks every second for up to 10 minutes.
   */
  reinitializeSpeechWhenIdle(reason) {
    const busy = () => speechService.isRecording || speechService.isProcessingAudio;
    if (!busy()) {
      this.reinitializeSpeech(reason);
      return;
    }
    if (this._speechReinitTimer) clearInterval(this._speechReinitTimer);
    const deadline = Date.now() + 10 * 60 * 1000;
    this._speechReinitTimer = setInterval(() => {
      if (busy() && Date.now() < deadline) return;
      clearInterval(this._speechReinitTimer);
      this._speechReinitTimer = null;
      this.reinitializeSpeech(reason);
    }, 1000);
    if (typeof this._speechReinitTimer.unref === "function") this._speechReinitTimer.unref();
  }

  /** Re-read the speech settings and tell every window whether the mic works. */
  reinitializeSpeech(reason) {
    try {
      speechService.initializeClient();
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      windowManager.broadcastToAllWindows("speech-availability", { available: this.speechAvailable });
      logger.info("Speech service reinitialized", { reason, speechAvailable: this.speechAvailable });
    } catch (e) {
      logger.warn("Failed to reinitialize speech service", { reason, error: e.message });
    }
  }

  /** Bare Whisper commands the installer probes, e.g. ["whisper"], ["python3", "-m", "whisper"]. */
  knownBareWhisperCommands() {
    try {
      return this.getWhisperInstaller()._candidateCommands()
        .filter(([cmd]) => !path.isAbsolute(cmd) && !/[\\/]/.test(cmd));
    } catch (e) {
      logger.warn("Could not read the Whisper installer's command list", { error: e.message });
      return [["whisper"]];
    }
  }

  /**
   * Check a save-settings payload from `windowType`. Returns { clean, errors }:
   * `clean` holds the trimmed values to apply, `errors` one
   * SettingsValidationError per rejected field (those fields are left out of
   * `clean`, the others still save). Throws SettingsValidationError when the
   * payload itself is not acceptable from this window; nothing is saved then.
   * A value equal to the one already in effect is accepted as-is, so a
   * setting written by setup.sh or an older build never blocks a save.
   */
  validateSettings(settings, windowType) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new SettingsValidationError(null, "Settings must be an object.");
    }
    const allowedFields = SETTINGS_FIELDS_BY_WINDOW[windowType];
    if (!allowedFields) {
      throw new SettingsValidationError(null, "This window cannot change settings.");
    }
    for (const field of Object.keys(settings)) {
      if (!allowedFields.includes(field)) {
        logger.warn("Rejected settings field from a window not allowed to change it", { field, windowType });
        throw new SettingsValidationError(field, `This window cannot change ${field}.`);
      }
    }

    const has = (field) => settings[field] !== undefined && settings[field] !== null;
    const text = (field) => {
      const value = settings[field];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new SettingsValidationError(field, `${field} must be text.`);
      }
      return String(value).trim();
    };
    const unchanged = (envKey, value) => value === String(process.env[envKey] || "").trim();
    const clean = {};
    const errors = [];
    // Run one field's check; a rejected field is reported and skipped.
    const check = (fn) => {
      try {
        fn();
      } catch (error) {
        if (!(error instanceof SettingsValidationError)) throw error;
        errors.push(error);
      }
    };

    check(() => {
      if (has("codingLanguage")) {
        const value = text("codingLanguage");
        if (value && !CODING_LANGUAGES.includes(value)) {
          throw new SettingsValidationError("codingLanguage", "Unknown coding language.");
        }
        clean.codingLanguage = value;
      }
    });
    check(() => {
      if (has("activeSkill")) {
        const value = text("activeSkill");
        if (value && !isInterviewMode(value)) {
          throw new SettingsValidationError("activeSkill", "Unknown interview mode.");
        }
        clean.activeSkill = value;
      }
    });
    check(() => {
      if (has("answerLength")) {
        const value = text("answerLength");
        if (!promptLoader.isAnswerLength(value)) {
          throw new SettingsValidationError("answerLength", "Answer length must be Auto, Short, Standard or Detailed.");
        }
        clean.answerLength = value;
      }
    });
    check(() => {
      if (has("selectedIcon")) {
        const value = normalizeAppIconKey(text("selectedIcon"));
        if (!APP_ICON_KEYS.includes(value)) {
          throw new SettingsValidationError("selectedIcon", "Unknown app icon.");
        }
        clean.selectedIcon = value;
      }
    });
    check(() => {
      if (has("windowGap")) {
        const gap = parseWindowGap(text("windowGap"));
        if (gap === null) {
          throw new SettingsValidationError("windowGap", `Window gap must be a whole number from 0 to ${MAX_WINDOW_GAP}.`);
        }
        clean.windowGap = gap;
      }
    });

    check(() => {
      if (has("speechProvider")) {
        const value = text("speechProvider");
        if (value && value !== "azure" && value !== "whisper") {
          throw new SettingsValidationError("speechProvider", "Speech provider must be Azure or Whisper.");
        }
        clean.speechProvider = value;
      }
    });
    const whisperOptions = {
      whisperDevice: [WHISPER_DEVICES, "Compute device must be Auto, CPU or CUDA."],
      whisperCaptureMode: [WHISPER_CAPTURE_MODES, "Capture mode must be Automatic or Manual."],
      whisperResponseTarget: [WHISPER_RESPONSE_TARGETS, "Show voice answers must be Chat and answer panel, Chat only or Answer panel only."],
    };
    for (const [field, [options, message]] of Object.entries(whisperOptions)) {
      check(() => {
        if (!has(field)) return;
        const value = text(field);
        if (value && !options.includes(value)) throw new SettingsValidationError(field, message);
        clean[field] = value;
      });
    }

    // Secrets: empty (or the masked object get-settings returned) keeps the
    // saved key, so saving other settings never wipes one.
    for (const field of Object.keys(SECRET_SETTING_ENV_KEYS)) {
      check(() => {
        if (!has(field) || typeof settings[field] === "object") return;
        const value = text(field);
        if (!value) return;
        if (!SECRET_VALUE_RE.test(value)) {
          throw new SettingsValidationError(field, "API keys can only contain printable characters, without spaces.");
        }
        clean[field] = value;
      });
    }

    check(() => {
      if (has("azureRegion")) {
        const raw = text("azureRegion");
        if (unchanged("AZURE_SPEECH_REGION", raw)) {
          clean.azureRegion = raw;
        } else {
          const value = raw.toLowerCase();
          if (value && (value.length > 40 || !AZURE_REGION_RE.test(value))) {
            throw new SettingsValidationError("azureRegion",
              "Azure region may only contain lowercase letters and digits, e.g. eastus.");
          }
          clean.azureRegion = value;
        }
      }
    });

    check(() => {
      if (has("whisperCommand")) {
        const value = text("whisperCommand");
        // Same arguments as the current command (e.g. only re-quoted) counts as unchanged.
        const sameCommand = JSON.stringify(splitCommand(value)) ===
          JSON.stringify(splitCommand(process.env.WHISPER_COMMAND || ""));
        if (!sameCommand) {
          const problem = whisperCommandProblem(value, this.knownBareWhisperCommands());
          if (problem) throw new SettingsValidationError("whisperCommand", `Whisper command ${problem}.`);
        }
        clean.whisperCommand = value;
      }
    });
    check(() => {
      if (has("whisperModel")) {
        const value = text("whisperModel");
        if (value && !unchanged("WHISPER_MODEL", value) && !isWhisperModelName(value)) {
          throw new SettingsValidationError("whisperModel",
            "Whisper model must be a model name such as small or large-v3.");
        }
        clean.whisperModel = value;
      }
    });
    check(() => {
      if (has("whisperLanguage")) {
        const value = text("whisperLanguage");
        if (value && !unchanged("WHISPER_LANGUAGE", value) && !/^[A-Za-z_-]{1,32}$/.test(value)) {
          throw new SettingsValidationError("whisperLanguage", "Whisper language must be a language name or code, e.g. auto or en.");
        }
        clean.whisperLanguage = value;
      }
    });
    check(() => {
      if (has("whisperEngine")) {
        const value = text("whisperEngine").toLowerCase();
        if (value && !WHISPER_ENGINES.includes(value)) {
          throw new SettingsValidationError("whisperEngine", "Voice engine must be Built-in or Python Whisper.");
        }
        clean.whisperEngine = value;
      }
    });
    check(() => {
      if (has("whisperCppModel")) {
        const value = text("whisperCppModel");
        if (value && !whisperModels.isModelId(value)) {
          throw new SettingsValidationError("whisperCppModel", "Unknown voice model.");
        }
        clean.whisperCppModel = value;
      }
    });
    check(() => {
      if (has("whisperSegmentMs")) {
        const value = text("whisperSegmentMs");
        if (value && !unchanged("WHISPER_SEGMENT_MS", value) && !/^\d{1,6}$/.test(value)) {
          throw new SettingsValidationError("whisperSegmentMs", "Segment length must be a whole number of milliseconds.");
        }
        clean.whisperSegmentMs = value;
      }
    });

    check(() => {
      if (has("llmProvider")) {
        const value = text("llmProvider").toLowerCase();
        if (value && !getProviderConfig(value)) {
          throw new SettingsValidationError("llmProvider", "Unknown AI provider.");
        }
        clean.llmProvider = value;
      }
    });
    for (const field of MODEL_SETTING_FIELDS) {
      check(() => {
        if (!has(field)) return;
        const value = text(field);
        if (value && !unchanged(LLM_SETTING_ENV_KEYS[field], value) && !MODEL_NAME_RE.test(value)) {
          throw new SettingsValidationError(field,
            "Model names may only use letters, digits and . _ : / - (up to 100 characters).");
        }
        clean[field] = value;
      });
    }
    check(() => {
      if (has("ollamaBaseUrl")) {
        const value = text("ollamaBaseUrl");
        if (value && !unchanged("OLLAMA_BASE_URL", value)) {
          const problem = baseUrlProblem(value);
          if (problem) throw new SettingsValidationError("ollamaBaseUrl", `Ollama URL ${problem}.`);
        }
        clean.ollamaBaseUrl = value;
      }
    });

    return { clean, errors };
  }

  saveSettings(rawSettings, windowType) {
    let settings;
    let rejected;
    try {
      ({ clean: settings, errors: rejected } = this.validateSettings(rawSettings, windowType));
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        logger.warn("Settings rejected", { field: error.field, windowType, reason: error.message });
        return { success: false, error: error.message, field: error.field };
      }
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }

    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.setActiveMode(settings.activeSkill);
      }
      if (settings.answerLength) {
        this.answerLength = settings.answerLength;
        llmService.setPromptContext({ answerLength: settings.answerLength });
      }
      if (settings.selectedIcon) {
        this.appIcon = normalizeAppIconKey(settings.selectedIcon);
        this.updateAppIcon(this.appIcon);
      }
      if (settings.windowGap !== undefined) {
        windowManager.setWindowGap(settings.windowGap);
      }

      // ── Persist provider / API-key fields back to .env ──
      // The settings UI is now the source of truth for these values.
      // Writing to .env ensures they survive app restarts and are picked
      // up the next time the app boots. Secret fields are only present when
      // the user typed a new key (see validateSettings).
      const envUpdates = {};
      if (settings.codingLanguage) {
        envUpdates.CODING_LANGUAGE = settings.codingLanguage;
      }
      if (settings.selectedIcon) {
        envUpdates.APP_ICON = normalizeAppIconKey(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        envUpdates.WINDOW_GAP = String(settings.windowGap);
      }
      if (settings.speechProvider === "azure" || settings.speechProvider === "whisper") {
        envUpdates.SPEECH_PROVIDER = settings.speechProvider;
      }
      if (settings.azureKey) {
        envUpdates.AZURE_SPEECH_KEY = settings.azureKey;
      }
      if (settings.azureRegion !== undefined) {
        envUpdates.AZURE_SPEECH_REGION = settings.azureRegion;
      }
      if (settings.whisperCommand !== undefined) {
        envUpdates.WHISPER_COMMAND = settings.whisperCommand;
      }
      if (settings.whisperModel !== undefined) {
        envUpdates.WHISPER_MODEL = settings.whisperModel;
      }
      if (settings.whisperLanguage !== undefined) {
        envUpdates.WHISPER_LANGUAGE = settings.whisperLanguage;
      }
      if (["auto", "cpu", "cuda"].includes(settings.whisperDevice)) {
        envUpdates.WHISPER_DEVICE = settings.whisperDevice;
      }
      if (["manual", "vad"].includes(settings.whisperCaptureMode)) {
        envUpdates.WHISPER_CAPTURE_MODE = settings.whisperCaptureMode;
      }
      if (["chat", "overlay", "both"].includes(settings.whisperResponseTarget)) {
        envUpdates.WHISPER_RESPONSE_TARGET = settings.whisperResponseTarget;
      }
      if (settings.whisperSegmentMs !== undefined) {
        envUpdates.WHISPER_SEGMENT_MS = String(settings.whisperSegmentMs);
      }
      if (settings.whisperEngine !== undefined) {
        envUpdates.WHISPER_ENGINE = settings.whisperEngine;
      }
      if (settings.whisperCppModel !== undefined) {
        envUpdates.WHISPER_CPP_MODEL = settings.whisperCppModel;
      }
      if (settings.geminiKey) {
        envUpdates.GEMINI_API_KEY = settings.geminiKey;
      }
      if (settings.llmProvider) {
        envUpdates.LLM_PROVIDER = settings.llmProvider;
      }
      if (settings.answerLength) {
        envUpdates.ANSWER_LENGTH = settings.answerLength;
      }
      for (const [field, envKey] of Object.entries(LLM_SETTING_ENV_KEYS)) {
        if (SECRET_SETTING_ENV_KEYS[field] ? !!settings[field] : settings[field] !== undefined) {
          envUpdates[envKey] = settings[field];
        }
      }

      // Capture the previous whisper command BEFORE persisting — persistEnvUpdates
      // mutates process.env in place, so comparing afterwards would always read
      // equal and skip the speech re-init below (the exact stale-mic-after-install
      // bug the re-init guards against).
      const prevWhisperCommand = process.env.WHISPER_COMMAND || '';
      const voiceEngineChanged = ["WHISPER_ENGINE", "WHISPER_CPP_MODEL"].some((key) =>
        envUpdates[key] !== undefined && String(envUpdates[key]) !== (process.env[key] || ""));

      // Same reason: decide now whether any AI-provider value actually changes.
      const llmEnvKeys = ["LLM_PROVIDER", "GEMINI_API_KEY", ...Object.values(LLM_SETTING_ENV_KEYS)];
      const llmSettingsChanged = llmEnvKeys.some((key) =>
        envUpdates[key] !== undefined && String(envUpdates[key]) !== (process.env[key] || "")
      );

      const persistedKeys = this.persistEnvUpdates(envUpdates);
      // persistEnvUpdates logs and returns [] when .env cannot be written.
      // The values apply now but would be lost on restart: say so.
      const notSavedToDisk = Object.keys(envUpdates).length > 0 && persistedKeys.length === 0;

      // Reinitialize the LLM service when the Gemini key was saved (as
      // before) or any other AI-provider setting changed, so the new client
      // picks up the provider, key and model. Without this, the test-
      // connection button in the onboarding wizard fails with
      // "Service not initialized" because the client was first created
      // at app startup, before any key was set.
      if (envUpdates.GEMINI_API_KEY !== undefined || llmSettingsChanged) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after AI provider settings update", {
            provider: getActiveProviderId()
          });
        } catch (e) {
          logger.warn("Failed to reinitialize LLM service after AI provider settings update", {
            error: e.message
          });
        }
      }

      // Reinitialize speech service when provider OR whisper command
      // changes. Without the second check, the install flow (which
      // writes a new whisperCommand after install but keeps the same
      // provider) would leave the speech service pointing at a stale
      // (or non-existent) binary, and the main overlay's mic button
      // would stay hidden / non-functional.
      const providerChanged = settings.speechProvider && speechService.provider !== settings.speechProvider;
      const whisperCommandChanged = envUpdates.WHISPER_COMMAND !== undefined &&
        prevWhisperCommand !== envUpdates.WHISPER_COMMAND;
      if (providerChanged || whisperCommandChanged || voiceEngineChanged) {
        try {
          speechService.initializeClient();
          this.speechAvailable = speechService.isAvailable
            ? speechService.isAvailable()
            : false;
          // Broadcast so any open window (settings, overlay, chat)
          // can react immediately — especially the main overlay's
          // mic button, which queries availability on load.
          const { BrowserWindow } = require("electron");
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("speech-availability", { available: this.speechAvailable });
            }
          });
          logger.info('Speech service reinitialized after settings change', {
            providerChanged,
            whisperCommandChanged,
            voiceEngineChanged,
            speechAvailable: this.speechAvailable,
          });
        } catch (e) {
          logger.warn("Failed to reinitialize speech service after settings change", {
            error: e.message
          });
        }
      }

      // persistEnvUpdates already applied the values to process.env; only
      // writing the file failed, so they last until the app restarts.
      if (Object.keys(envUpdates).length > 0 && persistedKeys.length === 0) {
        return {
          success: true,
          persisted: false,
          warning: "Changed for now, but Cuewell could not write its settings file, so the change is lost when it restarts.",
        };
      }

      // Log setting names only: values include API keys (geminiKey,
      // azureKey, anthropicKey, ...) that must never reach log files.
      if (rejected.length > 0) {
        logger.warn("Settings saved except rejected fields", {
          rejected: rejected.map((e) => ({ field: e.field, reason: e.message })),
          persistedEnvKeys: persistedKeys
        });
        return {
          success: false,
          error: rejected[0].message,
          field: rejected[0].field,
          errors: rejected.map((e) => ({ field: e.field, error: e.message })),
          persistedEnvKeys: persistedKeys
        };
      }
      if (notSavedToDisk) {
        return {
          success: false,
          error: "Your changes work for now but could not be saved, so they will be lost when Cuewell restarts. " +
            "Check that your user account can write to the app data folder.",
          persistedEnvKeys: persistedKeys
        };
      }
      logger.info("Settings saved successfully", {
        fields: Object.keys(rawSettings || {}),
        persistedEnvKeys: persistedKeys
      });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Check { provider, apiKey, baseUrl, model } with the same rules as
   * save-settings, then send one short request with them. Nothing is saved
   * and the running llmService is not touched: the test runs on a separate
   * instance built from a copy of process.env. An empty apiKey, model or
   * baseUrl falls back to the saved value. Returns { ok, message }; the key
   * is never logged or returned.
   */
  async testProvider(input) {
    const fail = (message) => ({ ok: false, message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Choose an AI provider.");
    const unexpected = Object.keys(input).find((k) => !["provider", "apiKey", "baseUrl", "model"].includes(k));
    if (unexpected) return fail(`Unexpected field ${unexpected}.`);
    const id = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "";
    const provider = getProviderConfig(id);
    if (!provider) return fail("Unknown AI provider.");
    const given = (v) => v !== undefined && v !== null && v !== "";
    if (given(input.apiKey) && typeof input.apiKey !== "string") return fail("API key must be text.");
    if (provider.noKey && given(input.apiKey)) return fail(`${provider.label} does not use an API key.`);
    if (given(input.baseUrl) && id !== "ollama") return fail("Only Ollama takes a server URL.");

    const keyField = id === "gemini" ? "geminiKey" : `${id}Key`;
    const modelField = `${id}Model`;
    const payload = { llmProvider: id };
    if (given(input.apiKey)) payload[keyField] = input.apiKey;
    if (given(input.model)) payload[modelField] = input.model;
    if (given(input.baseUrl)) payload.ollamaBaseUrl = input.baseUrl;
    let clean;
    try {
      const { clean: checked, errors } = this.validateSettings(payload, "onboarding");
      if (errors.length > 0) return fail(errors[0].message);
      clean = checked;
    } catch (error) {
      if (error instanceof SettingsValidationError) return fail(error.message);
      throw error;
    }

    const env = { ...process.env, LLM_PROVIDER: id };
    if (provider.keyEnv && clean[keyField]) env[provider.keyEnv] = clean[keyField];
    if (clean[modelField]) env[provider.modelEnv] = clean[modelField];
    if (clean.ollamaBaseUrl) env.OLLAMA_BASE_URL = clean.ollamaBaseUrl;
    if (!isConfigured(id, env)) return fail(`Enter your ${provider.label} API key.`);

    try {
      // Same methods as llmService, own state.
      const proto = Object.getPrototypeOf(llmService);
      const tester = Object.create(proto);
      Object.assign(tester, {
        providerId: id, model: getModel(id, env), client: null, provider: null,
        isInitialized: true, requestCount: 0, errorCount: 0,
      });
      if (provider.kind === "gemini") {
        const { GoogleGenAI } = require("@google/genai");
        tester.client = new GoogleGenAI({ apiKey: getApiKey(id, env) });
      } else {
        tester.provider = createProvider(id, env);
        // The shared copy names the saved Ollama URL; name the tested one.
        const baseURL = getBaseURL(id, env);
        tester._providerCopy = function () {
          const copy = proto._providerCopy.call(this);
          return id === "ollama"
            ? { ...copy, unreachable: `Cannot reach ${provider.label} at ${baseURL}. Make sure it is running.` }
            : copy;
        };
      }

      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({
          success: false,
          error: `${provider.label} did not answer within ${PROVIDER_TEST_TIMEOUT_MS / 1000} seconds.`,
        }), PROVIDER_TEST_TIMEOUT_MS);
      });
      const result = await Promise.race([tester.testConnection(), timeout]).finally(() => clearTimeout(timer));
      if (result && result.success) {
        return { ok: true, message: `Connected to ${provider.label} (${result.model || tester.model}).` };
      }
      // The shared wording points at Settings; the wizard has the fields right here.
      return fail(((result && result.error) || "Connection failed.").replace(/ in Settings\b/g, ""));
    } catch (error) {
      logger.warn("AI provider test failed", { provider: id, error: error.message });
      return fail(error.message || "Connection failed.");
    }
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      }
    }

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      // 0600 because .env holds API keys. `mode` only applies when the file
      // is created, so a temp file left over from an interrupted write (which
      // keeps its old mode) is removed first.
      try { fs.unlinkSync(tmpPath); } catch (_) { /* normally absent */ }
      fs.writeFileSync(tmpPath, newContent, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }
    try {
      fs.chmodSync(envPath, 0o600);
    } catch (e) {
      logger.warn("Could not restrict .env permissions", { error: e.message });
    }

    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    iconKey = normalizeAppIconKey(iconKey);
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        cuewell: "assests/icons/app-icon.png",
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        cuewell: "Cuewell",
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon (only if dock is available)
        if (app.dock) {
          app.dock.setIcon(fullIconPath);

          // Force dock refresh with multiple attempts
          const retryDockIcon = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* dock may not exist */ }
          };
          setTimeout(retryDockIcon, 100);
          setTimeout(retryDockIcon, 500);
        }
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey, fullIconPath);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey, iconPath) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;
      // The tray tooltip and menu use the same name.
      this.appDisplayName = String(appName || "").trim() || "Cuewell";
      if (this.tray) this.tray.refresh();

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            // The icon file is not always named after its key (cuewell).
            app.dock.setIcon(
              iconPath || require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping (Windows only)
      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
