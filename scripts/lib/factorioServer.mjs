// scripts/lib/factorioServer.mjs: start a throwaway Factorio headless server
// with the sei-companion mod, the Lua UDP link and RCON, for the headless
// harness and the brain session probe. Linux headless build only (download
// the free headless tarball into ~/.cache/sei-factorio/<version>/).

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import dgram from 'node:dgram'
import { connectRcon } from './factorioRcon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const MOD_DIR = join(here, '..', '..', 'native', 'factorio-mod', 'sei-companion')

export function defaultBin() {
  const root = join(homedir(), '.cache', 'sei-factorio')
  if (!existsSync(root)) return null
  const vers = readdirSync(root).filter((d) => /^2\.1\.\d+$/.test(d)).sort((a, b) => Number(a.split('.')[2]) - Number(b.split('.')[2]))
  return vers.length ? join(root, vers.at(-1), 'factorio', 'bin', 'x64', 'factorio') : null
}

export function freePort(type = 'tcp') {
  return new Promise((resolve, reject) => {
    if (type === 'udp') {
      const s = dgram.createSocket('udp4')
      s.on('error', reject)
      s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
      return
    }
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {{ bin: string, speed?: number, seed?: number, keep?: boolean }} opts
 * @returns {Promise<{ udpPort: number, run: string, rc: any, lua: (code: string) => Promise<any>, J: (expr: string) => string, L: (code: string, expr: string) => Promise<any>, log: () => string, stop: () => void }>}
 */
export async function startFactorioServer({ bin, speed = 1, seed = 424242, keep = false }) {
  if (!bin || !existsSync(bin)) throw new Error('no Factorio headless binary; pass --factorio <path>')
  const run = mkdtempSync(join(tmpdir(), 'sei-factorio-'))
  mkdirSync(join(run, 'mods'))
  symlinkSync(MOD_DIR, join(run, 'mods', 'sei-companion'))
  writeFileSync(join(run, 'mods', 'mod-list.json'), JSON.stringify({
    mods: [
      { name: 'base', enabled: true }, { name: 'sei-companion', enabled: true },
      { name: 'space-age', enabled: false }, { name: 'quality', enabled: false }, { name: 'elevated-rails', enabled: false },
    ],
  }))
  writeFileSync(join(run, 'server-settings.json'), JSON.stringify({
    name: 'sei-test', description: '', visibility: { public: false, lan: false }, require_user_verification: false,
    auto_pause: false, autosave_interval: 0, max_players: 4,
  }))
  // A fixed seed keeps the starting area the same between runs.
  const save = join(run, 'test.zip')
  execFileSync(bin, ['--create', save, '--mod-directory', join(run, 'mods'), '--map-gen-seed', String(seed)], { cwd: run, stdio: 'ignore', timeout: 120_000 })

  const udpPort = await freePort('udp')
  const rconPort = await freePort()
  const gamePort = await freePort('udp')
  const server = spawn(bin, ['--start-server', save, '--mod-directory', join(run, 'mods'), '--server-settings', join(run, 'server-settings.json'),
    `--enable-lua-udp=${udpPort}`, '--port', String(gamePort), '--rcon-bind', `127.0.0.1:${rconPort}`, '--rcon-password', 'seitest'],
  { cwd: run, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = ''
  server.stdout.on('data', (d) => { serverLog += d })
  server.stderr.on('data', (d) => { serverLog += d })
  let stopped = false
  let rc = null
  const stop = () => {
    if (stopped) return
    stopped = true
    try { rc?.close() } catch {}
    try { server.kill('SIGTERM') } catch {}
    if (!keep) setTimeout(() => { try { rmSync(run, { recursive: true, force: true }) } catch {} }, 1500).unref?.()
  }
  process.on('exit', () => { try { server.kill('SIGTERM') } catch {} })

  for (let i = 0; i < 100 && !/Starting RCON interface/.test(serverLog); i++) await sleep(200)
  if (!/Starting RCON interface/.test(serverLog)) { stop(); throw new Error(`server did not start:\n${serverLog.slice(-3000)}`) }

  rc = await connectRcon({ port: rconPort, password: 'seitest' })
  await rc.lua('rcon.print(1)') // the first /sc only warns about achievements
  async function lua(code) {
    const out = await rc.lua(code)
    if (!out) return null
    try { return JSON.parse(out) } catch { return out }
  }
  const J = (expr) => `rcon.print(helpers.table_to_json({v = ${expr}}))`
  const L = async (code, expr) => (await lua(`${code} ${J(expr)}`))?.v
  await lua(`game.speed = ${speed} game.forces.enemy.set_cease_fire('player', false) ${J('1')}`)
  return { udpPort, run, rc, lua, J, L, log: () => serverLog, stop }
}
