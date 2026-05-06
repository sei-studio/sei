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
 * @property {(opts: { goals: any, lastActionResult: string|null, inFlight: any }) => string} next
 *   Returns the world-summary string for the next seed turn.
 * @property {() => void} reset
 */

/**
 * @typedef {Object} AdapterHandlers
 * @property {(player: Player) => void}                                              onPlayerJoined
 * @property {(player: Player) => void}                                              onPlayerLeft
 * @property {(evt: { username: string, text: string, ownerSpoke: boolean,
 *                    addressed: boolean, nearby: boolean }) => void}                onChat
 * @property {(evt: { attacker: Player|null, attackerLabel: string,
 *                    attackerKind: 'player'|'mob'|'unknown' }) => void}             onAttacked
 * @property {() => void}                                                            onSpawn
 */

/**
 * @typedef {Object} ExecuteActionContext
 * @property {AbortSignal} signal
 * @property {any}         goalStore
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
 * @property {() => string}                                                worldPrimer
 *   Returns the per-adapter primer string. For minecraft, this is the MINECRAFT_PRIMER block
 *   currently in src/brain/persona.js — Plan 02 moves it to the adapter side.
 *
 * Session lifecycle:
 * @property {(handlers: AdapterHandlers) => void}                         attach
 *
 * Effects the brain commands but cannot synthesize:
 * @property {(text: string) => void}                                      chat
 *   The post-processed say() text reaches the player via this method.
 * @property {(fn: () => any) => void}                                     setInflightProvider
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
