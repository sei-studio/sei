#nullable enable

using System;
using NeuroSdk.Websocket;

namespace NeuroSdk.Messages.API
{
    public abstract class OutgoingMessageBuilder
    {
        protected abstract string Command { get; }

        protected virtual object? Data => this;

        public virtual bool Merge(OutgoingMessageBuilder other) => false;

        public WsMessage GetWsMessage() => new(Command, Data, WebsocketConnection.Instance?.game ?? throw new InvalidOperationException("Cannot get WsMessage without a WebsocketConnection instance."));
    }
}
