---
quick_id: 260617-qhs
slug: enable-a-craft-item-n-tool-for-agents-wi
date: 2026-06-17
mode: discuss
---

# Context: craft(item, n) tool + per-tick craftable world state

## Goal
Give the agent a `craft(item, n)` world action and surface, in the per-tick world
snapshot, the list of items it can currently craft (with counts), gated by whether
a crafting table is in reach.

## Research findings (web + codebase)
- **No new dependency needed.** Mineflayer ships crafting:
  - `bot.recipesFor(itemId, metadata, minResultCount, tableBlock)` — recipes
    craftable *given current inventory*. `tableBlock=null` ⇒ 2×2 inventory grid
    only; a table `Block` ⇒ unlocks 3×3 recipes.
  - `bot.craft(recipe, count, tableBlock)` — performs it (count = recipe reps).
  - `prismarine-recipe` `Recipe.find(itemId, meta)` returns ALL variants with a
    `requiresTable` flag (inventory-independent) — used for failure guidance.
  - `Recipe` fields: `result {id, count}`, `delta [{id, count}]` (count<0 =
    consumed, >0 = produced), `requiresTable`. `delta` + inventory ⇒ max craftable.
- `mineflayer-crafting-util` does *recursive* auto-crafting (auto-gather
  sub-ingredients) — out of scope; `craft(item,n)` "just crafts n".
- **Grid terminology:** user's "4×4 / 9×9" = Minecraft's **2×2 (4 slots, no table)**
  and **3×3 (9 slots, with table)**.
- **Integration seams** (all clean):
  - Register in `registry.js`; tool is auto-offered via `schemaBridge.buildAnthropicTools`
    + `ACTION_DESCRIPTIONS[name]`.
  - Behavior file `behaviors/craft.js`, mirroring `container.js`/`equip.js`
    timeout+abort race; reads `bot.inventory.items()`, `bot.findBlock`.
  - Per-tick state in `observers/snapshot.js` (insert after the `inventory (…)` line).
  - Capabilities/description text in `adapter/minecraft/prompts.js`.

## Decisions (locked via --discuss)
1. **Compute strategy:** cache the craftable list; recompute only when the
   inventory signature OR crafting-table-in-range boolean changes. Module-level
   cache is safe (one bot per utilityProcess). **Show ALL** craftable items.
2. **`craft(item, n)` count semantics:** `n` = number of the **product item**
   desired. Craft `ceil(n / batchSize)` repetitions (may overshoot to the batch
   boundary, e.g. ask 2 planks → make 4), capped by available materials. Report
   the **actual** produced ("crafted 4 oak_planks").
3. **No auto-walk.** If a recipe needs a 3×3 table and none is in reach, `craft()`
   fails with actionable guidance ("needs a crafting table — find/goto one, or
   craft a crafting_table from planks"). The LLM orchestrates movement with the
   existing `find`/`goTo` tools.
4. **World-state gating:** show 2×2-craftable items when no table in reach; ALSO
   show 3×3-craftable items when within table reach. Each line: `<item> craftable - Nx`.
5. **Capabilities note (explicit per request):** crafting CONSUMES materials and
   the agent only sees the PRODUCT, not the ingredients — so it must plan crafts
   carefully. Written into the capability paragraph + tool description.

## Out of scope
- Recursive/auto-gathering crafts, smelting/furnace, brewing, enchanting.
- Auto-pathfinding to a table inside `craft()`.
