---
status: partial
phase: 01-bot-substrate
source: [01-VERIFICATION.md]
started: 2026-04-24T00:00:00Z
updated: 2026-04-24T00:00:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Server connection and spawn
expected: Running `node src/index.js` with a valid config.json connects the bot to a Minecraft server and prints status to stdout (e.g., "Connected to 127.0.0.1:25565 as Sei")
result: [pending]

### 2. Auto-reconnect and plain-English errors
expected: Stopping the server causes the bot to print a human-readable disconnect reason and then attempt reconnect after reconnect_delay_ms, printing "Reconnecting in Xms..." and "Attempting reconnect..."
result: [pending]

### 3. Follow behavior
expected: Walking the owner away from the bot causes it to pathfind toward the owner and stop within follow_range blocks
result: [pending]

### 4. Chat response routing
expected: Saying the bot's name in chat causes it to reply with a scripted acknowledgement ("Hello, <username>!")
result: [pending]

### 5. Combat reflex
expected: Attacking the bot causes it to turn and attack back via pvp.attack()
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
