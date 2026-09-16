using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;
using SeiCompanion.Body;
using SeiCompanion.Observe;

namespace SeiCompanion.Actions
{
    /// <summary>A sub-routine's outcome, written by the callee so the caller can decide (a yielded Result ends the whole command).</summary>
    public sealed class Outcome
    {
        public bool Ok = true;
        public string Detail = "";
        public void Fail(string detail) { this.Ok = false; this.Detail = detail; }
        public void Pass(string detail = "") { this.Ok = true; this.Detail = detail; }
    }

    /// <summary>Where a verb was pointed: a tile in some location, and the handle behind it when there was one.</summary>
    public sealed class Target
    {
        public string LocationName;
        public Point Tile;
        public Handle Handle;
        public bool HasTile;

        public Vector2 TileVec => new Vector2(this.Tile.X, this.Tile.Y);
    }

    public static class Targets
    {
        /// <summary>Resolve `target` ("#N"), or `x`/`y` (+ optional `location`), into a Target. Null with a reason when nothing usable was given.</summary>
        public static Target Resolve(ActionContext ctx, out string error)
        {
            error = null;
            SeiBody body = ctx.Body;
            string handleId = ctx.Str("target");
            if (!string.IsNullOrEmpty(handleId) && handleId.TrimStart().StartsWith("#"))
            {
                Handle h = body.Handles.Resolve(handleId);
                if (h == null)
                {
                    error = $"{handleId} is not a handle from a recent snapshot; use one from the current one";
                    return null;
                }
                var t = new Target { Handle = h, HasTile = true };
                if (h.Character != null)
                {
                    t.LocationName = h.Character.currentLocation?.NameOrUniqueName ?? h.LocationName;
                    t.Tile = h.Character.TilePoint;
                }
                else if (h.Farmer != null)
                {
                    t.LocationName = h.Farmer.currentLocation?.NameOrUniqueName ?? h.LocationName;
                    t.Tile = h.Farmer.TilePoint;
                }
                else
                {
                    t.LocationName = h.LocationName;
                    t.Tile = h.Tile;
                }
                return t;
            }
            int? x = ctx.Int("x");
            int? y = ctx.Int("y");
            string location = ctx.Str("location");
            if (x.HasValue && y.HasValue)
            {
                return new Target
                {
                    LocationName = string.IsNullOrEmpty(location) ? body.LocationName : location,
                    Tile = new Point(x.Value, y.Value),
                    HasTile = true,
                };
            }
            if (!string.IsNullOrEmpty(location))
                return new Target { LocationName = location, HasTile = false };
            error = "give a #N handle from the snapshot, or x and y";
            return null;
        }

        public static int Chebyshev(Point a, Point b) => Math.Max(Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
        public static int Chebyshev(Vector2 a, Vector2 b) => (int)Math.Max(Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));

        public static string Fmt(Point p) => $"({p.X},{p.Y})";
    }
}
