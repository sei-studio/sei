// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// The companion's own inventory (not a player inventory: the body is an NPC).
// Saved per companion name with the world (SeiSystem). Also the item-name
// lookup the verbs use ("copper ore", "wood", "healing potion").

using System;
using System.Collections.Generic;
using System.Linq;
using Terraria;
using Terraria.ID;
using Terraria.ModLoader;

namespace SeiCompanion.Body
{
	public sealed class Bag
	{
		public const int MaxStacks = 50;
		public List<Item> Items;

		public Bag(List<Item> items) { Items = items ?? new List<Item>(); }

		public int Count(int type) => Items.Where(i => i.type == type).Sum(i => i.stack);

		public bool Has(int type, int n = 1) => Count(type) >= n;

		/// <summary>Add a stack; returns what did not fit (0 = all of it).</summary>
		public int Add(Item item)
		{
			if (item == null || item.IsAir) return 0;
			int left = item.stack;
			foreach (var i in Items)
			{
				if (left <= 0) break;
				if (i.type != item.type || i.prefix != item.prefix || i.stack >= i.maxStack) continue;
				int move = Math.Min(left, i.maxStack - i.stack);
				i.stack += move;
				left -= move;
			}
			while (left > 0 && Items.Count < MaxStacks)
			{
				var copy = item.Clone();
				copy.stack = Math.Min(left, Math.Max(1, item.maxStack));
				left -= copy.stack;
				Items.Add(copy);
			}
			return left;
		}

		public int Add(int type, int stack)
		{
			var it = new Item();
			it.SetDefaults(type);
			it.stack = stack;
			return Add(it);
		}

		/// <summary>Remove up to n of a type; returns the removed items (prefixes kept).</summary>
		public List<Item> Take(int type, int n)
		{
			var outList = new List<Item>();
			for (int k = Items.Count - 1; k >= 0 && n > 0; k--)
			{
				var i = Items[k];
				if (i.type != type) continue;
				int move = Math.Min(n, i.stack);
				var part = i.Clone();
				part.stack = move;
				outList.Add(part);
				i.stack -= move;
				n -= move;
				if (i.stack <= 0) Items.RemoveAt(k);
			}
			return outList;
		}

		public bool Consume(int type, int n = 1)
		{
			if (!Has(type, n)) return false;
			Take(type, n);
			return true;
		}

		public Item Find(Func<Item, bool> pred) => Items.FirstOrDefault(i => !i.IsAir && pred(i));

		/// <summary>Match a bag item by name (with or without its prefix).</summary>
		public Item FindByName(string name)
		{
			if (string.IsNullOrWhiteSpace(name)) return null;
			string q = ItemNames.Norm(name);
			return Items.FirstOrDefault(i => ItemNames.Norm(i.Name) == q || ItemNames.Norm(i.AffixName()) == q)
				?? Items.FirstOrDefault(i => ItemNames.Norm(i.Name) == ItemNames.Singular(q))
				?? Items.FirstOrDefault(i => ItemNames.Norm(i.AffixName()).Contains(q));
		}

		public Item BestPickaxe() => Items.Where(i => i.pick > 0).OrderByDescending(i => i.pick).FirstOrDefault();
		public Item BestAxe() => Items.Where(i => i.axe > 0).OrderByDescending(i => i.axe).FirstOrDefault();

		/// <summary>"Wood x40, Copper Shortsword, ..." (one entry per type).</summary>
		public List<string> Summary(int max = 24)
		{
			return Items.GroupBy(i => i.type)
				.Select(g => { var f = g.First(); int n = g.Sum(i => i.stack); return n > 1 ? $"{f.Name} x{n}" : f.AffixName(); })
				.Take(max).ToList();
		}
	}

	public static class ItemNames
	{
		private static Dictionary<string, int> _byName;

		public static string Norm(string s) => (s ?? "").Trim().ToLowerInvariant().Replace("'", "").Replace("  ", " ");

		public static string Singular(string q)
		{
			if (q.EndsWith("ies")) return q.Substring(0, q.Length - 3) + "y";
			if (q.EndsWith("es") && (q.EndsWith("ches") || q.EndsWith("shes") || q.EndsWith("xes"))) return q.Substring(0, q.Length - 2);
			if (q.EndsWith("s") && !q.EndsWith("ss")) return q.Substring(0, q.Length - 1);
			return q;
		}

		private static void Build()
		{
			_byName = new Dictionary<string, int>();
			for (int t = 1; t < ItemLoader.ItemCount; t++)
			{
				string n;
				try { n = Lang.GetItemNameValue(t); } catch { continue; }
				if (string.IsNullOrEmpty(n)) continue;
				string k = Norm(n);
				// Lowest id wins: the vanilla item before a deprecated duplicate.
				if (!_byName.ContainsKey(k)) _byName[k] = t;
			}
		}

		/// <summary>Item type for a name, or 0.</summary>
		public static int Lookup(string name)
		{
			if (string.IsNullOrWhiteSpace(name)) return 0;
			if (_byName == null) Build();
			string q = Norm(name);
			if (_byName.TryGetValue(q, out int t)) return t;
			if (_byName.TryGetValue(Singular(q), out t)) return t;
			// A few names people say differently.
			if (q == "wood planks" || q == "planks" || q == "logs") return ItemID.Wood;
			if (q == "heal potion" || q == "healing potions") return ItemID.LesserHealingPotion;
			return 0;
		}

		public static string Name(int type)
		{
			try { return Lang.GetItemNameValue(type); } catch { return $"item {type}"; }
		}

		public static void Reset() => _byName = null;
	}
}
