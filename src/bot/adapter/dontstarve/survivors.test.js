// The survivor roster lives in three places by necessity (main/renderer TS,
// bot JS, mod Lua). This pins the prefab lists and the mechanics flags
// together so an edit to one cannot drift silently.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DST_SURVIVORS, DST_SURVIVOR_PREFABS, DST_DEFAULT_SURVIVOR } from './survivors.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../../..')
const FLAGS = ['eatsSpoiled', 'fireImmune', 'wetnessDamage', 'frail', 'needsCrockpot', 'souls', 'plantFriend', 'noSleep']

function luaRoster() {
  const src = readFileSync(path.join(ROOT, 'native/dst-mod/sei/scripts/sei/survivors.lua'), 'utf8')
  const block = /Survivors\.TABLE = \{([\s\S]*?)\n\}/.exec(src)[1]
  const out = {}
  for (const m of block.matchAll(/^\s*(\w+) = row\(\{([^}]*)\}\)/gm)) {
    const flags = {}
    for (const f of m[2].matchAll(/(\w+) = (true|"\w+")/g)) flags[f[1]] = f[2] === 'true' ? true : f[2].replace(/"/g, '')
    out[m[1]] = flags
  }
  return out
}

function tsRoster() {
  const src = readFileSync(path.join(ROOT, 'src/shared/dstSurvivors.ts'), 'utf8')
  const out = {}
  for (const m of src.matchAll(/prefab: '(\w+)'[\s\S]*?diet: '(\w+)', ((?:\w+: (?:true|false), )*\w+: (?:true|false))/g)) {
    const flags = { diet: m[2] }
    for (const f of m[3].matchAll(/(\w+): (true|false)/g)) flags[f[1]] = f[2] === 'true'
    out[m[1]] = flags
  }
  return out
}

describe('survivor roster sync', () => {
  const lua = luaRoster()
  const ts = tsRoster()

  it('ships the fifteen eligible survivors in all three copies, same order', () => {
    expect(DST_SURVIVOR_PREFABS).toEqual([
      'wilson', 'willow', 'wolfgang', 'wendy', 'wx78', 'wickerbottom', 'waxwell', 'wigfrid', 'webber', 'winona',
      'wortox', 'wormwood', 'warly', 'wurt', 'walter',
    ])
    expect(Object.keys(lua)).toEqual([...DST_SURVIVOR_PREFABS])
    expect(Object.keys(ts)).toEqual([...DST_SURVIVOR_PREFABS])
    expect(DST_DEFAULT_SURVIVOR).toBe('wilson')
    for (const excluded of ['wes', 'woodie', 'wanda', 'wonkey']) expect(DST_SURVIVOR_PREFABS).not.toContain(excluded)
  })

  it('agrees on every mechanics flag', () => {
    for (const p of DST_SURVIVOR_PREFABS) {
      const js = DST_SURVIVORS[p]
      for (const f of FLAGS) {
        expect(Boolean(js[f]), `${p}.${f} js vs ts`).toBe(Boolean(ts[p][f]))
        expect(Boolean(lua[p][f]), `${p}.${f} lua vs ts`).toBe(Boolean(ts[p][f]))
      }
      expect(js.diet ?? 'any', `${p}.diet js`).toBe(ts[p].diet)
      expect(lua[p].diet ?? 'any', `${p}.diet lua`).toBe(ts[p].diet)
    }
  })
})
