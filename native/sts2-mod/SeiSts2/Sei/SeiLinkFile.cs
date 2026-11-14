#nullable enable

using System.Text.Json;

namespace Sts2Agent.Sei;

/// <summary>
/// Sei: where the bot's link server listens. Sei main writes
/// &lt;linkDir&gt;/link.json = {"v":1,"port":34870,"token":"..."} each session;
/// the mod re-reads it before EVERY connect attempt, so a new session (new
/// port or token) is picked up without restarting the game.
/// </summary>
public static class SeiLinkFile
{
    public readonly record struct Link(int Port, string Token);

    /// <summary>The parsed link file, or null when missing, unreadable or not v1.</summary>
    public static Link? Read(string linkDir)
    {
        try
        {
            var path = Path.Combine(linkDir, SeiConfig.LinkFileName);
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path);
            return Parse(text);
        }
        catch
        {
            return null;
        }
    }

    public static Link? Parse(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (root.TryGetProperty("v", out var v) && v.ValueKind == JsonValueKind.Number && v.GetInt32() != 1) return null;
            if (!root.TryGetProperty("port", out var p) || p.ValueKind != JsonValueKind.Number) return null;
            var port = p.GetInt32();
            if (port <= 0 || port > 65535) return null;
            var token = root.TryGetProperty("token", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
            return new Link(port, token);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>ws://127.0.0.1:&lt;port&gt;/sei-sts2?token=&lt;token&gt;</summary>
    public static string ToUrl(Link link)
    {
        var url = $"ws://127.0.0.1:{link.Port}{SeiConfig.LinkPath}";
        if (!string.IsNullOrEmpty(link.Token)) url += "?token=" + Uri.EscapeDataString(link.Token);
        return url;
    }

    /// <summary>NEURO_SDK_WS_URL when set (upstream behaviour, dev and tests), else link.json, else "".</summary>
    public static string ResolveUrl(Func<string?> env, string linkDir)
    {
        var fromEnv = env();
        if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv.Trim();
        var link = Read(linkDir);
        return link is { } l ? ToUrl(l) : "";
    }
}
