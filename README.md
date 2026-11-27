# Cuewell

A desktop AI interview copilot for practice, mock interviews and conversations where AI help is allowed. Ask by screenshot, voice or typed chat, and read a structured answer as it streams in, starting with one line you can say first.

Cuewell is free and open source (Apache-2.0), built on Electron, and maintained by Ankit Chaudhary. You bring your own AI provider and key. A landing page lives in [`website/`](website/index.html).

## Features

- **Small overlay.** A toolbar, a floating answer panel, a chat window, a Settings window and a first-run onboarding wizard. The overlay windows stay on top, and click-through mode lets clicks pass to the app underneath.
- **Menu bar and tray icon.** The overlay has no Dock icon or taskbar button. A menu bar icon (macOS) or tray icon (Windows, Linux) shows or hides Cuewell, takes a screenshot, opens the chat, Settings or Check for Updates…, and quits.
- **Interview modes.** Auto (the default) works out the question type: coding, technical theory, system design, behavioral, HR, managerial or situational, puzzles and case questions. You can also pin a mode: Coding, Technical, System design, Behavioral or HR.
- **One-line answer first.** Every answer opens with one sentence you can say right away, then the details. Answer length is Auto, Short, Standard or Detailed. Auto is Short for voice and Standard for typed and screenshot questions.
- **Coding language.** In Auto and Coding modes, code is written in C++, C, Python, Java or JavaScript, as chosen on the toolbar or in Settings.
- **Interview context.** Add your target role, company, job description, resume and notes in Settings. They are stored in `profile.json` in the app data folder and sent to your AI provider with every question, so answers fit the job and your experience.
- **About you.** Settings > About you holds your name, current title and company, years of experience, skills, projects, education, location, relocation, notice period, expected salary, languages, and the tone and language for answers. Every field is optional. Answers use these real details instead of blanks like [X years] and never make up employers, numbers or degrees. They are stored with the interview context in `profile.json` and sent to your AI provider with every question. **Clear all** removes them.
- **Three ways to ask.**
  - Screenshot: capture the display under the mouse pointer. The image goes to the AI provider directly, with no OCR step.
  - Voice: local Whisper by default, or Azure Speech. Capture is automatic (pause detection) or manual start/stop.
  - Chat: type a question. Typed and voice questions include recent conversation history, so follow-ups keep their context.
- **Live answers.** Answers stream into the answer panel, the chat or both (configurable for voice). Code blocks get syntax highlighting and a copy button.
- **Your choice of AI provider.** Gemini (default), Claude, OpenAI, OpenRouter, Groq, DeepSeek or a local Ollama model.
- **Privacy mode.** On macOS and Windows the windows are hidden from most screen capture and screen sharing. See [Privacy mode](#privacy-mode) for the limits.

## Quick start

You need Node.js 22.12 or newer. For local voice you also need Python 3.10 or newer (see [Requirements](#requirements)).

**macOS and Linux:**

```bash
git clone https://github.com/ankit1324/cuewell.git
cd cuewell
./setup.sh
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/ankit1324/cuewell.git
cd cuewell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Both scripts check your Node version, create `.env` from `env.example` (readable by your account only), install Node dependencies, set up local Whisper in `.venv-whisper`, run a short speech test and start the app. If Python is missing, they skip Whisper and tell you how to install it; you can also set Whisper up later from the onboarding wizard.

On first launch, the onboarding wizard opens. It walks you through:

1. Choosing an AI provider and entering its key (or the Ollama server URL), with a **Test connection** button.
2. Choosing a speech provider: local Whisper, Azure Speech, or skip.
3. For Whisper: detecting it, installing it into a virtual environment if needed, and downloading a model.

After setup, start the app with `npm start` (or `npm run dev`, which also disables the GPU). Both work from any terminal, including PowerShell and `cmd.exe`.

### setup.sh options

```bash
./setup.sh --no-run               # Set up only, do not launch
./setup.sh --ci                   # Use npm ci instead of npm install
./setup.sh --skip-whisper         # Skip the local Whisper setup
./setup.sh --install-system-deps  # Linux: install arecord (alsa-utils) for voice input
./setup.sh --build                # Build a distributable for this OS, then start the app
./setup.sh --build --no-run       # Build only
```

`setup.sh` also runs from Git Bash on Windows. Under WSL the app runs as a Linux app, so privacy mode has no effect.

### setup.ps1 options (Windows)

```powershell
.\setup.ps1 -NoRun          # Set up only, do not launch
.\setup.ps1 -Ci             # Use npm ci instead of npm install
.\setup.ps1 -SkipWhisper    # Skip the local Whisper setup
.\setup.ps1 -Build -NoRun   # Build the installer and portable app only
.\setup.ps1 -Help           # Show all options
```

`setup.ps1` finds Python through the `py` launcher, preferring 3.12, then 3.11, 3.10 and 3.13. Install Python from [python.org](https://www.python.org/downloads/) (turn on "Add python.exe to PATH") or with `winget install Python.Python.3.12`. If PowerShell refuses to run the script, the `-ExecutionPolicy Bypass` form above runs it without changing your system policy.

## Requirements

| | |
|---|---|
| Node.js | 22.12 or newer (`setup.sh` and `setup.ps1` check this; `package.json` declares it) |
| macOS | 13 (Ventura) or later |
| Windows | 10 or later, 64-bit |
| Linux | 64-bit, X11 or XWayland. Privacy mode has no effect (see below) |
| Local Whisper | Python 3.10 or newer (3.12 recommended), about 3 to 5 GB of disk for Whisper and its dependencies |
| Azure Speech | An Azure Speech resource key and region |

How each system records the microphone:

| | Recorder | What you need |
|---|---|---|
| macOS | Built in (the app's own audio capture) | Microphone permission |
| Windows | Built in (the app's own audio capture) | Microphone access on in Settings > Privacy & security > Microphone |
| Linux | `arecord` (alsa-utils), or `sox` | `sudo apt install alsa-utils` (the `.deb` installs it for you). Without either, voice input shows an error that names the missing package. |

ffmpeg is usually not needed: the app records PCM WAV, and its Python Whisper worker reads it directly. If that worker is unavailable, the app falls back to the `whisper` command-line tool, which needs ffmpeg.

## Building

```bash
npm run build:mac     # .dmg and .zip (x64 and arm64)
npm run build:win     # NSIS installer and portable .exe (x64)
npm run build:linux   # AppImage and .deb (x64)
```

Output goes to `dist/`. `./setup.sh --build --no-run` (or `.\setup.ps1 -Build -NoRun` on Windows) runs the right one for your OS. Windows and Linux builds can also be made on a Mac; macOS builds need a Mac.

| System | Files in `dist/` |
|---|---|
| macOS | `Cuewell-<version>-mac-arm64.dmg`, `Cuewell-<version>-mac-x64.dmg`, and a `.zip` of each |
| Windows | `Cuewell-<version>-win-x64-setup.exe` (installer), `Cuewell-<version>-win-x64-portable.exe` (no install) |
| Linux | `Cuewell-<version>-linux-amd64.deb`, `Cuewell-<version>-linux-x86_64.AppImage` |

The Windows installer installs for the current user only (no admin prompt), lets you choose the folder, adds Start menu and desktop shortcuts, and can start Cuewell when it finishes. Uninstalling keeps your settings, keys and Whisper files in the app data folder.

On Debian and Ubuntu, install the `.deb` with `sudo apt install ./Cuewell-<version>-linux-amd64.deb`; it adds Cuewell to the app menu and the `cuewell` command. For the AppImage, run `chmod +x Cuewell-<version>-linux-x86_64.AppImage`, then run the file. Some distributions need `libfuse2` for AppImages.

Builds are **not code signed or notarized** today. That means:

- **macOS:** the first launch of a downloaded build is blocked. Open System Settings > Privacy & Security and choose **Open Anyway**. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine /Applications/Cuewell.app`, or run from source with `./setup.sh`.
- **Windows:** SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**, only if you built or trust the file.

No pre-built downloads are linked from this README. The workflow in `.github/workflows/release.yml` builds macOS, Windows and Linux artifacts on each system's own GitHub runner, and publishes them as a GitHub release when a version tag (`v1.2.3`) is pushed.

## Updates

Cuewell does not update itself, because builds are not signed. It only tells you when a newer release exists:

- About 15 seconds after launch, at most once a day, it asks GitHub for the latest release. If that release is newer, a notification says "Cuewell X.Y.Z is available". Click it to open the release page in your browser. Nothing is shown if you are up to date or offline.
- **Check for Updates…** checks right away and tells you the result. It is in the menu bar or tray icon's menu on every system, in the **Cuewell** menu on macOS, and in the app menu on the toolbar on Windows and Linux.

The check is a single request to `api.github.com` that names only the app version. To turn off the automatic check, add `UPDATE_CHECKS=off` to `.env`. **Check for Updates…** still works when you choose it.

## Shortcuts

Global shortcuts work from any app. On macOS, `Alt` is the Option key.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + Shift + S` | Capture the display under the mouse pointer and ask about it |
| `Alt + R` | Start or stop voice input (when a speech provider is set up) |
| `Cmd/Ctrl + Shift + V` | Show or hide all windows |
| `Cmd/Ctrl + Shift + I` or `Alt + A` | Turn click-through on or off |
| `Cmd/Ctrl + Shift + C` | Open the chat window |
| `Cmd/Ctrl + Shift + \` | Clear the conversation history |

These work only while a Cuewell window has focus, so other apps keep them:

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + ,` | Open Settings |
| `Cmd/Ctrl + Up / Down` | Switch interview mode (click-through off), or move the windows (click-through on) |
| `Cmd/Ctrl + Left / Right` | Move the windows (click-through on) |

With click-through on, you cannot click a window to focus it, so moving the windows by keyboard only works while one still has focus, for example right after you turn click-through on.

If another app already owns a global shortcut, Cuewell cannot register it. Settings > Shortcuts marks it as not working, and the log has a warning. The menu bar or tray icon's menu still has those commands.

On Linux with Wayland, global shortcuts go through the desktop's shortcuts portal. GNOME and KDE may ask you once to allow them. Desktops without the portal give Cuewell no global shortcuts; use the tray icon's menu, or an X11 session.

## AI providers

Pick a provider in Settings or during onboarding.

| Provider | Screenshots | Key |
|---|---|---|
| Google Gemini (default) | Yes | `GEMINI_API_KEY` ([Google AI Studio](https://aistudio.google.com/)) |
| Anthropic Claude | Yes | `ANTHROPIC_API_KEY` |
| OpenAI | Yes | `OPENAI_API_KEY` |
| OpenRouter | Yes | `OPENROUTER_API_KEY` |
| Groq | No, text only | `GROQ_API_KEY` |
| DeepSeek | No, text only | `DEEPSEEK_API_KEY` |
| Ollama | Yes, with a vision model (default `llama3.2-vision`) | None; runs on your machine |

Keys are stored in a `.env` file:

- Installed builds use `.env` in the app data folder (`~/Library/Application Support/<app>` on macOS, `%APPDATA%\<app>` on Windows, `~/.config/<app>` on Linux).
- When you run from source, a `.env` in the project folder (the one `setup.sh` creates) is used if the app data folder has none.

On macOS and Linux the app makes this file readable by your user only (mode 0600). Keys entered in Settings take effect right away; direct edits to `.env` apply on the next start.

## Configuration

Settings writes provider, voice, mode, answer length, coding language, app icon and window gap values to `.env` for you. The main keys:

```bash
# AI provider: gemini | anthropic | openai | openrouter | groq | deepseek | ollama
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
# Optional per-provider model and endpoint overrides, for example:
# GEMINI_MODEL=, OPENAI_MODEL=, OLLAMA_MODEL=, OLLAMA_BASE_URL=http://localhost:11434/v1
# OPENAI_BASE_URL=, ANTHROPIC_BASE_URL=, ANTHROPIC_EFFORT=low
LLM_STREAM_IDLE_TIMEOUT_MS=60000

# Saved by the app when you change them
INTERVIEW_MODE=auto          # auto | dsa (Coding) | technical | system-design | behavioral | hr
ANSWER_LENGTH=auto           # auto | short | standard | detailed
CODING_LANGUAGE=cpp          # cpp | c | python | java | javascript
APP_ICON=terminal            # terminal | activity | settings | cuewell
WINDOW_GAP=10                # pixels, 0 to 100

# Set to off to turn off the automatic update check
# UPDATE_CHECKS=off

# Speech: whisper (local) or azure
SPEECH_PROVIDER=whisper
WHISPER_COMMAND=whisper
WHISPER_MODEL=small
WHISPER_LANGUAGE=auto
WHISPER_DEVICE=auto          # auto | cpu | cuda
WHISPER_CAPTURE_MODE=vad     # vad (pause detection) | manual
WHISPER_RESPONSE_TARGET=both # both | chat | overlay
WHISPER_MANUAL_MAX_MS=90000
WHISPER_GPU_IDLE_MS=60000
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
```

See `env.example` for the full list. `setup.sh` configures Whisper with the `base` model and English; change either in Settings.

Settings also has:

- **Interview context:** role, company, job description, resume and notes, saved to `profile.json` in the app data folder (not in `.env`).
- **App icon:** the name and icon the app shows to the system: its process title (as Activity Monitor shows it), its window titles and the menu bar or tray icon's tooltip. Choose Terminal (the default), Activity Monitor, System Settings or Cuewell.
- **Window gap:** spacing in pixels between the toolbar and the answer panel.

Settings saves each change as you make it. Quitting waits up to a second for a change that is still being saved.

If no speech provider is available, the mic buttons are hidden.

## Where your data goes

Cuewell has no server and no account, and sends no telemetry or analytics. Your questions, screenshots and interview context go only to the AI provider you picked. Audio leaves your computer only if you choose Azure Speech, and then it goes to Microsoft.

| Data | Stored | Sent to |
|---|---|---|
| Screenshot (the whole display under the mouse pointer, including anything else on it) | In memory while the request runs | Your AI provider. Sent without conversation history. |
| Typed question or voice transcript | In memory for the session | Your AI provider, with recent history: up to 14 earlier messages for typed questions, up to 8 for voice |
| Interview context (role, company, job description, resume, notes) | `profile.json` in the app data folder (owner-only on macOS and Linux) | Your AI provider, with every question (typed, voice and screenshot) |
| Microphone audio, local Whisper | A temporary WAV file in the system temp folder, deleted after transcription | Nowhere. Only the text transcript goes to the AI provider. |
| Microphone audio, Azure Speech | Not saved by the app | Microsoft (Azure Speech) |
| API keys | `.env` (owner-only on macOS and Linux) | Only the provider each key belongs to |
| Conversation history | In memory only. Cleared on restart or with `Cmd/Ctrl + Shift + \`. The chat window's clear button clears only the messages it shows. | Recent part, as above |
| App logs | `~/.Cuewell/logs`: app events and errors, kept 14 days (error logs 30) | Nowhere |

With Ollama on `localhost`, AI requests stay on your machine. The built-in endpoints for the cloud providers use HTTPS.

Setting up local Whisper also downloads Python packages from PyPI and model weights from OpenAI's download servers. No questions, audio or keys are sent with those downloads.

## Privacy mode

On macOS and Windows, every Cuewell window is marked as excluded from screen capture (Electron `setContentProtection`). Most screen recording and screen sharing tools then do not show the overlay. Limits:

- Some browser-based screen sharing, and older capture methods, can still capture the windows.
- On Linux there is no such window flag, so the windows are always visible in screen shares and recordings.
- The menu bar icon (macOS) and tray icon (Windows, Linux) are part of the system's menu bar or taskbar, so they show in screen shares and recordings of the whole screen.
- Someone looking at your screen, or a camera pointed at it, still sees it.

Treat privacy mode as a convenience for keeping the overlay out of your own recordings and shares, not as a guarantee.

## Use it responsibly

Cuewell is made for practice, mock interviews and conversations where AI help is allowed. Many employers do not allow AI assistance in live interviews. Check the rules for each interview before you use it, and follow them. You are responsible for how you use it.

## Security model

- **Sandboxed pages.** Every window runs with `sandbox`, `contextIsolation` and no Node integration.
- **Minimal per-window APIs.** Each window gets a preload that exposes only the calls that page uses. The main process checks the sender of every IPC message against a per-channel allowlist, and limits which settings fields each window may save.
- **Keys stay in the main process.** Settings shows masked keys; full keys are never sent to any window.
- **Strict Content Security Policy.** Pages load only local scripts and cannot make network requests (`connect-src 'none'`). AI output is sanitized with DOMPurify before it is rendered.
- **Locked-down navigation and permissions.** Links open in your browser, windows cannot navigate away from their own page, and only microphone and screen capture permissions are granted to the app's own pages.
- **Electron 45 with fuses in packaged builds.** `runAsNode`, `NODE_OPTIONS` and the inspector flags are disabled, and the app loads only from its asar archive, with an integrity check on macOS and Windows. Packaged builds also drop the Reload and Developer Tools menu items.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Troubleshooting

**Screenshots fail on macOS, or the app says screen capture failed.**
Allow Screen Recording under System Settings > Privacy & Security > Screen & System Audio Recording, then restart the app. When you run from source, the permission belongs to the app that launched it, such as your terminal or editor.

**Voice does nothing on macOS.**
Allow Microphone access under System Settings > Privacy & Security > Microphone for Cuewell, or for your terminal or editor when running from source.

**The screenshot answer describes a blank or black screen.**
A locked screen, a sleeping display or a screen saver gives a blank capture. Unlock the screen and try again.

**The onboarding wizard opens every time.**
It opens when the selected provider has no usable key. Finish onboarding, or open Settings (`Cmd/Ctrl + ,`) and enter a key.

**"Cannot reach Ollama (local) ... Make sure it is running."**
Start Ollama (the app, or `ollama serve`) and check the server URL in Settings. If the model is missing, run `ollama pull llama3.2-vision` or pick a model you have.

**"Groq does not support screenshots."**
Groq and DeepSeek accept text only. Switch to Gemini, Claude, OpenAI, OpenRouter or Ollama for screenshots.

**The mic button is missing.**
No speech provider is available. Run `./setup.sh` again, finish the Whisper step in onboarding, or enter Azure Speech credentials in Settings.

**A shortcut does not work.**
Another app may own it; check the log in `~/.Cuewell/logs`. `Cmd/Ctrl + ,` and the arrow shortcuts only work while a Cuewell window has focus.

**No tray icon on Linux.**
GNOME shows tray icons only with an AppIndicator extension (Ubuntu includes one). Install "AppIndicator and KStatusNotifierItem Support", or use the shortcuts and the toolbar.

**Blank window or GPU crash on Linux.**
The app already disables GPU acceleration on Linux. Make sure an X11 or XWayland display is available, and try `npm run dev`.

**setup.sh stops early.**
Install Node.js 22.12 or newer and retry. Exit code 130 means Ctrl+C was pressed.

## Reporting problems

- **Help > Report a Problem…** opens a new GitHub issue with your Cuewell version and operating system already filled in. Nothing else is sent.
- **Help > View Logs Folder** opens `~/.Cuewell/logs`. Log files are kept 14 days (error logs 30), each file is capped at 20 MB, and the oldest are deleted once all logs together pass 100 MB. Logs can contain parts of your session, so read a log and remove anything private before you attach it to an issue.

On Windows and Linux, both items are in the app menu on the toolbar. For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Project structure

```text
main.js                   Main process: windows, shortcuts, IPC, settings, .env handling
preload.js                Bridge for the toolbar, Settings and onboarding
preload-content.js        Smaller bridge for the chat and answer windows
index.html                Toolbar
llm-response.html         Answer panel
chat.html                 Chat window
settings.html             Settings
onboarding.html/.js       First-run wizard
prompt-loader.js          Builds the system prompt: mode, answer format, length, context
prompts/                  Mode prompts (auto, dsa, technical, system-design, behavioral, hr)
src/core/                 Config, logging, first run, profile store, menus, tray icon, updates, Whisper installer
src/managers/             Window and session (conversation history) managers
src/services/             Screen capture, LLM, speech and Whisper worker services
src/services/providers/   Claude and OpenAI-compatible provider adapters
src/ui/                   Renderer scripts for each window
lib/                      Markdown rendering and HTML sanitizing
scripts/                  Start script, Whisper worker (Python), speech test, installer hook
assests/                  Icons, fonts and vendored Font Awesome (the folder name is spelled this way)
website/                  Landing page; not included in app builds
setup.sh, setup.ps1       Setup scripts (macOS/Linux, Windows)
env.example               Configuration template
```

## Contributing

Issues and pull requests are welcome.

- Run from source with `./setup.sh`, then `npm start`.
- Keep changes small and focused, and match the existing style.
- There is no automated test suite or linter yet. Test your change by hand on the platforms it touches. `npm run test-speech` checks the Whisper setup.
- Do not commit `.env`, API keys or files from the app data folder.

Planned: export of conversation history to Markdown or PDF.

## License and credits

Released under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Cuewell is maintained by Ankit Chaudhary. It is a modified version of [OpenCluely](https://github.com/TechyCSR/OpenCluely) by TechyCSR, licensed under the Apache License 2.0. Bundled fonts (Manrope, JetBrains Mono) are under the SIL Open Font License 1.1. UI and structure were inspired by [Vysper](https://github.com/varun-singhh/Vysper) by varun-singhh.
