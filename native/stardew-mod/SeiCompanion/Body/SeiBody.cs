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
    /// One companion in the world: the NPC (walks, collides, carries the
    /// speech bubble, emotes and ground shadow) paired with the BotFarmer
    /// shadow that every game mechanic accepts as `who`. The shadow is synced
    /// FROM the NPC before anything reads it; nothing ever moves the shadow
    /// itself. Since 260921 the shadow is also what the player SEES: BodyDraw
    /// draws it, dressed with the character's Appearance, where the NPC's
    /// placeholder sprite would have been drawn.
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
        public string FollowTarget
        {
            get => this._followTarget;
            set { this._followTarget = value; this.FollowHoldAt = null; }
        }
        private string _followTarget;

        /// <summary>
        /// Following is ON HOLD (not cancelled) while this names the map the
        /// followed player was on when a command took the body to another map.
        /// The follow tick resumes by itself once the player leaves that map or
        /// comes to the body's map. Before 260925 such a command cleared the
        /// follow target for good: in the v0.6.5-beta.2 playtest the player
        /// said "follow me, we're heading outside", the model walked out first
        /// (goTo Farm), and nothing trailed the player for the rest of the
        /// session. The hold keeps the 260910 fix (the follow tick no longer
        /// drags the body straight back through the door it was sent out of).
        /// </summary>
        public string FollowHoldAt { get; private set; }

        /// <summary>
        /// A command is taking the body to `destination`. When that is not the
        /// followed player's map, put following on hold until the player moves
        /// on. Returns true when a hold was set (so results can say so).
        /// </summary>
        public bool HoldFollowForTrip(string destination)
        {
            if (this._followTarget == null)
                return false;
            Farmer target = this.ResolvePlayer(this._followTarget);
            string theirs = target?.currentLocation?.NameOrUniqueName;
            if (theirs == null || string.Equals(theirs, destination, StringComparison.OrdinalIgnoreCase))
                return false;
            this.FollowHoldAt = theirs;
            return true;
        }
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

        /// <summary>The look the shadow farmer was dressed with (the default look until ApplyLook runs).</summary>
        public Appearance Look { get; private set; } = new Appearance();

        /// <summary>
        /// Draw this body as its customized farmer (BodyDraw) instead of the
        /// NPC's placeholder sprite. Starts from config.json's FarmerLook and
        /// is switched off for good by a failed apply or a failed draw.
        /// </summary>
        public bool FarmerLook { get; set; }

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
        public void Spawn(Appearance look = null)
        {
            Farmer host = Game1.player;
            GameLocation loc = host.currentLocation ?? Game1.getFarm();
            Vector2 tile = this.FreeTileNear(loc, host.Tile, 1, reachable: true) ?? host.Tile;
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
            this.ApplyLook(look);
            BodyDraw.Register(this);
        }

        /// <summary>
        /// Dress the shadow farmer and start drawing it in the NPC's place
        /// (BodyDraw). Also called when a reconnecting bot adopts the body, so
        /// a look derived after the first spawn takes effect without a
        /// re-summon. Never throws: a failure leaves the placeholder sprite.
        /// </summary>
        public void ApplyLook(Appearance look)
        {
            this.Look = look ?? new Appearance();
            this.FarmerLook = this.Mod.Config.FarmerLook;
            if (!this.FarmerLook)
                return;
            try
            {
                // The shadow never runs Farmer.Update, so nothing else would
                // hand the sprite its owner or put it on a standing frame.
                this.Shadow.FarmerSprite.SetOwner(this.Shadow);
                this.Look.ApplyTo(this.Shadow);
                this.Shadow.FarmerSprite.StopAnimation();
                this.Shadow.FarmerSprite.faceDirection(this.Shadow.FacingDirection);
                if (this.Look.Rejected.Count > 0)
                    this.Monitor.Log($"{this.Name}: appearance fields the game refused (defaults used): {string.Join(", ", this.Look.Rejected)}", LogLevel.Debug);
            }
            catch (Exception ex)
            {
                this.FarmerLook = false;
                this.Monitor.Log($"{this.Name}: could not apply the farmer look, using the placeholder sprite: {ex.Message}", LogLevel.Warn);
            }
        }

        /// <summary>
        /// The shadow's Update never runs (tick-free design, BotFarmer.cs), so
        /// its walk cycle is advanced here from what the NPC did this tick:
        /// moved = the walk animation for the facing, still = the standing
        /// frame. Only on the host's current map: FarmerSprite's footstep
        /// side effects (dust, sound) are written for the map on screen.
        /// </summary>
        private void AnimateShadow()
        {
            if (!this.FarmerLook)
                return;
            try
            {
                FarmerSprite sprite = this.Shadow.FarmerSprite;
                bool moving = Vector2.Distance(this.Npc.Position, this._lastPos) > 0.5f;
                if (moving && this.Npc.currentLocation == Game1.currentLocation)
                {
                    int walk;
                    switch (this.Npc.FacingDirection)
                    {
                        case 0: walk = FarmerSprite.walkUp; break;
                        case 1: walk = FarmerSprite.walkRight; break;
                        case 3: walk = FarmerSprite.walkLeft; break;
                        default: walk = FarmerSprite.walkDown; break;
                    }
                    sprite.animate(walk, 16);
                }
                else
                {
                    sprite.StopAnimation();
                    sprite.faceDirection(this.Shadow.FacingDirection);
                }
            }
            catch (Exception ex)
            {
                this.FarmerLook = false;
                this.Monitor.Log($"{this.Name}: farmer animation failed, using the placeholder sprite: {ex.Message}", LogLevel.Warn);
            }
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
            BodyDraw.Unregister(this);
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
                this.WarpTo(host.currentLocation.NameOrUniqueName, this.FreeTileNear(host.currentLocation, host.Tile, 1, reachable: true)?.ToPoint() ?? host.TilePoint);
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
            // Before anything below moves the body by hand (follow catch-up,
            // barrier hop): those are teleports, not steps to animate.
            this.AnimateShadow();

            if (this.Paused)
            {
                // Stand still like a player away from the keyboard.
                this.Npc.controller = null;
                this.Npc.Halt();
                // Keep the movement baseline current, or the walk cycle would
                // run on the spot for the whole pause.
                this._lastPos = this.Npc.Position;
                return;
            }

            this.Runner.Tick();
            this.Background.Tick();
            this.Reflex.Tick(tick);
            if (!this.Runner.Busy && !this.Background.Busy)
                this.FollowTick();
            this.BarrierHop();
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
            if (this.FollowHoldAt != null)
            {
                // Resume once the player has moved on from the map they were on
                // when a command sent the body away, or has come to the body.
                bool together = target.currentLocation == this.Npc.currentLocation;
                bool movedOn = !string.Equals(target.currentLocation.NameOrUniqueName, this.FollowHoldAt, StringComparison.OrdinalIgnoreCase);
                if (!together && !movedOn)
                    return;
                this.FollowHoldAt = null;
                this._followCooldown = 0;
            }

            bool sameMap = target.currentLocation == this.Npc.currentLocation;
            // Count a stall on EVERY tick. It used to be counted only on the
            // ticks past the re-path cooldown (1 in 6 to 16), so "stuck for
            // 180 ticks" meant 20 to 50 seconds of walking into something.
            // A frozen world (a chest, a shop menu, dialogue, an event) stops
            // every NPC; that is not a stall, and counting it teleported the
            // body after a 3 s look into a chest (review of PR #21).
            if (Game1.shouldTimePass())
            {
                if (sameMap && this.Npc.controller != null && Vector2.Distance(this.Npc.Position, this._lastPos) < 0.5f)
                    this._stuckTicks++;
                else
                    this._stuckTicks = 0;
            }

            if (this._followCooldown > 0) { this._followCooldown--; return; }

            if (!sameMap)
            {
                // A festival, a cutscene or a temporary map (festival grounds,
                // event stages) is the game's business: warping a body in can
                // break the event. Wait where we are; trailing picks up again
                // once the player is back on a real map.
                if (Game1.isFestival() || Game1.eventUp || this.IsTemporaryMap(target.currentLocation))
                {
                    this._followCooldown = 60;
                    return;
                }
                // Different map: route there in the background; teleport beside
                // them only when no route exists (the mines).
                List<Hop> route = Router.FindRoute(this.Npc.currentLocation, target.currentLocation.NameOrUniqueName);
                if (route != null && route.Count > 0 && route.Count <= 4)
                {
                    var ctx = new ActionContext(this, null, default);
                    this.Background.Start(ctx, FollowTravel, Movement.Travel(ctx, target.currentLocation.NameOrUniqueName, null));
                }
                else
                {
                    this.WarpTo(target.currentLocation.NameOrUniqueName, this.FreeTileNear(target.currentLocation, target.Tile, 1, reachable: true)?.ToPoint() ?? target.TilePoint);
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
            // Stuck for a while while trailing on the same map (3 s of no
            // progress with a live path), or far behind: hop beside them.
            if (this._stuckTicks > 180 || dist > 18f)
            {
                Vector2? spot = this.FreeTileNear(target.currentLocation, target.Tile, 1, this.Npc.Tile, reachable: true);
                if (spot.HasValue)
                {
                    this.Npc.controller = null;
                    this.Npc.Position = spot.Value * 64f;
                    this._stuckTicks = 0;
                    this.SyncShadow();
                    return;
                }
            }
            if (Vector2.Distance(target.Tile, this._lastFollowGoal) < 1.5f && this.Npc.controller != null)
            {
                this._followCooldown = 5;
                return;
            }
            // The free tile beside them on OUR side: the nearest-to-the-player
            // pick was as likely to be behind them, and the way there went
            // through their tile.
            Vector2? goal = this.FreeTileNear(target.currentLocation, target.Tile, 1, this.Npc.Tile, reachable: true);
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

        /// <summary>The background routine name of a follow trip to another map.</summary>
        private const string FollowTravel = "follow-travel";

        private int _hopStuckTicks;
        private int _farmerBlockTicks;

        /// <summary>Ticks stalled against a farmer before stepping through them (1 s: a walking player usually clears the way first).</summary>
        private const int FarmerBlockHopTicks = 60;

        /// <summary>
        /// The NPC's own step collision honors the NPCBarrier tile property
        /// (every map exit has it, so villagers never wander out), which a
        /// farmer walks through. TryPath already routes as a farmer; here the
        /// body, stalled with a live controller whose next tile is an NPC-only
        /// wall, steps onto that tile directly. Measured 260910: stuck at
        /// (77,17) two tiles from the bus stop with the route found.
        /// </summary>
        private void BarrierHop()
        {
            PathFindController ctl = this.Npc.controller;
            if (ctl?.pathToEndPoint == null || ctl.pathToEndPoint.Count == 0)
            {
                this._hopStuckTicks = 0;
                this._farmerBlockTicks = 0;
                return;
            }
            if (Vector2.Distance(this.Npc.Position, this._lastPos) >= 0.5f)
            {
                this._hopStuckTicks = 0;
                this._farmerBlockTicks = 0;
                return;
            }
            // A frozen world is not a stall (see FollowTick).
            if (!Game1.shouldTimePass())
                return;
            Point next = ctl.pathToEndPoint.Peek();
            GameLocation loc = this.Npc.currentLocation;
            Point here = this.Npc.TilePoint;
            // The path stack carries the start tile, so the top can be the
            // tile the body stands on; the step it is trying to make is the
            // one after it.
            Point step = next;
            if (step == here)
            {
                foreach (Point p in ctl.pathToEndPoint)
                    if (p != here) { step = p; break; }
            }

            // A farmer in the way. The NPC's step collision refuses to walk
            // into a farmer while the path search never sees one, so a path
            // across the player's tile stalls on the tile before it (every
            // "stuck" in the v0.6.5-beta.2 playtest). TryPath routes around a
            // standing player; this is for a player who steps into the path,
            // or stands in a one-tile doorway: after a second, step through
            // them, as the player already walks through the companion
            // (farmerPassesThrough).
            // This runs before the own-tile return below: a player standing ON
            // the body's tile blocks its first step just the same.
            if (step != here && (this.FarmerOn(loc, step) || this.FarmerOn(loc, here)))
            {
                if (++this._farmerBlockTicks < FarmerBlockHopTicks)
                    return;
                this._farmerBlockTicks = 0;
                this._hopStuckTicks = 0;
                if (next == here)
                    ctl.pathToEndPoint.Pop();
                this.Npc.Position = new Vector2(step.X * 64, step.Y * 64);
                this.SyncShadow();
                return;
            }
            this._farmerBlockTicks = 0;
            if (next == here)
                return;

            if (++this._hopStuckTicks < 10)
                return;
            this._hopStuckTicks = 0;
            bool barrier;
            try
            {
                // Standing ON a barrier tile blocks every step too (the step
                // check's box still overlaps the tile it leaves), so the tile
                // under the body counts as well as the next one.
                var rect = new Rectangle(next.X * 64 + 8, next.Y * 64 + 8, 48, 48);
                barrier = loc.doesTileHaveProperty(next.X, next.Y, "NPCBarrier", "Back") != null
                    || loc.doesTileHaveProperty(here.X, here.Y, "NPCBarrier", "Back") != null
                    || (loc.isCollidingPosition(rect, Game1.viewport, false, 0, false, this.Npc, true, false, false)
                        && !loc.isCollidingPosition(rect, Game1.viewport, true, 0, false, this.Shadow, true, false, false));
            }
            catch { barrier = false; }
            if (!barrier)
                return;
            this.Npc.Position = new Vector2(next.X * 64, next.Y * 64);
            this.SyncShadow();
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
                // Path as a FARMER, walk as the NPC. Every map exit carries the
                // NPCBarrier tile property (villagers must never wander out),
                // and the NPC pathfinder honors it, so an NPC-routed body could
                // never leave the farm: measured 260910, "no path to (78,15)"
                // from three tiles away, farmer collision false, NPC collision
                // true, NPCBarrier on Back. The search runs with the invisible
                // shadow (a Farmer) for collisions and the result drives the
                // NPC's controller; the NPC constructor path is the fallback.
                this.SyncShadow();
                Stack<Point> path = null;
                try { path = PathFindController.findPath(this.Npc.TilePoint, target, PathFindController.isAtEndPoint, loc, this.Shadow, 10000); }
                catch (Exception ex) { this.Monitor.Log($"{this.Name}: farmer path search threw: {ex.Message}", LogLevel.Trace); }
                // The game's search walks straight through a standing farmer
                // (it never looks at them), and the NPC then stalls against
                // them. Detour around every farmer on this map when the found
                // path crosses one; keep the game's path when no detour exists
                // (a player in a one-tile doorway), BarrierHop steps through.
                if (path != null && path.Count > 0)
                {
                    HashSet<Point> occupied = this.FarmerTiles(loc);
                    occupied.Remove(this.Npc.TilePoint);
                    if (occupied.Count > 0 && !occupied.Contains(target) && path.Any(p => occupied.Contains(p)))
                    {
                        Stack<Point> detour = this.DetourPath(loc, target, occupied, GridPath.DetourBudget(path.Count));
                        if (detour != null)
                            path = detour;
                    }
                }
                PathFindController controller;
                if (path != null && path.Count > 0)
                {
                    controller = new PathFindController(path, this.Npc, loc)
                    {
                        finalFacingDirection = 2,
                        endBehaviorFunction = onArrive,
                    };
                }
                else
                {
                    controller = new PathFindController(this.Npc, loc, target, 2, onArrive);
                }
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

        /// <summary>
        /// Our own path to `target` that avoids `blocked` tiles, over the same
        /// walkability the verbs use, as a stack in the game's shape (next
        /// tile on top, the start tile included). Null when there is none.
        /// </summary>
        private Stack<Point> DetourPath(GameLocation loc, Point target, HashSet<Point> blocked, int maxNodes)
        {
            try
            {
                Point start = this.Npc.TilePoint;
                List<(int X, int Y)> tiles = GridPath.Find(
                    (start.X, start.Y),
                    (target.X, target.Y),
                    (x, y) => !blocked.Contains(new Point(x, y)) && this.IsWalkable(loc, new Vector2(x, y)),
                    maxNodes);
                if (tiles == null || tiles.Count == 0)
                    return null;
                var stack = new Stack<Point>();
                for (int i = tiles.Count - 1; i >= 0; i--)
                    stack.Push(new Point(tiles[i].X, tiles[i].Y));
                return stack;
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"{this.Name}: detour search threw: {ex.Message}", LogLevel.Trace);
                return null;
            }
        }

        /// <summary>Every tile a farmer's bounding box overlaps on this map (the host, farmhands; never the shadow).</summary>
        public HashSet<Point> FarmerTiles(GameLocation loc)
        {
            var tiles = new HashSet<Point>();
            if (loc == null) return tiles;
            try
            {
                foreach (Farmer f in Game1.getOnlineFarmers())
                {
                    if (f == null || f.currentLocation != loc) continue;
                    Rectangle box = f.GetBoundingBox();
                    for (int x = box.Left / 64; x <= (box.Right - 1) / 64; x++)
                        for (int y = box.Top / 64; y <= (box.Bottom - 1) / 64; y++)
                            tiles.Add(new Point(x, y));
                }
            }
            catch { }
            return tiles;
        }

        /// <summary>Whether a farmer stands on (overlaps) this tile.</summary>
        public bool FarmerOn(GameLocation loc, Point tile)
        {
            return this.FarmerTiles(loc).Contains(tile);
        }

        public bool FarmerOn(GameLocation loc, Vector2 tile)
        {
            return this.FarmerOn(loc, new Point((int)tile.X, (int)tile.Y));
        }

        /// <summary>
        /// A passable tile within `radius` of `around` that no farmer stands
        /// on, or null. Nearest to `around` first; with `prefer`, nearest to
        /// that (the body's own tile) first, so the body stops on its side of
        /// the player instead of walking round them. With `reachable`, the tile
        /// must also be a short walk from `around` (at most 2 x radius steps,
        /// `around` itself counted as open since a farmer stands there), so a
        /// tile across a fence corner from the player is never "beside" them.
        /// </summary>
        public Vector2? FreeTileNear(GameLocation loc, Vector2 around, int radius, Vector2? prefer = null, bool reachable = false)
        {
            var candidates = new List<Vector2>();
            for (int dx = -radius; dx <= radius; dx++)
                for (int dy = -radius; dy <= radius; dy++)
                {
                    if (dx == 0 && dy == 0) continue;
                    candidates.Add(new Vector2(around.X + dx, around.Y + dy));
                }
            HashSet<Point> occupied = this.FarmerTiles(loc);
            IEnumerable<Vector2> order = prefer.HasValue
                ? candidates.OrderBy(t => Vector2.Distance(t, prefer.Value)).ThenBy(t => Vector2.Distance(t, around))
                : candidates.OrderBy(t => Vector2.Distance(t, around));
            foreach (Vector2 t in order)
            {
                if (occupied.Contains(new Point((int)t.X, (int)t.Y)))
                    continue;
                if (!this.IsWalkable(loc, t))
                    continue;
                if (reachable && !GridPath.WithinSteps(
                        ((int)around.X, (int)around.Y),
                        ((int)t.X, (int)t.Y),
                        (x, y) => (x == (int)around.X && y == (int)around.Y) || this.IsWalkable(loc, new Vector2(x, y)),
                        2 * radius))
                    continue;
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
                // The same farmer collision the path search uses, so a tile the
                // route can cross is a tile a verb may stand on. The occupancy
                // mask used before counted tilled soil and crops as obstacles
                // (a player walks over both), which walled the body out of
                // its own field after two tills (measured 260910).
                var rect = new Rectangle((int)tile.X * 64 + 8, (int)tile.Y * 64 + 8, 48, 48);
                return !loc.isCollidingPosition(rect, Game1.viewport, true, 0, false, this.Shadow, true, false, false);
            }
            catch { return false; }
        }

        /// <summary>
        /// Festival grounds and event stages: maps the game builds for the
        /// occasion (named "Temp") and drops afterwards. GameLocation.IsTemporary
        /// is read by reflection so a game build without it still loads the mod.
        /// </summary>
        private bool IsTemporaryMap(GameLocation loc)
        {
            if (loc == null) return false;
            if (string.Equals(loc.Name, "Temp", StringComparison.OrdinalIgnoreCase)) return true;
            try { return this.Mod.Helper.Reflection.GetProperty<bool>(loc, "IsTemporary", required: false)?.GetValue() ?? false; }
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
            // A background follow-travel would keep walking (and warping) the
            // body under the command: buying seeds in Town while the player
            // steps into the FarmHouse got warped mid-purchase. The command
            // owns the body; FollowTick starts a fresh trip once it ends.
            if (this.Background.Busy && this.Background.ActionName == FollowTravel)
            {
                this.Background.Abort("a command took over");
                if (this.Npc != null) this.Npc.controller = null;
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

        /// <summary>
        /// Would TakeItem keep ALL of `item` (the same stacking and empty-slot
        /// rules, without changing anything)? A full bag would otherwise drop
        /// the rest at the body's feet.
        /// </summary>
        public bool HasRoomFor(Item item)
        {
            if (item == null) return true;
            try
            {
                var items = this.Shadow.Items;
                int left = item.Stack;
                for (int i = 0; i < items.Count; i++)
                {
                    Item slot = items[i];
                    if (slot == null || !slot.canStackWith(item)) continue;
                    left -= Math.Max(0, slot.maximumStackSize() - slot.Stack);
                    if (left <= 0) return true;
                }
                for (int i = 0; i < items.Count && i < this.Shadow.MaxItems; i++)
                    if (items[i] == null) return true;
                return items.Count < this.Shadow.MaxItems;
            }
            catch { return true; }
        }

        /// <summary>Add to the shadow's inventory, or drop it at the body's feet when full. Returns true when kept.</summary>
        /// <summary>
        /// Put an item in the shadow's bag: stack onto a matching stack, else
        /// the first empty slot. The game's Farmer.addItemToInventoryBool
        /// refused every drop for the shadow (measured 260910: "picked up 0
        /// items" after 25 pieces of debris, both bodies), so the bag is
        /// managed here. A full bag drops the item where the body stands.
        /// </summary>
        public bool TakeItem(Item item)
        {
            if (item == null) return false;
            try
            {
                var items = this.Shadow.Items;
                for (int i = 0; i < items.Count; i++)
                {
                    Item slot = items[i];
                    if (slot == null || !slot.canStackWith(item)) continue;
                    int room = slot.maximumStackSize() - slot.Stack;
                    if (room <= 0) continue;
                    int moved = Math.Min(room, item.Stack);
                    slot.Stack += moved;
                    item.Stack -= moved;
                    if (item.Stack <= 0) return true;
                }
                for (int i = 0; i < items.Count && i < this.Shadow.MaxItems; i++)
                {
                    if (items[i] != null) continue;
                    items[i] = item;
                    return true;
                }
                if (items.Count < this.Shadow.MaxItems)
                {
                    items.Add(item);
                    return true;
                }
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"{this.Name}: take item failed: {ex.Message}", LogLevel.Debug);
            }
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
            // Only item debris: OBJECT (a dropped Item, or an item id per chunk),
            // RESOURCE (wood, stone, fiber by id) and ARCHAEOLOGY. CHUNKS are the
            // cosmetic splinters a broken weed or stone throws (Debris.collect
            // throws on them), the rest is text. The item is lifted out of the
            // debris here rather than through Debris.collect, which refused the
            // shadow farmer (see TakeItem). Chunks are collected even before
            // they land: a map the host is not on never animates them.
            for (int i = loc.debris.Count - 1; i >= 0; i--)
            {
                Debris d = loc.debris[i];
                if (d == null) continue;
                Debris.DebrisType kind = d.debrisType.Value;
                if (kind != Debris.DebrisType.OBJECT && kind != Debris.DebrisType.RESOURCE && kind != Debris.DebrisType.ARCHAEOLOGY)
                    continue;
                for (int c = d.Chunks.Count - 1; c >= 0; c--)
                {
                    Chunk chunk = d.Chunks[c];
                    if (Vector2.Distance(chunk.position.Value, center) > max)
                        continue;
                    Item item = null;
                    try
                    {
                        if (d.item != null)
                            item = d.item;
                        else if (!string.IsNullOrEmpty(d.itemId?.Value))
                            item = ItemRegistry.Create(d.itemId.Value, 1, d.itemQuality);
                    }
                    catch (Exception ex)
                    {
                        this.Monitor.Log($"{this.Name}: could not read debris ({kind}, {d.itemId?.Value}): {ex.Message}", LogLevel.Debug);
                    }
                    if (item == null)
                        break;
                    if (!this.TakeItem(item))
                        break;
                    if (d.item != null)
                    {
                        d.item = null;
                        d.Chunks.Clear();
                        break;
                    }
                    d.Chunks.RemoveAt(c);
                }
                if (d.Chunks.Count == 0)
                    loc.debris.RemoveAt(i);
            }
        }
    }
}
