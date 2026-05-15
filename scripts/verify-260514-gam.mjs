#!/usr/bin/env node
// 260514-gam verification harness — universal non-blocking inflight + batched
// tool_use serialization via loop._pendingToolUses.
//
// Sister harness to verify-260513-wkd.mjs. That one proved long-runners
// (gather/goTo/dig/build/attackEntity) suspend cleanly via the
// action_complete contract; this one proves the same model now applies to
// every world-touching tool (sync + async alike) and that an N-tool batch
// drains via a single haiku call (not N).
//
// Test cases:
//   G1  every non-INLINE_METADATA tool sets loop.inFlight for the duration
//       of its dispatch (sync tools too)
//   G2  5-tool sync batch drains via _pendingToolUses with exactly ONE
//       callPersonality call after the batch settles
//   G3a chat arrives mid-tool, in_flight aborts, action_complete fires
//       with aborted=true, pendingInterrupt-fold renders PLAYER INTERRUPT
//   G3b tool settles naturally first, chat arrives during the window
//       before action_complete is processed; verify exactly one
//       continuation iteration
//   G4  case-2 stop tool fired while a sync tool is in flight aborts the
//       in_flight (verified via the abort wire end-to-end)
//   G5  case-3 reseed (new long-runner emitted while sync tool is in
//       flight) terminates loop and re-enqueues original trigger
//   G6  grep-gate: LONG_RUNNERS, isLongRunner, runWithInflightAwait,
//       runWithInflight all absent from orchestrator.js
//   G7  mixed batch [noteToSelf, placeBlock, setGoals] — inline-first,
//       suspend-middle, drain-inline-tail ordering
//   G8  regression: INLINE_METADATA tools never set loop.inFlight and
//       never fire sei:action_complete
//
// Pure-node — no mineflayer, no Anthropic SDK calls. Mock adapter that
// supports multiple tool names with delayed-resolve promises so we can
// observe loop.inFlight + queue-drain ordering directly.

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'

import { z } from 'zod'
import { createOrchestrator } from '../src/bot/brain/orchestrator.js'
import { getInFlightLineForSnapshot } from '../src/bot/brain/inflight.js'
import { Priority } from '../src/bot/brain/fsm.js'

let passCount = 0
function ok(letter, label) { console.log(`[verify-gam] PASS ${letter} - ${label}`); passCount++ }
function bad(letter, err) {
  console.error(`[verify-gam] FAIL ${letter}: ${err?.message ?? err}`)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Mock anthropic — scripted responses with auto-assigned IDs ─────────
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
      const content = []
      if (text) content.push({ type: 'text', text })
      for (const u of toolUses) content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input })
      return { toolUses, text, content, usage: {}, stopReason: toolUses.length ? 'tool_use' : 'end_turn' }
    },
    buildCachedSystem: () => [{ type: 'text', text: 'mock-system' }],
    model: 'mock-haiku',
  }
}

// ─── Mock adapter — supports placeBlock, equip, find (sync world-touchers)
// plus gather and goTo (long-runners). Each pending promise is exposed via
// `inFlightList` so the harness can resolve/abort tools in order.
function makeMockAdapter() {
  const chatLog = []
  const pending = []   // FIFO of { name, args, signal, resolve, reject }

  const actionNames = ['placeBlock', 'equip', 'find', 'lookAt', 'dropItem',
                       'gather', 'goTo', 'dig', 'build', 'attackEntity', 'follow']

  return {
    chatLog,
    pending,
    /** Returns the head of the pending FIFO (oldest unresolved). */
    head() { return pending[0] ?? null },
    /** Resolve the head of the FIFO. Shift it off. */
    resolveHead(result) {
      const h = pending.shift()
      if (!h) throw new Error('mock adapter: no pending action to resolve')
      h.resolve(result)
      return h
    },
    listActions: () => actionNames,
    getActionSchema: (name) => {
      if (name === 'placeBlock') return z.object({ x: z.number(), y: z.number(), z: z.number(), block: z.string().optional() })
      if (name === 'equip') return z.object({ item: z.string() })
      if (name === 'find') return z.object({ what: z.string() })
      if (name === 'goTo') return z.object({ x: z.number(), y: z.number(), z: z.number() })
      return z.object({}).passthrough()
    },
    getActionDescription: (name) => `mock ${name}`,
    executeAction: (name, args, execOpts) => {
      if (!actionNames.includes(name)) throw new Error(`mock adapter: unknown action ${name}`)
      return new Promise((resolve, reject) => {
        const entry = { name, args, signal: execOpts?.signal, resolve, reject, onProgress: execOpts?.onProgress }
        pending.push(entry)
        // Wire abort -> resolve with 'aborted partial'. Mirrors the
        // verify-260513-wkd fake behavior so action_complete fires with
        // aborted=true rather than dropping the promise.
        if (execOpts?.signal) {
          if (execOpts.signal.aborted) {
            // Shift this entry off and resolve immediately.
            const idx = pending.indexOf(entry)
            if (idx >= 0) pending.splice(idx, 1)
            return resolve(`aborted at start: ${name}`)
          }
          execOpts.signal.addEventListener('abort', () => {
            const idx = pending.indexOf(entry)
            if (idx >= 0) pending.splice(idx, 1)
            resolve(`aborted partial ${name}`)
          }, { once: true })
        }
      })
    },
    createSnapshotComposer: () => ({ next: () => 'mock-snapshot', reset: () => {} }),
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

// ─── Mock reenqueue + tiny priority queue (mirrors fsm sort). ───────────
function makeMockReenqueue() {
  const log = []
  let pendingQueue = []
  return {
    log,
    get pending() { return pendingQueue },
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
      if (event === 'sei:loop_terminal') return
      pendingQueue.push({ event, data, priority: p })
      pendingQueue.sort((a, b) => a.priority - b.priority)
    },
    clear: () => { log.length = 0; pendingQueue = [] },
    shift: () => pendingQueue.shift(),
  }
}

function makeConfig() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-gam-'))
  return {
    anthropic: { api_key: 'mock', model: 'mock', timeout_ms: 5000, thinking_budget_tokens: 0 },
    llm: { rate_limit_per_min: 60, debounce_ms: 100, max_hops: 5 },
    memory: {
      iteration_cap: 30,
      affect_md_path: path.join(tmpDir, 'AFFECT.md'),
      owner_md_path: path.join(tmpDir, 'OWNER.md'),
    },
    persona: { name: 'sei' },
  }
}

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

// Drain whatever sei:action_complete events are at the head of the pending
// queue (highest-priority first), feeding them back through handleDispatch.
// Returns the number of action_complete events drained.
async function drainActionComplete(orch, reenqueue, max = 10) {
  let drained = 0
  for (let i = 0; i < max; i++) {
    // Find the next action_complete in the queue.
    const ac = reenqueue.pending.find(p => p.event === 'sei:action_complete')
    if (!ac) break
    // Remove it from the queue (in-place).
    const idx = reenqueue.pending.indexOf(ac)
    reenqueue.pending.splice(idx, 1)
    await orch.handleDispatch(ac.event, ac.data)
    drained++
    await sleep(5)
  }
  return drained
}

// ─── G1 — every non-INLINE_METADATA tool sets loop.inFlight ──────────────
// Sub-test: placeBlock (was sync inline pre-260514-gam) must now suspend
// the loop and register loop.inFlight just like gather did.
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'placing', toolUses: [{ name: 'placeBlock', input: { x: 1, y: 2, z: 3, block: 'cactus' } }] })
  // Second response after action_complete continuation — text-only end.
  anthropic.queue.push({ text: 'done', toolUses: [] })
  const dispatchP = orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'place a cactus', ownerSpoke: true })
  // Yield to the dispatch microtasks so the for-loop dispatches the tool.
  await sleep(10)
  // The dispatch should have suspended — currentLoop.inFlight populated
  // with the placeBlock entry, NOT null.
  assert.ok(orch.currentLoop, 'G1: expected an active loop')
  const inflight = orch.currentLoop.inFlight
  assert.ok(inflight, 'G1: expected loop.inFlight to be set for placeBlock')
  assert.equal(inflight.name, 'placeBlock', `G1: expected inFlight.name='placeBlock', got ${inflight?.name}`)
  assert.ok(inflight.abortController instanceof AbortController, 'G1: inFlight.abortController missing')
  // The adapter received an executeAction call.
  assert.equal(adapter.pending.length, 1, `G1: expected 1 pending tool, got ${adapter.pending.length}`)
  assert.equal(adapter.pending[0].name, 'placeBlock', `G1: pending tool mismatch`)
  // Resolve the placeBlock so the loop tears down cleanly.
  adapter.resolveHead('placed')
  await sleep(20)  // let the settle handler enqueue action_complete
  await dispatchP
  await drainActionComplete(orch, reenqueue)
  await sleep(20)
  assert.equal(orch.currentLoop, null, 'G1: expected loop terminated after natural completion')
  ok('G1', 'placeBlock (was sync) now suspends the loop and sets loop.inFlight')
} catch (e) { bad('G1', e) }

// ─── G2 — 5-tool sync batch drains via _pendingToolUses with ONE haiku ──
// Headline test for the bug fix. Pre-260514-gam: the for-loop would call
// runWithInflightAwait sequentially for each placeBlock, blocking inline
// for the full mineflayer timeout per call. Post-260514-gam: dispatch the
// first, suspend, drain via action_complete, suspend, drain, ... until the
// queue is empty — then ONE haiku call for the post-batch text response.
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({
    text: 'placing 5',
    toolUses: [
      { name: 'placeBlock', input: { x: 1, y: 0, z: 0, block: 'cactus' } },
      { name: 'placeBlock', input: { x: 2, y: 0, z: 0, block: 'cactus' } },
      { name: 'placeBlock', input: { x: 3, y: 0, z: 0, block: 'cactus' } },
      { name: 'placeBlock', input: { x: 4, y: 0, z: 0, block: 'cactus' } },
      { name: 'placeBlock', input: { x: 5, y: 0, z: 0, block: 'cactus' } },
    ],
  })
  // Post-batch text-only response — verifies "exactly ONE haiku call after
  // the batch", not 5.
  anthropic.queue.push({ text: 'placed 5', toolUses: [] })

  const dispatchP = orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'place 5 cactus', ownerSpoke: true })
  await sleep(10)
  // After first dispatch: 1 tool in flight, 4 in _pendingToolUses.
  assert.ok(orch.currentLoop?.inFlight, 'G2: expected inFlight after first dispatch')
  assert.equal(orch.currentLoop.inFlight.name, 'placeBlock', 'G2: first inFlight name mismatch')
  assert.equal(orch.currentLoop.inFlight.input.x, 1, 'G2: first inFlight x mismatch')
  assert.equal(orch.currentLoop._pendingToolUses?.length, 4, `G2: expected 4 queued, got ${orch.currentLoop._pendingToolUses?.length}`)
  // Resolve tools in order, draining action_complete between each.
  const xs = []
  for (let k = 1; k <= 5; k++) {
    const inflight = orch.currentLoop?.inFlight
    assert.ok(inflight, `G2: expected inFlight at step ${k}`)
    xs.push(inflight.input.x)
    adapter.resolveHead(`placed-${k}`)
    await sleep(10)
    // Drain ONE action_complete (the most recent settle).
    const drained = await drainActionComplete(orch, reenqueue, 1)
    assert.equal(drained, 1, `G2: expected 1 action_complete drained at step ${k}, got ${drained}`)
  }
  // After 5 tools settled, the queue should be drained and the loop
  // terminated by the case-1 text-only response.
  await dispatchP
  await sleep(20)
  // Verify the in-order dispatch.
  assert.deepEqual(xs, [1, 2, 3, 4, 5], `G2: expected in-order [1..5], got ${JSON.stringify(xs)}`)
  // Exactly 2 anthropic calls: 1 initial + 1 post-batch (NOT 5+).
  assert.equal(anthropic.calls.length, 2, `G2: expected exactly 2 haiku calls (1 initial + 1 post-batch); got ${anthropic.calls.length}`)
  assert.equal(orch.currentLoop, null, 'G2: expected loop terminated after batch')
  ok('G2', '5-tool sync batch drains via _pendingToolUses with exactly ONE post-batch haiku call (was 5)')
} catch (e) { bad('G2', e) }

// ─── G3a — chat mid-tool aborts in_flight, PLAYER INTERRUPT folds ───────
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'finding', toolUses: [{ name: 'find', input: { what: 'cactus' } }] })
  anthropic.queue.push({ text: 'okay holding', toolUses: [] })
  const dispatchP = orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'find cactus', ownerSpoke: true })
  await sleep(10)
  const inflight = orch.currentLoop.inFlight
  assert.ok(inflight, 'G3a: expected inFlight after find dispatch')
  assert.equal(inflight.name, 'find', 'G3a: inFlight name mismatch')
  // Owner sends chat mid-tool.
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'wait here', ownerSpoke: true })
  await sleep(5)
  assert.equal(inflight.abortController.signal.aborted, true, 'G3a: in_flight signal not aborted')
  // The adapter promise resolved with 'aborted partial find' which fires
  // sei:action_complete with aborted=true.
  await sleep(20)
  await drainActionComplete(orch, reenqueue)
  await sleep(20)
  await dispatchP
  // PLAYER INTERRUPT should have folded — the next iteration's
  // appendToolResults eventText carries the chat text.
  const lastCall = anthropic.calls[anthropic.calls.length - 1]
  const lastUserTurn = lastCall.messages[lastCall.messages.length - 1]
  const userText = JSON.stringify(lastUserTurn)
  assert.ok(userText.includes('PLAYER INTERRUPT'), `G3a: expected PLAYER INTERRUPT in last user turn; got ${userText.slice(0, 300)}`)
  assert.ok(userText.includes('wait here'), `G3a: expected chat text 'wait here' in PLAYER INTERRUPT fold; got ${userText.slice(0, 300)}`)
  ok('G3a', 'mid-tool chat aborts in_flight, action_complete carries aborted=true, PLAYER INTERRUPT folds into next user turn')
} catch (e) { bad('G3a', e) }

// ─── G3b — tool settles naturally, chat arrives during processing ───────
// Race window: the tool resolves (action_complete reenqueued), THEN owner
// chat arrives BEFORE handleDispatch processes the action_complete. The
// chat-interrupt branch's `if (currentLoop.inFlight)` skips the in_flight
// abort (correct — inflight already null), sets pendingInterrupt, aborts
// loop.abortController. handleActionComplete then sees pendingInterrupt
// but data.aborted=false (natural settle) — Decision 2 corner: the fold
// only fires when `pendingInterrupt && data.aborted`, otherwise the
// PLAYER INTERRUPT must arrive via the repairAfterAbort path on the next
// iteration's outer abort.
//
// Per CONTEXT.md Decision 2 explicit corner: "if a 1s sync action settles
// at T=0.99s and chat arrives at T=1.00s, loop.inFlight is already null by
// the time chat enters the chat-interrupt branch — the branch's
// `if (currentLoop.inFlight)` guard skips the in_flight abort (correct),
// still sets pendingInterrupt, still aborts loop.abortController. The next
// iteration (driven by handleActionComplete's continuation) picks up
// pendingInterrupt and emits the PLAYER INTERRUPT turn."
//
// The next continuation iteration runs callPersonality with the loop's
// fresh abortController (replaceAbortController was called) — but
// pendingInterrupt is still set. The next response would normally not
// trigger a PLAYER INTERRUPT fold because handleActionComplete already
// passed. The runIterations callPersonality call sees signal.aborted=true
// (no, it doesn't — replaceAbortController already swapped). So actually,
// pendingInterrupt sits there until... the assistant turn appends, and
// then either appendToolResults' eventText carries it (no — only when
// data.aborted), OR runIterations sees the next abort, OR... we need to
// verify the current behavior produces exactly ONE PLAYER INTERRUPT
// iteration.
//
// What we can assert deterministically: (a) the loop continues (not
// torn down), (b) exactly one continuation haiku call fires, (c) no
// duplicate PLAYER INTERRUPT folds.
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'finding', toolUses: [{ name: 'find', input: { what: 'food' } }] })
  anthropic.queue.push({ text: 'okay', toolUses: [] })
  const dispatchP = orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'find food', ownerSpoke: true })
  await sleep(10)
  assert.ok(orch.currentLoop?.inFlight, 'G3b: expected inFlight')
  const inflight = orch.currentLoop.inFlight
  // Natural settle of the tool — action_complete reenqueued.
  adapter.resolveHead('found-at-x10-y0-z5')
  await sleep(5)
  // inFlight should already be null after the settle handler's then().
  assert.equal(orch.currentLoop?.inFlight, null, 'G3b: expected inFlight null after settle')
  // Now owner chat arrives BEFORE action_complete processed. The branch
  // in handleDispatch sets pendingInterrupt and aborts loop.abortController.
  // Note: signal.aborted is false because we just verified inflight is null.
  assert.equal(inflight.abortController.signal.aborted, false, 'G3b: inflight signal should NOT be aborted (natural settle)')
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'come back', ownerSpoke: true })
  await sleep(5)
  // Now drain action_complete.
  await drainActionComplete(orch, reenqueue)
  await sleep(20)
  await dispatchP
  // Exactly 2 anthropic calls (initial + 1 continuation). NO duplicate
  // PLAYER INTERRUPT folds.
  assert.equal(anthropic.calls.length, 2, `G3b: expected 2 haiku calls (1 initial + 1 continuation), got ${anthropic.calls.length}`)
  ok('G3b', 'natural settle then chat during action_complete window: exactly one continuation iteration, no duplicate folds')
} catch (e) { bad('G3b', e) }

// ─── G4 — case-2 end_loop fired while sync inflight is running ──────────
// Setup: model emits [placeBlock]. While placeBlock pends, owner sends
// "stop now". The P1 chat path (chat.js) no longer pre-aborts the body in
// 260514-ngj, so the in_flight abort fires only when the orchestrator's
// P1 dispatch branch sets pendingInterrupt + aborts the in_flight (B7a
// path). The abort cascades to action_complete (aborted=true) which folds
// PLAYER INTERRUPT; the NEXT iteration model emits [end_loop]. Verify
// end_loop tears down the loop cleanly even though loop.inFlight is null
// (placeBlock already aborted).
//
// 260514-ngj: assertion renamed from `stop` to `end_loop` after stop
// retirement.
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'placing', toolUses: [{ name: 'placeBlock', input: { x: 0, y: 0, z: 0, block: 'cactus' } }] })
  anthropic.queue.push({ text: 'stopping', toolUses: [{ name: 'end_loop', input: {} }] })
  const dispatchP = orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'place a cactus', ownerSpoke: true })
  await sleep(10)
  const inflight = orch.currentLoop.inFlight
  assert.ok(inflight, 'G4: expected inFlight after placeBlock dispatch')
  // Owner says stop while in_flight running. The P1 chat path aborts
  // in_flight.abortController (case-2 itself fires on the NEXT iteration
  // when the model emits [stop]).
  await orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'stop now', ownerSpoke: true })
  await sleep(5)
  assert.equal(inflight.abortController.signal.aborted, true, 'G4: in_flight not aborted by P1 chat')
  await sleep(20)
  await drainActionComplete(orch, reenqueue)
  await sleep(20)
  await dispatchP
  // After the [end_loop] response: loop torn down.
  assert.equal(orch.currentLoop, null, 'G4: expected loop terminated after end_loop')
  ok('G4', 'case-2 end_loop after sync inflight aborts in_flight via P1 chat AND end_loop tears down loop')
} catch (e) { bad('G4', e) }

// ─── G5 — case-3 reseed: new long-runner while sync inflight is running ─
// Setup: trigger=owner_chat (P1). Iteration 1 dispatches placeBlock
// (sync, now non-blocking). action_complete continuation iteration emits
// a NEW long-runner [goTo(...)]. Per case-3 with P0/P1 trigger gate, the
// current loop terminates and the original trigger event is re-enqueued.
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({ text: 'placing', toolUses: [{ name: 'placeBlock', input: { x: 0, y: 0, z: 0, block: 'dirt' } }] })
  // Continuation iteration: switch to a NEW long-runner.
  anthropic.queue.push({ text: 'changing plans', toolUses: [{ name: 'goTo', input: { x: 100, y: 64, z: 100 } }] })
  const dispatchP = orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'place a cactus then come back', ownerSpoke: true })
  await sleep(10)
  assert.ok(orch.currentLoop?.inFlight, 'G5: expected inFlight after placeBlock dispatch')
  // Naturally settle the placeBlock.
  adapter.resolveHead('placed')
  await sleep(10)
  await drainActionComplete(orch, reenqueue)
  await sleep(20)
  await dispatchP
  // Case-3 fire path: loop terminated AND original trigger re-enqueued.
  assert.equal(orch.currentLoop, null, 'G5: expected loop terminated after case-3 fire')
  const reseedCalls = reenqueue.log.filter(c => c.event === 'sei:chat_received')
  // One came from the original handleDispatch invocation (recorded by
  // makeMockReenqueue only when reenqueue is called — the test called
  // handleDispatch directly, NOT via reenqueue, so the FIRST chat is NOT
  // in the log). The reseed call IS via reenqueue, so we expect >=1.
  assert.ok(reseedCalls.length >= 1, `G5: expected >=1 sei:chat_received reseed, got ${reseedCalls.length}`)
  ok('G5', 'case-3 reseed after sync inflight settles: loop terminates AND original trigger re-enqueued')
} catch (e) { bad('G5', e) }

// ─── G6 — grep-gate: forbidden tokens absent from orchestrator.js ───────
try {
  let grepOut = ''
  let grepExit = 1
  try {
    grepOut = execSync('grep -nE "\\b(LONG_RUNNERS|isLongRunner|runWithInflightAwait|runWithInflight)\\b" src/bot/brain/orchestrator.js', {
      encoding: 'utf8',
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    })
    grepExit = 0
  } catch (e) {
    grepExit = e.status ?? 1
    grepOut = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
  }
  assert.equal(grepExit, 1, `G6: expected grep to find nothing (exit=1); got exit=${grepExit}, out=${grepOut}`)
  ok('G6', 'LONG_RUNNERS / isLongRunner / runWithInflightAwait / runWithInflight all absent from orchestrator.js')
} catch (e) { bad('G6', e) }

// ─── G7 — mixed batch [noteToSelf, placeBlock, setGoals] ────────────────
// Verifies the in-order processing: noteToSelf fills slot 0 inline (no
// inflight), placeBlock dispatches and suspends with setGoals queued, then
// on action_complete setGoals drains inline before the next haiku call.
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  anthropic.queue.push({
    text: 'mixed',
    toolUses: [
      { name: 'noteToSelf', input: { kind: 'preference', summary: 'likes cacti' } },
      { name: 'placeBlock', input: { x: 1, y: 1, z: 1, block: 'cactus' } },
      { name: 'setGoals', input: { current: 'plant a garden' } },
    ],
  })
  anthropic.queue.push({ text: 'planted', toolUses: [] })
  const dispatchP = orch.handleDispatch('sei:chat_received', { username: 'shawn', text: 'plant a garden', ownerSpoke: true })
  await sleep(10)
  // After dispatch: noteToSelf processed inline, placeBlock suspending,
  // setGoals queued.
  assert.ok(orch.currentLoop?.inFlight, 'G7: expected inFlight after placeBlock')
  assert.equal(orch.currentLoop.inFlight.name, 'placeBlock', 'G7: inFlight should be placeBlock')
  assert.equal(orch.currentLoop._pendingToolUses?.length, 1, `G7: expected 1 queued (setGoals), got ${orch.currentLoop._pendingToolUses?.length}`)
  assert.equal(orch.currentLoop._pendingToolUses[0].use.name, 'setGoals', 'G7: queued entry should be setGoals')
  // Resolve placeBlock.
  adapter.resolveHead('placed')
  await sleep(10)
  await drainActionComplete(orch, reenqueue)
  await sleep(20)
  await dispatchP
  // After drain: setGoals processed inline, appendToolResults + 1 haiku
  // call, then text-only response.
  assert.equal(orch.currentLoop, null, 'G7: expected loop terminated')
  // Exactly 2 anthropic calls — 1 initial + 1 post-drain.
  assert.equal(anthropic.calls.length, 2, `G7: expected 2 haiku calls, got ${anthropic.calls.length}`)
  ok('G7', 'mixed batch [noteToSelf, placeBlock, setGoals]: inline-first, suspend-middle, drain-inline-tail, ONE post-batch haiku')
} catch (e) { bad('G7', e) }

// ─── G8 — INLINE_METADATA tools never set inFlight nor fire action_complete
// 260514-ngj: stop retired, end_loop replaces it as the third INLINE_METADATA
// member alongside setGoals + noteToSelf.
try {
  const { orch, anthropic, adapter, reenqueue } = makeOrch()
  // Pure-metadata batch — should fire ZERO action_completes, never set inFlight.
  anthropic.queue.push({
    text: 'noting',
    toolUses: [
      { name: 'noteToSelf', input: { kind: 'preference', summary: 'enjoys building' } },
      { name: 'setGoals', input: { current: 'build a base' } },
      { name: 'end_loop', input: {} },
    ],
  })
  // Track inFlight observations during the dispatch.
  let sawInFlight = false
  const origRun = orch.handleDispatch.bind(orch)
  const dispatchP = origRun('sei:chat_received', { username: 'shawn', text: 'note things and stop', ownerSpoke: true })
  // Snapshot inFlight at multiple ticks during dispatch.
  for (let k = 0; k < 5; k++) {
    if (orch.currentLoop?.inFlight) sawInFlight = true
    await sleep(2)
  }
  await dispatchP
  await sleep(20)
  assert.equal(sawInFlight, false, 'G8: INLINE_METADATA tools should never set loop.inFlight')
  // No sei:action_complete reenqueues.
  const acCalls = reenqueue.log.filter(c => c.event === 'sei:action_complete')
  assert.equal(acCalls.length, 0, `G8: expected 0 sei:action_complete events for INLINE_METADATA batch, got ${acCalls.length}`)
  // Adapter pending list should be empty — INLINE_METADATA tools don't
  // route through executeAction (except setGoals which IS a registry
  // action). Allow setGoals here — the assertion that matters is no
  // action_complete reenqueue, which proves no startLongRunner dispatch.
  // Loop terminated via end_loop.
  assert.equal(orch.currentLoop, null, 'G8: expected loop terminated via end_loop')
  ok('G8', 'INLINE_METADATA tools (setGoals/noteToSelf/end_loop) never set inFlight, never fire sei:action_complete')
} catch (e) { bad('G8', e) }

// ─── Summary ─────────────────────────────────────────────────────────────
const EXPECTED = 9  // G1, G2, G3a, G3b, G4, G5, G6, G7, G8
console.log(`\n260514-gam harness: ${passCount}/${EXPECTED} PASS`)
if (passCount !== EXPECTED) {
  console.error(`Expected ${EXPECTED} PASS, got ${passCount}`)
  process.exit(1)
}
console.log('OK 260514-gam: G1..G8 (9/9 — G3 split into 3a/3b)')
process.exit(0)
