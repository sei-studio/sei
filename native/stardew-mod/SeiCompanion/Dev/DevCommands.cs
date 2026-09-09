using System;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace SeiCompanion.Dev
{
    /// <summary>
    /// Developer-only frames, refused unless config.json has DevCommands: true
    /// (the Sei app never writes it). They exist for the live test harness:
    /// a driver that can reach the mod's loopback socket but has no hands on
    /// the game window can still get a farm to play on. Every frame is still
    /// behind the WebSocket token like the rest of the protocol.
    ///
    /// newFarm goes through the game's OWN new-game path: the title menu's
    /// CharacterCustomization is opened, the three names it validates are
    /// filled in, and its OK button is pressed, so the save is exactly what
    /// a player clicking through the menu gets (default farm type and look).
    /// The arrival cutscene that follows is ended through Event.skipEvent,
    /// the same code the on-screen Skip button runs, which is what places the
    /// farmer on the farm with the intro's end state.
    /// </summary>
    internal static class DevCommands
    {
        /// <summary>Set by NewFarm; the first skippable event afterwards is skipped on the game thread.</summary>
        internal static bool SkipIntroPending;

        /// <summary>Game thread. Returns an error string, or null when the new game was started.</summary>
        public static string NewFarm(ModEntry mod, string farmerName, string farmName, string favoriteThing)
        {
            if (Context.IsWorldReady)
                return "a save is already loaded; return to the title screen first";
            if (!(Game1.activeClickableMenu is TitleMenu))
                return "not on the title screen";

            var menu = new CharacterCustomization(CharacterCustomization.Source.NewGame);
            TitleMenu.subMenu = menu;
            Game1.player.Name = farmerName;
            Game1.player.farmName.Value = farmName;
            Game1.player.favoriteThing.Value = favoriteThing;
            // The text boxes are private; the menu copies them back onto the
            // farmer, so they must agree with the fields set above.
            SetBox(mod, menu, "nameBox", farmerName);
            SetBox(mod, menu, "farmnameBox", farmName);
            SetBox(mod, menu, "favThingBox", favoriteThing);
            if (!menu.canLeaveMenu())
                return "the character menu refused the names (all three must be non-empty)";

            SkipIntroPending = true;
            // The menu's own "skip intro" option (a private bool behind the
            // checkbox in its advanced options): OK then creates the farm
            // directly instead of playing the arrival cutscene first.
            try
            {
                var skip = mod.Helper.Reflection.GetField<bool>(menu, "skipIntro", required: false);
                skip?.SetValue(true);
            }
            catch (Exception ex)
            {
                mod.Monitor.Log($"[dev] could not set skipIntro: {ex.Message}", LogLevel.Warn);
            }
            // The menu's own OK handler (private), rather than a hit-tested
            // click: the button's bounds depend on a layout pass this menu
            // has not had yet when it was created off-screen.
            try
            {
                mod.Helper.Reflection.GetMethod(menu, "optionButtonClick").Invoke("OK");
            }
            catch (Exception ex)
            {
                SkipIntroPending = false;
                return $"the character menu's OK failed: {ex.Message}";
            }
            mod.Monitor.Log($"[dev] new farm '{farmName}' for '{farmerName}' started from the title menu (gameMode {Game1.gameMode}, menu {Game1.activeClickableMenu?.GetType().Name ?? "none"}).", LogLevel.Info);
            return null;
        }

        /// <summary>Game thread: where the game is, for a driver with no screen.</summary>
        public static System.Collections.Generic.Dictionary<string, object> State()
        {
            var d = new System.Collections.Generic.Dictionary<string, object>
            {
                ["gameMode"] = Game1.gameMode,
                ["worldReady"] = Context.IsWorldReady,
                ["activeMenu"] = Game1.activeClickableMenu?.GetType().Name,
                ["titleSubMenu"] = TitleMenu.subMenu?.GetType().Name,
                ["eventUp"] = Game1.eventUp,
                ["eventId"] = Game1.CurrentEvent?.id,
                ["skipIntroPending"] = SkipIntroPending,
                ["farmer"] = Game1.player?.Name,
                ["farm"] = Game1.player?.farmName?.Value,
                ["location"] = Game1.currentLocation?.NameOrUniqueName,
                ["fading"] = Game1.fadeToBlack,
                ["locationEvent"] = Game1.currentLocation?.currentEvent?.id,
                ["locationEventSkippable"] = Game1.currentLocation?.currentEvent?.skippable,
                ["hasLoadedGame"] = Game1.hasLoadedGame,
                ["isWarping"] = Game1.isWarping,
                ["globalFade"] = Game1.globalFade,
                ["messagePause"] = Game1.messagePause,
                ["pauseTime"] = Game1.pauseTime,
                ["dialogueUp"] = Game1.dialogueUp,
                ["minigame"] = Game1.currentMinigame?.GetType().Name,
                ["day"] = Game1.dayOfMonth,
            };
            return d;
        }

        /// <summary>
        /// Game thread. Load a save from the title screen the way the load
        /// menu does: hand SaveGame.Load's iterator to the game's loading
        /// mode, which pumps it over the next frames. `slot` is the save
        /// folder name (Sei_448650108); empty = the newest folder.
        /// </summary>
        public static string LoadFarm(ModEntry mod, string slot)
        {
            if (Context.IsWorldReady)
                return "a save is already loaded; return to the title screen first";
            if (!(Game1.activeClickableMenu is TitleMenu))
                return "not on the title screen";
            string name = slot;
            if (string.IsNullOrWhiteSpace(name))
            {
                string savesDir = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "StardewValley", "Saves");
                var dirs = new System.Collections.Generic.List<System.IO.DirectoryInfo>();
                try
                {
                    foreach (string d in System.IO.Directory.GetDirectories(savesDir))
                    {
                        var info = new System.IO.DirectoryInfo(d);
                        if (System.IO.File.Exists(System.IO.Path.Combine(d, info.Name)))
                            dirs.Add(info);
                    }
                }
                catch (Exception ex) { return $"could not list saves: {ex.Message}"; }
                if (dirs.Count == 0) return "no saves on this machine";
                dirs.Sort((a, b) => b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc));
                name = dirs[0].Name;
            }
            try
            {
                Game1.exitActiveMenu();
                // Sets loadingMode and hands the game its own load iterator.
                SaveGame.Load(name);
            }
            catch (Exception ex)
            {
                return $"load failed: {ex.Message}";
            }
            mod.Monitor.Log($"[dev] loading save {name}.", LogLevel.Info);
            return null;
        }

        private static void SetBox(ModEntry mod, CharacterCustomization menu, string field, string value)
        {
            try
            {
                TextBox box = mod.Helper.Reflection.GetField<TextBox>(menu, field, required: false)?.GetValue();
                if (box != null) box.Text = value;
            }
            catch (Exception ex)
            {
                mod.Monitor.Log($"[dev] could not set {field}: {ex.Message}", LogLevel.Warn);
            }
        }

        /// <summary>Game thread, every tick: end the arrival cutscene of a farm NewFarm started.</summary>
        public static void Tick(ModEntry mod)
        {
            if (!SkipIntroPending)
                return;
            // The arrival cutscene runs BEFORE the world exists (a temporary
            // location whose event ends with the game's beginGame), so this
            // must not wait for IsWorldReady; the event hangs off the location.
            Event ev = Game1.CurrentEvent ?? Game1.currentLocation?.currentEvent;
            if (ev == null)
            {
                // The world is up and nothing is playing: the intro was skipped
                // at creation (skipIntro), so stop watching, or the next
                // ordinary cutscene of the session would be skipped too.
                if (Context.IsWorldReady) SkipIntroPending = false;
                return;
            }
            if (!ev.skippable)
                return;
            mod.Monitor.Log($"[dev] skipping event {ev.id} (the new farm's intro).", LogLevel.Info);
            ev.skipEvent();
            SkipIntroPending = false;
        }

        public static void Reset()
        {
            SkipIntroPending = false;
        }
    }
}
