using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using MegaCrit.Sts2.Core.Map;
using MegaCrit.Sts2.Core.Runs;

namespace Sts2Agent;

public static class MapSerializer
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static string Serialize()
    {
        try
        {
            var runState = RunManager.Instance?.DebugOnlyGetState();
            if (runState == null)
                return JsonSerializer.Serialize(new { error = "No active run" }, JsonOptions);

            var map = runState.Map;
            if (map == null)
                return JsonSerializer.Serialize(new { error = "No map available" }, JsonOptions);

            var visited = new HashSet<(int row, int col)>(
                runState.VisitedMapCoords.Select(c => (c.row, c.col)));

            var currentCoord = runState.CurrentMapCoord;

            var result = new Dictionary<string, object>
            {
                ["act"] = runState.CurrentActIndex + 1,
                ["rows"] = map.GetRowCount(),
                ["cols"] = map.GetColumnCount()
            };

            if (currentCoord.HasValue)
                result["currentCoord"] = new { row = currentCoord.Value.row, col = currentCoord.Value.col };

            result["visitedCoords"] = runState.VisitedMapCoords
                .Select(c => new { row = c.row, col = c.col })
                .ToList();

            // Boss node
            var boss = map.BossMapPoint;
            result["bossCoord"] = new { row = boss.coord.row, col = boss.coord.col };
            if (map.SecondBossMapPoint != null)
            {
                var boss2 = map.SecondBossMapPoint;
                result["secondBossCoord"] = new { row = boss2.coord.row, col = boss2.coord.col };
            }

            // Starting nodes (first row entry points)
            result["startCoords"] = map.startMapPoints
                .Select(p => new { row = p.coord.row, col = p.coord.col })
                .ToList();

            // Collect all points including special ones
            var seen = new HashSet<(int row, int col)>();
            var allPoints = new List<MapPoint>();

            foreach (var point in map.GetAllMapPoints())
            {
                if (seen.Add((point.coord.row, point.coord.col)))
                    allPoints.Add(point);
            }

            // Include boss/starting points if not already yielded
            foreach (var special in new[] { boss, map.SecondBossMapPoint, map.StartingMapPoint })
            {
                if (special != null && seen.Add((special.coord.row, special.coord.col)))
                    allPoints.Add(special);
            }

            var nodes = new List<object>();
            foreach (var point in allPoints)
            {
                var node = new Dictionary<string, object>
                {
                    ["coord"] = new { row = point.coord.row, col = point.coord.col },
                    ["type"] = point.PointType.ToString()
                };

                if (point.Children.Count > 0)
                {
                    node["children"] = point.Children
                        .Select(c => new { row = c.coord.row, col = c.coord.col })
                        .ToList();
                }

                if (visited.Contains((point.coord.row, point.coord.col)))
                    node["visited"] = true;

                nodes.Add(node);
            }

            result["nodes"] = nodes;

            return JsonSerializer.Serialize(result, JsonOptions);
        }
        catch (Exception e)
        {
            return JsonSerializer.Serialize(new { error = e.Message }, JsonOptions);
        }
    }

}
