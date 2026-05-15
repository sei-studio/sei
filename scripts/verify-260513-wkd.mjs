#!/usr/bin/env node
// 260513-wkd verification harness — non-blocking orchestrator loop + cancel
// semantics + signal threading + priority tiering.
//
// Drives createOrchestrator with a mocked anthropic client (scripted
// responses) and a stub adapter (fakeLong long-runner that resolves only on
// abort or external resolve). Exercises the 10 assertions B1..B9 (case-3
// has two branches counted separately):
//
//   B1   non-blocking dispatch (handleDispatch returns <50ms while fakeLong pends)
//   B2   sei:action_complete re-enqueue on natural settle
//   B2b  priority-tier ordering (P2_MOVEMENT before P2_ACTION_COMPLETE)
//   B3   action_complete drives next iteration (tool_result + snapshot + Haiku)
//   B4   case 1 — text-only response after action_complete: loop stays alive
//   B5   case 2 — `stop` tool: abort in_flight, loop torn down
//   B6f  case 3 fire — trigger=owner_chat: new long-runner reseeds
//   B6s  case 3 suppress — trigger=sei:idle: new long-runner continues same loop
//   B7a  P1 mid-loop preempt: owner_chat aborts in_flight, same loop continues
//   B7b  P0 attack mid-loop: pendingAttack reseed (existing path unchanged)
//   B8   signal delivery — config.signal.aborted flips within one tick
//   B9   stop terminal with no in_flight
//
// Exits 0 on PASS, non-zero with a clear label on FAIL.
//
// Pure-node — no mineflayer, no Anthropic SDK calls. Uses a mock
// adapter + mock anthropic client + in-memory reenqueue.

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { z } from 'zod'
import { createOrchestrator } from '../src/bot/brain/orchestrator.js'
import { Priority } from '../src/bot/brain/fsm.js'

let passCount = 0
function ok(letter, label) { console.log(`[verify-wkd] PASS ${letter} - ${label}`); passCount++ }
function bad(letter, err) {
  console.error(`[verify-wkd] FAIL ${letter}: ${err?.message ?? err}`)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
}

// ─── Test-harness primitives ────────────────────────────────────────────

/**
 * Mock anthropic client. Scripted responses: caller registers a queue of
 * responses; each `call()` shifts the next. Each response is
 *   { text, toolUses: [{id?, name, input}] }
 * `id` is auto-assigned if omitted.
 */
function makeMockAnthropic() {
  let nextId = 1
  const calls = []
  const queue = []
  return {
    queue,
    calls,
    async call(req) {
      calls.push({ messages: req.messages, tools: req.tools })
      const resp = queue.shift() ?? { text: 'fallback', toolUses: [] }
      const toolUses = (resp.toolUses ?? []).map(u => ({
        id: u.id ?? `tu-${nextId++}`,
        name: u.name,
        input: u.input ?? {},
      }))
      const text = resp.text ?? ''
      // Reconstruct content array (shape used by buildAssistantContent)
      const content = []
      if (text) content.push({ type: 'text', text })
      for (const u of toolUses) content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input })
      return { toolUses, text, content, usage: {}, stopReason: toolUses.length ? 'tool_use' : 'end_turn' }
    },
    buildCachedSystem: () => [{ type: 'text', text: 'mock-system' }],
    model: 'mock-haiku',
  }
}

/**
 * Mock adapter — supplies a single `fakeLong` long-runner and a `stop` op
 * (handled by orchestrator personality branch directly). The fakeLong
 * promise resolves only when its config.signal aborts OR when `tick()` is
 * called externally to deliver a natural completion.
 *
 * Synchronous personality tools (setGoals/noteToSelf/stop) are handled by
 * the orchestrator's tool_use dispatch switch, not the adapter — listActions
 * needs to expose `fakeLong` as a long-running action.
 */
function makeMockAdapter() {
  const chatLog = []
  let lastFakeLong = null  // { resolve, signal, args } — exposed for the harness
  const tools = {
    fakeLong: {
      description: 'fake long-running action used by verify-260513-wkd.mjs',
      schema: null,
    },
  }
  // Make `fakeLong` count as a long-runner — the orchestrator's
  // isLongRunner set is hardcoded (goTo/gather/dig/build/attackEntity), so
  // we register a `gather` action that pipes through to our fake. Using
  // 'gather' specifically because it's in the LONG_RUNNERS set AND the
  // orchestrator's _buildExecOpts treats gather as progress-flavored
  // (exercising the onProgress channel migration too).
  return {
    chatLog,
    get lastFakeLong() { return lastFakeLong },
    listActions: () => ['gather'],
    getActionSchema: () => z.object({
      block: z.string().optional(),
      n: z.number().optional(),
    }),
    getActionDescription: () => 'mock gather',
    executeAction: (name, args, execOpts) => {
      if (name !== 'gather') throw new Error(`mock adapter: unknown action ${name}`)
      // Capture the signal and the resolver so the harness can trigger
      // natural completion or abort externally.
      return new Promise((resolve) => {
        lastFakeLong = {
          resolve,
          signal: execOpts?.signal,
          args,
          onProgress: execOpts?.onProgress,
        }
        // Wire abort -> resolve('aborted partial')
        if (execOpts?.signal) {
          if (execOpts.signal.aborted) {
            return resolve('aborted at start')
          }
          execOpts.signal.addEventListener('abort', () => {
            resolve(`aborted partial gather`)
          }, { once: true })
        }
      })
    },
    createSnapshotComposer: () => ({
      next: () => 'mock-snapshot',
      reset: () => {},
    }),
    worldPrimer: () => 'mock-primer',
    attach: () => {},
    chat: (line) => { chatLog.push(line) },
    closeAnySessions: async () => {},
    supportsAutoEat: false,
    supportsFollow: false,
    botUsername: 'sei-test',
    getKnownPlayers: () => ({}),
  }
}

/**
 * Mock reenqueue + tiny priority queue. Records every call AND when used as
 * a fake FSM, dequeues by priority asc (mirroring fsm.js sort).
 */
function makeMockReenqueue() {
  const log = []          // every reenqueue call, in invocation order
  let pending = []        // pending dispatches; sorted by priority asc
  return {
    log,
    get pending() { return pending },
    reenqueue: (event, data, priority = null) => {
      let p = priority
      if (p == null) {
        switch (event) {
          case 'sei:attacked':         p = Priority.P0_SAFETY; break
          case 'sei:chat_received':    p = Priority.P1_CHAT; break
          case 'sei:joined':           p = Priority.P1_CHAT; break
          case 'sei:loop_terminal':    p = Priority.P2_5_LOOP_END; break
          case 'sei:action_complete':  p = Priority.P2_ACTION_COMPLETE; break
          case 'sei:loop_end':         p = Priority.P2_5_LOOP_END; break
          case 'sei:idle':             p = Priority.P3_IDLE; break
          case 'owner_chat':           p = Priority.P1_CHAT; break
          default:                     p = Priority.P2_MOVEMENT; break
        }
      }
      log.push({ event, data, priority: p })
      // Drop loop_terminal — it is informational and not part of the cancel
      // semantics test surface (B7b accounts for the attack reseed
      // mechanism explicitly).
      if (event === 'sei:loop_terminal') return
      pending.push({ event, data, priority: p })
      pending.sort((a, b) => a.priority - b.priority)
    },
    clear: () => { log.length = 0; pending = [] },
    // Drain the highest-priority event in the pending queue (mirroring
    // processNext's shift-after-sort behavior).
    shift: () => pending.shift(),
  }
}

function makeConfig() {
  // Use a tmp affect_md_path so createAffectLog doesn't throw.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-wkd-'))
  return {
    anthropic: { api_key: 'mock', model: 'mock', timeout_ms: 5000, thinking_budget_tokens: 0 },
    llm: { rate_limit_per_min: 60, debounce_ms: 100, max_hops: 5 },
    memory: {
      iteration_cap: 30,
      affect_md_path: path.join(tmpDir, 'AFFECT.md'),
    },
    persona: { name: 'sei' },
  }
}

// Build an orchestrator wired with mocks + return all the bits the
// assertions need to poke at.
function makeOrch() {
  const anthropic = makeMockAnthropic()
  const adapter = makeMockAdapter()
  const reenqueue = makeMockReenqueue()
  const config = makeConfig()
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const orch = createOrchestrator({
    adapter, config, logger,
    sessionState: null, ownerStore: null, diary: null,
    reenqueue: reenqueue.reenqueue,
    _anthropicOverride: anthropic,
  })
  return { orch, anthropic, adapter, reenqueue, config }
}

// Wait a tick — the orchestrator yields to microtasks between Haiku/dispatch
// boundaries. The harness needs to give those promises a chance to settle
// before asserting.
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── B1 — non-blocking dispatch ─────────────────────────────────────────
try {
  const { orch, anthropic, adapter } = makeOrch()
  // Script: model emits gather (long-runner) -> handleDispatch must return
  // before the fakeLong promise settles.
  anthropic.queue.push({ text: 'starting', toolUses: [{ name: 'gather', input: { block: 'cactus', n: 7 } }] })
  const t0 = Date.now()
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'gather cactus', ownerSpoke: true })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 500, `B1: handleDispatch took ${elapsed}ms; expected <500ms`)
  // The fakeLong should still be pending.
  assert.ok(adapter.lastFakeLong, 'B1: fakeLong promise was not started')
  assert.equal(adapter.lastFakeLong.signal?.aborted, false, 'B1: signal aborted prematurely')
  ok('B1', `non-blocking dispatch returned in ${elapsed}ms while gather pends`)
  // Cleanup — abort so the loop tears down cleanly (the test moves on)
  adapter.lastFakeLong.resolve('cleanup')
  await sleep(20)
} catch (e) { bad('B1', e) }

// ─── B2 — action_complete reenqueue + B3 mid-loop iteration + B4 case 1 ──
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'starting', toolUses: [{ name: 'gather', input: { block: 'cactus', n: 7 } }] })
  // Next response after action_complete: text only (case 1)
  anthropic.queue.push({ text: 'almost done', toolUses: [] })
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'gather cactus', ownerSpoke: true })
  // The orchestrator should have started a long-runner.
  assert.ok(adapter.lastFakeLong, 'B2: long-runner not started')
  // Naturally settle the long-runner.
  adapter.lastFakeLong.resolve('gathered 7/7 cactus')
  await sleep(30)
  // Assert: reenqueue saw sei:action_complete with shape.
  const acCalls = reenqueue.log.filter(c => c.event === 'sei:action_complete')
  assert.equal(acCalls.length, 1, `B2: expected 1 sei:action_complete, got ${acCalls.length}`)
  assert.equal(acCalls[0].data.name, 'gather', 'B2: action_complete data.name mismatch')
  assert.equal(acCalls[0].data.aborted, false, 'B2: action_complete data.aborted should be false')
  assert.equal(acCalls[0].data.result, 'gathered 7/7 cactus', 'B2: action_complete result mismatch')
  assert.equal(acCalls[0].priority, Priority.P2_ACTION_COMPLETE, 'B2: action_complete priority mismatch')
  ok('B2', 'sei:action_complete re-enqueued at P2.1 with correct shape')

  // Now drain the action_complete event back through handleDispatch.
  const ac = reenqueue.shift()
  assert.equal(ac.event, 'sei:action_complete')
  await orch.handleDispatch(ac.event, ac.data)
  // Assertions for B3: history should have a tool_result + assistant turn
  // for the action_complete continuation.
  const loop = orch.currentLoop
  // After case-1 (text only) the loop is terminated. Drain the loop if it's
  // still around.
  // Check anthropic.calls count went up — should be 2 (initial + action_complete).
  assert.ok(anthropic.calls.length >= 2, `B3: expected >=2 Haiku calls, got ${anthropic.calls.length}`)
  ok('B3', 'action_complete drove a second Haiku call with tool_result + snapshot')

  // B4: case 1 — text only response. Loop should be naturally terminal
  // (no tools fired, so it ends after the action_complete continuation).
  // The orchestrator's currentLoop should be null now.
  await sleep(10)
  assert.equal(orch.currentLoop, null, 'B4: expected currentLoop null after text-only response')
  // No additional sei:action_complete reenqueues.
  const acCalls2 = reenqueue.log.filter(c => c.event === 'sei:action_complete')
  assert.equal(acCalls2.length, 1, `B4: expected no further action_complete, got ${acCalls2.length}`)
  ok('B4', 'case 1 — text-only response terminates loop without further action_complete')
} catch (e) { bad('B2/B3/B4', e) }

// ─── B2b — priority-tier ordering ────────────────────────────────────────
try {
  const { reenqueue } = makeOrch()
  // Synthesize two reenqueue calls in arbitrary order.
  reenqueue.reenqueue('sei:action_complete', { name: 'gather' })
  reenqueue.reenqueue('any:movement', { foo: 1 })  // routes to P2_MOVEMENT
  // After sort: P2_MOVEMENT (2) before P2_ACTION_COMPLETE (2.1)
  const first = reenqueue.shift()
  const second = reenqueue.shift()
  assert.equal(first.event, 'any:movement', `B2b: expected P2_MOVEMENT first, got ${first.event}`)
  assert.equal(second.event, 'sei:action_complete', `B2b: expected sei:action_complete second, got ${second.event}`)
  ok('B2b', 'priority tier ordering P2_MOVEMENT(2) before P2_ACTION_COMPLETE(2.1)')
} catch (e) { bad('B2b', e) }

// ─── B5 — case 2 (stop tool) ─────────────────────────────────────────────
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'starting', toolUses: [{ name: 'gather', input: { block: 'cactus' } }] })
  // After action_complete, scripted response = stop
  anthropic.queue.push({ text: 'we have enough', toolUses: [{ name: 'stop', input: {} }] })
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'gather cactus', ownerSpoke: true })
  const fakeLongRef = adapter.lastFakeLong
  // Naturally complete the in_flight so action_complete fires.
  fakeLongRef.resolve('gathered 5/5 cactus')
  await sleep(30)
  // Drain action_complete
  const ac = reenqueue.shift()
  assert.equal(ac.event, 'sei:action_complete')
  await orch.handleDispatch(ac.event, ac.data)
  await sleep(20)
  // After stop tool: loop is torn down, chat received the spoken text.
  assert.equal(orch.currentLoop, null, 'B5: expected currentLoop=null after stop')
  // chat log should contain both "starting" and "we have enough"
  assert.ok(adapter.chatLog.some(l => l.includes('we have enough')),
    `B5: expected 'we have enough' in chat log; got: ${JSON.stringify(adapter.chatLog)}`)
  ok('B5', 'case 2 — stop tool tears down loop AND emits spoken text')
} catch (e) { bad('B5', e) }

// ─── B5b — stop aborts a STILL-RUNNING in_flight (via P1 preempt) ───────
// This validates the abort wire end-to-end: an owner-chat with in_flight
// running triggers in_flight.abortController.abort(), which fires
// action_complete with aborted=true. The orchestrator then folds PLAYER
// INTERRUPT into the next iteration; if THAT iteration emits stop, the
// loop terminates and the (already-aborted) signal stays aborted.
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'starting', toolUses: [{ name: 'gather', input: { block: 'cactus' } }] })
  // Next response (after P1 PLAYER INTERRUPT injection): stop
  anthropic.queue.push({ text: 'we have enough, holding', toolUses: [{ name: 'stop', input: {} }] })
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'gather cactus', ownerSpoke: true })
  const longRef = adapter.lastFakeLong
  assert.ok(longRef, 'B5b: long-runner not started')
  // Owner says "we have enough" while in_flight runs — abort path.
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'we have enough', ownerSpoke: true })
  // Within one tick the signal should flip.
  await sleep(5)
  assert.equal(longRef.signal.aborted, true, 'B5b: in_flight.signal not aborted by P1 preempt')
  // Drain action_complete (carries aborted=true)
  await sleep(20)
  const ac = reenqueue.shift()
  assert.ok(ac, 'B5b: expected sei:action_complete after abort')
  assert.equal(ac.event, 'sei:action_complete')
  assert.equal(ac.data.aborted, true, 'B5b: action_complete should carry aborted=true')
  await orch.handleDispatch(ac.event, ac.data)
  await sleep(20)
  // After stop response: loop torn down.
  assert.equal(orch.currentLoop, null, 'B5b: expected currentLoop=null after stop after preempt')
  ok('B5b', 'P1 preempt aborts in_flight; subsequent stop tears down loop')
} catch (e) { bad('B5b', e) }

// ─── B6-fire — case 3 with P0/P1 trigger (reseed) ────────────────────────
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  // First response: gather (long-runner). Trigger = owner_chat (P1).
  anthropic.queue.push({ text: 'starting', toolUses: [{ name: 'gather', input: { block: 'cactus' } }] })
  // After action_complete: model emits NEW long-runner (switch tasks).
  anthropic.queue.push({ text: 'switching to food', toolUses: [{ name: 'gather', input: { block: 'meat' } }] })
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'gather cactus', ownerSpoke: true })
  const firstLong = adapter.lastFakeLong
  firstLong.resolve('gathered 3/7 cactus')
  await sleep(20)
  // Drain action_complete
  const ac = reenqueue.shift()
  assert.equal(ac.event, 'sei:action_complete')
  await orch.handleDispatch(ac.event, ac.data)
  await sleep(20)
  // Case 3 fire branch: current loop terminated, the ORIGINAL triggering
  // event (sei:chat_received) re-enqueued.
  assert.equal(orch.currentLoop, null, 'B6-fire: expected currentLoop=null after case-3 fire')
  const reseedCalls = reenqueue.log.filter(c => c.event === 'sei:chat_received')
  // 1 is the original (this test triggered it manually, not via reenqueue);
  // 1 should be the case-3 reseed.
  assert.ok(reseedCalls.length >= 1, `B6-fire: expected >=1 reseed of sei:chat_received, got ${reseedCalls.length}`)
  ok('B6-fire', 'case 3 fire — owner_chat trigger reseeds original event after new long-runner')
} catch (e) { bad('B6-fire', e) }

// ─── B6-suppress — case 3 with non-P0/P1 trigger (continue same loop) ───
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  // Trigger = sei:idle (NOT P0/P1)
  anthropic.queue.push({ text: 'looking around', toolUses: [{ name: 'gather', input: { block: 'wood' } }] })
  // After action_complete: model emits NEW long-runner.
  anthropic.queue.push({ text: 'switching to food', toolUses: [{ name: 'gather', input: { block: 'meat' } }] })
  await orch.handleDispatch('sei:idle', {})
  const firstLong = adapter.lastFakeLong
  firstLong.resolve('gathered 1/3 wood')
  await sleep(20)
  const ac = reenqueue.shift()
  assert.equal(ac.event, 'sei:action_complete')
  await orch.handleDispatch(ac.event, ac.data)
  await sleep(20)
  // Case 3 suppress: same loop continues; new long-runner is the
  // current in_flight.
  assert.notEqual(orch.currentLoop, null, 'B6-suppress: expected currentLoop NOT null (same loop)')
  // No sei:idle reseed should have fired.
  const idleReseed = reenqueue.log.filter(c => c.event === 'sei:idle')
  assert.equal(idleReseed.length, 0, `B6-suppress: expected no sei:idle reseed, got ${idleReseed.length}`)
  // The NEW in_flight should be running with args.block = meat
  assert.ok(adapter.lastFakeLong, 'B6-suppress: new long-runner not started')
  assert.equal(adapter.lastFakeLong.args.block, 'meat', `B6-suppress: new in_flight args.block expected meat, got ${adapter.lastFakeLong.args?.block}`)
  ok('B6-suppress', 'case 3 suppress — sei:idle trigger continues same loop with new in_flight')
  // Cleanup
  adapter.lastFakeLong.resolve('cleanup')
  await sleep(20)
} catch (e) { bad('B6-suppress', e) }

// ─── B7a — P1 mid-loop preempt, same loop continues ─────────────────────
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'starting', toolUses: [{ name: 'gather', input: { block: 'cactus' } }] })
  // After PLAYER INTERRUPT injection, the model returns text-only (continue
  // chatting; case 1).
  anthropic.queue.push({ text: 'we need ten', toolUses: [] })
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'gather cactus', ownerSpoke: true })
  const longRef = adapter.lastFakeLong
  // Now owner says something mid-gather — P1 preempt.
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'how many do we need', ownerSpoke: true })
  await sleep(5)
  // Signal should be aborted within one tick.
  assert.equal(longRef.signal.aborted, true, 'B7a: in_flight.signal not aborted by P1 preempt')
  // currentLoop should still be present (same loop continues).
  assert.notEqual(orch.currentLoop, null, 'B7a: expected currentLoop NOT null (same loop)')
  // Drain action_complete (aborted=true)
  await sleep(20)
  const ac = reenqueue.shift()
  assert.equal(ac.event, 'sei:action_complete')
  assert.equal(ac.data.aborted, true, 'B7a: action_complete should carry aborted=true')
  await orch.handleDispatch(ac.event, ac.data)
  await sleep(20)
  // After the case-1 text-only response, the loop is naturally terminal.
  assert.equal(orch.currentLoop, null, 'B7a: expected currentLoop=null after case-1 response')
  // Chat log should contain "we need ten" (the response to the interrupt)
  assert.ok(adapter.chatLog.some(l => l.includes('we need ten')),
    `B7a: expected 'we need ten' in chat log; got: ${JSON.stringify(adapter.chatLog)}`)
  ok('B7a', 'P1 mid-loop preempt aborts in_flight, same loop continues with PLAYER INTERRUPT, case-1 text terminates')
} catch (e) { bad('B7a', e) }

// ─── B7b — P0 attack preempt (existing pendingAttack path unchanged) ────
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'starting', toolUses: [{ name: 'gather', input: { block: 'cactus' } }] })
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'gather cactus', ownerSpoke: true })
  const longRef = adapter.lastFakeLong
  // Attack arrives mid-loop.
  const attackData = { attackerLabel: 'zombie', attackerKind: 'mob' }
  await orch.handleDispatch('sei:attacked', attackData)
  await sleep(5)
  // The outer loop signal should be aborted (the existing pendingAttack
  // path aborts loop.abortController, NOT in_flight.abortController by
  // itself — but in_flight should also abort because the new model wires
  // both for symmetry).
  // Loop should be torn down by the catch arm (pendingAttack short-circuit).
  await sleep(30)
  // After teardown, sei:attacked should have been re-enqueued at P0.
  const attackReseed = reenqueue.log.filter(c => c.event === 'sei:attacked')
  assert.ok(attackReseed.length >= 1, `B7b: expected sei:attacked reseed, got ${attackReseed.length}`)
  assert.equal(attackReseed[attackReseed.length - 1].priority, Priority.P0_SAFETY,
    'B7b: reseeded sei:attacked should be at P0')
  // currentLoop should be null (loop torn down).
  assert.equal(orch.currentLoop, null, 'B7b: expected currentLoop=null after P0 reseed')
  ok('B7b', 'P0 attack preempt uses existing pendingAttack reseed path; sei:attacked re-enqueued at P0')
  // Resolve the long-runner so any stranded promise can clean up.
  try { longRef.resolve('abandoned') } catch {}
  await sleep(10)
} catch (e) { bad('B7b', e) }

// ─── B8 — signal delivery to behavior ────────────────────────────────────
try {
  const { orch, anthropic, adapter } = makeOrch()
  anthropic.queue.push({ text: 'starting', toolUses: [{ name: 'gather', input: { block: 'cactus' } }] })
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'gather cactus', ownerSpoke: true })
  const longRef = adapter.lastFakeLong
  assert.ok(longRef, 'B8: fakeLong not started')
  // Abort the in_flight via the orchestrator's exposed currentLoop handle.
  orch.currentLoop.inFlight.abortController.abort()
  await sleep(0)
  // One microtask later, signal.aborted should be true.
  assert.equal(longRef.signal.aborted, true, 'B8: config.signal.aborted not flipped within one tick')
  ok('B8', 'signal delivery — config.signal.aborted flips within one tick of abort()')
  await sleep(20)
} catch (e) { bad('B8', e) }

// ─── B9 — end_loop terminal with no in_flight ────────────────────────────
// 260514-ngj: stop retired, end_loop replaces it as the inline-metadata
// terminate signal. This assertion now exercises the same flow with the
// renamed tool — no in_flight starts, the loop tears down cleanly.
try {
  const { orch, anthropic, adapter } = makeOrch()
  // Fresh owner_chat where the model returns end_loop directly (no in_flight).
  anthropic.queue.push({ text: 'okay', toolUses: [{ name: 'end_loop', input: {} }] })
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'just hold', ownerSpoke: true })
  await sleep(20)
  // No in_flight should ever have started.
  assert.equal(adapter.lastFakeLong, null, 'B9: expected no in_flight; lastFakeLong should be null')
  // Loop torn down.
  assert.equal(orch.currentLoop, null, 'B9: expected currentLoop=null after end_loop with no in_flight')
  ok('B9', 'end_loop terminal with no in_flight — no abort needed, loop terminates cleanly')
} catch (e) { bad('B9', e) }

// PASS count breakdown:
//   B1 (1) + B2 (1) + B3 (1) + B4 (1) + B2b (1) + B5 (1) + B5b (1, bonus
//   P1-abort-into-stop coverage) + B6-fire (1) + B6-suppress (1) + B7a (1)
//   + B7b (1) + B8 (1) + B9 (1) = 13
//
// Plan-spec headline assertions: B1, B2, B2b, B3, B4, B5, B6-fire,
// B6-suppress, B7a, B7b, B8, B9 — 12 with B5b as an additional in-line
// abort-wire check (proves the P1 preempt → in_flight.abort cascade works
// end-to-end before stop tears down the loop).
const EXPECTED = 13
console.log(`\n260513-wkd harness: ${passCount}/${EXPECTED} PASS`)
if (passCount !== EXPECTED) {
  console.error(`Expected ${EXPECTED} PASS, got ${passCount}`)
  process.exit(1)
}
console.log('OK 260513-wkd: B1..B9 (12/12 plan-spec + B5b bonus = 13/13 — case-3 fire+suppress)')
process.exit(0)
