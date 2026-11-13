// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// The in-game half of the Sei desktop app's Terraria companion. The app's bot
// process (the brain) talks to this mod over a localhost WebSocket; the mod
// owns the companion's body: a server-side NPC drawn with the vanilla player
// renderer, its pathing, combat and survival reflexes, and the verbs the
// brain may call. See ../PROTOCOL.md.

using log4net;
using SeiCompanion.Link;
using Terraria;
using Terraria.ModLoader;

namespace SeiCompanion
{
	public class SeiMod : Mod
	{
		public static SeiMod Instance { get; private set; }
		public static ILog Log => Instance?.Logger;
		public static LinkConfig Config { get; private set; }
		public static Bridge Bridge { get; private set; }

		public override void Load()
		{
			Instance = this;
			Config = LinkConfig.Load();
			Bridge = new Bridge(Config);
			Bridge.Start();
			if (!Main.dedServ)
				Body.Puppet.Load();
		}

		public override void Unload()
		{
			try { Bridge?.Stop(); } catch { }
			Bridge = null;
			GameThread.Clear();
			Systems.SeiSystem.ClearAll();
			Body.Puppet.Unload();
			Config = null;
			Instance = null;
		}
	}
}
