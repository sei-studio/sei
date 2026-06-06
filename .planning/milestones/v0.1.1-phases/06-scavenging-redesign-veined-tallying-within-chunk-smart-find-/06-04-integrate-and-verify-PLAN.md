---
phase: 06
plan: 04
type: execute
wave: 3
depends_on: ["06-01", "06-02", "06-03"]
files_modified:
  - src/bot/adapter/minecraft/observers/snapshot.js
  - src/bot/adapter/minecraft/registry.js
  - src/bot/brain/orchestrator.js
  - scripts/verify-phase6.mjs
autonomous: false
requirements:
  - D-NEW-SCAV-1
  - D-NEW-SCAV-2
  - D-NEW-SCAV-3
tags:
  - minecraft
  - mineflayer
  - snapshot
  - registry
  - llm-primer
  - cache-bust

must_haves:
  truths:
    - "snapshot.js renders `nearby veins:` lines (one per vein, with #N handle) replacing the per-block `nearby blocks:` section"
    - "Vein handle entries are pushed to the shared `handles` array via the SAME monotonic `n` counter as entities — entity numbering continues uninterrupted"
    - "`find` action is registered in createDefaultRegistry with Zod schema; returns `{found, id, pos, distance}` or `{found:false, reason}`"
    - "`mine_vein` action is registered with refine(name || (x,y,z)) Zod schema; delegates to mineVeinAction"
    - "ACTION_DESCRIPTIONS.find and ACTION_DESCRIPTIONS.mine_vein are present in orchestrator.js; mine_vein description matches MINE_VEIN_DESCRIPTION byte-identically with sync-comment"
    - "verify-phase6.mjs exercises end-to-end with stubbed bot: snapshot renders veins line, find returns hit, mine_vein chains find+flood+dig, abort cancels mid-vein"
    - "Live-bot manual checkpoint approved by developer (visual confirm of `nearby veins:` and Haiku reaching for mine_vein/find)"
  artifacts:
    - path: src/bot/adapter/minecraft/observers/snapshot.js
      provides: "veined nearby-veins section"
      contains: "nearby veins:"
    - path: src/bot/adapter/minecraft/registry.js
      provides: "find + mine_vein registrations"
      contains: "register('find'"
    - path: src/bot/brain/orchestrator.js
      provides: "ACTION_DESCRIPTIONS.find + .mine_vein"
      contains: "mine_vein:"
    - path: scripts/verify-phase6.mjs
      provides: "Automated phase-6 end-to-end harness"
  key_links:
    - from: src/bot/adapter/minecraft/observers/snapshot.js
      to: src/bot/adapter/minecraft/observers/veins.js
      via: "imports nearbyVeins"
      pattern: "from './veins.js'"
    - from: src/bot/adapter/minecraft/registry.js
      to: src/bot/adapter/minecraft/loose-terms.js
      via: "imports resolveTerm for find handler"
      pattern: "resolveTerm"
    - from: src/bot/adapter/minecraft/registry.js
      to: src/bot/adapter/minecraft/behaviors/mineVein.js
      via: "imports mineVeinAction"
      pattern: "mineVeinAction"
    - from: src/bot/brain/orchestrator.js
      to: src/bot/adapter/minecraft/behaviors/mineVein.js
      via: "ACTION_DESCRIPTIONS.mine_vein mirrors MINE_VEIN_DESCRIPTION"
      pattern: "mine_vein:"
---

<objective>
Wire the three new modules (veins observer, loose-terms, mineVein behavior) into the live system: replace the snapshot's per-block render with veined output, register `find` and `mine_vein` in the closed Zod registry, and update the cached LLM primer (`ACTION_DESCRIPTIONS`) so Haiku knows the new affordances exist. End with an automated verification harness and a developer-driven live-bot checkpoint.

Purpose: Closes D-NEW-SCAV-1/2/3 end-to-end. Snapshot becomes mining-shaped, NL->ID resolves server-side, `mine_vein` becomes the iteration-cap-efficient verb for vein-shaped resources.

Deliberate Anthropic cache-prefix bust event — both new ACTION_DESCRIPTIONS keys land in ONE commit so cache rewarms once.

Output: 3 modified files + 1 new verification script + manual live-bot approval checkpoint.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-CONTEXT.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-RESEARCH.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-PATTERNS.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-01-veins-observer-PLAN.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-02-loose-terms-PLAN.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-03-mine-vein-behavior-PLAN.md
@src/bot/adapter/minecraft/observers/snapshot.js
@src/bot/adapter/minecraft/registry.js
@src/bot/adapter/minecraft/observers/targeting.js

Critical snapshot.js invariants (per PATTERNS.md + RESEARCH.md):
- L43 region: `const blocks = nearbyBlocks(...)` — swap to `nearbyVeins`.
- `let n` monotonic counter shared across blocks AND entities. PRESERVE — vein handles consume `n` first, entity numbering picks up after.
- L97-108 region: `nearby blocks:` render block. REPLACE with `nearby veins:` render.
- Handle push shape: `handles.push([tag, { kind: 'block', pos: { x, y, z }, expiresAt }])`.
- `setHandles(handles)` is the SINGLE call point at end of `composeSnapshot` — do not duplicate.
- `aroundFeet` / `terrain at feet:` section UNCHANGED (CONTEXT.md Q3).

registry.js patterns:
- Add registrations inside `createDefaultRegistry()` near other dig/locate actions.
- Inline handler for `find` (small); delegate `mine_vein` to `mineVeinAction` from `behaviors/mineVein.js`.
- Zod refine pattern for OR-shaped inputs (existing analog: AttackEntity name/target refine).
- Handler signature: `(args, bot, config) => Promise<string | object>`.

orchestrator.js patterns:
- `ACTION_DESCRIPTIONS` object around L107-118.
- ADD two keys: `find:` and `mine_vein:`.
- `mine_vein:` description MUST be byte-identical to `MINE_VEIN_DESCRIPTION` exported from `behaviors/mineVein.js` — add sync-comment (dig.js drift discipline analog at orchestrator.js L114-117).
- The map is consumed by `buildAnthropicTools(subRegistry, ACTION_DESCRIPTIONS)` around L447 — verify the subregistry path does NOT filter movement-tier actions out (per STATE.md "API-only collapse drop ollama/circuit/handOffToMovement"). If a filter remains, fix or escalate.
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Replace snapshot nearby-blocks render with nearby-veins render</name>
  <files>src/bot/adapter/minecraft/observers/snapshot.js</files>
  <behavior>
    - Snapshot output contains a `nearby veins:` section header (replacing `nearby blocks:`).
    - For each vein (top 8 by anchor distance): one line of the form `  #N <name> x<count> @<x>,<y>,<z> d=<dist1dp>`. When `count >= 64`, render `x64+` to signal flood-fill truncation.
    - Empty case prints `  (none)`.
    - Overflow prints trailing `  +<more> more` line.
    - Each vein anchor minted to `handles` array as `[tag, {kind:'block', pos:{x,y,z}, expiresAt}]`, consuming the shared monotonic `n` counter.
    - Entity numbering after veins continues from `n` correctly (existing entity section unchanged).
    - `terrain at feet:` line unchanged.
    - `setHandles(handles)` is called exactly once at end of composeSnapshot.
  </behavior>
  <action>
Read the current `src/bot/adapter/minecraft/observers/snapshot.js` first to confirm exact import lines, the `let n` declaration site, the `nearbyBlocks` call site, and the `nearby blocks:` render block.

Edits:

1. Import swap: replace `nearbyBlocks` import with `nearbyVeins` from `./veins.js`. Keep `aroundFeet` and any other blocks.js imports.

2. Call swap: replace the `nearbyBlocks(...)` call with `const veins = nearbyVeins(bot, { radius: 16, maxVeins: 8, veinCap: 64 })`.

3. Render swap: replace the entire `nearby blocks:` block with a `nearby veins:` render. The replacement must (a) consume the same `let n` counter, (b) push to the same `handles` array using the same `[tag, {kind:'block', pos, expiresAt}]` shape, (c) handle empty + overflow cases, (d) render `x64+` when count is capped. Inline-simple — no helper function (per CONTEXT.md L39, the scanner is already factored out so future renderer swaps remain local edits).

4. Self-invariants before save:
   - Single `setHandles(handles)` call at end of composeSnapshot.
   - Single `let n` declaration; veins consume first, entities continue after.
   - No remaining references to `nearbyBlocks`, `blocks.positions`, or the old `#N <name> @x,y,z` per-block format in this file.

Per Pitfall 3 (RESEARCH.md L457): nearbyVeins MUST NOT mint handles via any side channel — snapshot.js is the sole handle minter.

Per CONTEXT.md Q3 / RESEARCH.md L36: keep the `terrain at feet:` cube section as-is — it is complementary, not redundant.
  </action>
  <verify>
    <automated>node -e "const fs=require('fs');const s=fs.readFileSync('src/bot/adapter/minecraft/observers/snapshot.js','utf8');const stripped=s.split('\n').filter(l=>!l.trim().startsWith('//')&&!l.trim().startsWith('*')).join('\n');if(!stripped.includes('nearby veins:')){console.error('missing nearby veins: header');process.exit(1);}if(stripped.includes('nearbyBlocks(')){console.error('still calls nearbyBlocks');process.exit(2);}if(!stripped.includes('nearbyVeins(')){console.error('does not call nearbyVeins');process.exit(3);}const c=(stripped.match(/setHandles\(/g)||[]).length;if(c!==1){console.error('setHandles called',c,'times');process.exit(4);}console.log('ok');"</automated>
  </verify>
  <done>
    snapshot.js renders `nearby veins:` instead of `nearby blocks:`; mints one handle per vein anchor; preserves single `setHandles` call; `terrain at feet:` unchanged.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Register find + mine_vein in registry.js and update ACTION_DESCRIPTIONS</name>
  <files>src/bot/adapter/minecraft/registry.js, src/bot/brain/orchestrator.js</files>
  <behavior>
    - `find` registered with `z.object({ name: z.string().min(1), maxDistance: z.number().min(1).max(128).default(64) })`. Handler resolves term, builds mcData id-array `matching`, calls `bot.findBlocks(...)`, returns `{found:true,id,pos:{x,y,z},distance}` (distance to 1dp) on hit or `{found:false,reason}` otherwise. NaN-safe origin via `getHealedPos`.
    - `mine_vein` registered with refine schema (name OR x,y,z required), delegates to `mineVeinAction`.
    - `ACTION_DESCRIPTIONS.find` is a clear, single-paragraph description steering Haiku toward `find({name:"..."})` and explaining loose-term semantics + the `{found,id,pos,distance}` return shape.
    - `ACTION_DESCRIPTIONS.mine_vein` equals `MINE_VEIN_DESCRIPTION` byte-for-byte; a sync-comment near the key references `behaviors/mineVein.js` so future edits don't drift.
    - The buildAnthropicTools surfacing point (orchestrator.js around L447) is verified to not filter `find`/`mine_vein` out. If a movement-tier filter still exists, fix it or escalate as a phase blocker.
    - Existing 14 registered actions remain intact and unchanged.
  </behavior>
  <action>
Read `src/bot/adapter/minecraft/registry.js` first to confirm existing imports (`z`, registry factory) and the layout of `createDefaultRegistry()`.

**registry.js edits:**

1. Add imports near the top (skip any already present):
   - `import { resolveTerm } from './loose-terms.js'`
   - `import { mineVeinAction } from './behaviors/mineVein.js'`
   - `import { getHealedPos } from './observers/posHealer.js'`
   - `import mcDataLib from 'minecraft-data'`

2. Inside `createDefaultRegistry()` near other locate/dig-style actions, register `find` with an inline handler. Schema: `z.object({ name: z.string().min(1), maxDistance: z.number().min(1).max(128).default(64) })`. Handler steps (per RESEARCH.md L242-273):
   - `const ids = resolveTerm(args.name)`; if empty return `{found:false, reason:'no known IDs for <name>'}`.
   - Build `matching`: try `mcDataLib(bot.version)`; if `mcData?.blocksByName` then `ids.map(n => mcData.blocksByName[n]?.id).filter(v => v != null)`; else `(b) => ids.includes(b.name)`.
   - If id-array form yields empty array: return `{found:false, reason:'no known IDs for <name>'}`.
   - Compute origin: `const healed = getHealedPos(bot) ?? bot.entity?.position; const point = healed && Number.isFinite(healed.x) ? healed : undefined`.
   - `const hits = bot.findBlocks({ matching, maxDistance: args.maxDistance, count: 1, point })`.
   - If no hits: return `{found:false, reason:'no <name> in loaded chunks within <maxDistance>m'}`.
   - On hit: `const blk = bot.blockAt(hits[0])`; return `{found:true, id: blk?.name ?? 'unknown', pos:{x,y,z}, distance: Number(hits[0].distanceTo(point ?? hits[0]).toFixed(1))}` (guard distance against missing point).

3. Register `mine_vein` (per RESEARCH.md L374-389):
   - Schema: `z.object({ name: z.string().optional(), x: z.number().optional(), y: z.number().optional(), z: z.number().optional(), maxDistance: z.number().min(1).max(64).default(32) }).refine(a => (typeof a.name === 'string' && a.name.length > 0) || (typeof a.x === 'number' && typeof a.y === 'number' && typeof a.z === 'number'), { message: 'must specify name or x,y,z' })`.
   - Handler: `mineVeinAction` (imported).

Note: the inner property name `z` in the schema literal does not collide with the Zod alias `z` — `z.object` is a method call before the literal opens, and inside `{ z: z.number().optional() }` the property name is just a string key. Confirm by checking existing actions with `{x,y,z}` schemas (likely `dig`).

**orchestrator.js edits:**

1. Locate the `ACTION_DESCRIPTIONS` object near L107.

2. Add two keys (place near `dig:` for thematic grouping):
   - `find: '<one-paragraph description>'` — steer Haiku to call `find({name:"wood"|"ore"|"stone"|...|"oak_log"})` for nearest-loaded-chunk lookup; explain it does NOT move the bot; explain return shape `{found,id,pos,distance}` or `{found:false,reason}`; mention loose-term keys expand server-side (Pitfall 4: pass exact ID for strict match).
   - `mine_vein: MINE_VEIN_DESCRIPTION` — import the constant and reference it directly so byte-equality is automatic:
     ```js
     import { MINE_VEIN_DESCRIPTION } from '../adapter/minecraft/behaviors/mineVein.js'
     // ...
     const ACTION_DESCRIPTIONS = {
       // ...
       mine_vein: MINE_VEIN_DESCRIPTION, // SYNC: keep in sync with adapter/minecraft/behaviors/mineVein.js
       find: '...',
     }
     ```
   - If the orchestrator already imports from `behaviors/dig.js` (e.g. `DIG_DESCRIPTION`), follow the same import path style. If not, the `dig:` key may be inline — match whatever drift-discipline pattern already exists; if there is no precedent, prefer importing `MINE_VEIN_DESCRIPTION` so the byte-identity is mechanical, not manual.

3. Verify `buildAnthropicTools(subRegistry, ACTION_DESCRIPTIONS)` (around L447) — read the subregistry construction to confirm `find` and `mine_vein` are NOT filtered out. Per STATE.md "API-only collapse (drop ollama/circuit/handOffToMovement)" the single-Haiku-layer model calls movement actions directly, so the filter should already be gone. If a filter remains and excludes new actions: fix it (extend the allow-list) or escalate as a phase blocker via a TODO comment + STATE.md note before continuing.

**Cache-prefix coordination:** This task's edits to `ACTION_DESCRIPTIONS` bust the Anthropic cache prefix. Batch BOTH new keys into one commit (per Pitfall 6). Mention "phase 6 deliberate cache bust" in the commit message.
  </action>
  <verify>
    <automated>node -e "const fs=require('fs');const reg=fs.readFileSync('src/bot/adapter/minecraft/registry.js','utf8').split('\n').filter(l=>!l.trim().startsWith('//')&&!l.trim().startsWith('*')).join('\n');for(const t of [\"register('find'\",\"register('mine_vein'\",\"resolveTerm\",\"mineVeinAction\"]){if(!reg.includes(t)){console.error('registry missing',t);process.exit(1);}}const orch=fs.readFileSync('src/bot/brain/orchestrator.js','utf8').split('\n').filter(l=>!l.trim().startsWith('//')&&!l.trim().startsWith('*')).join('\n');for(const t of ['find:','mine_vein:']){if(!orch.includes(t)){console.error('orchestrator missing',t);process.exit(2);}}console.log('ok');"</automated>
  </verify>
  <done>
    Both actions registered; orchestrator surfaces both descriptions; movement-filter (if any) verified or fixed; commit message flags cache bust.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: scripts/verify-phase6.mjs end-to-end harness</name>
  <files>scripts/verify-phase6.mjs</files>
  <behavior>
    - Idempotent (re-run yields same result).
    - V1: snapshot renders `nearby veins:` for a stubbed 3-tree scene; each tree appears once with correct count; `#N` handles increment.
    - V2: registry exposes `find` and `mine_vein` with the expected Zod input shapes (introspect via `registry.list()` or whatever introspection the registry surface offers; if none, validate against a fresh registry by calling each schema's `.parse` with known-good and known-bad inputs).
    - V3: `find({name:'wood'})` against a stubbed bot with a single oak_log in loaded chunks returns `{found:true, id:'oak_log', pos:{x,y,z}, distance:<dp>}`.
    - V4: `find({name:'wood'})` against an empty world returns `{found:false, reason: /no wood/}`.
    - V5: `mine_vein({name:'wood'})` against a 4-log oak tree dig-stubs successfully → `mined 4/4 oak_log`.
    - V6: `mine_vein` AbortController fires mid-sequence → returns `aborted after K/4 oak_log`.
    - V7: `ACTION_DESCRIPTIONS.mine_vein === MINE_VEIN_DESCRIPTION` (byte-identical sanity check) — import both and compare.
    - V8: orchestrator's tool-build surface includes 'find' and 'mine_vein' in its tool list (introspect `buildAnthropicTools` output if exported; otherwise read the source and grep — last-resort fallback).
    - Prints `PASS V1..V8`; final line `[verify-phase6] OK (N assertions)`.
  </behavior>
  <action>
Create `scripts/verify-phase6.mjs` modeled on `scripts/verify-phase5.mjs` and `scripts/verify-phase3.js` for shape and pass/fail logging style.

Reuse the bot-stub patterns from 06-01 (test-nearbyVeins.mjs) and 06-03 (test-mineVein.mjs). Where possible, factor a shared `makeBot(...)` helper into the top of this file rather than re-implementing.

For V7 byte-identity: directly compare strings via `assert.strictEqual(orchestratorAction.mine_vein, MINE_VEIN_DESCRIPTION)` after both imports.

For V8: if `buildAnthropicTools` is not directly importable, fall back to grep-style read of `src/bot/brain/orchestrator.js` and assert the strings `'find'` and `'mine_vein'` both appear in the ACTION_DESCRIPTIONS region. Note: this fallback is a last resort — prefer dynamic import + introspection.

If `mineVeinAction` accepted optional `_deps` (per 06-03 Task 2 recommendation), V5/V6 pass stub goTo/digAction via `_deps`. If it did not, the harness must mock differently (e.g. by constructing a minimal bot stub whose `bot.dig` resolves synchronously and whose pathfinder no-ops; this is more fragile — prefer the `_deps` route).

For each test, print `[verify-phase6] PASS Vk - <one-line desc>`. On any failure, print `[verify-phase6] FAIL Vk: <reason>` and exit 1.

Idempotency: this is a pure-stub harness (no fs writes, no global state mutation) — re-runs yield the same result trivially.
  </action>
  <verify>
    <automated>node scripts/verify-phase6.mjs</automated>
  </verify>
  <done>
    `node scripts/verify-phase6.mjs` exits 0 with PASS V1..V8 and a final OK line. Re-run within the same shell yields the same result.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Manual live-bot verification of veined snapshot + find + mine_vein</name>
  <what-built>
    - snapshot.js now emits `nearby veins:` instead of `nearby blocks:`.
    - `find` and `mine_vein` are registered Zod actions exposed to the Haiku LLM via ACTION_DESCRIPTIONS.
    - verify-phase6.mjs passes 8/8 stubbed assertions.
  </what-built>
  <how-to-verify>
1. Start the bot against the dev Minecraft server (`sei start` or the developer's normal dev loop).
2. Position the bot near a small cluster of trees (e.g. 2-3 oak trees within 16 blocks).
3. Inspect the latest `[snapshot]` event in the readable log (logger from Phase 5):
   - Expect one `nearby veins:` line per tree, e.g. `#1 oak_log x6 @<x>,<y>,<z> d=<dist>`.
   - Expect `terrain at feet:` line still present and unchanged.
   - Expect entity numbering (`#N <mob>`) continuing from after the last vein handle.
4. In-game, address the bot with: "find me some wood". Inspect the `[haiku!]` tool_use sequence:
   - Expect either a `find({name:"wood"})` tool call OR a direct `mine_vein({name:"wood"})` call.
   - Expect the `find` tool_result to be `{found:true, id:"oak_log", pos:{...}, distance:...}` (JSON-stringified by orchestrator).
5. In-game, address the bot with: "chop down a tree". Inspect:
   - Expect a `mine_vein({name:"wood"})` (or `mine_vein` with a `#N` anchor from snapshot) tool call.
   - Expect bot to walk to nearest tree and clear it block-by-block. Inventory should grow by the tree size.
   - Expect terminal tool_result like `mined 6/6 oak_log`.
6. Test abort: address the bot mid-mine_vein with a strong owner-chat preempt (e.g. "stop and come here"). Expect:
   - Tool_result like `aborted after 3/6 oak_log` (partial K/N reflecting how many were dug before the preempt).
   - Bot reorients to the new owner instruction without disconnecting.
7. (Optional) Vein-cap test: dig a small tunnel into a stone wall, issue "mine all this stone". Expect `mined 64/64 stone (vein-cap reached)`.

Cross-cutting checks:
- No Anthropic cache thrashing beyond the expected one-time rewarm (single warm-up call after deploy).
- Haiku visibly references vein counts in its `[think]` (e.g. "I see two oak veins of 6 and 4 logs nearby").
- No regressions: bot still follows, eats, defends.
  </how-to-verify>
  <resume-signal>Type "approved" if all live-bot checks pass; otherwise describe the failure mode (which step, observed vs expected) and the planner will create a gap-closure plan.</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM tool_use args -> Zod schema | Untrusted Haiku-generated inputs validated by registry |
| ACTION_DESCRIPTIONS -> Anthropic cached prefix | Edits bust prefix; controlled cache event |
| Bot -> in-game owner | Mid-mine_vein abort must reach owner promptly via FSM preempt |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-06-10 | S | LLM injects raw coordinates outside snapshot/find provenance | mitigate | Zod schemas validate types; `mine_vein` accepts coords but `MINE_VEIN_DESCRIPTION` steers Haiku to `{name}` or `#N` anchors. |
| T-06-11 | T | Description drift between MINE_VEIN_DESCRIPTION and ACTION_DESCRIPTIONS.mine_vein | mitigate | `mine_vein: MINE_VEIN_DESCRIPTION` import-by-reference makes byte-identity mechanical. Verified in verify-phase6.mjs V7. |
| T-06-12 | D | Movement-tier filter excludes new actions from Haiku tool list | mitigate | Task 2 explicitly inspects buildAnthropicTools call site; fix or escalate if filter present. |
| T-06-13 | I | Snapshot `+K more` line hides real veins from LLM | accept | maxVeins=8 default; tradeoff documented in CONTEXT.md L39 (renderer swappable). |
| T-06-14 | D | Cache-prefix invalidation cascades to multiple commits | mitigate | Both new keys batched in one commit per Pitfall 6; commit message flags cache bust. |
</threat_model>

<verification>
- `node scripts/verify-phase6.mjs` exits 0 (8/8 PASS).
- Manual live-bot checkpoint approved by developer.
- `grep -c "register('find'\\|register('mine_vein'" src/bot/adapter/minecraft/registry.js` returns >= 2.
- `grep -v '^//' src/bot/brain/orchestrator.js | grep -cE "^\\s*(find|mine_vein):"` returns >= 2.
- `grep -c "nearby veins:" src/bot/adapter/minecraft/observers/snapshot.js` >= 1; `grep -c "nearby blocks:" src/bot/adapter/minecraft/observers/snapshot.js` == 0.
</verification>

<success_criteria>
- All three D-NEW-SCAV defects closed (snapshot is veined, NL->ID resolves server-side, find/mine_vein decouple locate-from-gather).
- Automated verification passes 8/8.
- Developer-approved live-bot validation.
- Cache prefix rewarms cleanly after the single deliberate bust.
</success_criteria>

<output>
After completion, create `.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-04-SUMMARY.md` and prepare to mark Phase 6 complete in STATE.md + ROADMAP.md.
</output>
