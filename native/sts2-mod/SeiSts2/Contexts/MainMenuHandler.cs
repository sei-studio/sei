using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using System.Text;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Platform;
using MegaCrit.Sts2.Core.Helpers;
using SceneHelper = Sts2Agent.Utilities.SceneHelper;

namespace Sts2Agent.Contexts;

public class MainMenuHandler : IContextHandler<MainMenuHandler.Result>
{
    public class Result : IContextResult
    {
        public NClickableControl Button { get; internal set; }
    }
    public ContextType Type => ContextType.MainMenu;

    public ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();
        var sceneRoot = SceneHelper.GetSceneRoot();
        var mainMenu = sceneRoot != null ? UiHelper.FindFirst<NMainMenu>(sceneRoot) : null;
        if (mainMenu == null) return new ContextReturn(stringBuilder.ToString());
        var timelineButton = mainMenu.Get(NMainMenu.PropertyName._timelineButton).As<NMainMenuTextButton>();
        var notification = mainMenu.Get(NMainMenu.PropertyName._timelineNotificationDot).As<Control>();

        if (Plugin.WantsMultiplayer())
        {
            stringBuilder.AppendLine("Multiplayer mode is enabled. Automatically navigating to multiplayer lobby");
            var mpButton = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/MultiplayerButton");
            if (mpButton != null && mpButton.IsEnabled)
            {
                return new ContextReturn(stringBuilder.ToString(), false);
            }
        }
        if (notification.Visible && timelineButton.IsEnabled)
        {
            stringBuilder.AppendLine("You have an unseen epoch to unlock. Automatically unlocking it now");
            return new ContextReturn(stringBuilder.ToString(), false);
        }
        if (SaveManager.Instance.HasRunSave)
        {

            stringBuilder.AppendLine("You have a previous run in progress. Automatically continuing it now");
            var continueBtn = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/ContinueButton");
            if (continueBtn != null && continueBtn.IsEnabled)
            {
                return new ContextReturn(stringBuilder.ToString(), false);
            }
        }
        else
        {

            // stringBuilder.AppendLine("Select a Character, Start your Adventure! And Conquer the Spire");
            var spButton = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/SingleplayerButton");
            if (spButton != null && spButton.IsEnabled)
            {
                return new ContextReturn(stringBuilder.ToString(), false);
            }
        }
        return new ContextReturn(stringBuilder.ToString(), false);
    }
    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();

        var sceneRoot = SceneHelper.GetSceneRoot();
        var mainMenu = sceneRoot != null ? UiHelper.FindFirst<NMainMenu>(sceneRoot) : null;
        if (mainMenu == null) return new CommandReturn();

        if (Plugin.WantsMultiplayer())
        {
            var mpButton = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/MultiplayerButton");
            if (mpButton != null && mpButton.IsEnabled)
                commands.Add(new ConstructedAction("multiplayer", "Go to multiplayer lobby"));
        }
        else
        {

            if (SaveManager.Instance.HasRunSave)
            {
                var continueBtn = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/ContinueButton");
                if (continueBtn != null && continueBtn.IsEnabled)
                    commands.Add(new ConstructedAction("continue_run", "Continue your last run"));
            }
            else
            {
                var spButton = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/SingleplayerButton");
                if (spButton != null && spButton.IsEnabled)
                    commands.Add(new ConstructedAction("start_run", "Start a new run"));
            }
        }

        var timelineButton = mainMenu.Get(NMainMenu.PropertyName._timelineButton).As<NMainMenuTextButton>();
        var notification = mainMenu.Get(NMainMenu.PropertyName._timelineNotificationDot).As<Control>();

        if (notification.Visible && timelineButton.IsEnabled)
        {
            commands.Add(new ConstructedAction("view_timeline", "View the Timeline and explore unseen epochs"));
        }

        return new CommandReturn(commands, true);
    }

    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {
        var sceneRoot = SceneHelper.GetSceneRoot();
        var mainMenu = sceneRoot != null ? UiHelper.FindFirst<NMainMenu>(sceneRoot) : null;
        if (mainMenu == null) return ExecutionResult.Failure("Not in the main menu; can't call this action");
        switch (action.Name)
        {
            case "continue_run":
                var continueBtn = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/ContinueButton");
                if (continueBtn != null && continueBtn.IsEnabled)
                {
                    parsedData.Button = continueBtn;
                    return ExecutionResult.Success();
                }
                else
                    return ExecutionResult.ModFailure("Can't continue a run when no previous run exists");
            case "abandon_run":
                var abandonBtn = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/AbandonRunButton");
                if (abandonBtn != null && abandonBtn.IsEnabled)
                {
                    parsedData.Button = abandonBtn;
                    return ExecutionResult.Success();
                }
                else
                    return ExecutionResult.ModFailure("Can't abandon a run when no previous run exists");
            case "multiplayer":
                var mpButton = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/MultiplayerButton");
                if (mpButton != null && mpButton.IsEnabled)
                {
                    parsedData.Button = mpButton;
                    return ExecutionResult.Success();
                }
                else
                    return ExecutionResult.ModFailure("Multiplayer button is not available or not enabled");
            case "start_run":
                var spButton = mainMenu.GetNode<NClickableControl>("MainMenuTextButtons/SingleplayerButton");
                if (spButton != null && spButton.IsEnabled)
                {
                    parsedData.Button = spButton;
                    return ExecutionResult.Success();
                }
                else
                    return ExecutionResult.ModFailure("Can't start a run. A run is already active.");
            case "view_timeline":
                var timelineButton = mainMenu.Get(NMainMenu.PropertyName._timelineButton).As<NMainMenuTextButton>();
                if (timelineButton.IsEnabled)
                {
                    parsedData.Button = timelineButton;
                    return ExecutionResult.Success();
                }
                else
                    return ExecutionResult.ModFailure("Timeline is not available or not enabled");
        }

        return ExecutionResult.Failure("Unknown action called in the main menu");
    }
    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)
    {
        Plugin.LogDebug($"Action: {action},result {result}, contextinfo {ctx}");
        var sceneRoot = SceneHelper.GetSceneRoot();
        await Task.Delay(2000);
        if (action.Name == "continue_run")
        {
            await GodotMainThread.ClickAsync(result.Button);

            // Wait for the run to load
            for (int i = 0; i < 100; i++)
            {
                await Task.Delay(200);
                if (RunManager.Instance?.IsInProgress == true)
                    break;
            }

            Plugin.Log("Continued saved run");
            return ExecutionResult.Success("Continued the saved run");
        }

        if (action.Name == "abandon_run")
        {
            await GodotMainThread.ClickAsync(result.Button);

            // The abandon button shows a confirmation popup — find and click "Yes"
            await Task.Delay(500);
            var yesBtn = await GodotMainThread.RunAsync(() =>
            {
                var popup = UiHelper.FindFirst<NAbandonRunConfirmPopup>(sceneRoot);
                return popup?.GetNode<NClickableControl>("VerticalPopup/YesButton");
            });

            if (yesBtn != null)
            {
                await GodotMainThread.ClickAsync(yesBtn);
                await Task.Delay(500);
            }

            Plugin.Log("Abandoned saved run");
            // GameStabilityDetector.ResetWasStable();
            return ExecutionResult.Success("Abandoned the saved run");
        }

        if (action.Name == "start_run")
        {
            await GodotMainThread.ClickAsync(result.Button);
            await Task.Delay(500);

            // Check if we landed on character select directly (first-time player)
            var charScreen = await GodotMainThread.RunAsync(() =>
                UiHelper.FindFirst<NCharacterSelectScreen>(sceneRoot));
            if (charScreen != null && charScreen.Visible)
            {
                Plugin.Log("Navigated directly to character select");
                return ExecutionResult.Success("Navigated to character select");
            }

            // Click the Standard button on the singleplayer submenu
            var spSubmenu = await GodotMainThread.RunAsync(() =>
                UiHelper.FindFirst<NSingleplayerSubmenu>(sceneRoot));
            if (spSubmenu == null || !spSubmenu.Visible)
                return ExecutionResult.Failure("Singleplayer submenu not found");

            var stdButton = await GodotMainThread.RunAsync(() =>
                spSubmenu.GetNode<NClickableControl>("StandardButton"));
            if (stdButton == null)
                return ExecutionResult.Failure("Standard button not found");

            await GodotMainThread.ClickAsync(stdButton);

            // Wait for character select screen to appear
            for (int i = 0; i < 30; i++)
            {
                await Task.Delay(100);
                var cs = await GodotMainThread.RunAsync(() =>
                    UiHelper.FindFirst<NCharacterSelectScreen>(sceneRoot));
                if (cs != null && cs.Visible)
                {
                    Plugin.Log("Navigated to character select via singleplayer submenu");
                    await Task.Delay(100);

                    return ExecutionResult.Success("Navigated to character select");
                }
            }

            return ExecutionResult.Failure("Timed out waiting for character select screen");
        }
        if (action.Name == "multiplayer")
        {
            await GodotMainThread.ClickAsync(result.Button);
            await Task.Delay(500);

            var mpSubmenu = await GodotMainThread.RunAsync(() => UiHelper.FindFirst<NMultiplayerSubmenu>(sceneRoot));
            if (mpSubmenu == null || !mpSubmenu.Visible)
                return ExecutionResult.Unstable("Multiplayer submenu not found");

            await Task.Delay(500);

            if (Plugin.Multiplayer.WantsHost)
            {
                Plugin.Log("Navigated to multiplayer lobby as host");
                if (Plugin.Multiplayer.WantsHostAbandonSave)
                {
                    var abandonButton = mpSubmenu.GetNode<NSubmenuButton>("ButtonContainer/AbandonButton");
                    if (abandonButton != null && abandonButton.IsEnabled && abandonButton.IsVisibleInTree())
                    {
                        await GodotMainThread.ClickAsync(abandonButton);
                        await Task.Delay(500);
                        Plugin.Log("Abandoned existing run from multiplayer submenu");
                    }
                }
                var loadButton = mpSubmenu.GetNode<NSubmenuButton>("ButtonContainer/LoadButton");
                Plugin.Log($"Load button found: {loadButton != null}, enabled: {loadButton?.IsEnabled}");
                if (loadButton != null && loadButton.IsEnabled && loadButton.IsVisibleInTree())
                {
                    await GodotMainThread.ClickAsync(loadButton);
                    await Task.Delay(500);
                    return ExecutionResult.Success("Loaded existing multiplayer run");
                }
                var newButton = mpSubmenu.GetNode<NSubmenuButton>("ButtonContainer/HostButton");
                Plugin.Log($"Host button found: {newButton != null}, enabled: {newButton?.IsEnabled}");
                if (newButton != null && newButton.IsEnabled && newButton.IsVisibleInTree())
                {
                    await GodotMainThread.ClickAsync(newButton);
                    await Task.Delay(500);
                    var newSubMenu = await GodotMainThread.RunAsync(() => UiHelper.FindFirst<NMultiplayerHostSubmenu>(sceneRoot));
                    if (newSubMenu == null || !newSubMenu.Visible)
                        return ExecutionResult.Failure("Multiplayer host submenu not found");
                    var stdButton = await GodotMainThread.RunAsync(() => newSubMenu.GetNode<NClickableControl>("StandardButton"));
                    if (stdButton == null)
                        return ExecutionResult.Failure("Standard button not found");

                    await GodotMainThread.ClickAsync(stdButton);

                    // Wait for character select screen to appear
                    for (int i = 0; i < 30; i++)
                    {
                        await Task.Delay(100);
                        var cs = await GodotMainThread.RunAsync(() =>
                            UiHelper.FindFirst<NCharacterSelectScreen>(sceneRoot));
                        if (cs != null && cs.Visible)
                        {
                            Plugin.Log("Navigated to character select via singleplayer submenu");
                            await Task.Delay(100);

                            return ExecutionResult.Success("Navigated to character select");
                        }
                    }

                    return ExecutionResult.Success("Started new multiplayer run");
                }
                //Check if we have a running run and if so, click the "Host with current run" button
                return ExecutionResult.Success("Navigated to multiplayer lobby as host");
            }
            else if (Plugin.Multiplayer.WantsJoin)
            {
                Plugin.Log("Navigated to multiplayer lobby as joiner");
                var joinButton = mpSubmenu.GetNode<NSubmenuButton>("ButtonContainer/JoinButton");
                if (joinButton != null && joinButton.IsEnabled)
                {
                    await GodotMainThread.ClickAsync(joinButton);
                    await Task.Delay(500);
                    var joinSubMenu = await GodotMainThread.RunAsync(() => UiHelper.FindFirst<NJoinFriendScreen>(sceneRoot));
                    if (joinSubMenu == null || !joinSubMenu.Visible)
                        return ExecutionResult.Failure("Join friend screen not found");

                    var buttonsContainer = joinSubMenu.GetNode<Control>("%ButtonContainer");
                    if (buttonsContainer == null || !buttonsContainer.Visible)
                        return ExecutionResult.Failure("Buttons container not found in join friend screen");
                    var refreshButton = joinSubMenu.GetNode<NJoinFriendRefreshButton>("%RefreshButton");
                    if (refreshButton == null || !refreshButton.IsEnabled)
                        return ExecutionResult.Failure("Refresh button not found or not enabled in join friend screen");

                    NJoinFriendButton? targetButton = null;

                    while (targetButton == null)
                    {
                        Plugin.Log("Looking for joinable friend buttons...");
                        await Task.Delay(5000);
                        targetButton = buttonsContainer.GetChildren().OfType<NJoinFriendButton>()
                            .FirstOrDefault(b => Plugin.Multiplayer.JoinName == null || StringHelper.Slugify(PlatformUtil.GetPlayerName(PlatformUtil.PrimaryPlatform, b.PlayerId)) == StringHelper.Slugify(Plugin.Multiplayer.JoinName));
                        if (targetButton == null)
                            await GodotMainThread.ClickAsync(refreshButton);
                    }

                    await GodotMainThread.ClickAsync(targetButton);

                    return ExecutionResult.Success("Joined multiplayer run");
                }
                return ExecutionResult.Unstable("Join button not found or disabled");
            }
            return ExecutionResult.Unstable("Unknown multiplayer state");
        }
        if (action.Name == "view_timeline")
        {
            NeuroIntegration.Unstable();
            await GodotMainThread.ClickAsync(result.Button);
            NeuroIntegration.Unstable();
            await Task.Delay(500);
            NeuroIntegration.Unstable();
            await Task.Delay(500);
            NeuroIntegration.Unstable();

            return ExecutionResult.Success("Opened the timeline");
        }

        return ExecutionResult.Failure("Unknown action");
    }

}
