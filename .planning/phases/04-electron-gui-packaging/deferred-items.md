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

## From plan 04-03 (stores and secrets)

- The repository's installed `node_modules/typescript` is **3.9.10**, not the
  `^5.4.0` declared in `package.json` devDependencies (added by plan 04-01).
  Parent repo never had `npm install` run after the plan-01 dependency bump.
  Likewise, `electron@42.0.0` (declared by plan 01) is not installed —
  `node_modules/electron` is absent, so `import { app, safeStorage } from 'electron'`
  cannot be type-checked locally.
  - Impact: the per-task `npx tsc --noEmit -p tsconfig.node.json` verify
    command in plans 04-02, 04-03 (and probably 04-04+) cannot run cleanly
    in this worktree. Files are written to spec; full type-check must wait
    until Wave-2 merge runs `npm install`.
  - Scope: pre-existing environmental issue, NOT caused by plan 04-03's
    changes. Logged here per executor scope-boundary rule.
  - Recommendation: the wave-merge / pre-build step must run `npm install`
    on the merged tree before plan 04-04 begins. Plan 04-11 (clean-VM smoke)
    already exercises a fresh install.
