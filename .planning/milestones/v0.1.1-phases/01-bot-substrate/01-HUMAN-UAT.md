---
status: approved
phase: 01-bot-substrate
source: [01-VERIFICATION.md]
started: 2026-04-24T00:00:00Z
updated: 2026-04-24T00:00:00Z
approved: 2026-04-24T00:00:00Z
---

## Current Test

[all tests passed — phase approved]

## Tests

### 1. Server connection and spawn
expected: Running `node src/index.js` with a valid config.json connects the bot to a Minecraft server and prints status to stdout (e.g., "Connected to 127.0.0.1:25565 as Sei")
result: pass

### 2. Auto-reconnect and plain-English errors
expected: Stopping the server causes the bot to print a human-readable disconnect reason and then attempt reconnect after reconnect_delay_ms, printing "Reconnecting in Xms..." and "Attempting reconnect..."
result: pass

### 3. Follow behavior
expected: Walking the owner away from the bot causes it to pathfind toward the owner and stop within follow_range blocks
result: pass

### 4. Chat response routing
expected: Saying the bot's name in chat causes it to reply with a scripted acknowledgement ("Hello, <username>!"); other messages echoed as "(heard: ...)"
result: pass

### 5. Combat reflex
expected: Attacking the bot causes it to turn and attack back; abandons combat 1s after last hit to resume follow
result: pass — verified against zombies, auto-respawn on death works, auto-eat triggers on hunger

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

None. Issues surfaced during UAT and fixed in-phase:
- autoEat v5 API migration (setOpts/enableAuto)
- entityHurt source resolution (stale refs, weapon entities)
- double pathfinder loadPlugin guard
- respawn handler re-registering behaviors
- NaN velocity/position from knockback packets (healed in-place)
- combat facing via zombie.yaw + π (bypasses unreliable bot position)
- minecraft_version pinned to 1.21.1 (auto-detection produced protocol mismatch)
