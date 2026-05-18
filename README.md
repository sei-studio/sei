# Sei

An AI player brain for Minecraft. Sei drives a `mineflayer` bot through an LLM loop wired to a closed action registry over the live game state. A single Haiku 4.5 model handles personality, decisions, and movement in one combined call.

The goal is a general-purpose AI brain that can play video games. A custom personality layer (roleplay as characters of your choosing) is incoming.

> WIP, dev-mode only.

## Quickstart

```bash
git clone https://github.com/oue2x2/sei.git   # download the source
cd sei                                        # enter the project directory
npm i                                         # install dependencies (mineflayer, anthropic SDK, etc.)
npm link                                      # register `sei` as a global command on your PATH
sei                                           # run onboarding (writes config.json + memory/OWNER.md)
```

Then open a Minecraft world, click "Open to LAN", and run `sei start`. Re-run onboarding any time with `sei config`.

## Progress

- [x] Bot skeleton — mineflayer connection, Zod-typed action registry, event-sourced FSM, reflex behaviors (follow / chat / combat / auto-eat / auto-respawn).
- [x] Bot brain — LLM loop over live game state (inventory, surroundings, position, exposure-filtered nearby blocks) with a closed action library. Recursion cap, single-flight loop with player-interrupt repair.
- [x] Memory — `memory/OWNER.md` identity store, `memory/DIARY.md` with LLM-directed semantic compaction, cross-session memory.
- [x] CLI — onboarding and start commands.
- [ ] Custom personas and skins.
- [ ] Real in-game vision.
- [ ] GUI — Electron app with onboarding UI and signed installers, so the wider non-technical Minecraft community can use it.

## Custom skins

Sei can give each character a custom Minecraft skin and a custom in-game
username, visible inside your own Minecraft world. The flow is:

1. Open the Sei app. On first launch the setup wizard runs automatically.
   (You can also re-run it later from Settings → "Re-run setup".)
2. The wizard scans your Minecraft installs (vanilla launcher + CurseForge
   instances) and installs [CustomSkinLoader](https://github.com/xfl03/MCCustomSkinLoader)
   into each one you select. For vanilla installs the wizard also installs
   [Fabric Loader](https://fabricmc.net/) for you using Minecraft's own
   bundled Java runtime (no need to install Java yourself).
3. On the character page, pick a skin: drop a 64×64 PNG, or search a real
   Minecraft username. Sei previews the skin in 3D before you apply it.
4. The next time you launch Minecraft, pick the new "fabric-loader" profile
   from the launcher dropdown (or just launch your CurseForge instance
   normally). When you summon a Sei character into your LAN world, the
   bot will appear with the chosen skin and username.

**About visibility on plain vanilla LAN:** custom skins are rendered
client-side by CustomSkinLoader, so the host (you) sees them correctly.
Friends connecting to your LAN world will see the bot wearing the default Minecraft skin unless they also install CustomSkinLoader themselves.
This is a vanilla Minecraft constraint that no purely-server-side
approach can work around — see
`.planning/phases/09-implement-custom-bot-skins-via-customskinloader-mod-first-la/RESEARCH.md`
for the full analysis.

The skin file itself never leaves your computer: Sei runs a tiny loopback
HTTP server on `127.0.0.1` that CustomSkinLoader queries for skins. No
third-party servers, no signed-texture pipeline, no Mojang dependency
once a skin is applied.

## Credits

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft bot library.
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — A* navigation.
- [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) — combat helpers.
- [mineflayer-auto-eat](https://github.com/link-discord/mineflayer-auto-eat) — auto-eat.
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — Haiku LLM brain.
- [Zod](https://zod.dev/) — runtime schema for the closed action registry.

## Contributing

Closed to external PRs while the framework stabilizes. If you are interested, reach out on X: [@oue2x2](https://x.com/oue2x2).
