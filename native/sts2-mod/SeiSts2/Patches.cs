using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Hooks;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.Map;
using MegaCrit.Sts2.Core.Nodes.Screens.GameOverScreen;
using MegaCrit.Sts2.Core.Nodes.Screens.Overlays;
using MegaCrit.Sts2.Core.Nodes.Screens.TreasureRoomRelic;
using MegaCrit.Sts2.Core.Nodes.Ftue;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;
using Sts2Agent.Utilities;
using MegaCrit.Sts2.Core.Nodes.Relics;
using System.Text;
using Sts2Agent.Contexts;
using STS2NeuroIntegration;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Models.Events;
using System.Reflection;

namespace Sts2Agent;

[HarmonyPatch(typeof(CombatManager), nameof(CombatManager.SetUpCombat))]
public static class CombatSetupPatch
{
    [HarmonyPostfix]
    public static void Postfix(CombatManager __instance)
    {
        try
        {
            GameStabilityDetector.SubscribeToCombat(__instance);
            Plugin.LogDebug("Combat events wired to stability detector.");
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in CombatSetupPatch: {e}");
        }
    }
}

[HarmonyPatch]
public static class CombatEndInternalPatch
{
    public static MethodBase? TargetMethod()
    {
        Type CombatTurnStateType = AccessTools.TypeByName("MegaCrit.Sts2.Core.Combat.CombatTurnState");
        if (CombatTurnStateType == null)
        {
            Plugin.LogError("Could not find CombatTurnState type for patching.");
            throw new Exception("Could not find CombatTurnState type for patching.");
        }

        Type[] parameterTypes = [CombatTurnStateType];
        return AccessTools.Method(typeof(CombatManager), "EndCombatInternal", parameterTypes);
    }
    public static void Prefix(object[] __args)
    {
        try
        {
            Plugin.LogDebug("Combat ending internally — clearing combat actions and scheduling context refresh");
            NeuroIntegration.EndForce();
            NeuroIntegration.UnregisterAllActions();
            ActionExecutor.ClearActions();
            GameStabilityDetector.OnScreenTransition();
            NeuroIntegration.SendContext("Combat has Ended. Don't use any Combat related actions from now on.", true);
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in CombatEndInternalPatch: {e}");
        }
    }
}

[HarmonyPatch(typeof(CardModel), nameof(CardModel.OnPlayWrapper))]
public static class MultiplayerAllyCardResourcePatch
{
    [HarmonyPrefix]
    public static void Prefix(CardModel __instance, out MultiplayerTurnRecovery.ResourceSnapshot? __state)
    {
        __state = MultiplayerTurnRecovery.CaptureBeforeEffect(
            __instance.Owner,
            TextHelper.SafeLocString(() => __instance.Title),
            "played");
    }

    [HarmonyPostfix]
    public static void Postfix(Task __result, MultiplayerTurnRecovery.ResourceSnapshot? __state)
    {
        if (__state != null)
            _ = MultiplayerTurnRecovery.NotifyAfterEffect(__result, __state);
    }
}

[HarmonyPatch(typeof(PotionModel), nameof(PotionModel.OnUseWrapper))]
public static class MultiplayerAllyPotionResourcePatch
{
    [HarmonyPrefix]
    public static void Prefix(PotionModel __instance, out MultiplayerTurnRecovery.ResourceSnapshot? __state)
    {
        __state = MultiplayerTurnRecovery.CaptureBeforeEffect(
            __instance.Owner,
            TextHelper.SafeLocString(() => __instance.Title),
            "used");
    }

    [HarmonyPostfix]
    public static void Postfix(Task __result, MultiplayerTurnRecovery.ResourceSnapshot? __state)
    {
        if (__state != null)
            _ = MultiplayerTurnRecovery.NotifyAfterEffect(__result, __state);
    }
}

[HarmonyPatch(typeof(CombatManager), nameof(CombatManager.SetReadyToEndTurn))]
public static class MultiplayerTurnEndingPatch
{
    [HarmonyPostfix]
    public static void Postfix(CombatManager __instance)
    {
        if (Plugin.IsMultiplayer() && __instance.AllPlayersReadyToEndTurn())
            NeuroIntegration.UnregisterAction(MultiplayerTurnRecovery.ResumeTurnActionName);
    }
}

[HarmonyPatch(typeof(NOverlayStack), nameof(NOverlayStack.Push))]
public static class OverlayPushPatch
{
    [HarmonyPostfix]
    public static void Postfix() => GameStabilityDetector.OnOverlayChanged();
}

[HarmonyPatch(typeof(NOverlayStack), nameof(NOverlayStack.Remove))]
public static class OverlayRemovePatch
{
    [HarmonyPostfix]
    public static void Postfix() => GameStabilityDetector.OnOverlayChanged();
}

[HarmonyPatch(typeof(EventModel), "SetEventState")]
public static class EventStateChangedPatch
{
    [HarmonyPostfix]
    public static void Postfix() => GameStabilityDetector.ScheduleStabilityCheck();
}

[HarmonyPatch(typeof(NMapScreen), nameof(NMapScreen.Open))]
public static class MapScreenOpenPatch
{
    [HarmonyPostfix]
    public static void Postfix()
    {
        Plugin.LogDebug("Map screen opened — scheduling stability check");
        GameStabilityDetector.OnRoomEntered();
    }
}

[HarmonyPatch(typeof(NPlayerHand), nameof(NPlayerHand.SelectCards))]
public static class HandSelectCardsPatch
{
    [HarmonyPostfix]
    public static void Postfix()
    {
        // SelectCards sets CurrentMode before awaiting, so this fires
        // while the hand is already in selection mode
        GameStabilityDetector.OnHandSelectionEntered();
    }
}

[HarmonyPatch(typeof(Hook), nameof(Hook.AfterRoomEntered))]
public static class RoomEnteredPatch
{
    [HarmonyPostfix]
    public static void Postfix(AbstractRoom room)
    {
        Plugin.LogDebug($"Room entered: {room.GetType().Name} — scheduling stability check");
        GameStabilityDetector.OnRoomEntered();
    }
}

[HarmonyPatch(typeof(NTreasureRoom), nameof(NTreasureRoom._Ready))]
public static class TreasureRoomAutoPatch
{
    public static bool AutoClickInProgress { get; private set; }
    public static NTreasureRoom? CurrentRoom { get; private set; }


    [HarmonyPostfix]
    public static void Postfix(NTreasureRoom __instance)
    {
        try
        {
            Plugin.LogDebug("Treasure room ready — auto-opening chest");
            AutoClickInProgress = true;
            CurrentRoom = __instance;
            _ = AutoOpenTreasure(__instance);
        }
        catch (Exception e)
        {
            AutoClickInProgress = false;
            Plugin.LogError($"Error in TreasureRoomAutoPatch: {e}");
        }
    }

    private static async Task AutoOpenTreasure(NTreasureRoom room)
    {
        try
        {
            // Click the chest button
            var chest = await GodotMainThread.RunAsync(() => room.GetNode<NClickableControl>("Chest"));
            if (chest == null)
            {
                Plugin.LogError("Treasure room: chest button not found");
                return;
            }
            await GodotMainThread.ClickAsync(chest);
            Plugin.LogDebug("Treasure room: chest clicked, waiting 3s for relics");

            // Wait 3 seconds for the chest animation and relics to appear
            await Task.Delay(3000);

            // Find and click all visible relic holders
            var holders = await GodotMainThread.RunAsync(() =>
            {
                var found = new List<NTreasureRoomRelicHolder>();
                FindAll(room, found);
                return found;
            });

            if (Plugin.IsMultiplayer())
            {
                Plugin.LogDebug("Treasure room: multiplayer detected, skipping auto-clicking relics");
                TreasureHandler.FoundRelics = holders;
                await Task.Delay(1000); // Wait a bit for the relics to be registered
                NeuroIntegration.Unstable();
                return;
            }

            StringBuilder stringBuilder = new();
            stringBuilder.AppendLine("Received relics in Treasure Room:");
            foreach (var holder in holders)
            {
                var canClick = await GodotMainThread.RunAsync(() =>
                    GodotObject.IsInstanceValid(holder) && holder.IsEnabled && holder.Visible);
                if (canClick)
                {
                    stringBuilder.AppendLine($"- {TextHelper.SafeLocString(() => holder.Relic.Model.Title)}: {TextHelper.GetRelicDescription(holder.Relic.Model)}");
                    Plugin.LogDebug("Treasure room: clicking relic");
                    await GodotMainThread.ClickAsync(holder);
                    await Task.Delay(500);
                }
            }

            // Wait for the proceed button to become enabled (relic awarding is async)
            for (int i = 0; i < 20; i++)
            {
                var proceedReady = await GodotMainThread.RunAsync(() =>
                    GodotObject.IsInstanceValid(room) && room.ProceedButton?.IsEnabled == true);
                if (proceedReady)
                    break;
                await Task.Delay(500);
            }
            EventLog.DrainAll();
            NeuroIntegration.SendContext(stringBuilder.ToString());

            Plugin.LogDebug("Treasure room: auto-open complete");
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error in AutoOpenTreasure: {e}");
        }
        finally
        {
            AutoClickInProgress = false;
            GameStabilityDetector.ScheduleStabilityCheck();
        }
    }

    private static void FindAll<T>(Node parent, List<T> results) where T : Node
    {
        foreach (var child in parent.GetChildren())
        {
            if (child is T match)
                results.Add(match);
            FindAll(child, results);
        }
    }
}

[HarmonyPatch(typeof(NGameOverContinueButton), "OnEnable")]
public static class GameOverContinueEnabledPatch
{
    [HarmonyPostfix]
    public static void Postfix()
    {
        Plugin.LogDebug("Game over continue button enabled — scheduling stability check");
        GameStabilityDetector.ScheduleStabilityCheck();
    }
}

[HarmonyPatch(typeof(NReturnToMainMenuButton), "OnEnable")]
public static class GameOverMainMenuEnabledPatch
{
    [HarmonyPostfix]
    public static void Postfix()
    {
        Plugin.LogDebug("Game over main menu button enabled — scheduling stability check");
        GameStabilityDetector.ScheduleStabilityCheck();
    }
}

[HarmonyPatch(typeof(NMainMenu), nameof(NMainMenu._Ready))]
public static class MainMenuReadyPatch
{
    [HarmonyPostfix]
    public static void Postfix()
    {
        Plugin.LogDebug("Main menu ready — scheduling stability check");
        GameStabilityDetector.OnScreenTransition();
    }
}

[HarmonyPatch(typeof(NCharacterSelectScreen), nameof(NCharacterSelectScreen.OnSubmenuOpened))]
public static class CharacterSelectOpenedPatch
{
    [HarmonyPostfix]
    public static void Postfix()
    {
        Plugin.LogDebug("Character select screen opened — scheduling stability check");
        GameStabilityDetector.OnScreenTransition();
    }
}

public static class AscensionFtueHelper
{
    public static void SendContextAndClose(NFtue popup, string titleKey, string descriptionKey, string disclaimerKey, string popupType)
    {
        try
        {
            var context = new StringBuilder();
            context.AppendLine($"# {new LocString("ftues", titleKey).GetUnformattedText()}");
            context.AppendLine(new LocString("ftues", descriptionKey).GetUnformattedText());
            context.AppendLine(new LocString("ftues", disclaimerKey).GetUnformattedText());
            NeuroIntegration.SendContext(context.ToString());
            _ = CloseAfterDelay(popup, popupType);
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error handling {popupType} ascension popup: {e}");
        }
    }

    private static async Task CloseAfterDelay(NFtue popup, string popupType)
    {
        try
        {
            await Task.Delay(5000);
            var confirmButton = await GodotMainThread.RunAsync(() =>
            {
                if (!GodotObject.IsInstanceValid(popup) || !popup.IsVisibleInTree())
                    return null;
                return popup.GetNodeOrNull<NClickableControl>("%FtueConfirmButton");
            });

            if (confirmButton != null && confirmButton.IsEnabled)
            {
                Plugin.LogDebug($"Closing {popupType} ascension popup after five seconds");
                await GodotMainThread.ClickAsync(confirmButton);
            }
        }
        catch (Exception e)
        {
            Plugin.LogError($"Error closing {popupType} ascension popup: {e}");
        }
    }
}

[HarmonyPatch(typeof(NAscensionSingleplayerFtue), nameof(NAscensionSingleplayerFtue._Ready))]
public static class AscensionSingleplayerFtuePatch
{
    [HarmonyPostfix]
    public static void Postfix(NAscensionSingleplayerFtue __instance)
    {
        AscensionFtueHelper.SendContextAndClose(
            __instance,
            "ASCENSION_SINGLEPLAYER_FTUE_TITLE",
            "ASCENSION_SINGLEPLAYER_FTUE_DESCRIPTION",
            "ASCENSION_SINGLEPLAYER_FTUE_DISCLAIMER",
            "singleplayer");
    }
}

[HarmonyPatch(typeof(NAscensionMultiplayerFtue), nameof(NAscensionMultiplayerFtue._Ready))]
public static class AscensionMultiplayerFtuePatch
{
    [HarmonyPostfix]
    public static void Postfix(NAscensionMultiplayerFtue __instance)
    {
        AscensionFtueHelper.SendContextAndClose(
            __instance,
            "ASCENSION_MULTIPLAYER_FTUE_TITLE",
            "ASCENSION_MULTIPLAYER_FTUE_DESCRIPTION",
            "ASCENSION_MULTIPLAYER_FTUE_DISCLAIMER",
            "multiplayer");
    }
}


[HarmonyPatch(typeof(SaveManager), nameof(SaveManager.SeenFtue))]
public static class SeenFtuePatch
{
    [HarmonyPostfix]
    public static void Postfix(string ftueKey, ref bool __result)
    {
        //Always return true, we don't want any ftues
        __result = true;
    }
}

[HarmonyPatch(typeof(TheArchitect), nameof(TheArchitect.OnRoomEnter))]
public static class TheArchitectRoomEnterPatch
{
    [HarmonyPostfix]
    public static void Postfix()
    {
        Plugin.LogDebug("The Architect room entered — scheduling stability check");
        GameStabilityDetector.OnRoomEntered();
    }

}
