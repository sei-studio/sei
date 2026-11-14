#nullable enable

using System.Reflection;
using System.Text.Json.Nodes;
using Godot;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Runs;
using NeuroSdk.Messages.API;
using NeuroSdk.Websocket;

namespace Sts2Agent.Sei;

/// <summary>Sei: shared helpers for the sei/* handlers below (found by reflection, like upstream's).</summary>
internal static class SeiIn
{
    public static string? Str(MessageJData d, string key)
    {
        try { return d.Data is JsonObject o && o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null; }
        catch { return null; }
    }

    public static bool? Bool(MessageJData d, string key)
    {
        try { return d.Data is JsonObject o && o[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null; }
        catch { return null; }
    }
}

/// <summary>
/// The bot answers our startup with its own `startup` {session:{displayName}}.
/// Upstream ignores it; Sei keeps the name for the "Play with ..." button.
/// </summary>
public sealed class SeiStartupReply : IncomingMessageHandler
{
    private string? _name;
    public override bool CanHandle(string command) => command == "startup";

    protected override ExecutionResult Validate(string command, MessageJData messageData)
    {
        _name = null;
        try
        {
            if (messageData.Data is JsonObject o && o["session"] is JsonObject s && s["displayName"] is JsonValue v && v.TryGetValue<string>(out var n))
                _name = n.Trim();
        }
        catch
        {
            // optional
        }
        return ExecutionResult.Success();
    }

    protected override void ReportResult(ExecutionResult result) { }

    protected override void Execute()
    {
        if (string.IsNullOrWhiteSpace(_name)) return;
        SeiRuntime.CompanionName = _name.Length > 24 ? _name[..24] : _name;
        SeiHostLobby.RefreshButtonLabel();
    }
}

/// <summary>`sei/say` {text}: a speech bubble over the companion's character, in both windows.</summary>
public sealed class SeiSay : IncomingMessageHandler
{
    private string _text = "";
    public override bool CanHandle(string command) => command == "sei/say";

    protected override ExecutionResult Validate(string command, MessageJData messageData)
    {
        _text = (SeiIn.Str(messageData, "text") ?? "").Trim();
        if (_text.Length > 300) _text = _text[..300];
        return ExecutionResult.Success();
    }

    protected override void ReportResult(ExecutionResult result) { }

    protected override void Execute()
    {
        if (_text.Length > 0) SeiBubble.Show(_text);
    }
}

/// <summary>`sei/pause` {paused}: the app paused or resumed the companion. Recorded and reported; the game itself is not paused (co-op cannot be).</summary>
public sealed class SeiPause : IncomingMessageHandler
{
    private bool _paused;
    public override bool CanHandle(string command) => command == "sei/pause";

    protected override ExecutionResult Validate(string command, MessageJData messageData)
    {
        _paused = SeiIn.Bool(messageData, "paused") ?? false;
        return ExecutionResult.Success();
    }

    protected override void ReportResult(ExecutionResult result) { }

    protected override void Execute()
    {
        SeiRuntime.Paused = _paused;
        Plugin.Log($"[sei] paused={_paused}");
    }
}

/// <summary>`sei/bye`: the companion leaves. The seat window quits; the host ignores it.</summary>
public sealed class SeiBye : IncomingMessageHandler
{
    public override bool CanHandle(string command) => command == "sei/bye";
    protected override ExecutionResult Validate(string command, MessageJData messageData) => ExecutionResult.Success();
    protected override void ReportResult(ExecutionResult result) { }

    protected override void Execute()
    {
        if (!SeiConfig.IsSeat) return;
        Plugin.Log("[sei] bye: closing the companion window");
        SeiRuntime.Quit();
        try
        {
            ((SceneTree)Engine.GetMainLoop()).Quit();
        }
        catch (Exception e)
        {
            Plugin.LogError($"[sei] quit failed: {e.Message}");
        }
    }
}

/// <summary>
/// Sei: the speech bubble. The game's own "talk" bubble command is looked up by
/// reflection (TalkCmd.Play(string, Creature, VfxColor, ...)), so a game update
/// that renames it only loses the bubble.
/// </summary>
public static class SeiBubble
{
    private static MethodInfo? _play;
    private static bool _looked;

    public static void Show(string text)
    {
        try
        {
            var creature = CompanionCreature();
            if (creature == null) return; // TODO(game): no bubble outside a run (main menu, lobby).
            var play = Play();
            if (play == null) return;
            var ps = play.GetParameters();
            var args = new object?[ps.Length];
            for (var i = 0; i < ps.Length; i++)
            {
                var t = ps[i].ParameterType;
                if (t == typeof(string)) args[i] = text;
                else if (t.IsInstanceOfType(creature)) args[i] = creature;
                else if (ps[i].HasDefaultValue) args[i] = ps[i].DefaultValue;
                else if (t.IsValueType) args[i] = Activator.CreateInstance(t);
                else args[i] = null;
            }
            play.Invoke(null, args);
        }
        catch (Exception e)
        {
            Plugin.LogDebug($"[sei] bubble failed: {e.Message}");
        }
    }

    // TODO(game): verify TalkCmd.Play exists and is safe to call outside the action queue
    // (it is a local visual; nothing goes over the co-op net).
    private static MethodInfo? Play()
    {
        if (_looked) return _play;
        _looked = true;
        var type = SeiReflect.FindType("MegaCrit.Sts2.Core.Commands.TalkCmd", "TalkCmd");
        _play = type?.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Play")
            .Where(m =>
            {
                var p = m.GetParameters();
                return p.Length >= 2 && p[0].ParameterType == typeof(string) && p.Any(x => typeof(Creature).IsAssignableFrom(x.ParameterType));
            })
            .OrderBy(m => m.GetParameters().Length)
            .FirstOrDefault();
        if (_play == null) Plugin.Log("[sei] TalkCmd.Play not found; speech bubbles are off");
        return _play;
    }

    /// <summary>Seat: our own character. Host: the other player in the run (the companion).</summary>
    private static Creature? CompanionCreature()
    {
        var runState = RunManager.Instance?.DebugOnlyGetState();
        if (runState == null) return null;
        var me = LocalContext.GetMe(runState.Players);
        if (SeiConfig.IsSeat) return me?.Creature;
        // TODO(game): with more than two players, pick the companion by net id (the seat's --clientId).
        return runState.Players.FirstOrDefault(p => p != null && p != me)?.Creature;
    }
}
