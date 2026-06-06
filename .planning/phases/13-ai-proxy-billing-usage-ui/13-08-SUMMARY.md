---
phase: 13
plan: 08
subsystem: proxy
tags: [proxy, anthropic, sse, streaming, x-sei-remaining-pct, tdd]
requirements: [PROXY-07, PROXY-10]
dependency_graph:
  requires:
    - 13-03 (proxy/ skeleton — Hono app + env loader + 501 stub on POST /v1/messages)
    - 13-05 (preDeduct + pricing types — depended on as TYPE-only imports; DI bag wires runtime)
  provides:
    - forwardToAnthropic — proxy's /v1/messages handler core
    - ForwardDeps DI bag — typed contract Wave 2 Plan 13-10 wires into Hono route
  affects:
    - 13-10 (proxy app wiring — drops forwardToAnthropic into the POST /v1/messages route with production deps)
    - 13-PATTERNS (Pitfall 1 — header pre-stream invariant now load-bearing across the proxy)
tech_stack:
  added:
    - hono/streaming streamSSE (verbatim SSE pass-through)
  patterns:
    - DI bag for testability (preDeduct / settle / settleAsRefunded / settleAtReservation / remainingPct / estimateInputTokens / fetchImpl / anthropicApiKey)
    - Raw-body verbatim forwarding (c.req.text() once → fetch body as-is)
    - Pre-stream header injection (c.header before streamSSE opens)
    - Single AbortController fan-out (client disconnect + 120s wall-clock timer)
    - Usage tee from message_start (input + cache) + message_delta (output)
    - Finally-block settle (settleAtReservation as safer default on missing message_delta)
key_files:
  created:
    - proxy/src/anthropic/forward.ts (270 lines — forwardToAnthropic + ForwardDeps)
    - proxy/src/anthropic/forward.test.ts (324 lines — 9 vitest cases)
  modified: []
decisions:
  - "(13-08) forward.ts uses raw fetch (NOT @anthropic-ai/sdk) so the SDK never reparses the SSE stream. Verbatim byte pass-through is part of the prompt-cache invariant (T-13-08-07). The SDK would also drop SSE bytes through its own parser, making the message_start usage tee fragile."
  - "(13-08) Body forwarded VERBATIM as raw bytes via c.req.text() once; JSON.parse(rawBody) ONLY for local-only peeks at model/max_tokens/stream. Never re-stringify and never forward the parsed object — preserves Anthropic prompt-cache markers (cache_control + key order + whitespace) byte-for-byte across all Sei users (T-13-08-07). 400 invalid_json_body path added for malformed bodies (no preDeduct, no fetch — fast-fail before any state mutation)."
  - "(13-08) X-Sei-Remaining-Pct header set via c.header() BEFORE the streamSSE() helper is invoked. Hono commits response headers on the first stream.write(); any header set after that point fails silently (RESEARCH Pitfall 1). Header value is computed from POST-reservation remainingPct — i.e. what the user has left if the upstream call uses 100% of the reservation."
  - "(13-08) Anthropic 429 → settleAsRefunded(reservationId) + 503 { error:'service_at_capacity', retry_after_seconds:30 } (D-44). Proxy NEVER propagates the 429 to client; surfaces it as graceful backpressure instead. Reservation is fully refunded (no upstream capacity consumed)."
  - "(13-08) Streaming usage merge: tee message_start.message.usage → inputUsage and message_delta.usage → outputUsage in the SSE loop; on stream close, settle() called with the merged Usage in the finally block. If EITHER side is missing → settleAtReservation (safer default per PATTERNS pitfall — likely DID consume upstream capacity, no refund). messageId captured from message_start.message.id and passed through to settle()."
  - "(13-08) Single AbortController fans out two concerns: (a) c.req.raw.signal abort propagation (client disconnect → free Anthropic capacity), (b) 120s setTimeout wall-clock timer (CLAUDE.md every-external-call invariant + T-13-08-03 DoS mitigation). Either trigger aborts the upstream fetch; the catch maps to 504 upstream_timeout for AbortError name match, 502 upstream_error otherwise."
  - "(13-08) Type-only stubs at proxy/src/anthropic/pricing.ts (Usage) and proxy/src/ledger/preDeduct.ts (PreDeductResult tagged union) authored in this plan as Rule-3 unblocking shells. Sibling 13-05/13-06 agents have since expanded both files with computeMicroDollarCost + estimateReservationMicro + the preDeduct runtime implementation — the Usage and PreDeductResult exports remained bit-identical so forward.ts binds without change."
metrics:
  duration_seconds: 253
  completed_date: 2026-05-22
  tasks_committed: 2
  files_created: 2
  files_modified: 0
---

# Phase 13 Plan 08: forwardToAnthropic SSE Pass-Through Summary

**One-liner:** Raw-fetch Anthropic Messages pass-through with DI-bag ledger gating, pre-stream X-Sei-Remaining-Pct injection, verbatim body forwarding (cache_control preserving), and finally-block usage settle from teed message_start + message_delta events.

## What Shipped

`proxy/src/anthropic/forward.ts` exports `forwardToAnthropic(c, deps)` — the proxy's `POST /v1/messages` handler core. Deps are a fully injected bag (`preDeduct`, `settle`, `settleAsRefunded`, `settleAtReservation`, `remainingPct`, `estimateInputTokens`, `fetchImpl`, `anthropicApiKey`) so the unit test runs without Supabase or Anthropic. Wave 2 Plan 13-10 will wire the production deps and drop the function into the Hono route (replacing the existing 501 stub at `proxy/src/app.ts:9-11`).

### 8-step flow (RESEARCH §Pattern 3)

1. **Read raw body** via `c.req.text()` ONCE — preserved as the upstream payload verbatim.
2. **Parse a local copy** of the body for header peeks (`model`, `max_tokens`, `stream`) — never re-stringified, never forwarded.
3. **Estimate input tokens** + **call preDeduct** — atomic FOR UPDATE row-lock in 13-01 RPC; insufficient → 402 payment_required.
4. **Compute X-Sei-Remaining-Pct** from POST-reservation `remainingPct(userId)`.
5. **Upstream fetch** to `https://api.anthropic.com/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01` + `content-type: application/json` + raw body (verbatim) + single AbortController signal.
6. **Translate Anthropic 429 → 503 service_at_capacity** (D-44); fully refund via `settleAsRefunded`.
7. **Set `c.header('X-Sei-Remaining-Pct', String(pct))`** — BEFORE streamSSE opens (RESEARCH Pitfall 1).
8. **Branch on `parsed.stream`**:
   - Non-streaming: await `upstream.json()`, settle with parsed `usage` (or settleAtReservation if absent), pass through `respJson` + `upstream.status`.
   - Streaming: open `streamSSE`, loop on `upstream.body.getReader()`, parse SSE events on `\n\n` boundaries, tee `message_start.message.usage` → inputUsage and `message_delta.usage` → outputUsage, forward raw bytes via `stream.write(raw + '\n\n')`. In the finally block: settle with merged usage if both teed, settleAtReservation otherwise.

### Why DI bag

The plan classifies as `type: tdd` with depends_on `[13-03, 13-05]`. At execution time, 13-05's runtime `preDeduct` had just landed as untracked work from a sibling agent, but the unit test must run without a real Supabase or real Anthropic. The DI bag is the seam — production deps wire in at 13-10, tests inject `vi.fn()` factories. The bag also doubles as the trust-boundary contract: 13-10 cannot wire forwardToAnthropic without supplying every entry, so a refactor that introduces a new ledger primitive must update both 13-10's wiring AND the bag's type signature.

## TDD Gate Compliance

| Gate    | Commit    | Behavior                                                                                |
| ------- | --------- | --------------------------------------------------------------------------------------- |
| RED     | `d4f3822` | 9 failing tests — `forward.js` doesn't exist; vitest reports "Failed to load url"      |
| GREEN   | `00e4f68` | forward.ts implements forwardToAnthropic; 9/9 forward.test.ts + 47/47 proxy suite pass |
| REFACTOR | (none)   | No refactor commit needed — GREEN was already at the plan-spec implementation shape   |

## Test Coverage (9 cases — plan §verification asked for 8+, delivered 9)

| # | Case                                              | Asserts                                                                  |
| - | ------------------------------------------------- | ------------------------------------------------------------------------ |
| 1 | insufficient balance                              | 402 payment_required, no fetch, no header                                |
| 2 | Anthropic 429                                     | 503 service_at_capacity + retry_after_seconds=30 + settleAsRefunded      |
| 3 | non-streaming 200                                 | JSON pass-through + X-Sei-Remaining-Pct + settle with usage              |
| 4 | streaming 200                                     | Header pre-stream + verbatim SSE bytes + merged message_start+_delta usage |
| 5 | streaming with no message_delta                  | settleAtReservation (safer default), settle NOT called                   |
| 6 | upstream AbortError                               | 504 upstream_timeout + settleAsRefunded                                  |
| 7 | anthropic-version pin                             | Headers contain `anthropic-version: 2023-06-01` + `x-api-key`            |
| 8 | raw body verbatim                                 | fetchImpl receives the EXACT raw bytes (preserves cache_control key order) |
| 9 | malformed JSON                                    | 400 invalid_json_body, no preDeduct, no fetch                            |

## Threat Mitigations (T-13-08-01..07 from plan threat_model)

| Threat                                | Mitigation in code                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| T-13-08-01 x-api-key disclosure       | Pulled from `deps.anthropicApiKey` (env-sourced in production); never logged          |
| T-13-08-03 long-running stream DoS    | `setTimeout(...UPSTREAM_TIMEOUT_MS)` 120s wall-clock + Fly.io concurrency caps        |
| T-13-08-04 stream-interrupted credit pin | `settleAtReservation` in the finally block — credits never pinned                 |
| T-13-08-05 detailed error leakage     | All errors mapped to enumerated sentinels (payment_required / service_at_capacity / upstream_timeout / upstream_error / invalid_json_body) |
| T-13-08-07 cache_control marker stripping | Raw body forwarded verbatim — `c.req.text()` once, never re-stringified           |

## Verification Sweep

```
anthropic-version 2023-06-01 count: 1        (plan asked for == 1)
wall-clock timeout count:        1            (plan asked for >= 1)
c.header X-Sei-Remaining-Pct:    1            (plan asked for >= 1)
service_at_capacity count:       3            (plan asked for >= 1)
TDD git history present:         YES (test → feat → ...)
forward.test.ts result:          9/9 pass
Full proxy suite result:         47/47 pass
tsc -p tsconfig.json --noEmit:   clean
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Created type-only stub modules for not-yet-landed deps**

- **Found during:** Pre-RED — plan imports `type { PreDeductResult }` from `../ledger/preDeduct.js` and `type { Usage }` from `./pricing.js`; neither module existed when 13-08 started executing (13-05/13-06 were in flight from sibling agents).
- **Fix:** Authored minimal type-only shells at `proxy/src/anthropic/pricing.ts` (`type Usage`) and `proxy/src/ledger/preDeduct.ts` (`type PreDeductResult` = `PreDeductOk | PreDeductInsufficient`). Sibling agents subsequently expanded both files with runtime implementations (`computeMicroDollarCost`, `estimateReservationMicro`, the runtime `preDeduct`). The `Usage` and `PreDeductResult` exports stayed bit-identical across the expansion, so `forward.ts` binds without changes.
- **Files modified:** `proxy/src/anthropic/pricing.ts`, `proxy/src/ledger/preDeduct.ts` (later expanded by 13-05/13-06 commits — not part of this plan's commits)

**2. [Rule 3 — Verification grep] Reformatted setTimeout to single-line for the plan's regex**

- **Found during:** Post-GREEN verification sweep
- **Issue:** Plan verification regex `setTimeout\(.*UPSTREAM_TIMEOUT_MS` requires a single-line match. My initial implementation split the call across multiple lines for readability (`setTimeout(\n  () => upstreamController.abort(),\n  UPSTREAM_TIMEOUT_MS,\n)`).
- **Fix:** Collapsed to a single line `const timeoutId = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);`. No behavior change; tests + tsc still clean. Plan grep now matches.
- **Files modified:** `proxy/src/anthropic/forward.ts`
- **Commit:** Folded into the GREEN commit `00e4f68` before publishing

### Authentication Gates

None — proxy module is downstream of verifyJwt (13-04). The DI bag receives the verified `userId` via `c.var.userId`, and tests set it explicitly in the route handler.

## Known Stubs

None. forward.ts is functionally complete and ready for Wave 2 Plan 13-10 to wire production deps into the Hono route.

## Self-Check: PASSED

- `proxy/src/anthropic/forward.ts` — exists (270 lines)
- `proxy/src/anthropic/forward.test.ts` — exists (324 lines, 9 vitest cases)
- Commit `d4f3822` (RED) — exists in `git log --all`
- Commit `00e4f68` (GREEN) — exists in `git log --all`
- All 4 plan verification greps satisfied
- All 9 forward.test.ts cases pass
- Full proxy suite 47/47 pass
- `npx tsc -p tsconfig.json --noEmit` clean
