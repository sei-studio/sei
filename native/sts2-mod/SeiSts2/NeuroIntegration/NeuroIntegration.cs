using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Godot;
using MegaCrit.Sts2.Core.Logging;
using NeuroSdk.Actions;
using NeuroSdk.Messages.Outgoing;
using NeuroSdk.Websocket;
using Sts2Agent;
using Sts2Agent.Contexts;
using Sts2Agent.Utilities;
namespace STS2NeuroIntegration;

public class NeuroIntegration : Node
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };
    public static NeuroIntegration? Instance
    {
        get; private set;
    }

    private ActionWindow? lastWindow;

    /// <summary>
    /// These are Actions that are always available for neuro.
    /// if they are one-time use the Action itself has to handle this
    /// </summary>
    public List<ConstructedAction> GlobalActions = [];
    public static void Setup(NeuroIntegration integration)
    {
        if (Instance != null)
        {
            Plugin.LogError("Neuro Integration has been Initialized Twice");
            integration.QueueFree();
            return;
        }
        Instance = integration;
    }

    public new void Ready()
    {
        // Sei: the player's own window (host role) never talks to the bot as a player.
        if (Sts2Agent.Sei.SeiConfig.IsHost) return;
        if (Plugin.WantsMultiplayer())
        {

            Context.Send("You are playing Slay the Spire 2 in Multiplayer! be sure to help out your teammates and conquer the spire together!");
        }
        else
        {

            Context.Send("You are playing Slay the Spire 2! be ready to conquer the spire and try your best to get the best deck and relic combination possible!");
        }
    }

    public void Process()
    {

    }

    public void Quit()
    {

    }

    public static void UnregisterAction(string action_name)
    {
        var action = Instance?.GlobalActions.Find((action) => action.Name == action_name);
        if (action != null)
        {
            NeuroActionHandler.UnregisterActions(action);
            Instance?.GlobalActions.Remove(action);
        }
    }

    public static void UnregisterActions(params string[] action_names)
    {
        if (Instance == null)
        {
            Plugin.LogError("Neuro Integration isn't Ready yet");
            return;
        }
        var actions_to_remove = Instance.GlobalActions.Where((action) => action_names.Contains(action.Name)).ToArray();
        NeuroActionHandler.UnregisterActions(actions_to_remove);
        foreach (var action in actions_to_remove)
        {
            Instance.GlobalActions.Remove(action);
        }
    }

    public static void UnregisterAllActions()
    {
        if (Instance == null)
        {
            Plugin.LogError("Neuro Integration isn't Ready yet");
            return;
        }
        if (Instance.GlobalActions.Count == 0)
        {
            return;
        }
        NeuroActionHandler.UnregisterActions(Instance.GlobalActions.ToArray());
        Instance.GlobalActions.Clear();
    }

    public static bool RegisterGlobalAction(ConstructedAction action)
    {
        if (Instance == null)
        {
            Plugin.LogError("Neuro Integration isn't Ready yet");
            return false;
        }
        if (Instance.GlobalActions.Any(existing => existing.Name == action.Name))
            return false;

        Instance.GlobalActions.Add(action);
        NeuroActionHandler.RegisterActions(action);
        return true;
    }

    /// <summary>
    /// Simple Wrapper for NeuroSdk.Messages.Outgoing.Context to make namespace collisions not happen when importing Context.
    /// </summary>
    /// <param name="message"></param>
    /// <param name="silent"></param>
    public static void SendContext(string message, bool silent = false)
    {
        Context.Send(message, silent);
    }

    static bool is_forcing = false;
    public static void EndForce()
    {
        is_forcing = false;
    }

    public static bool IsForcing()
    {
        return is_forcing;
    }

    public static void Reforce(string force_text)
    {
        if (is_forcing)
        {
            Plugin.LogWarning("Already Forcing, skipping Reforce call");
            return;
        }
        if (Instance!.GlobalActions.Count <= 1)
        {
            Plugin.LogWarning($"Not enough Global Actions to Reforce, skipping Reforce call, Forcing text to find the culprit: {force_text}");
            return;
        }
        is_forcing = true;
        var force = new ActionsForce(force_text, null, true, ActionsForce.Priority.Low, Instance!.GlobalActions);
        WebsocketConnection.Instance!.Send(force);

    }

    ContextType lastContext = ContextType.Unknown;
    public static Action OnContextSwitch;

    public void HandleDecisionPoint()
    {

        var ctx = GameContext.Resolve();
        if (ctx == null)
        {
            Plugin.LogError("Context is Invalid");
            return;
        }
        // Sei: the companion's window only plays inside the player's co-op run. Upstream would
        // continue a save or start a singleplayer run from the main menu; the seat waits instead.
        if (ctx.Type == ContextType.MainMenu && !Sts2Agent.Sei.SeiConfig.SeatMayUseMainMenu)
        {
            Sts2Agent.Sei.SeiRuntime.SeatAtMainMenu();
            return;
        }
        if (!QueryInfo.Registered && ctx.Type != ContextType.MainMenu)
        {
            QueryInfo.Registered = true;
            NeuroActionHandler.RegisterActions(new QueryInfo());
        }

        if (lastContext != ctx.Type)
        {

            StringBuilder stringBuilder = new();
            //Drain Any pending Events that happened. can happen when switching Context at the end of a Action. like Combat
            stringBuilder.RepresentEvents(EventLog.DrainAll());
            if (stringBuilder.Length > 0)
            {
                SendContext($"These events happened during a context switch:\n{stringBuilder}", true);
            }
            var oldhandler = ActionExecutor.GetHandlers().GetValueOrDefault(lastContext);
            if (oldhandler != null && oldhandler is IOnContextSwitch switchHandler)
            {
                switchHandler.OnContextSwitch(ctx.Type);
                Plugin.LogDebug($"Context Switch: Called OnContextSwitch for {lastContext} -> {ctx.Type}");
            }
            UnregisterAllActions();
            lastWindow?.End();
            lastContext = ctx.Type;
            ActionExecutor.ClearActions();
        }

        var handler = ActionExecutor.GetHandlers().GetValueOrDefault(ctx.Type);

        if (handler == null)
        {
            Plugin.LogError($"Current selected Handler is unvalid. not found for type: {ctx?.Type}");
            return;
        }

        if (ctx == null)
        {
            Plugin.LogError("Couldn't resolve current Context");
            GameStabilityDetector.ResetWasStable();
            GodotMainThread.RunAsync(async () => { await Task.Delay(200); GameStabilityDetector.ScheduleStabilityCheck(); });
            return;
        }

        if (ActionExecutor.ProcessEnqueuedActions())
        {
            return;
        }
        if (lastWindow?.CurrentState == ActionWindow.State.Forced && lastWindow.IsSameContextInfo(ctx))
        {
            return;
        }
        if (handler.GetCommands(ctx) is CommandReturn CommandsList)
        {
            var contextReturn = handler.GetContext(ctx);
            if (CommandsList.Commands == null || CommandsList.Commands.Count == 0)
            {
                if (!string.IsNullOrEmpty(contextReturn.Message))
                    SendContext(contextReturn.Message, contextReturn.Silent);
                Plugin.LogDebug("No Commands to run at this Decision Point");
                GameStabilityDetector.ResetWasStable();
                GodotMainThread.RunAsync(async () => { await Task.Delay(200); GameStabilityDetector.ScheduleStabilityCheck(); });
                return;
            }
            Plugin.LogDebug($"Commands list contains {CommandsList.Commands.Count} commands. Is a Persistent CommandReturn: {CommandsList.Persistent}");
            if (CommandsList.Commands.Count == 1 && !CommandsList.Commands[0].HasSchema() && !CommandsList.DontAutomaticallyExecute)
            {
                ActionExecutor.EnqueueAction(CommandsList.Commands[0]);
                if (!string.IsNullOrEmpty(contextReturn.Message))
                    SendContext(contextReturn.Message, contextReturn.Silent);
                Plugin.LogDebug("Only one command without parameters, enqueuing directly");
                UnregisterAllActions();
                GameStabilityDetector.ResetWasStable();
                GodotMainThread.RunAsync(async () => { await Task.Delay(200); GameStabilityDetector.ScheduleStabilityCheck(); });
                return;
            }
            if (!CommandsList.Persistent)
            {
                lastWindow?.End();
                lastWindow = ActionWindow.Create(this, ctx).SetContext(contextReturn.Message, contextReturn.Silent);
            }
            var new_global_actions = new List<ConstructedAction>();
            foreach (var item in CommandsList.Commands)
            {
                if (!CommandsList.Persistent)
                {
                    lastWindow!.AddAction(item);
                }
                else
                {
                    if (!GlobalActions.Any(action => action.Name == item.Name) && !new_global_actions.Any(action => action.Name == item.Name))
                    {
                        GlobalActions.Add(item);
                        new_global_actions.Add(item);
                    }
                    else
                    {
                        //Check if the Schema's are the same, if not unregister the old one and register the new one, to prevent issues with changing parameters of global actions
                        var existing = GlobalActions.Find((action) => action.Name == item.Name);
                        if (existing != null && existing.HasSchema() && item.HasSchema() && existing.ToString() != item.ToString())
                        {
                            Plugin.LogWarning($"Global Action '{item.Name}' is being updated with a different schema, registering");
                            UnregisterAction(item.Name);
                            new_global_actions.Add(item);
                        }
                    }
                }
            }
            if (new_global_actions.Count > 0)
                NeuroActionHandler.RegisterActions(new_global_actions);
            if (!CommandsList.Persistent)
            {
                UnregisterAllActions();
                lastWindow!.SetForce(0, CommandsList.ForceText, null, priority: CommandsList.ForcePriority);
                lastWindow!.Register();
                Plugin.LogDebug("Forcing new Action Window with commands: " + string.Join(", ", CommandsList.Commands.Select(c => c.Name)));
            }
            else
            {
                Plugin.LogDebug($"Is currently forcing: {is_forcing}, Global Actions Count: {GlobalActions.Count}");
                if (GlobalActions.Count > 0 && !is_forcing)
                {
                    Plugin.LogDebug("Forcing new Global Actions with commands: " + string.Join(", ", CommandsList.Commands.Select(c => c.Name)));
                    var force = new ActionsForce(CommandsList.ForceText, null, false, CommandsList.ForcePriority, GlobalActions);
                    if (!string.IsNullOrEmpty(contextReturn.Message))
                        SendContext(contextReturn.Message, contextReturn.Silent);
                    lastWindow?.End();
                    WebsocketConnection.Instance!.Send(force);
                    is_forcing = true;
                }
            }
            GodotMainThread.RunAsync(async () => { await Task.Delay(2000); GameStabilityDetector.ScheduleStabilityCheck(); });
        }
        else
        {
            Plugin.LogWarning("Decision Point Reached without actual commands to run!");
            GameStabilityDetector.ResetWasStable();
            GodotMainThread.RunAsync(async () => { await Task.Delay(200); GameStabilityDetector.ScheduleStabilityCheck(); });
        }
    }


    public static void SignalDecisionPoint()
    {
        // Sei: host role never registers actions or forces.
        if (Sts2Agent.Sei.SeiConfig.IsHost) return;
        // Sei: nobody to answer a force until the bot link is up; the handshake re-runs this.
        if (!NeuroSdk.Websocket.WebsocketConnection.IsOpen) return;
        Plugin.LogDebug("Decision Point Reached");

        if (Instance == null || !IsInstanceValid(Instance))
        {
            Plugin.LogError("Integration isn't Ready yet");
            return;
        }

        Instance.HandleDecisionPoint();
    }

    public static void Unstable()
    {
        Plugin.LogWarning("Game was Unstable! Trying to recover...");
        Instance?.lastWindow?.End();
        EndForce();
        UnregisterAllActions();
        GameStabilityDetector.ResetWasStable();
        GameStabilityDetector.ScheduleStabilityCheck();

    }
}
