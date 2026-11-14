using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.Screens.GameOverScreen;
using MegaCrit.Sts2.Core.Nodes.Screens.Overlays;
using MegaCrit.Sts2.Core.Runs;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using System.Text;

namespace Sts2Agent.Contexts;

public class GameOverHandler : IContextHandler<GameOverHandler.GameOverResult>
{
    public class GameOverResult { }
    public ContextType Type => ContextType.GameOver;

    private enum Phase { Continue, MainMenu }

    private Phase GetPhase(NGameOverScreen screen)
    {
        var mainMenuBtn = UiHelper.FindFirst<NReturnToMainMenuButton>(screen);
        if (mainMenuBtn != null && mainMenuBtn.Visible && mainMenuBtn.IsEnabled)
            return Phase.MainMenu;
        return Phase.Continue;
    }

    public ContextReturn GetContext(ContextInfo ctx)
    {
        return new ContextReturn(string.Empty, silent: true);
    }
    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();

        var screen = NOverlayStack.Instance?.Peek() as NGameOverScreen;
        if (screen == null)
            return new CommandReturn();

        var phase = GetPhase(screen);
        if (phase == Phase.MainMenu)
        {
            // commands.Add(new() { ["type"] = "continue" });
            commands.Add(new("continue", "Continue"));
        }
        else
        {
            var continueBtn = UiHelper.FindFirst<NGameOverContinueButton>(screen);
            if (continueBtn != null && continueBtn.IsEnabled)
                commands.Add(new("continue", "Continue"));
        }

        return new CommandReturn(commands);
    }


    public ExecutionResult Validate(ConstructedAction action, ActionJData data, GameOverResult result, ContextInfo ctx)
    {
        return ExecutionResult.Success();
    }
    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, GameOverResult result, ContextInfo ctx)
    {
        if (action.Name == "continue")
            return await AdvanceGameOver();
        return null;
    }

    private async Task<ExecutionResult> AdvanceGameOver()
    {
        var screen = await GodotMainThread.RunAsync(() =>
        {
            var overlay = NOverlayStack.Instance?.Peek();
            return overlay as NGameOverScreen;
        });

        if (screen == null)
            return ExecutionResult.Failure("Game over screen not found");

        var phase = await GodotMainThread.RunAsync(() => GetPhase(screen));

        if (phase == Phase.Continue)
        {
            var continueBtn = await GodotMainThread.RunAsync(() => UiHelper.FindFirst<NGameOverContinueButton>(screen));
            if (continueBtn == null)
                return ExecutionResult.Failure("Continue button not found");

            var enabled = await GodotMainThread.RunAsync(() => continueBtn.IsEnabled);
            if (!enabled)
                return ExecutionResult.Failure("Continue button not yet enabled");

            await GodotMainThread.ClickAsync(continueBtn);
            Plugin.Log("Clicked continue on game over screen");
            return ExecutionResult.Success("Continued to the run summary");
        }
        else
        {
            var mainMenuBtn = await GodotMainThread.RunAsync(() => UiHelper.FindFirst<NReturnToMainMenuButton>(screen));
            if (mainMenuBtn == null)
                return ExecutionResult.Failure("Main menu button not found");

            NeuroIntegration.SendContext(BuildGameOverContext());
            await GodotMainThread.ClickAsync(mainMenuBtn);
            Plugin.Log("Clicked return to main menu on game over screen");
            GameStabilityDetector.AddDelayBeforeNextCheck(30);
            return ExecutionResult.Success("Returning to main menu");
        }
    }

    private static string BuildGameOverContext()
    {
        var history = RunManager.Instance?.History;
        if (history == null)
        {
            return "## Run Over\nThe game over screen is open, but the run history is unavailable.";
        }

        StringBuilder stringBuilder = new();
        stringBuilder.AppendLine(history.Win ? "## Victory" : "## Defeat");
        stringBuilder.AppendLine(GetOutcomeSentence(history));
        stringBuilder.AppendLine();
        stringBuilder.AppendLine("## Run Summary");
        stringBuilder.AppendLine($"- **Ascension:** {history.Ascension}");
        stringBuilder.AppendLine($"- **Run time:** {FormatRunTime(history.RunTime)}");
        stringBuilder.AppendLine($"- **Floor reached:** {history.MapPointHistory.Sum(act => act.Count)}");

        string? causeOfEnd = GetCauseOfEnd(history);
        if (!string.IsNullOrWhiteSpace(causeOfEnd))
        {
            string label = history.Win ? "Final encounter" : "Killed by";
            stringBuilder.AppendLine($"- **{label}:** {causeOfEnd}");
        }

        var runState = RunManager.Instance?.DebugOnlyGetState();
        if (runState != null)
        {
            stringBuilder.AppendLine($"- **Score:** {ScoreUtility.CalculateScore(runState, history.Win)}");
        }

        var players = GetOrderedPlayers(history).ToList();
        if (players.Count > 0)
        {
            stringBuilder.AppendLine();
            stringBuilder.AppendLine(players.Count == 1 ? "## Character" : "## Party");
            foreach (var player in players)
            {
                string localSuffix = LocalContext.NetId.HasValue && player.Id == LocalContext.NetId.Value ? " *(you)*" : "";
                stringBuilder.AppendLine($"- **{GetCharacterName(player)}**{localSuffix} - deck size {player.Deck.Count()}, relic count {player.Relics.Count()}");
            }
        }

        return stringBuilder.ToString().TrimEnd();
    }

    private static IEnumerable<RunHistoryPlayer> GetOrderedPlayers(RunHistory history)
    {
        return LocalContext.NetId.HasValue
            ? history.Players.OrderByDescending(player => player.Id == LocalContext.NetId.Value).ThenBy(player => player.Id)
            : history.Players.OrderBy(player => player.Id);
    }

    private static string GetCharacterName(RunHistoryPlayer player)
    {
        var character = ModelDb.GetByIdOrNull<CharacterModel>(player.Character);
        return character != null
            ? TextHelper.SafeLocString(() => character.Title)
            : player.Character.ToString();
    }

    private static string? GetCauseOfEnd(RunHistory history)
    {
        if (history.KilledByEncounter != ModelId.none)
        {
            var encounter = ModelDb.GetByIdOrNull<EncounterModel>(history.KilledByEncounter);
            return encounter != null
                ? TextHelper.SafeLocString(() => encounter.Title)
                : history.KilledByEncounter.ToString();
        }

        if (history.KilledByEvent != ModelId.none)
        {
            var evt = ModelDb.GetByIdOrNull<EventModel>(history.KilledByEvent);
            return evt != null
                ? TextHelper.SafeLocString(() => evt.Title)
                : history.KilledByEvent.ToString();
        }

        return null;
    }

    private static string GetOutcomeSentence(RunHistory history)
    {
        if (history.WasAbandoned)
        {
            return "The run was abandoned.";
        }

        return history.Win
            ? "The run ended in victory."
            : "The run ended in defeat.";
    }

    private static string FormatRunTime(float runTimeSeconds)
    {
        var duration = TimeSpan.FromSeconds(Math.Max(0, runTimeSeconds));
        return duration.TotalHours >= 1
            ? duration.ToString(@"h\:mm\:ss")
            : duration.ToString(@"mm\:ss");
    }
}
