

using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Models;

namespace Sts2Agent.Utilities;


public static class CreatureHelper
{

    public static string GetUniqueName(this Creature creature, bool list_unique, int index)
    {
        return list_unique ? creature.Name : $"'{index}': " + creature.Name;

    }
    public static bool CreaturesAreDistinct(this IReadOnlyList<Creature> list)
    {
        return list.Count == list.DistinctBy((e) => e.Name).Count();
    }

    public static IEnumerable<string> GetUniqueNames(this IReadOnlyList<Creature> list)
    {
        var is_distinct = CreaturesAreDistinct(list);
        return list.Select(
                (e, i) =>
                {
                    return e.GetUniqueName(is_distinct, i);
                });
    }
    public static Creature? GetUniqueCreature(this IReadOnlyList<Creature> list, string target)
    {
        var is_distinct = CreaturesAreDistinct(list);
        return list.Where((e, i) =>
        {
            var uniquename = e.GetUniqueName(is_distinct, i);
            Plugin.LogDebug($"{uniquename} == {target}");
            return uniquename == target;
        }).FirstOrDefault();
    }

}
