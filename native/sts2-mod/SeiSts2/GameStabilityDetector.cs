using System;
using Godot;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Nodes.Screens.Map;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using Sts2Agent.Contexts;
using Sts2Agent.Utilities;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;
using MegaCrit.Sts2.Core.Nodes.RestSite;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Multiplayer.Game;

namespace Sts2Agent;

public static class GameStabilityDetector
{
    public static event Action? OnBecameStable;
    private static bool _pendingCheck;
    private static bool _wasStable;
    private static bool _firstCheck;
    private static MegaCrit.Sts2.Core.GameActions.ActionExecutor? _subscribedExecutor;
    private static CombatManager? _subscribedCombat;
    private static readonly Callable StabilityCallable = Callable.From(CheckStability);

    private static int? _waitTimeBeforeNextCheck;
    private static int TimeSinceLastCheck;
    public static void Initialize()
    {
        TrySubscribeToActionExecutor();
        Plugin.LogDebug("GameStabilityDetector initialized.");
    }

    private static void OnBeforeAction(GameAction action)
    {
        Plugin.LogDebug($"OnBeforeAction: {action.GetType().Name}, _wasStable was {_wasStable} → false");
        _wasStable = false;
    }

    private static void OnAfterAction(GameAction action)
    {
        Plugin.LogDebug($"OnAfterAction: {action.GetType().Name}, scheduling stability check");
        ScheduleStabilityCheck();
    }

    private static void TrySubscribeToActionExecutor()
    {
        try
        {
            var executor = RunManager.Instance?.ActionExecutor;
            if (executor == null || executor == _subscribedExecutor) return;
            if (_subscribedExecutor != null)
            {
                _subscribedExecutor.BeforeActionExecuted -= OnBeforeAction;
                _subscribedExecutor.AfterActionExecuted -= OnAfterAction;
            }
            executor.BeforeActionExecuted += OnBeforeAction;
            executor.AfterActionExecuted += OnAfterAction;
            _subscribedExecutor = executor;
            Plugin.LogDebug("Subscribed to ActionExecutor events.");
        }
        catch (Exception e)
        {
            Plugin.LogDebug($"ActionExecutor not ready yet: {e.Message}");
        }
    }

    public static void SubscribeToCombat(CombatManager cm)
    {
        TrySubscribeToActionExecutor();
        UnsubscribeFromCombat();
        _subscribedCombat = cm;
        cm.PlayerActionsDisabledChanged += OnCombatStateChanged;
        cm.TurnStarted += OnCombatStateChanged;
        cm.CombatEnded += OnCombatEnded;
    }

    public static void OnActionStarting()
    {
        _wasStable = false;
    }

    /// <summary>
    /// Reset _wasStable so the next CheckStability that finds stable=true
    /// will fire OnBecameStable. Called after action execution paths reset
    /// their decision-point state and before a post-action stability check.
    /// </summary>
    public static void ResetWasStable()
    {
        Plugin.LogDebug($"ResetWasStable: _wasStable was {_wasStable}, setting to false");
        _wasStable = false;
        _firstCheck = true;
    }

    public static void OnHandSelectionEntered()
    {
        Plugin.LogDebug("Hand selection entered — scheduling stability check");
        _wasStable = false;
        ScheduleStabilityCheck();
    }

    public static void OnRoomEntered()
    {
        _wasStable = false;
        ScheduleStabilityCheck();
    }

    public static void OnScreenTransition()
    {
        _wasStable = false;
        ScheduleStabilityCheck();
    }

    public static void OnOverlayChanged()
    {
        _wasStable = false;
        ScheduleStabilityCheck();
    }

    public static void AddDelayBeforeNextCheck(int seconds)
    {
        Plugin.LogDebug($"Adding delay of {seconds} seconds before next stability check can pass");
        _waitTimeBeforeNextCheck = seconds;
        TimeSinceLastCheck = 0;
    }
    public static void ScheduleStabilityCheck()
    {
        if (_pendingCheck) return;
        _pendingCheck = true;
        GodotMainThread.RunAsync(() => StabilityCallable.Call());
    }

    private static void CheckStability()
    {
        _pendingCheck = false;
        if (_wasStable)
        {
            Plugin.LogDebug("CheckStability: already stable, skipping check");
            return;
        }
        var stable = IsStable();
        if (stable && !_wasStable)
        {
            _wasStable = true;
            Plugin.Log("=== GAME STABLE ===");
            OnBecameStable?.Invoke();
            _firstCheck = true;
        }
        else if (stable && _wasStable)
        {
            Plugin.LogDebug("CheckStability: stable but _wasStable already true — no event fired (expected after initial signal)");
        }
        else if (!stable)
        {
            _wasStable = false;
            // Re-poll: game actions (animations, transitions) may still be running.
            // Schedule another check so we don't depend solely on events.
            ScheduleDelayedCheck();
        }
    }

    private static void OnDelayedCheckTimeout()
    {
        _pendingCheck = false;
        ScheduleStabilityCheck();
    }

    private static void ScheduleDelayedCheck()
    {
        if (_pendingCheck) return;
        _pendingCheck = true;
        if (Engine.GetMainLoop() is not SceneTree tree)
        {
            Plugin.LogDebug("ScheduleDelayedCheck: SceneTree is null, clearing _pendingCheck to avoid deadlock");
            _pendingCheck = false;
            return;
        }
        var timer = tree.CreateTimer(0.1);
        timer.Timeout += OnDelayedCheckTimeout;
    }


    private static void LogDebug(string message)
    {
        if (_firstCheck)
            Plugin.LogDebug($"[GameStabilityDetector] {message}");
    }

    public static bool IsStable()
    {
        if (_waitTimeBeforeNextCheck != null)
        {
            if (TimeSinceLastCheck < _waitTimeBeforeNextCheck)
            {
                Plugin.LogDebug($"IsStable: waiting before next check ({TimeSinceLastCheck}/{_waitTimeBeforeNextCheck} seconds) → false");
                TimeSinceLastCheck++;
                return false;
            }
            else
            {
                Plugin.LogDebug("IsStable: wait time elapsed, proceeding with stability check");
                _waitTimeBeforeNextCheck = null;
                TimeSinceLastCheck = 0;
            }
        }
        try
        {
            LogDebug("Checking game stability...");
            var ctx = GameContext.Resolve();
            if (ctx == null)
            {
                LogDebug("IsStable: no context → false");
                return false;
            }

            if (ActionExecutor.HasRunningActions())
            {
                LogDebug("IsStable: integration action still running → false");
                return false;
            }

            if (!IsMultiplayerStable(ctx))
            {
                LogDebug("IsStable: multiplayer state not stable → false");
                return false;
            }

            switch (ctx.Type)
            {
                case ContextType.Unknown:
                    LogDebug("IsStable: unknown context → false");
                    return false;

                case ContextType.Map:
                    {
                        if (_firstCheck)
                        {
                            LogDebug("First check for event context, adding wait time before next check to allow event options to populate");
                            _waitTimeBeforeNextCheck = 10; // Wait for 5 seconds before allowing stability checks to pass, giving time for event options to populate
                            return false;
                        }
                        var ms = NMapScreen.Instance;
                        if (ms is { IsTravelEnabled: true })
                        {
                            Plugin.LogDebug("IsStable: map screen, travel enabled → true");
                            return true;
                        }
                        // Map is open but not interactive — if travel finished, close it
                        // so the room underneath becomes visible to viewers and agent
                        if (ms is { IsTraveling: false })
                        {
                            Plugin.Log("Map overlay stuck open after travel — closing");
                            ms.Close();
                        }
                        if (ms != null)
                            LogDebug($"IsStable: map screen, travel not enabled (traveling={ms?.IsTraveling}) → false");
                        return false;
                    }

                case ContextType.BundleSelection:
                case ContextType.CardSelection:
                case ContextType.CrystalBallEvent:
                case ContextType.Rewards:
                    LogDebug($"IsStable: overlay {ctx.Type} → true");
                    return true;

                case ContextType.HandSelection:
                    LogDebug("IsStable: hand card selection → true");
                    return true;

                case ContextType.Combat:
                    {
                        var cm = CombatManager.Instance;
                        var pcs = LocalContext.GetMe(ctx.RunState.Players)?.PlayerCombatState;
                        var result = cm != null
                            && pcs != null
                            && pcs.Phase == PlayerTurnPhase.Play
                            && !cm.PlayerActionsDisabled
                            && RunManager.Instance.ActionExecutor.CurrentlyRunningAction == null;
                        if (cm != null && pcs != null)
                            LogDebug($"IsStable: combat → IsPlayPhase={pcs?.Phase == PlayerTurnPhase.Play}, Current Phase= {pcs?.Phase}, ActionsDisabled={cm?.PlayerActionsDisabled}, RunningAction={RunManager.Instance.ActionExecutor.CurrentlyRunningAction?.GetType().Name ?? "null"} → {result}");
                        if (result)
                        {
                            Plugin.LogDebug($"Combat is Stable");
                        }
                        return result;
                    }

                case ContextType.Event:
                    {
                        var evt = ctx.EventRoom?.LocalMutableEvent;
                        if ((evt is AncientEventModel && EventContextHandler.TryAdvanceAncientDialogue()) || evt == null || evt.Node == null || !evt.Node.Visible)
                            return false;
                        if (_firstCheck)
                        {
                            LogDebug("First check for event context, adding wait time before next check to allow event options to populate");
                            _waitTimeBeforeNextCheck = 10; // Wait for 5 seconds before allowing stability checks to pass, giving time for event options to populate
                            return false;
                        }
                        var evtResult = evt != null && (evt.CurrentOptions.Count > 0 || evt.IsFinished);
                        if (evt != null)
                            LogDebug($"IsStable: event → hasEvent={evt != null}, options={evt?.CurrentOptions.Count ?? 0}, finished={evt?.IsFinished} → {evtResult}");
                        if (evtResult)
                        {
                            Plugin.LogDebug($"IsStable: event → {evtResult}");
                        }
                        return evtResult;
                    }

                case ContextType.RestSite:
                    if (ctx.RestSiteRoom != null && NRestSiteRoom.Instance is NRestSiteRoom restSite)
                    {
                        if (UiHelper.FindFirst<NProceedButton>(restSite) is NProceedButton proceedBtn && proceedBtn.Visible && proceedBtn.IsEnabled)
                        {
                            var proceedEnabled = proceedBtn.IsEnabled;
                            Plugin.LogDebug($"IsStable Restsite: proceed button enabled={proceedEnabled} → {proceedEnabled}");
                            return proceedEnabled;
                        }
                        if (UiHelper.FindAll<NRestSiteButton>(restSite) is IEnumerable<NRestSiteButton> anyBtn && anyBtn.Any(b => b.Visible && b.IsEnabled))
                        {
                            var anyBtnEnabled = anyBtn.Any(b => b.Visible && b.IsEnabled);
                            Plugin.LogDebug($"IsStable Restsite: any button enabled={anyBtnEnabled} → {anyBtnEnabled}");
                            return anyBtnEnabled;
                        }
                    }

                    LogDebug($"IsStable Restsite: {ctx.Type} → false");
                    return false;
                case ContextType.Shop:
                    Plugin.LogDebug($"IsStable: {ctx.Type} → true");
                    return true;

                case ContextType.GameOver:
                    {
                        var goScreen = MegaCrit.Sts2.Core.Nodes.Screens.Overlays.NOverlayStack.Instance?.Peek()
                            as MegaCrit.Sts2.Core.Nodes.Screens.GameOverScreen.NGameOverScreen;
                        if (goScreen == null)
                        {
                            LogDebug("IsStable: game over screen not found → false");
                            return false;
                        }
                        var mainMenuBtn = UiHelper.FindFirst<MegaCrit.Sts2.Core.Nodes.Screens.GameOverScreen.NReturnToMainMenuButton>(goScreen);
                        if (mainMenuBtn != null && mainMenuBtn.Visible && mainMenuBtn.IsEnabled)
                        {
                            Plugin.LogDebug("IsStable: game over main menu button ready → true");
                            return true;
                        }
                        var continueBtn = UiHelper.FindFirst<MegaCrit.Sts2.Core.Nodes.Screens.GameOverScreen.NGameOverContinueButton>(goScreen);
                        var ready = continueBtn != null && continueBtn.IsEnabled;
                        LogDebug($"IsStable: game over continue enabled={ready} → {ready}");
                        return ready;
                    }

                case ContextType.MainMenu:
                    LogDebug("IsStable: main menu → true");
                    return true;
                case ContextType.TimelinesEvent:
                    if (_firstCheck)
                    {
                        LogDebug("First check for event context, adding wait time before next check to allow event options to populate");
                        _waitTimeBeforeNextCheck = 10; // Wait for 5 seconds before allowing stability checks to pass, giving time for event options to populate
                        return false;
                    }
                    var timelineReady = ctx.TimelineScreen != null && TimelinesHandler.IsReadyForAction(ctx.TimelineScreen);
                    LogDebug($"IsStable: timelines event ready={timelineReady} → {timelineReady}");
                    return timelineReady;
                case ContextType.CharacterSelect:
                    LogDebug("IsStable: character select → true");
                    return true;

                case ContextType.Treasure:
                    {
                        if (TreasureRoomAutoPatch.AutoClickInProgress)
                        {
                            LogDebug("IsStable: treasure auto-click in progress → false");
                            return false;
                        }
                        var treasureRoom = TreasureRoomAutoPatch.CurrentRoom;
                        var proceedEnabled = treasureRoom != null
                            && GodotObject.IsInstanceValid(treasureRoom)
                            && treasureRoom.ProceedButton?.IsEnabled == true;
                        LogDebug($"IsStable: treasure proceed={proceedEnabled} → {proceedEnabled}");
                        if (TreasureHandler.FoundRelics.Count > 0 && !proceedEnabled && Plugin.IsMultiplayer()) // We only need to decide in multiplayer
                        {
                            LogDebug("IsMultiplayerStable: treasure room has relics, therefore we need to decide what to pick -> true");
                            return true;
                        }
                        return proceedEnabled;
                    }
                default:
                    return false;
            }
        }
        finally
        {
            _firstCheck = false;
        }
    }

    //TODO: Event also seems to return stable even without options. Maybe stability check happens for every user connected? instead of just the local player?
    private static bool IsMultiplayerStable(ContextInfo ctx)
    {
        LogDebug("Checking multiplayer stability...");
        if (RunManager.Instance == null)
        {
            Plugin.LogDebug("IsMultiplayerStable: RunManager instance is null → true (not in a run)");
            return true;
        }
        if (RunManager.Instance.NetService == null)
        {
            Plugin.LogDebug("IsMultiplayerStable: NetService is null → true (not in a run)");
            return true;
        }
        if (!RunManager.Instance.NetService.Type.IsMultiplayer()) return true;
        LogDebug("IsMultiplayerStable: multiplayer run detected");

        switch (ctx.Type)
        {
            case ContextType.Combat:
                {
                    var player = LocalContext.GetMe(ctx.RunState.Players);
                    if (player == null)
                    {
                        LogDebug("IsMultiplayerStable: local player not found → false");
                        return false;
                    }
                    var pcs = player?.PlayerCombatState;
                    if (pcs == null)
                    {
                        LogDebug("IsMultiplayerStable: player combat state is null → false");
                        return false;
                    }
                    var combatManager = CombatManager.Instance;
                    if (combatManager == null)
                    {
                        LogDebug("IsMultiplayerStable: combat manager instance is null → false");
                        return false;
                    }
                    var stable = (pcs.Phase == PlayerTurnPhase.Play || pcs.Phase == PlayerTurnPhase.Start) && !combatManager.IsPlayerReadyToEndTurn(player);
                    LogDebug($"IsMultiplayerStable: combat phase={pcs.Phase} → {stable}");
                    if (!stable) return false;
                    return true;
                }
            case ContextType.Map:
                {
                    if (_firstCheck)
                    {
                        _waitTimeBeforeNextCheck = 10; // Wait for 5 seconds before allowing stability checks to pass, giving time for event options to populate
                        return false;
                    }
                    var ms = NMapScreen.Instance;
                    var player = LocalContext.GetMe(ctx.RunState.Players);
                    if (player == null)
                    {
                        LogDebug("IsMultiplayerStable: local player not found → false");
                        return false;
                    }
                    if (ms is { IsTravelEnabled: true, IsOpen: true })
                    {
                        if (ms.PlayerVoteDictionary.TryGetValue(player, out var vote) && vote != null)
                        {
                            LogDebug($"IsMultiplayerStable: player vote={vote} → false (waiting for all votes)");
                            return false;
                        }
                        Plugin.LogDebug("IsMultiplayerStable: map screen, travel enabled → true");
                        return true;
                    }
                    // Map is open but not interactive — if travel finished, close it
                    // so the room underneath becomes visible to viewers and agent
                    if (ms is { IsTraveling: false })
                    {
                        Plugin.Log("Map overlay stuck open after travel — closing");
                        ms.Close();
                    }
                    if (ms != null)
                        LogDebug($"IsMultiplayerStable: map screen, travel not enabled (traveling={ms?.IsTraveling}) → false");
                    return false;
                }
            case ContextType.CharacterSelect:
                {
                    var selectScreen = ctx.CharacterSelectScreen;
                    if (selectScreen == null || !GodotObject.IsInstanceValid(selectScreen))
                    {
                        LogDebug("IsMultiplayerStable: character select screen not found → false");
                        return false;
                    }
                    var localPlayer = selectScreen.Lobby.LocalPlayer;
                    if (localPlayer.isReady)
                    {
                        LogDebug("IsMultiplayerStable: character select, local player ready → true, Waiting for other players");
                        return false;
                    }

                    return true;
                }
            default:
                return true;
        }
    }

    private static void OnCombatStateChanged(CombatState _) => ScheduleStabilityCheck();

    private static void OnCombatEnded(CombatRoom _)
    {
        UnsubscribeFromCombat();
        _wasStable = false;
        ScheduleStabilityCheck();
    }

    private static void UnsubscribeFromCombat()
    {
        if (_subscribedCombat == null) return;
        _subscribedCombat.PlayerActionsDisabledChanged -= OnCombatStateChanged;
        _subscribedCombat.TurnStarted -= OnCombatStateChanged;
        _subscribedCombat.CombatEnded -= OnCombatEnded;
        _subscribedCombat = null;
    }
}
