using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NeuroSdk.Websocket;
using Sts2Agent;

namespace STS2NeuroIntegration;

/// <summary>
/// Queues actions so an AI agent can submit multiple moves at once.
/// Each queued action waits for all previous actions to finish before executing.
/// </summary>
public class ActionQueue
{
    public const int MaxQueueSize = 4;

    private string discardedActionText;

    private readonly object _lock = new();
    private readonly Queue<ActionEntry> _queue = new();
    private bool _executing;

    private class ActionEntry
    {
        public TaskCompletionSource<ExecutionResult> Tcs { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public CancellationTokenRegistration CtsRegistration;
    }

    private CancellationTokenSource _cts = new();

    /// <summary>
    /// Enqueues an action and returns a task that completes when it is this action's turn.
    /// Returns ExecutionResult.Failure if the queue is full or cancelled.
    /// The caller should revalidate the action after awaiting, since game state may have changed.
    /// </summary>
    public Task<ExecutionResult> GetExecution()
    {
        lock (_lock)
        {
            if (_cts.IsCancellationRequested)
            {
                return Task.FromResult(ExecutionResult.Failure("Queue was cancelled"));
            }

            if (_queue.Count >= MaxQueueSize)
            {
                return Task.FromResult(ExecutionResult.Failure("Action queue is full (max 4)"));
            }

            var entry = new ActionEntry();
            var token = _cts.Token;
            entry.CtsRegistration = token.Register(() =>
            {
                entry.Tcs.TrySetResult(ExecutionResult.Failure("Action cancelled: queue cleared"));
            });

            _queue.Enqueue(entry);
            Plugin.LogDebug($"ActionQueue: enqueued action, queue size={_queue.Count}");

            // If this is the only entry and nothing is currently executing, it's our turn
            if (_queue.Count == 1 && !_executing)
            {
                entry.Tcs.TrySetResult(ExecutionResult.Success());
            }

            return entry.Tcs.Task;
        }
    }

    /// <summary>
    /// Signals that the current action has finished executing.
    /// Advances the queue to the next waiting action.
    /// </summary>
    public void ActionFinished()
    {
        lock (_lock)
        {
            _executing = false;

            // Remove the completed entry
            if (_queue.Count > 0)
            {
                var finished = _queue.Dequeue();
                finished.CtsRegistration.Dispose();
            }

            // Release the next waiting action
            if (_queue.Count > 0)
            {
                var next = _queue.Peek();
                next.Tcs.TrySetResult(ExecutionResult.Success());
            }

            Plugin.LogDebug($"ActionQueue: action finished, remaining={_queue.Count}");
        }
    }

    /// <summary>
    /// Marks that the front-of-queue action is now executing.
    /// Call this after revalidation succeeds and before actual execution.
    /// </summary>
    public void MarkExecuting()
    {
        lock (_lock)
        {
            _executing = true;
        }
    }

    /// <summary>
    /// Clears the entire queue, cancelling all waiting actions.
    /// </summary>
    public void Clear()
    {
        lock (_lock)
        {
            Plugin.LogDebug($"ActionQueue: clearing {_queue.Count} queued actions");
            _cts.Cancel();
            _cts.Dispose();
            _cts = new CancellationTokenSource();
            _executing = false;

            // Drain any remaining entries and dispose registrations
            while (_queue.Count > 0)
            {
                var entry = _queue.Dequeue();
                entry.CtsRegistration.Dispose();
            }
        }
    }

    public void AddToDiscardedActionText(string text)
    {
        lock (_lock)
        {
            discardedActionText += text + "\n";
        }
    }

    public void SendDiscardedActionText()
    {
        lock (_lock)
        {
            if (!string.IsNullOrEmpty(discardedActionText))
            {
                NeuroIntegration.SendContext($"# Discarded actions\n{discardedActionText}Please try those actions again if they are still relevant.", true);
            }
            discardedActionText = "";
        }
    }

    public int Count
    {
        get { lock (_lock) return _queue.Count; }
    }
}
