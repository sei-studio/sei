#!/usr/bin/env node
// scripts/verify-phase2.js — Phase 2 end-to-end smoke check.
// Usage: node scripts/verify-phase2.js [--live]
//   default: structural assertions only
//   --live: makes real Anthropic calls for chat AND idle (requires ANTHROPIC_API_KEY)

import { createRequire } from 'module'
import { loadConfig } from '../src/config.js'
import { createDefaultRegistry } from '../src/registry.js'
import { createOrchestrator } from '../src/llm/orchestrator.js'

const require = createRequire(import.meta.url)
// Real minecraft-data registry — mineflayer-pathfinder's Movements ctor reads
// many specific block names (fire, lava, water, sand, ladder, air, ...). Faking
// them all is fragile; the real registry is small and deterministic.
const mcData = require('minecraft-data')('1.20.1')

const live = process.argv.includes('--live')
const failures = []
function assert(cond, msg) {
  if (!cond) { failures.push(msg); console.error('FAIL:', msg) }
  else { console.log('OK  :', msg) }
}

const config = loadConfig()
assert(config.persona?.name, 'config has persona.name')
assert(typeof config.anthropic?.model === 'string', 'anthropic.model set')
assert(config.llm?.max_hops === 5, 'llm.max_hops defaults to 5')

const registry = createDefaultRegistry()
assert(registry.list().includes('goTo'),     'registry has goTo')

let chatCalls = 0
// Stub bot enriched enough for goTo to run without crashing inside pathfind.js.
// mineflayer normally provides bot.registry.blocksByName and bot.pathfinder;
// without them, `new Movements(bot)` throws synchronously and the action chain
// would leak (no completion event ever fires for an action that never started).
const stubBot = {
  chat: (line) => { chatCalls++; console.log('[stub bot.chat]', line) },
  on:   () => {},
  emit: () => {},
  registry: mcData,
  entity: { position: { x: 0, y: 64, z: 0 } },
  pathfinder: {
    setMovements: () => {},
    goto: async () => { /* no-op: stub never moves */ },
    stop: () => {},
  },
}

const orch = createOrchestrator({ bot: stubBot, config, registry, logger: console })

assert(typeof orch.handleDispatch === 'function', 'handleDispatch exposed')
assert(orch._internal?.chains && typeof orch._internal.chains.size === 'function', 'chain tracker exposed on _internal')

if (live) {
  console.log('\n--- LIVE MODE: calling Anthropic ---')
  await orch.start()

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
      // After dispatch, any chain that remains open is one waiting for an FSM
      // completion event (per orchestrator.js: chains stay open after movement
      // dispatch so re-entries via FSM completion events count against the same
      // chain — see LLM-04). Without an FSM in this harness, that's expected.
      // Assert the REAL invariants:
      //  (a) no chain exceeded max_hops (no runaway loop)
      //  (b) at most 1 chain leaked (the one launched by this idle dispatch)
      const openChains = [...orch._internal.chains._internal.chains.values()]
      const maxObservedHops = openChains.reduce((m, c) => Math.max(m, c.hops), 0)
      assert(maxObservedHops <= config.llm.max_hops, `no chain exceeded max_hops (observed=${maxObservedHops}, cap=${config.llm.max_hops})`)
      assert(openChains.length <= 1, `idle dispatch leaked at most 1 chain (open=${openChains.length})`)
      // Clean up the stale chain so subsequent assertions/runs see a fresh tracker.
      for (const [id] of orch._internal.chains._internal.chains) orch._internal.chains.end(id)
      assert(orch._internal.chains.size() === 0, 'chain tracker drained after explicit cleanup')
      console.log(`[idle] chatCalls delta = ${chatCalls - idleStart} (0 or 1 both acceptable per PERS-04)`)
    } finally { clearTimeout(timeoutId) }
  }
}

if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log(`\nAll checks passed. live=${live}`)
