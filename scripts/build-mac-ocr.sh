#!/bin/bash
# Build the macOS Vision screen-text helper (native/mac-ocr) into
# resources/mac-ocr/sei-mac-ocr as a UNIVERSAL binary, so the same file works
# inside both the arm64 and x64 app bundles (electron-builder.yml packs it via
# mac.extraResources and signs it via the Resources Mach-O sweep).
#
# Same shape as build-mac-audio-tap.sh: skips itself on non-macOS, and skips
# the compile when the output is already newer than the source.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || exit 0

SRC=native/mac-ocr/main.swift
OUT_DIR=resources/mac-ocr
OUT="$OUT_DIR/sei-mac-ocr"

if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  exit 0
fi

mkdir -p "$OUT_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# macOS 13 floor to match the audio tap, so both helpers have one story about
# which systems get the native path. Vision text recognition itself is much
# older; revision 3 is what wants 13.
for ARCH in arm64 x86_64; do
  swiftc -O -target "$ARCH-apple-macos13.0" -o "$TMP/ocr-$ARCH" "$SRC"
done
lipo -create -output "$OUT" "$TMP/ocr-arm64" "$TMP/ocr-x86_64"
chmod +x "$OUT"
echo "built $OUT ($(lipo -archs "$OUT"))"
