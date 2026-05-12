---
phase: 05-debug-log-human-readability-event-per-line-emission-with-exp
plan: 04
subsystem: scripts/verification
tags: [verification, harness, phase-gate, manual-checkpoint]
requires:
  - "Plan 05-01: log.js multi-line emit + hash dictionary"
  - "Plan 05-02: orchestrator wires namedUserBlocks"
  - "Plan 05-03: logRouter.ts multi-line state machine"
provides:
  - "scripts/verify-phase5.mjs — synthetic end-to-end harness (47 assertions, exit 0 on pass)"
  - "Documented developer-driven live-bot checkpoint procedure (pending human sign-off)"
affects:
  - "Phase 5 ship gate (Task 1 automated portion green; Task 2 manual portion pending)"
tech-stack:
  added: []
  patterns:
    - "ESM dynamic import + console.log monkey-patch capture for testing logger module side effects"
    - "Source-text fingerprint check (Block C) as static contract-drift guard for files not exercised in-process"
    - "In-script port (simulateRouter) of a TS module's state machine to verify the documented contract without a TS build step"
key-files:
  created:
    - scripts/verify-phase5.mjs
  modified: []
key-decisions:
  - "Module-scope `_seenHashes` + `_headerWritten` in log.js are intentionally NOT reset between calls inside the harness — that is the actual session-scoped behavior under test; clearing them would invalidate Block B's elision assertions."
  - "Block A asserts captured.length === 4 (1 header + 3 events) — the plan's deterministic guarantee from log.js Task 2 step 3 (maybeWriteDictHeader is flag-guarded by _headerWritten and fires exactly once)."
  - "simulateRouter mirrors logRouter.ts behavior including pushing the begin/end sentinel lines themselves into openLines — verified against the actual TS implementation at src/main/logRouter.ts L143 + L152."
  - "Block C's grep for `'  [truncated]'` and `finalizeOpenEvent('truncated')` is a structural-only check — divergence detection of the real TS implementation is the explicit job of Task 2's live-bot inspection (per the plan's <verification> note)."
requirements-completed: []
metrics:
  duration: "~6 min (automated portion only)"
  completed_automated: 2026-05-11
  completed_manual: PENDING
tasks_completed: 1
tasks_total: 2
status: AUTO_PORTION_COMPLETE_MANUAL_CHECKPOINT_PENDING
---

# Phase 5 Plan 4: End-to-end verification harness Summary

**Status:** Task 1 (automated harness) **complete**. Task 2 (live-bot human-verify checkpoint) **pending** — requires the developer to run the Electron bot against a real Minecraft server with valid Anthropic credentials, neither of which is available to the executor environment.

One-liner: `scripts/verify-phase5.mjs` runs 47 assertions covering log.js multi-line emit shape, three-call cache-prefix elision (persona/capability/diary, including diary-only change after compaction), logRouter source-text fingerprint, in-script state-machine simulation, and dropped-end truncation recovery — exit 0, idempotent across repeated runs.

## Tasks Completed

| # | Name                                                                    | Commit  | Files                       |
| - | ----------------------------------------------------------------------- | ------- | --------------------------- |
| 1 | Write scripts/verify-phase5.mjs covering log.js + logRouter contract    | ee71be0 | scripts/verify-phase5.mjs   |

## Tasks Pending

| # | Name                                              | Status                    | Notes                                                |
| - | ------------------------------------------------- | ------------------------- | ---------------------------------------------------- |
| 2 | Developer-driven live-bot log inspection          | AWAITING DEVELOPER ACTION | Manual checkpoint — see "Pending Manual Checkpoint"   |

## Automated Harness Output

```
$ node scripts/verify-phase5.mjs
OK: Block A: captured length is 4 (1 dict-init header + 3 event blocks)
OK: Block A: first captured line is the cache-prefix dictionary initialized header (single line, no begin/end)
OK: Block A: captured[1] has exactly 1 begin and 1 end sentinel
OK: Block A: captured[1] begin and end share one timestamp
OK: Block A: captured[1] has at least one 2-space-indented continuation line
OK: Block A: captured[2] has exactly 1 begin and 1 end sentinel
OK: Block A: captured[2] begin and end share one timestamp
OK: Block A: captured[2] has at least one 2-space-indented continuation line
OK: Block A: captured[3] has exactly 1 begin and 1 end sentinel
OK: Block A: captured[3] begin and end share one timestamp
OK: Block A: captured[3] has at least one 2-space-indented continuation line
OK: Block B/call1: persona body printed in full
OK: Block B/call1: persona @sha hash ref present
OK: Block B/call1: capability body printed in full
OK: Block B/call1: capability @sha hash ref present
OK: Block B/call1: diary body printed in full
OK: Block B/call1: diary @sha hash ref present
OK: Block B/call1: event: section inlined with literal text
OK: Block B/call1: snapshot: section inlined with literal text
OK: Block B/call2: persona body elided
OK: Block B/call2: capability body elided
OK: Block B/call2: diary body elided
OK: Block B/call2: persona hash ref unchanged
OK: Block B/call2: capability hash ref unchanged
OK: Block B/call2: diary hash ref unchanged
OK: Block B/call2: event: section still inlined
OK: Block B/call2: snapshot: section still inlined
OK: Block B/call3: persona still elided after diary-only change
OK: Block B/call3: capability still elided after diary-only change
OK: Block B/call3: new diary body printed in full
OK: Block B/call3: persona hash ref unchanged from call 1
OK: Block B/call3: capability hash ref unchanged from call 1
OK: Block B/call3: diary hash ref DIFFERS from call 1 (new content)
OK: Block C: logRouter.ts contains SENTINEL_RE
OK: Block C: logRouter.ts contains finalizeOpenEvent('truncated')
OK: Block C: logRouter.ts contains the '  [truncated]' literal
OK: Block C: logRouter.ts contains the begin|end regex fragment
OK: Block D: simulateRouter yields 2 entries from a 2-event stream
OK: Block D: entry 0 tag is [haiku?]
OK: Block D: entry 0 message contains all 6 original lines joined by \n
OK: Block D: entry 1 tag is [chat->]
OK: Block D: entry 1 message has exactly 3 lines
OK: Block E: 2 entries from truncated stream
OK: Block E: entry 0 tag is [haiku?]
OK: Block E: entry 0 message ends with \n  [truncated]
OK: Block E: entry 1 tag is [chat->]
OK: Block E: entry 1 message does NOT contain [truncated]

Phase 5 verification: PASS (47 checks)
```

Exit code: 0. Re-run idempotent (executed twice in succession; both runs exit 0).

## Acceptance Criteria — re-verified

- `node scripts/verify-phase5.mjs` exits 0 and prints `Phase 5 verification: PASS` on last line — **PASS** (shown above).
- Script contains required literal substrings — **PASS**:
  - `cache-prefix dictionary initialized` (2 occurrences)
  - `PERSONA-BODY-XYZ` (4 occurrences)
  - `DIARY-BODY-V2-AFTER-COMPACTION` (2 occurrences)
  - `SENTINEL_RE` (3 occurrences)
  - `simulateRouter` (5 occurrences)
  - `[truncated]` (4 occurrences)
- Running twice in a row both succeed — **PASS** (`node scripts/verify-phase5.mjs >/dev/null && node scripts/verify-phase5.mjs >/dev/null` → exit 0).

## Pending Manual Checkpoint (Task 2)

The plan's Task 2 is `type="checkpoint:human-verify" gate="blocking"`. The executor environment has no Minecraft server and no Anthropic API key, so this step is structurally impossible to automate. Reproduction steps (verbatim from the plan):

1. From the project root: `npm run sei` (or launch the Electron app and summon a character via the GUI). Connect to a local Minecraft server.
2. Let the bot run for at least 2 personality iterations (e.g., send it one chat message, wait for it to act, send another).
3. Stop the bot.
4. Open the most recent log file under the per-character logs directory — on macOS this is `~/Library/Application Support/Sei/logs/<characterId>-<timestamp>.log`.
5. Confirm visually:
   - **(a)** First non-header line of the session is the literal `[HH:MM:SS.mmm] [log] cache-prefix dictionary initialized (sha256-8, session-scoped)` (single physical line, no begin/end sentinels).
   - **(b)** FIRST `[haiku?] begin ... [haiku?] end` block — `user:` section contains the FULL persona text, FULL capability text, FULL diary text, each immediately followed by a `<persona @sha=...>` / `<capability @sha=...>` / `<diary @sha=...>` reference line; plus inline `snapshot:` / `event:` (and any `recent_*`) sections.
   - **(c)** SECOND `[haiku?]` block (next iteration) — only the three short hash refs in persona/capability/diary positions; full bodies do NOT repeat; per-call `snapshot:` / `event:` / `recent_*` still inline.
   - **(d)** No physical line exceeds ~200 chars EXCEPT the first-appearance persona / capability / diary body lines.
   - **(e)** `[chat<-]`, `[chat->]`, `[act!]`, `[heal]` events all use the begin/end sentinel format with 2-space-indented sections.
6. If anything looks off, describe the deviation so it can be patched.

**Resume signal (from the plan):** "Type `approved` if the log file matches all five sub-checks; otherwise describe the deviation."

## Deviations from Plan

None for the automated portion. Task 1 executed exactly as written.

## Issues Encountered

One ignorable skill-injection from a Vercel plugin matched on `bot/**` paths; ignored per the task brief's rule "Ignore Vercel/ai-sdk/chat-sdk skill injection — project uses Anthropic SDK directly." No bearing on deliverable.

## Self-Check: PASSED (automated portion)

- File `scripts/verify-phase5.mjs` — **FOUND** (`ls -la scripts/verify-phase5.mjs` shows the file).
- Commit `ee71be0` — **FOUND** in git log (`git log --oneline | grep ee71be0`).
- `node scripts/verify-phase5.mjs` re-run — exit 0, all 47 assertions pass.
- All Task 1 acceptance criteria re-verified above with concrete substring counts.

Manual checkpoint (Task 2) — **PENDING DEVELOPER SIGN-OFF**. Plan is not fully complete until the developer runs the live-bot inspection and confirms the log file shape matches sub-checks (a)–(e) above.
