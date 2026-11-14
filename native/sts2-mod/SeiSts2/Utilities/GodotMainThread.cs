using System;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;

namespace Sts2Agent.Utilities;

public static class GodotMainThread
{
    public static Task RunAsync(Action action)
    {
        var tcs = new TaskCompletionSource<bool>();
        Callable.From(() =>
        {
            try
            {
                action();
                tcs.SetResult(true);
            }
            catch (Exception e)
            {
                tcs.SetException(e);
            }
        }).CallDeferred();
        return tcs.Task;
    }

    public static Task<T> RunAsync<T>(Func<T> func)
    {
        var tcs = new TaskCompletionSource<T>();
        Callable.From(() =>
        {
            try
            {
                tcs.SetResult(func());
            }
            catch (Exception e)
            {
                tcs.SetException(e);
            }
        }).CallDeferred();
        return tcs.Task;
    }

    public static async Task ClickAsync(NClickableControl button, int delayMs = 300)
    {
        if (button == null)
            throw new ArgumentNullException(nameof(button), "Tried to click a null control.");
        if (!GodotObject.IsInstanceValid(button) || !button.IsVisibleInTree())
            throw new InvalidOperationException($"Tried to click an unavailable control: {button.GetType().Name}");
        await RunAsync(() => button.ForceClick());
        if (delayMs > 0) await Task.Delay(delayMs);
    }
}
