// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// Everything that touches game state runs on the game's main thread. The
// bridge's socket threads only enqueue here; the queue is drained from every
// hook that runs on the main thread (world update, UI update while paused,
// and the dedicated server's raw tick when no client is connected).

using System;
using System.Collections.Concurrent;
using System.Diagnostics;

namespace SeiCompanion.Link
{
	public static class GameThread
	{
		private static readonly ConcurrentQueue<Action> Queue = new();

		public static void Post(Action work) => Queue.Enqueue(work);

		public static int Pending => Queue.Count;

		/// <summary>Run queued work for at most budgetMs (the rest waits for the next tick).</summary>
		public static void Drain(double budgetMs = 4.0)
		{
			if (Queue.IsEmpty) return;
			var sw = Stopwatch.StartNew();
			while (Queue.TryDequeue(out var work))
			{
				try { work(); }
				catch (Exception e) { SeiMod.Log?.Error($"[Sei] game-thread work threw: {e}"); }
				if (sw.Elapsed.TotalMilliseconds > budgetMs) break;
			}
		}

		public static void Clear()
		{
			while (Queue.TryDequeue(out _)) { }
		}
	}
}
