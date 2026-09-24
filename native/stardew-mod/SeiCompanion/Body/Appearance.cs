using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;

namespace SeiCompanion.Body
{
    /// <summary>
    /// How a companion looks: the knobs of the game's own character creator
    /// (gender, skin, hair + color, eyes, shirt, pants + color, accessory),
    /// sent by the Sei app in the optional `appearance` object of the `spawn`
    /// frame (PROTOCOL.md) and applied to the shadow Farmer through the
    /// game's own change* methods.
    ///
    /// The socket is never trusted: every field is checked against what THIS
    /// game accepts (Farmer.GetAllHairstyleIndices, Game1.shirtData /
    /// pantsData, the 0..23 skin and -1..29 accessory ranges the change*
    /// methods themselves wrap at) and a field that fails keeps the default.
    /// Checking against the game rather than against the app's curated legend
    /// (src/shared/stardewAppearance.ts) is deliberate: the legend can grow
    /// without a mod rebuild, and a modded game with extra hairstyles works.
    /// </summary>
    public sealed class Appearance
    {
        public bool Male;
        public int Skin;
        public int Hair = 47;
        public Color HairColor = new Color(122, 74, 42);
        public Color EyeColor = new Color(90, 58, 30);
        public string Shirt = "1005";
        public string Pants = "0";
        public Color PantsColor = new Color(46, 85, 183);
        public int Accessory = -1;

        /// <summary>True when at least one field came from the app (false = the neutral default look).</summary>
        public bool Custom;

        /// <summary>Fields the socket sent that the game refused, for the log and the dev frame.</summary>
        public List<string> Rejected { get; } = new List<string>();

        /// <summary>
        /// Build from the spawn frame's `appearance` element. Anything missing,
        /// mistyped or out of range keeps the default for that field. Runs on
        /// the game thread (it reads game data).
        /// </summary>
        public static Appearance FromJson(JsonElement el)
        {
            var a = new Appearance();
            if (el.ValueKind != JsonValueKind.Object)
                return a;

            if (el.TryGetProperty("gender", out JsonElement g) && g.ValueKind == JsonValueKind.String)
            {
                string s = (g.GetString() ?? "").Trim().ToLowerInvariant();
                if (s == "male" || s == "female") { a.Male = s == "male"; a.Custom = true; }
                else a.Rejected.Add("gender");
            }

            if (TryInt(el, "skin", out int skin))
            {
                if (skin >= 0 && skin <= 23) { a.Skin = skin; a.Custom = true; }
                else a.Rejected.Add("skin");
            }

            if (TryInt(el, "hair", out int hair))
            {
                bool known;
                try { known = Farmer.GetAllHairstyleIndices().Contains(hair); }
                catch { known = hair >= 0 && hair <= 55; }
                if (known) { a.Hair = hair; a.Custom = true; }
                else a.Rejected.Add("hair");
            }

            if (TryInt(el, "accessory", out int acc))
            {
                if (acc >= -1 && acc <= 29) { a.Accessory = acc; a.Custom = true; }
                else a.Rejected.Add("accessory");
            }

            // Shirts and pants are string item ids in 1.6; the app sends the number.
            if (TryInt(el, "shirt", out int shirt))
            {
                string id = shirt.ToString(CultureInfo.InvariantCulture);
                bool known;
                try { known = Game1.shirtData != null && Game1.shirtData.ContainsKey(id); }
                catch { known = false; }
                if (known) { a.Shirt = id; a.Custom = true; }
                else a.Rejected.Add("shirt");
            }

            if (TryInt(el, "pants", out int pants))
            {
                string id = pants.ToString(CultureInfo.InvariantCulture);
                bool known;
                try { known = Game1.pantsData != null && Game1.pantsData.ContainsKey(id); }
                catch { known = false; }
                if (known) { a.Pants = id; a.Custom = true; }
                else a.Rejected.Add("pants");
            }

            if (TryColor(el, "hairColor", a.Rejected, out Color hc)) { a.HairColor = hc; a.Custom = true; }
            if (TryColor(el, "eyeColor", a.Rejected, out Color ec)) { a.EyeColor = ec; a.Custom = true; }
            if (TryColor(el, "pantsColor", a.Rejected, out Color pc)) { a.PantsColor = pc; a.Custom = true; }
            return a;
        }

        /// <summary>
        /// Dress a farmer. Gender goes first because changeGender swaps the
        /// base texture and re-applies the shirt; hair goes after it because
        /// the bald styles swap the base texture again.
        /// </summary>
        public void ApplyTo(Farmer f)
        {
            f.changeGender(this.Male);
            f.changeSkinColor(this.Skin, true);
            f.changeHairStyle(this.Hair);
            f.changeHairColor(this.HairColor);
            f.changeEyeColor(this.EyeColor);
            f.changeShirt(this.Shirt);
            f.changePantStyle(this.Pants);
            f.changePantsColor(this.PantsColor);
            f.changeAccessory(this.Accessory);
        }

        /// <summary>What the farmer actually carries now, read back from its own fields (dev frame).</summary>
        public static Dictionary<string, object> Read(Farmer f)
        {
            return new Dictionary<string, object>
            {
                ["gender"] = f.IsMale ? "male" : "female",
                ["skin"] = f.skin.Value,
                ["hair"] = f.hair.Value,
                ["hairColor"] = Hex(f.hairstyleColor.Value),
                ["eyeColor"] = Hex(f.newEyeColor.Value),
                ["shirt"] = f.shirt.Value,
                ["pants"] = f.pants.Value,
                ["pantsColor"] = Hex(f.pantsColor.Value),
                ["accessory"] = f.accessory.Value,
            };
        }

        public static string Hex(Color c)
        {
            return $"#{c.R:x2}{c.G:x2}{c.B:x2}";
        }

        private static bool TryInt(JsonElement el, string name, out int value)
        {
            value = 0;
            return el.TryGetProperty(name, out JsonElement p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out value);
        }

        /// <summary>"#rrggbb" only. A present field that does not parse is recorded as rejected.</summary>
        private static bool TryColor(JsonElement el, string name, List<string> rejected, out Color color)
        {
            color = Color.White;
            if (!el.TryGetProperty(name, out JsonElement p))
                return false;
            string s = p.ValueKind == JsonValueKind.String ? (p.GetString() ?? "").Trim() : "";
            if (s.Length == 7 && s[0] == '#'
                && int.TryParse(s.AsSpan(1, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int r)
                && int.TryParse(s.AsSpan(3, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int g)
                && int.TryParse(s.AsSpan(5, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int b))
            {
                color = new Color(r, g, b);
                return true;
            }
            rejected.Add(name);
            return false;
        }
    }
}
