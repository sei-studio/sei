// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// World edits the verbs share: tool damage against a tile (the game's own
// pickaxe rules), breaking and placing tiles with multiplayer sync, collecting
// the drops she caused, and crafting-station detection. A private Player
// instance stands in where the game's rules are written against a player
// (pickaxe power checks, nearby crafting stations); it is never added to
// Main.player.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Microsoft.Xna.Framework;
using SeiCompanion.Body;
using Terraria;
using Terraria.ID;
using Terraria.ModLoader;
using Terraria.Map;

namespace SeiCompanion.Actions
{
	public static class WorldOps
	{
		private static Player _stand;
		private static MethodInfo _pickDamage;

		/// <summary>The stand-in player, moved to the companion's feet.</summary>
		public static Player StandIn(NPC at)
		{
			_stand ??= new Player();
			_stand.whoAmI = Main.maxPlayers;
			_stand.position = new Vector2(at.Center.X - _stand.width / 2f, at.position.Y + at.height - _stand.height);
			return _stand;
		}

		/// <summary>Damage one pickaxe hit does to the tile (0 = too weak), by the game's own rules.</summary>
		public static int PickDamage(NPC at, int x, int y, int pickPower)
		{
			var p = StandIn(at);
			_pickDamage ??= typeof(Player).GetMethod("GetPickaxeDamage", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
			if (_pickDamage == null) return pickPower; // shape changed: fall back to raw power
			int buf = p.hitTile.HitObject(x, y, 1);
			try { return (int)_pickDamage.Invoke(p, new object[] { x, y, pickPower, buf, Main.tile[x, y] }); }
			catch { return pickPower; }
		}

		public static int AxeDamage(int x, int y, int axePower)
		{
			int d = (int)(axePower * 1.2f);
			if (Main.tile[x, y].TileType == TileID.Cactus) d *= 3;
			return d;
		}

		public static HashSet<int> ActiveItems()
		{
			var s = new HashSet<int>();
			for (int i = 0; i < Main.maxItems; i++) if (Main.item[i].active) s.Add(i);
			return s;
		}

		/// <summary>Move items that appeared since `before` within the box into her bag. Returns what went in.</summary>
		public static List<(int type, int stack)> CollectNew(Companion c, HashSet<int> before, Rectangle box)
		{
			var got = new List<(int, int)>();
			for (int i = 0; i < Main.maxItems; i++)
			{
				var it = Main.item[i];
				if (!it.active || before.Contains(i) || !box.Intersects(it.Hitbox)) continue;
				int type = it.type, had = c.Bag.Count(type);
				if (PickUp(c, i)) got.Add((type, c.Bag.Count(type) - had));
			}
			return got;
		}

		/// <summary>Ground item i into her bag (if it fits).</summary>
		public static bool PickUp(Companion c, int i)
		{
			var it = Main.item[i];
			if (!it.active || it.IsAir) return false;
			var copy = it.Clone();
			int left = c.Bag.Add(copy);
			if (left >= copy.stack) return false;
			if (left > 0) it.stack = left;
			else { it.TurnToAir(); it.active = false; }
			if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.SyncItem, -1, -1, null, i);
			return true;
		}

		/// <summary>One hit's visuals (dust, crack, sound) without breaking.</summary>
		public static void HitEffect(int x, int y)
		{
			WorldGen.KillTile(x, y, fail: true);
			if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.TileManipulation, -1, -1, null, 0, x, y, 1f);
		}

		/// <summary>Break a tile for real (drops spawn as items). Returns false when the game refuses.</summary>
		public static bool Break(int x, int y)
		{
			if (!WorldGen.CanKillTile(x, y)) return false;
			WorldGen.KillTile(x, y);
			if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.TileManipulation, -1, -1, null, 0, x, y);
			return !Main.tile[x, y].HasTile;
		}

		public static bool PlaceTile(int x, int y, Item item)
		{
			if (item.createTile >= 0)
			{
				WorldGen.PlaceTile(x, y, item.createTile, false, false, -1, item.placeStyle);
				// PlaceTile's return value is not reliable for multi-tile objects: check the tile.
				if (!Main.tile[x, y].HasTile || Main.tile[x, y].TileType != item.createTile) return false;
				if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.TileManipulation, -1, -1, null, 1, x, y, item.createTile, item.placeStyle);
				return true;
			}
			if (item.createWall > 0)
			{
				if (Main.tile[x, y].WallType != 0) return false;
				WorldGen.PlaceWall(x, y, item.createWall);
				if (Main.tile[x, y].WallType != item.createWall) return false;
				if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.TileManipulation, -1, -1, null, 3, x, y, item.createWall);
				return true;
			}
			return false;
		}

		/// <summary>Crafting stations (tile types, with the game's equivalences) and liquids within reach of her.</summary>
		public static Player Stations(NPC at)
		{
			var p = StandIn(at);
			p.AdjTiles();
			return p;
		}

		public static string TileName(int x, int y)
		{
			var t = Main.tile[x, y];
			if (!t.HasTile) return "air";
			return TileTypeName(t.TileType, t.TileFrameX, t.TileFrameY);
		}

		public static string TileTypeName(int type, int frameX = 0, int frameY = 0)
		{
			int item = TileItem(type);
			if (item > 0) return ItemNames.Name(item);
			try
			{
				string n = Lang.GetMapObjectName(MapHelper.TileToLookup(type, 0));
				if (!string.IsNullOrEmpty(n)) return n;
			}
			catch { }
			if (TileID.Sets.IsATreeTrunk[type]) return "Tree";
			// The map names are not loaded on a dedicated server: fall back to the
			// internal name, split into words ("VanityTreeSakura" -> "vanity tree sakura").
			if (type < TileID.Count && TileID.Search.TryGetName(type, out string raw))
				return System.Text.RegularExpressions.Regex.Replace(raw, "(?<=[a-z])(?=[A-Z])", " ").ToLowerInvariant();
			if (TileLoader.GetTile(type) is ModTile mt) return mt.Name;
			return $"tile {type}";
		}

		private static Dictionary<int, int> _tileItem;

		/// <summary>The item that places this tile type (copper ore tile -> Copper Ore), or 0.</summary>
		public static int TileItem(int tileType)
		{
			if (_tileItem == null)
			{
				_tileItem = new Dictionary<int, int>();
				foreach (var kv in ContentSamples.ItemsByType.OrderBy(k => k.Key))
					if (kv.Value.createTile >= 0 && !_tileItem.ContainsKey(kv.Value.createTile)) _tileItem[kv.Value.createTile] = kv.Key;
			}
			return _tileItem.TryGetValue(tileType, out int i) ? i : 0;
		}

		/// <summary>Tile type for a block name ("copper ore", "stone", "dirt"), or -1.</summary>
		public static int BlockType(string name)
		{
			int item = ItemNames.Lookup(name);
			if (item > 0 && ContentSamples.ItemsByType.TryGetValue(item, out var it) && it.createTile >= 0) return it.createTile;
			string q = ItemNames.Norm(name);
			if (q == "stone" || q == "rock") return TileID.Stone;
			if (q == "dirt") return TileID.Dirt;
			return -1;
		}
	}
}
