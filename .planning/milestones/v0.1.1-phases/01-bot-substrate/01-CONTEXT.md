# Phase 1: Bot Substrate - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the mineflayer bot runtime layer: server connection, scripted reflex behaviors (follow, chat-response, auto-eat, combat, pathfinding), a closed Zod-typed action registry, and an event-sourced FSM with priority queue — all without any LLM involvement. No Electron GUI; runnable as a Node.js CLI.

</domain>

<decisions>
## Implementation Decisions

### Runnable Form
- **D-01:** Phase 1 runs as a standalone Node.js CLI entry point (`node src/index.js`). No Electron coupling in this phase — utilityProcess wrapping comes in Phase 4.
- **D-02:** Configuration loaded from a `config.json` file (server IP/port, auth mode, owner username). No GUI config in this phase.

### Owner Identification
- **D-03:** Owner identified via `owner_username` field in `config.json`. Bot follows the player whose in-game name matches this string. Explicit, zero-ambiguity, easy to test on a local server.

### Authentication
- **D-04:** Primary dev/test target is offline-mode (local LAN or private server with online-mode disabled). `auth` field in `config.json` accepts `"offline"` or `"microsoft"` — mineflayer handles both natively.
- **D-05:** Microsoft device-code flow (CONN-02) is satisfied by mineflayer's built-in stdout behavior when `auth: "microsoft"` is set. No custom auth UX needed in Phase 1.
- **D-06:** Dev validation uses `auth: "offline"` for fast feedback loop.

### Architecture (locked from CLAUDE.md)
- **D-07:** Mineflayer must live in utilityProcess when Electron is added (Phase 4). Phase 1 scaffolds this by keeping all bot logic in a self-contained module with no renderer coupling.
- **D-08:** FSM uses a priority queue: P0 safety → P1 chat → P2 movement-completion → P3 idle. Single outstanding action token tracked by AbortController.
- **D-09:** Every pathfinder call has a wall-clock timeout. "Couldn't reach" is a first-class return value, never a hang.
- **D-10:** Action registry is closed and Zod-typed. No code generation, no coordinate injection — actions only.

### Reference Implementation
- **D-11:** `../sui/mindcraft-0.1.4/` is a working prototype to draw patterns from (mineflayer setup, settings structure, bot initialization). Reuse patterns; do not copy code wholesale.

### Claude's Discretion
- Specific wall-clock timeout value for pathfinder (reasonable default: 10–15s)
- Zod schema field naming conventions for action registry
- Internal module file structure within `src/`
- Debounce implementation approach (500ms per REQUIREMENTS.md, mechanism is Claude's call)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & Constraints
- `CLAUDE.md` — Key architecture decisions (utilityProcess placement, FSM priority queue, AbortController, timeout requirement). **Read first.**
- `ARCHITECTURE.md` — Relational graph of full system data flow (context for where Phase 1 fits)

### Requirements
- `.planning/REQUIREMENTS.md` §Bot Connection (CONN-01–04), §Bot Behavior (BOT-01–06) — Phase 1 acceptance criteria
- `.planning/ROADMAP.md` §Phase 1 — Success criteria and dependency list

### Reference Implementation
- `../sui/mindcraft-0.1.4/settings.js` — Config shape reference (host, port, auth, only_chat_with pattern)
- `../sui/mindcraft-0.1.4/src/utils/mcdata.js` — mineflayer createBot invocation pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `mineflayer/` (repo root): mineflayer library source is present locally — import directly, no npm install needed for the library itself
- `../sui/mindcraft-0.1.4/`: Working prototype with mineflayer bot initialization, settings loading, and profile-based bot config. Draw from this for bot setup patterns.

### Established Patterns
- `../sui` uses `settings.js` (exported default object) for config — Sei will use `config.json` instead (simpler for CLI + future GUI ingestion)
- mineflayer `createBot({ host, port, username, auth })` — standard entry point, auth field handles offline/microsoft natively

### Integration Points
- Phase 1 output (bot module + FSM) becomes the payload for Phase 4's utilityProcess. Keep bot logic behind a clean `start(config)` / `stop()` interface to make wrapping trivial.
- Phase 2 will wire the LLM orchestrator into the FSM's P1/P2/P3 event slots — the FSM skeleton must expose those hooks.

</code_context>

<specifics>
## Specific Ideas

- User confirmed this phase is "simple and already validated" via `../sui` — planning should move quickly; no research into mineflayer basics needed.
- Owner follows by username match (not UUID) in Phase 1; UUID-based owner persistence comes in Phase 3 (MEM-03).

</specifics>

<deferred>
## Deferred Ideas

- Microsoft device-code GUI UX — Phase 4 (Electron will handle presenting the device-code URL in the log viewer)
- UUID-based owner persistence — Phase 3 (MEM-03)
- Ollama / LLM wiring — Phase 2

</deferred>

---

*Phase: 01-bot-substrate*
*Context gathered: 2026-04-24*
