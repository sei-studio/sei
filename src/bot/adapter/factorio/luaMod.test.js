// Runs the mod's offline Lua tests (native/factorio-mod/tests/run.lua) when a
// stock `lua` is on PATH, and checks that the JS and Lua framing agree. Skipped
// on machines without Lua; the headless harness covers the in-game parts.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { frames, parseFrame } from './client.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const modDir = path.join(repo, 'native', 'factorio-mod', 'sei-companion')
const hasLua = spawnSync('lua', ['-v'], { encoding: 'utf8' }).status === 0

describe.skipIf(!hasLua)('sei-companion Lua (offline)', () => {
  it('passes its offline tests', () => {
    const r = spawnSync('lua', [path.join(repo, 'native', 'factorio-mod', 'tests', 'run.lua')], { encoding: 'utf8', timeout: 20_000 })
    expect(r.stdout).toMatch(/\d+ passed, 0 failed/)
    expect(r.status).toBe(0)
  })

  it('frames bodies exactly like the JS client', () => {
    const body = JSON.stringify({ text: 'é☃'.repeat(25_000), op: 'say' })
    const script = `
      package.path = ${JSON.stringify(modDir + '/?.lua;')} .. package.path
      storage = {} helpers = {} game = { tick = 0 }
      local link = require("scripts.link")
      local s = io.read("*a")
      for _, f in ipairs(link.frames("id7", s)) do io.write(string.format("%d\\n", #f), f) end`
    const r = spawnSync('lua', ['-e', script], { input: body, timeout: 20_000 })
    expect(r.status).toBe(0)
    const luaFrames = []
    let buf = r.stdout
    while (buf.length) {
      const nl = buf.indexOf(0x0a)
      const len = Number(buf.subarray(0, nl).toString())
      luaFrames.push(buf.subarray(nl + 1, nl + 1 + len))
      buf = buf.subarray(nl + 1 + len)
    }
    const jsFrames = frames('id7', body)
    expect(luaFrames.length).toBe(jsFrames.length)
    for (let i = 0; i < jsFrames.length; i++) expect(Buffer.compare(luaFrames[i], jsFrames[i])).toBe(0)
    expect(parseFrame(luaFrames[0])).toMatchObject({ id: 'id7', part: 1, parts: jsFrames.length })
  })
})
