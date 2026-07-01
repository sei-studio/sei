---
phase: 17-minecraft-competence
plan: 05
subsystem: bot/minecraft-adapter
tags: [minecraft, prompts, capability-contract, disposition, vision, reflex, cached-system-block]

# Dependency graph
requires:
  - phase: 17-minecraft-competence
    provides: "registered actions openFurnace/smeltInput/addFuel/takeSmelted/activateBlock/readSign/shelter (Plan 03); next: snapshot line (Plan 04); attackerKind:'reflex' announcement contract (Plan 02)"
provides:
  - "CAPABILITY_PARAGRAPH that affirms smelt/cook, read signs, open doors/gates, build shelter — the 'you can't smelt, ask the player' deferral is gone"
  - "ACTION_DESCRIPTIONS entries for all 7 new actions, names matching the registry exactly"
  - "solo-capable-but-involves-the-player disposition framing (D-11) in the cached capability block"
  - "sei:idle passive -> chores -> invite tiers, framing the next: milestone as an invitation (D-12/D-13)"
  - "on-failure/on-demand look() framing in SEEING_RULE_VISION + PATHFINDER_RULE_VISION (D-10)"
  - "REFLEX_ADDENDUM: proactive attackerKind:'reflex' warning offering attack()/explore() (D-05)"
affects: [17-06, minecraft-competence]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single cached-system-block owner for the phase: all prompt-text edits land in adapter/minecraft/prompts.js so the cached block (anthropicClient index 2) churns once"
    - "Reflex announcement reuses the onAttacked route via an attackerKind discriminator branch in eventAddendum — no new event handler"

key-files:
  created: []
  modified:
    - src/bot/adapter/minecraft/prompts.js

key-decisions:
  - "Disposition (D-11) lives in CAPABILITY_PARAGRAPH so it is part of the cached system block, not re-sent per turn"
  - "Reflex framing is a separate REFLEX_ADDENDUM routed by a kind==='reflex' branch in eventAddendum, keeping the you-were-hit ATTACKED_ADDENDUM untouched; noticed/count flow through by passing the full data object"
  - "Lowercase smelt/sign/door/shelter kept in the affirming sentence so the capability is legible and matches the registry vocabulary"

requirements-completed: [MCRAFT-01, MCRAFT-04, MCRAFT-05, MCRAFT-06, MCRAFT-08]

# Metrics
duration: ~15min
completed: 2026-06-26
---

# Phase 17 Plan 05: Minecraft Capability Contract + Disposition + Vision Framing Summary

**The cached Minecraft system prompt now tells the bot the truth about its Phase 17 abilities — it CAN smelt, read signs, open doors, and build a shelter (the stale "ask the player to smelt" deferral is deleted) — advertises all seven new actions by their exact registry names, and encodes the north-star disposition (solo-capable to iron tier but chooses to involve the player), on-failure vision use, and a proactive reflex warning that offers the player attack()/explore().**

## What Was Built

**Task 1 — Capability contract + action descriptions.** Rewrote line 10 of `CAPABILITY_PARAGRAPH`: deleted the "You can't smelt in a furnace … a smelted ingot is something you request, not something you make" deferral and replaced it with a concise sentence affirming smelt/cook in a furnace, read signs, open and pass through doors/gates, and build a simple shelter (it still notes the genuinely-absent abilities: mounts, enchant, brew, redstone). Added seven `ACTION_DESCRIPTIONS` entries (one short paragraph each, mirroring the `placeBlock` style) for `openFurnace`, `smeltInput`, `addFuel`, `takeSmelted`, `activateBlock`, `readSign`, `shelter` — names cross-checked against `registry.js` and the 17-03-SUMMARY arg schemas. The furnace entries spell out the open -> load input + fuel -> wait -> takeSmelted workflow.

**Task 2 — Disposition + vision-on-failure + reflex framing.** Added the D-11 disposition sentence to the cached capability block: the bot is capable of soloing to iron tier but its default is to involve the player ("a friend who could beat the game alone yet chooses to play it together"). Sharpened `EVENT_GUIDANCE['sei:idle']` into explicit passive (observe/comment) -> reactive (light chores: wood, food, cobble) -> agentic tiers, where the agentic tier turns the snapshot `next:` milestone line into an invitation rather than soloing it, and a genuine block (no iron, missing tool, stuck pathing) becomes an in-character invite (D-13). Strengthened `SEEING_RULE_VISION` and `PATHFINDER_RULE_VISION` so navigation failure (goTo timeout/unreachable), ambiguous terrain, or a player ask triggers `look(around)` to orient — framed explicitly as on-failure/on-demand, not always-on (D-10), with the NOVISION variants left untouched (no look() regression). Added `REFLEX_ADDENDUM` and a `kind === 'reflex'` branch in `eventAddendum`: the `attackerKind:'reflex'` announcement (Plan 02 contract) is framed as a proactive warning that names the threat, states whether it noticed the bot (from `data.noticed`), notes the count, and offers the player `attack()` or `explore()` — distinct from the "you were hit" `ATTACKED_ADDENDUM`.

## Registered Action Names Advertised (cross-checked vs registry.js)

| Action | Registry line | Schema |
|--------|---------------|--------|
| `openFurnace` | registry.js:469 | TargetShape |
| `smeltInput` | registry.js:471 | `{ item, count 1..64 = 1 }` |
| `addFuel` | registry.js:480 | `{ item, count 1..64 = 1 }` |
| `takeSmelted` | registry.js:489 | `{}` |
| `activateBlock` | registry.js:438 | TargetShape |
| `readSign` | registry.js:442 | TargetShape |
| `shelter` | registry.js:269 | ShelterSchema (size 3..5) |

## Task Commits

1. **Task 1: Rewrite capability contract + add new action descriptions** — `9de743f` (feat)
2. **Task 2: Disposition (solo-but-involve) + vision-on-failure + reflex framing** — `fbb85d5` (feat)

## Verification

- `grep -v '^//' prompts.js | grep -c "can't smelt"` -> **0** (deferral removed)
- Capability paragraph affirms smelt + sign + door + shelter (all four lowercase tokens present)
- All seven new action names present in `ACTION_DESCRIPTIONS`, matching the registry exactly
- `grep -ci "invit"` (excluding comments) -> **3** (disposition + idle invite framing)
- Disposition states iron-tier-on-your-own + involve the player; reflex framing offers `attack()`/`explore()` and is distinct from `ATTACKED_ADDENDUM`
- NOVISION variants (`SEEING_RULE_NOVISION`, `PATHFINDER_RULE_NOVISION`) contain **0** `look(` references — no regression
- `node --input-type=module -e "import('.../prompts.js')"` -> **parsed OK**; `eventAddendum('sei:attacked', {attackerKind:'reflex', ...})` returns the proactive warning, `{attackerKind:'mob'}` still returns the you-were-hit line
- Consuming tests green: `orchestrator.test.js` + `orchestrator.idleVision.test.js` + `orchestrator.zombie.test.js` + `orchestrator.visualize.test.js` -> **38 passed**

## Threat Model Compliance

- **T-17-14 (stale capability prompt drift):** mitigated — removed the "can't smelt" deferral; the seven advertised action names were cross-checked against `registry.js` so the model cannot mis-advertise or call non-existent tools.
- **T-17-15 (vision-token DoS from always-on look):** mitigated — look() framing is explicitly on-failure/on-demand in both VISION rules; no new tool, no always-on render; NOVISION variants unchanged.
- **T-17-SC (dependency installs):** n/a — prompt text only, no code paths, no npm packages.

## Deviations from Plan

None — plan executed as written. Implementation note: to surface "whether it noticed the bot" and the hostile count in the reflex warning, `eventAddendum` now passes the full `data` object to `REFLEX_ADDENDUM` (the existing `ATTACKED_ADDENDUM` signature `(label, kind)` is unchanged). This is the natural realization of the plan's instruction to frame `noticed`/`count`, not a scope change — and it stays entirely inside `prompts.js`.

## Known Stubs

None.

## Self-Check: PASSED

- `src/bot/adapter/minecraft/prompts.js` present on disk and parses as a module.
- Both task commits (`9de743f`, `fbb85d5`) present in git history.
- Only `prompts.js` (plus this SUMMARY) modified; STATE.md / ROADMAP.md untouched (worktree mode — orchestrator owns those).

---
*Phase: 17-minecraft-competence*
*Completed: 2026-06-26*
