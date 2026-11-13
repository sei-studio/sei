// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
//
// The companion's look, in the vanilla character creator's terms (hair style,
// skin variant, colours). The Sei app picks it from the character card; the
// mod clamps every field against the game before use. Drawn by the vanilla
// player renderer, so no art ships with the mod.

using System;
using System.IO;
using System.Text.Json.Nodes;
using Microsoft.Xna.Framework;
using SeiCompanion.Link;

namespace SeiCompanion.Body
{
	public sealed class Appearance
	{
		public int Hair = 15;
		public int SkinVariant = 4; // 0-3 male, 4-7 female, 8-9 male alt, 10-11 female alt
		public Color HairColor = new(215, 215, 230);
		public Color SkinColor = new(255, 220, 200);
		public Color EyeColor = new(90, 140, 230);
		public Color ShirtColor = new(110, 150, 230);
		public Color UnderShirtColor = new(235, 235, 245);
		public Color PantsColor = new(70, 80, 120);
		public Color ShoeColor = new(60, 50, 60);

		public static Appearance FromJson(JsonObject o)
		{
			var a = new Appearance();
			if (o == null) return a;
			int hairMax = 0;
			try { hairMax = Terraria.ID.HairID.Count - 1; } catch { hairMax = 164; }
			a.Hair = Math.Clamp(Json.Int(o, "hair", a.Hair), 0, Math.Max(0, hairMax));
			a.SkinVariant = Math.Clamp(Json.Int(o, "skinVariant", a.SkinVariant), 0, 11);
			a.HairColor = ParseColor(Json.Str(o, "hairColor"), a.HairColor);
			a.SkinColor = ParseColor(Json.Str(o, "skinColor"), a.SkinColor);
			a.EyeColor = ParseColor(Json.Str(o, "eyeColor"), a.EyeColor);
			a.ShirtColor = ParseColor(Json.Str(o, "shirtColor"), a.ShirtColor);
			a.UnderShirtColor = ParseColor(Json.Str(o, "underShirtColor"), a.UnderShirtColor);
			a.PantsColor = ParseColor(Json.Str(o, "pantsColor"), a.PantsColor);
			a.ShoeColor = ParseColor(Json.Str(o, "shoeColor"), a.ShoeColor);
			return a;
		}

		public static Color ParseColor(string hex, Color fallback)
		{
			if (string.IsNullOrEmpty(hex)) return fallback;
			hex = hex.Trim().TrimStart('#');
			if (hex.Length != 6) return fallback;
			try
			{
				int v = Convert.ToInt32(hex, 16);
				return new Color((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
			}
			catch { return fallback; }
		}

		public void Write(BinaryWriter w)
		{
			w.Write((short)Hair);
			w.Write((byte)SkinVariant);
			foreach (var c in new[] { HairColor, SkinColor, EyeColor, ShirtColor, UnderShirtColor, PantsColor, ShoeColor })
			{
				w.Write(c.R); w.Write(c.G); w.Write(c.B);
			}
		}

		public static Appearance Read(BinaryReader r)
		{
			var a = new Appearance
			{
				Hair = r.ReadInt16(),
				SkinVariant = r.ReadByte(),
			};
			Color C() => new(r.ReadByte(), r.ReadByte(), r.ReadByte());
			a.HairColor = C(); a.SkinColor = C(); a.EyeColor = C(); a.ShirtColor = C();
			a.UnderShirtColor = C(); a.PantsColor = C(); a.ShoeColor = C();
			return a;
		}
	}
}
