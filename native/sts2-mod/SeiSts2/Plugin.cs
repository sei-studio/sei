using System;
using System.IO;
using System.Reflection;
using System.Text;
using HarmonyLib;
using MegaCrit.Sts2.Core.Extensions;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using NeuroSdk;
using NeuroSdk.Messages.Outgoing;

namespace Sts2Agent;

public enum LogLevel
{
    Debug = 0,
    Info = 1,
    Error = 2,
    Warning = 3,
}

[ModInitializer("Initialize")]
public static class Plugin
{

    public struct MultiplayerState
    {
        public bool WantsHost = false;
        public bool WantsHostAbandonSave = false;
        public bool WantsJoin = false;
        public string? JoinName = null;


        public MultiplayerState()
        {
        }
    }
    // Sei: the log lives in the link folder, one file per role, capped (upstream: ~/sts2agent.log, unbounded).
    public static string LogPath { get; private set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "sei-sts2.log");
    private const long LogMaxBytes = 5 * 1024 * 1024;

    public static LogLevel CurrentLogLevel { get; set; } = LogLevel.Debug;

    private static Harmony? _harmony;

    public static void Initialize()
    {
        try
        {
            // Sei: role first (seat = the companion's window, started with --clientId; host = the player's).
            var args = Godot.OS.GetCmdlineArgs().Concat(Godot.OS.GetCmdlineUserArgs()).ToArray();
            var roleEnv = Environment.GetEnvironmentVariable("SEI_STS2_ROLE");
            Sts2Agent.Sei.SeiConfig.SetRole(roleEnv == "seat" ? Sts2Agent.Sei.SeiRole.Seat
                : roleEnv == "host" ? Sts2Agent.Sei.SeiRole.Host
                : Sts2Agent.Sei.SeiConfig.DetectRole(args));
            try
            {
                Directory.CreateDirectory(Sts2Agent.Sei.SeiConfig.LinkDir());
                LogPath = Path.Combine(Sts2Agent.Sei.SeiConfig.LinkDir(), $"sei-sts2-{Sts2Agent.Sei.SeiConfig.RoleName}.log");
            }
            catch
            {
                // keep the home-folder fallback
            }

            MultiplayerParse();
            _harmony = new Harmony("sei-sts2");
            if (Sts2Agent.Sei.SeiConfig.IsSeat)
            {
                _harmony.PatchAll(typeof(Plugin).Assembly);
            }
            else
            {
                // Sei: the player's window gets only the SDK bootstrap and Sei's own patches. Upstream's
                // gameplay patches (treasure auto-open, FTUE suppression, stability hooks) stay out of it.
                _harmony.CreateClassProcessor(typeof(NeuroSdk.NGamePatch)).Patch();
                _harmony.CreateClassProcessor(typeof(Sts2Agent.Sei.SeiMainMenuPatch)).Patch();
            }
            SaveManager.Instance.InitProfileId();

            // Sei: upstream disabled tutorials, marked FTUEs and the EA disclaimer seen, and SAVED the
            // settings here. Removed: Sei never writes the player's settings. The seat window runs under
            // its own --clientId profile, and SeenFtuePatch (seat only) skips tutorials at runtime there.
            // TODO(game): check whether the early-access disclaimer still blocks a fresh seat profile.

            Godot.Bridge.ScriptManagerBridge.LookupScriptsInAssembly(Assembly.GetExecutingAssembly());

            if (Sts2Agent.Sei.SeiConfig.IsSeat)
            {
                GameStabilityDetector.Initialize();
                GameStabilityDetector.OnBecameStable += STS2NeuroIntegration.NeuroIntegration.SignalDecisionPoint;

                RunManager.Instance.RoomEntered += OnRoomEntered;
            }

            Sts2Agent.Sei.SeiRuntime.Initialize();

            Log("Plugin initialized. Patches applied.");
        }
        catch (Exception e)
        {
            LogError($"Failed to initialize: {e}");
        }
    }

    private static void OnRoomEntered()
    {
        try
        {
            GameStabilityDetector.OnRoomEntered();
        }
        catch (Exception e)
        {
            LogError($"Error in OnRoomEntered: {e}");
        }
    }

    private static void MultiplayerParse()
    {

        var cmdlines = Godot.OS.GetCmdlineArgs();
        foreach (var item in cmdlines)
        {
            Log($"Command line argument: {item}");
        }
        if (cmdlines.Contains("--multiplayer-host-abandon"))
        {
            Multiplayer = new MultiplayerState { WantsHost = true, WantsHostAbandonSave = true };
            return;
        }
        if (cmdlines.Contains("--multiplayer-host"))
        {
            Multiplayer = new MultiplayerState { WantsHost = true };
            return;
        }
        if (cmdlines.Contains("--multiplayer-join"))
        {
            var joinindex = cmdlines.IndexOf("--multiplayer-join");
            var joinName = joinindex + 1 < cmdlines.Length ? cmdlines[joinindex + 1] : null;
            Multiplayer = new MultiplayerState { WantsJoin = true, JoinName = joinName };
            return;
        }
        if (cmdlines.FirstOrDefault(arg => arg.StartsWith("--multiplayer-join-any")) != null)
        {
            Multiplayer = new MultiplayerState { WantsJoin = true, JoinName = null };
            return;
        }
    }

    public static bool IsMultiplayer() => RunManager.Instance?.NetService?.Type.IsMultiplayer() ?? false;

    public static MultiplayerState Multiplayer { get; private set; }

    public static bool WantsMultiplayer() => Multiplayer.WantsHost || Multiplayer.WantsJoin;

    public static void Log(string message) => Log(LogLevel.Info, message);
    public static void LogDebug(string message) => Log(LogLevel.Debug, message);
    public static void LogError(string message) => Log(LogLevel.Error, message);
    public static void LogWarning(string message) => Log(LogLevel.Warning, message);

    public static void Log(LogLevel level, string message)
    {
        if (level < CurrentLogLevel) return;
        try
        {
            var prefix = level switch
            {
                LogLevel.Debug => "DEBUG",
                LogLevel.Error => "ERROR",
                LogLevel.Warning => "WARNING",
                _ => "INFO"
            };
            if (RunManager.Instance?.NetService?.Type.IsMultiplayer() ?? false)
            {
                message = $"[NetId: {RunManager.Instance.NetService.NetId}] " + message;
            }
            var line = $"[{DateTime.Now:HH:mm:ss.fff}] [{prefix}] {message}\n";
            // Sei: rotate at 5 MB (one .old kept).
            var info = new FileInfo(LogPath);
            if (info.Exists && info.Length > LogMaxBytes) File.Move(LogPath, LogPath + ".old", overwrite: true);
            File.AppendAllText(LogPath, line, new UTF8Encoding(false));
        }
        catch
        {
            // Silently ignore logging failures
        }
    }
}
