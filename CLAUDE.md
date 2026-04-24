# Sei — Project Guide

## Project

Sei is a Minecraft AI companion system with a two-layer LLM architecture (Haiku 3 personality + Ollama Qwen movement), mineflayer bot control, and an Electron GUI for non-technical users. See `.planning/PROJECT.md` for full context.

## GSD Workflow

This project uses the GSD planning system. Planning artifacts live in `.planning/`.

**Current state:** `.planning/STATE.md`
**Roadmap:** `.planning/ROADMAP.md`
**Requirements:** `.planning/REQUIREMENTS.md`

### Phase commands

```
/gsd-discuss-phase N    — gather context before planning
/gsd-plan-phase N       — create execution plan for a phase
/gsd-execute-phase N    — execute a planned phase
/gsd-verify-work N      — verify phase deliverables
```

### Workflow enforcement

- Always read `.planning/STATE.md` and the current phase from `.planning/ROADMAP.md` before starting work
- Never skip phases — each phase builds on the previous
- Commit planning docs alongside code changes
- After each phase: update STATE.md and mark phase complete in ROADMAP.md

## Key Architecture Decisions

1. **Three-process Electron**: main ↔ renderer (contextIsolation) ↔ utilityProcess (bot + LLMs). Mineflayer must run in utilityProcess only.
2. **Closed action registry**: movement LLM calls Zod-typed actions, never generates code or coordinates
3. **Event-sourced FSM**: priority queue (P0 safety → P1 chat → P2 completion → P3 idle), single outstanding action token with AbortController
4. **LLM-directed memory compaction**: personality LLM decides when to compact at semantic boundaries, not a mechanical timer
5. **Every external call has a timeout**: pathfinder, Ollama, Anthropic — no exceptions

## Critical Pitfalls

- Pathfinder silent hangs → wrap every call with wall-clock timeout
- Two-layer LLM runaway loop → hard recursion cap (5 hops) + 500ms debounce from day one
- Native ABI mismatch → `@electron/rebuild` in postinstall, test packaged builds on clean VMs
- macOS screen recording → screenshot is v2, treat as optional, degrade gracefully
