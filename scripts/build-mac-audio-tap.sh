#!/bin/bash
# Build the macOS system-audio tap helper (native/mac-audio-tap) into
# resources/audio-tap/sei-audio-tap as a UNIVERSAL binary, so the same file
# works inside both the arm64 and x64 app bundles (electron-builder.yml packs
# it via extraResources and signs it via mac.binaries).
#
# Skips itself on non-macOS, and skips the compile when the output is already
# newer than the source — safe to hang off predev/predist:mac.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || exit 0

SRC=native/mac-audio-tap/main.swift
OUT_DIR=resources/audio-tap
OUT="$OUT_DIR/sei-audio-tap"

if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  exit 0
fi

mkdir -p "$OUT_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# macOS 13 is the SCK-audio floor; the binary itself still LOADS on older
# versions because availability is guarded at runtime (it exits with the
# version error and the renderer falls back to video-only).
for ARCH in arm64 x86_64; do
  swiftc -O -target "$ARCH-apple-macos13.0" -o "$TMP/tap-$ARCH" "$SRC"
done
lipo -create -output "$OUT" "$TMP/tap-arm64" "$TMP/tap-x86_64"
chmod +x "$OUT"
echo "built $OUT ($(lipo -archs "$OUT"))"
