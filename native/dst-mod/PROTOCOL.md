# Sei <-> Don't Starve Together helper: wire protocol

Version 1 (game-adapters M2, 260908). Mirrored in `src/shared/dstIpc.ts`
(main-process zod schemas) and `src/bot/adapter/dontstarve/protocol.js`
(bot-side shapes). `scripts/fake-dst-mod.mjs` is a Node client that speaks
all of it.

## Why it looks like this

The mod runs inside the player's game. Since Klei's 2025 sandbox change the
only way out of the Lua VM is `TheSim:QueryServer(url, cb, method, body)` to
`localhost` / `127.0.0.1`: no sockets, no headers, no content type, and
bodies should stay under ~20 KB (the engine allocates generously per
request). So every channel is the mod making an outbound HTTP request, and
the two Sei processes are HTTP servers:

- **main** keeps a long-lived listener on the first FREE port of the
  DISCOVERY list `27424..27428` (`DST_DISCOVERY_PORTS`; 260909, was one
  fixed, user-settable port) and only ever answers `/hello`. The mod probes
  the whole list every beat until one answers with `app: "sei"`, then sticks
  to it; three misses in a row send it back to probing. Nothing is
  configured on either side.
- **the bot runtime** (one per summoned character) listens on an ephemeral
  loopback port with a per-summon token and serves `/obs`, `/cmd`, `/event`,
  `/error`. It learns of the mod through main: the runtime posts
  `{type:'dst-listen', port, token}` up its port, the supervisor hands it to
  the DST game module, and the next heartbeat's response carries the summon.

All bodies are JSON. The token rides the query string (`?t=`) because it is
the only place a QueryServer request can carry one. Requests without a valid
token get `401` and never reach a handler.

## 1. Discovery (mod -> main)

`GET http://127.0.0.1:<port>/hello?q=<urlencoded json>` every 2 s from the
master simulation (the host's own game process, or the shard server when
caves are enabled). `q`:

```json
{
  "session": "<TheNet:GetSessionIdentifier()>",
  "world": "<server name>",
  "day": 3, "season": "autumn", "phase": "day",
  "players": [{ "userid": "KU_xxx", "name": "Steve", "prefab": "wilson" }],
  "ismastersim": true, "caves": false,
  "mod": "0.1.0", "build": "<APP_VERSION>",
  "bot": 12345
}
```

`bot` is the GUID of the live companion body when one exists. A heartbeat
inside 6 s = the world is `open` (`WorldState.dontstarve`); nothing for
longer = `closed`.

Response, idle: `{"ok": true, "app": "sei"}`. The `app` field is what lets
the mod tell Sei from a stranger listening on one of the discovery ports; a
response without it is treated as a miss.

Response carrying a summon (delivered to exactly one heartbeat, then dropped):

```json
{ "ok": true, "app": "sei", "summon": {
  "token": "<per-summon token>", "botPort": 51234,
  "name": "Sui", "prefab": "wigfrid", "nearUserid": "KU_xxx", "announce": true } }
```

The mod then configures its link (`sei/net.lua`) with `botPort` + `token`,
spawns `prefab` beside `nearUserid` (or the first player), and starts the
three channels below. A second summon while a body is live re-summons.

## 2. Observations (mod -> bot), `POST /obs?t=`

3 Hz, delta-compressed, cut at 8 KB. Entity positions are RELATIVE to the
body (`x`, `z` = dx, dz, one decimal); the bot stores them absolute.

```json
{
  "seq": 41, "full": false,
  "self": {
    "x": 12.3, "z": -40.1,
    "hp": 120, "hpmax": 150, "hunger": 80, "hungermax": 150, "sanity": 150, "sanitymax": 200,
    "temp": 21.5, "moist": 0, "freezing": false, "overheating": false,
    "inlight": true, "busy": false, "dead": false,
    "target": null, "follow": 100123, "cmd": "<current command id or null>",
    "inv": [{ "g": 3001, "p": "axe", "q": 1, "f": ["equip", "tool"], "s": 0.9 }],
    "equip": { "hands": { "g": 3001, "p": "axe", "q": 1, "f": ["equip", "tool"] } }
  },
  "ents": [{ "g": 100456, "p": "evergreen", "x": 4.2, "z": -1.1, "f": ["chop"], "n": null, "q": null, "h": null }],
  "gone": [100999],
  "world": { "day": 3, "phase": "day", "season": "autumn", "seasondays": 18, "raining": false, "snowing": false, "temp": 20, "dayprogress": 0.4, "caves": false },
  "truncated": false
}
```

- `full: true` replaces the whole entity set. The mod sends a full frame
  first, every 12th tick, and whenever the bot answers `{"full": true}`
  (it does so until it has seen one).
- A delta lists only entities that appeared, moved more than 0.75, or
  changed flags; `gone` lists guids that left the 24 m radius.
- Entity flags (from tags, `sei/perception.lua` TAG_FLAGS): `chop`, `mine`,
  `dig`, `hammer`, `pick`, `harvest`, `stewer`, `cooker`, `cookable`,
  `edible`, `eat` (this survivor can eat it), `equip`, `container`, `chest`,
  `prototyper`, `fire`, `burning`, `hostile`, `monster`, `combat`, `player`,
  `companion`, `sleep`, `fuel`, `structure`, `heavy`, `wall`, `spider`,
  `pickup`. `n` = player name, `q` = stack size, `h` = health fraction
  (combat entities and players).
- Inventory item flags: `equip`, `eat`, `fuel`, `tool`, `weapon`, `armor`;
  `s` = freshness fraction when perishable.
- Mod 0.3.0 adds, per entity: `t` = guid of what a non-player creature is
  fighting; and for players other than the companion `a` (the action they
  are doing, lowercased action id such as `chop`, or a stategraph state),
  `at` (that action's target prefab), `hold` (hands item prefab), `hu` and
  `sa` (hunger and sanity fractions). A delta re-sends the whole entity, so
  an absent field means cleared. `world.seasondays` = days left in the
  season.

Response: `{"full": <bool>}`.

## 3. Commands (bot -> mod), `GET /cmd?since=<seq>&t=`

Bounded long-poll with ONE request in flight: the runtime answers at once
when commands are queued, else holds the response up to `cmd_hold_ms`
(default 400 ms, `CMD_HOLD_MS`) and answers `{"cmds": []}`. `since` is the
highest `seq` the mod has processed; everything up to it is acknowledged
and never re-sent. A transport failure backs the mod's poll off to 1 s.

Response: `{"cmds": [{ "seq": 7, "id": "<uuid>", "kind": "...", ... }]}`.

Command kinds (`sei/commands.lua` dispatch):

| kind | fields | slot | result text (examples) |
|---|---|---|---|
| `say` | `text`, `announce?` | immediate | `said` |
| `stop` | `unfollow?` | immediate | `stopped` |
| `pause` | `paused` | immediate | `paused` / `resumed` |
| `fight` | `enabled` | immediate | `will fight back when hit` |
| `follow` | `guid` or `userid`, `dist?` | immediate | `following Steve` |
| `unfollow` | | immediate | `stopped following` |
| `equip` | `guid` (inventory item) | immediate | `equipped axe` |
| `drop` | `guid` | immediate | `dropped log` |
| `goto` | `guid` or `x`,`z`; `range?` | slotted (goto node) | `arrived (1.8 away)` / `cant_reach: ...` |
| `attack` | `guid`, `label?`, `pvp?` | slotted (ChaseAndAttack) | `killed spider` / `gave up the fight ...` |
| `flee` | `seconds?` | immediate (RunAway for N s) | `running from danger` |
| `action` | `name` (CHOP/MINE/PICK/PICKUP/EAT/COOK/SLEEPIN/...), `target?`, `invobject?`, `pos?`, `recipe?` | slotted (DoAction) | `chop done: evergreen` / `could not pick ...` |
| `gather` | `prefab`, `count`, `source?` (CHOP/MINE/plant prefab) | slotted loop | `gathered 4 twigs` |
| `build` | `recipe`, `pos?` | slotted (learn at a prototyper if needed) | `built campfire` / `missing ingredients for ...` |
| `container` | `op` (store/take), `container`, `item`, `count` | slotted | `stored 2 log` |
| `lightfire` | `recipe?` | slotted (ADDFUEL, else build campfire) | `fed the campfire with log` |
| `give` (0.3.0) | `item` (prefab), `count?`, `guid` or `userid` (player) | slotted (walks over, then gives) | `gave 2 berries to Steve` / `no berries in inventory` |
| `resync` | | immediate | `ok` |
| `despawn` | | immediate; body removed | `despawning`, then `despawned` event |

Work actions (CHOP/MINE/DIG/HAMMER) are re-issued until the target's
`*_workable` tag drops. A slotted command replaces the previous one (its
result is `replaced by <kind>`). Every slotted command has a deadline
(`CMD_TIMEOUT_S` 90 s; goto 30 s; attack 25 s; gather scaled by count).

## 4. Events (mod -> bot), `POST /event?t=`

`{ "kind": "...", "t": <GetTime()>, ... }`:

| kind | fields |
|---|---|
| `spawned` | `guid`, `prefab`, `name`, `x`, `z`, `session`, `world`, `near`, `mod` (0.3.0+: the helper's version; absent = older) |
| `spawnfailed` | `reason` |
| `despawned` | `reason` |
| `result` | `id`, `ok`, `text` (answers a command) |
| `chat` | `userid`, `name`, `prefab`, `text`, `whisper` (player chat via `Networking_Say`; the body's own lines are skipped) |
| `attacked` | `attacker` (guid), `label`, `isplayer`, `damage`, `health`, `healthpct` |
| `death` | `x`, `z`, `cause?`, `afflicter?` |
| `enterdark` / `enterlight` | `phase?` |
| `actionfailed` | `action`, `reason` |
| `phase` | `phase`, `day` (world phase change) |
| `survival` | `what` (`retreat` / `dark` / `ate`), `threat?`, `healthpct?`, `phase?`, `item?`, `hunger?` (the safety layer acted). Mod 0.3.0 habits add: `light` + `did` (`prepared` / `crafted` / `equipped` / `built` / `stowed`) + `item`; `fuel` + `item`, `fire`; `equip` + `items[]`, `target?`; `heal` + `item`, `healthpct`; `defend` + `threat`, `guid`, `player`, `userid` |

Response: `{}`.

## 5. Errors (mod -> bot), `POST /error?t=`

`{ "message": "<lua error>", "t": <GetTime()> }`. Logged by the runtime and
surfaced in Sei's log panel. Every mod handler runs in `pcall` and reports
through this.

## 6. Timing and failure semantics

- Bot runtime: no contact by the spawn deadline (sized inside the
  supervisor's 30 s summon watchdog, floor 5 s) = `GAME_NOT_ANSWERING`;
  contact but no `spawned` = `DST_SPAWN_FAILED`; no traffic for 10 s after
  spawn = `GAME_WORLD_NOT_OPEN` (the world closed); `death` = one brain turn,
  then `DST_BODY_DIED` (an ownerless survivor has no client to revive it).
- Stop: the runtime queues `despawn`, waits up to 2.5 s for `despawned`,
  stops the brain, closes the listener. The mod drops the inventory on the
  ground before `inst:Remove()` (the body is never saved with the world).
- The QueryServer request timeout is undocumented; the 400 ms hold is the
  day-one measurement item (plan section 5) and is raised only if safe.
