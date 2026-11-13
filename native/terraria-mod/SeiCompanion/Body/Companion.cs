// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// One companion: the server-side state behind one NPC body. Runs on the
// authority (single player, or the server); multiplayer clients only draw.
// Tick order each frame (from CompanionNPC.AI): knocked-out timer, survival
// reflex, combat target + swing, then the current job or background follow,
// then the motor.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using Microsoft.Xna.Framework;
using SeiCompanion.Actions;
using SeiCompanion.Link;
using Terraria;
using Terraria.Chat;
using Terraria.DataStructures;
using Terraria.ID;
using Terraria.Localization;
using Terraria.ModLoader;

namespace SeiCompanion.Body
{
	public enum Stance { Aggressive, Defensive, Passive }

	public sealed partial class Companion
	{
		public Session Session;
		public string SessionId;
		public readonly string Name;
		public Appearance Look;
		public readonly string OwnerName;
		public readonly Bag Bag;

		public int NpcIndex = -1;
		public NPC Npc => NpcIndex >= 0 && NpcIndex < Main.maxNPCs && Main.npc[NpcIndex].active && Main.npc[NpcIndex].ModNPC is CompanionNPC ? Main.npc[NpcIndex] : null;

		public readonly Motor Motor = new();
		public readonly Walker Walker = new();
		public Job Job;
		public bool Paused;

		/// <summary>Background follow (the follow verb) and who.</summary>
		public bool Following;
		public string FollowName;

		/// <summary>Dev harness: a point that stands in for the owner when no player is in the world.</summary>
		public Vector2? DevAnchor;

		public int KnockedTicks;
		public int Knockouts;
		private int _lastLife = -1;
		private ulong _ticks;
		private int _followReplan;
		private int _followFails;
		private Point _followTarget;

		public Companion(Session session, string name, Appearance look, string ownerName, Bag bag)
		{
			Session = session;
			SessionId = session?.Id;
			Name = name;
			Look = look ?? new Appearance();
			OwnerName = ownerName;
			Bag = bag;
			Following = true; // a companion arrives at your side and keeps up until told otherwise
		}

		public int TileX => Npc == null ? -1 : Motor.FeetX(Npc);
		public int TileY => Npc == null ? -1 : Motor.FeetY(Npc);

		public Dictionary<string, object> Identity() => new()
		{
			["name"] = Name,
			["npc"] = NpcIndex,
			["x"] = TileX,
			["y"] = TileY,
			["hp"] = Npc?.life ?? 0,
			["maxHp"] = Npc?.lifeMax ?? 0,
			["role"] = Systems.SeiSystem.Role(),
		};

		// ── Owner / players ──────────────────────────────────────────────
		public static Player FindPlayer(string name)
		{
			if (string.IsNullOrWhiteSpace(name)) return null;
			string q = name.Trim();
			for (int i = 0; i < Main.maxPlayers; i++)
			{
				var p = Main.player[i];
				if (p != null && p.active && string.Equals(p.name, q, StringComparison.OrdinalIgnoreCase)) return p;
			}
			for (int i = 0; i < Main.maxPlayers; i++)
			{
				var p = Main.player[i];
				if (p != null && p.active && p.name != null && p.name.StartsWith(q, StringComparison.OrdinalIgnoreCase)) return p;
			}
			return null;
		}

		/// <summary>The player this companion is with: the follow target, the owner the app named, or the first player.</summary>
		public Player Owner
		{
			get
			{
				if (Main.netMode == NetmodeID.SinglePlayer)
					return Main.LocalPlayer != null && Main.LocalPlayer.active ? Main.LocalPlayer : null;
				return FindPlayer(FollowName) ?? FindPlayer(OwnerName) ?? Main.player.Take(Main.maxPlayers).FirstOrDefault(p => p != null && p.active);
			}
		}

		public static Point FeetOf(Player p) => new((int)(p.Center.X / 16f), (int)((p.position.Y + p.height - 1) / 16f));

		/// <summary>Where "the player" is: the owner's feet, or the dev anchor in a headless test.</summary>
		public bool OwnerFeet(out Point feet, out string who)
		{
			var o = Owner;
			if (o != null && !o.dead) { feet = FeetOf(o); who = o.name; return true; }
			if (DevAnchor.HasValue) { feet = new Point((int)DevAnchor.Value.X, (int)DevAnchor.Value.Y); who = "anchor"; return true; }
			feet = default; who = null;
			return false;
		}

		public int OwnerIndex => Owner?.whoAmI ?? (Main.netMode == NetmodeID.SinglePlayer ? Main.myPlayer : 0);

		// ── Body ──────────────────────────────────────────────────────────
		public string CreateBody()
		{
			Point near;
			if (!OwnerFeet(out near, out _)) near = new Point(Main.spawnTileX, Main.spawnTileY - 1);
			var spot = FindStandableNear(near, 3, 10) ?? FindStandableNear(near, 0, 25) ?? near;
			int px = spot.X * 16 + 8, py = (spot.Y + 1) * 16;
			int idx = NPC.NewNPC(new EntitySource_Misc("SeiCompanion"), px, py, ModContent.NPCType<CompanionNPC>());
			if (idx < 0 || idx >= Main.maxNPCs) return "NO_SLOT";
			NpcIndex = idx;
			var npc = Main.npc[idx];
			npc.GivenName = Name;
			if (npc.ModNPC is CompanionNPC m) { m.Look = Look; m.CName = Name; m.Sync(this); }
			npc.netUpdate = true;
			_lastLife = npc.life;
			return null;
		}

		public void RemoveBody()
		{
			Job?.Abort(this, "despawned");
			Job = null;
			Motor.Stop();
			var npc = Npc;
			if (npc != null)
			{
				npc.active = false;
				npc.life = 0;
				if (Main.netMode == NetmodeID.Server)
					NetMessage.SendData(MessageID.SyncNPC, -1, -1, null, npc.whoAmI);
			}
			NpcIndex = -1;
		}

		/// <summary>Push name, look, armour and held weapon to the body (drawn by clients).</summary>
		public void SyncLook()
		{
			if (Npc?.ModNPC is CompanionNPC m) { m.Sync(this); Npc.netUpdate = true; }
		}

		public void ApplyLook(Appearance look)
		{
			if (look == null) return;
			Look = look;
			if (Npc?.ModNPC is CompanionNPC m) { m.Look = look; m.Sync(this); Npc.netUpdate = true; }
		}

		/// <summary>A standable tile near `around`, at least minDist columns away when possible, behind the player first.</summary>
		public static Point? FindStandableNear(Point around, int minDist, int radius)
		{
			var q = WorldTiles.Instance;
			for (int r = minDist; r <= radius; r++)
			{
				foreach (int dir in new[] { -1, 1 })
				{
					int x = around.X + dir * r;
					for (int dy = 0; dy <= 6; dy++)
					{
						foreach (int y in new[] { around.Y - dy, around.Y + dy })
							if (Nav.Standable(q, x, y)) return new Point(x, y);
					}
				}
			}
			return null;
		}

		public void TeleportNear(Point feet, string why)
		{
			var npc = Npc;
			if (npc == null) return;
			var spot = FindStandableNear(feet, 2, 8) ?? FindStandableNear(feet, 0, 20);
			if (spot == null) return;
			npc.position = new Vector2(spot.Value.X * 16 + 8 - npc.width / 2f, (spot.Value.Y + 1) * 16 - npc.height);
			npc.velocity = Vector2.Zero;
			npc.netUpdate = true;
			Motor.Stop();
			SeiMod.Log?.Debug($"[Sei] {Name} caught up by teleport ({why})");
		}

		// ── Bridge-facing ────────────────────────────────────────────────
		public void Say(string text)
		{
			text = (text ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
			if (text.Length == 0) return;
			if (text.Length > 300) text = text.Substring(0, 300);
			ChatHelper.BroadcastChatMessage(NetworkText.FromLiteral($"<{Name}> {text}"), new Color(150, 200, 255));
			// Other companions in the world hear it as chat too.
			foreach (var s in SeiMod.Bridge?.Sessions() ?? new List<Session>())
			{
				if (s.Id == SessionId) continue;
				s.SendEvent("chat", new Dictionary<string, object> { ["from"] = Name, ["text"] = text, ["kind"] = "companion" });
			}
		}

		public void SetPaused(bool paused)
		{
			Paused = paused;
			if (paused)
			{
				Job?.Abort(this, "paused");
				FinishJob(false, "paused");
				Motor.Stop();
			}
		}

		public void Cancel(string target, string reason)
		{
			if (Job == null) return;
			if (!string.IsNullOrEmpty(target) && target != Job.CmdId && target != Job.Name) return;
			Job.Abort(this, reason);
			FinishJob(false, reason);
			Motor.Stop();
		}

		public void RunCommand(string cmdId, string name, JsonObject args)
		{
			if (Npc == null) { Session?.SendResult(cmdId, false, "my body is not in the world right now"); return; }
			if (Paused) { Session?.SendResult(cmdId, false, "paused: the player paused the game"); return; }
			if (KnockedTicks > 0) { Session?.SendResult(cmdId, false, $"knocked out: back on my feet in {KnockedTicks / 60 + 1}s"); return; }
			Job job;
			string err = Verbs.Create(this, cmdId, name, args, out job);
			if (err != null) { Session?.SendResult(cmdId, false, err); return; }
			if (job == null) return; // answered inline
			job.CmdId = cmdId;
			job.Name = name;
			if (Job != null)
			{
				Job.Abort(this, "superseded");
				Session?.SendResult(Job.CmdId, false, $"superseded by {name}");
			}
			Motor.Stop();
			Walker.Reset();
			Job = job;
			var first = job.Start(this);
			if (first != null) FinishJob(first.Value.Ok, first.Value.Detail);
		}

		public void FinishJob(bool ok, string detail)
		{
			var j = Job;
			Job = null;
			Motor.Stop();
			Walker.Reset();
			if (j != null) Session?.SendResult(j.CmdId, ok, detail);
		}

		public void Progress(string text)
		{
			if (Job != null) Session?.SendProgress(Job.CmdId, text);
		}

		// ── Per-frame ────────────────────────────────────────────────────
		/// <summary>From CompanionNPC.AI on the authority.</summary>
		public void Tick(NPC npc)
		{
			_ticks++;
			npc.timeLeft = NPC.activeTime;
			UpdateStats(npc);
			TrackDamage(npc);

			if (KnockedTicks > 0)
			{
				KnockedTicks--;
				Motor.Brake(npc);
				if (KnockedTicks == 0) Revive(npc);
				return;
			}
			if (Paused) { Motor.Brake(npc); return; }

			SurvivalReflex(npc);
			bool combatMoved = CombatTick(npc);

			if (!combatMoved)
			{
				if (Job != null)
				{
					var r = Job.Tick(this);
					if (r != null) FinishJob(r.Value.Ok, r.Value.Detail);
				}
				else if (Following) FollowTick(npc);
				else Motor.Brake(npc);
			}

			if (Motor.Active)
			{
				Motor.Run = Focus >= 0 || RunWanted(npc);
				Motor.Tick(npc, out _, out bool stuck);
				if (stuck) Walker.NoteStuck();
			}
			else if (!combatMoved) Motor.Brake(npc);
		}

		private bool RunWanted(NPC npc)
		{
			if (!OwnerFeet(out var f, out _)) return false;
			return Math.Abs(f.X - Motor.FeetX(npc)) > 12;
		}

		/// <summary>From SeiSystem every frame on the authority (also when AI did not run).</summary>
		public void SystemTick()
		{
			if (Npc == null && NpcIndex != -2 && KnockedTicks == 0)
			{
				// The body vanished (a world wipe, another mod): put it back.
				string err = CreateBody();
				if (err != null) NpcIndex = -2;
			}
			if (Systems.SeiSystem.Ticks % 60 == 0 && Npc != null && Session != null && Session.IsOpen)
			{
				try { Session.SendEvent("obs", new Dictionary<string, object> { ["obs"] = Observe.Observer.Build(this) }); }
				catch (Exception e) { SeiMod.Log?.Warn($"[Sei] observe failed: {e.Message}"); }
			}
		}

		private void UpdateStats(NPC npc)
		{
			int want = Math.Max(100, Owner?.statLifeMax2 ?? 100);
			if (npc.lifeMax != want)
			{
				float frac = npc.lifeMax > 0 ? npc.life / (float)npc.lifeMax : 1f;
				npc.lifeMax = want;
				npc.life = Math.Clamp((int)Math.Round(frac * want), 1, want);
				npc.netUpdate = true;
			}
			npc.defense = 2 + ArmorDefense();
		}

		private void FollowTick(NPC npc)
		{
			if (!OwnerFeet(out var feet, out _)) { Motor.Brake(npc); return; }
			int fx = Motor.FeetX(npc), fy = Motor.FeetY(npc);
			int dx = Math.Abs(feet.X - fx), dy = Math.Abs(feet.Y - fy);
			if (dx > 90 || dy > 60 || _followFails >= 4)
			{
				TeleportNear(feet, dx > 90 || dy > 60 ? "far behind" : "no path");
				_followFails = 0;
				return;
			}
			bool close = dx <= 4 && dy <= 3;
			if (close && !Motor.Active) { Motor.Brake(npc); return; }
			if (close && Motor.Active && dx <= 2) { Motor.Stop(); return; }
			if (--_followReplan <= 0 || !Motor.Active || Math.Abs(_followTarget.X - feet.X) > 4 || Math.Abs(_followTarget.Y - feet.Y) > 3)
			{
				_followReplan = 45;
				_followTarget = feet;
				var path = Nav.Find(WorldTiles.Instance, fx, fy,
					(x, y) => Math.Abs(x - feet.X) <= 2 && Math.Abs(y - feet.Y) <= 2,
					(x, y) => Math.Abs(x - feet.X) + Math.Abs(y - feet.Y),
					out bool reached, 4000);
				if (path == null || path.Count == 0 && !reached) { _followFails++; Motor.Stop(); return; }
				if (!reached && path.Count == 0) _followFails++;
				else if (reached) _followFails = 0;
				Motor.SetPath(path);
			}
			if (Walker.ConsumeStuck()) { _followFails++; _followReplan = 0; }
		}

		private void TrackDamage(NPC npc)
		{
			if (_lastLife < 0) _lastLife = npc.life;
			if (npc.life < _lastLife) OnDamaged(npc, _lastLife - npc.life);
			_lastLife = npc.life;
		}

		public void OnKnockedOut(NPC npc)
		{
			Knockouts++;
			KnockedTicks = 60 * 10;
			npc.life = 1;
			npc.dontTakeDamage = true;
			npc.velocity = Vector2.Zero;
			npc.netUpdate = true;
			string by = LastAttackerName ?? "something";
			Job?.Abort(this, "knocked out");
			FinishJob(false, "knocked out");
			Motor.Stop();
			Session?.SendEvent("death", new Dictionary<string, object> { ["by"] = by, ["respawnSeconds"] = 10 });
			ChatHelper.BroadcastChatMessage(NetworkText.FromLiteral($"{Name} was knocked out by {by}."), new Color(225, 25, 25));
		}

		private void Revive(NPC npc)
		{
			npc.dontTakeDamage = false;
			npc.life = npc.lifeMax;
			if (OwnerFeet(out var feet, out _)) TeleportNear(feet, "revived");
			npc.netUpdate = true;
			_lastLife = npc.life;
			Session?.SendEvent("respawned", new Dictionary<string, object> { ["x"] = TileX, ["y"] = TileY });
		}
	}
}
