---
quick_id: 260505-twx
type: quick
plan: 01
wave: 1
depends_on: []
files_modified:
  - src/cli/index.js
  - src/config.js
  - src/llm/orchestrator.js
  - src/observers/snapshot.js
  - src/observers/blocks.js
  - src/behaviors/dig.js
  - src/behaviors/combat.js
  - src/llm/errStrings.js
  - src/llm/loop.js
autonomous: true
requirements: []

must_haves:
  truths:
    - "Onboarding (`sei` first-run and `sei config`) prompts for chat_mode (chat | full); persisted to config.json; ConfigSchema validates it."
    - "Orchestrator honors chat_mode: in `chat` mode only `say()` lines reach Minecraft chat (current behavior); in `full` mode the assistant's pre-tool `text` (private scratch) ALSO reaches chat with a visible prefix."
    - "Snapshot `nearby blocks:` shows up to 16 entries, with non-terrain interesting blocks (logs, ores, chests, crafting_table, furnace, beds) ordered BEFORE terrain (grass_block, dirt, sand, stone, ...) regardless of distance."
    - "Dig tool description explicitly tells the LLM that `{ block: \"<name>\" }` digs the nearest exposed block of that name within `maxDistance` (default 32) — no need to read coords from snapshot first."
    - "When sei:attacked fires while a loop is active, the orchestrator ABORTS the current loop (instead of dropping the dispatch) so the bot reacts within one Anthropic round-trip."
    - "The seed prompt for sei:attacked-driven loops names the attacker, instructs the bot to react verbally first (short, in-character), and tells it to retaliate against mobs (attackEntity) but use peer judgment for players."
    - "Combat throttle still suppresses rapid follow-up hits per attacker but the FIRST hit's dispatch always reaches the LLM (current leading-edge throttle behavior — verified preserved)."
    - "Dig error string for the `cannot break X with Y` branch no longer mentions the held item; instead it points at the root cause (no block / wrong block / unbreakable)."
    - "iteration_cap raised from 20 to 30; system prompt instructs the model that `say()` is REQUIRED on the first and last turn of a loop, optional in middle turns, and should not restate snapshot info."
    - "HP-loss while idle (no active loop) triggers a fresh loop via the existing recent_events delta path — verified by tracing snapshot deltas + sei:attacked dispatch."
  artifacts:
    - path: "src/config.js"
      provides: "ConfigSchema with `chat_mode: z.enum(['chat','full']).default('chat')` at top level."
    - path: "src/cli/index.js"
      provides: "Onboarding prompt for chat mode + removal of `delete cfg.chat` line; chat_mode persisted to config.json."
    - path: "src/llm/orchestrator.js"
      provides: "chat_mode-gated text relay for assistant `text` blocks; sei:attacked seed addendum; sei:attacked aborts active loop; dig tool description mentions name-based targeting; system prompt updated for say() cadence rule."
    - path: "src/observers/snapshot.js"
      provides: "MAX_BLOCKS = 16 + nearbyBlocks call passes interesting set."
    - path: "src/observers/blocks.js"
      provides: "TERRAIN exported; nearbyBlocks sorts non-terrain interesting blocks before terrain blocks (still distance-sorted within each tier)."
    - path: "src/behaviors/dig.js"
      provides: "Cleaner error strings: `cannot break <name>` (no held-item suffix); air branch reads `no block at X,Y,Z`."
    - path: "src/llm/loop.js"
      provides: "iterationCap default check unchanged; cap value bumped via config (memory.iteration_cap default 30 in src/config.js)."
  key_links:
    - from: "src/cli/index.js (onboarding)"
      to: "src/config.js (ConfigSchema)"
      via: "writes cfg.chat_mode → ConfigSchema.parse accepts it"
      pattern: "chat_mode"
    - from: "src/llm/orchestrator.js (mid-loop text branch ~L555-561 and terminal text branch ~L548-551)"
      to: "config.chat_mode"
      via: "if chat_mode === 'full' then bot.chat('[think] ' + text) + log"
      pattern: "chat_mode.*full"
    - from: "src/llm/orchestrator.js handleDispatch single-flight branch (~L371-381)"
      to: "currentLoop.abortController.abort()"
      via: "if event === 'sei:attacked' set pendingAttack and abort current loop"
      pattern: "sei:attacked.*abort"
    - from: "src/llm/orchestrator.js (event addendum ~L400-405)"
      to: "Anthropic seed user turn"
      via: "case 'sei:attacked' → addendum names attacker + reaction framing"
      pattern: "sei:attacked"
    - from: "src/observers/snapshot.js MAX_BLOCKS (line 11)"
      to: "src/observers/blocks.js nearbyBlocks ranking"
      via: "raised cap + tier-aware sort"
      pattern: "MAX_BLOCKS = 16"
---

<objective>
Five-fix consolidation from observed live bot session (260505): chat/full mode toggle, snapshot prioritization + dig-by-name verification, P0 attack reaction with verbal-first framing, simpler dig error strings, and loop architecture changes (higher cap + speech-cadence rule). All fixes are in src/ — no new dependencies.

Purpose: Make Sei react to the world the way the user observed it should — speak first when hit, see logs even when grass is closer, dig by name not coords, stop blaming a stick when there's no block to break, and let Haiku decide when a loop is done instead of capping at 20.

Output: Modified files listed in frontmatter. After this task: bot startup will prompt for chat_mode on first run; subsequent observations should show fewer "I can't break X with stick" dead-ends and immediate verbal reactions to attacks.
</objective>

<context>
@CLAUDE.md
@.planning/STATE.md
@src/llm/orchestrator.js
@src/llm/loop.js
@src/observers/snapshot.js
@src/observers/blocks.js
@src/cli/index.js
@src/behaviors/combat.js
@src/behaviors/dig.js
@src/llm/errStrings.js
@src/fsm.js
@src/registry.js
@src/observers/targeting.js
@src/config.js

<interfaces>
<!-- Already-verified from current code. Executor uses these directly. -->

# Dig name-based targeting ALREADY WORKS:
# - registry.js TargetShape (lines 70-80) accepts `block`, `target`, OR `(x,y,z)` — at least one required
# - observers/targeting.js resolveBlock (lines 58-86) tries: explicit coords → "#N" handle → `target` as name → `block` as name
# - Calling `dig({ block: "oak_log" })` finds the nearest oak_log within maxDistance (default 32, configurable to 64)
# - The user is correct: this already exists. Fix #2 only needs to UPDATE THE TOOL DESCRIPTION so Haiku knows.

# Current dig tool description (orchestrator.js ACTION_DESCRIPTIONS):
# - There is NO entry for `dig` in ACTION_DESCRIPTIONS at L39-46. The schemaBridge falls back to the schema only.
# - Add one: 'dig: Dig (break) a block. Prefer `{ block: "<name>" }` to dig the nearest exposed block of that name within maxDistance (default 32). Use `{ x, y, z }` only when you must dig a specific coordinate. `{ target: "#N" }` works for handles from the snapshot.'

# Combat throttle: leading-edge — fires FIRST hit immediately (debounce.js L30-47). Already correct. No change needed.

# FSM: sei:attacked is already P0 (fsm.js L18-24, L174). No change needed. The bug is in orchestrator's single-flight branch (L371-381).

# CLI: line 188 of cli/index.js does `delete cfg.chat` — remove that line and add a real chat_mode question.

# Loop iteration cap: pulled from config.memory.iteration_cap (orchestrator.js L387, L514). Default 20 (config.js L35). Bump default to 30 in config.js.
</interfaces>

<full_mode_print_path>
<!-- Where to splice the chat_mode === 'full' relay in orchestrator.js -->

Two text-branches in runIterations to wire (chat → terminal text, full → terminal text + mid-loop text):

# 1) Mid-loop text (assistant text alongside tool_uses) — L555-561 currently logs to debug only:
#       if (midText) {
#         const calledSay = toolUses.some(u => u.name === 'say')
#         if (!calledSay) logger.debug?.(`[sei/orch] mid-loop text (private, not relayed): ${midText}`)
#       }
#    Change: in `full` mode, also `bot.chat('[think] ' + midText)` + logChatOut + convoMemory.recentChat.pushSelf.
#    Truncate to ~256 chars, same as say().

# 2) Terminal text (text-only response, no tool_uses) — L546-552:
#       const text = (resp.text ?? '').trim()
#       if (text) logger.debug?.(`[sei/orch] terminal text (private, not relayed): ${text}`)
#       return
#    Change: in `full` mode, `bot.chat('[think] ' + text)` etc.

# DO NOT touch the cap-close path (gracefulCapClose at L722-751) — that already does bot.chat() unconditionally
# (it's the model's only voice in that branch since tools=[]).
</full_mode_print_path>

<attack_seed_addendum>
<!-- The new sei:attacked branch in handleDispatch's eventAddendum if/else chain (~L400-405) -->

  } else if (event === 'sei:attacked') {
    const label = data?.attackerLabel ?? 'unknown'
    const kind = data?.attackerKind ?? 'unknown'
    eventAddendum = `\n\n${label} (${kind}) just hit you. React out loud first — short, in-character. Then decide: ` +
      (kind === 'player'
        ? 'this is a peer; could be a nudge, a joke, or a real threat. Use judgment — call them out, dodge with goTo, or shrug it off. Auto-PvP is off so attackEntity on players is refused; do not try.'
        : 'mobs get hit back. Call attackEntity (with `times: 5+` for amortized swings) once you have spoken. follow first if it is moving.') +
      ' Resume any prior task only if it still makes sense.'
  }
</attack_seed_addendum>

<attack_abort_branch>
<!-- The single-flight handleDispatch branch (~L371-381) -->

# Current behavior at L371-381:
#   if (currentLoop !== null) {
#     if (!isOwnerChat) {
#       logger.warn(`[sei/orch] dispatch ${event} arrived while loop active — dropping`)
#       return
#     }
#     // owner-chat path: abort + queue interrupt
#   }
#
# New behavior: also accept sei:attacked as an abort-and-restart signal.
# Pattern matches owner-chat path but seeds a new loop instead of an interrupt turn.
#
# Implementation outline:
#   const isAttack = event === 'sei:attacked'
#   if (currentLoop !== null) {
#     if (isOwnerChat) { ...existing pendingInterrupt path... return }
#     if (isAttack) {
#       // Drop in-flight loop entirely; re-enqueue this dispatch after abort settles.
#       pendingAttack = { event, data }   // new module-level let
#       try { currentLoop.abortController.abort() } catch {}
#       return
#     }
#     logger.warn(`[sei/orch] dispatch ${event} arrived while loop active — dropping`)
#     return
#   }
#
# Then in the catch arm of runIterations (where AbortError is caught), check
# pendingAttack: if set, after the existing repair, terminate the loop early
# (return) and the finally block clears currentLoop. The bot.emit('sei:loop_terminal')
# then triggers the FSM. BUT: the FSM only enqueues sei:loop_end on terminal —
# we need the new attack dispatch to arrive too.
#
# Simpler approach: in the finally block of handleDispatch (where currentLoop = null),
# if pendingAttack is set, re-emit it via bot.emit('sei:attacked', pendingAttack.data)
# and clear. The FSM listener at fsm.js:174 will enqueue P0 → processNext → fresh
# dispatch arrives at orchestrator with currentLoop === null → runs as a fresh loop.
#
# Alternative even simpler: skip the finally re-emit, and in the abort catch arm
# of runIterations, set a flag that breaks out of the loop AND have handleDispatch's
# try/finally re-fire bot.emit('sei:attacked', pendingAttack.data) after currentLoop=null.
# The FSM owns priority + queue ordering; we just need to get the event back into the
# pipeline cleanly.
</attack_abort_branch>

<say_cadence_rule>
<!-- Add to SYSTEM_INSTRUCTIONS in orchestrator.js (L19-37) -->

Insert after the existing 'Use `say` frequently...' line (L23):

  'say() cadence: REQUIRED on the FIRST turn of a loop (so the owner knows you noticed the trigger) and on the LAST turn (so they know you finished or what you concluded). OPTIONAL in middle turns — speak only if you have something genuinely new. Do NOT restate inventory counts, position, or status the snapshot already shows. Mention numbers only when they just changed (e.g. "got the last 2 logs", not "I have 8 logs").',
</say_cadence_rule>
</context>

<tasks>

<task type="auto">
  <name>Task 1: chat/full mode toggle (CLI + ConfigSchema + orchestrator print path)</name>
  <files>src/cli/index.js, src/config.js, src/llm/orchestrator.js</files>
  <action>
Three coordinated edits — small surface area, single concern (a print toggle).

A) src/config.js: Add `chat_mode: z.enum(['chat', 'full']).default('chat')` to ConfigSchema as a top-level field (alongside `host`, `auth`, `username`, etc — pick a sensible spot near `username` since both are persona/UX shape). DEFAULT MUST BE `'chat'` so existing config.json files (which lack the field) keep current behavior after `ConfigSchema.parse`.

B) src/cli/index.js:
   1. DELETE line 188: `delete cfg.chat`. Replace with `delete cfg.chat` only if you need to scrub a stale legacy `chat` key — actually leave a single line `delete cfg.chat` as legacy-cleanup and ALSO scrub `delete cfg.chat_mode_legacy` if needed (no — just delete the line; the new field is `chat_mode`, distinct name, no collision).
   2. After the `tone` pick (around line 162), before the `apiKey` ask, add a new pick:
      ```
      const chatModeOpts = ['chat', 'full']
      const prevChatMode = existing.chat_mode === 'full' ? 1 : 0
      const chatMode = await pick(rl,
        'chat mode (chat = only say() reaches Minecraft; full = also print bot thinking):',
        chatModeOpts, prevChatMode)
      ```
   3. In the merged `cfg` object (line 169-186), add `chat_mode: chatMode,` as a top-level field.

C) src/llm/orchestrator.js — relay assistant `text` blocks to chat when chat_mode === 'full':
   1. In runIterations terminal-text branch (currently L546-551):
      ```
      const text = (resp.text ?? '').trim()
      if (text) {
        if (config.chat_mode === 'full') {
          const line = ('[think] ' + text).slice(0, 256)
          logChatOut(line)
          try { bot.chat(line) } catch {}
          convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
        } else {
          logger.debug?.(`[sei/orch] terminal text (private, not relayed): ${text}`)
        }
      }
      return
      ```
   2. In the mid-loop text branch (currently L555-561):
      ```
      const midText = (resp.text ?? '').trim()
      if (midText) {
        const calledSay = toolUses.some(u => u.name === 'say')
        if (!calledSay) {
          if (config.chat_mode === 'full') {
            const line = ('[think] ' + midText).slice(0, 256)
            logChatOut(line)
            try { bot.chat(line) } catch {}
            convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
          } else {
            logger.debug?.(`[sei/orch] mid-loop text (private, not relayed): ${midText}`)
          }
        }
      }
      ```
   The 256-char truncation matches the existing `say` truncation at L575. The `[think] ` prefix makes it visually distinct from say() lines in chat. DO NOT touch gracefulCapClose (L722-751) — it already routes its own text to chat.
  </action>
  <verify>
    <automated>node --input-type=module -e "import { ConfigSchema } from './src/config.js'; const cfg = ConfigSchema.parse({ host: '127.0.0.1', auth: 'offline', username: 'Sui', owner_username: 'You', persona: { name: 'Sui', backstory: 'x', tone: 'friendly' }, anthropic: { api_key: 'k' } }); if (cfg.chat_mode !== 'chat') { console.error('FAIL: default chat_mode is', cfg.chat_mode); process.exit(1) } const cfg2 = ConfigSchema.parse({ ...cfg, chat_mode: 'full' }); if (cfg2.chat_mode !== 'full') { console.error('FAIL: explicit full not accepted'); process.exit(1) } try { ConfigSchema.parse({ ...cfg, chat_mode: 'bogus' }); console.error('FAIL: bogus accepted'); process.exit(1) } catch (e) { /* expected */ } console.log('PASS') "</automated>
  </verify>
  <done>
- ConfigSchema accepts `chat` (default) and `full`; rejects other values.
- `delete cfg.chat` line removed from cli/index.js; new chat_mode pick prompts user.
- orchestrator's two text branches gate on `config.chat_mode === 'full'` and emit `[think] <text>` to chat + convoMemory + logChatOut.
- gracefulCapClose untouched.
  </done>
</task>

<task type="auto">
  <name>Task 2: Snapshot prioritization (16 entries, interesting-before-terrain) + dig tool description</name>
  <files>src/observers/snapshot.js, src/observers/blocks.js, src/llm/orchestrator.js</files>
  <action>
A) src/observers/blocks.js:
   1. EXPORT the `TERRAIN` constant (line 12): change `const TERRAIN = [...]` to `export const TERRAIN = [...]`. Snapshot consumers need to identify terrain names for tier-aware sorting.
   2. In `nearbyBlocks` (L74-143), after the existing `positions.sort((a, b) => a._d - b._d)` (line 140), add a STABLE secondary sort that promotes non-terrain to the front:
      ```
      // Tier-aware sort: non-terrain interesting blocks (logs, ores, chests, ...)
      // come before terrain (grass, dirt, sand, stone, ...). Within each tier,
      // closest-first is preserved. Without this, 8 nearby grass_blocks crowd out
      // the oak_log 14 blocks away — exactly the bug the user observed.
      const TERRAIN_SET = new Set(TERRAIN)
      positions.sort((a, b) => {
        const aTer = TERRAIN_SET.has(a.name) ? 1 : 0
        const bTer = TERRAIN_SET.has(b.name) ? 1 : 0
        if (aTer !== bTer) return aTer - bTer  // 0 (non-terrain) before 1 (terrain)
        return 0  // tier-equal: keep distance order (Array.prototype.sort is stable in V8)
      })
      ```
      Note: replace the prior distance sort + delete loop OR keep both — the order matters: distance sort FIRST (line 140), THEN tier sort (above) so the secondary stable sort preserves distance ordering within tiers. Then run the existing `for (const p of positions) delete p._d` loop AFTER both sorts.

B) src/observers/snapshot.js:
   1. Line 11: change `const MAX_BLOCKS = 8` to `const MAX_BLOCKS = 16`.
   2. No other change needed — `nearbyBlocks` already receives the count via `MAX_BLOCKS`. The `+K more` line keeps working.

C) src/llm/orchestrator.js — dig tool description:
   1. In `ACTION_DESCRIPTIONS` (L39-46), add a `dig` entry:
      ```
      dig: 'Break a block. Prefer `{ block: "<name>" }` to dig the NEAREST EXPOSED block of that name within maxDistance (default 32, max 64). Use `{ target: "#N" }` for a specific snapshot handle. Use `{ x, y, z }` only when you must dig a precise coordinate. The bot will pathfind into reach automatically; if "out of range" comes back, it walked as close as it could — call `dig` again or move with `goTo` first.',
      ```
   This is purely a description change. No schema change. The behavior is already supported by registry.js TargetShape (L70-80) and observers/targeting.js resolveBlock (L58-86, name fallback at L77+L82).
  </action>
  <verify>
    <automated>node --input-type=module -e "
      import { TERRAIN } from './src/observers/blocks.js';
      import { nearbyBlocks } from './src/observers/blocks.js';
      // Mock bot with mixed blocks: 5 grass_block close, 2 oak_log far.
      const blocks = [
        {x:0,y:0,z:1,name:'grass_block',d:1},
        {x:0,y:0,z:2,name:'grass_block',d:2},
        {x:0,y:0,z:3,name:'grass_block',d:3},
        {x:0,y:0,z:4,name:'grass_block',d:4},
        {x:0,y:0,z:5,name:'grass_block',d:5},
        {x:0,y:0,z:10,name:'oak_log',d:10},
        {x:0,y:0,z:11,name:'oak_log',d:11},
      ];
      const bot = {
        version:'1.21.1',
        entity:{position:{x:0,y:0,z:0,distanceTo:function(p){return Math.hypot(p.x-this.x,p.y-this.y,p.z-this.z)}}},
        findBlocks: () => blocks.map(b => ({ x:b.x,y:b.y,z:b.z,distanceTo:(p)=>b.d })),
        blockAt: (p) => { const b = blocks.find(x => x.x===p.x&&x.y===p.y&&x.z===p.z); return b ? { name:b.name, boundingBox:'block' } : null },
      };
      // Stub posHealer + isExposed by passing { count:7 } so we get all 7 back.
      // Actual nearbyBlocks uses bot.findBlocks under the hood — for this smoke check,
      // we just want to confirm TERRAIN is exported and the source builds.
      if (!TERRAIN.includes('grass_block')) { console.error('FAIL: TERRAIN missing grass_block'); process.exit(1) }
      if (!TERRAIN.includes('sand')) { console.error('FAIL: TERRAIN missing sand'); process.exit(1) }
      console.log('PASS: TERRAIN exported with', TERRAIN.length, 'entries');
    " && grep -q "MAX_BLOCKS = 16" src/observers/snapshot.js && echo "PASS: MAX_BLOCKS=16" && grep -q "dig:" src/llm/orchestrator.js && echo "PASS: dig description present"</automated>
  </verify>
  <done>
- TERRAIN exported from blocks.js.
- nearbyBlocks sorts non-terrain before terrain (stable secondary sort preserving distance within tiers).
- MAX_BLOCKS = 16 in snapshot.js.
- ACTION_DESCRIPTIONS.dig in orchestrator.js documents `{ block: "<name>" }` as preferred form.
- No registry/schema changes (already supported).
  </done>
</task>

<task type="auto">
  <name>Task 3: P0 attack reaction (abort active loop + verbal-first seed) + dig error strings + loop cap + say cadence rule</name>
  <files>src/llm/orchestrator.js, src/behaviors/dig.js, src/llm/errStrings.js, src/config.js</files>
  <action>
Bundled because all four touch closely-related concerns (orchestrator behavior + a couple of error-string lines + a config default). Order: simplest first.

A) src/config.js: change `iteration_cap: z.number().int().min(1).default(20)` (L35) → `default(30)`. The cap should rarely be hit; we want Haiku to drive termination via no-tool-use, not a forced wrap-up.

B) src/behaviors/dig.js — fix misleading error strings:
   1. Line 43-46 currently:
      ```
      if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
        const holding = bot.heldItem?.name ?? 'bare hands'
        return `cannot break ${blockName} with ${holding}`
      }
      ```
      Replace with:
      ```
      // Distinguish "no block at coord" (snapshot stale, model picked empty space)
      // from "block exists but cannot be broken" (bedrock, water, etc).
      if (blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air') {
        return `no block at ${bx},${by},${bz} (target was ${blockName})`
      }
      if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
        return `cannot break ${blockName} at ${bx},${by},${bz} (unbreakable or wrong tool)`
      }
      ```
      Two improvements: (1) air gets its own clear message pointing at the coord, (2) the held-item suffix is gone — Haiku was reading "with stick" as causal ("stick is wrong tool for log") when the real issue was empty space.

C) src/llm/errStrings.js — no functional changes needed; the helpers themselves are fine. Add a brief JSDoc note to `reason()` explaining when NOT to use it (i.e. don't append held-item or other "what you tried" context — let the action itself frame the failure):
      ```
      /**
       * Format an underlying mineflayer error into a single short line.
       *
       * NOTE: Do NOT post-decorate the result with held-item / inventory context
       * inside action wrappers. Haiku reads decoration as causal ("with stick"
       * → "stick is wrong tool"). If an action can fail for multiple distinct
       * reasons, branch on the reason and emit a self-contained message that
       * names the actual root cause (no block, unbreakable, out of range, ...).
       */
      ```
   That's the only edit to errStrings.js — defensive doc to prevent regressions.

D) src/llm/orchestrator.js — three edits in this file:

   D1) Add `say()` cadence rule to SYSTEM_INSTRUCTIONS (L19-37). After the existing 'Use `say` frequently...' line (currently L23), insert as a new array entry:
      ```
      'say() cadence: REQUIRED on the FIRST turn of a loop (so the owner knows you noticed the trigger) and on the LAST turn (so they know you finished or what you concluded). OPTIONAL in middle turns — speak only if you have something genuinely new. Do NOT restate inventory counts, position, or status the snapshot already shows. Mention numbers only when they just changed (e.g. "got the last 2 logs", not "I have 8 logs").',
      ```

   D2) Add sei:attacked seed addendum. In handleDispatch (~L400-405), the if/else chain currently handles `sei:loop_end` and `sei:idle`. Add an `else if (event === 'sei:attacked')` branch:
      ```
      } else if (event === 'sei:attacked') {
        const label = data?.attackerLabel ?? 'unknown'
        const kind = data?.attackerKind ?? 'unknown'
        const reactClause = (kind === 'player' || kind === 'players')
          ? 'this is a peer; could be a nudge, a joke, or a real threat. Use judgment — call them out, dodge with goTo, or shrug it off. Auto-PvP is off so attackEntity on players is refused; do not try.'
          : 'mobs get hit back. Call attackEntity (use `times: 5+` to amortize swings) once you have spoken. follow first if it is moving.'
        eventAddendum = `\n\n${label} (${kind}) just hit you. React out loud first — short, in-character. Then decide: ${reactClause} Resume any prior task only if it still makes sense.`
      }
      ```
      Place this AFTER the existing `sei:idle` branch but BEFORE `const eventText = ...` on L406.

   D3) sei:attacked aborts active loop instead of being dropped. This is the trickiest edit — three sub-edits to keep the wiring clean:

      i. Add a module-level let near `let pendingInterrupt = null` (L196):
         ```
         let pendingAttack = null
         ```

      ii. In the single-flight branch (L371-381), insert an attack-abort path before the existing drop-warn:
         ```
         if (currentLoop !== null) {
           if (isOwnerChat) {
             // existing owner-chat interrupt path — unchanged
             const chatText = (data && (data.text ?? data.message)) ?? JSON.stringify(data ?? {})
             pendingInterrupt = { chatText: String(chatText) }
             try { currentLoop.abortController.abort() } catch {}
             return
           }
           if (event === 'sei:attacked') {
             // P0 safety: drop in-flight loop and re-fire the attack as a fresh dispatch
             // once the current loop's finally has cleared currentLoop.
             pendingAttack = { event, data }
             try { currentLoop.abortController.abort() } catch {}
             return
           }
           logger.warn(`[sei/orch] dispatch ${event} arrived while loop active — dropping`)
           return
         }
         ```
         REORGANIZE: current code structure is `if (!isOwnerChat) { warn; return } /* owner chat path */`. The new code separates owner-chat and attack into explicit branches. Keep the chat-text extraction logic that was previously after the if-block.

      iii. In the finally block of handleDispatch (L468-498, after `currentLoop = null`), re-fire any pending attack:
         ```
         currentLoop = null
         pendingInterrupt = null
         if (pendingAttack) {
           const pa = pendingAttack
           pendingAttack = null
           // Re-emit so the FSM re-enqueues at P0 → processNext → fresh dispatch
           // arrives at handleDispatch with currentLoop === null (fresh-loop path).
           try { bot.emit('sei:attacked', pa.data) } catch (err) {
             logger.warn?.(`[sei/orch] sei:attacked re-emit failed: ${err.message}`)
           }
         }
         try { await closeContainerSession() } catch {}
         ```
         Note: the existing `bot.emit('sei:loop_terminal', ...)` call (L491) should still fire BEFORE the attack re-emit so the FSM's idle timer reset and loop_end suppression logic stay coherent. Order in finally: (1) loopHistory.push, (2) sei:loop_terminal emit, (3) `currentLoop = null; pendingInterrupt = null`, (4) `pendingAttack` re-emit, (5) closeContainerSession. The aborted loop still triggers sei:loop_terminal — that's fine; the FSM's loop_end enqueue will be P2.5 which is below the P0 sei:attacked we're about to re-fire, so the attack wins the queue race.

      iv. Update repairAfterAbort (L674-720): currently it composes a `PLAYER INTERRUPT:` user turn. When abort was triggered by `pendingAttack` (not `pendingInterrupt`), we want NEITHER the interrupt turn NOR a continuation — we want the loop to terminate. Simplest: in runIterations catch arm (L528-535), after `replaceAbortController(loop)`, check `if (pendingAttack) return` to exit the iteration loop cleanly. The aborted loop will close via finally; the re-emit fires the new loop.
         ```
         } catch (err) {
           if (err && (err.name === 'AbortError' || signal.aborted)) {
             if (pendingAttack) {
               // Drop this loop entirely; finally block re-fires the attack as a fresh dispatch.
               return
             }
             await repairAfterAbort(loop)
             replaceAbortController(loop)
             continue
           }
           throw err
         }
         ```
         Same check in the inner mid-tool-dispatch catch (L611-633): wrap the `pendingInterrupt` synthesis branch so that if `pendingAttack` is set instead, just return (don't append the PLAYER INTERRUPT turn). Add early in that branch:
         ```
         if (err && (err.name === 'AbortError' || signal.aborted)) {
           if (pendingAttack) {
             // Synthesize aborted results to keep pairing valid even though we're bailing,
             // so any in-flight Anthropic streaming state can settle cleanly.
             for (let i = 0; i < toolUses.length; i++) {
               if (!results[i]) results[i] = { type:'tool_result', tool_use_id: toolUses[i].id, content: 'aborted: incoming attack', is_error: false }
             }
             return  // finally block re-emits the attack
           }
           // existing pendingInterrupt synthesis path — unchanged
           ...
         }
         ```

E) Verify HP-loss-while-idle activation (no code change expected — this is a verification step):
   - When the bot takes damage with no active loop, `entityHurt` fires → combat.js emits `sei:attacked` → FSM enqueues P0 → orchestrator opens a fresh loop. This already works.
   - The recent_events line in snapshot.js (L227-229) records `hp -N` deltas. These show up in the seed snapshot of the next loop regardless of trigger.
   - Confirm: idle ticks (`sei:idle` at 60s) ALSO surface recent_events because the snapshot is composed fresh at L425/L431. No additional wiring needed.
  </action>
  <verify>
    <automated>node --input-type=module -e "
      import { ConfigSchema } from './src/config.js';
      const cfg = ConfigSchema.parse({ host:'127.0.0.1', auth:'offline', username:'Sui', owner_username:'You', persona:{name:'Sui',backstory:'x',tone:'friendly'}, anthropic:{api_key:'k'}, memory:{} });
      if (cfg.memory.iteration_cap !== 30) { console.error('FAIL: iteration_cap default is', cfg.memory.iteration_cap, 'expected 30'); process.exit(1) }
      console.log('PASS: iteration_cap default 30');
    " && grep -q 'no block at .* (target was' src/behaviors/dig.js && echo 'PASS: air dig msg' && grep -q 'unbreakable or wrong tool' src/behaviors/dig.js && echo 'PASS: unbreakable msg' && ! grep -q 'with \${holding}' src/behaviors/dig.js && echo 'PASS: held-item suffix removed' && grep -q "say() cadence" src/llm/orchestrator.js && echo 'PASS: cadence rule' && grep -q "pendingAttack" src/llm/orchestrator.js && echo 'PASS: pendingAttack wired' && grep -q "sei:attacked" src/llm/orchestrator.js && echo 'PASS: attack seed addendum present' && node --check src/llm/orchestrator.js && echo 'PASS: orchestrator parses' && node --check src/behaviors/dig.js && echo 'PASS: dig parses' && node --check src/config.js && echo 'PASS: config parses'</automated>
  </verify>
  <done>
- iteration_cap default is 30 in src/config.js.
- dig.js air branch returns `no block at X,Y,Z (target was air)`; unbreakable branch returns `cannot break X at X,Y,Z (unbreakable or wrong tool)`; held-item suffix gone.
- errStrings.js has JSDoc warning against post-decoration.
- orchestrator SYSTEM_INSTRUCTIONS includes the say() cadence rule.
- handleDispatch single-flight branch routes sei:attacked through abort + finally re-emit (instead of dropping).
- runIterations catch arms check pendingAttack and exit cleanly without appending a PLAYER INTERRUPT turn.
- finally block re-fires bot.emit('sei:attacked', data) AFTER currentLoop = null and AFTER sei:loop_terminal emit, so the next FSM tick sees a fresh dispatch with currentLoop===null and opens a new loop with the attack seed addendum.
- All three files parse with `node --check` (no syntax errors from the editing).
- Existing combat.js leading-edge throttle preserved — no change.
- HP-loss-while-idle path verified (no code change needed; entityHurt → sei:attacked → FSM P0 → fresh loop already works).
  </done>
</task>

</tasks>

<verification>
1. Boot the bot locally with `sei start` and confirm onboarding (`sei config`) prompts for chat_mode (1=chat default, 2=full).
2. Set `chat_mode: "full"` in config.json manually and start; trigger a loop (chat the bot) and confirm `[think] ...` lines appear in Minecraft chat alongside the say() lines.
3. Set chat_mode back to `chat` (default); confirm only say() lines reach chat.
4. In a forest biome with grass nearby, confirm snapshot's `nearby blocks:` lists oak_log (or similar) BEFORE grass_block entries even when grass is closer.
5. Tell the bot "chop a tree". Confirm it calls `dig({ block: "oak_log" })` instead of reading coords from snapshot.
6. Hit the bot mid-task (mid-loop). Confirm:
   - The current loop aborts (logs `[sei/orch] loop terminal` followed shortly by a fresh `loop start` with event=sei:attacked).
   - The bot's first say() in the new loop reacts verbally to being hit, names the attacker (or describes them), and the bot then either retaliates (mob) or improvises (player).
7. Try `dig({ x: <empty-coord>, y, z })` (or have the bot do it). Confirm error string says `no block at X,Y,Z (target was air)` not `cannot break air with stick`.
8. Run a multi-step task (e.g. "build a 4x4 dirt platform"). Confirm the loop runs more than 20 iterations without hitting the cap, terminates naturally when done.
9. Watch for repeated say() lines that just restate snapshot info — they should be rare.
</verification>

<success_criteria>
- All 5 fixes shipped in a single commit.
- All three task `<verify>` blocks pass.
- `node --check` succeeds on every modified .js file.
- `git diff` touches exactly the 9 files listed in `files_modified`.
- No new dependencies added (`package.json` unchanged).
- Existing tests (if any) still pass: `npm test` if a script exists, otherwise skip.
</success_criteria>

<output>
After completion, append a row to `.planning/STATE.md`'s Quick Tasks Completed table:
| 260505-twx | Sei behavior fixes: chat/full mode toggle, snapshot-prioritization (16 entries, interesting-before-terrain), dig-by-name tool description, P0 attack reaction with verbal-first seed, dig error strings, iteration_cap 20→30, say() cadence rule | 2026-05-05 | <commit> | [260505-twx-sei-behavior-fixes-chat-full-mode-toggle](./quick/260505-twx-sei-behavior-fixes-chat-full-mode-toggle/) |

Update Session Continuity's "Last action" to reference this quick task.
</output>
