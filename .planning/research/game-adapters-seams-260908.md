# Sei game-adapter seams (worktree: `/Users/ouen/slop/sei-studio/sei-games`, branch `feat/game-adapters`)

Every path below is relative to the worktree root. Line numbers are from the
current tree. The CLAUDE.md in this worktree is byte-identical to the primary
checkout's.

Short version: the brain/adapter seam **already exists and is real** on the bot
side (`src/bot/brain/types.js` + `REQUIRED_ADAPTER_MEMBERS`), and the brain's
comment literally says "A future adapter (Stardew, Roblox, ...) implements this
same shape." What is NOT generic is everything around it: the boot composer
(`src/bot/index.js`) hard-imports the Minecraft adapter; the config schema has
`adapter.kind: z.literal('minecraft')`; the supervisor, IPC, renderer, error
classes, dashboard, LAN discovery and analytics all assume one game called
Minecraft; and a handful of Minecraft action names leak into the brain.

---

## 1. Bot process entry and the adapter interface

### 1.1 `src/bot/index.js` — the boot composer

The bot is forked by main and receives ONE `parentPort` message carrying both
the init payload and the transferred `MessagePort` (lines 1030-1046, 1164-1166).
All later commands arrive on `initPort`.

**Init message shape** (destructured at lines 573-636):

```js
const {
  character, apiKey, lanPort, lanMotd, summonDeadlineAt, userDataDir,
  mc_username, preferred_name, skinServerBaseUrl,
  cloudMode,            // {baseURL, authToken} | undefined
  llm: llmInit,         // {provider, model?, base_url?, api_key?} | undefined
  visionMode, realisticTyping, chatLanguage,
  companions,           // string[] of OTHER bots' in-game usernames
  continuity,           // {summary, recent[]} | null
  knowledge,            // string
  voiceCallActive,      // boolean
} = initData
```

Minecraft-specific keys: `lanPort`, `lanMotd`, `mc_username`, `skinServerBaseUrl`,
and the `character.username` read at 678-680. Everything else is game-generic.

**Config is built hard-wired to Minecraft** (lines 708-786):

```js
adapter: {
  kind: 'minecraft',
  minecraft: { host: '127.0.0.1', port: lanPort, auth: 'offline',
               username: bot_mc_username, version: 'auto' },
},
```

then `ConfigSchema.parse(applyLlmInit(rawConfig, llmInit, apiKey))` (789). Post-
parse stashes on the config object (ConfigSchema strips unknown keys): `_seiCompanions`
(804), `_seiContinuity` (812), `_seiKnowledge` (819), `_seiSummonDeadlineAt`
(826), `_seiVoiceCallActive` (835). A `lanPort == null` check at 846 emits
`LAN_NOT_OPEN` and returns.

**`start(config, hooks)`** (lines 51-539) is entirely Minecraft:
- top-level imports: `createBotInstance, resolveServerVersion` from
  `./adapter/minecraft/connect.js` (20), `createMinecraftAdapter` (30),
  `createDashboardTelemetry` from `./adapter/minecraft/dashboard/telemetry.js` (31).
- `const mc = config.adapter.minecraft` (53); version ping at 84-102.
- `bringUp()` (104-396): `createBotInstance({...})` with `onSpawn/onEnd/onError/
  onConnectTimeout` hooks; the whole reconnect policy (MAX_RECONNECT_ATTEMPTS=3,
  modded-host kick, liveness re-ping) lives here (151-307).
- Adapter construction: `_adapter = createMinecraftAdapter({ bot: _bot, config, visionEnabled: true })` (329).
- Dashboard telemetry: `_dash = createDashboardTelemetry({ bot: _bot, emit: onDashboard, logger })` (335).
- Brain start (344-370): `startBrain({ config, adapter: _adapter, logger,
  onTerminalError, onAuthExpired, onSeiChatReply, onAction, onQuitRequested,
  onCallEndRequested })`. `onAction` fans out to `_dash.setAction(name,args)`
  AND `emitLifecycle({type:'action', name, args})` (354-361).
- `_bot._sei_startChat?.(null)` (393) — a mineflayer-side chat behavior hookup.
- Returned handle (400-538): `stop, setAuthToken, deliverSeiChat, observeSeiChat,
  setVoiceCall, setGamePaused, setGameMode, deliverVoiceCallGreeting,
  setCompanions, setBackend, visionCapable, setDashboardWatch`. Only
  `setDashboardWatch` and `setCompanions` (filters against `mc.username`, 499)
  touch adapter state; the rest are brain passthroughs. `src/bot/portForwarders.test.js`
  pins that every port-dispatched method has a forwarder here.

**Port message vocabulary handled at lines 1049-1155** (`initPort.on('message')`):
`stop`, `sei-chat`, `sei-chat-observe`, `voice-call`, `dashboard-watch`,
`voice-call-greet`, `game-pause`, `game-mode`, `roster`, `jwt`,
`cloud-jwt-update`, `backend-switch`. Of these only `dashboard-watch` and
`roster` are adapter-facing; the rest are brain/auth.

**Lifecycle emitted UP the port** (`emitLifecycle`, 561-571; contract in
`src/shared/ipc.ts:670-684` `BotLifecycle`): `init-ack`, `connected`,
`disconnected`, `error {error: ErrorClass, message, retryAfterSeconds?}`, `chat
{from,text}`, `action {name,args}`, `summon-ready`, `summon-stopped`, `exit`.
Non-lifecycle port pushes: `{type:'dashboard', snapshot}` (888),
`{type:'vision-capability'}` (965), `{type:'request-jwt'}` (557),
`{type:'call-end'}` (369).

Error routing (890-917) maps message prefixes to Minecraft error classes:
`UNSUPPORTED_MC_VERSION`, `MODDED_HOST_REJECTED`, `LAN_NOT_OPEN`, else
`BOT_START_TIMEOUT`.

### 1.2 The adapter contract — `src/bot/brain/types.js` (JSDoc, `ADAPTER_INTERFACE_VERSION = 1`)

```
Action surface:   listActions(), getActionSchema(name), getActionDescription(name),
                  executeAction(name, args, {signal}) -> Promise<string>   // ALWAYS a string
Perception:       createSnapshotComposer() -> { next({lastActionResult, inFlight, ...}) : string, reset() }
Prompt blocks:    worldPrimer(), capabilityParagraph(), actionRules(), cuboidGrammar(),
                  eventAddendum(event, data) -> string ('' for unknown), cantReachNudge({x,y,z,range})
Lifecycle:        attach(handlers), [detach()]
Effects:          chat(text), closeAnySessions() -> Promise
Capabilities:     supportsAutoEat, supportsFollow  (booleans)
Identity:         botUsername, getKnownPlayers() -> Record<string, {username, uuid}>
```

`AdapterHandlers` (lines 30-39): `onPlayerJoined(player)`, `onPlayerLeft(player)`,
`onChat({username, text, playerSpoke, addressed, nearby})`,
`onAttacked({attacker, attackerLabel, attackerKind:'player'|'mob'|'unknown'})`,
`onSpawn()`. NOT documented in types.js but wired by brain/index.js: `onDeath({pos})`
(brain/index.js:290) and the extra `onAttacked` kinds `'reflex'|'defend'` plus
`suppressInterrupt` on chat (fsmWires.js:42, 87, 118).

Enforced subset — `src/bot/brain/index.js:21-30`:

```js
const REQUIRED_ADAPTER_MEMBERS = [
  'listActions', 'getActionSchema', 'getActionDescription', 'executeAction',
  'createSnapshotComposer', 'worldPrimer',
  'attach',
  'chat', 'closeAnySessions',
  'supportsAutoEat', 'supportsFollow',
  'botUsername', 'getKnownPlayers',
]
```
`assertAdapter` (66-75) throws on a missing member at `brain.start`.

**Optional members the orchestrator probes with `typeof`/`?.`** (all in
`src/bot/brain/orchestrator.js`): `cuboidGrammar` (487), `getWorldInfo` (1602,
1674), `getProgression` (1670, 1679, 2799), `renderIdleFrame` (1450-1457),
`eventAddendum` (2255-2259), `cantReachNudge` (4108), `capabilityParagraph`/
`actionRules` (1367-1369, called unguarded, so effectively required),
`setWorldPaused` (brain/index.js:510). A Stardew/DST adapter can omit
`getProgression`, `renderIdleFrame`, `cantReachNudge`, `cuboidGrammar` and
nothing breaks.

### 1.3 The Minecraft implementation — `src/bot/adapter/minecraft/index.js` (200 lines)

`createMinecraftAdapter({ bot, config, visionEnabled })` returns the object.
Notable: `executeAction` (58-85) merges `ctx` (the AbortSignal) into a
config-shaped 4th arg and hoists `pathfinder_timeout_ms`/`follow_range` from
`config.adapter.minecraft` to the top level for handlers; increments
`bot._seiActionActive` around each execute (gaze suppression). `getWorldInfo`
(95-104) returns `{spawnPoint:{x,y,z}|null, dimension}`. `attach` (122-127) is
`wireBotEvents(bot, handlers, {config})`. `chat` (150-163) drops any leading
`/` (command-injection guard) then `bot.chat(text)`. `setWorldPaused` (172)
freezes the body loops. `closeAnySessions` closes container + furnace UIs.

### 1.4 How the brain drives it

`src/bot/brain/index.js:86` `start({ config, adapter, logger, onTerminalError,
onAuthExpired, onSeiChatReply, onQuitRequested, onCallEndRequested, onAction })`:
- builds a `sessionBotShim` (95-106) exposing `players`/`username` from the adapter;
- `createOrchestrator({ adapter, config, ... reenqueue })` (192);
- `createPriorityQueue({ onDispatch: orchestrator.handleDispatch, onPreempt,
  idleFallbackMs: () => ... idleCadenceMs(config.persona.proactiveness) })` (210-226);
- `adapter.attach({...})` (229-351) translates handlers into queue events (see §3);
- `orchestrator.start()` (353).

The orchestrator wraps the adapter as a registry (`orchestrator.js:727-732`):

```js
const registry = {
  list: () => adapter.listActions(),
  schema: (name) => adapter.getActionSchema(name),
  description: (name) => adapter.getActionDescription(name),
  execute: (name, args, _bot, execOpts) => adapter.executeAction(name, args, execOpts),
}
```

and composes the cached system prefix from adapter prompt blocks
(`rebuildPersonalitySystem`, 1355-1400):

```js
cachedSystemBlocks = anthropic.buildCachedSystem([
  BASELINE_INSTRUCTIONS,                 // brain: UNIVERSAL + MINECRAFT baseline (see §4)
  renderPersona(config.persona),         // [1] index is load-bearing for log.js
  adapter.capabilityParagraph(),         // [2]
  adapter.worldPrimer(),
  adapter.actionRules(),
  renderProactivenessDirective(...), renderPunctuationDirective(...),
  ...(language), ...(knowledge)
], combinedToolsFor())
```

`combinedToolsFor()` (1322-1352) = personality tools + `buildAnthropicTools(subRegistry, descMap)`, filtering `look` unless the provider is a VLM.

---

## 2. Action registry

### 2.1 Generic — `src/bot/registry.js` (60 lines, game-agnostic, keep as-is)

```js
register(name, zodSchema, handler(args, bot, config), description = '')
execute(name, args, bot, config)  // schema.parse(args) then handler; throws on unknown
list(), schema(name), description(name)
```
No priority field; priority is an FSM concept, not a registry one.

### 2.2 Minecraft — `src/bot/adapter/minecraft/registry.js` (584 lines)

`createDefaultRegistry({ visionEnabled })` registers ~30 actions (grep
`registry.register(` at 179, 209, 218, 254, 297, 313, 323, 334, 340, 354, 377,
391, 413, 472, 486, 506, 517, 526, 530, 534, 536, 538, 540, 549, 561, 563, 572,
581): `goTo, dig, explore, find, gather, follow/unfollow, build, shelter, place,
equip, craft, attackEntity, consume, look (gated), drop, activateItem,
activateBlock, readSign, sleep, openContainer/deposit/withdraw,
openFurnace/smelt/addFuel/takeSmelted, setPvp, ...`. Handlers import mineflayer
behaviors and `minecraft-data`. Shared shapes: `TargetShape` (block | `#N`
handle | x/y/z, maxDistance) and `DigSchema` (cuboid `to` + 256-cell cap).
Descriptions come from `ACTION_DESCRIPTIONS` in promptLibrary via
`describeAction(name, visionMode)` (adapter/index.js:57), NOT from the registry's
own `description` field (that is the fallback).

Results are plain strings: `'dug oak_log'`, `'cant_reach ...'`, `'timeout ...'`
(types.js:54). The orchestrator string-matches SOME of them: `cant_reach` prefix
on `goTo` results (orchestrator.js:4096-4110).

### 2.3 Brain-side tool families (`src/bot/brain/orchestrator.js`)

- `PERSONALITY_NAMES = new Set(['remember','forget','setGoal','clearGoal','follow','unfollow','end_loop','say','quit_game','end_call'])` (326).
  **`follow`/`unfollow` are Minecraft registry actions hardcoded into the brain's
  set** so they count as "not a movement call" (follow is a background trailer).
  `ACTION_VERB_SKIP` (335) and `INLINE_METADATA` (1797) are the related sets.
- `movementCalls = toolUses.filter(u => !PERSONALITY_NAMES.has(u.name))` (3892):
  a say()-only turn ends the loop; any non-personality call keeps it alive.
- Brain-registered inline tools (1255-1310): `end_loop`, `quit_game` (its
  description says "Leave the Minecraft game", 1272), `end_call`, plus
  `say/remember/forget/setGoal/clearGoal` in `personalityTools`.
- `emitSayCalls(loop, toolUses)` (1010) emits say() text up front through
  `_emitSayLine` -> `adapter.chat(clipChars(msg, MC_CHAT_MAX_CHARS))` (875-878)
  or `onSeiChatReply` when the turn came from Sei chat / a voice call.
  `MC_CHAT_MAX_CHARS = 256` (63) is a Minecraft packet limit living in the brain.
- Other Minecraft names in the brain: `stopToolForAction` returns `'unfollow'`
  for `follow` (1733); `_buildExecOpts` treats `build`/`gather`/`dig{to}` as
  progress-flavored (1818-1820); dig cap `_digSeen` (3902); `attackEntity`
  (3914); `goTo` cant_reach (4096); `look` filter (1345).

---

## 3. FSM wiring

### 3.1 Queue — `src/bot/brain/fsm.js` (game-agnostic)

```js
export const Priority = Object.freeze({
  P0_SAFETY: 0, P1_CHAT: 1, P2_MOVEMENT: 2,
  P2_ACTION_COMPLETE: 2.1, P2_ACTION_TICK: 2.3, P2_5_LOOP_END: 2.5, P3_IDLE: 3,
})                                                                    // 30-48
export function attackedPriority(data) {                              // 79-81
  return (kind === 'reflex' || kind === 'defend') ? Priority.P1_CHAT : Priority.P0_SAFETY }
createPriorityQueue({ onDispatch, onPreempt, idleFallbackMs, logger })
  -> { enqueue(priority, event, data), resetIdleTimer(), setHold(predicate), dispose() }   // 111, 368
```
Idle tick auto-enqueues `sei:idle {quietMs}` (167). P1 chat with
`data.playerSpoke === true` preempts a non-P0 in-flight action (202-204).

### 3.2 Event names an adapter feeds (via `adapter.attach` handlers -> `brain/index.js`)

| Handler | Queue event | Priority | Where |
|---|---|---|---|
| `onChat(evt)` | `sei:chat_received {username, message, text, addressed, playerSpoke}` | P1_CHAT | index.js:244-267 (skipped when `evt.suppressInterrupt`) |
| `onAttacked(evt)` | `sei:attacked` | `attackedPriority(evt)`: P0 for player/mob, P1 for `reflex`/`defend` | 268-289 |
| `onDeath(evt)` | `sei:death {pos, lastAttack?}` | P1_CHAT | 290-315 |
| `onSpawn()` | `sessionState.onSpawn()`, `orchestrator.noteSpawn()`, then once: `sei:idle {reason:'just_connected_first_spawn'}` after `spawn_settle_delay_ms` | P3 | 316-350 |
| `onPlayerJoined/Left` | sessionState only | n/a | 230-243 |

Internal re-enqueue defaults (`reenqueue`, 145-189): `sei:loop_terminal` resets
idle timer; `sei:action_complete` 2.1, `sei:action_tick` 2.3, `sei:loop_end`
2.5, `sei:idle` 3, unknown -> P2_MOVEMENT.

### 3.3 Minecraft wires — `src/bot/adapter/minecraft/fsmWires.js` (206 lines)

`wireBotEvents(bot, handlers)` subscribes to mineflayer/behavior bus events and
translates: `sei:chat_received` -> `onChat` (30-49; produced by
`behaviors/chat.js`), `sei:attacked` -> `onAttacked` (53-72; `behaviors/combat.js`),
`sei:owner_attacked` -> `onAttacked{attackerKind:'defend'}` (81-96),
`sei:reflex` -> `onAttacked{attackerKind:'reflex', noticed, count}` (110-126),
`sei:survival` -> `onAttacked{attackerKind:'reflex', survivalKind}` (135-149),
`sei:death` -> `onDeath` (157-161), `playerJoined/playerLeft` (164-175),
`spawn` -> `onSpawn` (181-185). Returns a dispose fn (195-205).

A new adapter's wires file is this shape: an event source -> the five/six
handler calls. The `attackerKind` vocabulary (`player|mob|unknown|reflex|defend`)
plus `survivalKind` are consumed by `eventAddendum` in the prompt library.

### 3.4 Pause

`brain.setGamePaused(paused)` (index.js:508-516) = `orchestrator.setGamePaused`
+ `adapter.setWorldPaused?.(paused)` + `queue.setHold(...)`. `snapshotText()`
returns the literal `'your minecraft was paused by the player. only they can
unpause it.'` while paused (orchestrator.js:1623; also 1850, 2356). Game-name
leak in the brain.

---

## 4. Prompts

All wording lives in `src/bot/brain/promptLibrary.js` (985 lines);
`src/bot/brain/prompts.js` and `src/bot/adapter/minecraft/prompts.js` are
re-export barrels (the latter adds the death addendum, 42-83).

**Brain-level but Minecraft-flavored (would need per-game variants):**
- `MINECRAFT_BASELINE` (130-145): "You play Minecraft through tool calls in
  turn-based loops... External: the world-action tools (move, follow, dig,
  gather, find, explore, place, equip, craft, build...)".
- `BASELINE_INSTRUCTIONS = \`${UNIVERSAL_BASELINE}\n\n${MINECRAFT_BASELINE}\`` (708),
  imported directly by orchestrator.js:19 and placed at system block [0] (1365).
- `PROACTIVENESS_DIRECTIVES` (485-489) mention setGoal/heartbeat (generic) but
  their prose is gameplay-progression flavored; `CURIOSITY_CLAUSE` (478) is generic.
- `IDLE_TICK_TEXT` (383): "gather wood, food, or cobble", "mine iron",
  explore() stuck nudges (`IDLE_STUCK_NUDGE_*`, 381-382).
- `EVENT_GUIDANCE` (385-407): `sei:loop_end`, `sei:idle`, `sei:attacked` ->
  `ATTACKED_ADDENDUM` (319-333), `REFLEX_ADDENDUM` (337-350),
  `SURVIVAL_ADDENDUM` (352-364), `DEFEND_ADDENDUM` (366-379) — all Minecraft
  combat prose. `eventAddendum()` (964-984) dispatches on `attackerKind`.
- `SESSION_END_CLAUSE` (593): "their LAN world goes down when they leave".
- `renderHeartbeat`/`renderFrontierBlock` (868-892, ~840): frontier text comes
  from `adapter.getProgression()` (optional) — with no progression the block is empty.
- `NUDGES.actionTurn` (611+), `SEED_HEADERS` (577): mostly generic.
- Chat-surface: `CHAT_BASELINE` (48-71) says "launch('minecraft')" and
  "minecraft: Vanilla Minecraft. open-world survival game..." (53-56).

**Adapter-level via the contract (already pluggable):** `WORLD_PRIMER` (147),
`CAPABILITY_PARAGRAPH` (154) + `SEEING_SENTENCE_*` (168-169), `ACTION_RULES`
(172) + `SEEING_RULE_*`/`PATHFINDER_RULE_*` (194-200), `CUBOID_GRAMMAR` (202),
`ACTION_DESCRIPTIONS` (230), `EXPLORE_DESCRIPTION_NOVISION` (297), `cantReachNudge`
(409). The assembly functions `worldPrimer/capabilityParagraph/actionRules/
cuboidGrammar/describeAction` (935-962) are what `adapter/minecraft/index.js`
exposes.

**How game context reaches each turn:** `snapshotText()`
(orchestrator.js:1617-1645) calls `snapshotComposer.next({ lastActionResult,
inFlight, pinUsername, companions, worldTag })`. The Minecraft composer
(`adapter/minecraft/observers/snapshot.js:436-472`) renders vitals, position,
facing, inventory, blocks, entities, craftables, follow state, aggro, `next:`
milestone, and `#N` targeting handles. A new adapter just returns its own text;
the brain treats it as opaque. `inFlight` comes from `src/bot/brain/inflight.js`
(its rendered line includes `y=<currentY>`, a mild coordinate assumption).

---

## 5. Main process

### 5.1 `src/main/botSupervisor.ts` (1810 lines)

- Constants: `SUMMON_TIMEOUT_MS = 30_000`, `STOP_TIMEOUT_MS = 10_000` (44-45);
  `summonDeadlineFrom(startedAtMs)` (86) ships the absolute deadline to the bot.
- `botEntryPath()` (192-208): `app.asar.unpacked/src/bot/index.js` packaged,
  `../../src/bot/index.js` in dev — one entry for all games.
- `BotSupervisorOptions` (210-290): `getLanPort`, `getLanMotd?`, `sendStatus`,
  `sendVisionCapability?`, `onBotChat?`, `onBotAction?`, `onDashboard?`,
  `sendLog`, `getSkinServerBaseUrl`, `cloudOverLimit`, `emitHardStop`,
  `isVoiceCallActive`, `onCallEndRequested`, `onSummonFailure`.
- `BotSupervisor` interface (320-400): `summon(id)`, `stop(id?)`, `getActiveId`,
  `getActiveIds`, `isActive`, `sendSeiChat`, `observeSeiChat`, `shutdown`,
  `updateJwt`, `switchBackend`, `setVoiceCall`, `greetVoiceCall`,
  `setDashboardWatch`, `setGamePaused`, `setGameMode`.
- `ActiveSession` (401-447): `{characterId, username, backendKind, startedAtMs,
  child, port1, router, exited, teardownJwtRotation?, stopRequested?}`;
  `sessions = new Map<string, ActiveSession>()` (449) + `pendingSummons`/
  `pendingUsernames` reservations (459-464).
- **Summon body** (`_summon`, ~686-1215):
  1. `effectiveMcUsername(character)` collision check against live + pending
     sessions -> `SUMMON_USERNAME_CONFLICT` (699-713).
  2. backend branch: cloud -> `cloudMode` + credit pre-gate `opts.cloudOverLimit()`
     -> `emitHardStop({reason:'depleted'})` + `CLOUD_CREDITS_DEPLETED` (738-757);
     local -> API key / provider guard.
  3. `PREFERRED_NAME_MISSING` guard (~845).
  4. `lanPort = opts.getLanPort()`; null -> `LAN_NOT_OPEN` status + throw (848-857).
  5. `sendStatus({kind:'connecting'})` (860), `createLogRouter({characterId,
     sendBatch})` (863), continuity + knowledge disk reads (874-880).
  6. `utilityProcess.fork(botEntryPath(), [], { stdio:'pipe', serviceName:
     \`sei-bot-${id}\`, env: { SEI_USER_DATA, SEI_CHARACTER_ID, SEI_BACKEND,
     SEI_HAS_API_KEY } })` (888-900).
  7. 30s watchdog (966-982); port message handler (990-1115) routes
     `vision-capability`, `request-jwt`, `chat` -> `onBotChat`, `call-end`,
     `action` -> `onBotAction`, `dashboard` -> `onDashboard`, `summon-ready`
     (re-sends `voice-call` if a call is live, 1037), `error` (pre-ready ->
     failure; `CLOUD_CREDITS_DEPLETED`/`DAILY_LIMIT_REACHED` -> `_stop`).
  8. On child `spawn`: `child.postMessage({type:'init', character, apiKey,
     lanPort, lanMotd, summonDeadlineAt, userDataDir, mc_username,
     preferred_name, visionMode, realisticTyping, chatLanguage, companions,
     skinServerBaseUrl, initialJwt, cloudMode, llm, continuity, knowledge,
     voiceCallActive}, [port2])` (1162-1215).
- Outbound port messages: `stop` (527), `roster` (592), `backend-switch`
  (1613), `sei-chat`, `sei-chat-observe` (1721), `voice-call` (1733),
  `voice-call-greet` (1745), `game-pause` (1757), `game-mode` (1769),
  `dashboard-watch` (1781), `jwt` (1803).
- Stop: `_stop(id, STOP_TIMEOUT_MS)` posts `stop`, waits, escalates to
  `child.kill()`; `_stopAll` on `shutdown` (1788).

### 5.2 `src/main/index.ts` — wiring + play row + analytics

- `watchLan({ onUpdate: broadcastLan, staleMs: 3000 })` (701-704);
  `getLanPort()`/`getLanMotd()` read `latestLanState` (398-404).
- `createBotSupervisor({...})` (707-770): `onDashboard: publishMcDashboardSnapshot`,
  `onBotChat` -> `appendChatMessage` (marks `voice:true` during a call),
  `onBotAction: broadcastAction`, `cloudOverLimit`, `onSummonFailure` (analytics
  `summon_failed` + `notePreGateFailure` from `summonGuard.ts`).
- `broadcastStatus` (~300-350): `clearMcDashboard(id)` on idle (320); on first
  `online` -> `capture('character_summoned')` (335); on terminal idle/error ->
  `emitPlaySession(id, durationMs)` + `capture('bot_session_ended',
  {character_id, duration_ms})` (340-342).
- `emitPlaySession` (215-234) writes the play row:
  `playSummaryText(name, 'Minecraft', durationMs, lang)` with
  `event: { kind: 'play', game: 'minecraft', durationMs }`. **No `foldIfDue`
  here** — unlike chess/draw/backseat, the Minecraft play row relies on the
  chat surface's next fold.

### 5.3 `src/main/ipc.ts` handlers

- `bot:summon` (676-684): `clearSummonBlock(id)` then `supervisor.summon(id)`.
- `bot:stop` (685-689), `bot:get-statuses` (692), `lan:get` (698), `lan:check-now` (705).
- `chat:send` (1268-1296) passes `summon`, `isInGame`, `routeToBot`, `leaveGame`,
  `getLanState`, `blockedAutoLaunch` into `sendChatMessage` — this is how the
  chat-surface `launch` tool (`src/main/chat/chatPrompts.ts:419` `LAUNCH_TOOL`,
  honored at `chatService.ts:915`) summons a bot.
- `mcdash:get/set-watching/set-paused/set-mode` (1584-1608) -> `mcDashboardService`
  + `supervisor.setDashboardWatch/setGamePaused/setGameMode`.
- Voice idle/companion turns (1780-1856) also honor `onLaunch` -> `supervisor.summon`.

### 5.4 `src/shared/ipc.ts` contracts

- `BotStatus` (92-126): `idle | connecting | online{uptimeMs,startedAtMs} |
  error{error: ErrorClass, message, transient?, midSession?}`, all keyed by `characterId`.
- `BotLifecycle` (670-684), `BotActionPush` (687-694).
- `LanState` (188-220): `open{port, motd, lastSeenAt, host?, versionName?,
  protocol?} | closed | unavailable`; `LanHost` (230-254) with
  `client: LanHostClient`, `forgeModCount`, `seiSkinMod`, `otherModCount`;
  `lanHostWarning()` (276) -> `'vanilla'|'modded'|'lunar'|null`.
- Channels (2617-2661, 2845-2854): `bot.{summon,stop,status,getStatuses,logBatch,action}`,
  `lan.{state,get,checkNow}`, `mcdash.{get,setWatching,snapshot,setPaused,setMode}`,
  `vision.capability`. `RendererApi`: `summon/stop` (preload 39-40),
  `onStatus/getBotStatuses/onBotAction` (430-436), `onLan/getLanState/lanCheckNow`
  (460-466), `mcDashboardGet/SetWatching` (222-223), wizard (346-351).
- `src/shared/mcDashboardIpc.ts`: `McDashboardSnapshot {characterId, ts,
  dimension, pos, yaw, health, food, held, items: McDashItem[], activity,
  actionName, map: McDashMap|null}` (45-67), `MC_DASH_MAP_SIZE = 33`, palette.
  Produced by `src/bot/adapter/minecraft/dashboard/telemetry.js`
  (`createDashboardTelemetry({bot, emit})` -> `{setWatching, setAction, stop}`,
  44-140) using `activityLabel.js`; validated in main by
  `src/main/mcDashboard/mcDashboardService.ts` (`RawSnapshotSchema`, 34;
  `publishMcDashboardSnapshot`, 59; `clearMcDashboard`, 73).

### 5.5 Errors

`src/shared/errorClasses.ts` (13-40): Minecraft-specific classes are
`LAN_NOT_OPEN`, `LAN_UNAVAILABLE`, `UNSUPPORTED_MC_VERSION`,
`MODDED_HOST_REJECTED`, `MOD_DOWNLOAD_FAILED`, `FABRIC_INSTALL_FAILED`,
`MC_INSTALL_NOT_FOUND`, `MOJANG_LOOKUP_FAILED`, `SKIN_*`, `WIZARD_PERMISSION_DENIED`.
User copy in `src/renderer/src/lib/errors.ts` `ERROR_COPY` (30-64), e.g.
`LAN_NOT_OPEN: "We can't see an open LAN world. In Minecraft, press Esc, choose Open to LAN..."`.

### 5.6 LAN discovery + host classification (all Minecraft)

- `src/main/lanWatcher.ts`: polls `listeningPorts()` (lsof/netstat) and
  `mcPing(port, '127.0.0.1')` each port; emits `open/closed/unavailable`;
  `checkNow()` for a fresh read (77-87). Multicast was dropped (macOS 26).
- `src/main/hostClient.ts` (`classifyCmdline`, 41) + `hostSetup.ts`
  (`inspectHostMods`, 106) classify the host java process (vanilla/fabric/forge/lunar).
- `src/main/mcPing.ts`, `listeningPorts.ts`, `mcInstallScan.ts`, `skinServer.ts`,
  `customSkinLoader.ts`, `summonGuard.ts` (auto-retry block, 27-74).
- `src/bot/adapter/minecraft/lanDiscovery.js` (`discoverLanPort`, 167) is a
  dead-ish bot-side mirror; the bot never calls it during summon.

---

## 6. Renderer

- **Cross-launch gate** `src/renderer/src/lib/gameLaunch.ts`:
  `LaunchGameId = 'chess' | 'minecraft' | 'draw' | 'backseat'` (39);
  `activeGameFor` (53-73) reads `useDataStore.summons[id].kind` for Minecraft;
  `endActiveGame` (79-100) Minecraft branch = `setStatus(idle)` +
  `useMcDashboardStore.setLaunch(false)` + `sei.stop(id)`; `openGame` (133-175)
  navigates to chat and sets `dash.setLaunch(id, true)` + `maybeOfferSkinSetup()`
  for Minecraft; `requestGameLaunch` opens the `cross-launch` modal.
- **Summon flow** `src/renderer/src/lib/summonFlow.ts`: `attemptSummon(id)`
  (164) -> `blockedByUsernameConflict` (99-118, modal `summon-conflict`) ->
  `proceedSummon` (125-158): `sei.lanCheckNow()`, if open `summonWithHostGate`
  (68-89, modal `lan-host-warning`) -> `launchSummon` (43-53: `mcDash.reset(id)`,
  `sei.summon(id)`, navigate); else `setPendingSummon(id)` + modal
  `{kind:'mc-setup', tab:'world', searching:true}` which auto-resumes on LAN open.
- **Game picker**: `src/shared/games.ts` `GAME_CATALOG` (37-48) already lists
  `stardew` and `dontstarve` with `available:false`; `renderGamesDirective()`
  (57-76) turns it into the chat/voice `# GAMES` prompt block.
  `src/renderer/src/lib/games.ts` `TILES` (37-92) adds art + descriptions
  (stardew/dontstarve copy present, 69-84). `GamesPickerModal.tsx` (137) calls
  `requestGameLaunch(characterId, {id, name}, () => openGame(characterId, id))`.
- **Chat game area**: `ChatScreen.tsx` 436-455 derives `mcOnline`, `mcLaunchOpen`,
  `gameOpen`; 623-650 mounts `<GameSurface>` with `ChessReplayPanel | ChessPanel
  | McDashboardPanel | McLaunchPanel`. `GameSurface.tsx` is the shared chrome.
- **Dashboard**: `components/mcdash/McLaunchPanel.tsx` (Launch button ->
  `attemptSummon`), `McDashboardPanel.tsx` (inventory/minimap/vitals/controls),
  `useMcDashLifecycle.ts` (`hydrate` + `setWatching`), `McDashMinimap/Avatar/
  Vitals`, `mcAssetSource.ts`. Store `lib/stores/useMcDashboardStore.ts`:
  `snapshots`, `launch`, `controls {paused, mode}`, `setLaunch/hydrate/
  setWatching/setPaused/setMode/reset` (36-64).
- **Status routing**: `useDataStore.ts` `summons: Record<string, BotStatus>` (32);
  the single `sei.onStatus` subscription (178-247) opens `unsupported-version`,
  `lan-not-open`, `modded-host`, `bot-crash` modals by error class.
- **CharacterPage.tsx** is static; its play tile calls
  `requestGameLaunch(id, {id:'minecraft', name:'Minecraft'}, () => openGame(id,'minecraft'))` (369-370).
- **IconRail.tsx** `avatarActivityBadge(...)` (173-196) counts `summons[id].kind
  === 'online'|'connecting'` as `'game'`. `callLaunch.ts:39` and `CallMiniBar.tsx:69`
  treat an online summon as an open game surface. `overlayParticipants.ts:20`
  counts a summon as avatar activity.
- **ChatTopBar.tsx**: controller button opens `games-picker`; Backseat button.
- **Modals** (`useUiStore.ts` union 90-135): `mc-setup{tab:'world'|'skin',
  searching}`, `summon-conflict`, `lan-host-warning`, `unsupported-version`,
  `lan-not-open`, `modded-host`, `bot-crash`, `games-picker`, `cross-launch`;
  `pendingSummonId` / `pendingSummonReturnToChat` (159-167). Components:
  `McSetupModal.tsx` (imports `minecraft-protocol/src/version.js` for the
  supported range), `LanNotOpenModal`, `SummonConflictModal`,
  `UnsupportedVersionModal`, `ModdedHostModal`, `LanHostWarningModal`,
  `SetupWizardModal`, `McInstallList/Row`, `SkinEditor`, `UsernameSearchField`.
- **Settings**: `SettingsScreen.tsx` 1359-1390 "Minecraft" group = `SkinSetupRow`
  (wizard) + Looking/vision mode selector (`vision_mode`); `realistic_typing` at 692.
- **Presence verb**: `lib/actionVerb.ts` maps Minecraft tool names to
  "gathering wood..." (vocabulary mirrors the MC registry; unknown -> "adventuring").
- **i18n**: key-is-English-string with a zh dictionary
  (`lib/i18n/index.ts`, `zh/{chatui,common,games,misc,modals,onboard,screens-a,screens-b}.ts`).
  ~104 zh entries mention Minecraft/LAN/summon (e.g. `zh/games.ts:76-77`,
  `zh/chatui.ts:93,113,132,174,182`, `zh/misc.ts:13-43,105,198-223`,
  `zh/screens-a.ts:80,214-215`). Stardew/DST tile copy already translated
  (`zh/chatui.ts:182`).

---

## 7. Config / schema

- `src/bot/config.js`: `MinecraftAdapterSchema` (14-120: host, port, auth,
  username, version, reconnect_delay_ms 5000, pathfinder_timeout_ms 12000,
  follow_range 3, combat/survival knobs); `AdapterSchema = { kind:
  z.literal('minecraft').default('minecraft'), minecraft: MinecraftAdapterSchema }`
  (122-123); `ConfigSchema` (139-350) top-level `chat_mode`, `player_username`,
  `player_display_name`, `lan_motd` (165), `persona`, `anthropic`, `llm`,
  `memory{...paths, iteration_cap 300 here, seed budgets}`, `vision`, `adapter`.
  Legacy hoist `{ adapter: { kind: 'minecraft', minecraft: mc } }` (352-386).
- `src/shared/characterSchema.ts`: `Character.username` (149, MC regex, max 16),
  `Character.skin` (148), `effectiveMcUsername()` (273-278), `character.metadata.chess`.
  `UserConfig`: `mc_username` (363), `preferred_name` (364), `chat_language`
  (483), `hide_vanilla_host_warning`/`hide_modded_host_warning` (514-515),
  `realistic_typing` (575), `skin_setup_pending` (731), `vision_mode` (833),
  `avatar_mode` (603), `call_backdrop` (715).

---

## 8. Analytics + continuity for the Minecraft summon

- `character_summoned` (main/index.ts:335), `bot_session_ended {character_id,
  duration_ms}` (342), `summon_failed` via `onSummonFailure` (supervisor ->
  main/index.ts ~760). No `bot_session_started` event exists.
- Play row: `emitPlaySession` -> `playSummaryText(name, 'Minecraft', ms)` +
  `event:{kind:'play', game:'minecraft', durationMs}` (main/index.ts:215-234).
  `src/main/chat/playSummary.ts` is shared (`playSummaryText`, 46-58).
- Continuity IN: `buildLaunchContinuity(id)` + `readKnowledgeForPrompt(id)`
  in the supervisor (874-880) -> `continuity`/`knowledge` in init ->
  `config._seiContinuity/_seiKnowledge` -> orchestrator seed/prefix.
- Continuity OUT: `remember()`/`forget()` write the same per-character
  `MEMORY.md` (`memory.memory_md_path`, index.js:769-774). `foldIfDue` is NOT
  fired at Minecraft session end (chess/draw/backseat do).

---

## 9. Memory world segmentation

`src/bot/brain/memory/worlds.js` `createWorldRegistry({ worldsPath, memoryLog })`
-> `{ resolveOnSpawn({fingerprint, label}), current() }` (33-98). Registry file
shape `{version:1, worlds:[{num, fingerprint, label, firstSeen, lastSeen}]}`.
The FINGERPRINT IS COMPUTED IN THE BRAIN, not the adapter
(`orchestrator.js:1599-1615`):

```js
let info = adapter.getWorldInfo?.()          // {spawnPoint:{x,y,z}, dimension}
const fingerprint = `${dim}@${sp.x},${sp.y},${sp.z}`
const label = (config.lan_motd) || `spawn ${sp.x},${sp.z}`
await worldRegistry.resolveOnSpawn({ fingerprint, label })
```
It is triggered from `onSpawn` (brain/index.js:323). `snapshotText` reads
`worldRegistry.current()` into `worldTag` (`#N label`). `memoryLog.noteWorld`
writes the `## World N — label` header; `readMemoryForSeed` and the compactor
preserve those headers. A Stardew adapter would supply a farm-name/save-id
based identity; DST a cluster/session id. The brain should call a generic
`adapter.getWorldIdentity() -> {fingerprint, label}` instead of assembling one
from spawn coords.

---

## 10. Existing abstraction hints

- `src/bot/brain/types.js:8`: "A future adapter (Stardew, Roblox, ...) implements this same shape."
- `src/bot/config.js:5`: "game-specific fields nest under `adapter.<kind>.*`" — but `kind` is a literal.
- `src/shared/games.ts:45-46`: `stardew`, `dontstarve` catalog rows (coming soon) + renderer tile art/copy already in place (`lib/games.ts:69-84`, `public/img/game-stardew.jpg`, `game-dontstarve.jpg`).
- `src/main/chat/chatPrompts.ts:59` `surface?: 'chat' | 'game'` and `promptLibrary.js:73` `GAME_SURFACE_BASELINE` — a per-surface baseline pattern to copy for per-game bot baselines.
- `BotSupervisorOptions.onDashboard` forwards the payload RAW; only `mcDashboardService` knows the shape, so per-game dashboards can plug in behind the same port message.
- `GameSurface.tsx` is already the shared chrome for any game panel in the chat aside.
- `LaunchGameId`/`activeGameFor` in `gameLaunch.ts` is the one place the renderer enumerates games.

---

## What must be generalized

Concrete refactors, roughly in dependency order.

**Bot process**
1. **Adapter selection in the init payload + config.** Add `game: 'minecraft'
   | 'stardew' | 'dontstarve'` to the init message (supervisor
   `botSupervisor.ts:1162`) and change `src/bot/config.js:122` to
   `kind: z.enum([...])` with a per-kind sub-schema (`adapter.stardew.*`,
   `adapter.dontstarve.*`). `bootstrapWithInit` (index.js:757-768) builds the
   `adapter` block from a per-game factory instead of the literal.
2. **Split `start()` in `src/bot/index.js` into a game-agnostic composer + a
   per-game "runtime".** Everything from `createBotInstance` through
   `createMinecraftAdapter`, the reconnect policy, the version ping, and
   `_bot._sei_startChat` belongs in `src/bot/adapter/minecraft/runtime.js`
   exposing something like `createRuntime(config, hooks) -> { adapter,
   telemetry?, stop(), setCompanions? }`. The composer keeps: config parse,
   `startBrain`, the returned handle, port dispatch, lifecycle emission.
   Dynamic-import the runtime by `config.adapter.kind` so mineflayer never
   loads for a Stardew session (and vice versa).
3. **Make the dashboard telemetry an adapter member** (e.g.
   `adapter.createTelemetry?({emit})` returning `{setWatching, setAction, stop}`)
   instead of `createDashboardTelemetry` imported in index.js:31/335. Keep the
   `{type:'dashboard', snapshot}` port message; tag the snapshot with `game`.
4. **Move Minecraft names out of the brain.** In `orchestrator.js`:
   `PERSONALITY_NAMES` includes `follow/unfollow` (326) and
   `stopToolForAction` (1733) — replace with an adapter-declared
   `backgroundActions: { follow: 'unfollow' }` map; `_buildExecOpts`
   progress-flavored set (1818-1820) -> `adapter.progressActions`; dig cap
   (3902), attackEntity/follow coupling (3914-3920), `goTo` cant_reach
   (4096) -> an optional `adapter.postProcessToolBatch(toolUses, results)` or
   per-action metadata; `look` filter (1345) -> `adapter.visionActions`.
   `MC_CHAT_MAX_CHARS` (63) -> `adapter.chatMaxChars`. The paused literal
   'your minecraft was paused' (1623/1850/2356) and `quit_game` description
   (1272) -> `adapter.gameName` interpolation.
5. **Per-game baseline + event prose.** `BASELINE_INSTRUCTIONS` (promptLibrary
   708, orchestrator 19/1365) hardcodes `MINECRAFT_BASELINE`; add
   `adapter.surfaceBaseline()` and compose `UNIVERSAL_BASELINE + that`.
   `EVENT_GUIDANCE` for `sei:attacked` variants, `IDLE_TICK_TEXT`,
   `IDLE_STUCK_NUDGE_*`, `SESSION_END_CLAUSE` ("LAN world goes down"), and the
   frontier prose in `renderFrontierBlock` all need per-game text, ideally by
   routing every event through `adapter.eventAddendum` (already the contract)
   and moving the brain-level defaults to `promptLibrary` game sections.
6. **World identity.** Replace the spawn-coordinate fingerprint assembly in
   `orchestrator.noteSpawn` (1599-1615) with `adapter.getWorldIdentity() ->
   {fingerprint, label} | null`; keep `worlds.js` unchanged. Drop the
   `config.lan_motd` dependency (index.js:723) in favor of a generic
   `world_label`.
7. **Document `onDeath` and the extra `attackerKind` values in `types.js`** and
   bump `ADAPTER_INTERFACE_VERSION` to 2 when the members above land.
8. **Error classes.** Add game-neutral classes (`GAME_NOT_REACHABLE`,
   `GAME_VERSION_UNSUPPORTED`, `GAME_REJECTED_JOIN`) or per-game ones; the
   error-prefix routing in index.js:900-906 becomes an adapter-supplied
   `classifyConnectError(message)`.

**Main process**
9. **Supervisor: game-aware summon.** `summon(characterId, game)`; the
   username-collision guard (699-713) is Minecraft-only (DST/Stardew have their
   own naming rules) -> `gameModule.effectiveUsername(character)` +
   `gameModule.collides(a,b)`. Replace `getLanPort/getLanMotd` with a
   per-game `getJoinTarget(): JoinTarget | null` (Minecraft: `{port, motd}`;
   Stardew: invite code / LAN host + cabin; DST: cluster token / server id).
   The `LAN_NOT_OPEN` branch at 848-857 becomes `gameModule.joinTargetMissingError`.
   Sessions map stays keyed by characterId (one bot per character regardless
   of game) but `ActiveSession` gains `game`.
10. **Discovery as a plug-in.** `lanWatcher.ts` is the Minecraft watcher; add
    `src/main/games/<game>/watcher.ts` with the same `{ onUpdate, checkNow,
    stop }` shape and a game-neutral `WorldState` union pushed on
    `world:state` (keep `lan:state` as an alias for one release). Host
    classification (`hostClient/hostSetup`) stays Minecraft-only behind the
    Minecraft watcher.
11. **Dashboard service per game.** `onDashboard(characterId, snapshot)` ->
    dispatch on `snapshot.game`; `mcdash:*` channels stay, add `stardash:*`/`dstdash:*`
    or a generic `gamedash:*` with a discriminated snapshot union in
    `src/shared/gameDashboardIpc.ts`. `clearMcDashboard` on idle (main/index.ts:320)
    becomes `clearGameDashboard`.
12. **Play row + analytics.** `emitPlaySession` (main/index.ts:215) hardcodes
    `'Minecraft'`/`game:'minecraft'`; take the game from the session. Emit
    `bot_session_ended` with a `game` property (dashboard `SESSION_EVENTS`
    sums by event name, so one name + a `game` prop is the least churn), and
    add `void foldIfDue(...)` at session end to match the other surfaces.
13. **Chat-surface launch tool.** `LAUNCH_TOOL` (chatPrompts.ts:419-425) and
    `CHAT_BASELINE` (promptLibrary 53-56) say Minecraft is the only
    self-launchable game; `GAME_CATALOG.selfLaunch` already models this, so
    give `launch` a `game` arg validated against catalog rows with
    `selfLaunch && available`, and have `chatService.ts:915` call
    `deps.summon(id, game)`. The "World status" lines (322-341) need the
    per-game join-target state.
14. **Preload/IPC.** `bot:summon` payload becomes `{characterId, game}`;
    `BotStatus` gains `game`. Keep channel names.

**Renderer**
15. **`LaunchGameId` + `activeGameFor`** (`gameLaunch.ts:39,53-73`): add ids;
    `summons[id].game` decides which surface counts as active. `endActiveGame`
    Minecraft branch generalizes to "any bot-backed game".
16. **Per-game launch panel + dashboard.** `ChatScreen.tsx:436-455, 640-649`
    selects `McDashboardPanel | McLaunchPanel` by summon state; make it
    `GAME_SURFACES[game].{LaunchPanel, DashboardPanel}` and rename
    `useMcDashboardStore.launch` -> `launch[characterId] = gameId`.
17. **Summon flow.** `summonFlow.ts` is a Minecraft pipeline (username
    conflict, `lanCheckNow`, host warning, `mc-setup` modal). Turn it into
    `summonFlows[game]` sharing `launchSummon`; the pending-summon auto-resume
    keys on the game's world state.
18. **Modals + copy.** `mc-setup`, `lan-not-open`, `unsupported-version`,
    `modded-host`, `lan-host-warning`, `summon-conflict` are Minecraft; add
    per-game setup modals and generalize `useDataStore.ts:196-247` error ->
    modal routing to look up by `(game, errorClass)`. `ERROR_COPY` needs
    per-game strings; `actionVerb.ts` needs per-game verb tables (or read the
    verb from the bot's `activity` line, which the dashboard already ships).
19. **Settings.** The "Minecraft" group (SettingsScreen 1359) becomes a
    per-game group; `vision_mode` is Minecraft-only today (the POV renderer),
    so gate it by game capability.
20. **Games catalog.** Flip `available:true` on `stardew`/`dontstarve` in
    `src/shared/games.ts` last; that alone lights the tiles and the prompt.

---

## Reusable as-is (no change needed for a second adapter)

- `src/bot/registry.js` — closed Zod registry, game-agnostic.
- `src/bot/brain/fsm.js` — priority queue, preemption, idle timer, `setHold`.
- `src/bot/brain/index.js` — adapter assertion, handler -> queue translation,
  pause/mode/backend/voice passthroughs (only needs the `types.js` doc update).
- `src/bot/brain/orchestrator.js` core loop: cached-prefix assembly from
  adapter blocks, `combinedToolsFor`, `emitSayCalls`/`postProcessSay`,
  say-dedupe, iteration cap, long-runner/`inflight`, `remember/forget/setGoal`,
  continuity + knowledge injection, voice-call routing, backend switch, JWT
  refresh — all consume the adapter through the contract (modulo the leaks in
  item 4 above).
- `src/bot/brain/memory/*` (`MEMORY.md`, `PLAYER.md`, `HEARTBEAT.md`,
  compaction, `worlds.js` registry, seed truncation).
- `src/bot/brain/llm/*` provider factory, `anthropicClient.js`, rate limiter,
  `llmInit.js`.
- `src/bot/brain/promptLibrary.js` game-agnostic halves: `UNIVERSAL_BASELINE`,
  `PERSONALITY_TOOL_DESCRIPTIONS`, `renderPersona/Core/Companions/
  Punctuation/Language`, `voiceGroupGuidance`, `NUDGES`, `MEMORY_GOAL_CUE`,
  `COMPACTION_SYSTEM`.
- Supervisor plumbing: fork + `MessageChannelMain`, 30s/10s timeouts, log
  router, JWT rotation, backend switch, roster broadcast, credit pre-gate,
  `sei-chat`/`sei-chat-observe`/`voice-call`/`game-pause`/`game-mode` port
  messages, `summonGuard.ts`.
- `src/main/chat/*` continuity (`buildLaunchContinuity`, `readKnowledgeForPrompt`,
  `playSummaryText`, `foldIfDue`).
- Renderer: `GameSurface.tsx` chrome, `GamesPickerModal.tsx`, `requestGameLaunch`
  cross-launch confirm, `IconRail` badge logic (keyed on `summons`), call
  integration (`callLaunch.ts`, `CallMiniBar`), avatar overlay activity,
  `useMcDashboardStore.controls` pause/mode plumbing (rename only), i18n
  mechanism (add keys, no structural change).
- `src/shared/games.ts` catalog + `renderGamesDirective()`.
