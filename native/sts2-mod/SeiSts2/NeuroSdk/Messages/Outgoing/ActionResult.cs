#nullable enable

using System.Text.Json.Serialization;
using NeuroSdk.Messages.API;
using NeuroSdk.Websocket;

namespace NeuroSdk.Messages.Outgoing
{
    public sealed class ActionResult : OutgoingMessageBuilder
    {
        public ActionResult(string id, ExecutionResult result)
        {
            _id = id;
            _success = result.Successful;
            _message = result.Message;
            // Sei: a successful action answers the pending force (the bot clears it too); a failed one leaves it open.
            if (_success) Sts2Agent.Sei.SeiState.MarkForceAnswered();
        }

        protected override string Command => "action/result";

        [JsonInclude, JsonPropertyName("id")]
        private readonly string _id;

        [JsonInclude, JsonPropertyName("success")]
        private readonly bool _success;

        [JsonInclude, JsonPropertyName("message")]
        private readonly string? _message;
    }
}
