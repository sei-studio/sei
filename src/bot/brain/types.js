// src/brain/types.js
//
// Adapter interface contract — the seam between game-agnostic brain and
// game-specific adapter implementations (e.g. the minecraft adapter under
// src/adapter/).
//
// The brain depends on this interface and nothing else game-shaped. A
// future adapter (Stardew, Roblox, ...) implements this same shape.
//
// This file is the source of truth for D-5 (brain/adapter split). The
// minecraft adapter's index.js satisfies this interface; the brain
// orchestrator stops importing observers/* and behaviors/* directly and
// instead consumes an injected `adapter` that conforms to this contract.
//
// Contract v2 (game-adapters M0, 260908): every Minecraft name that had
// leaked into the brain (the surface baseline, the 256-char chat cap, the
// follow/unfollow background pair, the build/gather/dig progress set, the
// `look` vision filter, the dig cap + attack/follow + cant_reach batch rules,
// the paused notice, the quit_game wording, the session-end clause, the stuck
// nudges, the spawn-coordinate world fingerprint, the dashboard telemetry, the
// connect-error classifier) is now an OPTIONAL adapter member. Each one has a
// Minecraft-valued default in ./adapterDefaults.js, so a v1 adapter (or a test
// fake) keeps the exact pre-v2 behavior and the Minecraft adapter changes only
// by declaring them. A new game's adapter declares every member it needs to
// differ on and nothing else.
//
// No runtime types — JSDoc only.

/**
 * @typedef {Object} Player
 * @property {string} username
 * @property {string} uuid
 */

/**
 * @typedef {Object} SnapshotComposer
 * @property {(opts: { lastActionResult: string|null, inFlight: any }) => string} next
 *   Returns the world-summary string for the next seed turn.
 * @property {() => void} reset
 */

/**
 * Attacker kinds carried by `onAttacked` (and consumed by `eventAddendum`
 * for the 'sei:attacked' event):
 *   - 'player' | 'mob' | 'unknown' — the bot WAS hit. Queued at P0_SAFETY.
 *   - 'reflex'  — a proactive threat warning: the bot was NOT hit, the
 *                 adapter's body loops are already evading (Minecraft:
 *                 behaviors/reflex.js + survival.js; `data.noticed`,
 *                 `data.count`, `data.survivalKind` ride along). Queued at
 *                 P1_CHAT so it never preempts a player-chat reply.
 *   - 'defend'  — the OWNER is being hit near the bot (Minecraft:
 *                 sei:owner_attacked; `data.engaged` says whether the body is
 *                 already swinging). Queued at P1_CHAT.
 * The brain keys the priority on this field (fsm.js attackedPriority) and
 * remembers the last non-reflex hit so a death that follows can name its cause.
 * @typedef {'player'|'mob'|'unknown'|'reflex'|'defend'} AttackerKind
 */

/**
 * @typedef {Object} AdapterHandlers
 * @property {(player: Player) => void}                                              onPlayerJoined
 * @property {(player: Player) => void}                                              onPlayerLeft
 * @property {(evt: { username: string, text: string, playerSpoke: boolean,
 *                    addressed: boolean, nearby: boolean,
 *                    suppressInterrupt?: boolean }) => void}                        onChat
 *   `suppressInterrupt: true` records the line in chat history WITHOUT waking
 *   the brain (a line aimed at a sibling companion, or a sibling's own chatter).
 * @property {(evt: { attacker: Player|null, attackerLabel: string,
 *                    attackerKind: AttackerKind, pvp?: boolean,
 *                    [k: string]: any }) => void}                                  onAttacked
 * @property {(evt: { pos: {x:number,y:number,z:number}|null }) => void}             onDeath
 *   The bot died and respawned. Enqueued at P1_CHAT as 'sei:death' with the
 *   last real hit attached (`lastAttack`) when one landed within 30s; the
 *   adapter's eventAddendum('sei:death', data) supplies the framing. Optional
 *   for adapters whose game has no death.
 * @property {() => void}                                                            onSpawn
 *   The body is in the world. Fires the world-identity resolve
 *   (getWorldIdentity), the settle-delayed first idle tick (greeting), and
 *   the session-state presence check. Must fire again after a reconnect.
 */

/**
 * @typedef {Object} ExecuteActionContext
 * @property {AbortSignal} signal
 */

/**
 * A synthesized tool result the adapter wants pre-filled for a tool_use in
 * the batch BEFORE dispatch (the tool never executes).
 * @typedef {Object} PrefilledToolResult
 * @property {string} id       The tool_use id.
 * @property {string} content  The result text the model reads.
 * @property {boolean} [is_error]
 */

/**
 * Per-loop scratch state handed to postProcessToolBatch. The brain creates a
 * fresh empty object per loop; the adapter may store whatever it needs on it
 * (the Minecraft adapter keeps its cant_reach dedup counters there).
 * @typedef {Object<string, any>} ToolBatchLoopState
 */

/**
 * @typedef {Object} WorldIdentity
 * @property {string} fingerprint  Stable across sessions for the SAME world
 *   (Minecraft: `${dimension}@${spawnX},${spawnY},${spawnZ}`; Stardew: a
 *   farm/save id; DST: a cluster id). Drives the per-character world number
 *   in memory/worlds.js.
 * @property {string} label        Human label for MEMORY.md section headers
 *   (config.world_label when main shipped one, else an adapter-chosen one).
 */

/**
 * @typedef {Object} Telemetry
 * @property {(active: boolean) => void} setWatching
 *   The renderer's dashboard is (not) on screen. Emit nothing while false.
 * @property {(name: string|null, args?: any) => void} setAction
 *   The orchestrator dispatched a world tool (name) or drained to idle (null).
 * @property {() => void} stop
 */

/**
 * @typedef {Object} Adapter
 *
 * Action surface — brain calls these by name+args (closed registry):
 * @property {() => string[]}                                              listActions
 * @property {(name: string) => any}                                       getActionSchema
 * @property {(name: string) => string}                                    getActionDescription
 * @property {(name: string, args: any, ctx: ExecuteActionContext) => Promise<string>} executeAction
 *   Always returns a string (success: 'dug oak_log'; failure: 'out of range (5.4m, need ≤4.5)').
 *
 * World perception — brain consumes plain text only:
 * @property {() => SnapshotComposer}                                      createSnapshotComposer
 *
 * Prompt blocks — natural-language instructions the brain joins into the
 * cached system prefix and seed user turn. All game-specific NL text comes
 * through these methods so the brain stays game-agnostic. Edit the strings
 * in src/bot/adapter/<game>/prompts.js.
 * @property {() => string}                                                worldPrimer
 *   World facts / biome / mob / tool primer.
 * @property {() => string}                                                capabilityParagraph
 *   "You can move / mine / place / ..." capability summary.
 * @property {() => string}                                                actionRules
 *   Movement / hunting / pathfinder / dig syntax rules.
 * @property {() => string}                                                [cuboidGrammar]
 *   Seed-block text teaching the two-corner build/dig grammar.
 * @property {(event: string, data: any) => string}                        eventAddendum
 *   Per-event seed addendum. THE ONLY SOURCE of game-flavored event prose:
 *   'sei:idle' (the idle tick text incl. stuck nudges — what the plan calls
 *   idleTickText()), 'sei:loop_end', 'sei:attacked' (every AttackerKind:
 *   hit / reflex / survival / defend), 'sei:death'. Returns '' for unknown
 *   events; the brain adds nothing of its own.
 * @property {(args: {x:number,y:number,z:number,range:number}) => string} [cantReachNudge]
 *   Mid-loop nudge when pathfinder cant_reach trips twice on the same dest.
 *   (Consumed by the Minecraft postProcessToolBatch, not by the brain.)
 *
 * Session lifecycle:
 * @property {(handlers: AdapterHandlers) => void}                         attach
 * @property {() => void}                                                  [detach]
 *   Tear down listeners on reconnect; idempotent. Optional — not in
 *   REQUIRED_ADAPTER_MEMBERS so adapters that don't need teardown don't fail
 *   boot. Boot composer guards with `_adapter?.detach?.()`.
 * @property {(paused: boolean) => void}                                   [setWorldPaused]
 *   Freeze/unfreeze the BODY's autonomous loops (the brain's queue hold only
 *   stops LLM-driven work). Re-arm on every spawn so a reconnect while paused
 *   comes back frozen.
 *
 * Effects the brain commands but cannot synthesize:
 * @property {(text: string) => void}                                      chat
 *   The post-processed say() text reaches the player via this method.
 * @property {() => Promise<void>}                                         closeAnySessions
 *   Container session lifecycle, etc. No-op default acceptable.
 *
 * Optional capabilities (brain checks before using):
 * @property {boolean}                                                     supportsAutoEat
 * @property {boolean}                                                     supportsFollow
 * @property {() => any}                                                   [getProgression]
 *   Milestone frontier view (heartbeat framing + JS-side completion). Absent
 *   = no frontier block.
 * @property {() => Promise<any>}                                          [renderIdleFrame]
 *   'continuous' Looking mode automatic view. Absent = no automatic views.
 *
 * Identity:
 * @property {string}                                                      botUsername
 * @property {() => Object<string, Player>}                                getKnownPlayers
 *
 * ── Contract v2 members (all OPTIONAL; defaults in ./adapterDefaults.js) ──
 *
 * @property {string}                                                      [gameName]
 *   Proper name of the game ('Minecraft'). Interpolated into every brain
 *   string that names the game: the quit_game tool description, the paused
 *   notice ("your <game> was paused by the player"), the FIRST CONTACT hint.
 *   Default 'Minecraft'.
 * @property {number}                                                      [chatMaxChars]
 *   Hard clip (UTF-16 units) applied to each in-world chat send. Default 256
 *   (Minecraft's chat packet limit).
 * @property {Object<string, string>}                                      [backgroundActions]
 *   Actions that only SET persistent background state (the body keeps acting
 *   after the loop ends) mapped to the action that stops them. A turn made
 *   only of these (plus personality tools) ENDS the loop, and the mid-action
 *   "stop" tool named in the prompt is the mapped value. Default
 *   `{ follow: 'unfollow' }`.
 * @property {string[] | ((name: string, args: any) => boolean)}           [progressActions]
 *   Which actions report progress through `execOpts.onProgress` (rendered in
 *   the in-flight line). Array of names, or a predicate for arg-dependent
 *   cases. Default: build, gather, and dig with a `to` corner.
 * @property {string[]}                                                    [visionActions]
 *   Tools withheld from the model unless the provider is a VLM and Looking is
 *   not 'off'. Default `['look']`.
 * @property {(toolUses: any[]) => PrefilledToolResult[]}                  [prefilterToolBatch]
 *   Runs BEFORE any tool in a batch dispatches; returned entries are
 *   pre-filled as results and those tools never execute. Minecraft: the
 *   one-dig-per-turn cap and the same-turn follow+attackEntity collapse.
 *   Default: nothing pre-filled.
 * @property {(toolUses: any[], results: any[], loopState: ToolBatchLoopState) => { nudge?: string|null }} [postProcessToolBatch]
 *   Runs AFTER the batch's results are collected (results[i] pairs with
 *   toolUses[i]). May return a one-shot `nudge` appended to the next user
 *   turn (it outranks the brain's silence nudge). Minecraft: the per-loop
 *   goTo cant_reach dedup → cantReachNudge. Default: no nudge.
 * @property {() => string}                                                [surfaceBaseline]
 *   The game-surface half of the cached system block [0]. The brain composes
 *   `${UNIVERSAL_BASELINE}\n\n${surfaceBaseline()}`. Default MINECRAFT_BASELINE.
 * @property {() => string}                                                [sessionEndClause]
 *   The "if they are ENDING THE SESSION call quit_game" sentence woven into
 *   every player-interrupt nudge. Names why the bot cannot stay (Minecraft:
 *   "their LAN world goes down when they leave"). Default SESSION_END_CLAUSE.
 * @property {() => { vision: string, noVision: string }}                  [stuckNudges]
 *   The "path is not working" instruction inside the mid-action check-in
 *   (with and without a look tool). Default: the Minecraft look/explore pair.
 * @property {() => WorldIdentity|null}                                    [getWorldIdentity]
 *   Called from onSpawn. null = not known yet (skip; next session catches
 *   it). Default: assembled from getWorldInfo() spawn point + dimension +
 *   config.world_label, exactly as the pre-v2 brain did.
 * @property {(opts: { emit: (snapshot: object) => void, logger?: object }) => Telemetry} [createTelemetry]
 *   Dashboard telemetry for this body instance (one per connect). `emit`
 *   posts the raw snapshot up the port as {type:'dashboard', snapshot};
 *   tag it with `game` so main can dispatch. Absent = no dashboard.
 * @property {(message: string) => string}                                 [classifyConnectError]
 *   Map a terminal connect/disconnect error message to the ErrorClass main
 *   should surface. Default: the Minecraft prefix table (UNSUPPORTED_MC_VERSION
 *   / MODDED_HOST_REJECTED / LAN_NOT_OPEN / else BOT_START_TIMEOUT).
 */

/**
 * The game runtime a per-game `adapter/<kind>/runtime.js` exports as
 * `createRuntime(config, hooks)`. Owns the BODY: connecting, reconnecting,
 * constructing the Adapter per connection, telemetry, and the brain
 * lifecycle per connection (through the composer's hooks). The composer
 * (src/bot/index.js) owns config, port dispatch, lifecycle emission and the
 * returned handle, and never imports a game module statically.
 *
 * @typedef {Object} RuntimeHooks
 * @property {{info: Function, warn: Function, error: Function}} logger
 * @property {number|null} summonDeadlineAt
 *   Epoch ms when main's summon watchdog fires; size any connect guard to
 *   report BEFORE it (null when an older main shipped none).
 * @property {(adapter: Adapter) => Promise<any>} createBrain
 *   Start the game-agnostic brain against a freshly constructed Adapter.
 *   Returns the brain handle. The runtime awaits it and MUST call
 *   `brain.stop()` itself if the body died during the await (the composer
 *   only tracks a brain once onBrainReady is called).
 * @property {(brain: any) => void} onBrainReady
 *   The brain is live against a connected body: the composer starts
 *   forwarding port messages (chat, voice, pause, mode, JWT, roster) to it.
 * @property {() => void} onBrainLost
 *   The body died; the runtime has already stopped (or is stopping) the
 *   brain. The composer drops its forwarder pointer.
 * @property {() => void} onConnected
 *   FIRST successful spawn of the session → the composer emits summon-ready.
 *   Reconnect spawns must NOT call it again.
 * @property {(info: { reason?: string, willRetry: boolean }) => void} onDisconnected
 *   Informational; the composer logs it.
 * @property {(info: { error: string, message: string, retryAfterSeconds?: number }) => void} onError
 *   TERMINAL: the runtime cannot recover (connect attempts exhausted, a live
 *   session dropped for good, an unsupported version, a modded host). `error`
 *   is an ErrorClass (see classifyConnectError). The composer emits the
 *   lifecycle error and runs the graceful shutdown.
 * @property {(snapshot: object) => void} onDashboard
 *   Telemetry snapshots go straight up the port (never through the stdout
 *   lifecycle mirror).
 * @property {() => void} emitVisionCapability
 *   Ask the composer to (re)publish the active provider's vision capability.
 *
 * @typedef {Object} RuntimeHandle
 * @property {Adapter|null} adapter     The CURRENT adapter (null between connections).
 * @property {Telemetry|null} telemetry The CURRENT telemetry (null between connections / no dashboard).
 * @property {() => Promise<void>} stop  Stop the brain, detach the adapter, leave the game. Idempotent.
 * @property {(names: string[]) => string[]} setCompanions
 *   Record the roster of OTHER companions for the body side (the runtime
 *   filters its own username out) and return the filtered list; the
 *   composer forwards that list to the brain.
 * @property {(active: boolean) => void} setDashboardWatch
 *   Renderer visibility flag; remembered across reconnects.
 */

export const ADAPTER_INTERFACE_VERSION = 2
