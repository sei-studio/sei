#!/usr/bin/env bash
# Runs every spike variant for this OS, one Electron launch each. Used by
# .github/workflows/seilink-spike.yml; also works by hand on a real machine.
set -u
cd "$(dirname "$0")/.."
OUT_ROOT="${SEILINK_OUT:-$PWD/out}"
mkdir -p "$OUT_ROOT"
# electron 42 fetches its binary on first require and prints progress first: keep the last line.
ELECTRON="$(node -p "require('electron')" | tail -n 1)"
# macOS has no coreutils timeout; perl's alarm survives exec.
run_timeout() { if command -v timeout >/dev/null; then timeout "$@"; else perl -e 'alarm shift; exec @ARGV' "$@"; fi; }
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) OS=win ;;
  Darwin) OS=mac ;;
  *) OS=linux ;;
esac
if [ -n "${SEILINK_VARIANTS:-}" ]; then
  VARIANTS="$SEILINK_VARIANTS"
elif [ "$OS" = win ]; then
  # Round 2 (supervised room host). Round-1 variants: SEILINK_VARIANTS="baseline auto ... explorer-restart-child".
  VARIANTS="r2-win"
else
  # Round-1 mac variants: SEILINK_VARIANTS="mac-baseline electron-desktop native-desktop+1 native-icon-1-nothrottle native-icon-1"
  VARIANTS="r2-mac"
fi
echo "OS=$OS electron=$ELECTRON variants: $VARIANTS"
for v in $VARIANTS; do
  echo "::group::variant $v"
  start=$(date +%s)
  # CI only: the runner's console window sits over the screen centre; minimise everything first.
  if [ "$OS" = win ] && [ -n "${CI:-}" ]; then
    powershell.exe -NoProfile -Command "(New-Object -ComObject Shell.Application).MinimizeAll()" || true
    sleep 1
  fi
  case "$v" in r2*) T=400 ;; *) T=170 ;; esac
  run_timeout $((T + 30)) "$ELECTRON" . --variant="$v" --out="$OUT_ROOT/$v" --timeout=$T > "$OUT_ROOT/$v.stdout.txt" 2>&1
  code=$?
  echo "exit=$code after $(( $(date +%s) - start ))s" | tee -a "$OUT_ROOT/$v.stdout.txt"
  grep -E "attach|checks|FATAL|CLOSED|ram |HARD|reattach|mac attach|raw input|proxy|TextEdit|notepad|explorer|STEP|measure|covered|reaction|hit trial|show desktop|killall" "$OUT_ROOT/$v/log.txt" 2>/dev/null | cut -c1-400 | head -80
  echo "::endgroup::"
  sleep 2
done
node scripts/summarize.js "$OUT_ROOT" | tee "$OUT_ROOT/summary.md"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$OUT_ROOT/summary.md" >> "$GITHUB_STEP_SUMMARY"; fi
