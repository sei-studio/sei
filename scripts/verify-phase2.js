#!/usr/bin/env node
// scripts/verify-phase2.js — Phase 2 end-to-end smoke check.
// Usage: node scripts/verify-phase2.js [--live]
//   default: structural assertions only
//   --live: makes real Anthropic calls for chat AND idle (requires ANTHROPIC_API_KEY)

import { loadConfig } from '../src/config.js'
import { createDefaultRegistry } from '../src/registry.js'
import { createOrchestrator } from '../src/llm/orchestrator.js'

const live = process.argv.includes('--live')
const failures = []
function assert(cond, msg) {
  if (!cond) { failures.push(msg); console.error('FAIL:', msg) }
  else { console.log('OK  :', msg) }
}

const config = loadConfig()
assert(config.persona?.name, 'config has persona.name')
assert(typeof config.anthropic?.model === 'string', 'anthropic.model set')
assert(config.ollama?.model?.includes('instruct'), 'ollama.model is instruct variant (D-21)')
assert(config.llm?.max_hops === 5, 'llm.max_hops defaults to 5')

const registry = createDefaultRegistry()
assert(registry.list().includes('setGoals'), 'registry has setGoals')
assert(registry.list().includes('goTo'),     'registry has goTo')

let chatCalls = 0
const stubBot = {
  chat: (line) => { chatCalls++; console.log('[stub bot.chat]', line) },
  on:   () => {},
  emit: () => {},
}

const orch = createOrchestrator({ bot: stubBot, config, registry, logger: console })

assert(orch.executorStatus === 'qwen' || orch.executorStatus === 'haiku-fallback', 'executorStatus initialized')
assert(typeof orch.handleDispatch === 'function', 'handleDispatch exposed')
assert(orch._internal?.chains && typeof orch._internal.chains.size === 'function', 'chain tracker exposed on _internal')

await registry.execute('setGoals', { list: 'owner', op: 'add', goal: 'kill cows' }, stubBot, { ...config, _goalStore: orch.goals })
assert(orch.goals.snapshot().owner_goals[0] === 'kill cows', 'setGoals via registry mutates goal store')

if (live) {
  console.log('\n--- LIVE MODE: probing Ollama and calling Anthropic ---')
  await orch.start()
  console.log('Executor after probe:', orch.executorStatus)

  // (1) Synthetic CHAT dispatch
  const chatStart = chatCalls
  {
    const ctrl = new AbortController()
    const timeoutId = setTimeout(() => ctrl.abort(new Error('chat verify timeout 60s')), 60_000)
    try {
      await orch.handleDispatch(
        'sei:chat_received',
        { username: 'shawn', message: 'hey, say hi', addressed: true, ownerSpoke: true },
        ctrl.signal
      )
      assert(chatCalls > chatStart, 'personality LLM emitted at least one say from chat dispatch (live)')
    } finally { clearTimeout(timeoutId) }
  }

  // (2) Synthetic IDLE dispatch — proves PERS-04 idle path reaches the orchestrator
  const idleStart = chatCalls
  {
    const ctrl = new AbortController()
    const timeoutId = setTimeout(() => ctrl.abort(new Error('idle verify timeout 60s')), 60_000)
    try {
      await orch.handleDispatch('sei:idle', {}, ctrl.signal)
      assert(orch._internal.chains.size() === 0, 'idle dispatch ended its chain cleanly (no leak)')
      console.log(`[idle] chatCalls delta = ${chatCalls - idleStart} (0 or 1 both acceptable per PERS-04)`)
    } finally { clearTimeout(timeoutId) }
  }
}

if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log(`\nAll checks passed. live=${live}`)
