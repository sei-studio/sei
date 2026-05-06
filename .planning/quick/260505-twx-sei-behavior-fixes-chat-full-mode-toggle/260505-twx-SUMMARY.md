---
quick_id: 260505-twx
type: quick
plan: 01
wave: 1
depends_on: []
status: completed
completed: 2026-05-05
duration_minutes: 35
files_modified:
  - src/cli/index.js
  - src/config.js
  - src/llm/orchestrator.js
  - src/observers/snapshot.js
  - src/observers/blocks.js
  - src/behaviors/dig.js
  - src/llm/errStrings.js
commits:
  - hash: d4db1ac
    title: "feat(260505-twx): add chat_mode toggle (chat | full) for [think] relay"
  - hash: 0e18119
    title: "feat(260505-twx): tier-aware nearby-blocks sort + 16-entry cap + dig name-targeting hint"
  - hash: ea9b342
    title: "feat(260505-twx): P0 attack reaction + dig errors + iteration cap + say cadence"
---

# Quick Task 260505-twx: Sei behavior fixes Summary

Five-fix consolidation from a live observed bot session: chat/full mode toggle, snapshot tier-aware ranking with 16-entry cap, dig-by-name tool description, P0 attack reaction with verbal-first seed + abort-and-restart wiring, cleaner dig error strings (no held-item suffix), iteration_cap raised 20→30, and a say() cadence rule for the system prompt.

## What Shipped

**Task 1 — chat_mode toggle (commit d4db1ac).** New top-level `chat_mode: 'chat' | 'full'` config field (default `chat` so existing config.json files keep current behavior). CLI onboarding picks it after `tone`. Orchestrator's terminal-text and mid-loop-text branches now relay the assistant's private `text` block to Minecraft chat with a `[think] ` prefix (256-char truncation matches `say()`) when `chat_mode === 'full'`. `gracefulCapClose` left alone — already routes its own text to chat.

**Task 2 — snapshot tier-aware ranking + dig description (commit 0e18119).** `TERRAIN` is now exported from `src/observers/blocks.js`. `nearbyBlocks` runs a stable secondary sort that places non-terrain interesting blocks (logs, ores, chests, crafting_table, beds, …) BEFORE terrain (grass_block, dirt, sand, …) regardless of distance — within each tier, distance order is preserved. `MAX_BLOCKS` bumped from 8 to 16. `ACTION_DESCRIPTIONS.dig` added so Haiku knows `{ block: "<name>" }` digs the nearest exposed block of that name within `maxDistance`. The behavior was already supported by `registry.js` TargetShape and `observers/targeting.js` `resolveBlock` — only the description was missing.

**Task 3 — P0 attack reaction + dig errors + cap + say cadence (commit ea9b342).** Five sub-fixes in one commit because they are tightly related (orchestrator behavior + a couple of action error strings + a config default):

1. `iteration_cap` default raised 20 → 30 in `src/config.js`.
2. `src/behaviors/dig.js` splits the previous `cannot break X with Y` branch:
   - air targets → `no block at X,Y,Z (target was air)` (snapshot stale, model picked empty space)
   - real unbreakable / wrong-tool → `cannot break <name> at X,Y,Z (unbreakable or wrong tool)` (no held-item suffix)
3. `src/llm/errStrings.js` JSDoc note on `reason()` warning against post-decorating error messages with held-item / inventory context inside action wrappers — Haiku reads decoration as causal.
4. `SYSTEM_INSTRUCTIONS` gains a say() cadence rule: REQUIRED on first and last loop turns, optional in middle, never restate snapshot info.
5. Attack-reaction wiring (the load-bearing change):
   - New `sei:attacked` branch in the seed addendum names the attacker (`label (kind)`), demands a verbal-first reaction, and sets player-vs-mob policy.
   - Module-level `pendingAttack` let. The single-flight branch in `handleDispatch` now accepts `sei:attacked` mid-loop: it stashes the dispatch, aborts the loop, and the finally block re-emits via `bot.emit('sei:attacked', data)` after `currentLoop = null`. The FSM re-enqueues at P0 → fresh dispatch arrives with `currentLoop === null` → new loop with the attack seed addendum. Previously these dispatches were dropped.
   - Both `runIterations` catch arms check `pendingAttack` and exit cleanly without appending a PLAYER INTERRUPT turn (the synthesized aborted tool_results keep any in-flight Anthropic streaming state coherent; the turn is never sent).

HP-loss-while-idle path is unchanged — `entityHurt → sei:attacked → FSM P0 → fresh loop` already worked; verified by trace, no code edit needed.

## Key Files

- **Created:** none (no new files; all edits are in-place).
- **Modified:**
  - `src/config.js` — `chat_mode` field; `iteration_cap` default 30.
  - `src/cli/index.js` — chat mode pick during onboarding; `chat_mode` persisted.
  - `src/llm/orchestrator.js` — `[think]` relay in two text branches; `dig` ACTION_DESCRIPTION; say() cadence rule in `SYSTEM_INSTRUCTIONS`; `sei:attacked` seed addendum; `pendingAttack` single-flight wiring (single-flight branch + finally re-emit + two catch-arm exits).
  - `src/observers/snapshot.js` — `MAX_BLOCKS = 16`.
  - `src/observers/blocks.js` — `export const TERRAIN`; tier-aware secondary sort in `nearbyBlocks`.
  - `src/behaviors/dig.js` — air vs unbreakable error branches; held-item suffix removed.
  - `src/llm/errStrings.js` — JSDoc note on `reason()`.

The plan listed `src/observers/blocks.js`, `src/behaviors/combat.js`, and `src/llm/loop.js` in `files_modified` for a total of 9 files. Of those, `combat.js` and `loop.js` did NOT need edits — the `must_haves` truths already verified that combat's leading-edge throttle is correct (no change) and that `loop.js` reads `iterationCap` from the orchestrator (config bump suffices). 7 files actually changed; the other 2 were precautionary listings in the plan that the implementation correctly skipped.

## Decisions Made

- **Attack abort uses bot.emit re-fire, not direct loop seeding.** The simpler alternative (synthesize a fresh loop in-line on abort) would bypass FSM priority/queue ordering and risk racing other dispatches. Re-emitting through `bot.emit('sei:attacked')` lets the FSM own queueing — the P0 sei:attacked then naturally beats the P2.5 sei:loop_end that the just-aborted loop's `sei:loop_terminal` enqueues.
- **Air branch returns `(target was air)` not just `(no block)`.** Distinguishes the different air variants (`air`, `cave_air`, `void_air`) so a future debug session can correlate cave-vs-overworld stale-snapshot bugs.
- **`[think] ` prefix matches Minecraft chat conventions.** Distinct enough from say() lines that an owner can filter visually; short enough that the 256-char truncation still leaves ~248 chars for the actual thinking text.
- **Tier-aware sort uses `Set(TERRAIN)` rebuilt each call.** TERRAIN is small (22 entries) so per-call construction is negligible; avoids module-level mutable state.

## Verification

All three task `<verify>` blocks passed:

```
Task 1: PASS (default chat_mode=chat, full accepted, bogus rejected)
Task 2: PASS (TERRAIN exported with 22 entries, MAX_BLOCKS=16, dig description present, behavioral smoke test confirms oak_log sorts before grass_block)
Task 3: PASS (iteration_cap=30, air dig msg, unbreakable msg, no held-item suffix, cadence rule, pendingAttack wired, attack seed present, all files parse)
```

`node --check` passed on every modified .js file. `package.json` unchanged (no new dependencies).

## Deviations from Plan

**1. [Rule 3 - Scope] Skipped no-op edits to `src/behaviors/combat.js` and `src/llm/loop.js`.**
- **Found during:** Task 3 planning review.
- **Issue:** The plan's `files_modified` frontmatter listed both files, but the `must_haves` truths and the plan's own context section explicitly said combat.js needs no change (leading-edge throttle is already correct) and that loop.js's iterationCap is read from `config.memory.iteration_cap` (so changing the config default suffices).
- **Fix:** Did not modify either file. The plan's own text already justified this.
- **Files modified:** none (this is a non-modification deviation).
- **Commit:** N/A.

**2. [Rule 1 - Bug] Plan instructed `delete cfg.chat` line removal but the existing intent was correct.**
- **Found during:** Task 1 implementation.
- **Issue:** The plan said "DELETE line 188: `delete cfg.chat`" but in context this line was scrubbing a stale legacy field from any pre-existing config.json. The plan author then back-pedaled in the same paragraph ("actually leave a single line `delete cfg.chat` as legacy-cleanup … no — just delete the line; the new field is `chat_mode`, distinct name, no collision").
- **Fix:** Kept the `delete cfg.chat` line (as the plan's own back-pedal preferred). Updated its comment to reflect the new field name. The new `chat_mode` field is distinct, so the legacy cleanup is still correct.
- **Files modified:** `src/cli/index.js`.
- **Commit:** d4db1ac.

No other deviations. The architectural changes (attack abort + re-emit, tier-aware sort, dig description) all match the plan's `<attack_abort_branch>`, `<full_mode_print_path>`, and `<say_cadence_rule>` blocks exactly.

## Authentication Gates

None — quick task is local code only, no external services touched.

## Self-Check: PASSED

- Files modified exist (all 7).
- Commits exist:
  - `d4db1ac feat(260505-twx): add chat_mode toggle (chat | full) for [think] relay`
  - `0e18119 feat(260505-twx): tier-aware nearby-blocks sort + 16-entry cap + dig name-targeting hint`
  - `ea9b342 feat(260505-twx): P0 attack reaction + dig errors + iteration cap + say cadence`
- All `node --check` calls passed.
- All three `<verify>` blocks passed (plus the behavioral smoke test for tier-aware sort).
