using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Map;
using MegaCrit.Sts2.Core.Nodes.Screens.Map;
using MegaCrit.Sts2.Core.Localization;
using Godot;
using Sts2Agent.Utilities;
using STS2NeuroIntegration;
using NeuroSdk.Websocket;
using NeuroSdk.Actions;
using System.Text;
using NeuroSdk.Json;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.Context;
using NeuroSdk.Messages.Outgoing;

namespace Sts2Agent.Contexts;

public class MapHandler : IContextHandler<MapHandler.Result>
{
    public class Result : IContextResult
    {
        public NMapPoint Target;
    }
    public ContextType Type => ContextType.Map;

    public ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder mapBuilder = new();
        mapBuilder.AppendLine($"# You are on the map and about to travel somewhere. Act {ctx.RunState.CurrentActIndex + 1}");
        mapBuilder.AppendLine($"Your current position is Row:{ctx.RunState?.CurrentMapCoord.Value.row}, Collumn: {ctx.RunState?.CurrentMapCoord.Value.col}");
        mapBuilder.AppendLine($"You can travel to these locations:");
        int index = 0;
        foreach (var coords in ctx.AvailableMapNodes ?? [])
        {
            mapBuilder.AppendLine();
            mapBuilder.AppendLine($"- '{index}' Room: '{GetMapPointName(coords.PointType)}' {GetMapPointPathDescription(coords)}");
            index++;
        }
        return new ContextReturn(mapBuilder.ToString());
    }

    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        if (ctx.AvailableMapNodes == null) return new CommandReturn();
        if (Plugin.IsMultiplayer())
        {
            var ms = NMapScreen.Instance;
            var player = LocalContext.GetMe(ctx.RunState.Players);
            if (ms == null || player == null || (ms.PlayerVoteDictionary.TryGetValue(player, out var vote) && vote != null))
                return new CommandReturn();
        }
        //This doesn't work in multiplayer
        if (ctx.AvailableMapNodes.Count == 1)
        {
            ActionExecutor.EnqueueAction(new ConstructedAction("select_first_node", ""));
            NeuroIntegration.SendContext("Open map, Only a single travel point available, Moving to: " + GetMapPointName(ctx.AvailableMapNodes[0].PointType) + " Room , Automatically", true);
            return new();
        }

        commands.Add(new("select_map_node", "Select a point to travel to", QJS.WrapObject(new Dictionary<string, JsonSchema>
        {
            ["coordIndex"] = QJS.Type(JsonSchemaType.Integer)
        })));
        StringBuilder forceText = new();
        forceText.AppendLine("Please select a map node to travel to. use this index to choose the location you want to travel to:");
        int index = 0;
        foreach (var item in ctx.AvailableMapNodes)
        {
            var name = GetMapPointName(item.PointType);
            forceText.AppendLine($"- '{index}': {name}");
            index++;
        }


        return new CommandReturn(commands, ForceText: forceText.ToString(), ForcePriority: ActionsForce.Priority.Medium);
    }


    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {
        var sceneRoot = SceneHelper.GetSceneRoot();
        if (sceneRoot == null)
            return ExecutionResult.Failure("Cannot access scene tree");
        if (action.Name == "select_first_node")
        {
            if (ctx.AvailableMapNodes == null || ctx.AvailableMapNodes.Count == 0)
                return ExecutionResult.Unstable("No available map nodes to select");
            Plugin.Log("Validating single available map node selection");
            var target = ctx.AvailableMapNodes[0];
            var mapPointNodes = UiHelper.FindAll<NMapPoint>(sceneRoot);
            var targetNode = mapPointNodes.FirstOrDefault(mp =>
                mp.Point.coord.row == target.coord.row && mp.Point.coord.col == target.coord.col);

            if (targetNode == null)
                return ExecutionResult.Failure($"Map node UI element not found for ({target.coord.row}, {target.coord.col})");
            Plugin.Log("Only one map node available, automatically selecting it");

            Plugin.Log($"Automatically selected the only available map node ({target.coord.row}, {target.coord.col})");
            parsedData.Target = targetNode;
            return ExecutionResult.Success();
        }
        if (action.Name != "select_map_node") return ExecutionResult.ModFailure("Unknown action called in the map");
        if (data.Data?["coordIndex"]?.GetValue<int>() is not int index)
        {
            return ExecutionResult.Failure("Missing parameter: coordIndex");
        }
        if (index < 0 || index >= ctx.AvailableMapNodes.Count)
        {
            return ExecutionResult.Failure("The coordIndex parameter is out of range");
        }
        try
        {
            var target = ctx.AvailableMapNodes[index];
            if (target == null)
            {
                return ExecutionResult.Failure("Couldn't find the specified node");
            }
            var mapPointNodes = UiHelper.FindAll<NMapPoint>(sceneRoot);
            var targetNode = mapPointNodes.FirstOrDefault(mp =>
                mp.Point.coord.row == target.coord.row && mp.Point.coord.col == target.coord.col);

            if (targetNode == null)
                return ExecutionResult.Failure($"Map node UI element not found for ({target.coord.row}, {target.coord.col})");
            Plugin.Log($"Selected map node {index} ({target.coord.row}, {target.coord.col})");
            parsedData.Target = targetNode;

        }
        catch (Exception e)
        {
            return ExecutionResult.Failure($"Failed to validate coord: {e.Message}");
        }
        return ExecutionResult.Success();
    }
    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)
    {
        await Task.Delay(100);
        await GodotMainThread.ClickAsync(result.Target);
        // Skip waiting in Multiplayer as we need to wait for all votes anyway
        if (!Plugin.IsMultiplayer())
        {
            // Wait for travel to start (IsTravelEnabled becomes false) or map to close
            for (int i = 0; i < 100; i++)
            {
                var ms = NMapScreen.Instance;
                if (ms == null || !ms.IsOpen || !ms.IsTravelEnabled)
                    break;
                await Task.Delay(100);
            }
        }
        return ExecutionResult.Success("Map node selected");
    }

    // Sei: internal (was private) so Sei/SeiState.cs can label map options.
    internal static string GetMapPointName(MapPointType pointType)
    {
        var locKey = pointType switch
        {
            MapPointType.Unknown => "LEGEND_UNKNOWN",
            MapPointType.Shop => "LEGEND_MERCHANT",
            MapPointType.Treasure => "LEGEND_TREASURE",
            MapPointType.RestSite => "LEGEND_REST",
            MapPointType.Monster => "LEGEND_ENEMY",
            MapPointType.Elite => "LEGEND_ELITE",
            _ => null
        };
        if (locKey == null) return pointType.ToString();
        return TextHelper.StripBBCode(new LocString("map", locKey + ".title").GetFormattedText());
    }


    private static string GetMapPointPathDescription(MapPoint point)
    {
        var paths = new List<List<MapPoint>>();

        void FindPaths(MapPoint current, List<MapPoint> path)
        {
            path.Add(current);
            if (current.PointType == MapPointType.Boss || current.Children.Count == 0)
            {
                paths.Add([.. path]);
            }
            else
            {
                foreach (var child in current.Children.OrderBy(p => p.coord.row).ThenBy(p => p.coord.col))
                    FindPaths(child, path);
            }

            path.RemoveAt(path.Count - 1);
        }

        // Children are the only legal next choices and always point toward the boss.
        // The selected point is the route origin, so it is not part of any path summary.
        foreach (var child in point.Children.OrderBy(p => p.coord.row).ThenBy(p => p.coord.col))
            FindPaths(child, []);
        if (paths.Count == 0)
            return " [no onward path]";

        MapPointType[] typeOrder =
        [
            MapPointType.Monster,
            MapPointType.Elite,
            MapPointType.Shop,
            MapPointType.RestSite,
            MapPointType.Treasure,
            MapPointType.Unknown,
            MapPointType.Boss
        ];

        var encounterSummary = new List<string>();
        foreach (var type in typeOrder)
        {
            var counts = paths
                .Select(path => path.Count(p => p.PointType == type))
                .ToList();
            var minimum = counts.Min();
            var maximum = counts.Max();
            if (maximum == 0)
                continue;

            var countText = minimum == maximum ? minimum.ToString() : $"{minimum}-{maximum}";
            //Don't add the boss. as every path will lead to the boss, and there is only 1
            if (type != MapPointType.Boss)
                encounterSummary.Add($"{countText} {GetPathPointTypeName(type, maximum)}");
        }
        if (encounterSummary.Count == 0)
            encounterSummary.Add("no classified rooms");

        var specialMarkers = paths
            .SelectMany(path => path)
            .SelectMany(pathPoint => pathPoint.Quests.Select(quest =>
                $"{quest.GetType().Name} ({quest.Id.Entry}) at [{pathPoint.coord.row},{pathPoint.coord.col}]"))
            .Distinct()
            .OrderBy(marker => marker)
            .ToList();

        var description = $"Going down this route you will run into: {string.Join(", ", encounterSummary)}";
        if (specialMarkers.Count > 0)
            description += $"; special markers: {string.Join(", ", specialMarkers)}";

        //Distances along the path to the first encounter of each type.
        {
            var firstDistanceByType = new Dictionary<MapPointType, int>();
            var queue = new Queue<(MapPoint point, int distance)>();
            var visited = new HashSet<MapPoint>();
            // The selected point is the first travel step, but is excluded from the reported distances.
            queue.Enqueue((point, 1));

            while (queue.Count > 0)
            {
                var (current, distance) = queue.Dequeue();
                if (!visited.Add(current))
                    continue;

                if (current != point)
                    firstDistanceByType.TryAdd(current.PointType, distance);
                foreach (var child in current.Children)
                    queue.Enqueue((child, distance + 1));
            }

            var distances = typeOrder
                .Where(firstDistanceByType.ContainsKey)
                .Select(type => type != MapPointType.Boss ? $"first {GetPathPointTypeName(type, 1)} in {firstDistanceByType[type]} step{(firstDistanceByType[type] == 1 ? "" : "s")}" : "Boss in " + firstDistanceByType[type] + " step" + (firstDistanceByType[type] == 1 ? "" : "s"))
                .ToList();
            if (distances.Count > 0)
                description += $"; distances: {string.Join(", ", distances)}";
        }

        return description + "]";
    }

    private static string GetPathPointTypeName(MapPointType pointType, int count)
    {
        var plural = count != 1;
        return pointType switch
        {
            MapPointType.Monster => plural ? "Enemies" : "Enemy",
            MapPointType.Elite => plural ? "Elites" : "Elite",
            MapPointType.Shop => plural ? "Shops" : "Shop",
            MapPointType.RestSite => plural ? "Rest Sites" : "Rest Site",
            MapPointType.Treasure => plural ? "Treasures" : "Treasure",
            MapPointType.Unknown => plural ? "Unknown Events" : "Unknown Event",
            _ => pointType.ToString()
        };
    }

}
