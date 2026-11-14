
using System.Text;
using Godot;
using MegaCrit.Sts2.addons.mega_text;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Events;
using MegaCrit.Sts2.Core.Nodes.Events.Custom.CrystalSphere;
using NeuroSdk.Actions;
using NeuroSdk.Json;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using STS2NeuroIntegration;

namespace Sts2Agent.Contexts;

public class CrystalBallHandler : AbstractQueuedHandler<CrystalBallHandler.Result>
{
    public class Result : IContextResult
    {
        internal NDivinationButton SelectedButton;
        internal NCrystalSphereCell SelectedCell;
        internal NProceedButton ProceedButton;
    }

    private Dictionary<Vector2I, bool> _revealedCells = new();
    private static readonly Vector2I[] CellDirections =
    [
    new Vector2I(0,1),
    new Vector2I(1,1),
    new Vector2I(1,0),
    new Vector2I(1,-1),
    new Vector2I(0,-1),
    new Vector2I(-1,-1),
    new Vector2I(-1,0),
    new Vector2I(-1,1),
  ];

    private bool _isBigSize = true;

    public override ContextType Type => ContextType.CrystalBallEvent;
    public override ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();
        stringBuilder.AppendLine("You are at the Crystal Ball event.");
        if (ctx.CrystalSphereScreen == null) return new ContextReturn(stringBuilder.ToString());
        stringBuilder.AppendLine("You can reveal cells that might contain a good or bad item. If you fully reveal one, you gain the item.");

        var instructionstext = ctx.CrystalSphereScreen.Get(NCrystalSphereScreen.PropertyName._instructionsDescriptionLabel).As<MegaRichTextLabel>();
        if (instructionstext != null)
        {
            stringBuilder.AppendLine(TextHelper.StripBBCode(instructionstext.Text));
        }
        var lefttext = ctx.CrystalSphereScreen.Get(NCrystalSphereScreen.PropertyName._divinationsLeftLabel).As<MegaRichTextLabel>();
        if (lefttext != null)
        {
            stringBuilder.AppendLine($"# {TextHelper.StripBBCode(lefttext.Text)}");
        }
        var currentSelection = UiHelper.FindAll<NDivinationButton>(ctx.CrystalSphereScreen).FirstOrDefault(x => x.Get(NDivinationButton.PropertyName._outline).As<Control>().Visible);
        if (currentSelection != null)
        {
            var selectionLabel = currentSelection.Get(NDivinationButton.PropertyName._label).As<MegaLabel>();
            stringBuilder.AppendLine($"# You currently have {selectionLabel?.Text ?? "unknown"} selected");
            _isBigSize = selectionLabel != null && selectionLabel.Text.Contains("Big", StringComparison.InvariantCultureIgnoreCase);
        }
        return new ContextReturn(stringBuilder.ToString());
    }

    public override CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        if (ctx.CrystalSphereScreen == null) return new CommandReturn();
        var eventScreen = ctx.CrystalSphereScreen;
        if (UiHelper.FindFirst<NProceedButton>(eventScreen) is NProceedButton proceed && proceed.IsEnabled)
        {
            commands.Add(new("proceed", "Leave the Crystal Ball event"));
            return new CommandReturn(commands);
        }

        var buttons = UiHelper.FindAll<NDivinationButton>(eventScreen);
        foreach (var divbutton in buttons)
        {
            var label = UiHelper.FindFirst<MegaLabel>(divbutton);
            if (label == null) continue;
            commands.Add(new($"select_{TextHelper.GetActionNameFor(label.Text)}", $"Change the current divination size to {label.Text}"));
        }
        var cells = eventScreen.Get(NCrystalSphereScreen.PropertyName._cellContainer).As<Control>().GetChildren().OfType<NCrystalSphereCell>().ToList();
        if (cells.Count != 0)
        {
            var minX = cells.MinBy(x => x.Entity.X)?.Entity?.X;
            var minY = cells.MinBy(x => x.Entity.Y)?.Entity?.Y;

            var maxX = cells.MaxBy(x => x.Entity.X)?.Entity?.X;
            var maxY = cells.MaxBy(x => x.Entity.Y)?.Entity?.Y;
            commands.Add(new("reveal_cell", $"Reveal a cell at the selected position between {minX},{minY} and {maxX},{maxY}. The selected position must be inside the sphere.", QJS.WrapObject(new Dictionary<string, JsonSchema>()
            {
                ["x"] = new()
                {
                    Type = JsonSchemaType.Integer,
                    Minimum = minX,
                    Maximum = maxX
                },
                ["y"] = new()
                {
                    Type = JsonSchemaType.Integer,
                    Minimum = minY,
                    Maximum = maxY
                },
            })));
        }


        return new CommandReturn(commands, true, getForceText(ctx));
    }

    private string getForceText(ContextInfo ctx)
    {
        if (ctx.CrystalSphereScreen == null) return "Couldn't find the event screen";
        var stringBuilder = new StringBuilder();
        var instructionsLabel = ctx.CrystalSphereScreen.Get(NCrystalSphereScreen.PropertyName._instructionsDescriptionLabel).As<MegaRichTextLabel>();
        if (instructionsLabel != null)
        {
            stringBuilder.AppendLine(TextHelper.StripBBCode(instructionsLabel.Text));
        }
        var leftLabel = ctx.CrystalSphereScreen.Get(NCrystalSphereScreen.PropertyName._divinationsLeftLabel).As<MegaRichTextLabel>();
        if (leftLabel != null)
        {
            stringBuilder.AppendLine($"# {TextHelper.StripBBCode(leftLabel.Text)}");
        }
        return stringBuilder.ToString();
    }

    public override ExecutionResult Validate(ConstructedAction action, ActionJData data, Result result, ContextInfo ctx)
    {
        if (ctx.CrystalSphereScreen == null) return ExecutionResult.ModFailure("Couldn't find the event screen");
        if (action.Name.StartsWith("select_"))
        {
            var divinationButtons = UiHelper.FindAll<NDivinationButton>(ctx.CrystalSphereScreen);
            foreach (var item in divinationButtons)
            {
                var label = UiHelper.FindFirst<MegaLabel>(item);
                if (label == null) continue;
                if (TextHelper.GetActionNameFor(label.Text) == action.Name.Replace("select_", ""))
                {
                    result.SelectedButton = item;
                    return ExecutionResult.Success();
                }
            }
            return ExecutionResult.ModFailure("Couldn't find a divination button with that name");
        }
        if (action.Name.StartsWith("reveal_"))
        {
            if (data.Data?["x"] == null || data.Data?["y"] == null) return ExecutionResult.Failure("Couldn't find the cell position parameters");
            Plugin.LogDebug($"Trying to reveal cell at position ({data.Data["x"]}, {data.Data["y"]})");
            var cells = ctx.CrystalSphereScreen.Get(NCrystalSphereScreen.PropertyName._cellContainer).As<Control>()?.GetChildren()?.OfType<NCrystalSphereCell>();
            if (cells == null) return ExecutionResult.Failure("Couldn't find any cells");
            foreach (var cell in cells)
            {
                if ($"{cell.Entity.X}_{cell.Entity.Y}" != $"{data.Data["x"]}_{data.Data["y"]}") continue;
                if (!cell.Entity.IsHidden) return ExecutionResult.Failure($"Position ({data.Data["x"]}, {data.Data["y"]}) is already unlocked. Try a different position.");
                if (!IsRevalidation && _revealedCells.TryGetValue(new(cell.Entity.X, cell.Entity.Y), out var isRevealed) && isRevealed)
                {
                    return ExecutionResult.Failure($"Position ({data.Data["x"]}, {data.Data["y"]}) is already unlocked. Try a different position.");
                }
                if (!IsRevalidation)
                {
                    if (_isBigSize)
                    {
                        foreach (var dir in CellDirections)
                        {
                            var neighborPos = new Vector2I(cell.Entity.X, cell.Entity.Y) + dir;
                            _revealedCells.TryAdd(neighborPos, true);
                        }
                    }
                    else
                    {
                        _revealedCells.TryAdd(new Vector2I(cell.Entity.X, cell.Entity.Y), true);
                    }
                }
                result.SelectedCell = cell;
                return ExecutionResult.Success();
            }
            return ExecutionResult.Failure("Couldn't find a cell at that position. It might be outside the Crystal Ball.");
        }
        if (action.Name == "proceed")
        {
            if (UiHelper.FindFirst<NProceedButton>(ctx.CrystalSphereScreen) is NProceedButton proceed && proceed.IsEnabled)
            {
                result.ProceedButton = proceed;
                return ExecutionResult.Success();
            }
            else
            {
                return ExecutionResult.ModFailure("Couldn't find the proceed button, or it isn't available");
            }

        }
        return ExecutionResult.Unstable("Unknown action");
    }
    protected override async Task<ExecutionResult?> ExecuteQueuedAction(ConstructedAction action, Result result, ContextInfo ctx)
    {
        if (action.Name.StartsWith("select_"))
        {
            if (result.SelectedButton == null) return ExecutionResult.Unstable("Validation passed without a proper result");
            await GodotMainThread.ClickAsync(result.SelectedButton);
            _isBigSize = result.SelectedButton.Get(NDivinationButton.PropertyName._label).As<MegaLabel>()?.Text?.Contains("Big", StringComparison.InvariantCultureIgnoreCase) ?? _isBigSize;
            return ExecutionResult.Success();
        }
        if (action.Name.StartsWith("reveal_"))
        {
            if (result.SelectedCell == null) return ExecutionResult.Unstable("Validation passed without a proper result");
            await GodotMainThread.ClickAsync(result.SelectedCell);
            NeuroIntegration.SendContext(result.SelectedCell.Entity.Item is null
              ? "The revealed cell contained no item."
              : $"The revealed cell contained part of a {(result.SelectedCell.Entity.Item.IsGood ? "good" : "bad")} item. Fully reveal it to claim it.");
            await Task.Delay(500);
            return ExecutionResult.Success();
        }
        if (action.Name == "proceed")
        {
            if (result.ProceedButton == null) return ExecutionResult.Unstable("Validation passed without a proper result");
            await GodotMainThread.ClickAsync(result.ProceedButton);
            _revealedCells.Clear();
            ActionQueue.Clear();
            return ExecutionResult.Success();
        }
        return ExecutionResult.Unstable("Unknown action");
    }

    protected override string GetContextChangedMessage(ConstructedAction action, Result result)
      => "Context changed, no longer on the Crystal Ball event";

    protected override void OnAfterQueuedAction(ConstructedAction action, Result result, ContextInfo freshCtx)
    {
        if (action.Name == "proceed" || ActionQueue.Count > 1)
        {
            return;
        }

        var currentCtx = GameContext.Resolve();
        if (currentCtx?.Type == ContextType.CrystalBallEvent && currentCtx.CrystalSphereScreen != null)
        {
            NeuroIntegration.Reforce(getForceText(currentCtx));
        }
    }

}
