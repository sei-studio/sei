#!/bin/bash
# Build the macOS input executor helper (native/mac-input) into
# resources/mac-input/sei-mac-input as a UNIVERSAL binary, the same way
# build-mac-audio-tap.sh builds the audio tap. electron-builder.yml packs it via
# extraResources and electron-osx-sign signs it with the app's identity.
#
# Dev-only (backseat act spike, SEI_BACKSEAT_ACT). Skips itself on non-macOS,
# and skips the compile when the output is already newer than the source.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || exit 0

SRC=native/mac-input/main.swift
OUT_DIR=resources/mac-input
OUT="$OUT_DIR/sei-mac-input"

if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  exit 0
fi

mkdir -p "$OUT_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# macOS 13 floor to match the audio tap. Screenshots use SCScreenshotManager
# (macOS 14), guarded with @available at runtime; input and queries work on 13.
for ARCH in arm64 x86_64; do
  swiftc -O -target "$ARCH-apple-macos13.0" -o "$TMP/input-$ARCH" "$SRC"
done
lipo -create -output "$OUT" "$TMP/input-arm64" "$TMP/input-x86_64"
chmod +x "$OUT"
echo "built $OUT ($(lipo -archs "$OUT"))"
