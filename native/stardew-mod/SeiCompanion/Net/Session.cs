using System;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using StardewModdingAPI;
using StardewValley;
using SeiCompanion.Body;
using SeiCompanion.Dev;

namespace SeiCompanion.Net
{
    /// <summary>
    /// One WebSocket client = one Sei bot = at most one companion body.
    /// Receives NDJSON frames on the socket thread, marshals every game-touching
    /// request onto the game thread (ModEntry.GameThread), and serialises all
    /// outbound sends through one lock (WebSocket.SendAsync is not reentrant).
    /// </summary>
    public sealed class Session
    {
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public bool IsOpen => this._socket.State == WebSocketState.Open;

        private readonly WebSocket _socket;
        private readonly Server _server;
        private readonly ModEntry _mod;
        private readonly IMonitor _monitor;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();

        public Session(WebSocket socket, Server server, ModEntry mod, IMonitor monitor)
        {
            this._socket = socket;
            this._server = server;
            this._mod = mod;
            this._monitor = monitor;
        }

        public async Task Run()
        {
            this._monitor.Log($"Sei bot connected ({this.Id.Substring(0, 8)}).", LogLevel.Info);
            this.SendEvent("welcome", new Dictionary<string, object>
            {
                ["protocol"] = Server.ProtocolVersion,
                ["session"] = this.Id,
                ["hello"] = this._server.HelloPayload(),
            });

            var buffer = new byte[64 * 1024];
            var text = new StringBuilder();
            try
            {
                while (this._socket.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult r = await this._socket.ReceiveAsync(new ArraySegment<byte>(buffer), this._cts.Token);
                    if (r.MessageType == WebSocketMessageType.Close)
                        break;
                    if (r.MessageType != WebSocketMessageType.Text)
                        continue;
                    text.Append(Encoding.UTF8.GetString(buffer, 0, r.Count));
                    if (!r.EndOfMessage)
                    {
                        if (text.Length > 4 * 1024 * 1024) { text.Clear(); }
                        continue;
                    }
                    string payload = text.ToString();
                    text.Clear();
                    foreach (string line in payload.Split('\n'))
                    {
                        string trimmed = line.Trim();
                        if (trimmed.Length == 0) continue;
                        this.Dispatch(trimmed);
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException ex)
            {
                this._monitor.Log($"Socket closed: {ex.Message}", LogLevel.Debug);
            }
            catch (Exception ex)
            {
                this._monitor.Log($"Session error: {ex.Message}", LogLevel.Warn);
            }
            finally
            {
                this.OnClosed();
            }
        }

        private void OnClosed()
        {
            this._monitor.Log($"Sei bot disconnected ({this.Id.Substring(0, 8)}).", LogLevel.Info);
            try { this._socket.Dispose(); } catch { }
            string id = this.Id;
            int grace = Math.Max(0, this._mod.Config.DisconnectGraceSeconds);
            // The body outlives the socket for a grace period so a reconnecting
            // bot can adopt it (Spawn with the same name); after that it leaves.
            Task.Delay(TimeSpan.FromSeconds(grace)).ContinueWith(_ =>
            {
                this._mod.GameThread.Enqueue(() =>
                {
                    SeiBody body = this._mod.BodyFor(id);
                    if (body != null && ReferenceEquals(body.Session, this))
                        this._mod.Despawn(id, "bot disconnected");
                });
            });
        }

        private void Dispatch(string json)
        {
            JsonDocument doc;
            try { doc = JsonDocument.Parse(json); }
            catch (Exception ex)
            {
                this.SendEvent("error", new Dictionary<string, object> { ["message"] = $"bad json: {ex.Message}" });
                return;
            }
            JsonElement root = doc.RootElement;
            string id = root.TryGetProperty("id", out JsonElement idEl) ? idEl.ToString() : null;
            string type = root.TryGetProperty("t", out JsonElement tEl) ? tEl.GetString() : null;
            if (type == null)
            {
                this.SendResult(id, false, "missing t");
                doc.Dispose();
                return;
            }
            if (type == "ping")
            {
                this.SendResult(id, true, "pong", new Dictionary<string, object> { ["save"] = this._mod.SaveInfo() });
                doc.Dispose();
                return;
            }
            this._mod.GameThread.Enqueue(() =>
            {
                try { this.Handle(id, type, root); }
                catch (Exception ex)
                {
                    this._monitor.Log($"{type} failed: {ex}", LogLevel.Error);
                    this.SendResult(id, false, $"error: {ex.Message}");
                }
                finally { doc.Dispose(); }
            });
        }

        /// <summary>Game thread.</summary>
        private void Handle(string id, string type, JsonElement root)
        {
            SeiBody body = this._mod.BodyFor(this.Id);
            switch (type)
            {
                case "spawn":
                {
                    string name = root.TryGetProperty("name", out JsonElement n) ? n.GetString() : "Sei";
                    string err = this._mod.Spawn(this.Id, name, this, out SeiBody spawned);
                    if (err != null)
                    {
                        this.SendResult(id, false, SpawnErrorText(err), new Dictionary<string, object> { ["error"] = err });
                        return;
                    }
                    this.SendResult(id, true, $"spawned as {spawned.Name} in {spawned.LocationName}", new Dictionary<string, object>
                    {
                        ["name"] = spawned.Name,
                        ["location"] = spawned.LocationName,
                        ["x"] = spawned.TileX,
                        ["y"] = spawned.TileY,
                    });
                    this.SendEvent("spawned", spawned.Identity());
                    return;
                }
                case "despawn":
                    this._mod.Despawn(this.Id, "bot asked");
                    this.SendResult(id, true, "despawned");
                    return;
                case "observe":
                    if (body == null) { this.SendResult(id, false, "not spawned"); return; }
                    this.SendResult(id, true, "ok", new Dictionary<string, object> { ["obs"] = body.Observe() });
                    return;
                case "say":
                {
                    if (body == null) { this.SendResult(id, false, "not spawned"); return; }
                    string textLine = root.TryGetProperty("text", out JsonElement t) ? t.GetString() : "";
                    body.Say(textLine ?? "");
                    this.SendResult(id, true, "said");
                    return;
                }
                case "pause":
                {
                    if (body == null) { this.SendResult(id, false, "not spawned"); return; }
                    bool paused = root.TryGetProperty("paused", out JsonElement p) && p.ValueKind == JsonValueKind.True;
                    body.SetPaused(paused);
                    this.SendResult(id, true, paused ? "paused" : "resumed");
                    return;
                }
                case "cancel":
                {
                    if (body == null) { this.SendResult(id, false, "not spawned"); return; }
                    string target = root.TryGetProperty("target", out JsonElement tg) ? tg.ToString() : null;
                    body.CancelCommand(target, "aborted");
                    this.SendResult(id, true, "cancelled");
                    return;
                }
                case "cmd":
                {
                    if (body == null) { this.SendResult(id, false, "not spawned"); return; }
                    string name = root.TryGetProperty("name", out JsonElement nm) ? nm.GetString() : null;
                    JsonElement args = root.TryGetProperty("args", out JsonElement a) ? a.Clone() : default;
                    if (string.IsNullOrEmpty(name)) { this.SendResult(id, false, "missing name"); return; }
                    body.RunCommand(id, name, args);
                    return;
                }
                case "newFarm":
                {
                    // Developer frame (DevCommands.cs): refused unless config.json opts in.
                    if (!this._mod.Config.DevCommands) { this.SendResult(id, false, "dev commands are off (DevCommands in config.json)"); return; }
                    string farmer = root.TryGetProperty("farmer", out JsonElement fr) ? fr.GetString() : null;
                    string farm = root.TryGetProperty("farm", out JsonElement fm) ? fm.GetString() : null;
                    string fav = root.TryGetProperty("favoriteThing", out JsonElement fv) ? fv.GetString() : null;
                    string err = DevCommands.NewFarm(this._mod, string.IsNullOrWhiteSpace(farmer) ? "Farmer" : farmer.Trim(), string.IsNullOrWhiteSpace(farm) ? "Sei" : farm.Trim(), string.IsNullOrWhiteSpace(fav) ? "Sei" : fav.Trim());
                    this.SendResult(id, err == null, err ?? "new farm started; the save loads in a moment");
                    return;
                }
                case "loadFarm":
                {
                    if (!this._mod.Config.DevCommands) { this.SendResult(id, false, "dev commands are off (DevCommands in config.json)"); return; }
                    string slot = root.TryGetProperty("slot", out JsonElement sl) ? sl.GetString() : null;
                    string err = DevCommands.LoadFarm(this._mod, slot);
                    this.SendResult(id, err == null, err ?? "loading; the save is up in a moment");
                    return;
                }
                case "devTiles":
                {
                    if (!this._mod.Config.DevCommands) { this.SendResult(id, false, "dev commands are off (DevCommands in config.json)"); return; }
                    int x0 = root.TryGetProperty("x0", out JsonElement a0) ? a0.GetInt32() : 0, y0 = root.TryGetProperty("y0", out JsonElement b0) ? b0.GetInt32() : 0;
                    int x1 = root.TryGetProperty("x1", out JsonElement a1) ? a1.GetInt32() : x0, y1 = root.TryGetProperty("y1", out JsonElement b1) ? b1.GetInt32() : y0;
                    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) { this.SendResult(id, false, "at most 400 tiles"); return; }
                    this.SendResult(id, true, "ok", new Dictionary<string, object> { ["tiles"] = DevCommands.Tiles(body, x0, y0, x1, y1) });
                    return;
                }
                case "devTime":
                {
                    if (!this._mod.Config.DevCommands) { this.SendResult(id, false, "dev commands are off (DevCommands in config.json)"); return; }
                    int time = root.TryGetProperty("time", out JsonElement tm) && tm.TryGetInt32(out int tv) ? tv : -1;
                    if (time < 600 || time > 2600) { this.SendResult(id, false, "time must be 600..2600 (game clock, e.g. 1330)"); return; }
                    Game1.timeOfDay = time;
                    this.SendResult(id, true, $"clock set to {Observe.Snapshot.TimeText(time)}");
                    return;
                }
                case "devDebris":
                    if (!this._mod.Config.DevCommands) { this.SendResult(id, false, "dev commands are off (DevCommands in config.json)"); return; }
                    this.SendResult(id, true, "ok", new Dictionary<string, object> { ["debris"] = DevCommands.Debris(body) });
                    return;
                case "devSleep":
                {
                    if (!this._mod.Config.DevCommands) { this.SendResult(id, false, "dev commands are off (DevCommands in config.json)"); return; }
                    string err = DevCommands.Sleep(this._mod);
                    this.SendResult(id, err == null, err ?? "sleeping; the next day starts in a moment");
                    return;
                }
                case "devState":
                    if (!this._mod.Config.DevCommands) { this.SendResult(id, false, "dev commands are off (DevCommands in config.json)"); return; }
                    this.SendResult(id, true, "ok", new Dictionary<string, object> { ["state"] = DevCommands.State() });
                    return;
                default:
                    this.SendResult(id, false, $"unknown message type {type}");
                    return;
            }
        }

        private static string SpawnErrorText(string code)
        {
            switch (code)
            {
                case "NO_SAVE": return "no save is loaded; load your farm first";
                case "NOT_HOST": return "this game is a farmhand, not the host; the companion can only join the host's game";
                case "FARMHAND_NO_MOD": return "a connected farmhand does not have the Sei companion mod; they need it before the companion can appear";
                case "NAME_TAKEN": return "a companion with that name is already in the world";
                case "NO_ART": return "the companion art failed to load; check the SMAPI log";
                default: return code;
            }
        }

        /*********
        ** Sending (any thread)
        *********/
        public void SendEvent(string type, Dictionary<string, object> fields)
        {
            var frame = new Dictionary<string, object>(fields ?? new Dictionary<string, object>()) { ["t"] = type };
            this.Send(frame);
        }

        public void SendResult(string id, bool ok, string detail, Dictionary<string, object> extra = null)
        {
            var frame = new Dictionary<string, object>(extra ?? new Dictionary<string, object>())
            {
                ["t"] = "result",
                ["id"] = id,
                ["ok"] = ok,
                ["detail"] = detail ?? "",
            };
            this.Send(frame);
        }

        public void SendProgress(string id, string text)
        {
            this.Send(new Dictionary<string, object> { ["t"] = "progress", ["id"] = id, ["text"] = text ?? "" });
        }

        private readonly System.Collections.Concurrent.ConcurrentQueue<byte[]> _outbox = new System.Collections.Concurrent.ConcurrentQueue<byte[]>();
        private int _draining;

        /// <summary>Queue a frame. One drain task at a time so frames leave in the order they were queued.</summary>
        private void Send(object frame)
        {
            if (this._socket.State != WebSocketState.Open)
                return;
            string json;
            try { json = JsonSerializer.Serialize(frame, Server.Json); }
            catch (Exception ex)
            {
                this._monitor.Log($"Could not serialise a frame: {ex.Message}", LogLevel.Warn);
                return;
            }
            this._outbox.Enqueue(Encoding.UTF8.GetBytes(json + "\n"));
            if (Interlocked.CompareExchange(ref this._draining, 1, 0) == 0)
                _ = Task.Run(this.Drain);
        }

        private async Task Drain()
        {
            try
            {
                while (this._outbox.TryDequeue(out byte[] bytes))
                {
                    if (this._socket.State != WebSocketState.Open)
                        continue;
                    await this._sendLock.WaitAsync();
                    try
                    {
                        await this._socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
                    }
                    catch (Exception ex)
                    {
                        this._monitor.Log($"Send failed: {ex.Message}", LogLevel.Debug);
                    }
                    finally { this._sendLock.Release(); }
                }
            }
            finally
            {
                Interlocked.Exchange(ref this._draining, 0);
                // A frame queued between the last TryDequeue and the flag reset
                // would otherwise sit until the next Send.
                if (!this._outbox.IsEmpty && Interlocked.CompareExchange(ref this._draining, 1, 0) == 0)
                    _ = Task.Run(this.Drain);
            }
        }

        public void Close()
        {
            try { this._cts.Cancel(); } catch { }
        }
    }
}
