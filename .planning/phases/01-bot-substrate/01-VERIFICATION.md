---
phase: 01-bot-substrate
verified: 2026-04-24T22:30:00Z
status: human_needed
score: 5/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Launch bot against a live offline-mode Minecraft server and confirm it connects, spawns, and prints '[sei] Connected to ...' to stdout"
    expected: "Bot joins server, spawn handler fires, all behaviors attach without error"
    why_human: "Cannot start a Minecraft server in CI; ECONNREFUSED is expected in the absence of a server"
  - test: "Disconnect the bot from the server (stop the server) and confirm it prints 'Disconnected: ...' followed by 'Reconnecting in 5000ms...' and 'Attempting reconnect...'"
    expected: "Auto-reconnect loop triggers with human-readable messages; no raw Error objects in output"
    why_human: "Requires a live server to disconnect from"
  - test: "Walk the owner player away from the bot and confirm bot follows; stop and confirm bot stops within follow_range blocks"
    expected: "Bot navigates to owner continuously; stops within 3 blocks"
    why_human: "Requires in-game observation"
  - test: "Type a message containing the bot's name (Sei) in chat and confirm bot responds in chat ('Hello, <username>!')"
    expected: "sei:chat_received event fires, FSM echoes response via bot.chat()"
    why_human: "Requires live in-game chat interaction"
  - test: "Have another player attack the bot and confirm bot turns and attacks back"
    expected: "hurtByEntity fires, sei:attacked emitted, bot.pvp.attack() called"
    why_human: "Requires live in-game combat interaction"
---

# Phase 1: Bot Substrate Verification Report

**Phase Goal:** A mineflayer-driven Minecraft bot connects to a server, executes scripted reflex behavior, and exposes a closed, Zod-typed action registry through an event-sourced FSM — all without any LLM involvement.
**Verified:** 2026-04-24T22:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (from ROADMAP Success Criteria + PLAN must_haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Developer can launch bot, it connects with auto-detected server version | VERIFIED | `node src/index.js` resolves all imports; attempts connection; version omitted when config says "auto" (src/bot.js:38-40) |
| 2 | Bot auto-reconnects and surfaces errors as plain-English messages | VERIFIED | `humanizeReason()` in src/bot.js:15-23; `bot.on('end')` with setTimeout reconnect in bot.js:69-82 |
| 3 | Bot follows owner, responds to chat, auto-eats, defends itself — scripted, no LLM | VERIFIED | All four behaviors implemented and wired in spawn handler (bot.js:51-54); event hooks present in each file |
| 4 | Every pathfinder call has wall-clock timeout; returns "couldn't reach" not a hang | VERIFIED | `Promise.race([navigationPromise, timeoutPromise])` in pathfind.js:41; `bot.pathfinder.stop()` in timeout branch (pathfind.js:36) |
| 5 | FSM skeleton routes events through single orchestrator, ready for Phase 2 LLM | VERIFIED | fsm.js exports `createFSM` + `Priority`; priority queue with `queue.sort`; `sei:dispatch` hook emitted before every handler (fsm.js:118); AbortController cancellation present |

**Score:** 5/5 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `package.json` | ESM project with mineflayer, zod | VERIFIED | `"type": "module"`, all deps present |
| `config.example.json` | Committed template | VERIFIED | All 9 fields present; gitignored config.json exists separately |
| `src/config.js` | Zod schema + loadConfig | VERIFIED | Exports `ConfigSchema` and `loadConfig`; `z.enum(['offline','microsoft'])` for auth |
| `src/bot.js` | Bot lifecycle: start/stop/getBot, reconnect, status | VERIFIED | All three exports present; humanizeReason; reconnect on 'end'; behaviors + FSM wired in spawn handler |
| `src/registry.js` | Closed Zod-typed action registry | VERIFIED | Exports `createRegistry`, `ActionRegistry`, `createDefaultRegistry`; throws on unknown action names; 'goTo' registered |
| `src/behaviors/pathfind.js` | Pathfinder wrapper with wall-clock timeout | VERIFIED | Exports `goTo`, `PathfindResult`; Promise.race with stop() on timeout |
| `src/behaviors/follow.js` | Owner-follow behavior | VERIFIED | Exports `startFollow`, `stopFollow`; setInterval with distanceTo check; calls goTo |
| `src/behaviors/chat.js` | Chat response routing | VERIFIED | Exports `startChat`; emits `sei:chat_received`; addressed + proximity check |
| `src/behaviors/autoEat.js` | Hunger monitor | VERIFIED | Exports `startAutoEat`; uses `loader` named export (ESM interop fixed); startAt = 14 |
| `src/behaviors/combat.js` | Self-defense combat reflex | VERIFIED | Exports `startCombat`; `bot.on('hurtByEntity')` + `bot.pvp.attack(attacker)` |
| `src/fsm.js` | Event-sourced FSM with priority queue + AbortController | VERIFIED | Exports `createFSM`, `Priority`; P0-P3 constants; queue.sort; AbortController; sei:dispatch hook |
| `src/index.js` | CLI entry point | VERIFIED | Loads config, calls start(config) |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| src/index.js | src/bot.js | `start(config)` call | WIRED | index.js:2,4 imports and calls start |
| src/bot.js | mineflayer createBot | `createBot({ host, port, username, auth })` | WIRED | bot.js:1,43; version omitted when 'auto' |
| src/bot.js | reconnect loop | `bot.on('end') setTimeout retry` | WIRED | bot.js:69-82 |
| src/behaviors/follow.js | src/behaviors/pathfind.js | `goTo()` in follow interval | WIRED | follow.js:1,19 |
| src/behaviors/pathfind.js | mineflayer-pathfinder | `bot.pathfinder.goto()` with Promise.race | WIRED | pathfind.js:25; ESM interop via pkg default |
| src/registry.js | src/behaviors/pathfind.js | registered 'goTo' action calling pathfind.goTo() | WIRED | registry.js:2,67 |
| src/bot.js | src/fsm.js | `createFSM(bot, config, registry)` on spawn | WIRED | bot.js:8,58 |
| src/fsm.js | AbortController | `currentAction.controller.abort()` before new action | WIRED | fsm.js:77 |
| src/behaviors/combat.js | src/fsm.js | `bot.emit('sei:attacked')` → `bot.on('sei:attacked')` in FSM | WIRED | combat.js:9; fsm.js:152 |
| src/behaviors/chat.js | src/fsm.js | `bot.emit('sei:chat_received')` → `bot.on('sei:chat_received')` in FSM | WIRED | chat.js:24; fsm.js:153 |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All imports resolve | `node --input-type=module --eval "import './src/index.js'"` | `[sei] Starting Sei — connecting to 127.0.0.1:25565` then ECONNREFUSED | PASS |
| FSM module exports | `import('./src/fsm.js')` | `function object` | PASS (per SUMMARY) |
| Registry lists goTo | `createDefaultRegistry().list()` | `['goTo']` | PASS (per SUMMARY) |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| CONN-01 | 01-01 | Bot connects to server with auto-detected version | SATISFIED | bot.js createBot; version omitted when 'auto' |
| CONN-02 | 01-01 | Microsoft OAuth auth | SATISFIED (partial — code path wired, runtime requires live test) | `z.enum(['offline','microsoft'])` accepted; auth passed to createBot |
| CONN-03 | 01-01 | Auto-reconnect with status update | SATISFIED | bot.js:69-82 reconnect loop with logStatus |
| CONN-04 | 01-01 | Plain-English error translation | SATISFIED | humanizeReason() maps ECONNREFUSED, timeout, kicked, auth errors |
| BOT-01 | 01-02/03 | Bot follows owner in proximity range | SATISFIED | follow.js: interval + goTo |
| BOT-02 | 01-02/03 | Bot responds to chat when addressed or nearby | SATISFIED | chat.js: addressed + proximity + ownerSpoke checks |
| BOT-03 | 01-02/03 | Bot auto-eats without LLM | SATISFIED | autoEat.js: mineflayer-auto-eat plugin, startAt=14 |
| BOT-04 | 01-02/03 | Combat reflex on hurtByEntity | SATISFIED | combat.js: hurtByEntity → pvp.attack() |
| BOT-05 | 01-02/03 | Pathfinder with wall-clock timeout | SATISFIED | pathfind.js: Promise.race with timeoutMs |
| BOT-06 | 01-02/03 | Recovers from pathfinder hangs | SATISFIED | goTo() returns 'timeout'/'cant_reach' — never throws or hangs |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/behaviors/chat.js | 24 | Phase 1 response is scripted acknowledgement only | Info | Intentional — Phase 2 will replace with LLM call |
| src/fsm.js | 258 | Phase 1 chat handler echoes "Hello, username!" | Info | Intentional stub for Phase 2 replacement |
| src/fsm.js | 263 | P3 idle handler only logs | Info | Intentional — Phase 2 personality LLM responds here |

No blockers found. The scripted-acknowledgement stubs in chat and idle handlers are explicitly intentional Phase 1 placeholders documented in plan comments.

---

## Notes on CONN-02 (Microsoft OAuth)

CONN-02 requires "Bot authenticates with a Microsoft account via OAuth device-code flow." The config schema correctly validates `auth: 'microsoft'` and passes it through to `createBot`. The actual OAuth device-code flow is handled entirely by mineflayer's internals — no custom auth code is expected in Phase 1. This satisfies the requirement at the infrastructure level; live runtime verification requires a real Microsoft account.

---

## Human Verification Required

### 1. Server Connection and Spawn

**Test:** Set config.json `auth: "offline"`, run `node src/index.js` against a local offline-mode Minecraft server
**Expected:** Bot joins, stdout prints `[sei] Connected to 127.0.0.1:25565 as Sei`, no errors
**Why human:** Cannot start a Minecraft server in automated verification

### 2. Auto-Reconnect and Plain-English Errors

**Test:** Stop the server while bot is connected
**Expected:** `Disconnected: Could not reach server — check host/port`, then `Reconnecting in 5000ms...`, then `Attempting reconnect...`
**Why human:** Requires a live server to disconnect from

### 3. Follow Behavior

**Test:** Walk the owner account away; verify bot follows and stops within 3 blocks
**Expected:** Bot navigates continuously; halts within follow_range
**Why human:** Requires in-game observation

### 4. Chat Response Routing

**Test:** Type "Sei hello" in chat; type a message as owner
**Expected:** Bot responds "Hello, [username]!" when addressed; emits sei:chat_received for owner messages
**Why human:** Requires live in-game chat

### 5. Combat Reflex

**Test:** Have another player attack the bot
**Expected:** Bot immediately attacks back via bot.pvp.attack()
**Why human:** Requires live in-game combat

---

## Gaps Summary

No automated gaps found. All artifacts exist, are substantive, are wired, and data flows correctly (event-driven architecture — no data rendering, no hollow props). Five human verification items require a live Minecraft server to confirm runtime behavior. These are expected for a bot substrate phase and do not indicate implementation defects.

---

_Verified: 2026-04-24T22:30:00Z_
_Verifier: Claude (gsd-verifier)_
