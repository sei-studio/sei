using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.TerrainFeatures;
using SeiCompanion.Body;

namespace SeiCompanion.Actions
{
    /// <summary>
    /// shake (mod 0.1.4): shake a berry bush, a tea bush, a fruit tree or a
    /// wild tree, the way a player's right click does. The game's own
    /// performUseAction drops whatever is on it (salmonberries, blackberries,
    /// tea leaves, fruit, a tree's seed or a hazelnut) as debris, and the body
    /// picks the debris up.
    /// </summary>
    public static class Shake
    {
        public static IEnumerable<object> Do(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            Point tile;
            bool named = !string.IsNullOrEmpty(ctx.Str("target")) || ctx.Int("x").HasValue;
            string err = null;
            Target t = named ? Targets.Resolve(ctx, out err) : null;
            if (named && (t == null || !t.HasTile)) { yield return Result.Fail(err ?? "give a #N handle from the snapshot, or x and y"); yield break; }
            if (t != null)
            {
                if (!string.IsNullOrEmpty(t.LocationName) && t.LocationName != loc.NameOrUniqueName)
                {
                    yield return Result.Fail($"that is in {t.LocationName}; goTo there first");
                    yield break;
                }
                tile = t.Tile;
            }
            else
            {
                Point? next = NearestLaden(body);
                if (next == null) { yield return Result.Fail("no bush with berries or fruit tree with fruit within 20 tiles"); yield break; }
                tile = next.Value;
            }

            TerrainFeature feature = FeatureAt(loc, tile, out Vector2 anchor);
            if (feature == null) { yield return Result.Fail($"no bush or tree at {Targets.Fmt(tile)}"); yield break; }
            string name = Label(feature);
            if (feature is Tree tree && (tree.stump.Value || tree.growthStage.Value < 5))
            {
                yield return Result.Fail(tree.stump.Value ? "that is a stump; there is nothing to shake" : $"the {name} is too young to shake");
                yield break;
            }

            var walk = new Outcome();
            yield return Movement.WalkTo(ctx, anchor.ToPoint(), true, walk);
            if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }

            Dictionary<string, int> before = BagCounts(body);
            body.SyncShadow();
            body.Shadow.FaceToward(anchor);
            body.Npc.faceDirection(body.Shadow.FacingDirection);
            string error = null;
            try
            {
                if (feature is FruitTree ft) ft.shake(anchor, false);
                else feature.performUseAction(anchor);
            }
            catch (Exception ex) { error = ex.Message; }
            if (error != null) { yield return Result.Fail($"could not shake the {name}: {error}"); yield break; }
            try { body.Npc.jump(2f); } catch { }
            // Let what fell land, then sweep it up.
            yield return WaitTicks.Ms(900);
            body.CollectDebris(3);

            var gained = new List<string>();
            foreach (var pair in BagCounts(body))
            {
                int was = before.TryGetValue(pair.Key, out int b) ? b : 0;
                if (pair.Value > was) gained.Add(pair.Value - was > 1 ? $"{pair.Value - was} {pair.Key}" : pair.Key);
            }
            yield return gained.Count > 0
                ? Result.Success($"shook the {name} and picked up {string.Join(", ", gained.Take(5))}")
                : Result.Success($"shook the {name}; nothing fell (no berries, fruit or seeds on it right now)");
        }

        /// <summary>The bush or tree covering a tile; `anchor` is its own tile.</summary>
        public static TerrainFeature FeatureAt(GameLocation loc, Point tile, out Vector2 anchor)
        {
            var v = new Vector2(tile.X, tile.Y);
            anchor = v;
            if (loc.terrainFeatures.TryGetValue(v, out TerrainFeature tf) && (tf is Tree || tf is FruitTree || tf is Bush))
                return tf;
            var cell = new Rectangle(tile.X * 64, tile.Y * 64, 64, 64);
            foreach (LargeTerrainFeature lt in loc.largeTerrainFeatures)
            {
                if (!(lt is Bush)) continue;
                Rectangle box = lt.getBoundingBox();
                if (!box.Intersects(cell)) continue;
                anchor = new Vector2(box.X / 64, box.Y / 64);
                return lt;
            }
            return null;
        }

        /// <summary>A bush showing berries or tea leaves (its fruit frame is up).</summary>
        public static bool HasBerries(Bush bush)
        {
            try { return bush.tileSheetOffset.Value == 1; }
            catch { return false; }
        }

        public static string Label(TerrainFeature f)
        {
            switch (f)
            {
                case Bush b:
                    // 3 is the tea bush size (Bush.greenTeaBush).
                    if (b.size.Value == 3) return "tea bush";
                    return HasBerries(b) ? "berry bush" : "bush";
                case FruitTree _:
                    return "fruit tree";
                case Tree _:
                    return "tree";
                default:
                    return "plant";
            }
        }

        /// <summary>The nearest bush with berries or fruit tree with fruit within 20 tiles.</summary>
        private static Point? NearestLaden(SeiBody body)
        {
            GameLocation loc = body.Npc.currentLocation;
            Vector2 me = body.Npc.Tile;
            Point? best = null;
            float bestDist = 20f;
            void Consider(Vector2 at)
            {
                float d = Vector2.Distance(at, me);
                if (d <= bestDist) { bestDist = d; best = at.ToPoint(); }
            }
            foreach (KeyValuePair<Vector2, TerrainFeature> pair in loc.terrainFeatures.Pairs)
            {
                if (pair.Value is FruitTree ft && ft.fruit.Count > 0) Consider(pair.Key);
                else if (pair.Value is Bush tb && HasBerries(tb)) Consider(pair.Key);
            }
            foreach (LargeTerrainFeature lt in loc.largeTerrainFeatures)
            {
                if (lt is Bush b && HasBerries(b))
                {
                    Rectangle box = b.getBoundingBox();
                    Consider(new Vector2(box.X / 64, box.Y / 64));
                }
            }
            return best;
        }

        private static Dictionary<string, int> BagCounts(SeiBody body)
        {
            var m = new Dictionary<string, int>();
            foreach (Item it in body.Shadow.Items)
            {
                if (it == null) continue;
                m[it.DisplayName] = (m.TryGetValue(it.DisplayName, out int c) ? c : 0) + it.Stack;
            }
            return m;
        }
    }
}
