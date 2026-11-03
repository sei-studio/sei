# SeiLink technical spike

Question: can an Electron window live behind the desktop icons on Windows and macOS
(Wallpaper Engine / Lively style)? This directory is a throwaway spike. There is NO product UI:
the window shows a magenta test pattern with a moving green square and a frame counter.

- `native/win.cc` - attach (raised 24H2+ layout: `WS_EX_LAYERED` child of `Progman` under
  `SHELLDLL_DefView`, above `WorkerW`; classic: child of the `0x052C` WorkerW; `workerw` =
  Lively's IsWorkerWParent fallback), window-tree dump, passive Raw Input (`RIDEV_INPUTSINK`).
- `native/mac.mm` - native `NSWindow` level + collectionBehavior, CGWindowList dump, and a plain
  non-activating `NSPanel` hit proxy (blue) to compare with Electron's `type:'panel'` (yellow).
- `app/main.js` - one launch = one variant (see `PRESETS`). Writes `out/<variant>/result.json`,
  `log.txt`, `tree-*.json`, screenshots, and pixel checks.
- `scripts/ci-run.sh` - runs all variants for the OS; `.github/workflows/seilink-spike.yml` runs
  it on windows-2022/2025 and macos-15/26 on every push to `exp/seilink-spike`.
- `explorer-restart-child` variant: the room runs in a child Electron process (`room-child`); the
  supervisor kills Explorer, records the child's exit code and respawns it if it died.
- `run-on-mac.sh` - the same on a real Mac (no synthetic clicks; a person clicks during HOLD).

## Round 2 (2026-11-04): supervised room host, mac hit layer, coverage signal

- `app/supervisor.js` - main spawns `<electron> . --room-host` as its own process and talks JSON
  lines over a named pipe / unix socket (`show hide pause resume set-fps ping` down;
  `ready attached covered click heartbeat` up). Restarts on exit or 3 s without a heartbeat,
  backoff 0, 0.5, 1, 2 ... 10 s, reset after 20 s up.
- `app/host.js` + `app/room.html` - the room host: attaches, re-validates the attachment on
  shell events (TaskbarCreated, WM_DISPLAYCHANGE, WM_SETTINGCHANGE, session change) and every
  2 s, drops to 0 FPS while covered, owns the mac hit panel.
- `native/win_r2.inc` - hidden watcher window + WinEventHooks (foreground, move/size end,
  minimize, location change of the foreground window) -> coverage check (a maximized or
  monitor-sized window on the primary monitor, or a D3D fullscreen app); `validate()`.
- `native/mac_r2.inc` - non-activating NSPanel at desktopIcon+1 over the companion rect
  (click / dblclick / drag events, rect settable from JS), NSWindow occlusion observer, and test
  helpers (double click, drag, keys, AX move of another app's window).
- `app/r2.js` - the harness (`--variant=r2-win` / `r2-mac`), run by `scripts/ci-run.sh`. Runs on
  Linux too (common block only, no desktop layer): `xvfb-run electron . --variant=r2 --no-sandbox`.

Test-harness clicks (`testClick`) use OS-level `SendInput` / `CGEventPost` to stand in for a hand.
The product design never posts mouse messages into Chromium.

```
npm ci && npm run build:addon && bash scripts/ci-run.sh   # or SEILINK_VARIANTS="auto" ...
```
