// ReSharper disable all
#nullable disable

// Taken from Unity's source code, this is here to allow NativeWebSocket to work in Il2Cpp.

using System.Collections;
using System.Runtime.CompilerServices;
using Godot;

public abstract class CustomYieldInstruction : IEnumerator
{
    public abstract bool keepWaiting { get; }
    public object Current => null;
    public bool MoveNext() => keepWaiting;
    public virtual void Reset() { }

    // This allows "await new WaitForUpdate()" to work directly
    public TaskAwaiter<bool> GetAwaiter()
    {
        var tcs = new TaskCompletionSource<bool>();

        // Use Godot's MainLoop to check the condition every frame
        MainThreadUtil.Run(() =>
        {
            void OnProcess()
            {
                if (!keepWaiting)
                {
                    ((SceneTree)Engine.GetMainLoop()).ProcessFrame -= OnProcess;
                    tcs.SetResult(true);
                }
            }
            ((SceneTree)Engine.GetMainLoop()).ProcessFrame += OnProcess;
        });

        return tcs.Task.GetAwaiter();
    }
}