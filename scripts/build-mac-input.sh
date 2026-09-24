#!/bin/bash
# Build the macOS input executor helper (native/mac-input) into
# resources/mac-input/sei-mac-input as a UNIVERSAL binary, the same way
# build-mac-audio-tap.sh builds the audio tap. electron-builder.yml packs it via
# extraResources and electron-osx-sign signs it with the app's identity.
#
# Dev-only (backseat act spike, SEI_BACKSEAT_ACT). Skips itself on non-macOS,
# and skips the compile when the output is already newer than the source.
#
# A compile failure is NOT fatal (predist runs this on every mac release, flag
# on or off): the output is removed, a loud warning goes to the log (and to the
# GitHub Actions annotations), the release ships without the helper
# (electron-builder skips a missing extraResources dir with a warning), and the
# app reports the feature as unavailable. SEI_MAC_INPUT_STRICT=1 (the CI helper
# job) makes it fatal again.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || exit 0

SRC=native/mac-input/main.swift
OUT_DIR=resources/mac-input
OUT="$OUT_DIR/sei-mac-input"

if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

build() {
  # macOS 13 floor to match the audio tap. Screenshots use SCScreenshotManager
  # (macOS 14), guarded with @available at runtime; input and queries work on 13.
  for ARCH in arm64 x86_64; do
    swiftc -O -target "$ARCH-apple-macos13.0" -o "$TMP/input-$ARCH" "$SRC" || return 1
  done
  lipo -create -output "$TMP/sei-mac-input" "$TMP/input-arm64" "$TMP/input-x86_64" || return 1
}

if ! build; then
  rm -rf "$OUT_DIR"
  if [ "${SEI_MAC_INPUT_STRICT:-}" = "1" ]; then
    echo "sei-mac-input: build FAILED" >&2
    exit 1
  fi
  echo "::warning title=sei-mac-input not built::The backseat control helper failed to compile. This build ships WITHOUT it and backseat control reports unavailable. Nothing else is affected."
  echo "==================================================================" >&2
  echo "sei-mac-input: BUILD FAILED. Continuing WITHOUT the helper:" >&2
  echo "  resources/mac-input is removed, electron-builder skips it, and" >&2
  echo "  backseat control (SEI_BACKSEAT_ACT) reports unavailable." >&2
  echo "==================================================================" >&2
  exit 0
fi
mkdir -p "$OUT_DIR"
mv "$TMP/sei-mac-input" "$OUT"
chmod +x "$OUT"
echo "built $OUT ($(lipo -archs "$OUT"))"
