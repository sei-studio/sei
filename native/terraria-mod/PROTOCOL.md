# Sei companion mod protocol (Terraria)

Protocol version 1. The same transport as the Stardew Valley mod.

## Transport

- The mod listens on `localhost` (and `127.0.0.1` off Windows) on the first
  free port of `port .. port+4` (default 27460). The port and a random token
  live in `<tModLoader save folder>/SeiCompanion/link.json`, written by the
  Sei app before the game starts:
  `{"port": 27460, "token": "<hex>"}`.
- `GET /hello` needs no token and answers
  `{mod, version, protocol, game:"terraria", terraria, tml, port, role, world, pid}`.
  `role` is `single`, `server` (a dedicated server or a hosted world) or
  `client` (the game joined someone else's server; the companion cannot
  spawn there). `world` is `{loaded, name, uniqueId, worldId, hardmode, players, companions}`.
- `GET /ws?token=<token>` upgrades to a WebSocket (401 on a bad token).
  Frames are JSON objects, one per line (NDJSON), each with `t` (type) and,
  for requests, `id`.

## Requests (bot to mod)

Every request is answered by `{t:"result", id, ok, detail, ...}`.

| `t` | fields | notes |
|---|---|---|
| `ping` | | answered at once |
| `spawn` | `name`, `appearance?`, `owner?` | result carries `{name, npc, x, y, hp, maxHp, role}`; on failure `error` is `NO_WORLD`, `NOT_HOST`, `NAME_TAKEN` or `NO_SLOT` |
| `despawn` | | her bag is kept in the world file under her name |
| `observe` | | result carries `obs` (below) |
| `say` | `text` | a chat line as `<Name> text` |
| `pause` | `paused` | freezes the body (reflexes too) |
| `cancel` | `target` | the `id` of a running `cmd` |
| `cmd` | `name`, `args` | a verb; the result comes when it finishes |

`appearance` is optional: `{hair, skinVariant, hairColor, skinColor, eyeColor,
shirtColor, underShirtColor, pantsColor, shoeColor}` with colours as `#rrggbb`.

A disconnected session keeps the body for 10 seconds, so a quick reconnect
spawning the same name adopts it.

## Verbs (`cmd`)

Coordinates are tiles, `y` grows downward, and a position is her feet.
`#N` handles are NPC slots from the observation's `hostiles`.

| name | args | |
|---|---|---|
| `follow` | `player?` | standing order, until `unfollow` |
| `unfollow` | | stay where she is |
| `come` | `player?` | walk to the player |
| `goTo` | `x, y` or `target` | walk there |
| `stance` | `mode`: `aggressive`, `defensive`, `passive` | who she fights on her own |
| `attack` | `target` | fight one enemy until it dies or leaves |
| `give` | `item`, `count?`, `player?` | walk over and drop it at their feet |
| `take` | `item`, `count?` | pick up items on the ground within 20 tiles |
| `mine` | `x, y, width?, height?` or `block`, `count?` | an area (up to 40 tiles) or the nearest exposed blocks of a kind (`ore` = any ore) |
| `place` | `item`, `x, y`, `width?`, `height?` | blocks, walls, furniture, stations |
| `chop` | `x?, y?`, `count?` | fell trees, collect the wood |
| `use` | `item` | drink a potion or use a consumable |
| `equip` | `item` | a weapon or a piece of armour |
| `craft` | `item`, `count?` | walks to the station it needs; `count` is how many items |

The reflexes run without a verb: she fights by her stance, drinks a healing
potion below 40% health (60 s cooldown) and backs away from a close enemy
below 25% when she has none.

## Events (mod to bot)

| `t` | fields |
|---|---|
| `welcome` | `protocol`, `session`, `hello` |
| `spawned` / `despawned` | identity / `reason` |
| `obs` | `obs`, pushed once a second |
| `progress` | `id` (the `cmd`), `text` |
| `chat` | `from`, `text`, `kind` (`player` / `companion`), `dist?` |
| `damaged` | `by`, `amount`, `hp`, `maxHp` (at most every 1.5 s) |
| `survival` | `kind`: `healed` (`item`), `retreating`, `low_health` (`potions`, `cooldown`); `hp`, `maxHp` |
| `death` | `by`, `respawnSeconds` (she is knocked out, then revives by the player) |
| `respawned` | `x`, `y` |
| `event` | `kind`, `text`, plus `boss` / `player` / `hp` by kind |

`event` kinds: `blood_moon`, `eclipse`, `pumpkin_moon`, `frost_moon`,
`slime_rain` (each with an `_end`), `invasion`, `invasion_end`, `dawn`,
`dusk`, `boss_spawn`, `boss_defeated`, `boss_left`, `player_joined`,
`player_left`, `player_died`, `player_low`.

## Observation

```
self      {name, x, y, hp, maxHp, defense, knockedOut, stance, following, job,
           weapon, armor[], potionCooldown, paused}
bag       ["Wood x12", ...]
time      "4:30 PM"     day  true|false
events    ["blood moon", "rain", ...]
world     {name, hardmode, bossesDown[]}
place     {layer, depthFt, biomes[]}
players   [{name, x, y, hp, maxHp, dist, dead, holding}]
hostiles  [{id, name, x, y, hp, maxHp, dist, boss}]   (8 nearest, bosses always)
items     [{name, stack, dist}]                     (on the ground, 20 tiles)
trees     [{x, y, dist}]   ores [{name, x, y, dist}]   stations ["Work Bench", "water"]
```
