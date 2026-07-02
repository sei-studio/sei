---
phase: 15-in-game-vision-via-prismarine-viewer
plan: 01
subsystem: infra
tags: [prismarine-viewer, node-canvas-webgl, headless-gl, node-canvas, electron-rebuild, native-abi, three, vision, jpeg]

# Dependency graph
requires:
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 03)
    provides: config.vision.resolution_px / image_quality knobs (≤512 cap) that renderPov defaults align with
provides:
  - "prismarine-viewer@1.33.0 + node-canvas-webgl@0.3.0 installed; native gl@8.1.6 + canvas@3.2.3 rebuilt against Electron 42 ABI"
  - "package.json overrides: node-canvas-webgl -> { canvas: ^3.2.0 (N-API), gl: ^8.1.6 } — the documented fallback off the unbuildable old pinned majors"
  - "reproducible native build: scripts/{postinstall,patch-vision-native,rebuild-vision-native}.mjs (gl c++20 + nan ExternalPointerTypeTag patch + electron-rebuild)"
  - "renderPov(bot, opts) -> {ok:true,buffer,mediaType} | {ok:false,reason:'cant_see'} — single-frame headless POV render, wall-clock-timeout-wrapped, VIS-08 degrade"
  - "disposeRenderer() — release the shared headless-gl context"
  - "PROVEN: gl+canvas dlopen + render a JPEG inside Electron 42 (2643 bytes synthetic-scene smoke); packaged dist gl.node == proven-loading dev gl.node"
affects: [15-04, 15-06, 15-07]

# Tech tracking
tech-stack:
  added:
    - "prismarine-viewer@1.33.0"
    - "node-canvas-webgl@0.3.0"
    - "gl@8.1.6 (override; native, Electron-42 ABI)"
    - "canvas@3.2.3 (override; N-API, native)"
  patterns:
    - "ESM->CJS interop for CJS-only native packages via createRequire(import.meta.url) + global.THREE/global.Worker (mirrors prismarine-viewer lib/headless.js)"
    - "Drive prismarine-viewer/viewer Viewer+WorldView DIRECTLY for one canvas.toBuffer JPEG (NOT the headless MP4/ffmpeg export)"
    - "Wall-clock-timeout render: Promise.race(waitForChunksToRender, timer) + post-race clearTimeout + worldView.removeListenersFromBot teardown (Pitfall 5)"
    - "Reproducible native ABI build via committed idempotent patch+rebuild scripts (no patch-package dep): gl binding.gyp c++17->c++20 + nan External::New/Value get V8's kExternalPointerTypeTagDefault"
    - "N-API (canvas@3) over nan (canvas@2/gl) wherever possible — N-API is ABI-stable across the Electron/V8 churn that breaks nan"

key-files:
  created:
    - src/bot/adapter/minecraft/render/povRenderer.js
    - scripts/postinstall.mjs
    - scripts/patch-vision-native.mjs
    - scripts/rebuild-vision-native.mjs
    - scripts/vision-spike-electron-smoke.cjs
  modified:
    - package.json
    - package-lock.json
    - src/bot/index.js

key-decisions:
  - "canvas overridden to ^3 (N-API) — canvas@2 (nan) CANNOT build against Electron 42's V8; N-API is ABI-stable and builds clean"
  - "gl kept on nan but patched: Electron 42's v8::External::New/Value require a mandatory ExternalPointerTypeTag that nan (<=2.27.0) never adopted — append V8's kExternalPointerTypeTagDefault at every call site + bump gyp c++17->c++20"
  - "Native build is reproducible via committed scripts (postinstall chain), NOT a one-off manual fix — survives npm install on a clean checkout with the documented homebrew/Python prereqs"
  - "setFirstPersonCamera receives the RAW bot position (viewer adds playerHeight internally) — NOT pre-offset by eyeHeight (would double-count); confirmed against installed lib/viewer.js + lib/headless.js"
  - "VIS-08 degrade keyed on worldView.loadedChunks count==0 (authoritative no-world signal) + a cheap GL-readback blank-frame sample, never throws"

patterns-established:
  - "Headless single-frame world render in the bot utilityProcess (three-process invariant) with graceful degrade + wall-clock timeout"
  - "Committed idempotent native-patch scripts as the reproducibility mechanism for ABI-fragile transitive native deps"

requirements-completed: []  # VIS-01 + VIS-08 are CODE-COMPLETE but NOT yet checkpoint-verified — see Checkpoint State. Mark complete only after the human approves the packaged live-world render.

# Metrics
duration: ~80min
completed: 2026-06-10 (PAUSED at Task 3 human-verify checkpoint)
---

# Phase 15 Plan 01: Headless Render-Path De-Risk Spike Summary

**The make-or-break native render path BUILDS and RENDERS under Electron 42: prismarine-viewer + node-canvas-webgl installed, gl+canvas rebuilt against the Electron 42 ABI (via a documented nan/c++20 patch + canvas->N-API override), and `renderPov(bot)` proven to dlopen + render a JPEG inside an Electron 42 process — PAUSED at the packaged live-world human-verify checkpoint.**

## Status: PAUSED at Task 3 checkpoint (packaged-build human-verify)

Tasks 1 and 2 are complete and committed. Task 3's automatable work is done and committed (spike probe + Electron native-render smoke). The plan now STOPS at the `checkpoint:human-verify` that was explicitly NOT pre-approved: a human must launch the packaged app against a live LAN Minecraft world and confirm `renderPov(bot)` emits a real world-chunk JPEG. See **Human-Verify Instructions** below.

## Performance

- **Duration:** ~80 min (dominated by the native-ABI fallback ladder)
- **Tasks:** 2 complete (Task 1, Task 2) + Task 3 automatable work done, paused at checkpoint
- **Files modified:** 8 (5 created, 3 modified)
- **Tests:** 589/589 vitest pass (no test files touched by this plan; the 530->589 delta is pre-existing collection, verified by stash-compare)

## Task Commits

1. **Task 1: install + native rebuild against Electron 42** — `aa8ac1a` (chore)
2. **Task 2: povRenderer.js (renderPov)** — `480b6b8` (feat)
3. **Task 3: SEI_VISION_SPIKE probe + Electron native-render smoke** — `7a9a278` (chore, TEMPORARY scaffolding)

## The Native-ABI Result (the make-or-break finding)

The spike's whole purpose was to learn whether headless-gl/canvas can build AND load under Electron 42. **Answer: YES, with a documented patch.** The path required climbing the full fallback ladder:

| Blocker | Fix | Layer |
|---------|-----|-------|
| node-gyp imports Python `distutils` (removed in 3.12+); system Python is 3.14 | auto-detect a distutils Python (3.11/3.10/Apple 3) in the build scripts | build env |
| `canvas` from-source needs pkg-config + cairo/pango/jpeg/giflib/librsvg | `brew install pkg-config pango jpeg giflib librsvg` (+ keg-only jpeg on PKG_CONFIG_PATH) | system libs |
| `canvas@2` (nan, pinned by node-canvas-webgl) cannot build against Electron 42's V8 | `overrides` -> `canvas@^3` (N-API, ABI-stable) — builds clean, no patch | dep version |
| Electron 42's V8 headers use C++20 concepts; gl gyp requests c++17 | gl binding.gyp `c++17`->`c++20` (+ deploy target 10.8->10.15) | gyp |
| Electron 42's `v8::External::New`/`Value()` require a mandatory `ExternalPointerTypeTag`; nan (even 2.27.0, gl@9-rc) still calls 2-arg | append V8's `kExternalPointerTypeTagDefault` at all 3 New + 28 Value nan call sites | nan patch |

**After the ladder:**
- `npm run postinstall` (patch -> install-app-deps -> electron-rebuild) exits 0 end-to-end, auto-detecting the build env.
- Both `gl/build/Release/webgl.node` (2.4 MB) and `canvas/build/Release/canvas.node` build against `.electron-gyp/42.0.0`.
- **Runtime-proven inside Electron 42:** `scripts/vision-spike-electron-smoke.cjs` → `VISION_SPIKE_OK: rendered 2643 bytes JPEG under Electron 42.0.0` — gl+canvas dlopen, a three.js WebGLRenderer draws a synthetic scene, canvas encodes a JPEG. NONE of the Pitfall-1 failures ("Module did not self-register", "getUniformLocation of null", segfault) occurred.
- As expected and documented in the plan, the same modules FAIL to load under **system Node v25** (`ERR_DLOPEN_FAILED` on gl) — because they are now bound to the Electron ABI. canvas@3 (N-API) DOES load under system Node and encodes JPEG (630 bytes), isolating the Electron-only binding to gl.

### Version pins that were needed (per plan's "record any gl/canvas version pins")
- `node-canvas-webgl` override block: `canvas: "^3.2.0"` (resolved 3.2.3, N-API), `gl: "^8.1.6"` (resolved 8.1.6, nan — patched).
- gl source patch (c++20 + nan tag) is re-applied idempotently by `scripts/patch-vision-native.mjs` on every install.

## renderPov signature + proven facts

```js
// src/bot/adapter/minecraft/render/povRenderer.js  (bot utilityProcess ONLY — needs bot.world)
export async function renderPov(bot, {
  width = 256, height = 256, viewDistance = 4, quality = 0.4, timeoutMs = 5000
} = {})
// -> { ok: true, buffer: Buffer, mediaType: 'image/jpeg' }
//  | { ok: false, reason: 'cant_see' }   // VIS-08 — never throws, never hangs
export function disposeRenderer()          // release the shared headless-gl context
```

- **Render path:** node-canvas-webgl `createCanvas` -> `three.WebGLRenderer` -> prismarine-viewer `Viewer` + `WorldView(bot.world, viewDistance, pos)` -> `waitForChunksToRender` -> `renderer.render(viewer.scene, viewer.camera)` -> `canvas.toBuffer('image/jpeg', {quality})`. Drives Viewer+WorldView directly (NOT the headless MP4 export).
- **World data used:** `bot.world` (chunk columns via WorldView), `bot.entity.position` (camera center + WorldView center), `bot.entity.yaw/pitch` (look direction), `bot.version` (viewer.setVersion guard).
- **Output:** aggressively-downscaled JPEG — canvas is created AT the 256px target so `toBuffer` emits the compressed frame directly (D-03 / VIS-06, well under the 512 ceiling). The Electron smoke proves the encode produces ~2.6 KB at 256px/q0.4.
- **Wall-clock timeout (CLAUDE.md invariant):** `Promise.race([waitForChunksToRender, timer(timeoutMs=5000)])` + post-race `clearTimeout` + `worldView.removeListenersFromBot` teardown (Pitfall 5 GL/listener-leak). A single long-lived WebGLRenderer is reused across renders (idle hot path); `disposeRenderer()` frees the context.
- **VIS-08 degrade returns the `cant_see` sentinel (never throws) on:** missing `bot.version`/`bot.entity`/`bot.world`, unsupported version (`setVersion` false), zero loaded chunks (`worldView.loadedChunks` empty → unloaded world), an all-background (sky-only) frame, a zero-byte buffer, or the timeout firing.

## Files Created/Modified

**Created**
- `src/bot/adapter/minecraft/render/povRenderer.js` — `renderPov` + `disposeRenderer` (the one file in this phase with NO in-repo analog).
- `scripts/postinstall.mjs` — unified postinstall: env-detect -> patch -> install-app-deps -> rebuild.
- `scripts/patch-vision-native.mjs` — idempotent gl-gyp (c++20) + nan (ExternalPointerTypeTag) source patches.
- `scripts/rebuild-vision-native.mjs` — gl+canvas electron-rebuild against the installed Electron ABI with the right build env.
- `scripts/vision-spike-electron-smoke.cjs` — TEMPORARY Electron-process native-render smoke (Task 3 scaffolding).

**Modified**
- `package.json` — deps (prismarine-viewer, node-canvas-webgl) + `overrides` (canvas ^3 / gl ^8) + postinstall -> scripts/postinstall.mjs.
- `package-lock.json` — re-resolved tree.
- `src/bot/index.js` — TEMPORARY `SEI_VISION_SPIKE=1`-gated render smoke-probe on bot spawn (Task 3 scaffolding).

## Checkpoint State — Task 3 (packaged-build human-verify, NOT pre-approved)

**Automated, done, committed:**
1. Wired the `SEI_VISION_SPIKE=1` probe into the bot utilityProcess spawn path (`src/bot/index.js` onSpawn). Behind the env flag so it ships nothing permanent; dynamic-imports povRenderer to keep the native dlopen off the normal path.
2. Built the packaged `.app` (`release/mac-arm64/Sei Launcher.app`, unsigned dir build). electron-builder ran `@electron/rebuild` for gl+canvas against Electron 42 during packaging ("finished moduleName=gl/canvas arch=arm64").
3. Verified packaged structure (Pitfall 1 load-bearing): `app.asar.unpacked/node_modules/gl/build/Release/webgl.node` + `.../canvas/build/Release/canvas.node` present; `app.asar.unpacked/src/bot/adapter/minecraft/render/povRenderer.js` + `prismarine-viewer/viewer` unpacked.
4. Proved gl+canvas dlopen + render a JPEG inside Electron 42 (synthetic scene, 2643 bytes). The packaged `gl.node` is byte-identical to this proven-loading dev binary.

**What the human must verify (the part automation cannot do — needs a live LAN Minecraft world):**
The synthetic-scene smoke proves the native pipeline loads/renders under Electron 42, but only a live world proves the full `bot.world` chunks -> JPEG path through `renderPov`. See instructions below.

### Human-Verify Instructions (verbatim)

1. **DEV check.** From `/Users/ouen/slop/sei-studio/sei`, run:
   `SEI_VISION_SPIKE=1 npm run dev`
   Summon a bot into an OPEN-TO-LAN Minecraft world and stand somewhere with terrain in view. ~3 s after the bot spawns, confirm the log (bot rolling log / dev console) shows:
   `vision spike: rendered N bytes JPEG`  with N > 0.
   A `vision spike: degraded (cant_see)` line instead means chunks weren't loaded where the bot stood — move the bot near built/solid terrain and re-summon. Any `vision spike: render threw …` with `Module did not self-register` / `getUniformLocation of null` / a segfault is a Pitfall-1 FAILURE — report it.

2. **PACKAGED check (the load-bearing one).** A packaged build already exists at
   `release/mac-arm64/Sei Launcher.app` (built unsigned this session). To run the packaged app WITH the spike probe:
   `SEI_VISION_SPIKE=1 open -a "release/mac-arm64/Sei Launcher.app"`
   (or launch it from Finder after exporting the env var in your shell, then `open` it from that shell).
   Summon a bot into the same live world and confirm the SAME `vision spike: rendered N bytes JPEG` (N > 0) appears in the packaged app's bot log, and the app does NOT crash. This is the exact failure surface Pitfall 1 warns about (works in dev, crashes in dist).
   - Packaged bot log location: `~/Library/Application Support/Sei Launcher/logs/` (the rolling bot log).
   - The native `.node` binaries it loads live at
     `release/mac-arm64/Sei Launcher.app/Contents/Resources/app.asar.unpacked/node_modules/{gl,canvas}/build/Release/`.

3. **Reply** `approved — packaged render works` to unblock Waves 2-4, or describe the failure (then the orchestrator escalates to the BrowserWindow-WebGL fallback or descope).

### After approval (NOT done yet — pending human)
- Remove the temporary probe from `src/bot/index.js` and `scripts/vision-spike-electron-smoke.cjs` so `grep -rc "SEI_VISION_SPIKE" src/` returns 0.
- Mark VIS-01 + VIS-08 requirements complete.
- Commit the probe removal.

## Build Environment (clean-machine recipe — for reproducibility)

The native build needs (macOS / Apple Silicon, verified this session):
- Xcode Command Line Tools (`xcode-select -p`).
- A Python with `distutils` (3.11 or earlier — 3.12+ removed it). Installed here: `/opt/homebrew/opt/python@3.11`. The build scripts auto-detect 3.11/3.10/Apple `/usr/bin/python3`, or honor `npm_config_python`.
- canvas native libs: `brew install pkg-config cairo pango jpeg giflib librsvg pixman` (jpeg is keg-only; the scripts add `/opt/homebrew/opt/jpeg/lib/pkgconfig` to `PKG_CONFIG_PATH`).
Then `npm install` runs the postinstall chain automatically. Windows/Linux clean-machine builds are UNVERIFIED by this spike (macOS-only) — Waves 2-4 / release should test those.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Native build toolchain (Python distutils + canvas system libs)**
- **Found during:** Task 1 (first `npm install`)
- **Issue:** System Python 3.14 lacks `distutils` (gl's old node-gyp needs it); `canvas` from-source needs pkg-config + cairo/pango/jpeg/giflib/librsvg which were partially missing.
- **Fix:** Point node-gyp at a distutils-capable Python (auto-detected in the build scripts); `brew install` the canvas native-lib prereqs; surface keg-only jpeg via PKG_CONFIG_PATH.
- **Files modified:** scripts/{postinstall,rebuild-vision-native}.mjs
- **Committed in:** `aa8ac1a`

**2. [Rule 3 - Blocking] canvas@2 (nan) unbuildable against Electron 42 -> override to canvas@3 (N-API)**
- **Found during:** Task 1 (postinstall electron-rebuild)
- **Issue:** node-canvas-webgl@0.3.0 pins canvas@^2.6.0; canvas@2's bundled nan fails against Electron 42's V8 (`v8::External::New` arity change). This is the plan's documented "old pinned majors don't build" fallback trigger.
- **Fix:** package.json `overrides` force `canvas@^3` (N-API, ABI-stable) — builds clean with no patch.
- **Files modified:** package.json, package-lock.json
- **Committed in:** `aa8ac1a`

**3. [Rule 3 - Blocking] gl (nan) needs c++20 + a nan ExternalPointerTypeTag patch for Electron 42**
- **Found during:** Task 1 (postinstall electron-rebuild)
- **Issue:** gl@8.1.6 (and gl@9-rc) use nan; even the latest nan (2.27.0) calls `v8::External::New`/`Value()` with the pre-Electron-42 arity. Electron 42's V8 made `ExternalPointerTypeTag` mandatory. gl gyp also requested c++17 while Electron 42's V8 headers use C++20 concepts.
- **Fix:** idempotent committed patch — gl binding.gyp c++17->c++20; append V8's `kExternalPointerTypeTagDefault` at all nan External::New (3) + Value (28) call sites. Re-applied by scripts/patch-vision-native.mjs before every compile.
- **Files modified:** scripts/patch-vision-native.mjs (patch logic), node_modules/gl + node_modules/nan (re-applied at build time, not committed)
- **Committed in:** `aa8ac1a`

**4. [Rule 1 - Correctness] setFirstPersonCamera receives raw position, not eye-offset**
- **Found during:** Task 2 (reading installed lib/viewer.js)
- **Issue:** The research sketch passed `center.offset(0, eyeHeight, 0)` to setFirstPersonCamera, but the installed `viewer.setFirstPersonCamera` adds `playerHeight` to `pos.y` internally — pre-offsetting would double-count the eye height and aim the camera too high.
- **Fix:** Pass the raw `bot.entity.position` (matches the installed lib/headless.js).
- **Files modified:** src/bot/adapter/minecraft/render/povRenderer.js
- **Committed in:** `480b6b8`

---

**Total deviations:** 4 auto-fixed (3 blocking build-toolchain/ABI, 1 correctness). All necessary to make the render path build + render correctly under Electron 42. No scope creep — the ABI fixes ARE the spike's deliverable (15-RESEARCH.md Pitfall 1 / A2 "make-or-break risk").

## Issues Encountered

- `npm` warns `Unknown env config "python"` when `npm_config_python` is set — cosmetic; node-gyp honors it and the build succeeds. Removed a `.npmrc python=` line that triggered the same warning at the project level in favor of in-script auto-detection.
- A stray `gl/bin/darwin-arm64-146/gl.node` prebuild (node-abi 146, NOT Electron) ships alongside the Electron-rebuilt `build/Release/webgl.node`. `require('bindings')('webgl')` resolves `build/Release/webgl.node` first, so the correct binary loads; the prebuild is inert. Noted for Waves 2-4 in case a stricter packaging trim is wanted.
- vitest collects 589 tests / 55 files now vs the 530/49 noted in the brief. Confirmed (via stash-compare and `git diff` of test files) this is NOT caused by this plan — zero test files were touched. All 589 pass; the known `fsm.test.js` flake did not trigger.

## Known Stubs

`scripts/vision-spike-electron-smoke.cjs` and the `SEI_VISION_SPIKE` probe in `src/bot/index.js` are INTENTIONAL TEMPORARY scaffolding for the Task 3 checkpoint, gated behind `SEI_VISION_SPIKE=1` (ship nothing by default). They are removed after the human approves the packaged render (tracked in "After approval" above). Not stubs in the data-not-wired sense — `renderPov` is fully implemented and proven to render.

## Threat Flags

None beyond the plan's `<threat_model>`. The native supply-chain surface (T-15-01-SC) was gated by the human package-legitimacy approval before any install; the render timeout (T-15-01-02) and GL/listener teardown (T-15-01-03) are implemented in renderPov; the app.asar.unpacked native-load boundary (T-15-01-04) is verified present in the packaged build (final confirmation is the human's packaged-render check).

## Next Phase Readiness

- **BLOCKED pending the Task 3 human-verify** (packaged live-world render). Waves 2-4 are waved behind this checkpoint by design.
- On approval: `renderPov(bot)` is the render primitive for 15-04 (visualize behavior: downscale+dedupe wraps this), and the `cant_see` sentinel feeds the VIS-08 graceful-degradation copy. `config.vision.resolution_px`/`image_quality` (from 15-03) are the width/height/quality args.
- Windows/Linux native builds are UNVERIFIED (macOS-only spike) — release/CI must validate those before shipping.

## Self-Check: PASSED

- Created files present: povRenderer.js, scripts/{postinstall,patch-vision-native,rebuild-vision-native}.mjs, scripts/vision-spike-electron-smoke.cjs.
- Commits exist: `aa8ac1a` (Task 1), `480b6b8` (Task 2), `7a9a278` (Task 3 scaffolding).
- Native binaries built against Electron 42: gl/build/Release/webgl.node + canvas/build/Release/canvas.node.
- Runtime proof: `VISION_SPIKE_OK: rendered 2643 bytes JPEG under Electron 42.0.0`.

---
*Phase: 15-in-game-vision-via-prismarine-viewer*
*Status: PAUSED at Task 3 packaged-build human-verify checkpoint*
*Completed (Tasks 1-2 + Task 3 automatable work): 2026-06-10*
