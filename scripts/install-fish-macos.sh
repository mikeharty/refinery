#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install Fish-Speech locally for macOS without touching global Fish installs.

Usage:
  scripts/install-fish-macos.sh [options]

Options:
  --update              Fetch and fast-forward an existing project-local clone.
  --skip-model          Install Fish-Speech dependencies but skip model download.
  --install-brew-deps   Install ffmpeg, sox, and portaudio with Homebrew if missing.
  --cpu-extra           Use Fish-Speech's CPU uv extra instead of the default install.
  --dry-run             Print what would happen without changing files.
  -h, --help            Show this help.

Environment:
  REFINERY_FISH_NATIVE_ROOT   Install root. Default: ./.local/fish-speech
  FISH_SPEECH_REPO_URL        Fish-Speech Git URL.
  FISH_SPEECH_REPO_REF        Branch/tag/SHA to checkout. Default: main
  FISH_SPEECH_MODEL_REPO      Hugging Face model repo. Default: fishaudio/s2-pro
  FISH_SPEECH_CHECKPOINT      Local checkpoint folder name. Default: s2-pro
  FISH_SPEECH_PYTHON_VERSION  Python version for uv sync. Default: 3.12
  FISH_SPEECH_UV_EXTRA        Optional uv extra. Usually leave empty on macOS.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${REFINERY_FISH_NATIVE_ROOT:-"$ROOT_DIR/.local/fish-speech"}"
REPO_DIR="$INSTALL_ROOT/repo"
CHECKPOINT_ROOT="$INSTALL_ROOT/checkpoints"
REPO_URL="${FISH_SPEECH_REPO_URL:-https://github.com/fishaudio/fish-speech.git}"
REPO_REF="${FISH_SPEECH_REPO_REF:-main}"
MODEL_REPO="${FISH_SPEECH_MODEL_REPO:-fishaudio/s2-pro}"
CHECKPOINT_NAME="${FISH_SPEECH_CHECKPOINT:-s2-pro}"
PYTHON_VERSION="${FISH_SPEECH_PYTHON_VERSION:-3.12}"
UV_EXTRA="${FISH_SPEECH_UV_EXTRA:-}"

UPDATE=0
SKIP_MODEL=0
INSTALL_BREW_DEPS=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --update) UPDATE=1 ;;
    --skip-model) SKIP_MODEL=1 ;;
    --install-brew-deps) INSTALL_BREW_DEPS=1 ;;
    --cpu-extra) UV_EXTRA="cpu" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

run() {
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    return 1
  fi
}

has_portaudio_headers() {
  if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists portaudio-2.0; then
    return 0
  fi
  [[ -f /opt/homebrew/include/portaudio.h || -f /usr/local/include/portaudio.h ]]
}

check_native_deps() {
  local missing=()
  command -v ffmpeg >/dev/null 2>&1 || missing+=(ffmpeg)
  command -v sox >/dev/null 2>&1 || missing+=(sox)
  has_portaudio_headers || missing+=(portaudio)

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return 0
  fi

  echo "Missing native dependency/dependencies: ${missing[*]}" >&2
  echo >&2
  echo "Fish-Speech depends on PyAudio, which needs PortAudio headers at install time." >&2
  echo "Install the missing Homebrew packages with:" >&2
  echo >&2
  echo "  scripts/install-fish-macos.sh --install-brew-deps" >&2
  echo >&2
  echo "Or install only the missing packages yourself:" >&2
  echo >&2
  echo "  brew install ${missing[*]}" >&2
  return 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for native macOS Fish-Speech installs only." >&2
  exit 1
fi

require_cmd git
require_cmd uv

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Warning: this script is intended for Apple Silicon. Continuing on $(uname -m)." >&2
fi

if [[ "$INSTALL_BREW_DEPS" -eq 1 ]]; then
  require_cmd brew
  for pkg in ffmpeg sox portaudio; do
    if ! brew list "$pkg" >/dev/null 2>&1; then
      run brew install "$pkg"
    fi
  done
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  check_native_deps
fi

if [[ -e "$REPO_DIR" && ! -d "$REPO_DIR/.git" ]]; then
  echo "Refusing to use existing non-Git directory: $REPO_DIR" >&2
  exit 1
fi

run mkdir -p "$INSTALL_ROOT"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  run git clone --filter=blob:none "$REPO_URL" "$REPO_DIR"
  run git -C "$REPO_DIR" checkout "$REPO_REF"
else
  origin_url="$(git -C "$REPO_DIR" remote get-url origin)"
  if [[ "$origin_url" != "$REPO_URL" ]]; then
    echo "Refusing to modify existing clone with different origin:" >&2
    echo "  $REPO_DIR" >&2
    echo "  origin: $origin_url" >&2
    echo "Expected:" >&2
    echo "  $REPO_URL" >&2
    exit 1
  fi

  if [[ "$UPDATE" -eq 1 ]]; then
    if ! git -C "$REPO_DIR" diff --quiet || ! git -C "$REPO_DIR" diff --cached --quiet; then
      echo "Refusing to update dirty Fish-Speech clone: $REPO_DIR" >&2
      exit 1
    fi
    run git -C "$REPO_DIR" fetch --tags origin
    run git -C "$REPO_DIR" checkout "$REPO_REF"
    current_branch="$(git -C "$REPO_DIR" branch --show-current || true)"
    if [[ -n "$current_branch" ]]; then
      run git -C "$REPO_DIR" pull --ff-only
    fi
  else
    echo "Using existing project-local Fish-Speech clone: $REPO_DIR"
    echo "Pass --update to fetch and fast-forward it."
  fi
fi

sync_cmd=(uv --project "$REPO_DIR" sync --python "$PYTHON_VERSION")
if [[ -n "$UV_EXTRA" ]]; then
  sync_cmd+=(--extra "$UV_EXTRA")
fi
run env PYTORCH_ENABLE_MPS_FALLBACK=1 "${sync_cmd[@]}"

if [[ "$SKIP_MODEL" -eq 0 ]]; then
  model_dir="$CHECKPOINT_ROOT/$CHECKPOINT_NAME"
  if [[ -f "$model_dir/codec.pth" ]]; then
    echo "Model checkpoint already present: $model_dir"
  else
    run mkdir -p "$model_dir"
    echo "Downloading $MODEL_REPO to $model_dir"
    echo "Review Fish Audio's model license before using the weights commercially."
    run uvx --from "huggingface_hub" hf download "$MODEL_REPO" --local-dir "$model_dir"
  fi
fi

cat <<EOF

Fish-Speech native install is ready.

Install root:
  $INSTALL_ROOT

Start the local API server:
  scripts/start-fish-macos.sh

Point Refinery at:
  FISH_TTS_URL=http://127.0.0.1:8080/v1/tts

Uninstall only this project-local install:
  scripts/uninstall-fish-macos.sh
EOF
