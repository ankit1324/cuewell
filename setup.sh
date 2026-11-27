#!/usr/bin/env bash
set -euo pipefail

DO_BUILD=0
DO_RUN=1
USE_CI=0
INSTALL_SYSTEM_DEPS=0
SETUP_WHISPER=1
# 1 = install the Python openai-whisper engine instead of fetching whisper.cpp.
PYTHON_WHISPER=0
WHISPER_MODEL="${WHISPER_MODEL:-base}"
WHISPER_LANGUAGE="${WHISPER_LANGUAGE:-en}"
WHISPER_SEGMENT_MS="${WHISPER_SEGMENT_MS:-4000}"
WHISPER_VENV_DIR=".venv-whisper"
# The openai-whisper release this app is tested with. Keep in sync with
# WHISPER_PIP_SPEC in src/core/whisper-installer.js.
WHISPER_PIP_SPEC="openai-whisper==20250625"
WHISPER_MODEL_DIR=".whisper-models"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS_NAME="unknown"
PLATFORM_BUILD_SCRIPT="build"
PYTHON_BIN=""
# One optional argument for PYTHON_BIN, e.g. -3.12 for the Windows py launcher.
PYTHON_ARG=""
WHISPER_PIP_PATH=""
WHISPER_COMMAND_PATH=""

print_header() {
  echo "========================================"
  echo " Cuewell Setup"
  echo "========================================"
}

usage() {
  cat <<EOF
Usage: ./setup.sh [options]

This script will:
1. Create .env from env.example when needed
2. Install Node dependencies
3. Fetch the built-in local voice engine (whisper.cpp) into vendor/whisper
   (or, with --python-whisper, install Python Whisper in ${WHISPER_VENV_DIR})
4. Optionally install system audio dependencies
5. Optionally build the app
6. Optionally run Cuewell

Options:
  --build                 Build a distributable for this OS
  --no-run                Do not start the app after setup
  --run                   Start the app after setup (default)
  --ci                    Use 'npm ci' instead of 'npm install'
  --install-system-deps   Install a microphone recorder on Linux (arecord or sox)
  --skip-whisper          Skip the local voice engine setup
  --python-whisper        Advanced: install the Python openai-whisper engine
                          (needs Python 3.10+ and 3 to 5 GB) instead of whisper.cpp
  -h, --help              Show this help

Environment variables:
  GEMINI_API_KEY          If provided, writes into .env
  WHISPER_MODEL           With --python-whisper: model to configure (default: base)
  WHISPER_LANGUAGE        With --python-whisper: language to configure (default: en)
  WHISPER_SEGMENT_MS      With --python-whisper: segment size in ms (default: 4000)

The speech model for the built-in engine (Small 190 MB or Base 60 MB)
downloads once from the Cuewell setup wizard or Settings > Voice.

Example:
  GEMINI_API_KEY=your_key_here ./setup.sh --install-system-deps
EOF
}

for arg in "$@"; do
  case "$arg" in
    --build) DO_BUILD=1 ;;
    --no-run) DO_RUN=0 ;;
    --run) DO_RUN=1 ;;
    --ci) USE_CI=1 ;;
    --install-system-deps) INSTALL_SYSTEM_DEPS=1 ;;
    --skip-whisper) SETUP_WHISPER=0 ;;
    --python-whisper) PYTHON_WHISPER=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg"; usage; exit 1 ;;
  esac
done

print_header
cd "$SCRIPT_DIR"

detect_os() {
  local uname_out
  uname_out=$(uname -s || echo "unknown")
  case "$uname_out" in
    Linux*) OS_NAME="linux" ;;
    Darwin*) OS_NAME="macos" ;;
    CYGWIN*|MINGW*|MSYS*) OS_NAME="windows" ;;
    *) OS_NAME="unknown" ;;
  esac

  case "$OS_NAME" in
    macos) PLATFORM_BUILD_SCRIPT="build:mac" ;;
    windows) PLATFORM_BUILD_SCRIPT="build:win" ;;
    linux) PLATFORM_BUILD_SCRIPT="build:linux" ;;
    *) PLATFORM_BUILD_SCRIPT="build" ;;
  esac

  case "$OS_NAME" in
    windows)
      WHISPER_PIP_PATH="${WHISPER_VENV_DIR}/Scripts/pip.exe"
      WHISPER_COMMAND_PATH="${WHISPER_VENV_DIR}/Scripts/whisper.exe"
      ;;
    *)
      WHISPER_PIP_PATH="${WHISPER_VENV_DIR}/bin/pip"
      WHISPER_COMMAND_PATH="${WHISPER_VENV_DIR}/bin/whisper"
      ;;
  esac
}

# Whether "$1" (plus optional argument "$2") runs Python 3.10 or newer.
python_is_supported() {
  "$1" ${2:+"$2"} -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

# Pick the Python for the Whisper venv: 3.12 first (best tested with PyTorch
# and numba), then 3.11, 3.10, 3.13, then the default python3 / python.
# On Windows (Git Bash), the py launcher is tried first. The Microsoft Store
# "python" stub fails the version check, so it is never picked.
find_python() {
  local version
  if [[ "$OS_NAME" == "windows" ]] && command -v py >/dev/null 2>&1; then
    for version in 3.12 3.11 3.10 3.13 3; do
      if python_is_supported py "-${version}"; then
        PYTHON_BIN="py"
        PYTHON_ARG="-${version}"
        return 0
      fi
    done
  fi
  for version in python3.12 python3.11 python3.10 python3.13 python3 python; do
    if command -v "$version" >/dev/null 2>&1 && python_is_supported "$version"; then
      PYTHON_BIN="$version"
      PYTHON_ARG=""
      return 0
    fi
  done
  return 1
}

require_command() {
  local cmd="$1"
  local message="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: ${message}"
    exit 1
  fi
}

# Electron 45 (and its npm package) needs Node.js 22.12 or newer.
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12

require_node_version() {
  if ! node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    const needMajor = Number(process.argv[1]);
    const needMinor = Number(process.argv[2]);
    process.exit(major > needMajor || (major === needMajor && minor >= needMinor) ? 0 : 1);
  ' "$MIN_NODE_MAJOR" "$MIN_NODE_MINOR"; then
    echo "Error: Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required (found $(node -v))."
    echo "Install a newer Node.js from https://nodejs.org/ and retry."
    exit 1
  fi
}

ensure_env_file() {
  if [[ ! -f .env ]]; then
    if [[ -f env.example ]]; then
      echo "Creating .env from env.example"
      cp env.example .env
    else
      echo "Error: env.example is missing"
      exit 1
    fi
  fi
  # .env holds API keys; keep it readable by the current user only.
  chmod 600 .env 2>/dev/null || true
}

# Set KEY=value in .env: replace the first KEY= line, or append one. awk
# reads the key and value from its environment (ENVIRON, not -v, which would
# expand backslash escapes), so characters such as $ @ | \ & stay plain data.
upsert_env() {
  local key="$1"
  local value="$2"
  local tmp

  case "$value" in
    *$'\n'*|*$'\r'*)
      echo "Error: refusing to write a multi-line value for ${key} to .env"
      return 1
      ;;
  esac

  [[ -f .env ]] || : > .env
  tmp="$(mktemp .env.XXXXXX)"
  chmod 600 "$tmp"
  if UPSERT_NAME="$key" UPSERT_VALUE="$value" awk '
    BEGIN { prefix = ENVIRON["UPSERT_NAME"] "="; value = ENVIRON["UPSERT_VALUE"]; done = 0 }
    !done && index($0, prefix) == 1 { print prefix value; done = 1; next }
    { print }
    END { if (!done) print prefix value }
  ' .env > "$tmp"; then
    mv -f "$tmp" .env
  else
    rm -f "$tmp"
    echo "Error: could not update ${key} in .env"
    return 1
  fi
}

# Run a command without API keys, tokens or secrets in its environment, so
# downloads, pip, Python and Whisper never see them.
run_without_secrets() {
  (
    local name
    for name in $(compgen -e); do
      case "$name" in
        *_KEY|*_TOKEN|*_SECRET|AZURE_SPEECH_KEY*) unset "$name" ;;
      esac
    done
    "$@"
  )
}

ensure_gemini_key() {
  if [[ -n "${GEMINI_API_KEY:-}" ]]; then
    upsert_env "GEMINI_API_KEY" "$GEMINI_API_KEY"
    # The app reads it from .env; keep it out of npm install scripts and the
    # other commands below.
    unset GEMINI_API_KEY
  fi

  # GEMINI_API_KEY is now OPTIONAL during setup. The app's first-run
  # flow will auto-open the Settings window if the key is missing and
  # guide the user to enter it. Hard-blocking at install time makes
  # CI / packaging / scripted installs harder for no real benefit.

  if ! grep -q '^GEMINI_API_KEY=' .env 2>/dev/null; then
    # Make sure the key exists in .env even if unset — the app reads
    # this on first-run to know whether onboarding is needed.
    echo "GEMINI_API_KEY=your_gemini_api_key_here" >> .env
  fi

  if grep -q 'your_gemini_api_key_here' .env 2>/dev/null; then
    echo ""
    echo "=========================================="
    echo " No Gemini API key detected"
    echo "=========================================="
    echo ""
    echo "The app will start, but AI features won't work until you set"
    echo "GEMINI_API_KEY in .env (or via the Settings window on first launch)."
    echo ""
    echo "Get a free key from: https://aistudio.google.com/"
    echo ""
    echo "Setup will continue without blocking."
    echo ""
  fi
}

install_system_deps() {
  if [[ "$INSTALL_SYSTEM_DEPS" -ne 1 ]]; then
    return
  fi

  echo "Attempting to install system audio dependencies"

  if command -v arecord >/dev/null 2>&1 || command -v sox >/dev/null 2>&1; then
    echo "A microphone recorder (arecord or sox) is already installed"
    return
  fi

  case "$OS_NAME" in
    macos)
      # Cuewell captures microphone audio via the renderer (Web Audio API) on
      # macOS, so the native sox/arecord recorders are not used. Skip installing
      # sox to avoid an unnecessary Homebrew dependency.
      echo "macOS uses built-in renderer audio capture; skipping sox install."
      ;;
    linux)
      # arecord (alsa-utils) is what Cuewell tries first on Linux.
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y && sudo apt-get install -y alsa-utils || echo "Could not install alsa-utils via apt-get"
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y alsa-utils || echo "Could not install alsa-utils via dnf"
      elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm alsa-utils || echo "Could not install alsa-utils via pacman"
      else
        echo "Unknown package manager. Install alsa-utils (arecord) or sox manually."
      fi
      ;;
    windows)
      echo "Windows uses the built-in microphone capture; nothing to install."
      ;;
    *)
      echo "Unknown OS. Install sox manually if you want microphone capture."
      ;;
  esac
}

install_node_deps() {
  if [[ -f package-lock.json && "$USE_CI" -eq 1 ]]; then
    echo "Installing Node dependencies with npm ci"
    npm ci
  else
    echo "Installing Node dependencies with npm install"
    npm install
  fi
}

# Clear the env.example Azure placeholders, but never a real Azure key.
clear_azure_placeholders() {
  if grep -qx 'AZURE_SPEECH_KEY=your_azure_speech_key_here' .env 2>/dev/null; then
    upsert_env "AZURE_SPEECH_KEY" ""
  fi
  if grep -qx 'AZURE_SPEECH_REGION=your_azure_region_here' .env 2>/dev/null; then
    upsert_env "AZURE_SPEECH_REGION" ""
  fi
}

# Fetch the pinned whisper.cpp whisper-server for this machine into
# vendor/whisper/<platform>-<arch>/ with the project's own script. It skips
# the work when a valid binary is already there. A failure only disables
# local voice; setup carries on.
setup_whisper_cpp() {
  if ! node -e 'const s = require("./package.json").scripts || {}; process.exit(s["fetch:whisper"] ? 0 : 1)' >/dev/null 2>&1; then
    echo "WARNING: this checkout has no 'npm run fetch:whisper' script, so the built-in"
    echo "voice engine was not set up. Update the repository and run ./setup.sh again."
    return
  fi

  echo "Setting up the built-in voice engine (whisper.cpp)"
  if [[ "$OS_NAME" == "macos" ]]; then
    echo "On macOS it is compiled from source the first time; this can take a few minutes."
  fi
  if run_without_secrets npm run fetch:whisper; then
    clear_azure_placeholders
    echo "The built-in voice engine is ready."
    echo "Cuewell downloads a speech model once (Small 190 MB or Base 60 MB) from"
    echo "the setup wizard or Settings > Voice."
  else
    echo "WARNING: the built-in voice engine could not be set up, so local voice is off."
    case "$OS_NAME" in
      macos)
        echo "Building it needs cmake and the Xcode Command Line Tools:"
        echo "  xcode-select --install"
        echo "  brew install cmake"
        ;;
      *)
        echo "Check your network connection. Only 64-bit (x64) Windows and Linux are supported."
        ;;
    esac
    echo "Then run ./setup.sh again, or use Azure Speech in Settings > Voice."
  fi
}

setup_voice() {
  if [[ "$SETUP_WHISPER" -ne 1 ]]; then
    echo "Skipping local voice setup"
    return
  fi

  # Skip it when only building: the build scripts fetch the engine they bundle.
  if [[ "$DO_BUILD" -eq 1 && "$DO_RUN" -eq 0 ]]; then
    echo "Skipping local voice setup (build-only mode)"
    return
  fi

  if [[ "$PYTHON_WHISPER" -eq 1 ]]; then
    setup_python_whisper
  else
    setup_whisper_cpp
  fi
}

# Advanced (--python-whisper): install openai-whisper into a Python venv.
setup_python_whisper() {
  if [[ ! -d "$WHISPER_VENV_DIR" ]]; then
    if ! find_python; then
      echo "WARNING: Python 3.10 or newer was not found, so local Whisper was not set up."
      echo "Install Python 3.12 (https://www.python.org/downloads/), then run ./setup.sh --python-whisper again,"
      echo "or run ./setup.sh without --python-whisper to use the built-in engine, which needs no Python."
      return
    fi
    echo "Creating Whisper virtual environment at $WHISPER_VENV_DIR with $PYTHON_BIN ${PYTHON_ARG}"
    if ! run_without_secrets "$PYTHON_BIN" ${PYTHON_ARG:+"$PYTHON_ARG"} -m venv "$WHISPER_VENV_DIR"; then
      echo "WARNING: Could not create the Whisper virtual environment."
      if [[ "$OS_NAME" == "linux" ]]; then
        echo "On Debian and Ubuntu, install the venv module first: sudo apt install python3-venv"
      fi
      return
    fi
  fi

  echo "Installing local Whisper into $WHISPER_VENV_DIR"
  run_without_secrets "$WHISPER_PIP_PATH" install --upgrade pip || true
  run_without_secrets "$WHISPER_PIP_PATH" install "$WHISPER_PIP_SPEC" || {
    echo "WARNING: pip install ${WHISPER_PIP_SPEC} failed. Whisper may be unavailable."
    echo "Common causes: insufficient disk space (needs ~3-5 GB), missing Python headers, or network issues."
  }

  mkdir -p "$WHISPER_MODEL_DIR"

  # Verify Whisper loads before claiming it's configured. Prefer
  # "<venv python> -m whisper": the app checks that form quickly at startup,
  # while the whisper script has to import PyTorch first.
  local venv_python
  if [[ "$OS_NAME" == "windows" ]]; then
    venv_python="${WHISPER_VENV_DIR}/Scripts/python.exe"
  else
    venv_python="${WHISPER_VENV_DIR}/bin/python"
  fi
  if [[ -f "$venv_python" ]] && run_without_secrets "$venv_python" -c 'import whisper' >/dev/null 2>&1; then
    WHISPER_COMMAND_PATH="${venv_python} -m whisper"
    echo "Whisper is installed: $WHISPER_COMMAND_PATH"
  else
    if [[ -f "$WHISPER_COMMAND_PATH" ]]; then
      echo "Whisper CLI found at: $WHISPER_COMMAND_PATH"
    else
      echo "WARNING: Whisper CLI not found at $WHISPER_COMMAND_PATH"
      echo "Speech recognition will be unavailable until Whisper is properly installed."
      echo "Run ./setup.sh without --python-whisper to use the built-in engine instead."
      echo "Your voice settings in .env were left unchanged."
      return
    fi
  fi

  upsert_env "SPEECH_PROVIDER" "whisper"
  clear_azure_placeholders
  upsert_env "WHISPER_ENGINE" "python"
  upsert_env "WHISPER_COMMAND" "${WHISPER_COMMAND_PATH}"
  upsert_env "WHISPER_MODEL_DIR" "${WHISPER_MODEL_DIR}"
  upsert_env "WHISPER_MODEL" "${WHISPER_MODEL}"
  upsert_env "WHISPER_LANGUAGE" "${WHISPER_LANGUAGE}"
  upsert_env "WHISPER_SEGMENT_MS" "${WHISPER_SEGMENT_MS}"

  echo "Running Whisper smoke test"
  run_without_secrets npm run test-speech
}

build_app() {
  if [[ "$DO_BUILD" -eq 1 ]]; then
    echo "Building app for $OS_NAME with npm run $PLATFORM_BUILD_SCRIPT"
    npm run "$PLATFORM_BUILD_SCRIPT"
  fi
}

run_app() {
  if [[ "$DO_RUN" -eq 1 ]]; then
    echo "Starting app"
    npm start
  else
    echo "Setup complete. Skipping run."
  fi
}

detect_os
echo "Detected OS: $OS_NAME"
if [[ "$OS_NAME" == "windows" ]]; then
  echo "Tip: on Windows you can also run .\\setup.ps1 from PowerShell."
fi
require_command node "Node.js 22.12+ is required."
require_node_version
require_command npm "npm is required."
echo "Node: $(node -v)"
echo "npm:  $(npm -v)"

ensure_env_file
ensure_gemini_key
install_system_deps
install_node_deps
setup_voice
build_app
run_app
