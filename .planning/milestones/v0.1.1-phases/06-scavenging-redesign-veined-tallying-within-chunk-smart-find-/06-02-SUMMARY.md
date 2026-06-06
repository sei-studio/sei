---
phase: 06
plan: 02
subsystem: nl-resolution
tags: [minecraft, nl-resolution, scavenging]
requires: []
provides:
  - "resolveTerm(name) → string[]"
  - "LOOSE_TERMS keylist"
affects:
  - src/bot/adapter/minecraft/loose-terms.js (new)
  - scripts/test-resolveTerm.mjs (new)
tech_stack:
  added: []
  patterns: ["pure ESM data module (no mineflayer/minecraft-data/vec3)"]
key_files:
  created:
    - src/bot/adapter/minecraft/loose-terms.js
    - scripts/test-resolveTerm.mjs
  modified: []
decisions:
  - "Hand-curated TABLE keys: wood/log/planks/leaves/ore/stone/dirt/sand"
  - "Unknown / unmapped inputs fall through as lowercased exact-ID singletons"
  - "Empty / nullish inputs return [] (caller must guard)"
metrics:
  duration_min: 5
  completed: 2026-05-11
---

# Phase 6 Plan 2: Loose-Terms NL→ID Resolver Summary

Hand-curated NL→MC-block-ID resolver shipped as a standalone pure module so Phase 6 actions (`find`, `mine_vein`) and Phase 7 pillar-up can call `resolveTerm()` without dragging the observer stack.

## What Shipped

- `src/bot/adapter/minecraft/loose-terms.js` — `TABLE` (8 keys, 60 IDs total), `resolveTerm(name) → string[]`, `LOOSE_TERMS` keylist. ESM named exports, zero mineflayer / minecraft-data / vec3 imports (Phase 7 reuse constraint).
- `scripts/test-resolveTerm.mjs` — 9 unit tests: known-key expansion (wood/ore/stone), alias equivalence (log↔wood), case-insensitivity (WOOD↔wood), exact-ID fallthrough (oak_log, NONESUCH_BLOCK), empty/null/undefined → [], LOOSE_TERMS coverage.

## Commits

| Task | Type | Hash | Message |
|------|------|------|---------|
| 1 | feat | 86d43ca | add loose-terms NL→ID resolver |
| 2 | test | 9013135 | cover resolveTerm + LOOSE_TERMS |

## Verification

- `node scripts/test-resolveTerm.mjs` → 9 PASS, exit 0.
- Purity grep: `grep -E "from 'mineflayer'|from 'minecraft-data'|from 'vec3'|require\(" src/bot/adapter/minecraft/loose-terms.js | grep -v '^//\|^ \*' | wc -l` → 0.
- Module load smoke test: `node -e "import('./src/bot/adapter/minecraft/loose-terms.js').then(...)"` → ok.

## Deviations from Plan

None — plan executed exactly as written. Test count matches plan spec (9 cases, including the implicit null/undefined extension of "empty input").

## Threat Flags

None. STRIDE T-06-04 (input coercion) and T-06-05 (collision UX) are addressed inline in the module + documented per RESEARCH.md Pitfall 4.

## TDD Gate Compliance

- RED gate (Task 1): pre-implementation import smoke test failed with `ERR_MODULE_NOT_FOUND` before file creation; commit 86d43ca made it pass (GREEN).
- Task 2 added a dedicated unit harness on top of the GREEN module (test-after for the harness itself, but each behavior in `<behavior>` is independently verified before the plan closes).

## Known Stubs

None. Module is feature-complete for D-NEW-SCAV-2.

## Self-Check: PASSED

- `src/bot/adapter/minecraft/loose-terms.js` — FOUND
- `scripts/test-resolveTerm.mjs` — FOUND
- Commit 86d43ca — FOUND
- Commit 9013135 — FOUND
