using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Locations;
using StardewValley.Monsters;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;
using SeiCompanion.Actions;
using SeiCompanion.Body;
using SObject = StardewValley.Object;

namespace SeiCompanion.Observe
{
    /// <summary>
    /// The observation the bot turns into its snapshot text. Everything the
    /// model may act on carries a `#N` handle (HandleRegistry). Lists are
    /// capped and nearest-first so the whole thing stays around 3 KB.
    /// Mirrored in src/shared/stardewIpc.ts and ../PROTOCOL.md.
    /// </summary>
    public static class Snapshot
    {
        public const int TileRadius = 8;
        public const int EntityRadius = 20;
        public const int WarpRadius = 15;

        public static Dictionary<string, object> Build(SeiBody body)
        {
            NPC npc = body.Npc;
            GameLocation loc = npc.currentLocation;
            Vector2 me = npc.Tile;
            var obs = new Dictionary<string, object>
            {
                ["name"] = body.Name,
                ["location"] = loc.NameOrUniqueName,
                ["locationKind"] = LocationKind(loc),
                ["x"] = (int)me.X,
                ["y"] = (int)me.Y,
                ["facing"] = FacingName(npc.FacingDirection),
                ["stamina"] = (int)body.Shadow.Stamina,
                ["maxStamina"] = body.Shadow.MaxStamina,
                ["health"] = body.Shadow.health,
                ["maxHealth"] = body.Shadow.maxHealth,
                ["exhausted"] = body.Shadow.exhausted.Value,
                ["gold"] = body.Shadow.Gold,
                ["time"] = Game1.timeOfDay,
                ["timeText"] = TimeText(Game1.timeOfDay),
                ["day"] = Game1.dayOfMonth,
                ["dayOfWeek"] = SafeDayName(),
                ["season"] = Game1.currentSeason,
                ["year"] = Game1.year,
                ["weather"] = Weather(),
                ["isDark"] = SafeIsDark(loc),
                ["follow"] = body.FollowTarget,
                ["paused"] = body.Paused,
                ["sleeping"] = body.Sleeping,
                ["inAction"] = body.Runner.ActionName,
                ["lastResult"] = body.LastActionResult,
            };

            obs["inventory"] = Inventory(body, out string held, out Dictionary<string, object> can);
            obs["held"] = held;
            obs["wateringCan"] = can;
            obs["tiles"] = Tiles(body, loc, me);
            obs["entities"] = Entities(body, loc, me);
            obs["warps"] = Warps(body, loc, me);
            obs["player"] = PlayerInfo(body, loc, me);
            return obs;
        }

        /*********
        ** Inventory
        *********/
        private static List<Dictionary<string, object>> Inventory(SeiBody body, out string held, out Dictionary<string, object> can)
        {
            var list = new List<Dictionary<string, object>>();
            held = null;
            can = null;
            for (int i = 0; i < body.Shadow.Items.Count; i++)
            {
                Item item = body.Shadow.Items[i];
                if (item == null) continue;
                var row = new Dictionary<string, object>
                {
                    ["slot"] = i,
                    ["id"] = item.QualifiedItemId,
                    ["name"] = item.DisplayName,
                    ["count"] = item.Stack,
                    ["kind"] = ItemKind(item),
                };
                if (item is SObject o && o.Edibility > 0) row["edible"] = o.Edibility;
                if (item is Tool t && t.UpgradeLevel > 0) row["upgrade"] = t.UpgradeLevel;
                if (item is WateringCan wc)
                    can = new Dictionary<string, object> { ["left"] = wc.WaterLeft, ["max"] = wc.waterCanMax };
                list.Add(row);
                if (i == body.Shadow.CurrentToolIndex) held = item.DisplayName;
            }
            return list;
        }

        public static string ItemKind(Item item)
        {
            switch (item)
            {
                case MeleeWeapon w when w.isScythe(): return "scythe";
                case MeleeWeapon _: return "weapon";
                case FishingRod _: return "rod";
                case Tool _: return "tool";
            }
            if (item is SObject o)
            {
                if (o.Category == SObject.SeedsCategory) return "seed";
                if (o.Category == SObject.fertilizerCategory) return "fertilizer";
                if (o.bigCraftable.Value) return "craftable";
                if (o.Edibility > 0 && (o.Category == SObject.CookingCategory)) return "food";
                if (o.Category == SObject.FishCategory) return "fish";
                if (o.Category == SObject.VegetableCategory || o.Category == SObject.FruitsCategory || o.Category == SObject.flowersCategory || o.Category == SObject.GreensCategory) return "crop";
                if (o.Category == SObject.metalResources || o.Category == SObject.buildingResources || o.Category == SObject.mineralsCategory || o.Category == SObject.GemCategory) return "resource";
                if (o.Edibility > 0) return "food";
                if (o.isForage()) return "forage";
            }
            return "other";
        }

        /*********
        ** Tiles
        *********/
        private static Dictionary<string, object> Tiles(SeiBody body, GameLocation loc, Vector2 me)
        {
            var crops = new List<Dictionary<string, object>>();
            var soil = new List<Dictionary<string, object>>();
            var trees = new List<Dictionary<string, object>>();
            var rocks = new List<Dictionary<string, object>>();
            var forage = new List<Dictionary<string, object>>();
            var chests = new List<Dictionary<string, object>>();
            var machines = new List<Dictionary<string, object>>();
            var ladders = new List<Dictionary<string, object>>();
            int twigs = 0, weeds = 0, stones = 0, dryCrops = 0, readyCrops = 0, allCrops = 0;
            Point? water = null;
            float waterDist = float.MaxValue;
            int r = TileRadius;

            for (int x = (int)me.X - r; x <= (int)me.X + r; x++)
            {
                for (int y = (int)me.Y - r; y <= (int)me.Y + r; y++)
                {
                    if (!loc.isTileOnMap(x, y)) continue;
                    var v = new Vector2(x, y);
                    float dist = Vector2.Distance(v, me);
                    if (loc.isWaterTile(x, y) && dist < waterDist) { waterDist = dist; water = new Point(x, y); }

                    if (loc.terrainFeatures.TryGetValue(v, out TerrainFeature tf))
                    {
                        switch (tf)
                        {
                            case HoeDirt dirt when dirt.crop != null:
                            {
                                allCrops++;
                                bool ready = dirt.readyForHarvest();
                                bool watered = dirt.isWatered();
                                if (ready) readyCrops++;
                                if (!watered && !dirt.crop.dead.Value) dryCrops++;
                                if (crops.Count < 12)
                                {
                                    crops.Add(new Dictionary<string, object>
                                    {
                                        ["x"] = x, ["y"] = y,
                                        ["name"] = Farming.CropName(dirt.crop),
                                        ["ready"] = ready,
                                        ["watered"] = watered,
                                        ["dead"] = dirt.crop.dead.Value,
                                        ["stage"] = $"{Math.Min(dirt.crop.currentPhase.Value + 1, Math.Max(1, dirt.crop.phaseDays.Count))}/{Math.Max(1, dirt.crop.phaseDays.Count)}",
                                        ["dist"] = (int)dist,
                                    });
                                }
                                break;
                            }
                            case HoeDirt dirt2:
                                if (soil.Count < 8)
                                    soil.Add(new Dictionary<string, object> { ["x"] = x, ["y"] = y, ["watered"] = dirt2.isWatered(), ["dist"] = (int)dist });
                                break;
                            case Tree tree:
                                if (trees.Count < 8)
                                {
                                    string id = body.Handles.Register(new Handle { Kind = "tree", Label = TreeName(tree), Tile = new Point(x, y), LocationName = loc.NameOrUniqueName });
                                    trees.Add(new Dictionary<string, object>
                                    {
                                        ["handle"] = id, ["x"] = x, ["y"] = y,
                                        ["kind"] = TreeName(tree),
                                        ["grown"] = tree.growthStage.Value >= 5,
                                        ["stage"] = tree.growthStage.Value,
                                        ["dist"] = (int)dist,
                                    });
                                }
                                break;
                            case FruitTree ft:
                                if (trees.Count < 8)
                                {
                                    string id = body.Handles.Register(new Handle { Kind = "fruittree", Label = "fruit tree", Tile = new Point(x, y), LocationName = loc.NameOrUniqueName });
                                    trees.Add(new Dictionary<string, object>
                                    {
                                        ["handle"] = id, ["x"] = x, ["y"] = y,
                                        ["kind"] = "fruit tree",
                                        ["fruit"] = ft.fruit.Count,
                                        ["dist"] = (int)dist,
                                    });
                                }
                                break;
                        }
                    }

                    if (loc.objects.TryGetValue(v, out SObject obj) && obj != null)
                    {
                        if (obj is Chest chest)
                        {
                            if (chests.Count < 4)
                            {
                                string id = body.Handles.Register(new Handle { Kind = "chest", Label = "chest", Tile = new Point(x, y), LocationName = loc.NameOrUniqueName });
                                chests.Add(new Dictionary<string, object>
                                {
                                    ["handle"] = id, ["x"] = x, ["y"] = y,
                                    ["items"] = chest.Items.Count(i => i != null),
                                    ["dist"] = (int)dist,
                                });
                            }
                        }
                        else if (obj.IsTwig()) twigs++;
                        else if (obj.IsWeeds()) weeds++;
                        else if (obj.IsBreakableStone() || obj.Name == "Stone")
                        {
                            stones++;
                            if (rocks.Count < 8)
                            {
                                string id = body.Handles.Register(new Handle { Kind = "rock", Label = obj.DisplayName, Tile = new Point(x, y), LocationName = loc.NameOrUniqueName });
                                rocks.Add(new Dictionary<string, object> { ["handle"] = id, ["x"] = x, ["y"] = y, ["kind"] = RockName(obj), ["dist"] = (int)dist });
                            }
                        }
                        else if (obj.IsSpawnedObject || obj.isForage())
                        {
                            if (forage.Count < 8)
                            {
                                string id = body.Handles.Register(new Handle { Kind = "forage", Label = obj.DisplayName, Tile = new Point(x, y), LocationName = loc.NameOrUniqueName });
                                forage.Add(new Dictionary<string, object> { ["handle"] = id, ["x"] = x, ["y"] = y, ["name"] = obj.DisplayName, ["dist"] = (int)dist });
                            }
                        }
                        else if (obj.bigCraftable.Value)
                        {
                            if (machines.Count < 6)
                            {
                                string id = body.Handles.Register(new Handle { Kind = "machine", Label = obj.DisplayName, Tile = new Point(x, y), LocationName = loc.NameOrUniqueName });
                                machines.Add(new Dictionary<string, object>
                                {
                                    ["handle"] = id, ["x"] = x, ["y"] = y,
                                    ["name"] = obj.DisplayName,
                                    ["ready"] = obj.readyForHarvest.Value,
                                    ["minutes"] = obj.MinutesUntilReady,
                                    ["holding"] = obj.heldObject.Value?.DisplayName,
                                    ["dist"] = (int)dist,
                                });
                            }
                        }
                    }

                    if (loc is MineShaft && ladders.Count < 4)
                    {
                        int idx = -1;
                        try { idx = loc.getTileIndexAt(x, y, "Buildings"); } catch { }
                        if (idx == 173 || idx == 174)
                        {
                            string kind = idx == 173 ? "ladder" : "shaft";
                            string id = body.Handles.Register(new Handle { Kind = kind, Label = kind, Tile = new Point(x, y), LocationName = loc.NameOrUniqueName });
                            ladders.Add(new Dictionary<string, object> { ["handle"] = id, ["x"] = x, ["y"] = y, ["kind"] = kind, ["dist"] = (int)dist });
                        }
                    }
                }
            }

            // Resource clumps (boulders, stumps, logs) are not per-tile objects.
            if (loc.resourceClumps != null)
            {
                foreach (ResourceClump c in loc.resourceClumps)
                {
                    if (c == null) continue;
                    float dist = Vector2.Distance(c.Tile, me);
                    if (dist > r + 2) continue;
                    bool woody = c.parentSheetIndex.Value == ResourceClump.stumpIndex || c.parentSheetIndex.Value == ResourceClump.hollowLogIndex;
                    string kind = ClumpName(c.parentSheetIndex.Value);
                    string id = body.Handles.Register(new Handle { Kind = woody ? "tree" : "rock", Label = kind, Tile = c.Tile.ToPoint(), LocationName = loc.NameOrUniqueName });
                    var row = new Dictionary<string, object> { ["handle"] = id, ["x"] = (int)c.Tile.X, ["y"] = (int)c.Tile.Y, ["kind"] = kind, ["big"] = true, ["dist"] = (int)dist };
                    if (woody) { if (trees.Count < 10) trees.Add(row); }
                    else { if (rocks.Count < 10) rocks.Add(row); }
                }
            }

            foreach (var list in new[] { crops, soil, trees, rocks, forage, chests, machines, ladders })
                list.Sort((a, b) => ((int)a["dist"]).CompareTo((int)b["dist"]));

            return new Dictionary<string, object>
            {
                ["radius"] = r,
                ["crops"] = crops,
                ["soil"] = soil,
                ["trees"] = trees,
                ["rocks"] = rocks,
                ["forage"] = forage,
                ["chests"] = chests,
                ["machines"] = machines,
                ["ladders"] = ladders,
                ["water"] = water.HasValue ? new Dictionary<string, object> { ["x"] = water.Value.X, ["y"] = water.Value.Y, ["dist"] = (int)waterDist } : null,
                ["counts"] = new Dictionary<string, object>
                {
                    ["crops"] = allCrops, ["dryCrops"] = dryCrops, ["readyCrops"] = readyCrops,
                    ["twigs"] = twigs, ["weeds"] = weeds, ["stones"] = stones,
                    ["emptySoil"] = soil.Count,
                },
            };
        }

        /*********
        ** Entities, warps, player
        *********/
        private static List<Dictionary<string, object>> Entities(SeiBody body, GameLocation loc, Vector2 me)
        {
            var list = new List<Dictionary<string, object>>();
            foreach (Farmer f in Game1.getOnlineFarmers())
            {
                if (f.currentLocation != loc) continue;
                string id = body.Handles.Register(new Handle { Kind = "player", Label = f.Name, Farmer = f, LocationName = loc.NameOrUniqueName });
                list.Add(new Dictionary<string, object>
                {
                    ["handle"] = id, ["kind"] = "player", ["name"] = f.Name,
                    ["farmerId"] = f.UniqueMultiplayerID.ToString(),
                    ["isHost"] = ReferenceEquals(f, Game1.player),
                    ["x"] = (int)f.Tile.X, ["y"] = (int)f.Tile.Y,
                    ["dist"] = (int)Vector2.Distance(f.Tile, me),
                    ["pinned"] = true,
                });
            }
            foreach (NPC c in loc.characters)
            {
                if (c == null || ReferenceEquals(c, body.Npc)) continue;
                float dist = Vector2.Distance(c.Tile, me);
                if (dist > EntityRadius) continue;
                string kind;
                if (c is Monster) kind = "monster";
                else if (c is Pet) kind = "pet";
                else if (c is Horse) kind = "horse";
                else if (c is Child) kind = "child";
                else if (c.Name != null && c.Name.StartsWith("Sei_")) kind = "companion";
                else kind = "villager";
                string label = kind == "companion" ? c.displayName : (c.displayName ?? c.Name);
                string id = body.Handles.Register(new Handle { Kind = kind, Label = label, Character = c, LocationName = loc.NameOrUniqueName });
                var row = new Dictionary<string, object>
                {
                    ["handle"] = id, ["kind"] = kind, ["name"] = label,
                    ["x"] = (int)c.Tile.X, ["y"] = (int)c.Tile.Y, ["dist"] = (int)dist,
                };
                if (c is Monster m)
                {
                    row["health"] = m.Health;
                    row["maxHealth"] = m.MaxHealth;
                }
                list.Add(row);
            }
            foreach (KeyValuePair<long, FarmAnimal> pair in loc.animals.Pairs)
            {
                FarmAnimal a = pair.Value;
                if (a == null) continue;
                float dist = Vector2.Distance(a.Tile, me);
                if (dist > EntityRadius) continue;
                string id = body.Handles.Register(new Handle { Kind = "animal", Label = a.displayName, Character = a, LocationName = loc.NameOrUniqueName });
                list.Add(new Dictionary<string, object>
                {
                    ["handle"] = id, ["kind"] = "animal", ["name"] = $"{a.displayName} ({a.type.Value})",
                    ["x"] = (int)a.Tile.X, ["y"] = (int)a.Tile.Y, ["dist"] = (int)dist,
                });
            }
            list.Sort((a, b) =>
            {
                bool pa = a.ContainsKey("pinned"), pb = b.ContainsKey("pinned");
                if (pa != pb) return pa ? -1 : 1;
                return ((int)a["dist"]).CompareTo((int)b["dist"]);
            });
            if (list.Count > 12) list.RemoveRange(12, list.Count - 12);
            return list;
        }

        private static List<Dictionary<string, object>> Warps(SeiBody body, GameLocation loc, Vector2 me)
        {
            var list = new List<Dictionary<string, object>>();
            foreach (Hop hop in Router.Exits(loc))
            {
                float dist = Vector2.Distance(new Vector2(hop.StandTile.X, hop.StandTile.Y), me);
                if (dist > WarpRadius) continue;
                string id = body.Handles.Register(new Handle { Kind = "warp", Label = hop.TargetName, Tile = hop.StandTile, LocationName = loc.NameOrUniqueName });
                list.Add(new Dictionary<string, object> { ["handle"] = id, ["to"] = hop.TargetName, ["x"] = hop.StandTile.X, ["y"] = hop.StandTile.Y, ["dist"] = (int)dist });
            }
            list.Sort((a, b) => ((int)a["dist"]).CompareTo((int)b["dist"]));
            if (list.Count > 6) list.RemoveRange(6, list.Count - 6);
            return list;
        }

        private static Dictionary<string, object> PlayerInfo(SeiBody body, GameLocation loc, Vector2 me)
        {
            Farmer who = body.ResolvePlayer(body.FollowTarget) ?? Game1.player;
            if (who?.currentLocation == null) return null;
            bool same = who.currentLocation == loc;
            return new Dictionary<string, object>
            {
                ["name"] = who.Name,
                ["farmerId"] = who.UniqueMultiplayerID.ToString(),
                ["location"] = who.currentLocation.NameOrUniqueName,
                ["x"] = (int)who.Tile.X,
                ["y"] = (int)who.Tile.Y,
                ["sameLocation"] = same,
                ["dist"] = same ? (int)Vector2.Distance(who.Tile, me) : -1,
            };
        }

        /*********
        ** Naming helpers
        *********/
        public static string Weather()
        {
            if (Game1.isLightning) return "storm";
            if (Game1.isRaining) return "rain";
            if (Game1.isSnowing) return "snow";
            if (Game1.isDebrisWeather) return "windy";
            return "sunny";
        }

        public static string TimeText(int t)
        {
            int hour = t / 100, minute = t % 100;
            string suffix = hour >= 12 && hour < 24 ? "PM" : "AM";
            int h12 = hour % 12; if (h12 == 0) h12 = 12;
            if (hour >= 24) { h12 = hour - 24; if (h12 == 0) h12 = 12; suffix = "AM"; }
            return $"{h12}:{minute:00} {suffix}";
        }

        private static string SafeDayName()
        {
            try { return Game1.shortDayNameFromDayOfSeason(Game1.dayOfMonth); } catch { return ""; }
        }

        private static bool SafeIsDark(GameLocation loc)
        {
            try { return Game1.isDarkOut(loc); } catch { return false; }
        }

        private static string FacingName(int d) => d switch { 0 => "up", 1 => "right", 2 => "down", 3 => "left", _ => "down" };

        private static string LocationKind(GameLocation loc)
        {
            if (loc is MineShaft) return "mine";
            if (loc.IsFarm) return "farm";
            if (loc is FarmHouse) return "farmhouse";
            if (!loc.IsOutdoors) return "indoors";
            string n = loc.Name ?? "";
            if (n == "Town" || n == "Beach" || n == "Forest" || n == "Mountain" || n == "BusStop" || n == "Backwoods" || n == "Railroad" || n == "Desert" || n == "Woods") return "outdoors";
            return "outdoors";
        }

        private static string TreeName(Tree tree)
        {
            if (tree.stump.Value) return "stump";
            string t = tree.treeType.Value ?? "";
            return t switch
            {
                "1" => "oak", "2" => "maple", "3" => "pine", "6" => "palm", "7" => "mushroom tree", "8" => "mahogany", "9" => "palm",
                "10" => "green rain tree", "11" => "green rain tree", "12" => "green rain tree", "13" => "mystic tree",
                _ => "tree",
            };
        }

        private static string RockName(SObject obj)
        {
            string n = (obj.Name ?? "").ToLowerInvariant();
            if (n.Contains("ore") || n.Contains("node")) return obj.DisplayName;
            string id = obj.ItemId ?? "";
            return id switch
            {
                "751" => "copper node", "290" => "iron node", "764" => "gold node", "765" => "iridium node",
                "95" => "mystic stone", "843" or "844" => "cinder shard node", "819" => "omni geode node",
                "44" or "46" => "gem node", "2" or "4" or "6" or "8" or "10" or "12" or "14" => "gem node",
                _ => "stone",
            };
        }

        private static string ClumpName(int idx)
        {
            return idx switch
            {
                ResourceClump.stumpIndex => "large stump",
                ResourceClump.hollowLogIndex => "hollow log",
                ResourceClump.meteoriteIndex => "meteorite",
                ResourceClump.boulderIndex => "boulder",
                ResourceClump.mineRock1Index or ResourceClump.mineRock2Index or ResourceClump.mineRock3Index or ResourceClump.mineRock4Index => "large rock",
                ResourceClump.quarryBoulderIndex => "quarry boulder",
                _ => "boulder",
            };
        }
    }
}
