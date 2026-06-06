---
phase: 06
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/bot/adapter/minecraft/loose-terms.js
  - scripts/test-resolveTerm.mjs
autonomous: true
requirements:
  - D-NEW-SCAV-2
tags:
  - minecraft
  - nl-resolution
  - scavenging

must_haves:
  truths:
    - "resolveTerm('wood') returns the full list of vanilla log IDs"
    - "resolveTerm('ore') returns ore + deepslate_*_ore variants"
    - "resolveTerm('oak_log') falls through to ['oak_log'] (exact-ID passthrough)"
    - "Unknown terms fall through to [term] — caller treats as exact ID"
    - "Module has zero dependencies on mineflayer (pure data + pure function); Phase 7 can import resolveTerm directly"
  artifacts:
    - path: src/bot/adapter/minecraft/loose-terms.js
      provides: "resolveTerm(name) NL→ID-list resolver + LOOSE_TERMS keylist"
      exports: ["resolveTerm", "LOOSE_TERMS"]
    - path: scripts/test-resolveTerm.mjs
      provides: "Coverage test for known terms + fallthrough"
  key_links:
    - from: src/bot/adapter/minecraft/loose-terms.js
      to: "consumers (registry.js find action, behaviors/mineVein.js, Phase 7)"
      via: "named import { resolveTerm }"
      pattern: "import \\{ resolveTerm \\} from"
---

<objective>
Build the hand-curated natural-language → MC block ID resolver as a standalone module with zero mineflayer dependency. This is reusable infrastructure: `find()` (06-04), `mine_vein()` (06-03), and future Phase 7 pillar-up all consume `resolveTerm` directly.

Purpose: D-NEW-SCAV-2 — Haiku's training data is fuzzy about MC IDs across versions. Server-side resolution (one call returning the correct version-specific IDs) beats N find() calls under the 20-iteration cap and eliminates ID hallucination.

Output: New `loose-terms.js` module + unit test. No callers wired yet.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-CONTEXT.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-RESEARCH.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-PATTERNS.md
@src/bot/adapter/minecraft/observers/blocks.js

<interfaces>
<!-- Pattern reuse from blocks.js constants section (L6-35) -->

From blocks.js (analog pattern — DO NOT import, mirror the shape):
```js
const WOODS = ['oak','birch','spruce','jungle','acacia','dark_oak','mangrove','cherry']
const ORES = ['coal_ore','iron_ore','gold_ore','diamond_ore','copper_ore','redstone_ore','lapis_ore','emerald_ore']
```

This module's contract (consumed by 06-03 and 06-04):
- `resolveTerm(name: string): string[]`
- `LOOSE_TERMS: string[]` — for diagnostics / capability primer construction
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement loose-terms table + resolveTerm</name>
  <files>src/bot/adapter/minecraft/loose-terms.js</files>
  <behavior>
    - `resolveTerm('wood')` → 8 IDs: `['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log']` (order need not match, content set equality is sufficient).
    - `resolveTerm('log')` → same list as 'wood' (alias).
    - `resolveTerm('planks')` → 8 *_planks IDs.
    - `resolveTerm('leaves')` → 8 *_leaves IDs.
    - `resolveTerm('ore')` → 16 IDs (8 surface + 8 deepslate_*).
    - `resolveTerm('stone')` → includes 'stone','cobblestone','andesite','diorite','granite','deepslate','tuff'.
    - `resolveTerm('dirt')` → includes 'dirt','coarse_dirt','grass_block','podzol','rooted_dirt','mycelium'.
    - `resolveTerm('sand')` → ['sand','red_sand'].
    - `resolveTerm('oak_log')` → ['oak_log'] (exact-ID passthrough — unknown key).
    - `resolveTerm('NONESUCH_BLOCK')` → ['nonesuch_block'] (lowercased fallthrough).
    - `resolveTerm('WOOD')` → same as `resolveTerm('wood')` (case-insensitive).
    - `LOOSE_TERMS` contains all known keys (used by primer wording in 06-04).
  </behavior>
  <action>
Create `src/bot/adapter/minecraft/loose-terms.js`. Pure data + pure function — no mineflayer, no minecraft-data, no Node-only APIs. ESM module, named exports only.

Structure (per RESEARCH.md L201-232 and PATTERNS.md):

```js
// loose-terms.js — hand-curated NL→ID table for the closed Zod action registry.
// Consumed by: find() action (registry.js), mine_vein() action (behaviors/mineVein.js),
// and Phase 7 pillar-up (NL→ID for "what to place").
//
// Design (per 06-CONTEXT.md): server-side resolution beats N find() calls under
// the 20-iteration cap and eliminates Haiku's fuzzy MC-version knowledge.

const WOODS = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']
const ORE_BASES = ['coal', 'iron', 'gold', 'diamond', 'copper', 'redstone', 'lapis', 'emerald']

const TABLE = {
  wood:   WOODS.map(w => `${w}_log`),
  log:    WOODS.map(w => `${w}_log`),
  planks: WOODS.map(w => `${w}_planks`),
  leaves: WOODS.map(w => `${w}_leaves`),
  ore: [
    ...ORE_BASES.map(o => `${o}_ore`),
    ...ORE_BASES.map(o => `deepslate_${o}_ore`),
  ],
  stone: ['stone','cobblestone','andesite','diorite','granite','deepslate','tuff'],
  dirt:  ['dirt','coarse_dirt','grass_block','podzol','rooted_dirt','mycelium'],
  sand:  ['sand','red_sand'],
}

export function resolveTerm(name) {
  const lower = String(name ?? '').toLowerCase().trim()
  if (!lower) return []
  if (TABLE[lower]) return [...TABLE[lower]]
  return [lower]
}

export const LOOSE_TERMS = Object.keys(TABLE)
```

JSDoc per blocks.js convention (full `@param`/`@returns`). Add a top-of-file block comment documenting:
- Why server-side resolution (per CONTEXT.md L50 rationale).
- Phase 7 reuse note (per CONTEXT.md L61).
- Pitfall 4 (RESEARCH.md L461-463): loose-term keys ALWAYS expand; pass exact ID for strict literal.
  </action>
  <verify>
    <automated>node -e "import('./src/bot/adapter/minecraft/loose-terms.js').then(m => { if (typeof m.resolveTerm !== 'function' || !Array.isArray(m.LOOSE_TERMS)) process.exit(1); console.log('ok'); })"</automated>
  </verify>
  <done>
    File exists; `resolveTerm` and `LOOSE_TERMS` are named exports; module loads with zero mineflayer/minecraft-data imports (verify: `grep -E "from 'mineflayer'|from 'minecraft-data'|from 'vec3'" src/bot/adapter/minecraft/loose-terms.js` returns no matches).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Unit test resolveTerm coverage</name>
  <files>scripts/test-resolveTerm.mjs</files>
  <behavior>
    - All 11 behaviors listed above pass.
    - Test uses `assert.deepStrictEqual` (set equality where order is irrelevant — sort both sides).
  </behavior>
  <action>
Create `scripts/test-resolveTerm.mjs` following the project convention (see `scripts/test-postProcessSay.mjs`). Import `{ resolveTerm, LOOSE_TERMS }` from `../src/bot/adapter/minecraft/loose-terms.js`.

Cover:
1. `resolveTerm('wood')` has 8 entries, includes 'oak_log' and 'cherry_log'.
2. `resolveTerm('log')` === `resolveTerm('wood')` (sorted compare).
3. `resolveTerm('ore')` has 16 entries, includes 'coal_ore' and 'deepslate_diamond_ore'.
4. `resolveTerm('stone')` includes 'cobblestone' and 'deepslate'.
5. `resolveTerm('oak_log')` returns `['oak_log']`.
6. `resolveTerm('NONESUCH_BLOCK')` returns `['nonesuch_block']` (lowercased fallthrough).
7. `resolveTerm('WOOD')` set-equals `resolveTerm('wood')`.
8. `resolveTerm('')` returns `[]`.
9. `LOOSE_TERMS` includes 'wood','ore','stone','dirt','sand','planks','leaves','log'.

Print PASS lines per test; exit 1 on any failure.
  </action>
  <verify>
    <automated>node scripts/test-resolveTerm.mjs</automated>
  </verify>
  <done>
    `node scripts/test-resolveTerm.mjs` exits 0 with all PASS lines.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM → resolveTerm input | Haiku-supplied `name` string is untrusted text |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-06-04 | T | resolveTerm input poisoning (very long string, non-string types) | mitigate | `String(name ?? '').toLowerCase().trim()` coerces; returns `[]` on empty. Output is consumed only as MC block ID strings — no eval, no path resolution. |
| T-06-05 | I | Loose-term collision (user wants literal 'stone' but gets granite back) | accept | Documented per Pitfall 4; users get exact match by passing the exact MC ID. |
</threat_model>

<verification>
- `node scripts/test-resolveTerm.mjs` exits 0.
- `grep -E "from 'mineflayer'|from 'minecraft-data'|from 'vec3'|require\\(" src/bot/adapter/minecraft/loose-terms.js | grep -v '^//\\|^ \\*' | wc -l` returns 0 (pure-data invariant for Phase 7 reuse).
</verification>

<success_criteria>
- resolveTerm + LOOSE_TERMS exported.
- Zero mineflayer/minecraft-data dependency (Phase 7 reuse constraint).
- All 9 unit tests pass.
</success_criteria>

<output>
After completion, create `.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-02-SUMMARY.md`.
</output>
