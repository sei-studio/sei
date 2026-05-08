# Phase 4 — Deferred Items

Items discovered during execution that are out of scope for the current plan.

## From plan 04-01 (build scaffold)

- `scripts/verify-phase2.js` and `scripts/verify-phase2_1.js` reference paths
  that no longer exist (`../src/llm/orchestrator.js`, `../src/observers/snapshot.js`,
  `../src/llm/persona.js`). These imports were already broken BEFORE this plan
  (the `src/llm/` and `src/observers/` directories were removed during Phase
  03.1's refactor). Plan 04-01 only relocated the file tree, so this is
  pre-existing breakage.
  - Impact: `npm run verify:phase2` and `verify:phase2_1` (if scripted) cannot
    run. They are not part of CI today.
  - Recommendation: a future maintenance pass should either delete these
    scripts or update them to import from `src/bot/...`. The plan-level
    `package.json` script entries `verify:phase2` and `verify:phase3` were
    preserved per the plan's Task 2 acceptance criteria.
