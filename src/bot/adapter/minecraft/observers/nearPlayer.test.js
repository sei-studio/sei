import { describe, it, expect } from 'vitest'
import { playerNearby } from './nearPlayer.js'

const bot = (alexPos, follow = null) => ({
  entity: { position: { x: 0, y: 64, z: 0 } },
  players: { Alex: { username: 'Alex', entity: alexPos ? { position: alexPos } : undefined }, Sui: { username: 'Sui' } },
  follow,
})

describe('playerNearby', () => {
  it('gives the distance in blocks and whether her follow is on them', () => {
    expect(playerNearby(bot({ x: 3, y: 64, z: 0 }), 'Alex', { followLabel: () => null })).toEqual({ distance: 3, following: false })
    expect(playerNearby(bot({ x: 0, y: 64, z: 12 }), 'alex', { followLabel: () => 'Alex' })).toEqual({ distance: 12, following: true })
  })

  it('has no distance when their entity is not loaded, and null for an unknown name', () => {
    expect(playerNearby(bot(null), 'Alex', { followLabel: () => 'Alex' })).toEqual({ distance: null, following: true })
    expect(playerNearby(bot({ x: 1, y: 64, z: 0 }), 'Steve', { followLabel: () => null })).toBeNull()
    expect(playerNearby(null, 'Alex')).toBeNull()
  })
})
