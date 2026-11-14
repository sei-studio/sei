#nullable enable

using Godot;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Runs;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Contexts;
using STS2NeuroIntegration;

namespace Sts2Agent.Sei;

/// <summary>
/// Sei: the per-frame hub, driven from NGamePatch's internal process
/// notification (main thread). Cheap when idle: everything runs on its own
/// timer.
///   every ~3 s  status-&lt;role&gt;.json heartbeat (both roles)
///   every 0.5 s sei/event diff (seat, link open)
///   every 1 s   sei/state when it changed and no force is pending (seat, link open)
///   seat        keeps its window small and muted
///   host        re-sends sei/hello once the player's name is known
/// </summary>
public static class SeiRuntime
{
    private const long StatusEveryMs = 3_000;
    private const long EventsEveryMs = 500;
    private const long StateEveryMs = 1_000;

    private static long _nextStatus, _nextEvents, _nextState, _nextSeatMenuNote;
    private static string? _lastStateJson;
    private static string? _helloPlayer;
    private static bool _initialized;

    /// <summary>The companion's display name from the bot's startup reply ("Play with ...").</summary>
    public static string CompanionName { get; set; } = "Sei";
    /// <summary>The app paused the companion (sei/pause). Reported in the status file.</summary>
    public static bool Paused { get; set; }

    private static long Now => System.Environment.TickCount64;

    public static void Initialize()
    {
        if (_initialized) return;
        _initialized = true;
        SeiSeatWindow.Initialize();
        Plugin.Log($"[sei] runtime up: role={SeiConfig.RoleName} linkDir={SeiConfig.LinkDir()} version={SeiConfig.ModVersion}");
    }

    public static void Tick()
    {
        if (!_initialized) return;
        var now = Now;
        try
        {
            if (now >= _nextStatus)
            {
                _nextStatus = now + StatusEveryMs;
                WriteStatus();
            }

            if (SeiConfig.IsSeat)
            {
                SeiSeatWindow.Tick(now);
                if (now >= _nextEvents)
                {
                    _nextEvents = now + EventsEveryMs;
                    var open = WebsocketConnection.IsOpen;
                    SeiEvents.Tick((kind, detail) =>
                    {
                        if (open) WebsocketConnection.Instance?.Send(SeiOutgoing.Event(kind, detail));
                    });
                }
                if (now >= _nextState && WebsocketConnection.IsOpen && !SeiState.ForcePendingFresh)
                {
                    _nextState = now + StateEveryMs;
                    PushStateIfChanged();
                }
            }
            else
            {
                SeiHostLobby.Tick(now);
                if (WebsocketConnection.IsOpen && _helloPlayer == null)
                {
                    var player = LocalPlayerName();
                    if (player != null)
                    {
                        _helloPlayer = player;
                        WebsocketConnection.Instance?.Send(Hello());
                    }
                }
            }
        }
        catch (Exception e)
        {
            Plugin.LogDebug($"[sei] tick failed: {e.Message}");
        }
    }

    /// <summary>Called by WebsocketConnection right after startup went out on a new socket.</summary>
    public static void OnConnected()
    {
        _lastStateJson = null;
        _helloPlayer = SeiConfig.IsHost ? LocalPlayerName() : null;
        WebsocketConnection.Instance?.SendImmediate(Hello());
        Plugin.Log($"[sei] link up as {SeiConfig.RoleName}");
        if (SeiConfig.IsSeat)
        {
            // The bot cleared its view of our actions on startup: re-register what is live and
            // re-run the decision point so a fresh force (with sei_state) goes out.
            try
            {
                NeuroActionHandler.ResendRegisteredActions();
                SeiState.MarkForceAnswered();
                NeuroIntegration.Unstable();
            }
            catch (Exception e)
            {
                Plugin.LogError($"[sei] re-force after connect failed: {e.Message}");
            }
        }
    }

    public static SeiOutgoing Hello() => SeiOutgoing.Hello(_helloPlayer, Plugin.IsMultiplayer() || SeiHostLobby.LobbyKind() != "none", GameVersion());

    /// <summary>The seat landed on the main menu (no lobby to join yet): say so now and then, do nothing.</summary>
    public static void SeatAtMainMenu()
    {
        var now = Now;
        if (now < _nextSeatMenuNote) return;
        _nextSeatMenuNote = now + 60_000;
        // TODO(game): retry the -fastmp join from here once we know the game's join entry point;
        // for now Sei main restarts the companion window when it sits here.
        NeuroIntegration.SendContext("You are at the main menu of your own game window, waiting to join the player's co-op lobby. There is nothing to do yet.", true);
    }

    private static void PushStateIfChanged()
    {
        var state = SeiState.Current();
        if (state == null) return;
        var json = state.ToJsonString();
        if (json == _lastStateJson) return;
        _lastStateJson = json;
        WebsocketConnection.Instance?.Send(SeiOutgoing.State(state));
    }

    private static string? LocalPlayerName()
    {
        try
        {
            var runState = RunManager.Instance?.DebugOnlyGetState();
            var me = runState != null ? LocalContext.GetMe(runState.Players) : null;
            if (me != null) return SeiState.PlayerName(me);
        }
        catch
        {
            // not in a run
        }
        // TODO(game): the local player's name outside a run (PlatformUtil has no verified "local name" call yet).
        return null;
    }

    private static string? _gameVersion;

    public static string GameVersion()
    {
        if (_gameVersion != null) return _gameVersion;
        try
        {
            // TODO(game): the game's own build string may live elsewhere; Godot's project version is the fallback.
            var v = ProjectSettings.GetSetting("application/config/version").AsString();
            _gameVersion = string.IsNullOrWhiteSpace(v) ? "unknown" : v.Trim();
        }
        catch
        {
            _gameVersion = "unknown";
        }
        return _gameVersion;
    }

    private static void WriteStatus()
    {
        var runState = RunManager.Instance?.DebugOnlyGetState();
        ContextType? type = null;
        try { type = GameContext.Resolve()?.Type; } catch { /* unknown screen */ }
        var players = new List<string>();
        if (runState != null)
        {
            try { players.AddRange(runState.Players.Where(p => p != null).Select(SeiState.PlayerName)); } catch { /* best effort */ }
        }
        else
        {
            players.AddRange(SeiHostLobby.LobbyPlayers());
        }
        SeiStatusWriter.Write(SeiConfig.LinkDir(), new SeiStatus
        {
            ts = SeiStatusWriter.NowMs(),
            role = SeiConfig.RoleName,
            game_version = GameVersion(),
            screen = SeiState.ScreenName(type, runState != null),
            lobby = SeiHostLobby.LobbyKind(),
            in_run = runState != null,
            players = players,
            pid = System.Environment.ProcessId,
            paused = Paused,
            linked = WebsocketConnection.IsOpen,
        });
    }

    /// <summary>The window is closing: drop our status file so main sees it gone at once.</summary>
    public static void Quit()
    {
        try { File.Delete(SeiStatusWriter.PathFor(SeiConfig.LinkDir(), SeiConfig.RoleName)); } catch { /* stale file ages out */ }
    }
}
