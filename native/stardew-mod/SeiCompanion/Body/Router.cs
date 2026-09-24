using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;

namespace SeiCompanion.Body
{
    /// <summary>One hop of a cross-map route: walk to a tile in `From`, then warp into `TargetName` at `TargetTile`.</summary>
    public sealed class Hop
    {
        public GameLocation From;
        public Point StandTile;
        public string TargetName;
        public Point TargetTile;
    }

    /// <summary>
    /// Cross-map routing over the world's warp graph. The game's own
    /// WarpPathfindingCache.GetLocationRoute deliberately ignores the Farm
    /// (NPC schedules never cross it), so it cannot route the companion home;
    /// a breadth-first search over every location's `warps` plus its building
    /// `doors` covers the farm, the town, the mines entrance and shop doors.
    /// No prior body routed across maps (both teleported); this does.
    /// </summary>
    public static class Router
    {
        private const int MaxDepth = 8;

        public static List<Hop> FindRoute(GameLocation from, string toName)
        {
            if (from == null || string.IsNullOrEmpty(toName))
                return null;
            if (string.Equals(from.NameOrUniqueName, toName, StringComparison.OrdinalIgnoreCase) || string.Equals(from.Name, toName, StringComparison.OrdinalIgnoreCase))
                return new List<Hop>();

            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { from.NameOrUniqueName };
            var queue = new Queue<(GameLocation loc, List<Hop> path)>();
            queue.Enqueue((from, new List<Hop>()));
            while (queue.Count > 0)
            {
                (GameLocation loc, List<Hop> path) = queue.Dequeue();
                if (path.Count >= MaxDepth)
                    continue;
                foreach (Hop hop in Exits(loc))
                {
                    if (hop.TargetName == null || visited.Contains(hop.TargetName))
                        continue;
                    var next = new List<Hop>(path) { hop };
                    if (string.Equals(hop.TargetName, toName, StringComparison.OrdinalIgnoreCase))
                        return next;
                    GameLocation target = Game1.getLocationFromName(hop.TargetName);
                    if (target == null)
                        continue;
                    visited.Add(hop.TargetName);
                    queue.Enqueue((target, next));
                }
            }
            return null;
        }

        /// <summary>Every warp out of a location, doors included, deduplicated by target.</summary>
        public static IEnumerable<Hop> Exits(GameLocation loc)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (loc.warps != null)
            {
                foreach (Warp w in loc.warps)
                {
                    if (w == null || string.IsNullOrEmpty(w.TargetName) || !seen.Add(w.TargetName))
                        continue;
                    yield return new Hop
                    {
                        From = loc,
                        StandTile = new Point(w.X, w.Y),
                        TargetName = w.TargetName,
                        TargetTile = new Point(w.TargetX, w.TargetY),
                    };
                }
            }
            // Buildings with an inside (the farmhouse, coops, barns, sheds):
            // their human door is not in `warps` nor in `doors`. Stand on the
            // tile below the door and land where the inside's exit warp
            // points back at us. Without this, nothing routed HOME from the
            // farm (measured 260910: "no known route from Farm to FarmHouse").
            if (loc.buildings != null)
            {
                foreach (StardewValley.Buildings.Building b in loc.buildings)
                {
                    GameLocation inside = null;
                    try { inside = b?.GetIndoors(); } catch { }
                    if (inside == null || b.humanDoor.Value.X < 0) continue;
                    string target = inside.NameOrUniqueName;
                    if (string.IsNullOrEmpty(target) || !seen.Add(target)) continue;
                    Point landing = new Point(-1, -1);
                    if (inside.warps != null)
                    {
                        foreach (Warp back in inside.warps)
                        {
                            if (back != null && (string.Equals(back.TargetName, loc.Name, StringComparison.OrdinalIgnoreCase) || string.Equals(back.TargetName, loc.NameOrUniqueName, StringComparison.OrdinalIgnoreCase)))
                            {
                                landing = new Point(back.X, Math.Max(0, back.Y - 1));
                                break;
                            }
                        }
                    }
                    if (landing.X < 0) continue;
                    yield return new Hop
                    {
                        From = loc,
                        StandTile = new Point(b.tileX.Value + b.humanDoor.Value.X, b.tileY.Value + b.humanDoor.Value.Y + 1),
                        TargetName = target,
                        TargetTile = landing,
                    };
                }
            }
            // Building doors (farm buildings, shop fronts) are not in `warps`;
            // the door tile carries the target name and the target's own exit
            // warp back to us tells us where to stand inside.
            if (loc.doors != null)
            {
                foreach (KeyValuePair<Point, string> pair in loc.doors.Pairs)
                {
                    string target = pair.Value;
                    if (string.IsNullOrEmpty(target) || !seen.Add(target))
                        continue;
                    GameLocation inside = Game1.getLocationFromName(target);
                    Point landing = new Point(-1, -1);
                    if (inside?.warps != null)
                    {
                        foreach (Warp back in inside.warps)
                        {
                            if (back != null && string.Equals(back.TargetName, loc.Name, StringComparison.OrdinalIgnoreCase))
                            {
                                landing = new Point(back.X, Math.Max(0, back.Y - 1));
                                break;
                            }
                        }
                    }
                    if (landing.X < 0)
                        continue;
                    yield return new Hop
                    {
                        From = loc,
                        StandTile = pair.Key,
                        TargetName = target,
                        TargetTile = landing,
                    };
                }
            }
        }

        /// <summary>The warp out of `loc` nearest to `tile`, or null.</summary>
        public static Hop NearestExit(GameLocation loc, Vector2 tile, string targetName = null)
        {
            Hop best = null;
            float bestDist = float.MaxValue;
            foreach (Hop hop in Exits(loc))
            {
                if (targetName != null && !string.Equals(hop.TargetName, targetName, StringComparison.OrdinalIgnoreCase))
                    continue;
                float d = Vector2.Distance(tile, new Vector2(hop.StandTile.X, hop.StandTile.Y));
                if (d < bestDist)
                {
                    bestDist = d;
                    best = hop;
                }
            }
            return best;
        }
    }
}
