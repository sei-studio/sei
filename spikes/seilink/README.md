# SeiLink technical spike

Question: can an Electron window live behind the desktop icons on Windows and macOS
(Wallpaper Engine / Lively style)? This directory is a throwaway spike. There is NO product UI:
the window shows a magenta test pattern with a moving green square and a frame counter.

- `native/win.cc` - attach (raised 24H2+ layout: `WS_EX_LAYERED` child of `Progman` under
  `SHELLDLL_DefView`, above `WorkerW`; classic: child of the `0x052C` WorkerW; `workerw` =
  Lively's IsWorkerWParent fallback), window-tree dump, passive Raw Input (`RIDEV_INPUTSINK`).
- `native/mac.mm` - native `NSWindow` level + collectionBehavior, CGWindowList dump.
- `app/main.js` - one launch = one variant (see `PRESETS`). Writes `out/<variant>/result.json`,
  `log.txt`, `tree-*.json`, screenshots, and pixel checks.
- `scripts/ci-run.sh` - runs all variants for the OS; `.github/workflows/seilink-spike.yml` runs
  it on windows-2022/2025 and macos-15/26 on every push to `exp/seilink-spike`.
- `run-on-mac.sh` - the same on a real Mac.

Test-harness clicks (`testClick`) use OS-level `SendInput` / `CGEventPost` to stand in for a hand.
The product design never posts mouse messages into Chromium.

```
npm ci && npm run build:addon && bash scripts/ci-run.sh   # or SEILINK_VARIANTS="auto" ...
```
