---
quick_id: 260513-wc4
status: complete
date: 2026-05-13
title: Small fixes — session idempotency, no-default-follow, thinking off
---

# 260513-wc4 — Small fixes

Four surgical edits identified from in-game log analysis (cactus run, jungle-wood
chat). Done in-context rather than via planner+executor — the edits were
single-line/known-location and would have been overhead-heavy in agent form.

A separate batch of 5 in-flight commits (text-as-chat refactor, follow rewrite,
pathfind orphan-timeout fix, dig/build description polish, log elision, GUI
console rebrand) landed first as `25fda20..e29a2bd`. The four fixes below
sit on top of those at `3f45d7d`.

## Changes

| # | File | Edit |
|---|------|------|
| 1 | `src/bot/brain/sessionState.js:219` | Guard `onPlayerJoined` against double-fire when `player.uuid === activeOwnerUuid`. Stops `session_count` going 1→2 in one connect (the "second time meeting" bug after memory wipe). |
| 2 | `src/bot/adapter/minecraft/behaviors/follow.js:42-48` | Remove auto `setFollowTarget(owner)` in `startFollow`. The body no longer drifts toward the owner between LLM-issued movements. |
| 3 | `src/bot/brain/orchestrator.js:110` + `src/bot/adapter/minecraft/index.js:27` | Drop "Default-on at spawn" from the `follow` tool description. Add a soft note to call `unfollow` before tasks that require moving away. |
| 4 | `src/bot/config.js:50-55` | Flip `thinking_budget_tokens` default from `1024` to `0`. Text blocks are the chat channel now (post-refactor `25fda20`), so thinking adds latency without changing said output. |

## Commit

- `3f45d7d` — fix(brain): four small fixes — session idempotency, no-default-follow, thinking off

## Verification

- All four touched modules import cleanly (`node -e "import('./...')"`).
- `ConfigSchema.shape.anthropic.shape.thinking_budget_tokens.parse(undefined) === 0`.
- No remaining src/ references to removed symbols (`setInflightProvider`, `say` tool, `Default-on at spawn`).
- Pending: live in-game verification — confirm (a) no "second time meeting" line after a fresh memory wipe, (b) bot stays put between gather batches instead of drifting toward player, (c) lower per-call latency with thinking off.

## Out of scope (deferred to 260513-was-...)

- The orchestrator/FSM rework (background actions, P2 completion event, signal
  threading through long-running behaviors, in-loop preemption semantics) is
  the larger architectural change being planned via `/gsd-quick --discuss --validate`.
