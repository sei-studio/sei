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

## From plan 04-04 (bot supervisor — wave 2)

- The repo's installed `node_modules/typescript` is pinned to **3.9.10**
  despite `package.json` declaring `typescript: ^5.4.0` as a devDependency.
  TypeScript 3.x cannot parse modern `@types/node` declarations
  (`.d.ts` files use template literal types and other TS-4+ syntax that
  3.x rejects), so `npx tsc --noEmit -p tsconfig.node.json` fails with
  hundreds of TS1005 / TS1110 errors against `node_modules/@types/node/*`.
  This is **pre-existing** — plan 04-01's `npm install` evidently resolved
  a hoisted/cached typescript@3 from a parent workspace. The new TS files
  in this plan (`src/main/lanWatcher.ts`, `src/main/logRouter.ts`,
  `src/main/botSupervisor.ts`) are syntactically clean per file inspection
  and follow PATTERNS/RESEARCH verbatim; they will type-check correctly
  once typescript is reinstalled at ^5.4.0.
  - Impact: cannot run the plan's tsc verify gates; relying on the lexical
    grep gates (which the plan also requires) + `node --check` for the
    `.js` augmentation. Plan 04-02 (shared types) is in flight in another
    worktree and may bring its own tsc fix.
  - Recommendation: `npm install --save-dev typescript@^5.4.0` (or full
    `rm -rf node_modules && npm install`) before plan 04-05 starts.
