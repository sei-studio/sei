using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Pathfinding;
using StardewValley.Tools;
using SeiCompanion.Actions;
using SeiCompanion.Net;
using SeiCompanion.Observe;
using SeiCompanion.Reflex;
using SObject = StardewValley.Object;

namespace SeiCompanion.Body
{
    /// <summary>
    /// One companion in the world: the visible NPC (walks, collides, is drawn,
    /// carries the speech bubble) paired with the invisible BotFarmer shadow
    /// that every game mechanic accepts as `who`. The shadow is synced FROM the
    /// NPC before anything reads it; nothing ever moves the shadow itself.
    /// </summary>
    public sealed class SeiBody
    {
        public string Name { get; }
        public Session Session { get; private set; }
        public NPC Npc { get; private set; }
        public BotFarmer Shadow { get; }
        public ModEntry Mod { get; }
        public IMonitor Monitor => this.Mod.Monitor;

        /// <summary>The player being trailed (a farmer name), or null.</summary>
        public string FollowTarget { get; set; }
        public bool Paused { get; private set; }
        public bool Sleeping { get; set; }
        public bool Detached { get; private set; }

        public ActionRunner Runner { get; } = new ActionRunner();
        /// <summary>Background coroutines (follow travel, bedtime walk) that never own the command slot.</summary>
        public ActionRunner Background { get; } = new ActionRunner();
        public HandleRegistry Handles { get; } = new HandleRegistry();
        public Reflexes Reflex { get; }

        /// <summary>Result of the most recent tool use, for the next observation.</summary>
        public string LastActionResult { get; set; }

        private int _followCooldown;
        private Vector2 _lastFollowGoal = new Vector2(-1, -1);
        private int _stuckTicks;
        private Vector2 _lastPos;
        private int _observeTick;
        private int _lastNightSoonDay = -1;
        private int _lastBedtimeDay = -1;
        private const string ModDataPrefix = "Sei.SeiCompanion/";

        public SeiBody(string name, Session session, ModEntry mod)
        {
            this.Name = name;
            this.Session = session;
            this.Mod = mod;
            this.Shadow = new BotFarmer();
            this.Shadow.UniqueMultiplayerID = mod.Helper.Multiplayer.GetNewID();
            this.Shadow.Name = name;
            this.Shadow.displayName = name;
            this.Shadow.Speed = 2;
            this.Shadow.MaxItems = 36;
            this.Shadow.Gold = mod.Config.StartingGold;
            this.Reflex = new Reflexes(this);
            this.Runner.Finished += this.OnCommandFinished;
        }

        public static string SanitizeName(string raw)
        {
            string cleaned = Regex.Replace(raw ?? "", @"[^A-Za-z0-9_ \-]", "").Trim();
            if (cleaned.Length > 24) cleaned = cleaned.Substring(0, 24);
            return cleaned.Length == 0 ? "Sei" : cleaned;
        }

        /*********
        ** Lifecycle
        *********/
        public void Spawn()
        {
            Farmer host = Game1.player;
            GameLocation loc = host.currentLocation ?? Game1.getFarm();
            Vector2 tile = this.FreeTileNear(loc, host.Tile, 1) ?? host.Tile;
            Vector2 pos = tile * 64f;
            var sprite = new AnimatedSprite(ModEntry.SpriteAsset, 0, 16, 32);
            this.Npc = new NPC(sprite, pos, loc.Name, 2, "Sei_" + this.Name.Replace(' ', '_'), this.Mod.CompanionPortrait, false)
            {
                displayName = this.Name,
                Breather = false,
                HideShadow = false,
                // The player must never be boxed in by the companion (doorways,
                // the bed); the companion still collides with the world.
                farmerPassesThrough = true,
                willDestroyObjectsUnderfoot = false,
            };
            this.Npc.collidesWithOtherCharacters.Value = false;
            this.Npc.currentLocation = loc;
            loc.addCharacter(this.Npc);
            this.Detached = false;
            this.Load();
            if (!this.Shadow.Items.HasAny())
                this.GiveStartingKit();
            this.SyncShadow();
            this._lastPos = this.Npc.Position;
        }

        private void GiveStartingKit()
        {
            var kit = new List<Item>();
            try { kit.AddRange(Farmer.initialTools()); } catch { }
            // Two things the initial tools lack that the job needs: a rod and a blade.
            try { kit.Add(ItemRegistry.Create("(T)BambooPole")); } catch { }
            try { kit.Add(ItemRegistry.Create("(W)0")); } catch { }
            this.Shadow.Items.OverwriteWith(kit);
            for (int i = this.Shadow.Items.Count; i < this.Shadow.MaxItems; i++)
                this.Shadow.Items.Add(null);
        }

        /// <summary>Step out of the world (save / day end) without forgetting anything.</summary>
        public void Detach(string reason)
        {
            if (this.Npc == null || this.Detached)
                return;
            this.Runner.Abort($"interrupted: {reason}");
            this.Background.Abort(reason);
            this.Npc.controller = null;
            this.Npc.currentLocation?.characters.Remove(this.Npc);
            this.Detached = true;
        }

        /// <summary>Come back after a save: same location if it still exists, else beside the host.</summary>
        public void Reattach()
        {
            if (this.Npc == null || !this.Detached)
                return;
            GameLocation loc = this.Npc.currentLocation;
            if (loc == null || !Game1.locations.Contains(loc) && Game1.getLocationFromName(loc.NameOrUniqueName) == null)
                loc = Game1.player.currentLocation ?? Game1.getFarm();
            if (!loc.characters.Contains(this.Npc))
            {
                this.Npc.currentLocation = loc;
                loc.addCharacter(this.Npc);
            }
            this.Detached = false;
            this.SyncShadow();
        }

        public void Remove(string reason)
        {
            this.Runner.Abort($"interrupted: {reason}");
            this.Background.Abort(reason);
            if (this.Npc != null)
            {
                this.Npc.controller = null;
                this.Npc.currentLocation?.characters.Remove(this.Npc);
                foreach (GameLocation loc in Game1.locations)
                {
                    try { if (loc.characters.Contains(this.Npc)) loc.characters.Remove(this.Npc); } catch { }
                }
            }
            this.Detached = true;
            this.Session?.SendEvent("despawned", new Dictionary<string, object> { ["reason"] = reason });
        }

        /// <summary>A reconnecting bot takes over this body.</summary>
        public void Adopt(Session session)
        {
            this.Session = session;
        }

        public void OnDayStarted()
        {
            this.Shadow.WakeUp();
            this.Sleeping = false;
            this.Reflex.OnNewDay();
            // Left underground overnight: the mines regenerate, so come home.
            if (this.Npc?.currentLocation is MineShaft || this.Npc?.currentLocation?.Name == "VolcanoDungeon")
                this.WarpTo("Farm", Game1.getFarm().GetMainFarmHouseEntry());
            this.Reattach();
            // Wake up beside the host so the day starts together.
            Farmer host = Game1.player;
            if (host?.currentLocation != null && this.Npc != null && this.Npc.currentLocation != host.currentLocation)
                this.WarpTo(host.currentLocation.NameOrUniqueName, this.FreeTileNear(host.currentLocation, host.Tile, 1)?.ToPoint() ?? host.TilePoint);
            this.Session?.SendEvent("day_started", new Dictionary<string, object>
            {
                ["day"] = Game1.dayOfMonth,
                ["season"] = Game1.currentSeason,
                ["year"] = Game1.year,
                ["weather"] = Snapshot.Weather(),
            });
        }

        public void OnTimeChanged(int newTime)
        {
            if (this.Detached)
                return;
            if (newTime >= 2200 && this._lastNightSoonDay != Game1.dayOfMonth)
            {
                this._lastNightSoonDay = Game1.dayOfMonth;
                this.Session?.SendEvent("night_soon", new Dictionary<string, object> { ["time"] = newTime });
            }
            if (newTime >= 2550 && this._lastBedtimeDay != Game1.dayOfMonth && !this.Sleeping)
            {
                this._lastBedtimeDay = Game1.dayOfMonth;
                this.Reflex.Bedtime();
            }
        }

        /*********
        ** Per tick
        *********/
        public void Tick(int tick)
        {
            if (this.Npc == null || this.Detached)
                return;
            if (this.Npc.currentLocation == null)
                return;
            this.SyncShadow();

            if (this.Paused)
            {
                // Stand still like a player away from the keyboard.
                this.Npc.controller = null;
                this.Npc.Halt();
                return;
            }

            this.Runner.Tick();
            this.Background.Tick();
            this.Reflex.Tick(tick);
            if (!this.Runner.Busy && !this.Background.Busy)
                this.FollowTick();
            if (tick % 12 == 0)
                this.CollectDebris(3);
            if (tick % 120 == 0)
                this.Handles.Sweep();
            this.PushObservation(tick);
            this._lastPos = this.Npc.Position;
        }

        public void SyncShadow()
        {
            if (this.Npc == null) return;
            this.Shadow.Position = this.Npc.Position;
            this.Shadow.currentLocation = this.Npc.currentLocation ?? Game1.player.currentLocation;
            this.Shadow.FacingDirection = this.Npc.FacingDirection;
        }

        private void PushObservation(int tick)
        {
            int hz = this.Mod.Config.ObserveHz;
            if (hz <= 0 || this.Session == null || !this.Session.IsOpen)
                return;
            int every = Math.Max(1, 60 / hz);
            if (++this._observeTick < every)
                return;
            this._observeTick = 0;
            try { this.Session.SendEvent("obs", new Dictionary<string, object> { ["obs"] = this.Observe() }); }
            catch (Exception ex) { this.Monitor.Log($"{this.Name}: observe failed: {ex.Message}", LogLevel.Debug); }
        }

        public Dictionary<string, object> Observe()
        {
            return Snapshot.Build(this);
        }

        public void SetPaused(bool paused)
        {
            this.Paused = paused;
            if (paused)
            {
                this.Runner.Abort("paused by the player");
                this.Background.Abort("paused");
                if (this.Npc != null) this.Npc.controller = null;
            }
        }

        /*********
        ** Follow
        *********/
        private void FollowTick()
        {
            if (this.FollowTarget == null || this.Sleeping)
                return;
            Farmer target = this.ResolvePlayer(this.FollowTarget);
            if (target == null || target.currentLocation == null)
                return;
            if (this._followCooldown > 0) { this._followCooldown--; return; }

            if (target.currentLocation != this.Npc.currentLocation)
            {
                // Different map: route there in the background; teleport beside
                // them only when no route exists (the mines, festival maps).
                List<Hop> route = Router.FindRoute(this.Npc.currentLocation, target.currentLocation.NameOrUniqueName);
                if (route != null && route.Count > 0 && route.Count <= 4)
                {
                    var ctx = new ActionContext(this, null, default);
                    this.Background.Start(ctx, "follow-travel", Movement.Travel(ctx, target.currentLocation.NameOrUniqueName, null));
                }
                else
                {
                    this.WarpTo(target.currentLocation.NameOrUniqueName, this.FreeTileNear(target.currentLocation, target.Tile, 1)?.ToPoint() ?? target.TilePoint);
                    this.Session?.SendEvent("warped", new Dictionary<string, object> { ["location"] = this.LocationName, ["reason"] = "caught up with the player" });
                }
                this._followCooldown = 30;
                return;
            }

            float dist = Vector2.Distance(target.Tile, this.Npc.Tile);
            if (dist <= 2.2f)
            {
                this.Npc.controller = null;
                this._stuckTicks = 0;
                return;
            }
            // Stuck for a while while trailing on the same map: hop beside them.
            if (Vector2.Distance(this.Npc.Position, this._lastPos) < 0.5f && this.Npc.controller != null)
                this._stuckTicks++;
            else
                this._stuckTicks = 0;
            if (this._stuckTicks > 180 || dist > 18f)
            {
                Vector2? spot = this.FreeTileNear(target.currentLocation, target.Tile, 1);
                if (spot.HasValue)
                {
                    this.Npc.controller = null;
                    this.Npc.Position = spot.Value * 64f;
                    this._stuckTicks = 0;
                }
            }
            if (Vector2.Distance(target.Tile, this._lastFollowGoal) < 1.5f && this.Npc.controller != null)
            {
                this._followCooldown = 5;
                return;
            }
            Vector2? goal = this.FreeTileNear(target.currentLocation, target.Tile, 1);
            if (goal.HasValue && this.TryPath(goal.Value.ToPoint(), null))
            {
                this._lastFollowGoal = target.Tile;
                this._followCooldown = 15;
            }
            else
            {
                this._followCooldown = 30;
            }
        }

        /*********
        ** Movement primitives (used by the verbs)
        *********/
        /// <summary>Install a path controller to a tile in the current map; false when no path exists.</summary>
        public bool TryPath(Point target, PathFindController.endBehavior onArrive)
        {
            try
            {
                GameLocation loc = this.Npc.currentLocation;
                var controller = new PathFindController(this.Npc, loc, target, 2, onArrive);
                if (controller.pathToEndPoint == null || controller.pathToEndPoint.Count == 0)
                {
                    this.Npc.controller = null;
                    return false;
                }
                this.Npc.controller = controller;
                this.Npc.speed = 3;
                return true;
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"{this.Name}: pathfinding threw: {ex.Message}", LogLevel.Debug);
                this.Npc.controller = null;
                return false;
            }
        }

        /// <summary>Move the NPC (and the shadow) into another location at a tile.</summary>
        public void WarpTo(string locationName, Point tile)
        {
            GameLocation target = Game1.getLocationFromName(locationName);
            if (target == null)
                return;
            this.Npc.controller = null;
            Game1.warpCharacter(this.Npc, target, new Vector2(tile.X, tile.Y));
            this.Npc.currentLocation = target;
            this.SyncShadow();
        }

        /// <summary>A passable tile within `radius` of `around`, nearest first, or null.</summary>
        public Vector2? FreeTileNear(GameLocation loc, Vector2 around, int radius)
        {
            var candidates = new List<Vector2>();
            for (int dx = -radius; dx <= radius; dx++)
                for (int dy = -radius; dy <= radius; dy++)
                {
                    if (dx == 0 && dy == 0) continue;
                    candidates.Add(new Vector2(around.X + dx, around.Y + dy));
                }
            foreach (Vector2 t in candidates.OrderBy(t => Vector2.Distance(t, around)))
            {
                if (this.IsWalkable(loc, t))
                    return t;
            }
            return null;
        }

        public bool IsWalkable(GameLocation loc, Vector2 tile)
        {
            try
            {
                if (!loc.isTileOnMap(tile)) return false;
                if (loc.isWaterTile((int)tile.X, (int)tile.Y)) return false;
                if (!loc.isTilePassable(tile)) return false;
                return !loc.IsTileOccupiedBy(tile, StardewValley.CollisionMask.Buildings | StardewValley.CollisionMask.Furniture | StardewValley.CollisionMask.Objects | StardewValley.CollisionMask.TerrainFeatures | StardewValley.CollisionMask.LocationSpecific, StardewValley.CollisionMask.None);
            }
            catch { return false; }
        }

        /*********
        ** Speech
        *********/
        public void Say(string text)
        {
            string line = (text ?? "").Trim();
            if (line.Length == 0 || this.Npc == null)
                return;
            if (line.Length > 300) line = line.Substring(0, 300);
            int duration = Math.Clamp(1500 + 55 * line.Length, 2500, 9000);
            try { this.Npc.showTextAboveHead(line, null, 2, duration); } catch { }
            if (this.Mod.Config.AnnounceInChat)
            {
                try { Game1.chatBox?.addMessage($"{this.Name}: {line}", new Color(150, 220, 150)); } catch { }
            }
        }

        /*********
        ** Commands
        *********/
        public void RunCommand(string id, string name, JsonElement args)
        {
            var ctx = new ActionContext(this, id, args);
            if (this.Paused)
            {
                this.Session?.SendResult(id, false, "paused: the player paused the game");
                return;
            }
            if (this.Detached)
            {
                this.Session?.SendResult(id, false, "the day is ending; try again in a moment");
                return;
            }
            // follow / unfollow only set background state (the trailing happens
            // on the follow tick), so they answer at once and never occupy the
            // command slot.
            if (name == "follow")
            {
                string who = ctx.Str("player") ?? ctx.Str("target") ?? Game1.player.Name;
                Farmer target = this.ResolvePlayer(who);
                if (target == null) { this.Session?.SendResult(id, false, $"no player named {who} is here"); return; }
                this.FollowTarget = target.Name;
                this.Sleeping = false;
                this.Session?.SendResult(id, true, $"following {target.Name}");
                return;
            }
            if (name == "unfollow")
            {
                this.FollowTarget = null;
                this.Npc.controller = null;
                this.Session?.SendResult(id, true, "stopped following");
                return;
            }
            Func<ActionContext, IEnumerable<object>> verb = Verbs.Resolve(name);
            if (verb == null)
            {
                this.Session?.SendResult(id, false, $"unknown action {name}");
                return;
            }
            this.Sleeping = false;
            IEnumerable<object> routine;
            try { routine = verb(ctx); }
            catch (Exception ex)
            {
                this.Session?.SendResult(id, false, $"error: {ex.Message}");
                return;
            }
            this.Runner.Start(ctx, name, routine);
        }

        public void CancelCommand(string targetId, string reason)
        {
            if (!this.Runner.Busy) return;
            if (targetId == null || this.Runner.Context?.Id == targetId)
                this.Runner.Abort(reason);
        }

        private void OnCommandFinished(ActionContext ctx, string name, Result result)
        {
            if (ctx?.Id == null) return;
            if (this.Npc != null) this.Npc.controller = null;
            this.LastActionResult = $"{name}: {result.Detail}";
            this.Session?.SendResult(ctx.Id, result.Ok, result.Detail, result.Extra);
        }

        /*********
        ** Inventory + wallet persistence (host farmer modData)
        *********/
        private string DataKey => ModDataPrefix + this.Name.ToLowerInvariant();

        public void Persist()
        {
            try
            {
                var items = new List<Dictionary<string, object>>();
                foreach (Item item in this.Shadow.Items)
                {
                    if (item == null) continue;
                    items.Add(new Dictionary<string, object>
                    {
                        ["id"] = item.QualifiedItemId,
                        ["stack"] = item.Stack,
                        ["quality"] = item.Quality,
                        ["upgrade"] = (item as Tool)?.UpgradeLevel ?? 0,
                    });
                }
                var data = new Dictionary<string, object> { ["gold"] = this.Shadow.Gold, ["items"] = items };
                Game1.player.modData[this.DataKey] = JsonSerializer.Serialize(data, Server.Json);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"{this.Name}: could not persist inventory: {ex.Message}", LogLevel.Warn);
            }
        }

        private void Load()
        {
            try
            {
                if (!Game1.player.modData.TryGetValue(this.DataKey, out string json) || string.IsNullOrEmpty(json))
                    return;
                using JsonDocument doc = JsonDocument.Parse(json);
                JsonElement root = doc.RootElement;
                if (root.TryGetProperty("gold", out JsonElement g) && g.TryGetInt32(out int gold))
                    this.Shadow.Gold = gold;
                var items = new List<Item>();
                if (root.TryGetProperty("items", out JsonElement arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (JsonElement e in arr.EnumerateArray())
                    {
                        string id = e.TryGetProperty("id", out JsonElement idEl) ? idEl.GetString() : null;
                        if (string.IsNullOrEmpty(id)) continue;
                        int stack = e.TryGetProperty("stack", out JsonElement st) && st.TryGetInt32(out int s) ? s : 1;
                        int quality = e.TryGetProperty("quality", out JsonElement q) && q.TryGetInt32(out int qv) ? qv : 0;
                        Item item = ItemRegistry.Create(id, Math.Max(1, stack), quality, allowNull: true);
                        if (item == null) continue;
                        if (item is Tool tool && e.TryGetProperty("upgrade", out JsonElement up) && up.TryGetInt32(out int level) && level > 0)
                            tool.UpgradeLevel = level;
                        items.Add(item);
                    }
                }
                if (items.Count > 0)
                {
                    this.Shadow.Items.OverwriteWith(items);
                    for (int i = this.Shadow.Items.Count; i < this.Shadow.MaxItems; i++)
                        this.Shadow.Items.Add(null);
                }
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"{this.Name}: could not restore inventory: {ex.Message}", LogLevel.Warn);
            }
        }

        /*********
        ** Helpers the verbs share
        *********/
        public string LocationName => this.Npc?.currentLocation?.NameOrUniqueName ?? "unknown";
        public int TileX => (int)(this.Npc?.Tile.X ?? 0);
        public int TileY => (int)(this.Npc?.Tile.Y ?? 0);

        public Dictionary<string, object> Identity()
        {
            return new Dictionary<string, object>
            {
                ["name"] = this.Name,
                ["location"] = this.LocationName,
                ["x"] = this.TileX,
                ["y"] = this.TileY,
            };
        }

        public Farmer ResolvePlayer(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
                return Game1.player;
            foreach (Farmer f in Game1.getOnlineFarmers())
            {
                if (string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase))
                    return f;
            }
            if (string.Equals(name, "player", StringComparison.OrdinalIgnoreCase) || string.Equals(name, "host", StringComparison.OrdinalIgnoreCase))
                return Game1.player;
            // Host-only v1: a name that matches nobody (the model once used the
            // owner's account name, 260910) still means the person beside you.
            return Game1.player;
        }

        public T FindTool<T>() where T : Tool
        {
            return this.Shadow.Items.OfType<T>().OrderByDescending(t => t.UpgradeLevel).FirstOrDefault();
        }

        /// <summary>The best melee weapon that is not a scythe, or null.</summary>
        public MeleeWeapon FindWeapon()
        {
            return this.Shadow.Items.OfType<MeleeWeapon>().Where(w => !w.isScythe()).OrderByDescending(w => w.maxDamage.Value).FirstOrDefault();
        }

        public MeleeWeapon FindScythe()
        {
            return this.Shadow.Items.OfType<MeleeWeapon>().FirstOrDefault(w => w.isScythe());
        }

        /// <summary>Find an inventory item by a loose name ("parsnip seeds", "seeds", "axe").</summary>
        public Item FindItem(string query)
        {
            if (string.IsNullOrWhiteSpace(query)) return null;
            string q = query.Trim().ToLowerInvariant();
            Item best = null;
            int bestScore = 0;
            foreach (Item item in this.Shadow.Items)
            {
                if (item == null) continue;
                string name = (item.DisplayName ?? item.Name ?? "").ToLowerInvariant();
                string raw = (item.Name ?? "").ToLowerInvariant();
                int score = 0;
                if (name == q || raw == q || item.QualifiedItemId.Equals(query, StringComparison.OrdinalIgnoreCase)) score = 100;
                else if (name.StartsWith(q) || raw.StartsWith(q)) score = 60;
                else if (name.Contains(q) || raw.Contains(q)) score = 40;
                else if (q.EndsWith("s") && (name.Contains(q.TrimEnd('s')))) score = 30;
                if (score > bestScore) { bestScore = score; best = item; }
            }
            return best;
        }

        public int SlotOf(Item item)
        {
            for (int i = 0; i < this.Shadow.Items.Count; i++)
                if (ReferenceEquals(this.Shadow.Items[i], item)) return i;
            return -1;
        }

        /// <summary>Add to the shadow's inventory, or drop it at the body's feet when full. Returns true when kept.</summary>
        public bool TakeItem(Item item)
        {
            if (item == null) return false;
            if (this.Shadow.addItemToInventoryBool(item))
                return true;
            try { Game1.createItemDebris(item, this.Npc.Position + new Vector2(32f, 32f), -1, this.Npc.currentLocation); } catch { }
            return false;
        }

        /// <summary>Pull item debris (chopped wood, mined stone, harvest drops) within `radius` tiles into the inventory.</summary>
        public void CollectDebris(int radius)
        {
            GameLocation loc = this.Npc?.currentLocation;
            if (loc?.debris == null || loc.debris.Count == 0)
                return;
            Vector2 center = this.Npc.Position + new Vector2(32f, 32f);
            float max = radius * 64f;
            for (int i = loc.debris.Count - 1; i >= 0; i--)
            {
                Debris d = loc.debris[i];
                if (d == null) continue;
                Debris.DebrisType kind = d.debrisType.Value;
                if (kind == Debris.DebrisType.SPRITECHUNKS || kind == Debris.DebrisType.LETTERS || kind == Debris.DebrisType.NUMBERS)
                    continue;
                if (d.item == null && d.chunkType.Value < 0 && kind != Debris.DebrisType.RESOURCE && kind != Debris.DebrisType.OBJECT)
                    continue;
                for (int c = d.Chunks.Count - 1; c >= 0; c--)
                {
                    Chunk chunk = d.Chunks[c];
                    if (Vector2.Distance(chunk.position.Value, center) > max)
                        continue;
                    bool taken;
                    try { taken = d.collect(this.Shadow, chunk); }
                    catch { taken = false; }
                    if (!taken)
                        break;
                    d.Chunks.RemoveAt(c);
                }
                if (d.Chunks.Count == 0)
                    loc.debris.RemoveAt(i);
            }
        }
    }
}
