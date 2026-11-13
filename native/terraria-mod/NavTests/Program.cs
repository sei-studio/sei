// Game-free checks for the companion's path finder (Body/Nav.cs) on ASCII maps.
//   #  solid      =  platform      D  closed door      L  lava
//   S  start (feet)   G  goal (feet)   .  air
// Exit code 0 when every case passes.

using System;
using System.Collections.Generic;
using System.Linq;
using SeiCompanion.Body;

internal sealed class Grid : ITileQuery
{
	private readonly string[] _rows;
	public Grid(params string[] rows) { _rows = rows; }
	public int W => _rows[0].Length;
	public int H => _rows.Length;
	private char At(int x, int y) => InWorld(x, y) ? _rows[y][x] : '#';
	public bool InWorld(int x, int y) => x >= 0 && y >= 0 && y < _rows.Length && x < _rows[y].Length;
	public bool Solid(int x, int y) => At(x, y) == '#';
	public bool Door(int x, int y) => At(x, y) == 'D';
	public bool Floor(int x, int y) => At(x, y) is '#' or '=';
	public bool Platform(int x, int y) => At(x, y) == '=';
	public bool Hazard(int x, int y) => At(x, y) == 'L';
	public (int x, int y) Find(char c)
	{
		for (int y = 0; y < H; y++)
			for (int x = 0; x < _rows[y].Length; x++)
				if (_rows[y][x] == c) return (x, y);
		throw new Exception($"no {c} on the map");
	}
}

internal static class Program
{
	private static int _failed;

	private static void Case(string name, bool expectReach, params string[] rows)
	{
		var g = new Grid(rows.Select(r => r.Replace('S', '.').Replace('G', '.')).ToArray());
		var raw = new Grid(rows);
		var (sx, sy) = raw.Find('S');
		var (gx, gy) = raw.Find('G');
		var path = Nav.Find(g, sx, sy, (x, y) => x == gx && y == gy, (x, y) => Math.Abs(x - gx) + Math.Abs(y - gy), out bool reached) ?? new List<NavStep>();
		bool ok = reached == expectReach;
		if (ok && reached)
		{
			// Every step must stand somewhere the body fits.
			foreach (var s in path)
				if (!Nav.BodyFits(g, s.X, s.Y)) { ok = false; break; }
			var last = path.LastOrDefault();
			if (path.Count > 0 && (last.X != gx || last.Y != gy)) ok = false;
		}
		Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {name}: reached={reached} steps={path.Count} {(path.Count > 0 ? string.Join(" ", path.Take(12)) : "")}");
		if (!ok) _failed++;
	}

	private static int Main()
	{
		Case("flat walk", true,
			"..........",
			"..........",
			".S......G.",
			"##########");
		Case("one-block step", true,
			"..........",
			"..........",
			"......G...",
			".S....#...",
			"##########");
		Case("jump onto a ledge 4 up", true,
			"..........",
			"..........",
			"..........",
			"......G...",
			"......#...",
			"......#...",
			"......#...",
			".S....#...",
			"##########");
		Case("wall too high to jump", false,
			"......#...",
			"......#...",
			"......#...",
			"......#...",
			"......#...",
			"......#...",
			"......#...",
			".S....#.G.",
			"##########");
		Case("gap jump", true,
			"..........",
			"..........",
			"..........",
			"..........",
			".S......G.",
			"####...###",
			"####...###");
		Case("drop down a hole", true,
			"..........",
			"..........",
			".S........",
			"####.#####",
			"....G.....",
			"##########");
		Case("platform: up through it and stand on it", true,
			"..........",
			"..........",
			"....G.....",
			"..=====...",
			"..........",
			".S........",
			"##########");
		Case("drop through a platform", true,
			"..........",
			"..........",
			"..S.......",
			"..=====...",
			"..........",
			"....G.....",
			"##########");
		Case("closed door is passable", true,
			"....#.....",
			"....D.....",
			"....D.....",
			".S..D...G.",
			"##########");
		Case("lava is never crossed", false,
			"..........",
			"..........",
			".S..LLLL..",
			"####LLLL.G",
			"##########");
		Case("tunnel two tall is too low", false,
			"..........",
			"..........",
			"..........",
			".S.#######",
			"..........",
			"........G.",
			"##########");
		Case("tunnel three tall", true,
			"##########",
			"..........",
			"..........",
			".S......G.",
			"##########");
		Console.WriteLine(_failed == 0 ? "all passed" : $"{_failed} failed");
		return _failed == 0 ? 0 : 1;
	}
}
