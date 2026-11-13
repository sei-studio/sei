# Game adapter: Factorio

Factorio 2.1 only. The companion is a real character in the player's game,
driven by our own MIT Lua mod (`native/factorio-mod/sei-companion`, see its
`README.md` and `PROTOCOL.md`). Read `game-adapters-stardew-dst.md` first; the
Factorio pieces follow the same shape.

## Pieces

| where | what |
|---|---|
| `native/factorio-mod/sei-companion/` | the mod: body, reflexes (follow, defend, retreat, respawn), job verbs, observation |
| `src/bot/adapter/factorio/client.js` | localhost UDP client: framing, resend with the same id, feed polling, job results |
| `src/bot/adapter/factorio/runtime.js` | hello, spawn, liveness (paused vs closed vs reloaded), brain lifecycle, `factorio-stats` posts |
| `src/bot/adapter/factorio/index.js` | the Adapter the brain drives |
| `src/bot/adapter/factorio/registry.js` | the tools (Zod), tool name to mod verb |
| `src/bot/adapter/factorio/observers/snapshot.js` | observation to snapshot text (a few hundred characters) |
| `src/bot/adapter/factorio/fsmWires.js` | feed events to brain handlers |
| `src/bot/adapter/factorio/prompts.js` | primer, capability, rules, tool descriptions, event addenda |
| `src/bot/adapter/factorio/stats.js` | shape-only counters (verb outcomes by failure class, reflex counts) |
| `src/main/games/factorio/` | detect, install the mod, launch with the UDP flag, watcher |

## Rules that matter

- The link needs `--enable-lua-udp <port>` on the command line (there is no
  config.ini key). Factorio binds `127.0.0.1:<port>` itself, so the app must
  never listen on that port; the client binds an ephemeral port and connects
  to the game's. If the port is taken, Factorio logs "Opening Lua UDP Socket
  failed" and runs without the link.
- The mod only reads UDP while the game ticks. Single player pauses in the
  menu, so silence means "paused" (the runtime holds the brain through
  `adapter.setGameQuiet`, which never touches the player's own pause), and an
  ICMP-refused port means the game quit (`world_closed`).
- A reloaded save forgets her (`poll` says "no companion"): the runtime spawns
  her again. A different save (new `hello.world`) ends the session, because
  her world memory is keyed on it (`getWorldIdentity`).
- Every in-game decision is the model's. Reflexes only cover survival and
  keeping up: following, shooting back under the chosen stance, backing off
  under 35% health, respawning next to the player. No verb chains another
  verb on its own.
- Verb results are the mod's own fixed strings. `stats.js` classifies those
  strings for analytics only; never match the model's text.
- `game.get_entity_by_unit_number` only finds some prototypes. The mod keeps
  its own handle registry (`verbs.remember` / `verbs.by_handle`); use it for
  every `#N` handle.
- Console `/sc` code runs in the level's context and cannot see the mod's
  `storage`. Tests reach the mod through `remote.call('sei_companion', ...)`.

## Testing

- `env -u POSTHOG_KEY npx vitest run src/bot/adapter/factorio/` (includes the
  offline Lua tests when `lua` is installed).
- `node scripts/factorio-headless-harness.mjs --registry`: every verb and
  reflex through the real adapter against a headless 2.1 server (download the
  free headless build into `~/.cache/sei-factorio/<version>/`).
- `node scripts/factorio-brain-session.mjs --minutes 15`: the real bot and
  model in a scripted session, with token totals per hour. Uses the dev test
  key; keep runs short.
- Needs a live check on a real client: the companion seen by the player in
  single player and multiplayer, `recv_udp` from a GUI client, Steam launch
  with the flag on Windows and macOS.
