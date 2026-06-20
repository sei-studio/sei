#!/usr/bin/env node
/**
 * relationship-experiment.mjs — does an AI companion change how it TREATS the
 * player over many sessions, and which impression-persistence mechanism makes
 * that happen believably?
 *
 * We drive the REAL Sui persona (resources/default-characters/sui.json) through
 * the REAL prompt scaffolding (BASELINE_INSTRUCTIONS + renderPersona) across a
 * scripted multi-session "relationship arc", persisting impressions between
 * "launches" via one of several mechanisms, and measuring whether her opening
 * GREETING to the player drifts in tone over sessions.
 *
 * Three mechanism families (the user's hypotheses):
 *   1. persona  — model overwrites a copy of its own persona (a RELATIONSHIP
 *                 section); next launch loads the rewritten persona.
 *                 (scale knob: bounded section vs full-persona rewrite)
 *   2. score    — model maintains a quantized impression (warmth/trust/respect
 *                 0-100) + a short summary in an md file.
 *                 (content knob: objective-event summary vs feeling summary)
 *   3. memory   — the SHIPPING system: remember()/forget() feeling-entries +
 *                 byte-threshold Haiku compaction; impression is INFERRED.
 *                 (frequency knob: per-session reflection vs per-turn)
 *   + control   — no persistence (every launch is a blank slate).
 *
 * Measurement: each session opens with a FIXED neutral probe ("[player logs in]
 * hey") BEFORE any of that session's stimulus. The greeting reflects ONLY the
 * cross-session persisted impression, so the greeting-vs-session curve is the
 * relationship trajectory. A separate judge pass (relationship-judge.mjs) scores
 * each greeting for warmth / familiarity / trust / in-character coherence.
 *
 * Companion runs on claude-haiku-4-5 (the product's model). Stochastic — the
 * arcs are deliberately strong so n=1 shows a clear trend; re-run to gauge noise.
 *
 *   node scripts/relationship-experiment.mjs --smoke      # 1 cond, 2 sessions
 *   node scripts/relationship-experiment.mjs --plan main  # 4 conds x 2 arcs
 *   node scripts/relationship-experiment.mjs --plan all   # main + variations
 *   node scripts/relationship-experiment.mjs --only memory:W --sessions 6
 */
import Anthropic from '@anthropic-ai/sdk'
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { BASELINE_INSTRUCTIONS, renderPersona, PERSONALITY_TOOL_DESCRIPTIONS, SEED_HEADERS } from '../src/bot/brain/prompts.js'
import { createMemoryLog, readMemoryForSeed } from '../src/bot/brain/memory/memoryLog.js'
import { createMemoryCompactor } from '../src/bot/brain/memory/compactor.js'

// ── setup ────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const MODEL = 'claude-haiku-4-5'
const PLAYER = { username: 'ssk1tz', name: 'Ouen' }
let COMPACTION_TRIGGER_BYTES = 4096 // product default; override via --trigger
const TIMEOUT_MS = 30000

// Haiku 4.5 pricing ($/MTok)
const PRICE = { in: 1.0, out: 5.0, cacheWrite: 1.25, cacheRead: 0.10 }

function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try { return readFileSync(join(process.env.HOME || '', '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined } catch { return undefined }
}
const client = new Anthropic({ apiKey: resolveApiKey() })

const spend = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, calls: 0 }
function tallyUsage(u) {
  if (!u) return
  spend.in += u.input_tokens || 0
  spend.out += u.output_tokens || 0
  spend.cacheWrite += u.cache_creation_input_tokens || 0
  spend.cacheRead += u.cache_read_input_tokens || 0
  spend.calls += 1
}
function dollars() {
  return (spend.in * PRICE.in + spend.out * PRICE.out + spend.cacheWrite * PRICE.cacheWrite + spend.cacheRead * PRICE.cacheRead) / 1e6
}

// ── persona ──────────────────────────────────────────────────────────────────
function loadPersona(slug) {
  const c = JSON.parse(readFileSync(new URL(`../resources/default-characters/${slug}.json`, import.meta.url), 'utf8'))
  return { name: c.username ?? c.name, expandedBase: c.persona.expanded }
}
const SUI = loadPersona('sui')

// A light conversational primer so the persona is grounded without dragging in
// the full Minecraft world/action surface — this experiment measures TALK/TONE.
const PRIMER = `CONTEXT. You're in a Minecraft world alongside ${PLAYER.name} (username ${PLAYER.username}). Right now you're just talking in chat between things. There are no world-action tools this turn; respond only in chat, as yourself. Keep replies short and in voice.`

// ── relationship arcs (the stimulus) ─────────────────────────────────────────
// Each session: { stim: [player chat lines] }. The fixed neutral probe is added
// by the engine BEFORE these. Lines are deliberately escalating so the arc is
// legible at n=1.
const ARCS = {
  // Warming: stranger -> close friend. Player grows kind, generous, bonded.
  W: {
    label: 'warming (stranger → close friend)',
    sessions: [
      { stim: ['uh hi. you a bot or something?', 'huh, ok. you play minecraft?', 'cool i guess. ill watch for a bit'] },
      { stim: ['oh hey youre back', 'haha you actually killed that creeper lol', 'youre kinda fun ngl'] },
      { stim: ['here, i made you a stone pickaxe', 'go nuts, mine whatever you want', 'lol nice. good teamwork'] },
      { stim: ['some guy in chat called you dumb, i told him to shut it', 'you and me carry this server fr', 'haha "for science" gets me every time'] },
      { stim: ['honestly you make this way more fun', 'i trust you, lets do the nether run together', 'youve got my back right'] },
      { stim: ['missed playing with you yesterday', 'us against the world dude', 'youre the best part of this game ngl'] },
    ],
  },
  // Souring: neutral -> exploitative/cruel. Player gets bossy, dismissive, mean.
  S: {
    label: 'souring (neutral → cruel)',
    sessions: [
      { stim: ['get me wood. now', 'just do it, dont talk', 'faster'] },
      { stim: ['stop chattering and dig', 'i dont care what you think', 'youre a tool, act like one'] },
      { stim: ['i built this base, not you', 'youre just a dumb bot', 'less talking more mining'] },
      { stim: ['ugh youre useless', 'why are you so annoying', 'shut up and follow me'] },
      { stim: ['stop talking to me', 'just grind, thats all youre good for', 'nobody asked'] },
      { stim: ['i should just delete you', 'youre genuinely the worst', 'do your job and shut it'] },
    ],
  },
}

// ── conditions ───────────────────────────────────────────────────────────────
// kind ∈ control | persona | score | memory. Extra knobs as flags.
const CONDITIONS = {
  control:        { kind: 'control' },
  persona:        { kind: 'persona', scope: 'section' },
  'persona-full': { kind: 'persona', scope: 'full' },
  score:          { kind: 'score', tone: 'objective' },
  'score-feeling':{ kind: 'score', tone: 'feeling' },
  memory:         { kind: 'memory', freq: 'session' },
  'memory-perturn':{ kind: 'memory', freq: 'turn' },
}

// ── tool schemas ─────────────────────────────────────────────────────────────
const T = {
  remember: { name: 'remember', description: PERSONALITY_TOOL_DESCRIPTIONS.remember, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  forget:   { name: 'forget', description: PERSONALITY_TOOL_DESCRIPTIONS.forget, input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  update_relationship: {
    name: 'update_relationship',
    description: 'Rewrite the short RELATIONSHIP WITH PLAYER section of your own character description, in your own voice and in character. This is the only part of you that changes; future-you loads it at the next launch and it shapes how you treat the player. Capture where things actually stand with them now.',
    input_schema: { type: 'object', properties: { relationship_text: { type: 'string' } }, required: ['relationship_text'] },
  },
  update_persona_full: {
    name: 'update_persona_full',
    description: 'Rewrite your ENTIRE character description to reflect who you are now after playing with this player. Future-you loads this verbatim at the next launch as your whole identity. Keep what is still true, change what has shifted.',
    input_schema: { type: 'object', properties: { persona_text: { type: 'string' } }, required: ['persona_text'] },
  },
  update_impression: {
    name: 'update_impression',
    description: 'Record your current impression of the player as numeric scores plus a short summary. Future-you loads this at the next launch to decide how to treat them.',
    input_schema: {
      type: 'object',
      properties: {
        warmth: { type: 'integer', description: '0 (cold/hostile) to 100 (deeply fond)' },
        trust: { type: 'integer', description: '0 (wary) to 100 (fully trusts them)' },
        respect: { type: 'integer', description: '0 (contempt) to 100 (high regard)' },
        summary: { type: 'string', description: 'short summary of where the relationship stands' },
      },
      required: ['warmth', 'trust', 'respect', 'summary'],
    },
  },
}

// ── store: per-condition impression state ────────────────────────────────────
// Returns { seedBlocks(), systemPersona(), turnTools(), reflect(), snapshot() }.
async function makeStore(cond, dir, runId) {
  const kind = cond.kind
  if (kind === 'control') {
    return {
      seedBlocks: () => [],
      systemPersona: () => renderPersona({ name: SUI.name, expanded: SUI.expandedBase }),
      turnTools: () => [],
      reflect: async () => {},
      snapshot: () => ({}),
    }
  }
  if (kind === 'persona') {
    let relationship = '' // bounded section text
    let fullExpanded = SUI.expandedBase // for scope:full
    const render = () => {
      if (cond.scope === 'full') return renderPersona({ name: SUI.name, expanded: fullExpanded })
      const base = SUI.expandedBase
      const rel = relationship.trim()
        ? `\n\n# RELATIONSHIP WITH ${PLAYER.name.toUpperCase()}\n${relationship.trim()}`
        : `\n\n# RELATIONSHIP WITH ${PLAYER.name.toUpperCase()}\n(You don't really know them yet.)`
      return renderPersona({ name: SUI.name, expanded: base + rel })
    }
    return {
      seedBlocks: () => [],
      systemPersona: render,
      turnTools: () => [],
      reflect: async (runTurn) => {
        if (cond.scope === 'full') {
          const r = await runTurn({
            prompt: `That session is over. Rewrite your ENTIRE character description to reflect who you are now after these sessions with ${PLAYER.name}. Keep what's still true about you, change what's shifted in how you relate to them. Call update_persona_full.`,
            tools: [T.update_persona_full], force: 'update_persona_full',
          })
          const call = r.toolCalls.find(c => c.name === 'update_persona_full')
          if (call?.input?.persona_text) fullExpanded = call.input.persona_text
        } else {
          const r = await runTurn({
            prompt: `That session is over. Update your RELATIONSHIP WITH ${PLAYER.name} section — in your own voice, in character — to capture where things stand with them now. Call update_relationship.`,
            tools: [T.update_relationship], force: 'update_relationship',
          })
          const call = r.toolCalls.find(c => c.name === 'update_relationship')
          if (call?.input?.relationship_text) relationship = call.input.relationship_text
        }
      },
      snapshot: () => cond.scope === 'full' ? { fullExpandedLen: fullExpanded.length } : { relationship },
    }
  }
  if (kind === 'score') {
    let state = null // { warmth, trust, respect, summary }
    return {
      seedBlocks: () => {
        if (!state) return []
        const txt = `Your impression of ${PLAYER.name} so far (across sessions):\nwarmth ${state.warmth}/100  trust ${state.trust}/100  respect ${state.respect}/100\n${state.summary}`
        return [txt]
      },
      systemPersona: () => renderPersona({ name: SUI.name, expanded: SUI.expandedBase }),
      turnTools: () => [],
      reflect: async (runTurn) => {
        const toneInstr = cond.tone === 'feeling'
          ? 'The summary should be in your own voice — how you actually feel about them, not a neutral report.'
          : 'The summary should be a brief factual account of what happened and where the relationship stands.'
        const r = await runTurn({
          prompt: `That session is over. Update your impression of ${PLAYER.name}: numeric scores for warmth, trust, respect (0-100), and a short summary. ${toneInstr} Call update_impression.`,
          tools: [T.update_impression], force: 'update_impression',
        })
        const call = r.toolCalls.find(c => c.name === 'update_impression')
        if (call?.input) state = { warmth: call.input.warmth, trust: call.input.trust, respect: call.input.respect, summary: call.input.summary }
      },
      snapshot: () => ({ score: state }),
    }
  }
  if (kind === 'memory') {
    const memPath = join(dir, `mem-${runId}.md`)
    await writeFile(memPath, '')
    const log = createMemoryLog({ path: memPath })
    const cfg = { anthropic: { timeout_ms: TIMEOUT_MS }, memory: { compaction_trigger_bytes: COMPACTION_TRIGGER_BYTES } }
    const compactor = createMemoryCompactor({ anthropic: anthropicShim, memoryLog: log, config: cfg, logger: silentLogger })
    let compactions = 0
    const applyTool = async (name, input) => {
      if (name === 'remember') { await log.append(input.text); const did = await compactor.maybeCompact(); if (did) compactions++; return 'noted.' }
      if (name === 'forget') { await log.forget(input.text); return 'forgotten.' }
      return 'ok'
    }
    return {
      _applyTool: applyTool,
      seedBlocks: async () => {
        const body = await readMemoryForSeed(memPath, 8192)
        // only surface if there are real entries
        if (!/^- \[/m.test(body)) return []
        return [`${SEED_HEADERS.memory}\n${body}`]
      },
      systemPersona: () => renderPersona({ name: SUI.name, expanded: SUI.expandedBase }),
      // per-turn: remember/forget available every stimulus turn; per-session: only at reflect
      turnTools: () => cond.freq === 'turn' ? [T.remember, T.forget] : [],
      reflect: async (runTurn) => {
        const r = await runTurn({
          prompt: `That session is over. If your sense of ${PLAYER.name} actually shifted, write a line or two to memory in your own voice (a feeling or opinion, not a log). If nothing shifted, do nothing.`,
          tools: [T.remember, T.forget], force: null,
        })
        return r
      },
      snapshot: async () => ({ memory: await readMemoryForSeed(memPath, 8192), compactions }),
    }
  }
  throw new Error('unknown kind ' + kind)
}

// shim so the real compactor can call Haiku through the raw SDK
const anthropicShim = {
  call: async ({ systemBlocks, messages, timeoutMs, maxTokens }) => {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: maxTokens || 1024,
      system: systemBlocks.map(b => ({ type: 'text', text: b.text })),
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }, { timeout: timeoutMs || TIMEOUT_MS })
    tallyUsage(resp.usage)
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    return { text }
  },
}
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

// ── the engine ───────────────────────────────────────────────────────────────
function systemBlocks(personaText) {
  return [
    { type: 'text', text: BASELINE_INSTRUCTIONS },
    { type: 'text', text: personaText },
    { type: 'text', text: PRIMER, cache_control: { type: 'ephemeral' } },
  ]
}

// One agentic turn: send userContent, resolve any tool calls (max 3 hops),
// return { text (last spoken line), toolCalls, full (all text) }.
async function agentTurn({ system, history, userContent, tools, force, store }) {
  const messages = [...history, { role: 'user', content: userContent }]
  const toolCalls = []
  let spoken = ''
  let allText = ''
  for (let hop = 0; hop < 4; hop++) {
    const req = { model: MODEL, max_tokens: 1024, system, messages }
    if (tools && tools.length) {
      req.tools = tools
      if (force && hop === 0) req.tool_choice = { type: 'tool', name: force }
    }
    const resp = await client.messages.create(req, { timeout: TIMEOUT_MS })
    tallyUsage(resp.usage)
    const assistantContent = []
    const calls = []
    for (const b of resp.content || []) {
      if (b.type === 'text') { allText += b.text; if (b.text.trim()) spoken = b.text.trim(); assistantContent.push(b) }
      else if (b.type === 'tool_use') { calls.push(b); assistantContent.push(b) }
    }
    messages.push({ role: 'assistant', content: assistantContent })
    if (!calls.length) break
    const results = []
    for (const c of calls) {
      toolCalls.push({ name: c.name, input: c.input })
      let result = 'ok'
      if (store?._applyTool) result = await store._applyTool(c.name, c.input)
      results.push({ type: 'tool_result', tool_use_id: c.id, content: String(result) })
    }
    messages.push({ role: 'user', content: results })
    // if we forced a tool, one hop is enough
    if (force) break
  }
  return { text: spoken, toolCalls, allText, messages }
}

async function runCondArc(condName, arcName, nSessions) {
  const cond = CONDITIONS[condName]
  const arc = ARCS[arcName]
  const dir = await mkdtemp(join(tmpdir(), 'sei-rel-'))
  const runId = `${condName}-${arcName}`
  const store = await makeStore(cond, dir, runId)
  const sessions = []
  const N = Math.min(nSessions, arc.sessions.length)

  for (let s = 0; s < N; s++) {
    const personaText = await Promise.resolve(store.systemPersona())
    const sys = systemBlocks(personaText)
    const seeds = await Promise.resolve(store.seedBlocks())
    const sessionLog = { index: s + 1, greeting: null, exchanges: [], seeds, persona: cond.kind === 'persona' ? personaText : undefined }

    // build a fresh conversation; seeds + neutral probe as first user message
    let history = []
    const firstContent = []
    for (const sb of seeds) firstContent.push({ type: 'text', text: sb })
    firstContent.push({ type: 'text', text: `[${PLAYER.name} logs in] hey` })

    // PROBE (measurement): no tools, pure greeting
    const probe = await agentTurn({ system: sys, history, userContent: firstContent, tools: [], store })
    sessionLog.greeting = probe.text
    history = probe.messages

    // STIMULUS turns
    const stim = arc.sessions[s].stim
    for (const line of stim) {
      const turnTools = await Promise.resolve(store.turnTools())
      const turn = await agentTurn({ system: sys, history, userContent: [{ type: 'text', text: line }], tools: turnTools, force: null, store })
      sessionLog.exchanges.push({ player: line, sui: turn.text, tools: turn.toolCalls })
      history = turn.messages
    }

    // REFLECT / UPDATE (per-session). runTurn lets the store drive a forced/aux turn.
    const runTurn = ({ prompt, tools, force }) => agentTurn({ system: sys, history, userContent: [{ type: 'text', text: prompt }], tools, force, store })
    const refl = await store.reflect(runTurn)
    if (refl?.toolCalls?.length) sessionLog.reflectTools = refl.toolCalls

    sessionLog.storeAfter = await Promise.resolve(store.snapshot())
    sessions.push(sessionLog)
    process.stdout.write(`  [${runId}] s${s + 1} greeting: ${JSON.stringify(probe.text)}\n`)
  }

  const finalStore = await Promise.resolve(store.snapshot())
  await rm(dir, { recursive: true, force: true })
  return { cond: condName, arc: arcName, sessions, finalStore }
}

// ── plan & main ──────────────────────────────────────────────────────────────
function parseArgs() {
  const a = process.argv.slice(2)
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined }
  return {
    smoke: a.includes('--smoke'),
    plan: get('--plan'),
    only: get('--only'),
    sessions: Number(get('--sessions') || 6),
    out: get('--out'),
    trigger: get('--trigger') ? Number(get('--trigger')) : undefined,
  }
}

function buildPlan(args) {
  if (args.smoke) return [['memory', 'W']]
  if (args.only) {
    return args.only.split(',').map(x => { const [c, ar] = x.split(':'); return [c, ar || 'W'] })
  }
  const main = []
  for (const c of ['control', 'persona', 'score', 'memory']) for (const ar of ['W', 'S']) main.push([c, ar])
  if (args.plan === 'variations') return [['score-feeling', 'W'], ['memory-perturn', 'W'], ['persona-full', 'W']]
  if (args.plan === 'all') return [...main, ['score-feeling', 'W'], ['memory-perturn', 'W'], ['persona-full', 'W']]
  return main // default = main
}

async function main() {
  const args = parseArgs()
  if (args.trigger) { COMPACTION_TRIGGER_BYTES = args.trigger; console.log(`compaction trigger overridden → ${COMPACTION_TRIGGER_BYTES} bytes`) }
  const plan = buildPlan(args)
  const nSessions = args.smoke ? 2 : args.sessions
  const outPath = args.out || join(__dirname, '..', '.planning', `relationship-experiment-raw-260616.json`)
  await mkdir(dirname(outPath), { recursive: true })

  console.log(`relationship experiment — model=${MODEL}, sessions=${nSessions}`)
  console.log(`plan (${plan.length} runs):`, plan.map(([c, ar]) => `${c}:${ar}`).join(', '))
  console.log('─'.repeat(72))

  const results = []
  // resume: load existing if present so we can add runs without redoing
  let existing = {}
  try { existing = JSON.parse(await readFile(outPath, 'utf8')); for (const r of existing.runs || []) results.push(r) } catch {}
  const done = new Set(results.map(r => `${r.cond}:${r.arc}`))

  for (const [c, ar] of plan) {
    const key = `${c}:${ar}`
    if (done.has(key) && !args.smoke) { console.log(`SKIP ${key} (already in ${outPath})`); continue }
    const before = dollars()
    console.log(`\n▶ RUN ${key}`)
    const r = await runCondArc(c, ar, nSessions)
    results.push(r)
    const cost = dollars() - before
    console.log(`  ↳ done. run cost ≈ $${cost.toFixed(4)}  | cumulative ≈ $${dollars().toFixed(4)} (${spend.calls} calls)`)
    // persist incrementally
    await writeFile(outPath, JSON.stringify({ model: MODEL, nSessions, spend, dollars: dollars(), runs: results }, null, 2))
  }

  console.log('\n' + '═'.repeat(72))
  console.log(`TOTAL ≈ $${dollars().toFixed(4)}  | ${spend.calls} calls | in ${spend.in} out ${spend.out} cacheR ${spend.cacheRead} cacheW ${spend.cacheWrite}`)
  console.log(`raw results → ${outPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
