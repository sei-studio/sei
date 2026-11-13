// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// The companion's body: a friendly NPC owned by the world's authority (single
// player, or the server), so vanilla netcode syncs its position and health to
// every client. A fake Player in a server slot does not survive: the server's
// Netplay loop deactivates every player slot without a connected client.
//
// Clients draw it with the vanilla player renderer (Puppet.cs) in the look
// the app chose; if that ever fails, the vanilla Guide sprite is the fallback.
// No new art ships with the mod.

using System.IO;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using SeiCompanion.Systems;
using Terraria;
using Terraria.ID;
using Terraria.ModLoader;

namespace SeiCompanion.Body
{
	public class CompanionNPC : ModNPC
	{
		public string CName = "Sei";
		public Appearance Look = new();
		public readonly int[] ArmorTypes = { 0, 0, 0 };
		public int HeldType;
		public bool Knocked;

		public override string Texture => "Terraria/Images/NPC_" + NPCID.Guide;

		public override void SetStaticDefaults()
		{
			Main.npcFrameCount[Type] = 25;
			NPCID.Sets.NPCBestiaryDrawOffset[Type] = new NPCID.Sets.NPCBestiaryDrawModifiers { Hide = true };
		}

		public override void SetDefaults()
		{
			NPC.width = 16;
			NPC.height = 40;
			NPC.friendly = true;
			NPC.aiStyle = -1;
			NPC.damage = 0;
			NPC.defense = 2;
			NPC.lifeMax = 100;
			NPC.life = 100;
			NPC.knockBackResist = 0.4f;
			NPC.HitSound = SoundID.NPCHit1;
			NPC.DeathSound = SoundID.NPCDeath1;
			NPC.netAlways = true;
			NPC.npcSlots = 0f;
			NPC.dontCountMe = true;
			NPC.chaseable = false;
			NPC.rarity = 0;
		}

		public override bool CheckActive() => false;

		public override bool NeedSaving() => false;

		public override bool CheckDead()
		{
			var c = SeiSystem.ForNpc(NPC.whoAmI);
			if (c == null) return true;
			c.OnKnockedOut(NPC);
			return false;
		}

		public override bool? CanFallThroughPlatforms() => NPC.ai[3] > 0f;

		public override bool? CanBeHitByItem(Player player, Item item) => false;

		public override bool? CanBeHitByProjectile(Projectile projectile) => projectile.hostile ? null : false;

		public override bool CanHitNPC(NPC target) => false;

		public override bool CanChat() => false;

		private int _netTick;

		public override void AI()
		{
			if (Main.netMode == NetmodeID.MultiplayerClient) return; // clients only draw; the server moves it
			var c = SeiSystem.ForNpc(NPC.whoAmI);
			if (c == null)
			{
				// Orphan (the bot left and the grace window ran out, or a reload): remove it.
				NPC.active = false;
				if (Main.netMode == NetmodeID.Server) NetMessage.SendData(MessageID.SyncNPC, -1, -1, null, NPC.whoAmI);
				return;
			}
			var oldVel = NPC.velocity;
			c.Tick(NPC);
			NPC.ai[2] = c.SwingTicks;
			NPC.ai[3] = c.Motor.DropTicks > 0 ? 1f : 0f;
			bool knocked = c.KnockedTicks > 0;
			if (knocked != Knocked) { Knocked = knocked; NPC.netUpdate = true; }
			int held = c.Weapon?.type ?? 0;
			if (held != HeldType) { Sync(c); NPC.netUpdate = true; }
			if (Main.netMode == NetmodeID.Server && (++_netTick >= 6 && NPC.velocity != Vector2.Zero || Vector2.DistanceSquared(oldVel, NPC.velocity) > 4f))
			{
				_netTick = 0;
				NPC.netUpdate = true;
			}
		}

		public void Sync(Companion c)
		{
			CName = c.Name;
			Look = c.Look;
			for (int i = 0; i < 3; i++) ArmorTypes[i] = c.Armor[i] != null && !c.Armor[i].IsAir ? c.Armor[i].type : 0;
			HeldType = c.Weapon?.type ?? 0;
			Knocked = c.KnockedTicks > 0;
			NPC.GivenName = c.Name;
		}

		public override void SendExtraAI(BinaryWriter writer)
		{
			writer.Write(CName ?? "");
			(Look ?? new Appearance()).Write(writer);
			foreach (int t in ArmorTypes) writer.Write((short)t);
			writer.Write((short)HeldType);
			writer.Write(Knocked);
		}

		public override void ReceiveExtraAI(BinaryReader reader)
		{
			CName = reader.ReadString();
			Look = Appearance.Read(reader);
			for (int i = 0; i < 3; i++) ArmorTypes[i] = reader.ReadInt16();
			HeldType = reader.ReadInt16();
			Knocked = reader.ReadBoolean();
			NPC.GivenName = CName;
		}

		public override void FindFrame(int frameHeight)
		{
			// Guide-sprite fallback only (the puppet animates itself).
			if (NPC.velocity.Y != 0f) { NPC.frame.Y = frameHeight; return; }
			if (System.Math.Abs(NPC.velocity.X) < 0.2f) { NPC.frame.Y = 0; NPC.frameCounter = 0; return; }
			NPC.frameCounter += System.Math.Abs(NPC.velocity.X) * 0.6f;
			int f = 2 + (int)(NPC.frameCounter / 6) % 14;
			NPC.frame.Y = f * frameHeight;
		}

		public override bool PreDraw(SpriteBatch spriteBatch, Vector2 screenPos, Color drawColor)
		{
			return !Puppet.Draw(this, NPC);
		}
	}
}
