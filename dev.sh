#!/usr/bin/env bash
# Link this checkout into the Omarchy plugin dir for hot-reload development.
# Edit files here; the shell picks up saves. Use `omarchy plugin add <git-url>`
# for a real install (this symlink workflow is development-only).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ID="h3nr1.d14z.jenkins"
DEST_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

REMOVE=0
RESTART=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) echo "Usage: ./dev.sh [--remove]"; exit 0 ;;
    --remove) REMOVE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ "$REMOVE" -eq 1 ]]; then
  if [[ -L "$DEST_DIR" ]]; then
    rm "$DEST_DIR"
    echo "==> Unlinked $DEST_DIR"
  else
    echo "==> No dev symlink at $DEST_DIR (nothing to remove)"
  fi
  exit 0
fi

mkdir -p "$HOME/.config/omarchy/plugins"
if [[ -e "$DEST_DIR" && ! -L "$DEST_DIR" ]]; then
  echo "==> $DEST_DIR exists and is not a symlink; refusing to overwrite" >&2
  exit 1
fi
ln -sfn "$SRC_DIR" "$DEST_DIR"
echo "==> Linked $DEST_DIR -> $SRC_DIR"
echo "==> Enable with: omarchy plugin enable $PLUGIN_ID"
echo "==> Token file (chmod 600): ~/.config/jenkins-health/token"
