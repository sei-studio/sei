---
quick_id: 260617-qhs
slug: enable-a-craft-item-n-tool-for-agents-wi
date: 2026-06-17
status: complete
---

# Plan: craft(item, n) tool + per-tick craftable world state

Enable an agent crafting tool using Mineflayer's built-in recipe API, and surface
the currently-craftable item list (with counts) in the per-tick snapshot.

## Tasks

1. **`observers/craftable.js` (new)** — craftable enumeration + cache.
   - `detectCraftingTable(bot)` → nearest `crafting_table` `Block` within reach
     (`CRAFT_TABLE_REACH`, default 4), else null.
   - Memoized reverse index (per `bot.version`): ingredient-id → Set(result-ids),
     built from `minecraft-data` recipes (flatten `inShape`/`ingredients`).
   - `getCraftableEntries(bot)` → `{ entries: [{name, count}], nearTable }`.
     Candidate result-ids = union of reverse-index hits for held item ids; for
     each, `bot.recipesFor(id, null, 1, tableBlock)`; compute max produced from
     `recipe.delta` + inventory. **Cached** on `(version | invSig | nearTable)`.
   - Fully defensive: any missing method / throw ⇒ return empty entries (snapshot
     omits the section), never throws into the tick.

2. **`behaviors/craft.js` (new)** — `craftAction(args, bot, config)`.
   - Resolve `item` → id (exact name). `count` default 1.
   - `tableBlock = detectCraftingTable(bot)`.
   - `recipes = bot.recipesFor(id, null, 1, tableBlock)`. If empty, branch on
     `Recipe.find(id)`:
       - no recipe ⇒ `can't craft <item>`;
       - recipe exists, all `requiresTable` & no table ⇒ `needs a crafting table —
         find/goto a crafting_table, or craft one from planks`;
       - else ⇒ `not enough materials to craft <item>`.
   - `reps = min(ceil(count / result.count), maxRepsFromInventory)`; produced =
     `reps * result.count`. `bot.craft(recipe, reps, tableBlock)` in a
     timeout+abort race. Return `crafted <produced> <item>`.

3. **`registry.js`** — import `craftAction`; register `'craft'` with
   `z.object({ item: z.string().min(1), count: z.number().int().min(1).max(64).default(1) })`.

4. **`prompts.js`** — update `CAPABILITY_PARAGRAPH` (you CAN craft now; crafting
   consumes materials and you only see the product, so plan carefully; needs a
   table for bigger recipes). Add `ACTION_DESCRIPTIONS.craft`.

5. **`snapshot.js`** — after the `inventory (…)` line, render the craftable
   section from `getCraftableEntries(bot)`: one `<item> craftable - Nx` line each,
   header noting whether a table is in reach. Omit entirely when no entries.

6. **Tests** — `craftable.test.js` (enumeration + count + table gating + cache),
   `craft.test.js` (success, overshoot report, no-table guidance, not-enough,
   unknown item, abort), and a registry assertion that `craft` is registered.

## Verification
- `npx vitest run` for the new + touched suites green.
- Manual reasoning trace for the count/overshoot + table-gating math.
