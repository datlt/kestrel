#!/usr/bin/env bash
# Builds the release app (Kestrel.app, no DMG) and puts the newest copy in the
# repository folder, so you can open ./Kestrel.app after each build.
#
# Usage: scripts/build-app.sh [--open]
#   --open  quit a running Kestrel, then start the new build.
set -euo pipefail

cd "$(dirname "$0")/.."
open_after=0
[ "${1:-}" = "--open" ] && open_after=1

npx tauri build --bundles app

if [ "$(uname)" != "Darwin" ]; then
  echo "The app bundle is in target/release/bundle/"
  exit 0
fi

src="target/release/bundle/macos/Kestrel.app"
dest="Kestrel.app"

if [ "$open_after" = 1 ]; then
  # Quit the old build first, so it can save its session.
  osascript -e 'tell application "Kestrel" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do
    pgrep -f "$PWD/$dest/Contents/MacOS/kestrel" >/dev/null || break
    sleep 0.1
  done
fi

# Copy next to the old app, then swap, so a failed copy never leaves a broken app.
rm -rf "$dest.new"
cp -R "$src" "$dest.new"
rm -rf "$dest"
mv "$dest.new" "$dest"
echo "Built: $PWD/$dest"

if [ "$open_after" = 1 ]; then
  open "$dest"
fi
