---
name: 260517-frz-SUMMARY
quick_id: 260517-frz
description: Research and implement giving bots custom skins in offline play
status: promoted
date: 2026-05-17
---

# Quick Task 260517-frz: Promoted to Phase 9

**Status:** Promoted (not executed as a quick task)

## What happened

Started as a quick task with `--research --discuss` flags. After the
discussion + research phase, multi-turn conversation with the user surfaced
that the scope was much larger than a quick task could carry:

- Vanilla LAN has a fundamental protocol-level limitation on offline-mode
  skin propagation
- Four implementation approaches were considered and three ruled out (signed-
  texture injection, prismarine-proxy, Paper sidecar)
- The chosen approach (CustomSkinLoader client mod with a Sei-managed setup
  wizard) requires cross-platform installer automation, 3D skin preview UI,
  and depends on the rest of Sei working on Windows first
- Realistic effort estimate: 9-13 days, comparable to a full phase

User decision: split into two phases.

- **Phase 8:** Windows cross-platform compatibility (precondition)
- **Phase 9:** Custom bot skins via CustomSkinLoader (this work)

## Artifacts preserved

The original quick-task artifacts (CONTEXT.md, RESEARCH.md) were copied into
the new Phase 9 directory:

- `.planning/phases/09-implement-custom-bot-skins-via-customskinloader-mod-first-la/CONTEXT.md`
  (rewritten to reflect final CustomSkinLoader decision; original quick-task
  context preserved as historical reference in `260517-frz-CONTEXT.md` in this
  directory)
- `.planning/phases/09-.../RESEARCH.md` (verbatim copy of `260517-frz-RESEARCH.md`)

## Why this is recorded as "promoted" not "complete"

No code was written, no executor ran, no commits landed against the quick task.
The value produced is upstream research that informs Phase 9 planning. STATE.md
records this as a promoted task, not a completed one.

## Pointers

- Read `.planning/phases/09-.../CONTEXT.md` first when planning Phase 9
- Read `.planning/phases/09-.../RESEARCH.md` for the full constraint analysis
  (vanilla LAN protocol, mineskin.org, prismarine-proxy, etc.)
- Phase 8 must complete before Phase 9 can plan in detail (cross-platform
  helpers established in Phase 8 are inputs to the wizard work)
