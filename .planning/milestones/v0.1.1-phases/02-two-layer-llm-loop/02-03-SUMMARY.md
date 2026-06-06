---
phase: 02-two-layer-llm-loop
plan: "03"
subsystem: llm-loop-integration
tags: [integration, fsm-wiring, debounce, abort-propagation, verification, persona-stability, combat-fix, kick-reason-fix]
requires:
  - 02-01-SUMMARY.md (config, persona renderer, Anthropic + Ollama clients)
  - 02-02-SUMMARY.md (orchestrator, goal store, debouncer, circuit breaker, chain-scoped hop tracker, setGoals)
provides:
  - "Wired two-layer LLM loop driving the FSM"
  - "500ms ingestion debounce on chat + combat at the source-event boundary"
  - "Standalone scripts/verify-phase2.js (structural + --live) covering chat AND idle dispatch paths"
  - "PERS-01/02 persona stability via mandated all-lowercase tone instructions"
  - "Combat substrate hardened: no client-side bot.entity rewrites under NaN knockback"
  - "Human-readable kick reasons (chat-component object handling)"
affects:
  - src/fsm.js
  - src/bot.js
  - src/behaviors/chat.js
  - src/behaviors/combat.js
  - src/llm/persona.js
  - scripts/verify-phase2.js
  - package.json
tech-stack:
  added: []
  patterns:
    - "Source-boundary event debounce (chat.js, combat.js debounce BEFORE FSM enqueue)"
    - "FSM emits sei:dispatch -> orchestrator.handleDispatch with shared AbortSignal (LLM-07 cascade)"
    - "Reuse FSM resetIdleTimer (10s) as PERS-04 ticker; no new timer added"
    - "Skip-on-NaN defensive pattern (no client-side state mutation)"
    - "Chat-component reason extraction (text -> translate -> extra[].text -> JSON.stringify)"
key-files:
  created:
    - scripts/verify-phase2.js
  modified:
    - src/fsm.js
    - src/bot.js
    - src/behaviors/chat.js
    - src/behaviors/combat.js
    - src/llm/persona.js
    - package.json
decisions:
  - "Persona tone lines mandate all-lowercase (proper nouns ok); accepted one-time Anthropic prompt-cache invalidation"
  - "Combat NaN knockback is handled by skipping the 250ms tick — never by writing to bot.entity.{velocity,position} (anti-cheat-detectable)"
  - "humanizeReason now extracts text from mineflayer chat-component objects before pattern-matching; previously String(obj) produced '[object Object]'"
  - "Phase 2.5 will be inserted for action-registry expansion (mining, inventory, follow-gating); rolling chat context deferred to Phase 3"
metrics:
  duration: "~30 min (3 substrate fixes + phase close-out)"
  completed: "2026-04-25"
  tasks_completed: 3
  files_changed: 7
---

# Phase 2 Plan 3: Wire Orchestrator + Verification + Substrate Fixes Summary

**One-liner:** Wired the Phase 2 two-layer LLM loop into the FSM, shipped a structural+live verification harness, and hardened the Phase 1 combat substrate against client-side state-mutation kicks discovered during live testing.

## Tasks Completed

### Task 1 — Wire orchestrator into FSM + bot.js + ingestion debounce (LLM-01, LLM-05, LLM-07)
- Gutted scripted P1 chat and P3 idle case bodies in `src/fsm.js`; FSM now emits `sei:dispatch` and the orchestrator handles personality/movement.
- Preserved the existing 10s `resetIdleTimer` as the PERS-04 idle ticker — no new timer.
- `src/bot.js` constructs `createOrchestrator(...)` after `createFSM`, wires `bot.on('sei:dispatch', ...)` to `orchestrator.handleDispatch`, exposes `bot._seiDebouncer`, calls `orchestrator.start()`, and logs executor status (`qwen` or `haiku-fallback`).
- `src/behaviors/chat.js` debounces `sei:chat_received` with key=`chat:${username}`, falling back to direct emit when `_seiDebouncer` absent.
- `src/behaviors/combat.js` debounces `sei:attacked` with key=`attacked:${attacker?.username}`.
- Commits: `feat(02-03): wire orchestrator into FSM + ingestion debounce` (889830f).

### Task 2 — Standalone verification harness (scripts/verify-phase2.js)
- Structural mode: validates config (persona.name, anthropic.model, instruct ollama D-21, max_hops=5), registry contents (setGoals, goTo), orchestrator wiring (executorStatus, handleDispatch, _internal.chains), and the setGoals -> goal store path.
- `--live` mode exercises BOTH a synthetic `sei:chat_received` AND a synthetic `sei:idle` dispatch through the real Anthropic API; asserts chain leak guard (`chains.size() === 0`) after idle.
- `package.json` gained `verify:phase2` script.
- Commits: `feat(02-03): add Phase 2 verification harness` (307b290) and `fix(02-03): make verify-phase2 --live robust to action lifecycle` (9eda436).

### Task 3 — Live Minecraft + Ollama + Anthropic verification (checkpoint:human-verify)
- Structural harness: all OK, exit 0.
- `--live` harness: passes against real Anthropic + Ollama; chat dispatch produces `[stub bot.chat]` output; idle dispatch closes the chain cleanly.
- In-game smoke test exposed two **Phase 1 substrate bugs** that surfaced under live combat — both fixed under this plan rather than deferred (Rule 1 / Rule 2 deviations):

#### Substrate Fix A — persona stability (PERS-01/02)
**Found during:** in-game chat with the bot.
**Issue:** Personality LLM mixed Sentence Case and lowercase replies between turns, breaking the perceived character.
**Fix:** Rewrote `TONE_LINES` in `src/llm/persona.js` to explicitly mandate all-lowercase output (proper nouns allowed) and forbid capitalizing the first word of a sentence. Also lowercased the `serious` `capHitLine` for consistency.
**Files modified:** `src/llm/persona.js`
**Commit:** `fix(02-03): mandate all-lowercase tone for persona stability` (0f6ae90)
**Cache impact:** One-time Anthropic prompt-cache invalidation, accepted.

#### Substrate Fix B — combat NaN client-side rewrite (Phase 1 bug)
**Found during:** in-game combat with a zombie; bot was repeatedly kicked.
**Issue:** `src/behaviors/combat.js` was healing NaN values in `bot.entity.velocity` and `bot.entity.position` by mutating them in place. This is anti-cheat-detectable client-side teleporting and produced repeated `Kicked: [object Object]` loops on attack ticks.
**Fix:** Replaced the heal-in-place block with a defensive skip — if `velocity` or `position` contain non-finite values, the 250ms attack tick simply returns. Mineflayer's normal physics restores valid state on the next packet.
**Files modified:** `src/behaviors/combat.js`
**Commit:** `fix(02-03): stop client-side rewrite of bot.entity on NaN knockback` (27b8e95)

#### Substrate Fix C — kick reason humanization (Phase 1 bug)
**Found during:** observing kick logs during combat fix.
**Issue:** `humanizeReason` did `String(reason)`, which produces `'[object Object]'` for mineflayer's chat-component kick payloads (objects with `text` / `translate` / `extra[]`).
**Fix:** Added `extractReasonText()` helper that prefers `reason.text`, then `reason.translate`, then joined `reason.extra[].text`, then `JSON.stringify`. All existing string-pattern checks now run against the extracted text. Minimal/additive — string reasons behave exactly as before.
**Files modified:** `src/bot.js`
**Commit:** `fix(02-03): humanize chat-component kick reasons` (46b98c4)

## Live Verification Results
- `node scripts/verify-phase2.js` (structural): all OK, exit 0.
- `node scripts/verify-phase2.js --live`: Anthropic round-trip succeeds for chat dispatch; idle dispatch ends with `chains.size() === 0`.
- In-game smoke: bot connects, chats in-character (lowercase, stable), follows owner, idle observations occur near owner, debounce coalesces rapid chat bursts to single personality calls. Combat no longer kicks the bot; kick messages (when they happen for unrelated reasons) are now human-readable.
- `usage.cache_creation_input_tokens`: **0** on first call after restart, as expected per the plan's PERS-05 acknowledgement (cached prefix is under Anthropic's 4096-token cache-creation minimum). Marker placement (D-18) is structurally correct; padding the prefix is deferred.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Persona tone produced inconsistent capitalization (PERS-01/02)**
- Found during: live in-game chat after Task 3 boot.
- Fix: rewrote TONE_LINES to mandate lowercase. See Substrate Fix A above.

**2. [Rule 1 - Bug] Combat behavior wrote to bot.entity under NaN knockback, triggering server kicks**
- Found during: in-game combat smoke test.
- Fix: skip-on-NaN; never mutate bot.entity. See Substrate Fix B above.

**3. [Rule 2 - Critical functionality] Kick reason was unreadable for chat-component objects**
- Found during: kick log inspection while diagnosing Fix B.
- Fix: extractReasonText helper handles object reasons. See Substrate Fix C above.

All three were Phase 1 substrate latent bugs that only manifested once the LLM loop was actually driving combat / chat. They were fixed under 02-03 because they blocked a green Phase 2 close-out.

## Deferred / Known Gaps (explicitly routed)

- **Rolling in-session chat context window** → Phase 3 (Memory & Persistence) — already in MEM-01/02 scope.
- **Mining action, inventory queries, follow-gating semantics, additional registry actions** → **new Phase 2.5 (action-registry expansion)** — to be planned via `/gsd-insert-phase 2.5`. None of these are in v1 requirements yet but became visible needs during live testing.
- **Anthropic prompt-cache real hits** → optional future work; pad cached prefix past 4096 tokens. Not a defect; PERS-05 satisfied structurally.

## TDD Gate Compliance
N/A — this plan was wiring + verification + bug fixes, no new behavior under TDD.

## Self-Check: PASSED

- File `scripts/verify-phase2.js`: FOUND
- File `src/llm/persona.js`: FOUND (lowercase tone)
- File `src/behaviors/combat.js`: FOUND (skip-on-NaN)
- File `src/bot.js`: FOUND (extractReasonText)
- Commit `889830f` (wire orchestrator): FOUND
- Commit `307b290` (verify harness): FOUND
- Commit `9eda436` (live harness fix): FOUND
- Commit `0f6ae90` (lowercase tone): FOUND
- Commit `27b8e95` (combat NaN skip): FOUND
- Commit `46b98c4` (kick reason): FOUND
- Structural verify-phase2: exit 0, all OK lines, zero FAIL.
