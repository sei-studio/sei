#!/usr/bin/env bash
# scripts/build-terraria-mod.sh [--tml-dir DIR] [--out DIR]
#
# Builds the Sei companion tModLoader mod (native/terraria-mod/SeiCompanion)
# into <repo>/assets/terraria-mod/SeiCompanion.tmod, the path both the dev app
# and the Terraria game pack read (scripts/build-game-pack.mjs terraria zips
# assets/terraria-mod).
#
# Needs the .NET 8 SDK. The mod compiles against tModLoader.dll; with no
# --tml-dir (or TML_DIR) it downloads the pinned tModLoader release zip from
# GitHub into native/terraria-mod/.tml once (no Steam, no game needed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOD_DIR="$ROOT/native/terraria-mod"
OUT="$ROOT/assets/terraria-mod"
TML_VERSION="${TML_VERSION:-v2026.09.3.1}"
TML_DIR="${TML_DIR:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tml-dir) TML_DIR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! command -v dotnet >/dev/null 2>&1; then
  if [[ -x "$HOME/.dotnet/dotnet" ]]; then export PATH="$HOME/.dotnet:$PATH"; else
    echo "[build-terraria-mod] dotnet SDK not found. Install the .NET 8 SDK: https://dotnet.microsoft.com/download" >&2
    exit 1
  fi
fi

if [[ -z "$TML_DIR" ]]; then
  TML_DIR="$MOD_DIR/.tml/$TML_VERSION"
  if [[ ! -f "$TML_DIR/tModLoader.dll" ]]; then
    echo "[build-terraria-mod] downloading tModLoader $TML_VERSION"
    mkdir -p "$TML_DIR"
    tmp="$(mktemp -d)"
    curl -fsSL --max-time 300 -o "$tmp/tModLoader.zip" \
      "https://github.com/tModLoader/tModLoader/releases/download/$TML_VERSION/tModLoader.zip"
    unzip -q "$tmp/tModLoader.zip" -d "$TML_DIR"
    rm -rf "$tmp"
  fi
fi
if [[ ! -f "$TML_DIR/tMLMod.targets" ]]; then
  echo "[build-terraria-mod] $TML_DIR is not a tModLoader install (no tMLMod.targets)" >&2
  exit 1
fi

# Build from a staging copy: the .tmod records the source folder and the
# pdb path, and the repo is public, so neither may name a developer's home.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SAVE_DIR="$WORK/save"
STAGE="$WORK/src/SeiCompanion"
mkdir -p "$SAVE_DIR" "$STAGE"
(cd "$MOD_DIR/SeiCompanion" && tar --exclude=bin --exclude=obj -cf - .) | (cd "$STAGE" && tar -xf -)
dotnet build "$STAGE/SeiCompanion.csproj" -c Release -p:TmlDir="$TML_DIR" \
  "-p:PathMap=$STAGE=SeiCompanion" -p:DebugType=embedded \
  "-p:ExtraBuildModFlags=-tmlsavedirectory $SAVE_DIR" -nologo -v:minimal
TMOD="$SAVE_DIR/Mods/SeiCompanion.tmod"
if [[ ! -f "$TMOD" ]]; then
  echo "[build-terraria-mod] build finished but $TMOD is missing" >&2
  exit 1
fi
mkdir -p "$OUT"
cp "$TMOD" "$OUT/SeiCompanion.tmod"
echo "[build-terraria-mod] wrote $OUT/SeiCompanion.tmod ($(wc -c < "$OUT/SeiCompanion.tmod") bytes)"
