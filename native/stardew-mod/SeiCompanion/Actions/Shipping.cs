using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using SeiCompanion.Body;
using SeiCompanion.Observe;
using SObject = StardewValley.Object;

namespace SeiCompanion.Actions
{
    /// <summary>
    /// ship / give (mod 0.1.3): the two ways the companion's haul reaches the
    /// player. Before these the only hand-off was a chest, so a harvest the
    /// companion picked sat in its own bag, and "give me the wood for the
    /// chest" had no verb.
    /// </summary>
    public static class Shipping
    {
        /// <summary>Inventory kinds (Snapshot.ItemKind) that ship() with no item takes: produce, never tools, seeds or materials.</summary>
        private static readonly HashSet<string> ProduceKinds = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "crop", "fish", "forage" };

        public static bool CanShip(Item item)
        {
            if (item == null || item is Tool) return false;
            try { return item.canBeShipped(); } catch { return false; }
        }

        /// <summary>What ship() with no item sends: crops, forage and fish the bin will buy.</summary>
        public static bool IsProduce(Item item)
        {
            if (!(item is SObject o) || o.bigCraftable.Value) return false;
            return ProduceKinds.Contains(Snapshot.ItemKind(item)) && CanShip(item);
        }

        /// <summary>The farm's shipping bin building, or null (a farm with no bin).</summary>
        public static Building FindBin(Farm farm)
        {
            if (farm?.buildings == null) return null;
            foreach (Building b in farm.buildings)
            {
                if (b is ShippingBin) return b;
            }
            return null;
        }

        /// <summary>
        /// Take `moving` of `item` out of the shadow's bag: the item itself when
        /// the whole stack goes (tools and other one-offs cannot be split),
        /// else a copy of `moving` with the rest left in the slot.
        /// </summary>
        private static Item Split(SeiBody body, Item item, int moving)
        {
            if (moving >= item.Stack)
            {
                int slot = body.SlotOf(item);
                if (slot >= 0) body.Shadow.Items[slot] = null;
                return item;
            }
            Item portion = item.getOne();
            portion.Stack = moving;
            item.Stack -= moving;
            return portion;
        }

        /*********
        ** ship
        *********/
        public static IEnumerable<object> Ship(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            string query = ctx.Str("item");
            int? count = ctx.Int("count");
            var picks = new List<Item>();
            if (!string.IsNullOrWhiteSpace(query))
            {
                Item named = body.FindItem(query);
                if (named == null) { yield return Result.Fail($"no {query} in the inventory"); yield break; }
                if (!CanShip(named)) { yield return Result.Fail($"{named.DisplayName} cannot be sold in the shipping bin"); yield break; }
                picks.Add(named);
            }
            else
            {
                picks.AddRange(body.Shadow.Items.Where(IsProduce));
                if (picks.Count == 0) { yield return Result.Fail("nothing to ship: no crops, forage or fish in the bag (name an item to ship something else)"); yield break; }
            }

            Farm farm = Game1.getFarm();
            Building bin = FindBin(farm);
            if (bin == null) { yield return Result.Fail("this farm has no shipping bin"); yield break; }
            var binTile = new Point(bin.tileX.Value, bin.tileY.Value);
            var travel = new Outcome();
            yield return Movement.Travel(ctx, farm.NameOrUniqueName, binTile, travel);
            if (!travel.Ok) { yield return Result.Fail($"could not reach the shipping bin: {travel.Detail}"); yield break; }

            var binItems = farm.getShippingBin(Game1.player);
            if (binItems == null) { yield return Result.Fail("could not open the shipping bin"); yield break; }
            var shipped = new List<string>();
            int value = 0;
            foreach (Item item in picks)
            {
                if (ctx.Cancelled) yield break;
                if (item == null || item.Stack <= 0 || body.SlotOf(item) < 0) continue;
                int moving = count.HasValue && !string.IsNullOrWhiteSpace(query) ? Math.Clamp(count.Value, 1, item.Stack) : item.Stack;
                int each = 0;
                try { if (item is SObject so) each = so.sellToStorePrice(); } catch { each = 0; }
                Item portion = Split(body, item, moving);
                binItems.Add(portion);
                value += Math.Max(0, each) * moving;
                shipped.Add($"{moving} {portion.DisplayName}");
            }
            if (shipped.Count == 0) { yield return Result.Fail("nothing was shipped"); yield break; }
            try { farm.playSound("Ship"); } catch { }
            string list = string.Join(", ", shipped.Take(6)) + (shipped.Count > 6 ? $" and {shipped.Count - 6} more" : "");
            string worth = value > 0 ? $", worth about {value}g" : "";
            yield return Result.Success($"put {list} in the shipping bin{worth}; the gold goes to the farm's wallet overnight");
        }

        /*********
        ** give
        *********/
        public static IEnumerable<object> Give(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            string query = ctx.Str("item");
            if (string.IsNullOrWhiteSpace(query)) { yield return Result.Fail("give needs an item name"); yield break; }
            Item item = body.FindItem(query);
            if (item == null) { yield return Result.Fail($"no {query} in the inventory"); yield break; }
            Farmer who = body.ResolvePlayer(ctx.Str("player"));
            if (who?.currentLocation == null) { yield return Result.Fail("cannot see the player"); yield break; }
            // addItemToInventoryBool is only safe on the local farmer: a
            // farmhand's inventory lives on their own machine.
            if (!ReferenceEquals(who, Game1.player)) { yield return Result.Fail($"can only hand things to the host for now; put it in a chest for {who.Name}"); yield break; }

            var o = new Outcome();
            if (who.currentLocation != body.Npc.currentLocation)
            {
                yield return Movement.Travel(ctx, who.currentLocation.NameOrUniqueName, null, o);
                if (!o.Ok) { yield return Result.Fail($"could not reach {who.Name}: {o.Detail}"); yield break; }
            }
            o = new Outcome();
            yield return Movement.WalkTo(ctx, who.TilePoint, true, o);
            if (!o.Ok || who.currentLocation != body.Npc.currentLocation || Targets.Chebyshev(body.Npc.TilePoint, who.TilePoint) > 3)
            {
                yield return Result.Fail($"could not get next to {who.Name}{(o.Ok ? "; they moved away" : $": {o.Detail}")}");
                yield break;
            }

            // The item may have moved slots or been eaten during the walk.
            if (body.SlotOf(item) < 0 || item.Stack <= 0) { yield return Result.Fail($"no {query} in the inventory anymore"); yield break; }
            int moving = Math.Clamp(ctx.Int("count") ?? item.Stack, 1, item.Stack);
            string name = item.DisplayName;
            Item probe = item.getOne();
            probe.Stack = moving;
            if (!who.couldInventoryAcceptThisItem(probe)) { yield return Result.Fail($"{who.Name}'s bag is full"); yield break; }
            Item portion = Split(body, item, moving);
            int before = portion.Stack;
            bool ok;
            try { ok = who.addItemToInventoryBool(portion); }
            catch (Exception ex)
            {
                body.TakeItem(portion);
                yield return Result.Fail($"handing it over failed: {ex.Message}");
                yield break;
            }
            int given = ok ? before : Math.Max(0, before - portion.Stack);
            // Whatever did not fit comes back to the companion's bag.
            if (!ok && portion.Stack > 0) body.TakeItem(portion);
            if (given <= 0) { yield return Result.Fail($"{who.Name}'s bag is full"); yield break; }
            try { who.currentLocation.playSound("pickUpItem"); } catch { }
            yield return Result.Success($"handed {given} {name} to {who.Name}");
        }
    }
}
