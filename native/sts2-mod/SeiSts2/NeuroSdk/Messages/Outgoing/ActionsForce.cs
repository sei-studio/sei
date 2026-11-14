#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using NeuroSdk.Actions;
using NeuroSdk.Messages.API;

namespace NeuroSdk.Messages.Outgoing
{
    public sealed class ActionsForce : OutgoingMessageBuilder
    {
        public enum Priority
        {
            /// <summary>
            /// Neuro will finish speaking before responding.
            /// </summary>
            Low,
            /// <summary>
            /// Neuro will finish speaking before responding, but will finish her current utterance sooner.
            /// </summary>
            Medium,
            /// <summary>
            /// Neuro will process the action force immediately, shortening her utterance and responding right after.
            /// </summary>
            High,
            /// <summary>
            /// Neuro will be interrupted immediately to respond to the action force.
            /// </summary>
            Critical
        }

        public ActionsForce(string query, string? state, bool? ephemeralContext, Priority priority, IEnumerable<INeuroAction> actions)
        {
            if (!Enum.IsDefined(typeof(Priority), priority))
            {
                throw new ArgumentOutOfRangeException(nameof(priority), "Invalid priority value.");
            }

            _query = query;
            _state = state;
            _ephemeralContext = ephemeralContext;
            _actionNames = actions.Select(a => a.Name).ToArray();
            _priority = priority.ToString().ToLowerInvariant();
            // Sei: the structured state rides on every force (PROTOCOL.md "SeiState"), and a force is now pending.
            _seiState = Sts2Agent.Sei.SeiState.Current();
            Sts2Agent.Sei.SeiState.MarkForceSent();
        }

        public ActionsForce(string query, string? state, bool? ephemeralContext, Priority priority, params INeuroAction[] actions)
            : this(query, state, ephemeralContext, priority, (IEnumerable<INeuroAction>)actions)
        {
        }

        protected override string Command => "actions/force";

        [JsonInclude, JsonPropertyName("state")]
        private readonly string? _state;

        [JsonInclude, JsonPropertyName("query")]
        private readonly string _query;

        [JsonInclude, JsonPropertyName("ephemeral_context")]
        private readonly bool? _ephemeralContext;

        [JsonInclude, JsonPropertyName("action_names")]
        private readonly string[] _actionNames;

        [JsonInclude, JsonPropertyName("priority")]
        private readonly string _priority;

        // Sei: structured state (null is dropped by the serializer).
        [JsonInclude, JsonPropertyName("sei_state")]
        private readonly System.Text.Json.Nodes.JsonObject? _seiState;
    }
}
