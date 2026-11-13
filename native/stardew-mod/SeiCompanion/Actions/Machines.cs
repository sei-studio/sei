using System;
using System.Collections.Generic;
using System.Linq;
using StardewValley;
using StardewValley.Inventories;
using StardewValley.Tools;
using SeiCompanion.Body;
using SObject = StardewValley.Object;

namespace SeiCompanion.Actions
{
    /// <summary>
    /// load (mod 0.1.4): put an input into a processing machine (furnace, keg,
    /// preserves jar, seed maker, mayonnaise machine, ...). Before this the
    /// companion could only EMPTY machines: interact told the model to
    /// place() an input, and place only knows placementAction, so every
    /// furnace or keg was a dead end.
    ///
    /// The game decides what a machine takes. Acceptance is asked with the
    /// machine's own probe (performObjectDropInAction with probe = true, the
    /// call the game makes every frame for the hover cursor; the same check
    /// StardewAutoPilot's Machines.AcceptedSlot uses, Apache-2.0), and the
    /// load itself goes through Object.AttemptAutoLoad, the 1.6 entry point
    /// Automate uses (MIT) that also consumes the machine's extra fuel (coal
    /// for a furnace) from the same inventory. The inventory handed to it holds
    /// only the chosen stack plus the fuel stacks, so the machine cannot pick a
    /// different item from her bag.
    /// </summary>
    public static class Machines
    {
        public static IEnumerable<object> Load(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            Target t = Targets.Resolve(ctx, out string err);
            if (t == null || !t.HasTile) { yield return Result.Fail(err ?? "load needs the machine's #N handle or x and y"); yield break; }
            if (!string.IsNullOrEmpty(t.LocationName) && loc != null && t.LocationName != loc.NameOrUniqueName)
            {
                yield return Result.Fail($"that machine is in {t.LocationName}; goTo there first");
                yield break;
            }
            if (!loc.objects.TryGetValue(t.TileVec, out SObject machine) || machine == null || !machine.bigCraftable.Value || machine.GetMachineData() == null)
            {
                yield return Result.Fail($"no machine at {Targets.Fmt(t.Tile)}");
                yield break;
            }
            string mname = machine.DisplayName;
            if (machine.readyForHarvest.Value)
            {
                yield return Result.Fail($"the {mname} is finished; harvest it first to take its output");
                yield break;
            }
            if (machine.heldObject.Value != null)
            {
                yield return Result.Fail($"the {mname} is busy: {machine.MinutesUntilReady} minutes left");
                yield break;
            }

            string query = ctx.Str("item");
            body.SyncShadow();
            Item chosen;
            if (!string.IsNullOrWhiteSpace(query))
            {
                chosen = body.FindItem(query);
                if (chosen == null) { yield return Result.Fail($"no {query} in your bag"); yield break; }
                if (!Accepts(machine, chosen, body))
                {
                    yield return Result.Fail(WhyNot(machine, chosen, body));
                    yield break;
                }
            }
            else
            {
                chosen = body.Shadow.Items.FirstOrDefault(i => i != null && !(i is Tool) && Accepts(machine, i, body));
                if (chosen == null)
                {
                    string fuel = MissingFuel(machine, body);
                    yield return Result.Fail(fuel != null ? $"the {mname} needs {fuel} as fuel too" : $"nothing in your bag goes into the {mname}");
                    yield break;
                }
            }

            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, t.Tile, true, walk);
            if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
            body.SyncShadow();
            // The walk took time: the machine may have been filled by the
            // player, or the stack moved.
            if (machine.heldObject.Value != null || machine.readyForHarvest.Value)
            {
                yield return Result.Fail($"the {mname} was filled while you walked over");
                yield break;
            }
            if (body.SlotOf(chosen) < 0 || chosen.Stack <= 0 || !Accepts(machine, chosen, body))
            {
                yield return Result.Fail($"you no longer have what the {mname} takes");
                yield break;
            }

            string itemName = chosen.DisplayName;
            string itemId = chosen.QualifiedItemId;
            int before = CountId(body, itemId);
            var fuelBefore = FuelIds(machine).ToDictionary(id => id, id => CountId(body, id));

            var feed = new Inventory();
            feed.Add(chosen);
            foreach (string id in fuelBefore.Keys)
                foreach (Item it in body.Shadow.Items)
                    if (it != null && !ReferenceEquals(it, chosen) && it.QualifiedItemId == id)
                        feed.Add(it);

            bool loaded;
            string error = null;
            try { loaded = machine.AttemptAutoLoad(feed, body.Shadow); }
            catch (Exception ex) { loaded = false; error = ex.Message; }
            ClearEmptySlots(body);
            if (error != null) { yield return Result.Fail($"loading the {mname} failed: {error}"); yield break; }
            if (!loaded || machine.heldObject.Value == null)
            {
                yield return Result.Fail($"the {mname} did not take the {itemName}");
                yield break;
            }

            int used = Math.Max(1, before - CountId(body, itemId));
            var fuelUsed = new List<string>();
            foreach (var pair in fuelBefore)
            {
                int n = pair.Value - CountId(body, pair.Key);
                if (n > 0) fuelUsed.Add($"{n} {ItemName(pair.Key)}");
            }
            string fuelNote = fuelUsed.Count > 0 ? $" (and {string.Join(", ", fuelUsed)})" : "";
            try { body.Npc.currentLocation?.playSound("Ship", machine.TileLocation); } catch { }
            string output = machine.heldObject.Value?.DisplayName;
            string makes = string.IsNullOrEmpty(output) ? "" : $", making {output}";
            yield return Result.Success($"put {used} {itemName}{fuelNote} into the {mname} at {Targets.Fmt(t.Tile)}{makes}; ready in {machine.MinutesUntilReady} minutes");
        }

        /// <summary>Does the machine take this stack right now? The machine's own probe: no side effects.</summary>
        public static bool Accepts(SObject machine, Item item, SeiBody body)
        {
            if (item == null || item is Tool || item.Stack <= 0) return false;
            try { return machine.performObjectDropInAction(item, true, body.Shadow); }
            catch { return false; }
        }

        private static string WhyNot(SObject machine, Item item, SeiBody body)
        {
            string fuel = MissingFuel(machine, body);
            if (fuel != null) return $"the {machine.DisplayName} needs {fuel} as fuel too";
            return $"the {machine.DisplayName} does not take {item.DisplayName} (some machines need several at once, like 5 ore for one bar)";
        }

        /// <summary>"1 Coal" when the machine burns something extra per load that her bag lacks, else null.</summary>
        private static string MissingFuel(SObject machine, SeiBody body)
        {
            try
            {
                var extras = machine.GetMachineData()?.AdditionalConsumedItems;
                if (extras == null) return null;
                foreach (var extra in extras)
                {
                    string id = ItemRegistry.QualifyItemId(extra.ItemId);
                    if (id == null) continue;
                    if (CountId(body, id) < extra.RequiredCount) return $"{extra.RequiredCount} {ItemName(id)}";
                }
            }
            catch { }
            return null;
        }

        private static IEnumerable<string> FuelIds(SObject machine)
        {
            var extras = machine.GetMachineData()?.AdditionalConsumedItems;
            if (extras == null) yield break;
            foreach (var extra in extras)
            {
                string id = ItemRegistry.QualifyItemId(extra.ItemId);
                if (id != null) yield return id;
            }
        }

        private static string ItemName(string qualifiedId)
        {
            try { return ItemRegistry.GetDataOrErrorItem(qualifiedId).DisplayName; }
            catch { return qualifiedId; }
        }

        private static int CountId(SeiBody body, string qualifiedId)
        {
            int n = 0;
            foreach (Item it in body.Shadow.Items)
                if (it != null && it.QualifiedItemId == qualifiedId) n += it.Stack;
            return n;
        }

        /// <summary>The machine consumes by lowering stacks; an emptied stack must leave her bag.</summary>
        private static void ClearEmptySlots(SeiBody body)
        {
            var items = body.Shadow.Items;
            for (int i = 0; i < items.Count; i++)
                if (items[i] != null && items[i].Stack <= 0) items[i] = null;
        }
    }
}
