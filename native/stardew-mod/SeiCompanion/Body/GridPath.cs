using System;
using System.Collections.Generic;

namespace SeiCompanion.Body
{
    /// <summary>
    /// A 4-connected A* over tile coordinates with a caller-supplied
    /// passability test. Pure (no game types) so it compiles and is tested
    /// outside the game (native/stardew-mod/GridPathTests).
    ///
    /// Why the mod has its own search next to the game's
    /// PathFindController.findPath: the game's search treats a tile a farmer
    /// stands on as open, while the NPC's step collision refuses to walk into
    /// a farmer. Every path that crossed the player's tile stalled on the tile
    /// before it (v0.6.5-beta.2 playtest, 260924: six "stuck" results, each
    /// with the next path tile equal to the player's tile and both collision
    /// checks false). This search takes an extra blocked set, so a walk can
    /// route around the player instead of into them.
    /// </summary>
    public static class GridPath
    {
        private static readonly (int dx, int dy)[] Steps = { (0, -1), (1, 0), (0, 1), (-1, 0) };

        /// <summary>
        /// Shortest path from `start` to `goal`. Returns the tiles in walking
        /// order, START INCLUDED (the game's path stacks carry the start tile
        /// too), or null when the goal cannot be reached within `maxNodes`
        /// expansions. `passable` is asked about every tile but the start; the
        /// goal must pass it.
        /// </summary>
        public static List<(int X, int Y)> Find((int X, int Y) start, (int X, int Y) goal, Func<int, int, bool> passable, int maxNodes = 4000)
        {
            if (passable == null) throw new ArgumentNullException(nameof(passable));
            if (start == goal) return new List<(int X, int Y)> { start };
            if (!passable(goal.X, goal.Y)) return null;

            var open = new PriorityQueue<(int X, int Y), (int f, int h)>();
            var came = new Dictionary<(int X, int Y), (int X, int Y)>();
            var cost = new Dictionary<(int X, int Y), int> { [start] = 0 };
            var closed = new HashSet<(int X, int Y)>();
            var verdict = new Dictionary<(int X, int Y), bool>();
            open.Enqueue(start, (H(start, goal), H(start, goal)));
            int expanded = 0;
            while (open.Count > 0)
            {
                (int X, int Y) cur = open.Dequeue();
                if (!closed.Add(cur)) continue;
                if (cur == goal) return Rebuild(came, start, goal);
                if (++expanded > maxNodes) return null;
                int g = cost[cur];
                foreach ((int dx, int dy) in Steps)
                {
                    var next = (cur.X + dx, cur.Y + dy);
                    if (closed.Contains(next)) continue;
                    if (!verdict.TryGetValue(next, out bool ok))
                    {
                        ok = passable(next.Item1, next.Item2);
                        verdict[next] = ok;
                    }
                    if (!ok) continue;
                    int ng = g + 1;
                    if (cost.TryGetValue(next, out int old) && old <= ng) continue;
                    cost[next] = ng;
                    came[next] = cur;
                    int h = H(next, goal);
                    // Ties on f go to the node nearer the goal: straighter paths, fewer expansions.
                    open.Enqueue(next, (ng + h, h));
                }
            }
            return null;
        }

        private static int H((int X, int Y) a, (int X, int Y) b) => Math.Abs(a.X - b.X) + Math.Abs(a.Y - b.Y);

        private static List<(int X, int Y)> Rebuild(Dictionary<(int X, int Y), (int X, int Y)> came, (int X, int Y) start, (int X, int Y) goal)
        {
            var path = new List<(int X, int Y)> { goal };
            var cur = goal;
            while (cur != start)
            {
                cur = came[cur];
                path.Add(cur);
            }
            path.Reverse();
            return path;
        }
    }
}
