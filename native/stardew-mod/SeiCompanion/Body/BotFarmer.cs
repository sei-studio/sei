// Adapted from Farmtronics (https://github.com/JoeStrout/Farmtronics), MIT
// License, Copyright (c) 2021 JoeStrout, and from amarisaster/StardewValley-MCP
// (https://github.com/amarisaster/StardewValley-MCP), Apache License 2.0
// (see ../THIRD_PARTY_NOTICES.md). The invisible shadow-Farmer pattern is
// theirs; the Sei changes are the modData wallet and the tick-free design
// (the shadow is never updated by the game loop, only synced from the NPC).
using System;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewValley;

namespace SeiCompanion.Body
{
    /// <summary>
    /// The mechanics half of a companion: an invisible Farmer instance that
    /// tools, combat, fishing, placement and inventory code accept as `who`.
    /// NEVER added to Game1.otherFarmers (Multiplayer.updateRoots walks that
    /// table every tick expecting net-backed farmers and NPEs on a hand-built
    /// one) and never given to location.farmers (monsters would target it and
    /// its Update is never run). Position, location and facing are copied
    /// from the visible NPC before every use (SeiBody.SyncShadow).
    /// </summary>
    public class BotFarmer : Farmer
    {
        /// <summary>Marks this farmer as a Sei body (never a real player).</summary>
        public bool IsSeiBody { get; } = true;

        /// <summary>The companion's own wallet. Farmer.Money throws for any farmer other than Game1.player, so it lives here.</summary>
        public int Gold { get; set; }

        /// <summary>
        /// No-op on purpose, still (260921). The farmer IS the visual now, but
        /// it is drawn by BodyDraw from inside the paired NPC's draw call, at
        /// the NPC's position and depth, through FarmerRenderer directly.
        /// Farmer.draw would also draw a second ground shadow, the held tool
        /// and the username, and would run for any game path that happens to
        /// hold this farmer; keeping it empty keeps one draw path.
        /// </summary>
        public override void draw(SpriteBatch b)
        {
        }

        public override void SetMovingUp(bool b)
        {
            if (!b) Halt();
            else moveUp = true;
        }

        public override void SetMovingRight(bool b)
        {
            if (!b) Halt();
            else moveRight = true;
        }

        public override void SetMovingDown(bool b)
        {
            if (!b) Halt();
            else moveDown = true;
        }

        public override void SetMovingLeft(bool b)
        {
            if (!b) Halt();
            else moveLeft = true;
        }

        /// <summary>Face a tile from the shadow's current position (4-way).</summary>
        public void FaceToward(Vector2 tile)
        {
            Vector2 diff = tile * 64f + new Vector2(32f, 32f) - (this.Position + new Vector2(32f, 32f));
            if (Math.Abs(diff.X) > Math.Abs(diff.Y))
                this.FacingDirection = diff.X > 0 ? 1 : 3;
            else
                this.FacingDirection = diff.Y > 0 ? 2 : 0;
        }

        /// <summary>Restore vitals for a new day (the game does this for real farmers only).</summary>
        public void WakeUp()
        {
            this.isInBed.Value = false;
            this.Stamina = this.MaxStamina;
            this.health = this.maxHealth;
            this.exhausted.Value = false;
        }
    }
}
