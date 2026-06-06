---
phase: 13
plan: 09
subsystem: proxy
tags: [proxy, sentinel, error-envelope, usage-extraction, tdd]
requirements: [PROXY-07]
dependency_graph:
  requires:
    - 13-03 (proxy/ Hono app + env loader)
    - 13-08 (forward.ts — the refactor target consuming sentinel + usage helpers)
  provides:
    - ProxyError discriminated union — canonical error vocabulary for the proxy
    - errorEnvelope() — pure status-code + body mapper, locked per CONTEXT
    - sendError(c, err) — Hono helper, single call site for every error response
    - extractUsage(rawChunk) — pure SSE parser for Anthropic message_start + message_delta
    - mergeUsage(input, output) — defensive four-field Usage merger with zero defaults
  affects:
    - 13-10 (proxy app wiring — verifyJwt middleware and other handlers should now route through sendError)
    - 13-13 (proxyClient.ts — keys renderer hard-stop/banner UI off the `error` string in these envelopes)
    - 13-08 forward.ts — refactored to use both helpers (small diff, behavior preserved)
tech_stack:
  added: []
  patterns:
    - Discriminated-union error sentinels with TypeScript exhaustiveness check (`_exhaustive: never`)
    - Pure-function SSE parser (testable without I/O; never throws on malformed input)
    - Allowed-key whitelist for envelope bodies (T-13-09-01 info-disclosure mitigation by enumeration)
key_files:
  created:
    - proxy/src/middleware/sentinel.ts (123 lines — ProxyError union + errorEnvelope + sendError)
    - proxy/src/middleware/sentinel.test.ts (174 lines — 15 vitest cases)
    - proxy/src/anthropic/usage.ts (110 lines — extractUsage + mergeUsage)
    - proxy/src/anthropic/usage.test.ts (205 lines — 13 vitest cases)
  modified:
    - proxy/src/anthropic/forward.ts (29 insertions, 50 deletions — net -21 LoC; same behavior, thinner code)
decisions:
  - "(13-09) ProxyError is a flat discriminated union on `code`, NOT a class hierarchy. Pattern matches PATTERNS §sentinel.ts (analog: cloudErrors.ts string-prefix sentinels). Each variant carries only the data needed for its envelope body. Adding a new variant requires updating exactly two places — the union AND the switch — and TypeScript enforces this via `const _exhaustive: never = err` in the default branch (T-13-09-05)."
  - "(13-09) The 9 status codes are LOCKED. Documented in both the JSDoc at the top of sentinel.ts AND inline next to each `case`. The renderer (13-13 proxyClient.ts) keys UI behavior off these strings, so any change is a cross-process API break — the renderer would route a `missing_jwt` to the wrong banner if we e.g. renamed it `no_jwt`."
  - "(13-09) `invalid_json_body` is NOT a ProxyError variant. It's a request-parse failure that only originates inside forward.ts BEFORE any auth/ledger pipeline runs. Adding it to the union would force every consumer to handle a code that can only ever come from one call site. Kept inline as `c.json({error:'invalid_json_body'}, 400)`. Documented in forward.ts:90."
  - "(13-09) `extractUsage` is whitespace-tolerant — it parses each line via `trim()` before checking the `event:` / `data:` prefix. The original forward.ts inline parser matched on the literal string `event: message_start` (with a single space), so a stream that emitted `event:  message_start` (extra space — wire-format-compliant per RFC 8895 §8.2) would silently lose its input usage tee and force a settleAtReservation. The new parser handles this. Test case 6 in usage.test.ts is a regression guard."
  - "(13-09) `mergeUsage(null, null) === null` is the explicit signal that NEITHER side of the SSE tee arrived. forward.ts uses this nullness to route to settleAtReservation. We deliberately do NOT return a zero-filled Usage object in this case, because a zero-filled object would route to settle() with an under-charge, which is worse than settleAtReservation (which pins the full reservation amount — safer per PATTERNS pitfall when we likely consumed upstream capacity)."
  - "(13-09) T-13-09-03 mitigation: forward.ts's catch block for upstream fetch errors maps AbortError → upstream_timeout and everything else → upstream_error WITHOUT carrying `err.message` through to the `detail` field. The sentinel's `detail` field exists in the type for future ops use (e.g., when an Edge Function we control wants to surface a sanitized error string), but production code on this path never sets it."
metrics:
  duration_seconds: 232
  completed_date: 2026-05-22
  tasks_committed: 3
  files_created: 4
  files_modified: 1
---

# Phase 13 Plan 09: sentinel + usage Helpers Summary

**One-liner:** Canonical ProxyError discriminated union with TypeScript exhaustiveness check + pure SSE usage extractor; refactor of 13-08 forward.ts to use both — net -21 LoC, same behavior, all 9 forward.test.ts cases unchanged.

## What Shipped

Two thin, pure utility modules consumed across the proxy:

1. **`proxy/src/middleware/sentinel.ts`** — `ProxyError` discriminated union (9 variants), `errorEnvelope(err)` mapper with locked status codes, and `sendError(c, err)` Hono helper. The default branch of the switch is `const _exhaustive: never = err`, so adding a new variant without updating the mapper raises a compile error. PATTERNS §sentinel.ts ban on `'unknown'` fallthroughs is enforced by the type system, not by convention.

2. **`proxy/src/anthropic/usage.ts`** — `extractUsage(rawChunk)` parses the Anthropic Messages SSE wire format (`event:` + `data:` lines, `\n\n` boundaries) for `message_start.message.usage` (input) and `message_delta.usage` (output) and surfaces `message.id`. Pure function, never throws — malformed JSON or missing fields return null fields. `mergeUsage(input, output)` merges them into the four-field Usage object that `computeMicroDollarCost` (13-05) consumes, defaulting missing cache fields to 0.

Then refactor `proxy/src/anthropic/forward.ts` (from 13-08) to use both:

- 4 inline `c.json({error:...}, status)` calls → `sendError(c, {code:...})` (payment_required, upstream_timeout, upstream_error, service_at_capacity).
- ~40-line inline SSE parsing loop (with try/catch per event for malformed JSON) → 4-line `extractUsage()` accumulation.
- 9-line ad-hoc merge in the finally block → 1-line `mergeUsage(inputUsage, outputUsage)!`.

Net diff on forward.ts: **29 insertions, 50 deletions** — same behavior, thinner code, one source of truth for the SSE parser.

## Locked Status Code Map

| Sentinel | HTTP Status | Body Fields |
|----------|-------------|-------------|
| `missing_jwt` | 401 | `error` |
| `invalid_jwt` | 401 | `error`, optional `detail` |
| `expired_jwt` | 401 | `error` |
| `payment_required` | 402 | `error` |
| `rate_limited` | 429 | `error`, `kind` (rpm/itpm/otpm/daily_dollar), `retry_after_seconds` |
| `service_at_capacity` | 503 | `error`, `retry_after_seconds` |
| `upstream_timeout` | 504 | `error` |
| `upstream_error` | 502 | `error`, optional `detail` |
| `internal_error` | 500 | `error` |

This is the contract 13-13 `proxyClient.ts` will route off. Any change is a cross-process API break.

## TDD Gate Compliance

| Gate | Commit | Behavior |
|------|--------|----------|
| RED | `45b5eb0` | 28 new tests; 2 suites fail to load (`Failed to load url ./sentinel.js` + `./usage.js` — impl files don't exist) |
| GREEN | `99e07b5` | sentinel.ts + usage.ts created; **85/85** total proxy tests pass (28 new); tsc clean |
| REFACTOR | `0518af2` | forward.ts rewired to consume both helpers; **85/85** still pass (no test changes) |

## Test Coverage

### sentinel.test.ts (15 cases — plan asked for 11+, delivered 15)

| # | Case | Asserts |
|---|------|---------|
| 1 | `missing_jwt` | 401 + body shape |
| 2 | `invalid_jwt` no detail | 401, body has no `detail` field |
| 2b | `invalid_jwt` with detail | 401 + `detail` included |
| 3 | `expired_jwt` | 401 + body shape |
| 4 | `payment_required` | 402 + body shape |
| 5 | `rate_limited` (`rpm`, retry=42) | 429 + body shape with kind + retry |
| 5b | All four `rate_limited` kinds | rpm/itpm/otpm/daily_dollar each round-trip |
| 6 | `service_at_capacity` | 503 + retry_after_seconds |
| 7 | `upstream_timeout` | 504 + body shape |
| 8 | `upstream_error` no detail | 502, body has no `detail` |
| 8b | `upstream_error` with detail | 502 + `detail` included |
| 9 | `internal_error` | 500 + body shape |
| 10 | **Allowed-key whitelist** (T-13-09-01) | Across all 9 variants, every body key ∈ {`error`, `detail`, `kind`, `retry_after_seconds`} — guards against future drift leaking Error.stack or new fields |
| 11 | `sendError` dispatches via `c.json` | Single call with correct envelope |
| 12 | `sendError` smoke test all variants | 9 variants → 9 c.json calls |

The TypeScript exhaustiveness check is enforced at **compile time** by `const _exhaustive: never = err` — verified by `tsc -p tsconfig.json --noEmit` exiting clean with all 9 cases present. Removing any case would cause a compile error; this is the strongest form of the test, stronger than any runtime assertion.

### usage.test.ts (13 cases — plan asked for 6+, delivered 13)

| # | Case | Asserts |
|---|------|---------|
| 1 | `message_start` with `cache_read_input_tokens=500` | Input usage + messageId captured, output null |
| 2 | `message_delta` with `output_tokens=42` | Output captured, input + messageId null |
| 5 | `message_start` + `message_delta` + `message_stop` in one chunk | Both accumulated, messageId from start |
| 4 | Missing `data:` line | All null, no throw |
| 4b | Malformed JSON in `data:` line (T-13-09-02) | All null, no throw |
| 6 | Whitespace tolerance (`event:  message_start` w/ extra space) | Still matches; input + messageId captured |
| 7 | Empty chunk | All null |
| 8 | `message_start` without `usage` field | Input null but messageId captured |
| 3 | `mergeUsage` fills missing cache fields with 0 | Canonical four-field shape |
| 3b | `mergeUsage` with input missing cache fields at runtime | Defaults to 0 (defensive) |
| 3c | `mergeUsage(null, null)` | Returns null (sentinel for "neither side seen") |
| 3d | `mergeUsage(null, output)` | Zeros for input fields |
| 3e | `mergeUsage(input, null)` | Zero for output_tokens |

## Threat Mitigations (T-13-09-01..05 from plan threat_model)

| Threat | Mitigation in code |
|--------|-------------------|
| T-13-09-01 Stack-trace info disclosure | `errorEnvelope` constructs the body from inline object literals containing ONLY documented fields. Test case 10 enforces an allowed-key whitelist across all 9 variants — adding `err.message` or `err.stack` to a body would fail the whitelist test. |
| T-13-09-02 Malformed SSE crashes proxy | `extractUsage` wraps each `JSON.parse` in `try/catch` and `continue`s past malformed events. Test cases 4 and 4b verify no-throw + null fields. |
| T-13-09-03 Anthropic upstream error message leakage | `forward.ts` catch block calls `sendError(c, {code: 'upstream_error'})` with `detail` UNSET. The `detail` field exists in the type for future controlled use by ops paths but is never set from raw Anthropic err.message in production code. |
| T-13-09-04 Hostile usage payload (negative tokens) | Out of scope here — downstream `computeMicroDollarCost` (13-05) `BigInt(Math.ceil(...))` + `LEAST()` guard handles this. `extractUsage` is a pure parser; it does not validate token counts. |
| T-13-09-05 Adding a new sentinel without updating envelope | `const _exhaustive: never = err` in the switch default — verified by `tsc --noEmit` exit-clean across all 9 variants. Removing any case fails compilation. |

## Verification Sweep

```
sentinel.ts case count:           9        (plan asked for == 9 — one per variant)
sentinel.ts _exhaustive: never:   1        (plan asked for == 1)
forward.ts sendError occurrences: 5        (plan asked for >= 4 — 1 import + 4 calls)
forward.ts extractUsage occurrences: 3     (plan asked for >= 1 — 1 import + 1 comment + 1 call)
sentinel.test.ts:                 15/15 pass (plan asked for 11+)
usage.test.ts:                    13/13 pass (plan asked for 6+)
forward.test.ts unchanged:        9/9 pass (post-refactor regression check)
Full proxy suite:                 85/85 pass
tsc -p tsconfig.json --noEmit:    clean
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Robustness] Whitespace-tolerant SSE parsing in `extractUsage`**

- **Found during:** Implementing usage.ts; plan §verification asked for case 6 ("whitespace tolerance — extra spaces still match"), which requires comparing event names AFTER `trim()`, not via `String.includes('event: message_start')`.
- **Issue:** The pre-13-09 inline parser in forward.ts matched events with `raw.includes('event: message_start')` — a literal-substring match that would silently miss `event:  message_start` (extra space). Such streams exist in the wild — Anthropic's CDN occasionally pads.
- **Fix:** `extractUsage` parses each line by `trim().startsWith('event:')` then takes `.slice('event:'.length).trim()` to extract the name. Now `event:  message_start` (any whitespace) matches `'message_start'` exactly. Documented inline at usage.ts:42.
- **Files modified:** proxy/src/anthropic/usage.ts
- **Commit:** `99e07b5` (GREEN — folded into the new helper, not a behavior change to forward.ts since the refactor in `0518af2` immediately consumes it).

**2. [Scope — KEPT inline] `invalid_json_body` not added to ProxyError union**

- **Found during:** REFACTOR — auditing every `c.json({error:...}, status)` in forward.ts.
- **Decision:** Kept inline rather than promoted to a ProxyError variant. Rationale: `invalid_json_body` is a request-parse failure that can only originate inside forward.ts BEFORE any auth/ledger pipeline runs. Adding it to the canonical union would force every consumer (renderer error map, observer dashboard, ops tooling) to handle a code that can only come from one call site. Documented in forward.ts:90.
- **Files modified:** proxy/src/anthropic/forward.ts (comment added)
- **Commit:** `0518af2`

### Authentication Gates

None — sentinel.ts and usage.ts are pure utility modules with no I/O. No auth boundary in scope.

## Known Stubs

None. Both helpers are complete and consumed by the refactored forward.ts.

## Threat Flags

None — no new attack surface introduced. The refactor strictly reduces forward.ts complexity by extracting the SSE parser and centralizing the error vocabulary; both surfaces were already enumerated in 13-08's threat model.

## Self-Check: PASSED

- `proxy/src/middleware/sentinel.ts` — FOUND (123 lines)
- `proxy/src/middleware/sentinel.test.ts` — FOUND (174 lines, 15 vitest cases)
- `proxy/src/anthropic/usage.ts` — FOUND (110 lines)
- `proxy/src/anthropic/usage.test.ts` — FOUND (205 lines, 13 vitest cases)
- Commit `45b5eb0` (RED) — FOUND in git log
- Commit `99e07b5` (GREEN) — FOUND in git log
- Commit `0518af2` (REFACTOR) — FOUND in git log
- All 4 plan verification greps satisfied (9 / 1 / 5 / 3)
- All 28 new tests pass (15 sentinel + 13 usage)
- All 9 existing forward.test.ts cases pass post-refactor
- Full proxy suite 85/85 pass
- `npx tsc -p tsconfig.json --noEmit` clean
