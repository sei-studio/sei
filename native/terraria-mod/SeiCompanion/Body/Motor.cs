// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// Drives the NPC body along a Nav path: horizontal steering, step-ups, jumps
// sized to the climb, platform drops, and doors (opened on the way, closed
// behind). Reports arrival and "stuck" (no progress for StuckTicks) so the
// caller can re-plan.

using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Terraria;
using Terraria.ID;

namespace SeiCompanion.Body
{
	public sealed class Motor
	{
		public const float Gravity = 0.3f;
		public const int StuckTicks = 50;

		public List<NavStep> Path;
		public int Index;
		public float WalkSpeed = 3.2f;
		public float RunSpeed = 4.6f;
		public bool Run;
		public int DropTicks;

		private bool _jumped;
		private int _sinceProgress;
		private float _bestDist = float.MaxValue;
		private int _lastIndex = -1;
		private readonly List<(int x, int y, int dir)> _opened = new();

		public bool Active => Path != null && Index < Path.Count;
		public NavStep? Current => Active ? Path[Index] : null;
		public NavStep? Final => Path != null && Path.Count > 0 ? Path[Path.Count - 1] : null;

		public void SetPath(List<NavStep> path)
		{
			Path = path;
			Index = 0;
			_jumped = false;
			ResetProgress();
		}

		public void Stop()
		{
			Path = null;
			Index = 0;
			_jumped = false;
		}

		private void ResetProgress()
		{
			_sinceProgress = 0;
			_bestDist = float.MaxValue;
			_lastIndex = Index;
		}

		public static int FeetX(NPC npc) => (int)(npc.Center.X / 16f);
		public static int FeetY(NPC npc) => (int)((npc.position.Y + npc.height - 1) / 16f);
		public static bool OnGround(NPC npc) => npc.velocity.Y == 0f;

		public static float JumpVelocity(int tiles) => (float)Math.Sqrt(2 * Gravity * (tiles * 16 + 12));

		/// <summary>One tick. stuck = no progress toward the current step for a while.</summary>
		public void Tick(NPC npc, out bool arrived, out bool stuck)
		{
			arrived = false;
			stuck = false;
			if (DropTicks > 0) DropTicks--;
			CloseDoorsBehind(npc);
			if (!Active)
			{
				Brake(npc);
				arrived = Path != null;
				return;
			}
			if (Index != _lastIndex) { ResetProgress(); _jumped = false; }

			var s = Path[Index];
			float tx = s.X * 16 + 8;
			int fx = FeetX(npc), fy = FeetY(npc);
			bool ground = OnGround(npc);
			float dxPx = tx - npc.Center.X;
			bool aligned = Math.Abs(dxPx) < 5f;

			switch (s.Move)
			{
				case Move.Walk:
				case Move.Step:
				case Move.Fall:
				{
					Steer(npc, dxPx);
					OpenDoorAhead(npc, Math.Sign(dxPx));
					// A one-block lip Collision.StepUp did not take: hop it.
					if (ground && npc.collideX && Math.Abs(dxPx) > 6f) npc.velocity.Y = -JumpVelocity(1);
					if (Math.Abs(dxPx) < 8f && fy == s.Y && ground) Index++;
					else if (s.Move == Move.Fall && aligned && ground && fy > s.Y) Index++;
					break;
				}
				case Move.Drop:
				{
					if (!aligned) Steer(npc, dxPx);
					else npc.velocity.X *= 0.7f;
					if (ground && fy < s.Y) DropTicks = 10;
					if (fy >= s.Y && ground) Index++;
					break;
				}
				case Move.Jump:
				{
					int sx = Index > 0 ? Path[Index - 1].X : fx;
					int sy = Index > 0 ? Path[Index - 1].Y : fy;
					if (!_jumped)
					{
						float takeoff = sx * 16 + 8 - npc.Center.X;
						if (Math.Abs(takeoff) > 5f && fx != sx) { Steer(npc, takeoff); break; }
						if (!ground) break;
						int rise = sy - s.Y;
						npc.velocity.Y = -JumpVelocity(Math.Max(1, rise + 1));
						_jumped = true;
						// Gaps: carry speed into the jump.
						if (rise <= 0) Steer(npc, dxPx, forceRun: true);
						else npc.velocity.X *= 0.3f;
						break;
					}
					// In the air: go across once the feet clear the landing ledge.
					float feet = npc.position.Y + npc.height;
					bool clear = feet <= (s.Y + 1) * 16 + 2 || s.Y >= sy;
					if (clear) Steer(npc, dxPx, forceRun: Math.Abs(s.X - sx) >= 3);
					else npc.velocity.X *= 0.8f;
					if (ground && npc.velocity.Y == 0f && _jumped && Math.Abs(dxPx) < 10f && fy == s.Y) Index++;
					else if (ground && _jumped && fy != s.Y && Math.Abs(npc.oldVelocity.Y) > 0.01f && _sinceProgress > 20) { stuck = true; }
					break;
				}
			}

			// Progress watch.
			float dist = Math.Abs(dxPx) + Math.Abs((s.Y * 16 + 16) - (npc.position.Y + npc.height));
			if (dist < _bestDist - 1f) { _bestDist = dist; _sinceProgress = 0; }
			else if (++_sinceProgress > StuckTicks) stuck = true;
			if (!Active) arrived = true;
		}

		public void Steer(NPC npc, float dxPx, bool forceRun = false)
		{
			float max = (Run || forceRun) ? RunSpeed : WalkSpeed;
			if (Math.Abs(dxPx) < 2f) { Brake(npc); return; }
			float want = Math.Sign(dxPx) * Math.Min(max, Math.Max(1.2f, Math.Abs(dxPx) * 0.25f));
			float accel = OnGround(npc) ? 0.35f : 0.22f;
			if (npc.velocity.X < want) npc.velocity.X = Math.Min(want, npc.velocity.X + accel);
			else if (npc.velocity.X > want) npc.velocity.X = Math.Max(want, npc.velocity.X - accel);
			npc.direction = npc.spriteDirection = Math.Sign(dxPx);
		}

		public static void Brake(NPC npc)
		{
			npc.velocity.X *= OnGround(npc) ? 0.75f : 0.95f;
			if (Math.Abs(npc.velocity.X) < 0.1f) npc.velocity.X = 0f;
		}

		private void OpenDoorAhead(NPC npc, int dir)
		{
			if (dir == 0) return;
			int fx = FeetX(npc), fy = FeetY(npc);
			int x = fx + dir;
			var q = WorldTiles.Instance;
			for (int k = 0; k < Nav.BodyHeight; k++)
			{
				int y = fy - k;
				if (!q.Door(x, y)) continue;
				if (Main.tile[x, y].TileType != TileID.ClosedDoor) return; // tall gates: leave to the player
				if (WorldGen.OpenDoor(x, y, dir))
				{
					if (Main.netMode == NetmodeID.Server)
						NetMessage.SendData(MessageID.ToggleDoorState, -1, -1, null, 0, x, y, dir);
					_opened.Add((x, y, dir));
				}
				return;
			}
		}

		private void CloseDoorsBehind(NPC npc)
		{
			if (_opened.Count == 0) return;
			int fx = FeetX(npc);
			for (int i = _opened.Count - 1; i >= 0; i--)
			{
				var d = _opened[i];
				if (Math.Abs(fx - d.x) < 3) continue;
				if (WorldGen.CloseDoor(d.x, d.y, false) && Main.netMode == NetmodeID.Server)
					NetMessage.SendData(MessageID.ToggleDoorState, -1, -1, null, 1, d.x, d.y, d.dir);
				_opened.RemoveAt(i);
			}
		}
	}
}
