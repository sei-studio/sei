using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using SeiCompanion.Body;

namespace SeiCompanion.Actions
{
    /// <summary>Walking on one map and travelling across maps. Both write an Outcome rather than finishing the command.</summary>
    public static class Movement
    {
        /// <summary>Ticks of no movement while a controller is live before a walk counts as stuck (2.5 s).</summary>
        private const int StuckTicks = 150;
        private const int WalkTimeoutTicks = 60 * 25;
        /// <summary>Ticks stalled with a farmer on the next tile before re-routing around them (0.5 s).</summary>
        private const int FarmerRepathTicks = 30;
        /// <summary>Fresh path searches one walk may make after a stall.</summary>
        private const int MaxRepaths = 2;

        private static bool NextTileHasFarmer(SeiBody body, GameLocation loc, NPC npc)
        {
            try
            {
                var path = npc.controller?.pathToEndPoint;
                if (path == null || path.Count == 0) return false;
                Point next = path.Peek();
                if (next == npc.TilePoint && path.Count > 1)
                    next = path.ElementAt(1);
                return body.FarmerOn(loc, next);
            }
            catch { return false; }
        }

        /// <summary>
        /// Walk to a tile on the current map. With `adjacentOk` the walk ends on
        /// any tile touching the target (what every tool verb wants: you stand
        /// beside a rock, not on it). Retargets once through the neighbours when
        /// the first path fails, then reports stuck / no path.
        /// </summary>
        public static IEnumerable<object> WalkTo(ActionContext ctx, Point target, bool adjacentOk, Outcome o)
        {
            SeiBody body = ctx.Body;
            NPC npc = body.Npc;
            GameLocation loc = npc.currentLocation;
            Point here = npc.TilePoint;
            // A tile a farmer stands on is never a place to stand: the NPC
            // cannot step into a farmer, so "go to the player's tile" (the
            // model's goTo(x,y) with the owner's coordinates, measured 260924)
            // means "go next to it".
            if (body.FarmerOn(loc, target))
                adjacentOk = true;
            int need = adjacentOk ? 1 : 0;
            if (Targets.Chebyshev(here, target) <= need)
            {
                body.Shadow.FaceToward(new Vector2(target.X, target.Y));
                npc.faceDirection(body.Shadow.FacingDirection);
                o.Pass("already there");
                yield break;
            }

            var goals = new List<Point>();
            if (!adjacentOk && body.IsWalkable(loc, new Vector2(target.X, target.Y)))
                goals.Add(target);
            // Neighbours nearest to us first so the body approaches from its
            // side; none a farmer stands on.
            HashSet<Point> occupied = body.FarmerTiles(loc);
            var ring = new List<Point>();
            for (int dx = -1; dx <= 1; dx++)
                for (int dy = -1; dy <= 1; dy++)
                {
                    if (dx == 0 && dy == 0) continue;
                    var p = new Point(target.X + dx, target.Y + dy);
                    if (occupied.Contains(p)) continue;
                    if (body.IsWalkable(loc, new Vector2(p.X, p.Y))) ring.Add(p);
                }
            ring.Sort((a, b) => Targets.Chebyshev(a, here).CompareTo(Targets.Chebyshev(b, here)));
            if (adjacentOk || goals.Count == 0)
                goals.AddRange(ring);
            if (goals.Count == 0)
            {
                o.Fail($"no walkable tile next to {Targets.Fmt(target)}");
                yield break;
            }

            bool pathed = false;
            Point goal = goals[0];
            foreach (Point g in goals)
            {
                // Standing on a goal already: drop any leftover controller (a
                // follow walk) or the loop below would wait on it.
                if (Targets.Chebyshev(here, g) == 0) { npc.controller = null; pathed = true; goal = g; break; }
                if (body.TryPath(g, null)) { pathed = true; goal = g; break; }
            }
            if (!pathed)
            {
                o.Fail($"no path to {Targets.Fmt(target)} from {Targets.Fmt(here)}; something is in the way (water, a fence, a cliff)");
                yield break;
            }

            int stuck = 0;
            int ticks = 0;
            int repaths = 0;
            // The budget scales with the route: a flat 25 s lost a 68-tile
            // crossing of the farm at NPC speed (measured 260910, "gave up
            // walking to (80,15) after 25s" on the way to town).
            int pathLen = npc.controller?.pathToEndPoint?.Count ?? 0;
            int timeoutTicks = Math.Max(WalkTimeoutTicks, pathLen * 60);
            Vector2 last = npc.Position;
            while (npc.controller != null)
            {
                yield return null;
                if (ctx.Cancelled) yield break;
                ticks++;
                if (Vector2.Distance(npc.Position, last) < 0.25f) stuck++; else stuck = 0;
                last = npc.Position;
                // Stalled against a farmer (the player walked into the path):
                // route around them from here before BarrierHop's step-through.
                if (stuck == FarmerRepathTicks && repaths < MaxRepaths && NextTileHasFarmer(body, loc, npc))
                {
                    repaths++;
                    if (body.TryPath(goal, null)) { stuck = 0; continue; }
                }
                if (stuck > StuckTicks && repaths < MaxRepaths)
                {
                    // One fresh search from where the body stands before
                    // giving up: what was in the way may have moved.
                    repaths++;
                    if (body.TryPath(goal, null)) { stuck = 0; continue; }
                }
                if (stuck > StuckTicks)
                {
                    // Name what stopped the step (the tile the controller wanted
                    // next and both collision verdicts) so a stall in a live
                    // run can be read off the SMAPI log.
                    try
                    {
                        Point nextTile = npc.controller?.pathToEndPoint != null && npc.controller.pathToEndPoint.Count > 0 ? npc.controller.pathToEndPoint.Peek() : new Point(-1, -1);
                        string what = "";
                        if (nextTile.X >= 0)
                        {
                            var v = new Vector2(nextTile.X, nextTile.Y);
                            var rect = new Rectangle(nextTile.X * 64 + 8, nextTile.Y * 64 + 8, 48, 48);
                            bool npcCol = loc.isCollidingPosition(rect, Game1.viewport, false, 0, false, npc, true, false, false);
                            bool farmerCol = loc.isCollidingPosition(rect, Game1.viewport, true, 0, false, body.Shadow, true, false, false);
                            bool farmerOn = body.FarmerOn(loc, nextTile);
                            loc.objects.TryGetValue(v, out StardewValley.Object obj);
                            loc.terrainFeatures.TryGetValue(v, out StardewValley.TerrainFeatures.TerrainFeature tf);
                            what = $" next {Targets.Fmt(nextTile)} npcCol={npcCol} farmerCol={farmerCol} farmerOn={farmerOn} object={obj?.Name ?? "-"} feature={tf?.GetType().Name ?? "-"} repaths={repaths}";
                        }
                        body.Monitor.Log($"{body.Name}: stuck at {Targets.Fmt(npc.TilePoint)} heading to {Targets.Fmt(target)}{what}", StardewModdingAPI.LogLevel.Debug);
                    }
                    catch { }
                    npc.controller = null;
                    // Stuck, but already beside what we walked to: that is an
                    // arrival (the last step was into the player, 260924).
                    if (adjacentOk && Targets.Chebyshev(npc.TilePoint, target) <= 1)
                    {
                        npc.speed = 2;
                        body.Shadow.FaceToward(new Vector2(target.X, target.Y));
                        npc.faceDirection(body.Shadow.FacingDirection);
                        o.Pass("arrived");
                        yield break;
                    }
                    o.Fail($"stuck on the way to {Targets.Fmt(target)} at {Targets.Fmt(npc.TilePoint)}");
                    yield break;
                }
                if (ticks > timeoutTicks)
                {
                    npc.controller = null;
                    o.Fail($"gave up walking to {Targets.Fmt(target)} after {timeoutTicks / 60}s");
                    yield break;
                }
            }
            npc.speed = 2;
            if (Targets.Chebyshev(npc.TilePoint, target) <= Math.Max(need, 1))
            {
                body.Shadow.FaceToward(new Vector2(target.X, target.Y));
                npc.faceDirection(body.Shadow.FacingDirection);
                o.Pass("arrived");
            }
            else
            {
                o.Fail($"ended at {Targets.Fmt(npc.TilePoint)}, not next to {Targets.Fmt(target)}");
            }
        }

        /// <summary>Cross-map travel through the warp graph, then optionally to a tile in the destination.</summary>
        public static IEnumerable<object> Travel(ActionContext ctx, string locationName, Point? tile, Outcome o = null)
        {
            o = o ?? new Outcome();
            SeiBody body = ctx.Body;
            NPC npc = body.Npc;
            if (!string.Equals(body.LocationName, locationName, StringComparison.OrdinalIgnoreCase))
            {
                List<Hop> route = Router.FindRoute(npc.currentLocation, locationName);
                if (route == null)
                {
                    o.Fail($"no known route from {body.LocationName} to {locationName}");
                    yield break;
                }
                // A commanded trip (ctx.Id set) to a map the followed player is
                // not on puts following ON HOLD until they move on (see
                // SeiBody.FollowHoldAt); it used to end following for good.
                // The follow tick's own background travel keeps its target.
                if (ctx.Id != null && route.Count > 0)
                    body.HoldFollowForTrip(locationName);
                foreach (Hop hop in route)
                {
                    if (ctx.Cancelled) yield break;
                    if (ctx.Id != null) ctx.Progress($"heading to {hop.TargetName} via {hop.From.NameOrUniqueName} {Targets.Fmt(hop.StandTile)}");
                    var walk = new Outcome();
                    yield return WalkTo(ctx, hop.StandTile, true, walk);
                    if (!walk.Ok)
                    {
                        o.Fail($"could not reach the way out of {hop.From.NameOrUniqueName}: {walk.Detail}");
                        yield break;
                    }
                    body.WarpTo(hop.TargetName, hop.TargetTile);
                    body.Session?.SendEvent("warped", new Dictionary<string, object> { ["location"] = body.LocationName });
                    yield return WaitTicks.Ms(250);
                }
            }
            if (tile.HasValue)
            {
                var walk = new Outcome();
                yield return WalkTo(ctx, tile.Value, true, walk);
                if (!walk.Ok) { o.Fail(walk.Detail); yield break; }
            }
            o.Pass($"in {body.LocationName}");
        }

        /// <summary>The result suffix for a trip that put following on hold, else "".</summary>
        public static string FollowHoldNote(SeiBody body)
        {
            if (body.FollowTarget == null || body.FollowHoldAt == null)
                return "";
            return $" (following {body.FollowTarget} is on hold while they stay in {body.FollowHoldAt}; it picks up again when they leave it or come to you. Call unfollow to stop for good)";
        }

        /// <summary>goTo: a tile, a handle, or another location.</summary>
        public static IEnumerable<object> GoTo(ActionContext ctx)
        {
            Target t = Targets.Resolve(ctx, out string err);
            if (t == null) { yield return Result.Fail(err); yield break; }
            SeiBody body = ctx.Body;
            var o = new Outcome();
            if (!string.Equals(t.LocationName, body.LocationName, StringComparison.OrdinalIgnoreCase))
            {
                yield return Travel(ctx, t.LocationName, t.HasTile ? t.Tile : (Point?)null, o);
                yield return o.Ok ? Result.Success($"arrived in {body.LocationName} at {Targets.Fmt(body.Npc.TilePoint)}{FollowHoldNote(body)}") : Result.Fail(o.Detail);
                yield break;
            }
            if (!t.HasTile) { yield return Result.Success($"already in {body.LocationName}"); yield break; }
            bool adjacent = t.Handle != null || !body.IsWalkable(body.Npc.currentLocation, t.TileVec);
            yield return WalkTo(ctx, t.Tile, adjacent, o);
            yield return o.Ok ? Result.Success($"at {Targets.Fmt(body.Npc.TilePoint)}") : Result.Fail(o.Detail);
        }

        /// <summary>come: walk to the player, across maps if needed.</summary>
        public static IEnumerable<object> Come(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            Farmer who = body.ResolvePlayer(ctx.Str("player"));
            if (who?.currentLocation == null) { yield return Result.Fail("cannot see the player"); yield break; }
            var o = new Outcome();
            if (who.currentLocation != body.Npc.currentLocation)
            {
                yield return Travel(ctx, who.currentLocation.NameOrUniqueName, null, o);
                if (!o.Ok) { yield return Result.Fail(o.Detail); yield break; }
            }
            yield return WalkTo(ctx, who.TilePoint, true, o);
            // They kept walking while we came: one more leg to where they are now.
            if (o.Ok && who.currentLocation == body.Npc.currentLocation && Targets.Chebyshev(body.Npc.TilePoint, who.TilePoint) > 2)
            {
                o = new Outcome();
                yield return WalkTo(ctx, who.TilePoint, true, o);
            }
            yield return o.Ok ? Result.Success($"next to {who.Name}") : Result.Fail(o.Detail);
        }
    }
}
