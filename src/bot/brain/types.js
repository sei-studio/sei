// src/brain/types.js
//
// Adapter interface contract — the seam between game-agnostic brain and
// game-specific adapter implementations (e.g. the minecraft adapter under
// src/adapter/).
//
// The brain depends on this interface and nothing else game-shaped. A
// future adapter (Stardew, Roblox, ...) implements this same shape.
//
// This file is the source of truth for D-5 (brain/adapter split). Plan 02
// (03.1-02) wires the minecraft adapter's index.js to satisfy it; the brain
// orchestrator stops importing observers/* and behaviors/* directly and
// instead consumes an injected `adapter` that conforms to this contract.
//
// No runtime types yet — JSDoc only. Plan 02 wires this into the orchestrator.

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
 * @typedef {Object} AdapterHandlers
 * @property {(player: Player) => void}                                              onPlayerJoined
 * @property {(player: Player) => void}                                              onPlayerLeft
 * @property {(evt: { username: string, text: string, playerSpoke: boolean,
 *                    addressed: boolean, nearby: boolean }) => void}                onChat
 * @property {(evt: { attacker: Player|null, attackerLabel: string,
 *                    attackerKind: 'player'|'mob'|'unknown' }) => void}             onAttacked
 * @property {() => void}                                                            onSpawn
 */

/**
 * @typedef {Object} ExecuteActionContext
 * @property {AbortSignal} signal
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
 * @property {() => string}                                                cuboidGrammar
 *   Seed-block text teaching the two-corner build/dig grammar.
 * @property {(event: string, data: any) => string}                        eventAddendum
 *   Per-event seed addendum (loop_end, idle, attacked, etc.). Returns '' for
 *   unknown events.
 * @property {(args: {x:number,y:number,z:number,range:number}) => string} cantReachNudge
 *   Mid-loop nudge when pathfinder cant_reach trips twice on the same dest.
 *
 * Session lifecycle:
 * @property {(handlers: AdapterHandlers) => void}                         attach
 * @property {() => void}                                                  [detach]
 *   Plan 03.1-09 / WR-07: tear down listeners on reconnect; idempotent.
 *   Optional — not in REQUIRED_ADAPTER_MEMBERS so adapters that don't need
 *   teardown don't fail boot. Boot composer guards with `_adapter?.detach?.()`.
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
 *
 * Identity:
 * @property {string}                                                      botUsername
 * @property {() => Object<string, Player>}                                getKnownPlayers
 */

export const ADAPTER_INTERFACE_VERSION = 1
