---
phase: 15-in-game-vision-via-prismarine-viewer
plan: 07
subsystem: api
tags: [vision, vlm, idle-tick, line-of-sight, auto-render, dedupe, orchestrator, adapter-seam, vitest, vis-04]

# Dependency graph
requires:
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 03)
    provides: "config.vision block (auto_render OFF default) + hasClearLineOfSight(bot, owner) custom LOS with 16-block range gate + fluid/entity occlusion (fail-closed)"
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 04)
    provides: "visualizeAction(args, bot, config) — {idle:true} applies D-02 pose-dedupe, returns {skip:true} on near-duplicate / structured image / degrade string"
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 06)
    provides: "handleVisualizeResult(loop, result, {idle}) image-attach on a FRESH user turn; idle:true deliberately NEVER arms _pendingVisionTurn (D-09)"
  - phase: 14-multi-provider-model-abstraction
    provides: "provider.capabilities.vision descriptor the orchestrator already holds as `anthropic`"
provides:
  - "idleVisionGate.shouldAutoRender(bot, config, provider) — the composite VIS-04 idle gate: four fail-closed checks ordered cheap-to-expensive (auto_render ON -> capabilities.vision -> owner resolved -> hasClearLineOfSight clear)"
  - "idleVisionGate.resolveOwnerEntity(bot, config) — config.player_username -> bot.players[username].entity, null on any miss"
  - "adapter.shouldAutoRenderIdle(provider) + adapter.renderIdleFrame() — the two seam methods that keep the mineflayer bot adapter-side while the orchestrator drives idle auto-render"
  - "orchestrator P3 idle-tick hook: gate -> render (idle:true dedupe) -> attach via handleVisualizeResult({idle:true}); gated-out / {skip:true} / degrade = silent no-op; NO new timer; idle stays on /v1/messages (D-09)"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Composite fail-closed gate, cheap-to-expensive short-circuit: boolean toggle + capability checks gate BEFORE the expensive owner-resolution + ray-march LOS, so an OFF toggle or non-VLM provider never pays for an LOS walk"
    - "Brain↔adapter seam preserved for a bot-touching idle behavior: the orchestrator references the gate/render through adapter methods (shouldAutoRenderIdle / renderIdleFrame) so the mineflayer bot reference stays adapter-side — the brain never imports src/adapter/ or mineflayer"
    - "Idle-tick reuse (no new scheduler): the hook fires inside the existing fresh-loop sei:idle branch of handleDispatch, before runIterations — the ~60s P3 cadence IS the render cadence"
    - "Idle render delivered through the EXISTING 15-06 image-attach (handleVisualizeResult with idle:true) — one image-attach implementation, idle path deliberately does not arm the one-shot vision-cap flag (D-09)"

key-files:
  created:
    - src/bot/adapter/minecraft/observers/idleVisionGate.js
    - src/bot/adapter/minecraft/observers/idleVisionGate.test.js
    - src/bot/brain/orchestrator.idleVision.test.js
  modified:
    - src/bot/adapter/minecraft/index.js
    - src/bot/brain/orchestrator.js

key-decisions:
  - "The orchestrator drives idle auto-render through TWO adapter seam methods (shouldAutoRenderIdle, renderIdleFrame) rather than importing idleVisionGate/visualize directly — preserving the load-bearing brain↔adapter invariant (CLAUDE.md: the orchestrator never imports from src/adapter/ or mineflayer). The grep-for-shouldAutoRender link is satisfied via adapter.shouldAutoRenderIdle (substring match)."
  - "The idle hook lives on the FRESH-LOOP idle branch of handleDispatch (after the seed appendUserTurn, before runIterations), so the rendered frame is attached to THIS idle turn's user content and the model comments on what it sees on the same turn."
  - "Idle render delivered via handleVisualizeResult(loop, result, {idle:true}) — reusing 15-06's image-attach verbatim. idle:true is the negative branch of that helper: it attaches the image but never sets _pendingVisionTurn, so the idle turn stays on /v1/messages (D-09 — only explicit visualize hits the per-hour cap)."
  - "Owner resolution is config.player_username -> bot.players[username]?.entity (targeting.js idiom). A present-but-unloaded player (out of render distance) carries a null .entity -> gate fails closed. The 16-block RANGE gate is NOT re-implemented here — it lives inside hasClearLineOfSight (15-03); resolving the owner then deferring to the LOS helper gives range + occlusion + fluids in one fail-closed call."
  - "The hook is wrapped in try/catch and uses typeof-function guards on the adapter methods: a render hiccup or an adapter without the seam (test mocks, future adapters) leaves the normal idle turn intact — auto-render is strictly best-effort."

patterns-established:
  - "Composite fail-closed capability gate with cheap-to-expensive ordering and a single deferred range/occlusion call"
  - "Bot-touching brain behavior routed through adapter seam methods to keep mineflayer out of brain code"

requirements-completed: [VIS-04]

# Metrics
duration: ~4min
completed: 2026-06-10
---

# Phase 15 Plan 07: Idle Auto-Render Hook (VIS-04) Summary

**The opt-in periodic "look around": on the existing P3 `sei:idle` tick a VLM-backed bot runs a four-check fail-closed gate (auto_render ON → provider VLM → owner ≤16 blocks → custom LOS clear) and, only when all pass, renders its POV (idle-deduped) and attaches the frame to the idle turn via the 15-06 image mechanism — reusing the idle tick (no new timer) and the standard LLM path (idle never hits the per-hour /vision cap, D-09).**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-06-10T18:12Z
- **Completed:** 2026-06-10T18:16:43Z
- **Tasks:** 2 (Task 1 was TDD: RED + GREEN)
- **Files modified:** 5 (3 created, 2 modified)
- **Tests:** 578/578 vitest pass across 55 files (baseline 561/53 + 17 new: 12 idleVisionGate + 5 idle-hook integration). The known `fsm.test.js` flake did not trigger.

## Accomplishments

- **VIS-04 composite gate (Task 1, TDD):** `idleVisionGate.shouldAutoRender(bot, config, provider)` — four checks, ordered cheap-to-expensive, EVERY one failing CLOSED: `(1)` `config.vision.auto_render` ON (default OFF) → `(2)` `provider.capabilities.vision` true (D-10) → `(3)` owner resolved (`resolveOwnerEntity`) → `(4)` `hasClearLineOfSight(bot, owner)` (16-block range + fluid/entity occlusion lives inside the helper, 15-03). The boolean toggle/capability checks short-circuit before the expensive owner-resolution + ray-march LOS.
- **Idle-tick hook (Task 2):** the orchestrator's fresh-loop `sei:idle` branch now checks `adapter.shouldAutoRenderIdle(anthropic)` BEFORE the normal idle LLM turn; on a clear gate it renders via `adapter.renderIdleFrame()` (`visualizeAction({idle:true})`, so D-02 dedupe applies) and attaches the frame through `handleVisualizeResult(loop, result, {idle:true})`. No new timer — the existing ~60s P3 tick IS the cadence.
- **D-09 standard-path proof:** idle delivery passes `{idle:true}` to `handleVisualizeResult`, the negative branch that attaches the image but never arms `_pendingVisionTurn`. The integration test asserts that even in cloud mode the idle turn's `path` is `undefined` — idle is uncounted by the per-hour `/vision/v1/messages` cap; only explicit visualize hits it.
- **Seam preserved:** two adapter methods (`shouldAutoRenderIdle`, `renderIdleFrame`) keep the mineflayer `bot` reference adapter-side; the orchestrator drives idle auto-render without importing `src/adapter/` or mineflayer (CLAUDE.md invariant intact).

## The gate order as implemented (each gate, the test proving it fails closed)

| # | Gate | Implementation | Fails closed when | Proving test (`idleVisionGate.test.js`) |
|---|------|----------------|-------------------|------------------------------------------|
| 1 | Toggle ON | `if (!config?.vision?.auto_render) return false` | auto_render OFF (default) / config or config.vision missing | "returns false when config.vision.auto_render is OFF … without even checking LOS"; "fails closed when config or config.vision is missing" |
| 2 | Provider VLM | `if (!provider?.capabilities?.vision) return false` | non-VLM provider / capabilities/provider missing | "returns false when the provider is NOT vision-capable (D-10)"; "returns false when capabilities is missing entirely" (also `null` provider) |
| 3 | Owner resolved | `resolveOwnerEntity` → `bot.players[username]?.entity` | owner offline / out of render distance (null entity) / player_username unset / bot missing | "returns false when the owner entity cannot be resolved"; "fails closed on a missing bot"; `resolveOwnerEntity` block (4 cases) |
| 4 | LOS clear | `return hasClearLineOfSight(bot, owner)` | >16 blocks OR occluded (handled inside the 15-03 helper) | "returns false when LOS is blocked (>16 blocks OR occluded)"; "returns TRUE only when toggle ON + VLM + owner resolved + LOS clear" (asserts LOS called with the OWNER entity) |

The all-clear TRUE case requires ALL four — no path returns true without every condition. Mocking `hasClearLineOfSight` lets each branch assert short-circuit ordering (e.g. an OFF toggle never calls LOS).

## Idle never arms the vision-path flag (D-09) — confirmation

The orchestrator idle hook calls `handleVisualizeResult(loop, idleResult, { idle: true })`. In that helper, `_pendingVisionTurn = true` is set only under `if (!idle)` — so the idle path NEVER arms it. `callPersonality` therefore computes `visionPath = undefined` for the idle turn (no `path` forwarded to `sdk.messages.create`). Proven three ways:
- `grep -c "'/vision/v1/messages'" src/bot/brain/orchestrator.js` == 0 (the literal stays single-sourced in `anthropicClient.js` via the imported `VISION_MESSAGES_PATH`; never inlined here).
- The idle hook diff (orchestrator.js) neither sets `_pendingVisionTurn` nor passes a `path` — it only calls `adapter.shouldAutoRenderIdle` / `adapter.renderIdleFrame` / `handleVisualizeResult({idle:true})`.
- `orchestrator.idleVision.test.js` "gate CLEAR … stays on the standard path (NOT /vision) even in cloud mode" asserts `provider.calls[0].path` is `undefined` with `cloudMode` set.

## Task Commits

Each task committed atomically (branch `dev`, hooks enabled, no `--no-verify`):

1. **Task 1 (TDD): idleVisionGate composite gate** — `0a99bdd` (test / RED — module absent), `a4b53ce` (feat / GREEN — 12 tests pass). No refactor commit; clean on first GREEN.
2. **Task 2: orchestrator idle-tick hook + adapter seams + integration test** — `5b24cf0` (feat)

**Plan metadata:** committed with this SUMMARY (docs).

## Files Created/Modified

**Created**
- `src/bot/adapter/minecraft/observers/idleVisionGate.js` — `shouldAutoRender` (four fail-closed checks) + `resolveOwnerEntity`.
- `src/bot/adapter/minecraft/observers/idleVisionGate.test.js` — 12 tests (each false branch + all-clear true + owner resolution + null-config/null-bot fail-closed; LOS mocked).
- `src/bot/brain/orchestrator.idleVision.test.js` — 5 integration tests (gate clear → frame attached + standard path in cloud; gate closed → no render; `{skip:true}` dedupe → no image; degrade → no image; non-idle chat never checks the gate).

**Modified**
- `src/bot/adapter/minecraft/index.js` — imports `shouldAutoRender` + `visualizeAction`; adds `shouldAutoRenderIdle(provider)` and `renderIdleFrame()` adapter methods (bot stays adapter-side).
- `src/bot/brain/orchestrator.js` — idle-tick hook in `handleDispatch`'s fresh-loop branch (gate → render → attach via `handleVisualizeResult({idle:true})`), wrapped in try/catch with typeof-function guards.

## Decisions Made

See `key-decisions` frontmatter. Headline: drive idle auto-render through adapter seam methods (so the brain never touches the bot/mineflayer — CLAUDE.md invariant), hook on the fresh-loop idle branch so the frame rides the same idle turn, deliver via the 15-06 image-attach with `idle:true` so it attaches WITHOUT arming the vision-cap flag (D-09), and resolve the owner via the `bot.players[username].entity` idiom while leaving the 16-block range gate inside `hasClearLineOfSight`.

## Deviations from Plan

None — plan executed exactly as written.

The plan's interface said the orchestrator calls `shouldAutoRender(bot, config, anthropic)`. Because the orchestrator holds no bot reference and the brain↔adapter seam forbids it from importing `src/adapter/` or mineflayer (CLAUDE.md), the gate + render are reached through two adapter seam methods (`shouldAutoRenderIdle` / `renderIdleFrame`) that thread the adapter's bot. This is the seam-faithful realization of the plan's intent (not a deviation): the `key_link` "orchestrator → idleVisionGate.shouldAutoRender" is honored via `adapter.shouldAutoRenderIdle`, and the `grep -c shouldAutoRender` acceptance (== 2) is satisfied.

## Issues Encountered

None. The TDD RED commit failed as expected (module absent), GREEN passed all 12 gate tests on first implementation, and the orchestrator hook + adapter seams passed the brain + adapter suites and the new integration suite with no regression.

## Known Stubs

None — the gate is fully implemented and tested, the orchestrator hook is wired end-to-end through real adapter methods, and the idle render reuses the proven 15-04 `visualizeAction` + 15-06 `handleVisualizeResult`. The only mocks are test-side (LOS mocked in the unit suite; a scripted provider + mock adapter in the integration suite — the same native-free strategy 15-04/15-06 use).

## Threat Flags

None beyond the plan's `<threat_model>`. T-15-07-01 (cost/DoS) — mitigated by all four controls: default OFF (gate check 1), D-02 dedupe (`{skip:true}` → silent no-op, asserted), the ~60s idle cadence (reused, no new timer), and the 15-04 ~256px compression. T-15-07-02 (privacy leak when owner is behind cover/underwater) — mitigated: the fail-closed custom LOS (fluids + entity AABBs as occluders, 16-block range) gates checks 3–4; a non-resolved owner → no render. T-15-07-03 (cap-path elevation) — mitigated: idle uses the standard `/v1/messages` path (`{idle:true}` never arms `_pendingVisionTurn`), asserted in cloud mode. No new trust-boundary surface introduced.

## Next Phase Readiness

- **Phase 15 is functionally complete.** This was the last plan (wave 4); the idle auto-render path now closes the VIS-04 loop on top of the LOS helper (15-03), the visualize action (15-04), the capability surface (15-03), and the image-attach + vision-routing wiring (15-06).
- **Open from 15-01:** the packaged live-world human-verify checkpoint for `renderPov` remains OPEN (user deferred). This plan builds against the committed 15-04/15-06 contracts and uses mocks/scripts in tests, so it is not blocked — but the true end-to-end idle render-to-model round trip in a live world isn't human-confirmed until that checkpoint clears.
- Full client vitest suite green (55 files / 578 tests). `STATE.md` / `ROADMAP.md` NOT modified (the orchestrator owns those writes). The `SEI_VISION_SPIKE` probe in `src/bot/index.js` untouched.

## Self-Check: PASSED

- Created files present: `src/bot/adapter/minecraft/observers/idleVisionGate.js`, `src/bot/adapter/minecraft/observers/idleVisionGate.test.js`, `src/bot/brain/orchestrator.idleVision.test.js`.
- Commits exist: `0a99bdd` (RED), `a4b53ce` (GREEN), `5b24cf0` (Task 2).
- Plan verification: `idleVisionGate.test.js` 12/12; `grep -c shouldAutoRender src/bot/brain/orchestrator.js` == 2 (>=1); `grep -c "'/vision/v1/messages'" src/bot/brain/orchestrator.js` == 0; brain suite no regression (61/61); `setInterval|setTimeout` count unchanged at 3 (no new timer). Full suite 578/578.

---
*Phase: 15-in-game-vision-via-prismarine-viewer*
*Completed: 2026-06-10*
