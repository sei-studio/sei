#nullable enable

using System.Runtime.InteropServices;

namespace Sts2Agent.Sei;

public enum SeiRole
{
    /// <summary>The player's own game window: reports the run, opens the lobby. Never plays.</summary>
    Host,
    /// <summary>The companion's game window (started by Sei with --clientId): registers actions and plays.</summary>
    Seat,
}

/// <summary>
/// Sei: constants and role detection. PROTOCOL.md is the contract;
/// src/shared/sts2Ipc.ts holds the same constants on the app side.
/// </summary>
public static class SeiConfig
{
    public const string ModId = "sei-sts2";
    public const string ModVersion = "0.1.0";
    public const int Protocol = 1;
    /// <summary>The Neuro SDK `game` field. src/bot/adapter/sts2/link.js GAME_NAME.</summary>
    public const string GameName = "Slay the Spire 2";
    /// <summary>The WebSocket path on the bot's link server.</summary>
    public const string LinkPath = "/sei-sts2";
    public const string LinkFileName = "link.json";
    public const string EnvUrl = "NEURO_SDK_WS_URL";
    /// <summary>Optional override of the link folder (tests, odd setups).</summary>
    public const string EnvLinkDir = "SEI_STS2_LINK_DIR";

    public static SeiRole Role { get; private set; } = SeiRole.Host;
    public static bool IsSeat => Role == SeiRole.Seat;
    public static bool IsHost => Role == SeiRole.Host;
    public static string RoleName => IsSeat ? "seat" : "host";

    /// <summary>Seat when the game was started with --clientId (Sei starts the companion window that way).</summary>
    public static SeiRole DetectRole(IEnumerable<string> args)
    {
        foreach (var a in args)
        {
            if (a == "--clientId" || a.StartsWith("--clientId=", StringComparison.Ordinal)) return SeiRole.Seat;
        }
        return SeiRole.Host;
    }

    public static void SetRole(SeiRole role) => Role = role;

    /// <summary>
    /// SEI_STS2_SOLO=1 lets a seat window use the main menu the upstream way
    /// (continue a save or start a singleplayer run). For testing the bot
    /// without co-op; Sei never sets it.
    /// </summary>
    public static bool SeatMayUseMainMenu => Environment.GetEnvironmentVariable("SEI_STS2_SOLO") == "1";

    /// <summary>
    /// macOS ~/Library/Application Support/sei-sts2, Windows %APPDATA%\sei-sts2,
    /// Linux $XDG_CONFIG_HOME/sei-sts2 or ~/.config/sei-sts2.
    /// </summary>
    public static string LinkDir()
    {
        var overrideDir = Environment.GetEnvironmentVariable(EnvLinkDir);
        if (!string.IsNullOrWhiteSpace(overrideDir)) return overrideDir;
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            return Path.Combine(home, "Library", "Application Support", ModId);
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var appData = Environment.GetEnvironmentVariable("APPDATA");
            if (string.IsNullOrWhiteSpace(appData)) appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, ModId);
        }
        var xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        if (string.IsNullOrWhiteSpace(xdg)) xdg = Path.Combine(home, ".config");
        return Path.Combine(xdg, ModId);
    }
}
