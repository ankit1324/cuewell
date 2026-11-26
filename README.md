<div align="center">

# Super Interview

**The invisible AI interview copilot.**

Real-time AI help on a stealth overlay that screen sharing cannot see. Ask by voice or screenshot, and get clear answers that stream in as you need them.

<a href="#download">Download</a> &nbsp;|&nbsp;
<a href="#quick-start">Quick start</a> &nbsp;|&nbsp;
<a href="#how-it-works">How it works</a>

</div>

## Demo

https://github.com/user-attachments/assets/896a7140-1e85-405d-bfbe-e05c9f3a816b

## What it is

Super Interview is a desktop app for technical interviews and practice. It places a small overlay on your screen that recording and conferencing tools do not capture. You can speak a question or take a screenshot, and the AI answers in real time. The answer streams into a floating window and an optional chat panel, with clean code blocks and syntax highlighting.

It is free and open source. Processing stays on your machine, and the only thing that leaves your device is the request you send to the AI provider.

## Highlights

- **Invisible overlay.** On macOS and Windows the windows are excluded from screen capture by apps that use the OS capture APIs (macOS ScreenCaptureKit, Windows Graphics Capture). Some older capture paths, for example Chromium 122-era screen sharing, still capture them on macOS, and Linux has no protection.
- **Flexible local voice.** Choose manual start/stop capture or automatic voice-activity detection without fixed-timer sentence cuts.
- **Configurable streamed answers.** Route voice replies to chat, the floating overlay, or both.
- **Your choice of AI provider.** Gemini, Claude, OpenAI, OpenRouter, Groq, DeepSeek or Ollama, chosen in Settings. Groq and DeepSeek do not accept screenshots.
- **Direct image analysis.** Screenshots go straight to the AI provider for visual reasoning, with no slow OCR step in between.
- **Session memory.** Typed and voice questions include recent conversation history (up to the last 15 events), so follow-ups keep their context. Screenshots are sent without history, and that history is cleared when the app restarts.
- **Language aware.** Tailored answers for C++, C, Python, Java, and JavaScript.
- **Stealthy by design.** Runs under ordinary system names, ships with no telemetry, and keeps your session local.
- **Cross platform.** Runs on macOS, Windows and Linux. Build from source with `./setup.sh`.

## Download

There are no pre-built installers for this fork. Build from source with `./setup.sh`, as described in [Quick start](#quick-start).

## Quick start

If you would rather build from source, three steps are all it takes.

1. Clone the repository.

   ```bash
   git clone <your-repo-url>
   cd super-interview
   ```

2. Run the setup script.

   ```bash
   ./setup.sh
   ```

   The script installs Node dependencies, creates your `.env` from the example, sets up a local Whisper virtual environment, points the config at it, and launches the app.

3. Add your Gemini key.

   On first launch the Settings window opens automatically. Get a free key from [Google AI Studio](https://aistudio.google.com/) and paste it in, or edit `.env` directly. Both work: keys saved in Settings take effect right away, and direct edits to `.env` apply the next time the app starts. Gemini is the default; to use another AI provider, pick it in Settings and enter its key there.

### Platform notes

- On Windows, use Git Bash (included with Git for Windows) or WSL to run `setup.sh`.
- On macOS and Linux, your normal terminal works.
- **macOS users must build from source** (steps above) — there is no pre-built `.dmg`. Because the app is unsigned, a downloaded build would be blocked by Gatekeeper as "damaged"; running from source avoids that entirely.
- No manual `npm` commands are needed. The script handles everything.

### Setup script options

```bash
./setup.sh --build                # Build a distributable for your OS
./setup.sh --ci                   # Use npm ci instead of npm install
./setup.sh --no-run               # Set up only, do not launch
./setup.sh --install-system-deps  # Install sox for the microphone (optional)
./setup.sh --skip-whisper         # Skip the local Whisper bootstrap
```

## Configuration

The setup script writes sensible defaults. The only required value is the API key for your AI provider: `GEMINI_API_KEY` for the default, Gemini. Ollama runs locally and needs no key.

```bash
# Required for the default AI provider (Gemini)
GEMINI_API_KEY=your_gemini_api_key_here

# Optional speech provider. Pick one.
SPEECH_PROVIDER=whisper

# Azure option
AZURE_SPEECH_KEY=your_azure_speech_key
AZURE_SPEECH_REGION=your_region

# Local Whisper option
WHISPER_COMMAND=whisper
WHISPER_MODEL_DIR=.whisper-models
WHISPER_MODEL=small
WHISPER_LANGUAGE=auto
WHISPER_DEVICE=auto
WHISPER_PYTHON=
WHISPER_CAPTURE_MODE=vad
WHISPER_RESPONSE_TARGET=both
WHISPER_MANUAL_MAX_MS=90000
WHISPER_GPU_IDLE_MS=60000
```

Speech is optional. If no provider is configured, the microphone button hides itself across the app.

## Optional voice setup

You can use local Whisper for offline transcription or Azure Speech for a cloud option.

For local Whisper, `./setup.sh` handles the full setup. It creates `.venv-whisper`, installs `openai-whisper`, points `.env` at the virtual environment, creates `.whisper-models`, and runs a quick speech test. The app reads its own PCM WAV recordings directly; ffmpeg is only needed when transcribing other audio formats through the CLI fallback.

For Azure Speech, create a Speech resource in the [Azure Portal](https://portal.azure.com/), then add the key and region to `.env` with `SPEECH_PROVIDER=azure`.

## How it works

1. **Ask.** Use automatic pause detection, choose manual start/stop capture in Settings, or use the screenshot shortcut.
2. **Reason.** Audio is transcribed locally by Whisper, or in the cloud by Azure Speech if you select it. The AI provider receives only text (your typed question or the transcript) and screenshots, plus recent conversation history for typed and voice questions, and works toward a precise answer.
3. **Answer.** Voice responses stream to chat, the overlay, or both, according to Settings.

## Keyboard shortcuts

| Action | Shortcut | Description |
|---|---|---|
| Screenshot capture | `Cmd/Ctrl + Shift + S` | Capture the screen and analyze it with the AI provider |
| Toggle speech | `Alt + R` | Start or stop voice recognition, if configured |
| Toggle visibility | `Cmd/Ctrl + Shift + V` | Show or hide all windows |
| Toggle interaction | `Cmd/Ctrl + Shift + I` or `Alt + A` | Enable or disable click through |
| Open chat | `Cmd/Ctrl + Shift + C` | Open the interactive chat window |
| Clear memory | `Cmd/Ctrl + Shift + \` | Clear the AI's conversation memory |
| Settings | `Cmd/Ctrl + ,` | Open the settings panel, while a Super Interview window is focused |
| Move or switch skill | `Cmd/Ctrl + Arrow keys` | While a Super Interview window is focused |

`Cmd/Ctrl + ,` and `Cmd/Ctrl + Arrow keys` only work while a Super Interview window is focused, so other apps keep these keys for their own settings and for line and word jumps.

## Project status

Super Interview is under active development. The core is stable and improvements ship regularly.

### Done

- Stealth overlay with a draggable command bar and a click through toggle
- Screenshot capture with direct analysis by the AI provider, no OCR step
- AI provider picker: Gemini, Claude, OpenAI, OpenRouter, Groq, DeepSeek or Ollama
- Configurable manual or VAD-driven voice capture
- Persistent local Whisper worker with optional CUDA acceleration and idle GPU release
- Configurable chat/overlay routing for streamed voice answers
- Whisper hallucination filter that drops phantom phrases on silence
- AI response window with markdown and syntax highlighting
- Global shortcuts for capture, visibility, interaction, chat, and settings
- Session memory and a full chat UI
- Language picker and a DSA skill prompt
- Optional Azure Speech and local Whisper, with an auto hiding mic button
- Multi-monitor and area capture support
- Window binding and positioning
- Settings management with disguise and stealth modes

### Planned

- Auto typing of code snippets into editors and IDEs
- Export of conversation history to markdown or PDF
- Deeper stealth, including process name randomization

## Troubleshooting

<details>
<summary>Setup issues</summary>

- **setup.sh will not run.** Make sure you are in the project folder (`cd super-interview`) and that the script is executable (`chmod +x setup.sh`). On Windows, use Git Bash.
- **Setup stops with exit code 130.** That means Ctrl+C was pressed. Run `./setup.sh` again.
- **Node or npm not found.** Install Node.js 18 or newer from [nodejs.org](https://nodejs.org/), restart the terminal, and retry.

</details>

<details>
<summary>App issues</summary>

- **Electron will not start or shows a blank window on Linux.** Try `npm run dev`, and make sure X11 or XWayland is available in headless setups.
- **macOS screen capture does not work.** Grant Screen Recording permission under System Settings, Privacy and Security, then relaunch the app.
- **Windows SmartScreen blocks the app.** Click More info, then Run anyway, or use `npm start` during development.
- **Microphone or voice not working.** Voice is optional. For Azure, add valid keys to `.env`. For Whisper, install `openai-whisper`, `ffmpeg`, and `sox`, then set `SPEECH_PROVIDER=whisper`.

</details>

<details>

<summary> Limitations </summary>

- **Screen-capture invisibility does not work on Linux.** The overlay stays hidden from screen shares and recordings only on **macOS** and **Windows**. This relies on Electron's `setContentProtection`, which maps to `NSWindowSharingNone` on macOS and `WDA_EXCLUDEFROMCAPTURE` on Windows. Electron provides **no equivalent on Linux** (neither X11 nor Wayland), so on Linux the call is a silent no-op and the overlay **will be visible** to anyone you screen-share with. This is a platform limitation, not a bug — there is no window flag on Linux that excludes a window from framebuffer capture. If you need capture-invisibility, run Super Interview on macOS or Windows. As a partial workaround on Linux, share a single application window instead of your entire screen, or place the overlay on a monitor you are not sharing.

</details>



## Privacy and ethics

Super Interview collects no data and sends no telemetry. Processing happens locally, and your session stays on your device. Requests to the AI provider are encrypted in transit.

The app is built for learning and practice. You are responsible for following the rules of any interview you take and the policies of the companies involved.

## License

Released under the Apache-2.0 License. See [LICENSE](LICENSE) for details.

## Acknowledgments

- Google Gemini for the AI reasoning
- Azure Speech and OpenAI Whisper for optional voice input
- Electron for the cross platform desktop runtime
- [Vysper by varun-singhh](https://github.com/varun-singhh/Vysper) for UI and structure inspiration

<div align="center">

Maintained by **Ankit Chaudhry**.

</div>

## Credits and license

Super Interview is a modified version of [OpenCluely](https://github.com/TechyCSR/OpenCluely) by TechyCSR, licensed under the Apache License 2.0. See `LICENSE` and `NOTICE`.
