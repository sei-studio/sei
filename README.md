# Sei

A Minecraft AI companion that feels like a real character — remembers you, reacts to the world, and acts with personality.

> **Status: WIP.** Right now Sei acts on instinct like a child — she follows you, eats when hungry, and attacks when attacked. No brain yet.

## Todo

- [x] **Phase 1 — Bot Substrate:** mineflayer connection, Zod action registry, event-sourced FSM, reflex behaviors (follow / chat / combat / auto-eat / auto-respawn)
- [ ] **Phase 2 — Two-Layer LLM Loop:** Haiku 3 personality + Ollama Qwen movement, closed-action dispatch, recursion cap
- [ ] **Phase 3 — Memory & Persistence:** SQLite event log, LLM-directed semantic compaction, cross-session memory
- [ ] **Phase 4 — Electron GUI & Packaging:** three-process Electron app (main ↔ renderer ↔ utilityProcess), signed installers

## Setup

```bash
npm install
cp config.example.json config.json
# edit config.json — set host, port, owner_username, minecraft_version
npm start
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) and `.planning/` for design docs.
