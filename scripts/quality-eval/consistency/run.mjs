#!/usr/bin/env node
// scripts/quality-eval/consistency/run.mjs: the cross-surface consistency
// eval (v0.7 character consistency, report section "Consistency eval").
//
//   node scripts/quality-eval/consistency/run.mjs --compare <refA> <refB>
//        [--mode pipeline|static] [--reps 3] [--history-n 20]
//        [--chars sui,roger] [--surfaces text,voice,mc] [--probes A1,C1]
//        [--concurrency 4] [--out DIR]
//   node scripts/quality-eval/consistency/run.mjs --ref <ref> ...   (one arm)
//
// Each character lives a scripted life (life.mjs): old memory notes, a text
// chat 5 days ago, a Minecraft session 3 days ago played through the real
// game brain (fixture from game-session.mjs), a voice call yesterday, then
// --history-n exchanges of today's chat. Then the probes (two per category
// A..F) are asked on a text chat, a voice call and in a new Minecraft
// session, and Opus grades the answers against the life (judge.mjs).
//
// pipeline: each arm lives the life with its own code (folds, session-end
//   call, play row, memory writes), so write-side changes show up.
// static: arm A lives the life once per rep and both arms answer from that
//   same stored state, so only read-side changes (prompt assembly) show up.
// --history-n 20 or more is the long-session mode: today's chat pushes older
//   rows through another fold before the probes.
//
// Refs are prepared like scorecard.mjs (detached worktrees under
// ~/suisei/eval/refs/<sha12>, node_modules linked from this checkout);
// "." or WORKTREE is this checkout. The key comes from ANTHROPIC_API_KEY or
// ~/.sei-dev/anthropic-test-key and is passed to the children in their
// environment only. Analytics: the arms never load the PostHog client, and
// POSTHOG_KEY is removed from their environment anyway.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadCharacters } from '../persona/characters.mjs'
import { LIVES } from './life.mjs'
import { judgeArm, makeJudgeClient } from './judge.mjs'
import { render } from './report.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const harnessRepo = path.resolve(HERE, '../../..')
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const MODE = opt('mode', 'pipeline')
const REPS = Number(opt('reps', 3))
const HISTORY_N = Number(opt('history-n', 20))
const CHARS = opt('chars', 'sui,roger').split(',')
const SURFACES = opt('surfaces', 'text,voice,mc')
const PROBES = opt('probes', null)
const CONC = Number(opt('concurrency', 4))
const CHARS_DIR = opt('chars-dir', path.join(os.homedir(), 'suisei/eval/characters'))
const date = new Date().toISOString().slice(0, 10)
const OUT = path.resolve(opt('out', path.join(os.homedir(), 'suisei', 'reports', 'quality', `${date}-consistency-${MODE}`)))
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`)

const git = (...a) => execFileSync('git', ['-C', harnessRepo, ...a], { encoding: 'utf8' }).trim()
function prepareRef(ref) {
  if (ref === '.' || ref === 'WORKTREE') return { ref: 'WORKTREE', sha: git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--', 'src') ? '+dirty' : ''), repo: harnessRepo }
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`)
  const dir = path.join(os.homedir(), 'suisei', 'eval', 'refs', sha.slice(0, 12))
  if (!fs.existsSync(path.join(dir, 'src', 'bot', 'index.js'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    git('worktree', 'add', '--detach', dir, sha)
  }
  const nm = path.join(dir, 'node_modules')
  if (!fs.existsSync(nm)) fs.symlinkSync(fs.realpathSync(path.join(harnessRepo, 'node_modules')), nm)
  return { ref, sha, repo: dir }
}

function apiKey() {
  return (process.env.ANTHROPIC_API_KEY ?? fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8')).trim()
}

function runArm(args, logFile) {
  const env = { ...process.env, ANTHROPIC_API_KEY: apiKey() }
  delete env.POSTHOG_KEY
  return new Promise((resolve, reject) => {
    const out = fs.openSync(logFile, 'a')
    const child = spawn('npx', ['tsx', path.join(HERE, 'arm.ts'), ...args], { cwd: harnessRepo, env, stdio: ['ignore', out, out] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000)
    child.on('exit', (code) => { clearTimeout(timer); fs.closeSync(out); code === 0 ? resolve() : reject(new Error(`arm ${args.join(' ')} exited ${code}, see ${logFile}`)) })
  })
}

async function pool(tasks, n) {
  const results = []
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const t = tasks[i++]; results.push(await t()) }
  }))
  return results
}

async function main() {
  const cmpI = argv.indexOf('--compare')
  const refs = cmpI >= 0 ? [prepareRef(argv[cmpI + 1]), prepareRef(argv[cmpI + 2])] : [prepareRef(opt('ref', 'WORKTREE'))]
  refs.forEach((r, i) => { r.label = refs.length === 2 ? 'AB'[i] : 'A' })
  fs.mkdirSync(OUT, { recursive: true })
  const config = { started: new Date().toISOString(), mode: MODE, reps: REPS, historyN: HISTORY_N, chars: CHARS, surfaces: SURFACES, probes: PROBES, arms: refs }
  fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(config, null, 2))
  log(`out ${OUT}; ${refs.map((r) => `${r.label}=${r.ref}@${r.sha.slice(0, 9)}`).join(' ')}; ${MODE}, reps ${REPS}, history-n ${HISTORY_N}`)
  const logFile = path.join(OUT, 'arms.log')
  const stateDir = (arm, ch, rep) => path.join(OUT, 'state', `${arm}-${ch}-${rep}`)
  const common = ['--history-n', String(HISTORY_N), '--chars-dir', CHARS_DIR]

  // 1. build each life (static: arm A's build is shared by both arms)
  const builds = []
  for (const ch of CHARS) for (let rep = 0; rep < REPS; rep++) {
    for (const r of MODE === 'static' ? [refs[0]] : refs) {
      builds.push(async () => {
        await runArm(['--src', r.repo, '--phase', 'build', '--state', stateDir(r.label, ch, rep), '--char', ch, ...common], logFile)
        log(`built ${r.label} ${ch} rep ${rep}`)
      })
    }
  }
  await pool(builds, CONC)
  if (MODE === 'static' && refs.length === 2) {
    for (const ch of CHARS) for (let rep = 0; rep < REPS; rep++) fs.cpSync(stateDir('A', ch, rep), stateDir('B', ch, rep), { recursive: true })
  }

  // 2. probes
  const probes = []
  for (const ch of CHARS) for (let rep = 0; rep < REPS; rep++) for (const r of refs) {
    probes.push(async () => {
      const out = path.join(OUT, 'answers', `${r.label}-${ch}-${rep}.jsonl`)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      await runArm(['--src', r.repo, '--phase', 'probe', '--state', stateDir(r.label, ch, rep), '--char', ch, '--out', out, '--surfaces', SURFACES, ...(PROBES ? ['--probes', PROBES] : []), ...common], logFile)
      log(`probed ${r.label} ${ch} rep ${rep}`)
    })
  }
  await pool(probes, CONC)

  // 3. judge, one call per (arm, char, rep)
  const client = makeJudgeClient(apiKey())
  const chars = Object.fromEntries(loadCharacters(CHARS_DIR, CHARS).map((c) => [c.key, c]))
  const graded = { answers: [], questions: [], usage: [] }
  const catOf = (ch, id) => LIVES[ch].probes.find((p) => p.id === id)?.cat
  const jobs = []
  for (const ch of CHARS) for (let rep = 0; rep < REPS; rep++) for (const r of refs) {
    jobs.push(async () => {
      const answers = fs.readFileSync(path.join(OUT, 'answers', `${r.label}-${ch}-${rep}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const j = await judgeArm({ client, ch: chars[ch], answers })
      for (const a of j.answers) graded.answers.push({ ...a, arm: r.label, char: ch, rep, cat: catOf(ch, a.probe) })
      for (const q of j.questions) graded.questions.push({ ...q, arm: r.label, char: ch, rep, cat: catOf(ch, q.probe) })
      graded.usage.push(j.usage)
      log(`judged ${r.label} ${ch} rep ${rep}`)
    })
  }
  await pool(jobs, CONC)

  // usage of the arms (builds + probes)
  const stateRoot = path.join(OUT, 'state')
  for (const d of fs.readdirSync(stateRoot)) {
    const f = path.join(stateRoot, d, 'usage.json')
    if (fs.existsSync(f) && !(MODE === 'static' && d.startsWith('B-'))) graded.usage.push(...JSON.parse(fs.readFileSync(f, 'utf8')))
  }
  for (const f of fs.readdirSync(path.join(OUT, 'answers')).filter((f) => f.endsWith('.usage.json'))) {
    graded.usage.push(...JSON.parse(fs.readFileSync(path.join(OUT, 'answers', f), 'utf8')))
  }
  fs.writeFileSync(path.join(OUT, 'graded.json'), JSON.stringify(graded, null, 1))
  const text = render(OUT)
  fs.writeFileSync(path.join(OUT, 'report.txt'), text + '\n')
  console.log(text)
}

main().catch((e) => { console.error(e); process.exit(1) })
