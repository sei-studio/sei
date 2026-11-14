using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using NeuroSdk.Messages.Outgoing;

namespace Sts2Agent.Contexts;

public struct ContextReturn(string message, bool silent = false)
{
    public string Message = message;
    public bool Silent = silent;
}
public struct CommandReturn(List<ConstructedAction> commands, bool persistent = false, string ForceText = "Its your turn to act!", ActionsForce.Priority ForcePriority = ActionsForce.Priority.Low, bool DontAutomaticallyExecute = false)
{
    public List<ConstructedAction> Commands = commands;
    public string ForceText = ForceText;
    public ActionsForce.Priority ForcePriority = ForcePriority;
    public bool Persistent = persistent;

    public bool DontAutomaticallyExecute = DontAutomaticallyExecute;
}
public interface IContextResult { }
public interface IContextHandler
{
    ContextType Type { get; }
    ContextReturn GetContext(ContextInfo ctx);
    CommandReturn GetCommands(ContextInfo ctx);
    ExecutionResult Internal_Validate(ConstructedAction action, ActionJData data, out object parsedData, ContextInfo ctx);

    Task<ExecutionResult?> Internal_TryExecute(ConstructedAction action, object ParsedData, ContextInfo ctx);
}
public interface IContextHandler<T> : IContextHandler where T : class, new()
{
    ExecutionResult IContextHandler.Internal_Validate(ConstructedAction action, ActionJData data, out object parsedData, ContextInfo ctx)
    {
        Plugin.LogDebug("Validating " + action.Name);
        var passedT = new T();
        var executionResult = Validate(action, data, passedT, ctx);
        parsedData = passedT;
        return executionResult;
    }

    Task<ExecutionResult?> IContextHandler.Internal_TryExecute(ConstructedAction action, object ParsedData, ContextInfo ctx)
    {
        try
        {
            Plugin.LogDebug("Executing " + action.Name + $"in type: {Type}, {this}");
            Plugin.LogDebug($"ParsedData runtime type: {ParsedData?.GetType()}");
            Plugin.LogDebug($"Expected type: {typeof(T)}");
            return TryExecute(action, (T)ParsedData, ctx);
        }
        catch (Exception ex)
        {
            return Task.FromResult<ExecutionResult?>(ExecutionResult.Unstable($"Exception during execution: {ex.Message}"));
        }

    }
    public ExecutionResult Validate(ConstructedAction action, ActionJData data, T parsedData, ContextInfo ctx);
    public Task<ExecutionResult?> TryExecute(ConstructedAction action, T ParsedData, ContextInfo ctx);
}

public interface IOnContextSwitch
{
    void OnContextSwitch(ContextType newContext);
}
