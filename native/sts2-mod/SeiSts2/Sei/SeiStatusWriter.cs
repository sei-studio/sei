#nullable enable

using System.Text.Json;

namespace Sts2Agent.Sei;

/// <summary>What one window reports in status-&lt;role&gt;.json (PROTOCOL.md "Status files").</summary>
public sealed class SeiStatus
{
    public long ts { get; set; }
    public string role { get; set; } = "host";
    public string version { get; set; } = SeiConfig.ModVersion;
    public int protocol { get; set; } = SeiConfig.Protocol;
    public string game_version { get; set; } = "";
    public string screen { get; set; } = "unknown";
    /// <summary>none | enet | steam</summary>
    public string lobby { get; set; } = "none";
    public bool in_run { get; set; }
    public List<string> players { get; set; } = new();
    public int pid { get; set; }
    /// <summary>Sei: the app asked the companion to hold still (sei/pause). Extra field, optional on read.</summary>
    public bool paused { get; set; }
    /// <summary>The bot link is up. Extra field, optional on read.</summary>
    public bool linked { get; set; }
}

/// <summary>
/// Sei: writes &lt;linkDir&gt;/status-&lt;role&gt;.json atomically (temp file then
/// rename) so Sei main never reads a half-written file.
/// </summary>
public static class SeiStatusWriter
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = false };

    public static string PathFor(string linkDir, string role) => Path.Combine(linkDir, $"status-{role}.json");

    public static bool Write(string linkDir, SeiStatus status)
    {
        try
        {
            Directory.CreateDirectory(linkDir);
            var path = PathFor(linkDir, status.role);
            var tmp = path + $".{Environment.ProcessId}.tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(status, Options));
            File.Move(tmp, path, overwrite: true);
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}
