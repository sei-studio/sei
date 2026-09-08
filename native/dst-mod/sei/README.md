# Sei companion helper for Don't Starve Together

A server-only mod that lets a [Sei](https://sei.gg) companion join the
world you host as a real survivor: it walks beside you, gathers, builds,
fights and talks through the game's chat, driven by Sei's brain running on
your computer. Friends who join your world need nothing installed.

The mod does nothing on its own. Every two seconds the master simulation
sends a small heartbeat to the Sei app on `127.0.0.1:<port>` (default
`27424`); when Sei asks, the mod spawns a vanilla survivor prefab, gives it
the companion's name, and connects it to the brain over localhost HTTP
(`../PROTOCOL.md`). Stop the companion in Sei, or close the world, and the
body drops its inventory and disappears. Nothing about it is written to your
save.

## Install

Sei installs this for you: it copies the folder into the game's local mods
directory and force-enables it through `mods/modsettings.lua`, re-applying
that on every launch because game updates and Steam's "verify files"
rewrite the file.

By hand, for development:

1. Copy this folder to `<Don't Starve Together>/mods/sei/` (macOS:
   `dontstarve_steam.app/Contents/mods/sei/`).
2. Add `ForceEnableMod("sei")` and `DisableLocalModWarning()` to
   `<Don't Starve Together>/mods/modsettings.lua`, or enable "Sei companion"
   from the Mods tab of the Host Game screen.
3. Host a world. The game log prints `[sei] helper active, discovery port
   27424`.

Options (Mods tab): `Sei discovery port` must match the port in Sei's
settings; `Chat announcements` also prints the companion's lines into the
chat log, not only as a speech bubble.

## Layout

```
modinfo.lua                 api_version 10, dst_compatible, all_clients_require_mod = false
modmain.lua                 server-only guard, Networking_Say chat capture, the /hello heartbeat, summon
scripts/brains/seibrain.lua the behaviour tree: safety layer, flee, attack, goto, command slot, follow
scripts/sei/companion.lua   spawn / despawn of the survivor body
scripts/sei/perception.lua  3 Hz delta-compressed observations (POST /obs, <= 8 KB)
scripts/sei/commands.lua    the GET /cmd long-poll and the command executor (gather, build, containers, ...)
scripts/sei/events.lua      chat / attacked / death / dark / phase / actionfailed -> POST /event
scripts/sei/speak.lua       talker:Say + optional TheNet:Announce
scripts/sei/survivors.lua   per-survivor mechanics as data (diet, wetness, frailty, ...)
scripts/sei/net.lua         TheSim:QueryServer wrappers, token, error reporting
scripts/sei/util.lua        JSON / URL helpers
```

`luacheck` (config in `../.luacheckrc`) runs over the mod in CI:
`luacheck native/dst-mod/sei`.

## Credits

Adapted from FAtiMA-DST (MIT, hineios), DST-AICompanion (MIT, Hansae) and
the Chat Announcements mod (CC0, gyroplast); see `../THIRD_PARTY_NOTICES.md`.
Don't Starve Together is a trademark of Klei Entertainment; this mod is not
affiliated with Klei.

## License

MIT, see `LICENSE`.
