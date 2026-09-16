# v0.6.5-beta.1 (draft release notes)

Beta channel (Advanced updates on). Publish as a GitHub PRE-RELEASE, not a draft; pass this file as `--notes-file`.

## What's new in 0.6.5-beta.1
- Stardew Valley: launch your companion onto your farm as a visible helper who walks, works, fights, and talks beside you (Play together > Stardew Valley; Sei installs SMAPI and its helper mod for you)
- Don't Starve Together: launch your companion into your hosted world as a survivor she picks for herself (Play together > Don't Starve Together; one companion per world)
- Game support files download on first launch instead of shipping in the installer, Minecraft included, so the app is about a third smaller
- Settings has one Games group for Minecraft, Stardew Valley, and Don't Starve Together
- Minecraft: pick the version for the Sei profile in the setup list; one "Sei <version>" profile per version, so an old world and a new one can coexist
- Each game's dashboard now looks like that game's HUD: parchment and vitals badges for Don't Starve, the wooden menu frame for Stardew
- Companions can look things up: search the web and read pages from chat, on calls, and in every game, and say so before they look; game companions ask their own wiki first
- Card image: regenerate a companion's portrait up to 3 times and switch between up to 8 saved versions
- Includes every fix from 0.6.1 through 0.6.4 (Ollama and local mode, local voices, the China mirror, the updater)

## Known gaps in this beta
- macOS: adding the Don't Starve Together helper needs the App Management permission for Sei (the setup step opens System Settings)
- Don't Starve Together: the helper must be in the game before the game starts (quit and reopen the game once after setup)
- Stardew Valley and Don't Starve Together: in-game typed chat, voice routing, combat, and a second companion are not yet verified live
