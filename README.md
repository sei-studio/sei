# Sei

**Sei is a framework for running custom personas in Minecraft.** You name the character, describe their personality, and Sei runs the bot loop — Anthropic Haiku for personality and decisions, local Ollama Qwen (or API-only fallback) for movement, all wired through `mineflayer`. The character lives, reacts, follows you around, and remembers across sessions.

> **Status: WIP, dev-mode only.** A friendly Electron GUI is on the roadmap (Phase 4). For now there's a small CLI for onboarding.

## Quickstart

```bash
git clone https://github.com/oue2x2/sei.git
cd sei
npm install

# first run: onboarding (asks for your MC username, names the character, picks a tone, etc.)
npx sei
# or globally: npm link  →  sei

# in Minecraft: open a world, click "Open to LAN"
# then:
npx sei start
```

`npx sei config` re-runs onboarding any time. Your Anthropic API key can be passed during onboarding or set via `ANTHROPIC_API_KEY` in your environment.

## Progress

- [x] **Phase 1 — Bot Substrate.** mineflayer connection, Zod-typed action registry, event-sourced FSM, reflex behaviors (follow / chat / combat / auto-eat / auto-respawn).
- [x] **Phase 2 — Two-Layer LLM Loop.** Haiku personality + Ollama Qwen movement, closed-action dispatch, recursion cap, single-flight loop with player-interrupt repair.
- [x] **Phase 2.1 — Expanded Actions & Game State.** Inventory / surroundings / position snapshot, container interaction, attack/follow hunting loop, exposure-filtered nearby blocks.
- [ ] **Phase 3 — Memory & Persistence.** OWNER.md identity store, DIARY.md with LLM-directed semantic compaction, cross-session memory.
- [ ] **Phase 4 — Electron GUI & Packaging.** Three-process Electron app (main ↔ renderer ↔ utilityProcess) with onboarding UI, signed installers for macOS/Windows. *(GUI incoming — replaces the current CLI for non-technical users.)*

## Credits

Built on the shoulders of these projects:

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — the Minecraft bot library that does all the heavy lifting.
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — A* navigation.
- [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) — combat helpers.
- [mineflayer-auto-eat](https://github.com/link-discord/mineflayer-auto-eat) — keeps the bot fed.
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — Haiku personality layer.
- [ollama-js](https://github.com/ollama/ollama-js) — local Qwen movement layer.
- [Zod](https://zod.dev/) — runtime schema for the closed action registry.

## Contributing

Sei is **closed to external PRs at the moment** while the framework stabilizes through Phase 4. If you want to chat about it — bugs, ideas, custom personas, anything — reach out on X: [@oue2x2](https://x.com/oue2x2).
