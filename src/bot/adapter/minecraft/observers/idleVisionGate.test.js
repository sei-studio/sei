// src/bot/adapter/minecraft/observers/idleVisionGate.test.js
//
// Phase 15 — Plan 15-07 Task 1 (TDD). The composite idle auto-render gate
// (VIS-04). shouldAutoRender(bot, config, provider) is the single fail-closed
// predicate the orchestrator's P3 idle tick checks BEFORE rendering. It layers
// four cheap-to-expensive checks, every one failing CLOSED:
//   (1) config.vision.auto_render ON          (default OFF — VIS-04)
//   (2) provider.capabilities.vision true      (D-10 — non-VLM never auto-renders)
//   (3) owner entity resolves                  (config.player_username online + in-range)
//   (4) hasClearLineOfSight(bot, owner) true   (16-block range + LOS — VIS-05)
//
// hasClearLineOfSight is mocked here: 15-03 already pins its block/fluid/entity
// behavior in lineOfSight.test.js. This suite asserts the GATE composition (the
// order + the fail-closed branches + the all-clear true case), not the LOS math.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the LOS helper so each branch is deterministic — we control true/false
// without constructing block worlds (that is 15-03's test surface).
vi.mock('./lineOfSight.js', () => ({
  hasClearLineOfSight: vi.fn(),
}))

import { hasClearLineOfSight } from './lineOfSight.js'
import { shouldAutoRender, resolveOwnerEntity } from './idleVisionGate.js'

const OWNER = 'steve'

/** Vision-capable provider (D-10). */
function vlmProvider() {
  return { capabilities: { vision: true } }
}

/** A bot whose player table resolves the owner to a live entity. */
function botWithOwner(ownerEntity = { id: 7, position: { x: 1, y: 64, z: 1 } }) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    players: { [OWNER]: { entity: ownerEntity } },
    entities: {},
  }
}

/** A bot whose owner is absent (offline / out of render distance). */
function botWithoutOwner() {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    players: {},
    entities: {},
  }
}

/** Config with the vision block; auto_render toggled per-case. */
function makeConfig({ autoRender = true } = {}) {
  return {
    player_username: OWNER,
    vision: { auto_render: autoRender, resolution_px: 256, image_quality: 0.4 },
  }
}

beforeEach(() => {
  vi.mocked(hasClearLineOfSight).mockReset()
})

describe('shouldAutoRender — composite idle auto-render gate (VIS-04, fail-closed)', () => {
  it('returns false when config.vision.auto_render is OFF (default — VIS-04), without even checking LOS', () => {
    vi.mocked(hasClearLineOfSight).mockReturnValue(true)
    const res = shouldAutoRender(botWithOwner(), makeConfig({ autoRender: false }), vlmProvider())
    expect(res).toBe(false)
    // Cheap-first ordering: the toggle gate short-circuits before LOS is touched.
    expect(hasClearLineOfSight).not.toHaveBeenCalled()
  })

  it('returns false when the provider is NOT vision-capable (D-10 — non-VLM)', () => {
    vi.mocked(hasClearLineOfSight).mockReturnValue(true)
    const nonVlm = { capabilities: { vision: false } }
    expect(shouldAutoRender(botWithOwner(), makeConfig(), nonVlm)).toBe(false)
    expect(hasClearLineOfSight).not.toHaveBeenCalled()
  })

  it('returns false when capabilities is missing entirely (fail-closed on unset)', () => {
    vi.mocked(hasClearLineOfSight).mockReturnValue(true)
    expect(shouldAutoRender(botWithOwner(), makeConfig(), {})).toBe(false)
    expect(shouldAutoRender(botWithOwner(), makeConfig(), null)).toBe(false)
    expect(hasClearLineOfSight).not.toHaveBeenCalled()
  })

  it('returns false when the owner entity cannot be resolved (offline / out of render distance)', () => {
    vi.mocked(hasClearLineOfSight).mockReturnValue(true)
    expect(shouldAutoRender(botWithoutOwner(), makeConfig(), vlmProvider())).toBe(false)
    // Owner never resolved → LOS is never consulted.
    expect(hasClearLineOfSight).not.toHaveBeenCalled()
  })

  it('returns false when LOS is blocked (>16 blocks OR occluded — VIS-05)', () => {
    vi.mocked(hasClearLineOfSight).mockReturnValue(false)
    expect(shouldAutoRender(botWithOwner(), makeConfig(), vlmProvider())).toBe(false)
    // The owner resolved, so the LOS gate WAS consulted (and returned false).
    expect(hasClearLineOfSight).toHaveBeenCalledTimes(1)
  })

  it('returns TRUE only when toggle ON + VLM + owner resolved + LOS clear', () => {
    const ownerEntity = { id: 7, position: { x: 2, y: 64, z: 0 } }
    vi.mocked(hasClearLineOfSight).mockReturnValue(true)
    const bot = botWithOwner(ownerEntity)
    expect(shouldAutoRender(bot, makeConfig(), vlmProvider())).toBe(true)
    // LOS was checked against the resolved OWNER entity (not the bot itself).
    expect(hasClearLineOfSight).toHaveBeenCalledTimes(1)
    expect(hasClearLineOfSight).toHaveBeenCalledWith(bot, ownerEntity)
  })

  it('fails closed when config or config.vision is missing (no path returns true on an unset config)', () => {
    vi.mocked(hasClearLineOfSight).mockReturnValue(true)
    expect(shouldAutoRender(botWithOwner(), null, vlmProvider())).toBe(false)
    expect(shouldAutoRender(botWithOwner(), {}, vlmProvider())).toBe(false)
    expect(hasClearLineOfSight).not.toHaveBeenCalled()
  })

  it('fails closed on a missing bot (no entity / no players table)', () => {
    vi.mocked(hasClearLineOfSight).mockReturnValue(true)
    expect(shouldAutoRender(null, makeConfig(), vlmProvider())).toBe(false)
    expect(shouldAutoRender({}, makeConfig(), vlmProvider())).toBe(false)
  })
})

describe('resolveOwnerEntity — config.player_username → bot.players[username].entity', () => {
  it('resolves the owner entity from the player table', () => {
    const ownerEntity = { id: 7, position: { x: 1, y: 64, z: 1 } }
    expect(resolveOwnerEntity(botWithOwner(ownerEntity), makeConfig())).toBe(ownerEntity)
  })

  it('returns null when the owner is absent from the player table', () => {
    expect(resolveOwnerEntity(botWithoutOwner(), makeConfig())).toBe(null)
  })

  it('returns null when player_username is unset', () => {
    const bot = botWithOwner()
    expect(resolveOwnerEntity(bot, { vision: { auto_render: true } })).toBe(null)
  })

  it('returns null when the player exists but has no entity (out of render distance)', () => {
    const bot = { players: { [OWNER]: { entity: null } } }
    expect(resolveOwnerEntity(bot, makeConfig())).toBe(null)
  })
})
