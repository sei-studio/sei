#!/bin/bash
# Double-clickable macOS wrapper for heal-phantom-call.mjs.
# Keep this file in the same folder as heal-phantom-call.mjs.
cd "$(dirname "$0")"
SCRIPT="heal-phantom-call.mjs"
if [ ! -f "$SCRIPT" ]; then
  echo "heal-phantom-call.mjs not found next to this file."
  read -r -p "Press Enter to close." _
  exit 1
fi
if command -v node >/dev/null 2>&1; then
  node "$SCRIPT" "$@"
else
  # Sei's packaged binary has the RunAsNode fuse off (electron-builder.yml
  # electronFuses), so it can no longer stand in for Node here.
  echo "Node.js was not found. Install it from https://nodejs.org (any LTS),"
  echo "or use the phantom-call repair inside Sei instead."
  read -r -p "Press Enter to close." _
  exit 1
fi
echo
read -r -p "Finished. Press Enter to close this window." _
