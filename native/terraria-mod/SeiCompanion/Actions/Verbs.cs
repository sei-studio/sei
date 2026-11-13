// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// The verbs the brain may call (`cmd` frames). Names and arguments match
// src/bot/adapter/terraria/registry.js. Quick verbs answer at once; the rest
// become a Job. Every answer is one plain line the brain reads as the tool
// result, and every failure says why.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using Microsoft.Xna.Framework;
using SeiCompanion.Body;
using SeiCompanion.Link;
using Terraria;
using Terraria.DataStructures;
using Terraria.ID;

namespace SeiCompanion.Actions
{
	public static class Verbs
	{
		public static readonly string[] Names =
		{
			"follow", "unfollow", "come", "stance", "attack", "give", "take",
			"goTo", "mine", "place", "chop", "use", "equip", "craft",
		};

		public static int? Handle(JsonObject a, string key = "target")
		{
			string s = Json.Str(a, key);
			if (string.IsNullOrWhiteSpace(s)) return null;
			s = s.Trim().TrimStart('#');
			return int.TryParse(s, out int v) ? v : null;
		}

		private static string PlayerList()
		{
			var names = Main.player.Take(Main.maxPlayers).Where(p => p != null && p.active).Select(p => p.name).ToList();
			return names.Count == 0 ? "no players are in the world" : "players here: " + string.Join(", ", names);
		}

		/// <summary>Returns an error line, or null. job == null and no error = answered inline.</summary>
		public static string Create(Companion c, string cmdId, string name, JsonObject a, out Job job)
		{
			job = null;
			void Answer(bool ok, string detail) => c.Session?.SendResult(cmdId, ok, detail);
			switch (name)
			{
				case "follow":
				{
					string who = Json.Str(a, "player");
					Player p = null;
					if (!string.IsNullOrWhiteSpace(who))
					{
						p = Companion.FindPlayer(who);
						if (p == null) return $"no player named {who}; {PlayerList()}";
					}
					c.Cancel(null, "superseded by follow");
					c.Following = true;
					c.FollowName = p?.name;
					c.OwnerFeet(out _, out string label);
					Answer(true, $"following {p?.name ?? label ?? "you"}");
					return null;
				}
				case "unfollow":
				{
					c.Cancel(null, "superseded by unfollow");
					c.Following = false;
					c.Motor.Stop();
					Answer(true, $"staying here at ({c.TileX},{c.TileY})");
					return null;
				}
				case "stance":
				{
					string mode = (Json.Str(a, "mode") ?? "").ToLowerInvariant();
					switch (mode)
					{
						case "aggressive": c.Stance = Stance.Aggressive; break;
						case "defensive": c.Stance = Stance.Defensive; break;
						case "passive": c.Stance = Stance.Passive; c.Focus = -1; break;
						default: return "mode must be aggressive, defensive or passive";
					}
					Answer(true, mode switch
					{
						"aggressive" => "stance aggressive: I attack anything hostile within about 20 tiles",
						"passive" => "stance passive: I do not fight unless you tell me to attack something",
						_ => "stance defensive: I fight what comes close to you or me",
					});
					return null;
				}
				case "equip":
				{
					string itemName = Json.Str(a, "item");
					var it = c.Bag.FindByName(itemName);
					if (it == null) return $"I have no {itemName}; my bag: {BagLine(c)}";
					return Equip(c, it, Answer);
				}
				case "use":
				{
					string itemName = Json.Str(a, "item");
					var it = c.Bag.FindByName(itemName);
					if (it == null) return $"I have no {itemName}; my bag: {BagLine(c)}";
					var npc = c.Npc;
					if (it.healLife > 0)
					{
						if (it.potion && c.PotionCooldown > 0) return $"potion sickness: I can drink another in {c.PotionCooldown / 60 + 1}s";
						if (npc.life >= npc.lifeMax) return $"I am already at full health ({npc.life}/{npc.lifeMax})";
						int gained = c.Drink(npc, it);
						Answer(true, $"used {it.Name}: +{gained} health, now {npc.life}/{npc.lifeMax}");
						return null;
					}
					if (it.createTile >= 0 || it.createWall > 0) return $"{it.Name} is placed, not used; use place with x and y";
					if (Companion.KindOf(it) != WeaponKind.None) return $"{it.Name} is a weapon; equip it and I fight with it";
					return $"I can only use healing items for now, not {it.Name}";
				}
				case "come":
				{
					string who = Json.Str(a, "player");
					if (!string.IsNullOrWhiteSpace(who) && Companion.FindPlayer(who) == null) return $"no player named {who}; {PlayerList()}";
					if (!c.OwnerFeet(out _, out _) && string.IsNullOrWhiteSpace(who)) return "no player to come to";
					job = new ComeJob(who);
					return null;
				}
				case "goTo":
				{
					int? h = Handle(a);
					string who = Json.Str(a, "player");
					int? x = Json.IntOrNull(a, "x"), y = Json.IntOrNull(a, "y");
					if (h != null)
					{
						if (h < 0 || h >= Main.maxNPCs || !Main.npc[h.Value].active) return $"#{h} is not here any more";
						job = new GoToJob(npcIndex: h.Value);
						return null;
					}
					if (!string.IsNullOrWhiteSpace(who))
					{
						if (Companion.FindPlayer(who) == null) return $"no player named {who}; {PlayerList()}";
						job = new ComeJob(who);
						return null;
					}
					if (x == null || y == null) return "give x and y, a #N target, or a player";
					if (!WorldGen.InWorld(x.Value, y.Value, 20)) return $"({x},{y}) is outside the world";
					job = new GoToJob(x.Value, y.Value);
					return null;
				}
				case "attack":
				{
					int? h = Handle(a);
					int target = h ?? NearestHostile(c, 25);
					if (target < 0) return "nothing hostile is nearby";
					var n = Main.npc[target];
					if (!n.active || n.friendly || !n.CanBeChasedBy()) return $"#{target} is not something I can fight";
					if (Companion.KindOf(c.Weapon) == WeaponKind.None && c.Weapon == null && n.lifeMax > 200)
						return $"I have no weapon; {n.GivenOrTypeName} is too strong for my fists";
					job = new AttackJob(target);
					return null;
				}
				case "give":
				{
					string itemName = Json.Str(a, "item");
					var it = c.Bag.FindByName(itemName);
					if (it == null) return $"I have no {itemName}; my bag: {BagLine(c)}";
					int have = c.Bag.Count(it.type);
					int count = Json.Int(a, "count", have);
					count = Math.Clamp(count, 1, have);
					string who = Json.Str(a, "player");
					if (!string.IsNullOrWhiteSpace(who) && Companion.FindPlayer(who) == null) return $"no player named {who}; {PlayerList()}";
					if (!c.OwnerFeet(out _, out _) && string.IsNullOrWhiteSpace(who)) return "no player to give it to";
					job = new GiveJob(it.type, count, who);
					return null;
				}
				case "take":
				{
					string itemName = Json.Str(a, "item");
					int type = 0;
					if (!string.IsNullOrWhiteSpace(itemName))
					{
						type = ItemNames.Lookup(itemName);
						if (type <= 0) return $"I do not know an item called {itemName}";
					}
					job = new TakeJob(type, Json.Int(a, "count", 999));
					return null;
				}
				case "mine":
				{
					var pick = c.Bag.BestPickaxe();
					if (pick == null) return "I have no pickaxe; give me one and I can mine";
					string block = Json.Str(a, "block");
					int? x = Json.IntOrNull(a, "x"), y = Json.IntOrNull(a, "y");
					if (x != null && y != null)
					{
						int w = Math.Clamp(Json.Int(a, "width", 1), 1, 12), hgt = Math.Clamp(Json.Int(a, "height", 1), 1, 12);
						if (w * hgt > 40) return "an area is at most 40 tiles";
						job = new MineJob(x.Value, y.Value, w, hgt);
						return null;
					}
					if (string.IsNullOrWhiteSpace(block)) return "give x and y (and width/height for an area), or a block name";
					int tile = WorldOps.BlockType(block);
					bool anyOre = ItemNames.Norm(block) is "ore" or "ores" or "any ore";
					if (tile < 0 && !anyOre) return $"I do not know a block called {block}";
					job = new MineJob(tile, anyOre, Math.Clamp(Json.Int(a, "count", 5), 1, 30));
					return null;
				}
				case "chop":
				{
					if (c.Bag.BestAxe() == null) return "I have no axe; give me one and I can chop trees";
					int? x = Json.IntOrNull(a, "x"), y = Json.IntOrNull(a, "y");
					job = new ChopJob(x, y, Math.Clamp(Json.Int(a, "count", 1), 1, 10));
					return null;
				}
				case "place":
				{
					string itemName = Json.Str(a, "item");
					var it = c.Bag.FindByName(itemName);
					if (it == null) return $"I have no {itemName}; my bag: {BagLine(c)}";
					if (it.createTile < 0 && it.createWall <= 0) return $"{it.Name} cannot be placed";
					int? x = Json.IntOrNull(a, "x"), y = Json.IntOrNull(a, "y");
					if (x == null || y == null) return "give x and y";
					int w = Math.Clamp(Json.Int(a, "width", 1), 1, 30), hgt = Math.Clamp(Json.Int(a, "height", 1), 1, 30);
					if (w * hgt > 30) return "at most 30 tiles per call";
					job = new PlaceJob(it.type, x.Value, y.Value, w, hgt);
					return null;
				}
				case "craft":
				{
					string itemName = Json.Str(a, "item");
					int type = ItemNames.Lookup(itemName);
					if (type <= 0) return $"I do not know an item called {itemName}";
					job = new CraftJob(type, Math.Clamp(Json.Int(a, "count", 1), 1, 250));
					return null;
				}
				default:
					return $"unknown action {name}";
			}
		}

		public static string BagLine(Companion c)
		{
			var s = c.Bag.Summary(12);
			return s.Count == 0 ? "empty" : string.Join(", ", s);
		}

		private static string Equip(Companion c, Item it, Action<bool, string> answer)
		{
			string slot = null;
			if (it.headSlot >= 0) { c.Armor[0] = it; slot = "head"; }
			else if (it.bodySlot >= 0) { c.Armor[1] = it; slot = "body"; }
			else if (it.legSlot >= 0) { c.Armor[2] = it; slot = "legs"; }
			if (slot != null)
			{
				c.SyncLook();
				answer(true, $"wearing {it.Name} ({slot}); defense now {2 + c.ArmorDefense()}");
				return null;
			}
			if (it.accessory) return "accessories are not supported yet";
			switch (Companion.KindOf(it))
			{
				case WeaponKind.Melee:
				case WeaponKind.Ranged:
				case WeaponKind.Magic:
					if (!c.HasAmmoFor(it)) return $"{it.Name} needs ammo I do not have";
					c.EquippedWeapon = it;
					c.SyncLook();
					answer(true, $"fighting with {it.AffixName()} ({it.damage} damage)");
					return null;
				case WeaponKind.Refused:
					return $"I cannot fight with {it.Name} yet (I can use swords, bows, guns and magic weapons that shoot)";
				default:
					return $"{it.Name} is not something I can equip";
			}
		}

		public static int NearestHostile(Companion c, int tiles)
		{
			var me = c.Npc;
			int best = -1;
			float bd = tiles * 16;
			for (int i = 0; i < Main.maxNPCs; i++)
			{
				var n = Main.npc[i];
				if (!n.active || n.friendly || !n.CanBeChasedBy()) continue;
				float d = Vector2.Distance(n.Center, me.Center);
				if (d < bd) { bd = d; best = i; }
			}
			return best;
		}
	}

	// ── Walking ─────────────────────────────────────────────────────────
	public sealed class ComeJob : Job
	{
		private readonly string _who;
		private Point _target;
		private bool _begun;
		public ComeJob(string who) { _who = who; }
		public override bool YieldsToCombat => false;
		protected override int TimeoutTicks => 60 * 60;

		private bool Where(Companion c, out Point feet, out string label)
		{
			if (!string.IsNullOrWhiteSpace(_who))
			{
				var p = Companion.FindPlayer(_who);
				if (p != null && !p.dead) { feet = Companion.FeetOf(p); label = p.name; return true; }
				feet = default; label = _who;
				return false;
			}
			return c.OwnerFeet(out feet, out label);
		}

		public override JobResult? Start(Companion c) => Step(c);

		protected override JobResult? Step(Companion c)
		{
			if (!Where(c, out var feet, out string label)) return Fail($"{label ?? "the player"} is not here");
			int fx = c.TileX, fy = c.TileY;
			if (Math.Abs(fx - feet.X) <= 2 && Math.Abs(fy - feet.Y) <= 2 && Motor.OnGround(c.Npc)) return Ok($"came to {label}");
			if (Math.Abs(fx - feet.X) > 120 || Math.Abs(fy - feet.Y) > 80)
			{
				c.TeleportNear(feet, "come: far");
				return Ok($"came to {label} (warped: they were {Math.Abs(fx - feet.X)} tiles away)");
			}
			if (!_begun || Math.Abs(_target.X - feet.X) > 3 || Math.Abs(_target.Y - feet.Y) > 3)
			{
				_begun = true;
				_target = feet;
				var t = feet;
				c.Walker.Begin((x, y) => Math.Abs(x - t.X) <= 2 && Math.Abs(y - t.Y) <= 2, (x, y) => Math.Abs(x - t.X) + Math.Abs(y - t.Y));
			}
			var st = c.Walker.Tick(c);
			if (st == Walker.St.Failed)
			{
				c.TeleportNear(feet, "come: no path");
				return Ok($"came to {label} (warped: {c.Walker.Fail})");
			}
			return null;
		}
	}

	public sealed class GoToJob : Job
	{
		private readonly int _x, _y, _npc = -1;
		public GoToJob(int x, int y) { _x = x; _y = y; }
		public GoToJob(int npcIndex) { _npc = npcIndex; }
		public override bool YieldsToCombat => false;
		protected override int TimeoutTicks => 60 * 75;
		private Point _target;

		public override JobResult? Start(Companion c)
		{
			Begin(c);
			return null;
		}

		private bool Begin(Companion c)
		{
			Point t;
			if (_npc >= 0)
			{
				var n = Main.npc[_npc];
				if (!n.active) return false;
				t = new Point((int)(n.Center.X / 16), (int)((n.position.Y + n.height - 1) / 16));
			}
			else t = new Point(_x, _y);
			_target = t;
			int tol = _npc >= 0 ? 2 : 1;
			c.Walker.Begin((x, y) => Math.Abs(x - t.X) <= tol && Math.Abs(y - t.Y) <= 2, (x, y) => Math.Abs(x - t.X) + Math.Abs(y - t.Y), 8000);
			return true;
		}

		protected override JobResult? Step(Companion c)
		{
			if (_npc >= 0 && Ticks % 45 == 0)
			{
				if (!Main.npc[_npc].active) return Fail($"#{_npc} left; stopped at ({c.TileX},{c.TileY})");
				var n = Main.npc[_npc];
				var now = new Point((int)(n.Center.X / 16), (int)((n.position.Y + n.height - 1) / 16));
				if (Math.Abs(now.X - _target.X) > 3 || Math.Abs(now.Y - _target.Y) > 3) Begin(c);
			}
			var st = c.Walker.Tick(c);
			if (st == Walker.St.Arrived) return Ok($"arrived at ({c.TileX},{c.TileY})");
			if (st == Walker.St.Failed) return Fail($"{c.Walker.Fail}; stopped at ({c.TileX},{c.TileY})");
			return null;
		}

		protected override JobResult? Timeout(Companion c) => Fail($"still walking after {TimeoutTicks / 60}s; stopped at ({c.TileX},{c.TileY})");
	}

	// ── Fighting ────────────────────────────────────────────────────────
	public sealed class AttackJob : Job
	{
		private readonly int _target;
		private string _name;
		private int _kills;
		private int _lastHp;
		private int _sinceHit;
		public AttackJob(int target) { _target = target; }
		protected override int TimeoutTicks => 60 * 45;

		public override JobResult? Start(Companion c)
		{
			var n = Main.npc[_target];
			_name = n.GivenOrTypeName;
			_kills = c.Kills;
			_lastHp = n.life;
			c.Focus = _target;
			c.Progress($"fighting {_name}");
			return null;
		}

		protected override JobResult? Step(Companion c)
		{
			var n = Main.npc[_target];
			bool sameOne = n.active && n.GivenOrTypeName == _name;
			if (!sameOne || n.life <= 0)
			{
				c.Focus = -1;
				if (c.Kills > _kills) return Ok($"defeated {_name}");
				return Ok($"{_name} is gone (despawned or someone else finished it)");
			}
			if (n.life < _lastHp) { _lastHp = n.life; _sinceHit = 0; }
			else if (++_sinceHit > 60 * 20)
			{
				c.Focus = -1;
				return Fail($"could not land a hit on {_name} for 20s (it is at {n.life}/{n.lifeMax})");
			}
			return null;
		}

		protected override JobResult? Timeout(Companion c)
		{
			c.Focus = -1;
			var n = Main.npc[_target];
			return Fail($"{_name} is still up after {TimeoutTicks / 60}s ({n.life}/{n.lifeMax})");
		}

		public override void Abort(Companion c, string reason) { c.Focus = -1; }
	}

	// ── Items ───────────────────────────────────────────────────────────
	public sealed class GiveJob : Job
	{
		private readonly int _type, _count;
		private readonly string _who;
		private readonly ComeJob _walk;
		public GiveJob(int type, int count, string who) { _type = type; _count = count; _who = who; _walk = new ComeJob(who); }
		public override bool YieldsToCombat => false;

		public override JobResult? Start(Companion c) => Step(c);

		protected override JobResult? Step(Companion c)
		{
			var r = _walk.Tick(c);
			if (r == null) return null;
			if (!r.Value.Ok) return Fail(r.Value.Detail);
			// Arrived (or warped). Drop the stack at their feet.
			Rectangle at;
			string label;
			var p = !string.IsNullOrWhiteSpace(_who) ? Companion.FindPlayer(_who) : c.Owner;
			if (p != null) { at = p.Hitbox; label = p.name; }
			else if (c.DevAnchor.HasValue) { at = new Rectangle((int)c.DevAnchor.Value.X * 16, (int)c.DevAnchor.Value.Y * 16 - 32, 16, 48); label = "anchor"; }
			else return Fail("nobody to give it to");
			var items = c.Bag.Take(_type, _count);
			int n = items.Sum(i => i.stack);
			if (n == 0) return Fail($"I no longer have any {ItemNames.Name(_type)}");
			foreach (var it in items)
				Item.NewItem(new EntitySource_Misc("SeiCompanion"), at, it, noBroadcast: false, noGrabDelay: true);
			return Ok($"gave {ItemNames.Name(_type)} x{n} to {label}");
		}
	}

	public sealed class TakeJob : Job
	{
		private readonly int _type, _count;
		private int _got;
		private readonly Dictionary<int, int> _gotBy = new();
		private int _current = -1;
		private int _fails;
		public const int Radius = 20;
		public TakeJob(int type, int count) { _type = type; _count = count; }
		protected override int TimeoutTicks => 60 * 45;

		public override JobResult? Start(Companion c)
		{
			if (Next(c) < 0) return Fail(_type > 0 ? $"no {ItemNames.Name(_type)} on the ground within {Radius} tiles" : $"nothing on the ground within {Radius} tiles");
			return null;
		}

		private int Next(Companion c)
		{
			var me = c.Npc;
			int best = -1;
			float bd = Radius * 16;
			for (int i = 0; i < Main.maxItems; i++)
			{
				var it = Main.item[i];
				if (!it.active || it.IsAir || _type > 0 && it.type != _type) continue;
				float d = Vector2.Distance(it.Center, me.Center);
				if (d < bd) { bd = d; best = i; }
			}
			_current = best;
			if (best >= 0)
			{
				int tx = (int)(Main.item[best].Center.X / 16), ty = (int)(Main.item[best].Center.Y / 16);
				c.Walker.Begin((x, y) => Math.Abs(x - tx) <= 1 && y >= ty - 1 && y <= ty + 2, (x, y) => Math.Abs(x - tx) + Math.Abs(y - ty), 4000);
			}
			return best;
		}

		private string Summary() => string.Join(", ", _gotBy.Select(kv => $"{ItemNames.Name(kv.Key)} x{kv.Value}"));

		protected override JobResult? Step(Companion c)
		{
			var me = c.Npc;
			// Grab everything matching in arm's reach.
			for (int i = 0; i < Main.maxItems && _got < _count; i++)
			{
				var it = Main.item[i];
				if (!it.active || it.IsAir || _type > 0 && it.type != _type) continue;
				if (Vector2.Distance(it.Center, me.Center) > 2.5f * 16) continue;
				int type = it.type, before = c.Bag.Count(type);
				if (WorldOps.PickUp(c, i))
				{
					int n = c.Bag.Count(type) - before;
					_got += n;
					_gotBy[type] = _gotBy.GetValueOrDefault(type) + n;
				}
				else return _got > 0 ? Ok($"picked up {Summary()}; my bag is full") : Fail("my bag is full");
			}
			if (_got >= _count) return Ok($"picked up {Summary()}");
			if (_current < 0 || !Main.item[_current].active)
			{
				if (Next(c) < 0) return _got > 0 ? Ok($"picked up {Summary()}") : Fail("the items are gone");
			}
			var st = c.Walker.Tick(c);
			if (st == Walker.St.Failed)
			{
				if (++_fails >= 3) return _got > 0 ? Ok($"picked up {Summary()}; could not reach the rest") : Fail($"could not reach the items ({c.Walker.Fail})");
				Next(c);
			}
			return null;
		}
	}

	// ── World edits ─────────────────────────────────────────────────────
	public sealed class MineJob : Job
	{
		private readonly int _tile = -1;
		private readonly bool _anyOre;
		private readonly int _count;
		private readonly Queue<Point> _area;
		private readonly HashSet<long> _skip = new();
		private Point? _cur;
		private int _damage;
		private int _cool;
		private int _mined;
		private int _tooHard;
		private string _tooHardName;
		private int _unreachable;
		private int _unreachableInARow;
		private readonly Dictionary<int, int> _got = new();
		private bool _walking;
		protected override int TimeoutTicks => 60 * 120;

		public MineJob(int x, int y, int w, int h)
		{
			_area = new Queue<Point>();
			for (int yy = y; yy < y + h; yy++)
				for (int xx = x; xx < x + w; xx++) _area.Enqueue(new Point(xx, yy));
			_count = w * h;
		}

		public MineJob(int tile, bool anyOre, int count)
		{
			_tile = tile;
			_anyOre = anyOre;
			_count = count;
		}

		private bool Matches(int x, int y)
		{
			if (!WorldTiles.Mineable(x, y)) return false;
			ushort t = Main.tile[x, y].TileType;
			if (_anyOre) return TileID.Sets.Ore[t];
			if (t == _tile) return true;
			// Grass is dirt (or mud) with grass on top and drops the block.
			if (_tile == TileID.Dirt) return t is TileID.Grass or TileID.CorruptGrass or TileID.CrimsonGrass or TileID.HallowedGrass;
			if (_tile == TileID.Mud) return t is TileID.JungleGrass or TileID.MushroomGrass;
			return false;
		}

		private Point? NextTarget(Companion c)
		{
			if (_area != null)
			{
				while (_area.Count > 0)
				{
					var p = _area.Dequeue();
					if (WorldTiles.Mineable(p.X, p.Y)) return p;
				}
				return null;
			}
			int fx = c.TileX, fy = c.TileY;
			Point? best = null;
			int bd = int.MaxValue;
			for (int dy = -30; dy <= 30; dy++)
				for (int dx = -35; dx <= 35; dx++)
				{
					int x = fx + dx, y = fy + dy;
					if (_skip.Contains(((long)x << 32) | (uint)y)) continue;
					if (!WorldGen.InWorld(x, y, 20) || !Matches(x, y) || !WorldTiles.Exposed(x, y)) continue;
					int d = Math.Abs(dx) + Math.Abs(dy) * 2;
					if (d < bd) { bd = d; best = new Point(x, y); }
				}
			return best;
		}

		private static bool InReach(int fx, int fy, Point t) => Math.Abs(fx - t.X) <= 3 && t.Y >= fy - 5 && t.Y <= fy + 2;

		public override JobResult? Start(Companion c)
		{
			if (!Pick(c)) return Fail("I have no pickaxe any more");
			return Advance(c) ?? null;
		}

		private bool Pick(Companion c) => c.Bag.BestPickaxe() != null;

		private JobResult? Advance(Companion c)
		{
			_cur = NextTarget(c);
			_damage = 0;
			_walking = false;
			if (_cur == null) return Done(c, _mined == 0 ? (_area != null ? "nothing mineable in that area" : $"no exposed {(_anyOre ? "ore" : WorldOps.TileTypeName(_tile))} within 35 tiles. To dig into the ground, give an area (x, y, width, height)") : null);
			var t = _cur.Value;
			if (!InReach(c.TileX, c.TileY, t))
			{
				_walking = true;
				c.Walker.Begin((x, y) => InReach(x, y, t) && !(x == t.X && y >= t.Y - 2 && y <= t.Y),
					(x, y) => Math.Abs(x - t.X) + Math.Abs(y - t.Y), 5000);
			}
			return null;
		}

		private JobResult Done(Companion c, string emptyReason)
		{
			string got = string.Join(", ", _got.Select(kv => $"{ItemNames.Name(kv.Key)} x{kv.Value}"));
			var parts = new List<string>();
			if (_mined > 0) parts.Add($"mined {_mined} block{(_mined == 1 ? "" : "s")}" + (got.Length > 0 ? $" (got {got})" : ""));
			if (_tooHard > 0) parts.Add($"{_tooHard} too hard for my pickaxe ({_tooHardName})");
			if (_unreachable > 0) parts.Add($"{_unreachable} out of reach");
			if (_mined == 0)
			{
				if (emptyReason != null) parts.Insert(0, emptyReason);
				return Fail(string.Join("; ", parts));
			}
			return Ok(string.Join("; ", parts));
		}

		protected override JobResult? Step(Companion c)
		{
			if (_mined >= _count) return Done(c, null);
			if (_cur == null) return Done(c, null);
			var t = _cur.Value;
			if (!WorldTiles.Mineable(t.X, t.Y) || _area == null && !Matches(t.X, t.Y)) return Advance(c);
			if (_walking)
			{
				var st = c.Walker.Tick(c);
				if (st == Walker.St.Running) return null;
				if (st == Walker.St.Failed)
				{
					_unreachable++;
					_skip.Add(((long)t.X << 32) | (uint)t.Y);
					if (++_unreachableInARow >= 3) return Done(c, $"could not reach any ({c.Walker.Fail})");
					return Advance(c);
				}
				_walking = false;
			}
			if (!InReach(c.TileX, c.TileY, t)) { _walking = false; return Advance(c); }
			var me = c.Npc;
			me.direction = me.spriteDirection = t.X * 16 + 8 >= me.Center.X ? 1 : -1;
			if (_cool > 0) { _cool--; return null; }
			var pick = c.Bag.BestPickaxe();
			if (pick == null) return Done(c, "I have no pickaxe any more");
			_cool = Math.Max(6, pick.useTime);
			c.SwingTicks = Math.Max(10, pick.useAnimation);
			int dmg = WorldOps.PickDamage(me, t.X, t.Y, pick.pick);
			if (dmg <= 0)
			{
				_tooHard++;
				_tooHardName = WorldOps.TileName(t.X, t.Y);
				_skip.Add(((long)t.X << 32) | (uint)t.Y);
				return Advance(c);
			}
			_damage += dmg;
			if (_damage < 100) { WorldOps.HitEffect(t.X, t.Y); return null; }
			var before = WorldOps.ActiveItems();
			if (!WorldOps.Break(t.X, t.Y))
			{
				_unreachable++;
				_skip.Add(((long)t.X << 32) | (uint)t.Y);
				return Advance(c);
			}
			_mined++;
			_unreachableInARow = 0;
			foreach (var (type, stack) in WorldOps.CollectNew(c, before, new Rectangle(t.X * 16 - 48, t.Y * 16 - 48, 112, 112)))
				_got[type] = _got.GetValueOrDefault(type) + stack;
			c.Progress($"mined {_mined}/{_count}");
			return Advance(c);
		}

		protected override JobResult? Timeout(Companion c) => Done(c, "ran out of time");
	}

	public sealed class ChopJob : Job
	{
		private readonly int? _x, _y;
		private readonly int _count;
		private Point? _cur;
		private int _damage, _cool, _chopped, _fails;
		private bool _walking;
		private readonly HashSet<long> _skip = new();
		private readonly Dictionary<int, int> _got = new();
		protected override int TimeoutTicks => 60 * 120;

		public ChopJob(int? x, int? y, int count) { _x = x; _y = y; _count = count; }

		public static bool IsTreeTile(int x, int y)
		{
			if (!WorldGen.InWorld(x, y, 10)) return false;
			var t = Main.tile[x, y];
			if (!t.HasTile) return false;
			int ty = t.TileType;
			return TileID.Sets.IsATreeTrunk[ty] || ty == TileID.Trees || ty == TileID.PalmTree || ty == TileID.Cactus || ty == TileID.MushroomTrees;
		}

		/// <summary>The bottom trunk tile of a tree (trunk above it, ground below), so one break fells the whole tree.</summary>
		public static bool IsTreeBase(int x, int y)
		{
			if (!IsTreeTile(x, y) || !IsTreeTile(x, y - 1)) return false;
			var below = Main.tile[x, y + 1];
			return below.HasTile && !IsTreeTile(x, y + 1) && (Main.tileSolid[below.TileType] || Main.tileSolidTop[below.TileType]);
		}

		private Point? FindBase(Companion c)
		{
			if (_x != null && _y != null && _chopped == 0)
			{
				int x = _x.Value, y = _y.Value;
				for (int k = 0; k < 40 && IsTreeTile(x, y); k++)
				{
					if (IsTreeBase(x, y)) return new Point(x, y);
					y++;
				}
				return null;
			}
			int fx = c.TileX, fy = c.TileY;
			Point? best = null;
			int bd = int.MaxValue;
			for (int dx = -30; dx <= 30; dx++)
				for (int dy = -12; dy <= 12; dy++)
				{
					int x = fx + dx, y = fy + dy;
					if (_skip.Contains(((long)x << 32) | (uint)y) || !IsTreeBase(x, y)) continue;
					int d = Math.Abs(dx) + Math.Abs(dy) * 2;
					if (d < bd) { bd = d; best = new Point(x, y); }
				}
			return best;
		}

		public override JobResult? Start(Companion c)
		{
			_cur = FindBase(c);
			if (_cur == null) return Fail(_x != null ? $"there is no tree at ({_x},{_y})" : "no tree within 30 tiles");
			BeginWalk(c);
			return null;
		}

		private void BeginWalk(Companion c)
		{
			var t = _cur.Value;
			_damage = 0;
			_walking = true;
			c.Walker.Begin((x, y) => Math.Abs(x - t.X) <= 2 && Math.Abs(y - t.Y) <= 1, (x, y) => Math.Abs(x - t.X) + Math.Abs(y - t.Y), 5000);
		}

		private string Got() => string.Join(", ", _got.Select(kv => $"{ItemNames.Name(kv.Key)} x{kv.Value}"));

		private JobResult? Next(Companion c)
		{
			if (_chopped >= _count) return Ok($"chopped {_chopped} tree{(_chopped == 1 ? "" : "s")}" + (_got.Count > 0 ? $" (got {Got()})" : ""));
			_cur = FindBase(c);
			if (_cur == null)
				return _chopped > 0 ? Ok($"chopped {_chopped} (no more trees nearby; got {Got()})") : Fail("no tree within 30 tiles");
			BeginWalk(c);
			return null;
		}

		protected override JobResult? Step(Companion c)
		{
			var t = _cur.Value;
			if (!IsTreeTile(t.X, t.Y)) return Next(c);
			if (_walking)
			{
				var st = c.Walker.Tick(c);
				if (st == Walker.St.Running) return null;
				if (st == Walker.St.Failed)
				{
					_skip.Add(((long)t.X << 32) | (uint)t.Y);
					if (++_fails >= 3) return _chopped > 0 ? Ok($"chopped {_chopped}; could not reach more trees (got {Got()})") : Fail($"could not reach a tree ({c.Walker.Fail})");
					return Next(c);
				}
				_walking = false;
			}
			var me = c.Npc;
			me.direction = me.spriteDirection = t.X * 16 + 8 >= me.Center.X ? 1 : -1;
			if (_cool > 0) { _cool--; return null; }
			var axe = c.Bag.BestAxe();
			if (axe == null) return Fail("I have no axe any more");
			_cool = Math.Max(8, axe.useTime);
			c.SwingTicks = Math.Max(10, axe.useAnimation);
			_damage += WorldOps.AxeDamage(t.X, t.Y, axe.axe);
			if (_damage < 100) { WorldOps.HitEffect(t.X, t.Y); return null; }
			var before = WorldOps.ActiveItems();
			WorldOps.Break(t.X, t.Y);
			_chopped++;
			foreach (var (type, stack) in WorldOps.CollectNew(c, before, new Rectangle(t.X * 16 - 8 * 16, t.Y * 16 - 40 * 16, 17 * 16, 43 * 16)))
				_got[type] = _got.GetValueOrDefault(type) + stack;
			c.Progress($"chopped {_chopped}/{_count}");
			return Next(c);
		}
	}

	public sealed class PlaceJob : Job
	{
		private readonly int _type;
		private readonly Queue<Point> _tiles = new();
		private Point? _cur;
		private bool _walking;
		private int _placed, _failed;
		private string _lastWhy;
		private int _cool;
		protected override int TimeoutTicks => 60 * 60;

		public PlaceJob(int type, int x, int y, int w, int h)
		{
			_type = type;
			// Bottom row first so blocks have something to sit on.
			for (int yy = y + h - 1; yy >= y; yy--)
				for (int xx = x; xx < x + w; xx++) _tiles.Enqueue(new Point(xx, yy));
		}

		private static bool InReach(int fx, int fy, Point t) => Math.Abs(fx - t.X) <= 4 && t.Y >= fy - 5 && t.Y <= fy + 3;

		public override JobResult? Start(Companion c) => NextTile(c);

		private JobResult? NextTile(Companion c)
		{
			if (_tiles.Count == 0) return Finish();
			_cur = _tiles.Dequeue();
			var t = _cur.Value;
			if (!InReach(c.TileX, c.TileY, t))
			{
				_walking = true;
				c.Walker.Begin((x, y) => InReach(x, y, t) && !(Math.Abs(x - t.X) <= 0 && y - 2 <= t.Y && t.Y <= y + 1),
					(x, y) => Math.Abs(x - t.X) + Math.Abs(y - t.Y), 5000);
			}
			return null;
		}

		private JobResult Finish()
		{
			string name = ItemNames.Name(_type);
			if (_placed == 0) return Fail($"placed nothing: {_lastWhy ?? "no room"}");
			return Ok($"placed {_placed} {name}" + (_failed > 0 ? $"; {_failed} could not go there ({_lastWhy})" : ""));
		}

		protected override JobResult? Step(Companion c)
		{
			if (_cur == null) return Finish();
			var t = _cur.Value;
			if (_walking)
			{
				var st = c.Walker.Tick(c);
				if (st == Walker.St.Running) return null;
				_walking = false;
				if (st == Walker.St.Failed) { _failed++; _lastWhy = "out of reach"; return NextTile(c); }
			}
			if (_cool > 0) { _cool--; return null; }
			var it = c.Bag.Find(i => i.type == _type);
			if (it == null) { _lastWhy = $"ran out of {ItemNames.Name(_type)}"; _failed += _tiles.Count + 1; _tiles.Clear(); return Finish(); }
			string why = CanPlaceHere(c, t, it);
			if (why == null && WorldOps.PlaceTile(t.X, t.Y, it))
			{
				c.Bag.Consume(_type, 1);
				_placed++;
				c.SwingTicks = 12;
				_cool = Math.Max(4, it.useTime / 2);
			}
			else { _failed++; _lastWhy = why ?? "the game refused (needs something to attach to)"; }
			return NextTile(c);
		}

		private static string CanPlaceHere(Companion c, Point t, Item it)
		{
			if (!WorldGen.InWorld(t.X, t.Y, 10)) return "outside the world";
			var tile = Main.tile[t.X, t.Y];
			if (it.createTile >= 0)
			{
				if (tile.HasTile && !Main.tileCut[tile.TileType]) return $"({t.X},{t.Y}) is taken by {WorldOps.TileName(t.X, t.Y)}";
				if (Main.tileSolid[it.createTile] && !Main.tileSolidTop[it.createTile])
				{
					var r = new Rectangle(t.X * 16, t.Y * 16, 16, 16);
					if (c.Npc.Hitbox.Intersects(r)) return "I am standing there";
					for (int i = 0; i < Main.maxPlayers; i++)
						if (Main.player[i].active && !Main.player[i].dead && Main.player[i].Hitbox.Intersects(r)) return $"{Main.player[i].name} is standing there";
				}
				return null;
			}
			if (tile.WallType != 0) return "there is a wall there already";
			return null;
		}
	}

	public sealed class CraftJob : Job
	{
		private readonly int _type, _want;
		private int _times;
		private Recipe _recipe;
		private bool _walking;
		protected override int TimeoutTicks => 60 * 45;
		/// <param name="want">How many of the item she should end up making (a recipe can make several at once).</param>
		public CraftJob(int type, int want) { _type = type; _want = want; }

		private int TimesFor(Recipe r) => Math.Max(1, (_want + Math.Max(1, r.createItem.stack) - 1) / Math.Max(1, r.createItem.stack));

		public override JobResult? Start(Companion c)
		{
			var recipes = Enumerable.Range(0, Recipe.numRecipes).Select(i => Main.recipe[i]).Where(r => r != null && r.createItem.type == _type && !r.Disabled).ToList();
			string name = ItemNames.Name(_type);
			if (recipes.Count == 0) return Fail($"{name} cannot be crafted");
			string lastMissing = null;
			foreach (var r in recipes)
			{
				string cond = ConditionProblem(r);
				if (cond != null) { lastMissing = cond; continue; }
				string miss = MissingIngredients(c, r, TimesFor(r));
				if (miss != null) { lastMissing = $"missing {miss}"; continue; }
				_recipe = r;
				_times = TimesFor(r);
				break;
			}
			if (_recipe == null) return Fail($"cannot craft {name}: {lastMissing}");
			var st = MissingStations(c, _recipe);
			if (st.Count == 0) return Craft(c);
			// Walk to the nearest station of the first missing kind.
			var spot = FindStation(c, st[0]);
			if (spot == null) return Fail($"cannot craft {name}: needs a {WorldOps.TileTypeName(st[0])} and there is none within 40 tiles");
			var s = spot.Value;
			_walking = true;
			c.Walker.Begin((x, y) => Math.Abs(x - s.X) <= 2 && Math.Abs(y - s.Y) <= 2, (x, y) => Math.Abs(x - s.X) + Math.Abs(y - s.Y), 5000);
			c.Progress($"walking to the {WorldOps.TileTypeName(st[0])}");
			return null;
		}

		protected override JobResult? Step(Companion c)
		{
			if (!_walking) return Craft(c);
			var st = c.Walker.Tick(c);
			if (st == Walker.St.Running) return null;
			if (st == Walker.St.Failed) return Fail($"could not reach the crafting station ({c.Walker.Fail})");
			_walking = false;
			return Craft(c);
		}

		private JobResult Craft(Companion c)
		{
			string name = ItemNames.Name(_type);
			var miss = MissingStations(c, _recipe);
			if (miss.Count > 0) return Fail($"cannot craft {name}: needs {string.Join(", ", miss.Select(t => WorldOps.TileTypeName(t)))} nearby");
			string liquid = MissingLiquid(c, _recipe);
			if (liquid != null) return Fail($"cannot craft {name}: I have to stand next to {liquid}");
			string missing = MissingIngredients(c, _recipe, _times);
			if (missing != null) return Fail($"cannot craft {name}: missing {missing}");
			int made = 0;
			for (int k = 0; k < _times; k++)
			{
				foreach (var req in _recipe.requiredItem)
				{
					int need = req.stack;
					foreach (int t in Acceptable(_recipe, req.type).OrderBy(t => t == req.type ? 0 : 1))
					{
						if (need <= 0) break;
						int have = c.Bag.Count(t);
						int take = Math.Min(have, need);
						if (take > 0) { c.Bag.Take(t, take); need -= take; }
					}
				}
				var it = new Item();
				it.SetDefaults(_recipe.createItem.type);
				it.stack = _recipe.createItem.stack;
				it.Prefix(-1);
				c.Bag.Add(it);
				made += it.stack;
			}
			return Ok($"crafted {name} x{made}");
		}

		private static string ConditionProblem(Recipe r)
		{
			foreach (var cond in r.Conditions)
			{
				if (cond == Condition.NearWater || cond == Condition.NearLava || cond == Condition.NearHoney) continue;
				return $"needs a special condition ({cond.Description.Value})";
			}
			return null;
		}

		public static IEnumerable<int> Acceptable(Recipe r, int type)
		{
			yield return type;
			foreach (int g in r.acceptedGroups)
			{
				if (!RecipeGroup.recipeGroups.TryGetValue(g, out var group) || !group.ContainsItem(type)) continue;
				foreach (int t in group.ValidItems) if (t != type) yield return t;
			}
		}

		private static string MissingIngredients(Companion c, Recipe r, int times)
		{
			var missing = new List<string>();
			foreach (var req in r.requiredItem)
			{
				int need = req.stack * times;
				int have = Acceptable(r, req.type).Distinct().Sum(t => c.Bag.Count(t));
				if (have < need) missing.Add($"{req.Name} {have}/{need}");
			}
			return missing.Count == 0 ? null : string.Join(", ", missing);
		}

		private static List<int> MissingStations(Companion c, Recipe r)
		{
			var p = WorldOps.Stations(c.Npc);
			return r.requiredTile.Where(t => t >= 0 && !p.adjTile[t]).ToList();
		}

		/// <summary>Water, lava or honey the recipe needs next to her, or null. She does not go looking for it.</summary>
		private static string MissingLiquid(Companion c, Recipe r)
		{
			var p = WorldOps.Stations(c.Npc);
			foreach (var cond in r.Conditions)
			{
				if (cond == Condition.NearWater && !p.adjWater) return "water";
				if (cond == Condition.NearLava && !p.adjLava) return "lava";
				if (cond == Condition.NearHoney && !p.adjHoney) return "honey";
			}
			return null;
		}

		private static Point? FindStation(Companion c, int tileType)
		{
			int fx = c.TileX, fy = c.TileY;
			Point? best = null;
			int bd = int.MaxValue;
			for (int dx = -40; dx <= 40; dx++)
				for (int dy = -25; dy <= 25; dy++)
				{
					int x = fx + dx, y = fy + dy;
					if (!WorldGen.InWorld(x, y, 10)) continue;
					var t = Main.tile[x, y];
					if (!t.HasTile) continue;
					if (!StationCounts(t.TileType, tileType)) continue;
					int d = Math.Abs(dx) + Math.Abs(dy);
					if (d < bd) { bd = d; best = new Point(x, y); }
				}
			return best;
		}

		private static bool StationCounts(int have, int want)
		{
			if (have == want) return true;
			switch (want)
			{
				// Player.AdjTiles' equivalences (tile ids as in vanilla).
				case 17: return have is 77 or 302 or 133;
				case 77: return have == 133;
				case 16: return have == 134;
				case 14: return have is 354 or 469 or 487 or 355;
				case 13: return have == 355;
				default: return false;
			}
		}
	}
}
