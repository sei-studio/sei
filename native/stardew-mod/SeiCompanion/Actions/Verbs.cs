using System;
using System.Collections.Generic;

namespace SeiCompanion.Actions
{
    /// <summary>
    /// The closed verb table. Names mirror src/bot/adapter/stardew/registry.js
    /// exactly; follow/unfollow are handled by SeiBody.RunCommand because they
    /// only set background state.
    /// </summary>
    public static class Verbs
    {
        private static readonly Dictionary<string, Func<ActionContext, IEnumerable<object>>> Table =
            new Dictionary<string, Func<ActionContext, IEnumerable<object>>>(StringComparer.OrdinalIgnoreCase)
            {
                ["goTo"] = Movement.GoTo,
                ["come"] = Movement.Come,
                ["till"] = Tools.Till,
                ["water"] = Tools.Water,
                ["plant"] = Farming.Plant,
                ["harvest"] = Farming.Harvest,
                ["chop"] = Tools.Chop,
                ["mine"] = Tools.Mine,
                ["gather"] = Tools.Gather,
                ["attack"] = Combat.Attack,
                ["fish"] = Fishing.Fish,
                ["eat"] = Items.Eat,
                ["equip"] = Items.Equip,
                ["place"] = Items.Place,
                ["chest"] = Items.ChestOp,
                ["buy"] = Shop.Buy,
                ["interact"] = Interact.Do,
                ["sleep"] = Interact.Sleep,
                // 0.1.3
                ["ship"] = Shipping.Ship,
                ["give"] = Shipping.Give,
            };

        public static Func<ActionContext, IEnumerable<object>> Resolve(string name)
        {
            return name != null && Table.TryGetValue(name, out var verb) ? verb : null;
        }

        public static IEnumerable<string> Names => Table.Keys;
    }
}
