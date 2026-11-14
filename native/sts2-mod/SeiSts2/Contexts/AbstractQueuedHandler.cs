using System.Threading.Tasks;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using STS2NeuroIntegration;

namespace Sts2Agent.Contexts;

public abstract class AbstractQueuedHandler<TResult> : IContextHandler<TResult>
    where TResult : class, IContextResult, new()
{
    private readonly ActionQueue _actionQueue = new();

    protected ActionQueue ActionQueue => _actionQueue;
    protected bool IsRevalidation { get; private set; }

    public abstract ContextType Type { get; }
    public abstract ContextReturn GetContext(ContextInfo ctx);
    public abstract CommandReturn GetCommands(ContextInfo ctx);
    public abstract ExecutionResult Validate(ConstructedAction action, ActionJData data, TResult parsedData, ContextInfo ctx);
    protected abstract Task<ExecutionResult?> ExecuteQueuedAction(ConstructedAction action, TResult result, ContextInfo ctx);

    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, TResult result, ContextInfo ctx)
    {
        OnQueuedActionReceived(action, result, ctx);

        var queueResult = await _actionQueue.GetExecution();
        if (!queueResult.Successful)
        {
            Plugin.LogDebug($"ActionQueue: action '{action.Name}' was rejected or cancelled: {queueResult.Message}");
            CleanupQueuedFailure(result);
            _actionQueue.AddToDiscardedActionText(GetQueueRejectedDiscardMessage(action, result, queueResult));
            if (_actionQueue.Count == 0)
                _actionQueue.SendDiscardedActionText();
            return queueResult;
        }

        var freshCtx = GameContext.Resolve();
        if (freshCtx == null || freshCtx.Type != Type)
        {
            Plugin.LogDebug($"ActionQueue: context changed while waiting for '{action.Name}'");
            CleanupQueuedFailure(result);
            _actionQueue.ActionFinished();
            return ExecutionResult.Failure(GetContextChangedMessage(action, result));
        }

        var executionResult = GetRevalidationResult(action, result, freshCtx);
        IsRevalidation = true;
        try
        {
            var revalidation = Validate(action, action.Data, executionResult, freshCtx);
            if (!revalidation.Successful)
            {
                Plugin.LogDebug($"ActionQueue: action '{action.Name}' failed revalidation: {revalidation.Message}");
                CleanupQueuedFailure(executionResult);
                _actionQueue.ActionFinished();
                _actionQueue.AddToDiscardedActionText(GetRevalidationFailedDiscardMessage(action, executionResult, revalidation));
                if (_actionQueue.Count == 0)
                    _actionQueue.SendDiscardedActionText();
                return revalidation;
            }
        }
        finally
        {
            IsRevalidation = false;
        }

        _actionQueue.MarkExecuting();

        try
        {
            return await ExecuteQueuedAction(action, executionResult, freshCtx);
        }
        finally
        {
            if (!ActionExecutor.HasEnqueuedActions())
                OnAfterQueuedAction(action, executionResult, freshCtx);
            _actionQueue.ActionFinished();
        }
    }

    protected virtual void OnQueuedActionReceived(ConstructedAction action, TResult result, ContextInfo ctx)
    {
    }

    protected virtual TResult GetRevalidationResult(ConstructedAction action, TResult result, ContextInfo freshCtx) => result;

    protected virtual void CleanupQueuedFailure(TResult result)
    {
    }

    protected virtual string DescribeAction(ConstructedAction action, TResult result) => action.Name;

    protected virtual string GetQueueRejectedDiscardMessage(ConstructedAction action, TResult result, ExecutionResult queueResult)
        => $"- couldn't {DescribeAction(action, result)} due to {queueResult.Message}";

    protected virtual string GetRevalidationFailedDiscardMessage(ConstructedAction action, TResult result, ExecutionResult revalidationResult)
        => $"- {DescribeAction(action, result)} was cancelled due to {revalidationResult.Message}";

    protected virtual string GetContextChangedMessage(ConstructedAction action, TResult result)
        => $"Context changed, no longer in {Type}";

    protected virtual void OnAfterQueuedAction(ConstructedAction action, TResult result, ContextInfo freshCtx)
    {
    }

    protected void ResetQueuedHandlerState()
    {
        IsRevalidation = false;
    }
}
