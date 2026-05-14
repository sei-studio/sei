#!/usr/bin/env node
// Phase 6 end-to-end verification harness.
//
// Exercises:
//   V1) snapshot composer renders `nearby blocks:` (per-unique-name aggregation)
//   V2) registry exposes `find` + `gather` with Zod schemas validating
//       known-good and known-bad inputs
//   V3) find({name:'wood'}) against a single oak_log returns {found:true,...}
//   V4) find({name:'wood'}) against an empty world returns {found:false,...}
//   V5) gather({name:'wood'}) against a 4-log oak tree -> 'gathered 4/4 oak_log'
//   V6) gather AbortController fires mid-sequence -> 'aborted after K/N ...'
//   V7) ACTION_DESCRIPTIONS.gather === GATHER_DESCRIPTION (byte-identical)
//   V8) orchestrator's tool surface includes 'find' and 'gather' descriptions
//
// Pure-stub harness: no fs writes, no mineflayer boot, no Anthropic call.
// Re-runs are idempotent.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Vec3 } from 'vec3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

let assertions = 0
function ok(label) { console.log(`[verify-phase6] PASS ${label}`); assertions++ }
function bad(label, err) {
  console.error(`[verify-phase6] FAIL ${label}: ${err?.message ?? err}`)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
}

// ─── Bot stub helpers ────────────────────────────────────────────────────
// `blocks` is a Map<"x,y,z", string blockName>. Missing keys read as air.
// Uses an obviously-invalid version so mcDataLib throws inside producers,
// forcing the function-form `matching` fallback path.
function makeBot({ blocks, originPos = { x: 0, y: 64, z: 0 }, version = 'not-a-real-version', inv = [], entities = {} } = {}) {
  function blockAt(p) {
    const k = `${p.x},${p.y},${p.z}`
    const name = blocks.get(k)
    if (!name) return { name: 'air', position: new Vec3(p.x, p.y, p.z), boundingBox: 'empty' }
    return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: 'block', diggable: true }
  }
  function findBlocks({ matching, maxDistance, count, point }) {
    const origin = point ?? originPos
    const hits = []
    for (const [k, name] of blocks.entries()) {
      const [x, y, z] = k.split(',').map(Number)
      const block = { name, _id: 0 }
      const ok = typeof matching === 'function' ? matching(block) : false
      if (!ok) continue
      const d = Math.hypot(x - origin.x, y - origin.y, z - origin.z)
      if (d > maxDistance) continue
      hits.push({ v: new Vec3(x, y, z), d })
    }
    hits.sort((a, b) => a.d - b.d)
    return hits.slice(0, count).map(h => h.v)
  }
  const me = { position: new Vec3(originPos.x, originPos.y, originPos.z) }
  return {
    version,
    entity: me,
    entities: { 0: me, ...entities },
    health: 20,
    food: 20,
    experience: { level: 0 },
    isSleeping: false,
    heldItem: null,
    inventory: { items: () => inv },
    time: { isDay: true, timeOfDay: 6000 },
    blockAt,
    findBlocks,
    game: { dimension: 'overworld' },
    biomeAt: () => ({ name: 'plains' }),
    registry: { biomes: { 0: { name: 'plains' } } },
  }
}

// ─── V1: snapshot renders `nearby blocks:` (per-unique-name aggregation) ─
try {
  const { composeSnapshot } = await import('../src/bot/adapter/minecraft/observers/snapshot.js')
  // Mixed scene: 9 oak_logs (across three "trees") + a single cactus. The new
  // observer aggregates per unique block NAME — so we expect ONE oak_log line
  // (total=9, nearest=closest member) and ONE cactus line, not separate veins.
  const blocks = new Map()
  for (let y = 64; y <= 67; y++) blocks.set(`3,${y},0`, 'oak_log')   // 4 logs
  for (let y = 64; y <= 66; y++) blocks.set(`7,${y},2`, 'oak_log')   // 3 logs
  for (let y = 64; y <= 65; y++) blocks.set(`-5,${y},4`, 'oak_log')  // 2 logs
  blocks.set('6,64,0', 'cactus')
  const bot = makeBot({ blocks, originPos: { x: 0, y: 64, z: 0 } })
  const out = composeSnapshot(bot, {})
  assert.match(out, /^nearby blocks:$/m, 'snapshot lacks `nearby blocks:` header')
  // One oak_log line aggregating all 9; nearest is (3,64,0).
  assert.match(out, /#\d+ oak_log x9 @3,64,0/, 'aggregated oak_log line missing')
  // Cactus surfaces despite never being on a hardcoded interesting list.
  assert.match(out, /#\d+ cactus x1 @6,64,0/, 'cactus line missing (interesting-list filter still active?)')
  assert.ok(!out.includes('nearby veins:'), 'old `nearby veins:` header still present')
  // Handles should number monotonically starting at #1.
  const handles = [...out.matchAll(/#(\d+) (?:oak_log|cactus)/g)].map(m => Number(m[1]))
  assert.deepEqual([...handles].sort((a,b)=>a-b), [1, 2], `handle numbering off: ${handles}`)
  ok('V1 - snapshot renders nearby blocks (per-unique-name) + monotonic #N handles')
} catch (e) { bad('V1', e) }

// ─── V2: registry exposes find + gather, Zod schemas validate ─────────
let regModule
try {
  regModule = await import('../src/bot/adapter/minecraft/registry.js')
  const r = regModule.createDefaultRegistry()
  const names = r.list()
  assert.ok(names.includes('find'), `registry missing 'find'; have: ${names.join(',')}`)
  assert.ok(names.includes('gather'), `registry missing 'gather'`)
  const findSchema = r.schema('find')
  assert.ok(findSchema, 'find schema is null')
  // Known-good
  assert.deepEqual(findSchema.parse({ name: 'wood' }), { name: 'wood', maxDistance: 64 })
  assert.deepEqual(findSchema.parse({ name: 'oak_log', maxDistance: 16 }), { name: 'oak_log', maxDistance: 16 })
  // Known-bad
  assert.throws(() => findSchema.parse({}), /name/i)
  assert.throws(() => findSchema.parse({ name: '' }), /String must contain at least 1|too_small|name/i)
  const mvSchema = r.schema('gather')
  assert.ok(mvSchema, 'gather schema is null')
  mvSchema.parse({ name: 'wood' })
  mvSchema.parse({ x: 1, y: 64, z: 2 })
  assert.throws(() => mvSchema.parse({}), /name or x,y,z/i)
  assert.throws(() => mvSchema.parse({ x: 1, y: 64 }), /name or x,y,z/i)
  ok('V2 - registry exposes find + gather with validating schemas')
} catch (e) { bad('V2', e) }

// ─── V3: find({name:'wood'}) -> {found:true, id:'oak_log', ...} ──────────
try {
  const blocks = new Map([['5,64,0', 'oak_log']])
  const bot = makeBot({ blocks })
  const r = regModule.createDefaultRegistry()
  const handler = (await import('../src/bot/registry.js')).createRegistry
  // We need to invoke via execute() — registry.execute(name, args, bot, config)
  const result = await r.execute('find', { name: 'wood' }, bot, {})
  assert.equal(result.found, true, `not found; got: ${JSON.stringify(result)}`)
  assert.equal(result.id, 'oak_log', `id=${result.id}`)
  assert.deepEqual(result.pos, { x: 5, y: 64, z: 0 })
  assert.equal(typeof result.distance, 'number', 'distance not numeric')
  ok('V3 - find({name:wood}) returns {found:true, id:oak_log, pos, distance}')
} catch (e) { bad('V3', e) }

// ─── V4: find({name:'wood'}) on empty world -> {found:false, reason:/wood/} ─
try {
  const bot = makeBot({ blocks: new Map() })
  const r = regModule.createDefaultRegistry()
  const result = await r.execute('find', { name: 'wood' }, bot, {})
  assert.equal(result.found, false, `expected not found; got: ${JSON.stringify(result)}`)
  assert.match(result.reason, /wood/, `reason=${result.reason}`)
  ok('V4 - find({name:wood}) on empty world returns {found:false, reason: /wood/}')
} catch (e) { bad('V4', e) }

// ─── V5: gather({name:'wood'}) on 4-log tree -> 'gathered 4/4 oak_log' ───
try {
  const blocks = new Map()
  for (let y = 64; y <= 67; y++) blocks.set(`5,${y},0`, 'oak_log')
  const bot = makeBot({ blocks })
  const { gatherAction } = await import('../src/bot/adapter/minecraft/behaviors/mineVein.js')
  const deps = {
    goTo: async () => 'reached',
    digAction: async (a) => `dug oak_log @${a.x},${a.y},${a.z}`,
  }
  const r = await gatherAction({ name: 'wood' }, bot, {}, deps)
  assert.equal(r, 'gathered 4/4 oak_log', `got: ${r}`)
  ok('V5 - gather({name:wood}) chains find+flood+dig -> gathered 4/4 oak_log')
} catch (e) { bad('V5', e) }

// ─── V6: gather AbortController mid-sequence ──────────────────────────
try {
  const blocks = new Map()
  for (let y = 64; y <= 67; y++) blocks.set(`5,${y},0`, 'oak_log')
  const bot = makeBot({ blocks })
  const { gatherAction } = await import('../src/bot/adapter/minecraft/behaviors/mineVein.js')
  const controller = new AbortController()
  let digCount = 0
  const deps = {
    goTo: async () => 'reached',
    digAction: async (a, _bot, cfg) => {
      digCount++
      if (digCount === 2) controller.abort()
      if (cfg?.signal?.aborted) return 'aborted'
      return `dug oak_log @${a.x},${a.y},${a.z}`
    },
  }
  const r = await gatherAction({ name: 'wood' }, bot, { signal: controller.signal }, deps)
  assert.match(r, /aborted after \d+\/4 oak_log/, `got: ${r}`)
  ok('V6 - gather abort mid-sequence -> aborted after K/4 oak_log')
} catch (e) { bad('V6', e) }

// ─── V7: ACTION_DESCRIPTIONS.gather === GATHER_DESCRIPTION ─────────
try {
  // ACTION_DESCRIPTIONS is module-internal — we cannot import it directly.
  // Read the orchestrator source and confirm `gather: GATHER_DESCRIPTION`
  // is the mapping (import-by-reference makes byte-identity mechanical).
  const orchPath = resolve(REPO_ROOT, 'src/bot/brain/orchestrator.js')
  const src = await readFile(orchPath, 'utf8')
  const stripped = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.match(stripped, /gather:\s*GATHER_DESCRIPTION/, 'gather not bound to GATHER_DESCRIPTION by reference')
  // And the named import exists.
  assert.match(stripped, /import \{ GATHER_DESCRIPTION \} from ['"][^'"]+mineVein\.js['"]/, 'missing GATHER_DESCRIPTION import')
  // Sanity: import resolves to a non-empty string.
  const { GATHER_DESCRIPTION } = await import('../src/bot/adapter/minecraft/behaviors/mineVein.js')
  assert.equal(typeof GATHER_DESCRIPTION, 'string')
  assert.ok(GATHER_DESCRIPTION.length > 100, 'GATHER_DESCRIPTION suspiciously short')
  ok('V7 - ACTION_DESCRIPTIONS.gather references GATHER_DESCRIPTION (byte-identity by import)')
} catch (e) { bad('V7', e) }

// ─── V8: orchestrator surfaces find + gather in ACTION_DESCRIPTIONS ───
try {
  const orchPath = resolve(REPO_ROOT, 'src/bot/brain/orchestrator.js')
  const src = await readFile(orchPath, 'utf8')
  const stripped = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  // Locate ACTION_DESCRIPTIONS region.
  const i = stripped.indexOf('const ACTION_DESCRIPTIONS')
  assert.ok(i >= 0, 'ACTION_DESCRIPTIONS not found')
  const region = stripped.slice(i, i + 4000)
  assert.match(region, /^\s*find:\s*/m, 'find: key not in ACTION_DESCRIPTIONS region')
  assert.match(region, /^\s*gather:\s*/m, 'gather: key not in ACTION_DESCRIPTIONS region')
  // Verify subRegistry filter at the buildAnthropicTools call site does NOT
  // exclude find / gather — only setGoals should be filtered.
  assert.match(stripped, /filter\(n => n !== 'setGoals'\)/, 'subRegistry filter signature changed; verify it still passes find + gather')
  ok('V8 - orchestrator tool surface includes find + gather (no movement-tier filter blocks them)')
} catch (e) { bad('V8', e) }

console.log(`[verify-phase6] OK (${assertions} assertions)`)
