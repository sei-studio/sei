#nullable enable

using System.Collections.Generic;
using Godot;
using NeuroSdk.Internal;
using NeuroSdk.Messages.API;
using NeuroSdk.Messages.Outgoing;

namespace NeuroSdk.Websocket
{
    // ReSharper disable once ClassWithVirtualMembersNeverInherited.Global
    public class MessageQueue : RefCounted
    {
        // ReSharper disable once MemberCanBePrivate.Global
        // Sei: no queued Startup. The handshake (startup + sei/hello) is sent on every
        // (re)connect by WebsocketConnection, ahead of anything queued.
        protected readonly List<OutgoingMessageBuilder> Messages = new();

        public virtual int Count
        {
            get
            {
                lock (Messages)
                {
                    return Messages.Count;
                }
            }
        }

        public virtual void Enqueue(OutgoingMessageBuilder message)
        {
            lock (Messages)
            {
                foreach (OutgoingMessageBuilder existingMessage in Messages)
                {
                    if (existingMessage.Merge(message)) return;
                }

                Messages.Add(message);
            }
        }

        // Sei: drop everything queued while disconnected (stale registers, forces, contexts).
        public virtual void Clear()
        {
            lock (Messages)
            {
                Messages.Clear();
            }
        }

        public virtual OutgoingMessageBuilder? Dequeue()
        {
            lock (Messages)
            {
                if (Messages.Count == 0) return null;

                OutgoingMessageBuilder message = Messages[0];
                Messages.RemoveAt(0);

                return message;
            }
        }
    }
}
