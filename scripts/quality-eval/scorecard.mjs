#!/usr/bin/env node
// scripts/quality-eval/scorecard.mjs: the nightly companion-quality scorecard.
//
// Three suites, from most to least deterministic:
//   micro     action micro-benchmarks (bench/micro.mjs): fixed arena states,
//             one direct order, success read from the server. Each benchmark
//             runs in brain mode (real Haiku decides) and direct mode (the
//             actions are called straight, no LLM) so skill and brain
//             failures separate.
//   convo     scripted conversations (bench/convo.mjs): a non-LLM player says
//             the same lines every run; Opus labels the response to each line.
//   freeplay  the original LLM-player scenarios (scenarios.mjs), repeated.
//
// Every number gets a 95% interval; summary.md flags a change as real only
// when it falls outside the interval.
//
//   node scripts/quality-eval/scorecard.mjs                full nightly (~2h, ~$1.60)
//   node scripts/quality-eval/scorecard.mjs --quick        quick subset (~30 min, ~$0.30)
//   node scripts/quality-eval/scorecard.mjs --compare <refA> <refB>
//        run both git refs on identical worlds/scripts/seeds, interleaved
//        trial by trial, and report deltas with intervals
//   node scripts/quality-eval/scorecard.mjs --compare-runs <dirA> <dirB>
//        compare two finished scorecards (e.g. the same ref run twice)
//   node scripts/quality-eval/scorecard.mjs --report <dir>  rebuild summary.md
//
// Knobs: --out DIR, --suites micro,convo,freeplay, --modes brain,direct,
// --bench id,id, --brain-reps N, --direct-reps N, --convo-reps N,
// --scripts id,id, --fp-reps N, --fp-minutes N, --fp-scenarios id,id,
// --skip-judge, --char-b FILE (compare: arm B plays this character file;
// the judge keeps the default card). Output: ~/suisei/reports/quality/<date>-scorecard[-quick]/.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { MICRO, QUICK_MICRO } from './bench/micro.mjs'
import { CONVO, QUICK_CONVO } from './bench/convo.mjs'
import { WORLD_RULES } from './bench/arena.mjs'
import { runMicroTrial, llmUsage } from './bench/runner.mjs'
import { runConvoSession } from './bench/convoRunner.mjs'
import { judgeConvoSession } from './bench/convoJudge.mjs'
import { SCENARIOS } from './scenarios.mjs'
import { judgeSession } from './judge.mjs'
import { loadSession } from './transcript.mjs'
import { COMPANION_MODEL, costOf } from './report.mjs'
import { serverCtl, cmds, MC_DIR } from './lib/server.mjs'
import { connectPlayer } from './lib/player.mjs'
import { KEY_FILE } from './lib/companionProc.mjs'
import { rng } from './lib/stats.mjs'
import { computeScorecard, compareScorecards, loadRows } from './lib/scorecard.mjs'
import { writeScorecardReport, writeCompareReport } from './lib/scorecardReport.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const harnessRepo = path.resolve(here, '..', '..')
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const list = (n, d) => { const v = opt(n, null); return v ? v.split(',').filter(Boolean) : d }
const log = (...a) => console.log(`[sc ${new Date().toISOString().slice(11, 19)}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const QUICK = flag('quick')
const date = new Date().toISOString().slice(0, 10)

// Defaults sized for the nightly budget (~2.5h, under $8); see summary.md.
const CFG = {
  suites: list('suites', QUICK ? ['micro', 'convo'] : ['micro', 'convo', 'freeplay']),
  modes: list('modes', ['brain', 'direct']),
  bench: list('bench', QUICK ? QUICK_MICRO : MICRO.map((b) => b.id)),
  brainReps: Number(opt('brain-reps', QUICK ? 6 : 5)),
  directReps: Number(opt('direct-reps', QUICK ? 2 : 3)),
  convoReps: Number(opt('convo-reps', 3)),
  scripts: list('scripts', QUICK ? QUICK_CONVO : CONVO.map((c) => c.id)),
  fpReps: Number(opt('fp-reps', 2)),
  fpMinutes: Number(opt('fp-minutes', 7)),
  fpScenarios: list('fp-scenarios', ['gather_craft', 'combat_night']),
  skipJudge: flag('skip-judge'),
}

// ── refs (compare mode) ─────────────────────────────────────────────────
function git(...a) { return execFileSync('git', ['-C', harnessRepo, ...a], { encoding: 'utf8' }).trim() }

function prepareRef(ref) {
  if (ref === '.' || ref === 'WORKTREE') return { ref: 'WORKTREE', sha: git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--', 'src') ? '+dirty' : ''), repo: harnessRepo }
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`)
  const dir = path.join(os.homedir(), 'suisei', 'eval', 'refs', sha.slice(0, 12))
  if (!fs.existsSync(path.join(dir, 'src', 'bot', 'index.js'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    git('worktree', 'add', '--detach', dir, sha)
  }
  // Deps come from the harness checkout; refs whose package.json differs may
  // need their own `npm ci` (reported in config.json).
  const nm = path.join(dir, 'node_modules')
  if (!fs.existsSync(nm)) fs.symlinkSync(fs.realpathSync(path.join(harnessRepo, 'node_modules')), nm)
  let depsDiffer = false
  try { depsDiffer = execFileSync('git', ['-C', harnessRepo, 'diff', '--quiet', sha, 'HEAD', '--', 'package-lock.json']).length > 0 } catch { depsDiffer = true }
  return { ref, sha, repo: dir, depsDiffer }
}

// ── judge queue (runs while the next session plays) ─────────────────────
function judgeQueue(limit = 2) {
  const pending = []
  let active = 0
  const queue = []
  const pump = () => {
    while (active < limit && queue.length) {
      const { fn, resolve } = queue.shift()
      active++
      fn().catch((e) => log(`judge failed: ${e?.message}`)).finally(() => { active--; resolve(); pump() })
    }
  }
  return {
    add(fn) { pending.push(new Promise((resolve) => { queue.push({ fn, resolve }); pump() })) },
    drain: () => Promise.all(pending),
  }
}

async function main() {
  if (flag('compare-runs')) {
    const i = argv.indexOf('--compare-runs')
    const [a, b] = [argv[i + 1], argv[i + 2]].map((d) => path.resolve(d))
    const out = path.resolve(opt('out', b))
    const sa = JSON.parse(fs.readFileSync(path.join(a, 'scorecard.json'), 'utf8'))
    const sb = JSON.parse(fs.readFileSync(path.join(b, 'scorecard.json'), 'utf8'))
    const A = Object.values(sa.byRef)[0], B = Object.values(sb.byRef)[0]
    const cmp = compareScorecards(A, B)
    writeCompareReport(path.join(out, 'compare.md'), { labelA: path.basename(a), labelB: path.basename(b), A, B, cmp })
    log(`wrote ${path.join(out, 'compare.md')}`)
    return
  }
  if (flag('report')) {
    const dir = path.resolve(opt('report'))
    await finish(dir, JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')))
    return
  }

  const cmpI = argv.indexOf('--compare')
  const refs = cmpI >= 0 ? [prepareRef(argv[cmpI + 1]), prepareRef(argv[cmpI + 2])] : [prepareRef(opt('ref', 'WORKTREE'))]
  if (refs.length === 2) { refs[0].label = 'A'; refs[1].label = 'B' } else refs[0].label = 'run'
  // --char-b FILE: arm B plays a different character file (a proposed card
  // edit, the bot code otherwise as its ref). The judge keeps arm A's card.
  const charB = opt('char-b', null)
  if (charB) {
    if (refs.length !== 2) throw new Error('--char-b needs --compare')
    refs[1].character = path.resolve(charB)
    process.env.QE_CHARACTER_BY_REPO = JSON.stringify({ [refs[1].repo]: refs[1].character })
  }
  const OUT = path.resolve(opt('out', path.join(os.homedir(), 'suisei', 'reports', 'quality', `${date}-scorecard${QUICK ? '-quick' : ''}${refs.length === 2 ? '-compare' : ''}`)))
  fs.mkdirSync(OUT, { recursive: true })
  const config = { started: new Date().toISOString(), quick: QUICK, cfg: CFG, refs, argv, suiteSeconds: {} }
  fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(config, null, 2))
  fs.writeFileSync(path.join(OUT, 'results.jsonl'), '')
  const addRow = (r) => fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify(r) + '\n')
  log(`output ${OUT}; refs ${refs.map((r) => `${r.label}=${r.ref}@${r.sha.slice(0, 9)}`).join(' ')}`)

  const anthropic = new Anthropic({ apiKey: fs.readFileSync(KEY_FILE, 'utf8').trim(), maxRetries: 3, timeout: 600000 })
  const judges = judgeQueue(2)

  if (!fs.existsSync(path.join(MC_DIR, 'eula.txt'))) serverCtl('setup')
  serverCtl('reset')
  serverCtl('start')
  await sleep(1000)

  // ── micro + convo share one scripted player connection ──
  if (CFG.suites.includes('micro') || CFG.suites.includes('convo')) {
    const pbot = await connectPlayer()
    await cmds(WORLD_RULES)
    if (CFG.suites.includes('micro')) {
      const t0 = Date.now()
      const benches = CFG.bench.map((id) => MICRO.find((b) => b.id === id)).filter(Boolean)
      const maxReps = Math.max(CFG.modes.includes('brain') ? CFG.brainReps : 0, CFG.modes.includes('direct') ? CFG.directReps : 0)
      for (let rep = 1; rep <= maxReps; rep++) {
        for (const b of benches) for (const mode of CFG.modes) {
          if (rep > (mode === 'brain' ? CFG.brainReps : CFG.directReps)) continue
          for (const R of refs) {
            const r = await runMicroTrial(b, { mode, rep, pbot, botRepo: R.repo, outDir: path.join(OUT, 'micro', b.id), ref: refs.length === 2 ? R.label : 'HEAD' })
            addRow({ suite: 'micro', refLabel: R.label, ...r, trace: undefined })
            log(`micro ${b.id} ${mode} #${rep}${refs.length === 2 ? ` [${R.label}]` : ''}: ${r.invalid ? 'INVALID' : r.success ? 'ok' : 'FAIL'} ${r.detail ?? ''} (${((r.timeMs ?? 0) / 1000).toFixed(0)}s)`)
          }
        }
      }
      config.suiteSeconds.micro = Math.round((Date.now() - t0) / 1000)
    }
    if (CFG.suites.includes('convo')) {
      const t0 = Date.now()
      const scripts = CFG.scripts.map((id) => CONVO.find((c) => c.id === id)).filter(Boolean)
      for (let rep = 1; rep <= CFG.convoReps; rep++) for (const s of scripts) for (const R of refs) {
        const dir = await runConvoSession(s, { rep, pbot, botRepo: R.repo, outDir: path.join(OUT, 'convo'), ref: refs.length === 2 ? R.label : 'HEAD' })
        const ev = fs.readFileSync(path.join(dir, 'companion.events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        addRow({ suite: 'convo', refLabel: R.label, id: path.basename(dir), script: s.id, rep, dir, companionCost: costOf(COMPANION_MODEL, llmUsage(ev)) })
        log(`convo ${s.id} #${rep}${refs.length === 2 ? ` [${R.label}]` : ''}: played`)
        if (!CFG.skipJudge) judges.add(async () => { const l = await judgeConvoSession(anthropic, dir); log(`judged ${path.basename(dir)}: ${l.labels.filter((x) => x.label === 'off').length}/${l.labels.length} off`) })
      }
      config.suiteSeconds.convo = Math.round((Date.now() - t0) / 1000)
    }
    pbot.quit()
    await sleep(1500)
  }

  // ── free play (its own player bot; resets the world per session) ──
  if (CFG.suites.includes('freeplay')) {
    const t0 = Date.now()
    const { runSession } = await import('./run.mjs')
    const scen = CFG.fpScenarios.map((id) => SCENARIOS.find((s) => s.id === id)).filter(Boolean)
    for (let rep = 1; rep <= CFG.fpReps; rep++) for (const sc of scen) for (const R of refs) {
      const id = `${sc.id}-${String(rep).padStart(2, '0')}${refs.length === 2 ? `-${R.label}` : ''}`
      const dir = path.join(OUT, 'freeplay', id)
      // Same seed for both refs and every rerun: the player's coin flips match.
      const seed = [...`${sc.id}:${rep}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
      try {
        const r = await runSession(sc, dir, { minutes: CFG.fpMinutes, rng: rng(seed), botRepo: R.repo })
        if (!r.ok) { log(`freeplay ${id}: companion failed`); continue }
      } catch (e) { log(`freeplay ${id} crashed: ${e?.message}`); continue }
      const sess = loadSession(dir)
      addRow({ suite: 'freeplay', refLabel: R.label, id, scenario: sc.id, rep, dir, minutes: CFG.fpMinutes, companionCost: costOf(COMPANION_MODEL, sess.usage), playerCost: costOf('claude-haiku-5-5', sess.meta.usage?.player) })
      log(`freeplay ${id}: played`)
      if (!CFG.skipJudge) judges.add(async () => { const l = await judgeSession(anthropic, dir); log(`judged ${id}: ${l.labels.filter((x) => x.label === 'off').length}/${l.labels.length} off`) })
    }
    config.suiteSeconds.freeplay = Math.round((Date.now() - t0) / 1000)
  }
  try { serverCtl('stop') } catch {}
  const tj = Date.now()
  await judges.drain()
  config.suiteSeconds.judgeTail = Math.round((Date.now() - tj) / 1000)
  config.finished = new Date().toISOString()
  config.wallSeconds = Math.round((Date.parse(config.finished) - Date.parse(config.started)) / 1000)
  fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(config, null, 2))
  await finish(OUT, config)
}

async function finish(OUT, config) {
  const rows = loadRows(OUT)
  const byRef = {}
  for (const R of config.refs) byRef[R.label] = computeScorecard(rows.filter((r) => r.refLabel === R.label))
  const cmp = config.refs.length === 2 ? compareScorecards(byRef.A, byRef.B) : null
  fs.writeFileSync(path.join(OUT, 'scorecard.json'), JSON.stringify({ config, byRef, compare: cmp }, null, 2))
  writeScorecardReport(path.join(OUT, 'summary.md'), { config, byRef, cmp, rows })
  log(`report: ${path.join(OUT, 'summary.md')}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
