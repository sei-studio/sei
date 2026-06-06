---
phase: 03-memory-persistence
plan: 02
subsystem: memory/persistence
tags: [memory, persistence, owner, diary, atomic-write, session, mineflayer]
requires:
  - Plan 3-01 (createLoop + Loop-driven orchestrator dispatch)
  - mineflayer playerJoined/playerLeft + bot.players[username].uuid
provides:
  - atomicWrite(path, contents) — same-dir tmp + rename atomic-replace helper
  - loadOwner / saveOwner / formatOwnerSeedBlock at src/memory/owner.js
  - createDiary({path, seedDiaryBudgetBytes, logger}) at src/memory/diary.js
  - createSessionState({ownerMdPath, diary, config, bot, logger}) at src/llm/sessionState.js
  - composeSeedBlocks(...) top-level export from src/llm/orchestrator.js (D-45 seed-turn loader)
  - Loop-terminal seam → sessionState.onLoopTerminal({messagesByteSize})
  - Full D-59 memory: config block (paths, caps, budgets, settle delay)
  - Plan 3-03 compaction seam reserved at orchestrator.handleDispatch try-block tail
affects:
  - src/llm/orchestrator.js (seed-loader + onLoopTerminal hook + cache-invariant assertion)
  - src/bot.js (playerJoined/playerLeft listeners + sessionState wiring; bot.on('end') untouched per D-58)
  - src/config.js (memory: block extended from iteration_cap-only to full D-59)
tech-stack:
  added: []
  patterns:
    - factory + closure-private state (owner store, diary store, sessionState)
    - atomicWrite (writeFile tmp + rename, same-dir tmp filename .name.tmp.PID.TS)
    - lazy file creation (Q4): readers never create files; only writers do
    - flat regex YAML frontmatter parser (no js-yaml dep)
    - module-level write mutex on diary (Pitfall 7 — consolidation race)
    - structural cache invariant (Pitfall 4): assertNoMemoryInSystemBlocks at construction
key-files:
  created:
    - src/storage/atomicWrite.js
    - src/memory/owner.js
    - src/memory/diary.js
    - src/llm/sessionState.js
    - scripts/verify-phase3-memory.js
    - .planning/phases/03-memory-persistence/03-02-SUMMARY.md
  modified:
    - src/config.js
    - src/bot.js
    - src/llm/orchestrator.js
decisions:
  - D-45 wired: seed_owner + seed_diary + event + snapshot on first user turn, seed:true
  - D-46/D-47 OWNER.md frontmatter shape implemented; flat-regex parser tolerates malformed/unknown
  - D-48 cold/warm/fallback all exercised in tests; UUID is source of truth post-capture
  - D-49 heading format `## YYYY-MM-DD HH:MM — <topic ≤ 6 words>` (UTC timestamps)
  - D-50 newest-first byte-budget walk; truncated marker appended when entries dropped
  - D-56/D-57/D-58 lifecycle wiring; bot.on('end') intentionally not touched (v1 trade-off)
  - D-59 full memory: schema landed; spawn_settle_delay_ms (default 500) added at planner discretion
  - Q4 resolution: lazy-create on first write only — verified by fresh-install + diary-lazy-create cases
metrics:
  duration: ~45 min
  completed: 2026-04-30
---

# Phase 3 Plan 2: Markdown Memory Layer Summary

Adds a persistent markdown memory layer (`OWNER.md`, `DIARY.md`) and wires
its content into every Loop's first user turn as `seed_owner` /
`seed_diary` blocks (D-45). Establishes the storage layer with an atomic-
write helper, owner UUID detection with username-change resilience (D-48),
session lifecycle handlers driven by mineflayer `playerJoined` /
`playerLeft` events (D-56/D-57), and reserves the per-loop-batch counter
seam that Plan 3-03 will subscribe to.

## Public APIs as shipped

### `src/storage/atomicWrite.js`
```javascript
export async function atomicWrite(path, contents)
//  tmp = `${dir}/.${name}.tmp.${pid}.${ms}`
//  writeFile(tmp, contents, 'utf8') → rename(tmp, path)
//  on rename failure: best-effort unlink(tmp); rethrow
```

### `src/memory/owner.js`
```javascript
async loadOwner(path): OwnerData
//  ENOENT → fresh placeholder (exists:false, total_sessions:0, notes:'')
//  parse: --- delimiters, flat key:value regex, tolerates malformed lines
//  body: drops `# Notes` heading if present
async saveOwner(path, data): void                  // atomic
formatOwnerSeedBlock(owner, budgetBytes): string
//  !exists → "# Owner\n(no owner recorded yet)\n"
//  truncates notes at byte boundary; frontmatter always preserved
```

### `src/memory/diary.js`
```javascript
createDiary({ path, seedDiaryBudgetBytes, logger? }): {
  readAll(),                  // newest-first DiaryEntry[] (lazy file read)
  appendEntry({topic, body, when?}),   // prepend; atomic; lazy-create
  seedSlice(),                // newest-first byte-budget walk (D-50)
  replaceOlderHalf(replacement),       // keep top max(ceil(N/2),5); atomic
  getFileSizeBytes(),
}
//  Module-level writeLock mutex — 2s poll then drop with warn (Pitfall 7).
//  Heading format: `## YYYY-MM-DD HH:MM — <topic ≤ 6 words>` UTC.
```

### `src/llm/sessionState.js`
```javascript
async createSessionState({ ownerMdPath, diary, config, bot, logger? }): {
  onPlayerJoined(player), onPlayerLeft(player), onSpawn(),
  onLoopTerminal({messagesByteSize}),       // Plan 3-03 seam
  ownerPresent(),
  currentSessionLoopBatch(): {loopCount, cumulativeBytes, sessionsSinceConsolidation},
  ownerData(): OwnerData,
  resetLoopBatchCounters(),                  // Plan 3-03 seam
  _internal: { ownerData, activeOwnerUuid, loopCount, cumulativeLoopBytes, sessionsSinceConsolidation },
}
//  spawn_settle_delay_ms default 500 (Pitfall 2). Belt-and-suspenders
//  one-shot bot.once('playerJoined') for late-arriving owner.
```

### `src/llm/orchestrator.js` (extended)
```javascript
export async function composeSeedBlocks({ sessionState, ownerStore, diary, config, eventText, snapshotText })
//  → [seed_owner, seed_diary, event, snapshot] in fixed order (D-45)
//  Used by the harness directly and internally by handleDispatch's first
//  loop.appendUserTurn(seedBlocks, { seed: true }) call.

createOrchestrator({ ..., sessionState?, ownerStore?, diary? })
//  When all three are wired: first user turn carries seed:true with the
//  seed blocks. After every Loop terminal, calls sessionState.onLoopTerminal
//  with messagesByteSize. The Plan 3-03 compaction call lands immediately
//  after that hook.
//  _internal.getCachedSystemBlocks() / getCachedCombinedSystemBlocks()
//  exposed as the harness seam for Pitfall 4 assertions.
```

## D-48 cold / warm / fallback paths exercised in tests

| Path        | Test case                       | Behavior verified |
|-------------|---------------------------------|-------------------|
| Cold        | `owner-uuid-cold`               | First encounter creates OWNER.md with `total_sessions=1`, `first_seen=now`, captured UUID |
| Warm        | `owner-uuid-warm`               | UUID-matched player joining → `total_sessions+=1`, `last_seen` updated, `first_seen` preserved |
| Username-change | `username-change-recognition` | Different username with matching UUID still recognized; new username persisted. Imposter (different UUID, original username) rejected. |
| Fallback    | `owner-uuid-fallback`           | OWNER.md exists with `owner_uuid: null` (hand-edited) → match by `config.owner_username`, capture UUID, preserve pre-existing notes |

## Hook reserved for Plan 3-03

In `src/llm/orchestrator.js`, inside `handleDispatch` after `runIterations`
returns:

```javascript
logger.info?.(`[sei/orch] loop terminal (id=${loop.id}, iterations=${loop.iterationCount})`)
if (sessionState) {
  const messagesByteSize = JSON.stringify(loop._internal.messages).length
  await sessionState.onLoopTerminal({ messagesByteSize })
}
// PHASE 3-03: compaction call lands here, after sessionState.onLoopTerminal.
```

Plan 3-03 plugs the per-loop-batch summary trigger immediately after
`sessionState.onLoopTerminal`, reading `sessionState.currentSessionLoopBatch()`
to decide whether thresholds (`loop_batch_loop_count_cap` /
`loop_batch_context_cap_bytes`) have fired, and using
`sessionState.resetLoopBatchCounters()` after a successful diary write.

## Q4 resolution: lazy-create confirmed

Verified via two harness cases:
- `fresh-install` — `loadOwner('./does-not-exist.md')` returns `exists:false` and `existsSync(path) === false` afterwards.
- `diary-lazy-create` — `createDiary({path}).seedSlice()` returns the placeholder string and `existsSync(path) === false`. Subsequent `appendEntry()` is what creates the file.

`saveOwner` and `appendEntry` / `replaceOlderHalf` go through `atomicWrite`,
whose tmp file lives in `dirname(targetPath)` (verified by the
`atomic-write` case which also greps `os\.tmpdir|tmpdir\(\)` against the
implementation).

## Observed file sizes — manual smoke session

Manual smoke session against a real Minecraft server is a developer-side
verification step (D-19 no-mock-LLM rule). The harness exercises all
file-system shapes synthetically; the plan's `<verification>` block records
the live smoke flow (fresh install → owner connects → OWNER.md appears
within ~500 ms after spawn-settle).

Synthetic file size baselines from harness fixtures:
- Empty OWNER.md (cold-path write): ~140 bytes (frontmatter only, empty notes).
- One-entry DIARY.md (heading + 200-char body): ~245 bytes.
- 20-entry DIARY.md (each ~500-byte body): ~10 KB → `seedSlice(3072)`
  packs 5 newest entries + truncated marker (verified by `diary-byte-budget`).

## Deviations from plan

### Auto-fixed during execution (Rule scope)

**1. [Rule 3 - Blocking] Test framework setup**

The plan's TDD flow demands a failing harness first. There was no harness
file at start; created `scripts/verify-phase3-memory.js` covering all 21
behavior cases at the start of Task 1, ran it to confirm RED (module-not-
found), then implemented. No deviation from plan content — just an
ordering note.

**2. [Rule 2 - Missing config field] `spawn_settle_delay_ms` added to D-59 schema**

D-59 lists the locked memory: fields. The plan's behavior text
(`spawn-settle-delay` test, plan `<action>` step 4 in Task 2) requires
reading `config.memory.spawn_settle_delay_ms ?? 500`. CONTEXT D-57 leaves
the settle-delay duration to "Claude's discretion" with a 500 ms starting
point. Added `spawn_settle_delay_ms: z.number().int().min(0).default(500)`
to the memory: schema so the field is configurable rather than hardcoded.
Documented at planner-discretion line in CONTEXT.md.

### Deferred items

None — Plan 3-03 owns the compaction call dispatch, the per-loop-batch
trigger evaluation, and the consolidation-pass async kickoff. All seams
this plan needed to expose (`onLoopTerminal`, `currentSessionLoopBatch`,
`resetLoopBatchCounters`, `replaceOlderHalf`) are in place.

## Auth gates / human checkpoints

None — fully autonomous plan, no auth gates encountered.

## Verification evidence

```
$ for c in atomic-write fresh-install owner-roundtrip owner-tolerates-malformed \
           owner-seed-block diary-lazy-create diary-newest-first \
           diary-byte-budget diary-heading-format diary-replace-older-half \
           owner-uuid-cold owner-uuid-warm username-change-recognition \
           owner-uuid-fallback spawn-settle-delay per-loop-batch-counter \
           seed-content-shape seed-content-fresh-install seed-budget-respected \
           seed-permanent-across-iterations seed-not-in-system-blocks; do
    node scripts/verify-phase3-memory.js --case=$c
  done
OK atomic-write
OK fresh-install
OK owner-roundtrip
OK owner-tolerates-malformed
OK owner-seed-block
OK diary-lazy-create
OK diary-newest-first
OK diary-byte-budget
OK diary-heading-format
OK diary-replace-older-half
OK owner-uuid-cold
OK owner-uuid-warm
OK username-change-recognition
OK owner-uuid-fallback
OK spawn-settle-delay
OK per-loop-batch-counter
OK seed-content-shape
OK seed-content-fresh-install
OK seed-budget-respected
OK seed-permanent-across-iterations
OK seed-not-in-system-blocks

$ git diff --stat 6514f41 -- src/fsm.js
(empty — fsm.js byte-unchanged per ADR #3 / D-39)

$ grep -nE "(# Owner|# Diary)" src/llm/persona.js src/llm/anthropicClient.js
(no matches — Pitfall 4 cache invariant intact)

$ grep -c "seed_owner\|seed_diary" src/llm/orchestrator.js
6   # ≥ 2 required

$ grep -n "playerJoined\|playerLeft" src/bot.js
105:          bot.on('playerJoined', (p) => sessionState.onPlayerJoined(p))
106:          bot.on('playerLeft',   (p) => sessionState.onPlayerLeft(p))

$ node scripts/verify-phase3-loop.js --case=tool-pairing && \
  node scripts/verify-phase3-loop.js --case=seed-content
OK tool-pairing
OK seed-content   # Plan 3-01 harness still green after orchestrator edits
```

## Hook reserved for Plan 3-03 (call signature)

```javascript
// in handleDispatch try-block, after sessionState.onLoopTerminal:
if (sessionState && diary && /* per-loop-batch trigger evaluator */) {
  const batch = sessionState.currentSessionLoopBatch()
  if (batch.loopCount >= config.memory.loop_batch_loop_count_cap ||
      batch.cumulativeBytes >= config.memory.loop_batch_context_cap_bytes) {
    await summarizeLoopBatch({ /* loop history slice, diary, sessionState */ })
    sessionState.resetLoopBatchCounters()
  }
}
```

The Plan 3-03 implementation lives at the comment marker
`// PHASE 3-03: compaction call lands here, after sessionState.onLoopTerminal.`
in `src/llm/orchestrator.js`.

## Threat flags

None — all Phase 3 threat-register entries (T-03-07..T-03-12) for this
plan are in `mitigate` disposition and have been addressed:

| Threat ID | Mitigation in this plan |
|-----------|--------------------------|
| T-03-07 (crash-mid-write corruption) | atomicWrite tmp+rename (kernel-atomic) |
| T-03-08 (concurrent diary writer) | module-level writeLock mutex with 2s poll → drop+warn |
| T-03-09 (OWNER/DIARY in cache prefix) | composeSeedBlocks routes them to user turn only; assertNoMemoryInSystemBlocks runtime guard |
| T-03-10 (UUID spoofing) | UUID is source of truth post-capture; username matching only on cold/fallback paths; imposter case verified by `username-change-recognition` test |
| T-03-11 (malformed YAML) | flat regex parser, ignores unknown keys, tolerates malformed lines (`owner-tolerates-malformed` test) |
| T-03-12 (path traversal) | accepted: single-user local bot trusts config.json |

No new attack surface introduced beyond the threat register — owner files
are write-only by Sei, read by Sei + LLM via seed turn.

## Commits

| Task | Type | Hash    | Subject                                                                            |
| ---- | ---- | ------- | ---------------------------------------------------------------------------------- |
| 1-3  | test | d9cac34 | add failing harness for atomicWrite, owner/diary stores, sessionState, seed loader |
| 1    | feat | 76150cb | implement atomicWrite, OWNER/DIARY stores, full memory config block                |
| 2    | feat | a30961d | sessionState lifecycle + bot.js playerJoined/Left wiring                           |
| 3    | feat | 85c5b9a | wire seed-loader and onLoopTerminal hook into orchestrator                         |

## Self-Check: PASSED

- src/storage/atomicWrite.js: FOUND
- src/memory/owner.js: FOUND
- src/memory/diary.js: FOUND
- src/llm/sessionState.js: FOUND
- scripts/verify-phase3-memory.js: FOUND
- src/config.js: MODIFIED (D-59 full block)
- src/bot.js: MODIFIED (playerJoined/Left + sessionState; bot.on('end') untouched)
- src/llm/orchestrator.js: MODIFIED (composeSeedBlocks export, seed-turn injection, onLoopTerminal hook, _internal harness seam, cache-invariant assertion)
- Commit d9cac34: FOUND
- Commit 76150cb: FOUND
- Commit a30961d: FOUND
- Commit 85c5b9a: FOUND
- All 21 harness cases pass; Plan 3-01 harness still green; fsm.js byte-unchanged
