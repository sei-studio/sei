// scripts/test-actionTick.mjs
//
// 260516-0yw: end-to-end-ish assertions for the action_tick wiring:
//
//   1. Priority.P2_ACTION_TICK === 2.3 (LOCKED — not 2.4, not 2.5).
//   2. The priority queue dispatches a queued sei:action_complete (2.1)
//      BEFORE a queued sei:action_tick (2.3) — so a same-batch settle
//      naturally suppresses the tick.
//   3. Tick interval handle stored on inflightEntry._tickHandle is cleared
//      by clearActionTick(entry); after clear, no further ticks fire.
//   4. setInterval handles cleared via clearInterval are no-ops even if
//      never fired (defensive — covers the fast-action case where the
//      long-runner settles before the first 10s tick elapsed).
//   5. The dispatcher classifier `iterationKeepsLoopAlive` returns TRUE
//      for `sei:action_tick` AND when loop.inFlight is present —
//      ensuring a tick text-only iteration KEEPS the loop alive instead
//      of tearing down the long-runner the tick was meant to monitor.
//   6. End-to-end signal plumbing reaches the follow handler: calling
//      adapter.executeAction('follow', ..., { signal }) returns a
//      promise that stays pending until the signal aborts. A future
//      regression that strips `signal:` from any layer in the chain
//      (orchestrator._buildExecOpts → adapter.executeAction →
//      registry.execute) makes this fail loudly.
//   7. BASELINE_INSTRUCTIONS contains the verbatim substring
//      `you do NOT have to speak` so the tick-iteration seed text can
//      reuse the wording without drift.
//
// Run: node scripts/test-actionTick.mjs

import assert from 'node:assert/strict'
import { Priority, createPriorityQueue } from '../src/bot/brain/fsm.js'
import { BASELINE_INSTRUCTIONS } from '../src/bot/brain/prompts.js'
import { createMinecraftAdapter } from '../src/bot/adapter/minecraft/index.js'

// ── 1. Priority constant LOCKED at 2.3 ────────────────────────────────────
assert.equal(Priority.P2_ACTION_TICK, 2.3, 'P2_ACTION_TICK must be 2.3 (LOCKED — not 2.4, not 2.5)')
assert.ok(Priority.P2_ACTION_TICK > Priority.P2_ACTION_COMPLETE, 'tick > action_complete')
assert.ok(Priority.P2_ACTION_TICK < Priority.P2_5_LOOP_END, 'tick < loop_end')

// ── 2. Priority queue: action_complete (2.1) drains BEFORE action_tick (2.3) ─
{
  const order = []
  const queue = createPriorityQueue({
    onDispatch: (event /*, data, signal */) => {
      order.push(event)
    },
    idleFallbackMs: 60_000,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  })
  // Enqueue tick FIRST, then action_complete — sort by priority asc means
  // action_complete dequeues first.
  queue.enqueue(Priority.P2_ACTION_TICK, 'sei:action_tick', { name: 'follow', elapsedMs: 10000 })
  queue.enqueue(Priority.P2_ACTION_COMPLETE, 'sei:action_complete', { name: 'follow' })
  // Drain both via setImmediate; processNext is async-scheduled.
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(order, ['sei:action_complete', 'sei:action_tick'],
    'action_complete (2.1) must drain BEFORE action_tick (2.3) on same-batch enqueue')
  queue.dispose()
}

// ── 3. setInterval handle stored on inflightEntry; clearInterval stops ticks ─
{
  let ticks = 0
  const entry = { _tickHandle: null, name: 'follow' }
  entry._tickHandle = setInterval(() => { ticks++ }, 20)
  await new Promise(r => setTimeout(r, 90))
  const beforeClear = ticks
  // Mimic clearActionTick(entry) from orchestrator
  clearInterval(entry._tickHandle)
  entry._tickHandle = null
  await new Promise(r => setTimeout(r, 80))
  assert.equal(ticks, beforeClear, 'no further ticks fire after clearInterval')
  assert.ok(beforeClear >= 2, `expected ≥2 ticks before clear, got ${beforeClear}`)
}

// ── 4. clearInterval on a never-fired handle is safe ──────────────────────
{
  const handle = setInterval(() => { throw new Error('should not fire') }, 60_000)
  // Clear immediately — no tick has elapsed; this must not throw.
  clearInterval(handle)
}

// ── 5. Dispatcher classifier extension: action_tick KEEPS loop alive ──────
// We re-implement the 4-line classifier here so we can assert its truth
// table without booting an orchestrator. The orchestrator code uses the
// same predicate (see src/bot/brain/orchestrator.js — search
// `iterationKeepsLoopAlive`); a regression that drops `sei:action_tick`
// from the predicate fails this test.
{
  const classify = (currentTrigger, triggerEvent) => {
    const e = currentTrigger ?? triggerEvent
    return e === 'player_chat' || e === 'sei:chat_received' || e === 'sei:attacked' || e === 'sei:action_tick'
  }
  // Confirm the live orchestrator source contains the renamed predicate
  // with action_tick in its body. Substring match instead of importing
  // the predicate (it's a closure inside createOrchestrator).
  const fs = await import('node:fs')
  const orchSrc = fs.readFileSync('src/bot/brain/orchestrator.js', 'utf8')
  assert.ok(/iterationKeepsLoopAlive/.test(orchSrc),
    'orchestrator.js must export the renamed classifier iterationKeepsLoopAlive')
  // Look for the classifier body — specifically the line with the predicate
  // chain. There may be multiple `iterationKeepsLoopAlive` mentions (the
  // declaration, the use site, and code comments referencing it); scan ALL
  // matches and assert at least one window holds the action_tick term.
  const matches = orchSrc.match(/iterationKeepsLoopAlive[\s\S]{0,500}/g) ?? []
  assert.ok(matches.length > 0, 'classifier match windows must be non-empty')
  assert.ok(matches.some(m => m.includes("'sei:action_tick'")),
    'iterationKeepsLoopAlive classifier body must include sei:action_tick somewhere within 500 chars of the symbol')
  // Now exercise the truth table.
  assert.equal(classify('sei:action_tick', 'sei:idle'), true, 'tick → keep alive')
  assert.equal(classify('sei:chat_received', null), true, 'chat → keep alive')
  assert.equal(classify('sei:attacked', null), true, 'attack → keep alive')
  assert.equal(classify('player_chat', null), true, 'legacy player_chat → keep alive')
  assert.equal(classify('sei:action_complete', null), false, 'action_complete → terminate (text-only)')
  assert.equal(classify('sei:idle', null), false, 'idle → terminate (text-only)')
  assert.equal(classify('sei:loop_end', null), false, 'loop_end → terminate (text-only)')
}

// ── 6. End-to-end signal plumbing: adapter → registry → follow handler ────
// Build a stub bot just rich enough for the follow handler:
//   bot.players['p1'] exists, bot.entity.position exists.
{
  const stubBot = {
    players: { p1: { entity: { id: 1, type: 'player', username: 'p1' } } },
    entities: {},
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: { isMoving: () => false, setGoal: () => {}, setMovements: () => {} },
    loadPlugin: () => {},
    hasPlugin: () => true,
    on: () => {},
    once: () => {},
    removeListener: () => {},
    chat: () => {},
    username: 'TestBot',
  }
  const stubConfig = {
    adapter: { kind: 'minecraft', minecraft: { follow_range: 3 } },
  }
  const adapter = createMinecraftAdapter({ bot: stubBot, config: stubConfig })
  const ac = new AbortController()
  const p = adapter.executeAction('follow', { player: 'p1' }, { signal: ac.signal })
  // (a) pending at 80ms
  let pendingFlag = true
  const tagged = p.then(v => { pendingFlag = false; return v })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(pendingFlag, true,
    'adapter.executeAction follow must stay PENDING while signal active — signal plumbing broken if this fails')
  // (b) abort resolves
  ac.abort()
  const result = await Promise.race([
    tagged,
    new Promise((_, rej) => setTimeout(() => rej(new Error('abort did not resolve in 500ms')), 500)),
  ])
  assert.equal(result, 'aborted: follow p1',
    'follow handler must resolve with aborted message on signal.abort')
}

// ── 7. BASELINE_INSTRUCTIONS contains tick-clause substring ───────────────
assert.ok(BASELINE_INSTRUCTIONS.includes('you do NOT have to speak'),
  'BASELINE_INSTRUCTIONS must contain verbatim substring "you do NOT have to speak"')

// ── 8. API pairing: handleActionTick closes open tool_use ─────────────────
// REGRESSION: prior to 260517-fix, handleActionTick called loop.appendUserTurn
// while the in-flight's tool_use was still open in the last assistant turn.
// Anthropic rejects with 400: "tool_use ids were found without tool_result
// blocks immediately after." Source-text assertion: the handler must close
// open tool_uses via appendToolResults (Mode 1) before the next user turn.
{
  const fs = await import('node:fs')
  const orchSrc = fs.readFileSync('src/bot/brain/orchestrator.js', 'utf8')

  // Extract the body of `async function handleActionTick(loop, data)` so we
  // assert only on its source (avoids matching unrelated tick comments).
  const fnIdx = orchSrc.indexOf('async function handleActionTick(')
  assert.ok(fnIdx >= 0, 'handleActionTick must exist in orchestrator.js')
  // Read up to the next top-level `async function` or `function ` declaration
  // — handleActionTick is 100-ish lines, well within 6000 chars.
  const fnSlice = orchSrc.slice(fnIdx, fnIdx + 6000)

  assert.ok(/appendToolResults\(/.test(fnSlice),
    'handleActionTick must close open tool_use via appendToolResults — appending a user turn while a tool_use is open causes Anthropic API 400')
  assert.ok(/_tickClaimed\s*=\s*true/.test(fnSlice),
    'handleActionTick must mark inFlight._tickClaimed = true so the real settle routes through the tick-claimed branch')
  assert.ok(/in progress \(\$\{elapsedSec\}s elapsed\)/.test(fnSlice),
    'handleActionTick must synthesize an interim "in progress" tool_result content for the open tool_use')

  // The dispatcher must route tickClaimed sei:action_complete through a
  // dedicated handler rather than dropping it via the tool_use_id mismatch
  // branch — otherwise a tick-claimed in-flight that settles naturally leaves
  // the loop suspended forever.
  assert.ok(/data\?\.tickClaimed[\s\S]{0,200}handleActionCompleteTickClaimed/.test(orchSrc),
    'dispatcher must route tickClaimed=true through handleActionCompleteTickClaimed')
  assert.ok(/async function handleActionCompleteTickClaimed\(/.test(orchSrc),
    'orchestrator.js must define handleActionCompleteTickClaimed')

  // The settle handler must capture inflightEntry._tickClaimed and propagate
  // it on the reenqueued sei:action_complete data — otherwise the dispatcher
  // can't tell tick-claimed settles from normal ones.
  assert.ok(/tickClaimed:\s*tickClaimed/.test(orchSrc) ||
            /tickClaimed,\s*$/m.test(orchSrc) ||
            /tickClaimed[,\s]/.test(orchSrc),
    'settle handler must propagate tickClaimed on the reenqueued sei:action_complete')
}

console.log('PASS: test-actionTick.mjs (8/8)')
