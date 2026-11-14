#nullable enable

using System.Text.Json.Serialization;
using NeuroSdk.Json;

namespace NeuroSdk.Actions
{
    public readonly struct WsAction
    {
        public WsAction(string name, string description, JsonSchema? schema)
        {
            Name = name;
            _description = description;
            _schema = schema;
        }

        [JsonInclude, JsonPropertyName("name")]
        public readonly string Name;

        [JsonInclude, JsonPropertyName("description")]
        private readonly string _description;

        [JsonInclude, JsonPropertyName("schema")]
        private readonly JsonSchema? _schema;
    }
}
