using System;
using System.Collections.Generic;
using System.Linq;
using StardewValley;
using StardewValley.Internal;
using SeiCompanion.Body;

namespace SeiCompanion.Actions
{
    /// <summary>buy: read the shop's stock (ShopBuilder), pay from the companion's own wallet, never open a menu.</summary>
    public static class Shop
    {
        /// <summary>Location name → Data/Shops id. The companion must be standing in the shop.</summary>
        public static readonly Dictionary<string, string> ShopByLocation = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SeedShop"] = "SeedShop",
            ["Saloon"] = "Saloon",
            ["Blacksmith"] = "Blacksmith",
            ["FishShop"] = "FishShop",
            ["AnimalShop"] = "AnimalShop",
            ["ScienceHouse"] = "Carpenter",
            ["Hospital"] = "Hospital",
            ["JojaMart"] = "Joja",
            ["Sewer"] = "ShadowShop",
            ["SandyHouse"] = "Sandy",
            ["AdventureGuild"] = "AdventureShop",
            ["IceCreamStand"] = "IceCreamStand",
        };

        public static IEnumerable<object> Buy(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            string shopId = ctx.Str("shop");
            if (string.IsNullOrEmpty(shopId))
            {
                if (!ShopByLocation.TryGetValue(body.LocationName, out shopId))
                {
                    yield return Result.Fail($"not in a shop ({body.LocationName}); walk into Pierre's (goTo location SeedShop), the Saloon, or the Blacksmith first");
                    yield break;
                }
            }
            string query = ctx.Str("item");
            int qty = Math.Clamp(ctx.Int("qty") ?? ctx.Int("count") ?? 1, 1, 99);
            if (string.IsNullOrEmpty(query)) { yield return Result.Fail("buy needs an item name"); yield break; }

            Dictionary<ISalable, ItemStockInformation> stock = null;
            string stockError = null;
            try { stock = ShopBuilder.GetShopStock(shopId); }
            catch (Exception ex) { stockError = ex.Message; }
            if (stockError != null) { yield return Result.Fail($"could not read the {shopId} stock: {stockError}"); yield break; }
            if (stock == null || stock.Count == 0) { yield return Result.Fail($"{shopId} has nothing for sale right now"); yield break; }

            string q = query.ToLowerInvariant();
            KeyValuePair<ISalable, ItemStockInformation>? match = null;
            int bestScore = 0;
            foreach (KeyValuePair<ISalable, ItemStockInformation> pair in stock)
            {
                string name = (pair.Key.DisplayName ?? pair.Key.Name ?? "").ToLowerInvariant();
                int score = name == q ? 100 : name.StartsWith(q) ? 60 : name.Contains(q) ? 40 : 0;
                if (score > bestScore) { bestScore = score; match = pair; }
            }
            if (match == null)
            {
                string listing = string.Join(", ", stock.Keys.Take(12).Select(s => s.DisplayName));
                yield return Result.Fail($"{shopId} does not sell {query}; it has: {listing}");
                yield break;
            }
            ISalable salable = match.Value.Key;
            ItemStockInformation info = match.Value.Value;
            if (info.Price < 0) { yield return Result.Fail($"{salable.DisplayName} is not for sale for gold here"); yield break; }
            if (info.Stock != int.MaxValue && info.Stock >= 0 && info.Stock < qty) qty = Math.Max(1, info.Stock);
            int total = info.Price * qty;
            if (body.Shadow.Gold < total)
            {
                int afford = info.Price > 0 ? body.Shadow.Gold / info.Price : qty;
                yield return Result.Fail(afford > 0 ? $"{qty} {salable.DisplayName} costs {total}g and the wallet holds {body.Shadow.Gold}g; can afford {afford}" : $"cannot afford {salable.DisplayName} ({info.Price}g each, wallet {body.Shadow.Gold}g)");
                yield break;
            }
            Item item;
            try { item = ItemRegistry.Create(salable.QualifiedItemId, qty, 0, allowNull: true); }
            catch { item = null; }
            if (item == null) { yield return Result.Fail($"could not create {salable.DisplayName}"); yield break; }
            if (!body.Shadow.couldInventoryAcceptThisItem(item)) { yield return Result.Fail("inventory is full"); yield break; }
            body.Shadow.Gold -= total;
            body.TakeItem(item);
            try { body.Npc.currentLocation.playSound("purchaseClick"); } catch { }
            yield return Result.Success($"bought {qty} {salable.DisplayName} for {total}g ({body.Shadow.Gold}g left)");
        }
    }
}
