#nullable enable

using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Godot;
using NeuroSdk.Messages.Outgoing;
using NeuroSdk.Websocket;

namespace NeuroSdk.Actions
{
    public sealed class NeuroActionHandler : Node
    {
        private static List<INeuroAction> _currentlyRegisteredActions = new();
        private static readonly List<INeuroAction> _dyingActions = new();

        public static INeuroAction? GetRegistered(string name) => _currentlyRegisteredActions.FirstOrDefault(a => a.Name == name);
        public static bool IsRecentlyUnregistered(string name) => _dyingActions.Any(a => a.Name == name);

        public void Quit()
        {
            WebsocketConnection.Instance!.SendImmediate(new ActionsUnregister(_currentlyRegisteredActions));
            _currentlyRegisteredActions = null!;
        }

        public static void RegisterActions(IReadOnlyCollection<INeuroAction> newActions)
        {
            _currentlyRegisteredActions.RemoveAll(oldAction => newActions.Any(newAction => oldAction.Name == newAction.Name));
            _dyingActions.RemoveAll(oldAction => newActions.Any(newAction => oldAction.Name == newAction.Name));
            _currentlyRegisteredActions.AddRange(newActions);
            WebsocketConnection.Instance!.Send(new ActionsRegister(newActions));
        }

        public static void RegisterActions(params INeuroAction[] newActions)
            => RegisterActions((IReadOnlyCollection<INeuroAction>)newActions);

        public static void UnregisterActions(IEnumerable<string> removeActionsList)
        {
            INeuroAction[] actionsToRemove = _currentlyRegisteredActions.Where(oldAction => removeActionsList.Any(removeAction => oldAction.Name == removeAction)).ToArray();

            _currentlyRegisteredActions.RemoveAll(actionsToRemove.Contains);
            _dyingActions.AddRange(actionsToRemove);

            WebsocketConnection connection = WebsocketConnection.Instance!;
            removeActions();
            connection.Send(new ActionsUnregister(removeActionsList));

            return;

            async void removeActions()
            {
                await Task.Delay(10 * 1000); //Wait for 10 seconds
                _dyingActions.RemoveAll(actionsToRemove.Contains);
            }
        }

        public static void UnregisterActions(IEnumerable<INeuroAction> removeActionsList)
            => UnregisterActions(removeActionsList.Select(a => a.Name));

        public static void UnregisterActions(params INeuroAction[] removeActionsList)
            => UnregisterActions((IReadOnlyCollection<INeuroAction>)removeActionsList);

        public static void UnregisterActions(params string[] removeActionNamesList)
            => UnregisterActions((IReadOnlyCollection<string>)removeActionNamesList);

        public static void ResendRegisteredActions()
        {
            WebsocketConnection.Instance!.Send(new ActionsRegister(_currentlyRegisteredActions));
        }
    }
}
