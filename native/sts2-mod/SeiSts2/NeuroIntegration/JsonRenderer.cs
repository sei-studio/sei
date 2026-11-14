using System.Text;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Models;
using Sts2Agent;
using Sts2Agent.Utilities;

namespace STS2NeuroIntegration;

public static class Renderer
{
    public static void RepresentDeck(this StringBuilder stringBuilder, IEnumerable<CardModel> deck, PileType pile = PileType.Deck)
    {
        var countedGroup = deck.GroupBy((card) => card.Title + $"{card.EnergyCost}{card.CurrentStarCost}");
        foreach (var cards in countedGroup)
        {
            var firstCard = cards.First();
            var description = TextHelper.GetCardDescriptionFor(firstCard, pile);
            var energyCost = firstCard.EnergyCost.GetAmountToSpend() + " Energy";
            var starCost = firstCard.CanonicalStarCost != -1 ? $" and {firstCard.CurrentStarCost} Stars" : "";
            var line = $"- {cards.Count()}x {TextHelper.StripBBCode(firstCard.Title)} \"{description}\" and costs {energyCost}{starCost}";
            stringBuilder.AppendLine(line);
        }
    }
    public static void GetIndexedCardNames(this StringBuilder stringBuilder, IEnumerable<CardModel> cards)
    {
        int index = 0;
        foreach (var card in cards)
        {
            stringBuilder.AppendLine($"[{index}] {TextHelper.StripBBCode(card.Title)}");
            index++;
        }
    }
    public static void RepresentRelics(this StringBuilder stringBuilder, IEnumerable<RelicModel> relics)
    {

        var countedGroup = relics.GroupBy((relic) => relic.Title);
        foreach (var relic in countedGroup)
        {
            var firstRelic = relic.First();
            stringBuilder.AppendLine($"- {relic.Count()}x {TextHelper.StripBBCode(firstRelic.Title.GetFormattedText())} \"{TextHelper.GetRelicDescription(firstRelic)}\"");
        }
    }

    public static void RepresentStartingCharacter(this StringBuilder stringBuilder, CharacterModel character)
    {

        stringBuilder.AppendLine($"\"{TextHelper.GetCharacterDescription(character)}\"");
        stringBuilder.AppendLine("");
        stringBuilder.AppendLine($"Starts with {character.StartingHp} HP and {character.StartingGold} gold");
        stringBuilder.AppendLine($"Starting deck:");
        RepresentDeck(stringBuilder, character.StartingDeck);
        stringBuilder.AppendLine($"Starting relics:");
        RepresentRelics(stringBuilder, character.StartingRelics);
    }

    public static void RepresentEvents(this StringBuilder stringBuilder, List<GameEvent> events)
    {

        var combinedEvents = events.GroupBy(x => x.Message);
        foreach (var eventBetweenRounds in combinedEvents)
        {
            var firstEvent = eventBetweenRounds.First();
            var count = eventBetweenRounds.Count();
            if (count > 1)
            {
                stringBuilder.AppendLine($"- {firstEvent.Message}, {count} times");

            }
            else
            {
                stringBuilder.AppendLine($"- {firstEvent.Message}");
            }
        }
    }
}
