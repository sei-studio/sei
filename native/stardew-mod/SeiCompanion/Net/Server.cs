using System;
using System.Collections.Generic;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using StardewModdingAPI;

namespace SeiCompanion.Net
{
    /// <summary>
    /// Loopback HTTP + WebSocket server (System.Net.HttpListener, no third-party
    /// DLLs; the StardewWebApi pattern, MIT).
    ///
    ///   GET /hello        unauthenticated liveness + save summary (the Sei app's
    ///                     watcher polls it every 3 s)
    ///   GET /ws?token=…   WebSocket upgrade; NDJSON frames; see ../PROTOCOL.md
    ///
    /// Bound to 127.0.0.1 only. A wrong or missing token is a 401 BEFORE the
    /// upgrade, so an unauthenticated peer never reaches a handler.
    /// </summary>
    public sealed class Server
    {
        private readonly ModConfig _config;
        private readonly IMonitor _monitor;
        private readonly ModEntry _mod;
        private readonly HttpListener _listener = new HttpListener();
        private readonly List<Session> _sessions = new List<Session>();
        private readonly object _sessionsLock = new object();
        private volatile bool _running;

        public static readonly JsonSerializerOptions Json = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            IncludeFields = true,
        };

        public const int ProtocolVersion = 1;

        public Server(ModConfig config, IMonitor monitor, ModEntry mod)
        {
            this._config = config;
            this._monitor = monitor;
            this._mod = mod;
            this._listener.Prefixes.Add($"http://127.0.0.1:{config.Port}/");
            this._listener.Prefixes.Add($"http://localhost:{config.Port}/");
        }

        public void Start()
        {
            this._running = true;
            Task.Run(this.MainLoop);
        }

        public void Stop()
        {
            this._running = false;
            try { this._listener.Stop(); } catch { }
        }

        private async Task MainLoop()
        {
            try
            {
                this._listener.Start();
                this._monitor.Log($"Sei companion server listening on http://127.0.0.1:{this._config.Port}/", LogLevel.Info);
            }
            catch (Exception ex)
            {
                this._monitor.Log($"Could not bind port {this._config.Port}: {ex.Message}. Change Port in config.json.", LogLevel.Error);
                return;
            }

            while (this._running)
            {
                HttpListenerContext ctx;
                try
                {
                    ctx = await this._listener.GetContextAsync();
                }
                catch (Exception ex)
                {
                    if (this._running)
                        this._monitor.Log($"Listener error: {ex.Message}", LogLevel.Warn);
                    continue;
                }
                _ = Task.Run(() => this.Handle(ctx));
            }
        }

        private async Task Handle(HttpListenerContext ctx)
        {
            try
            {
                string path = (ctx.Request.Url?.AbsolutePath ?? "/").ToLowerInvariant();
                if (path == "/hello")
                {
                    this.WriteJson(ctx.Response, 200, this.HelloPayload());
                    return;
                }
                if (path == "/ws")
                {
                    if (!this.Authorized(ctx.Request))
                    {
                        this.WriteJson(ctx.Response, 401, new Dictionary<string, object> { ["error"] = "unauthorized" });
                        return;
                    }
                    if (!ctx.Request.IsWebSocketRequest)
                    {
                        this.WriteJson(ctx.Response, 400, new Dictionary<string, object> { ["error"] = "websocket required" });
                        return;
                    }
                    HttpListenerWebSocketContext wsCtx = await ctx.AcceptWebSocketAsync(null);
                    var session = new Session(wsCtx.WebSocket, this, this._mod, this._monitor);
                    lock (this._sessionsLock)
                        this._sessions.Add(session);
                    try
                    {
                        await session.Run();
                    }
                    finally
                    {
                        lock (this._sessionsLock)
                            this._sessions.Remove(session);
                    }
                    return;
                }
                this.WriteJson(ctx.Response, 404, new Dictionary<string, object> { ["error"] = "not found" });
            }
            catch (Exception ex)
            {
                this._monitor.Log($"Request failed: {ex.Message}", LogLevel.Debug);
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
                    token = auth.Substring("Bearer ".Length).Trim();
            }
            if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(this._config.Token))
                return false;
            // Constant-time compare; the token is long and random.
            byte[] a = Encoding.UTF8.GetBytes(token);
            byte[] b = Encoding.UTF8.GetBytes(this._config.Token);
            if (a.Length != b.Length)
                return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++)
                diff |= a[i] ^ b[i];
            return diff == 0;
        }

        internal Dictionary<string, object> HelloPayload()
        {
            return new Dictionary<string, object>
            {
                ["mod"] = "SeiCompanion",
                ["version"] = this._mod.ModManifest.Version.ToString(),
                ["protocol"] = ProtocolVersion,
                ["game"] = SafeGameVersion(),
                ["smapi"] = Constants.ApiVersion.ToString(),
                ["port"] = this._config.Port,
                ["save"] = this._mod.SaveInfo(),
            };
        }

        private static string SafeGameVersion()
        {
            try { return StardewValley.Game1.version; } catch { return "unknown"; }
        }

        private void WriteJson(HttpListenerResponse response, int status, object body)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(body, Json));
                response.StatusCode = status;
                response.ContentType = "application/json";
                response.ContentLength64 = bytes.Length;
                response.OutputStream.Write(bytes, 0, bytes.Length);
                response.Close();
            }
            catch { try { response.Abort(); } catch { } }
        }

        /// <summary>Push the save summary to every open session (day change, load, title).</summary>
        public void NotifySaveState()
        {
            var save = this._mod.SaveInfo();
            lock (this._sessionsLock)
            {
                foreach (Session s in this._sessions)
                    s.SendEvent("save", save);
            }
        }
    }
}
