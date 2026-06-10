---
phase: 15-in-game-vision-via-prismarine-viewer
verified: 2026-06-10T11:30:00Z
status: passed
score: 5/5 must-haves verified (1 gap found and closed in-phase; live-world human verify still pending)
overrides_applied: 0
gaps: []
gap_closure_note: "VIS-02 wiring gap found by initial verification, fixed same day in commit d647864 (visionEnabled: true at the production adapter construction site + regression tests). Re-verified: suite 580/580 green."
human_verification:
  - test: "Packaged live-world render via renderPov"
    expected: "Summon a bot into a loaded LAN Minecraft world with SEI_VISION_SPIKE=1; bot log shows 'vision spike: rendered N bytes JPEG' with N > 0 in both dev and the packaged dist app"
    why_human: "Requires a live LAN Minecraft world. The synthetic smoke test under Electron 42 proved gl+canvas dlopen and encode work (2643-byte JPEG), but only a real world proves bot.world chunks flow through prismarine-viewer WorldView into a JPEG. Explicitly deferred by user per context note."
---

# Phase 15: In-Game Vision via prismarine-viewer Verification Report

**Phase Goal:** The bot can render its own POV via `prismarine-viewer` headless rendering, the LLM can invoke a `visualize` Zod action when the active provider supports vision, idle auto-render is opt-in per character with a cost projection shown, and a custom line-of-sight helper handles non-full blocks, fluids, and entity bounding boxes correctly.

**Verified:** 2026-06-10T11:30:00Z
**Status:** passed (gap closed in-phase; packaged live-world human verify deferred)
**Re-verification:** Yes — VIS-02 gap fixed (commit d647864) and re-verified 2026-06-10

---

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC-1 | LLM can call `visualize` and receive a fresh bot-POV PNG as an image content block in its next turn — only when active provider's `capabilities.vision` is true | VERIFIED (after fix) | RESOLVED 2026-06-10 (commit d647864): `src/bot/index.js` now calls `createMinecraftAdapter({ bot: _bot, config, visionEnabled: true })` — registration is unconditional at the construction site (the provider doesn't exist yet there) and the orchestrator's `combinedToolsFor()` filter is the authoritative D-10 gate. Production-shaped regression tests added in `adapter/minecraft/index.test.js` (real-registry `listActions()` contains `visualize`; source assertion on the construction site). Full suite 580/580 green. Initial finding: construction site omitted the flag, so the tool never entered the production tool list and mock-adapter integration tests hid it. |
| SC-2 | When the active model is non-VLM, `visualize` is hidden from the action registry and idle auto-render is disabled (cannot be enabled) | VERIFIED | (a) `createDefaultRegistry({ visionEnabled:false })` — `visualize` absent by default; (b) `combinedToolsFor()` in `orchestrator.js` filters `t.name !== 'visualize'` when `!anthropic.capabilities?.vision`; (c) `useUiStore.visionCapable` defaults `false` and the Settings toggle is `disabled={!visionCapable}` — verified in `src/renderer/src/screens/SettingsScreen.tsx`. Note: both gates fail-closed by default, which means they also prevent VLM providers from offering `visualize` (see SC-1 gap). |
| SC-3 | Idle auto-render fires only when within 16 blocks of owner AND custom LOS helper confirms clear sight (slabs, signs, levers, fences, panes, fluids, entity bounding boxes handled); default OFF | VERIFIED | `idleVisionGate.shouldAutoRender(bot, config, provider)` checks (1) `config.vision.auto_render` (default OFF), (2) `provider.capabilities.vision`, (3) owner entity resolved, (4) `hasClearLineOfSight(bot, owner)`. `lineOfSight.js` uses ray-marching with `FLUID_NAMES` check + `pointInAnyShape` + `segmentIntersectsEntityAABB` — zero `raycast` calls (`grep -v '^//' | grep -c raycast` == 0). All 9 LOS tests + 12 idleVisionGate tests pass. Adapter seam via `shouldAutoRenderIdle`/`renderIdleFrame` methods. |
| SC-4 | Vision calls per hour capped by proxy for cloud-AI users; exceeding returns clear error, not silent failure | VERIFIED | `visionHourlyGate` middleware in sei-proxy caps 10/3600s. `Retry-After` header capped at 10s (260610 convention). POST `/vision/v1/messages` route: `originLockGate -> ipRateLimitGate -> verifyJwt -> visionHourlyGate -> rateLimitGate -> forward`. Migration `20260610120000_vision_hourly_bucket.sql` applied live; CHECK constraint includes `vision_hourly`. 141 proxy `src/` tests pass. |
| SC-5 | When bot's chunks aren't loaded enough to render meaningfully, says "I can't see clearly right now" rather than crashing or rendering a black frame | VERIFIED | `renderPov` returns `{ ok:false, reason:'cant_see' }` on: missing `bot.version`/`bot.entity`/`bot.world`, unsupported version, zero loaded chunks (`worldView.loadedChunks` empty), blank frame (GL readback), zero-byte buffer, or timeout. `visualizeAction` translates `{ ok:false }` to the literal string `"I can't see clearly right now"` (`CANT_SEE_COPY`). Never throws. VIS-08 degrade tests pass in `visualize.test.js`. |

**Score: 5/5 truths verified** (SC-1 initially FAILED; fixed in commit d647864 and re-verified)

---

### VIS Requirement Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| VIS-01: `prismarine-viewer` headless render from bot eye position | VERIFIED (synthetic, human-verify deferred) | `src/bot/adapter/minecraft/render/povRenderer.js` exports `renderPov`; `createRequire` + `Viewer` + `WorldView` + `canvas.toBuffer('image/jpeg')`. Synthetic Electron 42 smoke: 2643-byte JPEG. Live-world packaged verify deferred per user. |
| VIS-02: `visualize` Zod action in closed registry; LLM can call it | VERIFIED (after fix d647864) | Handler fully implemented in `visualize.js`; registration now unconditional at the production construction site; `combinedToolsFor()` is the authoritative capability gate. Regression tests pin both. |
| VIS-03: `visualize` hidden when provider is non-VLM; idle disabled | VERIFIED | Both gates (registry + tool-list filter) fail-closed by default. `visionCapable` store defaults `false`; toggle `disabled={!visionCapable}`. |
| VIS-04: Auto-render opt-in; 16-block + LOS gate; default OFF | VERIFIED | `shouldAutoRender` four-check gate; adapter seam `shouldAutoRenderIdle`/`renderIdleFrame`; orchestrator idle hook in `handleDispatch`. Tests: 12 gate + 5 integration. |
| VIS-05: Custom LOS (not `raycast`): fluids, slabs, entity AABBs | VERIFIED | `lineOfSight.js` 173 lines; zero `raycast` calls; `FLUID_NAMES`, `pointInAnyShape`, `segmentIntersectsEntityAABB`. 9 tests pass. |
| VIS-06: Renders downscaled to max 512x512 before LLM | VERIFIED | `resolution_px: z.number().int().min(64).max(512).default(256)` in `src/bot/config.js`; canvas created at target size; `toBuffer('image/jpeg', { quality })` emits at that resolution. |
| VIS-07: Per-hour cap by proxy for cloud-AI users | VERIFIED | `visionHourlyGate` + `/vision/v1/messages` route in sei-proxy; `_pendingVisionTurn` one-shot flag in orchestrator routes only explicit post-visualize turns to this path in cloud mode. |
| VIS-08: Graceful degrade when chunks not loaded | VERIFIED | `renderPov` returns `cant_see` sentinel; `visualizeAction` returns the string; never throws. |

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/bot/adapter/minecraft/render/povRenderer.js` | Headless POV render: world chunks -> JPEG buffer | VERIFIED | 201 lines; exports `renderPov` + `disposeRenderer`; `Promise.race` + `clearTimeout`; `CANT_SEE` sentinel. |
| `src/bot/adapter/minecraft/observers/lineOfSight.js` | Custom LOS (VIS-05) | VERIFIED | 173 lines; `hasClearLineOfSight`; zero `raycast`; fluids + entity AABB. |
| `src/bot/adapter/minecraft/behaviors/visualize.js` | visualize handler | VERIFIED | Handler fully implemented (160 lines); wiring fixed in d647864 — tool offered to VLM providers via the real registry. |
| `src/bot/adapter/minecraft/observers/idleVisionGate.js` | Idle auto-render gate | VERIFIED | 76 lines; `shouldAutoRender` + `resolveOwnerEntity`; imports `hasClearLineOfSight`. |
| `src/shared/characterSchema.ts` | `vision_auto_render` field | VERIFIED | `vision_auto_render: z.boolean().optional().default(false)` present. Runtime-parsed. |
| `src/shared/ipc.ts` | `vision:capability` channel + `VisionCapability` type | VERIFIED | `vision: { capability: 'vision:capability' }` + `VisionCapability { visionCapable: boolean }` exported. |
| `src/renderer/src/lib/stores/useUiStore.ts` | `visionCapable` (default false) | VERIFIED | `visionCapable: false` default; `setVisionCapable` setter; subscription in `useDataStore.ts`. |
| `src/renderer/src/components/VisionAutoRenderConfirmModal.tsx` | Confirm popup; no token counts | VERIFIED | Exists; body says "uses more playtime"; no numeric/token patterns. |
| `src/renderer/src/screens/SettingsScreen.tsx` | Toggle with `disabled={!visionCapable}` | VERIFIED | `vision_auto_render` read+write; `pendingVisionEnable`; `disabled={!visionCapable}`; no stale `.js`. |
| `src/renderer/src/lib/playtimeEstimate.ts` | `VISION_MULTIPLIER` | VERIFIED | `VISION_MULTIPLIER = 1.4`; used at `UsageBar.tsx:62` and `IconRail.tsx:237`. |
| sei-proxy: `src/rateLimit/visionHourlyGate.ts` | Per-hour cap gate | VERIFIED | `VISION_HOURLY_LIMIT = 10n`; `VISION_WINDOW_SECONDS = 3600`; `Retry-After` capped at 10s. |
| sei-proxy: `src/app.ts` | `/vision/v1/messages` route | VERIFIED | `app.post('/vision/v1/messages', originLockGate, ipRateLimitGate, verifyJwt, visionHourlyGate, rateLimitGate, handler)`. |
| sei-proxy: migration `20260610120000_vision_hourly_bucket.sql` | DB CHECK extended | VERIFIED | File exists; `vision_hourly` in constraint; applied live per SUMMARY. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `visualize.js` → `povRenderer.js` | `renderPov` | `import { renderPov }` | VERIFIED | Import present; mocked in tests to avoid native load. |
| `registry.js` → `capabilities.vision` | `visionEnabled` gate | `if (visionEnabled) register('visualize')` | PARTIAL — code exists, never true | Code correct, but `visionEnabled` never `true` in production (`bot/index.js:220` omits it). |
| `orchestrator.js` → `anthropic.capabilities.vision` | `combinedToolsFor` filter | `.filter(t => visionOk || t.name !== 'visualize')` | VERIFIED (but tool never in list anyway) | Filter correct; `const visionOk = !!anthropic.capabilities?.vision`. |
| `orchestrator.js` → `loop.appendUserTurn` | image block after explicit visualize | `handleVisualizeResult` | VERIFIED in tests, UNREACHABLE in production | Orchestrator wiring correct; unreachable because `visualize` never offered. |
| `orchestrator.js` → `/vision/v1/messages` | `_pendingVisionTurn` + `VISION_MESSAGES_PATH` | one-shot flag + `cloudMode` guard | VERIFIED | `VISION_MESSAGES_PATH` imported; `_pendingVisionTurn` set on explicit branch only; `visionPath` applied only under `config.anthropic.cloudMode`. |
| `idleVisionGate.js` → `lineOfSight.hasClearLineOfSight` | `shouldAutoRender` check 4 | `return hasClearLineOfSight(bot, owner)` | VERIFIED | Import present; called as final gate. |
| `adapter.shouldAutoRenderIdle` → `shouldAutoRender` | `orchestrator idle hook` | `adapter.shouldAutoRenderIdle(anthropic)` | VERIFIED | Wired via `index.js:136`; orchestrator calls through adapter seam. |
| `UserConfig.vision_auto_render` → `config.vision.auto_render` | `botSupervisor` bridge | `visionAutoRender` read and passed in init | VERIFIED | `src/main/botSupervisor.ts:344,556`. |
| `messageMappers.js` → OpenAI `image_url` / Gemini `inline_data` | per-provider image translation | `else if (blk.type === 'image')` in mapper loops | VERIFIED | `grep -c "image_url" messageMappers.js` = 3; `grep -c "inline_data"` = 2. 6 image-translation tests pass. |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `visualize.js` `visualizeAction` | `result` (render output) | `renderPov(bot, { width, height, quality })` | Yes — drives `prismarine-viewer/viewer` against `bot.world` | FLOWING (test-verified; live-world verify deferred) |
| `idleVisionGate.js` `shouldAutoRender` | `owner` entity | `bot.players[username]?.entity` | Yes — live mineflayer player table | FLOWING |
| `SettingsScreen.tsx` toggle | `cfg.vision_auto_render` | `sei.getConfig()` IPC -> `UserConfigSchema.parse()` | Yes — persisted config file | FLOWING |
| `UsageBar.tsx` / `IconRail.tsx` playtime | `VISION_MULTIPLIER` | `tokensRemainingToPlaytime(remaining, DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER)` | Yes — server-returned remaining tokens | FLOWING |
| `useUiStore.visionCapable` | `visionCapable` bool | `useDataStore` `sei.onVisionCapability` subscription | Yes — bot emits after summon-ready and on setBackend | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `renderPov` exports `renderPov` + `disposeRenderer` | `grep -E "export (async )?function renderPov\|export function disposeRenderer"` | Both found | PASS |
| No `raycast` in LOS (non-comment) | `grep -v '^//' lineOfSight.js \| grep -c raycast` | 0 | PASS |
| `VISION_MESSAGES_PATH = '/vision/v1/messages'` exported | ESM-safe grep on `anthropicClient.js` | `export const VISION_MESSAGES_PATH = '/vision/v1/messages'` found | PASS |
| `visionEnabled` never `true` in production | `grep -rn "visionEnabled.*true\|visionEnabled:\s*true" src/ \| grep -v test` | Only in test files | FAIL — confirms the gap |
| Client vitest suite | `npx vitest run` | 578/578 pass (55 files) | PASS |
| Proxy `src/` vitest suite | `cd sei-proxy && npx vitest run` | 141/141 pass (5 Deno collection failures are pre-existing, unrelated) | PASS |
| `fsm.test.js` known flake | `npx vitest run src/bot/brain/fsm.test.js` | 6/6 pass in isolation | PASS |

---

### Probe Execution

No probe scripts declared for this phase. The `scripts/vision-spike-electron-smoke.cjs` file exists but is an Electron-process smoke (cannot run under system Node vitest); it is the Task 3 scaffolding from plan 15-01, intentionally retained pending the human-verify checkpoint.

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| `scripts/vision-spike-electron-smoke.cjs` | Intentionally Electron-only (runs under packaged app) | Cannot run under system Node | SKIP (requires packaged app + human) |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| VIS-01 | 15-01 | Bot-POV rendering via prismarine-viewer | VERIFIED (synthetic) | `povRenderer.js` exists; 2643-byte Electron-42 smoke passed; live-world verify deferred |
| VIS-02 | 15-04 | `visualize` Zod action; LLM can call it | VERIFIED (after fix d647864) | Registration unconditional at construction site; tool-list filter is the authoritative gate; regression-tested |
| VIS-03 | 15-03, 15-04 | `visualize` hidden when non-VLM; idle disabled | VERIFIED | Dual gates (registry + filter); `visionCapable` defaults false; Settings toggle disabled |
| VIS-04 | 15-07 | Idle auto-render opt-in; 16-block + LOS gate; default OFF | VERIFIED | `shouldAutoRender` four gates; adapter seam; orchestrator idle hook; 17 tests |
| VIS-05 | 15-03 | Custom LOS (not raycast); fluids + entity AABBs | VERIFIED | `lineOfSight.js`; zero raycast; `FLUID_NAMES`; `pointInAnyShape`; `segmentIntersectsEntityAABB`; 9 tests |
| VIS-06 | 15-01, 15-03 | Renders ≤512×512 | VERIFIED | `resolution_px .max(512)` in `config.js`; canvas created at target size |
| VIS-07 | 15-02, 15-06 | Per-hour cap; proxy; clear error | VERIFIED | `visionHourlyGate`; `/vision/v1/messages`; `_pendingVisionTurn`; migration applied |
| VIS-08 | 15-01, 15-04 | Graceful degrade; "I can't see clearly right now" | VERIFIED | `CANT_SEE` sentinel; `CANT_SEE_COPY` string; never throws; 9 degrade tests |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/bot/index.js` | 110–122 | `SEI_VISION_SPIKE=1` probe (gated by env var) | INFO (known open item) | Intentionally retained per user-deferred packaged live-world verify; gated behind `process.env.SEI_VISION_SPIKE === '1'`; ships nothing by default |
| `scripts/vision-spike-electron-smoke.cjs` | whole file | Temporary spike scaffolding | INFO (known open item) | Same as above — removal is a recorded follow-up after human approves the packaged render |
| `src/bot/index.js` | 220 | ~~omitted `visionEnabled`~~ FIXED in d647864 — passes `visionEnabled: true` with rationale comment | RESOLVED | Regression tests in `adapter/minecraft/index.test.js` pin the construction shape |

---

### Human Verification Required

#### 1. Packaged live-world render (VIS-01 / VIS-08 full confirmation)

**Test:** With `SEI_VISION_SPIKE=1`, launch the packaged `dist` app (`release/mac-arm64/Sei Launcher.app`), summon a bot into an open-to-LAN Minecraft world, and check the bot log (`~/Library/Application Support/Sei Launcher/logs/`) for `vision spike: rendered N bytes JPEG` with N > 0.

**Expected:** The bot log shows `vision spike: rendered N bytes JPEG` (N > 0) in the packaged app without a crash — proving `gl`/`canvas` `.node` binaries load from `app.asar.unpacked` under the real Electron 42 ABI and that live world chunks flow through `prismarine-viewer` `WorldView` into a JPEG.

**Why human:** Requires a live LAN Minecraft world. The synthetic Electron 42 smoke proved the native pipeline loads/renders (2643-byte JPEG, synthetic scene), but the live-world path through `bot.world` was explicitly deferred by the user. Cannot be verified programmatically.

**Follow-up after approval:** Remove the `SEI_VISION_SPIKE` probe from `src/bot/index.js` and `scripts/vision-spike-electron-smoke.cjs`; verify `grep -rc "SEI_VISION_SPIKE" src/` returns 0.

---

## Gaps Summary

**One blocker gap** preventing the explicit LLM-callable `visualize` path from working in production:

**VIS-02 wiring gap (BLOCKER — CLOSED in commit d647864):** `createMinecraftAdapter` in `src/bot/index.js:220` is always called without `visionEnabled`. The adapter is created before `startBrain` and before the provider exists — so the `visionEnabled` flag cannot be derived from `capabilities.vision` at construction time. As a result, `createDefaultRegistry({ visionEnabled: false })` never registers `visualize`, and the orchestrator's `combinedToolsFor()` never includes it in the tool list (the filter can only remove, not add tools). The model is never offered `visualize` regardless of whether the active provider is a VLM. Integration tests in `orchestrator.visualize.test.js` use a mock adapter with `'visualize'` hard-coded in `listActions()` — they prove the orchestrator wiring is correct but test a path that cannot be reached in production.

The idle auto-render path (VIS-04) is fully functional because it bypasses the tool-registry mechanism — the orchestrator calls `adapter.shouldAutoRenderIdle()` / `adapter.renderIdleFrame()` directly through the adapter seam. The explicit LLM-invoked `visualize` requires either (a) re-creating the adapter after the brain is initialized with `visionEnabled` from the known provider, or (b) adding a late-registration mechanism, or (c) passing `visionEnabled: true` initially and relying solely on the orchestrator's tool-list filter as the authoritative gate (which is already implemented and tested).

The simplest fix is to pass `visionEnabled: true` in `createMinecraftAdapter` and rely on the orchestrator's `combinedToolsFor()` filter as the sole cap-enforcement gate — which is exactly how the plan describes the system: "the orchestrator filter is the AUTHORITATIVE gate." This approach is safe because the filter already prevents a non-VLM model from seeing `visualize`, regardless of registration.

**One known open item (not a blocker):** The packaged live-world human-verify for `renderPov` (VIS-01 / VIS-08) was explicitly deferred by the user. The synthetic Electron 42 smoke (2643-byte JPEG) plus the committed `app.asar.unpacked` structure provide high confidence; the live-world verify is the final confirmation.

---

_Verified: 2026-06-10T11:30:00Z_
_Verifier: Claude (gsd-verifier)_
