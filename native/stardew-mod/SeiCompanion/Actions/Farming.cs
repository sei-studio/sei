using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.GameData.Crops;
using StardewValley.TerrainFeatures;
using SeiCompanion.Body;
using SObject = StardewValley.Object;

namespace SeiCompanion.Actions
{
    /// <summary>plant / harvest. Crop.harvest hands the item to Game1.player and freezes their animation, so harvesting is re-implemented here for the shadow.</summary>
    public static class Farming
    {
        public static bool IsSeed(Item item)
        {
            if (!(item is SObject o)) return false;
            if (o.Category == SObject.SeedsCategory || o.Category == SObject.fertilizerCategory) return true;
            string n = (o.Name ?? "").ToLowerInvariant();
            return n.EndsWith("seeds") || n.EndsWith("sapling") || n.EndsWith("starter") || n.EndsWith("bulb") || n.EndsWith("tuber") || n.Contains("bean starter");
        }

        public static IEnumerable<object> Plant(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            string query = ctx.Str("seed") ?? ctx.Str("item");
            Item seed = query != null ? body.FindItem(query) : body.Shadow.Items.FirstOrDefault(IsSeed);
            if (seed == null || !IsSeed(seed))
            {
                yield return Result.Fail(query != null ? $"no seeds matching {query} in the inventory" : "no seeds in the inventory; buy some at Pierre's (SeedShop) first");
                yield break;
            }
            bool fertilizer = (seed as SObject)?.Category == SObject.fertilizerCategory;
            int count = Math.Clamp(ctx.Int("count") ?? 1, 1, 20);
            var tiles = new List<Point>();
            Target t = Targets.Resolve(ctx, out _);
            if (t != null && t.HasTile)
                tiles.Add(t.Tile);
            else
                tiles.AddRange(EmptySoilNear(body, count));
            if (tiles.Count == 0)
            {
                yield return Result.Fail("no empty tilled soil nearby; till(x,y) some ground first");
                yield break;
            }
            int planted = 0;
            string seedName = seed.DisplayName;
            foreach (Point tile in tiles)
            {
                if (ctx.Cancelled) yield break;
                if (seed.Stack <= 0) break;
                if (!(loc.terrainFeatures.TryGetValue(new Vector2(tile.X, tile.Y), out TerrainFeature tf) && tf is HoeDirt dirt))
                {
                    if (tiles.Count == 1) { yield return Result.Fail($"{Targets.Fmt(tile)} is not tilled soil; till it first"); yield break; }
                    continue;
                }
                if (!fertilizer && dirt.crop != null)
                {
                    if (tiles.Count == 1) { yield return Result.Fail($"{Targets.Fmt(tile)} already has a crop"); yield break; }
                    continue;
                }
                var walk = new Outcome();
                yield return Movement.WalkTo(ctx, tile, true, walk);
                if (!walk.Ok) { if (tiles.Count == 1) { yield return Result.Fail(walk.Detail); yield break; } continue; }
                body.SyncShadow();
                bool ok;
                string plantError = null;
                try { ok = dirt.plant(seed.ItemId, body.Shadow, fertilizer); }
                catch (Exception ex) { ok = false; plantError = ex.Message; }
                if (plantError != null) { yield return Result.Fail($"planting failed: {plantError}"); yield break; }
                if (!ok)
                {
                    if (!fertilizer && !Crop.IsInSeason(loc, Crop.ResolveSeedId(seed.ItemId, loc)))
                    {
                        yield return Result.Fail($"{seedName} cannot be planted in {Game1.currentSeason} here");
                        yield break;
                    }
                    if (tiles.Count == 1) { yield return Result.Fail($"could not plant {seedName} at {Targets.Fmt(tile)}"); yield break; }
                    continue;
                }
                seed.Stack--;
                if (seed.Stack <= 0)
                {
                    int slot = body.SlotOf(seed);
                    if (slot >= 0) body.Shadow.Items[slot] = null;
                }
                planted++;
                yield return WaitTicks.Ms(250);
                if (planted >= count) break;
            }
            yield return planted > 0
                ? Result.Success(fertilizer ? $"applied {seedName} to {planted} tiles" : $"planted {planted} {seedName}")
                : Result.Fail($"planted nothing; no usable tile for {seedName}");
        }

        public static List<Point> EmptySoilNear(SeiBody body, int max)
        {
            GameLocation loc = body.Npc.currentLocation;
            Vector2 me = body.Npc.Tile;
            return loc.terrainFeatures.Pairs
                .Where(p => p.Value is HoeDirt d && d.crop == null && Vector2.Distance(p.Key, me) <= Tools.ScanRadius)
                .OrderBy(p => Vector2.Distance(p.Key, me))
                .Take(max)
                .Select(p => p.Key.ToPoint())
                .ToList();
        }

        /*********
        ** harvest
        *********/
        public static IEnumerable<object> Harvest(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            Target t = Targets.Resolve(ctx, out _);
            if (t != null && t.HasTile)
            {
                var o = new Outcome();
                yield return HarvestAt(ctx, t.Tile, o);
                yield return o.Ok ? Result.Success(o.Detail) : Result.Fail(o.Detail);
                yield break;
            }
            // scope "farm" (mod 0.1.3): walk to the Farm and take every ready
            // crop on it, not only those within 20 tiles (see Tools.Water).
            bool farmWide = Tools.FarmScope(ctx);
            if (farmWide)
            {
                var go = new Outcome();
                yield return Tools.ToFarm(ctx, go);
                if (!go.Ok) { yield return Result.Fail(go.Detail); yield break; }
            }
            int reach = farmWide ? Tools.WholeMap : Tools.ScanRadius;
            int limit = Math.Clamp(ctx.Int("count") ?? (farmWide ? 120 : 30), 1, farmWide ? 200 : 60);
            int done = 0;
            var names = new List<string>();
            var skipped = new HashSet<Point>();
            string lastSkip = null;
            for (int i = 0; i < limit + Tools.MaxSkips; i++)
            {
                if (ctx.Cancelled) yield break;
                if (done >= limit) break;
                Point? next = NearestReadyCrop(body, reach, skipped);
                if (next == null) break;
                var o = new Outcome();
                yield return HarvestAt(ctx, next.Value, o);
                if (!o.Ok)
                {
                    // An unreachable crop is stepped over; anything else ends the round.
                    if (!Tools.IsWalkFailure(o.Detail) || skipped.Count >= Tools.MaxSkips) { yield return Result.Fail(done > 0 ? $"harvested {done}, then: {o.Detail}" : o.Detail); yield break; }
                    skipped.Add(next.Value);
                    lastSkip = o.Detail;
                    continue;
                }
                done++;
                names.Add(o.Detail);
                ctx.Progress($"harvested {done}");
            }
            string where = farmWide ? " on the farm" : " nearby";
            string skips = skipped.Count > 0 ? $"; skipped {skipped.Count} it could not reach ({lastSkip})" : "";
            yield return done > 0
                ? Result.Success($"harvested {done} crops: {string.Join(", ", names.Distinct().Take(4))}{skips}")
                : Result.Fail(skipped.Count > 0 ? $"could not reach the ready crops{where}: {lastSkip}" : $"nothing is ready to harvest{where}");
        }

        public static Point? NearestReadyCrop(SeiBody body, int reach = Tools.ScanRadius, HashSet<Point> skip = null)
        {
            GameLocation loc = body.Npc.currentLocation;
            Vector2 me = body.Npc.Tile;
            Point? best = null;
            float bestDist = float.MaxValue;
            foreach (KeyValuePair<Vector2, TerrainFeature> pair in loc.terrainFeatures.Pairs)
            {
                if (!(pair.Value is HoeDirt dirt) || dirt.crop == null || !dirt.readyForHarvest())
                    continue;
                if (skip != null && skip.Contains(pair.Key.ToPoint()))
                    continue;
                float d = Vector2.Distance(pair.Key, me);
                if (d <= reach && d < bestDist) { bestDist = d; best = pair.Key.ToPoint(); }
            }
            return best;
        }

        public static IEnumerable<object> HarvestAt(ActionContext ctx, Point tile, Outcome o)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            var v = new Vector2(tile.X, tile.Y);
            if (loc.terrainFeatures.TryGetValue(v, out TerrainFeature tf))
            {
                if (tf is HoeDirt dirt)
                {
                    if (dirt.crop == null) { o.Fail($"no crop at {Targets.Fmt(tile)}"); yield break; }
                    if (!dirt.readyForHarvest()) { o.Fail($"the {CropName(dirt.crop)} at {Targets.Fmt(tile)} is not ready yet"); yield break; }
                    var walk = new Outcome();
                    yield return Movement.WalkTo(ctx, tile, true, walk);
                    if (!walk.Ok) { o.Fail(walk.Detail); yield break; }
                    string result = HarvestCrop(body, dirt, tile);
                    if (result == null) { o.Fail("harvest failed"); yield break; }
                    o.Pass(result);
                    yield break;
                }
                if (tf is FruitTree fruitTree)
                {
                    if (fruitTree.fruit.Count == 0) { o.Fail("that fruit tree has no fruit right now"); yield break; }
                    var walk = new Outcome();
                    yield return Movement.WalkTo(ctx, tile, true, walk);
                    if (!walk.Ok) { o.Fail(walk.Detail); yield break; }
                    int n = fruitTree.fruit.Count;
                    string shakeError = null;
                    try { fruitTree.shake(v, false); } catch (Exception ex) { shakeError = ex.Message; }
                    if (shakeError != null) { o.Fail($"could not shake the tree: {shakeError}"); yield break; }
                    yield return WaitTicks.Ms(900);
                    body.CollectDebris(3);
                    o.Pass($"shook {n} fruit down and picked them up");
                    yield break;
                }
            }
            if (loc.objects.TryGetValue(v, out SObject obj))
            {
                if (obj.IsSpawnedObject || obj.isForage())
                {
                    yield return Tools.PickUp(ctx, tile, o);
                    yield break;
                }
                if (obj.bigCraftable.Value && obj.readyForHarvest.Value)
                {
                    var walk = new Outcome();
                    yield return Movement.WalkTo(ctx, tile, true, walk);
                    if (!walk.Ok) { o.Fail(walk.Detail); yield break; }
                    o.Pass(EmptyMachine(body, obj) ?? "took nothing");
                    yield break;
                }
            }
            o.Fail($"nothing harvestable at {Targets.Fmt(tile)}");
        }

        public static string CropName(Crop crop)
        {
            try
            {
                Item item = ItemRegistry.Create(crop.indexOfHarvest.Value, 1, 0, allowNull: true);
                return item?.DisplayName ?? "crop";
            }
            catch { return "crop"; }
        }

        /// <summary>Take a ready crop into the shadow's inventory: one stack per CropData, regrow or destroy, farming XP.</summary>
        public static string HarvestCrop(SeiBody body, HoeDirt dirt, Point tile)
        {
            Crop crop = dirt.crop;
            CropData data = null;
            try { data = crop.GetData(); } catch { }
            int min = Math.Max(1, data?.HarvestMinStack ?? 1);
            int max = Math.Max(min, data?.HarvestMaxStack ?? min);
            int count = Game1.random.Next(min, max + 1);
            if (data != null && data.ExtraHarvestChance > 0 && Game1.random.NextDouble() < data.ExtraHarvestChance) count++;
            Item item;
            try { item = ItemRegistry.Create(crop.indexOfHarvest.Value, count, 0, allowNull: true); }
            catch { item = null; }
            if (item == null) return null;
            string name = item.DisplayName;
            body.TakeItem(item);
            try { body.Shadow.gainExperience(0, 8); } catch { }
            try { body.Npc.currentLocation.playSound("harvest", new Vector2(tile.X, tile.Y)); } catch { }
            int regrow = data?.RegrowDays ?? -1;
            if (regrow > 0)
            {
                crop.fullyGrown.Value = true;
                crop.dayOfCurrentPhase.Value = regrow;
            }
            else
            {
                dirt.destroyCrop(false);
            }
            return count > 1 ? $"{count} {name}" : name;
        }

        /// <summary>Empty a ready machine (keg, furnace, preserves jar...) the way a click would, without a menu.</summary>
        public static string EmptyMachine(SeiBody body, SObject machine)
        {
            SObject held = machine.heldObject.Value;
            string name = held?.DisplayName ?? machine.DisplayName;
            body.SyncShadow();
            bool ok = false;
            try { ok = machine.checkForAction(body.Shadow); } catch { ok = false; }
            if (!ok && held != null)
            {
                // Fallback: pull the product out by hand and reset the machine.
                machine.heldObject.Value = null;
                machine.readyForHarvest.Value = false;
                machine.showNextIndex.Value = false;
                body.TakeItem(held);
                ok = true;
            }
            return ok ? $"took {name} from the {machine.DisplayName}" : null;
        }
    }
}
