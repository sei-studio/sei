using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Runs;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using System.Text;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Screens.TreasureRoomRelic;
using NeuroSdk.Json;

namespace Sts2Agent.Contexts;

public class TreasureHandler : IContextHandler<TreasureHandler.Result>
{
    public class Result : IContextResult
    {
        public NProceedButton ProceedButton;
        public NTreasureRoomRelicHolder RelicButton;
    }

    public ContextType Type => ContextType.Treasure;


    public static List<NTreasureRoomRelicHolder> FoundRelics { get; set; } = [];

    public ContextReturn GetContext(ContextInfo ctx)
    {
        if (Plugin.IsMultiplayer() && FoundRelics.Count > 0 && FoundRelics.All(GodotObject.IsInstanceValid))
        {
            StringBuilder sb = new();
            sb.AppendLine("Relics in treasure room:");
            for (int i = 0; i < FoundRelics.Count; i++)
            {
                NTreasureRoomRelicHolder? relic = FoundRelics[i];
                if (relic == null || !GodotObject.IsInstanceValid(relic) || !relic.IsEnabled || !relic.Visible)
                    continue;
                sb.AppendLine($"- '{i}' {TextHelper.SafeLocString(() => relic.Relic.Model.Title)}: {TextHelper.GetRelicDescription(relic.Relic.Model)}");
            }
            return new ContextReturn(sb.ToString());

        }
        return new ContextReturn("");
    }
    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();

        var room = TreasureRoomAutoPatch.CurrentRoom;
        if (room != null && GodotObject.IsInstanceValid(room) && room.ProceedButton?.IsEnabled == true)
            commands.Add(new("proceed", "Leave the treasure room"));

        if (FoundRelics.Count > 0 && FoundRelics.All(GodotObject.IsInstanceValid))
        {
            var schema = QJS.WrapObject(new Dictionary<string, JsonSchema>()
            {
                ["treasure_index"] = QJS.Type(JsonSchemaType.Integer),
            }, false);
            schema.Required = ["treasure_index"];
            commands.Add(new("take_relic", "Take a relic from the treasure room", schema));
        }

        return new CommandReturn(commands);
    }


    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {
        if (action.Name == "proceed")
        {

            var room = TreasureRoomAutoPatch.CurrentRoom;
            if (room == null || !GodotObject.IsInstanceValid(room))
                return ExecutionResult.Failure("No treasure room");

            var button = room.ProceedButton;
            if (button == null || !button.IsEnabled)
                return ExecutionResult.Failure("Proceed button not available");
            parsedData.ProceedButton = button;
            return ExecutionResult.Success();
        }
        if (action.Name == "take_relic")
        {
            var treasureindex = data.GetValue("treasure_index", -1);
            if (treasureindex < 0)
                return ExecutionResult.Failure("Missing or invalid treasure_index");

            if (treasureindex < 0 || treasureindex >= FoundRelics.Count)
                return ExecutionResult.Failure($"Invalid treasure_index {treasureindex}, must be between 0 and {FoundRelics.Count - 1}");

            var relic = FoundRelics[treasureindex];
            if (!GodotObject.IsInstanceValid(relic) || !relic.IsEnabled || !relic.Visible)
                return ExecutionResult.Failure($"Relic at index {treasureindex} is not available to click");

            Plugin.Log($"Clicking relic at index {treasureindex}: {TextHelper.SafeLocString(() => relic.Relic.Model.Title)}");
            parsedData.RelicButton = relic;
            return ExecutionResult.Success();
        }
        return ExecutionResult.Unstable($"Unknown action {action.Name}");
    }

    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)
    {
        if (action.Name == "proceed")
            return await Proceed(result, ctx);
        if (action.Name == "take_relic")
            return await TakeRelic(result, ctx);
        return null;
    }

    private async Task<ExecutionResult> Proceed(Result result, ContextInfo ctx)
    {
        await GodotMainThread.ClickAsync(result.ProceedButton);
        Plugin.Log("Clicked proceed on treasure room");
        return ExecutionResult.Success();
    }
    private async Task<ExecutionResult> TakeRelic(Result result, ContextInfo ctx)
    {
        FoundRelics = []; // Clear the list of found relics after taking one, since the room will change
        await GodotMainThread.ClickAsync(result.RelicButton);
        Plugin.Log($"Clicked relic: {TextHelper.SafeLocString(() => result.RelicButton.Relic.Model.Title)}");
        //Wait for the proceed button to become enabled (relic awarding is async)
        int attempts = 0;
        while (true)
        {
            var proceedReady = await GodotMainThread.RunAsync(() =>
                GodotObject.IsInstanceValid(TreasureRoomAutoPatch.CurrentRoom) && TreasureRoomAutoPatch.CurrentRoom.ProceedButton?.IsEnabled == true);
            if (proceedReady)
                break;
            await Task.Delay(500);
            attempts++;
            if (attempts > 20)
                return ExecutionResult.Unstable("Timed out waiting for proceed button to become enabled after taking relic");
        }
        return ExecutionResult.Success();
    }
}

