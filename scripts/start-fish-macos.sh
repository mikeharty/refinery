#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Start the project-local native macOS Fish-Speech API server.

Usage:
  scripts/start-fish-macos.sh [options]

Options:
  --cpu          Use CPU instead of Apple MPS.
  --no-half      Do not pass --half to Fish-Speech.
  -h, --help     Show this help.

Environment:
  REFINERY_FISH_NATIVE_ROOT  Install root. Default: ./.local/fish-speech
  FISH_SPEECH_DEVICE         mps or cpu. Default: mps
  FISH_SPEECH_HOST           Listen host. Default: 127.0.0.1
  FISH_SPEECH_API_PORT       Listen port. Default: 8080
  FISH_SPEECH_HALF           1/0. Default: 1 for mps, 0 for cpu
  FISH_SPEECH_API_KEY        Optional API bearer token.
  FISH_SPEECH_EXTRA_ARGS     Extra args appended to tools/api_server.py.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${REFINERY_FISH_NATIVE_ROOT:-"$ROOT_DIR/.local/fish-speech"}"
REPO_DIR="$INSTALL_ROOT/repo"
CHECKPOINT_NAME="${FISH_SPEECH_CHECKPOINT:-s2-pro}"
CHECKPOINT_DIR="$INSTALL_ROOT/checkpoints/$CHECKPOINT_NAME"
DEVICE="${FISH_SPEECH_DEVICE:-mps}"
HOST="${FISH_SPEECH_HOST:-127.0.0.1}"
PORT="${FISH_SPEECH_API_PORT:-8080}"
HALF="${FISH_SPEECH_HALF:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cpu) DEVICE="cpu" ;;
    --no-half) HALF="0" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This launcher is for native macOS Fish-Speech installs only." >&2
  exit 1
fi

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "Fish-Speech is not installed at $REPO_DIR" >&2
  echo "Run scripts/install-fish-macos.sh first." >&2
  exit 1
fi

if [[ ! -f "$CHECKPOINT_DIR/codec.pth" ]]; then
  echo "Missing model checkpoint: $CHECKPOINT_DIR/codec.pth" >&2
  echo "Run scripts/install-fish-macos.sh without --skip-model, or set FISH_SPEECH_CHECKPOINT." >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Set FISH_SPEECH_API_PORT to another port." >&2
  exit 1
fi

if [[ -z "$HALF" ]]; then
  if [[ "$DEVICE" == "cpu" ]]; then
    HALF="0"
  else
    HALF="1"
  fi
fi

args=(
  tools/api_server.py
  --llama-checkpoint-path "$CHECKPOINT_DIR"
  --decoder-checkpoint-path "$CHECKPOINT_DIR/codec.pth"
  --device "$DEVICE"
  --listen "$HOST:$PORT"
)

if [[ "$HALF" == "1" ]]; then
  args+=(--half)
fi

if [[ -n "${FISH_SPEECH_API_KEY:-}" ]]; then
  args+=(--api-key "$FISH_SPEECH_API_KEY")
fi

if [[ -n "${FISH_SPEECH_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  extra_args=($FISH_SPEECH_EXTRA_ARGS)
  args+=("${extra_args[@]}")
fi

cat <<EOF
Starting Fish-Speech:
  repo:   $REPO_DIR
  model:  $CHECKPOINT_DIR
  device: $DEVICE
  listen: http://$HOST:$PORT

Refinery endpoint:
  FISH_TTS_URL=http://$HOST:$PORT/v1/tts
EOF

cd "$REPO_DIR"
export PYTORCH_ENABLE_MPS_FALLBACK="${PYTORCH_ENABLE_MPS_FALLBACK:-1}"
exec uv run python "${args[@]}"
