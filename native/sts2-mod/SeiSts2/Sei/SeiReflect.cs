#nullable enable

using System.Collections;
using System.Reflection;

namespace Sts2Agent.Sei;

/// <summary>
/// Sei: reflection reads for game members the upstream mod never touched, so
/// this mod compiles against any game build and degrades to "unknown" at
/// runtime instead of throwing a MissingMemberException. Every member read
/// this way is a guess at the game's API and is listed in README.md
/// "Unverified game API" until someone checks it against a real build.
/// </summary>
public static class SeiReflect
{
    private const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;

    /// <summary>The first readable property, field or zero-arg method among <paramref name="names"/>.</summary>
    public static object? Get(object? target, params string[] names)
    {
        if (target == null) return null;
        var type = target as Type ?? target.GetType();
        var instance = target is Type ? null : target;
        foreach (var name in names)
        {
            try
            {
                var prop = type.GetProperty(name, Flags);
                if (prop != null && prop.GetIndexParameters().Length == 0) return prop.GetValue(instance);
                var field = type.GetField(name, Flags);
                if (field != null) return field.GetValue(instance);
                var method = type.GetMethod(name, Flags, null, Type.EmptyTypes, null);
                if (method != null && method.ReturnType != typeof(void)) return method.Invoke(instance, null);
            }
            catch
            {
                // try the next name
            }
        }
        return null;
    }

    public static int? GetInt(object? target, params string[] names)
    {
        var v = Get(target, names);
        try
        {
            return v switch
            {
                null => null,
                int i => i,
                IConvertible c when v is not string && !(v is Enum) => Convert.ToInt32(c),
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }

    public static bool? GetBool(object? target, params string[] names) => Get(target, names) is bool b ? b : null;

    public static string? GetString(object? target, params string[] names)
    {
        var v = Get(target, names);
        return v?.ToString();
    }

    public static int? Count(object? collection)
    {
        if (collection == null) return null;
        if (collection is ICollection c) return c.Count;
        var n = GetInt(collection, "Count", "Length");
        if (n != null) return n;
        if (collection is IEnumerable e)
        {
            var i = 0;
            foreach (var _ in e) i++;
            return i;
        }
        return null;
    }

    /// <summary>A type by simple or full name from any loaded assembly (game types we do not reference directly).</summary>
    public static Type? FindType(params string[] names)
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type[] types;
            try { types = asm.GetTypes(); }
            catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray()!; }
            catch { continue; }
            foreach (var t in types)
            {
                if (t == null) continue;
                foreach (var n in names)
                {
                    if (t.FullName == n || t.Name == n) return t;
                }
            }
        }
        return null;
    }
}
