#nullable enable

using System.Collections;
using System.Reflection;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;
using MegaCrit.Sts2.Core.Runs;
using Sts2Agent.Utilities;
using SceneHelper = Sts2Agent.Utilities.SceneHelper;

namespace Sts2Agent.Sei;

/// <summary>
/// Sei: the player's side of "play together". A "Play with &lt;companion&gt;"
/// button on the main menu (host role only) opens a co-op lobby on the game's
/// built-in localhost ENet transport, which is what `-fastmp host_standard`
/// does at launch. Sei main sees lobby="enet" in status-host.json and starts
/// the companion's window with `-fastmp join`, which joins 127.0.0.1:33771.
///
/// How: set fastmp=host_standard in the game's parsed command line
/// (CommandLineHelper's static argument map, by reflection) so the normal
/// Multiplayer, Host, Standard path builds an ENet host instead of a Steam
/// lobby, then click that path like upstream's MainMenuHandler does. The
/// injected argument is removed again whenever the main menu is rebuilt, so
/// the player's own Multiplayer button keeps making Steam lobbies.
///
/// MVP: a NEW lobby only. Loading a saved co-op run whose players do not match
/// makes the game mark the save corrupt, so the button never clicks Load.
/// </summary>
public static class SeiHostLobby
{
    private const string FastMpKey = "fastmp";
    private const string FastMpHost = "host_standard";

    private static Button? _button;
    private static bool _busy;
    /// <summary>The player pressed our button and the lobby or run that followed is ours (ENet).</summary>
    private static bool _ours;
    private static bool _injected;
    private static long _nextTick;

    public static string Label() => $"Play with {SeiRuntime.CompanionName}";

    public static void RefreshButtonLabel()
    {
        if (_button != null && GodotObject.IsInstanceValid(_button)) _button.Text = Label();
    }

    /// <summary>"none" | "enet" | "steam" for the status file.</summary>
    public static string LobbyKind()
    {
        try
        {
            var runState = RunManager.Instance?.DebugOnlyGetState();
            if (runState != null)
            {
                if (!Plugin.IsMultiplayer()) return "none";
                var svc = RunManager.Instance?.NetService;
                var name = svc?.GetType().Name ?? "";
                // TODO(game): confirm the net service class names (ENet vs Steam) on a real build.
                if (name.Contains("Steam", StringComparison.OrdinalIgnoreCase)) return "steam";
                if (name.Contains("ENet", StringComparison.OrdinalIgnoreCase) || name.Contains("Local", StringComparison.OrdinalIgnoreCase)) return "enet";
                return _ours || HasFastMpArg() ? "enet" : "steam";
            }
            // Lobby before embark: the character select screen of a lobby we opened.
            // TODO(game): detect a Steam lobby on the character select screen (reported as "none" for now).
            var root = SceneHelper.GetSceneRoot();
            var cs = root != null ? UiHelper.FindFirst<NCharacterSelectScreen>(root) : null;
            if (cs != null && cs.Visible && (_ours || HasFastMpArg())) return "enet";
        }
        catch
        {
            // unknown: report none
        }
        return "none";
    }

    /// <summary>Player names in a lobby before embark. TODO(game): read the lobby's player list.</summary>
    public static IEnumerable<string> LobbyPlayers() => Array.Empty<string>();

    /// <summary>Host role, every ~250 ms: button visibility; forget our lobby once back at a bare main menu.</summary>
    public static void Tick(long now)
    {
        if (now < _nextTick) return;
        _nextTick = now + 250;
        try
        {
            var root = SceneHelper.GetSceneRoot();
            var menu = root != null ? UiHelper.FindFirst<NMainMenu>(root) : null;
            var bareMenu = menu != null && menu.Visible && !menu.SubmenuStack.SubmenusOpen && RunManager.Instance?.DebugOnlyGetState() == null;
            if (_button != null && GodotObject.IsInstanceValid(_button)) _button.Visible = bareMenu && !_busy;
            if (bareMenu && !_busy && _ours)
            {
                _ours = false;
                RemoveFastMp();
            }
        }
        catch
        {
            // best effort
        }
    }

    internal static void AddButton(NMainMenu menu)
    {
        if (!SeiConfig.IsHost) return;
        try
        {
            if (_button != null && GodotObject.IsInstanceValid(_button)) _button.QueueFree();
            var b = new Button { Name = "SeiPlayWith", Text = Label(), FocusMode = Control.FocusModeEnum.None };
            b.AddThemeFontSizeOverride("font_size", 26);
            b.SetAnchorsPreset(Control.LayoutPreset.BottomRight);
            b.OffsetLeft = -340;
            b.OffsetTop = -110;
            b.OffsetRight = -40;
            b.OffsetBottom = -50;
            b.Pressed += () => _ = OpenLobbyAsync();
            menu.AddChild(b);
            _button = b;
            // TODO(game): style it like the game's menu buttons (theme/font); plain Godot button for now.
        }
        catch (Exception e)
        {
            Plugin.LogError($"[sei] could not add the Play with button: {e.Message}");
        }
    }

    public static async Task OpenLobbyAsync()
    {
        if (_busy) return;
        _busy = true;
        try
        {
            if (!InjectFastMp())
            {
                // TODO(game): without the injected arg the Host path makes a Steam lobby, which the
                // companion cannot join. Fall back to telling the player instead of opening the wrong lobby.
                Plugin.LogError("[sei] could not set fastmp; not opening a lobby");
                return;
            }
            _ours = true;
            var root = SceneHelper.GetSceneRoot();
            if (root == null) return;
            var menu = UiHelper.FindFirst<NMainMenu>(root);
            var mp = menu?.GetNodeOrNull<NClickableControl>("MainMenuTextButtons/MultiplayerButton");
            if (mp == null || !mp.IsEnabled)
            {
                Plugin.LogError("[sei] Multiplayer button not available");
                _ours = false;
                RemoveFastMp();
                return;
            }
            await GodotMainThread.ClickAsync(mp);
            await Task.Delay(500);

            var sub = await GodotMainThread.RunAsync(() => UiHelper.FindFirst<NMultiplayerSubmenu>(root));
            if (sub == null || !sub.Visible) { Plugin.LogError("[sei] multiplayer submenu not found"); return; }
            var host = sub.GetNodeOrNull<NSubmenuButton>("ButtonContainer/HostButton");
            if (host == null || !host.IsEnabled || !host.IsVisibleInTree())
            {
                // A co-op save exists (Load/Abandon shown instead). Leave the player on this screen to decide.
                // TODO(game): offer "abandon and host new" from Sei once the save-compatibility check exists.
                Plugin.Log("[sei] host button unavailable (co-op save?); leaving the multiplayer menu open");
                return;
            }
            await GodotMainThread.ClickAsync(host);
            await Task.Delay(500);
            var hostSub = await GodotMainThread.RunAsync(() => UiHelper.FindFirst<NMultiplayerHostSubmenu>(root));
            var std = hostSub?.GetNodeOrNull<NClickableControl>("StandardButton");
            if (std == null) { Plugin.LogError("[sei] Standard button not found"); return; }
            await GodotMainThread.ClickAsync(std);
            Plugin.Log("[sei] opened a local co-op lobby");
        }
        catch (Exception e)
        {
            Plugin.LogError($"[sei] open lobby failed: {e}");
        }
        finally
        {
            _busy = false;
        }
    }

    // ── fastmp injection (the game's parsed command line) ─────────────────

    private static IDictionary? ArgsMap()
    {
        // TODO(game): CommandLineHelper and its static `_args` map are from reading the game, not a public API.
        var t = SeiReflect.FindType("MegaCrit.Sts2.Core.Helpers.CommandLineHelper", "CommandLineHelper");
        if (t == null) return null;
        const BindingFlags S = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        // Touch a reader first in case the map is parsed lazily.
        try { t.GetMethod("HasArg", S, null, new[] { typeof(string) }, null)?.Invoke(null, new object[] { FastMpKey }); } catch { /* optional */ }
        return t.GetField("_args", S)?.GetValue(null) as IDictionary;
    }

    private static bool HasFastMpArg()
    {
        try { return ArgsMap()?.Contains(FastMpKey) == true; } catch { return false; }
    }

    private static bool InjectFastMp()
    {
        try
        {
            var map = ArgsMap();
            if (map == null) return false;
            if (map.Contains(FastMpKey)) return true; // launched with -fastmp already
            map[FastMpKey] = FastMpHost;
            _injected = true;
            return true;
        }
        catch (Exception e)
        {
            Plugin.LogError($"[sei] fastmp inject failed: {e.Message}");
            return false;
        }
    }

    private static void RemoveFastMp()
    {
        if (!_injected) return;
        try { ArgsMap()?.Remove(FastMpKey); } catch { /* ignore */ }
        _injected = false;
    }

    /// <summary>Before the main menu builds: drop our injected arg so the game does not act on it there.</summary>
    internal static void BeforeMainMenuReady()
    {
        if (!_busy) { RemoveFastMp(); _ours = false; }
    }
}

[HarmonyPatch(typeof(NMainMenu), nameof(NMainMenu._Ready))]
public static class SeiMainMenuPatch
{
    [HarmonyPrefix]
    public static void Prefix() => SeiHostLobby.BeforeMainMenuReady();

    [HarmonyPostfix]
    public static void Postfix(NMainMenu __instance) => SeiHostLobby.AddButton(__instance);
}
