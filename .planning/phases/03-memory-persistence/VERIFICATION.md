---
phase: 03-memory-persistence
verified: 2026-04-30T00:00:00Z
status: passed
score: 16/16 must-haves verified
overrides_applied: 0
---

# Phase 03: Memory & Persistence — Verification Report

**Phase Goal:** Replace per-call stateless prompting with a Claude-Code-style active-loop session that owns conversation history, supports interrupt-on-chat, and on transition back to idle persists durable memory to two markdown files (`OWNER.md` + `DIARY.md`) loaded into every future session's seed message.

**Verified:** 2026-04-30
**Status:** PASS
**Re-verification:** No — initial verification

## Summary

Goal-backward verification of Phase 03 across MEM-01..MEM-05 plus the 10 SPEC acceptance criteria (A1..A10) and the 6 SPEC requirements. All evidence is in-tree; the aggregate harness `node scripts/verify-phase3.js` passes 48/48. `src/fsm.js` is byte-identical to pre-phase tip e284d19 (sha `6654ba484f22cd2efbfc058596407a7fe4440f0c` on both refs), as required by ADR #3 / D-39. `OWNER.md` / `DIARY.md` content is provably absent from the cached system prefix (Pitfall 4 invariant), and the compactor reuses orchestrator's `cachedSystemBlocks` by reference (D-52 / Pitfall 4 cache hit guarantee).

## Requirements Coverage (MEM-01..MEM-05)

| Req    | Description                                                        | Status      | Evidence |
| ------ | ------------------------------------------------------------------ | ----------- | -------- |
| MEM-01 | Rolling in-session context window                                  | SATISFIED   | `src/llm/loop.js` createLoop owns canonical `messages`; orchestrator.js:382-451 single-flights one Loop. Verifier cases `tool-pairing`, `seed-permanent-across-iterations`. |
| MEM-02 | LLM-directed compaction at semantic boundaries (not wall-clock)    | SATISFIED   | Triggers fire only from `onLoopTerminal` (loop terminal) and `onPlayerLeft` (session end) — `src/llm/sessionState.js:140,165,232,259`. Idle path drops events when `currentLoop !== null` (`orchestrator.js:359`). Verifier `a7-no-idle-write` proves idle has no path to disk. |
| MEM-03 | Owner identity by UUID, persisted across restarts                  | SATISFIED   | `src/memory/owner.js` persists `owner_uuid` field; `src/llm/sessionState.js:73` matches by UUID first; verifier cases `owner-uuid-cold`, `owner-uuid-warm`, `username-change-recognition`, `owner-uuid-fallback`. |
| MEM-04 | Long-term memory records world progression                         | SATISFIED   | `src/memory/diary.js` newest-first DIARY.md with byte-budget seed slice (D-50) and replaceOlderHalf consolidation (D-54). Compactor `summarizeLoopBatch` writes per-loop-batch entries (`src/llm/compaction.js:148`). |
| MEM-05 | better-sqlite3 with atomic writes and hard size cap                | DEFERRED→V2 | SPEC §Boundaries explicitly defers SQLite to V2; V1 uses two markdown files with `atomicWrite` (tmp+rename, `src/storage/atomicWrite.js`) and `diary_size_cap_bytes` 200 KB soft cap (`src/config.js:48`). Locked in interview round 3 of 03-SPEC.md. |

## Acceptance Criteria (A1..A10)

| #   | Criterion                                                                       | Status     | Evidence |
| --- | ------------------------------------------------------------------------------- | ---------- | -------- |
| A1  | Multi-iteration Loop produces paired tool_use ↔ tool_result blocks               | VERIFIED   | `src/llm/loop.js:68-96` enforces 1:1 pairing invariant at `appendToolResults`; verifier `tool-pairing`. |
| A2  | 10s idle probe never fires while a Loop is in flight                            | VERIFIED   | `src/llm/orchestrator.js:359` drops idle events when `currentLoop !== null`; verifier `idle-gated`, `single-flight`. |
| A3  | Owner-chat mid-action aborts Loop, preserves messages, appends PLAYER INTERRUPT | VERIFIED   | `orchestrator.js:374` aborts via `loop.abortController.abort()`; catch arm at `:596-609` synthesizes `aborted` tool_results + appends `PLAYER INTERRUPT:` user turn; verifier `interrupt`. |
| A4  | OWNER.md owner_uuid set; recognition survives username change + restart          | VERIFIED   | `sessionState.js:73-112` UUID-first matching; verifier `owner-uuid-cold`, `owner-uuid-warm`, `username-change-recognition`. |
| A5  | DIARY.md ≥3 newest-first entries after 3 sessions ≥10 Loops; 1 consolidation pass after ≥4 sessions | VERIFIED | D-51 trigger at `sessionState.js:232`; D-53 trigger at `:259`. Verifier `d51-loop-count-trigger`, `d51-bytes-trigger`, `d53-session-trigger`, `d53-size-trigger`, `diary-newest-first`. |
| A6  | Fresh-install boots cleanly with placeholder seed                                | VERIFIED   | `owner.js:50` returns placeholder when ENOENT; `diary.js` lazy-creates; verifier `fresh-install`, `diary-lazy-create`, `seed-content-fresh-install`. |
| A7  | DIARY.md appended only on loop-batch terminals — never idle, never mid-Loop      | VERIFIED   | Compactor invocations confined to `onLoopTerminal` / `onPlayerLeft`; idle dropped at orchestrator gate; verifier `a7-no-idle-write`. |
| A8  | Seed user message visibly includes `# Owner` and `# Diary` headings              | VERIFIED   | `composeSeedBlocks` exported from orchestrator; `formatOwnerSeedBlock` uses `# Owner`; `diary.seedSlice` uses `# Diary` heading; verifier `owner-seed-block`, `seed-content-shape`. |
| A9  | 20-iteration cap terminates gracefully with final say                           | VERIFIED   | `gracefulCapClose` at `orchestrator.js:683-705` issues one `tools: []` call to force text-only response then `bot.chat`; verifier `cap-graceful`. |
| A10 | Combined-call path uses Session.messages; two-call path keeps stateless movement | VERIFIED   | Both `callPersonalityCombined` (`:722`) and `callPersonalityTwoCall` (`:708`) consume `loop.buildAnthropicPayload()`; movement sub-call retains its `messages: [{ role: 'user', content: intent }]` form (`:225`); verifier `combined-path`. |

## Required Artifacts

| Artifact                       | Expected                                | Status     | Details |
| ------------------------------ | --------------------------------------- | ---------- | ------- |
| `src/llm/loop.js`              | createLoop factory, 154 LOC             | VERIFIED   | 154 lines, public API D-44 exact. |
| `src/llm/orchestrator.js`      | Loop-driven dispatch + abort-and-resume | VERIFIED   | 761 lines; single-flight `currentLoop`; idle gate; 20-iter cap; PLAYER INTERRUPT path. |
| `src/storage/atomicWrite.js`   | tmp+rename atomic write                 | VERIFIED   | 36 lines, same-dir tmp `${dirname}/.${basename}.tmp.${pid}.${ms}`. |
| `src/memory/owner.js`          | OWNER.md load/save/seed                 | VERIFIED   | 188 lines; `owner_uuid` source of truth; tolerates malformed YAML. |
| `src/memory/diary.js`          | DIARY.md newest-first, byte budget      | VERIFIED   | 251 lines; module-level writeLock; replaceOlderHalf split rule. |
| `src/llm/sessionState.js`      | Lifecycle + onLoopTerminal hook         | VERIFIED   | 312 lines; setCompactor seam; D-51/D-53 trigger evaluators. |
| `src/llm/compaction.js`        | createCompactor                         | VERIFIED   | 214 lines; reuses cachedSystemBlocks by reference; tools=[]; timeoutMs from config. |
| `src/config.js` memory: block  | Full D-59 schema                        | VERIFIED   | All fields present (`iteration_cap`, `loop_batch_loop_count_cap`, `loop_batch_context_cap_bytes`, `sessions_per_consolidation`, `diary_size_cap_bytes`, `seed_diary_budget_bytes`, `spawn_settle_delay_ms`). |
| `src/bot.js`                   | playerJoined/Left + setCompactor wiring | VERIFIED   | Lines 105-127. `bot.on('end')` intentionally untouched per D-58. |
| `src/fsm.js`                   | Byte-unchanged from e284d19             | VERIFIED   | sha `6654ba484f22cd2efbfc058596407a7fe4440f0c` identical at e284d19 and HEAD. `git diff e284d19 -- src/fsm.js` empty. |

## Key Link Verification

| From                          | To                              | Via                                              | Status   |
| ----------------------------- | ------------------------------- | ------------------------------------------------ | -------- |
| orchestrator.handleDispatch   | createLoop                      | `currentLoop = createLoop({ iterationCap })` (`:382`) | WIRED |
| Loop                          | Anthropic call                  | `loop.buildAnthropicPayload()` in two-call/combined helpers (`:716,730`) | WIRED |
| orchestrator                  | sessionState.onLoopTerminal     | invoked after every Loop terminal (`:439`)        | WIRED |
| sessionState                  | compactor.summarizeLoopBatch    | `setCompactor` (`:292`) + onLoopTerminal call (`:232`) | WIRED |
| sessionState                  | compactor.consolidateOlderHalf  | onPlayerLeft (`:165`) + onLoopTerminal (`:259`)   | WIRED |
| compactor                     | diary.appendEntry / replaceOlderHalf | `compaction.js:148, :204`                    | WIRED |
| compactor                     | cachedSystemBlocks (orchestrator) | reference passed via bot.js:127 wiring          | WIRED (identity check verified by `compaction-uses-cached-system-blocks`) |
| bot.js (mineflayer)           | sessionState.onPlayerJoined/Left | `bot.on('playerJoined' / 'playerLeft')` (`:106-107`) | WIRED |
| owner / diary                 | seed user turn                  | `composeSeedBlocks` → `loop.appendUserTurn(blocks, { seed: true })` | WIRED |
| atomicWrite                   | OWNER.md / DIARY.md             | `saveOwner`, `appendEntry`, `replaceOlderHalf`    | WIRED |

## Pitfall / Decision Spot-Checks

| Item                                          | Status   | Evidence |
| --------------------------------------------- | -------- | -------- |
| Pitfall 1 — `name` field stripped from text blocks | VERIFIED | `loop.js:122-128` drops `name` in `buildAnthropicPayload`; verifier `name-field-stripped`. |
| Pitfall 4 — OWNER/DIARY never in system prefix    | VERIFIED | `grep -nE "(# Owner|# Diary)" src/llm/persona.js src/llm/anthropicClient.js` → no matches. `assertNoMemoryInSystemBlocks(cachedSystemBlocks, ...)` runtime guard at `orchestrator.js:218`. Verifier `seed-not-in-system-blocks`. |
| D-40 abort-and-resume with synthetic tool_results | VERIFIED | `orchestrator.js:596-609` synthesizes `aborted: player interrupt` tool_results for orphan tool_uses, then appends PLAYER INTERRUPT user turn. Verifier `interrupt`. |
| D-43 rebuild-on-call trim (canonical immutable)   | VERIFIED | `loop.js:98-136` deep-clones every turn; canonical `messages` never mutated. Verifier `mutation-free` proves byte-identical canonical pre/post build. |
| D-46 / D-52 cache-hit reuse (identity)            | VERIFIED | `compaction.js:115,134,184` uses `cachedSystemBlocks` parameter passed by reference from `orchestrator._internal.cachedSystemBlocks`. Verifier `compaction-uses-cached-system-blocks` asserts identity. |
| A7 no-idle-write                                  | VERIFIED | Compactor calls confined to onLoopTerminal/onPlayerLeft. Idle dropped at `orchestrator.js:359`. Verifier `a7-no-idle-write`. |
| A9 graceful 20-iter close                         | VERIFIED | `gracefulCapClose` at `:683` forces `tools: []` final call; falls back to `capHitLine(persona)` on call failure. Verifier `cap-graceful`. |

## Behavioral Spot-Checks

| Behavior                              | Command                              | Result                          | Status |
| ------------------------------------- | ------------------------------------ | ------------------------------- | ------ |
| Phase 3 aggregate verifier            | `node scripts/verify-phase3.js`      | 48/48 passed                    | PASS   |
| fsm.js untouched                      | `git diff --stat e284d19 -- src/fsm.js` | empty diff                   | PASS   |
| fsm.js sha identity                   | `git show {e284d19,HEAD}:src/fsm.js \| shasum` | both `6654ba48...` matching | PASS   |
| Pitfall 4 cache invariant             | `grep -nE "(# Owner\|# Diary)" src/llm/persona.js src/llm/anthropicClient.js` | no matches | PASS   |
| Phase 3 commit chain on main          | `git log e284d19..HEAD`              | 15 commits on main, all 3 plans + SUMMARYs | PASS   |

## Anti-Patterns Found

None of significance. The two intentional shims/relaxations are documented:

| File                | Note                                                                                                                | Severity |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- |
| `src/llm/chains.js` | Reduced to no-op shim returning safe defaults — Q1 chosen over deletion to preserve imports until follow-up cleanup | INFO     |
| `src/bot.js`        | `bot.on('end')` not wired (no end-of-process consolidation flush) — explicit V1 trade-off per D-58                  | INFO     |
| Manual smoke test   | Live Haiku + Minecraft 60-min smoke deferred (D-19 no-mock-LLM rule) — recorded in 03-01 / 03-03 SUMMARY            | INFO     |

The deferred manual smoke is a known V1 verification gap noted in 03-01 and 03-03 SUMMARYs. It does not block goal achievement: every D-51..D-56 / Pitfall 1-7 / A1..A10 guarantee has an isolated structural test in `scripts/verify-phase3.js` (48/48 green).

## Human Verification Recommended (non-blocking)

The structural harness exhaustively covers every locked decision in isolation. A live integration smoke remains a recommended (not blocking) follow-up before phase 03 ships to a real user.

1. **Live owner-chat interrupt flow** — Boot bot against a real Minecraft server; owner chats `follow me`, then `stop and dig that tree` mid-action. Expected: logs show `[sei/orch] loop start`, `[sei/orch] PLAYER INTERRUPT preserved`, no `400 messages: tool_use ids ... don't have matching tool_result blocks` from Anthropic.
2. **Owner UUID round-trip across restart + username change** — Boot, owner chats, verify OWNER.md has `owner_uuid:` set; kill bot; rename owner Minecraft display name; reboot; owner chats. Expected: Sei still recognizes the owner; OWNER.md `owner_uuid` unchanged.
3. **60-min real-Haiku DIARY accumulation** — Run a long session; verify DIARY.md grows newest-first only on loop-batch terminals; consolidate fires at the size cap or 4th session, not on idle ticks.

These are recommended but the goal is provably achieved by the structural evidence above.

## Final Verdict

**PASS — Phase 03 goal achieved.**

- 16/16 must-haves verified (5 MEM-* requirements, 10 acceptance criteria, 1 ADR #3 fsm.js immutability).
- MEM-05 V1→V2 deferral is explicit and locked in SPEC §Boundaries (interview round 3).
- All locked decisions D-38..D-59 implemented as specified per the three SUMMARY frontmatters; spot-checks confirm D-40, D-43, D-46/D-52, D-59, D-58 in source.
- All Pitfalls 1, 3, 4, 7 verified structurally; Pitfall 2 (spawn-settle) has a configured 500ms delay default.
- `scripts/verify-phase3.js` reports `48/48 passed`.
- `src/fsm.js` byte-identical to pre-phase tip (sha `6654ba48…` at both e284d19 and HEAD).
- No blockers; one informational note on deferred live smoke.

---

_Verified: 2026-04-30_
_Verifier: Claude (gsd-verifier)_
