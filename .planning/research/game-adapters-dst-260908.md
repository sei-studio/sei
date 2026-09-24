# Don't Starve Together companion body: research report

Date: 2026-09-08. Scope: can the existing Sei brain (Node: LLM + Zod action
registry + FSM, currently bodied by mineflayer) drive a visible, autonomous
survivor in a non-technical player's own Don't Starve Together (DST, Steam PC)
world, and how does the Node process talk to the game.

Clones live under
`/private/tmp/claude-501/-Users-ouen-slop-sei-studio-sei/b7e70bff-0e01-4e13-ac55-e80b1ace87dd/scratchpad/research/dst/`
(referred to below as `research/dst/`). Two Klei script mirrors are there too:
`klei-scripts/` (build ~2024-09) and `klei-scripts-2/` (build 747465,
2026-08-13, the current game).

Confidence scale used: HIGH = read in source or official patch note; MEDIUM =
consistent secondary sources or inference from source; LOW = plausible, not
verified. Anything marked TEST needs a live check in the game before design
commits to it.

---

## 1. Executive summary

**Viable and recommended: a server-side Lua mod that spawns a vanilla player
prefab (e.g. `wilson`, `wx78`) as an ownerless entity, attaches a custom Brain,
and talks to the Node bot over HTTP to `127.0.0.1` via `TheSim:QueryServer`.**

Why this and not the alternatives:

- **The body exists in vanilla.** `MakePlayerCharacter` (Klei
  `prefabs/player_common.lua`) builds, on the master sim, an entity with
  `locomotor`, `combat`, `inventory`, `builder`, `eater`, `health`, `hunger`,
  `sanity`, `temperature`, `moisture`, `talker`, the `SGwilson` stategraph and
  198 action handlers. The input-side components (`playercontroller`,
  `playeractionpicker`) are only added when a network client takes ownership
  (`OnSetOwner`), and every reference to them in `SGwilson` is nil-guarded. So
  `SpawnPrefab("wilson")` + `inst:SetBrain(...)` yields a survivor that other
  players see, hit, trade with, and that can walk, chop, craft, eat and fight
  through the exact same `BufferedAction` path a real player's actions take
  server-side. Two independent projects did exactly this and shipped it:
  FAtiMA-DST (2018, Workshop "Walter") and DST-AICompanion (2024, a master's
  thesis, WX-78 body). Confidence HIGH that it works; MEDIUM on the long tail of
  systems that assume a player has a `userid` (see risks).
- **Because the body is a vanilla prefab, the mod can be server-only**
  (`all_clients_require_mod = false`): friends joining the world need nothing
  installed. Brains run only on the server, and no new prefab or asset is
  replicated to clients. Confidence MEDIUM-HIGH (both prior mods set
  `all_clients_require_mod = true` without needing to; the engine logic in
  `mods.lua` / `networking.lua` only pushes `all_clients_require_mod` mods to
  clients). TEST.
- **The transport survived Klei's 2025 lockdown, on purpose.** Update 651414
  (2025-01-24) blocked `io.open` writes, blocked `TheSim:QueryServer` from any
  third-party URL, and blocked persistent-string writes to auto-run files, in
  response to a self-spreading malicious mod. Hotfix 653007 (2025-02-05)
  restored exactly one hole: "TheSim:QueryServer on either the client or server
  may now query to localhost or 127.0.0.1", plus `io.open` writes into an
  `unsafedata/` directory. A localhost HTTP server owned by our Electron app is
  therefore the one sanctioned way for a mod to reach an external process
  today. Confidence HIGH (verbatim patch notes).
- **It works for the normal "Host Game" flow.** In a client-hosted world the
  host's game process is the master sim (`TheWorld.ismastersim == true`,
  `TheNet:GetIsServer() == true`), and `QueryServer` exists in the client
  build (Klei uses it from the main menu). If the host enables Caves, DST
  launches local `dontstarve_dedicated_server_nullrenderer` processes for the
  shards and the mod runs there instead; the localhost HTTP path is identical
  from either process. Confidence HIGH for the listen-server case, MEDIUM for
  the caves case (not re-verified live).
- **Chat both ways is available server-side.** Input: wrap the global
  `Networking_Say(guid, userid, name, prefab, message, ...)`, which the engine
  calls on the server for every chat line (three shipped mods do this). Output:
  `talker:Say(text)` on the bot broadcasts a speech bubble to all clients via
  `TheNet:Talker`; for the chat log, `TheNet:Announce(...)` /
  `TheNet:SystemMessage(...)`. Putting a line into the chat log *as a named
  player* has no public server API; `talker:Chatter` can echo to chat with the
  entity's display name but only resolves strings from the client's `STRINGS`
  table, so arbitrary LLM text needs the announcement route. Confidence HIGH.
- **Installation can be zero-click.** Drop a folder into `<install>/mods/sei/`
  and either write `ForceEnableMod("sei")` into `<install>/mods/modsettings.lua`
  (engine-supported developer hook, prints a warning to the log) or write the
  per-world `modoverrides.lua` the in-game Mods tab itself writes to
  `<Documents>/Klei/DoNotStarveTogether/<KU_id>/Cluster_N/Master/modoverrides.lua`.
  Confidence HIGH on mechanism (read `modindex.lua`, `shardsaveindex.lua`).

**Not viable: a second real player slot driven by a headless client.** There
is no headless DST client (`nullrenderer` is the *server* binary), the client
requires Steam + a Klei account, Steam runs one instance per account, and the
only known two-instance trick uses a Steam API emulator DLL. No
mineflayer-style protocol library exists. See fact 2.

**Plan B if the mod route stalls:** bundle the free dedicated server
(SteamCMD app 343050, `+login anonymous`) and host the world from our app with
`-console` so Lua goes in over stdin; the player joins their own LAN server.
Transport becomes trivial but the player's existing worlds must be migrated
and the UX is no longer "my normal world".

**No existing project is an LLM-driven DST companion we can adopt.** The
closest (FAtiMA-DST, MIT) is a 2018 rule-agent bridge whose mod-side pattern
(perception POST, decision GET, DoAction/Wander behaviour tree) is the right
skeleton; the richest behaviour library (Artificial Wilson, ~3900 lines of
behaviour trees for gathering/cooking/science/light/clothes) is single-player
Don't Starve, unlicensed, and only partly portable.

---

## 2. Prior art table

| Project | URL | License | Last activity | Lang | What it is | Relevance |
|---|---|---|---|---|---|---|
| FAtiMA-DST ("Walter - The AI Companion") | https://github.com/hineios/FAtiMA-DST ; Workshop 1339264854 | MIT | 2018-11-21 (Workshop item 2018-03-23) | Lua + C# | DST mod spawns `wilson` with a Brain that POSTs perceptions / GETs decisions from a local C# HTTP server running the FAtiMA agent toolkit | **Highest.** Proves body + HTTP transport; mod pattern is reusable |
| DST-AICompanion | https://github.com/votus777/DST-AICompanion | MIT | 2024-01-10 | Lua + C# (binaries) | Fork of FAtiMA-DST for a master's thesis: WX-78 body, personality config, follow/run-away nodes, speech-system hook | High. Confirms the approach still worked on 2023-24 DST; 2112-line brain with Follow/RunAway/inventory helpers |
| Artificial Wilson (DS-AI) | https://github.com/KingofTown/DS-AI ; DST port Workshop 2571021979 (2021, source not published) | none (unlicensed) | 2021-07-22 | Lua | Single-player Don't Starve behaviour-tree bot: gather, cook, science, light, clothes, combat helpers | High for behaviour ideas; unlicensed, DS-only APIs (GetPlayer, api_version 6) |
| DontStarveAI (Artificial Wilson LLM) | https://github.com/pedropcamellon/DontStarveAI | "Public domain / MIT" for additions; base is DS-AI (unlicensed) | 2026-03-17 | Lua + Python | DS-AI plus a Python/Ollama goal planner reading a JSON state file the mod writes | Medium. Single-player DS, file bridge (`io.open` write, which DST blocked in 2025); goal/planner code is Python |
| DST-MOD-REST-API | https://github.com/Hicsy/DST-MOD-REST-API | none | 2020-09-10 | Lua | Server-only mod: POSTs server status, polls a command queue every 3 s and `loadstring`-executes commands | Medium. Minimal, clean `QueryServer` GET/POST usage; `all_clients_require_mod=false` |
| Chat Announcements (Discord) | https://github.com/gyroplast/mod-dont-starve-chat-announcements | CC0-1.0 | 2021-12-25 | Lua | Server-only mod POSTing JSON embeds to a Discord webhook via `QueryServer` | Medium. Confirms POST with JSON body works (Discord requires JSON); broke for external URLs after 2025-01 |
| DST_Bridge (游戏消息桥) | https://github.com/Sodium-Aluminate/DST-Mods (DST_Bridge) | GPL-3.0 | 2023-05-29 | Lua + Java | Server-only mod bridging in-game chat with Telegram/Bilibili via an HTTP server: hooks `Networking_Say`, pushes JSON, polls | Medium. Reference for chat hook + poll loop. GPL: read only |
| dst-mod-moderator | https://github.com/jupitersh/dst-mod-moderator | GPL-3.0 | 2021-04-07 | Lua | Chat-command moderation by wrapping `Networking_Say` | Low. Chat hook pattern. GPL |
| dst-broadcasts (core.ListenSay) | https://github.com/zhzwz/dst-broadcasts | none | 2026-08-11 | Lua | Current-era mod with a clean server/client `Networking_Say` listener abstraction | Low-medium. Confirms hook still valid in 2026 |
| dont-starve-AIbot (peter-zx) | https://github.com/peter-zx/dont-starve-AIbot | MIT | 2025-05-06 | Python + Lua stub | Screenshot + pyautogui + LLM controlling the *player's own* character | Low. Screen-driving; not a companion |
| dont-starve-AIbot (DemoThree) | https://github.com/DemoThree/dont-starve-AIbot | Apache-2.0 | 2026-07-03 | Python + Lua | Screenshot + multimodal LLM; a mod exports entity coordinates with `TheSim:SetPersistentString` to the cluster save dir, Python reads the file | Low for control; **useful evidence** of the persistent-string file location on a 2026 build |
| QueryServer Fix | Workshop 3486748167 | none | 2025-05-24 (upd. 2025-06-28) | Python exe + Lua | Local proxy on 127.0.0.1 that forwards `QueryServer` calls to the internet, defeating the 2025 restriction | Evidence only: confirms localhost is the allowed hole |
| DST dedicated-server panels (dst-admin, dst-admin-go, vox-launcher) | github.com/qinming99/dst-admin (MIT), carrot-hu23/dst-admin-go (GPL-3), diogo-webber/vox-launcher (MIT) | see left | 2026 | Java/Go/Python | Manage dedicated servers; send console commands over stdin/screen | Low. Only relevant to Plan B |
| Klei script mirrors | github.com/vietnd69/dst-scripts (747465, 2026-08), github.com/taichunmin/dont-starve-together-game-scripts (2024) | none (Klei copyright) | 2026-08-13 | Lua | The game's own Lua | Reference only |

Not found despite searching: any DST reinforcement-learning/gym environment;
any "AI survivor" Workshop mod other than Walter/Artificial Wilson with
published source; any DST mod using websockets (impossible: no sockets in the
Lua sandbox).

---

## 3. Per-project deep dives

### 3.1 FAtiMA-DST (hineios, MIT) — `research/dst/FAtiMA-DST/`

Files: `FAtiMA-DST/modmain.lua` (95 lines), `FAtiMA-DST/scripts/brains/fatimabrain.lua`
(508 lines), `FAtiMA-Server/*.cs` (C# `HttpListener` on `http://localhost:8080`).

- **Spawning.** `AddSimPostInit`: if `TheWorld.ismastersim`, find the
  `multiplayer_portal`, then N times `SpawnPrefab("wilson")`, `AddTag("FAtiMA-Brain")`,
  `SetPosition(portal)`, `char:SetBrain(require "brains/fatimabrain")`,
  `char:RestartBrain()`. The same brain can also be attached to `ThePlayer`
  (click the sanity badge) "only if your game instance is also the server".
- **Observation** (`FAtiMABrain:Perceptions`, every 0.75 s): `TheSim:FindEntities(x,y,z,21,nil,{"INLIMBO","NOCLICK","CLASSIFIED","FX"})`,
  per entity GUID/prefab/stack/tags (`CHOP_workable`, `pickable`, `cooker`,
  `_equippable`, `readyforharvest`, ...), `inventory.itemslots` /
  `equipslots`, `health.currenthealth`, `hunger.current`, `sanity.current`,
  `inst:GetTemperature()`, `IsFreezing`, `IsOverheating`, `GetMoisture`,
  position. POSTed as JSON to `/<guid>/perceptions`. World state via
  `inst:WatchWorldState("phase"|"season"|...)` and `ListenForEvent("clocktick", ..., TheWorld)`
  → POST `/<guid>/events`. Combat events: `killed`, `attacked`, `death`,
  `onhitother`, `onmissother`.
- **Action** (`Decide`, GET `/<guid>/decide/Behaviour` every 2 s, `/Dialogue`
  every 10 s): response JSON `{Type:"Action", Action:"CHOP", Target:guid,
  InvObject:guid, PosX/PosZ, Recipe}`; the brain interrupts the current action
  (`inst:InterruptBufferedAction()`, `locomotor:Clear()`) and a
  `PriorityNode{ IfNode(has action, DoAction(inst, fn->BufferedAction(inst, Ents[target], ACTIONS[name], Ents[invobject], pos, recipe), "DoAction", true)), WhileNode(action==WANDER, Wander(...)) }`
  executes it. Work actions (CHOP/MINE/HAMMER/DIG) are re-issued until the
  `*_workable` tag disappears. Speech: `inst.components.talker:Say(utterance)`.
- **Transport:** `TheSim:QueryServer(url, cb(result, isSuccessful, http_code), "POST", json.encode(data))`
  and `"GET"`. The dissertation states the game's Lua "blocks any importation
  of external libraries", that HTTP was chosen over files/DB because the game
  "provided an easy way to make requests and register callback functions", and
  that the limitation is "we cannot send messages from the server to the
  client, only respond to client's requests", hence polling.
- **Controls a player prefab, not a custom prefab.** `modinfo.lua` says
  `all_clients_require_mod = true`, but nothing in the mod needs a client (no
  prefabs, no assets beyond an unused placement anim). Evaluation in the
  thesis: 30 runs each, Walter survived 3 days on average vs 8.9 for Artificial
  Wilson (19 rules vs 70+ BT nodes).
- **Reusable:** the whole brain skeleton (perception encoder, DoAction wrapper,
  KeepWorking rule, world-state watchers). MIT.

### 3.2 DST-AICompanion (votus777, MIT) — `research/dst/DST-AICompanion/`

`DST Mod/modmain.lua` is FAtiMA's plus CSV logging through `io.open(MODROOT.."graph_data.csv","w")`
(this write path was blocked by DST 651414 in Jan 2025). Spawns `wx78` instead
of `wilson`. `scripts/brains/fatimabrain.lua` grew to 2112 lines: perception
interval 0.5 s, decision 1.5 s, a `follower` leader with
`Follow(inst, fn->leader, min, target, max)`, `RunAway(inst, "hostile", ...)`
and `RunAway(inst, fn->combat.target, 6, 10)` nodes, distance tracking to the
human (`UpdatePlayerDist`), a "vision score", speech via `talker:Say`, and a
"speech system" where player utterances go DST → FAtiMA → external speech
service ("Agent not only replies to player's utterances, it can perform proper
actions", e.g. come closer when asked for help). README: "Mod files depend on
the game version"; recommends Ctrl+R world reload when the AI gets stuck.
Ships the FAtiMA-Server binaries (no C# source in this fork). Also confirms the
approach ran on 2023-era DST with the host in "Host Game → Friends Only".

### 3.3 Artificial Wilson / DS-AI (KingofTown, unlicensed) — `research/dst/DS-AI/`

Single-player Don't Starve (`api_version = 6`, `GetPlayer()`, `GetWorld()`),
0.3 from 2021. `modmain.lua` either replaces the player's brain
(`player:SetBrain(require "brains/artificalwilson")`, keeping
`playercontroller`) or spawns a second `wilson` with `follower`, `homeseeker`,
`inventory` and the brain. It also monkey-patches `locomotor.OnUpdate` for RoG
pathfinding and adds `prioritizer`, `chef`, `cartographer` components. The
brain (`artificalwilson.lua`, 893 lines) is a big `PriorityNode` with a
`GATHER_LIST` FIFO, `CanIBuildThis` recursive recipe/tech check,
`addRecipeToGatherList`, and behaviours in `scripts/behaviours/`:
`managehunger`, `managehealth`, `managesanity`, `manageclothes`,
`findresourceonground`, `findresourcetoharvest`, `findtreeorrock`,
`findormakelight`, `selfpreservation`, `doscience`, `cookfood`,
`gordonramsay` (crock-pot), `manageinventory`, `dontbeonfire`,
`findthingtoburn`. Branches `develop`, `feature/*` are 2015; the DST Workshop
port (2571021979, "Artifical Wilson (DST)", 2021-08, updated 2021-11, "Bot
Limit Per Player" setting) never got a public repo. No license file: treat as
read-only reference; re-implement rather than copy.

### 3.4 DontStarveAI (pedropcamellon) — `research/dst/DontStarveAI/`

DS-AI with an `llm_state_exporter` component that writes
`state/game_state.json` via `io.open("../mods/ds_llm/state/...","w")` (DS, not
DST), and a Python agent (`agent/`: `state_reader`, `goal_manager`,
`goal_planner`, `action_planner`, `ollama_client`, `memory.py`) that picks
mid-term goals with a local LLM. README: "not yet a fully autonomous end-to-end
Wilson controller". Its `mod_api_docs/file-io.md` (author's notes) records
sandbox facts consistent with ours: no sockets, `io.open` relative to the game
executable, persistent strings under `Documents/Klei/...`, JSON global
`json.encode/decode`. Its own additions are "Public domain / MIT"; the base is
DS-AI (unlicensed).

### 3.5 DST-MOD-REST-API (Hicsy, unlicensed) — `research/dst/DST-MOD-REST-API/`

`modmain.lua`: guarded by `TheNet:GetIsServer()`; builds a status report
(`TheNet:GetClientTable()`, `TheWorld.state`, topology) and POSTs it with
`TheSim:QueryServer(APIURL_STATUS, cb, "POST", json.encode_compliant(data))`;
every 3 s GETs `/commands?status=New`, `json.decode`s `{commands:[{id,command}]}`
and runs each with `loadstring(cmd)` in `pcall`, POSTing `{status}` back. Uses
`AddPrefabPostInit("world", fn)` to hang `DoPeriodicTask` on the world entity.
`all_clients_require_mod = false`. Note in code: "As per scripts/json.lua:
encode() is not json compliant, only use encode_compliant()". Confirms the
poll-for-commands shape and server-only packaging.

### 3.6 Chat Announcements (gyroplast, CC0) — `research/dst/chat-announcements/`

Server-only (`all_clients_require_mod = false`). `client/discord.lua` posts
`json.encode({username=..., embeds={...}})` with `TheSim:QueryServer(url, cb, "POST", body)`
and treats `isSuccessful and 200 <= resultCode <= 299` as success; validates
the webhook with a GET. Discord's webhook endpoint requires a JSON body, so
this is evidence that POST bodies go through in a form Discord accepts
(content type not controllable from Lua). CC0: freely reusable
(`lib/logging.lua`, `lib/util.lua` are small utilities).

### 3.7 DST_Bridge (Sodium-Aluminate, GPL-3.0) — fetched via API, not cloned

Server-only chat bridge. Hooks `GLOBAL.Networking_Say = function(guid, userid, name, prefab, message, colour, whisper, isemote) if TheNet:GetIsServer() and inst.ismastershard then ... end; return old(...) end`,
POSTs `{name, message}` JSON to `/sendMessage`, polls `/getMessage` with
`TheWorld:DoPeriodicTask`, prints inbound lines with `TheNet:SystemMessage`.
Config persisted with `TheSim:SetPersistentString`. GPL: pattern only.

### 3.8 dst-broadcasts `core.ListenSay` (2026) and dst-mod-moderator (2021)

Both wrap `GLOBAL.Networking_Say` with the 9-arg signature
`(guid, userid, name, prefab, message, colour, whisper, isemote, user_vanity)`
and dispatch to server- or client-side listeners. ListenSay's comment: "must
assign GLOBAL: assignments in the mod env do not override the global the game
actually calls" and it installs the hook in `AddSimPostInit`.

---

## 4. Technical facts

### 4.1 Spawning a separate AI-controlled survivor from a server-side mod — HIGH (works), MEDIUM (edge cases)

What `SpawnPrefab("wilson")` gives you on the master sim (Klei
`prefabs/player_common.lua`, build 747465, `MakePlayerCharacter`):

- Common (both sides): `table.insert(AllPlayers, inst)`, Transform/AnimState/
  Network/MiniMap/Light/LightWatcher, `AddTag("player")`, `talker`,
  `playervision`, `areaaware`, `attuner`, `skinner` ... `entity:SetPristine()`.
- Master only: `inst.persists = false` ("handled in a special way"),
  `player_classified` child spawned and parented, `locomotor` (configured by
  `ConfigurePlayerLocomotor`), `combat` (attack period, range, PVP damagemod),
  `inventory`, `builder`, `eater`, `health`, `hunger`, `sanity`, `temperature`,
  `moisture`, `sheltered`, `grue` (darkness attacks it), `trader`, `leader`,
  `rider`, `petleash`, `sleepingbaguser`, `timer`, `debuffable`, `catcher`,
  `drownable`, `constructionbuilder`, `bundler`, `age`, `experiencecollector`;
  stategraph `SGwilson`; brain `wilsonbrain`.
- `playercontroller`, `playeractionpicker`, `playervoter`, `playermetrics`
  are added in `OnSetOwner`, i.e. only when a real client owns the entity.
  `SGwilson` references `playercontroller` 397 times, every one guarded by
  `if inst.components.playercontroller ~= nil`. `wilsonbrain` guards it too.
- `OnSetOwner` is also where `inst.name` and `inst.userid` are set from
  `inst.Network:GetClientName()/GetUserID()`. Ownerless: `name == nil`,
  `userid == nil`.

Consequences and what existing mods did:

- Movement/actions: brains issue `BufferedAction` → `locomotor:PushAction` →
  on arrival `EntityScript:PushBufferedAction` → `SGwilson` `ActionHandler`
  picks the state (chop/pickup/eat/build/attack...). This is the path FAtiMA,
  AICompanion and c_spawn'd characters use; it needs no controller. HIGH.
- Crafting: `builder:MakeRecipe(recipe, pt, rot, skin, onsuccess)` requires no
  UI; it pushes `ACTIONS.BUILD` through the locomotor. `MakeRecipeFromMenu`
  refuses unless `inventory:IsOpenedBy(inst)` (UI state), so use `MakeRecipe`
  or a `BufferedAction(inst, nil, ACTIONS.BUILD, nil, pos, recname)` (FAtiMA's
  `BUILD` action). Tech: `builder:KnowsRecipe`, `HasIngredients`,
  `CanLearn`, `UsePrototyper(prototyper)` after standing at a science machine
  (`ACTIONS.ACTIVATE` / proximity); DS-AI's `doscience.lua` shows the loop.
  HIGH (read `components/builder.lua`).
- Name shown to others: `GetBasicDisplayName()` returns `displaynamefn()` or
  `nameoverride` or `self.name`; with `name == nil` the nameplate/inspection
  is blank. Setting `inst.name = "Sui"` server-side is safe for server-side
  strings; whether the CLIENT nameplate (which reads the client table by
  userid) shows it is a TEST item. AICompanion's WX-78 is shown in the README
  screenshot with a bubble, so the bubble path works regardless.
- Systems that assume `userid`: `OnRemoveEntity` calls
  `TheNet:SetIsClientInWorld(inst.userid, false)` with nil (TEST: does
  `inst:Remove()` on an ownerless player error? Both mods never despawned);
  `plantregistrydata.lua` calls `TheNet:GetClientTableForUser(player.userid)`.
  `AllPlayers` membership means the bot counts for hound waves, boss
  targeting, "everyone is dead" world-reset countdown, Winter's Feast tables,
  etc. A Steam thread notes an old bug where "spawning fake player NPCs would
  corrupt your player character... appears to have been fixed" (secondary,
  LOW). Mitigation: wrap risky calls, keep the brain alive with
  `inst.entity:SetCanSleep(false)` (AICompanion does; otherwise entities far
  from real players go to sleep and the brain stops).
- Ghost/death: `ex_fns.OnPlayerDeath` → `makeplayerghost` etc. are wired for
  players; a dead bot becomes a ghost with no client to respawn it. Handle
  `death` in the brain: despawn and re-summon, or use `TheWorld` resurrection
  helpers. TEST.
- Which prefab: any vanilla survivor (`wilson`, `wx78`, `wendy`, ...) works
  the same; character perks come with the prefab (e.g. WX-78 eats anything,
  Wurt is a merm). Skins: `c_spawn` applies `skinner:SetSkinMode("normal_skin")`
  for restricted characters; do the same.
- Custom prefab alternative (a non-player "survivor-like" prefab built from
  the `wilson` build with pig-style components + `SGpig`): would avoid
  `AllPlayers` side effects but requires the prefab on every client
  (`all_clients_require_mod = true`), loses the 198 player action handlers,
  equip animations and the builder/inventory UI-less path would need
  re-plumbing. Not recommended for v1.

Sources: `research/dst/klei-scripts-2/prefabs/player_common.lua` (lines
955-1010 OnSetOwner, 2320-2600 master postinit), `stategraphs/SGwilson.lua`,
`brains/wilsonbrain.lua`, `components/builder.lua` 543-600 and 831-870;
FAtiMA `modmain.lua`; AICompanion `modmain.lua`; Steam discussion
https://steamcommunity.com/app/322330/discussions/0/3277925755442724646/
("c_spawn "wilson" ... wouldn't move or do anything, but he can be interacted with").

### 4.2 A real second player slot via a headless client — NOT FEASIBLE (HIGH)

- The only headless binary is `dontstarve_dedicated_server_nullrenderer`
  (server). The client (`dontstarve_steam`) needs Steam running and a Klei
  account; Steam allows one running instance per account.
- The documented way to run two instances on one PC (Universal Split Screen
  guide, https://universalsplitscreen.github.io/docs/guides/dst/) replaces
  `steam_api.dll` with the Goldberg emulator, edits `account_name.txt` and
  `user_steam_id.txt`, plays offline/"Local Only". That is a Steam-API
  emulator, offline-only, and a GUI instance that would still need
  screen-driving. Not shippable to non-technical users.
- No protocol implementation exists (unlike Minecraft's). The two screen-driving
  bots found (peter-zx, DemoThree) control the player's OWN character with
  pyautogui + screenshots; DemoThree needs a mod to export world coordinates
  because pure vision positioning was too inaccurate.
- Dedicated server as host (Plan B): app 343050 is free via SteamCMD
  (`+login anonymous +app_update 343050`), runs offline/LAN without a cluster
  token (`-offline`, `offline_cluster`/`lan_only_cluster`), accepts Lua on
  stdin with `-console` (`console_enabled = true` default), and the launcher
  panels (dst-admin, vox-launcher) automate exactly this. It changes the
  player's workflow (join a LAN server instead of Host Game; worlds must be
  copied into a cluster dir), so it is a fallback, not the plan.

### 4.3 Transport from the Lua mod to Node on the same machine

Sandbox state (HIGH, verbatim Klei patch notes):

- 651414, 2025-01-24: "io.open will no longer be able to write files and will
  always treat any file access as read only." "TheSim:QueryServer will no
  longer be able to send or get information from third party services or
  URLs." "TheSim:SetPersistentString and TheSim:SetPersistentStringInClusterSlot
  will be prevented from writing to certain auto-ran files for clients and
  server clusters." "...we are open to hearing out potential solutions for
  allowing them to work again in a more defined way."
  (https://kleiforums.com/game-updates/dst/651414-r2462/). Context: a
  self-spreading malicious mod family that rewrote `modindex.lua` /
  `customcommands.lua` and spammed chat (Klei forum "Malicious mod", 2025).
- 653007, 2025-02-05: "TheSim:QueryServer on either the client or server may
  now query to localhost or 127.0.0.1." "io.open(filepath, "w") will work for
  filepaths that go into the "unsafedata" directory, and end with ".txt",
  ".tex", ".xml", ".png", or ".json"." Dedicated servers gained
  `-allow_ioopenwrite_sandbox_escape`.
  (https://kleiforums.com/game-updates/dst/653007-r2465/)
- There is no `require("socket")`; the Lua interpreter refuses external
  libraries (FAtiMA thesis; DontStarveAI notes). `json` is a global
  (`json.encode`, `json.decode`, `json.encode_compliant`).

Channels:

(a) **HTTP to localhost via `TheSim:QueryServer(url, callback, method, data)`** — RECOMMENDED. HIGH.
- Callback signature `(result, isSuccessful, resultCode)` (Klei
  `screens/emailsignupscreen.lua`, REST-API mod, Discord mod). Async; the
  engine's curl runs off the sim thread and the callback fires on the sim
  thread.
- `"POST"` with a string body works (FAtiMA 2018, REST-API 2020, Discord
  webhook 2021, DST_Bridge 2023). A 2016 forum thread claimed non-GET verbs
  were ignored; superseded by these working mods. Custom headers, cookies and
  content-type are NOT settable (forum; HIGH that nothing in the Lua API takes
  headers). Put auth in the URL query or body.
- Works in the client build (Klei calls it from `mainscreen.lua`,
  `multiplayermainscreen.lua`, `optionsscreen.lua`) and on servers
  (`lavaarena_communityprogression.lua`); the 653007 note says "client or
  server". In a client-hosted world without caves the host process IS the
  server, so the mod's `TheWorld.ismastersim` code has it.
- Known limits: DNS resolve timeout 5 s (irrelevant for 127.0.0.1); large
  bodies blow up memory ("sending a 70 kb data dump requires more than 2 GB",
  Klei bug tracker r2846) so keep observation payloads well under ~20 KB and
  send deltas; the overall request timeout is undocumented, so long-poll holds
  should stay short (≤1 s) until measured (TEST). No documented rate limit;
  FAtiMA ran 2 req/s perceptions + 0.67 req/s decisions + events for hours.
- Latency: localhost HTTP round trip is milliseconds; the effective command
  latency is the poll interval. Design: mod GETs `/commands?since=<seq>` at
  4-10 Hz with the Node server holding the response up to ~500 ms when idle
  (bounded long-poll), and POSTs observations at 2-4 Hz plus event-driven
  POSTs (chat line, attacked, death). One in-flight request per channel.

(b) **File mailbox via persistent strings** — viable fallback, MEDIUM.
- `TheSim:SetPersistentString(name, data, encode, cb)` /
  `GetPersistentString(name, cb(success, str))` (async callbacks). For a
  client-hosted world they land in the cluster's shard save dir: DemoThree's
  Python reads
  `Documents/Klei/DoNotStarveTogether/<KU_id>/Cluster_1/Master/save/AIBotRecorder.player_state`
  (2026-07 build), and Klei's `modindex.lua` reads `../modoverrides.lua`
  relative to that via `GetPersistentStringInClusterSlot(slot, "Master", ...)`.
  Still allowed post-2025 except "certain auto-ran files". Node would need
  the KU id + slot (discoverable by watching for the newest `Cluster_*`
  with a live `server_temp`/log) and file-watch polling; writes are atomic
  enough for snapshots but this is a 100-300 ms channel at best and cannot
  wake the mod. Use only if HTTP fails.
- `io.open("unsafedata/sei.json","w")` is the other allowed write; `io.open`
  reads of files Node writes are possible (read-only mode), but the sandbox
  root for relative paths is the data folder and exact resolution is
  undocumented (LOW).

(c) **Remote console / `c_remote` / `TheNet:SendRemoteExecute`** — HIGH that it
exists, but it runs from an ADMIN CLIENT's game (`consolecommands.lua:201`),
i.e. it requires driving the host's in-game console UI. Not automatable
without keystroke injection. Not usable.

(d) **Dedicated-server stdin** — HIGH that it works (`-console`,
`console_enabled = true`; Klei/wiki guides; every server panel uses it), but
only for a dedicated server we launch ourselves (Plan B). A "Host Game" world
without caves has no server process to attach to; with caves, DST launches the
shard servers itself and does not expose their stdin.

Ordering for a non-technical host: (a) is the only channel that is
sanctioned, works in both listen-server and caves-server modes, and gives
sub-second command latency. (b) is the backup. (c)/(d) are out.

Sources: patch notes above; Klei bug tracker
https://forums.kleientertainment.com/klei-bug-tracker/dont-starve-together/thesimqueryserver-memory-abuse-r2846/;
forum threads 63113 (timeout) and 67548 (methods);
https://dst-api-docs.fandom.com/wiki/TheSim; QueryServer Fix workshop page.

### 4.4 Installing and enabling the mod for a non-technical host — HIGH on mechanism

- Local mods: `<install>/mods/<modname>/` with `modinfo.lua` + `modmain.lua`.
  `MODS_ROOT` is an engine constant pointing there. Windows:
  `<Steam>\steamapps\common\Don't Starve Together\mods\`; macOS:
  `<Steam>/steamapps/common/Don't Starve Together/dontstarve_steam.app/Contents/mods/`
  (show package contents). Workshop mods live outside the install in
  `<Steam>/steamapps/workshop/content/322330/<id>/` and are addressed as
  `workshop-<id>`.
- Steam path detection: `<Steam>/steamapps/libraryfolders.vdf` lists each
  library `"path"` and its `"apps"` map keyed by appid; find the entry
  containing `"322330"` (verified format on this Mac). Windows Steam root:
  registry `HKCU\Software\Valve\Steam\SteamPath`; macOS:
  `~/Library/Application Support/Steam`.
- Enabling. Two engine-supported ways, both readable in `modindex.lua`:
  1. `<install>/mods/modsettings.lua`: `ForceEnableMod("sei")` (env also
     offers `EnableModDebugPrint()`, `EnableModError()`,
     `DisableLocalModWarning()`, `DisableModDisabling()`). Engine prints
     "WARNING: Force-enabling mod ... If you are not developing a mod, please
     use the in-game menu instead." Force-enabled mods are included in
     `ModWrangler:GetEnabledServerModNames()` (`IsModForceEnabled`), so they
     ride along into any world the player hosts, with default config, and are
     also loaded in the front end. Slot-independent; survives new worlds. Risk:
     Steam "verify files" or a game update can rewrite `modsettings.lua`
     (it ships with the game); re-apply on each launch.
  2. Per-world `modoverrides.lua`: what the Host Game → Mods tab writes
     (`ShardSaveIndex:SetSlotEnabledServerMods` → `ShardIndex:SetEnabledServerMods`
     → `TheSim:SetPersistentStringInClusterSlot(slot, "Master", "../modoverrides.lua", ...)`),
     read back by `ModIndex:LoadModOverides`. Path:
     `<Documents>/Klei/DoNotStarveTogether/<KU_id>/Cluster_<n>/Master/modoverrides.lua`.
     Format: `return { ["sei"] = { enabled = true, configuration_options = {} } }`
     (names resolve with or without the `workshop-` prefix; `TryLoadMod`
     picks up a directory even if the mod index has not seen it). Requires
     knowing which slot the player will host; can be applied to all slots.
- Recommendation: install dir + `ForceEnableMod`, and make the mod inert
  (no spawn, no polling beyond a 2 s heartbeat) unless the Node side answers
  `GET /hello` on the configured port. Also write `DisableLocalModWarning()`
  so the "local mods" warning does not confuse the player. Dedicated (Plan B)
  uses `dedicated_server_mods_setup.lua` (`ServerModSetup("<workshop id>")`)
  for Workshop items, plus the cluster's `modoverrides.lua`.
- Clients: with `all_clients_require_mod = false`, joining friends download
  nothing (`networking.lua DownloadMods` only temp-enables/downloads
  `all_clients_require_mod` mods).

### 4.5 Chat — HIGH

- Reading player chat on the server: wrap the global.
  ```lua
  local old = GLOBAL.Networking_Say
  GLOBAL.Networking_Say = function(guid, userid, name, prefab, message, colour, whisper, isemote, user_vanity)
      if GLOBAL.TheNet:GetIsServer() and not isemote then queue({userid=userid, name=name, text=message, whisper=whisper}) end
      return old(guid, userid, name, prefab, message, colour, whisper, isemote, user_vanity)
  end
  ```
  Three mods use this (dst-mod-moderator 2021, DST_Bridge 2023, dst-broadcasts
  2026). Klei's `networking.lua:53` shows the engine calls it with those args
  and it itself calls `entity.components.talker:Say(...)` and
  `ChatHistory:OnSay(...)`. `ChatHistory:AddChatHistoryListener(fn)` is the
  client-side alternative (the host is also a client, but a dedicated caves
  host is not, so prefer the global hook). `whisper` lines are range-filtered
  only on the client display; the server hook sees them all.
- Speaking:
  - `bot.components.talker:Say(text)` → `TheNet:Talker(text, entity, duration, filter_ctx, netid)`
    broadcasts the bubble to every client (`components/talker.lua` sayfn).
    Character-name prefixing is not needed; the bubble hangs over the bot.
    Klei applies `GetSpecialCharacterPostProcess` (e.g. WX-78 casing). Length
    cap: `MAX_CHAT_INPUT_LENGTH` for real chat; talker has none but keep it
    short; multi-line scripts accepted as `{Line(...)}` lists.
  - Chat log: `TheNet:Announce(msg, entity_or_nil, nil, category)` (as
    `c_announce`), or `TheNet:SystemMessage(msg)`; both show to everyone,
    styled as announcement/system, not as a named player line. Prefix
    `"Sui: "` yourself. Whether the `entity` arg attaches the bot's name in
    the announcement is a TEST item.
  - `talker:MakeChatter()` + `talker:Chatter(strtbl, strid, time, forcetext, echotochatpriority)`
    is Klei's mechanism for NPC lines echoed into chat WITH the entity's
    display name and icon, but the text is resolved on the client from
    `STRINGS[strtbl][strid]` (netvars carry only the table path + id), so a
    server-only mod cannot ship arbitrary LLM text through it. With a client
    mod one could set `talker.resolvechatterfn`; not for v1.
  - Emotes: `TheNet:Say(emotename, true, true)` is client-side only.

### 4.6 Pathfinding, movement, actions, brains — HIGH (read from source)

- `LocoMotor:GoToPoint(pt, bufferedaction, run)`, `GoToEntity(target, bufferedaction, run)`,
  `PushAction(bufferedaction, run, try_instant)` (walks to the target's
  action distance then performs), `Stop()`, `Clear()`; pathfinding is async
  through `TheWorld.Pathfinder` (`FindPath`, `PATHFIND_PERIOD = 1`,
  `PATHFIND_MAX_RANGE = 40` constant, the range check is commented out in the
  current build). Entities on different landmasses need boats/wormholes; the
  locomotor pushes `noPathFound`.
- `BufferedAction(doer, target, action, invobject, pos, recipe, distance, forced, rotation)`;
  `:AddSuccessAction(fn)`, `:AddFailAction(fn)`, `:TestForStart()`,
  `:IsValid()`. `EntityScript:PushBufferedAction` de-dupes identical pending
  actions and pushes `actionfailed` with a reason on `TestForStart` failure
  (Klei uses that to make the player say "I can't do that").
- Behaviour tree nodes (`behaviourtree.lua`, `behaviours/`): `PriorityNode`,
  `SequenceNode`, `WhileNode`, `IfNode`, `DoAction(inst, getactionfn, name, run, timeout)`,
  `Follow(inst, targetfn, min_dist, target_dist, max_dist, canrun)`,
  `Wander`, `ChaseAndAttack(inst, max_chase_time, give_up_dist, max_attacks)`,
  `RunAway(inst, hunter_or_tag_or_fn, see_dist, safe_dist)`, `Leash`,
  `Approach`, `FindLight`, `Panic`, `StandStill`, `ChattyNode`, `MinPeriod`.
  `Brain` subclass with `OnStart` building `self.bt = BT(inst, root)`,
  `OnStop`; `inst:SetBrain(brainclass)`, `RestartBrain`, `StopBrain`.
  `wilsonbrain` is tiny (hold-attack `ChaseAndAttack`); pig/bunnyman brains
  (`brains/pigbrain.lua`, `bunnymanbrain.lua`) show follower/leader,
  home-seeking, eating and panic patterns for a humanoid.
- Combat: `combat:SetTarget(ent)`, `combat.target`, `combat:CanAttack`,
  `combat:IsAlly`; equip weapon via `inventory:Equip(item)` or
  `ACTIONS.EQUIP`. Eating: `ACTIONS.EAT` with the food as target, or
  `eater:Eat(food)` directly; `eater:CanEat(item)`. Sleeping:
  `ACTIONS.SLEEPIN` on tent/bedroll. Containers: `ACTIONS.STORE`,
  `RUMMAGE`, `TAKEITEM`; `container:GiveItem`. Cooking: `ACTIONS.COOK` on a
  campfire, crock pot via `stewer` + `ACTIONS.HARVEST`. FAtiMA's README has a
  curated 50-action table with argument shapes.
- The action set should stay closed, Zod-typed on the Node side, and map 1:1
  to `ACTIONS.<NAME>` plus a few composite verbs (gather N of prefab, build
  recipe, follow player, flee), exactly like the Minecraft adapter registry.

### 4.7 Observation — HIGH

- `TheSim:FindEntities(x, y, z, radius, musttags, canttags, mustoneoftags)`
  (radius ~20-30 is what the prior mods used; exclude
  `{"INLIMBO","NOCLICK","CLASSIFIED","FX"}`; hostile scan with
  `{"_combat"}` / `{"hostile"}`; `"player"` for people).
- `TheWorld.state`: `phase` (day/dusk/night), `season`, `cycles`,
  `seasonprogress`, `temperature`, `israining`, `issnowing`, `moonphase`,
  `iscaveday` ...; `inst:WatchWorldState(var, fn)` for change events;
  `TheWorld.net.components.clock`.
- Self: `health.currenthealth`/`maxhealth`, `hunger.current`,
  `sanity.current`, `inst:GetTemperature()`, `IsFreezing()`,
  `IsOverheating()`, `GetMoisture()`, `LightWatcher:IsInLight()`,
  `inventory.itemslots` / `equipslots` / `inventory:Has(prefab, n)` /
  `FindItem`, `builder:KnowsRecipe`, `combat.target`, `inst.sg:HasStateTag("busy")`,
  `inst.bufferedaction`. Events: `attacked`, `killed`, `death`, `onhitother`,
  `enterdark`, `enterlight`, `actionfailed`, `performaction`.
- Payload discipline: send a compact entity list (guid, prefab, dx/dz,
  handful of capability flags derived from tags) and deltas; the memory bug
  above makes big JSON dangerous.

### 4.8 Distribution: what other clients need — MEDIUM-HIGH

- A server-only mod may only use prefabs and assets that exist on clients.
  Our body is a vanilla character prefab; our brain/behaviours are server-side
  Lua; we add no assets, prefabs, components with replicas, or strings. So
  `all_clients_require_mod = false`, `client_only_mod = false`. Joining
  clients see a normal Wilson/WX-78. TEST once live (the two prior mods left
  the flag true, so nobody has demonstrated the false case).
- If we ever want a custom look (own art, own name in the client table, chat
  as a named player), that is a `all_clients_require_mod = true` Workshop mod
  and friends must subscribe (Steam auto-subscribes when joining if enabled).

### 4.9 Versioning — MEDIUM

- `api_version = 10` has been the DST mod API version since 2015 and is still
  what 2026 mods declare. Klei ships the full Lua and changes internals
  monthly (updates 616404 to 751622 between 2024-06 and 2026-09); anything
  touching stategraph internals or private component fields breaks. The
  AICompanion README warns "Mod files depend on the game version". Keep to
  public component methods, `pcall` every command handler, report Lua errors
  to Node, and version-gate on `TheSim:GetGameVersion()` / `APP_VERSION`.
  The 2025 sandbox change shows Klei will tighten APIs abruptly; localhost was
  explicitly kept, which is a good sign but not a guarantee.

### 4.10 Despawn and persistence — HIGH (persistence), TEST (despawn)

- Player prefabs set `inst.persists = false`; real players are saved by the
  player-spawner per userid. An ownerless bot is therefore NOT written to the
  world save: on reload it is gone, together with the inventory it carried.
  That matches the desired "session" semantics; drop or chest the inventory
  on session end (`inventory:DropEverything()`) so items are not lost.
- Clean removal: stop the brain, `inventory:DropEverything()`, then
  `inst:Remove()`. `OnRemoveEntity` calls
  `TheNet:SetIsClientInWorld(inst.userid, false)` with a nil userid and
  pushes `ms_playerleft`; verify it does not error (wrap the removal in
  `pcall`, and as a fallback teleport the entity far away and
  `StopBrain()`). Also `player_classified` is removed with it.
- Host quits: nothing to do; the bot vanishes with the world session. Node
  side detects the heartbeat loss.

---

## 5. Recommended architecture sketch

```
Electron main                    Node bot process (utilityProcess)                DST (host game process, or caves shards)
  botSupervisor ── summon ──▶  src/bot/adapter/dst/                          mods/sei/  (server-only Lua)
                               ├─ bridge/httpServer  127.0.0.1:<port>  ◀── QueryServer POST /obs, /event, /chat
                               │     GET /cmd?since=N (bounded long-poll) ──▶  brain executes BufferedActions
                               ├─ registry.js  (Zod tools → command JSON)
                               ├─ observers    (obs JSON → snapshotText)
                               └─ existing brain: orchestrator + fsm + memory
```

Mod side (`mods/sei/`, ~1-2k lines of our own Lua, MIT):

- `modinfo.lua`: `api_version = 10`, `dst_compatible = true`,
  `all_clients_require_mod = false`, `client_only_mod = false`, a `port`
  config option.
- `modmain.lua`: only when `TheNet:GetIsServer()`. Hook `Networking_Say`.
  On `AddSimPostInit` start a 2 s heartbeat `GET /hello`; when Node answers
  with a summon request (character prefab, name, spawn near which userid),
  `SpawnPrefab(prefab)` near that player, `inst.name`, `skinner`, `SetCanSleep(false)`,
  `SetBrain(require "brains/seibrain")`. Handle `despawn`.
- `scripts/brains/seibrain.lua`: FAtiMA-style. Periodic `Perceptions` POST
  (2-4 Hz, delta-compressed); event POSTs; `GET /cmd` loop with one in-flight
  request; command types: `action{name,target,invobject,pos,recipe}`,
  `follow{userid,dist}`, `goto{x,z}`, `flee`, `stop`, `say{text}`,
  `announce{text}`, `equip/unequip`, `build{recipe,pos}`, `eat{guid}`,
  `gather{prefab,count}` (mod-side loop over FindEntities + work actions, so
  the LLM issues one verb). BT root: safety layer first (`RunAway` from
  hostiles when low health, `FindLight` at night when no light,
  `ChaseAndAttack` when attacked and told to fight), then the command slot
  (`DoAction`/`Follow`/`Wander`), like the FSM priorities P0/P1/P2/P3 already
  in the Node brain. Report `actionfailed` reasons back so the model gets the
  "tell the model" strings the Minecraft adapter already relies on.
- Every command handler in `pcall`; errors POSTed to `/error` so Node can
  surface them in LogsBar.

Node side:

- `src/bot/adapter/dst/` mirroring `adapter/minecraft/`: `connect.js`
  (start HTTP server on an ephemeral port, write the port into the mod config
  or a `unsafedata`/persistent file the mod reads on heartbeat), `registry.js`
  (Zod tools: `follow`, `come`, `goto`, `gather`, `chop`, `mine`, `pick`,
  `pickup`, `craft`, `build`, `eat`, `equip`, `attack`, `flee`, `sleep`,
  `store`, `light_fire`, `say`), `observers/` (turn obs JSON into the
  `snapshotText()` block: world clock/season, stats, inventory, nearby
  entities bucketed by capability, threats, last action result),
  `fsmWires.js` (P0 from `attacked`/`death`/`hungerdelta`, P1 from `/chat`,
  P2 from commands, P3 idle ticks).
- Electron main: install/enable step (`ForceEnableMod` + `mods/sei` copy,
  Steam path detection from `libraryfolders.vdf`), a "DST world open?"
  detector (heartbeat arrived), summon gate shared with Minecraft (mutually
  exclusive with MC/chess/Draw per character via `gameLaunch.ts`).
- Chat: `/chat` POSTs feed the same `P1_CHAT` path as Minecraft chat; `say`
  → `talker:Say` bubble + `TheNet:Announce("Sui: ...")` (make the announce
  optional; bubbles alone may be enough when following the player).

Latency budget: poll 100-250 ms + Node LLM turn; comparable to the Minecraft
adapter. Observation cadence 2-4 Hz keeps CPU trivial (FAtiMA ran 2 Hz on
2018 hardware).

---

## 6. Risks and unknowns (ordered)

1. **Ownerless player-prefab edge cases** (`userid == nil`, `AllPlayers`
   membership): despawn path, nameplate, hound/boss targeting, world-reset
   countdown, plant registry, death/ghost flow. Mitigation: live test matrix
   on day 1; wrap; consider `inst.userid = "KU_sei"` style fake ids only if a
   specific call needs a string (risky with `TheNet` calls). MEDIUM risk.
2. **Server-only packaging untested with this body.** If some replicated
   piece needs the mod client-side, fallback is a Workshop mod with
   `all_clients_require_mod = true` (friends auto-subscribe). LOW-MEDIUM.
3. **Klei re-tightens `QueryServer`** (they did once, Jan 2025, then carved
   out localhost within 12 days after community pushback). Fallback: the
   persistent-string mailbox (4.3b). MEDIUM impact, LOW likelihood.
4. **QueryServer behaviour under load**: undocumented request timeout,
   memory blow-up with big bodies, concurrency. Measure before committing to
   long-poll; keep payloads < 10 KB. MEDIUM.
5. **Caves-enabled hosting** moves the master sim into a background dedicated
   process launched by the game: the mod still runs (it is a server mod for
   that cluster), but confirm `QueryServer` from that process and that the bot
   spawns in the surface shard next to the player (shard migration through
   sinkholes is a separate feature). MEDIUM.
6. **modsettings.lua overwritten** by updates/verify: re-apply on every
   launch; or use per-slot `modoverrides.lua` (needs slot discovery).
7. **Game updates breaking the brain** (monthly). Keep the Lua thin and
   API-level; pin tests against the current build; watch Klei "Notes for
   Modders".
8. **Anti-cheat / ToS**: none in DST; Klei encourages mods and there is no
   rule against local external processes (Walter shipped on the Workshop). If
   we publish to the Workshop, code must be unobfuscated (Klei guideline) and
   assets credited.
9. **Chat identity**: bot lines appear as bubbles/announcements, not as a
   player row in the chat log or player list. Acceptable for v1; a client mod
   would be needed for more.
10. **macOS install path inside the .app bundle** and Steam Deck (Linux,
    `~/.klei`, Proton) paths need per-platform code; only Windows is the
    target for v1 per the task, but worth noting.

---

## 7. Licensing notes

- **Klei scripts**: copyrighted, shipped in `data/databundles/scripts.zip`;
  no license grants redistribution. Mods routinely read and imitate them,
  and Klei's guidelines say "just about any aspect of the game can be
  modified or extended" while banning mods that use "copyrighted material of
  which you do not own or have permission to use" and any "obfuscated or
  otherwise ambiguous code". Do not vendor Klei files (including the script
  mirrors cloned here) into the repo or the shipped mod; write our own Lua
  against their API. Referencing function names/patterns is standard
  practice. Do not ship Klei art; the body uses builds already on every
  machine.
- **FAtiMA-DST** (MIT) and **DST-AICompanion** (MIT): freely reusable with
  attribution; the C# server is irrelevant to us.
- **Chat Announcements** (CC0): freely reusable.
- **DS-AI / Artificial Wilson**: no license file → all rights reserved; use
  as design reference only, re-implement. **DontStarveAI**: its own additions
  are declared public domain/MIT but sit on the unlicensed base; same rule.
- **DST-MOD-REST-API**: no license → reference only (it is 200 lines; nothing
  needs copying).
- **DST_Bridge, dst-mod-moderator** (GPL-3.0): patterns only, no code.
- **QueryServer Fix**: unlicensed proxy; not needed.
- Our mod: MIT (or the repo's license). If it ever goes to the Workshop, the
  Steam Subscriber Agreement + Klei UGC guidelines apply (source must be
  readable; credit assets).

---

## 8. Reusable code list (paths in the clones)

Copy/adapt (permissive):

- `research/dst/FAtiMA-DST/FAtiMA-DST/scripts/brains/fatimabrain.lua`
  — `Entity()` capability encoder (lines 44-70), `KeepWorking`/`IsWorkAction`
  (77-85), the `Perceptions()` snapshot (177-233), the `DoAction`+`Wander`
  root with `AddFailAction`/`AddSuccessAction` bookkeeping (355-420), the
  world-state watcher registration/unregistration (300-355, 436-500). MIT.
- `research/dst/FAtiMA-DST/FAtiMA-DST/modmain.lua` — `FindPortal()` and the
  `AddSimPostInit` spawn block (61-95). MIT.
- `research/dst/FAtiMA-DST/README.md` — the curated action table (50
  actions with argument shapes) as the seed of our Zod registry. MIT.
- `research/dst/DST-AICompanion/DST Mod/scripts/brains/fatimabrain.lua` —
  `Follow(...)` leader wiring (1840-1900), `RunAway` from hostiles (1745-1770),
  `UpdatePlayerDist` tracking (1635), inventory helpers, "Sorry, I don't have
  enough items." style feedback. MIT.
- `research/dst/chat-announcements/lib/util.lua`, `lib/logging.lua`, and the
  POST/response handling in `client/discord.lua` (286-345). CC0.
- Klei reference (read, do not copy): `research/dst/klei-scripts-2/`
  `prefabs/player_common.lua`, `stategraphs/SGwilson.lua`,
  `components/{locomotor,builder,combat,inventory,eater,talker}.lua`,
  `behaviours/{doaction,follow,runaway,chaseandattack,wander,findlight}.lua`,
  `brains/{pigbrain,bunnymanbrain,wilsonbrain}.lua`, `networking.lua`,
  `chathistory.lua`, `modindex.lua` (mod enabling), `shardsaveindex.lua`
  (per-slot `modoverrides.lua`), `consolecommands.lua` (`c_spawn`,
  `c_announce`, `c_remote`), `actions.lua` (every `ACTIONS.X.fn`).

Reference only (unlicensed/GPL):

- `research/dst/DS-AI/scripts/behaviours/*.lua` (gather/cook/science/light/
  clothes loops) and `scripts/brains/artificalwilson.lua` (`CanIBuildThis`,
  `GATHER_LIST`) — behaviour design; DS APIs differ from DST
  (`GetPlayer()`→`AllPlayers`, `GetWorld()`→`TheWorld`, no replicas).
- `research/dst/DST-MOD-REST-API/modmain.lua` — poll/command loop shape.
- DST_Bridge `modmain.lua` (fetched, not cloned) — `Networking_Say` hook +
  push/pull loop.

---

## 9. Sources

Klei patch notes: https://kleiforums.com/game-updates/dst/651414-r2462/ (2025-01-24),
https://kleiforums.com/game-updates/dst/653007-r2465/ (2025-02-05), listing
https://kleiforums.com/game-updates/dst/?page=5.
Klei support: Dedicated Server Command Line Options Guide (archived
2025-10) https://support.klei.com/hc/en-us/articles/360029556192-Dedicated-Server-Command-Line-Options-Guide;
Modding Guidelines (archived 2024-03) https://support.klei.com/hc/en-us/articles/360029556052-Modding-Guidelines.
Klei forums (Wayback where the live site 403s): FAtiMA-DST thread
https://forums.kleientertainment.com/forums/topic/86495-fatima-dst-an-ai-framework/;
"When to use all_clients_require_mod" topic 100046; "QueryServer times out"
topic 63113; "non GET request support" topic 67548; "Malicious mod" topic
163311; "Mod API discussion thread" topic 163519; QueryServer memory abuse
bug r2846; "Is it possible to make a player character which's actually a npc
who uses a brain" topic 70088 (not retrievable; 403 and no archive).
Steam: Walter Workshop page https://steamcommunity.com/sharedfiles/filedetails/?id=1339264854;
Artifical Wilson (DST) https://steamcommunity.com/workshop/filedetails/?id=2571021979;
QueryServer Fix https://steamcommunity.com/workshop/filedetails/?id=3486748167;
NPC discussion https://steamcommunity.com/app/322330/discussions/0/3277925755442724646/.
Thesis: hineios, "Creating an Agent-Based Framework for Don't Starve Together"
(PDF from github.com/hineios/dissertation).
Docs: https://dst-api-docs.fandom.com/wiki/TheSim, https://vietnd69.github.io/dst-api-webdocs/,
https://universalsplitscreen.github.io/docs/guides/dst/.
Repos: listed in section 2, all cloned or fetched on 2026-09-08.
