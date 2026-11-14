#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace NeuroSdk.Internal
{
    internal static class ReflectionHelpers
    {
        public static IEnumerable<T?> GetAllInAssembly<T>(Assembly assembly)
        {
            IEnumerable<Type> types = assembly.GetTypes()
                .Where(type => !type.IsAbstract)
                .Where(type => typeof(T).IsAssignableFrom(type));

            foreach (Type type in types)
            {
                if (type.GetMethod("CreateInstance", BindingFlags.Static | BindingFlags.Public) is { } method)
                {
                    yield return (T?)method.Invoke(null, null);
                }
                else
                {
                    yield return (T?)Activator.CreateInstance(type);
                }
            }
        }
    }
}
