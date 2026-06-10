---
phase: 15-in-game-vision-via-prismarine-viewer
plan: 04
subsystem: api
tags: [zod, closed-registry, vision, vlm-gating, prismarine-viewer, renderpov, dedupe, vitest, native-mock, capabilities]

# Dependency graph
requires:
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 01)
    provides: "renderPov(bot, {width,height,viewDistance,quality,timeoutMs}) -> {ok:true,buffer,mediaType}|{ok:false,reason:'cant_see'} — timeout-wrapped, never throws/hangs"
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 03)
    provides: "config.vision block (resolution_px ≤512 cap, image_quality) + per-provider capabilities.vision the gate reads"
provides:
  - "visualizeAction(args, bot, config) — the LLM-callable explicit render (D-01 path a). Success returns EXACTLY { text:string, image:{ mediaType:string, dataBase64:string } } (the 15-06 image-attach contract); degrade returns the string \"I can't see clearly right now\" (VIS-08); idle near-duplicate returns { skip:true } (D-02); pre-aborted signal returns 'aborted'. Never throws, never hangs."
  - "createDefaultRegistry({ visionEnabled }) — conditional 'visualize' registration (D-10): registered ONLY when visionEnabled is true, empty z.object({}) schema (closed-registry invariant)"
  - "createMinecraftAdapter({ bot, config, visionEnabled }) — threads the gate flag (defaults false at the construction site, which has no provider handle)"
  - "orchestrator combinedToolsFor() filters visualize out of the tool list when !anthropic.capabilities?.vision (VIS-03) — the authoritative belt-and-suspenders gate"
  - "ACTION_DESCRIPTIONS.visualize prompt entry (only surfaced when vision is enabled)"
affects: [15-06, 15-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pose-quantization frame dedupe (D-02): hash = round(x),round(y),round(z) | round(yaw/(π/4)),round(pitch/(π/4)) — a parked bot re-hashes identical, no JPEG-buffer hashing; applied only on the idle path (args.idle===true)"
    - "Belt-and-suspenders capability gate: skip registration (adapter) AND filter the tool list (orchestrator) on capabilities.vision — either alone keeps a non-VLM model from seeing the tool"
    - "Native-free vitest gate: vi.mock('./behaviors/visualize.js') so povRenderer.js + gl/canvas (Electron-ABI natives) never dlopen under system-Node — the mandatory pattern for ANY suite whose import graph reaches registry.js"
    - "lookAt/pathfind wrapper discipline reused for a non-bot external call: abort-first early return + Promise.race(render, timer, abort) + post-race clearTimeout/removeEventListener"

key-files:
  created:
    - src/bot/adapter/minecraft/behaviors/visualize.js
    - src/bot/adapter/minecraft/behaviors/visualize.test.js
    - src/bot/adapter/minecraft/registry.vision.test.js
  modified:
    - src/bot/adapter/minecraft/registry.js
    - src/bot/adapter/minecraft/index.js
    - src/bot/adapter/minecraft/prompts.js
    - src/bot/brain/orchestrator.js
    - src/bot/adapter/minecraft/index.test.js

key-decisions:
  - "Dedupe hash = pose quantization (position whole-block + yaw/pitch into π/4 buckets), NOT a perceptual/buffer hash — cheaper and sufficient for 'parked bot sends same view' (D-02 discretion)"
  - "Dedupe lives in the handler but is gated on args.idle===true; the explicit path (model asked for a fresh look) NEVER dedupes (per the plan's behavior spec)"
  - "Handler-level wall-clock timeout (DEFAULT_VISION_TIMEOUT_MS=8000) races renderPov's own 5s internal timeout — defense in depth so a hung renderPov (or a never-resolving mock) can't wedge the loop"
  - "base64 size cap (MAX_BASE64_BYTES=256KB) before return — request-size safety (ASVS V5 / T-15-04-04); oversized -> degrade rather than ship a huge image"
  - "Adapter visionEnabled defaults false at construction (src/bot/index.js builds the adapter BEFORE the brain/provider exists); the orchestrator tool-list filter is the authoritative gate (plan Task 2b)"

patterns-established:
  - "Conditional closed-registry action: createDefaultRegistry({ flag }) toggles a single register() call without disturbing the base set"
  - "Native-dep test isolation: every suite reaching registry.js MUST vi.mock the visualize behavior or it fails to load under system-Node vitest"

requirements-completed: [VIS-02, VIS-03, VIS-08]

# Metrics
duration: ~5min
completed: 2026-06-10
---

# Phase 15 Plan 04: visualize Zod action — VLM-gated render hook Summary

**The LLM's hook into vision: a `visualize` closed-registry action that drives `renderPov` behind a wall-clock timeout, returns the exact `{ text, image:{ mediaType, dataBase64 } }` shape 15-06 attaches as an image (or the VIS-08 degrade string), dedupes idle frames by pose quantization, and is double-gated on `capabilities.vision` (registration skip + tool-list filter).**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-06-10T17:51:33Z
- **Completed:** 2026-06-10T17:56:07Z
- **Tasks:** 3 (Task 1 was TDD: RED + GREEN)
- **Files modified:** 8 (3 created, 5 modified)
- **Tests:** 607/607 vitest pass across 57 files (baseline 594 + 13 new: 9 visualize + 4 gate). Known `fsm.test.js` flake did not trigger.

## Accomplishments

- **visualizeAction (VIS-02/VIS-08):** the explicit render handler (D-01 path a). Mirrors lookAt's `(args, bot, config)` signature + abort-first early return + `Promise.race(render, timer, abort)` with post-race cleanup. Reads `config.vision.resolution_px` / `image_quality` (config is source of truth, D-03/D-04). Returns a structured image result on success, the degrade string on unloaded chunks / timeout / any rejection (never throws), `'aborted'` on a pre-aborted signal, and `{ skip:true }` for an idle near-duplicate.
- **D-02 idle dedupe:** pose-quantization hash (position whole-block + yaw/pitch into π/4 buckets), applied ONLY when `args.idle===true`. The explicit path always renders fresh.
- **D-10 conditional registration:** `createDefaultRegistry({ visionEnabled })` registers `visualize` (empty `z.object({})` schema) only when vision is enabled; threaded through `createMinecraftAdapter({ ..., visionEnabled })` (defaults false at the construction site).
- **VIS-03 tool-list filter:** `combinedToolsFor()` drops `visualize` when `!anthropic.capabilities?.vision` — the authoritative belt-and-suspenders gate so a non-VLM model never sees the tool even if registration leaks.
- **Native-free gate test:** `registry.vision.test.js` mocks `./behaviors/visualize.js` so the registry's import graph never dlopens the Electron-ABI gl/canvas natives under system-Node; asserts `list()` includes/excludes `visualize` per the flag.

## The 15-06 contract (RETURN SHAPE — what 15-06 consumes)

`visualizeAction` is the producer; 15-06 is the consumer that wires the output into the LLM turn. The structured success result is **exactly**:

```js
{
  text: 'rendered view attached',           // short tool_result text
  image: {
    mediaType: 'image/jpeg',                // from renderPov result.mediaType
    dataBase64: '<base64 of result.buffer>' // the encoded JPEG frame
  }
}
```

15-06 destructures `image.mediaType` / `image.dataBase64` to build the image content block. The exact top-level keys (`['text','image']`) and image keys (`['mediaType','dataBase64']`) are asserted in `visualize.test.js` — adding keys or re-nesting would silently break 15-06.

**The other three return shapes** (all unions of the same return type):
- `"I can't see clearly right now"` — VIS-08 degrade STRING on `{ ok:false }`, timeout, or any rejection.
- `'aborted'` — string, on a pre-aborted `config.signal` (renderPov is NOT called).
- `{ skip: true }` — idle near-duplicate sentinel (the idle caller drops the send).

## Gating points implemented (belt-and-suspenders, D-10/VIS-03)

1. **Registration gate (adapter):** `createDefaultRegistry({ visionEnabled })` in `registry.js` — the `register('visualize', …)` call is inside `if (visionEnabled)`. `createMinecraftAdapter({ bot, config, visionEnabled })` forwards it (defaults false; the construction site in `src/bot/index.js:220` has no provider handle yet).
2. **Tool-list gate (orchestrator):** `combinedToolsFor()` in `orchestrator.js` — `const visionOk = !!anthropic.capabilities?.vision` then `.filter(t => visionOk || t.name !== 'visualize')`. This is the AUTHORITATIVE gate: the provider handle is live here, so even a leaked registration is filtered before the model sees it.

## Dedupe-hash algorithm (recorded per plan output spec)

```js
poseHash(bot) = `${round(x)},${round(y)},${round(z)}|${round(yaw/(π/4))},${round(pitch/(π/4))}`
```
~8 yaw buckets, ~4 pitch buckets, whole-block position. A parked/idle bot re-renders the same view and re-hashes identical → `{ skip:true }`. Chosen over perceptual/buffer hashing because it's O(1), needs no image decode, and exactly captures the "bot didn't move" case D-02 targets. Reset for tests via the `__resetVisualizeDedupeCache()` seam.

## Gate-test mock specifier (recorded per plan output spec)

`registry.vision.test.js` (and the regression fix to `index.test.js`) mock the specifier **`./behaviors/visualize.js`** (relative to the adapter dir), not `./render/povRenderer.js`. registry.js imports `visualizeAction` from `./behaviors/visualize.js` eagerly; mocking that one module short-circuits the entire native chain (visualize.js → povRenderer.js → node-canvas-webgl/gl/canvas) before any dlopen.

## Task Commits

1. **Task 1 (TDD): visualize handler** — `da75a17` (test / RED), `848a13f` (feat / GREEN). No refactor commit — clean on first GREEN.
2. **Task 2: conditional registration + prompt + gate test** — `444c448` (feat)
3. **Task 3: orchestrator tool-list filter** — `b2b279d` (feat)
4. **Deviation fix: native-mock index.test.js** — `c54c343` (fix)

## Files Created/Modified

**Created**
- `src/bot/adapter/minecraft/behaviors/visualize.js` — `visualizeAction` + `CANT_SEE_COPY` + `__resetVisualizeDedupeCache` + `DEFAULT_VISION_TIMEOUT_MS`.
- `src/bot/adapter/minecraft/behaviors/visualize.test.js` — 9 tests: exact success shape, knob pass-through, `{ok:false}`/reject/timeout degrade, abort, idle dedupe, explicit non-dedupe, pose-change re-render.
- `src/bot/adapter/minecraft/registry.vision.test.js` — 4 native-free gate tests (visionEnabled true/false/default + base-set invariance).

**Modified**
- `src/bot/adapter/minecraft/registry.js` — import `visualizeAction`; `createDefaultRegistry({ visionEnabled })`; conditional `register('visualize', z.object({}), …)`.
- `src/bot/adapter/minecraft/index.js` — `createMinecraftAdapter({ bot, config, visionEnabled })` forwards the flag.
- `src/bot/adapter/minecraft/prompts.js` — `ACTION_DESCRIPTIONS.visualize` entry.
- `src/bot/brain/orchestrator.js` — `combinedToolsFor()` vision filter.
- `src/bot/adapter/minecraft/index.test.js` — `vi.mock('./behaviors/visualize.js')` (deviation fix).

## Decisions Made

See `key-decisions` frontmatter. Headline: dedupe by cheap pose quantization (idle-only); handler-level timeout + base64 cap as defense in depth on top of renderPov's own guarantees; adapter gate defaults false and the orchestrator filter is authoritative because the adapter is constructed before the provider exists.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Native gl/canvas leaked into index.test.js, breaking its suite load**
- **Found during:** Task 3 (full-suite regression check after all task commits)
- **Issue:** Task 2 added a static `import { visualizeAction } from './behaviors/visualize.js'` at the top of `registry.js`. That pulls `./render/povRenderer.js` → native `gl` (built for the Electron 42 ABI). `index.test.js` imports `createMinecraftAdapter` → `createDefaultRegistry`, so the suite now tried to dlopen `gl` under system-Node vitest and failed to LOAD (`NODE_MODULE_VERSION 146 vs 141`). The 7 H4-guard assertions still "passed" in the inner report, but the suite itself was a Failed Suite. Previously green; this is a regression I introduced.
- **Fix:** Added `vi.mock('./behaviors/visualize.js', …)` to `index.test.js` (mirrors `registry.vision.test.js`'s native-free strategy). The mock keeps the native chain off the import graph; all 7 H4 tests load and pass clean.
- **Scope verified:** grep confirmed ONLY `index.test.js` + `registry.vision.test.js` import the registry/adapter chain — no other suite needs the mock.
- **Files modified:** `src/bot/adapter/minecraft/index.test.js`
- **Verification:** `npx vitest run` → 57 files / 607 tests all green.
- **Committed in:** `c54c343`

---

**Total deviations:** 1 auto-fixed (1 bug — a regression I introduced and immediately repaired).
**Impact on plan:** Necessary to keep the suite green. No scope creep — it's the same documented native-mock strategy the plan mandates for registry-reaching tests, extended to the one pre-existing suite that the new static import newly affected.

## Issues Encountered

- A `tail -4` on the isolated `index.test.js` run masked the Failed-Suite line (it showed "7 passed"), so the native-load break wasn't visible until the full-suite run. Lesson applied: read the suite-level pass/fail line, not just the assertion count. Resolved by the mock above before the SUMMARY.
- The shell's `ugrep` alias misparses `-c "t.name !== 'visualize'"` (treats `!==` as a flag); used `grep -c -e "…"` to get the real count (1) for the Task 3 acceptance grep.

## Known Stubs

None — `visualizeAction` is fully implemented and renders via the real (mocked-in-tests) `renderPov`. The image-content-block delivery to the LLM turn (the VIS-02 wiring half) is 15-06's explicit scope, not a stub here: this plan's contract (the exact return shape) is intentionally consumed downstream. The idle `{ skip:true }` path's caller is 15-07. Neither is missing data — they are the planned consumers of contracts this plan provides.

## Threat Flags

None beyond the plan's `<threat_model>`. T-15-04-01 (registry widening) is mitigated — `visualize` is a Zod `z.object({})` action dispatched through `registry.execute`, no code generation. T-15-04-02 (non-VLM offered the tool) is mitigated by both gates (registration skip + tool-list filter). T-15-04-03 (loop hang) is mitigated — renderPov is timeout-wrapped AND the handler races its own wall-clock timer + abort signal, returning a string. T-15-04-04 (oversized payload) is mitigated — ~256px q0.4 plus the explicit base64 size cap before return. No new trust-boundary surface introduced.

## Next Phase Readiness

- **15-06 (image-content-block wiring):** consume `visualizeAction`'s success shape `{ text, image:{ mediaType, dataBase64 } }`; the degrade/abort strings stay as plain tool_result text. Per 15-PATTERNS §"(b)", the image should ride a FRESH user turn (appendUserTurn), NOT be embedded in the tool_result.
- **15-07 (idle auto-render):** call `visualizeAction({ idle: true }, bot, config)` on the P3 idle tick; honor the `{ skip:true }` sentinel (drop the send) and apply the 16-block + LOS gate (`hasClearLineOfSight`, 15-03) BEFORE calling — explicit `visualize` is ungated by owner-proximity (D-08), idle is not.
- **Open from 15-01:** the packaged live-world human-verify checkpoint for `renderPov` is still OPEN (user deferred). This plan builds against the committed interface and mocks renderPov in tests, so it is not blocked — but the end-to-end render isn't human-confirmed until that checkpoint clears.
- Full client vitest suite green (57 files / 607 tests). render/ + scripts/ + the SEI_VISION_SPIKE probe + STATE.md + ROADMAP.md all untouched (as required).

## Self-Check: PASSED

- Created files present: `visualize.js`, `visualize.test.js`, `registry.vision.test.js`.
- Commits exist: `da75a17` (RED), `848a13f` (GREEN), `444c448` (Task 2), `b2b279d` (Task 3), `c54c343` (fix).
- Full suite: 57 files / 607 tests green.

---
*Phase: 15-in-game-vision-via-prismarine-viewer*
*Completed: 2026-06-10*
