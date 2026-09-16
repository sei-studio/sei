using System;
using HarmonyLib;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace SeiCompanion.Chat
{
    /// <summary>
    /// Reads the in-game chat. SMAPI has no chat event; every mod that listens
    /// hooks ChatBox.receiveChatMessage, which both the local player's typed
    /// line and remote lines pass through (JunimoServer's postfix, MIT). A
    /// postfix never changes what the game does with the line.
    /// </summary>
    public static class ChatHook
    {
        private static Action<long, int, string> _onLine;
        private static IMonitor _monitor;

        public static void Apply(Harmony harmony, IMonitor monitor, Action<long, int, string> onLine)
        {
            _onLine = onLine;
            _monitor = monitor;
            try
            {
                harmony.Patch(
                    original: AccessTools.Method(typeof(ChatBox), nameof(ChatBox.receiveChatMessage)),
                    postfix: new HarmonyMethod(typeof(ChatHook), nameof(ReceiveChatMessage_Postfix))
                );
            }
            catch (Exception ex)
            {
                monitor.Log($"Could not hook the chat box; the companion will not hear in-game chat: {ex.Message}", LogLevel.Error);
            }
        }

        /// <summary>Harmony postfix. Parameter names must match the original's.</summary>
        public static void ReceiveChatMessage_Postfix(long sourceFarmer, int chatKind, LocalizedContentManager.LanguageCode language, string message)
        {
            try
            {
                _onLine?.Invoke(sourceFarmer, chatKind, message);
            }
            catch (Exception ex)
            {
                _monitor?.Log($"Chat hook failed: {ex.Message}", LogLevel.Warn);
            }
        }
    }
}
