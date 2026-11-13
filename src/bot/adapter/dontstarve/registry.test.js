import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createDefaultRegistry, itemPrefab, recipeId, gatherSource, COOKPOT_TIMEOUT_MS } from './registry.js'
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

  it('adds dig for a 0.3.0 helper: one DIG action on a handle or the nearest stump', async () => {
    const { link, sent, state } = fakeLink()
    expect(createDefaultRegistry({ link }).list()).not.toContain('dig')
    link.hasCaps = true
    const reg = createDefaultRegistry({ link })
    expect(reg.list()).toContain('dig')
    expect(await reg.execute('dig', {}, null, {})).toMatch(/^no stump matching/)
    const frame = createFakeMod({ botPort: 1, token: 'x' }).frame(true)
    // A grass tuft can be dug too, but a dig with no target means a stump.
    state.apply({ ...frame, full: false, ents: [
      { g: 7100, p: 'grass', x: 1, z: 1, f: ['dig', 'pick'] },
      { g: 7101, p: 'evergreen', x: 3, z: 1, f: ['dig', 'stump'] },
    ] })
    expect(await reg.execute('dig', {}, null, {})).toBe('ok:action')
    expect(sent.at(-1)).toEqual({ kind: 'action', name: 'DIG', target: 7101 })
    expect(await reg.execute('dig', { target: 'grass' }, null, {})).toBe('ok:action')
    expect(sent.at(-1)).toEqual({ kind: 'action', name: 'DIG', target: 7100 })
  })

  describe('camp chores (helper 0.4.0)', () => {
    function choresLink(extra = []) {
      const f = fakeLink()
      f.link.hasCaps = true
      f.link.hasChores = true
      const frame = createFakeMod({ botPort: 1, token: 'x' }).frame(true)
      f.state.apply({ ...frame, full: false, ents: [
        { g: 7201, p: 'cookpot', x: 2, z: 2, f: ['stewer', 'container', 'structure', 'hammer'] },
        { g: 7202, p: 'meatrack', x: 3, z: -2, f: ['container', 'rack', 'structure', 'hammer'] },
        { g: 7203, p: 'butterfly', x: 4, z: 0, f: ['net', 'combat'], h: 1 },
        ...extra,
      ] })
      return { ...f, reg: createDefaultRegistry({ link: f.link }) }
    }

    it('registers the chore verbs only for a helper that runs them', () => {
      const { link } = fakeLink()
      link.hasCaps = true
      const caps = createDefaultRegistry({ link }).list()
      for (const v of ['hammer', 'net', 'harvest', 'plant', 'trap', 'dry', 'cookpot', 'stash']) expect(caps).not.toContain(v)
      link.hasChores = true
      const chores = createDefaultRegistry({ link }).list()
      for (const v of ['hammer', 'net', 'harvest', 'plant', 'trap', 'dry', 'cookpot', 'stash']) expect(chores).toContain(v)
    })

    it('hammer needs a named structure; net takes the nearest butterfly', async () => {
      const { reg, sent } = choresLink()
      await expect(reg.execute('hammer', {}, null, {})).rejects.toThrow()
      expect(await reg.execute('hammer', { target: 'meatrack' }, null, {})).toBe('ok:action')
      expect(sent.at(-1)).toEqual({ kind: 'action', name: 'HAMMER', target: 7202 })
      expect(await reg.execute('net', {}, null, {})).toBe('ok:action')
      expect(sent.at(-1)).toEqual({ kind: 'action', name: 'NET', target: 7203 })
    })

    it('harvest picks what is ready, including a rack with jerky on it', async () => {
      const { reg, sent } = choresLink()
      expect(await reg.execute('harvest', {}, null, {})).toBe('nothing ready to harvest nearby')
      const ready = choresLink([{ g: 7204, p: 'meatrack', x: 1, z: 0, f: ['container', 'rack', 'dried'] }])
      expect(await ready.reg.execute('harvest', {}, null, {})).toBe('ok:harvest')
      expect(ready.sent.at(-1)).toEqual({ kind: 'harvest', target: 7204 })
      expect(sent).toHaveLength(0)
    })

    it('plant, trap and dry send one command each', async () => {
      const { reg, sent, link } = choresLink()
      link.state.self.inv.push({ guid: 3010, prefab: 'pinecone', qty: 3, flags: [] })
      expect(await reg.execute('plant', { item: 'pine cone', count: 2 }, null, {})).toBe('ok:plant')
      expect(sent.at(-1)).toEqual({ kind: 'plant', item: 'pinecone', count: 2, pos: undefined })
      expect(await reg.execute('plant', { item: 'acorn' }, null, {})).toBe('no "acorn" in your inventory')
      expect(await reg.execute('trap', { x: 5, z: 6 }, null, {})).toBe('ok:trap')
      expect(sent.at(-1)).toEqual({ kind: 'trap', op: 'set', pos: { x: 5, z: 6 } })
      expect(await reg.execute('trap', { collect: true }, null, {})).toBe('ok:trap')
      expect(sent.at(-1)).toEqual({ kind: 'trap', op: 'collect' })
      expect(await reg.execute('dry', { item: 'meat' }, null, {})).toBe('ok:dry')
      expect(sent.at(-1)).toEqual({ kind: 'dry', rack: 7202, items: ['meat'] })
    })

    it('cookpot takes exactly 4 ingredients and waits long enough for the stew', async () => {
      const { reg, sent, link } = choresLink()
      await expect(reg.execute('cookpot', { ingredients: ['meat', 'berries'] }, null, {})).rejects.toThrow()
      expect(await reg.execute('cookpot', { ingredients: ['morsel', 'berries', 'berries', 'berries'], preview: true }, null, { timeoutMs: 30_000 })).toBe('ok:cookpot')
      expect(sent.at(-1)).toEqual({ kind: 'cookpot', pot: 7201, items: ['smallmeat', 'berries', 'berries', 'berries'], preview: true })
      expect(link.send.mock.calls.at(-1)[1].timeoutMs).toBe(COOKPOT_TIMEOUT_MS)
      expect(await reg.execute('cookpot', {}, null, {})).toBe('ok:cookpot')
      expect(sent.at(-1)).toEqual({ kind: 'cookpot', pot: 7201, items: [] })
    })

    it('stash picks up loot by default and can stay on one item', async () => {
      const { reg, sent } = choresLink()
      expect(await reg.execute('stash', {}, null, {})).toBe('ok:stash')
      expect(sent.at(-1)).toEqual({ kind: 'stash', pickup: true })
      expect(await reg.execute('stash', { item: 'rocks', pickup: false }, null, {})).toBe('ok:stash')
      expect(sent.at(-1)).toEqual({ kind: 'stash', item: 'rocks', pickup: false })
    })

    it('follow can ask to help with the player\'s chopping and mining', async () => {
      const { reg, sent } = choresLink()
      expect(await reg.execute('follow', { help: true }, null, {})).toBe('ok:follow')
      expect(sent.at(-1)).toMatchObject({ kind: 'follow', guid: 2001, help: true })
      expect(await reg.execute('follow', {}, null, {})).toBe('ok:follow')
      expect(sent.at(-1).help).toBeUndefined()
    })
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

  it('give only hands to an exact player name, and to the host only when no name is given', async () => {
    const { link, sent, state } = fakeLink()
    link.hasCaps = true
    state.ents.set(2002, { guid: 2002, prefab: 'wendy', name: 'Stevie', flags: ['player'], x: 2, z: 2 })
    const reg = createDefaultRegistry({ link })
    // Case-insensitive exact match on a player in sight.
    expect(await reg.execute('give', { item: 'berries', player: 'stevie' }, null, {})).toBe('ok:give')
    expect(sent.at(-1)).toMatchObject({ kind: 'give', guid: 2002 })
    // A partial name is not a match, and nothing is sent.
    const n = sent.length
    const miss = await reg.execute('give', { item: 'berries', player: 'Ste' }, null, {})
    expect(miss).toMatch(/^no player named "Ste"\. You can give to: .*Steve.*Stevie|^no player named "Ste"\. You can give to: .*Stevie.*Steve/)
    expect(sent.length).toBe(n)
    // No name: the host, never "whoever is first".
    expect(await reg.execute('give', { item: 'berries' }, null, {})).toBe('ok:give')
    expect(sent.at(-1)).toMatchObject({ kind: 'give', guid: 2001 })
  })

  it('give reaches the host by userid when they are out of sight, and refuses to guess without one', async () => {
    const { link, sent, state } = fakeLink()
    link.hasCaps = true
    for (const [guid, e] of [...state.ents]) if (e.flags.includes('player')) state.ents.delete(guid)
    const reg = createDefaultRegistry({ link })
    expect(await reg.execute('give', { item: 'berries', player: 'STEVE' }, null, {})).toBe('ok:give')
    expect(sent.at(-1)).toMatchObject({ kind: 'give', userid: 'KU_steve' })
    expect(await reg.execute('give', { item: 'berries' }, null, {})).toBe('ok:give')
    expect(sent.at(-1)).toMatchObject({ kind: 'give', userid: 'KU_steve' })
    expect(await reg.execute('give', { item: 'berries', player: 'Wes' }, null, {})).toBe('no player named "Wes". You can give to: Steve.')
    link.playerName = () => null
    link.playerUserid = () => ''
    const n = sent.length
    expect(await reg.execute('give', { item: 'berries' }, null, {})).toBe('say who to give it to (player). You can give to: nobody in sight.')
    expect(sent.length).toBe(n)
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
