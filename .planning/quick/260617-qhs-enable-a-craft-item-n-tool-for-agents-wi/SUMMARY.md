---
quick_id: 260617-qhs
slug: enable-a-craft-item-n-tool-for-agents-wi
date: 2026-06-17
status: complete
committed: false
---

# Summary: craft(item, n) tool + per-tick craftable world state

## Outcome
Agents can now craft. A `craft(item, n)` world action was added, and the per-tick
world snapshot now advertises everything craftable right now (with counts), gated
by crafting-table reach. Built entirely on Mineflayer's built-in recipe API — **no
new dependency** (production code depends only on `minecraft-data`, already used
across the adapter).

## Files
- **NEW** `src/bot/adapter/minecraft/observers/craftable.js` — craftable
  enumeration. Detects a `crafting_table` within `CRAFT_TABLE_REACH` (4),
  prunes candidate recipes via a per-version ingredient→results reverse index,
  computes max producible count from `recipe.delta` + inventory. **Cached** at
  module level on `(version | nearTable | inventory-signature)`; recomputes only
  when inventory or table-proximity changes. Fully defensive (never throws into a
  tick).
- **NEW** `src/bot/adapter/minecraft/behaviors/craft.js` — `craftAction`. `n` =
  product count; crafts `ceil(n / batchSize)` reps (overshoot to batch boundary),
  capped by materials, reports actual produced. No auto-walk; 3×3 recipes without
  a table return actionable guidance. `requiresTable` derived from
  `minecraft-data` grid shape (no `prismarine-recipe` dependency).
- `registry.js` — registers `craft` (`{item, count?}`); auto-offered to the LLM
  via `schemaBridge` + `ACTION_DESCRIPTIONS`.
- `observers/snapshot.js` — renders the `craftable:` section after `inventory`.
- `prompts.js` — capability paragraph rewritten (you CAN craft; crafting consumes
  materials and you see only the product, so plan carefully; table needed for
  bigger recipes) + `ACTION_DESCRIPTIONS.craft`.
- **Tests** — `craftable.test.js`, `craft.test.js`, `registry.craft.test.js`
  (18 new). Full bot suite green (197 passed).

## Decisions (from --discuss, see CONTEXT.md)
Cache+recompute-on-change · show ALL craftable · produce ≥ n / report actual ·
no auto-walk (goto a table or craft one) · 2×2 always, 3×3 when table in reach.

## Verification
- `npx vitest run src/bot` → 25 files, **197 tests pass**.
- Real-data trace: 5 oak_log → `oak_planks - 20x`; 8 planks+2 stick near a table →
  full wooden toolset + chest/fence/doors with correct counts.

## Not committed — deliberate
The working tree on `dev` holds extensive unrelated WIP (60+ files), and the
crafting edits to `registry.js`, `snapshot.js`, and `prompts.js` are interleaved
with that pre-existing WIP in the same files. A clean atomic commit could not be
isolated without bundling unrelated in-progress work, so **no commit was made**.
All changes are complete and tested in the working tree; commit alongside the rest
of the WIP, or cherry-pick these files, at your discretion.
