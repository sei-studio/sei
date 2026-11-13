// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// The link settings the Sei app writes at install time:
//   <tModLoader save folder>/SeiCompanion/link.json
//   { "port": 27460, "token": "...", "devCommands": false, "headlessTick": false }
// Main.SavePath is the tModLoader save root (honours -tmlsavedirectory), so a
// test server with its own save folder reads its own link.json.

using System;
using System.IO;
using System.Text.Json.Nodes;
using Terraria;

namespace SeiCompanion.Link
{
	public sealed class LinkConfig
	{
		/// <summary>First port tried; the bridge walks PortSpan ports from here.</summary>
		public const int DefaultPort = 27460;
		/// <summary>Ports tried in order. Host and Play runs a client AND a server process with the mod, so two bridges can be up at once.</summary>
		public const int PortSpan = 5;

		public int Port = DefaultPort;
		public string Token = "";
		/// <summary>Developer frames (spawn test enemies, give items, anchors). The app never sets it.</summary>
		public bool DevCommands;
		/// <summary>Dedicated server only: run world updates with no client joined (test harness). The app never sets it.</summary>
		public bool HeadlessTick;
		public string LoadedFrom = "";

		public static string DirPath => Path.Combine(Main.SavePath, "SeiCompanion");
		public static string FilePath => Path.Combine(DirPath, "link.json");

		public static LinkConfig Load()
		{
			var cfg = new LinkConfig();
			try
			{
				string path = FilePath;
				cfg.LoadedFrom = path;
				if (!File.Exists(path))
					return cfg;
				var node = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
				if (node == null)
					return cfg;
				cfg.Port = Json.Int(node, "port", DefaultPort);
				if (cfg.Port < 1024 || cfg.Port > 65000)
					cfg.Port = DefaultPort;
				cfg.Token = Json.Str(node, "token", "");
				cfg.DevCommands = Json.Bool(node, "devCommands", false);
				cfg.HeadlessTick = Json.Bool(node, "headlessTick", false);
			}
			catch (Exception e)
			{
				SeiMod.Log?.Warn($"[Sei] link.json unreadable: {e.Message}");
			}
			return cfg;
		}
	}
}
