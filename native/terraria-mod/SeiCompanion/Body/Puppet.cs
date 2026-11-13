// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// Client-side look: each companion NPC is drawn as a player through the
// vanilla player renderer (the way mannequins draw their doll), using a
// private Player object that never enters Main.player. Hair, skin and
// clothes come from the app's appearance; armour and the held weapon from
// what the brain equipped. Any failure turns the puppet off for the session
// and the NPC falls back to the vanilla Guide sprite.

using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Terraria;

namespace SeiCompanion.Body
{
	public static class Puppet
	{
		private static Dictionary<int, Player> _players;
		private static bool _failed;

		public static void Load()
		{
			_players = new Dictionary<int, Player>();
			_failed = false;
		}

		public static void Unload()
		{
			_players = null;
		}

		/// <summary>Draws the companion; false = fall back to the NPC sprite.</summary>
		public static bool Draw(CompanionNPC m, NPC npc)
		{
			if (_failed || Main.dedServ || _players == null) return false;
			try
			{
				if (!_players.TryGetValue(npc.whoAmI, out var p))
				{
					p = new Player();
					_players[npc.whoAmI] = p;
				}
				Dress(p, m, npc);
				Main.PlayerRenderer.DrawPlayer(Main.Camera, p, p.position, 0f, Vector2.Zero, m.Knocked ? 0.6f : 0f, 1f);
				return true;
			}
			catch (Exception e)
			{
				_failed = true;
				SeiMod.Log?.Warn($"[Sei] player-style drawing failed, using the fallback sprite: {e.Message}");
				return false;
			}
		}

		private static void SetItem(ref Item slot, int type)
		{
			if (slot == null) slot = new Item();
			if (slot.type == type) return;
			if (type > 0) slot.SetDefaults(type); else slot.TurnToAir();
		}

		private static void Dress(Player p, CompanionNPC m, NPC npc)
		{
			var a = m.Look ?? new Appearance();
			p.name = m.CName;
			p.whoAmI = Main.maxPlayers;
			p.active = true;
			p.dead = false;
			p.hair = a.Hair;
			p.skinVariant = a.SkinVariant;
			p.hairColor = a.HairColor;
			p.skinColor = a.SkinColor;
			p.eyeColor = a.EyeColor;
			p.shirtColor = a.ShirtColor;
			p.underShirtColor = a.UnderShirtColor;
			p.pantsColor = a.PantsColor;
			p.shoeColor = a.ShoeColor;
			for (int i = 0; i < 3; i++) SetItem(ref p.armor[i], m.ArmorTypes[i]);
			SetItem(ref p.inventory[0], m.HeldType);
			p.selectedItem = 0;
			p.head = p.armor[0].IsAir ? -1 : p.armor[0].headSlot;
			p.body = p.armor[1].IsAir ? -1 : p.armor[1].bodySlot;
			p.legs = p.armor[2].IsAir ? -1 : p.armor[2].legSlot;
			p.direction = npc.spriteDirection == 0 ? 1 : npc.spriteDirection;
			p.gravDir = 1f;
			p.velocity = npc.velocity;
			p.position = new Vector2(npc.Center.X - p.width / 2f, npc.position.Y + npc.height - p.height);
			p.gfxOffY = npc.gfxOffY;
			p.ResetVisibleAccessories();
			p.UpdateDyes();

			// Frames: 56px rows on the player sheet. 0 stand, 5 airborne,
			// 6..19 walk; 1..4 the arm swing while she uses a tool or weapon.
			int legs;
			if (npc.velocity.Y != 0f) legs = 5;
			else if (Math.Abs(npc.velocity.X) > 0.3f)
			{
				npc.localAI[0] += Math.Abs(npc.velocity.X) * 1.3f;
				legs = 6 + (int)(npc.localAI[0] / 8f) % 14;
			}
			else { legs = 0; npc.localAI[0] = 0; }
			int body = legs;
			int swing = (int)npc.ai[2];
			if (swing > 0) body = 1 + Math.Min(3, (swing / 4) % 4);
			p.legFrame = new Rectangle(0, legs * 56, 40, 56);
			p.bodyFrame = new Rectangle(0, body * 56, 40, 56);
			p.headFrame = p.bodyFrame;
		}
	}
}
