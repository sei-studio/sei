#nullable enable

using System;
using System.Collections;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Godot;
using NativeWebSocket;
using NeuroSdk.Internal;
using NeuroSdk.Messages.API;
using Sts2Agent;

namespace NeuroSdk.Websocket
{
    public partial class WebsocketConnection : Node
    {
        // Sei: 2 s (was 3), retried forever, including when there is no link file yet.
        private const float RECONNECT_INTERVAL = 2;

        private static bool _checkingSelf;

        private static WebsocketConnection? _instance;
        public static WebsocketConnection? Instance
        {
            get
            {
                if (_instance is null && !_checkingSelf) Plugin.LogWarning("Accessed WebsocketConnection.Instance without an instance being present");
                _checkingSelf = false;
                return _instance;
            }
            private set => _instance = value;
        }

        private static WebSocket? _socket;

        public string game = "";

        // Sei: handshake state. False until startup + sei/hello went out on the current socket.
        private bool _handshakeDone;
        private static bool _loggedNoUrl;
        public static bool IsOpen => _socket?.State is WebSocketState.Open;
        public MessageQueue messageQueue = null!;
        public CommandHandler commandHandler = null!;

        public Action? onConnected;
        public Action<string>? onError;
        public Action<WebSocketCloseCode>? onDisconnected;

        public void Startup()
        {
            _checkingSelf = true;
            if (Instance is not null)
            {
                Plugin.Log("Destroying duplicate WebsocketConnection instance");
                QueueFree();
                return;
            }

            Instance = this;

            Plugin.Log("NeuroSdk WebsocketConnection is now awake");
            _ = StartWs();
        }

        // ReSharper disable once ArrangeThisQualifier -- Il2Cpp has this as an extension method

        private async Task Reconnect()
        {
            await Task.Delay((int)(RECONNECT_INTERVAL * 1000));
            await StartWs();
        }

        private async Task StartWs()
        {
            if (MainThreadUtil.Instance == null) MainThreadUtil.Setup();

            try
            {
                if (_socket?.State is WebSocketState.Open or WebSocketState.Connecting) _ = _socket.Close();
            }
            catch
            {
                // ignored
            }

            string? websocketUrl = null;
            WsUrlFinder.FindWsUrl(result => websocketUrl = result);


            if (websocketUrl is null or "")
            {
                // Sei: no link file yet (Sei not running). Keep trying quietly.
                if (!_loggedNoUrl) Plugin.Log("[sei] no link file yet; retrying every 2 s");
                _loggedNoUrl = true;
                _ = Reconnect();
                return;
            }
            _loggedNoUrl = false;

            // Websocket callbacks get run on separate threads! Watch out
            try
            {
                _socket = new WebSocket(websocketUrl);
            }
            catch (Exception e)
            {
                // Sei: a malformed URL must not end the retry loop.
                Plugin.LogError($"[sei] bad link url: {e.Message}");
                _ = Reconnect();
                return;
            }
            _socket.OnOpen += () =>
            {
                // ReSharper disable once ArrangeThisQualifier -- Il2Cpp has this as an extension method
                coroutine();
                return;

                async void coroutine()
                {
                    Plugin.LogDebug(GetTree()?.ToString() ?? "TREE NOT FOUND ON CONNECTION");
                    await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
                    onConnected?.Invoke();
                }
            };
            _socket.OnMessage += bytes =>
            {
                string message = Encoding.UTF8.GetString(bytes);
                // ReSharper disable once ArrangeThisQualifier -- Il2Cpp has this as an extension method
                ReceiveMessage(message);
            };
            _socket.OnError += error =>
            {
                // ReSharper disable once ArrangeThisQualifier -- Il2Cpp has this as an extension method
                coroutine();
                return;

                async void coroutine()
                {
                    await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);

                    onError?.Invoke(error);
                    if (error != "Unable to connect to the remote server")
                    {
                        Plugin.LogError("Websocket connection has encountered an error!");
                        Plugin.LogError(error);
                    }
                }
            };
            _socket.OnClose += code =>
            {
                // ReSharper disable once ArrangeThisQualifier -- Il2Cpp has this as an extension method
                _ = coroutine();
                return;

                async Task coroutine()
                {
                    await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);

                    onDisconnected?.Invoke(code);
                    if (code != WebSocketCloseCode.Abnormal) Plugin.LogWarning($"Websocket connection has been closed with code {code}!");
                    // ReSharper disable once ArrangeThisQualifier -- Il2Cpp has this as an extension method
                    _ = Reconnect();
                }
            };

            _ = _socket.Connect();

        }
        public void Loop()
        {
            if (_socket?.State is not WebSocketState.Open)
            {
                _handshakeDone = false; // Sei: the next open socket gets a fresh handshake
                return;
            }

            if (!_handshakeDone)
            {
                // Sei: on every (re)connect, startup + sei/hello go first, stale queued messages are
                // dropped, and the seat re-registers and re-forces from the current game state.
                _handshakeDone = true;
                messageQueue.Clear();
                SendImmediate(new NeuroSdk.Messages.Outgoing.Startup());
                Sts2Agent.Sei.SeiRuntime.OnConnected();
            }

            while (messageQueue.Count > 0)
            {
                OutgoingMessageBuilder builder = messageQueue.Dequeue()!;
                // ReSharper disable once ArrangeThisQualifier -- Il2Cpp has this as an extension method
                _ = SendTask(builder);
            }
            _socket.DispatchMessageQueue();
        }

        private async Task SendTask(OutgoingMessageBuilder builder)
        {
            string message = Jason.Serialize(builder.GetWsMessage());

            Plugin.Log($"Sending ws message {message}");

            Task task = _socket!.SendText(message);
            // ReSharper disable once RedundantDelegateCreation
            await task;

            if (task.IsCanceled || task.IsFaulted)
            {
                Plugin.LogError($"Failed to send ws message {message}");
                messageQueue.Enqueue(builder);
            }
        }

        public void Send(OutgoingMessageBuilder messageBuilder) => messageQueue.Enqueue(messageBuilder);

        public void SendImmediate(OutgoingMessageBuilder messageBuilder)
        {
            string message = Jason.Serialize(messageBuilder.GetWsMessage());

            if (_socket?.State is not WebSocketState.Open)
            {
                Plugin.LogError($"WS not open - failed to send immediate ws message {message}");
                return;
            }

            Plugin.Log($"Sending immediate ws message {message}");

            _socket.SendText(message);
        }

        private async void ReceiveMessage(string msgData)
        {
            await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);

            try
            {

                Plugin.Log("Received ws message " + msgData);

                JsonObject message = (JsonObject)JsonNode.Parse(msgData);
                string? command = message["command"]?.GetValue<string>();
                MessageJData data = new(message["data"]);

                if (command == null)
                {
                    Plugin.LogError("Received command that could not be deserialized. Wtf are you doing?");
                    return;
                }

                commandHandler.Handle(command, data);
            }
            catch (Exception e)
            {
                Plugin.LogError("Received invalid message");
                Plugin.LogError(e.ToString());
            }
        }
    }
}
