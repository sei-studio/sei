#!/usr/bin/env bash
# scripts/build-sts2-mod.sh [--data-path DIR] [--out DIR] [--configuration Release]
#
# Builds the Sei Slay the Spire 2 mod (native/sts2-mod/SeiSts2, a fork of
# VedalAI/neuro-sts2, MIT) into
#   <repo>/assets/sts2-mod/sei-sts2/   (sei-sts2.dll + sei-sts2.json)
# which is the path both the dev app and the game pack read (the pack builder,
# scripts/build-game-pack.mjs sts2, zips this same directory under assets/).
# The output is TRACKED in git like assets/stardew-mod.
#
# Needs: the .NET 9 SDK and the game's data folder, because the mod compiles
# against the game's own sts2.dll, GodotSharp.dll and 0Harmony.dll. Those are
# not redistributable and are never copied into the repo or the output, so a
# machine without the game cannot build the mod; this script fails fast then.
# See native/sts2-mod/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$ROOT/native/sts2-mod/SeiSts2"
PROJECT="$PROJECT_DIR/sei-sts2.csproj"
OUT="$ROOT/assets/sts2-mod/sei-sts2"
CONFIG="Release"
DATA_PATH="${STS2_DATA_PATH:-${SlayTheSpireDataPath:-}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-path) DATA_PATH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --configuration) CONFIG="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done

DOTNET="${DOTNET:-}"
if [[ -z "$DOTNET" ]]; then
  if command -v dotnet >/dev/null 2>&1; then DOTNET="dotnet"
  elif [[ -x "$HOME/.dotnet/dotnet" ]]; then DOTNET="$HOME/.dotnet/dotnet"
  fi
fi
if [[ -z "$DOTNET" ]]; then
  echo "[build-sts2-mod] dotnet SDK not found. Install the .NET 9 SDK: https://dotnet.microsoft.com/download" >&2
  exit 1
fi
if ! "$DOTNET" --list-sdks 2>/dev/null | grep -Eq '^(9|[1-9][0-9])\.'; then
  echo "[build-sts2-mod] the mod targets net9.0; install the .NET 9 SDK (found: $("$DOTNET" --list-sdks 2>/dev/null | tr '\n' ' '))" >&2
  exit 1
fi

# The game's data folder (the one holding sts2.dll).
detect_data_path() {
  local games=()
  case "$(uname -s)" in
    Darwin)
      games+=("$HOME/Library/Application Support/Steam/steamapps/common/Slay the Spire 2/SlayTheSpire2.app/Contents/Resources")
      games+=("/Applications/SlayTheSpire2.app/Contents/Resources")
      ;;
    Linux)
      games+=("$HOME/.steam/steam/steamapps/common/Slay the Spire 2")
      games+=("$HOME/.local/share/Steam/steamapps/common/Slay the Spire 2")
      games+=("$HOME/.var/app/com.valvesoftware.Steam/data/Steam/steamapps/common/Slay the Spire 2")
      ;;
    MINGW*|MSYS*|CYGWIN*)
      games+=("/c/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2")
      games+=("/c/Program Files/Steam/steamapps/common/Slay the Spire 2")
      ;;
  esac
  local g d
  for g in "${games[@]}"; do
    for d in "$g"/data_sts2_*; do
      if [[ -f "$d/sts2.dll" ]]; then echo "$d"; return 0; fi
    done
  done
  return 1
}

if [[ -z "$DATA_PATH" ]]; then
  DATA_PATH="$(detect_data_path || true)"
fi
if [[ -z "$DATA_PATH" || ! -f "$DATA_PATH/sts2.dll" ]]; then
  cat >&2 <<MSG
[build-sts2-mod] Slay the Spire 2 was not found${DATA_PATH:+ at "$DATA_PATH"}.

The mod compiles against the game's own assemblies (sts2.dll, GodotSharp.dll,
0Harmony.dll), which ship with the game and cannot be redistributed. Build on a
machine with the game installed and pass its data folder:

  scripts/build-sts2-mod.sh --data-path "<game>/data_sts2_windows_x86_64"
  (macOS: ".../SlayTheSpire2.app/Contents/Resources/data_sts2_macos_arm64")

or export STS2_DATA_PATH. See native/sts2-mod/README.md.
MSG
  exit 3
fi
for dll in GodotSharp.dll 0Harmony.dll; do
  if [[ ! -f "$DATA_PATH/$dll" ]]; then
    echo "[build-sts2-mod] \"$DATA_PATH\" has no $dll; is this the game's data_sts2_* folder?" >&2
    exit 4
  fi
done

echo "[build-sts2-mod] data: $DATA_PATH"
echo "[build-sts2-mod] out:  $OUT"
BUILD_DIR="$PROJECT_DIR/bin/$CONFIG/net9.0"
"$DOTNET" build "$PROJECT" -c "$CONFIG" -p:SlayTheSpireDataPath="$DATA_PATH" -nologo

rm -rf "$OUT"
mkdir -p "$OUT"
# What the game loads from mods/: <id>.dll + <id>.json. Nothing else (the game's
# own DLLs are references with Private=false and must never land here).
cp "$BUILD_DIR/sei-sts2.dll" "$OUT/"
cp "$PROJECT_DIR/sei-sts2.json" "$OUT/"
for forbidden in sts2.dll GodotSharp.dll 0Harmony.dll; do
  if [[ -e "$OUT/$forbidden" ]]; then
    echo "[build-sts2-mod] refusing: $forbidden ended up in $OUT" >&2
    rm -f "$OUT/$forbidden"
    exit 5
  fi
done
echo "[build-sts2-mod] done: $(ls "$OUT" | tr '\n' ' ')"
