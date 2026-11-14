using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Nodes.Cards;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Screens.CardSelection;
using MegaCrit.Sts2.Core.Nodes.Screens.Overlays;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using NeuroSdk.Json;
using System.Text;
using MegaCrit.Sts2.Core.Models.Cards;

namespace Sts2Agent.Contexts;

public class BundleSelectionHandler : IContextHandler<BundleSelectionHandler.Result>
{
    public class Result : IContextResult
    {
        public NCardBundle? SelectedBundle;
    }
    public ContextType Type => ContextType.BundleSelection;

    public ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();
        var bundles = ctx.Bundles;
        if (bundles == null) return new ContextReturn(stringBuilder.ToString());
        if (bundles.Count == 0) return new ContextReturn(stringBuilder.ToString());
        stringBuilder.AppendLine("You need to select a bundle of cards.");
        stringBuilder.AppendLine($"You have {bundles.Count} bundles available to choose from:");

        for (int i = 0; i < bundles.Count; i++)
        {
            NCardBundle? bundle = bundles[i];
            if (bundle.Bundle == null) continue;

            stringBuilder.AppendLine($"[{i}] Bundle:");
            foreach (var card in bundle.Bundle)
            {
                stringBuilder.AppendLine($"- {card.Title} - {TextHelper.GetCardDescription(card)}");
            }
        }
        return new ContextReturn(stringBuilder.ToString());
    }
    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        var bundles = ctx.Bundles;
        if (bundles == null) return new CommandReturn();

        commands.Add(new("select_bundle", "Select a bundle of cards", QJS.WrapObject(new Dictionary<string, JsonSchema>
        {
            ["bundleIndex"] = QJS.Type(JsonSchemaType.Integer)
        })));

        return new CommandReturn(commands, ForceText: "Select a bundle between 0 and " + (bundles.Count - 1));
    }

    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {
        var bundleIndex = data.GetValue("bundleIndex", -1);
        if (bundleIndex < 0)
            return ExecutionResult.Failure("Bundle index not found");
        var bundles = ctx.Bundles;

        if (bundles == null || bundleIndex >= bundles.Count)
            return ExecutionResult.Failure($"Bundle index {bundleIndex} out of range (available: {bundles?.Count ?? 0})");

        var bundle = bundles[bundleIndex];
        if (bundle == null) return ExecutionResult.ModFailure($"Bundle {bundleIndex} not found");
        parsedData.SelectedBundle = bundle;
        return ExecutionResult.Success();
    }
    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)
    {
        return action.Name switch
        {
            "select_bundle" => await SelectBundle(result, ctx),
            _ => null
        };
    }

    private async Task<ExecutionResult> SelectBundle(Result result, ContextInfo ctx)
    {
        var overlayNode = ctx.OverlayNode;
        var overlayScreen = ctx.OverlayScreen;
        if (result.SelectedBundle == null)
            return ExecutionResult.Failure("Bundle not selected");

        // Click the bundle to open preview
        await GodotMainThread.RunAsync(() =>
        {
            result.SelectedBundle.EmitSignal(NCardBundle.SignalName.Clicked, result.SelectedBundle);
        });

        // Wait for preview to appear with confirm button
        await Task.Delay(2000);

        // Find and click confirm button
        NConfirmButton? confirmButton = null;
        for (int i = 0; i < 20; i++)
        {
            if (overlayNode == null || !GodotObject.IsInstanceValid(overlayNode)) break;
            confirmButton = UiHelper.FindFirst<NConfirmButton>(overlayNode);
            if (confirmButton != null && confirmButton.IsEnabled) break;
            confirmButton = null;
            await Task.Delay(100);
        }

        if (confirmButton == null)
            return ExecutionResult.Failure("Confirm button not found or not enabled after selecting bundle");

        await GodotMainThread.ClickAsync(confirmButton);
        Plugin.LogDebug("BundleSelection: clicked confirm button");

        // Wait for overlay to close
        for (int i = 0; i < 50; i++)
        {
            await Task.Delay(100);
            if (overlayNode == null || !GodotObject.IsInstanceValid(overlayNode)
                || NOverlayStack.Instance?.Peek() != overlayScreen)
            {
                Plugin.Log($"Selected bundle {result.SelectedBundle?.Name ?? "unknown"}");
                return ExecutionResult.Success("Bundle selected");
            }
        }

        Plugin.Log($"Selected bundle {result.SelectedBundle?.Name ?? "unknown"} (overlay may still be closing)");
        return ExecutionResult.Success("Bundle selected");
    }
}
