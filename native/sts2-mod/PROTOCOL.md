# Sei StS2 link protocol (v1)

The wire and file contract between the Sei Slay the Spire 2 mod
(`native/sts2-mod/SeiSts2`, role host or seat) and Sei (main process +
the bot's `sts2` adapter). App-side sources of truth:
`src/shared/sts2Ipc.ts` (constants, status file),
`src/bot/adapter/sts2/link.js` (session), `src/bot/adapter/sts2/state.js`
(SeiState reader), `src/bot/adapter/sts2/fixtures/` (fake mod + scenario).

## Topology

```
player's game window  (mod role "host")  --ws-->  bot link server (127.0.0.1)
companion's window    (mod role "seat")  --ws-->  same server
companion's window  --ENet co-op (game built-in)-->  player's window 127.0.0.1:33771
```

The bot is the WebSocket SERVER (the Neuro side). Both mods connect out.

## Roles

| | host | seat |
|---|---|---|
| Which window | the player's own (Steam) | the companion's, started by Sei main |
| Detected by | default | `--clientId` on the command line, or env `SEI_STS2_ROLE=seat` (env `SEI_STS2_ROLE=host` forces host) |
| Registers actions, answers forces | never | yes (upstream neuro-sts2 behaviour) |
| Sends | `startup`, `sei/hello`, `sei/chat` (TODO) | `startup`, `sei/hello`, everything upstream sends, `sei/state`, `sei/event` |
| Upstream gameplay patches | none applied | all applied |

Sei main launches the seat with `--windowed --force-steam off --clientId 1001 -fastmp join`.

## Link discovery

Link folder:

- macOS `~/Library/Application Support/sei-sts2/`
- Windows `%APPDATA%\sei-sts2\`
- Linux `$XDG_CONFIG_HOME/sei-sts2/` or `~/.config/sei-sts2/`
- override: env `SEI_STS2_LINK_DIR`

Sei main writes `<linkDir>/link.json` per session:

```json
{ "v": 1, "port": 34870, "token": "<per-session secret>" }
```

Before EVERY connect attempt the mod re-reads it and dials
`ws://127.0.0.1:<port>/sei-sts2?token=<token>`. Env `NEURO_SDK_WS_URL`, when
set, wins (dev and tests; upstream behaviour). No file, a bad file, a refused
or dropped connection: retry every 2 s, forever.

## Handshake (every connect and reconnect)

1. mod -> `startup` (Neuro SDK). Anything the mod queued while disconnected is dropped first.
2. mod -> `sei/hello`:
   ```json
   { "mod": "sei-sts2", "version": "0.1.0", "protocol": 1, "role": "host|seat",
     "player": "<host only, the player's name, once known>", "coop": true,
     "game_version": "<build string>" }
   ```
   The host sends `sei/hello` again once the player's name becomes known (first run). Every message's `game` field is exactly `"Slay the Spire 2"`.
3. bot -> `startup` `{ session: { sessionId, characterId, displayName } }`. The mod keeps `displayName` for its "Play with <name>" button; otherwise ignored.
4. seat only: the mod re-sends its registered actions and re-runs its decision point, so a fresh `actions/force` (with `sei_state`) follows within a moment.

A connection with `startup` and no `sei/hello` within 400 ms is treated by the
bot as a seat (the unmodified upstream mod).

## Neuro SDK messages (seat)

Unchanged from neuro-sts2 / the Neuro SDK spec: `context`, `actions/register`,
`actions/unregister`, `actions/force`, `action` (bot -> mod), `action/result`.
Sei additions:

- `actions/force` carries `sei_state` (a SeiState object, below). The upstream
  `state` field stays null; the human-readable situation is in the preceding
  `context` messages.
- `action/result` `success:true` answers the pending force. `success:false`
  leaves the force open: the bot keeps it and retries with a corrected action
  (the mod may also re-force on its own after an unstable result).

Index arguments (as upstream's actions read them):

| arg | indexes into | SeiState list |
|---|---|---|
| `card_index` | the full hand, playable or not | `hand` |
| `enemy_index` | alive, hittable enemies (`CombatState.HittableEnemies`) | `enemies` |
| `ally_index` | alive players OTHER than you, combat order (Sei changed `use_potion` to match `play_card`) | `allies` |
| `potion_index` | potion slots (empty slots count) | `me.potions` (empty slots are `{name:"(empty slot)", empty:true}`, trailing empties trimmed) |
| `character_index` | character select buttons | `options` |
| `coordIndex` (map) | reachable map nodes | `options` |

## SeiState (v1)

Sent as `actions/force.sei_state` and as `sei/state` `{ state }`. `sei/state`
goes out (seat) at most once a second, only when the JSON changed, and only
while no force is pending (a force older than 2 minutes counts as not
pending).

```json
{
  "v": 1,
  "screen": "combat",
  "run": { "act": 1, "floor": 6, "ascension": 0 },
  "me": {
    "character": "The Ironclad", "hp": 61, "max_hp": 80, "block": 5, "gold": 99,
    "energy": 2, "max_energy": 3, "stars": 0, "ended_turn": false,
    "potions": [{ "name": "Fire Potion", "desc": "Deal 20 damage." }],
    "relics": ["Burning Blood"], "deck": 12,
    "powers": [{ "name": "Strength", "amount": 2 }]
  },
  "allies": [{ "name": "Player", "character": "The Silent", "hp": 20, "max_hp": 70, "block": 0,
               "is_player": true, "ended_turn": true, "powers": [] }],
  "enemies": [{ "name": "Jaw Worm", "hp": 30, "max_hp": 44, "block": 0,
                "intent": "Attack: Deal 11 damage.", "powers": [] }],
  "hand": [{ "name": "Bash", "cost": 2, "type": "attack", "target": "enemy",
             "desc": "Deal 8 damage. Apply 2 Vulnerable.", "playable": true }],
  "piles": { "draw": 5, "discard": 2, "exhaust": 0 },
  "options": []
}
```

- `screen`: `main_menu`, `menu`, `character_select`, `map`, `combat`, `hand_select`, `card_select`, `rewards`, `event`, `rest`, `shop`, `treasure`, `bundle_select`, `game_over`, `timeline`, `loading`, `unknown`.
- Outside a run only `v`, `screen`, `options` are present. Out of combat `enemies` and `hand` are `[]`, `piles` is absent, `allies` come from the run's player list (no powers, block 0).
- `target`: `enemy`, `ally`, `all_enemies`, `all_allies`, `none`, `self`.
- `cost` may be null (unknown); `max_energy`, `stars`, `ended_turn` only in combat; `floor` may be null on builds where the mod cannot read it.
- `options` is filled for character select and the map only. Other choice screens (rewards, events, shop, rest, card selection) describe their choices in the `context` text and in the registered actions.

## Events

`sei/event` `{ kind, detail? }`, seat only, from a snapshot diff every 0.5 s:

| kind | when | detail |
|---|---|---|
| `act_start` | a run starts at act 1, or the act index goes up | `act N` |
| `combat_start` / `elite_start` / `boss_start` | combat begins (room type from the map node) | enemy names |
| `combat_won` | combat ends and the party is not wiped | enemy names |
| `you_died` | your character's creature dies (edge) | |
| `player_low` | a teammate player drops under 30% hp (edge, re-armed above 30%) | `<name> at <hp>/<max> hp` |
| `run_won` / `run_lost` | the game over screen appears (abandoned runs: nothing) | `act N` / `against <enemies>` |

## Bot -> mod (Sei)

| command | data | seat | host |
|---|---|---|---|
| `sei/say` | `{ text }` (<= 300 chars) | bubble over its own character | bubble over the companion's character (the other player) |
| `sei/pause` | `{ paused }` | recorded, reported in the status file | same |
| `sei/bye` | `{}` | removes its status file and quits the game (`SceneTree.Quit`) | ignored |

The bubble uses the game's own talk bubble command looked up by reflection;
when it is missing (or outside a run) the text is not shown.

## Mod -> bot chat (host)

`sei/chat` `{ from, text }` when the player types in the game's chat.
TODO: not sent yet; no in-game chat hook is known for StS2 co-op.

## Status files

Each window writes `<linkDir>/status-<role>.json` every ~3 s, atomically
(write `status-<role>.json.<pid>.tmp`, then rename over the old file), and
deletes it when the window closes. A file older than 12 s means that window is
gone.

```json
{ "ts": 1763180000000, "role": "host", "version": "0.1.0", "protocol": 1,
  "game_version": "...", "screen": "character_select", "lobby": "enet",
  "in_run": false, "players": [], "pid": 4242, "paused": false, "linked": true }
```

- `lobby`: `enet` when a Sei lobby or run on the localhost ENet transport is up (the companion can join), `steam` for a Steam co-op lobby or run, `none` otherwise.
- `players`: player names in the run (lobby list before embark: TODO, `[]`).
- `paused`, `linked` are extras; readers treat every field as optional.

## Logs

`<linkDir>/sei-sts2-<role>.log`, rotated at 5 MB (one `.old` kept).
