// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// One WebSocket client = one Sei bot = at most one companion body. Frames are
// parsed on the socket thread; everything that touches the game is posted to
// GameThread. Sends go through one ordered outbox (SendAsync is not reentrant).

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using SeiCompanion.Body;
using SeiCompanion.Systems;

namespace SeiCompanion.Link
{
	public sealed class Session
	{
		public string Id { get; } = Guid.NewGuid().ToString("N");
		public bool IsOpen => _socket.State == WebSocketState.Open;

		private readonly WebSocket _socket;
		private readonly Bridge _bridge;
		private readonly LinkConfig _config;
		private readonly CancellationTokenSource _cts = new();
		private readonly ConcurrentQueue<byte[]> _outbox = new();
		private readonly SemaphoreSlim _sendLock = new(1, 1);
		private int _draining;

		/// <summary>Seconds a body outlives its socket so a reconnecting bot can adopt it.</summary>
		public const int DisconnectGraceSeconds = 10;

		public Session(WebSocket socket, Bridge bridge, LinkConfig config)
		{
			_socket = socket;
			_bridge = bridge;
			_config = config;
		}

		public async Task Run()
		{
			SeiMod.Log?.Info($"[Sei] bot connected ({Id.Substring(0, 8)})");
			SendEvent("welcome", new Dictionary<string, object>
			{
				["protocol"] = Bridge.ProtocolVersion,
				["session"] = Id,
				["hello"] = _bridge.Hello(),
			});
			var buffer = new byte[64 * 1024];
			var text = new StringBuilder();
			try
			{
				while (_socket.State == WebSocketState.Open)
				{
					var r = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token);
					if (r.MessageType == WebSocketMessageType.Close) break;
					if (r.MessageType != WebSocketMessageType.Text) continue;
					text.Append(Encoding.UTF8.GetString(buffer, 0, r.Count));
					if (!r.EndOfMessage)
					{
						if (text.Length > 1024 * 1024) text.Clear();
						continue;
					}
					string payload = text.ToString();
					text.Clear();
					foreach (string line in payload.Split('\n'))
					{
						string trimmed = line.Trim();
						if (trimmed.Length > 0) Dispatch(trimmed);
					}
				}
			}
			catch (OperationCanceledException) { }
			catch (WebSocketException e) { SeiMod.Log?.Debug($"[Sei] socket closed: {e.Message}"); }
			catch (Exception e) { SeiMod.Log?.Warn($"[Sei] session error: {e.Message}"); }
			finally { OnClosed(); }
		}

		private void OnClosed()
		{
			SeiMod.Log?.Info($"[Sei] bot disconnected ({Id.Substring(0, 8)})");
			try { _socket.Dispose(); } catch { }
			string id = Id;
			Task.Delay(TimeSpan.FromSeconds(DisconnectGraceSeconds)).ContinueWith(_ =>
			{
				GameThread.Post(() =>
				{
					var c = SeiSystem.ForSession(id);
					if (c != null && ReferenceEquals(c.Session, this))
						SeiSystem.Despawn(id, "bot disconnected");
				});
			});
		}

		private void Dispatch(string json)
		{
			JsonObject root;
			try { root = JsonNode.Parse(json) as JsonObject; }
			catch (Exception e)
			{
				SendEvent("error", new Dictionary<string, object> { ["message"] = $"bad json: {e.Message}" });
				return;
			}
			if (root == null) return;
			string id = Json.Str(root, "id");
			string type = Json.Str(root, "t");
			if (type == null) { SendResult(id, false, "missing t"); return; }
			if (type == "ping")
			{
				SendResult(id, true, "pong", new Dictionary<string, object> { ["hello"] = _bridge.Hello() });
				return;
			}
			GameThread.Post(() =>
			{
				try { Handle(id, type, root); }
				catch (Exception e)
				{
					SeiMod.Log?.Error($"[Sei] {type} failed: {e}");
					SendResult(id, false, $"error: {e.Message}");
				}
			});
		}

		/// <summary>Game thread.</summary>
		private void Handle(string id, string type, JsonObject root)
		{
			var c = SeiSystem.ForSession(Id);
			switch (type)
			{
				case "spawn":
				{
					string name = Json.Str(root, "name", "Sei");
					var look = Appearance.FromJson(Json.Obj(root, "appearance"));
					string owner = Json.Str(root, "owner");
					string err = SeiSystem.Spawn(this, name, look, owner, out var spawned);
					if (err != null)
					{
						SendResult(id, false, SpawnErrorText(err), new Dictionary<string, object> { ["error"] = err });
						return;
					}
					SendResult(id, true, $"spawned as {spawned.Name} at ({spawned.TileX},{spawned.TileY})", spawned.Identity());
					SendEvent("spawned", spawned.Identity());
					return;
				}
				case "despawn":
					SeiSystem.Despawn(Id, "bot asked");
					SendResult(id, true, "despawned");
					return;
				case "observe":
					if (c == null) { SendResult(id, false, "not spawned"); return; }
					SendResult(id, true, "ok", new Dictionary<string, object> { ["obs"] = Observe.Observer.Build(c) });
					return;
				case "say":
				{
					if (c == null) { SendResult(id, false, "not spawned"); return; }
					c.Say(Json.Str(root, "text", ""));
					SendResult(id, true, "said");
					return;
				}
				case "pause":
				{
					if (c == null) { SendResult(id, false, "not spawned"); return; }
					bool paused = Json.Bool(root, "paused");
					c.SetPaused(paused);
					SendResult(id, true, paused ? "paused" : "resumed");
					return;
				}
				case "cancel":
				{
					if (c == null) { SendResult(id, false, "not spawned"); return; }
					c.Cancel(Json.Str(root, "target"), "aborted");
					SendResult(id, true, "cancelled");
					return;
				}
				case "cmd":
				{
					if (c == null) { SendResult(id, false, "not spawned"); return; }
					string name = Json.Str(root, "name");
					if (string.IsNullOrEmpty(name)) { SendResult(id, false, "missing name"); return; }
					c.RunCommand(id, name, Json.Obj(root, "args") ?? new JsonObject());
					return;
				}
				default:
					if (type.StartsWith("dev"))
					{
						if (!_config.DevCommands) { SendResult(id, false, "dev commands are off (devCommands in link.json)"); return; }
						Dev.DevCommands.Handle(this, c, id, type, root);
						return;
					}
					SendResult(id, false, $"unknown message type {type}");
					return;
			}
		}

		private static string SpawnErrorText(string code)
		{
			switch (code)
			{
				case "NO_WORLD": return "no world is open; enter a world first";
				case "NOT_HOST": return "this game joined someone else's server; the companion can only appear in a world you host";
				case "NAME_TAKEN": return "a companion with that name is already in the world";
				case "NO_SLOT": return "the world has no free NPC slot";
				default: return code;
			}
		}

		// ── Sending (any thread) ──────────────────────────────────────────
		public void SendEvent(string type, Dictionary<string, object> fields)
		{
			var frame = new Dictionary<string, object>(fields ?? new Dictionary<string, object>()) { ["t"] = type };
			Send(frame);
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
			Send(frame);
		}

		public void SendProgress(string id, string text)
		{
			Send(new Dictionary<string, object> { ["t"] = "progress", ["id"] = id, ["text"] = text ?? "" });
		}

		private void Send(object frame)
		{
			if (_socket.State != WebSocketState.Open) return;
			string json;
			try { json = JsonSerializer.Serialize(frame, Bridge.JsonOpts); }
			catch (Exception e)
			{
				SeiMod.Log?.Warn($"[Sei] could not serialise a frame: {e.Message}");
				return;
			}
			_outbox.Enqueue(Encoding.UTF8.GetBytes(json + "\n"));
			if (Interlocked.CompareExchange(ref _draining, 1, 0) == 0)
				_ = Task.Run(Drain);
		}

		private async Task Drain()
		{
			try
			{
				while (_outbox.TryDequeue(out var bytes))
				{
					if (_socket.State != WebSocketState.Open) continue;
					await _sendLock.WaitAsync();
					try { await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None); }
					catch (Exception e) { SeiMod.Log?.Debug($"[Sei] send failed: {e.Message}"); }
					finally { _sendLock.Release(); }
				}
			}
			finally
			{
				Interlocked.Exchange(ref _draining, 0);
				if (!_outbox.IsEmpty && Interlocked.CompareExchange(ref _draining, 1, 0) == 0)
					_ = Task.Run(Drain);
			}
		}

		public void Close()
		{
			try { _cts.Cancel(); } catch { }
		}
	}
}
