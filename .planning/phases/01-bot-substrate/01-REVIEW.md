---
phase: 01-bot-substrate
reviewed: 2026-04-24T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - package.json
  - config.example.json
  - .gitignore
  - src/config.js
  - src/index.js
  - src/bot.js
  - src/behaviors/pathfind.js
  - src/registry.js
  - src/behaviors/follow.js
  - src/behaviors/chat.js
  - src/behaviors/autoEat.js
  - src/behaviors/combat.js
  - src/fsm.js
findings:
  critical: 0
  warning: 5
  info: 4
  total: 9
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-04-24
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Phase 1 establishes the bot substrate: config loading, connection lifecycle with reconnect, reflex behaviors (follow, chat, autoEat, combat), a closed action registry, and an event-sourced FSM. The architecture is sound and follows the project's CLAUDE.md constraints well — timeouts are present on pathfinder calls, the registry is properly closed (no code generation), and the FSM uses AbortController for preemption.

Five warnings were found, mostly around race conditions and missing guards that could cause crashes or incorrect behavior at runtime. Four info items cover minor quality issues.

---

## Warnings

### WR-01: `follow.js` double-loads pathfinder plugin — crash on reconnect

**File:** `src/behaviors/follow.js:8`
**Issue:** `follow.js` calls `bot.loadPlugin(pathfinder)` but `bot.js` already calls `bot.loadPlugin(pathfinder)` on line 48. mineflayer throws `"Plugin already loaded"` if the same plugin is loaded twice on the same bot instance. On first connect this is likely benign only because `bot.js` loads it first and mineflayer may silently deduplicate — but the duplicate call is fragile and will throw if load order ever changes.
**Fix:** Remove the `loadPlugin(pathfinder)` call from `follow.js` entirely and the redundant import. The plugin is already loaded in `bot.js` before `startFollow` is called.

```js
// follow.js — remove these two lines:
import pkg from 'mineflayer-pathfinder'
const { pathfinder } = pkg

export function startFollow(bot, config) {
  // bot.loadPlugin(pathfinder)  <-- remove
  _followInterval = setInterval(async () => { ...
```

---

### WR-02: `follow.js` — stale interval holds reference to dead bot on disconnect

**File:** `src/behaviors/follow.js:10-21`
**Issue:** `_followInterval` is a module-level singleton. When the bot disconnects, `stopFollow()` is called from `bot.js`'s `end` handler — that's correct. However, if `stopFollow()` is somehow missed (e.g., the `end` event fires after `startFollow` has already been called for the reconnected bot instance), the old interval continues running against a stale `bot` reference. More concretely: if reconnect fires before the `end` handler fully completes, `startFollow` is called again and sets a new `_followInterval` without clearing the previous one, leaking an interval.
**Fix:** Clear any existing interval at the top of `startFollow` before creating a new one.

```js
export function startFollow(bot, config) {
  stopFollow()  // clear any previously running interval first
  _followInterval = setInterval(async () => { ...
```

---

### WR-03: `pathfind.js` — timeout race does not cancel the navigation promise, causing a dangling pathfinder

**File:** `src/behaviors/pathfind.js:34-41`
**Issue:** When the wall-clock timeout fires, `bot.pathfinder.stop()` is called and `'timeout'` is resolved. However the `navigationPromise` is still live — its `.then`/`.catch` callbacks remain registered on the pathfinder. If pathfinder emits a completion or error after the timeout, those callbacks call `resolve('reached')` or `resolve('cant_reach')` on the already-settled outer promise — which is silently dropped by `Promise.race`. This is benign for the return value but means the `Movements` object and goal remain in memory until the pathfinder fully stops. More critically, `bot.pathfinder.stop()` inside the timeout callback races with a concurrent `goTo` call if the caller issues a new `goTo` immediately after getting `'timeout'` — the stop call from the old invocation will interrupt the new navigation.
**Fix:** Use an AbortController or a shared `cancelled` flag to prevent the navigation callback from calling `bot.pathfinder.stop()` after the timeout has already done so.

```js
export async function goTo(bot, x, y, z, range = 1, timeoutMs = 12000) {
  if (!bot) return 'no_bot'

  let settled = false
  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)
  const goal = new goals.GoalNear(x, y, z, range)

  const navigationPromise = new Promise((resolve) => {
    bot.pathfinder.goto(goal)
      .then(() => { if (!settled) resolve('reached') })
      .catch(() => { if (!settled) resolve('cant_reach') })
  })

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      settled = true
      bot.pathfinder.stop()
      resolve('timeout')
    }, timeoutMs)
  })

  const result = await Promise.race([navigationPromise, timeoutPromise])
  settled = true
  return result
}
```

---

### WR-04: `fsm.js` — re-queued lower-priority item starves processing loop permanently if `currentAction` never clears

**File:** `src/fsm.js:82-87`
**Issue:** When a lower-priority item is encountered while a higher-priority action is running, the item is re-inserted at the front of the queue with `queue.unshift(item)` and `processing = false`. `scheduleProcess` is only called when a new event arrives via `enqueue`. If no new events arrive, `processNext` is never re-scheduled, so the re-queued item sits in the queue indefinitely even after `currentAction` completes (since action completion does not call `scheduleProcess`).
**Fix:** After the `finally` block in `processNext`, call `scheduleProcess()` unconditionally (or inline `setImmediate(processNext)`) so the queue is drained after each action finishes.

```js
  } finally {
    if (currentAction?.controller === controller) {
      currentAction = null
    }
  }

  // Always continue draining the queue, not just when length > 0 after the shift
  if (queue.length > 0) {
    setImmediate(processNext)
  } else {
    processing = false
  }
```

The existing drain block at lines 107-111 actually handles this correctly for the normal path, but the early-return at line 85 (`processing = false; return`) bypasses it — after that return, there is no mechanism to wake up processing when `currentAction` finishes.

---

### WR-05: `combat.js` — `hurtByEntity` fires for non-hostile entities (other players, tamed pets)

**File:** `src/behaviors/combat.js:6-11`
**Issue:** `bot.pvp.attack(attacker)` is called for *any* entity that damages the bot, including other players and the owner. This could cause the bot to attack the owner if they accidentally hit it (e.g., during building). There is no check that `attacker` is a hostile mob or that the attacker is not the owner.
**Fix:** At minimum, skip attacking the owner.

```js
bot.on('hurtByEntity', (attacker) => {
  if (!attacker) return
  if (attacker.username === config.owner_username) return  // never attack the owner
  bot.emit('sei:attacked', { attacker })
  bot.pvp.attack(attacker)
})
```

Note: `startCombat` currently does not receive `config`, so this requires passing `config` as a parameter.

---

## Info

### IN-01: `pathfind.js` — both catch branches resolve to the same value

**File:** `src/behaviors/pathfind.js:27-30`
**Issue:** The catch block has an `if/else` that resolves to `'cant_reach'` in both branches. The conditional check on `msg` is dead code.
**Fix:** Collapse to a single `resolve('cant_reach')`.

```js
.catch(() => resolve('cant_reach'))
```

---

### IN-02: `registry.js` — `ActionRegistry` export is an alias that shadows intent

**File:** `src/registry.js:51`
**Issue:** `export const ActionRegistry = createRegistry` exports `createRegistry` under a second name with no documentation. This is unused in the codebase (only `createDefaultRegistry` is imported in `bot.js`) and could confuse Phase 2 contributors.
**Fix:** Remove the alias or document its intended use.

---

### IN-03: `fsm.js` — `sei:dispatch` receives the `AbortSignal` object via `bot.emit`

**File:** `src/fsm.js:118`
**Issue:** `bot.emit('sei:dispatch', { event, data, signal })` passes the live `AbortSignal`. This is intentional for Phase 2 LLM handlers, but `AbortSignal` objects are not serializable. When Electron IPC is introduced in Phase 4, this event payload will not cross process boundaries as-is. A comment noting this constraint would prevent a confusing bug later.
**Fix:** Add a comment; no code change required now.

```js
// NOTE: signal is a live AbortSignal — not serializable over IPC.
// Phase 4 IPC bridge must convert this to a cancellation token before forwarding.
bot.emit('sei:dispatch', { event, data, signal })
```

---

### IN-04: `bot.js` — `spawn` handler recreates registry and FSM on every reconnect, not just once

**File:** `src/bot.js:44-58`
**Issue:** The `spawn` event fires each time the bot successfully connects, including after reconnects. `createDefaultRegistry()` and `createFSM()` are called inside the `spawn` handler, creating new instances each reconnect. The FSM's idle timer and event listeners accumulate on the bot's EventEmitter across reconnects if prior FSM listeners are not removed. Since `createBotInstance` creates a brand-new bot object each reconnect (line 42), this is currently safe — but is worth documenting explicitly so future refactors don't move FSM setup outside of `createBotInstance` without accounting for this.
**Fix:** Add a comment clarifying that FSM/registry setup is intentionally inside `createBotInstance` scope.

---

_Reviewed: 2026-04-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
