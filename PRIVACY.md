# Privacy

Cuewell has no server and no account. It sends no telemetry, analytics or crash reports. It connects only to the services listed here, and only for what you use.

## What leaves your computer

| Where | When | What is sent |
|---|---|---|
| The AI provider you picked (Gemini, Claude, OpenAI, OpenRouter, Groq, DeepSeek, or your Ollama server) | Each time you ask a question | Your question (typed, or the voice transcript), recent conversation history (up to 14 earlier messages for typed questions, up to 8 for voice), your interview context and About you details, and the API key for that provider. For a screenshot: the image of the whole display under the mouse pointer, without history. |
| Microsoft Azure Speech | Only if you choose Azure Speech for voice | Your microphone audio while voice input is on, and your Azure key |
| Hugging Face (`huggingface.co` and its `hf.co` download hosts) | When you download a speech model | A request for the model file. Nothing about you. |
| GitHub (`api.github.com`) | About 15 seconds after launch, at most once a day, and when you choose **Check for Updates…** | A request for the latest release, naming the Cuewell version. Turn off the automatic check with `UPDATE_CHECKS=off` in `.env`. |

The cloud AI providers are reached over HTTPS. With Ollama on `localhost`, questions stay on your computer.

When an AI request fails, Cuewell may open a connection to `google.com` or to the provider's server to check whether you are online. It sends nothing over that connection.

**Report a Problem…** and the offer after a crash open a GitHub issue page in your browser. The page is filled in with your Cuewell version and operating system, and, after a crash, the error message and stack trace. Nothing is sent until you read it and submit it yourself.

Running from source or using the advanced Python Whisper setup also downloads software: whisper.cpp from GitHub, Python packages from PyPI and Whisper weights from OpenAI's servers. None of these downloads carry your questions, audio or keys.

## Local voice

With local voice (whisper.cpp), audio never leaves your computer. The speech engine runs as a background process that only this computer can reach: a private socket in an owner-only temp folder on macOS and Linux, and `127.0.0.1` on Windows. Only the text transcript goes to your AI provider.

## Files on your computer

| File | What it holds |
|---|---|
| `secrets.bin` in the app data folder | Your API keys, encrypted with your system's secure storage (macOS Keychain, Windows DPAPI, or a Linux keyring). Readable by your user only. Keys are never shown in full to any window. |
| `.env` in the app data folder | Settings. Also API keys, in plain text readable only by your user, on systems with no secure storage (some Linux desktops); Settings says when that is the case. |
| `profile.json` in the app data folder | Your interview context and About you details. Readable by your user only on macOS and Linux. **Clear all** in Settings > About you removes the About you details. |
| `.whisper-models/` in the app data folder (or `WHISPER_MODEL_DIR`) | Downloaded speech models |
| `update-check.json` in the app data folder | When the last update check ran and the latest version it found |
| `last-crash.json` in the app data folder | Written only when Cuewell, a window or a helper process crashes: the time, Cuewell version, operating system, processor type, and the error name, message and stack trace. Your home folder and user name are replaced with `~` and `<user>`, and anything that looks like a key or token is removed. Cuewell does not add questions, transcripts, answers, screenshots, clipboard contents or settings to it, but an error message can sometimes quote part of what failed, such as an AI provider's error reply, so read the report before you submit it. On the next launch Cuewell offers once to report it, then deletes it whether you report it or not. |
| `~/.Cuewell/logs` | App events and errors, kept 14 days (error logs 30). Logs can contain parts of your session; read a log and remove anything private before you share it. |
| System temp folder | With the advanced Python Whisper setup, each recording is briefly saved as a WAV file and deleted after transcription |

The app data folder is `~/Library/Application Support/<app>` on macOS, `%APPDATA%\<app>` on Windows and `~/.config/<app>` on Linux. Questions, screenshots and conversation history are kept in memory only, and are gone when you quit.

Uninstalling Cuewell keeps the app data folder and the logs. Delete them yourself to remove everything.
