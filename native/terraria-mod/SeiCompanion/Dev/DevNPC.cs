// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
// Dev harness only: NPCs spawned by devSpawn stay in the world on a headless
// server (vanilla despawns anything with no player nearby at once).

using Terraria;
using Terraria.ModLoader;

namespace SeiCompanion.Dev
{
	public class DevNPC : GlobalNPC
	{
		public override bool InstancePerEntity => true;
		public bool Pinned;

		public override bool CheckActive(NPC npc) => !Pinned;
	}
}
