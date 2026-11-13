using System;
using System.Collections.Generic;
using System.Linq;
using StardewValley;
using SeiCompanion.Body;

namespace SeiCompanion.Observe
{
    /// <summary>
    /// Birthdays and gift tastes for the observation (mod 0.1.4). The
    /// companion cannot gift villagers herself; this is so she can tell the
    /// player whose birthday it is and what in either bag someone would love.
    /// Reads the game's own data (NPC.isBirthday, Birthday_Season/Day,
    /// getGiftTasteForThisItem, the host's friendshipData), the same calls
    /// StardewAutoPilot's Social.cs makes (Apache-2.0; approach only).
    /// Kept small: birthdays only when there is one today or tomorrow, gift
    /// ideas only for villagers in view, at most two each.
    /// </summary>
    public static class Social
    {
        private const int TasteLove = 0;
        private const int TasteLike = 2;
        private const int IdeaCacheTicks = 300;
        private const int MaxIdeas = 2;

        private static int _birthdayStamp = -1;
        private static Dictionary<string, object> _birthdays;
        private static readonly Dictionary<string, (int Tick, List<Dictionary<string, object>> Ideas)> IdeaCache =
            new Dictionary<string, (int Tick, List<Dictionary<string, object>> Ideas)>();

        /// <summary>{today:[names], tomorrow:[names]} or null when neither has one. Recomputed once a day.</summary>
        public static Dictionary<string, object> Birthdays()
        {
            int stamp = (int)Game1.stats.DaysPlayed;
            if (_birthdayStamp == stamp)
                return _birthdays;
            var today = new List<string>();
            var tomorrow = new List<string>();
            string season = Game1.currentSeason;
            int day = Game1.dayOfMonth;
            string nextSeason = day >= 28 ? NextSeason(season) : season;
            int nextDay = day >= 28 ? 1 : day + 1;
            try
            {
                foreach (NPC npc in Utility.getAllVillagers())
                {
                    if (npc == null || !npc.CanSocialize) continue;
                    // Interpolated, so it reads the same whether the game types
                    // it as a season key string or a Season value.
                    string bs = $"{npc.Birthday_Season}";
                    int bd = npc.Birthday_Day;
                    if (string.IsNullOrEmpty(bs) || bd <= 0) continue;
                    if (npc.isBirthday()) today.Add(npc.displayName);
                    else if (bd == nextDay && string.Equals(bs, nextSeason, StringComparison.OrdinalIgnoreCase)) tomorrow.Add(npc.displayName);
                }
            }
            catch { }
            _birthdays = today.Count + tomorrow.Count == 0
                ? null
                : new Dictionary<string, object> { ["today"] = today, ["tomorrow"] = tomorrow };
            _birthdayStamp = stamp;
            IdeaCache.Clear();
            return _birthdays;
        }

        private static string NextSeason(string season)
        {
            switch ((season ?? "").ToLowerInvariant())
            {
                case "spring": return "summer";
                case "summer": return "fall";
                case "fall": return "winter";
                default: return "spring";
            }
        }

        /// <summary>Adds the host's hearts, this week's gifts, a birthday flag and gift ideas to a villager's entity row.</summary>
        public static void Describe(NPC npc, Dictionary<string, object> row, SeiBody body)
        {
            try
            {
                if (!npc.CanSocialize) return;
                if (Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship f) && f != null)
                {
                    row["hearts"] = f.Points / 250;
                    if (f.GiftsThisWeek > 0) row["giftsThisWeek"] = f.GiftsThisWeek;
                    if (f.GiftsToday > 0) row["giftedToday"] = true;
                }
                if (npc.isBirthday()) row["birthday"] = true;
                List<Dictionary<string, object>> ideas = GiftIdeas(npc, body);
                if (ideas.Count > 0) row["gifts"] = ideas;
            }
            catch { }
        }

        /// <summary>Up to two items in the player's or her own bag this villager loves (first) or likes.</summary>
        public static List<Dictionary<string, object>> GiftIdeas(NPC npc, SeiBody body)
        {
            if (IdeaCache.TryGetValue(npc.Name, out var cached) && Game1.ticks - cached.Tick < IdeaCacheTicks)
                return cached.Ideas;
            var ideas = new List<Dictionary<string, object>>();
            try
            {
                if (npc.CanReceiveGifts())
                {
                    var loves = new List<(string Item, string Bag)>();
                    var likes = new List<(string Item, string Bag)>();
                    void Scan(IEnumerable<Item> items, string bag)
                    {
                        foreach (Item it in items)
                        {
                            if (it == null || it is Tool || !it.canBeGivenAsGift()) continue;
                            if (loves.Any(l => l.Item == it.DisplayName) || likes.Any(l => l.Item == it.DisplayName)) continue;
                            int taste;
                            try { taste = npc.getGiftTasteForThisItem(it); }
                            catch { continue; }
                            if (taste == TasteLove) loves.Add((it.DisplayName, bag));
                            else if (taste == TasteLike) likes.Add((it.DisplayName, bag));
                        }
                    }
                    Scan(Game1.player.Items, "player");
                    Scan(body.Shadow.Items, "yours");
                    foreach (var (item, bag) in loves.Take(MaxIdeas))
                        ideas.Add(new Dictionary<string, object> { ["item"] = item, ["taste"] = "love", ["bag"] = bag });
                    foreach (var (item, bag) in likes.Take(MaxIdeas - ideas.Count))
                        ideas.Add(new Dictionary<string, object> { ["item"] = item, ["taste"] = "like", ["bag"] = bag });
                }
            }
            catch { }
            IdeaCache[npc.Name] = (Game1.ticks, ideas);
            return ideas;
        }
    }
}
