#nullable enable

using System;
using System.Collections;

namespace NeuroSdk.Internal
{
    internal static class WsUrlFinder
    {
        public static void FindWsUrl(Action<string> callback)
        {
            string? url = null;
            TryGetWsUrlFromEnvironment(ref url);

            // Sei: NEURO_SDK_WS_URL still wins (dev, tests); otherwise read the link file Sei main
            // writes each session. Called before every connect attempt, so a new port/token is picked up.
            if (url is null or "")
            {
                url = Sts2Agent.Sei.SeiLinkFile.ResolveUrl(() => null, Sts2Agent.Sei.SeiConfig.LinkDir());
            }

            callback(url ?? "");
        }
        private static void TryGetWsUrlFromEnvironment(ref string? url)
        {
            if (url is not null && url is not "") return;

            url = Environment.GetEnvironmentVariable("NEURO_SDK_WS_URL", EnvironmentVariableTarget.Process);
            if (url is not null && url is not "") return;

            url = Environment.GetEnvironmentVariable("NEURO_SDK_WS_URL", EnvironmentVariableTarget.User);
            if (url is not null && url is not "") return;

            url = Environment.GetEnvironmentVariable("NEURO_SDK_WS_URL", EnvironmentVariableTarget.Machine);
        }
    }
}
