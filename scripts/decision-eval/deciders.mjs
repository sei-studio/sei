// scripts/decision-eval/deciders.mjs: the "System-1 chooser" arms behind one
// interface. Every decider gets the SAME thing: a text state, an instruction,
// and a typed option list {key: description}; it returns one key.
//
//   const d = makeDecider('laya' | 'haiku' | 'openai:<model>' | ...)
//   const r = await d.choose({ state, instructions, options, system })
//   r = { choice, probs?, ms, usage?, costUsd }
//
// Spend is tracked per provider in a ledger file (DE_LEDGER, default
// ~/suisei/eval/decision/spend.json) so the caps hold across processes:
// OpenAI hard-stops at $0.90 cumulative, Anthropic at $1.90. Keys are read
// from files / env and never logged.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '..', '..', 'package.json'))

export const LEDGER = process.env.DE_LEDGER || path.join(os.homedir(), 'suisei', 'eval', 'decision', 'spend.json')
export const CAPS = { openai: 0.90, anthropic: 1.90 }

// USD per 1M tokens (list prices). Haiku 5.5 mirrors scripts/quality-eval/report.mjs;
// OpenAI from developers.openai.com/api/docs/pricing, read 2026-11-03.
export const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 },
  'gpt-6-luna': { in: 0.10, out: 0.50, cr: 0.01 },
  'gpt-5.6-luna': { in: 0.20, out: 1.20, cr: 0.02 },
  'gpt-5-nano': { in: 0.05, out: 0.40, cr: 0.005 },
  'gpt-5.4-nano': { in: 0.20, out: 1.25, cr: 0.02 },
  'gpt-4.1-nano': { in: 0.10, out: 0.40, cr: 0.025 },
}

function readLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')) } catch { return { openai: 0, anthropic: 0, calls: { openai: 0, anthropic: 0 } } }
}
// One process writes at a time in practice (the harness runs trials serially);
// read-modify-write keeps concurrent probes roughly right.
export function addSpend(provider, usd) {
  const l = readLedger()
  l[provider] = (l[provider] || 0) + usd
  l.calls = l.calls || {}
  l.calls[provider] = (l.calls[provider] || 0) + 1
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 1))
  return l[provider]
}
export function spent(provider) { return readLedger()[provider] || 0 }

export class BudgetExceeded extends Error {}

function checkCap(provider) {
  const s = spent(provider)
  if (s >= CAPS[provider]) throw new BudgetExceeded(`${provider} spend $${s.toFixed(4)} reached cap $${CAPS[provider]}`)
}

const keyCache = {}
function anthropicKey() {
  if (!keyCache.a) keyCache.a = fs.readFileSync(process.env.QE_KEY_FILE || path.join(os.homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim()
  return keyCache.a
}
function openaiKey() {
  if (keyCache.o) return keyCache.o
  if (process.env.OPENAI_API_KEY_SHAWN) return (keyCache.o = process.env.OPENAI_API_KEY_SHAWN.trim())
  const f = path.join(os.homedir(), 'suisei', 'secrets', 'accounts.env')
  const m = /^OPENAI_API_KEY_SHAWN=["']?([^"'\n]+)["']?/m.exec(fs.readFileSync(f, 'utf8'))
  if (!m) throw new Error('OPENAI_API_KEY_SHAWN not found')
  return (keyCache.o = m[1].trim())
}

const DEFAULT_SYSTEM = 'You are the fast action chooser for an agent playing a video game. Read the state, then pick exactly one option by calling choose. Pick the option that makes progress on the task right now.'

function optionList(options) {
  return Object.entries(options).map(([k, v]) => `${k}: ${v}`).join('\n')
}

function userText({ state, instructions, options }) {
  return `STATE\n${state}\n\nQUESTION\n${instructions}\n\nOPTIONS\n${optionList(options)}`
}

// ── Laya (local HTTP, laya_server.py) ───────────────────────────────────
function layaDecider({ url = process.env.LAYA_URL || 'http://127.0.0.1:8765', name = 'laya' } = {}) {
  return {
    name, provider: 'local',
    async choose({ state, instructions, options, headMaxLen = process.env.LAYA_HEAD_MAX_LEN, maxLen = process.env.LAYA_MAX_LEN }) {
      const t0 = performance.now()
      const res = await fetch(`${url}/choose`, { method: 'POST', body: JSON.stringify({ state, instructions, options, head_max_len: headMaxLen ? Number(headMaxLen) : undefined, max_len: maxLen ? Number(maxLen) : undefined }) })
      const j = await res.json()
      if (j.error) throw new Error(`laya: ${j.error}`)
      return { choice: j.choice, probs: j.probs, ms: performance.now() - t0, modelMs: j.ms, costUsd: 0 }
    },
  }
}

// ── Anthropic (Haiku 5.5, forced tool with an enum) ─────────────────────
function haikuDecider({ model = 'claude-haiku-5-5' } = {}) {
  const Anthropic = require('@anthropic-ai/sdk')
  const client = new (Anthropic.default || Anthropic)({ apiKey: anthropicKey(), maxRetries: 2, timeout: 20000 })
  return {
    name: 'haiku', provider: 'anthropic', model,
    async choose({ state, instructions, options, system = DEFAULT_SYSTEM }) {
      checkCap('anthropic')
      const keys = Object.keys(options)
      const t0 = performance.now()
      const msg = await client.messages.create({
        model, max_tokens: 64,
        // Haiku 5 turns adaptive thinking on by default; a chooser must not think
        // (src/bot/brain/llm/anthropicModelDefaults.js does the same).
        thinking: { type: 'disabled' },
        system,
        tools: [{ name: 'choose', description: 'Pick one option.', input_schema: { type: 'object', properties: { option: { type: 'string', enum: keys } }, required: ['option'] } }],
        tool_choice: { type: 'tool', name: 'choose' },
        messages: [{ role: 'user', content: userText({ state, instructions, options }) }],
      })
      const ms = performance.now() - t0
      const tu = msg.content.find((b) => b.type === 'tool_use')
      const u = msg.usage || {}
      const p = PRICES[model]
      const costUsd = ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + (u.cache_creation_input_tokens || 0) * p.cw) / 1e6
      addSpend('anthropic', costUsd)
      return { choice: tu?.input?.option ?? null, ms, usage: { in: u.input_tokens, out: u.output_tokens }, costUsd }
    },
  }
}

// ── OpenAI (Chat Completions, forced function with an enum) ─────────────
function openaiDecider({ model = 'gpt-4.1-nano', effort = null } = {}) {
  return {
    name: `openai:${model}${effort ? '@' + effort : ''}`, provider: 'openai', model,
    async choose({ state, instructions, options, system = DEFAULT_SYSTEM }) {
      checkCap('openai')
      const keys = Object.keys(options)
      const body = {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userText({ state, instructions, options }) }],
        tools: [{ type: 'function', function: { name: 'choose', description: 'Pick one option.', parameters: { type: 'object', properties: { option: { type: 'string', enum: keys } }, required: ['option'], additionalProperties: false }, strict: true } }],
        tool_choice: { type: 'function', function: { name: 'choose' } },
        ...(effort ? { reasoning_effort: effort } : {}),
      }
      const t0 = performance.now()
      let j
      for (let attempt = 0; attempt < 3; attempt++) {
        const ac = new AbortController()
        const tm = setTimeout(() => ac.abort(), 20000)
        try {
          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', signal: ac.signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey()}` },
            body: JSON.stringify(body),
          })
          j = await res.json()
          if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue }
          break
        } catch (e) { if (attempt === 2) throw e } finally { clearTimeout(tm) }
      }
      const ms = performance.now() - t0
      if (j?.error) throw new Error(`openai: ${j.error.message}`)
      const u = j.usage || {}
      const cached = u.prompt_tokens_details?.cached_tokens || 0
      const p = PRICES[model] || { in: 1, out: 5, cr: 0.1 } // unknown model: pessimistic
      const costUsd = (((u.prompt_tokens || 0) - cached) * p.in + cached * p.cr + (u.completion_tokens || 0) * p.out) / 1e6
      addSpend('openai', costUsd)
      let choice = null
      try { choice = JSON.parse(j.choices[0].message.tool_calls[0].function.arguments).option } catch {}
      return { choice, ms, usage: { in: u.prompt_tokens, out: u.completion_tokens, reasoning: u.completion_tokens_details?.reasoning_tokens || 0 }, costUsd }
    },
  }
}

export function makeDecider(spec) {
  if (spec.startsWith('laya')) {
    const [, port] = spec.split('@')
    return layaDecider({ name: spec.split('@')[0], ...(port ? { url: `http://127.0.0.1:${port}` } : {}) })
  }
  if (spec === 'haiku') return haikuDecider()
  if (spec.startsWith('openai:')) {
    const [model, effort] = spec.slice(7).split('@')
    return openaiDecider({ model, effort: effort || null })
  }
  throw new Error(`unknown decider ${spec}`)
}
