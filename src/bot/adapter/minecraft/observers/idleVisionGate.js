// src/bot/adapter/minecraft/observers/idleVisionGate.js
//
// Phase 15 — Plan 15-07 (VIS-04). The composite idle auto-render gate. This is
// the single fail-closed predicate the orchestrator's existing P3 `sei:idle`
// tick checks BEFORE auto-rendering the bot's POV (no new timer — the idle tick
// is reused; 15-PATTERNS.md "Idle (P3) tick reuse"). It governs ONLY the idle
// path: explicit `visualize` (the model asked) is ungated by owner-proximity
// (D-08). The 16-block + LOS gate exists here to keep the periodic "look around"
// cheap and private — a parked, VLM-backed bot only auto-renders when its owner
// is genuinely in view.
//
// Four checks, ordered cheap-to-expensive, EVERY one failing CLOSED so any
// ambiguity (toggle unset, non-VLM provider, owner offline/out-of-range,
// occluded LOS) yields `false` — the bot does NOT auto-render:
//   (1) config.vision.auto_render ON         (default OFF — VIS-04 / D-04)
//   (2) provider.capabilities.vision true     (D-10 — a non-VLM never auto-renders)
//   (3) owner entity resolves                 (config.player_username online + loaded)
//   (4) hasClearLineOfSight(bot, owner) true  (16-block range + fluid/entity LOS — VIS-05)
//
// The 16-block RANGE gate lives INSIDE hasClearLineOfSight (15-03) — we do NOT
// re-implement it here; resolving the owner then deferring to the LOS helper
// gives us range + occlusion + fluids in one fail-closed call.

import { hasClearLineOfSight } from './lineOfSight.js'

/**
 * Resolve the bot's owner entity for the idle gate. Mirrors targeting.js's
 * bot.players[username] idiom: config.player_username keys the player table, and
 * a present-but-unloaded player (out of render distance) carries a null
 * `.entity`. Returns null on any miss so the gate fails closed.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} config
 * @returns {import('prismarine-entity').Entity | null}
 */
export function resolveOwnerEntity(bot, config) {
  const username = config?.player_username
  if (!bot || typeof username !== 'string' || username.length === 0) return null
  const players = bot.players ?? {}
  const owner = players[username]?.entity
  return owner ?? null
}

/**
 * VIS-04 idle auto-render gate. Returns true ONLY when ALL of: the user toggle
 * is ON, the active provider is vision-capable, the owner entity is resolved,
 * and the custom line-of-sight to that owner is clear within 16 blocks. Every
 * other case — including any unset/missing input — returns false (fail-closed).
 *
 * Cheap-to-expensive ordering: the boolean toggle and capability checks
 * short-circuit before the (more expensive) owner resolution + ray-march LOS, so
 * an OFF toggle or a non-VLM provider never pays for an LOS walk.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} config             validated bot config (reads config.vision + player_username)
 * @param {{ capabilities?: { vision?: boolean } }} provider  the active LLM provider handle
 * @returns {boolean}
 */
export function shouldAutoRender(bot, config, provider) {
  // (1) Toggle — default OFF (VIS-04). The optional chain + truthiness check
  //     fails closed when config / config.vision is missing or auto_render unset.
  if (!config?.vision?.auto_render) return false

  // (2) Capability — D-10. A non-VLM (or an unreadable capability) never
  //     auto-renders. Fail-closed on a missing provider/capabilities object.
  if (!provider?.capabilities?.vision) return false

  // (3) Owner — must be online AND within render distance (loaded entity).
  const owner = resolveOwnerEntity(bot, config)
  if (!owner) return false

  // (4) Line of sight — the 16-block range gate + fluid/entity occlusion live
  //     inside hasClearLineOfSight (15-03). It fails closed on out-of-range,
  //     unloaded chunk, fluid, solid/partial block, or an intervening entity.
  return hasClearLineOfSight(bot, owner)
}
