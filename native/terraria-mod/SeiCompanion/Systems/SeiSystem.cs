// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// The mod's world-side glue: the companion registry, the game-thread drain,
// chat in, world events, and per-companion bag persistence in the world file.
//
// Where game-thread work runs:
//   single player / client  PostUpdateEverything, and UpdateUI while paused
//   dedicated server        PostUpdateEverything while a client is connected,
//                           and Main.OnTickForThirdPartySoftwareOnly always.
// A dedicated server only runs Main.Update while a client is connected
// (Main.DedServ loop: `if (Netplay.HasClients) Update(...)`), so NPC AI and
// every per-tick mod hook stop with nobody joined. The bridge still answers
// then; bodies simply stand still. The dev-only HeadlessTick setting runs
// Main.Update anyway so the test harness can play without a client.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Microsoft.Xna.Framework;
using SeiCompanion.Body;
using SeiCompanion.Link;
using Terraria;
using Terraria.Chat;
using Terraria.ID;
using Terraria.ModLoader;
using Terraria.ModLoader.IO;

namespace SeiCompanion.Systems
{
	public class SeiSystem : ModSystem
	{
		private static readonly Dictionary<string, Companion> BySession = new();
		/// <summary>Bags of companions not currently in the world, by lower-case name (saved with the world).</summary>
		private static readonly Dictionary<string, List<Item>> StoredBags = new();

		/// <summary>Replaced whole (never mutated) so the bridge's socket threads can read it.</summary>
		public static volatile Dictionary<string, object> WorldInfo = new() { ["loaded"] = false };

		private static bool _worldLoaded;
		private static MethodInfo _mainUpdate;
		private static long _rawTicks;
		public static ulong Ticks;

		public static IEnumerable<Companion> All => BySession.Values;

		public static Companion ForSession(string sessionId) =>
			sessionId != null && BySession.TryGetValue(sessionId, out var c) ? c : null;

		public static Companion ForNpc(int whoAmI)
		{
			foreach (var c in BySession.Values)
				if (c.NpcIndex == whoAmI) return c;
			return null;
		}

		public static string Role()
		{
			switch (Main.netMode)
			{
				case NetmodeID.Server: return "server";
				case NetmodeID.MultiplayerClient: return "client";
				default: return "single";
			}
		}

		// ── Hooks ─────────────────────────────────────────────────────────
		public override void Load()
		{
			Main.OnTickForThirdPartySoftwareOnly += RawTick;
			On_ChatCommandProcessor.ProcessIncomingMessage += OnIncomingChat;
		}

		public override void Unload()
		{
			Main.OnTickForThirdPartySoftwareOnly -= RawTick;
			On_ChatCommandProcessor.ProcessIncomingMessage -= OnIncomingChat;
		}

		public override void OnWorldLoad()
		{
			_worldLoaded = true;
			RefreshWorldInfo();
		}

		public override void OnWorldUnload()
		{
			_worldLoaded = false;
			foreach (var c in BySession.Values.ToList())
			{
				StoreBag(c);
				c.Session?.SendEvent("despawned", new Dictionary<string, object> { ["reason"] = "world closed" });
			}
			BySession.Clear();
			StoredBags.Clear();
			Events.Reset();
			WorldInfo = new Dictionary<string, object> { ["loaded"] = false };
		}

		public static void ClearAll()
		{
			BySession.Clear();
			StoredBags.Clear();
			WorldInfo = new Dictionary<string, object> { ["loaded"] = false };
		}

		public override void PostUpdateEverything()
		{
			GameThread.Drain();
			Ticks++;
			if (Ticks % 60 == 0) RefreshWorldInfo();
			if (Main.netMode != NetmodeID.MultiplayerClient)
			{
				Events.Tick();
				foreach (var c in BySession.Values.ToList()) c.SystemTick();
			}
		}

		public override void UpdateUI(GameTime gameTime)
		{
			// Single player pauses the world under the inventory / menu; the
			// bridge still answers (observe, say) while paused.
			if (Main.gamePaused) GameThread.Drain();
		}

		private static void RawTick()
		{
			if (!Main.dedServ) return;
			_rawTicks++;
			GameThread.Drain();
			if (SeiMod.Config?.HeadlessTick == true && _worldLoaded && !Netplay.HasClients)
			{
				try
				{
					_mainUpdate ??= typeof(Main).GetMethod("Update", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public, null, new[] { typeof(GameTime) }, null);
					_mainUpdate?.Invoke(Main.instance, new object[] { new GameTime() });
				}
				catch (Exception e)
				{
					if (_rawTicks % 600 == 0) SeiMod.Log?.Warn($"[Sei] headless tick failed: {e.InnerException?.Message ?? e.Message}");
				}
			}
			else if (_rawTicks % 60 == 0)
			{
				RefreshWorldInfo();
			}
		}

		private static void OnIncomingChat(On_ChatCommandProcessor.orig_ProcessIncomingMessage orig, ChatCommandProcessor self, ChatMessage message, int clientId)
		{
			string text = message?.Text;
			orig(self, message, clientId);
			try
			{
				if (string.IsNullOrWhiteSpace(text) || text.StartsWith("/")) return;
				if (clientId < 0 || clientId >= Main.maxPlayers) return;
				var p = Main.player[clientId];
				if (p == null || !p.active) return;
				var fields = new Dictionary<string, object>
				{
					["from"] = p.name,
					["text"] = text.Trim(),
					["kind"] = "player",
				};
				// Who could hear it: each session gets its own "nearby" flag.
				foreach (var s in SeiMod.Bridge?.Sessions() ?? new List<Session>())
				{
					var c = ForSession(s.Id);
					var f = new Dictionary<string, object>(fields);
					if (c?.Npc != null) f["dist"] = (int)(Vector2.Distance(c.Npc.Center, p.Center) / 16f);
					s.SendEvent("chat", f);
				}
			}
			catch (Exception e)
			{
				SeiMod.Log?.Warn($"[Sei] chat hook: {e.Message}");
			}
		}

		// ── World info for /hello ────────────────────────────────────────
		public static void RefreshWorldInfo()
		{
			if (!_worldLoaded || Main.gameMenu && !Main.dedServ)
			{
				WorldInfo = new Dictionary<string, object> { ["loaded"] = false };
				return;
			}
			var players = new List<string>();
			for (int i = 0; i < Main.maxPlayers; i++)
			{
				var p = Main.player[i];
				if (p != null && p.active && !string.IsNullOrEmpty(p.name)) players.Add(p.name);
			}
			string uid = "";
			try { uid = Main.ActiveWorldFileData?.UniqueId.ToString() ?? ""; } catch { }
			WorldInfo = new Dictionary<string, object>
			{
				["loaded"] = true,
				["name"] = Main.worldName ?? "",
				["uniqueId"] = uid,
				["worldId"] = Main.worldID,
				["hardmode"] = Main.hardMode,
				["players"] = players,
				["companions"] = BySession.Values.Select(c => c.Name).ToList(),
			};
		}

		// ── Spawn / despawn ───────────────────────────────────────────────
		public static string Spawn(Session session, string name, Appearance look, string ownerName, out Companion spawned)
		{
			spawned = null;
			if (!_worldLoaded) return "NO_WORLD";
			if (Main.netMode == NetmodeID.MultiplayerClient) return "NOT_HOST";
			name = CleanName(name);
			// Re-spawn on a live session (or adopt the body a reconnecting bot left behind).
			var mine = ForSession(session.Id);
			if (mine != null) { spawned = mine; mine.ApplyLook(look); return null; }
			foreach (var kv in BySession.ToList())
			{
				if (!string.Equals(kv.Value.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
				if (kv.Value.Session != null && kv.Value.Session.IsOpen) return "NAME_TAKEN";
				// Adopt: the previous socket closed inside its grace window.
				BySession.Remove(kv.Key);
				kv.Value.Session = session;
				kv.Value.SessionId = session.Id;
				kv.Value.ApplyLook(look);
				BySession[session.Id] = kv.Value;
				spawned = kv.Value;
				return null;
			}
			var bag = TakeStoredBag(name);
			var c = new Companion(session, name, look, ownerName, bag);
			string err = c.CreateBody();
			if (err != null) { StoredBags[name.ToLowerInvariant()] = bag.Items; return err; }
			BySession[session.Id] = c;
			spawned = c;
			RefreshWorldInfo();
			return null;
		}

		public static void Despawn(string sessionId, string reason)
		{
			var c = ForSession(sessionId);
			if (c == null) return;
			BySession.Remove(sessionId);
			StoreBag(c);
			c.RemoveBody();
			c.Session?.SendEvent("despawned", new Dictionary<string, object> { ["reason"] = reason });
			RefreshWorldInfo();
		}

		private static string CleanName(string name)
		{
			name = (name ?? "").Trim();
			if (name.Length == 0) name = "Sei";
			if (name.Length > 24) name = name.Substring(0, 24);
			return name;
		}

		private static void StoreBag(Companion c)
		{
			if (c?.Bag == null) return;
			StoredBags[c.Name.ToLowerInvariant()] = c.Bag.Items;
		}

		private static Bag TakeStoredBag(string name)
		{
			string key = name.ToLowerInvariant();
			if (StoredBags.TryGetValue(key, out var items))
			{
				StoredBags.Remove(key);
				return new Bag(items);
			}
			return new Bag(new List<Item>());
		}

		// ── Persistence ───────────────────────────────────────────────────
		public override void SaveWorldData(TagCompound tag)
		{
			var all = new Dictionary<string, List<Item>>(StoredBags);
			foreach (var c in BySession.Values) all[c.Name.ToLowerInvariant()] = c.Bag.Items;
			var list = new List<TagCompound>();
			foreach (var kv in all)
			{
				var items = kv.Value.Where(i => i != null && !i.IsAir).Select(ItemIO.Save).ToList();
				list.Add(new TagCompound { ["name"] = kv.Key, ["items"] = items });
			}
			if (list.Count > 0) tag["bags"] = list;
		}

		public override void LoadWorldData(TagCompound tag)
		{
			StoredBags.Clear();
			if (!tag.ContainsKey("bags")) return;
			foreach (var t in tag.GetList<TagCompound>("bags"))
			{
				string name = t.GetString("name");
				if (string.IsNullOrEmpty(name)) continue;
				StoredBags[name] = t.GetList<TagCompound>("items").Select(ItemIO.Load).Where(i => i != null && !i.IsAir).ToList();
			}
		}
	}
}
