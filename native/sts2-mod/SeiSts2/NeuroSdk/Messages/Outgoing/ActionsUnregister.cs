#nullable enable

using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using NeuroSdk.Actions;
using NeuroSdk.Messages.API;

namespace NeuroSdk.Messages.Outgoing
{
    public sealed class ActionsUnregister : OutgoingMessageBuilder
    {
        public ActionsUnregister(IEnumerable<string> actionNames)
        {
            Names = actionNames.ToList();
        }

        public ActionsUnregister(IEnumerable<INeuroAction> actions) : this(actions.Select(a => a.Name))
        {
        }

        public ActionsUnregister(params INeuroAction[] actions) : this((IEnumerable<INeuroAction>)actions)
        {
        }

        public ActionsUnregister(params string[] actionNames) : this((IEnumerable<string>)actionNames)
        {
        }

        protected override string Command => "actions/unregister";

        [JsonInclude, JsonPropertyName("action_names")]
        public readonly List<string> Names;

        public override bool Merge(OutgoingMessageBuilder other)
        {
            if (other is ActionsUnregister actionsUnregister)
            {
                Names.RemoveAll(existingName => actionsUnregister.Names.Contains(existingName));
                Names.AddRange(actionsUnregister.Names);
                return true;
            }

            return false;
        }
    }
}
