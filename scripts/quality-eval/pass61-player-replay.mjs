// scripts/quality-eval/pass61-player-replay.mjs: quality pass 61, the
// free-play player's realism in combat_night, without a Minecraft server.
//
// Replays the player's reaction points (trigger companion_spoke) of recorded
// combat_night sessions: the chat, the player's own lines, her distance (the
// 30 s world tick) and health as they were, and asks the player model again
// with the old prompt (run.mjs before pass 61, copied here) and the new one
// (lib/playerBrain.mjs, with the repeat backstop). Measures, per arm:
//   said      share of points where the player typed something
//   stay      share that is a stay-close / don't-leave ask (a word check, for
//             this analysis only)
//   stayNear  the same, among points where she was within 4 blocks
//   stayFar   the same, among points where she was more than 6 blocks away
//             (must not drop: asking her back when she is far is real)
//   copy      share that is a near copy (word overlap >= 0.5) of one of the
//             player's own last 4 lines
//
//   node scripts/quality-eval/pass61-player-replay.mjs --out DIR [--max 120] RUN_DIR...
//
// Key: ~/.sei-dev/anthropic-test-key (or QE_KEY_FILE), never printed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { PRICES } from './report.mjs'
import { SCENARIOS } from './scenarios.mjs'
import { playerSystem, playerAsk, repeatedBit, redoNote, stillRepeats } from './lib/playerBrain.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const OUT = opt('out')
const MAX = Number(opt('max', 120))
const RUNS = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
if (!OUT || !RUNS.length) { console.error('usage: --out DIR [--max N] RUN_DIR...'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const MODEL = 'claude-haiku-5-5'
const P = PRICES[MODEL]
const anthropic = new Anthropic({ apiKey: fs.readFileSync(process.env.QE_KEY_FILE || path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8').trim(), maxRetries: 3 })
const sc = SCENARIOS.find((s) => s.id === 'combat_night')
const PLAYER = 'Alex'
const BOT = 'Sui'
const MOVES = ['stay', 'walk_away', 'go_to_companion', 'wander', 'look_at_companion', 'attack_companion', 'walk_to_trees']
const TOOL = {
  name: 'player_turn',
  description: 'What you type in chat this moment (or nothing), and how you move.',
  input_schema: { type: 'object', properties: { say: { type: 'string', description: 'The chat message you type, or an empty string to say nothing.' }, move: { type: 'string', enum: MOVES, description: 'What your character does now. stay keeps doing nothing new.' } }, required: ['say', 'move'] },
}

// run.mjs before pass 61, verbatim.
function oldSystem() {
  return [
    `You are playing Minecraft Java as the player "${PLAYER}". You are a real person, around 17 to 25, playing on your computer.`,
    `${BOT} is an AI companion in the game with you. You talk to her by typing in game chat.`,
    '', `This session: ${sc.brief}`, '', 'How you type:',
    '- Like a normal gamer in chat. Mostly lowercase, short, casual. Skip punctuation a lot. A typo now and then is fine.',
    '- Usually one short message. Never more than about 20 words.',
    '- You do not explain yourself and you do not narrate. You just type what you would type.',
    '- You are not a tester and you never mention tests, prompts or evaluations.',
    '- Read your own earlier lines in the chat. Do not send the same request or question again unless she ignored it. Vary how you word things.',
    '- Sometimes you do not answer her at all, about one time in four, especially when she just narrates what she is doing. Then say is an empty string.',
    '- Now and then you go off topic or ignore what she asked, like real players do.',
    '', 'When a director note appears, it tells you what to do next in the session. Do it in your own words, right away.',
    'Pick a move only when it makes sense. Most of the time move is "stay".',
  ].join('\n')
}
function oldAsk({ history, dist, hp, elapsedMin }) {
  const recent = history.slice(-30).map((h) => (h.who === PLAYER ? `you: ${h.text}` : `${h.who}: ${h.text}`)).join('\n') || '(nothing yet)'
  return `Chat so far:\n${recent}\n\nNow: ${elapsedMin} min into the session. ${BOT} is ${dist == null ? 'unknown' : Number(dist).toFixed(0)} blocks from you. Your health ${Math.round(hp ?? 20)}/20. Your inventory: stone_sword x1, bread x8. You do not mine or craft yourself in this session, so do not claim to.` +
    `\n\n${BOT} just said something. Reply if you would, or say nothing.\n\nCall player_turn.`
}

// Analysis-only word checks (never product code).
const STAY = /stay (close|near|by|with|right)|dont (leave|go|wander)|don't (leave|go|wander)|near me|by me|close to me|stick (with|close)|keep close|dont get too far/i
const W = (s) => new Set((String(s).toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => w.length > 2 && !['sui', 'thx', 'pls', 'lol'].includes(w)))
const copyOf = (say, own) => { const w = W(say); return own.slice(-4).some((o) => { const p = W(o.text); const u = new Set([...w, ...p]).size; return u && [...w].filter((x) => p.has(x)).length / u >= 0.5 }) }

// ---- decision points ------------------------------------------------------
const points = []
for (const run of RUNS) {
  const ev = fs.readFileSync(path.join(run, 'player.events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const t0 = ev.find((e) => e.kind === 'session_start')?.t ?? ev[0].t
  const history = []; const own = []; let dist = null; let hp = 20; let lastHer = 0
  for (const e of ev) {
    if (e.kind === 'world') { dist = e.companion_dist; hp = e.player_hp ?? hp }
    if (e.kind === 'heard') { history.push({ who: e.from, text: e.text }); if (e.from === BOT) lastHer = e.t }
    if (e.kind === 'death') history.push({ who: '[game]', text: e.text })
    if ((e.kind === 'player_say' || e.kind === 'player_quiet') && e.trigger === 'companion_spoke' && !e.skipped) {
      points.push({ run: path.basename(path.dirname(path.dirname(run))) + '/' + path.basename(run), t: e.t, history: history.slice(), own: own.slice(), dist, hp, lastHer, elapsedMin: ((e.t - t0) / 60000).toFixed(1), actual: e.kind === 'player_say' ? e.text : '' })
    }
    if (e.kind === 'player_say') { history.push({ who: PLAYER, text: e.text }); own.push({ text: e.text, at: e.t }) }
  }
}
let x = 11
const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
for (let i = points.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [points[i], points[j]] = [points[j], points[i]] }
const sample = points.slice(0, MAX)

let cost = 0
async function call(system, content) {
  const r = await anthropic.messages.create({ model: MODEL, max_tokens: 200, system, tools: [TOOL], tool_choice: { type: 'tool', name: 'player_turn' }, messages: [{ role: 'user', content }] })
  const u = r.usage
  cost += ((u.input_tokens ?? 0) * P.in + (u.output_tokens ?? 0) * P.out + (u.cache_creation_input_tokens ?? 0) * P.cw + (u.cache_read_input_tokens ?? 0) * P.cr) / 1e6
  return String(r.content.find((c) => c.type === 'tool_use')?.input?.say ?? '').trim()
}

const rows = []
const newSys = playerSystem(sc, BOT, PLAYER)
for (const [i, p] of sample.entries()) {
  const oldSay = await call(oldSystem(), oldAsk(p))
  const ask = playerAsk({ history: p.history, ownLines: p.own, botName: BOT, player: PLAYER, dist: p.dist, hp: p.hp, inv: 'stone_sword x1, bread x8', elapsedMin: p.elapsedMin, trigger: 'companion_spoke', now: p.t })
  let newSay = await call(newSys, ask)
  const rep = repeatedBit(newSay, p.own, { now: p.t, lastHerLineAt: p.lastHer, dist: p.dist, names: [BOT, PLAYER] })
  let redo = null
  if (rep) {
    redo = { bit: rep.bit, first: newSay }
    newSay = await call(newSys, ask.replace(/\n\nCall player_turn\.$/, '') + redoNote(rep, BOT) + '\n\nCall player_turn.')
    if (stillRepeats(newSay, rep, [BOT, PLAYER])) newSay = ''
  }
  const cp = (t) => !!t && copyOf(t, p.own)
  rows.push({ run: p.run, dist: p.dist, actual: p.actual, old: oldSay, new: newSay, redo, copy: { actual: cp(p.actual), old: cp(oldSay), new: cp(newSay) } })
  if (i % 20 === 0) console.log(`${i}/${sample.length} $${cost.toFixed(3)}`)
}
fs.writeFileSync(path.join(OUT, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

const near = (r) => r.dist != null && r.dist <= 4
const far = (r) => r.dist != null && r.dist > 6
const rate = (rs, f, k) => { const n = rs.length; const m = rs.filter((r) => f(r[k], r, k)).length; return `${m}/${n}` }
const md = ['# pass61 player replay', '', `${rows.length} reaction points from ${RUNS.length} sessions, ${MODEL}, cost $${cost.toFixed(3)}`, '',
  '| measure | recorded | old prompt | new prompt |', '|---|---:|---:|---:|']
for (const [name, rs, f] of [
  ['said', rows, (s) => !!s],
  ['stay ask', rows, (s) => STAY.test(s)],
  ['stay ask, she within 4', rows.filter(near), (s) => STAY.test(s)],
  ['stay ask, she 7+ away', rows.filter(far), (s) => STAY.test(s)],
  ['copy of own last 4', rows, (s, r, k) => r.copy[k]],
]) md.push(`| ${name} | ${rate(rs, f, 'actual')} | ${rate(rs, f, 'old')} | ${rate(rs, f, 'new')} |`)
md.push('', `backstop redo fired ${rows.filter((r) => r.redo).length}x`, '', '## Lines (dist | recorded | old | new)', '')
for (const r of rows) md.push(`- ${r.dist ?? '?'} | ${r.actual || '(quiet)'} | ${r.old || '(quiet)'} | ${r.new || '(quiet)'}${r.redo ? ` [redo of "${r.redo.first}"]` : ''}`)
fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n') + '\n')
console.log(md.slice(0, 13).join('\n'))
