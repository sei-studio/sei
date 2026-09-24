using System;
using Microsoft.Xna.Framework;
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

        /// <summary>Game thread: the debris lying in the body's location (what the tools dropped and whether it is collectable).</summary>
        public static System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>> Debris(SeiCompanion.Body.SeiBody body)
        {
            var list = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>>();
            GameLocation loc = body?.Npc?.currentLocation ?? Game1.currentLocation;
            if (loc?.debris == null) return list;
            Vector2 me = body?.Npc?.Position ?? Vector2.Zero;
            foreach (StardewValley.Debris d in loc.debris)
            {
                if (d == null) continue;
                var row = new System.Collections.Generic.Dictionary<string, object>
                {
                    ["type"] = d.debrisType.Value.ToString(),
                    ["chunkType"] = d.chunkType.Value,
                    ["item"] = d.item?.DisplayName,
                    ["itemId"] = d.itemId?.Value,
                    ["chunks"] = d.Chunks.Count,
                    ["player"] = d.player?.Value?.Name,
                };
                if (d.Chunks.Count > 0)
                    row["dist"] = (int)(Vector2.Distance(d.Chunks[0].position.Value, me) / 64f);
                list.Add(row);
                if (list.Count >= 30) break;
            }
            return list;
        }

        /// <summary>Game thread: what a rectangle of tiles is made of, for pathing questions.</summary>
        public static System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>> Tiles(SeiCompanion.Body.SeiBody body, int x0, int y0, int x1, int y1)
        {
            var list = new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>>();
            GameLocation loc = body?.Npc?.currentLocation ?? Game1.currentLocation;
            if (loc == null) return list;
            for (int y = y0; y <= y1; y++)
            for (int x = x0; x <= x1; x++)
            {
                var v = new Vector2(x, y);
                var row = new System.Collections.Generic.Dictionary<string, object> { ["x"] = x, ["y"] = y };
                try
                {
                    row["onMap"] = loc.isTileOnMap(v);
                    row["passable"] = loc.isTilePassable(v);
                    row["water"] = loc.isWaterTile(x, y);
                    row["occupied"] = loc.IsTileOccupiedBy(v, StardewValley.CollisionMask.All, StardewValley.CollisionMask.None);
                    if (loc.objects.TryGetValue(v, out StardewValley.Object o) && o != null) row["object"] = o.Name;
                    if (loc.terrainFeatures.TryGetValue(v, out StardewValley.TerrainFeatures.TerrainFeature tf) && tf != null) row["feature"] = tf.GetType().Name;
                    foreach (string layer in new[] { "Back", "Buildings", "Front" })
                    {
                        string barrier = loc.doesTileHaveProperty(x, y, "NPCBarrier", layer);
                        if (barrier != null) row["npcBarrier"] = layer;
                        string pass = loc.doesTileHaveProperty(x, y, "Passable", layer);
                        if (pass != null) row["passableProp"] = layer;
                    }
                    int bIdx = -1;
                    try { bIdx = loc.getTileIndexAt(x, y, "Buildings"); } catch { }
                    if (bIdx >= 0) row["buildingsTile"] = bIdx;
                    if (body?.Npc != null)
                    {
                        var rect = new Rectangle(x * 64 + 8, y * 64 + 8, 48, 48);
                        row["npcColliding"] = loc.isCollidingPosition(rect, Game1.viewport, false, 0, false, body.Npc, true, false, false);
                        row["farmerColliding"] = loc.isCollidingPosition(rect, Game1.viewport, true, 0, false, body.Shadow, true, false, false);
                    }
                }
                catch (Exception ex) { row["error"] = ex.Message; }
                list.Add(row);
            }
            return list;
        }

        /// <summary>
        /// Game thread: what the body looks like, for a driver with no screen.
        /// `requested` is the clamped look from the spawn frame, `applied` is
        /// read back from the shadow farmer's own fields (the two differ only
        /// if a change* method wrapped a value), `rejected` names the fields
        /// the game refused, and `sprite` says which frame is on and whether
        /// the farmer draw is live or has fallen back to the placeholder.
        /// </summary>
        public static System.Collections.Generic.Dictionary<string, object> Appearance(SeiCompanion.Body.SeiBody body)
        {
            var look = body.Look;
            var requested = new System.Collections.Generic.Dictionary<string, object>
            {
                ["gender"] = look.Male ? "male" : "female",
                ["skin"] = look.Skin,
                ["hair"] = look.Hair,
                ["hairColor"] = SeiCompanion.Body.Appearance.Hex(look.HairColor),
                ["eyeColor"] = SeiCompanion.Body.Appearance.Hex(look.EyeColor),
                ["shirt"] = look.Shirt,
                ["pants"] = look.Pants,
                ["pantsColor"] = SeiCompanion.Body.Appearance.Hex(look.PantsColor),
                ["accessory"] = look.Accessory,
            };
            var result = new System.Collections.Generic.Dictionary<string, object>
            {
                ["custom"] = look.Custom,
                ["farmerLook"] = body.FarmerLook,
                ["requested"] = requested,
                ["rejected"] = look.Rejected,
            };
            try
            {
                result["applied"] = SeiCompanion.Body.Appearance.Read(body.Shadow);
                result["sprite"] = new System.Collections.Generic.Dictionary<string, object>
                {
                    ["frame"] = body.Shadow.FarmerSprite.CurrentFrame,
                    ["animation"] = body.Shadow.FarmerSprite.CurrentSingleAnimation,
                    ["facing"] = body.Shadow.FacingDirection,
                    ["texture"] = body.Shadow.FarmerRenderer.textureName.Value,
                };
            }
            catch (Exception ex) { result["error"] = ex.Message; }
            return result;
        }

        /// <summary>Game thread: end the day the way the bed does (the host sleeps; the game saves and starts the next day).</summary>
        public static string Sleep(ModEntry mod)
        {
            if (!Context.IsWorldReady) return "no save is loaded";
            try
            {
                var m = mod.Helper.Reflection.GetMethod(Game1.currentLocation, "startSleep", required: false);
                if (m != null) { m.Invoke(); return null; }
                Game1.player.isInBed.Value = true;
                Game1.NewDay(0f);
                return null;
            }
            catch (Exception ex)
            {
                return $"sleep failed: {ex.Message}";
            }
        }
    }
}
