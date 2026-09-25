import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createDefaultRegistry, itemPrefab, recipeId, gatherSource } from './registry.js'
import { createObservationState, createHandleRegistry } from './protocol.js'
import { createFakeMod } from '../../../../scripts/fake-dst-mod.mjs'

function fakeLink() {
  const state = createObservationState()
  const mod = createFakeMod({ botPort: 1, token: 'x' })
  state.apply(mod.frame(true))
  const sent = []
  const link = {
    events: new EventEmitter(), state, handles: createHandleRegistry(), botName: 'Sui', prefab: 'wilson',
    body: { fight: true, followLabel: null }, playerName: () => 'Steve', playerUserid: () => 'KU_steve',
    send: vi.fn(async (cmd) => { sent.push(cmd); return `ok:${cmd.kind}` }),
    say: vi.fn(), setPaused: vi.fn(),
  }
  return { link, sent, state }
}

describe('DST registry: come/follow when the player is out of the perception sweep (260909)', () => {
  function farLink() {
    const { link, sent, state } = fakeLink()
    // Drop every player from the observed set, as if the body wandered off.
    for (const [guid, e] of [...state.ents]) if (e.flags.includes('player')) state.ents.delete(guid)
    return { link, sent }
  }

  it('come walks to the pinned player by userid instead of failing', async () => {
    const { link, sent } = farLink()
    const reg = createDefaultRegistry({ link })
    expect(await reg.execute('come', {}, null, {})).toBe('ok:goto')
    expect(sent.at(-1)).toMatchObject({ kind: 'goto', userid: 'KU_steve', range: 3 })
    expect(sent.at(-1).guid).toBeUndefined()
  })

  it('follow addresses the pinned player by userid and labels the follow', async () => {
    const { link, sent } = farLink()
    const reg = createDefaultRegistry({ link })
    expect(await reg.execute('follow', { distance: 3 }, null, {})).toBe('ok:follow')
    expect(sent.at(-1)).toMatchObject({ kind: 'follow', userid: 'KU_steve', dist: 3 })
    expect(link.body.followLabel).toBe('Steve')
  })

  it('falls back to the nearest player (userid "") when nobody is pinned', async () => {
    const { link, sent } = farLink()
    link.playerUserid = () => ''
    const reg = createDefaultRegistry({ link })
    expect(await reg.execute('come', {}, null, {})).toBe('ok:goto')
    expect(sent.at(-1)).toMatchObject({ kind: 'goto', userid: '', range: 3 })
  })
})

describe('DST registry', () => {
  it('registers the verb set the prompt describes', () => {
    const { link } = fakeLink()
    const reg = createDefaultRegistry({ link })
    expect(reg.list().sort()).toEqual([
      'attack', 'build', 'chop', 'come', 'cook', 'craft', 'drop', 'eat', 'equip', 'flee', 'follow', 'gather', 'goTo',
      'lightFire', 'mine', 'pick', 'pickup', 'sleep', 'store', 'take', 'unfollow',
    ])
  })

  it('adds give for a 0.3.0 helper and hands an inventory item to the player', async () => {
    const { link, sent } = fakeLink()
    link.hasCaps = true
    const reg = createDefaultRegistry({ link })
    expect(reg.list()).toContain('give')
    expect(await reg.execute('give', { item: 'berries', count: 2 }, null, {})).toBe('ok:give')
    expect(sent.at(-1)).toMatchObject({ kind: 'give', item: 'berries', count: 2, guid: 2001 })
    expect(await reg.execute('give', { item: 'axe' }, null, {})).toBe('ok:give') // the one in hand
    expect(sent.at(-1)).toMatchObject({ kind: 'give', item: 'axe', count: 1 })
    expect(await reg.execute('give', { item: 'gold' }, null, {})).toBe('no "gold" in your inventory')
  })

  it('maps verbs to one command each, resolving handles, names and inventory items', async () => {
    const { link, sent, state } = fakeLink()
    const reg = createDefaultRegistry({ link })
    const spider = [...state.ents.values()].find((e) => e.prefab === 'spider')
    const h = link.handles.handleFor(spider.guid)

    expect(await reg.execute('goTo', { x: 3, z: 4 }, null, {})).toBe('ok:goto')
    expect(sent.at(-1)).toMatchObject({ kind: 'goto', x: 3, z: 4, range: 2.5 })
    expect(await reg.execute('goTo', { target: h }, null, {})).toBe('ok:goto')
    expect(sent.at(-1)).toMatchObject({ kind: 'goto', guid: spider.guid })
    expect(await reg.execute('come', {}, null, {})).toBe('ok:goto')
    expect(sent.at(-1)).toMatchObject({ kind: 'goto', guid: 2001, range: 3 })
    expect(await reg.execute('follow', {}, null, {})).toBe('ok:follow')
    expect(link.body.followLabel).toBe('Steve')
    expect(await reg.execute('gather', { item: 'wood', count: 5 }, null, {})).toBe('ok:gather')
    expect(sent.at(-1)).toMatchObject({ kind: 'gather', prefab: 'log', count: 5, source: 'CHOP' })
    expect(await reg.execute('chop', {}, null, {})).toBe('ok:action')
    expect(sent.at(-1)).toMatchObject({ kind: 'action', name: 'CHOP', target: 1001 })
    expect(await reg.execute('mine', { target: 'rock' }, null, {})).toBe('ok:action')
    expect(sent.at(-1)).toMatchObject({ name: 'MINE', target: 1005 })
    expect(await reg.execute('pick', { target: 'sapling' }, null, {})).toBe('ok:action')
    expect(sent.at(-1)).toMatchObject({ name: 'PICK', target: 1003 })
    expect(await reg.execute('pickup', { target: 'flint' }, null, {})).toBe('ok:action')
    expect(sent.at(-1)).toMatchObject({ name: 'PICKUP', target: 1006 })
    expect(await reg.execute('craft', { recipe: 'Science Machine' }, null, {})).toBe('ok:build')
    expect(sent.at(-1)).toMatchObject({ kind: 'build', recipe: 'researchlab' })
    expect(await reg.execute('build', { recipe: 'fire pit', x: 1, z: 2 }, null, {})).toBe('ok:build')
    expect(sent.at(-1)).toMatchObject({ kind: 'build', recipe: 'firepit', pos: { x: 1, z: 2 } })
    expect(await reg.execute('eat', { item: 'berries' }, null, {})).toBe('ok:action')
    expect(sent.at(-1)).toMatchObject({ name: 'EAT', target: 3003 })
    expect(await reg.execute('eat', { item: 'log' }, null, {})).toMatch(/not something you can eat/)
    expect(await reg.execute('eat', { item: 'cake' }, null, {})).toMatch(/no "cake" in your inventory/)
    expect(await reg.execute('equip', { item: 'axe' }, null, {})).toBe('ok:equip')
    expect(await reg.execute('attack', { target: h }, null, {})).toBe('ok:attack')
    expect(sent.at(-1)).toMatchObject({ kind: 'attack', guid: spider.guid, label: 'spider' })
    expect(await reg.execute('attack', { target: 'Steve' }, null, {})).toBe('you never attack players')
    expect(await reg.execute('flee', {}, null, {})).toBe('ok:flee')
    expect(await reg.execute('lightFire', {}, null, {})).toBe('ok:lightfire')
    expect(await reg.execute('cook', { item: 'berries' }, null, {})).toBe('ok:action')
    expect(sent.at(-1)).toMatchObject({ name: 'COOK', target: 1009, invobject: 3003 })
    expect(await reg.execute('store', { container: 'chest', item: 'logs', count: 2 }, null, {})).toBe('ok:container')
    expect(sent.at(-1)).toMatchObject({ kind: 'container', op: 'store', container: 1010, item: 'log', count: 2 })
    expect(await reg.execute('take', { container: '#99', item: 'log' }, null, {})).toMatch(/no chest matching/)
    expect(await reg.execute('sleep', {}, null, {})).toBe('no tent or bedroll nearby')
    expect(await reg.execute('drop', { item: 'twigs' }, null, {})).toBe('ok:drop')
    expect(await reg.execute('unfollow', {}, null, {})).toBe('ok:unfollow')
    expect(link.body.followLabel).toBeNull()
    // The abort signal rides through to the link.
    const ac = new AbortController()
    await reg.execute('goTo', { x: 0, z: 0 }, null, { signal: ac.signal })
    expect(link.send.mock.calls.at(-1)[1].signal).toBe(ac.signal)
  })

  it('rejects args outside the schema', async () => {
    const { link } = fakeLink()
    const reg = createDefaultRegistry({ link })
    await expect(reg.execute('goTo', {}, null, {})).rejects.toThrow()
    await expect(reg.execute('gather', { item: 'log', count: 0 }, null, {})).rejects.toThrow()
  })

  it('aliases loose names', () => {
    expect(itemPrefab('Twig')).toBe('twigs')
    expect(itemPrefab('cut grass')).toBe('cutgrass')
    expect(itemPrefab('goldnugget')).toBe('goldnugget')
    expect(recipeId('crock pot')).toBe('cookpot')
    expect(recipeId('axe')).toBe('axe')
    expect(gatherSource('rocks')).toBe('MINE')
    expect(gatherSource('cutgrass')).toBe('grass')
    expect(gatherSource('unknown_thing')).toBeNull()
  })
})
