using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;
using SeiCompanion.Body;
using SObject = StardewValley.Object;

namespace SeiCompanion.Actions
{
    /// <summary>Tool use on the shadow farmer (Tool.DoFunction with the shadow as `who`) and the verbs built on it.</summary>
    public static class Tools
    {
        public const int ScanRadius = 20;
        private const int MaxSwings = 40;

        /// <summary>One swing of a tool at a tile. The shadow pays the stamina; the NPC hops so the swing reads on screen.</summary>
        public static void UseToolAt<T>(SeiBody body, Point tile, Outcome o) where T : Tool
        {
            T tool = body.FindTool<T>();
            if (tool == null) { o.Fail($"no {ToolName<T>()} in the inventory"); return; }
            if (body.Shadow.Stamina <= 0f) { o.Fail("out of energy (exhausted); eat something or sleep before using tools"); return; }
            body.SyncShadow();
            body.Shadow.FaceToward(new Vector2(tile.X, tile.Y));
            body.Npc.faceDirection(body.Shadow.FacingDirection);
            int slot = body.SlotOf(tool);
            if (slot >= 0) body.Shadow.CurrentToolIndex = slot;
            float before = body.Shadow.Stamina;
            try
            {
                tool.DoFunction(body.Npc.currentLocation, tile.X * 64 + 32, tile.Y * 64 + 32, 1, body.Shadow);
            }
            catch (Exception ex)
            {
                o.Fail($"{ToolName<T>()} failed: {ex.Message}");
                return;
            }
            body.Shadow.checkForExhaustion(before);
            try { body.Npc.jump(4f); } catch { }
            o.Pass();
        }

        public static string ToolName<T>()
        {
            Type t = typeof(T);
            if (t == typeof(Axe)) return "axe";
            if (t == typeof(Pickaxe)) return "pickaxe";
            if (t == typeof(Hoe)) return "hoe";
            if (t == typeof(WateringCan)) return "watering can";
            if (t == typeof(FishingRod)) return "fishing rod";
            return t.Name.ToLowerInvariant();
        }

        /*********
        ** till
        *********/
        public static IEnumerable<object> Till(ActionContext ctx)
        {
            Target t = Targets.Resolve(ctx, out string err);
            if (t == null || !t.HasTile) { yield return Result.Fail(err ?? "till needs x and y"); yield break; }
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            if (loc.terrainFeatures.TryGetValue(t.TileVec, out TerrainFeature existing) && existing is HoeDirt)
            {
                yield return Result.Success($"{Targets.Fmt(t.Tile)} is already tilled");
                yield break;
            }
            if (loc.doesTileHaveProperty(t.Tile.X, t.Tile.Y, "Diggable", "Back") == null)
            {
                yield return Result.Fail($"{Targets.Fmt(t.Tile)} is not diggable ground (grass, path or a floor); pick a dirt tile on the farm");
                yield break;
            }
            if (loc.objects.ContainsKey(t.TileVec))
            {
                yield return Result.Fail($"something is on {Targets.Fmt(t.Tile)}; clear it first (mine or chop)");
                yield break;
            }
            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, t.Tile, true, walk);
            if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
            var use = new Outcome();
            UseToolAt<Hoe>(body, t.Tile, use);
            if (!use.Ok) { yield return Result.Fail(use.Detail); yield break; }
            yield return WaitTicks.Ms(300);
            bool tilled = loc.terrainFeatures.TryGetValue(t.TileVec, out TerrainFeature tf) && tf is HoeDirt;
            yield return tilled ? Result.Success($"tilled {Targets.Fmt(t.Tile)}") : Result.Fail($"the hoe did not turn {Targets.Fmt(t.Tile)} into soil");
        }

        /*********
        ** water
        *********/
        public static IEnumerable<object> Water(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            WateringCan can = body.FindTool<WateringCan>();
            if (can == null) { yield return Result.Fail("no watering can in the inventory"); yield break; }

            Target t = Targets.Resolve(ctx, out string err);
            if (t != null && t.HasTile)
            {
                // A water tile refills; a soil tile gets watered.
                if (loc.isWaterTile(t.Tile.X, t.Tile.Y))
                {
                    var w = new Outcome();
                    yield return Movement.WalkTo(ctx, t.Tile, true, w);
                    if (!w.Ok) { yield return Result.Fail(w.Detail); yield break; }
                    can.WaterLeft = can.waterCanMax;
                    try { loc.playSound("slosh", t.TileVec); } catch { }
                    yield return Result.Success($"refilled the watering can ({can.WaterLeft}/{can.waterCanMax})");
                    yield break;
                }
                var single = new Outcome();
                yield return WaterTile(ctx, t.Tile, single);
                yield return single.Ok ? Result.Success(single.Detail) : Result.Fail(single.Detail);
                yield break;
            }

            // No tile: every dry crop in reach, nearest first.
            int done = 0;
            int limit = Math.Clamp(ctx.Int("count") ?? 30, 1, 60);
            for (int i = 0; i < limit; i++)
            {
                if (ctx.Cancelled) yield break;
                Point? next = NearestDryCrop(body);
                if (next == null) break;
                if (can.WaterLeft <= 0 && !can.IsBottomless)
                {
                    yield return Result.Fail(done > 0 ? $"watered {done} crops, then the can ran dry; water(x,y) on a water tile to refill" : "the watering can is empty; water(x,y) on a water tile to refill it");
                    yield break;
                }
                var o = new Outcome();
                yield return WaterTile(ctx, next.Value, o);
                if (!o.Ok) { yield return Result.Fail(done > 0 ? $"watered {done} crops, then: {o.Detail}" : o.Detail); yield break; }
                done++;
                ctx.Progress($"watered {done} crops");
            }
            yield return Result.Success(done == 0 ? "nothing here needs water" : $"watered {done} crops ({can.WaterLeft}/{can.waterCanMax} left in the can)");
        }

        private static IEnumerable<object> WaterTile(ActionContext ctx, Point tile, Outcome o)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            if (!(loc.terrainFeatures.TryGetValue(new Vector2(tile.X, tile.Y), out TerrainFeature tf) && tf is HoeDirt dirt))
            {
                o.Fail($"{Targets.Fmt(tile)} is not tilled soil");
                yield break;
            }
            if (dirt.isWatered()) { o.Pass($"{Targets.Fmt(tile)} is already watered"); yield break; }
            WateringCan can = body.FindTool<WateringCan>();
            if (can != null && can.WaterLeft <= 0 && !can.IsBottomless) { o.Fail("the watering can is empty; water(x,y) on a water tile to refill it"); yield break; }
            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, tile, true, walk);
            if (!walk.Ok) { o.Fail(walk.Detail); yield break; }
            var use = new Outcome();
            UseToolAt<WateringCan>(body, tile, use);
            if (!use.Ok) { o.Fail(use.Detail); yield break; }
            yield return WaitTicks.Ms(250);
            o.Pass(dirt.isWatered() ? $"watered {Targets.Fmt(tile)}" : $"tried to water {Targets.Fmt(tile)} but it stayed dry");
        }

        public static Point? NearestDryCrop(SeiBody body)
        {
            GameLocation loc = body.Npc.currentLocation;
            Vector2 me = body.Npc.Tile;
            Point? best = null;
            float bestDist = float.MaxValue;
            foreach (KeyValuePair<Vector2, TerrainFeature> pair in loc.terrainFeatures.Pairs)
            {
                if (!(pair.Value is HoeDirt dirt) || dirt.crop == null || dirt.isWatered() || dirt.crop.dead.Value)
                    continue;
                float d = Vector2.Distance(pair.Key, me);
                if (d <= ScanRadius && d < bestDist) { bestDist = d; best = pair.Key.ToPoint(); }
            }
            return best;
        }

        /*********
        ** chop / mine
        *********/
        public static IEnumerable<object> Chop(ActionContext ctx)
        {
            Target t = Targets.Resolve(ctx, out string err);
            if (t == null || !t.HasTile) { yield return Result.Fail(err ?? "chop needs a #N tree or x and y"); yield break; }
            var o = new Outcome();
            yield return ChopAt(ctx, t.Tile, o);
            yield return o.Ok ? Result.Success(o.Detail) : Result.Fail(o.Detail);
        }

        public static IEnumerable<object> Mine(ActionContext ctx)
        {
            Target t = Targets.Resolve(ctx, out string err);
            if (t == null || !t.HasTile) { yield return Result.Fail(err ?? "mine needs a #N rock or x and y"); yield break; }
            var o = new Outcome();
            yield return MineAt(ctx, t.Tile, o);
            yield return o.Ok ? Result.Success(o.Detail) : Result.Fail(o.Detail);
        }

        private static bool TreeAt(GameLocation loc, Point tile)
        {
            if (loc.terrainFeatures.TryGetValue(new Vector2(tile.X, tile.Y), out TerrainFeature tf) && (tf is Tree || tf is FruitTree))
                return true;
            return ClumpAt(loc, tile) != null;
        }

        public static ResourceClump ClumpAt(GameLocation loc, Point tile)
        {
            if (loc.resourceClumps == null) return null;
            foreach (ResourceClump clump in loc.resourceClumps)
            {
                if (clump == null) continue;
                var rect = new Rectangle((int)clump.Tile.X, (int)clump.Tile.Y, clump.width.Value, clump.height.Value);
                if (rect.Contains(tile)) return clump;
            }
            return null;
        }

        private static bool IsStumpOrLog(ResourceClump c)
        {
            int idx = c.parentSheetIndex.Value;
            return idx == ResourceClump.stumpIndex || idx == ResourceClump.hollowLogIndex;
        }

        public static IEnumerable<object> ChopAt(ActionContext ctx, Point tile, Outcome o)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            bool twig = loc.objects.TryGetValue(new Vector2(tile.X, tile.Y), out SObject obj) && (obj.IsTwig() || obj.IsWeeds());
            if (!TreeAt(loc, tile) && !twig) { o.Fail($"nothing to chop at {Targets.Fmt(tile)}"); yield break; }
            if (body.FindTool<Axe>() == null) { o.Fail("no axe in the inventory"); yield break; }
            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, tile, true, walk);
            if (!walk.Ok) { o.Fail(walk.Detail); yield break; }
            int before = InventoryCount(body);
            for (int swing = 0; swing < MaxSwings; swing++)
            {
                if (ctx.Cancelled) yield break;
                bool stillThere = TreeAt(loc, tile) || (loc.objects.TryGetValue(new Vector2(tile.X, tile.Y), out SObject o2) && (o2.IsTwig() || o2.IsWeeds()));
                if (!stillThere) break;
                ResourceClump clump = ClumpAt(loc, tile);
                if (clump != null && !IsStumpOrLog(clump)) { o.Fail($"{Targets.Fmt(tile)} is a boulder, use mine"); yield break; }
                var use = new Outcome();
                UseToolAt<Axe>(body, tile, use);
                if (!use.Ok) { o.Fail(use.Detail); yield break; }
                body.CollectDebris(3);
                yield return WaitTicks.Ms(350);
                if (swing % 4 == 3) ctx.Progress($"chopping at {Targets.Fmt(tile)} ({swing + 1} swings)");
            }
            body.CollectDebris(4);
            int gained = InventoryCount(body) - before;
            bool gone = !TreeAt(loc, tile);
            if (!gone)
            {
                o.Fail(body.Shadow.Stamina <= 0 ? "ran out of energy before the tree came down" : $"the axe is not strong enough for what is at {Targets.Fmt(tile)} (needs an upgraded axe)");
                yield break;
            }
            o.Pass(gained > 0 ? $"chopped {Targets.Fmt(tile)} and picked up {gained} items (wood/sap)" : $"cleared {Targets.Fmt(tile)}");
        }

        private static bool RockAt(GameLocation loc, Point tile)
        {
            if (loc.objects.TryGetValue(new Vector2(tile.X, tile.Y), out SObject obj) && (obj.IsBreakableStone() || obj.Name == "Stone"))
                return true;
            ResourceClump c = ClumpAt(loc, tile);
            return c != null && !IsStumpOrLog(c);
        }

        public static IEnumerable<object> MineAt(ActionContext ctx, Point tile, Outcome o)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            if (!RockAt(loc, tile)) { o.Fail($"nothing to mine at {Targets.Fmt(tile)}"); yield break; }
            if (body.FindTool<Pickaxe>() == null) { o.Fail("no pickaxe in the inventory"); yield break; }
            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, tile, true, walk);
            if (!walk.Ok) { o.Fail(walk.Detail); yield break; }
            int before = InventoryCount(body);
            for (int swing = 0; swing < MaxSwings; swing++)
            {
                if (ctx.Cancelled) yield break;
                if (!RockAt(loc, tile)) break;
                var use = new Outcome();
                UseToolAt<Pickaxe>(body, tile, use);
                if (!use.Ok) { o.Fail(use.Detail); yield break; }
                body.CollectDebris(3);
                yield return WaitTicks.Ms(350);
                if (swing % 4 == 3) ctx.Progress($"mining {Targets.Fmt(tile)} ({swing + 1} swings)");
            }
            body.CollectDebris(4);
            int gained = InventoryCount(body) - before;
            if (RockAt(loc, tile))
            {
                o.Fail(body.Shadow.Stamina <= 0 ? "ran out of energy before the rock broke" : $"the pickaxe cannot break what is at {Targets.Fmt(tile)} (needs an upgraded pickaxe)");
                yield break;
            }
            o.Pass(gained > 0 ? $"broke the rock at {Targets.Fmt(tile)} and picked up {gained} items" : $"broke the rock at {Targets.Fmt(tile)}");
        }

        public static int InventoryCount(SeiBody body)
        {
            int n = 0;
            foreach (Item it in body.Shadow.Items) if (it != null) n += it.Stack;
            return n;
        }

        /*********
        ** gather
        *********/
        public static IEnumerable<object> Gather(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            string kind = (ctx.Str("kind") ?? "forage").Trim().ToLowerInvariant();
            int count = Math.Clamp(ctx.Int("count") ?? 5, 1, 40);
            var known = new HashSet<string> { "forage", "wood", "stone", "fiber", "debris" };
            if (!known.Contains(kind)) { yield return Result.Fail($"unknown kind {kind}; use forage, wood, stone, fiber or debris"); yield break; }
            int before = InventoryCount(body);
            int cleared = 0;
            var tried = new HashSet<Point>();
            for (int i = 0; i < 40; i++)
            {
                if (ctx.Cancelled) yield break;
                int gained = InventoryCount(body) - before;
                int progress = kind == "debris" ? cleared : gained;
                if (progress >= count) break;
                Point? next = NearestGatherTarget(body, kind, tried);
                if (next == null) break;
                tried.Add(next.Value);
                var o = new Outcome();
                GameLocation loc = body.Npc.currentLocation;
                Vector2 v = new Vector2(next.Value.X, next.Value.Y);
                if (loc.objects.TryGetValue(v, out SObject obj) && (obj.IsSpawnedObject || obj.isForage()))
                    yield return PickUp(ctx, next.Value, o);
                else if (RockAt(loc, next.Value))
                    yield return MineAt(ctx, next.Value, o);
                else
                    yield return ChopAt(ctx, next.Value, o);
                if (o.Ok) cleared++;
                ctx.Progress($"gathering {kind}: {(kind == "debris" ? cleared : InventoryCount(body) - before)}/{count}");
                if (!o.Ok && o.Detail.Contains("energy")) { yield return Result.Fail(o.Detail); yield break; }
            }
            int total = InventoryCount(body) - before;
            if (kind == "debris")
                yield return cleared > 0 ? Result.Success($"cleared {cleared} pieces of debris, picked up {total} items") : Result.Fail("no debris (weeds, twigs, stones) within reach");
            else
                yield return total > 0 ? Result.Success($"gathered {total} items of {kind}") : Result.Fail($"found no {kind} to gather within {ScanRadius} tiles");
        }

        private static Point? NearestGatherTarget(SeiBody body, string kind, HashSet<Point> skip)
        {
            GameLocation loc = body.Npc.currentLocation;
            Vector2 me = body.Npc.Tile;
            Point? best = null;
            float bestDist = float.MaxValue;
            void Consider(Vector2 tile)
            {
                Point p = tile.ToPoint();
                if (skip.Contains(p)) return;
                float d = Vector2.Distance(tile, me);
                if (d <= ScanRadius && d < bestDist) { bestDist = d; best = p; }
            }
            foreach (KeyValuePair<Vector2, SObject> pair in loc.objects.Pairs)
            {
                SObject obj = pair.Value;
                if (obj == null) continue;
                bool ok = kind switch
                {
                    "forage" => obj.IsSpawnedObject || obj.isForage(),
                    "stone" => obj.IsBreakableStone() || obj.Name == "Stone",
                    "fiber" => obj.IsWeeds(),
                    "wood" => obj.IsTwig(),
                    "debris" => obj.IsTwig() || obj.IsWeeds() || obj.IsBreakableStone() || obj.Name == "Stone",
                    _ => false,
                };
                if (ok) Consider(pair.Key);
            }
            if (kind == "wood")
            {
                foreach (KeyValuePair<Vector2, TerrainFeature> pair in loc.terrainFeatures.Pairs)
                {
                    if (pair.Value is Tree tree && tree.growthStage.Value >= 5 && !tree.tapped.Value)
                        Consider(pair.Key);
                }
                if (loc.resourceClumps != null)
                    foreach (ResourceClump c in loc.resourceClumps)
                        if (c != null && IsStumpOrLog(c)) Consider(c.Tile);
            }
            if (kind == "stone" && loc.resourceClumps != null)
            {
                foreach (ResourceClump c in loc.resourceClumps)
                    if (c != null && !IsStumpOrLog(c)) Consider(c.Tile);
            }
            return best;
        }

        /// <summary>Pick up a forage item or a dropped-looking object at a tile.</summary>
        public static IEnumerable<object> PickUp(ActionContext ctx, Point tile, Outcome o)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            var v = new Vector2(tile.X, tile.Y);
            if (!loc.objects.TryGetValue(v, out SObject obj) || !(obj.IsSpawnedObject || obj.isForage() || obj.CanBeGrabbed))
            {
                o.Fail($"nothing to pick up at {Targets.Fmt(tile)}");
                yield break;
            }
            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, tile, true, walk);
            if (!walk.Ok) { o.Fail(walk.Detail); yield break; }
            if (!loc.objects.TryGetValue(v, out obj)) { o.Fail("it is gone"); yield break; }
            Item taken = obj.getOne();
            taken.Stack = Math.Max(1, obj.Stack);
            string name = taken.DisplayName;
            if (!body.Shadow.couldInventoryAcceptThisItem(taken)) { o.Fail("inventory is full"); yield break; }
            loc.objects.Remove(v);
            body.TakeItem(taken);
            try { loc.playSound("pickUpItem", v); } catch { }
            try { body.Shadow.gainExperience(2, 7); } catch { }
            o.Pass($"picked up {name}");
        }
    }
}
