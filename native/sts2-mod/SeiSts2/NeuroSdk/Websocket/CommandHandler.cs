#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Godot;
using NeuroSdk.Internal;
using NeuroSdk.Messages.API;
using Sts2Agent;
using STS2NeuroIntegration;

namespace NeuroSdk.Websocket
{
    // ReSharper disable once ClassWithVirtualMembersNeverInherited.Global
    public class CommandHandler : Node
    {
        // ReSharper disable once MemberCanBePrivate.Global
        protected readonly List<IIncomingMessageHandler> Handlers = new();


        public void Initialize()
        {
            AddHandlersFromAssembly(Assembly.GetExecutingAssembly());
        }

        // ReSharper disable once MemberCanBeProtected.Global
        public virtual void AddHandlersFromAssembly(Assembly assembly)
        {
            Handlers.AddRange(ReflectionHelpers.GetAllInAssembly<IIncomingMessageHandler>(assembly).Where(h => h != null)!);
        }

        public virtual void Handle(string command, MessageJData data)
        {
            foreach (IIncomingMessageHandler handler in Handlers)
            {
                if (!handler.CanHandle(command)) continue;

                ExecutionResult validationResult;
                object? parsedData;
                try
                {
                    validationResult = handler.Validate(command, data, out parsedData);
                }
                catch (Exception e)
                {
                    Plugin.LogError("Caught exception during validation at WebsocketConnection level - this is bad.");
                    Plugin.LogError(e.ToString());

                    validationResult = ExecutionResult.Failure(NeuroSdkStrings.MessageHandlerFailedCaughtException.Format(e.Message));
                    parsedData = null;
                }

                if (!validationResult.Successful)
                {
                    Plugin.LogWarning("Received unsuccessful execution result when handling a message");
                    Plugin.LogWarning(validationResult.Message);
                    if (validationResult.IsUnstable)
                        NeuroIntegration.Unstable();
                    // Plugin.LogWarning(StackTraceUtility.ExtractStackTrace());
                }

                handler.ReportResult(parsedData, validationResult);

                if (validationResult.Successful)
                {
                    handler.Execute(parsedData);
                }
            }
        }
    }
}
