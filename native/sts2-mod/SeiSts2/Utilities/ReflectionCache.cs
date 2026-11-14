using System.Reflection;
using MegaCrit.Sts2.Core.Nodes.Combat;

namespace Sts2Agent.Utilities;

public static class ReflectionCache
{
    private const BindingFlags NonPublicInstance = BindingFlags.NonPublic | BindingFlags.Instance;

    public static readonly FieldInfo? HandConfirmButton =
        typeof(NPlayerHand).GetField("_selectModeConfirmButton", NonPublicInstance);

    public static readonly FieldInfo? HandPrefs =
        typeof(NPlayerHand).GetField("_prefs", NonPublicInstance);

    public static readonly FieldInfo? HandSelectedCards =
        typeof(NPlayerHand).GetField("_selectedCards", NonPublicInstance);
}
