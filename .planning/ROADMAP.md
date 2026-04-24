# Roadmap: Sei

**Created:** 2026-04-24
**Granularity:** coarse (4 phases)
**Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.

## Phases

- [x] **Phase 1: Bot Substrate** - Mineflayer connection, action registry, FSM, and scripted reflex behavior (no LLMs yet)
- [ ] **Phase 2: Two-Layer LLM Loop** - Personality LLM (Haiku 3) + movement LLM (Ollama Qwen) wired into the FSM with guardrails
- [ ] **Phase 3: Memory & Persistence** - SQLite-backed identity, owner relationship, world progression, and LLM-directed compaction
- [ ] **Phase 4: Electron GUI & Packaging** - Setup form, Start/Stop, live log viewer, and bundled .dmg/.exe distribution

## Phase Details

### Phase 1: Bot Substrate
**Goal**: A mineflayer-driven Minecraft bot connects to a server, executes scripted reflex behavior, and exposes a closed, Zod-typed action registry through an event-sourced FSM — all without any LLM involvement.
**Depends on**: Nothing (foundation)
**Requirements**: CONN-01, CONN-02, CONN-03, CONN-04, BOT-01, BOT-02, BOT-03, BOT-04, BOT-05, BOT-06
**Success Criteria** (what must be TRUE):
  1. A developer can launch the bot with a server IP/port and Microsoft account, and see it join the server with auto-detected version.
  2. When disconnected, the bot automatically reconnects and surfaces connection errors as plain-English status messages.
  3. The bot follows its owner, responds to proximity/addressed chat, auto-eats when hungry, and defends itself when attacked — entirely through scripted handlers, no LLM.
  4. Every pathfinder call has a wall-clock timeout and returns "couldn't reach" as a first-class result rather than hanging.
  5. An event queue + FSM skeleton routes chat, world, and movement-completion events through a single orchestrator ready to be driven by an LLM in Phase 2.
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md — Project scaffold, config schema, bot connection + reconnect loop
- [x] 01-02-PLAN.md — Pathfinder wrapper, action registry, reflex behaviors (follow/chat/eat/combat)
- [x] 01-03-PLAN.md — Event-sourced FSM with priority queue, AbortController, behavior wiring

### Phase 2: Two-Layer LLM Loop
**Goal**: The personality LLM drives the bot via natural-language hand-off to a local movement LLM that calls actions from the registry, with hard guardrails preventing runaway loops or cost.
**Depends on**: Phase 1
**Requirements**: LLM-01, LLM-02, LLM-03, LLM-04, LLM-05, LLM-06, LLM-07, LLM-08, PERS-01, PERS-02, PERS-03, PERS-04, PERS-05
**Success Criteria** (what must be TRUE):
  1. The personality LLM (Haiku 3) reacts to chat, world events, and 10s idle fallback, and hands off natural-language intent to the movement LLM (never coordinates or code).
  2. The movement LLM (Ollama Qwen 2.5) reliably calls registered actions from the Zod-typed registry, and the system falls back to Haiku-as-executor when Ollama is unavailable.
  3. A recursion cap (5 hops), event debounce (500ms), rate limit (30/min), and AbortController-based action cancellation demonstrably prevent runaway loops under stress.
  4. The bot speaks in a configurable name/backstory/tone that is stable across sessions and forms the cached Anthropic prompt prefix.
  5. When idle near its owner, the bot makes rate-limited proactive observations that feel in-character, not scripted.
**Plans**: TBD

### Phase 3: Memory & Persistence
**Goal**: The bot remembers its identity, owner, and world progression across restarts via better-sqlite3, with compaction timing decided by the personality LLM at semantic boundaries.
**Depends on**: Phase 2
**Requirements**: MEM-01, MEM-02, MEM-03, MEM-04, MEM-05
**Success Criteria** (what must be TRUE):
  1. Recent events and chat accumulate in a rolling in-session context window feeding the personality LLM.
  2. After a restart, the bot recognizes its owner by player UUID and references prior shared history in conversation.
  3. The personality LLM itself decides when to compact session context to long-term memory (at task-sequence boundaries), not a mechanical timer.
  4. Long-term memory records world progression (builds, exploration, accomplishments) and surfaces it when contextually relevant.
  5. The SQLite store uses atomic writes and enforces a hard size cap with compaction — the DB does not grow unbounded under long play sessions.
**Plans**: TBD

### Phase 4: Electron GUI & Packaging
**Goal**: A non-technical user can double-click an installer, fill in a setup form, and press Start to run Sei — with all errors explained in plain English and native modules working in the packaged build.
**Depends on**: Phase 3
**Requirements**: GUI-01, GUI-02, GUI-03, GUI-04, GUI-05, PKG-01, PKG-02, PKG-03
**Success Criteria** (what must be TRUE):
  1. A non-technical user completes setup (server IP/port, API key stored via OS keychain, personality name/backstory/tone) in the Electron GUI without editing any files.
  2. Start/Stop controls a utilityProcess-hosted bot, and a live log viewer streams bot activity, LLM decisions, and errors in real time.
  3. Every user-facing error includes a plain-English explanation and an action hint ("Check your server address", "Start Ollama", etc.).
  4. `electron-builder` produces a signed .dmg (macOS) and .exe installer (Windows) with better-sqlite3 rebuilt for the bundled Electron ABI via `@electron/rebuild`.
  5. Packaged builds are validated on clean VMs with no dev environment before release.
**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Bot Substrate | 3/3 | Complete | 2026-04-24 |
| 2. Two-Layer LLM Loop | 0/0 | Not started | - |
| 3. Memory & Persistence | 0/0 | Not started | - |
| 4. Electron GUI & Packaging | 0/0 | Not started | - |

## Coverage

- v1 requirements: 36 total
- Mapped: 36 / 36
- Orphans: 0

---
*Last updated: 2026-04-24 after Phase 1 plan 01 execution*
