// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// Reflexes: combat timing and survival only. The brain decides stance, the
// focus target (attack verb), what to equip and when to drink; the body picks
// the nearest threat inside its stance, swings or shoots on the weapon's own
// timing, and drinks a healing potion when low (if it carries one).
//
// Weapons: melee swings are hitbox checks against her reach; ranged and magic
// weapons fire the projectile the weapon or its ammo names (ammo comes out of
// her bag). Yoyos, flails, spears, boomerangs, whips, summons and channelled
// weapons are refused in v1 (they need a player's projectile AI).

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using Terraria;
using Terraria.DataStructures;
using Terraria.ID;
using Terraria.ModLoader;

namespace SeiCompanion.Body
{
	public enum WeaponKind { None, Melee, Ranged, Magic, Refused }

	public sealed partial class Companion
	{
		public Stance Stance = Stance.Defensive;
		/// <summary>NPC index the brain told her to fight (attack verb), or -1.</summary>
		public int Focus = -1;
		public int Target = -1;
		/// <summary>Bag reference of the weapon the brain equipped, or null = best usable.</summary>
		public Item EquippedWeapon;
		public readonly Item[] Armor = { null, null, null };

		public int PotionCooldown;
		public int AttackCooldown;
		public int SwingTicks;
		public string LastAttackerName;
		private ulong _lastHurtTick;
		private int _pendingDamage;
		private ulong _lastDamagedSent;
		private ulong _lowWarned;
		private int _retarget;
		public int Kills;
		public string LastKill;
		private int _retreat;
		private ulong _lastRetreat;
		/// <summary>Retreat reflex tuning: below this share of max health with a threat close, back off.</summary>
		public float RetreatAt = 0.25f;
		/// <summary>Ticks between retreats, and how long one lasts.</summary>
		public int RetreatEvery = 60 * 10, RetreatTicks = 150;

		public static WeaponKind KindOf(Item i)
		{
			if (i == null || i.IsAir || i.damage <= 0 || i.accessory || i.ammo > 0 || i.useStyle == ItemUseStyleID.None) return WeaponKind.None;
			if (i.createTile >= 0 || i.createWall > 0) return WeaponKind.None;
			if (i.channel) return WeaponKind.Refused;
			if (ItemID.Sets.Yoyo[i.type] || ItemID.Sets.Spears[i.type]) return WeaponKind.Refused;
			if (i.CountsAsClass(DamageClass.Summon) || i.CountsAsClass(DamageClass.SummonMeleeSpeed)) return WeaponKind.Refused;
			if (i.shoot > ProjectileID.None && ProjectileID.Sets.IsAWhip[i.shoot]) return WeaponKind.Refused;
			if (i.CountsAsClass(DamageClass.Melee))
			{
				// 1.4 shortswords stab with a short projectile; she stabs with a hitbox instead.
				if (i.useStyle == ItemUseStyleID.Rapier) return WeaponKind.Melee;
				if (i.noMelee) return WeaponKind.Refused; // flails, boomerangs, spears
				return WeaponKind.Melee;
			}
			if (i.CountsAsClass(DamageClass.Ranged) && (i.shoot > ProjectileID.None || i.useAmmo > 0)) return WeaponKind.Ranged;
			if (i.CountsAsClass(DamageClass.Magic) && i.shoot > ProjectileID.None) return WeaponKind.Magic;
			if (i.CountsAsClass(DamageClass.Throwing) && i.shoot > ProjectileID.None) return WeaponKind.Ranged;
			return WeaponKind.Refused;
		}

		/// <summary>The weapon she fights with: the equipped one while she still has it, else her strongest usable one.</summary>
		public Item Weapon
		{
			get
			{
				if (EquippedWeapon != null && Bag.Items.Contains(EquippedWeapon) && KindOf(EquippedWeapon) is WeaponKind.Melee or WeaponKind.Ranged or WeaponKind.Magic && HasAmmoFor(EquippedWeapon))
					return EquippedWeapon;
				return Bag.Items
					.Where(i => KindOf(i) is WeaponKind.Melee or WeaponKind.Ranged or WeaponKind.Magic && HasAmmoFor(i))
					.OrderByDescending(i => i.pick > 0 || i.axe > 0 || i.hammer > 0 ? i.damage * 0.6f : i.damage)
					.FirstOrDefault();
			}
		}

		public bool HasAmmoFor(Item w) => w.useAmmo <= 0 || Bag.Items.Any(a => a.ammo == w.useAmmo && a.stack > 0);

		public int ArmorDefense() => Armor.Where(a => a != null && !a.IsAir).Sum(a => a.defense);

		// ── Targeting ────────────────────────────────────────────────────
		private bool ValidEnemy(int idx)
		{
			if (idx < 0 || idx >= Main.maxNPCs) return false;
			var n = Main.npc[idx];
			return n.active && n.life > 0 && !n.friendly && n.CanBeChasedBy();
		}

		private int PickTarget(NPC me)
		{
			if (Focus >= 0)
			{
				if (ValidEnemy(Focus)) return Focus;
				Focus = -1;
			}
			if (Stance == Stance.Passive) return -1;
			bool hasOwner = OwnerFeet(out var of, out _);
			Vector2 ownerPx = hasOwner ? new Vector2(of.X * 16 + 8, of.Y * 16) : me.Center;
			float meR = Stance == Stance.Aggressive ? 22 * 16 : 9 * 16;
			float ownR = Stance == Stance.Aggressive ? 14 * 16 : 9 * 16;
			bool recentlyHurt = _ticks - _lastHurtTick < 300;
			int best = -1;
			float bestD = float.MaxValue;
			for (int i = 0; i < Main.maxNPCs; i++)
			{
				if (!ValidEnemy(i)) continue;
				var n = Main.npc[i];
				float d = Vector2.Distance(n.Center, me.Center);
				float dOwner = Vector2.Distance(n.Center, ownerPx);
				bool inRange = d <= meR || dOwner <= ownR || recentlyHurt && d <= 5 * 16;
				if (!inRange) continue;
				// Do not run off after something far from the player while following.
				if (hasOwner && dOwner > 35 * 16) continue;
				if (d > 6 * 16 && !Collision.CanHitLine(me.position, me.width, me.height, n.position, n.width, n.height)) continue;
				if (d < bestD) { bestD = d; best = i; }
			}
			return best;
		}

		/// <summary>Returns true when combat moved the body this tick (the job / follow waits).</summary>
		private bool CombatTick(NPC me)
		{
			if (AttackCooldown > 0) AttackCooldown--;
			if (SwingTicks > 0) SwingTicks--;
			if (_retreat > 0 && RetreatTick(me)) return true;
			if (--_retarget <= 0 || !ValidEnemy(Target))
			{
				_retarget = 10;
				Target = PickTarget(me);
			}
			if (Target < 0) return false;
			var t = Main.npc[Target];
			var w = Weapon;
			var kind = w == null ? WeaponKind.Melee : KindOf(w);
			float d = Vector2.Distance(t.Center, me.Center);

			TryAttack(me, t, w, kind);

			// Movement: jobs that carry the player's intent (come, goTo, give) keep the legs.
			if (Job != null && !Job.YieldsToCombat) return false;
			if (Job != null && Focus < 0 && d > 7 * 16) return false; // self-defence only interrupts a chore up close
			bool melee = kind == WeaponKind.Melee;
			bool los = Collision.CanHitLine(me.position, me.width, me.height, t.position, t.width, t.height);
			float wantDist = melee ? 1.2f * 16 : 14 * 16;
			if (d <= wantDist && los)
			{
				Motor.Stop();
				me.direction = me.spriteDirection = t.Center.X >= me.Center.X ? 1 : -1;
				if (melee) Motor.Steer(me, (t.Center.X - me.Center.X) * 0.5f);
				else Motor.Brake(me);
				// Hop at a target above her.
				if (melee && Motor.OnGround(me) && t.Bottom.Y < me.position.Y && Math.Abs(t.Center.X - me.Center.X) < 40) me.velocity.Y = -Motor.JumpVelocity(2);
				return true;
			}
			// Close in on it (re-planned every half second as it moves).
			int tx = (int)(t.Center.X / 16), ty = (int)((t.position.Y + t.height - 1) / 16);
			if (!Motor.Active || _ticks % 30 == 0)
			{
				int fx = Motor.FeetX(me), fy = Motor.FeetY(me);
				int reach = melee ? 1 : 10;
				var path = Nav.Find(WorldTiles.Instance, fx, fy,
					(x, y) => Math.Abs(x - tx) <= reach && Math.Abs(y - ty) <= (melee ? 2 : 8),
					(x, y) => Math.Abs(x - tx) + Math.Abs(y - ty), out _, 2500);
				if (path != null && path.Count > 0) Motor.SetPath(path);
				else if (melee) Motor.Steer(me, t.Center.X - me.Center.X);
			}
			return true;
		}

		private void TryAttack(NPC me, NPC t, Item w, WeaponKind kind)
		{
			if (AttackCooldown > 0) return;
			int owner = OwnerIndex;
			if (kind == WeaponKind.Melee)
			{
				int reach = w == null ? 20 : w.useStyle == ItemUseStyleID.Rapier ? 40 : (int)(Math.Max(w.width, w.height) * Math.Max(1f, w.scale)) + 6;
				int dir = t.Center.X >= me.Center.X ? 1 : -1;
				var box = new Rectangle(dir > 0 ? (int)me.Center.X : (int)me.Center.X - reach, (int)me.position.Y - 12, reach, me.height + 24);
				if (!box.Intersects(t.Hitbox)) return;
				int dmg = w?.damage ?? 4;
				float kb = w?.knockBack ?? 1f;
				bool crit = Main.rand.Next(100) < (w?.crit ?? 0) + 4;
				Strike(t, dmg, dir, crit, kb, w?.DamageType ?? DamageClass.Melee, owner);
				me.direction = me.spriteDirection = dir;
				int anim = Math.Max(12, w?.useAnimation ?? 20);
				AttackCooldown = anim;
				SwingTicks = anim;
				me.netUpdate = true;
				return;
			}
			if (kind is WeaponKind.Ranged or WeaponKind.Magic && w != null)
			{
				float d = Vector2.Distance(t.Center, me.Center);
				if (d > 32 * 16) return;
				if (!Collision.CanHitLine(me.position, me.width, me.height, t.position, t.width, t.height)) return;
				int projType = w.shoot;
				float speed = Math.Max(6f, w.shootSpeed);
				int dmg = w.damage;
				float kb = w.knockBack;
				if (w.useAmmo > 0)
				{
					var ammo = Bag.Items.FirstOrDefault(a => a.ammo == w.useAmmo && a.stack > 0);
					if (ammo == null) return;
					if (ammo.shoot > ProjectileID.None) projType = ammo.shoot;
					speed += ammo.shootSpeed;
					dmg += ammo.damage;
					kb += ammo.knockBack;
					if (ammo.consumable) Bag.Consume(ammo.type, 1);
				}
				else if (w.consumable)
				{
					Bag.Consume(w.type, 1);
				}
				if (projType <= ProjectileID.None) return;
				Vector2 from = me.Center + new Vector2(0, -6);
				Vector2 aim = t.Center + t.velocity * (Vector2.Distance(from, t.Center) / Math.Max(speed, 1f));
				Vector2 vel = Vector2.Normalize(aim - from) * speed;
				int p = Projectile.NewProjectile(new EntitySource_Misc("SeiCompanion"), from, vel, projType, dmg, kb, Main.netMode == NetmodeID.SinglePlayer ? Main.myPlayer : 255);
				if (p >= 0 && p < Main.maxProjectiles)
				{
					var proj = Main.projectile[p];
					proj.npcProj = true;
					proj.friendly = true;
					proj.hostile = false;
					proj.noDropItem = true;
					proj.GetGlobalProjectile<CompanionShot>().Shooter = me.whoAmI;
					if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.SyncProjectile, -1, -1, null, p);
				}
				t.playerInteraction[owner] = true;
				me.direction = me.spriteDirection = vel.X >= 0 ? 1 : -1;
				int use = Math.Max(10, w.useTime);
				if (kind == WeaponKind.Magic) use = (int)(use * 1.4f); // no mana pool: slower casting instead
				AttackCooldown = use;
				SwingTicks = Math.Max(10, w.useAnimation);
				me.netUpdate = true;
			}
		}

		private void Strike(NPC t, int dmg, int dir, bool crit, float kb, DamageClass cls, int owner)
		{
			if (owner >= 0 && owner < 256) t.playerInteraction[owner] = true;
			bool wasAlive = t.life > 0;
			string name = t.GivenOrTypeName;
			t.SimpleStrikeNPC(dmg, dir, crit, kb, cls, damageVariation: true);
			if (wasAlive && (!t.active || t.life <= 0)) { Kills++; LastKill = name; }
		}

		/// <summary>Low and out of potions with a threat close: back off for a few seconds.</summary>
		private bool RetreatTick(NPC me)
		{
			_retreat--;
			int th = Verbs_NearestThreat(me, 10);
			if (th < 0) { _retreat = 0; return false; }
			var t = Main.npc[th];
			Motor.Stop();
			Motor.Steer(me, me.Center.X >= t.Center.X ? 400f : -400f, forceRun: true);
			if (Motor.OnGround(me) && me.collideX) me.velocity.Y = -Motor.JumpVelocity(2);
			return true;
		}

		private int Verbs_NearestThreat(NPC me, int tiles)
		{
			int best = -1;
			float bd = tiles * 16;
			for (int i = 0; i < Main.maxNPCs; i++)
			{
				if (!ValidEnemy(i)) continue;
				float d = Vector2.Distance(Main.npc[i].Center, me.Center);
				if (d < bd) { bd = d; best = i; }
			}
			return best;
		}

		// ── Survival ─────────────────────────────────────────────────────
		private void SurvivalReflex(NPC me)
		{
			if (PotionCooldown > 0) PotionCooldown--;
			if (me.life >= me.lifeMax * Math.Max(0.4f, RetreatAt)) return;
			if (PotionCooldown <= 0 && me.life < me.lifeMax * 0.4f)
			{
				var pot = Bag.Items.Where(i => i.potion && i.healLife > 0).OrderBy(i => i.healLife).FirstOrDefault(i => i.healLife >= me.lifeMax - me.life)
					?? Bag.Items.Where(i => i.potion && i.healLife > 0).OrderByDescending(i => i.healLife).FirstOrDefault();
				if (pot != null)
				{
					Drink(me, pot);
					Session?.SendEvent("survival", new Dictionary<string, object> { ["kind"] = "healed", ["item"] = pot.Name, ["hp"] = me.life, ["maxHp"] = me.lifeMax });
					return;
				}
			}
			if (me.life < me.lifeMax * RetreatAt && (_lastRetreat == 0 || _ticks - _lastRetreat > (ulong)RetreatEvery) && Verbs_NearestThreat(me, 5) >= 0)
			{
				_lastRetreat = _ticks;
				_retreat = RetreatTicks;
				Session?.SendEvent("survival", new Dictionary<string, object> { ["kind"] = "retreating", ["hp"] = me.life, ["maxHp"] = me.lifeMax });
			}
			if ((_lowWarned == 0 || _ticks - _lowWarned > 60 * 30) && me.life < me.lifeMax * 0.3f)
			{
				_lowWarned = _ticks;
				Session?.SendEvent("survival", new Dictionary<string, object>
				{
					["kind"] = "low_health",
					["hp"] = me.life,
					["maxHp"] = me.lifeMax,
					["potions"] = Bag.Items.Where(i => i.potion && i.healLife > 0).Sum(i => i.stack),
					["cooldown"] = PotionCooldown / 60,
				});
			}
		}

		/// <summary>Drink a healing item from her bag (the reflex and the use verb).</summary>
		public int Drink(NPC me, Item pot)
		{
			int type = pot.type, heal = pot.healLife;
			if (!Bag.Consume(type, 1)) return 0;
			int before = me.life;
			me.life = Math.Min(me.lifeMax, me.life + heal);
			int gained = me.life - before;
			me.HealEffect(gained, true);
			PotionCooldown = 60 * 60;
			me.netUpdate = true;
			_lastLife = me.life;
			return gained;
		}

		private void OnDamaged(NPC me, int amount)
		{
			_lastHurtTick = _ticks;
			string by = NearestHostileName(me);
			if (by != null) LastAttackerName = by;
			_pendingDamage += amount;
			if (_ticks - _lastDamagedSent < 90) return;
			_lastDamagedSent = _ticks;
			Session?.SendEvent("damaged", new Dictionary<string, object>
			{
				["by"] = by ?? "something",
				["amount"] = _pendingDamage,
				["hp"] = me.life,
				["maxHp"] = me.lifeMax,
			});
			_pendingDamage = 0;
		}

		private static string NearestHostileName(NPC me)
		{
			string best = null;
			float bd = 6 * 16;
			for (int i = 0; i < Main.maxNPCs; i++)
			{
				var n = Main.npc[i];
				if (!n.active || n.friendly || n.lifeMax <= 1) continue;
				float d = Vector2.Distance(n.Center, me.Center);
				if (d < bd) { bd = d; best = n.GivenOrTypeName; }
			}
			if (best != null) return best;
			for (int i = 0; i < Main.maxProjectiles; i++)
			{
				var p = Main.projectile[i];
				if (!p.active || !p.hostile) continue;
				float d = Vector2.Distance(p.Center, me.Center);
				if (d < 4 * 16) return Lang.GetProjectileName(p.type).Value;
			}
			return null;
		}
	}
}
