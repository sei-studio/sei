#nullable enable

using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;

namespace NeuroSdk.Json
{
    public static class JTokenWrapperExtensions
    {
        public static T? GetValue<T>(this IJTokenWrapper data, string key, T? defaultValue)
        {
            JsonNode? jToken = data.Data?[key];
            return jToken != null ? jToken.GetValue<T>() : defaultValue;
        }

        public static T? GetValue<T>(this IJTokenWrapper data, string key) where T : class
        {
            JsonNode? jToken = data.Data?[key];
            return jToken?.GetValue<T>();
        }

        public static IEnumerable<T?> GetArray<T>(this IJTokenWrapper data, string key)
        {
            return data.Data?[key]?.AsArray().GetValues<T>() ?? Enumerable.Empty<T?>();
        }
    }
}
