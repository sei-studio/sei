// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// Loopback HTTP + WebSocket bridge (System.Net.HttpListener, no extra DLLs).
//   GET /hello        no auth; liveness + which process this is (single player,
//                     a multiplayer client, or the server) and the open world.
//                     The Sei app polls it to pick the process that owns the world.
//   GET /ws?token=... WebSocket; NDJSON frames, see ../../PROTOCOL.md
// A wrong or missing token is a 401 before the upgrade.

using System;
using System.Collections.Generic;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace SeiCompanion.Link
{
	public sealed class Bridge
	{
		public const int ProtocolVersion = 1;

		private readonly LinkConfig _config;
		private HttpListener _listener;
		private readonly List<Session> _sessions = new();
		private readonly object _lock = new();
		private volatile bool _running;

		public int BoundPort { get; private set; }

		public static readonly JsonSerializerOptions JsonOpts = new()
		{
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
			IncludeFields = true,
		};

		public Bridge(LinkConfig config)
		{
			_config = config;
		}

		/// <summary>Bind the first free port of Port..Port+PortSpan-1. Host and Play runs two processes with the mod, so the second one takes the next port.</summary>
		public void Start()
		{
			for (int i = 0; i < LinkConfig.PortSpan; i++)
			{
				int port = _config.Port + i;
				var listener = new HttpListener();
				listener.Prefixes.Add($"http://localhost:{port}/");
				if (Environment.OSVersion.Platform != PlatformID.Win32NT)
					listener.Prefixes.Add($"http://127.0.0.1:{port}/");
				try
				{
					listener.Start();
				}
				catch (Exception)
				{
					try { listener.Close(); } catch { }
					continue;
				}
				_listener = listener;
				BoundPort = port;
				break;
			}
			if (_listener == null)
			{
				SeiMod.Log?.Error($"[Sei] no free port in {_config.Port}..{_config.Port + LinkConfig.PortSpan - 1}; the Sei app cannot reach this game");
				return;
			}
			_running = true;
			SeiMod.Log?.Info($"[Sei] bridge listening on http://localhost:{BoundPort}/ (link config: {(_config.Token.Length > 0 ? "found" : "missing")})");
			Task.Run(Loop);
		}

		public void Stop()
		{
			_running = false;
			lock (_lock)
			{
				foreach (var s in _sessions) s.Close();
			}
			try { _listener?.Stop(); } catch { }
			try { _listener?.Close(); } catch { }
		}

		public List<Session> Sessions()
		{
			lock (_lock) return new List<Session>(_sessions);
		}

		/// <summary>Send an event frame to every open session (world events, chat).</summary>
		public void Broadcast(string type, Dictionary<string, object> fields)
		{
			foreach (var s in Sessions()) s.SendEvent(type, fields);
		}

		private async Task Loop()
		{
			while (_running)
			{
				HttpListenerContext ctx;
				try { ctx = await _listener.GetContextAsync(); }
				catch (Exception e)
				{
					if (_running) SeiMod.Log?.Warn($"[Sei] listener: {e.Message}");
					if (!_listener.IsListening) return;
					continue;
				}
				_ = Task.Run(() => Handle(ctx));
			}
		}

		private async Task Handle(HttpListenerContext ctx)
		{
			try
			{
				string path = (ctx.Request.Url?.AbsolutePath ?? "/").ToLowerInvariant();
				if (path == "/hello")
				{
					WriteJson(ctx.Response, 200, Hello());
					return;
				}
				if (path == "/ws")
				{
					if (!Authorized(ctx.Request))
					{
						WriteJson(ctx.Response, 401, new Dictionary<string, object> { ["error"] = "unauthorized" });
						return;
					}
					if (!ctx.Request.IsWebSocketRequest)
					{
						WriteJson(ctx.Response, 400, new Dictionary<string, object> { ["error"] = "websocket required" });
						return;
					}
					var ws = await ctx.AcceptWebSocketAsync(null);
					var session = new Session(ws.WebSocket, this, _config);
					lock (_lock) _sessions.Add(session);
					try { await session.Run(); }
					finally { lock (_lock) _sessions.Remove(session); }
					return;
				}
				WriteJson(ctx.Response, 404, new Dictionary<string, object> { ["error"] = "not found" });
			}
			catch (Exception e)
			{
				SeiMod.Log?.Debug($"[Sei] request failed: {e.Message}");
				try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { }
			}
		}

		private bool Authorized(HttpListenerRequest request)
		{
			string token = request.QueryString["token"];
			if (string.IsNullOrEmpty(token))
			{
				string auth = request.Headers["Authorization"];
				if (!string.IsNullOrEmpty(auth) && auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
					token = auth.Substring(7).Trim();
			}
			if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(_config.Token)) return false;
			byte[] a = Encoding.UTF8.GetBytes(token), b = Encoding.UTF8.GetBytes(_config.Token);
			if (a.Length != b.Length) return false;
			int diff = 0;
			for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
			return diff == 0;
		}

		/// <summary>Read from a socket thread: only immutable or atomically replaced values.</summary>
		public Dictionary<string, object> Hello()
		{
			var world = Systems.SeiSystem.WorldInfo;
			return new Dictionary<string, object>
			{
				["mod"] = "SeiCompanion",
				["version"] = SeiMod.Instance?.Version?.ToString() ?? "0",
				["protocol"] = ProtocolVersion,
				["game"] = "terraria",
				["terraria"] = SafeTerrariaVersion(),
				["tml"] = SafeTmlVersion(),
				["port"] = BoundPort,
				["role"] = Systems.SeiSystem.Role(),
				["world"] = world,
				["pid"] = Environment.ProcessId,
			};
		}

		private static string SafeTerrariaVersion()
		{
			try { return Terraria.Main.versionNumber; } catch { return "unknown"; }
		}

		private static string SafeTmlVersion()
		{
			try { return Terraria.ModLoader.BuildInfo.tMLVersion.ToString(); } catch { return "unknown"; }
		}

		private static void WriteJson(HttpListenerResponse response, int status, object body)
		{
			try
			{
				byte[] bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(body, JsonOpts));
				response.StatusCode = status;
				response.ContentType = "application/json";
				response.ContentLength64 = bytes.Length;
				response.OutputStream.Write(bytes, 0, bytes.Length);
				response.Close();
			}
			catch { try { response.Abort(); } catch { } }
		}
	}
}
