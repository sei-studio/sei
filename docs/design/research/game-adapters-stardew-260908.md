# Stardew Valley companion body: prior art + technical facts

Research date: 2026-09-08. Scope: how to give Sei's existing Node brain (LLM + Zod action
registry + FSM, currently embodied through mineflayer in Minecraft) a body inside the
player's Stardew Valley 1.6.x game on PC, plus the transport between the Node bot process
and the game.

All clones live under
`/private/tmp/claude-501/-Users-ouen-slop-sei-studio-sei/b7e70bff-0e01-4e13-ac55-e80b1ace87dd/scratchpad/research/stardew/`
(referred to below as `$R`). Game facts were verified against a decompile of Stardew Valley
1.6.15 (`$R/sdv-decompiled`, Dannode36/StardewValleyDecompiled, build 1.6.15-24356) and the
SMAPI source (`$R/smapi`, tag state 4.5.2). Wiki pages were fetched with curl (the wiki and
Nexus block the WebFetch tool; Nexus additionally blocks the browser pane behind Cloudflare
for all but one page).

Confidence scale used below: HIGH = read in source/decompile; MEDIUM = documented but not
executed; LOW = inferred or from a search snippet only.

---

## 1. Executive summary

**Recommended approach: a host-side SMAPI mod that spawns the companion as a vanilla-typed
`NPC` (visible body, uses the game's own `PathFindController`) paired with an invisible
"shadow" `Farmer` instance that performs every mechanic that needs a `Farmer` (tool use,
combat, fishing, inventory, placement). The mod runs a loopback WebSocket/TCP JSON server;
the Node bot process connects to it and drives the body through a small typed command set
that mirrors the mineflayer adapter's action registry.**

Why this and not the alternatives:

- **It is proven.** Two independent codebases already ship exactly this body shape:
  Farmtronics (MIT, 2021-2025, bots that "can do almost anything you can do: use tools,
  water crops, plant seeds") and amarisaster/StardewValley-MCP (Apache-2.0, 2026, "Player
  2/3" companions with follow/farm/mine/fish modes plus 12 direct-control MCP tools). Both
  discovered the same load-bearing detail independently: the shadow `Farmer` must NOT be
  added to `Game1.otherFarmers` (that is the network-synced remote-player table and
  `Multiplayer.updateRoots()` walks it every tick; see fact 1).
- **It does not fight the human.** Every "AI plays Stardew" project that controls
  `Game1.player` (StarDojo, luy-0/StardewValley-MCP, StardewMCP on Nexus, AutoPlaySV,
  Starbot, ASVA) takes the keyboard away from the player. Sei's product is a companion, so
  the body must be a second character.
- **No second game client, no second Steam license, no second window.** A split-screen
  farmhand (fact 2) would give a REAL `Farmer` with every mechanic and animation for free,
  but it needs a full second `Game1` instance rendering into the host's window, synthetic
  gamepad injection into a non-main instance, and a cabin; no project has done it and the
  cost is a permanent half-screen and roughly doubled CPU. Keep it as the fallback if the
  shadow-farmer action surface turns out too thin.
- **Transport is unconstrained.** SMAPI has no sandbox: mods use `HttpListener`,
  `TcpListener`, third-party WebSocket DLLs and file polling in the wild; SMAPI only emits
  informational warnings for filesystem/shell/console access (fact 4).

The two honest costs: (1) a shadow farmer gets the MECHANICS but not the ANIMATIONS or the
UI paths, so fishing (BobberBar minigame), shops (ShopMenu) and chests (ItemGrabMenu) must be
re-implemented as direct API calls, which the prior art already does for fishing, chests and
purchases; (2) farmhands on other PCs only see the companion if either the mod is installed
on their client too, or the companion is a plain `NPC` using a sprite asset the client can
load (fact 8). v1 should target the single-player / host-only case, which is also Sei's
Minecraft v1 shape (LAN host world).

---

## 2. Prior art table

| Project | URL | License (exact) | Last activity | Lang | Body | Observes via | Acts via | Transport |
|---|---|---|---|---|---|---|---|---|
| amarisaster/StardewValley-MCP ("Stardew MCP Bridge") | https://github.com/amarisaster/StardewValley-MCP | LICENSE.txt = Apache-2.0 (README footer says "MIT"; conflicting, treat as Apache-2.0) | pushed 2026-06-04, 27 stars | C# + TS | Separate: `NPC` visual + invisible `BotFarmer : Farmer` | Per-tick `SurroundingsScanner` over tiles/objects/crops/monsters | `Tool.DoFunction`, `MeleeWeapon.DoDamage`, `FishingRod.beginUsing/tickUpdate`, `PathFindController` on the NPC | JSON file polled every 30 ticks + `actions/*.json` queue; MCP over stdio in Node |
| JoeStrout/Farmtronics | https://github.com/JoeStrout/Farmtronics | MIT | pushed 2025-09-05, 55 stars, v1.4.1, SMAPI>=4.0 | C# | Separate: `BotObject : StardewValley.Object` (big craftable) + invisible `BotFarmer : Farmer` | Own tile queries (`TileInfo`) | `CurrentTool.DoFunction`, `beginUsing` for scythe, `placementAction`, `Chest.addItem`, crop `harvest` | None external (in-game MiniScript shell); multiplayer via SMAPI ModMessages |
| StarDojo2025/stardojo (paper arXiv 2507.07445) | https://github.com/StarDojo2025/stardojo | MIT | pushed 2025-11-03, 67 stars | C# + Python | Controls `Game1.player` (host) | `ExportGameData` JSON + rendered frames via memory-mapped file | `PathFindController` on player, `Tool.DoFunction`, Harmony patches for shop/dialogue, `Game1.paused` during inference | `TcpListener` 127.0.0.1:10783, `method%arg%arg` strings, mmap for images |
| luy-0/StardewValley-MCP | https://github.com/luy-0/StardewValley-MCP | Apache-2.0 | pushed 2026-08-17, 5 stars | C# + Python | Controls `Game1.player` | 6 read-only query capabilities | 16 write capabilities (`navigate`, `use_tool`, `interact`, `craft_item`, `purchase_shop_item`...) | Mod = loopback TCP listener, 4-byte length-prefixed protobuf frames, HMAC-SHA256 challenge auth, single-owner lease (ADR-0002) |
| zunderscore/StardewWebApi | https://github.com/zunderscore/StardewWebApi | MIT | pushed 2025-01-05, 7 stars, v0.6.0, SMAPI>=4.0 | C# | None (read + a few UI actions) | Controllers over `Game1` | HUD/chat/sound actions only | `HttpListener` http://localhost:7882 REST + WebSocket `/events` |
| ObjectManagerManager/SMAPIDedicatedServerMod | https://github.com/ObjectManagerManager/SMAPIDedicatedServerMod | MIT | pushed 2024-01-20, 110 stars (1.5-era; MinimumApiVersion 3.0) | C# | Automates the HOST `Game1.player` | Behavior chain on `UpdateTicked` | Warps, dialogue skipping, sleep, festival attendance | In-game chat commands via `EventDrivenChatBox : ChatBox` replacing `Game1.chatBox` |
| stardew-valley-dedicated-server/server (JunimoServer) | https://github.com/stardew-valley-dedicated-server/server | MIT (LICENSE; gh reports NOASSERTION because two notices) | pushed 2026-09-08, 338 stars, targets SDV 1.6.15 | C# + Docker | Automates + hides HOST (`Game1.displayFarmer=false`) | n/a | n/a | Harmony postfix on `ChatBox.receiveChatMessage`; HTTP API; ships `HttpListenerFix` for Linux |
| Floogen/CustomCompanions | https://github.com/Floogen/CustomCompanions | MIT | pushed 2025-12-19, 12 stars | C# | Separate cosmetic `Companion : NPC` (follows owner, no tools) | n/a | Velocity toward owner (`SetMotion`), collision checks; not `PathFindController` | Content packs; custom `NetFields` so mod needed on all clients |
| purrplingcat NPC Adventures | https://github.com/rikai/NpcAdventures (source), Nexus 4582 (deprecated) | MIT (purrplingcat repos) | deprecated, 1.5 era | C# | Vanilla villagers recruited as followers who fight | n/a | NPC follow + sword swings | n/a; single player only (Nexus). NOT cloned; from search + Nexus snippet only |
| phin01/AutoPlaySV | https://github.com/phin01/AutoPlaySV | NONE (no license file) | 2021-09 | C# | Controls `Game1.player` | Hard-coded | Manual `PathFindController.update` + `warpFarmer` + `checkForAction` | none |
| OniQ/SDV-Starbot | https://github.com/OniQ/SDV-Starbot | MIT | 2020-01 | C# | Controls the local player (works as farmhand bots in MP) | Objectives | Input simulation (`IInputSimulator`, `Input2.cs`) | none |
| andyruwruw/stardew-valley-bot-framework | https://github.com/andyruwruw/stardew-valley-bot-framework | NONE | 2021-03 | C# | `Character`-agnostic controller | Location graph parser | Route/tour/path templates | none |
| CrazyBong/ASVA | https://github.com/CrazyBong/Autonomous-Stardew-Valley-Agent-ASVA- | NONE | 2026-03 | C# + TS | Controls `Game1.player` (sets `Position` directly) | `GameStateExtractor` | `ActionInjector` (`useTool()`, `CurrentToolIndex`) | WatsonWebsocket ws://127.0.0.1:7890 |
| zalataraglados-prog/StardewValleyAICompanion | https://github.com/zalataraglados-prog/StardewValleyAICompanion | NONE | pushed 2026-09-06, 1 star, 1548 .cs files | C# | Controls the local player via a "TransparentBridge" SMAPI mod; companion-as-separate-role is a stated FUTURE constraint, not built | 585-field snapshot | 228 registered actions, policy-ranked candidate queues | internal |
| StardewMCP (shylux) | Nexus 46320 (no source link on page) | unknown | 2026-05-22 | C# | Controls/observes `Game1.player`; cheat-style tools | 50+ MCP tools | teleport, give items, set time... | HTTP MCP server http://localhost:24842 |
| BAAI-Agents/Cradle | https://github.com/BAAI-Agents/Cradle | MIT | 2024-11 | Python | Screen + keyboard/mouse (no mod) | Screenshots + GPT-4o | OS input | n/a; irrelevant for a body |
| LLM dialogue mods (hanshuqimen/StardewValleyAIMod, njg67p5dwn-bot/StardewValleyLLMChat, RPGGO-AI/stardewAIRPG MIT, "AI Valley" Nexus 25025, Inworld demo) | various | mixed/none | 2024-2026 | C# | None; NPC dialogue replacement | n/a | n/a | HTTP to LLM APIs |
| Nexus-only automation: AI Farm Assistant 49293, Farmhand Scheduler 39862, Fabulous Farmhands 47062, Fishbot 36115, Farmer Helper 21030, Dayswork 47134 | Nexus | unknown | 2025-2026 | C# | From snippets: automate the PLAYER's own chores (auto-fish, auto-eat, return home) or invisible "hire a helper" scheduling | n/a | n/a | Could not fetch pages (Cloudflare); no GitHub source found via `gh search` |

Other repos surfaced by `gh search` and rejected as irrelevant or empty: junibot (Python
screen bot, 2022), karreiro/stardew-valley-bot (Go, Twitter-driven, 2019), the several
"stardew-valley-agent" Python repos (wiki Q&A, no game integration), Stardew.Tasks (task
list), StardewValleyMCPMod (NguyenHuynhPhuVinh, MIT, 2025-05, tiny), vehemont/sdv-mcp (Python
save-file reader, MIT). No RL "gym" mod other than StarDojo exists on GitHub; the gym-style
environment IS StarDojo.

---

## 3. Per-project deep dives

### 3.1 amarisaster/StardewValley-MCP (the closest prior art)  `$R/sv-mcp-amarisaster`

Files: `smapi-mod/{ModEntry,BotManager,CompanionAI,CompanionFarmer,CompanionNPC,BotFarmer,CompanionActions,SurroundingsScanner}.cs`, `mcp-server/src/index.ts` (541 lines, 25 MCP tools).

Body construction (`BotManager.SpawnBot`, `CompanionFarmer` ctor):
- `ModEntry.OnAssetRequested` injects `Data/Characters` entries (`CharacterData{DisplayName, HomeRegion="Town"}`) and loads `Characters/Companion1` + `Portraits/Companion1` textures from the mod folder. Because injecting into `Data/Characters` makes the game auto-spawn the NPC, `SpawnBot` first sweeps every location and removes duplicates by name.
- Visual: `new CompanionNPC(new AnimatedSprite("Characters\\Companion1", 0, 16, 32), pos, locationName, 2, name, portrait, false)`; `location.addCharacter(npc)`. `CompanionNPC : NPC` only overrides `draw` to widen the sprite 1.3x.
- Mechanics: `BotFarmer : Farmer` with `draw()` a no-op, `SetMoving*` overrides, a `new tryToMoveInDirection` that uses `isTilePassable` (both copied from Farmtronics), `UniqueMultiplayerID = helper.Multiplayer.GetNewID()`, `Farmer.initialTools()` added to `Items`, inventory padded to 36 nulls. Comment in source: "Do NOT add Shadow to Game1.otherFarmers... Multiplayer.updateRoots() walks it every tick expecting net-backed farmers and NPEs on a hand-built one."
- Every action starts with `SyncFromNpc()` (copy Position/currentLocation/FacingDirection from NPC to shadow).

Action surface (`CompanionFarmer.cs`):
- `UseToolAt(tile, typeof(Pickaxe|Axe|Hoe|WateringCan|MeleeWeapon))` → `tool.DoFunction(location, tileX*64, tileY*64, 1, Shadow)`; weapons → `weapon.DoDamage(location, x, y, facing, 1, Shadow)`; then `Shadow.checkForExhaustion(oldStamina)`.
- `AreaAttack` → `location.damageMonster(rect, min, max, ..., Shadow)`.
- Fishing: `rod.beginUsing(location, x, y, Shadow)`, `rod.castingPower = 1f`, `rod.tickUpdate(gameTime, Shadow)` every frame, and on `rod.isNibbling` → `rod.DoFunction(location, 1, 1, 1, Shadow)`. See fact 1 for why this is fragile.
- Shopping: bypasses ShopMenu entirely, `Game1.player.Money -= total; Game1.player.addItemToInventory(ItemRegistry.Create(qualifiedId, qty))` (note: adds to the HOST's inventory, and charges the host).
- `WarpTo(locationName, x, y)`: remove NPC from old `characters`, set `Position/currentLocation`, `target.addCharacter(npc)`, mirror to shadow.
- `CompanionActions.cs`: direct tile manipulation (`dirt.state.Value = 1` to water, `crop.harvest`, debris removal) used by the autonomous farm mode; `WaterAll`/`HarvestAll` are instant cheats.

Movement (`CompanionAI.cs`): `npc.controller = new PathFindController(npc, location, targetPoint, 2)` with a 15-tick recalculation cooldown, distance > 10 tiles → teleport next to player, stuck detection at 120 ticks, `WarpToPlayerIfNeeded()` whenever the player changes location (there is no cross-location routing; it teleports).

Day cycle: `OnDayEnding`/`TimeChanged>=2600` set `Shadow.isInBed = true` ("prevent deadlock"); `OnDayStarted` restores stamina/health and warps companions out of mines. Since the shadow is not in `otherFarmers` it cannot actually participate in `FarmerTeam` ready checks (fact 1), so this is defensive rather than required.

Transport: mod writes `bridge_data.json` atomically every 30 ticks and drains `actions/*.json` (ordinal sort, delete-before-handle); Node MCP server reads/writes those files. Chat: `Game1.chatBox.addMessage(text, Color.Gold)` which is LOCAL ONLY (never networked, no speaker name).

What worked/failed per README notes: v0.2.1 fixed "AI tick rate (60/sec, was 2/sec)", atomic writes, an action-file race, "fishing rod lifecycle", "fishing timeout", "farm mode stuck detection", "mine mode ladder descent", "shadow farmer sync every tick", "day transition safety". README: "companion AI operates at 60 ticks/second rather than real-time LLM responses for combat" (hence `stardew_set_auto_combat`). Verdict: strongest design reference; file transport and cheat-style shopping/watering should not be copied.

### 3.2 JoeStrout/Farmtronics  `$R/farmtronics`

The origin of the shadow-farmer pattern (amarisaster credits it). `Bot/BotObject.cs` (1004 lines) is a `StardewValley.Object` big-craftable that owns a `BotFarmer` ("We need a Farmer to be able to use tools. So, we're going to create our own invisible Farmer instance"). Coverage:
- `UseTool()`: `farmer.CurrentTool.DoFunction(location, x, y, 1, farmer)`; MeleeWeapon/scythe via `beginUsing` + `crop.harvest` (mirrors `HoeDirt.performToolAction`).
- `Harvest()`: HoeDirt crops (hand or scythe), machines (`readyForHarvest`, `heldObject`), with a TODO noting the crop-harvest code path internally assumes `Game1.player` ("ToDo, something like: Game1.player = farmer").
- Placement via `itemAsObj.placementAction(location, x, y, farmer)`; chest transfer via `chest.addItem(item)`; `location.performToolAction`, `terrainFeatures[tile].performToolAction(tool, 1, tile)`, `obj.performToolAction(tool)` for clearing.
- `MoveForward()` uses `TileInfo.IsPassable` + `feature.doCollisionAction(...)`.
- Multiplayer (`Multiplayer/MultiplayerManager.cs`): bots are converted to `Chest`s around peer-context events "to prevent a XML serialization error", bot state is sent with SMAPI `SendMessage` (`AddBotInstance`, disk sync), and the host runs the shells of disconnected players' bots. So even a `StardewValley.Object` subclass needed the mod on every client and a serialization workaround.
Targets net6.0, SMAPI >= 4.0, Stardew 1.6 (uses `ItemId`, `GameData.Crops`).

### 3.3 StarDojo  `$R/stardojo`

`StardojoMod/ModEntry.cs` (937 lines): `TcpListener` on 127.0.0.1:`--port-id` (default 10783) started with `Task.Run`; each request `method%arg1%arg2` is marshalled onto the game thread by subscribing a one-shot `UpdateTicked` handler and completing a `TaskCompletionSource` (`HandleMessage`), then dispatched by reflection to `ActionsAPI`/`InitTaskAPI`. `waitForReady` spins (100 ms) until `!UsingTool && !paused && !usingWeapon && !toolAnimation && !passingOut && !fadeToBlack`. Screenshots and JSON observations are written into a memory-mapped file (`shared_memory_<port>.bin`, 8 MB). The Python side (`env/stardew_env.py`, gymnasium) launches `StardewModdingAPI.exe --port-id N --sample-rate R` per instance (Linux only for parallel).
`actions/Actions.cs` (3081 lines) drives `Game1.player`: `move` = `PathFindController` to an adjacent tile with `endBehaviorFunction` + `Player.Warped`/`MenuChanged` completion; `use_tool` = `tool.DoFunction(location, x*64, y*64, power, player)`; `use_item` = `Farmer.useTool`/`placementAction`/`performUseAction`; shop/dialogue/carpenter/animal-shop via menus with Harmony patches (`patches/ShopMenuPatch.cs`, `DialoguePatch.cs`); `pause`/`resume` set `Game1.paused`. Observation exporters (`GetTileInfo`, `GetSurroundings`, `GetFarmData`, `GetProgressionData`) are a good reference for what to serialize. Manifest MinimumApiVersion 3.0.0, csproj net6.0 + Harmony 2.3.3 + MessagePack. MIT.

### 3.4 luy-0/StardewValley-MCP  `$R/sv-mcp-luy`

Apache-2.0, spec-driven, Chinese docs. Relevant decisions: ADR-0002 (`spec/decisions/0002-local-transport.md`) chose "Mod = listener, MCP = client" over the reverse and over named pipes/UDS ("Windows, macOS and Linux path/permission/library behaviour differ, would expand the install and test matrix"), with a 4-byte big-endian length prefix + protobuf frame, HMAC-SHA256 challenge/response using a shared secret generated into the mod's `config.json` on first load, a single-owner lease with grace-period resume, and result tombstones so a reconnecting client never re-executes a command. `docs/mod-capabilities.md`: 22 capabilities including `navigate` (same-map or cross-map to a position/object/character), `interact`, `use_tool` (axe/pickaxe/scythe/hoe/watering can with charge levels, "observed by an independent driver through the tool's accept/release/converge lifecycle"), `transfer_inventory_item` through the live chest UI, `purchase_shop_item`, `craft_item`. `docs/runtime-compatibility.md`: keep `net6.0`; build with .NET 10 SDK, test with the 6.x runtime. Controls the host player, so the body is not reusable, but the protocol/auth design and the capability list are worth mirroring.

### 3.5 zunderscore/StardewWebApi  `$R/stardewwebapi`

`src/Server/WebServer.cs`: `HttpListener` with prefixes `http://localhost:7882/`, `http://127.0.0.1:7882/` (+ `[::1]` on Windows), `Task.Run(MainLoop)`, semaphore of 20 concurrent contexts; `WebServer.WebSockets.cs`: `context.AcceptWebSocketAsync(null)` on `/events`, broadcast helper; attribute routing (`[Route]`, `[RequireLoadedGame]`). Proves `System.Net.HttpListener` + `System.Net.WebSockets` work inside a SMAPI mod with zero third-party DLLs. MIT.

### 3.6 SMAPIDedicatedServerMod  `$R/dedicated-server-mod` and JunimoServer  `$R/junimoserver`

Both turn the HOST into a bot. Dedicated: `Chat/EventDrivenChatBox.cs` subclasses `ChatBox`, overrides `receiveChatMessage(long sourceFarmer, int chatKind, LanguageCode, string message)` to raise an event, and `StartFarmStage.cs:290` swaps it into `Game1.onScreenMenus` in place of `Game1.chatBox` (which also replaces SMAPI's `SChatBox`, losing SMAPI's chat error logging). JunimoServer instead uses a Harmony postfix on `ChatBox.receiveChatMessage` (`Services/ChatCommands/ChatCommands.cs:49`, `ChatWatcher.receiveChatMessage_Postfix`), hides the host with `Game1.displayFarmer = !PlayerIsHidden` (`HostAutomation/Activities/HideHostActivity.cs`), warps it to the farm each day, and ships `JunimoServer.Shared/HttpListenerFix.cs` (Harmony patch for dotnet/runtime#28658 on Linux) plus a `NullDisplayDevice`/`FpsThrottle` for headless rendering. JunimoServer runs in Docker with the Steam depot downloaded by the user's own account; it is a SERVER product, not a way to add a bot to a player's local game. MIT.

### 3.7 Floogen/CustomCompanions  `$R/customcompanions`

`Framework/Companions/Companion.cs`: `Companion : NPC` adds its own `NetFields` (`companionKey`, `ownerId`, `targetTile`, `motion`...) in `initNetFields()`, so instances serialize to farmhands ONLY if the mod (and the content pack) is on every client; follow logic is velocity-based (`SetMotion(Utility.getVelocityTowardPoint(...))`, `isCollidingPosition` checks), not `PathFindController`. Useful as a reference for a synced custom NPC subclass, and as evidence that "custom NPC type = mod on all clients". MIT.

### 3.8 Smaller ones

- AutoPlaySV (`$R/autoplaysv`, no license): manually steps `pathFind.update(...)`, `Game1.player.updateMovement(...)`, `updateMovementAnimation` inside `UpdateTicked`, uses `warpFarmer(warp)` and `obj.checkForAction(Game1.player)`; 1.5-era; read-only reference.
- Starbot (`$R/starbot`, MIT, 2020): input simulation through a SMAPI-era `IInputSimulator`; README claims it "could operate farmhands while being the only human", i.e. it runs on each farmhand client. 1.4/1.5 era, not maintained.
- bot-framework (`$R/bot-framework`, no license): route/tour planning across `GameLocation`s over an abstract `Character`; ideas only.
- ASVA (`$R/asva`, no license): `apps/smapi-bridge/src/WebSocketServer.cs` uses the WatsonWebsocket NuGet package on ws://127.0.0.1:7890; `ActionInjector.cs` teleports (`Game1.player.Position = ...`) and calls `Game1.player.useTool()`; a Node/TS agent with Ollama does A* itself. Early prototype.
- zalataraglados-prog/StardewValleyAICompanion (`$R/ai-companion-zal`, no license): very large, policy-model-driven, explicitly plans "AI joins as a separate character with an independent input channel" as a future constraint (`docs/FUTURE_COMPANION_ARCHITECTURE_CN.md`) but today controls the local player. Unlicensed; reference only.

---

## 4. Technical facts

### Fact 1. A mod CAN spawn a separate, visible, tool-using body without a second client (HIGH, with an itemized caveat list)

Evidence: Farmtronics `Bot/BotObject.cs` + `Bot/BotFarmer.cs`; amarisaster `CompanionFarmer.cs` + `BotFarmer.cs`; decompile signatures.

- Visible body: any `NPC` (or subclass) added with `location.addCharacter(npc)` (`GameLocation.cs:1976`; `characters` is a `NetCollection<NPC>` at line 238) is drawn, collides, and can be given `npc.controller = new PathFindController(...)` (fact 3). `NPC.showTextAboveHead(text, ...)` (`NPC.cs:1374`) draws a speech bubble; `textAboveHead` is a plain field, not a `NetString`, so it is host-local.
- Mechanics: `Tool.DoFunction(GameLocation location, int x, int y, int power, Farmer who)` (`Tool.cs:588`), `Tool.beginUsing(...)`/`endUsing(...)`/`tickUpdate(GameTime, Farmer who)` (`Tool.cs:467-669`), `MeleeWeapon.DoDamage(...)`, `Object.placementAction(GameLocation, int x, int y, Farmer who = null)` (`Object.cs:6008`), `Chest.addItem(Item)` (`Chest.cs:854`), `HoeDirt.crop.harvest(...)`, `location.damageMonster(..., Farmer who)` all accept an arbitrary `Farmer` instance. Stamina/XP/health accrue on that instance (`checkForExhaustion(oldStamina)` at `Farmer.cs:6782`).
- The shadow must NOT be in `Game1.otherFarmers`: `Multiplayer.updateRoots()` (`Multiplayer.cs:326`) iterates `farmerRoots()` built from `Game1.otherFarmers.Roots`, and both mods report NPEs on a hand-built farmer there. Consequently the shadow is invisible to `Game1.getOnlineFarmers()`, so `FarmerTeam` ready checks (`FarmerTeam.cs:1185-1254`) and sleep/festival gating ignore it; that is desirable.
- What does NOT come for free on an NPC + shadow farmer (each needs mod code):
  1. Tool-use animations: `Tool.DoFunction` applies the effect without the farmer swing animation; the NPC sprite must play its own frames (amarisaster does not; Farmtronics has a scythe-frame counter).
  2. Fishing minigame: `FishingRod.DoFunction` returns early for a non-local farmer while `isReeling || isFishing || pullingOutOfWater` (`FishingRod.cs:392`), and a nibble that reaches `startMinigameEndFunction` sets `Game1.activeClickableMenu = new BobberBar(...)` (`FishingRod.cs:840`) on the HOST's screen. amarisaster's cast/tick/hook path is therefore unreliable (their own "fishing timeout" fix). The clean route is to roll the catch in mod code and call the public `FishingRod.pullFishFromWater(string fishId, int fishSize, int fishQuality, int fishDifficulty, bool treasureCaught, bool wasPerfect, bool fromFishPond, string setFlagOnCatch, bool isBossFish, int numCaught)` (`FishingRod.cs:1038`) or simply add the fish via `ItemRegistry.Create` after a plausible delay; the shadow never opens the minigame.
  3. Shops: `ShopMenu` is UI-bound (`onPurchase` delegate, `ShopMenu.cs:236-270`); buy by reading `ShopData` and doing `ItemRegistry.Create` + money deduction (amarisaster `BuyItem`), choosing whose wallet (shared team wallet vs the companion's own `Money`).
  4. Chests/fridge: use `chest.Items`/`chest.addItem` directly (Farmtronics), never `ItemGrabMenu`.
  5. Doors, ladders, warps: NPCs do not auto-warp on `location.warps`; amarisaster teleports between locations; StarDojo relies on the player's `warpFarmer`. Use `WarpPathfindingCache.GetLocationRoute` + explicit `Game1.warpCharacter`-style moves (fact 3).
  6. `Farmer.Update(GameTime, GameLocation)` references `Game1.player` in ~18 places (Desert Festival egg logic, `actionsWhenPlayerFree` guarded by `IsLocalPlayer`); neither mod calls `Shadow.Update` at all; they only sync position. Keep it that way and drive tools directly.
  7. `Farmer.IsLocalPlayer` is `UniqueMultiplayerID == Game1.player.UniqueMultiplayerID` (`Farmer.cs:1873`), so every `who.IsLocalPlayer` branch in game code (sounds, HUD messages, minigames) is skipped for the shadow. Usually good; sometimes a needed side-effect is missed (item pickup HUD, sound).
- NPC Adventures and CustomCompanions show the pure-NPC route (follow + sword swings) but never touch tools, so the shadow farmer remains the only demonstrated way to till/water/mine/chop as a non-player.

### Fact 2. Split-screen farmhand driven programmatically: possible in principle, undone anywhere, expensive (MEDIUM for the API, LOW for feasibility)

- Vanilla API: `GameRunner.AddGameInstance(PlayerIndex)` (`GameRunner.cs:192`) creates a second `Game1` with its own `staticVarHolder`, after `Game1.StartLocalMultiplayerIfNecessary()`; instances are swapped via `LoadInstance/SaveInstance` each tick (`ExecuteForInstances`). No method named `LoadSplitScreenGame` exists in 1.6.15.
- Input routing (`InputState.cs:25-110`): `GetKeyboardState()` returns `default` unless `Game1.game1.IsMainInstance && HasKeyboardFocus()`; `GetMouseState()` returns a simulated position for non-main instances; `GetGamePadState()` reads `GamePad.GetState(Game1.playerOneIndex)`. So a split-screen farmhand can ONLY be driven by a gamepad, and a mod would have to patch `InputState.GetGamePadState` (SMAPI already replaces `Game1.input` with an internal `SInputState` that overrides all three getters and has an internal `OverrideButton(SButton, bool)`, `SInputState.cs:136-163`) to feed a synthetic `GamePadState` for instance N. The new instance still has to walk the `FarmhandMenu` (needs a Cabin on the farm) through that synthetic input.
- Cost: the second instance runs the full update+draw loop and occupies half the window (`Game1.DrawSplitScreenWindow`, `Game1.cs:13988`); community mods "Split Screen Manager" (Nexus 12063) and "Splitscreen Improved" (24507) exist to manage layout, and Ilyaki/SplitScreen runs multiple `StardewModdingAPI.exe` processes instead. No project drives a split-screen farmhand programmatically.
- Headless/dedicated servers (JunimoServer, SMAPIDedicatedServerMod, DawningW/stardew-always-on-server, JunimoHost) automate the HOST farmer, hide it (`Game1.displayFarmer=false`) and let humans join as farmhands; their reusable parts are chat interception, host automation stages, and Linux `HttpListener` fixes, not a bot-as-farmhand.
- Verdict: fallback only. It would give a real `Farmer` with animations, minigames and menus, at the price of a permanent split window, doubled game cost, synthetic-gamepad plumbing, and a cabin requirement.

### Fact 3. Pathfinding APIs (HIGH)

- `PathFindController(Character c, GameLocation location, Point endPoint, int finalFacingDirection)` plus overloads with `endBehavior endBehaviorFunction`, `int limit` (default 10000 nodes) and `Stack<Point> pathToEndPoint` (`PathFindController.cs:61-110`). `endBehaviorFunction?.Invoke(character, location)` fires on arrival (line 283). Works for any `Character` (NPC or Farmer): StarDojo uses it on `Game1.player`, amarisaster on the NPC; assign to `character.controller` and the game's update loop advances it. `pathToEndPoint == null || Count == 0` means no path.
- Static: `PathFindController.findPath(Point start, Point end, isAtEnd fn, GameLocation, Character, int limit)` (line 180) and `findPathForNPCSchedules(...)` (line 425).
- Cross-location routing: `StardewValley.Pathfinding.WarpPathfindingCache.GetLocationRoute(string startingLocation, string endingLocation, Gender gender)` returns the chain of location names NPC schedules use (`WarpPathfindingCache.cs:49`, `PopulateCache()` at 28); per-location exits are `location.warps` (`Warp.X/Y/TargetName/TargetX/TargetY`) and doors. Neither prior-art body does real cross-map routing (amarisaster teleports to the player's map; luy-0 claims cross-map `navigate` for the player). Sei's adapter will need: route = `GetLocationRoute`; per hop, `PathFindController` to the warp tile, then remove from `characters`, `addCharacter` in the target, set `Position` to `TargetX/TargetY`, mirror to shadow.
- Failure modes reported: NPC standing on the target tile (StarDojo detours to an adjacent tile), being stuck > 2 s (amarisaster retargets), and `PathFindController` throwing on some locations (amarisaster wraps every construction in try/catch and teleports on failure).

### Fact 4. Transport from the mod to Node: no sandbox, several proven options (HIGH)

- SMAPI does not restrict networking or assemblies. `ModWarning` (`smapi/src/SMAPI.Toolkit/Framework/BundledModData/ModWarning.cs`) only flags `AccessesFilesystem`, `AccessesShell`, `AccessesConsole`, `PatchesGame`, `UsesUnvalidatedUpdateTick`, `NoUpdateKeys`, `ChangesSaveSerializer` as console warnings; nothing about sockets. Mods may ship extra DLLs next to their own (StarDojo: MessagePack/Newtonsoft/Harmony; ASVA: WatsonWebsocket; luy-0: Google.Protobuf).
- Proven in mods: `System.Net.HttpListener` + `System.Net.WebSockets` (StardewWebApi, StardewMCP on Nexus at :24842), `System.Net.Sockets.TcpListener` (StarDojo :10783, luy-0 protobuf frames), third-party WebSocket lib (ASVA :7890), file polling (amarisaster), memory-mapped file for frames (StarDojo).
- The one hard rule: touch game state only on the game thread. StarDojo's pattern (queue the request, complete it inside a one-shot `GameLoop.UpdateTicked` handler) or a `ConcurrentQueue` drained in `UpdateTicked` is required; JunimoServer has a `GameThreadOneShot` util for the same thing.
- Named pipes / UDS: rejected by luy-0 for cross-platform reasons; stdio is not available (the mod is loaded inside the game process, which Sei does not spawn when the player launches via Steam).
- Linux note: JunimoServer needed a Harmony fix for `HttpListener` (`dotnet/runtime#28658`, "HttpListener on Linux deprecated in favor of Kestrel"); for Windows/macOS it is fine. A raw `TcpListener` with newline-delimited JSON avoids that entirely.
- Recommendation: mod = listener on 127.0.0.1 (stable lifetime, luy-0's ADR-0002 reasoning), WebSocket over `HttpListener` for framing convenience, or length-prefixed/NDJSON over `TcpListener` for zero platform quirks; a random per-install token written to the mod's `config.json` that Sei reads (luy-0's HMAC scheme is the hardened version).

### Fact 5. Versions and compatibility (HIGH)

- Latest stable Stardew Valley is **1.6.15** (wiki Version History top entry; JunimoServer badge "Stardew Valley v1.6.15"; decompile is 1.6.15 build 24356). 1.6 patch series: 1.6, 1.6.1 ... 1.6.15.
- SMAPI source: `Constants.cs` `RawApiVersion = "4.5.2"`, `MinimumGameVersion = 1.6.14`, `MaximumGameVersion = null`. Mods target **net6.0** (wiki Get Started: "Install the .NET 6 SDK. You need .NET 6 because it's the version used by the game... Yes we know it's EOL"); luy-0 builds with the .NET 10 SDK targeting net6.0. Reference `Pathoschild.Stardew.ModBuildConfig` (4.1.1 in both bodies; 4.3.0 in StarDojo).
- 1.6 breaking changes that matter here (wiki Migrate to 1.6): string item IDs everywhere (`ItemRegistry.Create("(O)472")`, `QualifiedItemId`), `ObjectFactory/ToolFactory` removed, `Farmer.items`/`Chest.items` are the new `Inventory` class, `Data/Characters` replaces `Data/NPCDispositions` (needed to register the companion NPC as a valid character), unified `Gender`, `Game1.player.team.globalInventories`, `PathFindController` moved to `StardewValley.Pathfinding`. SMAPI 4 replaced `IAssetLoader/IAssetEditor` with `Content.AssetRequested` and split `helper.ModContent`/`helper.GameContent`.
- Multiplayer between mismatched versions is refused by the game, so the mod must track patch releases; SMAPI's rewriters (`Rewriters/StardewValley_1_6`) paper over many API renames automatically.

### Fact 6. Distribution and detection (HIGH for mechanics, MEDIUM for UX judgement)

- SMAPI install: the official zip contains `install on Windows.bat`, `install on macOS.command`, `install on Linux.sh`, `internal/<windows|unix>/install.dat` (a renamed zip) and `SMAPI.Installer.dll`. The installer is scriptable: `--install`, `--uninstall`, `--no-prompt`, `--game-path "<dir>"` (`InteractiveInstaller.cs:134-155`). On Windows it prints the Steam launch option `"<game>\StardewModdingAPI.exe" %command%` (line 527-530); on macOS/Linux it renames the launcher so the normal Steam/GOG launch already runs SMAPI (wiki: "You don't need to change your Steam launch options (that's only needed on Windows)"). SMAPI is LGPL-3.0; downloading it at runtime from smapi.io (or GitHub releases) rather than bundling keeps Sei's licensing simple.
- Steam launch options cannot be set through a public API; they live in Steam's `userdata/<id>/config/localconfig.vdf` and Steam must be closed to edit safely. The least-friction path is: Sei launches `StardewModdingAPI.exe` (or the macOS `Contents/MacOS/StardewValley` launcher) directly; achievements/overlay are lost only when launched this way on Windows. Offer the launch-option instructions as an optional "keep achievements" step. GOG Galaxy needs a `start.bat` custom executable; Xbox/Game Pass needs exe renaming (wiki Installing_SMAPI_on_Windows). macOS Gatekeeper blocks `install on macOS.command` for many users (wiki troubleshooting section); Sei running the installer DLL itself with `dotnet` avoids the double-click path but still needs the game's bundled .NET runtime or a system one.
- Mod install = copy a folder into `<game>/Mods/<ModName>/` containing `ModName.dll` + `manifest.json` (+ assets). SMAPI hot-loads nothing; the game must be (re)started.
- Game path detection, straight from SMAPI's `GameScanner.cs` (`smapi/src/SMAPI.Toolkit/Framework/GameScanning/`): Windows registry `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 413150\InstallLocation`, `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\1453375253\PATH`, `HKCU\Software\Valve\Steam\SteamPath` + `steamapps\libraryfolders.vdf` (app key `413150`), then defaults under `C:\Program Files[ (x86)]\{Steam\steamapps\common, GalaxyClient\Games, GOG Galaxy\Games, GOG Games}\Stardew Valley` and `X:\Program Files\ModifiableWindowsApps\Stardew Valley` for C..H; macOS `~/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS` and `/Applications/Stardew Valley.app/Contents/MacOS` (GOG); Linux `~/.steam/steam/...`, `~/.local/share/Steam/...`, Flatpak, `~/GOG Games/Stardew Valley/game`; plus `~/stardewvalley.targets` `<GamePath>`. Validity = `Stardew Valley.dll` present (1.6+). Port this to the Electron main process.
- Runtime detection of "is SMAPI running / is our mod loaded": the mod's own listener answering a hello on the loopback port, plus SMAPI's log at `%AppData%\StardewValley\ErrorLogs\SMAPI-latest.txt` (Windows) / `~/.config/StardewValley/ErrorLogs/` (macOS/Linux).

### Fact 7. Chat in and out (HIGH)

- Reading: SMAPI exposes no chat event (wiki Multiplayer API lists only `ModMessageReceived`). Every mod reads chat by hooking `ChatBox.receiveChatMessage(long sourceFarmer, int chatKind, LocalizedContentManager.LanguageCode language, string message)` (`ChatBox.cs:986`): JunimoServer via Harmony postfix (`ChatWatcher.receiveChatMessage_Postfix`), SMAPIDedicatedServerMod by replacing `Game1.chatBox` with a subclass (which evicts SMAPI's own `SChatBox`, `SCore.cs:1256`; prefer the postfix). Both local and remote lines pass through it: the local player's typed line goes `ChatBox.textBoxEnter(string)` → `Game1.multiplayer.sendChatMessage(...)` + `receiveChatMessage(Game1.player.UniqueMultiplayerID, 0, ...)` (`ChatBox.cs:113-131`); remote lines arrive as message type 10 in `Multiplayer.processIncomingMessage` → `Multiplayer.receiveChatMessage(Farmer source, long recipient, ...)` → `Game1.chatBox.receiveChatMessage(...)` (`Multiplayer.cs:1133-1145`). `chatKind` 0 = public, 3 = private, 2 = notification, 1/other = error. Chat commands start with `/` and are intercepted before sending.
- Writing so it renders like another player: `formatMessage` (`ChatBox.cs`, private) resolves the speaker name via `Game1.player` or `Game1.otherFarmers[sourceFarmer]`, else the `Strings\UI:Chat_UnknownUserName` string. Since the shadow farmer is not in `otherFarmers`, options are: (a) host-local `Game1.chatBox.addMessage("Sei: hi", color)` (what amarisaster does; not networked); (b) `Game1.chatBox.receiveChatMessage(shadowId, 0, lang, text)` which renders with the unknown-user format; (c) chatKind 2 notification format with the name baked in; (d) network delivery to farmhands via `Game1.server.sendMessage(peerId, 10, Game1.player, recipient, lang, text)` (renders as the HOST's name) or via SMAPI `SendMessage` to a client-side copy of the mod that calls `addMessage` locally. The Minecraft integration already emits chat lines with a name prefix; (a) on host + (d)/(SMAPI message) for farmhands is the pragmatic mapping. Add `NPC.showTextAboveHead` for an in-world speech bubble on the host.
- The game filters chat through `Program.sdk.FilterDirtyWords` on both send and receive.

### Fact 8. Multiplayer visibility of a host-spawned companion (HIGH)

- `GameLocation.characters` is a `NetCollection<NPC>`; each element is a `NetRef` whose wire format writes the concrete `Type.FullName` (`Netcode/NetRefTypes.cs` `WriteTypeOf`), and the reader resolves it by scanning `AppDomain.CurrentDomain.GetAssemblies()` and throws `InvalidOperationException` if not found (`NetRefTypes.GetType`). Therefore: a custom `NPC` SUBCLASS (CustomCompanions' `Companion`, amarisaster's `CompanionNPC`) requires the mod assembly on every farmhand; a plain `StardewValley.NPC` instance syncs to vanilla clients.
- A plain NPC still needs its sprite: `AnimatedSprite.textureName` is a `NetString` (`AnimatedSprite.cs:25`) loaded on the client via the content pipeline, so a custom `Characters/<Name>` asset must exist on the client (mod or content pack) or the client errors; the safe vanilla-client option is to reuse a vanilla character sheet name. Portraits and `Data/Characters` entries are likewise per-client assets.
- The shadow `Farmer` is never synced (by design), so farmhands see the NPC body and the world effects of its actions (tilled dirt, watered crops, broken rocks, dropped items are all host-authoritative net state) but nothing "farmer-like" about it.
- Farmtronics' experience (convert bots to `Chest` around peer connect "to prevent a XML serialization error") shows a custom `Object` subclass also needs care for save serialization; an NPC that the mod removes on `Saving` and recreates on `DayStarted`/load avoids polluting the save (amarisaster removes companions on `ReturnedToTitle`; check `Saving` too).
- Recommendation: v1 host/single-player only; v2 ship the same mod to farmhands (SMAPI's `IMultiplayerPeer.GetMod(id)` lets the host detect who has it and degrade to a vanilla-sprite NPC for those who do not).

---

## 5. Recommended architecture sketch

```
Electron main (src/main)                 SMAPI mod "SeiCompanion" (C#, net6.0)      Stardew 1.6.15 process
  stardewInstaller.ts                      ┌───────────────────────────────┐
   - GameScanner port (fact 6)             │ ModEntry                      │
   - download SMAPI zip, run installer     │  - AssetRequested: Data/Characters entry + Characters/Sei sheet
     --install --no-prompt --game-path     │  - UpdateTicked: drain cmd queue, tick bodies, push snapshots
   - copy Mods/SeiCompanion                │  - Harmony postfix ChatBox.receiveChatMessage → chat events
   - launch StardewModdingAPI(.exe)        │ Body                          │
  botSupervisor.ts                         │  - NPC visual (+ animation frames for tool use)
   - forks src/bot with adapter=stardew    │  - BotFarmer shadow (tools, combat, inventory, stamina)
                                           │  - PathFindController + WarpPathfindingCache routing
src/bot (utilityProcess, Node)             │ Server                        │
  adapter/stardew/                          │  - 127.0.0.1:<port> WebSocket (HttpListener) or NDJSON TCP
   - connect.js  (ws client, token)  ◀────▶│  - hello/token, cmd{id,name,args} → result{id,ok,detail}
   - observers.js (snapshot → text)        │  - push: snapshot @2-4 Hz, events (chat, damage, warped, day)
   - registry.js (Zod tools, ~18 actions)  └───────────────────────────────┘
   - fsmWires.js (P0 safety, P1 chat, P2 movement, P3 idle)
```

Mod-side command set (each returns a result string the model reads, same "tell the model"
pattern as the Minecraft adapter): `spawn/despawn`, `follow(player)`, `goto(location, x, y)`
(cross-map), `face(dir)`, `use_tool(tool, x, y, power)`, `attack(target)`, `interact(x, y)`
(doors, ladders, machines, chests, NPC talk stub), `harvest(x, y)`, `plant(seedId, x, y)`,
`place(itemId, x, y)`, `chest_put/take`, `buy(shopId, itemId, qty)`, `eat(itemId)`,
`fish(x, y)` (mod-internal state machine ending in `pullFishFromWater`), `sleep`, `say(text)`,
`emote(id)`, `pause/resume` (mirrors `setGamePaused`). Observations: location name + tile grid
around the body (passable/water/object/crop state/breakable), monsters, NPCs, players,
inventory, stamina/health, time/season/weather, warps, plus `chat` and `damage` events.

Adapter-side: reuse the brain untouched (orchestrator, FSM, memory, say tool). The Stardew
adapter's registry mirrors the Minecraft one (`follow/come/goto, dig→mine/chop/till, gather,
place, equip, consume, sleep, container ops, fish, attack`). Long-running actions are
mod-side state machines reporting progress; the adapter polls or awaits completion with the
same wall-clock timeout discipline as `pathfinder_timeout_ms`. `world` fingerprint for memory
segmentation = save `Game1.uniqueIDForThisGame` + farm name.

Process/lifecycle: Sei never injects into a running game; it (re)launches SMAPI when the mod
is not answering, exactly as it tells the Minecraft player to open a LAN world today.
Summon = connect + `spawn`; stop = `despawn` + disconnect, with the same 30 s / 10 s
timeouts. The mod must remove the body on `Saving`/`ReturnedToTitle` and on disconnect after a
grace period.

---

## 6. Risks and unknowns

1. **Animation fidelity.** A shadow farmer applies tool effects instantly and silently for
   non-local players; the NPC must fake swing frames and sounds. Unverified how convincing
   this looks; amarisaster ships without it.
2. **Fishing.** Must be re-implemented (fact 1.2). The nibble/hook timing is doable; whether
   `pullFishFromWater` behaves for a non-local farmer (achievements, `fishCaught` stats) is
   untested.
3. **Game code that assumes `Game1.player`.** Farmtronics' harvest TODO and the ~18
   `Game1.player` references inside `Farmer.Update` show that some paths silently act on the
   host instead of the shadow (amarisaster's `BuyItem` even charges the host on purpose).
   Every new action needs a decompile read.
4. **Save pollution.** An NPC left in `characters` at save time is serialized; the shadow
   farmer holds items that vanish on restart unless persisted in `modData`. Needs a
   `Saving`/`Saved` dance like Farmtronics' chest conversion.
5. **Multiplayer.** Vanilla farmhands only see a vanilla-typed NPC with a vanilla sprite
   (fact 8); a custom sprite or subclass forces the mod onto every client. Chat from the
   companion cannot carry its own name over the network without a client-side mod.
6. **Version churn.** 1.6.x patches change signatures; SMAPI rewriters absorb most, but the
   mod pins `MinimumApiVersion` and needs a CI build against each release. A 1.7 would be a
   full re-verification.
7. **Install friction.** The SMAPI installer is scriptable, but Windows Steam achievements
   need a launch option Sei cannot set; macOS Gatekeeper and Full Disk Access prompts are
   real (wiki troubleshooting). Xbox/Game Pass builds need exe renaming.
8. **Latency model.** Companion AI in amarisaster runs at 60 Hz for combat because LLM
   round-trips are too slow; Sei's Minecraft adapter already has the same split (reflex
   loops in the adapter, LLM at P1/P2), so mirror that: combat retaliation, auto-eat and
   evasion live in the mod.
9. **Nexus-only mods unverified.** AI Farm Assistant, Farmhand Scheduler, Fabulous Farmhands
   and Fishbot could not be read (Cloudflare) and have no public source; from snippets they
   automate the player's own character, not a second body.
10. **Split-screen fallback is unproven** (fact 2); budget a spike only if the shadow farmer's
    action surface proves insufficient.

---

## 7. Licensing notes

- Freely reusable (MIT/Apache-2.0/LGPL): Farmtronics (MIT), amarisaster/StardewValley-MCP
  (LICENSE.txt is Apache-2.0; README says MIT; keep the Apache NOTICE either way),
  luy-0/StardewValley-MCP (Apache-2.0), StarDojo (MIT), StardewWebApi (MIT), CustomCompanions
  (MIT), SMAPIDedicatedServerMod (MIT), JunimoServer (MIT), Starbot (MIT code), RPGGO
  stardewAIRPG (MIT), Cradle (MIT). SMAPI itself is LGPL-3.0 (link against it as every mod
  does; do not vendor modified SMAPI). `Pathoschild.Stardew.ModBuildConfig` is MIT.
- Note-only (no license = all rights reserved): AutoPlaySV, stardew-valley-bot-framework,
  ASVA, zalataraglados-prog/StardewValleyAICompanion, hanshuqimen/StardewValleyAIMod. Read
  for ideas, copy nothing.
- GPL/AGPL: none of the relevant projects. NPC Adventures (purrplingcat) repos are MIT but
  1.5-era and not cloned.
- The decompiled game source is ConcernedApe's copyright; use it for reference only, never
  copy game code into the mod. Harmony (Lib.Harmony) is MIT. MonoGame is Ms-PL/MIT.
- Nexus mods without a stated license (StardewMCP, AI Farm Assistant, etc.) cannot be
  reused.

---

## 8. Reusable code list (paths under `$R`)

Body pattern (Apache-2.0 / MIT):
- `sv-mcp-amarisaster/smapi-mod/BotFarmer.cs` - invisible `Farmer` subclass: no-op `draw`, `SetMoving*` overrides, `FaceToward`, `WakeUp`, `SignalSleepReady`.
- `sv-mcp-amarisaster/smapi-mod/CompanionFarmer.cs` - NPC/shadow pairing, `UseToolAt`, `AttackNearbyMonsters`, `AreaAttack`, fishing cast/tick/hook, `WarpTo`, inventory serialization.
- `sv-mcp-amarisaster/smapi-mod/CompanionNPC.cs` - custom draw with aspect fix.
- `sv-mcp-amarisaster/smapi-mod/ModEntry.cs` - `Data/Characters` + `Characters/*` + `Portraits/*` injection via `AssetRequested`; day/sleep hooks; atomic file I/O (replace with sockets).
- `sv-mcp-amarisaster/smapi-mod/BotManager.cs` - spawn/despawn incl. duplicate-NPC sweep, per-companion crash isolation, command routing, `PathFindController` usage (lines 146-180).
- `sv-mcp-amarisaster/smapi-mod/CompanionAI.cs` - follow with recalculation cooldown, stuck detection, `WarpToPlayerIfNeeded`, mine-ladder descent.
- `sv-mcp-amarisaster/smapi-mod/SurroundingsScanner.cs` + `CompanionActions.cs` - tile/crop/object/monster scan and farm task scan.
- `sv-mcp-amarisaster/mcp-server/src/index.ts` - tool schema list (25 tools) to seed the Zod registry.
- `farmtronics/Farmtronics/Bot/BotFarmer.cs`, `Bot/BotObject.cs` (`UseTool`, `Harvest`, `doBotHarvestFromObject`, `PlaceItem`, chest transfer, `MoveForward`, debris attraction), `M1/TileInfo.cs` (passability), `Utils/MapUtils.cs`, `Multiplayer/*` (ModMessage sync + chest conversion on save).

Transport (MIT / Apache-2.0):
- `stardewwebapi/src/Server/WebServer.cs`, `WebServer.WebSockets.cs`, `WebServer.Routing.cs`, `WebServer.EndpointProcessing.cs` - HttpListener + WebSocket server with attribute routing.
- `stardojo/StardojoMod/ModEntry.cs` (`StartServer`, `HandleClientAsync`, `HandleMessage` main-thread marshalling, `waitForReady`).
- `sv-mcp-luy/spec/decisions/0002-local-transport.md`, `spec/mod-mcp-protocol.md`, `spec/capabilities/manifest.schema.json`, `spec/capabilities/behavior.md` - protocol/auth/lease design and a capability catalogue.
- `junimoserver/mod/JunimoServer.Shared/HttpListenerFix.cs` (Linux), `Util/GameThreadOneShot.cs`, `Util/WebSocketClient.cs`.

Observation exporters (MIT):
- `stardojo/StardojoMod/actions/Actions.cs` lines 2030-3038 (`ExportGameData_v2`, `GetPlayerData`, `GetNPCData`, `GetFarmData`, `GetProgressionData`, `GetTileInfo`, `GetSurroundings`), `env/observation.py`, `docs/docs_src/{observation_space,action_space}.md`.
- `stardewwebapi/src/Game/**` (Player/NPC/World/Items DTOs).

Chat (MIT):
- `junimoserver/mod/JunimoServer/Services/ChatCommands/ChatWatcher.cs` + `ChatCommands.cs` (Harmony postfix pattern), `dedicated-server-mod/DedicatedServer/Chat/EventDrivenChatBox.cs` (subclass pattern).

Host automation / hiding (MIT), only if a "companion hosts the world" mode is ever wanted:
- `dedicated-server-mod/DedicatedServer/HostAutomatorStages/*` (behavior chain: sleep, festivals, dialogue skipping, ready checks), `junimoserver/mod/JunimoServer/Services/HostAutomation/*`, `Services/AlwaysOnServer/*`.

Install path detection (LGPL-3.0, port the logic rather than the code):
- `smapi/src/SMAPI.Toolkit/Framework/GameScanning/GameScanner.cs`, `smapi/src/SMAPI.Installer/InteractiveInstaller.cs` (CLI flags, Steam launch string), `smapi/src/SMAPI.Installer/assets/README.txt` (manual install layout).

Game API reference (read-only, copyright ConcernedApe):
- `sdv-decompiled/Stardew Valley/StardewValley.Pathfinding/{PathFindController,WarpPathfindingCache}.cs`, `StardewValley/{Farmer,NPC,GameLocation,Multiplayer,InputState,GameRunner}.cs`, `StardewValley.Menus/ChatBox.cs`, `StardewValley.Tools/FishingRod.cs`, `StardewValley/Tool.cs`, `Netcode/NetRefTypes.cs`.

Wiki text extracts (curl'd HTML + `textutil` text) in `$R/wiki-*.txt`: Multiplayer API, Get Started, Player Guide, Installing SMAPI on Windows/Mac, Migrate to 1.6, Migrate to SMAPI 4.0, Version History, Input, Utilities.
