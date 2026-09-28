# sei-autolan

A tiny Fabric mod (MIT) that opens a singleplayer world to LAN once it has
loaded, so a Sei companion can join without the player pressing Esc > Open to
LAN. It uses the world's own game mode and cheats setting, a free port, and
posts the vanilla "Local game hosted on port N" line plus "(Sei: world opened
for your companion)". It does nothing on multiplayer servers or Realms (no
integrated server there), and leaves a world the player already opened alone.

No Fabric API. One mixin: `Minecraft.tick()` TAIL calls `SeiAutoLan.onClientTick`,
which waits 2 s after the player is in the world, then publishes once per
integrated server. Any error disables the mod for the session.

## Layout

- `src/main/java/gg/sei/autolan/`: the mod and its mixin, written against
  Mojang's official names.
- `compat/<variant>/java/gg/sei/autolan/Compat.java`: the per-era calls
  (publish, chat components, chat HUD, window title). One is compiled in per
  build (`-Pcompat=`):

  | variant | releases | what differs |
  |---|---|---|
  | `v1_14` | 1.14.4 - 1.15.2 | world data from the overworld level, `TextComponent`, no `updateTitle` |
  | `v1_16` | 1.16 - 1.18.2 | `getWorldData().getAllowCommands()`, `TextComponent` |
  | `v1_19` | 1.19 - 1.20.4 | `Component.literal` / `translatable` |
  | `v1_20_5` | 1.20.5 - 1.21.11 | `isAllowCommands()` |
  | `v26_1` | 26.1 - 26.1.2 | unobfuscated; `addClientSystemMessage` |
  | `v26_2` | 26.2 - 26.3 | `publishServer(MultiplayerScope.LAN, port)`, chat under `gui.hud` |

- `versions.json`: every stable release compiled and checked, with its
  variant, plus `ceiling` (exclusive upper bound of the newest jar).

## Building

```
npm run build:autolan-mod                 # full matrix, writes assets/minecraft-autolan/
node scripts/build-minecraft-autolan-mod.mjs --only 1.21.1,26.2   # check only
```

Needs JDK 25 (`apt install openjdk-25-jdk-headless`, or set `JAVA_HOME`) and
network for the first run (Loom downloads each Minecraft version). The script
builds every release, groups consecutive releases whose compiled classes are
identical (same constant pool, class version and mixin level, so they link
against Minecraft the same way), and writes one jar per group with
`fabric.mod.json` declaring `>=first <nextGroupFirst`, plus `manifest.json`
(range + sha256 per jar) that `src/main/mcAutoLan.ts` installs from. The jars
are committed; electron-builder ships them as `resources/minecraft-autolan/`.

Obfuscated builds (up to 1.21.11) must remap the mixin target to an
intermediary `method_NNNN` name; 26.x builds must find `public void tick()` in
the Minecraft jar. The script fails otherwise.

## Adding a Minecraft release

1. Add it to `versions.json` (ascending) with the variant it should build
   with, and move `ceiling` past it.
2. `npm run build:autolan-mod`. If it does not compile, add a new
   `compat/<variant>` for the changed API.
3. Commit `assets/minecraft-autolan/`. The app's startup sync puts the new jar
   into every Sei profile on the next launch.
