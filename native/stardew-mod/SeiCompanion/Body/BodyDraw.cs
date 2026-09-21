using System;
using System.Collections.Generic;
using HarmonyLib;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewValley;

namespace SeiCompanion.Body
{
    /// <summary>
    /// Draws a companion as its customized shadow Farmer in place of the
    /// NPC's placeholder sprite (260921).
    ///
    /// The NPC stays the body in every other sense (pathing, collision, the
    /// barrier hop, location.characters, the speech bubble, emotes, the
    /// ground shadow), so nothing that depends on it changed. Only its draw
    /// is replaced, with a Harmony prefix on NPC.draw(SpriteBatch, float):
    /// - A prefix, not an SMAPI Rendered* event, because the farmer has to be
    ///   drawn INSIDE the world's depth-sorted sprite batch to pass behind
    ///   trees and in front of fences like everyone else. An event draw
    ///   would sit on top of the whole map.
    /// - A prefix, not an NPC subclass, because location.characters is a
    ///   NetCollection of NPC and a save/net path that meets an unknown
    ///   subclass is a crash this mod does not need.
    /// - The shadow is still never in Game1.otherFarmers or location.farmers
    ///   (BotFarmer.cs); FarmerRenderer.draw only reads the farmer it is
    ///   handed, so it does not need to be.
    /// The ground shadow needs nothing: Game1.DrawWorld draws every
    /// character's shadow separately from NPC.draw (decompiled 1.6.15).
    ///
    /// Host only. A farmhand's game has no registry entry for the NPC, so it
    /// draws the placeholder sprite there as before.
    /// </summary>
    public static class BodyDraw
    {
        /// <summary>
        /// An NPC's sprite bottom sits 48px below its Position and a farmer's
        /// 32px (NPC bounding box is y+16..y+48, a farmer's y..y+32; both
        /// draw feet-at-box-bottom). Drawing the farmer this much lower puts
        /// its feet where the NPC's collision box and ground shadow are.
        /// </summary>
        private const float FeetOffsetY = 16f;

        /// <summary>
        /// Farmer.draw's origin with no x/y offset: (0, (128 - boxHeight/2) / 4 + 4)
        /// with the farmer's 32px box. FarmerRenderer adds it to the position
        /// and draws with it, so the 16x32 frame lands 96px above the position.
        /// </summary>
        private static readonly Vector2 FarmerOrigin = new Vector2(0f, 32f);

        private static readonly Dictionary<NPC, SeiBody> Bodies = new Dictionary<NPC, SeiBody>();
        private static IMonitor _monitor;

        public static void Apply(Harmony harmony, IMonitor monitor)
        {
            _monitor = monitor;
            try
            {
                harmony.Patch(
                    original: AccessTools.Method(typeof(NPC), nameof(NPC.draw), new[] { typeof(SpriteBatch), typeof(float) }),
                    prefix: new HarmonyMethod(typeof(BodyDraw), nameof(Draw_Prefix))
                );
            }
            catch (Exception ex)
            {
                monitor.Log($"Could not hook NPC.draw; companions keep the placeholder sprite: {ex.Message}", LogLevel.Warn);
            }
        }

        public static void Register(SeiBody body)
        {
            if (body?.Npc != null)
                Bodies[body.Npc] = body;
        }

        public static void Unregister(SeiBody body)
        {
            if (body?.Npc != null)
                Bodies.Remove(body.Npc);
        }

        /// <summary>Harmony prefix. False skips the NPC's own draw. Parameter names must match the original's.</summary>
        public static bool Draw_Prefix(NPC __instance, SpriteBatch b, float alpha)
        {
            // One dictionary miss per villager per frame; nothing when no body is out.
            if (Bodies.Count == 0 || !Bodies.TryGetValue(__instance, out SeiBody body) || !body.FarmerLook)
                return true;
            try
            {
                DrawFarmer(body, b, alpha);
                return false;
            }
            catch (Exception ex)
            {
                // A look must never cost the player their game: fall back to the
                // placeholder for this body for good and say so once.
                body.FarmerLook = false;
                _monitor?.Log($"{body.Name}: farmer draw failed, using the placeholder sprite: {ex}", LogLevel.Warn);
                return true;
            }
        }

        private static void DrawFarmer(SeiBody body, SpriteBatch b, float alpha)
        {
            NPC npc = body.Npc;
            BotFarmer farmer = body.Shadow;
            if (npc.IsInvisible || !Utility.isOnScreen(npc.Position, 128))
                return;

            // The NPC's own depth rule, so sorting matches the body that collides.
            float layer = Math.Max(0f, npc.drawOnTop ? 0.991f : npc.StandingPixel.Y / 10000f);
            // getLocalPosition already carries yJumpOffset (the tool-use hop) and drawOffset.
            Vector2 position = npc.getLocalPosition(Game1.viewport) + new Vector2(0f, FeetOffsetY);
            if (npc.shakeTimer > 0)
                position += new Vector2(Game1.random.Next(-1, 2), Game1.random.Next(-1, 2));

            FarmerSprite sprite = farmer.FarmerSprite;
            farmer.FarmerRenderer.draw(b, sprite, sprite.SourceRect, position, FarmerOrigin, layer, Color.White * alpha, 0f, farmer);
            npc.DrawEmote(b);
        }
    }
}
