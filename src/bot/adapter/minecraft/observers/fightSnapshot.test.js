// 261106 (quality pass 44): the snapshot while attackEntity runs.
//
// combat_night-01 (11-03 dev scorecard, 02:29): her attack was on a zombie in
// the river. Water blocks the sight filter, so the snapshot showed
// "in_flight: attackEntity(zombie)" with no zombie in the entity list, and she
// told the player "zombies are down" and called goTo, which ended the fight.

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { composeSnapshot } from './snapshot.js'

function riverBot() {
  // Water fills y 60..63 for x >= 4: a mob standing in it is out of sight.
  const zombie = { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(6, 61, 0), height: 1.95 }
  const other = { id: 9, name: 'zombie', type: 'hostile', position: new Vec3(7, 61, 3), height: 1.95 }
  const alex = { id: 2, username: 'Alex', type: 'player', position: new Vec3(-3, 64, 0), height: 1.8 }
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, eyeHeight: 1.6 },
    username: 'Sui',
    entities: { 2: alex, 7: zombie, 9: other },
    players: { Alex: { username: 'Alex', entity: alex } },
    _seiOwnerNames: ['alex'],
    inventory: { items: () => [], slots: [] },
    findBlocks: () => [],
    findBlock: () => null,
    blockAt: (p) => (p.x >= 4 && p.y >= 60 && p.y < 64
      ? { name: 'water', shapes: [], position: p }
      : { name: 'air', shapes: [], position: p }),
    health: 20,
    food: 20,
    game: { dimension: 'overworld' },
    time: { timeOfDay: 14000 },
  })
}

const inFlight = { id: 1, name: 'attackEntity', args: { target: 'zombie', times: 8 }, startedAt: Date.now() - 11_000 }
const run = () => ({ open: true, name: 'zombie', mobTarget: true, ctx: { currentId: 7, deadIds: new Set([5]), tagged: new Set([5, 7]), used: 4, budget: 8, signal: null } })

describe('snapshot while attackEntity runs (261106)', () => {
  it('lists the mob the attack is on, the kills so far and where it goes next', () => {
    const bot = riverBot()
    bot._seiAttackRun = run()
    const snap = composeSnapshot(bot, { inFlight, pinUsername: 'Alex' })
    const flight = snap.split('\n').find((l) => l.startsWith('in_flight:'))
    expect(flight).toMatch(/^in_flight: attackEntity\(zombie\) started=1\d\.\ds ago, 1 killed so far\. After this kill it goes on by itself to the zombie 11 blocks from Alex\.$/)
    expect(flight).not.toMatch(/—/)
    // The zombie it is on shows despite the water; the other one stays hidden.
    expect(snap).toMatch(/ zombie @6,61,0 \(7 from you, 9 from Alex\)/)
    expect(snap).not.toMatch(/zombie @7,61,3/)
  })

  it('is the plain line once the attack has ended', () => {
    const bot = riverBot()
    const snap = composeSnapshot(bot, { inFlight, pinUsername: 'Alex' })
    expect(snap.split('\n').find((l) => l.startsWith('in_flight:'))).toMatch(/^in_flight: attackEntity\(zombie\) started=1\d\.\ds ago$/)
    expect(snap).not.toMatch(/zombie @6,61,0/)
  })
})
