#!/usr/bin/env node
// scripts/quality-eval/consistency/game-session.mjs: play each character's
// scripted Minecraft session (life.mjs, three days before the probes) through
// the REAL game brain once, and keep what was said as a fixture
// (scripts/fixtures/consistency/game-<char>.json).
//
//   node scripts/quality-eval/consistency/game-session.mjs [--chars sui,roger]
//        [--src <checkout>] [--force]
//
// The scripted player lines go to the live model; small talk from the filler
// fixture is replayed between them as already said (and before the closing
// goodbye), so the session is long
// enough that its key moments are not all in the last few lines (the way a
// 40 minute session reads at its end). Both arms of a comparison replay this
// one fixture: what the brain said in the game is the same input, and what
// each arm does with it at session end (and later) is what gets compared.
//
// Output: { lines: [{who:'player'|'you', text}], remembers: [text],
//           durationMs, game: 'minecraft' }
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCharacters } from '../persona/characters.mjs'
import { LIVES } from './life.mjs'
import { createGameBrain } from './brain.mjs'
import { FIXTURE_DIR } from './gen-filler.mjs'
import { costOf } from '../persona/report.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const CHARS = opt('chars', 'sui,roger').split(',')
const CHARS_DIR = opt('chars-dir', path.join(os.homedir(), 'suisei/eval/characters'))
const SRC = path.resolve(opt('src', path.resolve(HERE, '../../..')))
/** Filler exchanges replayed between two scripted lines, and after the last. */
export const GAP = 2
export const TAIL = 4

function key() {
  return (process.env.ANTHROPIC_API_KEY ?? fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
}

async function main() {
  const chars = loadCharacters(CHARS_DIR, CHARS)
  const usage = []
  for (const ch of chars) {
    const out = path.join(FIXTURE_DIR, `game-${ch.key}.json`)
    if (fs.existsSync(out) && !argv.includes('--force')) { console.log(`exists: ${out}`); continue }
    const L = LIVES[ch.key]
    const filler = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `filler-${ch.key}.json`), 'utf8')).ingame
    const memDir = fs.mkdtempSync(path.join(os.tmpdir(), `ce-game-${ch.key}-`))
    const brain = await createGameBrain({ src: SRC, ch, memDir, key: key(), usage })
    const lines = []
    const remembers = []
    let f = 0
    const replayFiller = async (n) => {
      for (let i = 0; i < n && f < filler.length; i++, f++) {
        const [p, c] = filler[f]
        await brain.primeExchange(p, c)
        lines.push({ who: 'player', text: p }, { who: 'you', text: c })
      }
    }
    for (let t = 0; t < L.game.turns.length; t++) {
      if (t > 0) await replayFiller(t === L.game.turns.length - 1 ? TAIL : GAP)
      const turn = L.game.turns[t]
      const r = await brain.playerTurn(turn.player, turn.snapshot)
      if (r.error) console.warn(`${ch.key} turn ${t}: ${r.error}`)
      lines.push({ who: 'player', text: turn.player })
      for (const s of r.says) lines.push({ who: 'you', text: s })
      remembers.push(...r.remembers)
      console.log(`${ch.key} ${t}: ${turn.player}\n   -> ${r.says.join(' | ') || '(silent)'}${r.remembers.length ? `\n   [remember] ${r.remembers.join(' | ')}` : ''}`)
    }
    fs.writeFileSync(out, JSON.stringify({ game: 'minecraft', durationMs: L.game.minutes * 60_000, lines, remembers }, null, 1) + '\n')
    fs.rmSync(memDir, { recursive: true, force: true })
    console.log(`wrote ${out} (${lines.length} lines, ${remembers.length} remembered)`)
  }
  const cost = usage.reduce((a, u) => a + costOf(u.model, u), 0)
  console.log(`haiku calls ${usage.length}, cost $${cost.toFixed(3)}`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
