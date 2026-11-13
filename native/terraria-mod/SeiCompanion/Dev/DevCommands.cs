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
//   devChat {from, text, dist?}  a chat line from a pretend player, sent to every session
//   devFill {x0, x1, y0, y1}     put dirt in every empty tile of the box (undo a test's digging)
//   devClear                     remove every hostile NPC (between test runs)
//   devStrip                     take off her armor and weapon (they are not put in the bag)
//   devKillTile {x, y, x1?, y1?, keep?}  remove a tile or a box, no drop (undo a test's placing)
//   devTree {x}                  grow a tree on the surface at x (replace what tests chopped)
//   devReflex {retreatAt?, retreatEvery?, retreatTicks?}   retreat-reflex tuning for A/B runs
// Any frame may carry {companion: name} to act on another session's companion,
// so a driver connection can steer the body a real bot session spawned.

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
			string target = Json.Str(a, "companion");
			if (!string.IsNullOrEmpty(target))
				c = SeiSystem.All.FirstOrDefault(x => string.Equals(x.Name, target, StringComparison.OrdinalIgnoreCase));
			switch (type)
			{
				case "devFill":
				{
					int x0 = Math.Clamp(Json.Int(a, "x0"), 1, Main.maxTilesX - 2), x1 = Math.Clamp(Json.Int(a, "x1"), x0, Math.Min(x0 + 80, Main.maxTilesX - 2));
					int y0 = Math.Clamp(Json.Int(a, "y0"), 1, Main.maxTilesY - 2), y1 = Math.Clamp(Json.Int(a, "y1"), y0, Math.Min(y0 + 40, Main.maxTilesY - 2));
					int n = 0;
					for (int x = x0; x <= x1; x++)
						for (int y = y0; y <= y1; y++)
							if (!Main.tile[x, y].HasTile && WorldGen.PlaceTile(x, y, TileID.Dirt, mute: true, forced: true)) n++;
					if (n > 0 && Main.netMode == NetmodeID.Server) NetMessage.SendTileSquare(-1, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
					s.SendResult(id, true, $"filled {n}");
					return;
				}
				case "devClear":
				{
					int n = 0;
					for (int i = 0; i < Main.maxNPCs; i++)
					{
						var npc = Main.npc[i];
						if (!npc.active || npc.friendly || npc.townNPC || SeiSystem.ForNpc(i) != null) continue;
						npc.active = false;
						if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.SyncNPC, -1, -1, null, i);
						n++;
					}
					s.SendResult(id, true, $"cleared {n}");
					return;
				}
				case "devKillTile":
				{
					// One tile, or a box up to (x1, y1); keep:"trees" leaves tree tiles alone.
					int x0 = Json.Int(a, "x"), y0 = Json.Int(a, "y");
					int x1 = Math.Min(Json.Int(a, "x1", x0), x0 + 60), y1 = Math.Min(Json.Int(a, "y1", y0), y0 + 30);
					bool keepTrees = Json.Str(a, "keep") == "trees";
					if (x0 < 1 || y0 < 1 || x1 >= Main.maxTilesX - 1 || y1 >= Main.maxTilesY - 1) { s.SendResult(id, false, "out of the world"); return; }
					int n = 0;
					for (int x = x0; x <= x1; x++)
						for (int y = y0; y <= y1; y++)
						{
							var t = Main.tile[x, y];
							if (!t.HasTile || keepTrees && (t.TileType == TileID.Trees || t.TileType == TileID.Saplings)) continue;
							WorldGen.KillTile(x, y, noItem: true);
							n++;
						}
					if (n > 0 && Main.netMode == NetmodeID.Server) NetMessage.SendTileSquare(-1, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
					s.SendResult(id, true, $"removed {n}");
					return;
				}
				case "devTree":
				{
					int x = Math.Clamp(Json.Int(a, "x", Main.spawnTileX), 10, Main.maxTilesX - 10);
					int y = Surface(x);
					if (Main.tile[x, y].HasTile && TileID.Sets.IsATreeTrunk[Main.tile[x, y].TileType]) { s.SendResult(id, true, "a tree is already there"); return; }
					var below = Main.tile[x, y + 1];
					if (!below.HasTile) { s.SendResult(id, false, "no ground"); return; }
					below.TileType = TileID.Grass;
					bool ok = false;
					for (int i = 0; i < 20 && !ok; i++)
					{
						if (!Main.tile[x, y].HasTile) WorldGen.PlaceTile(x, y, TileID.Saplings, mute: true, forced: true);
						ok = WorldGen.GrowTree(x, y);
					}
					if (!ok)
					{
						// GrowTree refused (it is picky about space and walls): stand up a plain trunk.
						if (Main.tile[x, y].HasTile && Main.tile[x, y].TileType == TileID.Saplings) WorldGen.KillTile(x, y, noItem: true);
						for (int k = 0; k < 8; k++)
						{
							var t = Main.tile[x, y - k];
							if (t.HasTile) break;
							t.HasTile = true;
							t.TileType = TileID.Trees;
							t.TileFrameX = 0;
							t.TileFrameY = (short)(22 * (k % 3));
							ok = true;
						}
					}
					if (Main.netMode == NetmodeID.Server) NetMessage.SendTileSquare(-1, x - 2, y - 30, 5, 32);
					s.SendResult(id, ok, ok ? $"tree at ({x},{y})" : $"the tree did not grow (ground {Main.tile[x, y + 1].TileType}, here {(Main.tile[x, y].HasTile ? Main.tile[x, y].TileType : -1)})");
					return;
				}
				case "devStrip":
				{
					if (c == null) { s.SendResult(id, false, "not spawned"); return; }
					for (int i = 0; i < c.Armor.Length; i++) c.Armor[i] = null;
					c.EquippedWeapon = null;
					if (c.Npc != null) c.Npc.netUpdate = true;
					s.SendResult(id, true, "stripped");
					return;
				}
				case "devReflex":
				{
					if (c == null) { s.SendResult(id, false, "not spawned"); return; }
					if (a.ContainsKey("retreatAt")) c.RetreatAt = Math.Clamp(Json.Int(a, "retreatAt", 25), 0, 90) / 100f;
					c.RetreatEvery = Math.Clamp(Json.Int(a, "retreatEvery", c.RetreatEvery), 30, 60 * 60);
					c.RetreatTicks = Math.Clamp(Json.Int(a, "retreatTicks", c.RetreatTicks), 30, 60 * 30);
					s.SendResult(id, true, $"retreat below {(int)(c.RetreatAt * 100)}% for {c.RetreatTicks} ticks, every {c.RetreatEvery}");
					return;
				}
				case "devChat":
				{
					string text = Json.Str(a, "text");
					if (string.IsNullOrWhiteSpace(text)) { s.SendResult(id, false, "missing text"); return; }
					var fields = new Dictionary<string, object> { ["from"] = Json.Str(a, "from") ?? "Ouen", ["text"] = text.Trim(), ["kind"] = "player" };
					int? dist = Json.IntOrNull(a, "dist");
					if (dist.HasValue) fields["dist"] = dist.Value;
					SeiMod.Bridge?.Broadcast("chat", fields);
					s.SendResult(id, true, "sent");
					return;
				}
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
					if (Json.Bool(a, "clearCooldown", false)) c.PotionCooldown = 0;
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
