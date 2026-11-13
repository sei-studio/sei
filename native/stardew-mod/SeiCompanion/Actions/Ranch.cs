using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using SeiCompanion.Body;
using SObject = StardewValley.Object;

namespace SeiCompanion.Actions
{
    /// <summary>
    /// pet and collect (mod 0.1.4): the barn and coop chores.
    ///
    /// pet goes through the game's own FarmAnimal.pet with the shadow as the
    /// farmer, so friendship, the heart emote, the sound and the professions
    /// work as for a player. pet() talks to the HOST in two cases, so both are
    /// ruled out first: an animal already petted today opens the animal's
    /// info menu, and after 7 PM an animal that is not moving shows the
    /// "trying to sleep" message (the same check CSXizhang/star's
    /// AnimalPettingConditions makes, Apache-2.0; approach only).
    ///
    /// collect picks up what lies on an animal house floor (eggs, wool,
    /// feathers, rabbit's feet) and milks or shears every animal whose
    /// produce is waiting, with her OWN milk pail or shears. The game's
    /// MilkPail / Shears DoFunction reads a private animal field set during a
    /// player's swing, so the produce is taken here directly: the item at the
    /// animal's produce quality, the produce cleared, +5 friendship, 4 energy
    /// and farming XP, as the tool would.
    /// </summary>
    public static class Ranch
    {
        public const int ScanRadius = 20;

        /// <summary>FarmAnimal.pet answers with a host-facing message instead of petting.</summary>
        public static bool TryingToSleep(FarmAnimal a) => Game1.timeOfDay >= 1900 && !a.isMoving();

        /// <summary>The animals on her map within reach, nearest first.</summary>
        public static List<FarmAnimal> AnimalsNear(SeiBody body, int reach = ScanRadius)
        {
            var list = new List<FarmAnimal>();
            GameLocation loc = body.Npc?.currentLocation;
            if (loc?.animals == null) return list;
            Vector2 me = body.Npc.Tile;
            foreach (KeyValuePair<long, FarmAnimal> pair in loc.animals.Pairs)
            {
                FarmAnimal a = pair.Value;
                if (a != null && Vector2.Distance(a.Tile, me) <= reach) list.Add(a);
            }
            list.Sort((x, y) => Vector2.Distance(x.Tile, me).CompareTo(Vector2.Distance(y.Tile, me)));
            return list;
        }

        /// <summary>"MilkPail" / "Shears" when this animal's produce is taken with a tool, else null.</summary>
        public static string HarvestToolOf(FarmAnimal a)
        {
            try
            {
                if (a.GetHarvestType()?.ToString() != "HarvestWithTool") return null;
                string tool = a.GetAnimalData()?.HarvestTool;
                return string.IsNullOrWhiteSpace(tool) ? null : tool;
            }
            catch { return null; }
        }

        /// <summary>Produce waiting for a milk pail or shears.</summary>
        public static bool HasToolProduce(FarmAnimal a)
        {
            try { return a != null && !string.IsNullOrEmpty(a.currentProduce.Value) && a.isAdult() && HarvestToolOf(a) != null; }
            catch { return false; }
        }

        public static string ToolLabel(string harvestTool)
        {
            if (string.Equals(harvestTool, "MilkPail", StringComparison.OrdinalIgnoreCase)) return "Milk Pail";
            return harvestTool ?? "tool";
        }

        /// <summary>The produce's display name ("Milk", "Wool"), or null.</summary>
        public static string ProduceName(FarmAnimal a)
        {
            try
            {
                Item item = ItemRegistry.Create(QualifiedProduce(a.currentProduce.Value), 1, 0, allowNull: true);
                return item?.DisplayName;
            }
            catch { return null; }
        }

        private static string QualifiedProduce(string id) => string.IsNullOrEmpty(id) || id.StartsWith("(") ? id : "(O)" + id;

        private static Tool ToolFor(SeiBody body, string harvestTool)
        {
            if (string.Equals(harvestTool, "MilkPail", StringComparison.OrdinalIgnoreCase)) return body.FindTool<MilkPail>();
            if (string.Equals(harvestTool, "Shears", StringComparison.OrdinalIgnoreCase)) return body.FindTool<Shears>();
            return null;
        }

        /*********
        ** pet
        *********/
        public static IEnumerable<object> Pet(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            var targets = new List<FarmAnimal>();
            bool single = false;
            if (!string.IsNullOrEmpty(ctx.Str("target")))
            {
                Target t = Targets.Resolve(ctx, out string err);
                if (t == null) { yield return Result.Fail(err); yield break; }
                if (!(t.Handle?.Character is FarmAnimal one)) { yield return Result.Fail($"{ctx.Str("target")} is not a farm animal"); yield break; }
                if (one.wasPet.Value) { yield return Result.Fail($"{one.displayName} was already petted today"); yield break; }
                targets.Add(one);
                single = true;
            }
            else
            {
                List<FarmAnimal> near = AnimalsNear(body);
                if (near.Count == 0) { yield return Result.Fail("no farm animals within 20 tiles; they are in the barn and coop, or out grazing on a sunny day"); yield break; }
                targets = near.Where(a => !a.wasPet.Value).ToList();
                if (targets.Count == 0) { yield return Result.Success($"all {near.Count} animals here were already petted today"); yield break; }
            }

            int limit = Math.Clamp(ctx.Int("count") ?? 20, 1, 40);
            var names = new List<string>();
            int sleeping = 0;
            string lastSkip = null;
            foreach (FarmAnimal a in targets.Take(limit))
            {
                if (ctx.Cancelled) yield break;
                if (a.wasPet.Value || a.currentLocation != body.Npc.currentLocation) continue;
                var walk = new Outcome();
                yield return Movement.WalkTo(ctx, a.TilePoint, true, walk);
                if (!walk.Ok) { lastSkip = walk.Detail; continue; }
                if (Targets.Chebyshev(a.TilePoint, body.Npc.TilePoint) > 2) { lastSkip = $"{a.displayName} wandered off"; continue; }
                if (TryingToSleep(a)) { sleeping++; continue; }
                if (!PetOne(body, a)) { lastSkip = $"{a.displayName} would not hold still"; continue; }
                names.Add(a.displayName);
                if (ctx.Id != null) ctx.Progress($"petted {names.Count}");
                yield return WaitTicks.Ms(300);
            }

            string sleep = sleeping > 0 ? $"; {sleeping} {(sleeping == 1 ? "is" : "are")} asleep for the night" : "";
            if (names.Count == 0)
            {
                if (sleeping > 0) yield return Result.Fail($"the animals are asleep for the night; pet them tomorrow");
                else yield return Result.Fail(single ? (lastSkip ?? "could not pet it") : $"could not pet any of them ({lastSkip ?? "no animal held still"})");
                yield break;
            }
            string list = string.Join(", ", names.Take(6)) + (names.Count > 6 ? $" +{names.Count - 6} more" : "");
            yield return Result.Success($"petted {names.Count}: {list}{sleep}");
        }

        private static bool PetOne(SeiBody body, FarmAnimal a)
        {
            body.SyncShadow();
            body.Shadow.FaceToward(a.Tile);
            body.Npc.faceDirection(body.Shadow.FacingDirection);
            try { a.pet(body.Shadow, false); }
            catch (Exception ex) { body.Monitor.Log($"{body.Name}: FarmAnimal.pet threw: {ex.Message}", StardewModdingAPI.LogLevel.Debug); }
            if (a.wasPet.Value) return true;
            // pet() returned before petting (the shadow's farmer sprite was
            // mid-animation): the core of it by hand.
            try
            {
                a.wasPet.Value = true;
                a.friendshipTowardFarmer.Value = Math.Min(1000, a.friendshipTowardFarmer.Value + 15);
                a.doEmote(20);
                body.Shadow.gainExperience(0, 5);
                return true;
            }
            catch { return false; }
        }

        /*********
        ** collect
        *********/
        public static IEnumerable<object> Collect(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            int limit = Math.Clamp(ctx.Int("count") ?? 30, 1, 60);
            var got = new Dictionary<string, int>();
            var needTool = new SortedSet<string>();
            string lastSkip = null;
            bool bagFull = false;
            int taken = 0;
            List<FarmAnimal> animals;

            if (!string.IsNullOrEmpty(ctx.Str("target")))
            {
                Target t = Targets.Resolve(ctx, out string err);
                if (t == null) { yield return Result.Fail(err); yield break; }
                if (!(t.Handle?.Character is FarmAnimal one)) { yield return Result.Fail($"{ctx.Str("target")} is not a farm animal; with no target collect takes everything here"); yield break; }
                if (!HasToolProduce(one)) { yield return Result.Fail($"{one.displayName} has nothing to milk or shear right now"); yield break; }
                animals = new List<FarmAnimal> { one };
            }
            else
            {
                // What lies on the floor of this coop or barn first.
                foreach (Point p in FloorProduce(loc, body.Npc.Tile))
                {
                    if (ctx.Cancelled) yield break;
                    if (taken >= limit) break;
                    var o = new Outcome();
                    yield return Tools.PickUp(ctx, p, o);
                    if (o.Ok)
                    {
                        string name = o.Detail.StartsWith("picked up ") ? o.Detail.Substring(10) : o.Detail;
                        got[name] = got.TryGetValue(name, out int c) ? c + 1 : 1;
                        taken++;
                        continue;
                    }
                    if (o.Detail.Contains("full")) { bagFull = true; break; }
                    lastSkip = o.Detail;
                }
                animals = AnimalsNear(body).Where(HasToolProduce).ToList();
            }

            foreach (FarmAnimal a in animals)
            {
                if (ctx.Cancelled) yield break;
                if (bagFull || taken >= limit) break;
                string harvestTool = HarvestToolOf(a);
                Tool tool = ToolFor(body, harvestTool);
                if (tool == null) { needTool.Add(ToolLabel(harvestTool)); continue; }
                if (a.currentLocation != body.Npc.currentLocation) continue;
                var walk = new Outcome();
                yield return Movement.WalkTo(ctx, a.TilePoint, true, walk);
                if (!walk.Ok) { lastSkip = walk.Detail; continue; }
                if (Targets.Chebyshev(a.TilePoint, body.Npc.TilePoint) > 2) { lastSkip = $"{a.displayName} wandered off"; continue; }
                if (body.Shadow.Stamina <= 0f) { lastSkip = "out of energy"; break; }
                string name = TakeProduce(body, a, tool, out bool full);
                if (full) { bagFull = true; break; }
                if (name == null) { lastSkip = $"{a.displayName} had nothing after all"; continue; }
                got[name] = got.TryGetValue(name, out int c) ? c + 1 : 1;
                taken++;
                if (ctx.Id != null) ctx.Progress($"collected {taken}");
                yield return WaitTicks.Ms(400);
            }

            var parts = new List<string>();
            if (got.Count > 0) parts.Add("collected " + string.Join(", ", got.Select(kv => kv.Value > 1 ? $"{kv.Value} {kv.Key}" : kv.Key)));
            if (needTool.Count > 0) parts.Add($"some animals need a {string.Join(" or ", needTool)}, which you do not have (Marnie sells them)");
            if (bagFull) parts.Add("stopped: your bag is full");
            if (got.Count == 0)
            {
                if (parts.Count == 0) parts.Add(lastSkip != null ? $"could not collect anything: {lastSkip}" : "nothing to collect here (no eggs or wool on the floor, nobody ready to milk or shear)");
                yield return Result.Fail(string.Join("; ", parts));
                yield break;
            }
            yield return Result.Success(string.Join("; ", parts));
        }

        /// <summary>Produce lying on an animal house floor, nearest first (the coop's eggs, the barn's wool).</summary>
        public static List<Point> FloorProduce(GameLocation loc, Vector2 me)
        {
            var list = new List<Point>();
            if (!(loc is AnimalHouse)) return list;
            foreach (KeyValuePair<Vector2, SObject> pair in loc.objects.Pairs)
            {
                SObject o = pair.Value;
                if (o != null && !o.bigCraftable.Value && (o.IsSpawnedObject || o.isForage()))
                    list.Add(pair.Key.ToPoint());
            }
            list.Sort((x, y) => Vector2.Distance(x.ToVector2(), me).CompareTo(Vector2.Distance(y.ToVector2(), me)));
            return list;
        }

        /// <summary>Take the waiting produce into her bag; the produce name, or null. `full` when it would not fit.</summary>
        private static string TakeProduce(SeiBody body, FarmAnimal a, Tool tool, out bool full)
        {
            full = false;
            string id = a.currentProduce.Value;
            if (string.IsNullOrEmpty(id)) return null;
            Item item;
            try { item = ItemRegistry.Create(QualifiedProduce(id), 1, a.produceQuality.Value, allowNull: true); }
            catch { item = null; }
            if (item == null) return null;
            if (!body.HasRoomFor(item)) { full = true; return null; }
            body.SyncShadow();
            body.Shadow.FaceToward(a.Tile);
            body.Npc.faceDirection(body.Shadow.FacingDirection);
            int slot = body.SlotOf(tool);
            if (slot >= 0) body.Shadow.CurrentToolIndex = slot;
            string name = item.DisplayName;
            body.TakeItem(item);
            a.currentProduce.Value = null;
            try { a.friendshipTowardFarmer.Value = Math.Min(1000, a.friendshipTowardFarmer.Value + 5); } catch { }
            // A sheared sheep's sprite changes; the method's shape differs across
            // 1.6 builds, so it is looked up rather than called.
            try { body.Mod.Helper.Reflection.GetMethod(a, "ReloadTextureIfNeeded", required: false)?.Invoke(false); }
            catch { try { body.Mod.Helper.Reflection.GetMethod(a, "ReloadTextureIfNeeded", required: false)?.Invoke(); } catch { } }
            float before = body.Shadow.Stamina;
            body.Shadow.Stamina = Math.Max(0f, body.Shadow.Stamina - 4f);
            body.Shadow.checkForExhaustion(before);
            try { body.Shadow.gainExperience(0, 5); } catch { }
            try { body.Npc.currentLocation.playSound(tool is MilkPail ? "Milking" : "scissors", a.Tile); } catch { }
            try { body.Npc.jump(3f); } catch { }
            return name;
        }
    }
}
