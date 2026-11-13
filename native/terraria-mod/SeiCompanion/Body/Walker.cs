// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// "Walk until this holds": plans with Nav, hands the path to the Motor, and
// re-plans when the motor reports stuck or a partial path runs out. Jobs use
// it for every walk; it gives up after MaxReplans with a reason.

using System;
using Terraria;

namespace SeiCompanion.Body
{
	public sealed class Walker
	{
		public enum St { Running, Arrived, Failed }
		public const int MaxReplans = 5;

		private Func<int, int, bool> _goal;
		private Func<int, int, float> _h;
		private int _maxNodes;
		private int _replans;
		private bool _planned;
		private bool _reached;
		private bool _stuck;
		private int _bestH = int.MaxValue;
		public string Fail;

		public void Reset()
		{
			_goal = null;
			_planned = false;
			_replans = 0;
			_stuck = false;
			_bestH = int.MaxValue;
			Fail = null;
		}

		public void Begin(Func<int, int, bool> goal, Func<int, int, float> h, int maxNodes = 6000)
		{
			Reset();
			_goal = goal;
			_h = h;
			_maxNodes = maxNodes;
		}

		public void NoteStuck() => _stuck = true;

		public bool ConsumeStuck()
		{
			bool s = _stuck;
			_stuck = false;
			return s;
		}

		public St Tick(Companion c)
		{
			var npc = c.Npc;
			if (npc == null || _goal == null) { Fail = "no body"; return St.Failed; }
			int fx = Motor.FeetX(npc), fy = Motor.FeetY(npc);
			if (_goal(fx, fy) && Motor.OnGround(npc)) { c.Motor.Stop(); return St.Arrived; }
			bool needPlan = !_planned || _stuck || !c.Motor.Active;
			if (!needPlan) return St.Running;
			if (_planned)
			{
				// A partial path ran out, or the motor stalled: count it, unless it got closer.
				int hNow = (int)_h(fx, fy);
				if (hNow < _bestH - 2) _bestH = hNow;
				else _replans++;
			}
			_stuck = false;
			if (_replans > MaxReplans)
			{
				Fail = $"stuck at ({fx},{fy}); could not find a way";
				return St.Failed;
			}
			var path = Nav.Find(WorldTiles.Instance, fx, fy, _goal, _h, out bool reached, _maxNodes);
			if (path == null || path.Count == 0)
			{
				if (_goal(fx, fy)) { c.Motor.Stop(); return St.Arrived; }
				Fail = $"no way to get there from ({fx},{fy})";
				return St.Failed;
			}
			_planned = true;
			_reached = reached;
			c.Motor.SetPath(path);
			return St.Running;
		}

		public bool PlannedFullPath => _planned && _reached;
	}
}
