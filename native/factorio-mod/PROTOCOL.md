# Sei companion mod: wire protocol (v1)

The Sei app (the brain) and the `sei-companion` mod (the body) talk over
localhost UDP. Factorio must be started with `--enable-lua-udp <port>`
(command line only; there is no config.ini setting). The game then binds
`127.0.0.1:<port>`. The app binds its own ephemeral port and sends requests
there; the mod reads them once per game tick and replies to the request's
source port.

App side: `src/bot/adapter/factorio/client.js`. Mod side:
`sei-companion/scripts/link.lua` (transport) and `scripts/api.lua` (ops).

## Framing

Both directions use `SEI1 <id> <part> <parts>\n<body chunk>`.

- `id` is `[A-Za-z0-9_-]+`, chosen by the app per request; the reply carries
  the same id.
- A body is JSON, cut into chunks of at most 60000 bytes (never inside a UTF-8
  character), at most 32 parts.
- The mod sends at most 3 datagrams per tick and queues the rest.

## Delivery

UDP can drop a datagram, so the app resends a request with the same id every
400 ms until the reply arrives or it times out (8 s by default).

- Read ops (`hello`, `players`, `poll`, `observe`) run every time.
- Every other op is answered from a per-client cache of the last 48 replies
  when the same id arrives again, so a resent action never runs twice.

The mod only reads its socket while the game ticks. A single-player game that
is paused (or sitting in the main menu) does not answer; the app treats a
long silence as "paused" and holds the brain. When the game quits, the port
closes and the OS reports it unreachable; the app ends the session.

## Ops

| op | request | reply |
|---|---|---|
| `hello` | `{op}` | `{ok, mod, game, protocol: 1, tick, player_index, players: [{i, name}], multiplayer, paused?, world, seed}`. `world` is a per-save id (seed plus the tick the mod first ran). |
| `players` | `{op}` | `{ok, players}` |
| `spawn` | `{op, name, color?: {r,g,b}}` | `{ok, cid, fresh, seq, owner, at}`. Spawns (or brings back) the companion next to the requesting player. The same name for the same player returns the same `cid`. At most 3 per player. |
| `poll` | `{op, cid, since}` | `{ok, seq, ev: [events with seq > since], alive}`. The feed keeps the last 120 events. |
| `observe` | `{op, cid}` | `{ok, obs}` (see Observation) |
| `cmd` | `{op, cid, verb, args}` | Instant verbs: `{ok, done: true, success, msg}`. Job verbs: `{ok, started: true, id}`; the job later pushes a `result` event with that id. |
| `cancel` | `{op, cid, reason?}` | `{ok, cancelled}`; the running job ends with a failed `result`. |
| `pause` | `{op, cid, paused}` | `{ok, paused}`; while paused her reflexes and jobs stop. |
| `despawn` | `{op, cid}` | `{ok}`; she leaves (her body is stashed and comes back on the next spawn). |

Errors are `{ok: false, error}`. A client only drives companions owned by its
own player.

The same ops are also reachable over RCON (fallback and tests) with the
console command `/sei <json>`, and through the remote interface
`sei_companion.dispatch(json, player_index)`.

## Verbs

Instant: `say {text}`, `follow`, `stay`, `defend {stance: passive|defensive|aggressive}`,
`look {target | x, y}`, `stop`.

Jobs (each has a deadline of 5 to 15 minutes):

| verb | args | what she does |
|---|---|---|
| `goto` | `x, y` | walks there and stays |
| `come` | | walks to the player |
| `gather` | `resource, count` | mines ore, trees (`wood`), rocks (`stone`) nearby until she has `count` more |
| `craft` | `item, count` | hand-crafts, including missing intermediates she can make |
| `give` | `item, count?` | walks to the player and hands it over |
| `take` | `target | x,y, item?, count?` | takes from a chest or machine |
| `deposit` | `target | x,y, item, count?` | puts items into a chest or machine |
| `tend` | `radius?` | fuels furnaces, drills and boilers, loads ore into furnaces, ammo into turrets |
| `build` | `item, x, y, direction?` | places one entity (clears trees and rocks in the way); a failure names what blocks it and the nearest free spot |
| `build_ghosts` | `radius?` | builds the player's ghosts with what she carries |
| `pickup` | `target | x,y` | mines a building back into her inventory |
| `research` | `tech` | queues research; explains trigger technologies |

`target` is a `#N` handle from the observation (sent as a number).

## Events (the `poll` feed)

| t | fields |
|---|---|
| `spawned` | `at` |
| `chat` | `from, text, player_index?, companion?` (`companion: true` = a sibling companion spoke) |
| `hit` | `attacker, damage, health, fighting` (throttled to one per 8 s) |
| `fight` | `enemy, count, near_owner` (her reflex opened fire) |
| `fight_over` | `kills` |
| `survival` | `kind: retreat|safe|no_ammo, attacker?, health` |
| `death` | `cause, at, respawn_s` |
| `respawned` | `at` |
| `rescued` | `reason` (no path to the player; she hopped to them) |
| `owner_away` | `surface` |
| `research_finished` | `tech` |
| `player_joined`, `player_left` | `name` |
| `result` | `id, verb, ok, detail` |

## Observation

`observe.lua` returns a compact table (about 600 bytes): her name, position,
surface, health, stance, follow state, job and progress, crafting queue; the
player's distance, direction, vehicle, health, held item and what they point
at; her inventory (top 14 kinds), free slots and guns; nearby resources,
trees and rocks; enemies near her or the player; buildings within 24 tiles,
up to 6 problem machines and 6 chests with handles; ghosts; research; time of
day. The app turns it into the snapshot text the model reads
(`src/bot/adapter/factorio/observers/snapshot.js`). Lua writes an empty list
as `{}`, so the app reads every list defensively.
