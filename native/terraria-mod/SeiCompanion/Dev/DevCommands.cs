// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// Developer frames for the headless test harness (scripts/fake + eval). Only
// answered when link.json sets devCommands; the app never does.
//   devState                     server tick counters, clients, headless flag
//   devAnchor {x?, y?}           a point that stands in for the player (none = world spawn surface)
//   devGive {item, count}        put items in her bag
//   devSpawn {npc, dx?, dy?}     spawn an NPC near her (name or id)
//   devDrop {item, count, dx}    drop an item on the ground near her
//   devHp {hp}                   set her health
//   devTake {item}               remove every stack of an item from her bag
//   devTime {day, time}          set the clock (time in ticks)
//   devTeleport {x, y}           move her
//   devTiles {r?}                ASCII map around her (# solid, = platform, D door, ~ water, L lava, T tree, o ore)
//   devFakePlayer / devFakePlayerCheck   fake-player-slot experiment (does a Player in an empty slot survive?)

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Xna.Framework;
using SeiCompanion.Actions;
using SeiCompanion.Body;
using SeiCompanion.Link;
using SeiCompanion.Systems;
using Terraria;
using Terraria.DataStructures;
using Terraria.ID;

namespace SeiCompanion.Dev
{
	public static class DevCommands
	{
		private static int _fakeSlot = -1;
		private static ulong _fakeAt;

		public static void Handle(Session s, Companion c, string id, string type, JsonObject a)
		{
			switch (type)
			{
				case "devState":
					s.SendResult(id, true, "ok", new Dictionary<string, object>
					{
						["ticks"] = SeiSystem.Ticks,
						["hasClients"] = Netplay.HasClients,
						["headless"] = SeiMod.Config?.HeadlessTick ?? false,
						["netMode"] = Main.netMode,
						["spawn"] = new[] { Main.spawnTileX, Main.spawnTileY },
						["surface"] = (int)Main.worldSurface,
						["maxTiles"] = new[] { Main.maxTilesX, Main.maxTilesY },
					});
					return;
				case "devAnchor":
				{
					if (c == null) { s.SendResult(id, false, "not spawned"); return; }
					int x = Json.Int(a, "x", Main.spawnTileX);
					int y = Json.IntOrNull(a, "y") ?? Surface(x);
					if (a.ContainsKey("clear")) { c.DevAnchor = null; s.SendResult(id, true, "anchor cleared"); return; }
					c.DevAnchor = new Vector2(x, y);
					s.SendResult(id, true, $"anchor at ({x},{y})", new Dictionary<string, object> { ["x"] = x, ["y"] = y });
					return;
				}
				case "devGive":
				{
					if (c == null) { s.SendResult(id, false, "not spawned"); return; }
					int t = ResolveItem(a);
					if (t <= 0) { s.SendResult(id, false, "unknown item"); return; }
					int n = Math.Max(1, Json.Int(a, "count", 1));
					int left = c.Bag.Add(t, n);
					c.SyncLook();
					s.SendResult(id, left == 0, $"gave her {ItemNames.Name(t)} x{n - left}");
					return;
				}
				case "devDrop":
				{
					if (c?.Npc == null) { s.SendResult(id, false, "not spawned"); return; }
					int t = ResolveItem(a);
					if (t <= 0) { s.SendResult(id, false, "unknown item"); return; }
					int dx = Json.Int(a, "dx", 3);
					var pos = c.Npc.Center + new Vector2(dx * 16, -16);
					int idx = Item.NewItem(new EntitySource_Misc("SeiDev"), pos, t, Math.Max(1, Json.Int(a, "count", 1)));
					s.SendResult(id, true, $"dropped item #{idx}");
					return;
				}
				case "devSpawn":
				{
					if (c?.Npc == null) { s.SendResult(id, false, "not spawned"); return; }
					string npcName = Json.Str(a, "npc", "Green Slime");
					int ntype = int.TryParse(npcName, out int nt) ? nt : NPCID.Search.TryGetId(npcName.Replace(" ", ""), out int sid) ? sid : NpcByName(npcName);
					if (ntype <= 0) { s.SendResult(id, false, $"unknown npc {npcName}"); return; }
					int dx = Json.Int(a, "dx", 10), dy = Json.Int(a, "dy", 0);
					int px = (int)c.Npc.Center.X + dx * 16, py = (int)c.Npc.Bottom.Y + dy * 16;
					int idx = NPC.NewNPC(new EntitySource_Misc("SeiDev"), px, py, ntype);
					if (idx < Main.maxNPCs && Json.Bool(a, "pin", true)) Main.npc[idx].GetGlobalNPC<DevNPC>().Pinned = true;
					s.SendResult(id, idx < Main.maxNPCs, $"spawned {Main.npc[idx].GivenOrTypeName} #{idx}", new Dictionary<string, object> { ["npc"] = idx });
					return;
				}
				case "devHp":
				{
					if (c?.Npc == null) { s.SendResult(id, false, "not spawned"); return; }
					c.Npc.life = Math.Clamp(Json.Int(a, "hp", c.Npc.lifeMax), 1, c.Npc.lifeMax);
					c.Npc.netUpdate = true;
					s.SendResult(id, true, $"hp {c.Npc.life}/{c.Npc.lifeMax}");
					return;
				}
				case "devTake":
				{
					if (c == null) { s.SendResult(id, false, "not spawned"); return; }
					int t = ResolveItem(a);
					int n = c.Bag.Count(t);
					if (n > 0) c.Bag.Take(t, n);
					s.SendResult(id, true, $"took {n}");
					return;
				}
				case "devTime":
				{
					Main.dayTime = Json.Bool(a, "day", true);
					Main.time = Json.Int(a, "time", 0);
					s.SendResult(id, true, "time set");
					return;
				}
				case "devTeleport":
				{
					if (c?.Npc == null) { s.SendResult(id, false, "not spawned"); return; }
					int x = Json.Int(a, "x"), y = Json.IntOrNull(a, "y") ?? Surface(Json.Int(a, "x"));
					c.TeleportNear(new Point(x, y), "dev");
					s.SendResult(id, true, $"at ({c.TileX},{c.TileY})");
					return;
				}
				case "devTiles":
				{
					if (c?.Npc == null) { s.SendResult(id, false, "not spawned"); return; }
					int r = Math.Clamp(Json.Int(a, "r", 12), 3, 30);
					s.SendResult(id, true, "ok", new Dictionary<string, object> { ["map"] = Map(c, r) });
					return;
				}
				case "devFakePlayer":
				{
					// Evidence for the body choice: put a Player into an empty slot and see
					// whether the server keeps it active on the next ticks.
					int slot = -1;
					for (int i = Main.maxPlayers - 2; i > 0; i--) if (!Main.player[i].active) { slot = i; break; }
					if (slot < 0) { s.SendResult(id, false, "no empty slot"); return; }
					var p = new Player { name = "SeiFake" };
					p.position = new Vector2(Main.spawnTileX * 16, (Main.spawnTileY - 3) * 16);
					p.active = true;
					Main.player[slot] = p;
					p.whoAmI = slot;
					_fakeSlot = slot;
					_fakeAt = SeiSystem.Ticks;
					s.SendResult(id, true, $"fake player in slot {slot}", new Dictionary<string, object> { ["slot"] = slot });
					return;
				}
				case "devFakePlayerCheck":
				{
					if (_fakeSlot < 0) { s.SendResult(id, false, "run devFakePlayer first"); return; }
					var p = Main.player[_fakeSlot];
					bool alive = p.active && p.name == "SeiFake";
					s.SendResult(id, true, alive ? "fake player still active" : "fake player was deactivated", new Dictionary<string, object>
					{
						["slot"] = _fakeSlot,
						["active"] = p.active,
						["ticksSince"] = SeiSystem.Ticks - _fakeAt,
					});
					if (!alive || Json.Bool(a, "cleanup")) { Main.player[_fakeSlot].active = false; _fakeSlot = -1; }
					return;
				}
				default:
					s.SendResult(id, false, $"unknown dev frame {type}");
					return;
			}
		}

		private static int ResolveItem(JsonObject a)
		{
			string item = Json.Str(a, "item");
			if (int.TryParse(item, out int t)) return t;
			return ItemNames.Lookup(item);
		}

		private static int NpcByName(string name)
		{
			string q = ItemNames.Norm(name);
			for (int t = 1; t < NPCID.Count; t++)
			{
				try { if (ItemNames.Norm(Lang.GetNPCNameValue(t)) == q) return t; } catch { }
			}
			return 0;
		}

		/// <summary>Feet row of the first standable spot from the top of column x.</summary>
		public static int Surface(int x)
		{
			var q = WorldTiles.Instance;
			for (int y = 50; y < Main.maxTilesY - 50; y++)
				if (Nav.Standable(q, x, y)) return y;
			return Main.spawnTileY - 1;
		}

		private static List<string> Map(Companion c, int r)
		{
			var q = WorldTiles.Instance;
			int fx = c.TileX, fy = c.TileY;
			var rows = new List<string>();
			for (int y = fy - r; y <= fy + r; y++)
			{
				var sb = new StringBuilder();
				for (int x = fx - r * 2; x <= fx + r * 2; x++)
				{
					char ch = '.';
					if (!q.InWorld(x, y)) ch = ' ';
					else
					{
						var t = Main.tile[x, y];
						if (x == fx && y <= fy && y >= fy - 2) ch = '@';
						else if (q.Door(x, y)) ch = 'D';
						else if (q.Platform(x, y)) ch = '=';
						else if (ChopJob.IsTreeTile(x, y)) ch = 'T';
						else if (t.HasTile && TileID.Sets.Ore[t.TileType]) ch = 'o';
						else if (q.Solid(x, y)) ch = '#';
						else if (t.LiquidAmount > 0) ch = t.LiquidType == LiquidID.Lava ? 'L' : '~';
						if (c.DevAnchor.HasValue && (int)c.DevAnchor.Value.X == x && (int)c.DevAnchor.Value.Y == y) ch = 'A';
					}
					sb.Append(ch);
				}
				rows.Add($"{y,5} {sb}");
			}
			return rows;
		}
	}
}
