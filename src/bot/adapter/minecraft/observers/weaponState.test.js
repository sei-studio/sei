// 261030 (quality pass 31): fight events say so when she owns no weapon.
//
// combat_night eval: a first death dropped her sword, and every hit, defend
// and threat turn after it still told her to attackEntity the mob. She fought
// bare-handed and died again (13 of 18 deaths in the two worst runs).

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { withWeaponState } from './weaponState.js'
import { noteLostWeapon, lostWeaponUnarmed, LOST_WEAPON_MS } from '../behaviors/weaponSelect.js'
import { staleAttackerText } from './staleAttacker.js'
import { trackEntityDeaths } from './entities.js'
import {
  eventAddendum, ATTACKED_ADDENDUM_MOB, attackedMobUnarmed,
} from '../../../brain/promptLibrary.js'
import { deathAddendum } from '../prompts.js'

const botWith = (items) => ({ inventory: { items: () => items.map((name) => ({ name, count: 1 })) } })
// A bot whose last death dropped a stone sword.
const afterDeath = (items) => { const b = botWith(items); noteLostWeapon(b, [{ item: 'stone_sword', n: 1 }]); return b }
const zombie = { id: 7, name: 'zombie', isValid: true }

describe('withWeaponState', () => {
  it('marks a mob hit, defend and threat event only after a death took her weapon', () => {
    for (const kind of ['hostile_mob', 'mob', 'defend']) {
      expect(withWeaponState(afterDeath(['bread', 'dirt']), 'sei:attacked', { attackerKind: kind }).unarmed).toBe(true)
    }
    for (const w of ['stone_sword', 'iron_axe', 'trident']) {
      const d = { attackerKind: 'hostile_mob' }
      expect(withWeaponState(afterDeath([w]), 'sei:attacked', d)).toBe(d)
    }
  })

  it('a bot that never had a weapon (wooden pickaxe only) keeps the dev event data', () => {
    const d = { attackerKind: 'hostile_mob' }
    expect(withWeaponState(botWith(['wooden_pickaxe', 'oak_log']), 'sei:attacked', d)).toBe(d)
    const t = { attackerKind: 'defend', threat: true }
    expect(withWeaponState(botWith([]), 'sei:attacked', t)).toBe(t)
  })

  it('leaves player hits, reflex and survival turns, other events and inert bots alone', () => {
    const empty = afterDeath([])
    for (const d of [{ attackerKind: 'player' }, { attackerKind: 'reflex' }, { attackerKind: 'reflex', survivalKind: 'drowning' }]) {
      expect(withWeaponState(empty, 'sei:attacked', d)).toBe(d)
    }
    const idle = { quietMs: 5000 }
    expect(withWeaponState(empty, 'sei:idle', idle)).toBe(idle)
    const d = { attackerKind: 'hostile_mob' }
    expect(withWeaponState({}, 'sei:attacked', d)).toBe(d)
  })
})

describe('the lost-weapon mark', () => {
  it('is set only by a death whose drop held a weapon', () => {
    const b = botWith([])
    expect(noteLostWeapon(b, [{ item: 'bread', n: 3 }, { item: 'wooden_pickaxe', n: 1 }])).toBe(null)
    expect(lostWeaponUnarmed(b)).toBe(false)
    expect(noteLostWeapon(b, [{ item: 'bread', n: 3 }, { item: 'wooden_axe', n: 1 }, { item: 'iron_sword', n: 1 }])).toBe('iron_sword')
    expect(lostWeaponUnarmed(b)).toBe(true)
  })

  it('clears when she owns a weapon again, and stays cleared', () => {
    let items = []
    const b = { inventory: { items: () => items } }
    noteLostWeapon(b, [{ item: 'stone_sword', n: 1 }])
    expect(lostWeaponUnarmed(b)).toBe(true)
    items = [{ name: 'stone_sword', count: 1 }]
    expect(lostWeaponUnarmed(b)).toBe(false)
    items = []
    expect(lostWeaponUnarmed(b)).toBe(false)
  })

  it('expires after LOST_WEAPON_MS; a second death while marked restarts it', () => {
    const b = botWith([])
    noteLostWeapon(b, [{ item: 'stone_sword', n: 1 }], 0)
    expect(lostWeaponUnarmed(b, LOST_WEAPON_MS - 1)).toBe(true)
    noteLostWeapon(b, [{ item: 'bread', n: 2 }], LOST_WEAPON_MS - 1)
    expect(lostWeaponUnarmed(b, 2 * LOST_WEAPON_MS - 2)).toBe(true)
    expect(lostWeaponUnarmed(b, 2 * LOST_WEAPON_MS)).toBe(false)
  })
})

describe('unarmed event text', () => {
  it('a mob hit: the armed text keeps the stand-your-ground offer, the unarmed one says get away', () => {
    const armed = eventAddendum('sei:attacked', { attackerLabel: 'drowned', attackerKind: 'hostile_mob' })
    const bare = eventAddendum('sei:attacked', { attackerLabel: 'drowned', attackerKind: 'hostile_mob', unarmed: true })
    expect(armed).toBe(ATTACKED_ADDENDUM_MOB.replace('{label}', 'drowned'))
    expect(bare).toBe(attackedMobUnarmed().replace('{label}', 'drowned'))
    expect(bare).toMatch(/no weapon/)
    expect(bare).not.toMatch(/swing back on their own/)
    expect(attackedMobUnarmed().slice(attackedMobUnarmed().indexOf(' Then:'))).not.toMatch(/—/)
  })

  it('a threat on the player: unarmed says do not attackEntity it', () => {
    const data = { attackerLabel: 'zombie', attackerKind: 'defend', threat: true, count: 2, ownerLabel: 'Alex', distance: 11, ownerDistance: 8 }
    const armed = eventAddendum('sei:attacked', data)
    const bare = eventAddendum('sei:attacked', { ...data, unarmed: true })
    expect(armed).toMatch(/Call attackEntity on it now/)
    expect(bare).toMatch(/^2 hostiles are closing in on Alex: the nearest is 8 blocks from them and 11 blocks from you\. You lost your weapon when you died/)
    expect(bare).toMatch(/Unless they ask you to fight it, do not attackEntity it/)
    expect(bare).not.toMatch(/—/)
  })

  it('a held defend turn: unarmed swaps the attack advice; her own running attack keeps its wording', () => {
    const data = { attackerLabel: 'zombie', attackerKind: 'defend', ownerLabel: 'Alex', distance: 5, engaged: false }
    expect(eventAddendum('sei:attacked', data)).toMatch(/attackEntity it to pull it off them/)
    const bare = eventAddendum('sei:attacked', { ...data, unarmed: true })
    expect(bare).toMatch(/^Alex is being hit by zombie \(5 blocks from you\)\. You lost your weapon when you died/)
    const action = { ...data, engaged: true, actionOnIt: true }
    expect(eventAddendum('sei:attacked', { ...action, unarmed: true })).toBe(eventAddendum('sei:attacked', action))
  })
})

describe('death that dropped a weapon', () => {
  it('names the weapon and what it means', () => {
    const t = deathAddendum({ pos: { x: 1, y: 2, z: 3 }, lost: [{ item: 'bread', n: 3 }, { item: 'stone_sword', n: 1 }, { item: 'wooden_axe', n: 1 }] })
    expect(t).toMatch(/That includes your stone_sword, so you have no weapon until you get it back/)
  })
  it('says nothing about weapons when none dropped', () => {
    const t = deathAddendum({ pos: { x: 1, y: 2, z: 3 }, lost: [{ item: 'bread', n: 3 }] })
    expect(t).not.toMatch(/weapon/)
  })
})

describe('staleAttackerText covers her own hits (hostile_mob)', () => {
  it('replaces a hit event whose mob died before the turn', () => {
    const bot = new EventEmitter()
    bot.entity = { position: new Vec3(0, 64, 0) }
    bot.entities = {}
    trackEntityDeaths(bot)
    const z = { ...zombie, type: 'hostile', position: new Vec3(2, 64, 0) }
    bot.entities[7] = z
    const data = { attacker: z, attackerLabel: 'zombie', attackerKind: 'hostile_mob' }
    expect(staleAttackerText(bot, 'sei:attacked', data)).toBeNull()
    bot.emit('entityDead', z)
    expect(staleAttackerText(bot, 'sei:attacked', data)).toMatch(/^A zombie went for you a moment ago, and it has died since then/)
  })
})
