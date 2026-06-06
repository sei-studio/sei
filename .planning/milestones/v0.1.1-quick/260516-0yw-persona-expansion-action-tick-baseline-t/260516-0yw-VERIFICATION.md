---
quick_id: 260516-0yw
slug: persona-expansion-action-tick-baseline-t
verified: 2026-05-16T00:00:00Z
status: human_needed
score: 20/20 must-haves verified in code; UI flow + live Anthropic expansion need human testing
commits_verified:
  - 619b8e6
  - 5030ac7
  - bb6490c
test_scripts:
  - script: scripts/test-actionTick.mjs
    result: PASS (7/7)
  - script: scripts/test-followOpenEnded.mjs
    result: PASS
  - script: scripts/test-personaExpansion.mjs
    result: PASS (6/6)
typecheck:
  - tsconfig.node.json: clean
  - tsconfig.web.json: clean
human_verification:
  - test: "Run the Electron GUI, add a new character with a short persona blurb"
    expected: "Add screen collapses to 2 steps (Name → Persona source). Save shows 'Generating…' for 3–8s. On return, the character has a populated persona.expanded with six markdown headers; opening Edit shows the expanded preview behind a collapsible toggle."
    why_human: "Requires a running Electron + renderer + main process + live Anthropic API call; no automated harness exists for the full IPC round-trip."
  - test: "Edit an existing character's persona.source and save"
    expected: "Save button reads 'Generating persona…'; main passes priorExpanded as voice-continuity reference; on completion, persona.expanded is updated and the renderer's store reflects the new expansion."
    why_human: "End-to-end voice-continuity regeneration involves a live LLM call; quality is subjective and not programmatically verifiable."
  - test: "Summon the bot and run a long-running action (e.g. mineVein or follow)"
    expected: "After 10s, the model gets one silent-default iteration; most ticks should produce no text; on a chat or attack, the loop preempts normally; on unfollow / abort, follow returns 'aborted: follow <label>'."
    why_human: "Real Minecraft world + live mineflayer + Anthropic responses; tick-cadence behavior is observable only at runtime."
  - test: "Verify follow no longer spam-loops"
    expected: "Issuing `follow <player>` once results in a single 'following X' chat line; subsequent ticks/iterations do NOT re-say 'following you' on repeat. Bot stays in pursuit until preempted."
    why_human: "Spam-loop regression test requires real mineflayer + bot loop; isolated test covers handler shape but not multi-iteration pacing."
---

# Quick Task 260516-0yw: persona expansion + action tick + baseline trim + first-person memory — Verification Report

**Task goal:** Land four coupled fixes — persona expansion (LLM-generated long-form prompt per character), action tick (10s heartbeat during long actions), baseline trim (tone/proactiveness moved into per-character persona), and first-person colored memory (compactor preserves emotional arc).

**Verified:** 2026-05-16
**Status:** human_needed
**Mode:** Initial verification

## Summary

All structural / engine must-haves verified in the actual codebase, all three task-introduced test scripts pass (7/7 + 1/1 + 6/6 = 14 assertions), and both TypeScript configs compile clean. The three claimed commits (`619b8e6`, `5030ac7`, `bb6490c`) exist with the correct file scopes per the SUMMARY. The deferred-items.md file calls out pre-existing harness failures (`verify-260513-wkd.mjs`, `verify-260514-gam.mjs`) caused by an earlier session's adapter refactor — not by this task — and the new 0yw tests cover the new wiring end-to-end with the live orchestrator.

Four runtime / UI flows still need human verification because they require the Electron renderer, the main process, live Anthropic calls, or a running Minecraft world that the verifier cannot exercise automatically.

## Per Must-Have Status

### 1. fsm.js — P2_ACTION_TICK = 2.3 (LOCKED)

**Status:** passed.
**Evidence:** `src/bot/brain/fsm.js:46` — `P2_ACTION_TICK: 2.3,` sits between `P2_ACTION_COMPLETE: 2.1` (line 36) and `P2_5_LOOP_END: 2.5` (line 47). No 2.4 anywhere. The comment block explicitly documents the placement rationale (lines 38–45) and acknowledges the CONTEXT.md "P2.5" mention as a known bug.

### 2. brain/index.js — `sei:action_tick` reenqueue routing

**Status:** passed.
**Evidence:** `src/bot/brain/index.js:111` — `case 'sei:action_tick':    p = Priority.P2_ACTION_TICK; break`, surrounded by `sei:action_complete` (2.1) at line 106 and `sei:loop_end` (2.5) at line 112.

### 3. orchestrator.js — classifier rename + extension

**Status:** passed.
**Evidence:** `src/bot/brain/orchestrator.js:1493–1496`:
```js
const iterationKeepsLoopAlive = (() => {
  const e = loop._currentIterationTrigger ?? loop._triggerEvent
  return e === 'player_chat' || e === 'sei:chat_received' || e === 'sei:attacked' || e === 'sei:action_tick'
})()
```
Used at line 1499 (`if (iterationKeepsLoopAlive && loop.inFlight)`). No remaining references to the old name `iterationTriggerIsP0P1` anywhere in the file.

### 4. orchestrator.js — `clearActionTick` helper

**Status:** passed.
**Evidence:** `src/bot/brain/orchestrator.js:1061–1067` defines `clearActionTick(inflightEntry)` — null-guarded, idempotent, sets `_tickHandle = null` after clearing. Single `clearInterval` call point in the entire file.

### 5. orchestrator.js — five tick-clear sites with correct scope variable

**Status:** passed.
**Evidence (grep with surrounding context):**
- `line 670 → clearActionTick(currentLoop.inFlight)` immediately before `currentLoop.inFlight.abortController.abort()` (PLAYER INTERRUPT — `currentLoop` is the loop variable in scope; `loop` would throw ReferenceError).
- `line 707 → clearActionTick(dyingLoop.inFlight)` immediately before `dyingLoop.inFlight.abortController.abort()` (P0 attack preempt — `dyingLoop` in scope).
- `line 1546 → clearActionTick(loop.inFlight)` immediately before `loop.inFlight.abortController.abort()` (R4 — `loop` in scope).
- `line 1562 → clearActionTick(loop.inFlight)` (R3).
- `line 1574 → clearActionTick(loop.inFlight)` (R2).
- `line 1013 → clearActionTick(loop.inFlight)` in `attachSettleHandler` `.then` BEFORE `loop.inFlight = null` (line 1014).
- `line 1033 → clearActionTick(loop.inFlight)` in `attachSettleHandler` `.catch` BEFORE `loop.inFlight = null` (line 1034).

This is the structure `test-actionTick.mjs` enforces via the source-text co-location scan; that test passes (7/7).

### 6. orchestrator.js — tick setInterval started in `dispatchSuspendingTool`

**Status:** passed.
**Evidence:** `src/bot/brain/orchestrator.js:1099` stashes `_tickHandle: null` on the inflightEntry; `lines 1109–1120` schedule the interval via `inflightEntry._tickHandle = setInterval(() => { ... reenqueue('sei:action_tick', { name, startedAt, elapsedMs }) }, _TICK_INTERVAL_MS)`. `_TICK_INTERVAL_MS = 10_000` (line 105) with a `_setTickIntervalForTests` hook for the test harness. No inline `clearInterval` outside `clearActionTick`.

### 7. registry.js — follow open-ended on AbortSignal

**Status:** passed.
**Evidence:** `src/bot/adapter/minecraft/registry.js:257–306`. After resolving the target, the handler reads `config?.signal`; if absent, returns the legacy `following ${label}` synchronously (for test envs); otherwise awaits `new Promise(resolve => signal.addEventListener('abort', ...))` and returns `aborted: follow ${label}` after the signal fires. `setFollowTarget(null)` runs only after the abort. The end-to-end signal plumbing through `_buildExecOpts → adapter.executeAction → registry.execute → handler config arg` is asserted by test-actionTick.mjs (assertion 6).

### 8. prompts.js — BASELINE_INSTRUCTIONS trimmed

**Status:** passed.
**Evidence:** `src/bot/brain/prompts.js:14–28`:
- Length rule (≤12 words, one short sentence) — top of block.
- "YOUR TEXT BLOCK IS IN-GAME CHAT" — in-game-chat semantics + no-monologue/scratchpad.
- "IDENTITY GUARDRAILS" — anti-prompt-injection + no AI/LLM self-description.
- Tool / `end_loop` / action-tick mechanics — three short paragraphs.
- "If a tick fires while your action is ongoing, you do NOT have to speak — silence is the default…"

Forbidden text from prior versions ("Tone and voice come from your character", mirroring/proactiveness/dynamic/reactions content) is absent (`grep -c "Tone and voice come from your character" → 0`). The only occurrence of "proactiveness" is in the docblock comment explaining what was moved out (line 6).

### 9. prompts.js — first-person `remember()` tool description

**Status:** passed.
**Evidence:** `src/bot/brain/prompts.js:30–33`. The `remember` description steers "from your own perspective, in your own voice" and "the way YOU would describe what happened — your reactions, your impressions, how the player came across to you." Quote-verbatim guidance preserved.

### 10. compactor.js — emotional arc preservation

**Status:** passed.
**Evidence:** `src/bot/brain/memory/compactor.js:30`:
```
'- Emotional arc across entries — if entries show a relationship shifting (e.g. hostile → warm, distant → close, formal → casual), the condensed version MUST still show that shift. Long-time relationship development depends on the emotional arc surviving compaction; flattening it into a single steady-state summary is forbidden. When in doubt, preserve the trajectory at the cost of literal detail.'
```
Substring `emotional arc` present and unambiguous.

### 11. characterSchema.ts — persona { source, expanded }, no description

**Status:** passed.
**Evidence:** `src/shared/characterSchema.ts:19–22`:
```ts
export const PersonaSchema = z.object({
  source: z.string().min(1),
  expanded: z.string().default(''),
});
```
Top-level `description` and `persona_prompt` fields removed from `CharacterSchema` (line 33–42). No `.optional()`, no compat shim. The docblock explicitly cites CLAUDE.md "no backwards-compat hacks".

### 12. personaExpansion.ts (NEW) — main process, 30s timeout, six-section template

**Status:** passed (with minor note — see "Notes" below).
**Evidence:** `src/main/personaExpansion.ts:29` imports `@anthropic-ai/sdk`. Constants `EXPANSION_MODEL = 'claude-haiku-4-5-20251001'`, `EXPANSION_TIMEOUT_MS = 30_000`, passed to `client.messages.create(req, { timeout: EXPANSION_TIMEOUT_MS, signal })` at line 151 (CLAUDE.md "every external call has a timeout" honored). `EXPANSION_SYSTEM` produces the six-section template (IDENTITY / VOICE / DEFAULT DYNAMIC WITH THE PLAYER / PROACTIVENESS / REACTIONS / MEMORY — write in YOUR voice), validated via `REQUIRED_SECTION_HEADERS` substring check (lines 81–88, 180–184). The system prompt is STABLE — `priorExpanded` is appended to the USER message only (`buildExpansionUserMessage`, lines 95–109). `_clientFactory` DI seam exposed for testing.

### 13. characterStore.ts — expand-on-save flow

**Status:** passed.
**Evidence:** `src/main/characterStore.ts:132–167` defines `expandAndSaveCharacter`: loads prior character to pull `persona.expanded` as voice-continuity reference (lines 142–148), calls `loadApiKey()` (line 150), runs `expandPersona({ source, priorExpanded, apiKey })` (lines 152–156), merges into the input and persists via raw `saveCharacter`. Legacy-shape detector at lines 80–93 throws an explicit error before Zod parsing.

### 14. brain/index.js (orchestrator) — renderPersona consumes persona.expanded

**Status:** passed.
**Evidence:** `src/bot/brain/prompts.js:70–72` — `renderPersona(persona) → "You are ${persona.name}.\n${persona.expanded}"`. Called from `src/bot/brain/orchestrator.js:384`. `src/bot/index.js:289–305` reads `character.persona.expanded`, throws `BOT_CRASH` with message `persona expansion missing — re-save the character in the GUI to populate persona.expanded` when empty (no compat fallback). Bot config schema `src/bot/config.js:46–49` requires `persona: { name, expanded }`.

### 15. Three atomic commits with claimed hashes

**Status:** passed.
**Evidence:** `git log --oneline | grep -E "619b8e6|5030ac7|bb6490c"` returns all three:
- `619b8e6 feat(260516-0yw): engine — baseline trim + action_tick + follow open-ended + first-person memory`
- `5030ac7 feat(260516-0yw): schema + main-process persona expansion + IPC + migration`
- `bb6490c feat(260516-0yw): renderer — 2-step add flow, expanded-prompt preview, loading state`

Per-commit file diffs match the SUMMARY (engine touches brain + adapter; schema/main touches shared + main; renderer touches src/renderer).

### 16. All three test scripts pass

**Status:** passed.
**Evidence (live run output):**
- `node scripts/test-actionTick.mjs` → `PASS: test-actionTick.mjs (7/7)`
- `node scripts/test-followOpenEnded.mjs` → `PASS: test-followOpenEnded.mjs`
- `node scripts/test-personaExpansion.mjs` → `PASS: test-personaExpansion.mjs (6/6)`

### 17. Renderer — description dropped, persona.source field, expanded preview, loading state

**Status:** passed (structural code review).
**Evidence:**
- `AddCharacterScreen.tsx` (line 38) uses `personaSource` state; `line 70` submits `{ source: personaSource.trim() }`; `line 125` shows `nextLabel={submitting ? 'Generating…' : 'Create'}`. No `description` field in the form.
- `EditCharacterModal.tsx` (line 48) reads `character.persona.source ?? ''`; line 158 derives `hasExpanded`; line 220 renders `<pre className={styles.expandedPre}>{character.persona.expanded}</pre>` inside a collapsible section; line 272 shows `{saving ? 'Generating persona…' : 'Save'}`. Copy-to-clipboard button at line 150.
- `CharacterPage.tsx` (line 200–202) replaces the DESCRIPTION card with a PERSONA SOURCE card showing `character.persona.source`.
- `grep -E "description: |\.description"` across all three files returns zero matches (clean).

### 18. cli/index.js — new persona shape, no description

**Status:** passed.
**Evidence:** `src/bot/cli/index.js:67–71` sets `DEFAULT_CONFIG.persona = { name, source, expanded: '' }`; lines 173–178 prompt for "short persona blurb (who is this character?)"; line 221–228 writes `{ name, source, expanded }` to config.json. No `description` field in default config.

### 19. ipc.ts + migration.ts — IPC handler + non-expansion legacy migration

**Status:** passed.
**Evidence:**
- `src/main/ipc.ts:49–52` — `chars.save` handler now calls `expandAndSaveCharacter` and returns the persisted `Character`. `src/shared/ipc.ts:98` matching type change to `Promise<Character>`.
- `src/main/migration.ts:88–106` — legacy-config migration emits the new shape `{ persona: { source: ..., expanded: '' } }` and uses RAW `saveCharacter` (NOT `expandAndSaveCharacter`) so first-launch doesn't burn an Anthropic call.

### 20. TypeScript compiles clean

**Status:** passed.
**Evidence:**
- `npx tsc --noEmit -p tsconfig.node.json` → no output (clean exit).
- `npx tsc --noEmit -p tsconfig.web.json` → no output (clean exit).

## Notes

- **Six vs seven sections:** The verifier prompt's must-have #10 references a "seven-section template" but enumerates only six section names. The actual implementation matches the CONTEXT.md decision (`# IDENTITY / # VOICE / # DEFAULT DYNAMIC WITH THE PLAYER / # PROACTIVENESS / # REACTIONS / # MEMORY — write in YOUR voice`), which is six sections. The "seven" appears to be a wording inconsistency in the verifier prompt; CONTEXT and implementation are aligned at six.
- **Deferred items:** `deferred-items.md` documents two pre-existing harness failures in `verify-260513-wkd.mjs` and `verify-260514-gam.mjs` caused by a prior session's adapter refactor (capabilityParagraph / worldPrimer / actionRules moved out of `persona.js` into adapter prompts). These are NOT caused by 0yw work. The 0yw test scripts (`test-actionTick.mjs`, `test-followOpenEnded.mjs`) cover the new wiring end-to-end with the live orchestrator and the registry/adapter signal plumbing, so the 0yw-specific changes are independently verified.
- **Bot config schema vs CLI write:** `bot/config.js` Zod schema declares `persona: { name, expanded }` only; the CLI writes `{ name, source, expanded }`. Since Zod's default `.object()` does NOT strip extra keys (`.passthrough()` semantics not opted out via `.strict()`), the extra `source` is silently retained on the parsed config — harmless. The bot's `renderPersona` only reads `name` + `expanded`.

## Recommendations

- Human verification (see frontmatter `human_verification` list) — the four items require the live Electron + main + renderer + Anthropic stack or a real Minecraft world.
- The deferred harness mismatches (`verify-260513-wkd.mjs`, `verify-260514-gam.mjs`) are outside this task's scope but should get a separate quick-task pass to bring the mock adapter back in sync with the orchestrator's new prompt-rebuild requirements.

---

_Verified: 2026-05-16_
_Verifier: Claude (gsd-verifier, quick-task mode)_
