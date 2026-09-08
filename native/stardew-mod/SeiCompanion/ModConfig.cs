using System;

namespace SeiCompanion
{
    /// <summary>
    /// Mod configuration (<c>config.json</c> beside the DLL). Written by the
    /// Sei app's installer (src/main/games/stardew/install.ts) and read by
    /// its watcher: the port is where the mod listens, the token is what a
    /// WebSocket client must present. A missing token is generated on first
    /// load so a hand-installed mod still works (the app reads it back).
    /// </summary>
    public class ModConfig
    {
        /// <summary>Loopback port for the HTTP hello + WebSocket server (bound on localhost).</summary>
        public int Port { get; set; } = 27431;

        /// <summary>Shared secret for the WebSocket. Empty = generate on load.</summary>
        public string Token { get; set; } = "";

        /// <summary>Echo the companion's lines into the in-game chat box (the speech bubble always shows).</summary>
        public bool AnnounceInChat { get; set; } = true;

        /// <summary>How often a connected client receives an observation push while a body is spawned (0 = on demand only).</summary>
        public int ObserveHz { get; set; } = 2;

        /// <summary>The companion's starting wallet. It never touches the host's money.</summary>
        public int StartingGold { get; set; } = 500;

        /// <summary>Seconds a body survives after its client disconnects before it is removed.</summary>
        public int DisconnectGraceSeconds { get; set; } = 10;

        public static string NewToken()
        {
            return Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        }
    }
}
