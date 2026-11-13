// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// Remembers which companion fired a projectile so a kill by her arrow or
// spell counts as hers (the attack verb reports "defeated" vs "gone").

using SeiCompanion.Systems;
using Terraria;
using Terraria.ModLoader;

namespace SeiCompanion.Body
{
	public class CompanionShot : GlobalProjectile
	{
		public override bool InstancePerEntity => true;

		/// <summary>NPC slot of the companion that fired it, or -1.</summary>
		public int Shooter = -1;

		public override void OnHitNPC(Projectile projectile, NPC target, NPC.HitInfo hit, int damageDone)
		{
			if (Shooter < 0 || target.life > 0) return;
			var c = SeiSystem.ForNpc(Shooter);
			if (c == null) return;
			c.Kills++;
			c.LastKill = target.GivenOrTypeName;
		}
	}
}
