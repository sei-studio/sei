# Requirements: Sei

**Defined:** 2026-04-24
**Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.

## v1 Requirements

### Bot Connection

- [ ] **CONN-01**: Bot connects to a Minecraft server (IP + port) using mineflayer with auto-detected server version
- [ ] **CONN-02**: Bot authenticates with a Microsoft account via OAuth device-code flow
- [ ] **CONN-03**: Bot auto-reconnects after disconnect with user-visible status update
- [ ] **CONN-04**: Bot connection errors are translated to plain-English messages in the GUI log

### Bot Behavior

- [ ] **BOT-01**: Bot follows its owner and stays within proximity range
- [ ] **BOT-02**: Bot responds to in-game chat when directly addressed or nearby (within configurable range)
- [ ] **BOT-03**: Bot auto-eats food when hungry without LLM involvement
- [ ] **BOT-04**: Bot defends itself when attacked (combat reflex, not LLM-driven)
- [ ] **BOT-05**: Bot navigates to targets via mineflayer-pathfinder with wall-clock timeout on every call
- [ ] **BOT-06**: Bot recovers gracefully from pathfinder hangs ("couldn't reach" as first-class return)

### LLM Orchestration

- [ ] **LLM-01**: Personality LLM (Haiku 3) runs on an event-driven loop: triggered by chat message, movement completion, significant world events (attacked, hungry, mob nearby, inventory change), with 10s idle fallback
- [ ] **LLM-02**: Personality LLM sends natural language movement instructions to movement LLM; never generates code or coordinates
- [x] **LLM-03**: Movement LLM (Ollama Qwen 2.5) calls mineflayer functions from a closed Zod-typed action registry
- [ ] **LLM-04**: Orchestrator enforces hard recursion cap (max 5 hops per event) to prevent runaway loops
- [ ] **LLM-05**: Events are debounced (500ms) to prevent storm of triggers from a single game situation
- [ ] **LLM-06**: Personality LLM rate-limited to 30 calls/min with token-bucket; excess events queued or dropped
- [ ] **LLM-07**: One outstanding movement action tracked at a time; new instruction cancels previous via AbortController
- [x] **LLM-08**: System degrades gracefully when Ollama is unavailable (API-only fallback using Haiku for both layers)

### Personality

- [x] **PERS-01**: Bot has a configurable name used in-game and consistently in all speech
- [x] **PERS-02**: Bot has a configurable backstory that informs its personality responses
- [x] **PERS-03**: Bot has a configurable tone preset (friendly / sarcastic / serious / curious)
- [ ] **PERS-04**: Bot makes rate-limited proactive observations when idle near owner (10s fallback loop)
- [x] **PERS-05**: Bot's personality prompt is stable across sessions and forms the leading cached prefix for Anthropic prompt caching

### Memory

- [ ] **MEM-01**: Bot maintains a rolling in-session context window of recent events and chat
- [ ] **MEM-02**: Bot compacts session context to long-term memory at LLM-chosen semantic boundaries (e.g. after completing a task sequence, not mid-task) — compaction timing is decided by the personality LLM, not a mechanical timer
- [ ] **MEM-03**: Long-term memory persists owner identity and relationship across restarts (keyed by player UUID, not username)
- [ ] **MEM-04**: Long-term memory records world progression (what has been built, explored, accomplished)
- [ ] **MEM-05**: Memory store uses better-sqlite3 with atomic writes and a hard size cap with compaction

### GUI

- [ ] **GUI-01**: Electron app presents a setup form: server IP/port, Anthropic API key (stored in OS keychain via safeStorage), personality fields
- [ ] **GUI-02**: Start/Stop button launches and terminates the bot process (Electron utilityProcess)
- [ ] **GUI-03**: Live log viewer displays bot activity, LLM decisions, and errors in real time
- [ ] **GUI-04**: Personality form: name, backstory text area, tone preset selector
- [ ] **GUI-05**: All user-facing errors include a plain-English explanation and an action hint (e.g. "Check your server address")

### Packaging

- [ ] **PKG-01**: App packages as a bundled .dmg (macOS) and .exe installer (Windows) via electron-builder
- [ ] **PKG-02**: Native modules (better-sqlite3) rebuild correctly for the bundled Electron ABI via @electron/rebuild
- [ ] **PKG-03**: Packaged builds tested on clean VMs (no dev environment) before each release

## v2 Requirements

### Visual Context

- **VIS-01**: OS screenshot of Minecraft window captured and sent to personality LLM as visual context
- **VIS-02**: macOS screen recording permission preflight with user guidance
- **VIS-03**: Graceful text-only fallback when screenshot unavailable or permission denied
- **VIS-04**: Requires Haiku 3.5 (vision-capable) — model upgrade from v1 Haiku 3

### Advanced GUI

- **GUI-V2-01**: Ollama status indicator with install guidance for users without local model
- **GUI-V2-02**: Model source selector: local Ollama or API-only mode
- **GUI-V2-03**: Auto-updater for app distribution

### Memory Expansion

- **MEM-V2-01**: Per-player relationship memory for non-owner players (with forgetting/privacy policy)
- **MEM-V2-02**: Vector/semantic retrieval for long-term memory lookup

## Out of Scope

| Feature | Reason |
|---------|--------|
| LLM-generated code / JS execution | Security risk (RCE); local 9B model unreliable for codegen |
| Long-horizon autonomous goals | Bot wanders off; core value is companion, not autonomous agent |
| Block-breaking without explicit instruction | Griefing risk; preserve server trust |
| Auto-PvP against players | Social/trust harm |
| Raw system prompt editing in GUI | Non-technical users; power users can edit config files |
| Voice/TTS | Out of scope for v1 |
| Multi-bot instances | Single companion per app for v1 |
| LLM-chosen coordinates | Hallucination risk; movement LLM calls actions, never raw coords |
| Running JS from chat input | Code injection risk |
| Plaintext API key storage | Replaced by OS keychain (safeStorage) |
| Screenshot/vision | Deferred to v2; needs Haiku 3.5, macOS permission UX, text baseline first |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONN-01 | Phase 1 | Pending |
| CONN-02 | Phase 1 | Pending |
| CONN-03 | Phase 1 | Pending |
| CONN-04 | Phase 1 | Pending |
| BOT-01 | Phase 1 | Pending |
| BOT-02 | Phase 1 | Pending |
| BOT-03 | Phase 1 | Pending |
| BOT-04 | Phase 1 | Pending |
| BOT-05 | Phase 1 | Pending |
| BOT-06 | Phase 1 | Pending |
| LLM-01 | Phase 2 | Pending |
| LLM-02 | Phase 2 | Pending |
| LLM-03 | Phase 2 | Pending |
| LLM-04 | Phase 2 | Pending |
| LLM-05 | Phase 2 | Pending |
| LLM-06 | Phase 2 | Pending |
| LLM-07 | Phase 2 | Pending |
| LLM-08 | Phase 2 | Pending |
| PERS-01 | Phase 2 | Pending |
| PERS-02 | Phase 2 | Pending |
| PERS-03 | Phase 2 | Pending |
| PERS-04 | Phase 2 | Pending |
| PERS-05 | Phase 2 | Pending |
| MEM-01 | Phase 3 | Pending |
| MEM-02 | Phase 3 | Pending |
| MEM-03 | Phase 3 | Pending |
| MEM-04 | Phase 3 | Pending |
| MEM-05 | Phase 3 | Pending |
| GUI-01 | Phase 4 | Pending |
| GUI-02 | Phase 4 | Pending |
| GUI-03 | Phase 4 | Pending |
| GUI-04 | Phase 4 | Pending |
| GUI-05 | Phase 4 | Pending |
| PKG-01 | Phase 4 | Pending |
| PKG-02 | Phase 4 | Pending |
| PKG-03 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 36 total
- Mapped to phases: 36
- Unmapped: 0

---
*Requirements defined: 2026-04-24*
*Last updated: 2026-04-24 after roadmap creation (traceability populated)*
