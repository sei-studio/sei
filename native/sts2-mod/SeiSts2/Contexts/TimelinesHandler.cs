
using System.Reflection;
using System.Text;
using Godot;
using MegaCrit.Sts2.addons.mega_text;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Events;
using MegaCrit.Sts2.Core.Nodes.Events.Custom.CrystalSphere;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;
using MegaCrit.Sts2.Core.Nodes.Screens.Timeline;
using MegaCrit.Sts2.Core.Nodes.Screens.Timeline.UnlockScreens;
using MegaCrit.Sts2.Core.Timeline;
using NeuroSdk.Actions;
using NeuroSdk.Json;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using STS2NeuroIntegration;

namespace Sts2Agent.Contexts;

public class TimelinesHandler : IContextHandler<TimelinesHandler.Result>
{
    public class Result : IContextResult
    {
        // Empty result class
        internal NButton ProceedButton;
        internal NEpochSlot EpochButton;
        internal NEpochInspectScreen InspectScreen;
        internal NUnlockScreen UnlockScreen;
    }

    private sealed class PendingEpochUnlock(EpochModel epoch)
    {
        internal EpochModel Epoch { get; } = epoch;
        internal List<UnlockEntry> Entries { get; } = [];
    }

    private readonly record struct UnlockEntry(string Title, string Content);

    private static readonly BindingFlags PrivateInstance = BindingFlags.NonPublic | BindingFlags.Instance;
    private static readonly FieldInfo? CharacterScreenCharacterField = typeof(NUnlockCharacterScreen).GetField("_character", PrivateInstance);
    private static readonly FieldInfo? CardsScreenCardsField = typeof(NUnlockCardsScreen).GetField("_cards", PrivateInstance);
    private static readonly FieldInfo? RelicsScreenRelicsField = typeof(NUnlockRelicsScreen).GetField("_relics", PrivateInstance);
    private static readonly FieldInfo? PotionsScreenPotionsField = typeof(NUnlockPotionsScreen).GetField("_potions", PrivateInstance);
    private static readonly FieldInfo? MiscScreenTextField = typeof(NUnlockMiscScreen).GetField("_textToSet", PrivateInstance);
    private static readonly FieldInfo? TimelineScreenEpochsField = typeof(NUnlockTimelineScreen).GetField("_erasToUnlock", PrivateInstance);
    private static readonly FieldInfo? EpochScreenEpochsField = typeof(NUnlockEpochScreen).GetField("_unlockedEpochs", PrivateInstance);

    private PendingEpochUnlock? _pendingEpochUnlock;

    public ContextType Type => ContextType.TimelinesEvent;

    private SceneTreeTimer _softlocktimer;
    private SceneTreeTimer _fatalSoftlocktimer; // A Timer with a longer trigger window to handle fatel softlocks that can't be resolved from by rerunning actions

    // If we repeat the same action 10 times in a row, we will consider it a softlock and reset fatally
    private string previousAction = string.Empty;
    private int actionRepeatCount = 0;
    private CancellationTokenSource _scts = new();
    private CancellationToken _softlockFatalCancellationToken = new();
    public ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();
        // stringBuilder.AppendLine("You are at the Timelines Event");
        if (UiHelper.FindFirst<NTimelineTutorial>(ctx.TimelineScreen) is NTimelineTutorial tutorial)
        {
            stringBuilder.AppendLine(TextHelper.StripBBCode(tutorial.Get(NTimelineTutorial.PropertyName._text).As<MegaRichTextLabel>().Text.AsSingleLine()));
        }
        var tounlockEpochs = UiHelper.FindAll<NEpochSlot>(ctx.TimelineScreen);
        if (tounlockEpochs.Count > 0)
        {
            var tounlock = tounlockEpochs.Where(x => x.State == EpochSlotState.Obtained);
            // stringBuilder.AppendLine($"You have {tounlock.Count()} epochs to unlocked");
        }
        return new ContextReturn(stringBuilder.ToString());
    }

    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        if (UiHelper.FindFirst<NTimelineTutorial>(ctx.TimelineScreen) is { Visible: true } tutorial && IsTutorialReady(tutorial))
        {
            commands.Add(new("proceed", "Continue"));
            return new CommandReturn(commands, true);
        }

        var inspectScreen = UiHelper.FindFirst<NEpochInspectScreen>(ctx.TimelineScreen);
        if (inspectScreen != null && inspectScreen.Visible && IsInspectScreenReady(inspectScreen))
        {
            commands.Add(new("proceed_epoch", "Close the unlocked epoch"));
            return new CommandReturn(commands, true);
        }

        var unlockScreen = UiHelper.FindFirst<NUnlockScreen>(ctx.TimelineScreen);
        if (unlockScreen != null && unlockScreen.Visible && IsUnlockScreenReady(unlockScreen))
        {
            commands.Add(new("close_unlock", "Close the unlock screen"));
            return new CommandReturn(commands, true);
        }

        if (ctx.TimelineScreen.IsScreenQueued())
        {
            Plugin.LogDebug($" screen queue,Current State of things: InspectScreen: {inspectScreen?.Visible}, UnlockScreen: {unlockScreen?.Visible} ");
            return new CommandReturn(commands, true);
        }

        var tounlockEpochs = UiHelper.FindAll<NEpochSlot>(ctx.TimelineScreen);
        if (tounlockEpochs.Count > 0)
        {
            var tounlock = tounlockEpochs.Where(x => x.State == EpochSlotState.Obtained);
            if (tounlock.Any())
            {
                commands.Add(new("unlock_epoch", "Unlock the next obtained epoch. This gives you its rewards and story context for Slay the Spire 2."));
                return new CommandReturn(commands, true);
            }
        }
        var backButton = ctx.TimelineScreen.Get(NTimelineScreen.PropertyName._backButton).As<NBackButton>();
        if (backButton != null && backButton.IsEnabled && backButton.Visible)
        {
            commands.Add(new("back_to_main_menu", "Close the timeline and return to the main menu"));
        }
        Plugin.LogDebug($"Current State of things: InspectScreen: {inspectScreen?.Visible}, UnlockScreen: {unlockScreen?.Visible}, BackButton: {backButton?.Visible}");
        return new CommandReturn(commands, true);
    }

    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result result, ContextInfo ctx)
    {
        if (_softlocktimer == null)
        {
            ResetSoftlockTimer();
        }

        if (action.Name == previousAction)
        {
            actionRepeatCount++;
            Plugin.LogDebug($"Action {action.Name} has been repeated {actionRepeatCount} times");
            bool unlock_epoch_counter = action.Name == "unlock_epoch" && actionRepeatCount > 2; //This will unlikely be called many times in a row, but if it does, we will consider it a softlock and reset fatally
            bool proceed_epoch_counter = action.Name == "proceed_epoch" && actionRepeatCount > 10;
            bool proceed_counter = action.Name == "proceed" && actionRepeatCount > 10;
            bool close_unlock_counter = action.Name == "close_unlock" && actionRepeatCount > 10;
            bool back_to_main_menu_counter = action.Name == "back_to_main_menu" && actionRepeatCount > 2;

            bool isSoftlock = unlock_epoch_counter || proceed_epoch_counter || proceed_counter || close_unlock_counter || back_to_main_menu_counter;

            if (isSoftlock)
            {
                Plugin.LogDebug($"Action {action.Name} has been repeated {actionRepeatCount} times, triggering fatal softlock timer");
                _fatalSoftlocktimer?.Disconnect("timeout", Callable.From(OnFatalSoftlockTimeout));
                _fatalSoftlocktimer = null;
                OnFatalSoftlockTimeout();
                return ExecutionResult.Unstable($"Action {action.Name} has been repeated {actionRepeatCount} times, triggering fatal softlock timer");
            }
        }
        else
        {
            previousAction = action.Name;
            actionRepeatCount = 1;
        }

        if (action.Name == "proceed")
        {
            var timelineTutorial = UiHelper.FindFirst<NTimelineTutorial>(SceneHelper.GetSceneRoot());
            if (timelineTutorial is { Visible: true } && UiHelper.FindFirst<NAcknowledgeButton>(timelineTutorial) is { Visible: true, IsEnabled: true } acknowledgeButton)
            {
                result.ProceedButton = acknowledgeButton;
                return ExecutionResult.Success();
            }
            return ExecutionResult.Unstable("Couldn't find the proceed button");
        }
        if (action.Name == "unlock_epoch")
        {
            if (!IsTimelineIdle(ctx.TimelineScreen))
            {
                return ExecutionResult.Unstable("Timeline is still processing an unlock");
            }

            var tounlockEpochs = UiHelper.FindAll<NEpochSlot>(ctx.TimelineScreen);
            if (tounlockEpochs.Count > 0)
            {
                var tounlock = tounlockEpochs.Where(x => x.State == EpochSlotState.Obtained);
                if (tounlock.Any())
                {
                    result.EpochButton = tounlock.First();
                    return ExecutionResult.Success();
                }
            }
            return ExecutionResult.Unstable("No epochs to unlock");
        }
        if (action.Name == "proceed_epoch")
        {
            var inspectScreen = UiHelper.FindFirst<NEpochInspectScreen>(ctx.TimelineScreen);
            if (inspectScreen != null && inspectScreen.Visible && IsInspectScreenReady(inspectScreen))
            {
                result.InspectScreen = inspectScreen;
                return ExecutionResult.Success();
            }
            return ExecutionResult.Unstable("No proceed button found");
        }
        if (action.Name == "close_unlock")
        {

            var unlockScreen = UiHelper.FindFirst<NUnlockScreen>(ctx.TimelineScreen);
            if (unlockScreen != null && unlockScreen.Visible && IsUnlockScreenReady(unlockScreen))
            {
                var button = UiHelper.FindFirst<NUnlockConfirmButton>(unlockScreen);
                if (button != null)
                {
                    result.ProceedButton = button;
                    result.UnlockScreen = unlockScreen;
                    return ExecutionResult.Success();
                }
            }
            return ExecutionResult.ModFailure("Couldn't find the close button on the unlock screen");
        }

        if (action.Name == "back_to_main_menu")
        {
            var backButton = ctx.TimelineScreen.Get(NTimelineScreen.PropertyName._backButton).As<NBackButton>();
            if (backButton != null && backButton.IsEnabled && backButton.Visible)
            {
                result.ProceedButton = backButton;
                return ExecutionResult.Success();
            }
            return ExecutionResult.ModFailure("Couldn't find the Back button on the timeline");
        }

        return ExecutionResult.Unstable("Unknown action");
    }

    public static bool IsReadyForAction(NTimelineScreen timelineScreen)
    {
        if (UiHelper.FindFirst<NTimelineTutorial>(timelineScreen) is { Visible: true } tutorial)
        {
            return IsTutorialReady(tutorial);
        }

        if (UiHelper.FindFirst<NEpochInspectScreen>(timelineScreen) is { Visible: true } inspectScreen)
        {
            return IsInspectScreenReady(inspectScreen);
        }

        if (UiHelper.FindFirst<NUnlockScreen>(timelineScreen) is { Visible: true } unlockScreen)
        {
            return IsUnlockScreenReady(unlockScreen);
        }

        return !timelineScreen.IsScreenQueued();
    }

    private static bool IsTimelineIdle(NTimelineScreen timelineScreen)
    {
        return UiHelper.FindFirst<NTimelineTutorial>(timelineScreen) is not { Visible: true }
            && UiHelper.FindFirst<NEpochInspectScreen>(timelineScreen) is not { Visible: true }
            && UiHelper.FindFirst<NUnlockScreen>(timelineScreen) is not { Visible: true }
            && !timelineScreen.IsScreenQueued();
    }

    private static bool IsTutorialReady(NTimelineTutorial tutorial)
    {
        return UiHelper.FindFirst<NAcknowledgeButton>(tutorial) is { Visible: true, IsEnabled: true };
    }

    private static bool IsInspectScreenReady(NEpochInspectScreen inspectScreen)
    {
        return inspectScreen.GetNodeOrNull<NButton>("%CloseButton") is { Visible: true, IsEnabled: true };
    }

    private static bool IsUnlockScreenReady(NUnlockScreen unlockScreen)
    {
        return UiHelper.FindFirst<NUnlockConfirmButton>(unlockScreen) is { Visible: true, IsEnabled: true };
    }

    private void OnSoftlockTimeout()
    {
        Plugin.LogDebug("Softlock timer expired, sending unstable message");
        NeuroIntegration.Unstable();
    }

    private void OnFatalSoftlockTimeout()
    {
        Plugin.LogDebug("Fatal softlock timer expired, we are softlocked");
        //Reset Screen
        var backButton = NTimelineScreen.Instance.Get(NTimelineScreen.PropertyName._backButton).As<NBackButton>();
        if (backButton != null)
        {
            GodotMainThread.ClickAsync(backButton);
        }
        else
        {
            NTimelineScreen.Instance.CallDeferred(NTimelineScreen.MethodName.ResetScreen);
        }

        NeuroIntegration.Unstable();
        _scts.Cancel(); // Cancel any ongoing operations that might be waiting for user input or screen changes
    }

    private void ResetSoftlockTimer()
    {
        if (_softlocktimer != null)
        {
            _softlocktimer.Disconnect("timeout", Callable.From(OnSoftlockTimeout));
        }
        if (_fatalSoftlocktimer != null)
        {
            _fatalSoftlocktimer.Disconnect("timeout", Callable.From(OnFatalSoftlockTimeout));
        }
        _softlocktimer = SceneHelper.GetSceneRoot().GetTree().CreateTimer(15f);
        _softlocktimer.Connect("timeout", Callable.From(OnSoftlockTimeout));
        _fatalSoftlocktimer = SceneHelper.GetSceneRoot().GetTree().CreateTimer(60f);
        _fatalSoftlocktimer.Connect("timeout", Callable.From(OnFatalSoftlockTimeout));
    }

    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)
    {
        if (_softlocktimer != null && _fatalSoftlocktimer != null && GodotObject.IsInstanceValid(_softlocktimer) && GodotObject.IsInstanceValid(_fatalSoftlocktimer))
            Plugin.LogDebug($"Current Softlock Timers: SoftlockTimer: {_softlocktimer?.TimeLeft}, FatalSoftlockTimer: {_fatalSoftlocktimer?.TimeLeft}");
        await Task.Delay(1000);
        if (action.Name == "proceed" || action.Name == "back_to_main_menu")
        {
            _softlocktimer?.Disconnect("timeout", Callable.From(OnSoftlockTimeout));
            _softlocktimer = null;
            _fatalSoftlocktimer?.Disconnect("timeout", Callable.From(OnFatalSoftlockTimeout));

            _fatalSoftlocktimer = null;
            await GodotMainThread.ClickAsync(result.ProceedButton);
            await Task.Delay(1000);// wait for the screen to fade
            return ExecutionResult.Success();
        }
        if (action.Name == "unlock_epoch")
        {
            var cts_token = _scts.Token;
            if (result.EpochButton.model is EpochModel epochModel)
            {
                _pendingEpochUnlock = new PendingEpochUnlock(epochModel);
            }
            await GodotMainThread.ClickAsync(result.EpochButton);
            ResetSoftlockTimer();
            await Task.Delay(1000);// wait for the screen to fade


            ResetSoftlockTimer();
            await Task.Delay(3000);// wait for the screen to fade
            while (UiHelper.FindFirst<NEpochInspectScreen>(ctx.TimelineScreen) is { Visible: true } inspectScreen)
            {
                cts_token.ThrowIfCancellationRequested();

                if (!IsInspectScreenReady(inspectScreen))
                {
                    await Task.Delay(250);
                    continue;
                }
                if (inspectScreen.GetNodeOrNull<NButton>("%CloseButton") is not { Visible: true, IsEnabled: true } closeButton)
                {
                    await Task.Delay(250);
                    continue;
                }
                await Task.Delay(2000);
                await GodotMainThread.ClickAsync(closeButton);
                await Task.Delay(500);// wait for the screen to fade
                ResetSoftlockTimer();
                while (UiHelper.FindFirst<NUnlockScreen>(ctx.TimelineScreen) is { Visible: true } unlockScreen)
                {
                    cts_token.ThrowIfCancellationRequested();
                    if (!IsUnlockScreenReady(unlockScreen))
                    {
                        await Task.Delay(250);
                        continue;
                    }
                    if (UiHelper.FindFirst<NUnlockConfirmButton>(unlockScreen) is not { Visible: true, IsEnabled: true } confirmButton)
                    {
                        await Task.Delay(250);
                        continue;
                    }
                    AddUnlockEntry(unlockScreen);
                    await Task.Delay(2000);
                    await GodotMainThread.ClickAsync(confirmButton);
                    var nextUnlockScreen = await WaitForFollowUpUnlockScreen(ctx, unlockScreen);
                    while (nextUnlockScreen is NUnlockTimelineScreen)
                    {
                        AddUnlockEntry(nextUnlockScreen);
                        nextUnlockScreen = await WaitForFollowUpUnlockScreen(ctx, nextUnlockScreen);
                        ResetSoftlockTimer();
                    }

                    if (nextUnlockScreen is null)
                    {
                        FlushPendingEpochUnlock();
                        await Task.Delay(500);
                        actionRepeatCount = 0; // Reset the action repeat count after a successful unlock
                        previousAction = string.Empty; // Reset the previous action after a successful unlock
                        ResetSoftlockTimer();
                        return ExecutionResult.Success();
                    }
                }
            }

            return ExecutionResult.Unstable("Failed to unlock epoch, could not find the inspect screen or unlock screen");
        }
        if (action.Name == "proceed_epoch")
        {
            await GodotMainThread.RunAsync(result.InspectScreen.Close);
            await Task.Delay(1000);// wait for the screen to fade
            if (_pendingEpochUnlock != null && UiHelper.FindFirst<NUnlockScreen>(ctx.TimelineScreen) is not { Visible: true })
            {
                FlushPendingEpochUnlock();
            }
            ResetSoftlockTimer();
            await Task.Delay(500);
            return ExecutionResult.Success();
        }
        if (action.Name == "close_unlock")
        {
            AddUnlockEntry(result.UnlockScreen);
            await GodotMainThread.ClickAsync(result.ProceedButton);
            var nextUnlockScreen = await WaitForFollowUpUnlockScreen(ctx, result.UnlockScreen);
            while (nextUnlockScreen is NUnlockTimelineScreen)
            {
                AddUnlockEntry(nextUnlockScreen);
                nextUnlockScreen = await WaitForFollowUpUnlockScreen(ctx, nextUnlockScreen);
                ResetSoftlockTimer();
            }

            if (nextUnlockScreen is null)
            {
                FlushPendingEpochUnlock();
                return ExecutionResult.Success();
            }

            await Task.Delay(500);
            return ExecutionResult.Success();
        }
        return ExecutionResult.Unstable("Unknown action");
    }

    private static T? GetFieldValue<T>(FieldInfo? field, object instance)
    {
        if (field?.GetValue(instance) is T value)
        {
            return value;
        }
        return default;
    }

    private void AddUnlockEntry(NUnlockScreen unlockScreen)
    {
        if (_pendingEpochUnlock == null)
        {
            return;
        }

        UnlockEntry? entry = CreateUnlockEntry(unlockScreen);
        if (entry is { Content.Length: > 0 } unlockEntry)
        {
            _pendingEpochUnlock.Entries.Add(unlockEntry);
        }
    }

    private UnlockEntry? CreateUnlockEntry(NUnlockScreen unlockScreen)
    {
        return unlockScreen switch
        {
            NUnlockCharacterScreen characterScreen => CreateCharacterUnlockEntry(characterScreen),
            NUnlockCardsScreen cardsScreen => CreateCardsUnlockEntry(cardsScreen),
            NUnlockRelicsScreen relicsScreen => CreateRelicsUnlockEntry(relicsScreen),
            NUnlockPotionsScreen potionsScreen => CreatePotionsUnlockEntry(potionsScreen),
            NUnlockMiscScreen miscScreen => CreateMiscUnlockEntry(miscScreen),
            NUnlockTimelineScreen timelineScreen => CreateTimelineUnlockEntry(timelineScreen),
            NUnlockEpochScreen epochScreen => CreateEpochsUnlockEntry(epochScreen),
            _ => null
        };
    }

    private static UnlockEntry? CreateCharacterUnlockEntry(NUnlockCharacterScreen unlockScreen)
    {
        CharacterModel? character = GetFieldValue<CharacterModel>(CharacterScreenCharacterField, unlockScreen);
        if (character == null)
        {
            return null;
        }

        StringBuilder stringBuilder = new();
        stringBuilder.AppendLine(TextHelper.StripBBCode(character.Title.GetFormattedText()));
        stringBuilder.RepresentStartingCharacter(character);
        return new UnlockEntry("Character", stringBuilder.ToString().TrimEnd());
    }

    private static UnlockEntry? CreateCardsUnlockEntry(NUnlockCardsScreen unlockScreen)
    {
        IReadOnlyList<CardModel>? cards = GetFieldValue<IReadOnlyList<CardModel>>(CardsScreenCardsField, unlockScreen);
        if (cards == null || cards.Count == 0)
        {
            return null;
        }

        StringBuilder stringBuilder = new();
        stringBuilder.RepresentDeck(cards);
        return new UnlockEntry("Cards", stringBuilder.ToString().TrimEnd());
    }

    private static UnlockEntry? CreateRelicsUnlockEntry(NUnlockRelicsScreen unlockScreen)
    {
        IReadOnlyList<RelicModel>? relics = GetFieldValue<IReadOnlyList<RelicModel>>(RelicsScreenRelicsField, unlockScreen);
        if (relics == null || relics.Count == 0)
        {
            return null;
        }

        StringBuilder stringBuilder = new();
        stringBuilder.RepresentRelics(relics);
        return new UnlockEntry("Relics", stringBuilder.ToString().TrimEnd());
    }

    private static UnlockEntry? CreatePotionsUnlockEntry(NUnlockPotionsScreen unlockScreen)
    {
        IReadOnlyList<PotionModel>? potions = GetFieldValue<IReadOnlyList<PotionModel>>(PotionsScreenPotionsField, unlockScreen);
        if (potions == null || potions.Count == 0)
        {
            return null;
        }

        StringBuilder stringBuilder = new();
        foreach (var potionGroup in potions.GroupBy(potion => TextHelper.StripBBCode(potion.Title.GetFormattedText())))
        {
            PotionModel firstPotion = potionGroup.First();
            stringBuilder.AppendLine($"- {potionGroup.Count()}x {TextHelper.StripBBCode(firstPotion.Title.GetFormattedText())} \"{TextHelper.GetPotionDescription(firstPotion)}\"");
        }
        return new UnlockEntry("Potions", stringBuilder.ToString().TrimEnd());
    }

    private static UnlockEntry? CreateMiscUnlockEntry(NUnlockMiscScreen unlockScreen)
    {
        string? text = GetFieldValue<string>(MiscScreenTextField, unlockScreen);
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        return new UnlockEntry("Misc", TextHelper.StripBBCode(text));
    }

    private static UnlockEntry? CreateTimelineUnlockEntry(NUnlockTimelineScreen unlockScreen)
    {
        List<EpochSlotData>? epochSlots = GetFieldValue<List<EpochSlotData>>(TimelineScreenEpochsField, unlockScreen);
        if (epochSlots == null || epochSlots.Count == 0)
        {
            return null;
        }

        StringBuilder stringBuilder = new();
        foreach (EpochSlotData epochSlot in epochSlots.OrderBy(slot => slot.EraPosition))
        {
            stringBuilder.AppendLine($"- {GetEpochHeading(epochSlot.Model, markdownHeading: false)}");
            string slotText = GetEpochSlotText(epochSlot.Model, isRevealed: false);
            if (!string.IsNullOrWhiteSpace(slotText))
            {
                stringBuilder.AppendLine($"  {slotText}");
            }
        }
        return new UnlockEntry("Timeline", stringBuilder.ToString().TrimEnd());
    }

    private static UnlockEntry? CreateEpochsUnlockEntry(NUnlockEpochScreen unlockScreen)
    {
        IReadOnlyList<EpochModel>? epochs = GetFieldValue<IReadOnlyList<EpochModel>>(EpochScreenEpochsField, unlockScreen);
        if (epochs == null || epochs.Count == 0)
        {
            return null;
        }

        StringBuilder stringBuilder = new();
        foreach (EpochModel epoch in epochs)
        {
            stringBuilder.AppendLine($"- {GetEpochHeading(epoch, markdownHeading: false)}");
            string slotText = GetEpochSlotText(epoch, isRevealed: false);
            if (!string.IsNullOrWhiteSpace(slotText))
            {
                stringBuilder.AppendLine($"  {slotText}");
            }
        }
        return new UnlockEntry("Epochs", stringBuilder.ToString().TrimEnd());
    }

    private static string GetEpochHeading(EpochModel epoch, bool markdownHeading = true)
    {
        string prefix = markdownHeading ? "## " : "";
        string chapterTitle = TextHelper.StripBBCode(epoch.Title.GetFormattedText());
        if (epoch.ChapterIndex > 0)
        {
            return $"{prefix}Chapter {epoch.ChapterIndex} - {chapterTitle}";
        }

        return $"{prefix}{chapterTitle}";
    }

    private static string GetEpochSlotText(EpochModel epoch, bool isRevealed)
    {
        LocString unlockInfo = epoch.UnlockInfo;
        unlockInfo.Add("IsRevealed", variable: isRevealed);
        return TextHelper.StripBBCode(unlockInfo.GetFormattedText());
    }

    private void FlushPendingEpochUnlock()
    {
        if (_pendingEpochUnlock == null)
        {
            return;
        }

        string message = BuildEpochUnlockMessage(_pendingEpochUnlock);
        _pendingEpochUnlock = null;
        if (!string.IsNullOrWhiteSpace(message))
        {
            NeuroIntegration.SendContext(message);
        }
    }

    private static string BuildEpochUnlockMessage(PendingEpochUnlock pendingEpochUnlock)
    {
        StringBuilder stringBuilder = new();
        stringBuilder.AppendLine(GetEpochHeading(pendingEpochUnlock.Epoch));

        string epochText = GetEpochSlotText(pendingEpochUnlock.Epoch, isRevealed: true);
        if (!string.IsNullOrWhiteSpace(epochText))
        {
            stringBuilder.AppendLine(epochText);
        }

        if (pendingEpochUnlock.Entries.Count > 0)
        {
            stringBuilder.AppendLine();
            stringBuilder.AppendLine("## Unlocks:");
            foreach (UnlockEntry entry in pendingEpochUnlock.Entries)
            {
                stringBuilder.AppendLine($"### {entry.Title}");
                stringBuilder.AppendLine(entry.Content);
                stringBuilder.AppendLine();
            }
        }

        return stringBuilder.ToString().TrimEnd();
    }

    private static async Task<NUnlockScreen?> WaitForFollowUpUnlockScreen(ContextInfo ctx, NUnlockScreen closingScreen)
    {
        ulong closingScreenId = GodotObject.IsInstanceValid(closingScreen) ? closingScreen.GetInstanceId() : 0;
        for (int i = 0; i < 200; i++)
        {
            await Task.Delay(100);
            NUnlockScreen? unlockScreen = UiHelper.FindFirst<NUnlockScreen>(ctx.TimelineScreen);
            if (unlockScreen == null || !unlockScreen.Visible)
            {
                if (!GodotObject.IsInstanceValid(closingScreen) || !closingScreen.Visible)
                {
                    return null;
                }
                continue;
            }

            if (closingScreenId != 0 && unlockScreen.GetInstanceId() == closingScreenId)
            {
                continue;
            }

            return unlockScreen;
        }
        return UiHelper.FindFirst<NUnlockScreen>(ctx.TimelineScreen);
    }

}
