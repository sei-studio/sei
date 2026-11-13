// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// The observation the brain reads (pushed once a second, and answered on
// `observe`). Kept small: the adapter turns it into a few short lines, and
// every token here is paid on every turn. Coordinates are tiles; y grows
// downward. #N handles on hostiles are NPC slots (attack / goTo take them).

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using SeiCompanion.Actions;
using SeiCompanion.Body;
using Terraria;
using Terraria.ID;

namespace SeiCompanion.Observe
{
	public static class Observer
	{
		public static Dictionary<string, object> Build(Companion c)
		{
			var me = c.Npc;
			var o = new Dictionary<string, object>();
			if (me == null) { o["self"] = new Dictionary<string, object> { ["name"] = c.Name, ["absent"] = true }; return o; }
			int fx = c.TileX, fy = c.TileY;
			c.OwnerFeet(out var ownerFeet, out string ownerName);
			o["self"] = new Dictionary<string, object>
			{
				["name"] = c.Name,
				["x"] = fx,
				["y"] = fy,
				["hp"] = me.life,
				["maxHp"] = me.lifeMax,
				["defense"] = me.defense,
				["knockedOut"] = c.KnockedTicks > 0 ? c.KnockedTicks / 60 + 1 : 0,
				["stance"] = c.Stance.ToString().ToLowerInvariant(),
				["following"] = c.Following ? (c.FollowName ?? ownerName) : null,
				["job"] = c.Job?.Name,
				["weapon"] = c.Weapon?.AffixName(),
				["armor"] = c.Armor.Where(a => a != null && !a.IsAir).Select(a => a.Name).ToList(),
				["potionCooldown"] = c.PotionCooldown > 0 ? c.PotionCooldown / 60 + 1 : 0,
				["paused"] = c.Paused,
			};
			o["bag"] = c.Bag.Summary(24);
			o["time"] = Clock();
			o["day"] = Main.dayTime;
			o["events"] = WorldEvents();
			o["world"] = new Dictionary<string, object>
			{
				["name"] = Main.worldName,
				["hardmode"] = Main.hardMode,
				["bossesDown"] = BossesDown(),
			};
			o["place"] = Place(c, fy, ownerName);
			o["players"] = Players(me);
			o["hostiles"] = Hostiles(me);
			o["items"] = GroundItems(me);
			o["trees"] = Trees(fx, fy);
			o["ores"] = Ores(fx, fy);
			o["stations"] = Stations(me);
			return o;
		}

		public static string Clock()
		{
			double t = Main.time + (Main.dayTime ? 4.5 * 3600 : 19.5 * 3600);
			int mins = (int)(t / 60) % (24 * 60);
			int h = mins / 60, m = mins % 60;
			string ampm = h >= 12 ? "PM" : "AM";
			int h12 = h % 12 == 0 ? 12 : h % 12;
			return $"{h12}:{m:00} {ampm}";
		}

		public static List<string> WorldEvents()
		{
			var e = new List<string>();
			if (Main.bloodMoon) e.Add("blood moon");
			if (Main.eclipse) e.Add("solar eclipse");
			if (Main.pumpkinMoon) e.Add("pumpkin moon");
			if (Main.snowMoon) e.Add("frost moon");
			if (Main.slimeRain) e.Add("slime rain");
			if (Main.invasionType > 0 && Main.invasionSize > 0) e.Add(InvasionName(Main.invasionType));
			if (Main.raining) e.Add("rain");
			if (Terraria.GameContent.Events.DD2Event.Ongoing) e.Add("old one's army");
			return e;
		}

		public static string InvasionName(int t) => t switch
		{
			InvasionID.GoblinArmy => "goblin army",
			InvasionID.SnowLegion => "frost legion",
			InvasionID.PirateInvasion => "pirate invasion",
			InvasionID.MartianMadness => "martian madness",
			_ => "invasion",
		};

		public static List<string> BossesDown()
		{
			var b = new List<string>();
			if (NPC.downedSlimeKing) b.Add("King Slime");
			if (NPC.downedBoss1) b.Add("Eye of Cthulhu");
			if (NPC.downedBoss2) b.Add(WorldGen.crimson ? "Brain of Cthulhu" : "Eater of Worlds");
			if (NPC.downedQueenBee) b.Add("Queen Bee");
			if (NPC.downedBoss3) b.Add("Skeletron");
			if (NPC.downedDeerclops) b.Add("Deerclops");
			if (Main.hardMode) b.Add("Wall of Flesh");
			if (NPC.downedQueenSlime) b.Add("Queen Slime");
			if (NPC.downedMechBoss1) b.Add("The Destroyer");
			if (NPC.downedMechBoss2) b.Add("The Twins");
			if (NPC.downedMechBoss3) b.Add("Skeletron Prime");
			if (NPC.downedPlantBoss) b.Add("Plantera");
			if (NPC.downedGolemBoss) b.Add("Golem");
			if (NPC.downedFishron) b.Add("Duke Fishron");
			if (NPC.downedEmpressOfLight) b.Add("Empress of Light");
			if (NPC.downedAncientCultist) b.Add("Lunatic Cultist");
			if (NPC.downedMoonlord) b.Add("Moon Lord");
			return b;
		}

		public static string Layer(int y)
		{
			if (y < Main.worldSurface * 0.35) return "space";
			if (y < Main.worldSurface) return "surface";
			if (y < Main.rockLayer) return "underground";
			if (y < Main.UnderworldLayer) return "caverns";
			return "underworld";
		}

		private static Dictionary<string, object> Place(Companion c, int y, string ownerName)
		{
			var d = new Dictionary<string, object>
			{
				["layer"] = Layer(y),
				["depthFt"] = (int)(y * 2 - Main.worldSurface * 2),
			};
			var p = c.Owner;
			if (p != null && c.Npc != null && Vector2.Distance(p.Center, c.Npc.Center) < 60 * 16)
			{
				var biomes = new List<string>();
				if (p.ZoneCorrupt) biomes.Add("corruption");
				if (p.ZoneCrimson) biomes.Add("crimson");
				if (p.ZoneHallow) biomes.Add("hallow");
				if (p.ZoneJungle) biomes.Add("jungle");
				if (p.ZoneSnow) biomes.Add("snow");
				if (p.ZoneDesert) biomes.Add("desert");
				if (p.ZoneBeach) biomes.Add("ocean");
				if (p.ZoneDungeon) biomes.Add("dungeon");
				if (p.ZoneGlowshroom) biomes.Add("glowing mushroom");
				if (p.ZoneMeteor) biomes.Add("meteorite");
				if (p.ZoneGraveyard) biomes.Add("graveyard");
				if (p.ZoneHive) biomes.Add("hive");
				if (p.ZoneLihzhardTemple) biomes.Add("jungle temple");
				if (biomes.Count == 0 && Layer(y) == "surface") biomes.Add("forest");
				d["biomes"] = biomes;
			}
			return d;
		}

		private static List<Dictionary<string, object>> Players(NPC me)
		{
			var list = new List<Dictionary<string, object>>();
			for (int i = 0; i < Main.maxPlayers; i++)
			{
				var p = Main.player[i];
				if (p == null || !p.active) continue;
				var f = Companion.FeetOf(p);
				list.Add(new Dictionary<string, object>
				{
					["name"] = p.name,
					["x"] = f.X,
					["y"] = f.Y,
					["hp"] = p.statLife,
					["maxHp"] = p.statLifeMax2,
					["dist"] = (int)(Vector2.Distance(p.Center, me.Center) / 16f),
					["dead"] = p.dead,
					["holding"] = p.HeldItem != null && !p.HeldItem.IsAir ? p.HeldItem.Name : null,
				});
			}
			return list;
		}

		private static List<Dictionary<string, object>> Hostiles(NPC me)
		{
			var list = new List<(float d, NPC n)>();
			for (int i = 0; i < Main.maxNPCs; i++)
			{
				var n = Main.npc[i];
				if (!n.active || n.friendly || n.lifeMax <= 5 || n.townNPC || n.CountsAsACritter) continue;
				if (n.ModNPC is CompanionNPC) continue;
				float d = Vector2.Distance(n.Center, me.Center);
				bool boss = n.boss || NPCID.Sets.ShouldBeCountedAsBoss[n.type];
				if (d > 45 * 16 && !boss) continue;
				list.Add((d, n));
			}
			return list.OrderBy(t => t.d).Take(8).Select(t => new Dictionary<string, object>
			{
				["id"] = t.n.whoAmI,
				["name"] = t.n.GivenOrTypeName,
				["x"] = (int)(t.n.Center.X / 16),
				["y"] = (int)(t.n.Center.Y / 16),
				["hp"] = t.n.life,
				["maxHp"] = t.n.lifeMax,
				["dist"] = (int)(t.d / 16f),
				["boss"] = t.n.boss || NPCID.Sets.ShouldBeCountedAsBoss[t.n.type],
			}).ToList();
		}

		private static List<Dictionary<string, object>> GroundItems(NPC me)
		{
			var list = new List<(float d, Item it)>();
			for (int i = 0; i < Main.maxItems; i++)
			{
				var it = Main.item[i];
				if (!it.active || it.IsAir) continue;
				float d = Vector2.Distance(it.Center, me.Center);
				if (d <= 20 * 16) list.Add((d, it));
			}
			return list.OrderBy(t => t.d).Take(6).Select(t => new Dictionary<string, object>
			{
				["name"] = t.it.Name,
				["stack"] = t.it.stack,
				["dist"] = (int)(t.d / 16f),
			}).ToList();
		}

		private static List<Dictionary<string, object>> Trees(int fx, int fy)
		{
			var list = new List<(int d, int x, int y)>();
			for (int dx = -30; dx <= 30; dx++)
				for (int dy = -12; dy <= 12; dy++)
				{
					int x = fx + dx, y = fy + dy;
					if (ChopJob.IsTreeBase(x, y)) list.Add((Math.Abs(dx) + Math.Abs(dy), x, y));
				}
			return list.OrderBy(t => t.d).Take(3).Select(t => new Dictionary<string, object> { ["x"] = t.x, ["y"] = t.y, ["dist"] = t.d }).ToList();
		}

		private static List<Dictionary<string, object>> Ores(int fx, int fy)
		{
			// Nearest exposed tile of each ore type within 25 tiles.
			var best = new Dictionary<int, (int d, int x, int y)>();
			for (int dx = -25; dx <= 25; dx++)
				for (int dy = -20; dy <= 20; dy++)
				{
					int x = fx + dx, y = fy + dy;
					if (!WorldGen.InWorld(x, y, 10)) continue;
					var t = Main.tile[x, y];
					if (!t.HasTile || !TileID.Sets.Ore[t.TileType] || !WorldTiles.Exposed(x, y)) continue;
					int d = Math.Abs(dx) + Math.Abs(dy);
					if (!best.TryGetValue(t.TileType, out var b) || d < b.d) best[t.TileType] = (d, x, y);
				}
			return best.OrderBy(kv => kv.Value.d).Take(5).Select(kv => new Dictionary<string, object>
			{
				["name"] = WorldOps.TileTypeName(kv.Key),
				["x"] = kv.Value.x,
				["y"] = kv.Value.y,
				["dist"] = kv.Value.d,
			}).ToList();
		}

		private static readonly int[] StationTypes =
		{
			TileID.WorkBenches, TileID.Furnaces, TileID.Anvils, TileID.MythrilAnvil, TileID.Hellforge, TileID.AdamantiteForge,
			TileID.Tables, TileID.Chairs, TileID.Bottles, TileID.Sawmill, TileID.Loom, TileID.CookingPots, TileID.TinkerersWorkbench,
			TileID.DemonAltar, TileID.ImbuingStation, TileID.Kegs, TileID.HeavyWorkBench, TileID.AlchemyTable, TileID.Solidifier,
		};

		private static List<string> Stations(NPC me)
		{
			var p = WorldOps.Stations(me);
			var list = StationTypes.Where(t => p.adjTile[t]).Select(t => WorldOps.TileTypeName(t)).Distinct().ToList();
			if (p.adjWater) list.Add("water");
			return list;
		}
	}
}
