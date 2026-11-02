#!/usr/bin/env node
// scripts/decision-eval/run.mjs: live decision-model trials on the
// quality-eval arena (T301). Harness only, over mineflayer; the shipped bot
// is driven through the quality-eval companion (direct mode = its registered
// actions with a stub brain, brain mode = the real Haiku brain).
//
//   node scripts/decision-eval/run.mjs --out DIR --cells "L2/openai:gpt-6-luna@none/cow/3,L1/laya/fight/2"
//
// Levels and deciders:
//   L1/<decider>/fight*   agent bot 'Dex' + 20 Hz reflex motor; the decider
//                         picks attack|flee|eat|back_off|none as fast as it answers
//                         (target 3 Hz). Baselines: L1/scripted (always attack),
//                         L1/idle (never acts), L1/sei-reflex (Sei's companion in
//                         direct mode, idle: her own combat/survival loops only).
//   L2/<decider>/<task>   Sei's companion in direct mode; the decider picks one of
//                         her registered actions with pre-filled args, or complete.
//   L3/<decider>/<task>   agent bot 'Dex' on raw keyboard/mouse-style controls.
//   base/sei/<task>       Sei's companion in brain mode (Haiku), order in chat.
// Deciders: laya | haiku | openai:<model>[@effort].
//
// Writes DIR/trials.jsonl (one row per trial) and DIR/<cell>/r<N>/{steps.jsonl,result.json}.
// Pause between trials by creating ~/suisei/eval/decision/PAUSE (resumes when removed).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serverCtl, cmds, query, itemCount, entityCount } from '../quality-eval/lib/server.mjs'
import { connectPlayer } from '../quality-eval/lib/player.mjs'
import { startCompanion, companionName, PLAYER } from '../quality-eval/lib/companionProc.mjs'
import { WORLD_RULES, arenaReset, playersReset, P, Y } from '../quality-eval/bench/arena.mjs'
import { llmUsage, waitQuiet } from '../quality-eval/bench/runner.mjs'
import { COMPANION_MODEL, costOf } from '../quality-eval/report.mjs'
import { makeDecider, addSpend, spent, CAPS, BudgetExceeded } from './deciders.mjs'
import { connectAgent, startReflexMotor, l3Exec, uiState, clearControls, Vec3 } from './body.mjs'
import { scanObs, L1_OPTIONS, L1_INSTRUCTIONS, formatL1, optionsL2, formatL2, L2_INSTRUCTIONS, optionsL3, formatL3, L3_INSTRUCTIONS, L3_KEYMAP } from './state.mjs'
import { TASKS } from './tasks.mjs'

const argv = process.argv.slice(2)
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const OUT = arg('--out') || path.join(os.homedir(), 'suisei', 'reports', 'decision-model-eval-2026-11-03', 'live')
const CELLS = (arg('--cells') || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const [level, decider, task, reps, capS] = s.split('/')
  if (!TASKS[task]) throw new Error(`unknown task ${task}`)
  return { level, decider, task, reps: Number(reps || 1), capMs: capS ? Number(capS) * 1000 : null }
})
const AGENT = 'Dex'
const PAUSE = path.join(os.homedir(), 'suisei', 'eval', 'decision', 'PAUSE')
const DIRECT_GAP_MS = 800
const L1_HZ = 3
// Laya's English checkpoint truncates at 512 tokens / 192 head tokens; the
// L2/L3 states are longer, so they get the budget the offline pass used.
const LAYA_BUDGET = { L1: {}, L2: { maxLen: 1024, headMaxLen: 384 }, L3: { maxLen: 1024, headMaxLen: 448 } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) }
const safe = (s) => s.replace(/[^\w.@-]+/g, '_')
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ── Laya process accounting (CPU% averaged over the trial, RSS) ─────────
function layaPid() {
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      let c = ''
      try { c = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8') } catch { continue }
      if (/python/.test(c) && /laya_server\.py/.test(c)) return Number(d)
    }
  } catch {}
  return null
}
function procTicks(pid) {
  try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]) } catch { return null }
}
function procRssMb(pid) {
  try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Math.round(Number(m[1]) / 1024) : null } catch { return null }
}

// ── world actors ─────────────────────────────────────────────────────────
let pbot = null
let agent = null
let agentDied = false
async function ensurePlayer() {
  if (pbot && pbot.entity && !pbot._ended) return pbot
  pbot = await connectPlayer()
  pbot.on('end', () => { pbot._ended = true })
  return pbot
}
async function ensureAgent() {
  if (agent && agent.entity && !agent._ended) return agent
  agent = await connectAgent({ username: AGENT })
  agent.on('end', () => { agent._ended = true })
  agent.on('death', () => { agentDied = true })
  return agent
}
function agentObs(task, extra = {}) {
  const o = scanObs(agent, { Vec3 })
  o.entities = o.entities.filter((e) => e.kind !== 'player')
  return { ...o, task: task.text, ...extra }
}
async function compObs(comp, task, extra = {}) {
  const o = await comp.obs()
  if (!o) return null
  o.entities = (o.entities || []).filter((e) => e.kind !== 'player')
  return { ...o, task: task.text, ...extra }
}

async function waitIfPaused() {
  let said = false
  while (fs.existsSync(PAUSE)) {
    if (!said) { log('PAUSE file present, waiting'); said = true }
    await sleep(15000)
  }
  if (said) { log('resumed'); await cmds(WORLD_RULES) }
}

// ── one trial ────────────────────────────────────────────────────────────
async function runTrial(cell, rep) {
  const task = TASKS[cell.task]
  const level = cell.level
  const cellName = `${level}-${safe(cell.decider)}-${cell.task}`
  const tdir = path.join(OUT, cellName, `r${rep}`)
  fs.mkdirSync(tdir, { recursive: true })
  const stepsOut = fs.createWriteStream(path.join(tdir, 'steps.jsonl'))
  const usesComp = level === 'L2' || level === 'base' || (level === 'L1' && cell.decider === 'sei-reflex')
  const decider = ['scripted', 'idle', 'sei-reflex', 'sei'].includes(cell.decider) ? null : makeDecider(cell.decider)
  const budget = decider && cell.decider.startsWith('laya') ? LAYA_BUDGET[level] || {} : {}
  const capMs = cell.capMs || task.timeMs[level === 'base' ? 'base' : level]
  const maxSteps = level === 'L2' ? task.steps.L2 : level === 'L3' ? task.steps.L3 : null
  if (!capMs) throw new Error(`${cell.task} has no time cap for ${level}`)

  await ensurePlayer()
  await cmds([...arenaReset(), ...(task.world || [])])
  let comp = null
  let name = AGENT
  if (usesComp) {
    // A connected agent from an earlier cell must not be a target or a helper.
    if (agent && !agent._ended) await cmds([`gamemode spectator ${AGENT}`, `tp ${AGENT} 150.5 ${Y + 15} -12.5`])
    comp = await startCompanion({ sessDir: tdir, mode: level === 'base' ? 'brain' : 'direct', tag: `de-${cell.task}` })
    name = companionName()
  } else {
    await ensureAgent()
    try { if (agent.currentWindow) agent.closeWindow(agent.currentWindow) } catch {}
    clearControls(agent)
  }
  let died = false
  const deathRe = new RegExp(`^${name} (was|died|drowned|fell|burned|blew|hit|suffocated|starved|walked|tried)`)
  const onMsg = (m) => { if (deathRe.test(m.toString())) died = true }
  pbot.on('message', onMsg)
  agentDied = false

  // One untimed call first: the first Laya inference after idle takes ~13 s
  // and the first HTTPS call pays the TLS handshake.
  if (decider) { try { await decider.choose({ state: 'Warm-up.', instructions: 'Pick one.', options: { a: 'first', b: 'second' } }) } catch {} }

  // The observer: creative (mobs ignore it). Parked off to the side for the
  // decider arms; next to the start for the brain baseline, which takes the
  // order in chat like a player would give it.
  const park = level === 'base'
    ? [`gamemode creative ${PLAYER}`, `tp ${PLAYER} ${P.x + 0.5} ${Y} ${P.z + 3.5}`]
    : [`gamemode creative ${PLAYER}`, `setblock 160 ${Y + 18} 14 barrier`, `tp ${PLAYER} 160.5 ${Y + 19} 14.5`]
  await cmds([...park, ...playersReset([name]), ...task.start(name)])
  if (level === 'base') await waitQuiet(comp)
  else await sleep(1500)
  if (task.atStart) await cmds(task.atStart())
  await sleep(300)

  const laya = decider && cell.decider.startsWith('laya') ? layaPid() : null
  const tick0 = laya ? procTicks(laya) : null
  const lat = [], modelLat = []
  let steps = 0, invalid = 0, costUsd = 0, completeChosen = false, falseComplete = false, goalMet = false
  let last = null, milestone = 0, errors = 0, stopReason = null
  const mem = {}
  const choices = {}
  const t0 = Date.now()
  const left = () => capMs - (Date.now() - t0)
  const isDead = () => died || (comp ? false : agentDied)
  const ctx = {
    itemCount: (it) => itemCount(name, it),
    entityCount,
    obs: async () => (comp ? compObs(comp, task) : agentObs(task)),
    deaths: () => (isDead() ? 1 : 0),
  }
  // "complete" is judged on server truth (the bot's own inventory view can
  // lag a take/craft by a moment). Survival tasks end on the clock, so a
  // complete there is a no-op. Returns true when the trial should stop.
  const judgeComplete = async (oNow) => {
    completeChosen = true
    if (task.survival) return false
    if (oNow) track(oNow)
    if (task.done?.(oNow)) { goalMet = true; stopReason = 'complete'; return true }
    await sleep(1200)
    let f = {}
    try { f = await task.final(ctx) } catch {}
    if (f.full ?? f.success) { goalMet = true; stopReason = 'complete' } else { falseComplete = true; stopReason = 'false complete' }
    return true
  }
  const record = (row) => stepsOut.write(JSON.stringify({ t: Date.now() - t0, ...row }) + '\n')
  const track = (o) => { if (task.progress && o) milestone = Math.max(milestone, task.progress(o, mem)) }
  const decide = async (q) => {
    const r = await decider.choose({ ...q, ...budget })
    steps++
    lat.push(r.ms); if (r.modelMs != null) modelLat.push(r.modelMs)
    costUsd += r.costUsd || 0
    const ok = r.choice && r.choice in q.options
    if (!ok) invalid++
    choices[r.choice] = (choices[r.choice] || 0) + 1
    return { ...r, ok }
  }

  try {
    // ── L1 ────────────────────────────────────────────────────────────
    if (level === 'L1') {
      if (cell.decider === 'sei-reflex') {
        while (left() > 0 && !isDead()) await sleep(500)
      } else {
        const motor = startReflexMotor(agent)
        try {
          if (cell.decider === 'scripted') motor.set('attack')
          while (left() > 0 && !isDead()) {
            if (!decider) { await sleep(500); continue }
            const tStep = Date.now()
            const o = agentObs(task, { reflex: motor.mode, reflexForS: motor.forS, timeLeftS: Math.max(0, Math.round(left() / 1000)), last })
            const q = { state: formatL1(o), instructions: L1_INSTRUCTIONS, options: L1_OPTIONS }
            const r = await decide(q)
            if (r.ok) { motor.set(r.choice); last = `chose ${r.choice}` }
            record({ step: steps, choice: r.choice, ok: r.ok, ms: Math.round(r.ms), modelMs: r.modelMs != null ? Math.round(r.modelMs) : null, hp: Math.round(agent.health ?? 0), hostiles: o.entities.filter((e) => e.kind === 'hostile').length, hits: motor.hits })
            const wait = 1000 / L1_HZ - (Date.now() - tStep)
            if (wait > 0) await sleep(wait)
          }
        } finally { motor.stop() }
      }
      stopReason = isDead() ? 'died' : 'time'
    }

    // ── L2 ────────────────────────────────────────────────────────────
    if (level === 'L2') {
      let lastExecEnd = 0
      while (left() > 0 && steps < maxSteps && !isDead()) {
        const o = await compObs(comp, task, { step: steps + 1, maxSteps, last })
        if (!o) { if (++errors > 3) { stopReason = 'obs failed'; break } await sleep(1000); continue }
        track(o)
        if (task.done?.(o)) { goalMet = true; stopReason = 'goal met'; break }
        const opts = optionsL2(o)
        const q = { state: formatL2(o), instructions: L2_INSTRUCTIONS, options: Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v.desc])) }
        const r = await decide(q)
        const row = { step: steps, choice: r.choice, ok: r.ok, ms: Math.round(r.ms), modelMs: r.modelMs != null ? Math.round(r.modelMs) : null, nOptions: Object.keys(q.options).length, stateChars: q.state.length, milestone, state: q.state }
        if (!r.ok) { last = `invalid choice ${r.choice}`; record({ ...row, result: last }); continue }
        const call = opts[r.choice].call
        if (call === null) {
          const stop = await judgeComplete(await compObs(comp, task))
          record({ ...row, result: stop ? stopReason : 'complete ignored (survival task)' })
          last = stop ? last : 'complete: the fight is not over until the time runs out'
          if (stop) break
          continue
        }
        const results = []
        for (const c of Array.isArray(call) ? call : [call]) {
          if (left() <= 0 || isDead()) break
          if (c.name === '__wait') { await sleep(Math.min(c.args.ms, Math.max(0, left()))); results.push('waited'); continue }
          const gap = DIRECT_GAP_MS - (Date.now() - lastExecEnd)
          if (gap > 0) await sleep(gap)
          const h = comp.execStart(c.name, c.args)
          const tm = setTimeout(() => comp.abort(h.id), Math.max(1000, Math.min(120000, left())))
          const ev = await h.done
          clearTimeout(tm)
          lastExecEnd = Date.now()
          const txt = ev.error ? `error: ${ev.error}` : (ev.result || '')
          results.push(`${c.name}: ${String(txt).slice(0, 220)}`)
          if (ev.error) break
        }
        last = `${r.choice} -> ${results.join(' | ')}`
        record({ ...row, result: last })
      }
      if (!stopReason) stopReason = isDead() ? 'died' : steps >= maxSteps ? 'step cap' : 'time'
    }

    // ── L3 ────────────────────────────────────────────────────────────
    if (level === 'L3') {
      const st = { ui: false }
      while (left() > 0 && steps < maxSteps && !isDead()) {
        const o = agentObs(task, { step: steps + 1, maxSteps, last })
        o.ui = uiState(agent, st.ui)
        // An item held on the UI cursor is still hers (closing returns it).
        const withCursor = o.ui?.cursor ? { ...o, self: { ...o.self, inv: { ...o.self.inv, [o.ui.cursor.name]: (o.self.inv[o.ui.cursor.name] || 0) + o.ui.cursor.count } } } : o
        track(withCursor)
        if (task.done?.(withCursor)) { goalMet = true; stopReason = 'goal met'; break }
        const options = optionsL3(o)
        const q = { state: formatL3(o), instructions: L3_INSTRUCTIONS, options }
        const r = await decide(q)
        const row = { step: steps, choice: r.choice, ok: r.ok, ms: Math.round(r.ms), modelMs: r.modelMs != null ? Math.round(r.modelMs) : null, nOptions: Object.keys(options).length, stateChars: q.state.length, milestone, state: q.state.replace(L3_KEYMAP, '[keymap]') }
        if (!r.ok) { last = `invalid choice ${r.choice}`; record({ ...row, result: last }); continue }
        if (r.choice === 'complete') {
          const u2 = uiState(agent, st.ui)
          const o2 = agentObs(task)
          if (u2?.cursor) o2.self.inv[u2.cursor.name] = (o2.self.inv[u2.cursor.name] || 0) + u2.cursor.count
          const stop = await judgeComplete(o2)
          record({ ...row, result: stop ? stopReason : 'complete ignored (survival task)' })
          last = stop ? last : 'complete: the fight is not over until the time runs out'
          if (stop) break
          continue
        }
        last = `${r.choice}: ${await l3Exec(agent, r.choice, st)}`
        record({ ...row, result: last })
      }
      try { if (agent.currentWindow) agent.closeWindow(agent.currentWindow) } catch {}
      clearControls(agent)
      if (!stopReason) stopReason = isDead() ? 'died' : steps >= maxSteps ? 'step cap' : 'time'
    }

    // ── Sei baseline (brain mode) ─────────────────────────────────────
    if (level === 'base') {
      pbot.chat(task.text)
      while (left() > 0 && !isDead()) {
        await sleep(2000)
        const o = await compObs(comp, task)
        if (!o) continue
        track(o)
        record({ step: ++steps, milestone, pos: o.self.pos, inv: o.self.inv })
        if (task.done?.(o)) { goalMet = true; stopReason = 'goal met'; break }
      }
      if (!stopReason) stopReason = isDead() ? 'died' : 'time'
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) stopReason = `budget: ${e.message}`
    else stopReason = `crash: ${String(e?.stack || e).slice(0, 400)}`
  }
  const timeMs = Date.now() - t0

  // ── server truth ────────────────────────────────────────────────────
  let fin = {}
  try { fin = await task.final(ctx) } catch (e) { fin = { success: false, detail: `final failed: ${e?.message}` } }
  const fm = task.finalMilestone?.(fin)
  if (fm != null) milestone = Math.max(milestone, fm)
  if (fin.milestone != null) milestone = fin.milestone
  else if (task.progress) {
    // The server count can show what the last obs missed (an item landing late).
    const o = await ctx.obs().catch(() => null)
    if (o) track(o)
  }

  let llm = null
  if (level === 'base' || (level === 'L1' && cell.decider === 'sei-reflex') || level === 'L2') {
    llm = llmUsage(comp.log)
    const c = costOf(COMPANION_MODEL, llm)
    if (c > 0) { addSpend('anthropic', c); costUsd += c }
  }
  const tick1 = laya ? procTicks(laya) : null
  const clk = 100
  const result = {
    level, decider: cell.decider, task: cell.task, rep,
    success: !!fin.success, value: fin.value ?? null, detail: fin.detail ?? null, extra: { smelted: fin.smelted, killed: fin.killed },
    milestone, milestones: task.milestones.length, milestoneLabel: milestone ? task.milestones[Math.min(milestone, task.milestones.length) - 1] : 'none',
    stopReason, died: isDead(), goalMet, completeChosen, falseComplete,
    timeMs, steps, invalid, decisionsPerSec: steps ? Number((steps / (timeMs / 1000)).toFixed(2)) : 0,
    latP50: pct(lat, 0.5), latP95: pct(lat, 0.95), modelP50: pct(modelLat, 0.5), modelP95: pct(modelLat, 0.95),
    costUsd: Number(costUsd.toFixed(5)), usdPerHour: Number((costUsd / (timeMs / 3.6e6)).toFixed(4)),
    layaCpuPct: laya && tick0 != null && tick1 != null ? Math.round(((tick1 - tick0) / clk) / (timeMs / 1000) * 100) : null,
    layaRssMb: laya ? procRssMb(laya) : null,
    choices, llm, bootMs: comp?.bootMs ?? null,
    chat: comp ? comp.log.filter((e) => e.kind === 'chat_out' && e.t >= t0).map((e) => e.text).slice(0, 10) : null,
    actions: comp && level === 'base' ? comp.log.filter((e) => e.kind === 'action_call' && e.t >= t0 && !['thinking', 'say', 'remember', 'forget', 'setGoal', 'clearGoal', 'end_loop'].includes(e.name)).map((e) => e.name) : null,
  }
  fs.writeFileSync(path.join(tdir, 'result.json'), JSON.stringify(result, null, 2))
  fs.appendFileSync(path.join(OUT, 'trials.jsonl'), JSON.stringify(result) + '\n')
  await new Promise((r) => stepsOut.end(r))
  pbot.off('message', onMsg)
  if (comp) await comp.stop().catch(() => {})
  return result
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  if (!CELLS.length) throw new Error('no --cells')
  const st = serverCtl('status')
  if (!/running/.test(st)) { log('starting MC server'); serverCtl('start') }
  await cmds(WORLD_RULES)
  await ensurePlayer()
  log(`cells: ${CELLS.map((c) => `${c.level}/${c.decider}/${c.task}x${c.reps}${c.capMs ? `@${c.capMs / 1000}s` : ''}`).join(' ')}`)
  for (const cell of CELLS) {
    for (let rep = 1; rep <= cell.reps; rep++) {
      await waitIfPaused()
      if (cell.decider.startsWith('openai') && spent('openai') >= CAPS.openai) { log(`SKIP ${cell.level}/${cell.decider}/${cell.task}: openai cap`); continue }
      if ((cell.decider === 'haiku' || cell.level === 'base' || cell.level === 'L2') && spent('anthropic') >= CAPS.anthropic) { log(`SKIP ${cell.level}/${cell.decider}/${cell.task}: anthropic cap`); continue }
      log(`>> ${cell.level}/${cell.decider}/${cell.task} r${rep}`)
      let r
      try { r = await runTrial(cell, rep) } catch (e) { log(`trial failed: ${e?.stack || e}`); continue }
      log(`<< ${r.success ? 'OK  ' : 'FAIL'} ${r.level}/${r.decider}/${r.task} r${rep}: ${r.detail}; milestone ${r.milestone}/${r.milestones} (${r.milestoneLabel}); ${r.stopReason}; ${Math.round(r.timeMs / 1000)}s, ${r.steps} steps, inv ${r.invalid}, p50 ${r.latP50} ms, $${r.costUsd}  [openai $${spent('openai').toFixed(4)} anth $${spent('anthropic').toFixed(4)}]`)
    }
  }
  try { agent?.quit() } catch {}
  try { pbot?.quit() } catch {}
  await sleep(500)
}

main().then(() => process.exit(0), (e) => { console.error(e?.stack || e); process.exit(1) })
