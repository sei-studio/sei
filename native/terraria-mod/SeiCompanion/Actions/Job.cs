// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// A verb that takes time (walk, mine, chop, craft at a station...). Start and
// Tick return null while running, or a result whose Detail becomes the tool
// result the brain reads. Every job has a wall-clock budget.

using SeiCompanion.Body;

namespace SeiCompanion.Actions
{
	public struct JobResult
	{
		public bool Ok;
		public string Detail;
		public JobResult(bool ok, string detail) { Ok = ok; Detail = detail; }
	}

	public abstract class Job
	{
		public string CmdId;
		public string Name;
		protected int Ticks;
		protected virtual int TimeoutTicks => 60 * 90;

		/// <summary>False for jobs that carry the player's intent (come, goTo, give): combat may swing but never takes the legs.</summary>
		public virtual bool YieldsToCombat => true;

		public abstract JobResult? Start(Companion c);

		public JobResult? Tick(Companion c)
		{
			if (++Ticks > TimeoutTicks) return Timeout(c);
			return Step(c);
		}

		protected abstract JobResult? Step(Companion c);

		protected virtual JobResult? Timeout(Companion c) => Fail($"gave up after {TimeoutTicks / 60}s");

		public virtual void Abort(Companion c, string reason) { }

		protected static JobResult Ok(string detail) => new(true, detail);
		protected static JobResult Fail(string detail) => new(false, detail);
	}
}
