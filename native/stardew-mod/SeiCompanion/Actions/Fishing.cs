using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using SeiCompanion.Body;

namespace SeiCompanion.Actions
{
    /// <summary>
    /// fish: a mod-side cast. The vanilla rod path opens the BobberBar on the
    /// host's screen for whoever `lastUser` is, so the companion never uses it:
    /// it stands by the water, waits out a bite, then rolls the catch through
    /// the location's own getFish table and pockets the result.
    /// </summary>
    public static class Fishing
    {
        public static Point? NearestWater(SeiBody body, int radius)
        {
            List<Point> all = WaterTiles(body, radius);
            return all.Count > 0 ? all[0] : (Point?)null;
        }

        /// <summary>Water tiles with a walkable neighbour, nearest first (a fresh farm's pond is often hemmed in by debris on one side).</summary>
        public static List<Point> WaterTiles(SeiBody body, int radius)
        {
            GameLocation loc = body.Npc.currentLocation;
            Vector2 me = body.Npc.Tile;
            var list = new List<(float d, Point p)>();
            for (int dx = -radius; dx <= radius; dx++)
                for (int dy = -radius; dy <= radius; dy++)
                {
                    int x = (int)me.X + dx, y = (int)me.Y + dy;
                    if (!loc.isTileOnMap(x, y) || !loc.isWaterTile(x, y)) continue;
                    if (body.FreeTileNear(loc, new Vector2(x, y), 1) == null) continue;
                    list.Add((Math.Abs(dx) + Math.Abs(dy), new Point(x, y)));
                }
            list.Sort((a, b) => a.d.CompareTo(b.d));
            var outp = new List<Point>();
            foreach (var e in list) outp.Add(e.p);
            return outp;
        }

        public static IEnumerable<object> Fish(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            FishingRod rod = body.FindTool<FishingRod>();
            if (rod == null) { yield return Result.Fail("no fishing rod in the inventory"); yield break; }
            if (body.Shadow.Stamina <= 0f) { yield return Result.Fail("out of energy; eat or sleep before fishing"); yield break; }
            Target t = Targets.Resolve(ctx, out _);
            var candidates = new List<Point>();
            if (t != null && t.HasTile && loc.isWaterTile(t.Tile.X, t.Tile.Y)) candidates.Add(t.Tile);
            else candidates.AddRange(WaterTiles(body, 14));
            if (candidates.Count == 0) { yield return Result.Fail("no water within reach; goTo a river, the pond, or the beach first"); yield break; }
            // Try up to eight shore spots, nearest first: the nearest edge of
            // the pond can be walled off by debris while the far edge is open.
            Point? water = null;
            string lastWalk = null;
            int tries = 0;
            foreach (Point cand in candidates)
            {
                if (tries++ >= 8) break;
                var walk = new Outcome();
                yield return Movement.WalkTo(ctx, cand, true, walk);
                if (ctx.Cancelled) yield break;
                if (walk.Ok) { water = cand; break; }
                lastWalk = walk.Detail;
            }
            if (water == null) { yield return Result.Fail($"could not reach the water's edge ({lastWalk}); clear the debris in the way or try another spot"); yield break; }

            int slot = body.SlotOf(rod);
            if (slot >= 0) body.Shadow.CurrentToolIndex = slot;
            try { loc.playSound("cast", body.Npc.Tile); } catch { }
            int casts = Math.Clamp(ctx.Int("casts") ?? 1, 1, 5);
            var caught = new List<string>();
            for (int c = 0; c < casts; c++)
            {
                if (ctx.Cancelled) yield break;
                int waitMs = Game1.random.Next(4000, 11000);
                int waited = 0;
                while (waited < waitMs)
                {
                    yield return WaitTicks.Ms(500);
                    waited += 500;
                    if (ctx.Cancelled) yield break;
                    if (waited % 3000 == 0) ctx.Progress($"waiting for a bite ({waited / 1000}s)");
                }
                body.Shadow.Stamina = Math.Max(-16f, body.Shadow.Stamina - 8f);
                body.SyncShadow();
                Item fish = null;
                try
                {
                    fish = loc.getFish(0f, null, 3, body.Shadow, 0.0, new Vector2(water.Value.X, water.Value.Y), loc.Name);
                }
                catch (Exception ex)
                {
                    body.Monitor.Log($"{body.Name}: getFish threw: {ex.Message}", StardewModdingAPI.LogLevel.Debug);
                }
                try { loc.playSound("fishBite", body.Npc.Tile); } catch { }
                yield return WaitTicks.Ms(700);
                if (fish == null)
                {
                    ctx.Progress("nothing bit");
                    continue;
                }
                try { loc.playSound("pullItemFromWater", body.Npc.Tile); } catch { }
                string name = fish.DisplayName;
                if (!body.Shadow.couldInventoryAcceptThisItem(fish))
                {
                    yield return Result.Fail(caught.Count > 0 ? $"caught {string.Join(", ", caught)}, then the inventory filled up" : "inventory is full");
                    yield break;
                }
                body.TakeItem(fish);
                try { body.Shadow.gainExperience(1, 6); } catch { }
                caught.Add(name);
                ctx.Progress($"caught {name}");
            }
            yield return caught.Count > 0
                ? Result.Success($"caught {string.Join(", ", caught)}")
                : Result.Fail("nothing bit; try another spot or another time of day");
        }
    }
}
