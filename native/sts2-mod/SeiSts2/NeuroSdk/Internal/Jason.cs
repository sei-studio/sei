
#nullable enable

using System.Text.Json;
using System.Text.Json.Serialization;

namespace NeuroSdk.Internal
{
    internal static class Jason
    {
        private static readonly JsonSerializerOptions _options = new()
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        public static string Serialize(object? value)
        {
            return JsonSerializer.Serialize(value, _options);
        }
    }
}
