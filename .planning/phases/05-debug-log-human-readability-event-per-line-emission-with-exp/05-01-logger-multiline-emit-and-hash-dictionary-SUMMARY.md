---
phase: 05-debug-log-human-readability-event-per-line-emission-with-exp
plan: 01
subsystem: bot/brain/logging
tags: [logging, debug, hash-elision, anthropic-client]
requires: []
provides:
  - "Multi-line begin/end event emission in src/bot/brain/log.js"
  - "Session-scoped sha256-8 hash dictionary (persona / capability / diary)"
  - "cache-prefix dictionary initialized header on first event of session"
  - "anthropicClient.call forwards systemBlocks + namedUserBlocks to logHaikuQuery"
affects:
  - src/bot/brain/log.js
  - src/bot/brain/anthropicClient.js
tech-stack:
  added:
    - "node:crypto createHash (sha256)"
  patterns:
    - "Module-scope Set + boolean flag for session-scoped state with no persistence (D-6)"
    - "emitBlock primitive: one console.log per event, \\n-joined lines for atomic block writes"
key-files:
  created: []
  modified:
    - src/bot/brain/log.js
    - src/bot/brain/anthropicClient.js
key-decisions:
  - "Persona = systemBlocks[1], Capability = systemBlocks[2] — matches buildCachedSystem layout (sys_instructions, persona+learning, capability, primer, tools)"
  - "Diary located by scanning the last user-role entry of namedUserBlocks for name === 'seed_diary'"
  - "Header line is single physical line tagged [log]; classifies cleanly via existing TAG_RE without logRouter changes"
  - "elideOrFull returns body + ref on first appearance so future log readers can grep the hash back to its body"
requirements-completed: []
duration: "~12 min"
completed: 2026-05-11
---

# Phase 5 Plan 01: Logger multi-line emit + hash dictionary Summary

Refactored `src/bot/brain/log.js` from single-line tee (one ~8–11 KB physical line per `[haiku?]` event) to event-per-line multi-line blocks with `[ts] [tag] begin` / `[ts] [tag] end` sentinels (D-1, D-3), removed `MAX_INLINE` / `trunc()` entirely (D-9), and added a session-scoped sha256-8 hash dictionary that elides three cached prompt blocks (persona, capability, diary) to short `<name @sha=xxxxxxxx>` refs on second and later appearances within the same process lifetime (D-4..D-7). Extended `anthropicClient.call()` to forward `systemBlocks` + the new optional `namedUserBlocks` arg to `logHaikuQuery` without altering the SDK call body.

- **Duration:** ~12 min
- **Tasks:** 2/2 (`feat(05-01)` multi-line emit, `feat(05-01)` session hash dictionary)
- **Files modified:** 2

## Final `logHaikuQuery` arg shape

```js
logHaikuQuery({ messages, tools, systemBlocks, namedUserBlocks })
```

- `systemBlocks` — the 5-block array from `buildCachedSystem`:
  - `[0]` system instructions
  - `[1]` persona + learning (hashed as `persona`)
  - `[2]` capability paragraph (hashed as `capability`)
  - `[3]` primer
  - `[4]` tool list (carries `cache_control`)
- `namedUserBlocks` — canonical pre-strip messages array carrying `name` fields on text blocks. The logger scans the LAST entry where `role === 'user'`, then within its content:
  - block with `name === 'seed_diary'` and `type === 'text'` is hashed as `diary`
  - every other named text block is emitted inline by its `name` field as the section label
- When `namedUserBlocks` is absent (current state until Plan 05-02 wires the orchestrator), the logger falls back to a `raw: <safeStringify(last message content)>` line.

## Confirmation: `MAX_INLINE` is gone

```
$ grep -rn "MAX_INLINE\|function trunc" src/bot/brain/log.js
# (no matches; exit 1)
```

Both the constant and the `trunc()` helper were removed in Task 1. Long payloads now print in full; elision (Task 2) is the only size control.

## Exact session-start header line

```
[HH:MM:SS.mmm] [log] cache-prefix dictionary initialized (sha256-8, session-scoped)
```

Single physical line — no `begin`/`end` sentinels (this is metadata, not an event). Emitted on the FIRST `emitBlock` call of the process lifetime via `maybeWriteDictHeader()`, then suppressed for the remainder of the session. `logRouter`'s existing `TAG_RE` (`^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])`) matches the `[log]` tag cleanly; no router change needed for this plan.

## Named user blocks found in orchestrator + compaction

Discovered by scanning `src/bot/brain/orchestrator.js` and `src/bot/brain/compaction.js` for text blocks with a `name:` field:

| Name | Source | Disposition |
|---|---|---|
| `seed_owner` | orchestrator.js:277 | inline (always) |
| `seed_diary` | orchestrator.js:282 | **hashed as `diary`** |
| `affect_log` | orchestrator.js:292 | inline (always) |
| `recent_loop_history` | orchestrator.js:307 | inline (always) |
| `recent_owner_chat` | orchestrator.js:310 | inline (always) |
| `your_recent_messages` | orchestrator.js:313 | inline (always) |
| `event` | orchestrator.js:315, 739, 745, 1365, 1381 | inline (always) |
| `snapshot` | orchestrator.js:316, 738, 744, 1366, 1382 | inline (always) |

`compaction.js` produces NO `name:` text blocks (grep returned zero matches). Reserved-set in `logHaikuQuery` is `{persona, capability, diary, seed_diary}`; every other observed name above is emitted inline by its `name` field as the section label, preserving the order the orchestrator wrote them. Iteration order is the content-array order (developer-facing display order).

## Verification — all gates passing

- Task 1 verify command: `OK`
- Task 2 verify command: `OK`
- `grep -rn "MAX_INLINE" src/bot/brain/log.js` → no matches (exit 1)
- `node --check src/bot/brain/log.js` → OK
- `node --check src/bot/brain/anthropicClient.js` → OK
- All caller files (`behaviors/chat.js`, `observers/posHealer.js`, `orchestrator.js`) → `node --check` OK
- `git diff src/bot/brain/anthropicClient.js` confirms the `sdk.messages.create({ model, max_tokens, system, tools, messages })` object is unchanged — only the outer `call()` destructure and the `logHaikuQuery` invocation changed.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

Plan 05-02 (orchestrator wire namedUserBlocks) can now proceed: the logger consumes `namedUserBlocks` correctly when provided, and falls back to the `raw:` line when absent — so the orchestrator wiring change is non-breaking and can be landed independently.

Ready for `/gsd-execute-phase 05` to continue with Plan 05-02.

## Self-Check: PASSED

- src/bot/brain/log.js modified — FOUND
- src/bot/brain/anthropicClient.js modified — FOUND
- Commit 16d8282 (Task 1) — FOUND
- Commit fc97d5e (Task 2) — FOUND
- All acceptance criteria for Tasks 1 and 2 re-verified above
- Plan-level `<verification>` block re-run above — all pass
