---
phase: 05-debug-log-human-readability-event-per-line-emission-with-exp
plan: 02
subsystem: bot/brain
tags: [orchestrator, anthropic, logging, cache-prefix]
requires:
  - 05-01 (anthropicClient.call accepts optional namedUserBlocks)
provides:
  - orchestrator forwards canonical pre-strip user-content array to both anthropic.call sites
affects:
  - log.js hashing of seed_diary / persona / capability blocks (real raw bytes, not the `raw:` fallback)
tech-stack:
  added: []
  patterns:
    - "Pass `loop._internal.messages` alongside `messages: loop.buildAnthropicPayload()` so the API payload stays byte-identical while the logger receives the named version."
key-files:
  created: []
  modified:
    - src/bot/brain/orchestrator.js
decisions:
  - Used direct `loop._internal.messages` (no optional chaining) at both production call sites; the seam is guaranteed by loop.js L166.
metrics:
  duration: ~2m
  completed: 2026-05-11
tasks_completed: 1
tasks_total: 1
---

# Phase 5 Plan 2: Orchestrator wire namedUserBlocks Summary

One-liner: Both `anthropic.call` sites in `src/bot/brain/orchestrator.js` now forward `loop._internal.messages` as `namedUserBlocks` so Plan 05-01's logger can hash cached blocks by raw text; the Anthropic API request body is unchanged.

## Tasks Completed

| # | Name                                                     | Commit  | Files                              |
| - | -------------------------------------------------------- | ------- | ---------------------------------- |
| 1 | Add namedUserBlocks to both anthropic.call sites         | e91c993 | src/bot/brain/orchestrator.js      |

## Edit Locations

- **Cap-close call:** `src/bot/brain/orchestrator.js` L1385–L1395 — inserted `namedUserBlocks: loop._internal.messages,` after `messages:` line.
- **callPersonality:** `src/bot/brain/orchestrator.js` L1432–L1439 — inserted `namedUserBlocks: loop._internal.messages,` after `messages:` line.

## Verification

- `node --check src/bot/brain/orchestrator.js` → exit 0
- `grep -c 'namedUserBlocks:' src/bot/brain/orchestrator.js` → 2
- `grep -c 'loop\.buildAnthropicPayload()' src/bot/brain/orchestrator.js` → 2 (API payload unchanged)
- `git diff --stat` → 1 file changed, 2 insertions(+), 0 deletions(-)

## API Payload Confirmation

The `messages:` field — the only thing forwarded into `sdk.messages.create` — still equals `loop.buildAnthropicPayload()` at both sites. `namedUserBlocks` is an out-of-band sibling consumed only by the logger (per Plan 05-01); `anthropicClient.call` does not forward it to the SDK.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- File `src/bot/brain/orchestrator.js` — FOUND
- Commit `e91c993` — FOUND in git log
