using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using HarmonyLib;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Entities.Powers;
using MegaCrit.Sts2.Core.Hooks;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Platform;
using MegaCrit.Sts2.Core.Runs;
using Sts2Agent.Utilities;

namespace Sts2Agent;

[HarmonyPatch(typeof(Hook), nameof(Hook.AfterDamageReceived))]
public static class DamageReceivedPatch
{
    [HarmonyPostfix]
    public static void Postfix(Creature target, DamageResult result, Creature? dealer)
    {
        try
        {
            var targetName = TextHelper.StripBBCode(target.Name);
            var dealerName = dealer != null ? TextHelper.StripBBCode(dealer.Name) : "unknown";
            var blocked = result.BlockedDamage;
            var hpLoss = result.UnblockedDamage;
            var total = result.TotalDamage;

            string message;
            if (dealer != null)
                message = $"{dealerName} dealt {total} damage to {targetName} ({blocked} blocked, {hpLoss} HP lost)";
            else
                message = $"{targetName} took {total} damage ({blocked} blocked, {hpLoss} HP lost)";

            EventLog.Add("damage_received", message, new Dictionary<string, object>
            {
                ["target"] = targetName,
                ["dealer"] = dealerName,
                ["total_damage"] = total,
                ["blocked"] = blocked,
                ["hp_loss"] = hpLoss,
                ["was_kill"] = result.WasTargetKilled
            });
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in DamageReceivedPatch: {e}");
        }
    }
}

[HarmonyPatch(typeof(Hook), nameof(Hook.AfterDeath))]
public static class DeathPatch
{
    [HarmonyPostfix]
    public static void Postfix(Creature creature)
    {
        try
        {
            var name = TextHelper.StripBBCode(creature.Name);
            var isEnemy = creature.IsMonster;
            EventLog.Add("creature_died", $"{name} died", new Dictionary<string, object>
            {
                ["creature"] = name,
                ["is_enemy"] = isEnemy
            });
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in DeathPatch: {e}");
        }
    }
}

[HarmonyPatch(typeof(Hook), nameof(Hook.BeforeCardAutoPlayed))]
public static class CardAutoPlayedPatch
{
    [HarmonyPostfix]
    public static void Postfix(CardModel card, Creature? target, AutoPlayType type)
    {
        try
        {
            var cardName = TextHelper.StripBBCode(card.Title);
            var targetName = target != null ? TextHelper.StripBBCode(target.Name) : null;

            var message = targetName != null
                ? $"{cardName} auto-played on {targetName}"
                : $"{cardName} auto-played";

            EventLog.Add("card_auto_played", message, new Dictionary<string, object>
            {
                ["card"] = cardName,
                ["target"] = targetName ?? "",
                ["auto_play_type"] = type.ToString()
            });
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in CardAutoPlayedPatch: {e}");
        }
    }
}

[HarmonyPatch(typeof(Hook), nameof(Hook.AfterPowerAmountChanged))]
public static class PowerChangedPatch
{
    [HarmonyPostfix]
    public static void Postfix(PowerModel power, decimal amount, Creature? applier)
    {
        try
        {
            var ownerName = TextHelper.StripBBCode(power.Owner.Name);
            var powerName = TextHelper.SafeLocString(() => power.Title);
            var applierName = applier != null ? TextHelper.StripBBCode(applier.Name) : null;
            var powerType = power.Type;
            var intAmount = (int)amount;

            string message;
            if (applierName != null)
                message = $"{applierName} applied {intAmount} {powerName} to {ownerName}";
            else
                message = $"{ownerName} gained {intAmount} {powerName}";

            EventLog.Add("power_changed", message, new Dictionary<string, object>
            {
                ["owner"] = ownerName,
                ["power"] = powerName,
                ["amount"] = intAmount,
                ["new_amount"] = power.Amount,
                ["applier"] = applierName ?? "",
                ["type"] = powerType.ToString()
            });
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in PowerChangedPatch: {e}");
        }
    }
}

[HarmonyPatch(typeof(CardCmd), nameof(CardCmd.Upgrade), typeof(IEnumerable<CardModel>), typeof(CardPreviewStyle))]
public static class CardUpgradePatch
{
    [HarmonyPrefix]
    public static void Prefix(IEnumerable<CardModel> cards, out List<(CardModel card, string oldName)>? __state)
    {
        try
        {
            __state = new List<(CardModel, string)>();
            foreach (var card in cards)
            {
                if (card.IsUpgradable)
                    __state.Add((card, TextHelper.StripBBCode(card.Title)));
            }
        }
        catch (Exception e)
        {
            __state = null;
            Plugin.LogError($"Error in CardUpgradePatch.Prefix: {e}");
        }
    }

    [HarmonyPostfix]
    public static void Postfix(List<(CardModel card, string oldName)>? __state)
    {
        try
        {
            if (__state == null) return;
            foreach (var (card, oldName) in __state)
            {
                var newName = TextHelper.StripBBCode(card.Title);
                EventLog.Add("card_upgraded", $"{oldName} upgraded to {newName}", new Dictionary<string, object>
                {
                    ["old_name"] = oldName,
                    ["new_name"] = newName
                });
            }
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in CardUpgradePatch.Postfix: {e}");
        }
    }
}

[HarmonyPatch(typeof(Hook), nameof(Hook.BeforeCardRemoved))]
public static class CardRemovedPatch
{
    [HarmonyPostfix]
    public static void Postfix(CardModel card)
    {
        try
        {
            var cardName = TextHelper.StripBBCode(card.Title);
            EventLog.Add("card_removed", $"{cardName} removed from deck", new Dictionary<string, object>
            {
                ["card"] = cardName
            });
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in CardRemovedPatch: {e}");
        }
    }
}

[HarmonyPatch(typeof(RelicModel), nameof(RelicModel.Flash), new Type[0])]
public static class RelicActivatedPatch
{
    [HarmonyPostfix]
    public static void Postfix(RelicModel __instance)
    {
        try
        {
            var relicName = TextHelper.SafeLocString(() => __instance.Title);
            EventLog.Add("relic_activated", $"{relicName} activated", new Dictionary<string, object>
            {
                ["relic"] = relicName
            });
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in RelicActivatedPatch: {e}");
        }
    }
}

[HarmonyPatch(typeof(RelicCmd), nameof(RelicCmd.Obtain), typeof(RelicModel), typeof(Player), typeof(int))]
public static class RelicObtainedPatch
{
    [HarmonyPostfix]
    public static void Postfix(RelicModel relic)
    {
        try
        {
            var relicName = TextHelper.SafeLocString(() => relic.Title);
            EventLog.Add("relic_obtained", $"{TextHelper.StripBBCode(PlatformUtil.GetPlayerNameRaw(RunManager.Instance.NetService.Platform, relic.Owner.NetId))} Obtained relic: {relicName}", new Dictionary<string, object>
            {
                ["relic"] = relicName,
            });
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in RelicObtainedPatch: {e}");
        }
    }
}

[HarmonyPatch(typeof(RelicCmd), nameof(RelicCmd.Remove))]
public static class RelicRemovedPatch
{
    [HarmonyPostfix]
    public static void Postfix(RelicModel relic)
    {
        try
        {
            var relicName = TextHelper.SafeLocString(() => relic.Title);
            EventLog.Add("relic_removed", $"Lost relic: {relicName}", new Dictionary<string, object>
            {
                ["relic"] = relicName
            });
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in RelicRemovedPatch: {e}");
        }
    }
}
