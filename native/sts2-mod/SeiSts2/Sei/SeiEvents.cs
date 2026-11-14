#nullable enable

using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Map;
using MegaCrit.Sts2.Core.Runs;
using Sts2Agent.Contexts;

namespace Sts2Agent.Sei;

/// <summary>
/// Sei: `sei/event` {kind, detail} from diffing a snapshot of the run every
/// tick, instead of more Harmony patches on game internals. Kinds
/// (src/bot/adapter/sts2/prompts.js EVENT_LINES): combat_start, elite_start,
/// boss_start, combat_won, act_start, run_won, run_lost, you_died,
/// player_low. Seat role only (the companion's view). Main thread only.
/// </summary>
public static class SeiEvents
{
    private const double LowHpFraction = 0.3;

    private static bool _inCombat;
    private static string _lastEnemies = "";
    private static int? _act;
    private static bool _gameOverSent;
    private static bool _meDead;
    private static readonly HashSet<string> LowAllies = new();
    private static object? _runRef;

    public static void Reset()
    {
        _inCombat = false;
        _lastEnemies = "";
        _act = null;
        _gameOverSent = false;
        _meDead = false;
        LowAllies.Clear();
        _runRef = null;
    }

    /// <summary>Diff the game against the last tick and emit what changed.</summary>
    public static void Tick(Action<string, string?> emit)
    {
        var runState = RunManager.Instance?.DebugOnlyGetState();

        // Run over (checked first: the run state may already be gone on the game over screen).
        if (_runRef != null && !_gameOverSent && IsGameOverScreen())
        {
            _gameOverSent = true;
            var history = RunManager.Instance?.History;
            if (history != null && history.Win) emit("run_won", _act != null ? $"act {_act + 1}" : null);
            else if (history != null && history.WasAbandoned) { /* abandoned: no event */ }
            else emit("run_lost", string.IsNullOrEmpty(_lastEnemies) ? null : $"against {_lastEnemies}");
        }
        if (runState != null && !ReferenceEquals(runState, _runRef))
        {
            // A new run (or a loaded one): start clean; act 1 is announced, a loaded later act is not.
            Reset();
            _runRef = runState;
            _act = runState.CurrentActIndex;
            if (runState.CurrentActIndex == 0) emit("act_start", "act 1");
        }
        if (runState == null || _gameOverSent) return;
        // Act change.
        var act = runState.CurrentActIndex;
        if (_act != null && act > _act) emit("act_start", $"act {act + 1}");
        _act = act;

        var cm = CombatManager.Instance;
        var inCombat = cm != null && cm.IsInProgress && !cm.IsOverOrEnding;
        var combatState = inCombat ? cm!.DebugOnlyGetState() : null;
        var me = LocalContext.GetMe(runState.Players);

        if (inCombat && combatState != null)
        {
            var names = string.Join(", ", combatState.HittableEnemies.Select(e => e.Name).Distinct().Take(5));
            if (!string.IsNullOrEmpty(names)) _lastEnemies = names;
            if (!_inCombat)
            {
                var kind = RoomKind(runState) switch
                {
                    MapPointType.Boss => "boss_start",
                    MapPointType.Elite => "elite_start",
                    _ => "combat_start",
                };
                emit(kind, names);
            }

            // Me down (edge).
            if (me != null)
            {
                var dead = !me.Creature.IsAlive;
                if (dead && !_meDead) emit("you_died", null);
                _meDead = dead;
            }

            // A teammate player under 30% (edge per player, re-armed when they recover).
            foreach (var c in combatState.Allies.Where(c => c != null && c.IsPlayer && c.Player != null && c != me?.Creature))
            {
                var id = c.Player!.NetId.ToString() ?? "";
                var low = c.IsAlive && c.MaxHp > 0 && c.CurrentHp < c.MaxHp * LowHpFraction;
                if (low && LowAllies.Add(id)) emit("player_low", $"{SeiState.PlayerName(c.Player)} at {c.CurrentHp}/{c.MaxHp} hp");
                else if (!low) LowAllies.Remove(id);
            }
        }
        else if (_inCombat)
        {
            // Combat ended: a win unless the run is over (game over screen handles losses).
            var lost = me != null && !me.Creature.IsAlive && runState.Players.All(p => p.Creature == null || !p.Creature.IsAlive);
            if (!lost) emit("combat_won", _lastEnemies);
            _meDead = false;
            LowAllies.Clear();
        }
        _inCombat = inCombat;
    }

    private static bool IsGameOverScreen()
    {
        try
        {
            return GameContext.Resolve()?.Type == ContextType.GameOver;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>The map point type of the room the party is in, from the run's map.</summary>
    public static MapPointType? RoomKind(RunState runState)
    {
        try
        {
            var coord = runState.CurrentMapCoord;
            var map = runState.Map;
            if (!coord.HasValue || map == null) return null;
            var (row, col) = (coord.Value.row, coord.Value.col);
            foreach (var p in map.GetAllMapPoints().Concat(new[] { map.BossMapPoint, map.SecondBossMapPoint }))
            {
                if (p != null && p.coord.row == row && p.coord.col == col) return p.PointType;
            }
        }
        catch
        {
            // unknown room
        }
        return null;
    }
}
