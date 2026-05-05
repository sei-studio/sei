# Sei

An AI player brain for Minecraft. Sei drives a `mineflayer` bot through an LLM loop wired to a closed action registry over the live game state. A single LLM handles personality, decisions, and movement.

A two-layer variant with a larger API model for personality plus a local Ollama model for movement is in the codebase from the original design but currently inactive. Everything runs through the single API model (Haiku 4.5) path.

The goal is a general-purpose AI brain that can play video games. A custom personality layer (roleplay as characters of your choosing) is incoming.

> Status: WIP, dev-mode only.

## Quickstart

```bash
git clone https://github.com/oue2x2/sei.git
cd sei
npm i
npm link
sei
```

Then open a Minecraft world, click "Open to LAN", and run `sei start`. Re-run onboarding any time with `sei config`.

## Progress

- [x] Bot skeleton — mineflayer connection, Zod-typed action registry, event-sourced FSM, reflex behaviors (follow / chat / combat / auto-eat / auto-respawn).
- [x] Bot brain — LLM loop over live game state (inventory, surroundings, position, exposure-filtered nearby blocks) with a closed action library. Haiku-only path active; two-layer Haiku + Ollama Qwen variant is wired but unused. Recursion cap, single-flight loop with player-interrupt repair.
- [x] Memory — `memory/OWNER.md` identity store, `memory/DIARY.md` with LLM-directed semantic compaction, cross-session memory.
- [x] CLI — onboarding and start commands.
- [ ] Custom personas and skins.
- [ ] Real in-game vision.
- [ ] GUI — Electron app with onboarding UI and signed installers, so the wider non-technical Minecraft community can use it.

## Credits

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft bot library.
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — A* navigation.
- [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) — combat helpers.
- [mineflayer-auto-eat](https://github.com/link-discord/mineflayer-auto-eat) — auto-eat.
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — Haiku personality layer.
- [ollama-js](https://github.com/ollama/ollama-js) — local Qwen movement layer.
- [Zod](https://zod.dev/) — runtime schema for the closed action registry.

## Contributing

Closed to external PRs while the framework stabilizes. If you are interested, reach out on X: [@oue2x2](https://x.com/oue2x2).
