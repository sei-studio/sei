# Sei companion for Factorio

`sei-companion/` is a Factorio 2.1 mod that gives your Sei companion a body in
your game: a real character who walks, mines, crafts, builds and fights under
normal player rules. The Sei app is her brain; the mod is the body and its
reflexes (keep up with you, shoot back, back off when hurt, come back after
dying). Every choice about what to do next is made by the app's language
model; the mod only runs the verbs it asks for.

- License: MIT (`sei-companion/LICENSE`). Third-party notices:
  `sei-companion/THIRD_PARTY_NOTICES.md`.
- Wire protocol: `PROTOCOL.md`.
- Not on the mod portal: Sei installs it into your Factorio `mods/` folder and
  starts Factorio with the `--enable-lua-udp` option the link needs.

## Layout

| file | role |
|---|---|
| `control.lua` | event wiring, the `/sei` console command, the `sei_companion` remote interface |
| `data-final-fixes.lua` | the `sei-companion` character prototype (a copy of the player character) |
| `scripts/link.lua` | UDP framing, reply cache, send queue |
| `scripts/api.lua` | the ops (hello, spawn, poll, observe, cmd, ...) |
| `scripts/body.lua` | spawn, leave, say, death and respawn, the event feed |
| `scripts/reflex.lua` | follow, defend, retreat |
| `scripts/movement.lua` | walking with the game's pathfinder |
| `scripts/verbs.lua` | the job verbs and the handle registry |
| `scripts/observe.lua` | the observation the app turns into her snapshot |

## Tests

- `lua native/factorio-mod/tests/run.lua`: offline tests of the pure parts
  (framing, reply cache, geometry, text). Also run by vitest
  (`src/bot/adapter/factorio/luaMod.test.js`) when `lua` is installed.
- `node scripts/factorio-headless-harness.mjs [--registry]`: every verb and
  reflex against a real Factorio 2.1 headless server (download the free
  headless build into `~/.cache/sei-factorio/<version>/`).
- `node scripts/factorio-brain-session.mjs --minutes 15`: the real bot and
  model in a scripted session, with a token report. Uses the dev test key.
