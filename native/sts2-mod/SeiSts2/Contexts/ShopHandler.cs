using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Entities.Merchant;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using Sts2Agent.Utilities;
using STS2NeuroIntegration;
using NeuroSdk.Websocket;
using NeuroSdk.Actions;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;
using System.Text;
using NeuroSdk.Json;

namespace Sts2Agent.Contexts;

public class ShopHandler : AbstractQueuedHandler<ShopHandler.Result>
{
    public class Result : IContextResult
    {
        public MerchantEntry BuyItem;
        internal NButton Button;
    }
    public override ContextType Type => ContextType.Shop;
    bool firstContext = true;

    int projectedGoldAfterPurchase = 0;
    public override ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();

        if (!ctx.ShopIsOpen)
        {
            firstContext = false;
            return new ContextReturn(stringBuilder.ToString());
        }
        stringBuilder.AppendLine($"You are inside a shop.");
        stringBuilder.AppendLine("In the shop, you can buy cards, relics, or remove a card from your deck.");
        stringBuilder.AppendLine("Once you are done with your purchases, you can leave the shop and continue your adventure.");

        return new ContextReturn(stringBuilder.ToString(), !firstContext);
    }
    public override CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();

        if (!ctx.ShopIsOpen)
        {
            commands.Add(new("shop_open", "Open the shop"));
            return new CommandReturn(commands);
        }

        var forceText = new StringBuilder();
        getForceText(forceText);
        if (ctx.ShopItems!.Any(x => x.EnoughGold))
            commands.Add(new("shop_buy", "Buy an item. use the index of the item to buy it.", QJS.WrapObject(new Dictionary<string, JsonSchema>()
            {
                ["item_index"] = QJS.Type(JsonSchemaType.Integer)
            })));
        commands.Add(new("shop_leave", "Leave the shop"));

        Plugin.LogDebug($"Generated shop commands. ForceText: {forceText}");

        return new CommandReturn(commands, true, ForceText: forceText.ToString());
    }

    private void getForceText(StringBuilder forceText)
    {
        var ctx = GameContext.Resolve();
        var player = LocalContext.GetMe(ctx.RunState.Players);
        forceText.AppendLine($"Please buy an item or leave the shop if you are done with your purchases. You have {player!.Gold} gold to spend.");
        var item_index = 0;
        if (ctx.ShopItems != null)
        {
            if (ctx.ShopItems.Any(x => x.EnoughGold))
                forceText.AppendLine("Available items:");
            foreach (var entry in ctx.ShopItems)
            {
                if (entry != null && entry.IsStocked && entry.EnoughGold)
                {
                    forceText.AppendLine($"- [{item_index}] {GetEntryName(entry)} for {entry.Cost} gold. Description: {GetEntryDescription(entry).AsSingleLine()}");
                }
                item_index++;
            }
        }
    }

    public override ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {
        if (action.Name == "shop_open")
        {

            var nRoom = NMerchantRoom.Instance;
            if (nRoom == null)
                return ExecutionResult.Failure("You are not in a shop");
            if (nRoom.Inventory?.IsOpen == true)
                return ExecutionResult.Failure("Shop already open");

            var merchantButton = nRoom.MerchantButton;
            if (merchantButton == null)
                return ExecutionResult.Failure("Merchant button not found");
            parsedData.Button = merchantButton;

        }
        else if (action.Name == "shop_leave")
        {
            var sceneRoot = SceneHelper.GetSceneRoot();
            if (sceneRoot == null)
                return ExecutionResult.Failure("Cannot access scene tree");

            var button = UiHelper.FindFirst<NProceedButton>(sceneRoot);
            if (button == null)
                return ExecutionResult.Failure("Couldn't find the Leave button");
            parsedData.Button = button;
            firstContext = true;

        }
        else if (action.Name == "shop_buy")
        {
            var itemIndex = data.GetValue("item_index", -1);
            if (itemIndex < 0)
                return ExecutionResult.Failure("Missing Parameter: item_index");
            var items = ctx.ShopItems;
            var inv = ctx.ShopInventory;

            if (items == null || inv == null)
                return ExecutionResult.Failure("No shop inventory");
            if (itemIndex >= items.Count)
                return ExecutionResult.Failure($"Item Index out of range (available range: 0-{items.Count - 1})");

            var entry = items.ElementAtOrDefault(itemIndex);
            if (entry == null)
                return ExecutionResult.Failure($"Item not found at index {itemIndex}");
            if (!entry.EnoughGold)
                return ExecutionResult.Failure("Not enough gold to buy this item");
            if (!IsRevalidation)
            {
                //check if the player has enough gold after considering the projected cost of previous purchases that haven't executed yet
                var player = LocalContext.GetMe(ctx.RunState.Players);
                if (player == null)
                    return ExecutionResult.Failure("Player not found in context");
                var effectiveGold = player.Gold - projectedGoldAfterPurchase;
                if (effectiveGold < entry.Cost)
                    return ExecutionResult.Failure($"Not enough gold to buy this item considering previous purchases in the queue. You have {player.Gold} gold, and {projectedGoldAfterPurchase} gold is currently reserved for previous purchases, leaving you with {effectiveGold} gold.");
                projectedGoldAfterPurchase += entry.Cost;
            }
            parsedData.BuyItem = entry;
        }
        return ExecutionResult.Success();
    }

    protected override async Task<ExecutionResult?> ExecuteQueuedAction(ConstructedAction action, Result result, ContextInfo ctx)
    {
        if (action.Name == "shop_open") return await ShopOpen(result);
        if (action.Name == "shop_buy") return await ShopBuy(result, ctx);
        if (action.Name == "shop_leave") return await ShopLeave(result);
        return ExecutionResult.Failure("Invalid shop action");
    }

    protected override string GetContextChangedMessage(ConstructedAction action, Result result)
        => "Context changed, no longer in shop";

    protected override void OnAfterQueuedAction(ConstructedAction action, Result result, ContextInfo freshCtx)
    {
        if (action.Name is "shop_leave" or "shop_open" || ActionQueue.Count > 1)
        {
            return;
        }

        var stringBuilder = new StringBuilder();
        getForceText(stringBuilder);
        NeuroIntegration.Reforce(stringBuilder.ToString());
    }

    private async Task<ExecutionResult> ShopOpen(Result result)
    {
        projectedGoldAfterPurchase = 0;
        await GodotMainThread.ClickAsync(result.Button);
        await Task.Delay(500);
        Plugin.Log("Opened shop inventory");
        return ExecutionResult.Success();
    }

    private async Task<ExecutionResult> ShopBuy(Result root, ContextInfo ctx)
    {
        projectedGoldAfterPurchase -= root.BuyItem.Cost;
        await GodotMainThread.RunAsync(() => root.BuyItem.OnTryPurchaseWrapper(ctx.ShopInventory));
        await Task.Delay(300);
        return ExecutionResult.Success();
    }

    private async Task<ExecutionResult> ShopLeave(Result result)
    {
        projectedGoldAfterPurchase = 0;
        NeuroIntegration.UnregisterAllActions();
        // Shop leave: find proceed button
        await GodotMainThread.ClickAsync(result.Button);
        Plugin.Log("Clicked proceed (shop leave)");
        return ExecutionResult.Success();
    }


    private static string GetEntryName(MerchantEntry entry)
    {
        if (entry is MerchantCardEntry cardEntry)
            return cardEntry.CreationResult.Card.Title.ToString();
        if (entry is MerchantRelicEntry relicEntry)
            return TextHelper.SafeLocString(() => relicEntry.Model.Title);
        if (entry is MerchantPotionEntry potionEntry)
            return TextHelper.SafeLocString(() => potionEntry.Model.Title);
        return "Remove Card";
    }
    private static string GetEntryDescription(MerchantEntry entry)
    {
        if (entry is MerchantCardEntry cardEntry)
            return TextHelper.GetCardDescription(cardEntry.CreationResult.Card);
        if (entry is MerchantRelicEntry relicEntry)
            return TextHelper.GetRelicDescription(relicEntry.Model);
        if (entry is MerchantPotionEntry potionEntry)
            return TextHelper.GetPotionDescription(potionEntry.Model);
        return "???";
    }
}
