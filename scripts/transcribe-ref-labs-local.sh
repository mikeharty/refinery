#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Bootstrap and run local Refinery reference transcription.

Usage:
  scripts/transcribe-ref-labs-local.sh [refs/path] [transcribe_ref_labs.py options]

Examples:
  scripts/transcribe-ref-labs-local.sh refs/bender-moods --dry-run
  scripts/transcribe-ref-labs-local.sh refs/bender-moods --language en --limit 5
  scripts/transcribe-ref-labs-local.sh refs/bender-moods --language en --mlx-model mlx-community/whisper-small.en-mlx
  scripts/transcribe-ref-labs-local.sh refs/bender-moods --provider faster-whisper --language en --local-model medium.en

Behavior:
  - On Apple Silicon macOS, defaults to mlx-whisper.
  - Everywhere else, defaults to faster-whisper.
  - Local transcription defaults to large Whisper models.
  - Python packages are installed by uv on first run into uv's cache.
  - macOS ffmpeg is installed with Homebrew if missing.
  - --dry-run and --help do not install ML dependencies.

Environment:
  REFINERY_TRANSCRIBE_PROVIDER       Override provider: mlx-whisper, faster-whisper, whisper-cli.
  REFINERY_MLX_TRANSCRIBE_MODEL      Default MLX model.
  REFINERY_LOCAL_TRANSCRIBE_MODEL    Default faster-whisper/whisper-cli model.
  REFINERY_TRANSCRIBE_SKIP_BREW=1    Do not install ffmpeg with Homebrew.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

has_arg() {
  local name="$1"
  shift
  for arg in "$@"; do
    if [[ "$arg" == "$name" || "$arg" == "$name="* ]]; then
      return 0
    fi
  done
  return 1
}

value_after_arg() {
  local name="$1"
  shift
  local previous=""
  for arg in "$@"; do
    if [[ "$previous" == "$name" ]]; then
      printf '%s\n' "$arg"
      return 0
    fi
    if [[ "$arg" == "$name="* ]]; then
      printf '%s\n' "${arg#*=}"
      return 0
    fi
    previous="$arg"
  done
  return 1
}

provider_from_args() {
  local from_args=""
  from_args="$(value_after_arg "--provider" "$@" || true)"
  if [[ -n "$from_args" ]]; then
    printf '%s\n' "$from_args"
    return 0
  fi
  if [[ -n "${REFINERY_TRANSCRIBE_PROVIDER:-}" ]]; then
    printf '%s\n' "$REFINERY_TRANSCRIBE_PROVIDER"
    return 0
  fi
  if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
    printf '%s\n' "mlx-whisper"
  else
    printf '%s\n' "faster-whisper"
  fi
}

ensure_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1; then
    return 0
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ "${REFINERY_TRANSCRIBE_SKIP_BREW:-0}" == "1" ]]; then
      echo "Missing ffmpeg. Install with: brew install ffmpeg" >&2
      return 1
    fi
    if ! command -v brew >/dev/null 2>&1; then
      echo "Missing ffmpeg and Homebrew is unavailable. Install ffmpeg first." >&2
      return 1
    fi
    echo "Installing ffmpeg with Homebrew..."
    brew install ffmpeg
    return 0
  fi

  echo "Missing ffmpeg. Install it with your system package manager first." >&2
  return 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] || has_arg "-h" "$@" || has_arg "--help" "$@"; then
  usage
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "Missing required command: uv" >&2
  exit 1
fi

if has_arg "--dry-run" "$@"; then
  cd "$ROOT_DIR"
  exec uv run python scripts/transcribe_ref_labs.py "$@"
fi

ensure_ffmpeg

provider="$(provider_from_args "$@")"
uv_args=(uv run)
script_args=("$@")

case "$provider" in
  mlx-whisper)
    uv_args+=(--with mlx-whisper --with hf-xet)
    if ! has_arg "--provider" "${script_args[@]}"; then
      script_args+=(--provider mlx-whisper)
    fi
    ;;
  faster-whisper)
    uv_args+=(--with faster-whisper)
    if ! has_arg "--provider" "${script_args[@]}"; then
      script_args+=(--provider faster-whisper)
    fi
    ;;
  whisper-cli)
    uv_args+=(--with openai-whisper)
    if ! has_arg "--provider" "${script_args[@]}"; then
      script_args+=(--provider whisper-cli)
    fi
    ;;
  auto)
    if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
      uv_args+=(--with mlx-whisper --with hf-xet)
    else
      uv_args+=(--with faster-whisper)
    fi
    ;;
  *)
    echo "Unsupported local transcription provider: $provider" >&2
    echo "Use mlx-whisper, faster-whisper, or whisper-cli." >&2
    exit 2
    ;;
esac

echo "Local transcription provider: $provider"
cd "$ROOT_DIR"
exec "${uv_args[@]}" python scripts/transcribe_ref_labs.py "${script_args[@]}"
