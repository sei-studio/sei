#nullable enable

using System.Text.Json.Nodes;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.MonsterMoves.Intents;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Platform;
using MegaCrit.Sts2.Core.Runs;
using Sts2Agent.Contexts;
using Sts2Agent.Utilities;

namespace Sts2Agent.Sei;

/// <summary>
/// Sei: the compact structured state (SeiState v1, PROTOCOL.md "SeiState")
/// that rides on every actions/force as `sei_state` and goes out as
/// `sei/state` when it changes while no force is pending.
/// src/bot/adapter/sts2/state.js renderSeiState reads it.
///
/// Index alignment with the upstream actions (CombatHandler.cs):
///   hand[i]      = play_card card_index (full hand, playable or not)
///   enemies[i]   = enemy_index (CombatState.HittableEnemies)
///   allies[i]    = ally_index (alive players other than me, CombatState.Allies order;
///                  use_potion uses the same list, see the "Sei:" edit in CombatHandler)
///   me.potions[i]= potion_index (PotionSlots; empty slots kept as {empty:true}, trailing ones trimmed)
///   options[i]   = character_index / map node index where filled in
/// Main thread only (reads game objects).
/// </summary>
public static class SeiState
{
    /// <summary>An actions/force is out and no action has resolved it yet.</summary>
    public static bool ForcePending { get; private set; }
    private static long _forceSentAt;

    public static void MarkForceSent()
    {
        ForcePending = true;
        _forceSentAt = Environment.TickCount64;
    }

    public static void MarkForceAnswered() => ForcePending = false;

    /// <summary>A force older than this with no answer is treated as stale for sei/state purposes.</summary>
    public static bool ForcePendingFresh => ForcePending && Environment.TickCount64 - _forceSentAt < 120_000;

    /// <summary>The state, or null when it cannot be built. Never throws.</summary>
    public static JsonObject? Current()
    {
        try
        {
            return Build();
        }
        catch (Exception e)
        {
            Plugin.LogDebug($"[sei] state build failed: {e.Message}");
            return null;
        }
    }

    public static string ScreenName(ContextType? type, bool inRun) => type switch
    {
        ContextType.Map => "map",
        ContextType.HandSelection => "hand_select",
        ContextType.CardSelection => "card_select",
        ContextType.Rewards => "rewards",
        ContextType.Combat => "combat",
        ContextType.Event => "event",
        ContextType.RestSite => "rest",
        ContextType.Shop => "shop",
        ContextType.Treasure => "treasure",
        ContextType.BundleSelection => "bundle_select",
        ContextType.GameOver => "game_over",
        ContextType.CharacterSelect => "character_select",
        ContextType.MainMenu => "main_menu",
        ContextType.CrystalBallEvent => "event",
        ContextType.TimelinesEvent => "timeline",
        null => inRun ? "loading" : "menu",
        _ => "unknown",
    };

    private static string Clip(string? s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        s = s.Replace('\n', ' ').Replace('\r', ' ').Trim();
        while (s.Contains("  ")) s = s.Replace("  ", " ");
        return s.Length > max ? s[..max] : s;
    }

    public static string PlayerName(Player p)
    {
        try
        {
            var name = PlatformUtil.GetPlayerNameRaw(RunManager.Instance.NetService.Platform, p.NetId);
            if (!string.IsNullOrWhiteSpace(name)) return Clip(name, 64);
        }
        catch
        {
            // fall through
        }
        return "player " + p.NetId;
    }

    private static string CharacterName(Player p) => Clip(TextHelper.SafeLocString(() => p.Character.Title), 40);

    private static JsonArray Powers(Creature c)
    {
        var arr = new JsonArray();
        try
        {
            foreach (var power in c.Powers)
            {
                if (arr.Count >= 8) break;
                arr.Add(new JsonObject { ["name"] = Clip(TextHelper.SafeLocString(() => power.Title), 40), ["amount"] = power.Amount });
            }
        }
        catch
        {
            // powers are optional
        }
        return arr;
    }

    private static JsonObject? Build()
    {
        var runState = RunManager.Instance?.DebugOnlyGetState();
        var ctx = GameContext.Resolve();
        var cm = CombatManager.Instance;
        var inCombat = cm != null && cm.IsInProgress && !cm.IsOverOrEnding;
        var combatState = inCombat ? cm!.DebugOnlyGetState() : null;

        var state = new JsonObject
        {
            ["v"] = 1,
            ["screen"] = ScreenName(ctx?.Type, runState != null),
        };

        if (runState == null)
        {
            state["options"] = Options(ctx);
            return state;
        }

        state["run"] = new JsonObject
        {
            ["act"] = runState.CurrentActIndex + 1,
            // TODO(game): floor and ascension member names are guesses; null when absent.
            ["floor"] = SeiReflect.GetInt(runState, "TotalFloor", "Floor", "CurrentFloor", "FloorNumber") ?? SeiReflect.Count(SeiReflect.Get(runState, "VisitedMapCoords")),
            ["ascension"] = SeiReflect.GetInt(runState, "AscensionLevel", "Ascension") ?? 0,
        };

        var me = LocalContext.GetMe(runState.Players);
        if (me != null) state["me"] = Me(me, inCombat ? cm : null);

        state["allies"] = Allies(runState, me, combatState);

        if (combatState != null && me != null)
        {
            state["enemies"] = Enemies(combatState);
            var pcs = me.PlayerCombatState;
            if (pcs != null)
            {
                var canAct = pcs.Phase == PlayerTurnPhase.Play && !(cm?.IsPlayerReadyToEndTurn(me) ?? false) && !cm!.PlayerActionsDisabled;
                state["hand"] = Hand(pcs.Hand.Cards, canAct);
                state["piles"] = new JsonObject
                {
                    ["draw"] = pcs.DrawPile.Cards.Count,
                    ["discard"] = pcs.DiscardPile.Cards.Count,
                    ["exhaust"] = pcs.ExhaustPile.Cards.Count,
                };
            }
        }
        else
        {
            state["enemies"] = new JsonArray();
            state["hand"] = new JsonArray();
        }

        state["options"] = Options(ctx);
        return state;
    }

    private static JsonObject Me(Player me, CombatManager? cm)
    {
        var o = new JsonObject
        {
            ["character"] = CharacterName(me),
            ["hp"] = me.Creature.CurrentHp,
            ["max_hp"] = me.Creature.MaxHp,
            ["block"] = me.Creature.Block,
            ["gold"] = me.Gold,
        };
        var pcs = me.PlayerCombatState;
        if (cm != null && pcs != null)
        {
            o["energy"] = pcs.Energy;
            // TODO(game): max energy member name is a guess.
            var maxEnergy = SeiReflect.GetInt(pcs, "MaxEnergy", "EnergyPerTurn", "BaseEnergy") ?? SeiReflect.GetInt(me, "MaxEnergy", "BaseEnergy");
            if (maxEnergy != null) o["max_energy"] = maxEnergy;
            if (pcs.Stars > 0) o["stars"] = pcs.Stars;
            o["ended_turn"] = cm.IsPlayerReadyToEndTurn(me);
        }

        var potions = new JsonArray();
        var slots = me.PotionSlots;
        var last = -1;
        for (var i = 0; i < slots.Count; i++) if (slots[i] != null) last = i;
        for (var i = 0; i <= last; i++)
        {
            var p = slots[i];
            potions.Add(p == null
                ? new JsonObject { ["name"] = "(empty slot)", ["empty"] = true }
                : new JsonObject { ["name"] = Clip(TextHelper.SafeLocString(() => p.Title), 40), ["desc"] = Clip(TextHelper.GetPotionDescription(p), 160) });
        }
        o["potions"] = potions;

        var relics = new JsonArray();
        foreach (var r in me.Relics)
        {
            if (relics.Count >= 30) break;
            relics.Add(Clip(TextHelper.SafeLocString(() => r.Title), 40));
        }
        o["relics"] = relics;
        o["deck"] = me.Deck.Cards.Count;
        o["powers"] = Powers(me.Creature);
        return o;
    }

    private static JsonArray Allies(RunState runState, Player? me, CombatState? combatState)
    {
        var arr = new JsonArray();
        var cm = CombatManager.Instance;
        if (combatState != null)
        {
            // Same list and order as play_card's ally_index.
            foreach (var c in combatState.Allies.Where(c => c != null && c.IsAlive && c.IsPlayer && c != me?.Creature))
            {
                var p = c.Player;
                var o = new JsonObject
                {
                    ["name"] = p != null ? PlayerName(p) : Clip(c.Name, 40),
                    ["character"] = p != null ? CharacterName(p) : "",
                    ["hp"] = c.CurrentHp,
                    ["max_hp"] = c.MaxHp,
                    ["block"] = c.Block,
                    ["is_player"] = true,
                    ["powers"] = Powers(c),
                };
                if (p != null && cm != null) o["ended_turn"] = cm.IsPlayerReadyToEndTurn(p);
                arr.Add(o);
            }
            return arr;
        }
        foreach (var p in runState.Players)
        {
            if (p == null || p == me) continue;
            arr.Add(new JsonObject
            {
                ["name"] = PlayerName(p),
                ["character"] = CharacterName(p),
                ["hp"] = p.Creature.CurrentHp,
                ["max_hp"] = p.Creature.MaxHp,
                ["block"] = 0,
                ["is_player"] = true,
                ["powers"] = new JsonArray(),
            });
        }
        return arr;
    }

    private static JsonArray Enemies(CombatState combatState)
    {
        var arr = new JsonArray();
        var enemies = combatState.HittableEnemies.ToList();
        var playerCreatures = combatState.Creatures.Where(c => c.Player != null);
        foreach (var e in enemies)
        {
            arr.Add(new JsonObject
            {
                ["name"] = Clip(e.Name, 40),
                ["hp"] = e.CurrentHp,
                ["max_hp"] = e.MaxHp,
                ["block"] = e.Block,
                ["intent"] = Intent(e, playerCreatures),
                ["powers"] = Powers(e),
            });
        }
        return arr;
    }

    private static string Intent(Creature enemy, IEnumerable<Creature> allies)
    {
        try
        {
            if (enemy.Monster is not MonsterModel monster) return "";
            var intents = monster.NextMove.Intents;
            if (intents == null || intents.Count == 0) return "";
            var parts = new List<string>();
            foreach (var intent in intents)
            {
                var tip = intent.GetHoverTip(allies, enemy);
                var title = tip.Title != null ? TextHelper.StripBBCode(tip.Title) : "";
                var desc = TextHelper.StripBBCode(tip.Description ?? "");
                parts.Add(string.IsNullOrWhiteSpace(title) ? desc : string.IsNullOrWhiteSpace(desc) ? title : $"{title}: {desc}");
            }
            return Clip(string.Join("; ", parts), 160);
        }
        catch
        {
            return "";
        }
    }

    private static JsonArray Hand(IReadOnlyList<CardModel> cards, bool canAct)
    {
        var arr = new JsonArray();
        foreach (var card in cards)
        {
            bool playable;
            try { playable = canAct && card.CanPlay(); } catch { playable = false; }
            int? cost;
            try { cost = card.EnergyCost.GetAmountToSpend(); } catch { cost = null; }
            arr.Add(new JsonObject
            {
                ["name"] = Clip(TextHelper.SafeLocString(() => card.Title), 40),
                ["cost"] = cost,
                // TODO(game): CardModel.Type is a guess; empty when absent.
                ["type"] = (SeiReflect.GetString(card, "Type", "CardType") ?? "").ToLowerInvariant(),
                ["target"] = TargetName(card.TargetType),
                ["desc"] = Clip(TextHelper.GetCardDescription(card), 200),
                ["playable"] = playable,
            });
        }
        return arr;
    }

    private static string TargetName(TargetType t) => t switch
    {
        TargetType.AnyEnemy => "enemy",
        TargetType.AnyAlly => "ally",
        TargetType.AnyPlayer => "ally",
        TargetType.AllEnemies => "all_enemies",
        TargetType.AllAllies => "all_allies",
        TargetType.TargetedNoCreature => "none",
        _ => "self",
    };

    /// <summary>Choices whose index the action expects. Screens not covered here leave it empty; the upstream context text lists them.</summary>
    private static JsonArray Options(ContextInfo? ctx)
    {
        var arr = new JsonArray();
        if (ctx == null) return arr;
        try
        {
            switch (ctx.Type)
            {
                case ContextType.CharacterSelect when ctx.CharacterButtons != null:
                    foreach (var b in ctx.CharacterButtons)
                        arr.Add(new JsonObject { ["label"] = Clip(TextHelper.SafeLocString(() => b.Character.Title), 40) });
                    break;
                case ContextType.Map when ctx.AvailableMapNodes != null:
                    foreach (var n in ctx.AvailableMapNodes)
                        arr.Add(new JsonObject { ["label"] = Clip(MapHandler.GetMapPointName(n.PointType), 40) });
                    break;
            }
        }
        catch
        {
            // options are optional
        }
        return arr;
    }
}
