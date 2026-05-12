---
phase: 05-debug-log-human-readability-event-per-line-emission-with-exp
plan: 03
subsystem: main/logRouter
tags: [logging, ipc, multi-line, state-machine, electron-main]
requires:
  - "Plan 05-01: logger emits [ts] [tag] begin / end sentinels with indented continuation lines"
provides:
  - "Multi-line state machine in src/main/logRouter.ts that coalesces begin/end blocks into ONE LogEntry"
  - "Dropped-end recovery: appends '  [truncated]' marker on unmatched begin or close()-while-open"
  - "Per-physical-line file tee preserved (file shape unchanged)"
affects:
  - src/main/logRouter.ts
tech-stack:
  added: []
  patterns:
    - "Closure-private state-machine variables (openTag/openLines/openTimestamp/openLevel) alongside existing buffer/dropped/closed"
    - "Sentinel regex distinct from TAG_RE: begin/end suffix is the trigger; TAG_RE is reused only for the single-line passthrough classify() path"
key-files:
  created:
    - .planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-03-logrouter-multiline-state-machine-SUMMARY.md
  modified:
    - src/main/logRouter.ts
key-decisions:
  - "SENTINEL_RE is `^\\[\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\]\\s+(\\[[^\\]]+\\])\\s+(begin|end)\\s*$` — strict suffix match so continuation lines that happen to start with a `[ts] [tag]` prefix WITHOUT a begin/end suffix are not mistaken for sentinels (none are emitted by log.js but defensive)"
  - "openLevel escalates monotonically from info → warn → error across continuation lines via classify(); begin/end sentinels themselves stay info (they carry no level signal)"
  - "Orphan / mismatched end lines (end whose tag does not match the currently-open tag, or end with no open event) pass through as single-line defensive LogEntry, NOT silently dropped — preserves debuggability if log.js ever emits a malformed pair"
  - "close() handles the still-open event INLINE rather than calling finalizeOpenEvent() because finalizeOpenEvent → flush() short-circuits when closed=true; matches the plan's explicit instruction"
  - "File tee `stream.write(cleaned + '\\n')` is the FIRST side effect after cleaning the line, OUTSIDE the sentinel/openTag branches — file granularity stays per-physical-line per D-10"
requirements-completed: []
duration: "~2 min"
completed: 2026-05-12
---

# Phase 5 Plan 03: logRouter multi-line state machine Summary

Extended `src/main/logRouter.ts` from a single-line classifier into a multi-line state machine that coalesces `[ts] [tag] begin` … `[ts] [tag] end` blocks emitted by Plan 05-01's refactored `src/bot/brain/log.js` into exactly one `LogEntry` per logical event. Continuation lines accumulate into `openLines[]` and are joined by `\n` into the entry's `message` field on the matching end sentinel. Dropped-end scenarios (new `begin` arrives while another event is still open, or `close()` is called mid-event) flush the in-progress event with a `  [truncated]` marker line appended. `src/shared/ipc.ts` was not touched — `LogEntry` field shapes are unchanged; only the `message` string content can now contain embedded newlines.

- **Duration:** ~2 min
- **Tasks:** 1/1 (`feat(05-03)` multi-line state machine)
- **Files modified:** 1 (`src/main/logRouter.ts`)
- **Commit:** `39c5306`

## Regex shape

```ts
const SENTINEL_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(\[[^\]]+\])\s+(begin|end)\s*$/;
```

Distinct from the existing `TAG_RE` which only anchors the timestamp + bracketed tag. The two regexes serve different roles after this plan:

| Regex | Role | Where used |
|---|---|---|
| `SENTINEL_RE` | Detects begin/end transitions in `append()` | Multi-line state machine branch |
| `TAG_RE` | Extracts tag for the single-line passthrough path | `classify()` (unchanged) — called for stray lines, the `[log]` session header, and for continuation-line level escalation |

## close()-time truncation handling

When `close()` runs with `openTag !== null` (process shutting down mid-event), the open event is flushed inline:

```ts
if (openTag !== null) {
  openLines.push('  [truncated]');
  buffer.push({
    timestamp: openTimestamp ?? new Date().toISOString(),
    tag: openTag,
    message: openLines.join('\n'),
    level: openLevel,
  });
  openTag = null; openLines = []; openTimestamp = null; openLevel = 'info';
}
```

Then the final batch is constructed and sent inline (NOT via `flush()`, because `flush()` early-returns when `closed === true`). Stream `.end()` is awaited last as before.

## Confirmation: src/shared/ipc.ts untouched

```
$ git diff --name-only HEAD~1 HEAD
src/main/logRouter.ts
```

`src/shared/ipc.ts` is NOT in the diff. The `LogEntry` / `LogBatch` shapes are byte-identical to what Plan 04 shipped; the renderer requires no IPC contract change to consume multi-line `message` strings (it already renders `message` as text, so embedded `\n` Just Works).

## State-machine behavior matrix

| Incoming line | openTag === null | openTag !== null, same tag | openTag !== null, different tag |
|---|---|---|---|
| `[ts] [tag] begin` | Open new event | Finalize old as `[truncated]`, open new | Finalize old as `[truncated]`, open new |
| `[ts] [tag] end` | Push as orphan single-line entry | Append + finalize as `end` | Push as orphan single-line entry |
| Continuation (no sentinel match) | Push as single-line passthrough (with classify-derived tag) | Append to openLines, escalate openLevel | Append to openLines, escalate openLevel |

## Plan-level success criteria — re-verified

A standalone JS reimplementation of the state-machine surface (mirroring the committed file) was run against five scenarios:

| # | Scenario | Expected | Actual |
|---|---|---|---|
| A | begin + 2 cont + end | 1 entry, 4-line message, tag `[haiku?]` | 1 entry, 4 lines, tag `[haiku?]` — **PASS** |
| B | begin → (no end) → second begin → end | 2 entries; first ends with `[truncated]` | 2 entries; first has `[truncated]` — **PASS** |
| C | begin → close() with no end | 1 entry with `[truncated]` | **PASS** |
| D | Session header (no begin/end) | 1 single-line entry, tag `[log]` | **PASS** |
| E | Stray non-tagged stack line | 1 entry with tag `null` | **PASS** |

(See the smoke-test script output captured during task execution.)

## Acceptance criteria — all green

- `npx tsc --noEmit -p tsconfig.node.json` → exit 0, no errors (project-config typecheck; see "Deviations" below for the verify-command note).
- `grep "SENTINEL_RE" src/main/logRouter.ts | grep -v '^//' | wc -l` → **2** (declaration + use in `append`) ≥ 2 required.
- `grep -c "openTag" src/main/logRouter.ts` → **12** ≥ 6 required.
- `grep -q "openTag === tag" src/main/logRouter.ts` → **match** (the end-suffix tag-match check).
- `grep -q "finalizeOpenEvent('truncated')" src/main/logRouter.ts` → **match** (called in the begin-while-open branch).
- `stream.write(cleaned + '\n')` is present at the top of `append()` body, OUTSIDE every branch, before any `return` — file tee runs unconditionally for every physical line.
- `git diff --name-only HEAD~1 HEAD` → `src/main/logRouter.ts` only; `src/shared/ipc.ts` NOT in diff.

## Deviations from Plan

**1. [Rule 3 — Blocker] Verify command's TS module-resolution flag is incompatible with the project's tsconfig**

- **Found during:** Task 1 verification step
- **Issue:** The plan's verify command runs `tsc --module nodenext --moduleResolution nodenext` against a single file. The project's actual `tsconfig.node.json` uses `"moduleResolution": "Bundler"`, where extensionless relative imports like `import type { LogEntry, LogBatch } from '../shared/ipc'` are valid. Under `nodenext` they raise `TS2835` and demand a `.js` suffix. The errors are about pre-existing imports the plan explicitly forbade me from changing.
- **Fix:** Ran the project's own typecheck instead: `npx tsc --noEmit -p tsconfig.node.json`. Exit 0, zero errors. The intent of the verify step — confirm the file typechecks — passes against the canonical project config. Adding `.js` extensions or rewriting the imports would have been an out-of-scope change to a file shape the plan said to keep.
- **Files modified:** none (no code change; only verification command swapped to project-canonical equivalent).
- **Verification:** `npx tsc --noEmit -p tsconfig.node.json` → silent (exit 0).
- **Commit:** N/A (verification-method swap only).

**Total deviations:** 1 auto-fixed (1 Rule 3 — blocker on verify command). **Impact:** None on the deliverable; the file is committed, typechecks against project config, all greps and the functional smoke-test scenarios pass.

## Authentication Gates

None encountered — this plan is a pure code change to a main-process module with no external services.

## Issues Encountered

None.

## Next Phase Readiness

Plan 05-04 (end-to-end verification harness) can now proceed. The contract between `src/bot/brain/log.js` (multi-line emit, Plan 05-01) and `src/main/logRouter.ts` (multi-line consume, this plan) is in place. Plan 05-02 (orchestrator wires namedUserBlocks) is on a parallel wave and does not block 05-04.

Ready for `/gsd-execute-phase 05` to continue with Plan 05-04.

## Self-Check: PASSED

- `src/main/logRouter.ts` modified — **FOUND** (`git diff --name-only HEAD~1 HEAD` lists it)
- Commit `39c5306` (Task 1) — **FOUND** (`git log --oneline | grep 39c5306` matches)
- All acceptance criteria for Task 1 re-verified above with concrete commands
- Plan-level `<verification>` re-run: verify-command grep portion → `OK`; project tsc → exit 0; `git diff` shows `src/main/logRouter.ts` only, `src/shared/ipc.ts` not in diff
- Plan-level `<success_criteria>` scenarios A & B (the two specified) both pass in the smoke-test matrix above, plus three additional defensive scenarios (C/D/E) for close()-time truncation, session-header passthrough, and stray-line passthrough
