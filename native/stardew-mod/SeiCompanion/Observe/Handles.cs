using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;

namespace SeiCompanion.Observe
{
    /// <summary>What a `#N` handle points at. Only one of the references is set.</summary>
    public sealed class Handle
    {
        public string Id;
        public string Kind;          // monster | npc | player | animal | warp | chest | machine | tree | rock | forage | debris | water | crop
        public string Label;
        public Character Character;  // monsters, villagers, animals
        public Farmer Farmer;        // players
        public Point Tile;           // objects, terrain, warps, water tiles
        public string LocationName;
        public long IssuedAt;
    }

    /// <summary>
    /// The `#N` targeting handles the snapshot hands the model (the Minecraft
    /// adapter's targeting.js). A handle stays resolvable for a while after the
    /// snapshot that issued it, since the model acts on a snapshot a few seconds
    /// old; the same target keeps its number across snapshots so the model's
    /// memory of "#3 is the slime" holds.
    /// </summary>
    public sealed class HandleRegistry
    {
        private const long TtlMs = 90_000;
        private readonly Dictionary<string, Handle> _byId = new Dictionary<string, Handle>();
        private readonly Dictionary<object, string> _idByKey = new Dictionary<object, string>();
        private int _next = 1;

        private static object KeyFor(Handle h)
        {
            if (h.Character != null) return h.Character;
            if (h.Farmer != null) return h.Farmer;
            return $"{h.Kind}@{h.LocationName}:{h.Tile.X},{h.Tile.Y}";
        }

        public string Register(Handle h)
        {
            object key = KeyFor(h);
            long now = Environment.TickCount64;
            if (this._idByKey.TryGetValue(key, out string existing) && this._byId.TryGetValue(existing, out Handle old))
            {
                old.IssuedAt = now;
                old.Label = h.Label;
                old.Kind = h.Kind;
                old.Tile = h.Tile;
                return existing;
            }
            string id = $"#{this._next++}";
            h.Id = id;
            h.IssuedAt = now;
            this._byId[id] = h;
            this._idByKey[key] = id;
            return id;
        }

        public Handle Resolve(string id)
        {
            if (string.IsNullOrEmpty(id))
                return null;
            string key = id.Trim();
            if (!key.StartsWith("#")) key = "#" + key;
            return this._byId.TryGetValue(key, out Handle h) ? h : null;
        }

        public void Sweep()
        {
            long now = Environment.TickCount64;
            var stale = new List<string>();
            foreach (KeyValuePair<string, Handle> pair in this._byId)
            {
                Handle h = pair.Value;
                bool dead = now - h.IssuedAt > TtlMs
                    || (h.Character != null && (h.Character.currentLocation == null || (h.Character is StardewValley.Monsters.Monster m && m.Health <= 0)));
                if (dead) stale.Add(pair.Key);
            }
            foreach (string id in stale)
            {
                if (this._byId.TryGetValue(id, out Handle h))
                {
                    this._idByKey.Remove(KeyFor(h));
                    this._byId.Remove(id);
                }
            }
        }
    }
}
