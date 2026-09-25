using System;
using System.Collections.Generic;
using System.Linq;
using SeiCompanion.Body;

// Minimal runner: no test framework, so it needs no package restore beyond
// the SDK. Exit code 1 on any failure.
internal static class Program
{
    private static int _failed;

    private static void Check(string name, bool ok)
    {
        Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {name}");
        if (!ok) _failed++;
    }

    /// <summary>A map from rows of text: '#' wall, 'P' a farmer, anything else open.</summary>
    private static Func<int, int, bool> Grid(string[] rows, bool farmersBlock)
    {
        return (x, y) =>
        {
            if (y < 0 || y >= rows.Length || x < 0 || x >= rows[y].Length) return false;
            char c = rows[y][x];
            if (c == '#') return false;
            if (c == 'P') return !farmersBlock;
            return true;
        };
    }

    private static bool Contiguous(List<(int X, int Y)> path)
    {
        for (int i = 1; i < path.Count; i++)
            if (Math.Abs(path[i].X - path[i - 1].X) + Math.Abs(path[i].Y - path[i - 1].Y) != 1) return false;
        return true;
    }

    private static int Main()
    {
        // The v0.6.5-beta.2 farmhouse stall: body at (8,9), player at (9,9),
        // goTo (10,10). The straight way crosses the player; the detour must not.
        string[] house =
        {
            "############",
            "#..........#",
            "#.......SP.#",
            "#..........#",
            "############",
        };
        var start = (8, 2);
        var goal = (10, 3);
        var naive = GridPath.Find(start, goal, Grid(house, farmersBlock: false));
        var around = GridPath.Find(start, goal, Grid(house, farmersBlock: true));
        Check("finds a path when farmers do not block", naive != null && naive.First() == start && naive.Last() == goal);
        Check("detour exists around the player", around != null);
        Check("detour never enters the player's tile", around != null && !around.Contains((9, 2)));
        Check("detour starts on the start tile and ends on the goal", around != null && around.First() == start && around.Last() == goal);
        Check("detour is 4-connected", around != null && Contiguous(around));
        Check("detour is shortest (3 steps)", around != null && around.Count == 4);

        // A player standing in a one-tile doorway: no detour (the caller keeps
        // the game's path and steps through them).
        string[] door =
        {
            "#####",
            "#...#",
            "##P##",
            "#...#",
            "#####",
        };
        Check("no detour through a blocked doorway", GridPath.Find((2, 1), (2, 3), Grid(door, farmersBlock: true)) == null);
        Check("the doorway is open when farmers do not block", GridPath.Find((2, 1), (2, 3), Grid(door, farmersBlock: false)) != null);

        // Walls: the route goes round.
        string[] wall =
        {
            "#######",
            "#..#..#",
            "#..#..#",
            "#.....#",
            "#######",
        };
        var r = GridPath.Find((1, 1), (5, 1), Grid(wall, false));
        Check("routes round a wall", r != null && Contiguous(r) && r.Count == 9 && !r.Contains((3, 1)) && !r.Contains((3, 2)));

        // Edge cases.
        Check("start == goal is a one-tile path", GridPath.Find((1, 1), (1, 1), Grid(wall, false))?.Count == 1);
        Check("an impassable goal has no path", GridPath.Find((1, 1), (3, 1), Grid(wall, false)) == null);
        Check("the node budget is honoured", GridPath.Find((0, 0), (500, 500), (x, y) => true, maxNodes: 50) == null);
        Check("an open field is walked in Manhattan distance", GridPath.Find((0, 0), (30, 20), (x, y) => x >= 0 && y >= 0 && x < 64 && y < 64)?.Count == 51);

        // WithinSteps keeps "the free tile beside the player" on their side of
        // a fence. Player P at (2,2); the fence corner blocks (3,2) and (2,3),
        // so the diagonal (3,3) is one tile away but across the fence.
        string[] fence =
        {
            "#####",
            "#...#",
            "#.P#.",
            "#.#..",
            "#....",
        };
        Func<int, int, bool> open = (x, y) => (x, y) == (2, 2) || Grid(fence, false)(x, y);
        Check("an orthogonal neighbour is beside the player", GridPath.WithinSteps((2, 2), (1, 2), open, 2));
        Check("an open diagonal is beside the player", GridPath.WithinSteps((2, 2), (1, 1), open, 2));
        Check("a diagonal across a fence corner is not", !GridPath.WithinSteps((2, 2), (3, 3), open, 2));
        Check("the same tile is reachable the long way round", GridPath.WithinSteps((2, 2), (3, 3), open, 8));
        Check("WithinSteps is true for the start itself", GridPath.WithinSteps((2, 2), (2, 2), open, 0));
        Check("WithinSteps refuses a goal further than the budget", !GridPath.WithinSteps((0, 0), (5, 0), (x, y) => true, 4));
        Check("WithinSteps refuses a blocked goal", !GridPath.WithinSteps((2, 2), (3, 2), open, 2));

        // The detour budget: 4x the game's path, never more than 400.
        Check("detour budget is 4x a mid path", GridPath.DetourBudget(20) == 80);
        Check("detour budget caps at 400", GridPath.DetourBudget(150) == 400 && GridPath.DetourBudget(10000) == 400);
        Check("detour budget has a floor for tiny paths", GridPath.DetourBudget(1) == 16 && GridPath.DetourBudget(0) == 16);
        // The farmhouse detour fits its budget (game path 4 tiles incl. start).
        Check("the farmhouse detour fits its budget", GridPath.Find(start, goal, Grid(house, true), GridPath.DetourBudget(naive.Count)) != null);
        // A detour that needs the whole map gives up inside the budget.
        string[] longWay = new string[41];
        longWay[0] = new string('#', 41);
        longWay[40] = new string('#', 41);
        for (int y = 1; y < 40; y++)
            longWay[y] = "#" + new string('.', 19) + (y == 1 ? "P" : y < 39 ? "#" : ".") + new string('.', 19) + "#";
        var straight = GridPath.Find((18, 1), (22, 1), Grid(longWay, false));
        Check("a straight path through the player exists", straight != null && straight.Count == 5);
        Check("the way round the whole wall is refused within budget", GridPath.Find((18, 1), (22, 1), Grid(longWay, true), GridPath.DetourBudget(straight.Count)) == null);
        Check("and exists with an unbounded search", GridPath.Find((18, 1), (22, 1), Grid(longWay, true), 100000) != null);

        Console.WriteLine(_failed == 0 ? "all passed" : $"{_failed} failed");
        return _failed == 0 ? 0 : 1;
    }
}
