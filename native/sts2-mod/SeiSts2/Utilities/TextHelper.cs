using System;
using System.Text;
using System.Text.RegularExpressions;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.Cards;
using MegaCrit.Sts2.GameInfo.Objects;

namespace Sts2Agent.Utilities;

public static class TextHelper
{
    private static readonly Regex ImgTagRegex = new(@"\[img[^\]]*\](.*?)\[/img\]", RegexOptions.Compiled);
    private static readonly Regex BbCodeRegex = new(@"\[/?[^\]]+\]", RegexOptions.Compiled);

    private static readonly Dictionary<char, string> _urlUnsafeChars = new()
    {
        ['+'] = "plus",
        ['-'] = "minus",
        [' '] = "_",
        ['&'] = "and",
        ['%'] = "percent",
        ['#'] = "hash",
        ['@'] = "at",
        ['!'] = "excl",
        ['?'] = "q",
        ['='] = "eq",
        ['/'] = "slash",
        ['\\'] = "backslash",
        ['.'] = "dot",
        [','] = "comma",
        [';'] = "semi",
        [':'] = "colon",
        ['\''] = "apos",
        ['"'] = "quot",
        ['<'] = "lt",
        ['>'] = "gt",
        ['['] = "lbracket",
        [']'] = "rbracket",
        ['{'] = "lbrace",
        ['}'] = "rbrace",
        ['('] = "lparen",
        [')'] = "rparen",
        ['*'] = "star",
        ['^'] = "caret",
        ['~'] = "tilde",
        ['`'] = "grave",
        ['|'] = "pipe",
    };

    private static string SanitizeName(string name)
    {
        var sb = new StringBuilder();
        foreach (char c in name)
        {
            if (_urlUnsafeChars.TryGetValue(c, out var replacement))
            {

                if (replacement != "_")
                    sb.Append($"_{replacement}");
                else
                {
                    sb.Append($"{replacement}");
                }
            }
            else
                sb.Append(c);
        }
        return sb.ToString();
    }


    public static string StripBBCode(string text)
    {
        if (string.IsNullOrEmpty(text))
            return text;

        text = ImgTagRegex.Replace(text, match => GetLocalizedIconText(match.Groups[1].Value));
        return BbCodeRegex.Replace(text, "").Replace("\n", " ").Trim();
    }

    public static string GetUnformattedText(this LocString locString)
    {
        return StripBBCode(locString.GetFormattedText());
    }

    public static string GetActionNameFor(string Title)
    {
        return SanitizeName(Title.ToLowerInvariant());
    }
    public static string GetActionName(this LocString locString)
    {
        return GetActionNameFor(SafeLocString(() => locString));
    }

    public static string AsSingleLine(this LocString locString)
    {
        return SafeLocString(() => locString).Replace('\n', ' ');
    }
    public static string AsSingleLine(this string desc)
    {
        return desc.Replace('\n', ' ');
    }

    public static string SafeLocString(Func<object> getter)
    {
        try
        {
            var val = getter();
            if (val is LocString loc)
                return StripBBCode(loc.GetFormattedText());
            return StripBBCode(val?.ToString() ?? "");
        }
        catch
        {
            return "???";
        }
    }
    public static string GetCharacterDescription(CharacterModel character)
    {
        try
        {
            var table = LocManager.Instance.GetTable("characters");
            return StripBBCode(table.GetRawText(character.CharacterSelectDesc));
        }
        catch
        {
            return SafeLocString(() => character.CharacterSelectDesc);
        }
    }

    public static string GetCardDescriptionFor(CardModel card, PileType pile)
    {
        return StripBBCode(card.GetDescriptionForPile(pile));
    }
    public static string GetCardDescription(CardModel card)
    {
        try
        {
            LocString desc = card.Description;
            card.DynamicVars.AddTo(desc);
            desc.Add("OnTable", true);
            desc.Add("InCombat", CombatManager.Instance?.IsInProgress ?? false);
            StringBuilder sb = new();
            foreach (var keyword in card.Keywords)
            {
                sb.Append(Enum.GetName(keyword) + ". ");
            }
            return StripBBCode(desc.GetFormattedText()) + sb.ToString();
        }
        catch
        {
            Plugin.LogError($"Couldn't resolve Card description for card: {card.Title}");
            return SafeLocString(() => card.Description);
        }
    }

    public static string? GetCardDescriptionFromNode(NCard cardNode)
    {
        try
        {
            var label = cardNode.GetNode<Godot.RichTextLabel>("%DescriptionLabel");
            if (label == null) return null;
            var text = label.Text;
            if (string.IsNullOrEmpty(text)) return null;
            return StripBBCode(text);
        }
        catch
        {
            return null;
        }
    }

    public static string GetRelicDescription(RelicModel relic)
    {
        try
        {
            return StripBBCode(relic.DynamicDescription.GetFormattedText());
        }
        catch
        {
            return SafeLocString(() => relic.DynamicDescription);
        }
    }

    public static string GetPotionDescription(PotionModel potion)
    {
        try
        {
            return StripBBCode(potion.DynamicDescription.GetFormattedText());
        }
        catch
        {
            return SafeLocString(() => potion.DynamicDescription);
        }
    }

    public static string GetPowerDescription(PowerModel power)
    {
        try
        {
            LocString desc = power.Description;
            power.DynamicVars.AddTo(desc);
            desc.Add("Amount", power.Amount);
            return StripBBCode(desc.GetFormattedText());
        }
        catch
        {
            return "???";
        }
    }

    //TODO: Fix Icon text just being duplicated. convert StarsStarsStart to 3x Stars. and so on
    private static string GetLocalizedIconText(string iconPath)
    {
        try
        {
            var table = LocManager.Instance.GetTable("static_hover_tips");
            if (iconPath.Contains("energy_icon"))
                return table.GetRawText("ENERGY.title");
            if (iconPath.Contains("star_icon"))
                return table.GetRawText("STAR_COUNT.title");
        }
        catch { }
        return "";
    }

    public static string GetCardCosts(CardModel card)
    {
        var costs = new List<string>
        {
            $"Cost: {card.EnergyCost.GetAmountToSpend()} Energy"
        };
        if (card.CurrentStarCost > 0)
            costs.Add($" and {card.CurrentStarCost} Stars");
        return string.Join("", costs);
    }

    public static void AppendPlayableCards(StringBuilder stringBuilder, IReadOnlyList<CardModel> cards, bool allHandCards = true)
    {
        for (int i = 0; i < cards.Count; i++)
        {
            if (allHandCards || cards[i].CanPlay())
                stringBuilder.AppendLine($"- `{i}`: {StripBBCode(cards[i].Title)} ({GetCardCosts(cards[i])})");
        }
    }
    public static string GetAvailableCardsActionText(Player player, bool allHandCards = false)
    {
        var pcs = player.PlayerCombatState;
        if (pcs == null) return "No player combat state";
        if (pcs.Hand.Cards.Count == 0) return "Your hand is empty";
        var text = new StringBuilder();
        AppendPlayableCards(text, pcs.Hand.Cards, allHandCards);
        return text.ToString();
    }
}
