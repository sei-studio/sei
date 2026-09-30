#!/usr/bin/env node
// scripts/mc-version-smoke.mjs — live check that Sei's REAL Minecraft adapter
// (connect.js + the action registry, no LLM) works against a running server.
//
// Written for the 26.2 support work (260926): run it against an offline-mode
// vanilla server of the version you are adding, and against one version we
// already support, before changing the supported set.
//
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/mc-version-smoke.mjs \
//     --port 25620 [--host 127.0.0.1] [--username SeiSmoke] \
//     [--console /path/to/server/console.in]
//
// Electron-as-node (not plain node) because the render natives (gl, canvas)
// are built for Electron's ABI; see the render-pov-smoke.mjs header. On a
// Linux box where the gl build links a newer libstdc++ than canvas bundles,
// prefix LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libstdc++.so.6.
//
// Vanilla 26.3 servers default to white-list=true: run `whitelist off`.
//
// --console is a file the server's stdin tails (`tail -F console.in | java
// -jar server.jar nogui`). With it the script ops itself and /gives the
// items the craft/place steps need; without it those steps are skipped.
//
// Steps: status ping + version resolve, spawn, chat round-trip, block
// lookup, pathfind (goTo), dig + pickup, inventory, craft, equip, place,
// follow a second (plain mineflayer) player, POV render. Prints one PASS/FAIL/SKIP line per step and exits non-zero on
// any FAIL.

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveServerVersion, createBotInstance } from '../src/bot/adapter/minecraft/connect.js'
import { createMinecraftAdapter } from '../src/bot/adapter/minecraft/index.js'
import { ConfigSchema } from '../src/bot/config.js'
import { createBot } from 'mineflayer'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const host = arg('host', '127.0.0.1')
const port = Number(arg('port', '25565'))
const username = arg('username', 'SeiSmoke')
const consoleFile = arg('console', null)

const results = []
const record = (step, status, detail = '') => {
  results.push({ step, status, detail })
  console.log(`[smoke] ${status.padEnd(4)} ${step}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const serverCmd = (cmd) => { if (consoleFile) appendFileSync(consoleFile, cmd + '\n') }
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
])
const quiet = { info: () => {}, warn: (m) => console.log(`[warn] ${m}`), error: (m) => console.log(`[error] ${m}`) }

async function step(name, fn) {
  try {
    const detail = await fn()
    if (detail && typeof detail === 'object' && detail.skip) record(name, 'SKIP', detail.skip)
    else record(name, 'PASS', detail ?? '')
  } catch (err) {
    record(name, 'FAIL', (err && err.message) || String(err))
  }
}

const count = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)

async function main() {
  let version
  await step('ping + resolve version', async () => {
    version = await resolveServerVersion({ host, port, logger: quiet })
    return version
  })
  if (!version) return

  const config = ConfigSchema.parse({
    player_username: 'SmokePlayer',
    persona: { name: 'Smoke', expanded: 'smoke test' },
    anthropic: { api_key: 'smoke-test-unused' },
    adapter: { kind: 'minecraft', minecraft: { host, port, auth: 'offline', username, version } },
  })

  let bot
  await step('spawn', async () => {
    await withTimeout(new Promise((resolve, reject) => {
      bot = createBotInstance({
        host, port, auth: 'offline', username, version, config, logger: quiet,
        onSpawn: resolve,
        onEnd: (reason) => reject(new Error(`connection ended: ${reason}`)),
        onError: (err) => reject(err),
        onConnectTimeout: (err) => reject(err),
      })
    }), 45_000, 'spawn')
    await withTimeout(bot.waitForChunksToLoad(), 30_000, 'chunks')
    const p = bot.entity.position
    return `as ${bot.username} on ${bot.version} (protocol ${bot.protocolVersion}) at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} hp=${bot.health}`
  })
  if (!bot?.entity) return summary()

  const adapter = createMinecraftAdapter({ bot, config })
  const act = (name, args) => withTimeout(adapter.executeAction(name, args), 60_000, name)

  await step('chat round-trip', async () => {
    const heard = new Promise((resolve) => {
      bot.on('messagestr', (m) => { if (m.includes('sei smoke hello')) resolve(m) })
    })
    bot.chat('sei smoke hello')
    return await withTimeout(heard, 10_000, 'own chat echo')
  })

  let arena = null
  if (consoleFile) {
    arena = bot.entity.position.floored()
    serverCmd(`op ${username}`)
    serverCmd(`gamemode survival ${username}`)
    // A flat, open 25x25 arena around the bot so the movement / place /
    // follow steps do not depend on where the world happened to spawn it
    // (it also exercises multi-block-change packets).
    serverCmd(`execute at ${username} run fill ~-12 ~ ~-12 ~12 ~12 ~12 air`)
    serverCmd(`execute at ${username} run fill ~-12 ~-3 ~-12 ~12 ~-2 ~12 dirt`)
    serverCmd(`execute at ${username} run fill ~-12 ~-1 ~-12 ~12 ~-1 ~12 grass_block`)
    await sleep(2000)
  }

  await step('block lookup', async () => {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    if (!below) throw new Error('blockAt(feet-1) returned null')
    const found = bot.findBlocks({ matching: (b) => b && b.name !== 'air' && b.name !== 'cave_air', maxDistance: 8, count: 50 })
    if (found.length === 0) throw new Error('findBlocks returned nothing')
    return `standing on ${below.name}; ${found.length} solid blocks within 8`
  })

  await step('goTo (pathfinder)', async () => {
    const start = bot.entity.position.clone()
    // Pick a standable surface block ~6-10 blocks away.
    const target = bot.findBlock({
      matching: (b) => b && ['grass_block', 'dirt', 'sand', 'stone', 'snow_block', 'podzol'].includes(b.name),
      maxDistance: 16,
      useExtraInfo: (b) => {
        const d = b.position.distanceTo(start)
        const above = bot.blockAt(b.position.offset(0, 1, 0))
        const above2 = bot.blockAt(b.position.offset(0, 2, 0))
        return d > 6 && d < 12 && above?.name === 'air' && above2?.name === 'air'
      },
    })
    if (!target) return { skip: 'no standable block 6-12 away' }
    const goal = target.position.offset(0, 1, 0)
    const res = await act('goTo', { x: goal.x, y: goal.y, z: goal.z, range: 1 })
    const moved = bot.entity.position.distanceTo(start)
    const left = bot.entity.position.distanceTo(goal)
    if (left > 2.5) throw new Error(`ended ${left.toFixed(1)} from goal (moved ${moved.toFixed(1)}); result: ${JSON.stringify(res)}`)
    return `moved ${moved.toFixed(1)} blocks, ${left.toFixed(1)} from goal; result: ${String(res?.message ?? res).slice(0, 80)}`
  })

  await step('dig + pickup', async () => {
    const pick = ['dirt', 'grass_block', 'sand', 'gravel', 'short_grass']
    const before = Object.fromEntries(pick.map((n) => [n, count(bot, n)]))
    const target = bot.findBlock({ matching: (b) => b && ['grass_block', 'dirt', 'sand'].includes(b.name), maxDistance: 6 })
    if (!target) return { skip: 'no dirt/grass/sand within 6' }
    const res = await act('dig', { x: target.position.x, y: target.position.y, z: target.position.z })
    const after = bot.blockAt(target.position)
    if (after && after.name === target.name) throw new Error(`block still ${after.name}; result: ${JSON.stringify(res)}`)
    await sleep(1500)
    const gained = pick.filter((n) => count(bot, n) > before[n])
    return `dug ${target.name} -> now ${after?.name}; inventory gained: ${gained.join(',') || 'nothing (pickup not observed)'}`
  })

  await step('inventory', async () => {
    if (consoleFile) {
      // Clear first: the world persists across runs, so leftovers would satisfy the wait early.
      serverCmd(`clear ${username}`)
      await withTimeout((async () => { while (bot.inventory.items().length) await sleep(250) })(), 10_000, 'inventory cleared')
      serverCmd(`give ${username} oak_log 4`)
      serverCmd(`give ${username} cobblestone 8`)
      await withTimeout((async () => { while (count(bot, 'oak_log') < 4 || count(bot, 'cobblestone') < 8) await sleep(250) })(), 10_000, 'given items')
    }
    const items = bot.inventory.items().map((i) => `${i.name}x${i.count}`)
    if (consoleFile && !items.length) throw new Error('inventory empty after /give')
    return items.join(' ') || 'empty'
  })

  await step('craft planks', async () => {
    if (!count(bot, 'oak_log')) return { skip: 'no oak_log (needs --console)' }
    const res = await act('craft', { item: 'oak_planks', count: 4 })
    if (count(bot, 'oak_planks') < 4) throw new Error(`no planks; result: ${JSON.stringify(res)}`)
    return `oak_planks=${count(bot, 'oak_planks')}`
  })

  await step('equip', async () => {
    if (!count(bot, 'cobblestone')) return { skip: 'no cobblestone (needs --console)' }
    await act('equip', { item: 'cobblestone', destination: 'hand' })
    if (bot.heldItem?.name !== 'cobblestone') throw new Error(`holding ${bot.heldItem?.name}`)
    return 'holding cobblestone'
  })

  await step('placeBlock', async () => {
    if (!count(bot, 'cobblestone')) return { skip: 'no cobblestone (needs --console)' }
    const before = count(bot, 'cobblestone')
    const res = await act('placeBlock', { block: 'cobblestone' })
    // The inventory update can trail the action when the server is behind; poll briefly.
    for (let i = 0; i < 20 && count(bot, 'cobblestone') >= before; i++) await sleep(200)
    if (count(bot, 'cobblestone') >= before) throw new Error(`cobblestone count unchanged (${before} -> ${count(bot, 'cobblestone')}, held ${bot.heldItem?.name}x${bot.heldItem?.count}, slots ${bot.inventory.items().filter((i) => i.name === 'cobblestone').map((i) => i.slot + ':' + i.count).join(',')}); result: ${JSON.stringify(res)}`)
    return String(res?.message ?? res).slice(0, 100)
  })

  await step('follow a player', async () => {
    if (!consoleFile) return { skip: 'needs --console to place the player' }
    // A second, plain mineflayer client stands in for the human host.
    const player = createBot({ host, port, username: 'SmokePlayer', auth: 'offline', version })
    try {
      await withTimeout(new Promise((resolve, reject) => {
        player.once('spawn', resolve)
        player.once('kicked', (r) => reject(new Error(`player kicked: ${JSON.stringify(r)}`)))
        player.once('error', reject)
      }), 30_000, 'player spawn')
      // Inside the flat arena, 10 blocks east of where it was built.
      serverCmd(`tp SmokePlayer ${arena.x + 10.5} ${arena.y} ${arena.z + 0.5}`)
      await sleep(1500)
      const tracked = () => bot.players.SmokePlayer?.entity
      await withTimeout((async () => { while (!tracked()) await sleep(200) })(), 10_000, 'player entity tracked')
      const startDist = tracked().position.distanceTo(bot.entity.position)
      await act('follow', { player: 'SmokePlayer' })
      const gap = () => (tracked() ? tracked().position.distanceTo(bot.entity.position) : Infinity)
      try {
        await withTimeout((async () => { while (gap() > 3.5) await sleep(250) })(), 25_000, 'follow closing the gap')
      } catch (err) {
        const pp = tracked()?.position
        throw new Error(`${err.message}: gap ${startDist.toFixed(1)} -> ${gap().toFixed(1)}; player at ${pp ? `${pp.x.toFixed(1)},${pp.y.toFixed(1)},${pp.z.toFixed(1)}` : '?'}, bot at ${bot.entity.position.toString()}, pathfinder moving=${bot.pathfinder?.isMoving?.()}`)
      }
      const endDist = tracked().position.distanceTo(bot.entity.position)
      await act('unfollow', {})
      return `gap ${startDist.toFixed(1)} -> ${endDist.toFixed(1)} blocks`
    } finally {
      try { player.quit() } catch {}
    }
  })

  await step('POV render', async () => {
    const { renderPov } = await import('../src/bot/adapter/minecraft/render/povRenderer.js')
    const r = await withTimeout(renderPov(bot), 60_000, 'renderPov')
    if (r?.ok) {
      const dir = join(tmpdir(), 'sei-mc-version-smoke')
      mkdirSync(dir, { recursive: true })
      const f = join(dir, `pov-${bot.version}.jpg`)
      writeFileSync(f, r.buffer)
      return `rendered ${r.buffer.length} bytes -> ${f}`
    }
    return { skip: `degraded: ${r?.reason ?? JSON.stringify(r)}` }
  })

  await step('still connected', async () => {
    await sleep(3000)
    if (!bot.entity || bot._client?.ended) throw new Error('connection dropped during the run')
    return `hp=${bot.health} food=${bot.food}`
  })

  try { bot.quit('smoke done') } catch {}
  return summary()
}

function summary() {
  const failed = results.filter((r) => r.status === 'FAIL')
  console.log(`[smoke] ${results.length - failed.length}/${results.length} steps ok (${failed.length} failed)`)
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500)
}

process.on('unhandledRejection', (e) => console.log(`[smoke] unhandledRejection: ${(e && e.stack) || e}`))
main().catch((e) => { record('harness', 'FAIL', (e && e.stack) || String(e)); summary() })
