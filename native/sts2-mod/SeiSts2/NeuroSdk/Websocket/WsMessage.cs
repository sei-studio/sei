#nullable enable

using System.Text.Json.Serialization;

namespace NeuroSdk.Websocket
{
    public record WsMessage
    {
        public WsMessage(string command, object? data, string game)
        {
            Command = command;
            _game = game;
            Data = data;
        }

        [JsonInclude, JsonPropertyName("command")]
        public readonly string Command;

        [JsonInclude, JsonPropertyName("game")]
        private readonly string _game;

        [JsonInclude, JsonPropertyName("data")]
        public readonly object? Data;
    }
}
