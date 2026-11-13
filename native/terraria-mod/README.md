# Sei companion mod for Terraria (tModLoader)

`SeiCompanion/` is a tModLoader 1.4.4 mod (C#, net8.0) that lets the Sei
desktop app put an AI companion into the player's Terraria world. The mod has
no AI in it: the Sei bot drives it over a localhost WebSocket (see
`PROTOCOL.md`), and everything that has to be fast (walking, jumping,
combat timing, the heal and retreat reflexes) runs inside the mod at 60 Hz.

The companion is a server-owned `ModNPC` drawn as a player through the
vanilla player renderer (hair, skin, clothes from the app; armour and the
held weapon from what she equipped). A real `Player` in a free slot is not an
option: the server deactivates any player slot that has no client behind it
within a few ticks.

Layout:

- `SeiMod.cs`: lifecycle; starts the bridge and loads `link.json`.
- `Link/`: `HttpListener` server (`GET /hello`, `/ws`), sessions, the
  game-thread queue, `link.json` (port, token).
- `Systems/`: the companion registry, chat hook, world alerts (`Events.cs`),
  bag persistence in the world file.
- `Body/`: the NPC, the puppet renderer, the bag, A* over tiles (`Nav.cs`),
  the motor (steer, jump, drop through platforms, doors), combat and the
  survival reflexes.
- `Actions/`: the verbs (`Verbs.cs`) and the tile helpers they share.
- `Observe/`: the observation JSON.
- `Dev/`: developer frames for the headless test harness (only answered
  when `link.json` sets `devCommands`; the app never does).

## Building

Needs the .NET 8 SDK and a tModLoader install (the Steam app, or the
release zip from github.com/tModLoader/tModLoader). From the repo root:

    scripts/build-terraria-mod.sh

It downloads tModLoader into `native/terraria-mod/.tml` when no install is
given (`TML_DIR=...`), builds, and copies `SeiCompanion.tmod` to
`assets/terraria-mod/`, which the game pack carries.

`NavTests/` is a plain console program that checks the path finder against
ASCII maps without the game: `dotnet run --project NavTests`.

## Headless server

The tModLoader dedicated server runs on Linux without a client. It only runs
world updates while a client is connected, so `link.json` can set
`headlessTick: true` (development only) to tick the world from the server's
own loop. With that, the companion walks, fights, mines and crafts on a
headless server and the harness can drive every verb.

## Terms

The mod is installed by the Sei app as a local mod (sideloaded into the
player's `tModLoader/Mods` folder). It is not published to the Steam
Workshop.
