---
phase: 15-in-game-vision-via-prismarine-viewer
plan: 06
subsystem: api
tags: [vision, vlm, multi-provider, image-block, anthropic-sdk, rate-limit, proxy, vitest, orchestrator, messageMappers]

# Dependency graph
requires:
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 04)
    provides: "visualizeAction success shape { text:string, image:{ mediaType:string, dataBase64:string } } | degrade string | { skip:true } | 'aborted' — the exact contract this plan consumes"
  - phase: 15-in-game-vision-via-prismarine-viewer (plan 02)
    provides: "POST /vision/v1/messages proxy route + server-authoritative vision_hourly cap (10/3600s) — the path this plan routes the post-visualize turn to"
  - phase: 14-multi-provider-model-abstraction
    provides: "messageMappers anthropic<->OpenAI/Gemini translation seam + per-provider capabilities.vision descriptor"
provides:
  - "Provider-neutral image block { type:'image', source:{ type:'base64', media_type, data } } translated per provider in messageMappers (Anthropic passthrough, OpenAI/Ollama image_url data-URL in ARRAY content, Gemini inline_data)"
  - "anthropicClient.call optional per-call `path` override + exported VISION_MESSAGES_PATH = '/vision/v1/messages' — single-sourced literal, forwarded into sdk.messages.create options only when truthy"
  - "orchestrator handleVisualizeResult: structured visualize result -> short tool_result text + image on a FRESH user turn; base64 never leaks into tool_result/lastActionResult/history"
  - "orchestrator one-shot _pendingVisionTurn flag: EXACTLY the one post-explicit-visualize personality turn routes via /vision/v1/messages in cloud mode (BYOK/local + idle stay on /v1/messages)"
  - "loop.buildAnthropicPayload image-block passthrough VERIFIED by test (no loop.js edit needed)"
affects: [15-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Provider-neutral image content block: one internal shape (== Anthropic wire) translated at the messageMappers seam so the orchestrator stays provider-agnostic (VIS-02)"
    - "Image rides a FRESH role:'user' turn (never a tool_result) — the lowest-common-denominator shape across Anthropic/OpenAI/Gemini/Ollama (Pitfall 4)"
    - "Per-call SDK RequestOptions.path override for selective proxy routing (single client, no header/second-client surface)"
    - "One-shot routing flag set+cleared at the single LLM seam (callPersonality) so exactly ONE turn is metered against a server cap"
    - "formatToolResult passes a structured action result through as an OBJECT (not JSON) so a downstream interceptor can branch on it before the generic slot-fill — prevents base64 baking into history"

key-files:
  created:
    - src/bot/brain/orchestrator.visualize.test.js
    - src/bot/brain/loop.test.js
  modified:
    - src/bot/brain/llm/messageMappers.js
    - src/bot/brain/llm/messageMappers.test.js
    - src/bot/brain/anthropicClient.js
    - src/bot/brain/orchestrator.js

key-decisions:
  - "Image rides a fresh user turn via loop.appendUserTurn([image, event-text]) — never inside the visualize tool_result (tool_result stays the short text 'rendered view attached'). Anthropic alone accepts an image in a tool_result; OpenAI/Gemini/Ollama require a user-turn image, so the fresh-user-turn shape is the only cross-provider-safe option."
  - "OpenAI/Ollama user content switches to the multimodal ARRAY form ONLY when an image is present; text-only turns keep the coalesced string form (zero regression to existing turns)."
  - "VISION_MESSAGES_PATH exported from anthropicClient.js (single source) and imported by the orchestrator — no string duplication / drift."
  - "One-shot _pendingVisionTurn is read+cleared UNCONDITIONALLY in callPersonality (not gated on cloudMode) so the flag can never 'stick' across a backend switch; the /vision path is then applied only when config.anthropic.cloudMode is set (D-11: BYOK/local uncapped)."
  - "formatToolResult special-cases the structured visualize result (and { skip }) to pass it through as an object — required because it was JSON-stringifying it BEFORE handleVisualizeResult could intercept, which would have baked base64 into data.result (hazard #2)."
  - "Covered BOTH completion paths (handleActionComplete + handleActionCompleteTickClaimed); visualize is a short-lived long-runner that settles via handleActionComplete (confirmed by integration test logs), but the tick-claimed branch is guarded too in case the handler timeout is ever raised above the 10s tick."

patterns-established:
  - "Cross-provider image attachment: provider-neutral block + per-mapper translation; image on a user turn, short text on the tool_result."
  - "Selective server-cap routing: a per-call path override armed by a one-shot flag at the single LLM seam, cloud-mode-gated."

requirements-completed: [VIS-02, VIS-07]

# Metrics
duration: ~10min
completed: 2026-06-10
---

# Phase 15 Plan 06: Wire the rendered frame back to the LLM + route the post-visualize turn to /vision Summary

**The rendered frame reaches the model: a provider-neutral image block translated per provider in messageMappers (Anthropic passthrough, OpenAI/Ollama `image_url`, Gemini `inline_data`), attached on a FRESH user turn after an explicit `visualize` (base64 never leaking into the tool_result, `lastActionResult`, or history), with EXACTLY that one post-visualize personality turn routed through the proxy `/vision/v1/messages` per-hour cap in cloud mode only — closing RESEARCH Open Q1.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-06-10T18:00Z
- **Completed:** 2026-06-10T18:08Z
- **Tasks:** 4 (Task 1 was TDD: RED + GREEN)
- **Files modified:** 6 (2 created, 4 modified)
- **Tests:** 620/620 vitest pass across 59 files (baseline 607 + 13 new: 6 messageMappers image + 4 visualize integration + 3 loop passthrough). The known `fsm.test.js` flake did not trigger.

## Accomplishments

- **VIS-02 per-provider image translation (Task 1, TDD):** `messageMappers.js` translates the provider-neutral `{ type:'image', source:{ type:'base64', media_type, data } }` block to each provider's native shape — OpenAI/Ollama `{ type:'image_url', image_url:{ url:'data:<mt>;base64,<b64>' } }` in the **array** content form (text-only turns keep the coalesced string), Gemini `{ inline_data:{ mime_type, data } }`, Anthropic passes through verbatim. An image NEVER lands on a tool/function-result message (Pitfall 4) — asserted by test.
- **VIS-07 routing seam (Task 2):** `anthropicClient.call` accepts an optional `path`, forwarded into the single `sdk.messages.create(req, { ... })` options object only when truthy (`...(path ? { path } : {})`); the deadline controller / attempt loop / rescue-retry policy are untouched. Exported `VISION_MESSAGES_PATH = '/vision/v1/messages'`.
- **VIS-02 + VIS-07/D-09 orchestrator wiring (Task 3):** `handleVisualizeResult` branches on the 15-04 result shape — structured success -> short `text` for the tool_result + `lastActionResult`, image on a fresh `appendUserTurn`; degrade string / `{ skip }` -> text only, no image. A one-shot `_pendingVisionTurn` flag, set only on the explicit branch and applied only under `config.anthropic.cloudMode`, makes exactly the next personality turn hit `/vision/v1/messages`.
- **loop.js passthrough verified (Task 4):** new `loop.test.js` proves the image block survives `buildAnthropicPayload` unchanged (deep-clone passthrough, snapshot-strip untouched). **No loop.js edit was needed.**

## The three audit hazards — how each was resolved (with the proving test)

**Hazard #1 — two completion paths.** `visualize` is NOT in `INLINE_METADATA`, so it dispatches via `startLongRunner` and settles through `sei:action_complete -> handleActionComplete` (confirmed: the integration test's run log shows `first-iter/no-inflight long-runner=visualize` -> `[act!]` -> `terminateLoop reason=natural-after-action-complete`). The tick-claimed variant (`handleActionCompleteTickClaimed`) is ALSO wired (`data.name === 'visualize'`) as defense in depth — it would only fire if a render outlived the 10s tick (the 8s handler timeout makes that practically unreachable). **Proven by:** `orchestrator.visualize.test.js` "attaches the frame as a FRESH user image turn …" (settle path) — all 4 cases in that file exercise the handleActionComplete route.

**Hazard #2 — slot-fill / lastActionResult leak.** Two interception points: (a) `formatToolResult` now passes the structured visualize result through as an **object** instead of JSON-stringifying it (it previously serialized any >2-key object, which would have baked the base64 into `data.result` before any interception). (b) Both completion handlers call `handleVisualizeResult` BEFORE the generic `content: data.result` slot-fill and the `lastActionResult = data.result` assignment, substituting the short `text`. **Proven by:** the integration test asserts the base64 token appears **exactly once** in the post-visualize payload (the image block's `data`), the visualize tool_result content is the literal string `"rendered view attached"`, and the snapshot's `last_action_result` line carries the short text — never the raw object or base64.

**Hazard #3 — the 260610-reworked call() retry/deadline machinery.** The `path` spread was added to the existing `{ signal, timeout }` options object at the SINGLE `sdk.messages.create` site (now inside the attempt loop); `buildSdkOptions` (`maxRetries:0`), the `ctrl` deadline controller, and the rescue-retry policy are all untouched. A vision-gate 429 retried once re-hits the SAME path via the loop's `path` closure — accepted behavior, not special-cased. **Proven by:** `npx vitest run src/bot/brain/` stays green (the existing anthropicClient/orchestrator retry+deadline tests are unaffected), and the ESM import gate prints `/vision/v1/messages`.

## The "next turn is a vision turn" mechanism (exact wiring)

1. On the EXPLICIT visualize success branch only, `handleVisualizeResult(loop, result, { idle:false })` sets `_pendingVisionTurn = true` (idle path — 15-07 — passes `idle:true` and never arms it; D-09).
2. The next `callPersonality(loop, signal)` reads `const visionTurn = _pendingVisionTurn` then immediately `_pendingVisionTurn = false` (one-shot, cleared every turn).
3. `const visionPath = (visionTurn && config.anthropic.cloudMode) ? VISION_MESSAGES_PATH : undefined` — cloud-only (D-11).
4. `anthropic.call({ ..., ...(visionPath ? { path: visionPath } : {}) })`.
5. `provider.call === anthropicClient.call` (anthropicProvider is a direct passthrough), so the `path` threads through to `sdk.messages.create`. Every subsequent turn reverts to the SDK default `/v1/messages`.

## Per-provider image-on-user-turn shape (confirmed across all four)

| Provider | Image shape | On a tool/function-result message? |
|----------|-------------|-------------------------------------|
| Anthropic | `{ type:'image', source:{ type:'base64', media_type, data } }` (verbatim passthrough) | Never — orchestrator appends it on a user turn |
| OpenAI / Ollama | `{ type:'image_url', image_url:{ url:'data:<mt>;base64,<b64>' } }` in **array** content | Never — tool_result becomes a separate `{role:'tool'}` text message |
| Gemini | `{ inline_data:{ mime_type, data } }` part | Never — functionResponse parts carry no inline_data |

## Task Commits

Each task committed atomically (branch `dev`, hooks enabled, no `--no-verify`):

1. **Task 1 (TDD): messageMappers image translation** — `e469484` (test / RED), `46b9d95` (feat / GREEN). No refactor commit — clean on first GREEN.
2. **Task 2: anthropicClient per-call path + VISION_MESSAGES_PATH** — `6e8a5b5` (feat)
3. **Task 3: orchestrator image attach + /vision routing (+ formatToolResult fix + integration test)** — `420af48` (feat)
4. **Task 4: loop.js passthrough verification test** — `2776fab` (test)

**Plan metadata:** committed with this SUMMARY (docs).

## Files Created/Modified

**Created**
- `src/bot/brain/orchestrator.visualize.test.js` — 4 end-to-end tests (real orchestrator + scripted provider + mock adapter) covering the settle path, the no-base64-leak guarantee, cloud-only one-shot vision routing, BYOK/idle exclusion, the degrade case, and one-shot revert.
- `src/bot/brain/loop.test.js` — 3 tests proving the image block survives `buildAnthropicPayload` (preserved on last AND non-last user turns; deep-clone isolation).

**Modified**
- `src/bot/brain/llm/messageMappers.js` — `anthropicToOpenAIMessages` (image -> `image_url`, array content when an image is present) + `anthropicToGeminiContents` (image -> `inline_data`).
- `src/bot/brain/llm/messageMappers.test.js` — 6 new image-translation cases (OpenAI array/data-URL/png, no-image-on-tool-result, Gemini inline_data, Gemini no-inline-on-functionResponse).
- `src/bot/brain/anthropicClient.js` — `VISION_MESSAGES_PATH` export + optional `path` param on `call()` forwarded into the single create-site options.
- `src/bot/brain/orchestrator.js` — `VISION_MESSAGES_PATH` import, `_pendingVisionTurn` flag, `handleVisualizeResult` helper, interception in both completion handlers, `formatToolResult` structured-visualize passthrough, `callPersonality` one-shot vision-path.

## Decisions Made

See `key-decisions` frontmatter. Headline: image on a fresh user turn (cross-provider LCD), `path` override single-sourced via `VISION_MESSAGES_PATH`, one-shot vision flag read+cleared unconditionally but applied cloud-only, and `formatToolResult` passing the structured visualize result through as an object so the base64 never serializes into history.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `formatToolResult` was JSON-stringifying the structured visualize result before the image-attach interception could run**
- **Found during:** Task 3 (writing the integration test — the post-visualize turn never fired and base64 would have leaked).
- **Issue:** The plan's interfaces noted the slot-fill puts `data.result` in verbatim, but `data.result` is the output of `attachSettleHandler -> formatToolResult(use.name, r)`, NOT the raw handler return. `formatToolResult` JSON-stringifies any object with >2 keys / no `ok` field, so the `{ text, image:{ mediaType, dataBase64 } }` object was being serialized (base64 and all) into `data.result` BEFORE `handleActionComplete` could branch on it. My `typeof result === 'object'` check would then never match, the image turn would never append, and the base64 string would land in the tool_result + `lastActionResult` + history — exactly hazard #2.
- **Fix:** `formatToolResult` now special-cases `name === 'visualize'` with the structured shape (or `{ skip:true }`) and returns the object unchanged, so `handleVisualizeResult` downstream extracts the short text and rides the image on a fresh user turn.
- **Files modified:** `src/bot/brain/orchestrator.js`
- **Verification:** `orchestrator.visualize.test.js` asserts base64 appears exactly once (the image block), tool_result content is `"rendered view attached"`, and `last_action_result` carries the short text. All 4 cases green.
- **Committed in:** `420af48` (Task 3 commit).

---

**Total deviations:** 1 auto-fixed (1 bug — a latent base64-leak that the plan's interface note pointed at but located one frame upstream of where I expected).
**Impact on plan:** Necessary for correctness — without it the structured visualize result would leak base64 into conversation history (the precise hazard #2 the audit flagged). Single-sourced in the existing `formatToolResult` (no new code path). No scope creep.

## Issues Encountered

- The first integration-test run looped (21 personality calls): the test harness drained ALL re-enqueued events back into `handleDispatch`, including the lifecycle `sei:loop_terminal` that `terminateLoop` emits — which opened a fresh loop each time. Resolved by restricting the test's drain to re-dispatch ONLY `sei:action_complete` (mirroring the real FSM, which routes the long-runner settle but does not re-open a loop on a terminal event). This is a test-harness fidelity fix, not a product change.
- One assertion compared an unescaped string against the JSON-flattened payload (`last_action_result="..."` vs the escaped `\"..."`); corrected to match the actual (correct) escaped form. The underlying behavior was right.

## Known Stubs

None. The full VIS-02 delivery loop is wired and exercised end-to-end. The idle render path (15-07) is the documented next consumer: it will call `visualizeAction({ idle:true })` and reuse `handleVisualizeResult(loop, result, { idle:true })` — which attaches the image but deliberately does NOT arm the vision-path flag (idle stays on `/v1/messages`, D-09). That `{ idle:true }` branch is present and tested implicitly (the explicit branch arms the flag; idle is the negative).

## Threat Flags

None beyond the plan's `<threat_model>`. T-15-06-01 (image egress) — the frame is the bot-POV buffer produced upstream (15-01/15-04); this plan only moves that small buffer onto the user turn, composites nothing. T-15-06-02 (image on tool_result -> 400/drop) — mitigated: image rides a fresh user turn, asserted never on a tool/function-result across all three non-Anthropic mappers. T-15-06-03 (oversized base64) — image already downscaled + size-capped in 15-04; per-hour cap (15-02) bounds frequency. T-15-06-04 (cap bypass/grief) — the cap is server-authoritative; the one-shot flag is explicit-only + cloud-only, so BYOK/local and idle/normal turns can't route to /vision. No new trust-boundary surface.

## Next Phase Readiness

- **15-07 (idle auto-render):** call `visualizeAction({ idle:true }, bot, config)` on the P3 idle tick; honor `{ skip:true }` (drop the send) and apply the 16-block + LOS gate BEFORE calling (D-08 — idle is owner-proximity gated, explicit is not). Deliver the frame via `handleVisualizeResult(loop, result, { idle:true })` so the image attaches but the turn stays on `/v1/messages` (D-09 — idle is uncounted by the per-hour cap).
- **Open from 15-01:** the packaged live-world human-verify checkpoint for `renderPov` remains OPEN (user deferred). This plan builds against the committed 15-04 contract and uses a scripted result in tests, so it is not blocked — but the true end-to-end render-to-model round trip isn't human-confirmed until that checkpoint clears.
- Full client vitest suite green (59 files / 620 tests). `loop.js` unchanged (passthrough held). STATE.md / ROADMAP.md NOT modified (orchestrator owns those writes).

## Self-Check: PASSED

- Created files present: `src/bot/brain/orchestrator.visualize.test.js`, `src/bot/brain/loop.test.js`.
- Commits exist: `e469484` (RED), `46b9d95` (GREEN), `6e8a5b5` (Task 2), `420af48` (Task 3), `2776fab` (Task 4).
- Plan verification: messageMappers 30/30, ESM import prints `/vision/v1/messages`, loop passthrough 3/3, brain suite green, `grep type:'image'` = 1, `grep VISION_MESSAGES_PATH` = 2 (under cloudMode guard). Full suite 620/620.
- `loop.js` shows NO change (`git diff --stat src/bot/brain/loop.js` empty).

---
*Phase: 15-in-game-vision-via-prismarine-viewer*
*Completed: 2026-06-10*
