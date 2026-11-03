#!/usr/bin/env bash
# Runs every spike variant for this OS, one Electron launch each. Used by
# .github/workflows/seilink-spike.yml; also works by hand on a real machine.
set -u
cd "$(dirname "$0")/.."
OUT_ROOT="${SEILINK_OUT:-$PWD/out}"
mkdir -p "$OUT_ROOT"
ELECTRON="$(node -p "require('electron')")"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) OS=win ;;
  Darwin) OS=mac ;;
  *) OS=linux ;;
esac
if [ -n "${SEILINK_VARIANTS:-}" ]; then
  VARIANTS="$SEILINK_VARIANTS"
elif [ "$OS" = win ]; then
  # explorer-restart last: it rebuilds the shell under everything else.
  VARIANTS="baseline auto auto-showfirst auto-nodcomp auto-nogpu auto-noocclusion workerw explorer-restart"
else
  VARIANTS="mac-baseline electron-desktop native-desktop+1 native-icon-1-nothrottle native-icon-1"
fi
echo "OS=$OS electron=$ELECTRON variants: $VARIANTS"
for v in $VARIANTS; do
  echo "::group::variant $v"
  start=$(date +%s)
  timeout 200 "$ELECTRON" . --variant="$v" --out="$OUT_ROOT/$v" --timeout=170 > "$OUT_ROOT/$v.stdout.txt" 2>&1
  code=$?
  echo "exit=$code after $(( $(date +%s) - start ))s" | tee -a "$OUT_ROOT/$v.stdout.txt"
  grep -E "attach|checks|FATAL|CLOSED|ram |HARD|reattach|mac attach|raw input|proxy|TextEdit|notepad|explorer" "$OUT_ROOT/$v/log.txt" 2>/dev/null | cut -c1-400 | head -40
  echo "::endgroup::"
  sleep 2
done
node scripts/summarize.js "$OUT_ROOT" | tee "$OUT_ROOT/summary.md"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$OUT_ROOT/summary.md" >> "$GITHUB_STEP_SUMMARY"; fi
