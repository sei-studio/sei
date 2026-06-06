---
phase: 07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla
plan: 05
subsystem: bot/brain
tags: [llm-prompt, cache, cuboid, grammar]
requires: [07-02, 07-04]
provides: [seed_cuboid_grammar]
affects: [src/bot/brain/orchestrator.js]
tech-stack:
  added: []
  patterns: [cached-system-prompt-block]
key-files:
  created: []
  modified:
    - src/bot/brain/orchestrator.js
decisions:
  - "D-08: seed_cuboid_grammar inserted between seed_owner and seed_diary so cache_control on seed_diary still terminates the cached prefix"
metrics:
  completed: 2026-05-12
  tasks: 1
requirements: [R-01, R-02]
---

# Phase 7 Plan 05: seed_cuboid_grammar Cached Block Summary

Static `SEED_CUBOID_GRAMMAR` constant added to `orchestrator.js` and inserted by `composeSeedBlocks` between `seed_owner` and `seed_diary`, teaching the LLM the two-corner cuboid mental model (pillar/wall/platform/tunnel/hollow shapes + 256-volume cap + scaffolding note) once per session at the cached layer.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Define SEED_CUBOID_GRAMMAR + insert into composeSeedBlocks | 72eb395 | src/bot/brain/orchestrator.js |

## Verification

Inline verification script printed `OK`:
- `seed_cuboid_grammar` block present in composeSeedBlocks output
- Index ordering: seed_cuboid_grammar precedes seed_diary
- Text contains all five shape vocab terms (pillar, wall, platform, tunnel, hollow) and `256`
- Block carries no `cache_control` of its own (seed_diary remains the sole static cache boundary)
- No `# Owner` / `# Diary` headers in grammar text (cache invariant preserved)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- File modified: src/bot/brain/orchestrator.js (FOUND)
- Commit 72eb395 (FOUND in git log)
