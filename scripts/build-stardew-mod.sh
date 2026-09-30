#!/usr/bin/env bash
# scripts/build-stardew-mod.sh [--game-path DIR] [--out DIR] [--configuration Release]
#
# Builds the Sei companion SMAPI mod (native/stardew-mod/SeiCompanion) into
#   <repo>/assets/stardew-mod/SeiCompanion/   (DLL + manifest.json + Assets/)
# which is the path BOTH the dev app and the game pack read: in dev
# ensurePack('stardew') resolves to the repo root, and the pack builder
# (scripts/build-game-pack.mjs stardew) zips this same directory under
# assets/, so <packRoot>/assets/stardew-mod/SeiCompanion is one relative path
# everywhere.
#
# Needs: the .NET SDK (6+; the mod targets net6.0, the 10.x SDK builds it) and
# the Stardew Valley game folder, because Pathoschild.Stardew.ModBuildConfig
# resolves Stardew Valley.dll, StardewModdingAPI.dll, MonoGame and xTile from
# it. Without the game this script fails fast with a clear message: the
# reference assemblies are not redistributable, so a machine that has never
# installed the game cannot compile the mod. See native/stardew-mod/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/native/stardew-mod/SeiCompanion/SeiCompanion.csproj"
OUT="$ROOT/assets/stardew-mod/SeiCompanion"
CONFIG="Release"
GAME_PATH="${GAME_PATH:-${STARDEW_GAME_PATH:-}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --game-path) GAME_PATH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --configuration) CONFIG="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! command -v dotnet >/dev/null 2>&1; then
  echo "[build-stardew-mod] dotnet SDK not found. Install .NET SDK 6 or newer: https://dotnet.microsoft.com/download" >&2
  exit 1
fi

# Where the game usually lives (SMAPI's GameScanner defaults; the installer
# in src/main/games/stardew/install.ts ports the same list).
detect_game_path() {
  local candidates=()
  case "$(uname -s)" in
    Darwin)
      candidates+=("$HOME/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS")
      candidates+=("/Applications/Stardew Valley.app/Contents/MacOS")
      ;;
    Linux)
      candidates+=("$HOME/.steam/steam/steamapps/common/Stardew Valley")
      candidates+=("$HOME/.local/share/Steam/steamapps/common/Stardew Valley")
      candidates+=("$HOME/GOG Games/Stardew Valley/game")
      candidates+=("$HOME/.var/app/com.valvesoftware.Steam/data/Steam/steamapps/common/Stardew Valley")
      ;;
    MINGW*|MSYS*|CYGWIN*)
      candidates+=("/c/Program Files (x86)/Steam/steamapps/common/Stardew Valley")
      candidates+=("/c/Program Files/Steam/steamapps/common/Stardew Valley")
      candidates+=("/c/Program Files (x86)/GOG Galaxy/Games/Stardew Valley")
      ;;
  esac
  for c in "${candidates[@]}"; do
    if [[ -f "$c/Stardew Valley.dll" ]]; then echo "$c"; return 0; fi
  done
  return 1
}

if [[ -z "$GAME_PATH" ]]; then
  GAME_PATH="$(detect_game_path || true)"
fi
if [[ -z "$GAME_PATH" || ! -f "$GAME_PATH/Stardew Valley.dll" ]]; then
  cat >&2 <<MSG
[build-stardew-mod] Stardew Valley was not found${GAME_PATH:+ at "$GAME_PATH"}.

The mod compiles against the game's own assemblies (Stardew Valley.dll,
StardewModdingAPI.dll, MonoGame.Framework.dll, xTile.dll), which ship with the
game and cannot be redistributed. Build on a machine with the game installed
(SMAPI installed too, since StardewModdingAPI.dll comes from it) and pass the
folder that contains "Stardew Valley.dll":

  scripts/build-stardew-mod.sh --game-path "/path/to/Stardew Valley"
  (macOS: ".../Stardew Valley/Contents/MacOS")

or export GAME_PATH / STARDEW_GAME_PATH. See native/stardew-mod/README.md.
MSG
  exit 3
fi
if [[ ! -f "$GAME_PATH/StardewModdingAPI.dll" ]]; then
  echo "[build-stardew-mod] SMAPI is not installed in \"$GAME_PATH\" (no StardewModdingAPI.dll). Install SMAPI first: https://smapi.io" >&2
  exit 4
fi

echo "[build-stardew-mod] game: $GAME_PATH"
echo "[build-stardew-mod] out:  $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
BUILD_DIR="$ROOT/native/stardew-mod/SeiCompanion/bin/$CONFIG/net6.0"
dotnet build "$PROJECT" -c "$CONFIG" -p:GamePath="$GAME_PATH" -nologo

# The mod folder SMAPI loads: DLL + manifest + Assets (+ the pdb for stack traces).
cp "$BUILD_DIR/SeiCompanion.dll" "$OUT/"
[[ -f "$BUILD_DIR/SeiCompanion.pdb" ]] && cp "$BUILD_DIR/SeiCompanion.pdb" "$OUT/"
cp "$ROOT/native/stardew-mod/SeiCompanion/manifest.json" "$OUT/"
cp -R "$ROOT/native/stardew-mod/SeiCompanion/Assets" "$OUT/Assets"
echo "[build-stardew-mod] done: $(ls "$OUT" | tr '\n' ' ')"
