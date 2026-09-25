# Sei companion mod: wire protocol (v1)

The mod (`SeiCompanion`, C#, in the Stardew Valley process) is the SERVER.
The Sei bot (`src/bot/adapter/stardew/`, Node) is the CLIENT. Everything is
loopback: `http://localhost:<port>/` (localhost, not the IP: it is the one
prefix Windows lets the mod bind without a URL ACL, and http.sys matches the
Host header). The port and the token live in the mod's
`config.json`, which the Sei app's installer writes and its watcher reads.
`src/shared/stardewIpc.ts` mirrors every shape below in TypeScript + zod.

## HTTP

### `GET /hello` (no auth)

Liveness for the app's watcher (polled every 3 s). Never touches game state
that cannot be read off-thread.

```json
{
  "mod": "SeiCompanion",
  "version": "0.1.0",
  "protocol": 1,
  "game": "1.6.15",
  "smapi": "4.5.2",
  "port": 27431,
  "save": {
    "loaded": true,
    "farmName": "Sunny",
    "uniqueId": "123456789",
    "day": 3,
    "season": "spring",
    "year": 1,
    "time": 1330,
    "isHost": true,
    "companions": ["Sui"]
  }
}
```

`save.loaded: false` means the game is on the title screen (the app shows
"game running, no save loaded").

### `GET /ws?token=<token>` → WebSocket

Also accepts `Authorization: Bearer <token>`. A missing or wrong token is an
HTTP `401` before the upgrade. One socket = one bot = at most one companion
body.

## Frames

Text frames, one JSON object per line (NDJSON; several lines per frame are
allowed). Every client frame carries `t` (type) and, for anything that
expects an answer, `id` (any string; the answer echoes it).

### Server → client, unsolicited

| `t` | fields | when |
|---|---|---|
| `welcome` | `protocol`, `session`, `hello` (the /hello payload) | first frame after connect |
| `save` | the `/hello` `save` object | save loaded, day started, returned to title |
| `spawned` | `name`, `location`, `x`, `y` | after a successful `spawn` |
| `despawned` | `reason` | the body left the world (title screen, disconnect grace expired, `despawn`) |
| `obs` | `obs` (Observation below) | `ObserveHz` times per second while spawned (default 2) |
| `progress` | `id`, `text` | a running command reports a step |
| `chat` | `from`, `text`, `kind` (`public`/`private`), `farmerId`, `isHost`, `sameLocation` | a player typed in the game chat |
| `damaged` | `attacker`, `attackerKind`, `damage`, `health`, `maxHealth`, `retaliated`, `retreating` | a monster hit the body (at most once per second) |
| `survival` | `kind` (`retreat` / `ate` / `bedtime`), plus `attacker`/`detail`/`time` | a reflex acted on its own |
| `death` | `cause`, `where`, `location` | the body was knocked out; it wakes at the farm with half health |
| `day_started` | `day`, `season`, `year`, `weather` | a new day |
| `night_soon` | `time` | 10 PM |
| `warped` | `location`, optional `reason`, `mineLevel` | the body changed map |
| `error` | `message` | a frame could not be parsed |

### Client → server (each answered by a `result`)

| `t` | fields | notes |
|---|---|---|
| `ping` | | answered off-thread with `{save}` |
| `spawn` | `name`, `appearance?` | creates the body beside the host. Errors: `NO_SAVE`, `NOT_HOST`, `FARMHAND_NO_MOD`, `NAME_TAKEN`, `NO_ART` (in `result.error`). A reconnecting bot that spawns with the same name inside the disconnect grace ADOPTS the existing body (an `appearance` sent with that spawn is applied to it). `appearance` is optional, see Appearance below. |
| `despawn` | | removes the body now |
| `observe` | | `result.obs` carries a fresh Observation |
| `say` | `text` | chat box line `Name: text` (if `AnnounceInChat`) + speech bubble |
| `pause` | `paused` | freezes the body (reflexes off, controller dropped, commands refused) |
| `cmd` | `name`, `args` | runs a verb; the `result` arrives on COMPLETION (seconds to a minute for a `gather`); `progress` frames may precede it |
| `cancel` | `target` (the `cmd`'s `id`, or omitted for whatever runs) | aborts the running verb; its `result` reads `aborted` |
| `loadFarm` | `slot?` (save folder name; default the newest) | DEVELOPER frame (same gate): load a save from the title screen. |
| `devTime` | `time` (600..2600) | DEVELOPER frame (same gate): set the game clock. |
| `devSleep` | | DEVELOPER frame (same gate): the host goes to bed (the game saves and the next day starts). |
| `devDebris` | | DEVELOPER frame (same gate): `result.debris` lists the item debris lying in the body's location. |
| `devAppearance` | | DEVELOPER frame (same gate): `result.appearance` is `{custom, farmerLook, requested, rejected, applied, sprite}`: the clamped look from the spawn frame, the fields the game refused, the values read back from the shadow farmer, and the sprite frame / facing / base texture in use. |
| `devState` | | DEVELOPER frame (same gate): `result.state` names the menu, game mode, event and world state, for a driver with no screen. |
| `newFarm` | `farmer?`, `farm?`, `favoriteThing?` | DEVELOPER frame, refused unless config.json has `DevCommands: true` (the app never sets it): from the title screen, starts a new game through the game's own character menu and skips the arrival cutscene. For a test driver with no hands on the game window. |

### Appearance (the optional `spawn.appearance` object)

The companion is drawn as a farmer dressed through the game's own character
creator methods. Every field is optional and checked against what the running
game accepts; a field that is missing, mistyped or out of range keeps the
default for that field, and a frame with no `appearance` gets the whole
default look. Protocol version is unchanged: an older mod ignores the field.

| field | type | accepted | default |
|---|---|---|---|
| `gender` | string | `"female"`, `"male"` | `"female"` |
| `skin` | int | 0..23 | 0 |
| `hair` | int | any index in `Farmer.GetAllHairstyleIndices()` (vanilla: 0..55, 100..122) | 47 |
| `hairColor`, `eyeColor`, `pantsColor` | string | `"#rrggbb"` | brown, brown, blue |
| `shirt` | int | its string form must be a key of `Data/Shirts` (the creator offers 1000..1111) | 1005 |
| `pants` | int | its string form must be a key of `Data/Pants` (the creator offers 0..3) | 0 |
| `accessory` | int | -1 (none) .. 29 | -1 |

`FarmerLook: false` in config.json turns the farmer draw off and the body uses
the shared placeholder sprite, as before.

### `result`

```json
{ "t": "result", "id": "<echo>", "ok": true, "detail": "watered 12 crops (18/40 left in the can)", "...extra": "" }
```

`detail` is the string the model reads (the adapter returns it verbatim as
the tool result). `ok: false` carries the reason in `detail` and sometimes a
machine `error` code.

## Verbs (`cmd.name` / `cmd.args`)

Coordinates are TILES in the body's current map. `#N` handles come from the
latest Observation and stay valid ~90 s.

| name | args | does |
|---|---|---|
| `goTo` | `{x,y}` or `{target:"#N"}` or `{location:"Town", x?, y?}` | walk there; crosses maps through the warp graph |
| `come` | `{player?}` | walk to the player, across maps |
| `follow` | `{player?}` | trail the player until `unfollow` (background; answers at once). A commanded trip (`goTo`, `interact` on a door, `sleep`) to a map the player is not on puts following on hold (`followHold` in the observation) until the player leaves the map they were on or comes to the body; it no longer ends following. Following survives the night. |
| `unfollow` | | stop trailing |
| `till` | `{x,y}` | hoe a diggable tile |
| `water` | `{x,y}` (crop, or a water tile to refill) or `{count?}` for every dry crop nearby | watering can |
| `plant` | `{seed, x?, y?, count?}` | seeds or fertilizer onto tilled soil; no tile = nearest empty soil |
| `harvest` | `{x,y}` / `{target}` or nothing for every ready crop nearby | crops, fruit trees, forage, ready machines |
| `chop` | `{x,y}` / `{target:"#N"}` | axe a tree, stump, log or twig until it is gone |
| `mine` | `{x,y}` / `{target:"#N"}` | pickaxe a stone, ore node or boulder until it is gone |
| `gather` | `{kind: forage\|wood\|stone\|fiber\|debris, count?}` | loop: nearest matching target, walk, act, until `count` items (or targets for debris) |
| `attack` | `{target:"#N", times?}` | walk adjacent and swing `times` (default 5) |
| `fish` | `{x?, y?, casts?}` | stand by water, wait out a bite, catch |
| `eat` | `{item?}` | eat the named or best food |
| `equip` | `{item}` | hold an item |
| `place` | `{item, x, y}` | place an object (chest, scarecrow, machine input goes through `interact`) |
| `chest` | `{action: put\|take, item, count?, x?, y?, target?}` | move items with a chest |
| `buy` | `{item, qty?, shop?}` | buy from the shop the body is standing in, paid from its own wallet |
| `interact` | `{target:"#N"}` / `{x,y}` | warps and doors, mine ladders, chests (lists contents), machines (empties when ready), forage, villagers (faces them) |
| `sleep` | | walk home and lie down; the day ends when the player sleeps |

## Observation

```json
{
  "name": "Sui", "location": "Farm", "locationKind": "farm", "x": 62, "y": 18, "facing": "down",
  "stamina": 210, "maxStamina": 270, "health": 100, "maxHealth": 100, "exhausted": false, "gold": 500,
  "time": 1330, "timeText": "1:30 PM", "day": 3, "dayOfWeek": "Wed", "season": "spring", "year": 1,
  "weather": "sunny", "isDark": false, "daysPlayed": 3,
  "farm": {"crops": 24, "dryCrops": 12, "readyCrops": 0, "deadCrops": 0, "soil": 6, "twigs": 40, "weeds": 120, "stones": 80, "debris": 240, "bigClumps": 12, "grownTrees": 60, "shippingBinItems": 0},
  "host": {"name": "Ouen", "money": 500, "seeds": 0, "stamina": 270, "maxStamina": 270, "farmingLevel": 0, "mailWaiting": 1},
  "follow": "Ouen", "followHold": null, "paused": false, "sleeping": false, "inAction": null, "lastResult": "water: watered 12 crops",
  "inventory": [{"slot": 0, "id": "(T)Axe", "name": "Axe", "count": 1, "kind": "tool"}],
  "held": "Axe", "wateringCan": {"left": 18, "max": 40},
  "tiles": {
    "radius": 8,
    "crops": [{"x": 60, "y": 20, "name": "Parsnip", "ready": false, "watered": true, "dead": false, "stage": "2/5", "dist": 2}],
    "soil": [{"x": 61, "y": 20, "watered": false, "dist": 2}],
    "trees": [{"handle": "#4", "x": 70, "y": 12, "kind": "oak", "grown": true, "stage": 5, "dist": 9}],
    "rocks": [{"handle": "#5", "x": 66, "y": 19, "kind": "stone", "dist": 4}],
    "forage": [{"handle": "#6", "x": 58, "y": 24, "name": "Leek", "dist": 7}],
    "chests": [{"handle": "#7", "x": 64, "y": 14, "items": 3, "dist": 4}],
    "machines": [{"handle": "#8", "x": 65, "y": 14, "name": "Furnace", "ready": true, "minutes": 0, "holding": "Copper Bar", "dist": 5}],
    "ladders": [],
    "water": {"x": 71, "y": 30, "dist": 15},
    "counts": {"crops": 24, "dryCrops": 12, "readyCrops": 0, "twigs": 3, "weeds": 9, "stones": 5, "emptySoil": 6}
  },
  "entities": [{"handle": "#1", "kind": "player", "name": "Ouen", "x": 63, "y": 18, "dist": 1, "pinned": true},
               {"handle": "#2", "kind": "monster", "name": "Green Slime", "x": 50, "y": 10, "dist": 15, "health": 24, "maxHealth": 24}],
  "warps": [{"handle": "#3", "to": "BusStop", "x": 79, "y": 17, "dist": 17}],
  "player": {"name": "Ouen", "location": "Farm", "x": 63, "y": 18, "sameLocation": true, "dist": 1}
}
```

`farm` is the WHOLE Farm map (recomputed at most once a second) and `host`
the host farmer, so the bot can answer "what is the farm's next job" from
inside the house; they feed the first-fortnight progression frontier
(`src/bot/adapter/stardew/observers/progression.json`). Entity kinds:
`player`, `monster`, `villager`, `animal`, `pet`, `horse`, `child`,
`companion`. `stage` on a crop is `phase/phases`; `ready` is what
matters. Lists are nearest-first and capped, so an empty list means "none
within 8 tiles", not "none on the map".

## Lifecycle rules the client relies on

- The body leaves the world on `DayEnding` / `Saving` and comes back on
  `Saved` / `DayStarted`, so a save never contains it. Commands sent in that
  window fail with "the day is ending".
- Inventory + wallet persist in the host farmer's `modData` under
  `Sei.SeiCompanion/<name>`, so a reload in the same session keeps them.
- On disconnect the body survives `DisconnectGraceSeconds` (10) for a
  reconnect, then is removed with `despawned {reason:"bot disconnected"}`.
- The mod refuses to spawn while any connected farmhand lacks the mod
  (`FARMHAND_NO_MOD`): a plain NPC with a custom sprite errors on a client
  that cannot load the sprite asset.
