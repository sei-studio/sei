#nullable enable

using System.Text.Json.Nodes;
using NeuroSdk.Messages.API;

namespace Sts2Agent.Sei;

/// <summary>
/// Sei: vendor-prefixed `sei/*` commands (PROTOCOL.md). The Neuro SDK spec
/// says an unaware peer ignores unknown commands, so these are safe to send
/// to any Neuro server.
/// </summary>
public sealed class SeiOutgoing : OutgoingMessageBuilder
{
    private readonly string _command;
    private readonly JsonObject _data;

    public SeiOutgoing(string command, JsonObject data)
    {
        _command = command;
        _data = data;
    }

    protected override string Command => _command;
    protected override object? Data => _data;

    /// <summary>A newer sei/state replaces a queued one instead of piling up.</summary>
    public override bool Merge(OutgoingMessageBuilder other)
    {
        if (other is not SeiOutgoing o || o._command != _command || _command != "sei/state") return false;
        _data["state"] = o._data["state"]?.DeepClone();
        return true;
    }

    public static SeiOutgoing Hello(string? player, bool coop, string gameVersion)
    {
        var d = new JsonObject
        {
            ["mod"] = SeiConfig.ModId,
            ["version"] = SeiConfig.ModVersion,
            ["protocol"] = SeiConfig.Protocol,
            ["role"] = SeiConfig.RoleName,
            ["coop"] = coop,
            ["game_version"] = gameVersion,
        };
        if (SeiConfig.IsHost && !string.IsNullOrEmpty(player)) d["player"] = player;
        return new SeiOutgoing("sei/hello", d);
    }

    public static SeiOutgoing State(JsonObject state) => new("sei/state", new JsonObject { ["state"] = state });

    public static SeiOutgoing Event(string kind, string? detail)
    {
        var d = new JsonObject { ["kind"] = kind };
        if (!string.IsNullOrWhiteSpace(detail)) d["detail"] = detail;
        return new SeiOutgoing("sei/event", d);
    }

    // TODO(game): nothing sends sei/chat yet. The host should send it when the player types in the
    // game's co-op chat, if StS2 has one; no chat hook is known. PROTOCOL.md "Mod -> bot chat".
    public static SeiOutgoing Chat(string from, string text) => new("sei/chat", new JsonObject { ["from"] = from, ["text"] = text });
}
