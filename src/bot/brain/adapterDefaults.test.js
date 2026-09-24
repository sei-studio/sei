// Game-adapters M0 (260908): the contract-v2 defaults ARE the values the
// Minecraft adapter declares, and adaptNudges() with those defaults renders the
// exact NUDGES text. Together with systemBlocks.minecraft.test.js this is the
// "no behavior change for Minecraft" proof for everything outside the cached
// prefix (the per-turn nudges, the paused notice, the batch rules).
import { describe, it, expect } from 'vitest'
import { ADAPTER_DEFAULTS, resolveAdapterCaps } from './adapterDefaults.js'
import { NUDGES, adaptNudges, SESSION_END_CLAUSE, MINECRAFT_BASELINE, UNIVERSAL_BASELINE, BASELINE_INSTRUCTIONS } from './promptLibrary.js'

describe('ADAPTER_DEFAULTS (Minecraft values)', () => {
  it('names Minecraft, the 256-char clip, follow/unfollow, look, and the classifier table', () => {
    expect(ADAPTER_DEFAULTS.gameName).toBe('Minecraft')
    expect(ADAPTER_DEFAULTS.chatMaxChars).toBe(256)
    expect(ADAPTER_DEFAULTS.backgroundActions).toEqual({ follow: 'unfollow' })
    expect([...ADAPTER_DEFAULTS.visionActions]).toEqual(['look'])
    expect(ADAPTER_DEFAULTS.progressActions('build', {})).toBe(true)
    expect(ADAPTER_DEFAULTS.progressActions('gather', {})).toBe(true)
    expect(ADAPTER_DEFAULTS.progressActions('dig', { to: { x: 1, y: 2, z: 3 } })).toBe(true)
    expect(ADAPTER_DEFAULTS.progressActions('dig', { block: 'stone' })).toBe(false)
    expect(ADAPTER_DEFAULTS.progressActions('goTo', {})).toBe(false)
    expect(ADAPTER_DEFAULTS.classifyConnectError('UNSUPPORTED_MC_VERSION: 1.7')).toBe('UNSUPPORTED_MC_VERSION')
    expect(ADAPTER_DEFAULTS.classifyConnectError('MODDED_HOST_REJECTED: forge')).toBe('MODDED_HOST_REJECTED')
    expect(ADAPTER_DEFAULTS.classifyConnectError('LAN_NOT_OPEN: gone')).toBe('LAN_NOT_OPEN')
    expect(ADAPTER_DEFAULTS.classifyConnectError('spawn never landed')).toBe('BOT_START_TIMEOUT')
  })

  it('composes the pre-v2 BASELINE_INSTRUCTIONS byte for byte', () => {
    expect(`${UNIVERSAL_BASELINE}\n\n${ADAPTER_DEFAULTS.surfaceBaseline()}`).toBe(BASELINE_INSTRUCTIONS)
    expect(ADAPTER_DEFAULTS.surfaceBaseline()).toBe(MINECRAFT_BASELINE)
    expect(ADAPTER_DEFAULTS.sessionEndClause()).toBe(SESSION_END_CLAUSE)
  })
})

describe('resolveAdapterCaps', () => {
  it('uses defaults for a v1 adapter and reproduces the old spawn-coordinate world identity', () => {
    const adapter = {
      getWorldInfo: () => ({ spawnPoint: { x: 10, y: 64, z: -5 }, dimension: 'overworld' }),
    }
    const caps = resolveAdapterCaps(adapter, { world_label: null })
    expect(caps.gameName).toBe('Minecraft')
    expect(caps.getWorldIdentity()).toEqual({ fingerprint: 'overworld@10,64,-5', label: 'spawn 10,-5' })
    const labeled = resolveAdapterCaps(adapter, { world_label: ' My World ' })
    expect(labeled.getWorldIdentity().label).toBe('My World')
    const noSpawn = resolveAdapterCaps({ getWorldInfo: () => ({ spawnPoint: null }) }, {})
    expect(noSpawn.getWorldIdentity()).toBeNull()
  })

  it('prefers the adapter declaration and binds methods to it', () => {
    const adapter = {
      gameName: 'Stardew Valley',
      chatMaxChars: 120,
      backgroundActions: { followPlayer: 'stopFollowing' },
      progressActions: ['water', 'harvest'],
      visionActions: [],
      surfaceBaseline() { return `baseline for ${this.gameName}` },
      getWorldIdentity: () => ({ fingerprint: 'farm:abc', label: 'Sunny Farm' }),
    }
    const caps = resolveAdapterCaps(adapter, {})
    expect(caps.gameName).toBe('Stardew Valley')
    expect(caps.chatMaxChars).toBe(120)
    expect(caps.backgroundActions).toEqual({ followPlayer: 'stopFollowing' })
    expect(caps.isProgressAction('water', {})).toBe(true)
    expect(caps.isProgressAction('build', {})).toBe(false)
    expect(caps.visionActions.size).toBe(0)
    expect(caps.surfaceBaseline()).toBe('baseline for Stardew Valley')
    expect(caps.getWorldIdentity()).toEqual({ fingerprint: 'farm:abc', label: 'Sunny Farm' })
    // Unspecified members still default.
    expect(caps.sessionEndClause()).toBe(SESSION_END_CLAUSE)
  })
})

describe('adaptNudges', () => {
  const variants = [
    { action: 'follow Steve', stopTool: 'unfollow', playerLine: 'wait up', who: 'Steve' },
    { action: 'follow Steve', stopTool: 'unfollow', playerLine: null, elapsedSec: 45, proactiveness: 2 },
    { action: 'gather oak_log', stopTool: 'end_loop', playerLine: null, elapsedSec: 12, visionOff: true },
    { action: null, stopTool: 'end_loop', playerLine: 'hey', who: 'Steve' },
    { action: null, stopTool: 'end_loop', playerLine: 'hey', who: 'Steve', voice: true, peers: ['Marv'] },
    { action: 'goTo 1 2 3', stopTool: 'end_loop', playerLine: 'yo', who: 'Marv', voice: true, fromTeammate: true },
  ]

  it('with the defaults renders byte-identical NUDGES text', () => {
    const adapted = adaptNudges()
    expect(adapted.playerInterruptHint).toBe(NUDGES.playerInterruptHint)
    expect(adapted.playerInterruptHintGroupVoice).toBe(NUDGES.playerInterruptHintGroupVoice)
    expect(adapted.silence).toBe(NUDGES.silence)
    expect(adapted.capClose).toBe(NUDGES.capClose)
    for (const v of variants) expect(adapted.actionTurn(v)).toBe(NUDGES.actionTurn(v))
  })

  it('substitutes an adapter session-end clause and stuck nudges everywhere they appear', () => {
    const clause = 'If they are ENDING THE SESSION, the farm day ends when they sleep, so call quit_game.'
    const stuck = { vision: 'LOOK-STUCK', noVision: 'NOLOOK-STUCK' }
    const adapted = adaptNudges({ sessionEndClause: clause, stuckNudges: stuck })
    expect(adapted.playerInterruptHint).toContain(clause)
    expect(adapted.playerInterruptHint).not.toContain(SESSION_END_CLAUSE)
    expect(adapted.playerInterruptHintGroupVoice).toContain(clause)
    const mid = adapted.actionTurn({ action: 'water crops', stopTool: 'end_loop', playerLine: 'hey', who: 'Steve' })
    expect(mid).toContain(clause)
    expect(mid).not.toContain(SESSION_END_CLAUSE)
    const monitor = adapted.actionTurn({ action: 'water crops', stopTool: 'end_loop', playerLine: null, elapsedSec: 5 })
    expect(monitor).toContain('LOOK-STUCK')
    const monitorOff = adapted.actionTurn({ action: 'water crops', stopTool: 'end_loop', playerLine: null, elapsedSec: 5, visionOff: true })
    expect(monitorOff).toContain('NOLOOK-STUCK')
  })
})
