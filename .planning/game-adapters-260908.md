# Game adapters: Stardew Valley + Don't Starve Together (260908)

Status: IMPLEMENTED 260908 through M2 on `feat/game-adapters` (worktree
`../sei-games`): M0a seams, M0b game packs, M1 Stardew, M2 DST merged; every
test green. Both tiles flipped to `available: true` on 260908 at the
user's request so M3 (the live checklist, per game) can be run from the app;
M3 itself is still owed. Settings hosts every game under one "Games" group
(left column game list, right column that game's section). Decisions in section 8 override
sections 1 and 7 where they differ. The CLAUDE.md section "Game adapters"
is the maintained summary.

Goal: a companion can be launched into the player's Stardew Valley farm or
Don't Starve Together world the way it is launched into a Minecraft LAN world
today, with as much in-game autonomy as the brain already has in Minecraft:
walk beside the player, work, fight, survive, and talk through the game's chat.

Research inputs (committed beside this doc, read them before touching the
areas they cover):

- `research/game-adapters-seams-260908.md`: every seam in this repo a second
  adapter plugs into, file and line cited.
- `research/game-adapters-stardew-260908.md`: prior art, decompile facts,
  transport, install, licensing for Stardew 1.6.15 / SMAPI 4.5.
- `research/game-adapters-dst-260908.md`: same for DST build 747465, including
  the 2025 Klei sandbox change and the localhost carve-out.

Third-party clones referenced in those reports live in the session scratchpad
and are ephemeral; every repo is named with its URL and license, so re-clone
when needed.

---

## 1. Decisions

1. **Both games get a companion BODY inside the player's own game, spawned by
   a game-side mod, driven by the existing Node brain over a localhost link.**
   Neither game has a mineflayer-style protocol library, neither allows a
   headless second client (DST: Steam one-instance-per-account, no headless
   client; Stardew: a split-screen farmhand is gamepad-only and halves the
   window), so "join as a real second player" is out for both. The body is a
   mod-side entity that other players see and can interact with.
2. **The brain is not forked.** `src/bot/brain/*` (orchestrator, FSM, memory,
   prompts, LLM layer, say tool) stays one implementation. Each game supplies
   an adapter that satisfies the contract in `src/bot/brain/types.js`
   (`REQUIRED_ADAPTER_MEMBERS` in `brain/index.js`), exactly as the comment
   there predicts. The Minecraft-specific names that leaked into the brain are
   moved behind adapter-declared metadata first (M0 below).
3. **Discovery in main, protocol in the bot.** Mirrors Minecraft: main runs a
   per-game watcher that answers "is a world open" (Minecraft: `lanWatcher`;
   Stardew: probe the mod's hello endpoint; DST: receive the mod's heartbeat),
   and the forked bot owns the game protocol. No game protocol code in main.
4. **Reflexes live in the mod, decisions live in the brain.** Combat
   retaliation, evasion, auto-eat, stamina and darkness guards run in the
   game process at frame rate (the Minecraft adapter's `behaviors/*` loops are
   the precedent, and amarisaster's Stardew companion moved combat to 60 Hz
   for the same reason). The LLM issues closed, Zod-typed verbs; composite
   verbs (`gather(kind, count)`) loop mod-side so one call does a job.
5. **Game adapters are downloaded on first use, not bundled** (approved
   260908, replaces the bundling recommendation). Every game, Minecraft
   included, has a GAME PACK: a versioned zip built in CI from the same
   commit as the app, published as a release asset and mirrored to
   `dl.sei.gg`, fetched into `<userData>/game-packs/<game>/` the first time
   the player launches that game. Section 2.6 has the design. SMAPI itself
   (LGPL) is downloaded from its GitHub release at install time, never
   vendored.
6. **v1 scope is the host's own single-player or hosted world**, the same
   shape as Minecraft v1 (LAN host). Stardew farmhands and DST joiners are
   handled defensively (see per-game sections) but not targeted.
7. **The Stardew body is the proven NPC + shadow-Farmer pair** (Farmtronics,
   MIT; amarisaster/StardewValley-MCP, Apache-2.0). A spike on drawing the
   shadow Farmer itself with `FarmerRenderer` (real farmer look, tool swing
   animations for free, appearance from the character) is budgeted but not on
   the critical path.
8. **The DST body is a vanilla survivor prefab** chosen by the CHARACTER
   herself on first launch (approved 260908: a one-off LLM call over the
   persona plus a roster brief, persisted per character; the chosen
   survivor's perks brief rides the world primer), with a custom Brain,
   server-only mod (`all_clients_require_mod = false`), so friends install
   nothing. Proven by FAtiMA-DST (MIT, 2018) and
   DST-AICompanion (MIT, 2024).
9. **Licensing:** reuse only MIT/Apache/CC0 code (listed per game). Klei's Lua
   and the Stardew decompile are reference only; nothing from them is copied.
   Our mods are MIT.

---

## 2. Architecture

### 2.1 Process picture

```
Electron main                          Node bot (utilityProcess, per character)         Game process
src/main/games/<game>/                 src/bot/index.js  (composer, game-agnostic)
  watcher.ts   "world open?"  ─────▶   adapter/<game>/runtime.js (dynamic import)
  install.ts   detect/install/enable        ├─ connect.js   (transport client/server)  ◀──▶  mod (Sei-owned)
  launch.ts    start the game               ├─ registry.js  (Zod verbs → commands)           body entity
botSupervisor.ts summon(id, game)           ├─ observers/   (obs JSON → snapshot text)        reflex loops
  init {game, joinTarget, ...}              ├─ fsmWires.js  (events → P0/P1/P3)               chat hook
  port: dashboard/chat/pause/mode           ├─ telemetry.js (dashboard snapshots)
                                            └─ prompts.js   (baseline, primer, rules, events)
                                       brain/*  UNCHANGED core
```

### 2.2 M0: shared generalization (blocks both games)

Everything here is a refactor with tests, no behavior change for Minecraft.
It is done first, by one agent, so the two game agents only ADD files and
register them.

Bot process:

- `src/bot/config.js`: `adapter.kind: z.enum(['minecraft','stardew','dontstarve'])`,
  per-kind sub-schemas `adapter.stardew.*`, `adapter.dontstarve.*`.
- `src/bot/index.js`: split `start()` into the composer (config parse, brain
  start, port dispatch, lifecycle emission, returned handle) and a per-game
  runtime loaded by `await import(\`./adapter/${kind}/runtime.js\`)` exposing
  `createRuntime(config, hooks) -> { adapter, telemetry, stop, setCompanions }`.
  The whole mineflayer bring-up, reconnect policy, version ping and
  `_sei_startChat` move to `adapter/minecraft/runtime.js`. mineflayer never
  loads for a non-Minecraft session. `portForwarders.test.js` keeps pinning
  the handle.
- Adapter contract v2 (`types.js`, `ADAPTER_INTERFACE_VERSION = 2`), new
  optional members with Minecraft defaults so the Minecraft adapter changes
  only by declaring them:
  - `gameName` (for the paused notice, `quit_game` description, play row)
  - `chatMaxChars` (replaces `MC_CHAT_MAX_CHARS`)
  - `backgroundActions: { follow: 'unfollow' }` (replaces the hardcoded
    `follow/unfollow` in `PERSONALITY_NAMES` and `stopToolForAction`)
  - `progressActions` (replaces the `build/gather/dig` set in `_buildExecOpts`)
  - `visionActions` (replaces the `look` filter)
  - `postProcessToolBatch(toolUses, results)` (dig cap, attackEntity/follow
    coupling, `goTo` cant_reach handling move out of the orchestrator)
  - `surfaceBaseline()` (composed as `UNIVERSAL_BASELINE + surfaceBaseline`)
  - `eventAddendum` becomes the ONLY source of attacked/reflex/survival/
    defend prose; `IDLE_TICK_TEXT`, stuck nudges and `SESSION_END_CLAUSE`
    move to adapter prompt blocks (`idleTickText()`, `sessionEndClause()`)
  - `getWorldIdentity() -> {fingerprint, label} | null` (replaces the
    spawn-coordinate assembly in `noteSpawn`; `worlds.js` untouched)
  - `createTelemetry({emit}) -> {setWatching, setAction, stop}`
  - `classifyConnectError(message) -> ErrorClass`
  - `onDeath` and the `reflex|defend` attacker kinds documented.
- Init payload: `game`, `joinTarget` (game-specific object) replace
  `lanPort`/`lanMotd`; `mc_username`/`skinServerBaseUrl` stay Minecraft-only
  inside `joinTarget`.

Main process:

- `src/main/games/index.ts`: `GameModule` registry
  `{ id, effectiveUsername(character), collides(a,b), watcher, getJoinTarget(),
  joinTargetMissingError, install: {detect, install, enable, launch} }`.
  Minecraft's is a thin wrapper over `lanWatcher`, `effectiveMcUsername`,
  `getLanPort/getLanMotd`.
- `botSupervisor.ts`: `summon(characterId, game)`; `ActiveSession.game`; the
  username guard and the join-target branch call the module. Everything
  else (fork, timeouts, credit gate, JWT, chat, pause/mode) unchanged.
- `src/shared/gameIpc.ts`: `GameId`, `WorldState` discriminated union
  (Minecraft's `LanState` becomes one member; `lan:*` channels stay as
  aliases for one release), `GameDashboardSnapshot` union, `world:state`
  push. `BotStatus` gains `game`.
- `main/index.ts`: play row and analytics take the game from the session
  (`playSummaryText(name, gameName)`, `event:{kind:'play', game}`,
  `bot_session_ended {duration_ms, game}`; one event name, so the analytics
  dashboard needs no change), plus `void foldIfDue(...)` at session end,
  which Minecraft has been missing.
- Chat-surface `launch` tool: `game` argument validated against
  `GAME_CATALOG` rows with `selfLaunch && available`; world-status lines read
  the per-game `WorldState`.
- Dashboard service: dispatch on `snapshot.game`; `mcdash:*` channels stay,
  a generic `gamedash:*` set is added for the two new games.

Renderer:

- `gameLaunch.ts`: `LaunchGameId` gains `'stardew' | 'dontstarve'`;
  `activeGameFor`/`endActiveGame` use `summons[id].game`.
- `summonFlows[game]` sharing `launchSummon`; the Minecraft pipeline is
  unchanged behind `summonFlows.minecraft`.
- `GAME_SURFACES[game] = { LaunchPanel, DashboardPanel }` in `ChatScreen`.
- `useDataStore` error-to-modal routing keyed by `(game, errorClass)`;
  `ERROR_COPY` per game; `actionVerb.ts` reads the verb from the dashboard
  `activity` line the bot already ships instead of a Minecraft table.
- Settings: the "Minecraft" group becomes per-game groups.
- `src/shared/games.ts`: `available: true` flips LAST, per game, when its
  vertical slice passes the live checklist.

### 2.3 Stardew Valley adapter

**Mod: `native/stardew-mod/SeiCompanion/`** (C#, net6.0, SMAPI >= 4.5,
`Pathoschild.Stardew.ModBuildConfig`, Lib.Harmony). Built by
`scripts/build-stardew-mod.sh` (dotnet SDK present here: 10.0.302, targets
net6.0 as luy-0 does) into `resources/stardew-mod/SeiCompanion/` (DLL +
`manifest.json` + assets), hooked on `predist` and built in CI on the
Windows and macOS runners.

- Body: `SeiBody = { npc: NPC, shadow: BotFarmer }`. `NPC` registered through
  `Data/Characters` + `Characters/Sei_<n>` sheet via `AssetRequested`; the
  duplicate-NPC sweep on spawn (the game auto-spawns registered characters).
  `BotFarmer : Farmer` with no-op `draw`, `SetMoving*` overrides, own
  `UniqueMultiplayerID`, initial tools, NEVER added to `Game1.otherFarmers`.
  Every command syncs shadow position from the NPC first.
- Actions on the shadow: `Tool.DoFunction(loc, x, y, power, shadow)` for
  hoe/axe/pickaxe/watering can/scythe, `MeleeWeapon.DoDamage`,
  `Object.placementAction(..., shadow)`, `Chest.addItem`/`Items`,
  `crop.harvest`, `location.damageMonster(..., shadow)`, `checkForExhaustion`
  after each. Fishing is a mod-side state machine ending in
  `FishingRod.pullFishFromWater(...)` (the vanilla path opens the BobberBar
  on the host's screen). Shops: read `ShopData`, `ItemRegistry.Create` +
  money from the companion's own `Money`, never the host's wallet.
- Movement: `PathFindController(npc, location, target, facing, endBehavior)`
  same-map; cross-map routing = `WarpPathfindingCache.GetLocationRoute` +
  per-hop path to the warp tile + relocate `characters` membership (no prior
  body does this; both teleport). Stuck detection at 2 s, retarget, then
  teleport-to-player as the last resort (amarisaster).
- Animation: the NPC plays a short swing frame set per tool use with the
  tool's sound; the spike in decision 7 replaces this if it lands.
- Reflex loops (per tick, in `UpdateTicked`): retaliate when a monster hits
  the shadow, step away below 30% health, eat from inventory below 20%
  stamina, walk home and sleep at 1:50 AM, refuse tool use at 0 stamina.
  Each mirrors a Minecraft `behaviors/*` loop and reports through the same
  `sei:attacked` / `sei:survival` event vocabulary.
- Transport: `HttpListener` on `http://127.0.0.1:<port>/` with
  `AcceptWebSocketAsync` on `/ws` (StardewWebApi pattern, zero third-party
  DLLs; JunimoServer's `HttpListenerFix` only if Linux is ever targeted).
  NDJSON frames `{id, t, ...}`; `GET /hello` (no auth) returns
  `{mod, game, smapi, save: {loaded, farmName, uniqueId, day, season} }`.
  Token + port live in the mod's `config.json`, written by Sei's installer
  and read by main. All game-state access is marshalled onto the game thread
  via a `ConcurrentQueue` drained in `UpdateTicked` (StarDojo).
- Chat: Harmony postfix on `ChatBox.receiveChatMessage` (JunimoServer)
  pushes `{from, text, kind}`; speaking = `Game1.chatBox.addMessage("Name: text")`
  on the host plus `npc.showTextAboveHead(text)` bubble. Farmhand delivery is
  a v2 item (needs a client-side mod message).
- Save hygiene: remove the NPC on `Saving` and re-add on `Saved`; shadow
  inventory persisted to `modData` on the host farmer so it survives a
  reload within a session; body removed on `ReturnedToTitle` and on
  bot disconnect after a 10 s grace.
- Multiplayer guard: if any connected farmhand lacks the mod
  (`IMultiplayerPeer.GetMod`), refuse to spawn with a custom sprite and
  report `STARDEW_FARMHAND_NO_MOD` (a custom sprite would error on their
  client per `NetRef` type resolution).

**Bot adapter: `src/bot/adapter/stardew/`**

- `runtime.js`: connect WS with token, resend on reconnect (3 attempts,
  same policy shape as Minecraft), summon = `spawn{name, sprite}` and wait
  for `spawned` inside the supervisor deadline (`summonDeadlineAt` sizing as
  in `connectTimeoutFor`).
- `registry.js` (Zod, ~18 verbs, descriptions in a Stardew section of
  `promptLibrary`): `goTo(location?, x, y | #N)`, `come`, `follow/unfollow`,
  `till`, `water`, `plant(seed)`, `harvest`, `chop`, `mine`, `gather(kind, count)`
  (forage/debris loop), `attack(#N)`, `fish`, `eat(item)`, `equip(item)`,
  `place(item, x, y)`, `chest(put|take, item, count)`, `buy(shop, item, qty)`,
  `interact(#N)` (doors, ladders, machines, talk), `sleep`, `say` (brain tool).
  Every result is a string; failures say why ("no stamina", "tile is not
  tillable", "can't reach: water in the way").
- `observers/snapshot.js`: location, tile-local grid summary around the body
  (radius 8: crops with growth stage, debris, water, breakable rocks/trees,
  chests, machines), monsters/NPCs/players with `#N` handles, inventory,
  stamina/health, time/day/season/weather, warps in reach, follow state, last
  action result. Budget ~1.2k tokens like the Minecraft snapshot.
- `fsmWires.js`: `chat` -> P1, `damaged` -> P0 (`reflex` when the loop
  already handled it), `death`/`passed_out` -> P1, `spawned` -> first idle,
  `day_started`/`night_soon` -> idle ticks with a reason.
- `prompts.js`: `STARDEW_BASELINE`, world primer (seasons, stamina, the day
  clock, that the farm is the player's and the companion asks before
  planting over their plans), capability paragraph, action rules, event
  addenda, idle text ("water the crops, clear debris, forage, fish").
- `telemetry.js`: `{game:'stardew', location, x, y, stamina, health, held,
  items, activity, day, season, time}` at 1 Hz while watched.
- World identity: `${uniqueIDForThisGame}` fingerprint, label = farm name.

**Main: `src/main/games/stardew/`**

- `install.ts`: port of SMAPI's `GameScanner` logic (registry keys,
  `libraryfolders.vdf` app 413150, default paths per OS/store; valid when
  `Stardew Valley.dll` exists), SMAPI presence (`StardewModdingAPI.dll`),
  SMAPI download from the GitHub release (size shown, 60 s timeout,
  AbortSignal) and `SMAPI.Installer.dll --install --no-prompt --game-path`,
  mod folder copy from `resources/`, `config.json` with a fresh token + port.
  Progress events reuse the `WizardProgressEvent` shape.
- `launch.ts`: start `StardewModdingAPI.exe` (Windows) or the macOS launcher
  the SMAPI installer already rewired; a one-time notice explains the Steam
  launch option for achievements on Windows (Sei cannot set it).
- `watcher.ts`: `GET /hello` every 3 s on the configured port ->
  `WorldState {game:'stardew', open{farmName, day, season} | closed |
  not_installed | game_running_no_save}`.

Error classes: `STARDEW_NOT_INSTALLED`, `SMAPI_INSTALL_FAILED`,
`STARDEW_MOD_NOT_ANSWERING`, `STARDEW_NO_SAVE_LOADED`,
`STARDEW_FARMHAND_NO_MOD`, `STARDEW_VERSION_UNSUPPORTED`.

### 2.4 Don't Starve Together adapter

**Mod: `native/dst-mod/sei/`** (Lua, `api_version = 10`, `dst_compatible`,
`all_clients_require_mod = false`, `client_only_mod = false`, config option
`port`). Copied verbatim to `resources/dst-mod/sei/`. `luacheck` in CI.

- `modmain.lua`: only when `TheNet:GetIsServer()`. Wrap
  `GLOBAL.Networking_Say` (9-arg signature) to capture chat. On
  `AddSimPostInit`, start a 2 s heartbeat `GET http://127.0.0.1:<port>/hello?...`
  carrying `{session: TheNet:GetSessionIdentifier(), world: name, day,
  season, phase, players: [{userid, name}], ismastersim, caves}`. The
  response is either `{}` (idle) or `{summon: {token, botPort, name, prefab,
  nearUserid}}`. On summon: `SpawnPrefab(prefab)` next to that player,
  `inst.name`, `skinner:SetSkinMode("normal_skin")`, `entity:SetCanSleep(false)`,
  `SetBrain(require "brains/seibrain")`. Despawn: stop brain,
  `inventory:DropEverything()` (or into a chest the player picks), `pcall(inst.Remove)`.
  The mod is inert (heartbeat only) when nothing answers.
- `scripts/brains/seibrain.lua` (FAtiMA skeleton, MIT): BT root =
  safety layer first (`RunAway` from hostiles when health < 35%, `FindLight`
  at dusk/night without a light source, `ChaseAndAttack` on `attacked` when
  the command says fight, eat when hunger < 25%), then the command slot
  (`DoAction` over a `BufferedAction(inst, target, ACTIONS[name], invobject,
  pos, recipe)`, `Follow(leader)`, `Wander`). Work actions re-issue until the
  `*_workable` tag drops (`KeepWorking`). `gather(prefab, count)` and
  `build(recipe)` are mod-side loops (`builder:MakeRecipe` needs no UI;
  `UsePrototyper` at a science machine when `CanLearn`). `actionfailed`
  reasons and `performaction` results are queued as command results.
- Perception POST at 3 Hz, delta-compressed, capped at 8 KB (Klei's
  QueryServer memory bug starts around tens of KB): `FindEntities` radius 24
  excluding `INLIMBO/NOCLICK/CLASSIFIED/FX`, per entity `{guid, prefab, dx,
  dz, flags}` where flags derive from tags (`CHOP_workable`, `pickable`,
  `_combat`, `hostile`, `player`, `_equippable`, `cooker`, `readyforharvest`,
  ...); self vitals, temperature/moisture, in-light, inventory + equips,
  `combat.target`, `sg` busy, world state. Event POSTs: chat, attacked,
  death, enterdark, actionfailed.
- Command channel: `GET /cmd?since=<seq>&t=<token>` with one in-flight
  request; the bot holds the response up to 400 ms when idle (bounded
  long-poll; the QueryServer timeout is undocumented, so the hold is
  measured on day one and raised only if safe). Effective command latency
  100-400 ms.
- Speaking: `talker:Say(text)` bubble (broadcast to all clients) plus
  `TheNet:Announce("Name: text")` into the chat log, the announcement
  toggle in the mod config.
- Every handler in `pcall`; Lua errors POST to `/error` and land in the
  LogsBar through the bot log router.

**Bot adapter: `src/bot/adapter/dontstarve/`**

- `runtime.js`: start a `node:http` server on an ephemeral 127.0.0.1 port
  with the per-summon token; main's watcher hands the mod the port via the
  heartbeat response; `spawned` = summon ready. Heartbeat loss for 10 s =
  disconnected (same reconnect budget as Minecraft: the world closing is a
  normal end, not a crash).
- `registry.js` (Zod, ~18 verbs): `goTo(x, z | #N)`, `come`, `follow/unfollow`,
  `gather(kind, count)`, `chop`, `mine`, `pick`, `pickup(#N)`, `craft(recipe)`,
  `build(recipe, near)`, `eat(item)`, `equip(item)`, `attack(#N)`, `flee`,
  `lightFire`, `cook(item)`, `store/take(container #N, item, count)`, `sleep`,
  `say` (brain tool). Results are strings with the mod's failure reason.
- `observers/snapshot.js`: day/season/phase/temperature, vitals triple,
  inventory/equips, nearby entities bucketed by what can be done to them
  with `#N` handles, threats, light, last action result, follow state.
- `fsmWires.js`: chat -> P1, attacked -> P0 (`reflex` when the safety layer
  already acted), death -> P1, enterdark -> P0 survival, spawned -> first
  idle, phase change -> idle tick with reason.
- `prompts.js`: `DST_BASELINE`, world primer (the Constant, the three
  meters, day/dusk/night, darkness kills, seasons), capability paragraph,
  action rules, event addenda, idle text ("gather twigs and grass, keep the
  fire fed, cook before dusk").
- `telemetry.js`: `{game:'dontstarve', x, z, health, hunger, sanity,
  temperature, held, items, activity, day, season, phase}` at 1 Hz.
- World identity: fingerprint = session identifier, label = world name.

**Main: `src/main/games/dontstarve/`**

- `install.ts`: Steam path from `libraryfolders.vdf` (app 322330) or the
  Windows registry `SteamPath`; mod dir = `<install>/mods/sei/` (macOS:
  inside `dontstarve_steam.app/Contents/mods/`); write
  `<install>/mods/modsettings.lua` with `ForceEnableMod("sei")` and
  `DisableLocalModWarning()` (preserving other lines), re-applied on every
  Sei launch because game updates and Steam "verify" rewrite that file.
  No download, no installer.
- `watcher.ts`: a long-lived `node:http` listener on the first free port
  of a fixed list (27424..27428; 260909, was one configurable port and a
  matching mod option) serving `/hello`; a heartbeat within
  the last 6 s = `WorldState {game:'dontstarve', open{worldName, day,
  season, caves}}`, else `closed`; not installed = `not_installed`.
- `launch.ts`: `steam://rungameid/322330` (Steam handles the rest; the mod
  is force-enabled so any world the player hosts carries it).

Error classes: `DST_NOT_INSTALLED`, `DST_MOD_INSTALL_FAILED`,
`DST_WORLD_NOT_OPEN`, `DST_SPAWN_FAILED`, `DST_PORT_IN_USE`.

### 2.5 Game packs (approved 260908)

Why: the Minecraft adapter's dependencies (`minecraft-data` 429 MB,
`prismarine-viewer` 392 MB, `gl` 218 MB, mineflayer and friends) are the
bulk of the installed app and are dead weight for a player who never opens
Minecraft. The user's decision 1 makes every game's adapter a download on
first use, Minecraft included.

What a pack is:

- `packs/<game>/` in the repo is an npm WORKSPACE package (`packs/minecraft/
  package.json` lists mineflayer, mineflayer-pathfinder, mineflayer-auto-eat,
  minecraft-data, prismarine-viewer, vec3, gl, node-canvas-webgl, three and
  whatever else only `src/bot/adapter/minecraft/**` imports). The root
  `package.json` does NOT depend on it. Root `npm ci` still installs and
  hoists the workspace's deps, so `npm run dev` and vitest resolve them as
  today. electron-builder 26's npm collector walks `npm list --omit dev`
  from the root, so packages reachable only through the workspace are not
  packed. `three` stays a root dependency (the chess scene bundles it);
  `minecraft-protocol/src/version.js` is a build-time renderer import and
  needs no runtime copy.
- `scripts/build-game-pack.mjs <game> [--platform --arch]` produces
  `sei-pack-<game>-<appVersion>-<platform>-<arch>.zip` (or `-any` for packs
  with no native code) containing `node_modules/` (production install of the
  workspace, native modules rebuilt against Electron's ABI for the target
  arch, the same texture prunes electron-builder.yml applies today) plus
  `assets/` (Stardew: the built SMAPI mod; DST: the Lua mod), and a
  `pack.json` `{game, version, platform, arch, treeHash, files}`. `treeHash`
  is a hash over sorted relative paths and file contents, so two builds of
  the same lockfile compare equal even though their zips do not.
- CI: the release workflow's mac and win legs build the packs beside the
  app (mac: arm64 and x64), a `game-packs-<version>.json` manifest lists
  every pack with its sha256, size and treeHash; all of it is uploaded with
  the other release assets, so `mirror-release.yml` mirrors it unchanged.
- Client: `src/shared/gamePacks.ts` (descriptor per game: id, platform
  specific or not, which adapter needs it); `src/main/games/packs.ts`
  (`getPackState(game)`, `ensurePack(game, {onProgress, signal})`: fetch the
  manifest mirror first (`https://dl.sei.gg/updates/...`) then the GitHub
  release URL, download to a temp file, verify sha256, extract with jszip
  into `<userData>/game-packs/<game>/<version>/`, write `installed.json`,
  delete older versions; a matching `treeHash` on an installed pack is
  re-linked without a download). Progress rides a `game:pack-progress`
  push; the launch panel shows a download card before the first launch of
  a game and the supervisor awaits `ensurePack` before forking. Failure is
  `GAME_PACK_DOWNLOAD_FAILED` with the URL tried and the size, like
  `MOD_DOWNLOAD_FAILED`.
- Bot: the init payload carries `packRoot`. `src/bot/packLoader.js`
  registers a `module.register()` resolve hook BEFORE the composer
  dynamic-imports the game runtime; the hook rewrites bare specifiers to
  resolve from `<packRoot>/` so `import mineflayer from 'mineflayer'` inside
  the in-app adapter code finds the pack's node_modules, and CJS requires
  inside the pack resolve within the pack as normal. In dev (unpackaged)
  `packRoot` is the repo root and the hook is a no-op. No import in
  `src/bot/adapter/**` changes.

Unbundling Minecraft is the risky half of this decision and gets its own
verification step in M3: a packaged build on a clean machine must summon
into a LAN world after downloading the pack, with vision mode on.

### 2.6 What is reused, with licenses

- Stardew: Farmtronics (MIT) `BotFarmer`, `BotObject` tool/harvest/placement
  code; amarisaster/StardewValley-MCP (Apache-2.0, keep NOTICE) NPC+shadow
  pairing, `UseToolAt`, follow/stuck logic, `Data/Characters` injection;
  StardewWebApi (MIT) HttpListener + WebSocket server; StarDojo (MIT)
  game-thread marshalling, observation exporters; JunimoServer (MIT) chat
  postfix; luy-0/StardewValley-MCP (Apache-2.0) protocol/auth design as a
  reference; SMAPI (LGPL-3.0) GameScanner LOGIC ported, binary downloaded.
- DST: FAtiMA-DST and DST-AICompanion (MIT) brain skeleton, perception
  encoder, DoAction wrapper, Follow/RunAway wiring; Chat Announcements (CC0)
  POST handling. DS-AI behaviours (unlicensed) and DST_Bridge (GPL) are
  design reference only.

---

## 3. Performance

Targets are the Minecraft adapter's, since the brain and its cadence are the
same; the new costs are the mods inside the game processes.

| Item | Stardew | DST | Note |
|---|---|---|---|
| Command latency (bot -> body starts) | ~5 ms (WS push) | 100-400 ms (poll + hold) | Both well under the LLM turn (2-6 s) |
| Observation cadence | 4 Hz push, ~3 KB | 3 Hz POST, <= 8 KB, deltas | Only the newest is read per turn |
| Game-side CPU | tile scan radius 8 + entity list per push; reflex checks per tick | one `FindEntities` r=24 per push; BT per frame | Budget: < 1 ms per frame on a 2020 laptop, measured before flipping `available` |
| Snapshot text per turn | ~1.2k tokens | ~1.0k tokens | Same budget as the Minecraft composer; cached prefix layout unchanged |
| Summon | connect + spawn inside the 30 s supervisor deadline | heartbeat handoff (<= 2 s) + spawn | `summonDeadlineAt` sizing rule applies to both connects |
| Stop | despawn + disconnect < 10 s | drop inventory + remove < 10 s | Then the supervisor kill path as today |
| Bot process | no mineflayer loaded (dynamic import) | same | Roughly 40 MB less RSS than a Minecraft session |
| Reflex loops | 60 Hz in `UpdateTicked` | per-frame BT nodes | Never wait on the LLM |

Prompt caching: the adapter blocks sit in the same cached system prefix
slots the Minecraft adapter fills; nothing per-turn moves above the
breakpoint. Idle cadence, iteration cap (30), say-suppression and memory
compaction are untouched.

Transport safety: Stardew token per install in the mod config; DST token per
summon in the URL query (QueryServer cannot set headers), bound to 127.0.0.1,
requests without the token get 401 and never reach a handler. Payload caps on
both sides. The DST bounded long-poll hold is measured against QueryServer's
undocumented timeout on day one (report risk 4) and defaults to 400 ms.

---

## 4. User experience

Same shape as Minecraft, so a player who has summoned into a LAN world knows
the flow: pick the game tile, get the world open, press Launch, the companion
appears next to you and starts talking in chat.

1. **Games picker.** The Stardew and DST tiles (art and copy already in
   `lib/games.ts`, zh translated) flip from "coming soon" to playable per
   game. The companion learns of them through `renderGamesDirective()` with
   no prompt edits; `launch` gains a `game` argument so she can start either
   herself, as she starts Minecraft.
2. **Launch panel** (`GAME_SURFACES[game].LaunchPanel`, hosted in
   `GameSurface` beside the chat like `McLaunchPanel`). Three states:
   - **Set up**: install card (detected install path; "Install SMAPI + Sei's
     helper" / "Add Sei's helper to Don't Starve Together"), progress bar in
     the setup-wizard style, one-time explanations: Stardew on Windows loses
     Steam achievements unless the player adds a launch option (shown with a
     copy button); DST prints a "local mod" notice in its own log and the
     helper is inert until Sei asks.
   - **Waiting for your world**: "Open your farm" / "Host a world" with a
     "Launch Stardew Valley (with Sei)" / "Launch Don't Starve Together"
     button; the watcher auto-resumes the pending summon when the world
     opens, exactly like the LAN watcher does today.
   - **Launch**: the button, the character's in-game name, and for DST the
     survivor pick (Wilson default; per-character choice saved in
     `avatar_prefs`-style sparse config, never in `character.metadata`).
3. **In game.** Stardew: an NPC with the character's sprite walks beside the
   player, speech bubble above its head, lines also in the chat box as
   "Name: ...". DST: a survivor with the character's name, speech bubbles
   through `talker`, lines announced into the chat log. The player talks by
   typing in the game's own chat (Stardew: T, DST: Enter); on a voice call
   the call routes the line as it does for Minecraft.
4. **Dashboard** (`GAME_SURFACES[game].DashboardPanel`): the controls window
   (reactive/proactive, play/pause) and status strip are reused unchanged;
   the vitals row is per game (Stardew: stamina/health, time, season;
   DST: health/hunger/sanity, day/phase, temperature), inventory list, and a
   location line instead of the Minecraft minimap in v1.
5. **Errors** are per-game copies of the Minecraft ones: not installed
   (with the detected paths we looked in), install failed (with the log
   tail), world not open (with the exact in-game steps), farmhand without
   the mod (Stardew), version unsupported.
6. **Cross-launch gate** unchanged: one game per character; a Stardew or DST
   summon is exclusive with Minecraft, chess, Draw! and backseat through
   `gameLaunch.ts`.
7. **Continuity and analytics** as the contracts require: play row "You and
   Marv played Stardew Valley for 12 minutes.", `foldIfDue` at session end,
   `remember()` available (it is the brain's), `bot_session_ended` with
   `game`, `character_summoned` with `game`.
8. **Settings**: per-game groups (Stardew: install status, achievements
   note; DST: install status, game folder; the discovery port row went 260909). Vision mode stays
   Minecraft-only.

---

## 5. Work plan

Two parallel implementation agents after M0, each in its own worktree branch
off `feat/game-adapters`, merged back into it; nothing is merged to `dev`
before the live checklist.

- **M0 (one agent, ~2 days): shared generalization.** Section 2.2, with
  every Minecraft test green and `portForwarders`, `botSupervisor.summon`,
  `gameLaunch` tests extended for the enum. Ends with `GAME_CATALOG`
  untouched (both tiles still coming soon).
- **M1 (agent A, parallel): Stardew vertical slice.** Mod + adapter + main
  module + renderer panels. Directory ownership: `native/stardew-mod/`,
  `src/bot/adapter/stardew/`, `src/main/games/stardew/`,
  `src/renderer/src/components/stardew/`, `src/shared/stardewIpc.ts`, plus
  one-line registrations in the M0 registries and its i18n keys.
- **M2 (agent B, parallel): DST vertical slice.** Same shape:
  `native/dst-mod/`, `src/bot/adapter/dontstarve/`,
  `src/main/games/dontstarve/`, `src/renderer/src/components/dontstarve/`,
  `src/shared/dstIpc.ts`.
- **M3: live checklist**, per game, on a machine with the game installed
  (neither is installed on this Mac; Steam is; both are about 15 USD):
  install from a clean state, launch, summon, follow, one of each verb
  family, chat both ways, voice-call line routing, pause/mode, stop,
  despawn hygiene (save reload shows no leftover), crash of the game mid-
  session, second summon in the same world, then flip `available`.
  **DST progress (260909, live on this Mac via computer use):** install
  from a clean state (helper copied from a shell after the App Management
  grant; the dev Electron never got the grant), restart detection, Host
  Game, Launch, greeting in game chat, `come` on command (arrived 1.1 away),
  follow (trails at 4-10 units while the host walks), stop on world
  shutdown (GAME_WORLD_NOT_OPEN), re-summon into the resumed world: PASS.
  Fixed on the way: empty seed_cuboid_grammar block (400 upstream, 502 via
  proxy), Minecraft goals leaking into DST, come/follow beyond the 24-unit
  sweep (userid fallback), heartbeat on sim time flapping the world during
  autopause. Second round (260909, later): pause/resume/mode, chop+pickup+build
  (ingredient check)+gather+come from one instruction, game crash (kill -9)
  -> clean stop + Try again into the resumed save, SIGKILL of the bot ->
  Connection lost modal + the helper's own despawn (4 s), one-companion
  gate for a second character: PASS. Body died overnight with the host AFK
  (dark + sanity + hunger): death path PASS, survival layer OWED. Orphan
  body after the watchdog despawn under investigation (despawn steps now
  logged). Still owed: one of each verb family beyond gather/pick/goTo,
  in-game chat typed by the player (needs a focused game; keystrokes never
  reach DST from background computer use), voice-call routing, pause/mode,
  game crash mid-session, second summon, despawn hygiene on save reload.

Test discipline (offline, no Electron launch): vitest for every adapter file
against recorded observation fixtures; a fake mod (`scripts/fake-stardew-mod.mjs`,
`scripts/fake-dst-mod.mjs`) speaking each protocol so the runtime, summon
timeout and reconnect paths run in CI; `dotnet build` of the SMAPI mod on
CI; `luacheck` on the DST mod; the seams tests listed in M0.

Spikes, time-boxed to half a day each, not on the critical path:

- Stardew: draw the shadow `Farmer` with `FarmerRenderer` as the visible body
  (decision 7). Success = a farmer-looking body with real swing animations
  and no host-side side effects. Replaces the NPC + swing frames if it lands.
- DST: `all_clients_require_mod = false` with a second client joining
  (nobody has demonstrated it); ownerless `inst:Remove()`; caves-enabled
  host (master sim in the shard process); QueryServer hold time.

---

## 6. Risks (top five, the reports carry the full lists)

1. **Stardew animation fidelity and fishing.** A shadow farmer applies
   effects without the swing; fishing must bypass the minigame. Both are
   re-implementation, not unknowns; the spike may remove the first.
2. **DST ownerless-player edge cases** (`userid == nil`): despawn,
   nameplate, hound waves and world-reset counting the bot. Day-one test
   matrix, every call wrapped, fallback = park the entity far away and stop
   the brain.
3. **Version churn.** Stardew 1.6.x patches and monthly DST builds. Keep
   both mods on public APIs, pin `MinimumApiVersion`/`api_version`, gate on
   the reported game version, build the SMAPI mod in CI per release.
4. **Klei re-tightening `QueryServer`.** They did once (Jan 2025) and carved
   localhost back out within 12 days; fallback is the persistent-string
   mailbox, which is slower but sanctioned.
5. **Install friction.** SMAPI on macOS trips Gatekeeper prompts; Windows
   achievements need a launch option Sei cannot set; DST's `modsettings.lua`
   gets rewritten by updates. All three are copy plus re-apply-on-launch, not
   blockers.

---

## 7. Decisions needed before implementation

1. Bundle both mods in the app (recommended) or download at first use.
2. Stardew body art for v1: a small set of original bundled sprite sheets
   picked per character (recommended; a generator from the character's
   portrait is a later feature), or a vanilla sheet reused for the spike.
3. DST survivor: fixed Wilson (simplest) or per-character choice from the
   vanilla roster (recommended, sparse per-character pref).
4. Scope confirmation: host-only v1 for both, farmhands/joiners in v2.
5. Platforms: Windows and macOS for both (the code paths differ only in
   install detection); Linux deferred.
6. Live testing: approve buying both games on the test machine, or name a
   machine that has them, before M3.

---

## 8. Approved decisions (260908)

The user's answers to section 7, verbatim in intent:

1. Game adapters download on first use, and Minecraft moves to the same
   mechanism. Design in section 2.5.
2. Stardew body art: default art for now (a vanilla-style sheet the mod
   ships; no per-character sprites in v1).
3. DST survivor: the character chooses on first launch. A one-off LLM call
   (`src/main/games/dontstarve/survivorPick.ts`, the `chessProfile.ts`
   pattern) gets the persona plus a roster brief of every eligible survivor
   (perks, downsides, stats, sourced from the DST wiki and verified) and
   returns a prefab id, persisted sparse per character in
   `UserConfig.dst_survivor[characterId]` (never `character.metadata`). The
   chosen survivor's brief is appended to the adapter's world primer so the
   brain plays to its perks. Eligible roster: every vanilla survivor whose
   mechanics a body without a client can carry (Wilson, Willow, Wolfgang,
   Wendy, WX-78, Wickerbottom, Woodie, Maxwell, Wigfrid, Webber, Winona,
   Wortox, Wormwood, Warly, Wurt, Walter, Wanda); Wes and Wonkey are
   excluded (deliberate handicap; unlock-only monkey). DLC survivors spawn
   server-side regardless of ownership; if a live test shows otherwise the
   list shrinks to the base twelve.
4. Host-only v1 for both games, like Minecraft's LAN host.
5. Windows and macOS.
6. Hold before live testing (M3 waits for the user).
7. Every open-source library or mod code reused is credited in the README
   Acknowledgements list, in the mineflayer entry's format, with its
   license.
