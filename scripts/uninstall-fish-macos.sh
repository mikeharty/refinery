#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${REFINERY_FISH_NATIVE_ROOT:-"$ROOT_DIR/.local/fish-speech"}"

usage() {
  cat <<'EOF'
Remove the project-local native macOS Fish-Speech install.

This removes only REFINERY_FISH_NATIVE_ROOT, which defaults to:
  ./.local/fish-speech

It does not remove global Fish-Speech clones, Homebrew packages, uv caches,
Docker images, Docker volumes, or Refinery reference audio.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

if [[ ! -e "$INSTALL_ROOT" ]]; then
  echo "Nothing to remove: $INSTALL_ROOT"
  exit 0
fi

resolved_root="$(cd "$(dirname "$INSTALL_ROOT")" && pwd)/$(basename "$INSTALL_ROOT")"
project_root="$(cd "$ROOT_DIR" && pwd)"

if [[ "$resolved_root" != "$project_root"/.local/fish-speech && -z "${REFINERY_FISH_NATIVE_ROOT:-}" ]]; then
  echo "Safety check failed for install root: $resolved_root" >&2
  exit 1
fi

echo "This will permanently delete the project-local Fish-Speech install:"
du -sh "$INSTALL_ROOT" 2>/dev/null || true
echo "  $INSTALL_ROOT"
echo
echo "It will not remove global Fish installs, Homebrew packages, uv caches, Docker images, or Docker volumes."
echo
printf 'Type DELETE %s to continue: ' "$INSTALL_ROOT"
read -r confirmation

if [[ "$confirmation" != "DELETE $INSTALL_ROOT" ]]; then
  echo "Aborted."
  exit 1
fi

rm -rf "$INSTALL_ROOT"
echo "Removed: $INSTALL_ROOT"
