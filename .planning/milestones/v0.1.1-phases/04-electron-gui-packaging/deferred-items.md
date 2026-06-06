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

## From plans 04-03 and 04-04 (stores+secrets, bot supervisor — wave 2)

- The repo's installed `node_modules/typescript` is pinned to **3.9.10**
  despite `package.json` declaring `typescript: ^5.4.0` as a devDependency
  (added by plan 04-01). The parent repo never ran `npm install` after the
  plan-01 dependency bump, so a hoisted/cached typescript@3 remained.
  Likewise, `electron@42.0.0` is not installed — `node_modules/electron`
  is absent, so `import { app, safeStorage } from 'electron'` cannot be
  type-checked locally. TypeScript 3.x also cannot parse modern
  `@types/node` declarations (template literal types, etc.), so
  `npx tsc --noEmit -p tsconfig.node.json` fails with hundreds of
  TS1005 / TS1110 errors against `node_modules/@types/node/*`.
  - Impact: per-task `tsc --noEmit` verify gates in wave-2 plans cannot
    run cleanly. Wave-2 executors substituted lexical grep gates and
    `node --check` for the `.js` augmentations.
  - Scope: pre-existing environmental issue, NOT caused by wave-2 plans.
    All new `.ts` files were written to PATTERNS/RESEARCH spec and are
    expected to type-check cleanly once typescript and electron are
    reinstalled.
  - Recommendation: `rm -rf node_modules && npm install` before plan
    04-05 starts. Plan 04-11 (clean-VM smoke) already exercises a fresh
    install on production VMs.
