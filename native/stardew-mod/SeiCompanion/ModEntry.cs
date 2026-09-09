using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using SeiCompanion.Body;
using SeiCompanion.Chat;
using SeiCompanion.Dev;
using SeiCompanion.Net;

namespace SeiCompanion
{
    /// <summary>
    /// Mod entry point. Owns the loopback server, the companion bodies (one
    /// per connected Sei bot), and the lifecycle hooks that keep a body out
    /// of the save file and off the title screen.
    ///
    /// Threading rule (StarDojo pattern): the server threads never touch game
    /// state. Everything they want done is queued on <see cref="GameThread"/>
    /// and drained at the top of every UpdateTicked, so all game access runs
    /// on the game thread in game order.
    /// </summary>
    public class ModEntry : Mod
    {
        public static ModEntry Instance { get; private set; }
        internal ModConfig Config { get; private set; }
        internal Server Server { get; private set; }

        /// <summary>Work handed over from server threads, drained on UpdateTicked.</summary>
        internal readonly ConcurrentQueue<Action> GameThread = new ConcurrentQueue<Action>();

        /// <summary>Live bodies keyed by session id (one body per WebSocket client).</summary>
        internal readonly Dictionary<string, SeiBody> Bodies = new Dictionary<string, SeiBody>();

        internal Texture2D CompanionSprite { get; private set; }
        internal Texture2D CompanionPortrait { get; private set; }

        /// <summary>Asset names the sprite + portrait are registered under (AssetRequested).</summary>
        public const string SpriteAsset = "Characters/SeiCompanion";
        public const string PortraitAsset = "Portraits/SeiCompanion";

        private int _tick;

        public override void Entry(IModHelper helper)
        {
            Instance = this;
            this.Config = helper.ReadConfig<ModConfig>();
            if (string.IsNullOrWhiteSpace(this.Config.Token))
            {
                this.Config.Token = ModConfig.NewToken();
                helper.WriteConfig(this.Config);
                this.Monitor.Log("Generated a connection token in config.json.", LogLevel.Info);
            }

            helper.Events.Content.AssetRequested += this.OnAssetRequested;
            helper.Events.GameLoop.GameLaunched += this.OnGameLaunched;
            helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
            helper.Events.GameLoop.SaveLoaded += this.OnSaveLoaded;
            helper.Events.GameLoop.DayStarted += this.OnDayStarted;
            helper.Events.GameLoop.DayEnding += this.OnDayEnding;
            helper.Events.GameLoop.Saving += this.OnSaving;
            helper.Events.GameLoop.Saved += this.OnSaved;
            helper.Events.GameLoop.TimeChanged += this.OnTimeChanged;
            helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;

            var harmony = new Harmony(this.ModManifest.UniqueID);
            ChatHook.Apply(harmony, this.Monitor, this.OnChatLine);

            this.Server = new Server(this.Config, this.Monitor, this);
            this.Server.Start();
        }

        /*********
        ** Assets
        *********/
        private void OnGameLaunched(object sender, GameLaunchedEventArgs e)
        {
            try
            {
                this.CompanionSprite = this.Helper.ModContent.Load<Texture2D>("Assets/companion.png");
                this.CompanionPortrait = this.Helper.ModContent.Load<Texture2D>("Assets/portrait.png");
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"Could not load the companion art: {ex.Message}", LogLevel.Error);
            }
        }

        private void OnAssetRequested(object sender, AssetRequestedEventArgs e)
        {
            // A plain StardewValley.NPC loads its sheet through the content
            // pipeline by name (AnimatedSprite.textureName), so the sheet must
            // exist as a game asset. No Data/Characters entry on purpose: a
            // registered character is auto-spawned by the game and needs a
            // duplicate sweep (amarisaster); an ad hoc NPC does not.
            if (e.NameWithoutLocale.IsEquivalentTo(SpriteAsset))
                e.LoadFromModFile<Texture2D>("Assets/companion.png", AssetLoadPriority.Exclusive);
            else if (e.NameWithoutLocale.IsEquivalentTo(PortraitAsset))
                e.LoadFromModFile<Texture2D>("Assets/portrait.png", AssetLoadPriority.Exclusive);
        }

        /*********
        ** Game loop
        *********/
        private void OnUpdateTicked(object sender, UpdateTickedEventArgs e)
        {
            this._tick++;
            // Drain server-thread work first so a command lands before this
            // tick's body updates.
            while (this.GameThread.TryDequeue(out Action work))
            {
                try { work(); }
                catch (Exception ex) { this.Monitor.Log($"Queued work failed: {ex}", LogLevel.Error); }
            }

            // A dev-started farm ends its arrival cutscene here (no-op otherwise).
            DevCommands.Tick(this);

            if (!Context.IsWorldReady)
                return;

            foreach (SeiBody body in this.Bodies.Values.ToList())
            {
                try { body.Tick(this._tick); }
                catch (Exception ex)
                {
                    this.Monitor.Log($"{body.Name}: tick failed (recovering): {ex}", LogLevel.Error);
                }
            }
        }

        private void OnTimeChanged(object sender, TimeChangedEventArgs e)
        {
            foreach (SeiBody body in this.Bodies.Values.ToList())
                body.OnTimeChanged(e.NewTime);
        }

        private void OnSaveLoaded(object sender, SaveLoadedEventArgs e)
        {
            this.Server.NotifySaveState();
        }

        private void OnDayStarted(object sender, DayStartedEventArgs e)
        {
            foreach (SeiBody body in this.Bodies.Values.ToList())
                body.OnDayStarted();
            this.Server.NotifySaveState();
        }

        private void OnDayEnding(object sender, DayEndingEventArgs e)
        {
            // Before the game runs its end-of-day passes over every character
            // (NPC.dayUpdate, schedules) the companion steps out of the world;
            // it is re-added on DayStarted.
            foreach (SeiBody body in this.Bodies.Values.ToList())
                body.Detach("day ending");
        }

        private void OnSaving(object sender, SavingEventArgs e)
        {
            // Belt and braces with DayEnding: nothing of ours may be inside
            // the save. Inventory + wallet ride the host farmer's modData.
            foreach (SeiBody body in this.Bodies.Values.ToList())
            {
                body.Persist();
                body.Detach("saving");
            }
        }

        private void OnSaved(object sender, SavedEventArgs e)
        {
            foreach (SeiBody body in this.Bodies.Values.ToList())
                body.Reattach();
        }

        private void OnReturnedToTitle(object sender, ReturnedToTitleEventArgs e)
        {
            foreach (string id in this.Bodies.Keys.ToList())
                this.Despawn(id, "returned to title");
            DevCommands.Reset();
            this.Server.NotifySaveState();
        }

        /*********
        ** Bodies
        *********/
        /// <summary>Spawn a body for a session. Runs on the game thread. Returns an error code or null.</summary>
        internal string Spawn(string sessionId, string name, Session session, out SeiBody body)
        {
            body = null;
            if (!Context.IsWorldReady)
                return "NO_SAVE";
            if (!Context.IsMainPlayer)
                return "NOT_HOST";
            if (this.CompanionSprite == null)
                return "NO_ART";

            // A farmhand without the mod cannot resolve our sprite asset and
            // would error on the NetRef; refuse rather than crash their client.
            foreach (IMultiplayerPeer peer in this.Helper.Multiplayer.GetConnectedPlayers())
            {
                if (peer.IsSplitScreen)
                    continue;
                if (peer.GetMod(this.ModManifest.UniqueID) == null)
                    return "FARMHAND_NO_MOD";
            }

            if (this.Bodies.TryGetValue(sessionId, out SeiBody existing))
            {
                body = existing;
                return null;
            }

            string cleanName = SeiBody.SanitizeName(name);
            foreach (KeyValuePair<string, SeiBody> pair in this.Bodies.ToList())
            {
                SeiBody other = pair.Value;
                if (!string.Equals(other.Name, cleanName, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (other.Session != null && other.Session.IsOpen)
                    return "NAME_TAKEN";
                // The previous bot for this companion dropped its socket and is
                // inside the disconnect grace: the reconnecting bot adopts the
                // body instead of spawning a second one.
                this.Bodies.Remove(pair.Key);
                other.Adopt(session);
                this.Bodies[sessionId] = other;
                body = other;
                this.Monitor.Log($"Companion {cleanName} re-adopted by a reconnecting bot.", LogLevel.Info);
                return null;
            }

            body = new SeiBody(cleanName, session, this);
            body.Spawn();
            this.Bodies[sessionId] = body;
            this.Monitor.Log($"Spawned companion {cleanName}.", LogLevel.Info);
            return null;
        }

        internal void Despawn(string sessionId, string reason)
        {
            if (!this.Bodies.TryGetValue(sessionId, out SeiBody body))
                return;
            this.Bodies.Remove(sessionId);
            try
            {
                body.Persist();
                body.Remove(reason);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"{body.Name}: despawn failed: {ex.Message}", LogLevel.Warn);
            }
            this.Monitor.Log($"Removed companion {body.Name} ({reason}).", LogLevel.Info);
        }

        internal SeiBody BodyFor(string sessionId)
        {
            return this.Bodies.TryGetValue(sessionId, out SeiBody body) ? body : null;
        }

        /*********
        ** Chat
        *********/
        private void OnChatLine(long sourceFarmer, int chatKind, string message)
        {
            if (chatKind != 0 && chatKind != 3)
                return; // 2 = notification, 1/other = error
            if (string.IsNullOrWhiteSpace(message))
                return;
            Farmer who = null;
            foreach (Farmer f in Game1.getOnlineFarmers())
            {
                if (f.UniqueMultiplayerID == sourceFarmer) { who = f; break; }
            }
            string from = who?.Name ?? "someone";
            bool isHost = Game1.player != null && sourceFarmer == Game1.player.UniqueMultiplayerID;
            foreach (SeiBody body in this.Bodies.Values.ToList())
            {
                // The companion's own echo never passes through receiveChatMessage
                // (addMessage is a different path), so nothing to filter here.
                body.Session.SendEvent("chat", new Dictionary<string, object>
                {
                    ["from"] = from,
                    ["text"] = message,
                    ["kind"] = chatKind == 3 ? "private" : "public",
                    ["farmerId"] = sourceFarmer,
                    ["isHost"] = isHost,
                    ["sameLocation"] = who != null && body.Npc?.currentLocation != null && who.currentLocation == body.Npc.currentLocation,
                });
            }
        }

        /*********
        ** Hello payload (any thread; reads are tolerant)
        *********/
        internal Dictionary<string, object> SaveInfo()
        {
            var save = new Dictionary<string, object> { ["loaded"] = false };
            try
            {
                if (Context.IsWorldReady && Game1.player != null)
                {
                    save["loaded"] = true;
                    save["farmName"] = Game1.player.farmName.Value;
                    save["uniqueId"] = Game1.uniqueIDForThisGame.ToString();
                    save["day"] = Game1.dayOfMonth;
                    save["season"] = Game1.currentSeason;
                    save["year"] = Game1.year;
                    save["time"] = Game1.timeOfDay;
                    save["isHost"] = Context.IsMainPlayer;
                    save["companions"] = this.Bodies.Values.Select(b => b.Name).ToList();
                }
            }
            catch { /* a mid-load read; the next hello is fine */ }
            return save;
        }
    }
}
