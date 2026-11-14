#nullable enable

using System.Text.Json.Nodes;
using NeuroSdk.Json;

namespace NeuroSdk.Messages.API
{
    public readonly struct MessageJData : IJTokenWrapper
    {
        public JsonNode? Data { get; }


        public MessageJData(JsonNode? data)
        {
            Data = data;
        }
    };
}
