using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.Cards.Holders;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using NeuroSdk.Json;
using System.Text;
using MegaCrit.Sts2.Core.Localization.DynamicVars;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Context;

namespace Sts2Agent.Contexts;

public class HandSelectionHandler : IContextHandler<HandSelectionHandler.Result>
{
    public class Result : IContextResult
    {
        internal List<NHandCardHolder> Cards;
        internal NConfirmButton ConfirmButton;
    }
    public ContextType Type => ContextType.HandSelection;

    public ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();
        stringBuilder.AppendLine("## Select Cards from Your Hand");
        var hand = ctx.Hand;
        if (hand == null) return new ContextReturn(stringBuilder.ToString());
        if (ReflectionCache.HandPrefs != null)
        {
            try
            {
                dynamic prefs = ReflectionCache.HandPrefs.GetValue(hand)!;
                stringBuilder.AppendLine(TextHelper.StripBBCode(
                    ((MegaCrit.Sts2.Core.Localization.LocString)prefs.Prompt).GetFormattedText()));
                stringBuilder.AppendLine(prefs.MinSelect != prefs.MaxSelect ? $"Select {prefs.MinSelect} up to {prefs.MaxSelect} cards." : $"Select {prefs.MaxSelect} card.");
            }
            catch { }
        }

        var holders = GetVisibleHolders(hand);
        if (holders.Count > 0)
        {
            stringBuilder.AppendLine();
            stringBuilder.AppendLine("**Selectable cards:**");
            var player = LocalContext.GetMe(ctx.RunState!.Players);
            if (player != null)
                stringBuilder.AppendLine(TextHelper.GetAvailableCardsActionText(player, true));
        }
        if (ReflectionCache.HandConfirmButton != null)
        {
            if (ReflectionCache.HandConfirmButton.GetValue(hand) is NConfirmButton confirmButton && confirmButton.IsEnabled)
            {
                return new();
            }
        }
        return new ContextReturn(stringBuilder.ToString());

    }

    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        var hand = ctx.Hand;
        if (hand == null) return new CommandReturn();

        var holders = GetVisibleHolders(hand);
        var min_select = 0;
        var max_select = 1;

        if (ReflectionCache.HandPrefs != null)
        {
            try
            {
                dynamic prefs = ReflectionCache.HandPrefs.GetValue(hand)!;
                min_select = (int)prefs.MinSelect;
                max_select = (int)prefs.MaxSelect;
            }
            catch
            {
                Plugin.LogError("Couldn't Figure out how many Cards needed to be selected, falling back to maximum selection");
                max_select = holders.Count;
            }
        }
        commands.Add(new("choose_hand_cards", min_select != max_select ? $"Select {min_select} up to {max_select} cards" : $"Select {max_select} cards", QJS.WrapObject(new Dictionary<string, JsonSchema>()
        {
            ["cards"] = new()
            {
                Type = JsonSchemaType.Array,
                MinItems = min_select,
                MaxItems = max_select,
                Items = QJS.Type(JsonSchemaType.Integer),
            }
        })));


        if (ReflectionCache.HandConfirmButton != null)
        {
            if (ReflectionCache.HandConfirmButton.GetValue(hand) is NConfirmButton confirmButton && confirmButton.IsEnabled)
            {
                commands.Clear();
                commands.Add(new("confirm_selection", "Confirm your selection of cards and proceed"));
            }
        }
        StringBuilder forceText = new();

        forceText.AppendLine("Select cards from your hand:");
        var player = LocalContext.GetMe(ctx.RunState!.Players);
        if (player != null)
            forceText.AppendLine(TextHelper.GetAvailableCardsActionText(player, true));

        return new CommandReturn(commands, ForceText: forceText.ToString(), ForcePriority: NeuroSdk.Messages.Outgoing.ActionsForce.Priority.Medium);
    }

    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {
        if (action.Name == "choose_hand_cards")
        {
            var hand = ctx.Hand;
            if (hand == null || !hand.IsInCardSelection)
                return ExecutionResult.ModFailure("Hand is not in card selection mode");

            var cardIndex = data.GetArray<int>("cards");
            if (cardIndex == null)
                return ExecutionResult.Failure("Missing parameter: cards");
            var cardname = cardIndex.FirstOrDefault(-1);
            if (cardname < 0)
                return ExecutionResult.Failure("Missing a card value in the array");
            var holders = GetVisibleHolders(hand);
            if (holders == null)
                return ExecutionResult.ModFailure("Couldn't find the hand to select from");


            var held_cards = new List<NHandCardHolder>();
            foreach (var index in cardIndex)
            {
                if (index < 0 || index >= holders.Count)
                    return ExecutionResult.Failure($"Card index {index} out of range (available: {holders.Count}), Available cards: {TextHelper.GetAvailableCardsActionText(LocalContext.GetMe(ctx.RunState!.Players), true)}");
                held_cards.Add(holders[index]);

            }
            parsedData.Cards = held_cards;
            return ExecutionResult.Success();
        }
        else
        {
            var hand = ctx.Hand;
            if (hand == null || !hand.IsInCardSelection)
                return ExecutionResult.Failure("No active selection to confirm");

            if (ReflectionCache.HandConfirmButton == null)
                return ExecutionResult.Failure("Cannot access confirm button");

            if (ReflectionCache.HandConfirmButton.GetValue(hand) is not NConfirmButton confirmButton || !confirmButton.IsEnabled)
                return ExecutionResult.Failure("Confirm button is not enabled (need to select more cards?)");
            parsedData.ConfirmButton = confirmButton;

        }
        return ExecutionResult.Success();
    }
    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)

    {
        return action.Name switch
        {
            "choose_hand_cards" => await ChooseHandCard(result, ctx),
            "confirm_selection" => await ConfirmSelection(result),
            _ => null
        };
    }

    private async Task<ExecutionResult> ChooseHandCard(Result root, ContextInfo ctx)
    {

        foreach (var item in root.Cards)
        {
            await GodotMainThread.RunAsync(() =>
            {
                Plugin.LogDebug($"ChooseHandCards: emitting Pressed on holder for '{item.CardNode?.Model?.Title}'");
                item.EmitSignal(NCardHolder.SignalName.Pressed, item);
            });
        }
        return ExecutionResult.Success("Hand card selected");
    }

    private async Task<ExecutionResult> ConfirmSelection(Result result)
    {
        await GodotMainThread.ClickAsync(result.ConfirmButton);
        Plugin.LogDebug("ConfirmSelection: clicked hand select confirm button");
        return ExecutionResult.Success("Selection confirmed");
    }

    private static List<NHandCardHolder> GetVisibleHolders(NPlayerHand hand)
    {
        return hand.CardHolderContainer.GetChildren()
            .OfType<NHandCardHolder>()
            .Where(h => h.Visible && h.CardNode?.Model != null)
            .ToList();
    }

}
