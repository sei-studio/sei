using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Objects;
using SeiCompanion.Body;
using SObject = StardewValley.Object;

namespace SeiCompanion.Actions
{
    /// <summary>eat / equip / place / chest.</summary>
    public static class Items
    {
        public static bool IsEdible(Item item) => item is SObject o && o.Edibility > 0;

        public static IEnumerable<object> Eat(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            string query = ctx.Str("item");
            SObject food = query != null ? body.FindItem(query) as SObject : null;
            if (query != null && (food == null || !IsEdible(food)))
            {
                yield return Result.Fail(food == null ? $"no {query} in the inventory" : $"{food.DisplayName} is not edible");
                yield break;
            }
            food = food ?? body.Shadow.Items.OfType<SObject>().Where(IsEdible).OrderByDescending(o => o.Edibility).FirstOrDefault();
            if (food == null) { yield return Result.Fail("nothing edible in the inventory; forage some berries or buy food at the Saloon"); yield break; }
            string detail = EatNow(body, food);
            yield return WaitTicks.Ms(600);
            yield return Result.Success(detail);
        }

        /// <summary>Consume one of `food` right now (no animation; Farmer.eatObject drives a FarmerSprite the shadow does not render).</summary>
        public static string EatNow(SeiBody body, SObject food)
        {
            int stamina = food.staminaRecoveredOnConsumption();
            int health = food.healthRecoveredOnConsumption();
            float beforeS = body.Shadow.Stamina;
            int beforeH = body.Shadow.health;
            body.Shadow.Stamina = Math.Min(body.Shadow.MaxStamina, body.Shadow.Stamina + stamina);
            body.Shadow.health = Math.Min(body.Shadow.maxHealth, body.Shadow.health + health);
            body.Shadow.exhausted.Value = false;
            string name = food.DisplayName;
            food.Stack--;
            if (food.Stack <= 0)
            {
                int slot = body.SlotOf(food);
                if (slot >= 0) body.Shadow.Items[slot] = null;
            }
            try { body.Npc.currentLocation?.playSound("eat", body.Npc.Tile); } catch { }
            try { body.Npc.doEmote(20); } catch { }
            return $"ate {name} (+{(int)(body.Shadow.Stamina - beforeS)} energy, +{body.Shadow.health - beforeH} health)";
        }

        public static IEnumerable<object> Equip(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            string query = ctx.Str("item");
            if (string.IsNullOrEmpty(query)) { yield return Result.Fail("equip needs an item name"); yield break; }
            Item item = body.FindItem(query);
            if (item == null) { yield return Result.Fail($"no {query} in the inventory"); yield break; }
            int slot = body.SlotOf(item);
            if (slot < 0) { yield return Result.Fail("could not find that slot"); yield break; }
            body.Shadow.CurrentToolIndex = slot;
            yield return Result.Success($"holding {item.DisplayName}");
        }

        public static IEnumerable<object> Place(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            string query = ctx.Str("item");
            if (string.IsNullOrEmpty(query)) { yield return Result.Fail("place needs an item name and x, y"); yield break; }
            Target t = Targets.Resolve(ctx, out string err);
            if (t == null || !t.HasTile) { yield return Result.Fail(err ?? "place needs x and y"); yield break; }
            Item item = body.FindItem(query);
            if (item == null) { yield return Result.Fail($"no {query} in the inventory"); yield break; }
            if (!(item is SObject obj) || !obj.isPlaceable()) { yield return Result.Fail($"{item.DisplayName} cannot be placed"); yield break; }
            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, t.Tile, true, walk);
            if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
            body.SyncShadow();
            int px = t.Tile.X * 64 + 32, py = t.Tile.Y * 64 + 32;
            if (!Utility.playerCanPlaceItemHere(loc, obj, px, py, body.Shadow))
            {
                yield return Result.Fail($"cannot place {obj.DisplayName} at {Targets.Fmt(t.Tile)}; the tile is taken or not allowed");
                yield break;
            }
            SObject one = (SObject)obj.getOne();
            bool placed;
            string placeError = null;
            try { placed = one.placementAction(loc, px, py, body.Shadow); }
            catch (Exception ex) { placed = false; placeError = ex.Message; }
            if (placeError != null) { yield return Result.Fail($"placing failed: {placeError}"); yield break; }
            if (!placed) { yield return Result.Fail($"could not place {obj.DisplayName} at {Targets.Fmt(t.Tile)}"); yield break; }
            obj.Stack--;
            if (obj.Stack <= 0)
            {
                int slot = body.SlotOf(obj);
                if (slot >= 0) body.Shadow.Items[slot] = null;
            }
            yield return Result.Success($"placed {one.DisplayName} at {Targets.Fmt(t.Tile)}");
        }

        /*********
        ** chest
        *********/
        public static Chest FindChest(SeiBody body, Target t)
        {
            GameLocation loc = body.Npc.currentLocation;
            if (t != null && t.HasTile && loc.objects.TryGetValue(t.TileVec, out SObject at) && at is Chest c)
                return c;
            Chest best = null;
            float bestDist = 4f;
            foreach (KeyValuePair<Vector2, SObject> pair in loc.objects.Pairs)
            {
                if (pair.Value is Chest chest)
                {
                    float d = Vector2.Distance(pair.Key, body.Npc.Tile);
                    if (d < bestDist) { bestDist = d; best = chest; }
                }
            }
            return best;
        }

        public static IEnumerable<object> ChestOp(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            string action = (ctx.Str("action") ?? "put").ToLowerInvariant();
            if (action != "put" && action != "take") { yield return Result.Fail("chest action must be put or take"); yield break; }
            Target t = Targets.Resolve(ctx, out _);
            Chest chest = FindChest(body, t);
            if (chest == null) { yield return Result.Fail("no chest within reach; give its x and y or stand next to one"); yield break; }
            Point chestTile = chest.TileLocation.ToPoint();
            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, chestTile, true, walk);
            if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
            string query = ctx.Str("item");
            int count = Math.Max(1, ctx.Int("count") ?? 999);
            if (action == "put")
            {
                Item item = query != null ? body.FindItem(query) : null;
                if (item == null) { yield return Result.Fail(query != null ? $"no {query} in the inventory" : "say which item to put"); yield break; }
                int moving = Math.Min(count, item.Stack);
                Item portion = item.getOne();
                portion.Stack = moving;
                Item left = chest.addItem(portion);
                int stored = moving - (left?.Stack ?? 0);
                if (stored <= 0) { yield return Result.Fail("the chest is full"); yield break; }
                item.Stack -= stored;
                if (item.Stack <= 0)
                {
                    int slot = body.SlotOf(item);
                    if (slot >= 0) body.Shadow.Items[slot] = null;
                }
                try { body.Npc.currentLocation.playSound("Ship", chest.TileLocation); } catch { }
                yield return Result.Success($"put {stored} {portion.DisplayName} in the chest at {Targets.Fmt(chestTile)}");
                yield break;
            }
            // take
            Item found = null;
            string q = (query ?? "").ToLowerInvariant();
            foreach (Item it in chest.Items)
            {
                if (it == null) continue;
                if (q.Length == 0 || (it.DisplayName ?? "").ToLowerInvariant().Contains(q) || (it.Name ?? "").ToLowerInvariant().Contains(q))
                {
                    found = it;
                    break;
                }
            }
            if (found == null)
            {
                string listing = string.Join(", ", chest.Items.Where(i => i != null).Take(8).Select(i => $"{i.DisplayName} x{i.Stack}"));
                yield return Result.Fail(query != null ? $"no {query} in that chest; it holds: {(listing.Length > 0 ? listing : "nothing")}" : "say which item to take");
                yield break;
            }
            int take = Math.Min(count, found.Stack);
            Item taken = found.getOne();
            taken.Stack = take;
            if (!body.Shadow.couldInventoryAcceptThisItem(taken)) { yield return Result.Fail("inventory is full"); yield break; }
            found.Stack -= take;
            if (found.Stack <= 0) chest.Items.Remove(found);
            body.TakeItem(taken);
            yield return Result.Success($"took {take} {taken.DisplayName} from the chest at {Targets.Fmt(chestTile)}");
        }
    }
}
