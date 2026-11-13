// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// World alerts pushed to every bot as `event` frames: bosses arriving,
// defeated or leaving, blood moons and invasions, nightfall and dawn, and a
// player dropping low or dying. Facts only; the brain decides what to say.

using System;
using System.Collections.Generic;
using Terraria;
using Terraria.ID;
using SeiCompanion.Body;

namespace SeiCompanion.Systems
{
	public static class Events
	{
		private static readonly Dictionary<int, (int idx, string name)> Bosses = new();
		private static readonly Dictionary<int, ulong> LowWarned = new();
		private static readonly bool[] WasDead = new bool[256];
		private static readonly bool[] WasActive = new bool[256];
		private static bool _blood, _eclipse, _pumpkin, _frost, _slime, _day = true, _init;
		private static int _invasion;

		public static void Reset()
		{
			Bosses.Clear();
			LowWarned.Clear();
			Array.Clear(WasDead);
			Array.Clear(WasActive);
			_init = false;
		}

		private static void Send(string kind, string text, Dictionary<string, object> extra = null)
		{
			var f = extra ?? new Dictionary<string, object>();
			f["kind"] = kind;
			f["text"] = text;
			SeiMod.Bridge?.Broadcast("event", f);
		}

		public static void Tick()
		{
			if (SeiSystem.Ticks % 15 != 0) return;
			if (!_init)
			{
				_init = true;
				_blood = Main.bloodMoon; _eclipse = Main.eclipse; _pumpkin = Main.pumpkinMoon; _frost = Main.snowMoon;
				_slime = Main.slimeRain; _day = Main.dayTime; _invasion = Main.invasionType;
				for (int i = 0; i < Main.maxPlayers; i++) { WasActive[i] = Main.player[i].active; WasDead[i] = Main.player[i].dead; }
			}
			Flag(ref _blood, Main.bloodMoon, "blood_moon", "A blood moon is rising. Zombies and demon eyes are out in force and doors will not keep them out for long.", "The blood moon is over.");
			Flag(ref _eclipse, Main.eclipse, "eclipse", "A solar eclipse started. Strong monsters roam until night.", "The eclipse ended.");
			Flag(ref _pumpkin, Main.pumpkinMoon, "pumpkin_moon", "The pumpkin moon is up.", "The pumpkin moon ended.");
			Flag(ref _frost, Main.snowMoon, "frost_moon", "The frost moon is up.", "The frost moon ended.");
			Flag(ref _slime, Main.slimeRain, "slime_rain", "It is raining slimes.", "The slime rain stopped.");
			int inv = Main.invasionSize > 0 ? Main.invasionType : 0;
			if (inv != _invasion)
			{
				if (inv > 0) Send("invasion", $"The {Observe.Observer.InvasionName(inv)} is coming.");
				else Send("invasion_end", $"The {Observe.Observer.InvasionName(_invasion)} is over.");
				_invasion = inv;
			}
			if (Main.dayTime != _day)
			{
				_day = Main.dayTime;
				Send(_day ? "dawn" : "dusk", _day ? "The sun is up." : "Night is falling. Zombies and demon eyes come out at night.");
			}
			TrackBosses();
			TrackPlayers();
		}

		private static void Flag(ref bool was, bool now, string kind, string on, string off)
		{
			if (now == was) return;
			was = now;
			Send(now ? kind : kind + "_end", now ? on : off);
		}

		private static void TrackBosses()
		{
			var seen = new HashSet<int>();
			for (int i = 0; i < Main.maxNPCs; i++)
			{
				var n = Main.npc[i];
				if (!n.active || !(n.boss || NPCID.Sets.ShouldBeCountedAsBoss[n.type])) continue;
				int key = n.realLife >= 0 ? Main.npc[n.realLife].type : n.type;
				if (seen.Contains(key)) continue;
				seen.Add(key);
				if (!Bosses.ContainsKey(key))
				{
					Bosses[key] = (i, n.GivenOrTypeName);
					Send("boss_spawn", $"{n.GivenOrTypeName} has awoken!", new Dictionary<string, object> { ["boss"] = n.GivenOrTypeName, ["id"] = i });
				}
				else Bosses[key] = (i, Bosses[key].name);
			}
			foreach (var key in new List<int>(Bosses.Keys))
			{
				if (seen.Contains(key)) continue;
				var (idx, name) = Bosses[key];
				Bosses.Remove(key);
				var n = Main.npc[idx];
				bool killed = n.life <= 0;
				Send(killed ? "boss_defeated" : "boss_left", killed ? $"{name} was defeated." : $"{name} left.", new Dictionary<string, object> { ["boss"] = name });
			}
		}

		private static void TrackPlayers()
		{
			for (int i = 0; i < Main.maxPlayers; i++)
			{
				var p = Main.player[i];
				if (p == null) continue;
				if (p.active != WasActive[i])
				{
					WasActive[i] = p.active;
					if (!string.IsNullOrEmpty(p.name))
						Send(p.active ? "player_joined" : "player_left", p.active ? $"{p.name} joined the world." : $"{p.name} left the world.", new Dictionary<string, object> { ["player"] = p.name });
				}
				if (!p.active) continue;
				if (p.dead != WasDead[i])
				{
					WasDead[i] = p.dead;
					if (p.dead) Send("player_died", $"{p.name} died.", new Dictionary<string, object> { ["player"] = p.name });
				}
				if (!p.dead && p.statLifeMax2 > 0 && p.statLife < p.statLifeMax2 * 0.3f)
				{
					ulong last = LowWarned.GetValueOrDefault(i);
					if (SeiSystem.Ticks - last > 60 * 30)
					{
						LowWarned[i] = SeiSystem.Ticks;
						Send("player_low", $"{p.name} is low on health ({p.statLife}/{p.statLifeMax2}).", new Dictionary<string, object> { ["player"] = p.name, ["hp"] = p.statLife, ["maxHp"] = p.statLifeMax2 });
					}
				}
			}
		}
	}
}
