---
status: complete
phase: 15-in-game-vision-via-prismarine-viewer
source: 15-01-SUMMARY.md … 15-07-SUMMARY.md (verified against live session log, not interactively)
started: 2026-06-10T23:35:00Z
updated: 2026-06-11T00:05:00Z
---

> **Resolution (2026-06-11):** all gaps below were fixed directly in-session
> (user-directed, bypassing /gsd:execute-phase --gaps-only):
> 1. sei-proxy deployed to Fly — `POST https://api.sei.gg/vision/v1/messages`
>    now returns 401 unauth (was 404); `vision_hourly` migration 20260610120000
>    confirmed applied. VIS-07 cap is now enforceable.
> 2. `anthropicClient.js` — 404 vision-path fallback no longer consumes the
>    rescue-retry allowance; rescue retries raised to 2 for ALL calls
>    (sleeps 500ms / 1.5s, Retry-After honored, 2s cap, abortable, deadline
>    controller unchanged). Tests: anthropicClient.rescueRetry.test.js +
>    260610-chain case in anthropicClient.visionFallback.test.js.
> 3. `orchestrator.js` — VIS-02 delivery guard: frames are stashed and attached
>    by the runIterations funnel AFTER tool_result turns (fixes a latent
>    Anthropic 400: tool_result must immediately follow its tool_use — the
>    old order was [assistant(tool_use), user(image), user(tool_result)]);
>    frame turns now carry the fresh snapshot (previously a frame turn
>    stripped the snapshot entirely — visible in the live log's first prompt);
>    on loop death with an undelivered frame, the passive cadence re-arms
>    (fresh frame next turn) and last_action_result is rewritten honestly.
>    Test: "260610 delivery guard" in orchestrator.visualize.test.js.
> Suites green: sei 583/583; sei-proxy 141/141 (5 Deno edge-fn test files
> don't collect under vitest — pre-existing, unrelated).

> **Mode note:** per user direction this UAT was run by comparing live bot
> behavior against the phase requirements, using the dev session log
> `~/Library/Application Support/Sei Launcher Dev/logs/25770cd6-…-2026-06-10T23-29-48-956Z.log`
> (session 23:29–23:30 UTC, cloud-proxy mode, sparse_jungle LAN world) as the
> evidence source. Results below cite log line numbers. Criteria not exercised
> in that session are marked skipped.

## Current Test

[testing complete]

## Tests

### 1. First passive frame attaches on the first turn after join (15-07, first-join requirement)
expected: The session's first LLM turn carries a bot-POV frame; render waits out the post-join chunk stream instead of shipping a sparse frame or degrading
result: pass
evidence: Log L11-L63 — loop-1 idle prompt at 23:29:53 (~2s after join) contains the `event: rendered view attached` block, which is appended in the same user turn as the image block (orchestrator.js handleVisualizeResult), proving the image was in the payload. Call succeeded in 4952ms. No CANT_SEE, no sparse frame.

### 2. Model actually receives the passive/idle frame (VIS-02 delivery, idle path)
expected: The image content block reaches the provider request and the call succeeds
result: pass
evidence: Idle frames stay on `/v1/messages` by design (D-09) — loop-1's image-bearing call returned 200 with no vision-route detour (L65-L71). orchestrator.idleVision.test.js / orchestrator.visualize.test.js assert the image block lands on a user turn in the provider payload.

### 3. Explicit `visualize` renders a correct, full frame (VIS-01/VIS-06 + chunk-stream fix)
expected: LLM calls visualize; renderPov returns a ≤512px JPEG of the actual scene
result: pass
evidence: L208-L223 — visualize called at 23:30:24, returned an 8814-byte 256×256 JPEG in ~600ms. Frame extracted from log and inspected: full sparse-jungle scene (trees, vines, terrain to horizon) matching bot pos 4,79,-30. Not a sparse/dirt-block frame.

### 4. Model receives the explicit-visualize frame in its next turn (VIS-02 delivery, explicit path)
expected: After a successful explicit render, the post-visualize turn delivers the image content block to the model
result: issue
reported: "Render succeeded but the continuation carrying the image failed: 404 on /vision/v1/messages → fallback to /v1/messages → 502 → no retry → loop terminated → frame destroyed with loop history. Bot then answered 'thoughts on this place?' from the text snapshot while last_action_result claimed 'rendered view attached'."
severity: major

### 5. Post-visualize turn routes through the proxy vision-cap path (VIS-07/D-09)
expected: Exactly the one post-explicit-visualize cloud turn hits /vision/v1/messages so the per-hour cap counts it
result: issue
reported: "Client routing is correct (L254-L257 proves the turn targeted /vision/v1/messages), but the deployed proxy at api.sei.gg returns 404 — the route isn't live, so the hourly cap is currently unenforced and every explicit look pays a 404 detour."
severity: major

### 6. Entity-model log spam eliminated (original Dev Viewer bug)
expected: Unknown 1.17+ entity types produce one short notice per type, no stack traces, no magenta boxes
result: pass
evidence: L13-L15 — exactly three one-line `[sei/vision] no viewer model for entity "axolotl|frog|armadillo" — not rendered` notices at first render; zero `Unknown entity` stack traces in the whole session (vs dozens in the 23:05 log).

### 7. visionCapable handshake + conditional tool registration (VIS-03)
expected: vision-capability lifecycle message is true and `visualize` appears in the tool list for a VLM provider
result: pass
evidence: L7 `{"type":"vision-capability","visionCapable":true}`; L18 tool list includes `visualize`. (Non-VLM hiding not exercisable in this session — covered by registry.vision.test.js.)

### 8. Graceful degradation when chunks unready (VIS-08)
expected: "I can't see clearly right now" instead of crash/black frame
result: skipped
reason: Not exercised — chunks loaded fast enough that no degrade occurred this session. Covered by visualize.test.js (9/9) and the render-pov-smoke.mjs sparse scenario.

### 9. Idle auto-render 16-block + LOS gate (VIS-04/VIS-05)
expected: Cadence frames only within 16 blocks of owner with clear LOS
result: skipped
reason: Not observable from this log (owner was 2-30 blocks away and frames fired on the interval_turns cadence; no boundary case occurred). Needs a dedicated live test or unit coverage check.

## Summary

total: 9
passed: 5
issues: 2
pending: 0
skipped: 2
blocked: 0

## Gaps

- truth: "After a successful explicit visualize render, the model receives the frame as an image content block in its next turn"
  status: failed
  reason: "User session 23:30:25 — render ok, but the post-visualize continuation died: 404 (vision route) → 502 (fallback) → terminal; loop torn down; frame lost; bot confabulated sight from the text snapshot"
  severity: major
  test: 4
  root_cause: "Three stacked causes: (a) api.sei.gg proxy lacks /vision/v1/messages (deploy lag — route exists in local sei-proxy, needs fly deploy); (b) anthropicClient.js rescue-retry gate `attempt === 1` (line ~247) — the 404 fallback increments attempt, so the fallback request gets ZERO transient-failure retries; the 502 was retryable (Retry-After 60) but was treated as terminal; (c) orchestrator.js handleActionComplete catch (line ~1531) terminates the loop on continuation failure, destroying the just-attached image turn, while lastActionResult keeps saying 'rendered view attached'"
  artifacts:
    - path: "src/bot/brain/anthropicClient.js"
      issue: "404 vision-path fallback consumes the single rescue-retry allowance (attempt counter shared between fallback and retry)"
    - path: "src/bot/brain/orchestrator.js"
      issue: "failed post-visualize continuation drops the frame and leaves a misleading last_action_result"
  missing:
    - "anthropicClient: don't count the 404 path-fallback as a retry attempt (e.g. attempt-- before continue, or a separate fallback flag)"
    - "orchestrator: on post-visualize continuation failure, either set lastActionResult to an honest degrade string (e.g. CANT_SEE copy) or carry the undelivered frame into the next loop's first turn"
    - "infra: fly deploy sei-proxy so /vision/v1/messages exists at api.sei.gg"
  debug_session: ""

- truth: "Vision calls per hour are capped by the proxy for cloud-AI users (VIS-07)"
  status: failed
  reason: "Deployed proxy returns 404 on /vision/v1/messages — cap is unenforced; client falls back to the uncapped /v1/messages by design"
  severity: major
  test: 5
  root_cause: "sei-proxy deploy lag: the vision route shipped client-side ahead of the proxy rollout (intentional, with fallback), but the proxy deploy hasn't happened — api.sei.gg origin also threw a transient 502 at 23:30:26 (origin_bad_gateway), worth a glance at fly logs"
  artifacts: []
  missing:
    - "fly deploy of sei-proxy (separate repo — outside this codebase)"
  debug_session: ""
