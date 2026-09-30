using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Monsters;
using StardewValley.Tools;
using SeiCompanion.Body;
using SeiCompanion.Observe;

namespace SeiCompanion.Actions
{
    /// <summary>
    /// Melee for the shadow. MeleeWeapon.DoDamage returns early for any farmer
    /// that is not the local player, so a swing is location.damageMonster with
    /// the weapon's own numbers (or fists), aimed at the tile the body faces.
    /// </summary>
    public static class Combat
    {
        public const int SwingIntervalMs = 500;

        public static bool Swing(SeiBody body, Monster target)
        {
            GameLocation loc = body.Npc.currentLocation;
            if (loc == null) return false;
            body.SyncShadow();
            body.Shadow.FaceToward(target.Tile);
            body.Npc.faceDirection(body.Shadow.FacingDirection);
            MeleeWeapon weapon = body.FindWeapon();
            int slot = weapon != null ? body.SlotOf(weapon) : -1;
            if (slot >= 0) body.Shadow.CurrentToolIndex = slot;
            int min = weapon?.minDamage.Value ?? 1;
            int max = weapon?.maxDamage.Value ?? 3;
            float knockback = weapon?.knockback.Value ?? 1f;
            int precision = weapon?.addedPrecision.Value ?? 0;
            float crit = weapon?.critChance.Value ?? 0.02f;
            float critMult = weapon?.critMultiplier.Value ?? 3f;
            Rectangle area = AreaInFront(body);
            // Also cover the target's own box so a diagonal neighbour is hit.
            area = Rectangle.Union(area, target.GetBoundingBox());
            bool hit;
            try
            {
                hit = loc.damageMonster(area, min, max, false, knockback, precision, crit, critMult, true, body.Shadow);
            }
            catch (Exception ex)
            {
                body.Monitor.Log($"{body.Name}: damageMonster threw: {ex.Message}", StardewModdingAPI.LogLevel.Debug);
                hit = false;
            }
            try { loc.playSound(weapon != null ? "swordswipe" : "clubhit", body.Npc.Tile); } catch { }
            try { body.Npc.jump(3f); } catch { }
            return hit;
        }

        public static Rectangle AreaInFront(SeiBody body)
        {
            Rectangle box = body.Npc.GetBoundingBox();
            int x = box.X, y = box.Y;
            switch (body.Shadow.FacingDirection)
            {
                case 0: y -= 64; break;
                case 1: x += 64; break;
                case 2: y += 64; break;
                case 3: x -= 64; break;
            }
            var r = new Rectangle(x - 16, y - 16, box.Width + 32, box.Height + 32);
            return r;
        }

        public static IEnumerable<object> Attack(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            Target t = Targets.Resolve(ctx, out string err);
            Monster monster = t?.Handle?.Character as Monster;
            if (monster == null)
            {
                // No handle: the nearest monster in reach.
                monster = Nearest(body, 12f);
                if (monster == null) { yield return Result.Fail(err ?? "no monster in sight to attack; use a #N handle from the snapshot"); yield break; }
            }
            int times = Math.Clamp(ctx.Int("times") ?? 5, 1, 12);
            string label = monster.displayName ?? monster.Name;
            int swings = 0;
            for (int i = 0; i < times * 3 && swings < times; i++)
            {
                if (ctx.Cancelled) yield break;
                if (monster.Health <= 0 || monster.currentLocation != body.Npc.currentLocation)
                {
                    yield return Result.Success(swings > 0 ? $"{label} is down after {swings} hits" : $"{label} is already gone");
                    yield break;
                }
                float dist = Vector2.Distance(monster.Tile, body.Npc.Tile);
                if (dist > 1.6f)
                {
                    var walk = new Outcome();
                    yield return Movement.WalkTo(ctx, monster.TilePoint, true, walk);
                    if (!walk.Ok)
                    {
                        yield return Result.Fail(swings > 0 ? $"hit {label} {swings} times, then it moved out of reach ({walk.Detail})" : $"cannot reach {label}: {walk.Detail}");
                        yield break;
                    }
                    continue;
                }
                bool hit = Swing(body, monster);
                swings++;
                ctx.Progress(hit ? $"hit {label} ({monster.Health} hp left)" : $"missed {label}");
                yield return WaitTicks.Ms(SwingIntervalMs);
            }
            yield return monster.Health <= 0
                ? Result.Success($"{label} is down after {swings} hits")
                : Result.Success($"hit {label} {swings} times; it has {Math.Max(0, monster.Health)} hp left");
        }

        public static Monster Nearest(SeiBody body, float maxTiles)
        {
            GameLocation loc = body.Npc?.currentLocation;
            if (loc == null) return null;
            Monster best = null;
            float bestDist = maxTiles;
            foreach (NPC c in loc.characters)
            {
                if (c is Monster m && !m.IsInvisible && m.Health > 0)
                {
                    float d = Vector2.Distance(m.Tile, body.Npc.Tile);
                    if (d <= bestDist) { bestDist = d; best = m; }
                }
            }
            return best;
        }
    }
}
