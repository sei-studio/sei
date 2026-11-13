import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BondSchema, BOND_STAGES as SHARED_STAGES, BOND_MAX_ITEMS as SHARED_MAX, BOND_LINE_CHARS as SHARED_CHARS } from '../../../shared/bondSchema'
import {
  BOND_STAGES, BOND_MAX_ITEMS, BOND_LINE_CHARS, mergeBond, normalizeBond, parseBondBlock, readBondSync, saveBondUpdate,
} from './bond.js'
import { BOND_MAX_CHARS, renderBond, renderBondNotes } from '../promptLibrary.js'

const T = Date.UTC(2026, 10, 13, 12)
const up = (o) => ({ treated: 'warm', stage: null, lists: {}, ...o })

describe('bond.js mirrors the shared schema', () => {
  it('has the same stages and caps', () => {
    expect(BOND_STAGES).toEqual([...SHARED_STAGES])
    expect(BOND_MAX_ITEMS).toBe(SHARED_MAX)
    expect(BOND_LINE_CHARS).toBe(SHARED_CHARS)
  })
  it('every merged record passes the schema', () => {
    const long = 'x'.repeat(400)
    const b = mergeBond(null, up({ stage: 'familiar', lists: { how_i_feel: [long, 'a', 'b', 'c'], names: ['al'] } }), T)
    expect(BondSchema.safeParse(b).success).toBe(true)
    expect(b.how_i_feel).toHaveLength(3)
  })
})

describe('parseBondBlock', () => {
  it('takes the block out of the reply and reads its labelled lines', () => {
    const { update, rest } = parseBondBlock('<summary>s</summary>\n<bond>\ntreated: Warm.\nstage: **close**\nfeeling: i like them\nfeeling: they make me laugh\nrule: none\njoke: the turnip thing\nthread: finish the roof\nnot a label\n</bond>')
    expect(rest).toBe('<summary>s</summary>')
    expect(update).toEqual({ treated: 'warm', stage: 'close', lists: { how_i_feel: ['i like them', 'they make me laugh'], standing_rules: [], running_jokes: ['the turnip thing'] } })
  })
  it('no block: null update, reply unchanged', () => {
    expect(parseBondBlock('recap: x\nnone')).toEqual({ update: null, rest: 'recap: x\nnone' })
  })
  it('an unknown stage or treated value is ignored', () => {
    expect(parseBondBlock('<bond>stage: soulmates\ntreated: meh</bond>').update).toEqual({ treated: null, stage: null, lists: {} })
  })
})

describe('mergeBond: grow or hold, never sour', () => {
  const base = mergeBond(null, up({ stage: 'familiar', lists: { how_i_feel: ['i like them'], running_jokes: ['the turnip thing'] } }), T)
  it('a first write takes the stage it is given, capped below the top', () => {
    expect(base.stage).toBe('familiar')
    expect(mergeBond(null, up({ stage: 'bonded' }), T).stage).toBe('close')
    expect(mergeBond(null, up({}), T)).toBeNull()
  })
  it('moves up one step at most, and only after a warm stretch', () => {
    expect(mergeBond(base, up({ stage: 'bonded' }), T).stage).toBe('close')
    expect(mergeBond(base, up({ treated: 'neutral', stage: 'close' }), T).stage).toBe('familiar')
    expect(mergeBond(base, up({ treated: null, stage: 'close' }), T).stage).toBe('familiar')
  })
  it('never moves down', () => {
    expect(mergeBond(base, up({ treated: 'badly', stage: 'new' }), T).stage).toBe('familiar')
    expect(mergeBond(base, up({ treated: 'warm', stage: 'acquainted' }), T).stage).toBe('familiar')
  })
  it('feelings change only after a warm stretch', () => {
    expect(mergeBond(base, up({ treated: 'badly', lists: { how_i_feel: ['they hurt me'] } }), T).how_i_feel).toEqual(['i like them'])
    expect(mergeBond(base, up({ treated: 'neutral', lists: { how_i_feel: ['not sure about them'] } }), T).how_i_feel).toEqual(['i like them'])
    expect(mergeBond(base, up({ lists: { how_i_feel: ['they are my favourite'] } }), T).how_i_feel).toEqual(['they are my favourite'])
    // none yet: a neutral first impression may be written, a bad one may not
    expect(mergeBond(null, up({ treated: 'neutral', stage: 'new', lists: { how_i_feel: ['they seem fun'] } }), T).how_i_feel).toEqual(['they seem fun'])
    expect(mergeBond(null, up({ treated: 'badly', stage: 'new', lists: { how_i_feel: ['they are mean'] } }), T).how_i_feel).toEqual([])
  })
  it('facts update either way; a list left out is kept; none empties one', () => {
    const b = mergeBond(base, up({ treated: 'badly', lists: { standing_rules: ['never swear'] } }), T)
    expect(b.standing_rules).toEqual(['never swear'])
    expect(b.how_i_feel).toEqual(['i like them'])
    expect(b.running_jokes).toEqual(['the turnip thing'])
    expect(mergeBond(b, up({ lists: { running_jokes: [] } }), T).running_jokes).toEqual([])
    expect(b.updates).toBe(2)
  })
})

describe('saveBondUpdate', () => {
  it('writes, reads back, and respects mayWrite and validate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bond-'))
    try {
      expect((await saveBondUpdate(dir, null)).outcome).toBe('missing')
      expect((await saveBondUpdate(dir, up({ stage: 'new' }), { mayWrite: () => false })).outcome).toBe('unchanged')
      expect(readBondSync(dir)).toBeNull()
      expect((await saveBondUpdate(dir, up({ stage: 'new' }), { validate: () => false })).outcome).toBe('invalid')
      const r = await saveBondUpdate(dir, up({ stage: 'acquainted' }), { now: T })
      expect(r).toEqual({ outcome: 'saved', stage: 'acquainted', prevStage: null, treated: 'warm' })
      expect(readBondSync(dir).stage).toBe('acquainted')
      fs.writeFileSync(path.join(dir, 'bond.json'), '{not json')
      expect(readBondSync(dir)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('normalizeBond drops a record without a known stage and clips the rest', () => {
    expect(normalizeBond({ stage: 'x' })).toBeNull()
    expect(normalizeBond({ stage: 'new', names: ['a', '', 'b', 'c', 'd'], open_threads: [{ text: 't' }] })).toEqual(expect.objectContaining({ names: ['a', 'b', 'c'] }))
    expect(normalizeBond({ stage: 'new', open_threads: [{ text: 't' }] })).not.toHaveProperty('open_threads')
  })
})

describe('renderBond', () => {
  const full = mergeBond(null, up({
    stage: 'close',
    lists: {
      how_i_feel: ['a'.repeat(160), 'b'.repeat(160), 'c'.repeat(160)],
      names: ['n'.repeat(160), 'm'.repeat(160), 'o'.repeat(160)],
      running_jokes: ['j'.repeat(160), 'k'.repeat(160), 'l'.repeat(160)],
      standing_rules: ['r'.repeat(160), 's'.repeat(160), 't'.repeat(160)],
    },
  }), T)
  it('is empty without a bond, the same text for the same input, and held under the cap', () => {
    expect(renderBond(null)).toBe('')
    const text = renderBond(full, { userName: 'Alex' })
    expect(text.length).toBeLessThanOrEqual(BOND_MAX_CHARS)
    expect(text).toContain('# YOU AND ALEX')
    expect(text).toContain('You and Alex are close.')
    expect(text).toContain('r'.repeat(160))
    expect(text).not.toContain('—')
    expect(renderBond(full, { userName: 'Alex' })).toBe(text)
  })
  it('a small bond renders every part, and the writer sees the same labels', () => {
    const b = mergeBond(null, up({ stage: 'familiar', lists: { how_i_feel: ['i like them'], running_jokes: ['the turnip wolf'], standing_rules: ['never call them kiddo'] } }), T)
    const text = renderBond(b, {})
    expect(text).toContain('You and the player know each other well by now.')
    expect(text).toContain('Running jokes between you: the turnip wolf')
    expect(text).toContain('Things they asked of you, which you keep to: never call them kiddo')
    expect(renderBondNotes(b)).toContain('joke: the turnip wolf')
    expect(renderBondNotes(null)).toContain('no notes yet')
  })
})
