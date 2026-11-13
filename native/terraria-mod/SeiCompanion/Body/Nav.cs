// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// Side-view A* over tiles for a body one tile wide and three tall. Game-free
// (tiles come through ITileQuery) so NavTests can run it on any machine.
//
// A node (x, y) is the tile the feet occupy; the body fills (x, y-2..y) and
// stands on (x, y+1). Moves: walk, step up one tile, walk off a ledge and fall,
// drop through a platform, and jump (up to MaxJumpUp tiles high, MaxJumpAcross
// tiles across) then land.

using System;
using System.Collections.Generic;

namespace SeiCompanion.Body
{
	public interface ITileQuery
	{
		bool InWorld(int x, int y);
		/// <summary>A tile that blocks the body (solid, not actuated, not a platform, not a closed door).</summary>
		bool Solid(int x, int y);
		/// <summary>A closed door: blocks until opened, which the motor does.</summary>
		bool Door(int x, int y);
		/// <summary>Something the body can stand on: solid, or solid-top (platform, table).</summary>
		bool Floor(int x, int y);
		/// <summary>A solid-top tile the body can drop through.</summary>
		bool Platform(int x, int y);
		/// <summary>Lava or a damaging block: never path through or onto it.</summary>
		bool Hazard(int x, int y);
	}

	public enum Move : byte { Start, Walk, Step, Fall, Drop, Jump }

	public struct NavStep
	{
		public int X, Y;
		public Move Move;
		public NavStep(int x, int y, Move m) { X = x; Y = y; Move = m; }
		public override string ToString() => $"{Move}({X},{Y})";
	}

	public static class Nav
	{
		public const int BodyHeight = 3;
		public const int MaxJumpUp = 5;
		public const int MaxJumpAcross = 4;
		public const int MaxFall = 40;

		private static bool Clear(ITileQuery q, int x, int y, bool doorsOk) =>
			q.InWorld(x, y) && !q.Solid(x, y) && !q.Hazard(x, y) && (doorsOk || !q.Door(x, y));

		public static bool BodyFits(ITileQuery q, int x, int y, bool doorsOk = true)
		{
			for (int k = 0; k < BodyHeight; k++)
				if (!Clear(q, x, y - k, doorsOk)) return false;
			return true;
		}

		public static bool Standable(ITileQuery q, int x, int y) =>
			BodyFits(q, x, y) && q.InWorld(x, y + 1) && q.Floor(x, y + 1) && !q.Hazard(x, y + 1) && !q.Door(x, y + 1);

		/// <summary>First standable feet row at or below y in column x, falling through clear cells only.</summary>
		public static int Land(ITileQuery q, int x, int y, int maxFall = MaxFall, bool throughPlatforms = false)
		{
			for (int d = 0; d <= maxFall; d++)
			{
				int yy = y + d;
				if (!BodyFits(q, x, yy, doorsOk: false)) return int.MinValue;
				if (q.InWorld(x, yy + 1) && q.Floor(x, yy + 1) && !(throughPlatforms && d == 0 && q.Platform(x, yy + 1)))
					return q.Hazard(x, yy + 1) ? int.MinValue : yy;
			}
			return int.MinValue;
		}

		private static long Key(int x, int y) => ((long)x << 32) | (uint)y;

		private struct Rec
		{
			public float G;
			public long Parent;
			public Move Move;
			public int X, Y;
		}

		/// <summary>
		/// Path from (sx, sy) to the first node where goal(x, y) holds. Returns
		/// the steps after the start (empty when the start already satisfies the
		/// goal), or a path to the node closest to the goal by `h` when the goal
		/// is out of reach (reached = false), or null when even that is nothing.
		/// </summary>
		public static List<NavStep> Find(ITileQuery q, int sx, int sy, Func<int, int, bool> goal, Func<int, int, float> h, out bool reached, int maxNodes = 6000)
		{
			reached = false;
			if (!Standable(q, sx, sy))
			{
				int land = Land(q, sx, sy);
				if (land == int.MinValue)
				{
					// Squeezed or mid-air over a pit: try the columns either side.
					foreach (int dx in new[] { 0, -1, 1 })
					{
						for (int dy = -1; dy <= 1; dy++)
						{
							if (Standable(q, sx + dx, sy + dy)) { sx += dx; sy += dy; goto found; }
						}
					}
					return null;
				}
				sy = land;
			}
			found:
			var recs = new Dictionary<long, Rec>();
			var open = new PriorityQueue<long, float>();
			long start = Key(sx, sy);
			recs[start] = new Rec { G = 0, Parent = -1, Move = Move.Start, X = sx, Y = sy };
			open.Enqueue(start, h(sx, sy));
			var closed = new HashSet<long>();
			long best = start;
			float bestH = h(sx, sy);
			int expanded = 0;
			var nbrs = new List<(int x, int y, Move m, float c)>(64);

			while (open.Count > 0 && expanded < maxNodes)
			{
				long k = open.Dequeue();
				if (!closed.Add(k)) continue;
				var cur = recs[k];
				expanded++;
				if (goal(cur.X, cur.Y)) { reached = true; return Build(recs, k); }
				float hh = h(cur.X, cur.Y);
				if (hh < bestH) { bestH = hh; best = k; }

				nbrs.Clear();
				Neighbours(q, cur.X, cur.Y, nbrs);
				foreach (var n in nbrs)
				{
					long nk = Key(n.x, n.y);
					if (closed.Contains(nk)) continue;
					float g = cur.G + n.c;
					if (recs.TryGetValue(nk, out var old) && old.G <= g) continue;
					recs[nk] = new Rec { G = g, Parent = k, Move = n.m, X = n.x, Y = n.y };
					open.Enqueue(nk, g + h(n.x, n.y));
				}
			}
			if (best == start) return goal(sx, sy) ? new List<NavStep>() : null;
			return Build(recs, best);
		}

		private static List<NavStep> Build(Dictionary<long, Rec> recs, long k)
		{
			var path = new List<NavStep>();
			while (k != -1)
			{
				var r = recs[k];
				if (r.Move != Move.Start) path.Add(new NavStep(r.X, r.Y, r.Move));
				k = r.Parent;
			}
			path.Reverse();
			return path;
		}

		public static void Neighbours(ITileQuery q, int x, int y, List<(int x, int y, Move m, float c)> outList)
		{
			for (int dir = -1; dir <= 1; dir += 2)
			{
				int nx = x + dir;
				bool walked = false;
				// Walk level.
				if (Standable(q, nx, y)) { outList.Add((nx, y, Move.Walk, 1f)); walked = true; }
				// Step up one (needs head room above the current column too).
				else if (Standable(q, nx, y - 1) && Clear(q, x, y - BodyHeight, true)) { outList.Add((nx, y - 1, Move.Step, 1.4f)); walked = true; }
				// Walk off a ledge and fall.
				else if (BodyFits(q, nx, y) && !(q.InWorld(nx, y + 1) && q.Floor(nx, y + 1)))
				{
					int land = Land(q, nx, y + 1);
					if (land != int.MinValue) outList.Add((nx, land, Move.Fall, 1f + (land - y) * 0.15f));
				}
				// Jumps: rise H, slide across at the apex, then land.
				for (int hgt = 1; hgt <= MaxJumpUp + 1; hgt++)
				{
					int ay = y - hgt;
					// Head room over the take-off column.
					if (!Clear(q, x, ay - (BodyHeight - 1), false)) break;
					for (int dx = 1; dx <= MaxJumpAcross + 1; dx++)
					{
						int tx = x + dir * dx;
						if (!BodyFits(q, tx, ay, doorsOk: false)) break;
						if (dx == 1 && walked && hgt <= 1) continue;
						int land = Land(q, tx, ay, maxFall: MaxJumpUp + 8);
						if (land == int.MinValue) continue;
						int rise = y - land; // > 0 = landed higher
						if (rise > MaxJumpUp) continue;
						if (rise < -8) continue;
						// Only keep jumps that reach somewhere walking cannot.
						if (dx == 1 && rise <= 1 && walked) continue;
						if (dx == 1 && rise == 0) continue;
						if (rise <= 0 && dx <= 1) continue;
						// Only the lowest apex that works for this landing spot.
						if (rise > 0 && hgt < rise) continue;
						if (hgt > Math.Max(rise, 0) + 2) continue;
						outList.Add((tx, land, Move.Jump, 2f + hgt * 0.4f + dx + Math.Max(0, -rise) * 0.15f));
					}
				}
			}
			// Drop through a platform under the feet.
			if (q.InWorld(x, y + 1) && q.Platform(x, y + 1))
			{
				int land = Land(q, x, y + 1);
				if (land != int.MinValue && land > y) outList.Add((x, land, Move.Drop, 2f + (land - y) * 0.15f));
			}
		}
	}
}
