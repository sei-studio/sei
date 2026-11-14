using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Nodes.Cards;
using MegaCrit.Sts2.Core.Nodes.Cards.Holders;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Screens.CardSelection;
using MegaCrit.Sts2.Core.Nodes.Screens.Overlays;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using NeuroSdk.Json;
using System.Text;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Context;

namespace Sts2Agent.Contexts;

public class CardSelectionHandler : IContextHandler<CardSelectionHandler.Result>
{
    private const BindingFlags PrivateInstance = BindingFlags.NonPublic | BindingFlags.Instance;
    private static readonly Dictionary<Type, FieldInfo?> CompletionSourceFields = [];
    private static readonly Dictionary<Type, FieldInfo?> PrefsFields = [];

    public ContextType Type => ContextType.CardSelection;


    public class Result : IContextResult
    {
        public NCardHolder SelectedCard;
        public List<NCardHolder> MultipleCards;
    }


    public ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();
        stringBuilder.AppendLine("You need to select a card.");
        var cardHolders = ctx.CardHolders;
        if (cardHolders == null) return new ContextReturn(stringBuilder.ToString());
        // Don't offer commands until the screen is fully initialized (_completionSource set)
        if (!IsSelectionScreenReady(ctx.OverlayScreen))
            return new ContextReturn(stringBuilder.ToString());
        var cardModels = cardHolders.Select(x => x.CardModel);
        if (cardModels == null || !cardModels.Any())
            return new ContextReturn(stringBuilder.ToString());
        stringBuilder.AppendLine("The following cards are selectable:");
        stringBuilder.RepresentDeck(cardModels.Cast<CardModel>());
        return new ContextReturn(stringBuilder.ToString());
    }
    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        var cardHolders = ctx.CardHolders;
        if (cardHolders == null) return new CommandReturn();

        // Don't offer commands until the screen is fully initialized (_completionSource set)
        if (!IsSelectionScreenReady(ctx.OverlayScreen))
            return new CommandReturn();
        var (min_select, max_select) = GetSelectionBounds(ctx.OverlayScreen);
        Plugin.LogDebug($"min_select: {min_select}, max_select:{max_select}");
        var prompt = new StringBuilder();
        if (max_select > 1)
        {
            commands.Add(new("select_multiple_cards", min_select != max_select ? $"Select {min_select} up to {max_select} cards" : $"Select {max_select} cards", QJS.WrapObject(new Dictionary<string, JsonSchema>
            {
                ["card_index"] = new()
                {
                    Type = JsonSchemaType.Array,
                    MinItems = min_select,
                    MaxItems = max_select,
                    Items = QJS.Type(JsonSchemaType.Integer)
                }
            })));
            prompt.AppendLine($"Select {min_select} to {max_select} cards, Your current cards are:");
        }
        else
        {
            commands.Add(new("select_card", "Select an available card", QJS.WrapObject(new Dictionary<string, JsonSchema>
            {
                ["card_index"] = QJS.Type(JsonSchemaType.Integer),
            })));
            prompt.AppendLine("Select a card, Your current cards are:");
        }

        prompt.GetIndexedCardNames(cardHolders.Select(x => x.CardModel!));
        var canSkip = ctx.OverlayScreen is NCardRewardSelectionScreen;
        if (!canSkip && ctx.OverlayNode != null)
            canSkip = UiHelper.FindFirst<NChoiceSelectionSkipButton>(ctx.OverlayNode) != null;
        if (canSkip)
            commands.Add(new("skip", "Skip this selection. No card will be added to your deck."));

        return new CommandReturn(commands, ForceText: prompt.ToString());
    }

    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)
    {
        return action.Name switch
        {
            "select_card" => await SelectCard(result, ctx),
            "select_multiple_cards" => await SelectMultipleCards(ctx, result),
            "skip" => await Skip(ctx),
            _ => ExecutionResult.Failure("Unknown action")
        };
    }

    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result result, ContextInfo? ctx)
    {
        if (action.Name == "skip")
        {
            return ExecutionResult.Success();
        }
        else if (action.Name == "select_card")
        {
            var cardIndex = data.GetValue("card_index", -1);
            if (cardIndex < 0)
            {
                return ExecutionResult.Failure("Missing parameter: card");
            }
            if (ctx?.OverlayScreen == null || ctx.OverlayNode == null)
                return ExecutionResult.Failure("No card selection screen open");
            var holders = ctx.CardHolders;
            if (holders == null)
                return ExecutionResult.Failure("No cards are available to select");

            if (cardIndex < 0 || cardIndex >= holders.Count)
                return ExecutionResult.Failure($"Card index {cardIndex} out of range (available: {holders.Count}), Available cards to select are: {TextHelper.GetAvailableCardsActionText(LocalContext.GetMe(ctx.RunState.Players), true)}");

            var holder = holders[cardIndex];
            if (holder == null)
            {
                return ExecutionResult.Failure($"Card '{cardIndex}' is not available to select");
            }
            result.SelectedCard = holder;
            return ExecutionResult.Success();
        }
        else if (action.Name == "select_multiple_cards")
        {

            var all_nodes = new List<NCardHolder>();
            var cardIndex = data.GetArray<int>("card_index");
            if (cardIndex == null || !cardIndex.Any())
            {
                return ExecutionResult.Failure("Missing parameter: cards");
            }
            if (ctx?.OverlayScreen == null || ctx.OverlayNode == null)
                return ExecutionResult.Failure("No card selection screen open");
            var holders = ctx.CardHolders;
            if (holders == null)
                return ExecutionResult.Failure("No cards are available to select");
            foreach (var item in cardIndex)
            {
                var cardName = item;
                if (cardName < 0 || cardName >= holders.Count)
                    return ExecutionResult.Failure($"Card index {cardName} out of range (available: {holders.Count}). Available cards to select are: {TextHelper.GetAvailableCardsActionText(LocalContext.GetMe(ctx.RunState.Players), true)}");
                var holder = holders[cardName];
                if (holder == null)
                {
                    return ExecutionResult.Failure($"Not enough copies of {cardName} are available. Select fewer copies or choose a different card.");
                }
                all_nodes.Add(holder);
            }
            result.MultipleCards = all_nodes;
            return ExecutionResult.Success();
        }

        return ExecutionResult.Failure("Unknown action");
    }
    private async Task<ExecutionResult> SelectCard(Result result, ContextInfo ctx)
    {
        if (result.SelectedCard == null)
        {
            Plugin.LogError($"[CRITICAL] Missing Parameter SelectedCard Even tho it passed validation");
            return ExecutionResult.Failure("Missing parameter: card");
        }
        Plugin.LogDebug("Selecting card: " + result.SelectedCard?.ToString());

        // Wait for _completionSource to be set
        if (ctx.OverlayScreen != null)
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                if (IsSelectionScreenReady(ctx.OverlayScreen)) break;
                await Task.Delay(100);
            }
            if (!IsSelectionScreenReady(ctx.OverlayScreen))
                return ExecutionResult.Failure("Card selection screen not ready (_completionSource is null)");
        }

        var isGridScreen = ctx.IsGridScreen;
        var grid = isGridScreen && ctx.OverlayNode != null
            ? UiHelper.FindFirst<NCardGrid>(ctx.OverlayNode) : null;

        var selectedCardName = result.SelectedCard.CardNode?.Model?.Title.ToString() ?? "unknown";
        Plugin.LogDebug($"SelectCard: overlay type={ctx.OverlayScreen.GetType().Name}, card={selectedCardName}");

        // Emit signal on main thread
        var completed = await Task.WhenAny(
            GodotMainThread.RunAsync(() =>
            {
                if (grid != null)
                    grid.EmitSignal(NCardGrid.SignalName.HolderPressed, result.SelectedCard);
                else
                    result.SelectedCard.EmitSignal(NCardHolder.SignalName.Pressed, result.SelectedCard);
            }),
            Task.Delay(5000));

        if (completed is Task<bool> { IsCompletedSuccessfully: false })
            return ExecutionResult.Failure("SelectCard timed out emitting signal");

        // Non-grid: click completes selection, wait for close
        if (!isGridScreen)
        {
            await WaitForOverlayClose(ctx.OverlayNode, ctx.OverlayScreen);
            Plugin.Log($"Selected card {selectedCardName}");
            return ExecutionResult.Success("Card selected");
        }

        // Grid: check if auto-closed
        await Task.Delay(200);
        if (!GodotObject.IsInstanceValid(ctx.OverlayNode) || NOverlayStack.Instance?.Peek() != ctx.OverlayScreen)
        {
            Plugin.Log($"Selected card {selectedCardName}");
            return ExecutionResult.Success("Card selected");
        }

        // Check for confirm button
        var confirmButtons = UiHelper.FindAll<NConfirmButton>(ctx.OverlayNode);
        NConfirmButton? enabledButton = confirmButtons.FirstOrDefault(b => b.IsEnabled);

        if (enabledButton == null)
        {
            for (int i = 0; i < 5; i++)
            {
                await Task.Delay(100);
                enabledButton = confirmButtons.FirstOrDefault(b => b.IsEnabled);
                if (enabledButton != null) break;
            }
        }

        if (enabledButton != null)
        {
            await Task.Delay(2000);
            await GodotMainThread.ClickAsync(enabledButton);
            Plugin.LogDebug("SelectCard: clicked confirm button");
            await WaitForOverlayClose(ctx.OverlayNode, ctx.OverlayScreen);
        }
        else
        {
            Plugin.LogDebug("SelectCard: partial selection (no confirm enabled yet)");
        }

        Plugin.Log($"Selected card {selectedCardName}");
        return ExecutionResult.Success("Card selected");
    }

    private async Task<ExecutionResult> SelectMultipleCards(ContextInfo ctx, Result result)
    {
        foreach (var card in result.MultipleCards)
        {
            var selection_proxy = new Result
            {
                SelectedCard = card
            };
            var result1 = await SelectCard(selection_proxy, ctx);
            if (!result1.Successful)
            {
                Plugin.LogError($"[CRITICAL] SelectCard failed inside SelectMultipleCards {result1.Message}");
                return result1;
            }
        }
        return ExecutionResult.Success("Cards selected");
    }

    private async Task<ExecutionResult> Skip(ContextInfo ctx)
    {
        var sceneRoot = SceneHelper.GetSceneRoot();
        if (sceneRoot == null)
            return ExecutionResult.Failure("Cannot access scene tree");

        var skipButton = UiHelper.FindFirst<NChoiceSelectionSkipButton>(sceneRoot);
        if (skipButton != null)
        {
            await GodotMainThread.ClickAsync(skipButton);
            Plugin.Log("Clicked skip button");
            return ExecutionResult.Success("Skipped");
        }

        // Card reward screens use NCardRewardAlternativeButton instead of NChoiceSelectionSkipButton
        if (ctx.OverlayScreen is NCardRewardSelectionScreen cardRewardScreen)
        {
            var altButtons = UiHelper.FindAll<NCardRewardAlternativeButton>((Node)cardRewardScreen);
            if (altButtons.Count > 0)
            {
                // Click the first alternative button (Skip). Reroll is added second if present.
                await GodotMainThread.ClickAsync(altButtons[0]);
                await WaitForOverlayClose(ctx.OverlayNode!, ctx.OverlayScreen);
                Plugin.Log("Clicked skip on card reward screen");
                return ExecutionResult.Success("Skipped");
            }
        }

        // Fallback: proceed button
        var proceedButton = UiHelper.FindFirst<NProceedButton>(sceneRoot);
        if (proceedButton != null)
        {
            await GodotMainThread.ClickAsync(proceedButton);
            Plugin.Log("Clicked proceed (as skip fallback)");
            return ExecutionResult.Success("Skipped (proceed)");
        }

        return ExecutionResult.Failure("No skip or proceed button found");
    }

    private static bool IsSelectionScreenReady(object? overlayScreen)
    {
        if (overlayScreen == null)
            return true;

        var completionSourceField = GetCachedField(CompletionSourceFields, overlayScreen, "_completionSource");
        return completionSourceField == null || completionSourceField.GetValue(overlayScreen) != null;
    }

    private static (int MinSelect, int MaxSelect) GetSelectionBounds(object? overlayScreen)
    {
        if (overlayScreen == null)
            return (1, 1);

        var prefsField = GetCachedField(PrefsFields, overlayScreen, "_prefs");
        if (prefsField == null)
            return (1, 1);

        try
        {
            dynamic prefs = prefsField.GetValue(overlayScreen)!;
            return ((int)prefs.MinSelect, (int)prefs.MaxSelect);
        }
        catch (Exception e)
        {
            Plugin.LogWarning($"CardSelectionHandler: couldn't read _prefs on {overlayScreen.GetType().Name}: {e.Message}");
            return (1, 1);
        }
    }

    private static FieldInfo? GetCachedField(Dictionary<Type, FieldInfo?> cache, object owner, string fieldName)
    {
        var type = owner.GetType();
        if (cache.TryGetValue(type, out var field))
            return field;

        field = type.GetField(fieldName, PrivateInstance);
        cache[type] = field;
        if (field == null)
            Plugin.LogWarning($"CardSelectionHandler: couldn't find private field '{fieldName}' on {type.Name}");
        return field;
    }

    private static async Task WaitForOverlayClose(Node overlayNode, object overlay, int timeoutMs = 5000)
    {
        var iterations = timeoutMs / 100;
        for (int i = 0; i < iterations; i++)
        {
            await Task.Delay(100);
            if (!GodotObject.IsInstanceValid(overlayNode) || NOverlayStack.Instance?.Peek() != overlay)
                return;
        }
        Plugin.LogDebug("WaitForOverlayClose: timed out");
    }


}
