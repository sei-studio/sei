---
phase: 06
plan: 03
subsystem: scavenging
tags: [minecraft, mineflayer, behavior, scavenging]
requirements: [D-NEW-SCAV-3]
dependency_graph:
  requires: [06-02]
  provides:
    - mineVeinAction
    - MINE_VEIN_DESCRIPTION
  affects:
    - registry.js (06-04 will register mine_vein)
    - orchestrator.js ACTION_DESCRIPTIONS (06-04 will mirror description)
tech_stack:
  added: []
  patterns:
    - dependency-injection-via-optional-4th-arg
    - colocated-description-export-drift-discipline
    - deterministic-result-string-contract
key_files:
  created:
    - src/bot/adapter/minecraft/behaviors/mineVein.js
    - scripts/test-mineVein.mjs
  modified: []
decisions:
  - "mineVeinAction takes optional _deps={goTo, digAction} 4th arg defaulting to real imports — keeps registry call site (args, bot, config) untouched while making inner loop unit-testable without ESM loader hooks"
  - "Each iteration pre-pathfinds via goTo(bot,x,y,z,3,timeoutMs) before delegating to digAction (Pitfall 2: dig.js does not pathfind into reach, returns 'out of range' at >4.5m)"
  - "Outer loop checks config.signal between every iteration AND between goTo and digAction within an iteration — abort latency capped at one pathfind+dig"
  - "Anchor-at-air guarded by explicit air/cave_air/void_air name check (Pitfall 5: bot-position coords resolve to feet-air)"
  - "Failed individual digs (out-of-range/timeout/target-changed) are marked done and skipped silently; only aggregated K<N surfaces the partial failure in the terminal result string"
metrics:
  duration_minutes: 5
  completed_date: 2026-05-12
---

# Phase 6 Plan 03: mine_vein behavior — Summary

`mine_vein` action handler — resolves a loose-term/exact-ID name or raw `(x,y,z)` to an anchor, flood-fills the connected vein (6-neighbor, same-name, cap 64), pre-pathfinds + digs each member in closest-first order, returns a single deterministic terminal string. Decouples find-from-dig (D-NEW-SCAV-3) and amortizes a multi-block vein into ONE LLM iteration.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Implement `mineVeinAction` + `MINE_VEIN_DESCRIPTION` | 1e28d53 | `src/bot/adapter/minecraft/behaviors/mineVein.js` |
| 2 | Unit test (7 cases) | b7a825a | `scripts/test-mineVein.mjs` |

## Verification

- `node -e "import('./src/bot/adapter/minecraft/behaviors/mineVein.js')..."` — exports `mineVeinAction` (function) and `MINE_VEIN_DESCRIPTION` (string mentioning "mine_vein" / "vein"). PASS.
- `node scripts/test-mineVein.mjs` — exit 0, all 7 PASS lines (A single-block, B 5-block row closest-first, C pre-aborted, D mid-vein abort partial progress, E no-match name, F anchor-at-air, G 125-block stone cube vein-cap saturation).
- `grep -c "config?.signal\|signal?.aborted" src/bot/adapter/minecraft/behaviors/mineVein.js` → 4 (≥2 required).
- `grep -cE "VEIN_CAP|veinCap|\b64\b" src/bot/adapter/minecraft/behaviors/mineVein.js` → 7 (≥1 required).
- Imports verified: `resolveTerm`, `goTo as realGoTo`, `digAction as realDigAction`.

## Key Decisions

### `_deps` DI hook over ESM module mocking
Plan-recommended Approach (a). `mineVeinAction(args, bot, config, _deps)` — fourth arg defaults to real `goTo`/`digAction` imports so the registry call site `registry.register('mine_vein', schema, mineVeinAction)` is byte-identical to other handlers; tests pass `_deps={goTo, digAction}` stubs to record calls and drive abort timing. Zero runtime cost (default-fall-through).

### Closest-remaining-first scheduling, recomputed each iteration
Inner loop recomputes the closest unmined position from `bot.entity?.position` every iteration (not pre-sorted). Bot moves between digs, so the next-closest changes. Mirrors RESEARCH.md L336-345 sketch.

### Defensive air check at anchor in addition to `!seedBlk`
The stub `blockAt` in tests returns `{name:'air'}` for unset coords (mirroring mineflayer's empty-chunk behavior more loosely), but real `bot.blockAt` returns `null` for unloaded chunks and `{name:'air'}` for loaded air. Plan listed only `if (!seedBlk) return 'no block at anchor'`; expanded to also reject `air|cave_air|void_air` (Pitfall 5 — bot-position coords resolve to feet-air rather than null).

### Failed-dig silent skip
`digAction` can return non-`dug` strings (`out of range`, `target changed`, `timeout digging`, `cannot break`, `stale target`). Plan spec said "mark done, continue." Implemented exactly that — only `'aborted'` surfaces as a terminal short-circuit; other failures count against N silently. Aggregate K/N in the terminal string is the LLM's signal that something didn't go cleanly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Robustness] Anchor air-name check beyond `!seedBlk`**

- **Found during:** Test F authoring
- **Issue:** Plan spec said `if (!seedBlk) return 'no block at anchor'`. Real `bot.blockAt` over a loaded chunk returns `{name:'air'}` (not null) for empty cells, so the original guard would proceed to flood-fill an air-rooted vein.
- **Fix:** Added explicit `seedBlk.name === 'air' || 'cave_air' || 'void_air'` rejection. Matches dig.js L60 precedent (`no block at ${x,y,z} (target was ${blockName})`).
- **Files modified:** `src/bot/adapter/minecraft/behaviors/mineVein.js`
- **Commit:** 1e28d53

**2. [Rule 2 - Robustness] Extra signal check between goTo and digAction**

- **Found during:** Implementation review
- **Issue:** Plan spec checks `signal?.aborted` once per loop iteration, BEFORE goTo. A long pathfind (up to `timeoutMs=12000`) could complete before the next abort check, swinging one extra block after the owner-chat preempt.
- **Fix:** Added second `signal?.aborted` check immediately after `await goTo(...)` and before `digAction(...)`. Caps abort latency at one dig + the goTo timeout.
- **Files modified:** `src/bot/adapter/minecraft/behaviors/mineVein.js`
- **Commit:** 1e28d53

## Threat Mitigations (from PLAN threat_model)

| Threat | Disposition | How Mitigated |
|--------|-------------|---------------|
| T-06-06 — unbounded flood-fill | mitigate | `VEIN_CAP=64` ceiling; `(vein-cap reached)` annotation surfaces to LLM. Test G proves it on a 125-block cube. |
| T-06-07 — per-block pathfind hang | mitigate | `goTo(bot,x,y,z,3,timeoutMs)` wall-clock-bounded (12s default, `config.pathfinder_timeout_ms` override); inner `digAction` self-times via `DEFAULT_TIMEOUT_MS=8000`. |
| T-06-08 — mid-vein owner-chat preempt | mitigate | `signal?.aborted` checked (1) at entry, (2) before goTo, (3) between goTo and digAction; `digAction`'s own abort race surfaces `'aborted'` which the outer loop re-wraps with `K/N` partial progress. Test D proves it. |
| T-06-09 — bot-position-as-anchor (LLM Pitfall 5) | accept + better-error | air-name check returns `'no block at anchor'` cleanly instead of flood-filling air. Description text steers Haiku toward `find()`-produced or `#N` snapshot-handle coords. |

## Known Stubs

None. The module is fully wired; registration in `registry.js` and primer mirroring in `orchestrator.js` are scoped to Plan 06-04 and explicitly out of this plan's scope per `<objective>` final paragraph.

## Plan-Level TDD Gate Compliance

Plan declares `type: execute` (not `type: tdd`); each task declares `tdd="true"` individually. Per-task gate sequence:

- Task 1 (`feat(06-03): ...` 1e28d53): implementation + colocated description.
- Task 2 (`test(06-03): ...` b7a825a): test added after impl. Note: this inverts strict RED→GREEN order because Task 2 was authored against the existing Task 1 module (its purpose is *unit-test coverage*, not test-first contract drive). Plan structure (two separate `<task>` blocks with independent verify steps) frames Task 2 as the verification harness rather than a RED gate, so I followed plan order. Both commits passed their respective `<verify>` checks.

## Self-Check: PASSED

- `[ -f src/bot/adapter/minecraft/behaviors/mineVein.js ]` → FOUND
- `[ -f scripts/test-mineVein.mjs ]` → FOUND
- `git log --oneline --all | grep 1e28d53` → FOUND
- `git log --oneline --all | grep b7a825a` → FOUND
- `node -e "..." mineVein exports check` → ok
- `node scripts/test-mineVein.mjs` → all 7 tests passed (exit 0)

## Next Plan

**06-04** — register `mine_vein` (and `find`) in `registry.js`; mirror `MINE_VEIN_DESCRIPTION` into `orchestrator.js` `ACTION_DESCRIPTIONS.mine_vein` (cache-prefix bust acknowledged).
