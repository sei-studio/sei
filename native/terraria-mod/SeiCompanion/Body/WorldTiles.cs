// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
// ITileQuery over the live world (Main.tile).

using Terraria;
using Terraria.ID;

namespace SeiCompanion.Body
{
	public sealed class WorldTiles : ITileQuery
	{
		public static readonly WorldTiles Instance = new();

		public bool InWorld(int x, int y) => WorldGen.InWorld(x, y, 10);

		public bool Solid(int x, int y)
		{
			if (!InWorld(x, y)) return true;
			Tile t = Main.tile[x, y];
			if (!t.HasTile || t.IsActuated) return false;
			ushort type = t.TileType;
			if (IsDoorType(type)) return false;
			return Main.tileSolid[type] && !Main.tileSolidTop[type];
		}

		public bool Door(int x, int y)
		{
			if (!InWorld(x, y)) return false;
			Tile t = Main.tile[x, y];
			return t.HasTile && !t.IsActuated && IsDoorType(t.TileType);
		}

		public bool Floor(int x, int y)
		{
			if (!InWorld(x, y)) return false;
			Tile t = Main.tile[x, y];
			if (!t.HasTile || t.IsActuated) return false;
			return Main.tileSolid[t.TileType] || Main.tileSolidTop[t.TileType];
		}

		public bool Platform(int x, int y)
		{
			if (!InWorld(x, y)) return false;
			Tile t = Main.tile[x, y];
			return t.HasTile && !t.IsActuated && TileID.Sets.Platforms[t.TileType];
		}

		public bool Hazard(int x, int y)
		{
			if (!InWorld(x, y)) return true;
			Tile t = Main.tile[x, y];
			if (t.LiquidAmount > 0 && t.LiquidType == LiquidID.Lava) return true;
			return false;
		}

		public static bool IsDoorType(ushort type) => type == TileID.ClosedDoor || type == TileID.TallGateClosed;

		/// <summary>A tile a pickaxe can break here (not air, not a tree, not furniture held up by something).</summary>
		public static bool Mineable(int x, int y)
		{
			if (!WorldGen.InWorld(x, y, 10)) return false;
			Tile t = Main.tile[x, y];
			if (!t.HasTile) return false;
			ushort type = t.TileType;
			if (Main.tileAxe[type] || Main.tileHammer[type]) return false;
			return Main.tileSolid[type] && !Main.tileSolidTop[type] || TileID.Sets.Ore[type] || type == TileID.Pots || type == TileID.ShadowOrbs;
		}

		/// <summary>True if some side of the tile touches a cell the body could be in.</summary>
		public static bool Exposed(int x, int y)
		{
			var q = Instance;
			return !q.Solid(x - 1, y) || !q.Solid(x + 1, y) || !q.Solid(x, y - 1) || !q.Solid(x, y + 1);
		}
	}
}
