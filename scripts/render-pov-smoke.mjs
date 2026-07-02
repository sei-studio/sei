// scripts/render-pov-smoke.mjs
//
// Synthetic-world smoke test for renderPov — runs the REAL render path (native
// gl/canvas, worker meshing, JPEG encode) against a hand-built prismarine world,
// no Minecraft server needed. Natives are built for Electron's ABI, so run under
// Electron's node mode (15-01 pattern):
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/render-pov-smoke.mjs
//
// Scenarios (frames land in $TMPDIR/sei-render-smoke/):
//   full    all columns present before the call         -> terrain to the horizon
//   sparse  only the bot's own column, no readiness API -> reproduces the
//           "single dirt mound floating in sky" bug shape (what a too-early
//           render saw before the waitForNearbyColumns fix)
//   stream  starts sparse; bot.waitForChunksToLoad "streams in" the rest after
//           1.2s -> a full frame proves renderPov waits out the chunk stream
//
// The script must ALSO exit on its own: a hang here means the per-render viewer
// worker_threads were not terminated (the leak renderPov's finally now fixes).

import { createRequire } from 'module'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const VERSION = '1.21.1'
const registry = require('prismarine-registry')(VERSION)
const ChunkColumn = require('prismarine-chunk')(registry)
const World = require('prismarine-world')(registry)
const { Vec3 } = require('vec3')

const DIRT = registry.blocksByName.dirt.defaultState
const GRASS = registry.blocksByName.grass_block.defaultState
const STONE = registry.blocksByName.stone.defaultState

const OUT_DIR = path.join(os.tmpdir(), 'sei-render-smoke')

// Flat grass world, surface at y=63, with stone pillars every 24 blocks as
// unmistakable distance landmarks — a correct frame shows pillars receding to
// the horizon; a sparse frame shows a lone grass island against sky.
function makeChunk (cx, cz) {
  const chunk = new ChunkColumn({ minY: -64, worldHeight: 384 })
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      for (let y = 56; y < 63; y++) chunk.setBlockStateId(new Vec3(x, y, z), DIRT)
      chunk.setBlockStateId(new Vec3(x, 63, z), GRASS)
      const wx = cx * 16 + x
      const wz = cz * 16 + z
      if (wx % 24 === 0 && wz % 24 === 0) {
        for (let y = 64; y < 71; y++) chunk.setBlockStateId(new Vec3(x, y, z), STONE)
      }
    }
  }
  return chunk
}

const SPAN = 5 // columns -5..5 ≈ what a server sends around a player

function fillWorld (world) {
  for (let cx = -SPAN; cx <= SPAN; cx++) {
    for (let cz = -SPAN; cz <= SPAN; cz++) {
      if (!world.getColumn(cx, cz)) world.setColumn(cx, cz, makeChunk(cx, cz))
    }
  }
}

// Minimal stand-in for the live mineflayer bot: renderPov + WorldView touch
// version/entity/world, EventEmitter wiring (listenToBot), and — post-fix —
// the optional bot.waitForChunksToLoad readiness API.
function makeBot (world, waitForChunksToLoad, timeOfDay = null) {
  const { EventEmitter } = require('node:events')
  const bot = new EventEmitter()
  bot.username = 'SmokeBot'
  bot.version = VERSION
  bot.world = world
  bot.entities = {}
  bot.entity = { position: new Vec3(8, 64, 8), yaw: Math.PI / 4, pitch: 0, height: 1.62 }
  if (waitForChunksToLoad) bot.waitForChunksToLoad = waitForChunksToLoad
  // 260611: time-of-day sky — renderPov reads bot.time?.timeOfDay.
  if (timeOfDay != null) bot.time = { timeOfDay }
  return bot
}

const { renderPov } = await import('../src/bot/adapter/minecraft/render/povRenderer.js')

async function run (name, bot) {
  const t0 = Date.now()
  const result = await renderPov(bot, { timeoutMs: 7000 })
  const ms = Date.now() - t0
  if (result.ok) {
    const file = path.join(OUT_DIR, `${name}.jpg`)
    await writeFile(file, result.buffer)
    console.log(`[smoke] ${name}: ok ${result.buffer.length} bytes in ${ms}ms -> ${file}`)
  } else {
    console.log(`[smoke] ${name}: DEGRADED (${result.reason}) in ${ms}ms`)
  }
}

await mkdir(OUT_DIR, { recursive: true })

// 1. full — steady-state world, immediate readiness.
{
  const world = new World(null).sync
  fillWorld(world)
  await run('full', makeBot(world, async () => {}))
}

// 2. sparse — bug reproduction: one column, no readiness API to wait on.
{
  const world = new World(null).sync
  world.setColumn(0, 0, makeChunk(0, 0))
  await run('sparse', makeBot(world))
}

// 3. stream — starts sparse, chunks "arrive" while renderPov waits (the fix).
{
  const world = new World(null).sync
  world.setColumn(0, 0, makeChunk(0, 0))
  await run('stream', makeBot(world, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    fillWorld(world)
  }))
}

// 4./5. night + sunset — 260611 time-of-day sky. Full world; only bot.time
// differs. A correct night frame keeps terrain visible under a dark sky
// (NOT degraded to cant_see — isBlankFrame must track the dynamic color).
{
  const world = new World(null).sync
  fillWorld(world)
  await run('night', makeBot(world, async () => {}, 18000))
  await run('sunset', makeBot(world, async () => {}, 12500))
}

const { disposeRenderer } = await import('../src/bot/adapter/minecraft/render/povRenderer.js')
disposeRenderer()
console.log('[smoke] done — process should now exit on its own (hang = leaked viewer workers)')

// Watchdog: unref'd, so it only fires if something is still holding the loop.
setTimeout(() => {
  console.error('[smoke] WARNING: event loop still alive 10s after done — leaked threads?')
  process.exit(2)
}, 10000).unref()
