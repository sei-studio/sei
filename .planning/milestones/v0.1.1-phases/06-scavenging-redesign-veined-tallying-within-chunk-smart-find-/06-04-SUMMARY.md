---
phase: 06
plan: 04
subsystem: integrate-and-verify
tags: [minecraft, snapshot, registry, llm-primer, cache-bust]
status: partial — automated complete, live-bot checkpoint pending
requires: [06-01, 06-02, 06-03]
provides:
  - snapshot.js: veined `nearby veins:` render with #N anchors
  - registry: find + mine_vein registered Zod actions
  - orchestrator: ACTION_DESCRIPTIONS.find + .mine_vein
  - scripts/verify-phase6.mjs: 8-assertion end-to-end harness
affects:
  - Anthropic cached system prefix (deliberate one-time bust)
tech-stack:
  added: []
  patterns:
    - import-by-reference for LLM descriptions (drift discipline)
    - filter('setGoals')-only subRegistry — new actions surface to Haiku
key-files:
  created:
    - scripts/verify-phase6.mjs
  modified:
    - src/bot/adapter/minecraft/observers/snapshot.js
    - src/bot/adapter/minecraft/registry.js
    - src/bot/brain/orchestrator.js
decisions:
  - mine_vein description sourced via import (MINE_VEIN_DESCRIPTION) so byte-identity is mechanical
  - find handler delivers `{found,id,pos,distance}` JSON shape, not a string — orchestrator stringifies for the model
  - subRegistry filter only excludes `setGoals`; find + mine_vein pass through to Haiku tool list without further plumbing
metrics:
  commits: 3
  tasks_complete: 3
  task_pending: 1  # live-bot checkpoint
  files_modified: 3
  files_created: 1
  verify_assertions: 8
---

# Phase 6 Plan 4: Integrate & Verify — Summary (partial)

Closes D-NEW-SCAV-1/2/3 end-to-end. Snapshot now emits `nearby veins:` lines, the Zod registry exposes `find` + `mine_vein` to Haiku, and a deterministic `verify-phase6.mjs` harness passes 8/8 against pure-stub bot fixtures.

The live-bot manual checkpoint (Task 4) remains pending — automated work stops at the automation/verification boundary as instructed.

## What landed

### Task 1 — Snapshot veined render
**Commit:** `0fb1277` (`feat(06-04): replace snapshot nearby-blocks with veined nearby-veins render`)

- `src/bot/adapter/minecraft/observers/snapshot.js`:
  - Dropped `nearbyBlocks` + `INTERESTING_BLOCK_NAMES` import; replaced with `nearbyVeins` from `./veins.js`.
  - Removed the `MAX_BLOCKS` constant; vein cap is configured at the call site (`maxVeins: 8`, `veinCap: 64`).
  - Replaced the `nearby blocks:` render block with a `nearby veins:` render. Each vein anchor mints one handle through the same monotonic `let n` counter that entity numbering continues from. Count is rendered as `xN`, or `x64+` when the flood-fill saturated.
  - Empty case prints `  (none)`; overflow prints `  +K more`.
  - `terrain at feet:` render is unchanged. `setHandles(handles)` is still called exactly once at the end of `composeSnapshot`.

### Task 2 — Registry + LLM primer
**Commit:** `b6b84c4` (`feat(06-04): register find + mine_vein actions and update LLM primer`)

- `src/bot/adapter/minecraft/registry.js`:
  - New imports: `resolveTerm` (loose-terms), `mineVeinAction` (behaviors/mineVein), `getHealedPos` (posHealer), `mcDataLib`.
  - `registry.register('find', ...)`: Zod schema `{name:string min 1, maxDistance:number 1..128 default 64}`. Handler resolves the term, builds an mcData id-array (falls back to a function-form matcher if mcData is unavailable), uses `getHealedPos` for a NaN-safe origin, and returns `{found,id,pos,distance}` or `{found:false,reason}`.
  - `registry.register('mine_vein', ...)`: Zod schema with `name? + (x,y,z)?` and a `.refine` that requires either name or full coords. Delegates to `mineVeinAction`.
- `src/bot/brain/orchestrator.js`:
  - Imports `MINE_VEIN_DESCRIPTION` from `behaviors/mineVein.js`.
  - `ACTION_DESCRIPTIONS.mine_vein = MINE_VEIN_DESCRIPTION` (import-by-reference → mechanical byte-identity, no drift possible).
  - `ACTION_DESCRIPTIONS.find = '...'`: one-paragraph description steering Haiku to `find({name:"<term>"})`, explaining loose-term expansion + the `{found,id,pos,distance}` return shape, and warning that the action does NOT move the bot.
- Verified the `buildAnthropicTools(subRegistry, ACTION_DESCRIPTIONS)` call site (around orchestrator.js L443-454): the `subRegistry.list` only filters out `setGoals`. `find` and `mine_vein` are surfaced to Haiku without further work — the API-only collapse already removed the movement-tier filter that previously blocked this.

**Cache prefix:** Both new `ACTION_DESCRIPTIONS` keys land in this single commit per Pitfall 6 — the Anthropic cached system prefix invalidates exactly once on first deploy of this commit, then rewarms.

### Task 3 — verify-phase6.mjs
**Commit:** `77150f3` (`test(06-04): add verify-phase6.mjs end-to-end harness`)

`scripts/verify-phase6.mjs` — 229 lines, 8 PASS assertions, pure-stub:

| V# | Coverage |
|----|----------|
| V1 | composeSnapshot renders `nearby veins:` for a 3-tree scene; per-vein `#N <name> xN @x,y,z d=<dp>` lines; monotonic handles 1..3 |
| V2 | createDefaultRegistry exposes `find` + `mine_vein`; both schemas accept known-good and reject known-bad inputs (empty name, missing coords, etc.) |
| V3 | `find({name:'wood'})` against a single oak_log → `{found:true,id:'oak_log',pos:{5,64,0},distance:number}` |
| V4 | `find({name:'wood'})` against an empty world → `{found:false,reason:/wood/}` |
| V5 | `mine_vein({name:'wood'})` against a 4-log oak tree (via `_deps`-stubbed goTo + digAction) → `mined 4/4 oak_log` |
| V6 | mine_vein with AbortController firing after the 2nd dig → `aborted after K/4 oak_log` (K = 1 or 2 depending on when the signal is observed) |
| V7 | orchestrator.js binds `mine_vein: MINE_VEIN_DESCRIPTION` by reference (import statement present), so byte-identity is mechanical |
| V8 | ACTION_DESCRIPTIONS region contains both `find:` and `mine_vein:` keys; subRegistry filter at buildAnthropicTools site only excludes `setGoals` |

Final output:
```
[verify-phase6] OK (8 assertions)
```

Idempotent: re-running in the same shell produces an identical 8-PASS output.

## Deviations from Plan

None — automated tasks executed exactly as written. One minor formatting choice: the initial `registry.register(\n    'find',` multiline style failed the plan's strict `register('find'` text-match check. Reformatted to `register('find',\n    ...)` (matching the existing `register('dig', ...)` single-line-prefix style) to satisfy both readability and the verification regex. No behavior change.

## Threat-model touchpoints

- **T-06-11 (description drift):** mitigated as planned — `mine_vein: MINE_VEIN_DESCRIPTION` imports by reference; V7 confirms.
- **T-06-12 (movement-tier filter):** verified clear — only `setGoals` is filtered from the movement subRegistry; V8 asserts the filter signature has not changed.
- **T-06-14 (cache cascades):** both new keys batched in a single commit (`b6b84c4`).

## Pending — Task 4 live-bot checkpoint

The manual live-bot checkpoint remains the only gate before this plan can be marked complete. The developer must:

1. Boot the bot against the dev Minecraft server.
2. Visually confirm the snapshot now emits `nearby veins:` lines (one per detected vein, `#N` handles continuing into entities).
3. Verbally task the bot (e.g. "find me some wood", "chop down a tree") and confirm Haiku reaches for `find({name:"wood"})` and/or `mine_vein({name:"wood"})`.
4. Confirm a mid-mine_vein owner-chat preempt returns `aborted after K/N <name>` and the bot reorients.
5. Cross-cutting: no Anthropic cache thrashing beyond the single deliberate rewarm; no regressions in follow / eat / defend.

Resume-signal: developer types `approved` (or describes the failure mode for a gap-closure plan).

## Self-Check: PASSED

- `src/bot/adapter/minecraft/observers/snapshot.js` FOUND, contains `nearby veins:`, no `nearby blocks:`, single `setHandles(`.
- `src/bot/adapter/minecraft/registry.js` FOUND, contains `register('find'` and `register('mine_vein'`.
- `src/bot/brain/orchestrator.js` FOUND, contains both `find:` and `mine_vein:` in ACTION_DESCRIPTIONS, imports MINE_VEIN_DESCRIPTION.
- `scripts/verify-phase6.mjs` FOUND; `node scripts/verify-phase6.mjs` exits 0 with `OK (8 assertions)`.
- Commits `0fb1277`, `b6b84c4`, `77150f3` all present in `git log --oneline`.
