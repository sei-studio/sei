using System;
using System.Linq;
using System.Threading.Tasks;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Entities.Players;
using Sts2Agent.Utilities;
using STS2NeuroIntegration;

namespace Sts2Agent;

public static class MultiplayerTurnRecovery
{
    public const string ResumeTurnActionName = "resume_turn";

    public sealed class ResourceSnapshot(Player localPlayer, string allyName, string sourceName, string sourceVerb, int energy, int playableCards)
    {
        public Player LocalPlayer { get; } = localPlayer;
        public string AllyName { get; } = allyName;
        public string SourceName { get; } = sourceName;
        public string SourceVerb { get; } = sourceVerb;
        public int Energy { get; } = energy;
        public int PlayableCards { get; } = playableCards;
    }

    public static ResourceSnapshot? CaptureBeforeEffect(Player actor, string sourceName, string sourceVerb)
    {
        if (!Plugin.IsMultiplayer() || LocalContext.IsMe(actor))
            return null;

        try
        {
            var combatManager = CombatManager.Instance;
            var localPlayer = LocalContext.GetMe(actor.RunState.Players);
            var playerState = localPlayer?.PlayerCombatState;
            if (combatManager == null || !combatManager.IsInProgress || localPlayer == null || playerState == null)
                return null;

            return new ResourceSnapshot(
                localPlayer,
                actor.Creature.Name,
                sourceName,
                sourceVerb,
                playerState.Energy,
                playerState.Hand.Cards.Count(card => card.CanPlay()));
        }
        catch (Exception e)
        {
            Plugin.LogError($"Failed to capture multiplayer ally effect state: {e}");
            return null;
        }
    }

    public static async Task NotifyAfterEffect(Task effectTask, ResourceSnapshot snapshot)
    {
        try
        {
            await effectTask;
            await GodotMainThread.RunAsync(() => ReportResourceGain(snapshot));
        }
        catch (Exception e)
        {
            Plugin.LogError($"Failed to inspect multiplayer ally effect: {e}");
        }
    }

    private static void ReportResourceGain(ResourceSnapshot snapshot)
    {
        if (!Plugin.IsMultiplayer())
            return;

        var playerState = snapshot.LocalPlayer.PlayerCombatState;
        var combatManager = CombatManager.Instance;
        if (playerState == null || combatManager == null || !combatManager.IsInProgress)
            return;

        int energyGained = playerState.Energy - snapshot.Energy;
        int playableCardsGained = playerState.Hand.Cards.Count(card => card.CanPlay()) - snapshot.PlayableCards;
        if (energyGained <= 0 && playableCardsGained <= 0)
            return;

        var gains = new[]
        {
            energyGained > 0 ? $"{energyGained} Energy" : null,
            playableCardsGained > 0 ? $"{playableCardsGained} playable card{(playableCardsGained == 1 ? "" : "s")}" : null
        }.Where(gain => gain != null);

        bool canResumeTurn = snapshot.LocalPlayer.Creature.IsAlive
            && combatManager.IsPlayerReadyToEndTurn(snapshot.LocalPlayer)
            && !combatManager.AllPlayersReadyToEndTurn();
        if (canResumeTurn)
        {
            NeuroIntegration.RegisterGlobalAction(new ConstructedAction(
                ResumeTurnActionName,
                "Un-End your turn"));
        }

        var message = $"{snapshot.AllyName} {snapshot.SourceVerb} {snapshot.SourceName}, giving you {string.Join(" and ", gains!)}.";
        message += canResumeTurn
            ? $" Your turn is currently ended; use `{ResumeTurnActionName}` to continue it. To use your new gains, resume your turn."
            : " Your current resources have been updated.";
        NeuroIntegration.SendContext(message);
    }
}
