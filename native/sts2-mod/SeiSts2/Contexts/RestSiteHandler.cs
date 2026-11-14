using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.RestSite;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Nodes.Screens.Overlays;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using System.Text;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Nodes.Multiplayer;
using MegaCrit.Sts2.Core.Nodes.Combat;

namespace Sts2Agent.Contexts;

public class RestSiteHandler : IContextHandler<RestSiteHandler.Result>
{
    private const BindingFlags NonPublicInstance = BindingFlags.NonPublic | BindingFlags.Instance;
    private static readonly MethodInfo? FinishTargetingMethod =
        typeof(NTargetManager).GetMethod("FinishTargeting", NonPublicInstance);

    public class Result : IContextResult
    {
        internal NRestSiteButton SelectedOption;
        internal NProceedButton ProceedButton;
    }
    public ContextType Type => ContextType.RestSite;

    public ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();
        stringBuilder.AppendLine("You are at a rest site. You can choose only one action here. The others will be locked for this rest site.");

        var player = LocalContext.GetMe(ctx.RunState.Players);
        if (player != null)
            stringBuilder.AppendLine($"# You currently have {player.Creature.CurrentHp} HP out of {player.Creature.MaxHp} max HP and {player.Creature.Block} Block");
        return new ContextReturn(stringBuilder.ToString());
    }
    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        var restRoom = ctx.RestSiteRoom;
        if (restRoom == null) return new CommandReturn();

        foreach (var opt in restRoom.Options)
        {
            if (opt.IsEnabled)
            {
                commands.Add(new($"rest_option_{opt.OptionId.ToLowerInvariant()}", $"{TextHelper.SafeLocString(() => opt.Title)} - {TextHelper.SafeLocString(() => opt.Description)}"));
            }
        }

        var nRestSiteRoom = FindNRestSiteRoom();
        if (nRestSiteRoom?.ProceedButton?.IsEnabled == true)
            commands.Add(new("proceed", "Proceed from the rest site. Any remaining options will be ignored."));


        return new CommandReturn(commands, ForceText: "Please choose an Available Rest Site Option, You can only choose one. The others will be disabled once you select something.");
    }

    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {

        if (action.Name.StartsWith("rest_option_"))
        {
            var option = action.Name.Replace("rest_option_", "");

            var sceneRoot = SceneHelper.GetSceneRoot();
            if (sceneRoot == null)
                return ExecutionResult.Failure("Cannot access scene tree");

            var buttons = UiHelper.FindAll<NRestSiteButton>(sceneRoot)
                .Where(b => b.Option.IsEnabled && b.IsVisibleInTree())
                .ToList();

            if (buttons.Count == 0)
                return ExecutionResult.Failure("No rest site options available");

            var match = buttons.FirstOrDefault(b =>
                b.Option.OptionId.Equals(option, StringComparison.OrdinalIgnoreCase));

            if (match == null)
            {
                if (int.TryParse(option, out var idx) && idx >= 0 && idx < buttons.Count)
                    match = buttons[idx];
                else
                    return ExecutionResult.Failure($"Rest option '{option}' not found. Available: {string.Join(", ", buttons.Select(b => b.Option.OptionId))}");
            }
            parsedData.SelectedOption = match;
            Plugin.Log($"Selected rest option: {option}");
            return ExecutionResult.Success();

        }
        else
        {
            var nRestSiteRoom = FindNRestSiteRoom();
            if (nRestSiteRoom?.ProceedButton?.IsEnabled != true)
                return ExecutionResult.Failure("Proceed button not available");
            parsedData.ProceedButton = nRestSiteRoom.ProceedButton;
            return ExecutionResult.Success();

        }
    }

    //TODO: (Multiplayer) Mend option requires a second click on the other player
    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)

    {
        if (action.Name == "proceed") return await Proceed(result);
        if (result.SelectedOption == null || !result.SelectedOption.IsVisibleInTree()) return ExecutionResult.ModFailure("The selected option is invalid");


        var isMend = action.Name.EndsWith("mend", StringComparison.OrdinalIgnoreCase);
        await GodotMainThread.ClickAsync(result.SelectedOption);
        // Wait for the animation to finish: proceed button becomes enabled or an overlay appears
        // (e.g., Smith opens card selection). Mirrors the game's AutoSlay RestSiteRoomHandler logic.
        var nRoom = FindNRestSiteRoom();
        if (nRoom != null)
        {
            for (int i = 0; i < 40; i++) // up to ~10s (40 * 250ms)
            {
                await Task.Delay(250);
                var ready = await GodotMainThread.RunAsync(() =>
                {
                    if (isMend)
                    {
                        return NTargetManager.Instance.IsInSelection;
                    }

                    if (nRoom.ProceedButton?.IsEnabled == true) return true;
                    var overlay = NOverlayStack.Instance;
                    if (overlay != null && overlay.ScreenCount > 0) return true;
                    return false;
                });
                if (ready) break;
            }
        }
        // GameStabilityDetector.ResetWasStable();
        if (isMend)
        {
            await Task.Delay(200);
            await GodotMainThread.RunAsync(() =>
            {
                var sceneRoot = SceneHelper.GetSceneRoot();
                if (sceneRoot == null)
                {
                    return;
                }

                var players = UiHelper.FindAll<NMultiplayerPlayerState>(sceneRoot)
                    .Where(p => p.Player != LocalContext.GetMe(ctx.RunState.Players))
                    .ToList();
                var targetHelper = NTargetManager.Instance;
                Plugin.Log($"Found {players.Count} player states in the scene.");
                foreach (var p in players)
                {
                    if (!targetHelper.AllowedToTargetNode(p))
                    {
                        continue;
                    }

                    Plugin.Log($"Found a valid target for mend: {p.Name}");
                    targetHelper.OnNodeHovered(p);
                    FinishTargetingMethod?.Invoke(targetHelper, [false]);
                    break;
                }
            });
        }

        return ExecutionResult.Success("Rest option selected");
    }

    private async Task<ExecutionResult> Proceed(Result result)
    {

        await GodotMainThread.ClickAsync(result.ProceedButton);
        Plugin.Log("Clicked proceed (rest site)");
        return ExecutionResult.Success("Proceeded");
    }

    private static NRestSiteRoom? FindNRestSiteRoom()
    {
        var sceneRoot = SceneHelper.GetSceneRoot();
        return sceneRoot == null ? null : UiHelper.FindFirst<NRestSiteRoom>(sceneRoot);
    }

}
