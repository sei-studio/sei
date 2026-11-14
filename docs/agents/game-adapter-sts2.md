# Game adapter: Slay the Spire 2 (261115)

The companion joins the player's Slay the Spire 2 co-op run as her OWN
player, plays her own character turn by turn, and talks with the player
about the plan, card picks and fights. Status: experimental, on
`feat/sts2-companion`, NOT merged to dev. The catalog tile is
`available: false` until the live test passes.

## Seat design: a second game window on the same computer

The game has co-op (up to 4 players) but no AI-player hook and no
headless client. One copy and one Steam account can still run two
windows: the game ships a built-in localhost ENet transport for co-op
testing (`-fastmp`), and `--clientId <n>` gives a window its own settings
and saves. So:

```
player's window (started through Steam, steam://rungameid/2868840)
  Sei mod, host role: main-menu button "Play with Sei"
  -> opens a co-op lobby on localhost ENet (127.0.0.1:33771)

companion window (spawned by Sei main in prepareJoin)
  <game binary> --windowed --force-steam off --clientId 1001 -fastmp join
  env SEI_STS2_ROLE=seat
  Sei mod, seat role: joins the lobby, plays HER character

both mods --WebSocket, Neuro SDK protocol + sei/*--> bot (listens on the link port)
```

- The mod is a fork of VedalAI/neuro-sts2 (MIT, 21f9a34) in
  `native/sts2-mod/`. Nothing from STS2-Agent (AGPL-3.0) or
  STS2_DualRoleAdventure (no license) is used; they were read only.
- `native/sts2-mod/PROTOCOL.md` is the wire and file contract. The bot
  side is `src/bot/adapter/sts2/link.js` (Neuro session per window) and
  `wsServer.js` (a minimal RFC 6455 server, loopback only, token checked).
- The link folder lives OUTSIDE the game's .app bundle (macOS App
  Management blocks writes inside it): macOS
  `~/Library/Application Support/sei-sts2/`, Windows `%APPDATA%\sei-sts2\`,
  Linux `$XDG_CONFIG_HOME|~/.config/sei-sts2/`.
  - `link.json` `{v:1, port, token}`: main writes it per summon
    (`src/main/games/sts2/link.ts` `pickLinkPort` 34870..34879, `newToken`).
    The mod re-reads it before every connect attempt.
  - `status-host.json` / `status-seat.json`: heartbeats the mod writes
    about every 3 s; stale after 12 s (`STS2_STATUS_STALE_MS`).
- World state (`worldFromStatus`): `open` = fresh host heartbeat with
  `lobby: 'enet'`; fresh with another lobby = `no_lobby` (main menu, solo
  run, or a Steam lobby the companion cannot join); otherwise `closed`, or
  `not_installed`.
- One companion per run (`maxBodies: 1`, `STS2_ONE_COMPANION`). Ending the
  session stops the companion window after an 8 s grace (`onSessionEnd`).

## Mod install (main)

`src/main/games/sts2/install.ts`. Two flat files, `sei-sts2.dll` and
`sei-sts2.json`, go into the game's mods folder: Windows `<game>/mods/`,
macOS `SlayTheSpire2.app/Contents/MacOS/mods/` (community docs; unverified
on a real Mac, see the test plan). On macOS a refused write (EPERM) takes
the Don't Starve Together grant path (`createMacGrant`, Open panel then
Finder). The player turns the mod on once in the game (Settings, Mods, a
consent dialog); Sei cannot. `modLoaded` turns true on the first host
heartbeat, which is how the setup panel knows that step is done.

The built DLL is tracked at `assets/sts2-mod/sei-sts2/` like Stardew's,
because it compiles only against the game's own `sts2.dll`,
`GodotSharp.dll` and `0Harmony.dll` (never committed). Build with
`npm run build:sts2-mod` on a machine with the game and the .NET 9 SDK
(`native/sts2-mod/README.md`). Until that build exists the pack
(`build-game-pack sts2`) fails and CI must not pack it.

## Bot side

`src/bot/adapter/sts2/`: `runtime.js` (listens, waits for the seat, seat
grace, stats every 30 s), `index.js` (the adapter), `state.js` (SeiState to
a few hundred tokens; name-to-index resolution), `observers/snapshot.js`,
`prompts.js`, `fsmWires.js`, `stats.js`.

- ONE stable tool, `act(action, args)`. Card, target and potion NAMES are
  mapped to the game's indexes right before each send, so a response may
  queue several plays even though hand positions shift.
- Every move is the model's. The mod enforces the rules (illegal moves come
  back as failed results). A failed move keeps the force open. The brain
  wakes on a new force and on run events, and gets bounded nudges if a move
  stays pending; the idle tick is 10 minutes.
- Speech goes through `say()` -> `sei/say` (a speech bubble in both windows).
- Upstream mode: the unmodified neuro-sts2 mod also works (no structured
  state; the snapshot shows the context sent with the force and asks for
  index args). The Sei mod is what ships.

Continuity (`docs/agents/continuity-surfaces.md`) is the shared bot path:
the init payload carries persona, memory, summary and knowledge; the bot's
`remember()` writes the same MEMORY.md; main writes the one
"You and <name> played Slay the Spire 2" play row at session end
(`emitPlaySession`, module `displayName`) and folds the summary.

## Testing without the game

- Unit and e2e: `env -u POSTHOG_KEY npx vitest run src/bot/adapter/sts2
  src/bot/composer.sts2.test.js src/main/games/sts2 src/main/sts2SessionStats.test.ts`.
  `fixtures/scenario.js` is a small synthetic run (lobby, map, co-op fights
  with intents, card reward, rest, event, elite, end) with the rules
  enforced; `fixtures/fakeMod.js` speaks the mod's protocol over a real
  WebSocket.
- Real app, no game: `npm run sts2:fake-game` writes both heartbeats into
  the link folder (the app then sees an open lobby and a running companion
  window and does not spawn the game), follows `link.json`, links a host
  and a seat, and forwards stdin as in-game chat. Run it, then press
  Launch on the Slay the Spire 2 tile in a dev build (the tile is
  `available: false`; flip it locally or open the game page directly).
- Real brain: `node scripts/sts2-brain-session.mjs --minutes 10` (dev test
  key, analytics off) plays the synthetic run with the real bot and LLM and
  reports tokens per turn and per hour plus a transcript (`--out`). The
  synthetic run is far faster than a real one, so per-hour figures are an
  upper bound; per-turn figures transfer.

## Live test plan (Mac, once the game is owned)

Take the Mac lock first (`mkdir ~/suisei/mac.lock` plus an `owner` file),
`mac status`, and remove the lock when done.

1. Install the game through Steam on the Mac. Do not buy anything without
   approval.
2. Build the mod on the Mac: .NET 9 SDK, then
   `scripts/build-sts2-mod.sh --data-path
   "<Steam>/steamapps/common/Slay the Spire 2/SlayTheSpire2.app/Contents/Resources/data_sts2_macos_arm64"`.
   Fix compile errors against the real types first; the TODOs that need
   real member names are listed in `native/sts2-mod/README.md` and marked
   `TODO(game)` in `SeiSts2/` (`grep -rn "TODO(game)" native/sts2-mod`). Commit `assets/sts2-mod/sei-sts2/`.
3. In a dev build of this branch: Slay the Spire 2 tile, setup panel.
   Check: install found, mod copied (App Management prompt appears once and
   the grant path completes), files land in `Contents/MacOS/mods/`.
4. Start the game from the panel. In the game: Settings, Mods, turn on
   "Sei Companion", accept the consent dialog, restart if asked. Check the
   game lists the mod (else switch `modsDirFor` to `Contents/Resources/mods`)
   and `status-host.json` appears in the link folder.
5. Main menu: the "Play with Sei" button shows; clicking it opens a lobby.
   Check `status-host.json` says `lobby: "enet"` (the biggest unknown:
   whether injecting `fastmp=host_standard` makes Host, then Standard, use
   ENet). Logs: `<linkDir>/sei-sts2-host.log`.
6. Press Launch in Sei. Check: a second, small, windowed game starts, joins
   the lobby (`sei-sts2-seat.log`, `status-seat.json`), the early-access
   notice does not block a fresh `--clientId 1001` profile, and the two
   windows run side by side at a usable frame rate.
7. Play floors 1 to 3 together: she picks a character, embarks with you,
   plays her own cards in fights, picks rewards, talks in bubbles and in the
   app chat. Check that typing in the app reaches her and her lines show as
   bubbles over her character (no bubble outside a run). Typing in the
   game's own chat does not reach her yet: the mod has no chat hook
   (`SeiMessages.cs`, `sei/chat` is never sent).
8. Stop from the app: the companion window closes within about 10 s and
   `bot_session_ended` has `game: 'sts2'`.
9. Repeat 3 to 8 on Windows when a Windows machine with the game is
   available (the VM may not run the game).

## Plan gating (to decide)

Mega Crit's mod rules do not allow charging for a mod or putting one
behind a paywall. The Sei mod is free, and the companion in Slay the Spire 2
must stay usable on the Free plan and with the user's own keys (BYOK).
Options for later, none built yet:

- No game gate (recommended): the game is open on every plan; the existing
  usage limits of each plan apply as they do to any other game. What a
  paid plan buys is more AI usage, not access to the mod or the game.
- Do NOT make Slay the Spire 2 a paid-only tile or unlock it with a plan,
  and do not mention the game in paid-plan marketing as a paid feature.
- If a gate is ever needed, it belongs on usage (the AI service), applied
  the same way to every game, never on installing or using the mod.

## Analytics (shape only)

- `game_setup_step` with `game: 'sts2'`, steps `find_game`, `mod_copy`,
  `start_game`, `mod_loaded`, `lobby_seen`, `companion_window`
  (`STS2_SETUP_STEPS`).
- `bot_session_ended` with `game: 'sts2'` carries the folded `sts2_*` props
  from `src/main/sts2SessionStats.ts`: `sts2_acts`, `sts2_acts_ok`,
  `sts2_forces`, `sts2_wakes`, `sts2_nudges`, `sts2_batch_max`, `sts2_says`,
  `sts2_combats_won`, `sts2_max_floor`, `sts2_max_act`, `sts2_run_end`,
  `sts2_seat_drops`, `sts2_host_seen`, `sts2_structured_state`, `sts2_coop`,
  `sts2_first_act_ms`, `sts2_f_<family>` (move counts per family) and
  `sts2_fail_<class>` (failure counts per closed class). No card names,
  player names or chat text.
- Error class `STS2_ONE_COMPANION`; spawn failures `STS2_SPAWN_FAILED`.

## Merge notes

- `src/shared/games.ts` / `games.test.ts` conflict with
  `feat/games-grid-redesign` (it rewrites the coming-soon rows and adds a
  plain `sts2` row). Keep the redesign's rows and replace its `sts2` row
  with this branch's (it has the aliases); the length cap in
  `games.test.ts` here is 450.
- Terraria and KTANE branches touch the same lists (`GAME_KINDS`,
  `GAME_IDS`, enums in `config.js`, `setupTelemetry.ts`, `botSupervisor.ts`,
  `gameLaunch.ts`, `gameSurfaces.tsx`, `App.tsx`, the i18n files,
  `build-game-pack.mjs`, `gamePackVerify.mjs`). Every conflict is two
  additions to one list: keep both. The i18n strings for this game sit in
  their own spread modules (`lib/i18n/sts2.ts`, `zh/sts2.ts`) so keys do
  not collide.
- The Factorio branch merges cleanly with this one.
