#nullable enable

using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using NeuroSdk.Actions;
using NeuroSdk.Messages.API;

namespace NeuroSdk.Messages.Outgoing
{
    public sealed class ActionsRegister : OutgoingMessageBuilder
    {
        public ActionsRegister(IEnumerable<INeuroAction> actions)
        {
            Actions = actions.Select(action => action.GetWsAction()).ToList();
        }

        public ActionsRegister(params INeuroAction[] actions) : this((IEnumerable<INeuroAction>)actions)
        {
        }

        protected override string Command => "actions/register";

        [JsonInclude, JsonPropertyName("actions")]
        public readonly List<WsAction> Actions;

        public override bool Merge(OutgoingMessageBuilder other)
        {
            if (other is ActionsRegister actionsRegister)
            {
                Actions.RemoveAll(existingWsa => actionsRegister.Actions.Any(newWsa => newWsa.Name == existingWsa.Name));
                Actions.AddRange(actionsRegister.Actions);
                return true;
            }

            return false;
        }
    }
}
