#nullable enable

using Godot;

namespace Sts2Agent.Sei;

/// <summary>
/// Sei: the companion's window stays out of the way: windowed, small, muted.
/// Runtime only (DisplayServer/AudioServer); nothing is written to settings,
/// and the seat runs under its own --clientId profile anyway. Sei main also
/// starts it with --windowed.
/// </summary>
public static class SeiSeatWindow
{
    private static readonly Vector2I Size = new(1024, 576);
    /// <summary>The game applies its own display settings during startup; keep re-applying the size for a while, then let the player resize it.</summary>
    private const long SizeWindowMs = 20_000;
    private const long EveryMs = 2_000;

    private static long _startedAt;
    private static long _next;

    public static void Initialize() => _startedAt = System.Environment.TickCount64;

    public static void Tick(long now)
    {
        if (now < _next) return;
        _next = now + EveryMs;
        try
        {
            var master = AudioServer.GetBusIndex("Master");
            if (master >= 0 && !AudioServer.IsBusMute(master)) AudioServer.SetBusMute(master, true);

            if (now - _startedAt > SizeWindowMs) return;
            var mode = DisplayServer.WindowGetMode();
            if (mode != DisplayServer.WindowMode.Windowed) DisplayServer.WindowSetMode(DisplayServer.WindowMode.Windowed);
            if (DisplayServer.WindowGetSize() != Size) DisplayServer.WindowSetSize(Size);
        }
        catch (Exception e)
        {
            Plugin.LogDebug($"[sei] seat window tweak failed: {e.Message}");
        }
    }
}
