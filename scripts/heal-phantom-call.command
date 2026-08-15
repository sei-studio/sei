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
  SEI="/Applications/Sei.app/Contents/MacOS/Sei"
  if [ ! -x "$SEI" ]; then
    echo "Neither Node.js nor the Sei app was found. Install Sei to /Applications first."
    read -r -p "Press Enter to close." _
    exit 1
  fi
  ELECTRON_RUN_AS_NODE=1 "$SEI" "$SCRIPT" "$@"
fi
echo
read -r -p "Finished. Press Enter to close this window." _
