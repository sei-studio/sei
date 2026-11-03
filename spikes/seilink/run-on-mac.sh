#!/usr/bin/env bash
# SeiLink spike on a REAL Mac (Shawn's macOS 26). Run it ON the Mac, inside the logged-in user's
# account, e.g. from the server:
#   mac status                                    # tunnel must be up
#   mac sh 'bash -s' < spikes/seilink/run-on-mac.sh      # or: scp it over and run it
# While each variant HOLDs (default 30 s), take `mac shot` screenshots from the server and click
# the yellow "HIT PROXY" box with `mac click` (real HID input via Screen Sharing). Then click an
# empty wallpaper spot with a normal window open to see whether macOS sweeps windows away.
#
# The app is launched through LaunchServices (`open`) so it lands in the GUI session even when
# this script runs over ssh. In-app screencapture is OFF by default (it would need Screen
# Recording permission for Electron); set SEILINK_SHOTS=1 to try it. Nothing here needs
# Accessibility, Input Monitoring or Screen Recording. Results: ~/seilink-spike/out/<variant>/.
set -euo pipefail
BRANCH="${SEILINK_BRANCH:-exp/seilink-spike}"
DIR="${SEILINK_DIR:-$HOME/seilink-spike}"
HOLD="${SEILINK_HOLD:-30}"
VARIANTS="${SEILINK_VARIANTS:-electron-desktop native-icon-1}"
command -v node >/dev/null || { echo "node not found (need Node 20+)"; exit 1; }
command -v git >/dev/null || { echo "git not found"; exit 1; }
sw_vers
echo "Click wallpaper to reveal desktop: $(defaults read com.apple.WindowManager EnableStandardClickToShowDesktop 2>/dev/null || echo 'unset (default = Always)')"
echo "Stage Manager: $(defaults read com.apple.WindowManager GloballyEnabled 2>/dev/null || echo unset)"

if [ ! -d "$DIR/.git" ]; then
  git clone --depth 1 --branch "$BRANCH" --filter=blob:none --sparse https://github.com/sei-studio/sei.git "$DIR"
  git -C "$DIR" sparse-checkout set spikes/seilink
else
  git -C "$DIR" fetch --depth 1 origin "$BRANCH" && git -C "$DIR" checkout -q FETCH_HEAD
fi
cd "$DIR/spikes/seilink"
npm ci --no-audit --no-fund
npm run build:addon
APP="$PWD/node_modules/electron/dist/Electron.app"
for f in 1 2 3 4; do echo "icon $f" > "$HOME/Desktop/SeiLink test $f.txt"; done

SHOT_FLAG="--no-shots"
[ "${SEILINK_SHOTS:-0}" = 1 ] && SHOT_FLAG=""
for v in $VARIANTS; do
  out="$PWD/out/$v"
  rm -rf "$out"; mkdir -p "$out"
  echo "=== $v: launching, HOLD ${HOLD}s starts once the room is attached (see $out/log.txt)"
  open -n -g -W "$APP" --args "$PWD" --variant="$v" --out="$out" --hold="$HOLD" $SHOT_FLAG &
  pid=$!
  for _ in $(seq 1 30); do grep -q HOLD "$out/log.txt" 2>/dev/null && break; sleep 1; done
  echo ">>> HOLDING now: mac shot / mac click the yellow proxy, open a Finder window and click empty wallpaper"
  wait $pid || true
  grep -E "mac attach|HOLD|proxy mousedown|checks|ram |after .* click|FATAL" "$out/log.txt" | cut -c1-300 || true
done
node scripts/summarize.js "$PWD/out"
# Remove the test icons again.
rm -f "$HOME/Desktop/SeiLink test "*.txt
