#nullable enable


using System.Text.Json.Nodes;

namespace NeuroSdk.Json
{
    public interface IJTokenWrapper
    {
        JsonNode? Data { get; }
    }
}
