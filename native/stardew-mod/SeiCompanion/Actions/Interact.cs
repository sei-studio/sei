using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Objects;
using SeiCompanion.Body;
using SeiCompanion.Observe;
using SObject = StardewValley.Object;

namespace SeiCompanion.Actions
{
    /// <summary>interact (warps, doors, ladders, chests, machines, forage, villagers) and sleep.</summary>
    public static class Interact
    {
        public static IEnumerable<object> Do(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            GameLocation loc = body.Npc.currentLocation;
            Target t = Targets.Resolve(ctx, out string err);
            if (t == null || !t.HasTile) { yield return Result.Fail(err ?? "interact needs a #N handle or x and y"); yield break; }
            Handle h = t.Handle;
            string kind = h?.Kind;

            // Villager / player: face them; talking happens in chat.
            if (h?.Character != null && !(h.Character is StardewValley.Monsters.Monster))
            {
                var walk = new Outcome();
                yield return Movement.WalkTo(ctx, h.Character.TilePoint, true, walk);
                if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
                try { h.Character.faceTowardFarmerForPeriod(2000, 2, false, body.Shadow); } catch { }
                yield return Result.Success($"standing with {h.Label}; villagers cannot hold a conversation with you yet, talk to the player in chat instead");
                yield break;
            }
            if (h?.Farmer != null)
            {
                var walk = new Outcome();
                yield return Movement.WalkTo(ctx, h.Farmer.TilePoint, true, walk);
                yield return walk.Ok ? Result.Success($"next to {h.Farmer.Name}") : Result.Fail(walk.Detail);
                yield break;
            }

            // A warp or a door out of this map.
            if (kind == "warp" || kind == "door")
            {
                Hop hop = Router.NearestExit(loc, t.TileVec, h?.Label);
                if (hop == null) { yield return Result.Fail("that exit is gone"); yield break; }
                var walk = new Outcome();
                yield return Movement.WalkTo(ctx, hop.StandTile, true, walk);
                if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
                // A door the model walks through on purpose ends following:
                // measured 260910, with the host still inside, the follow tick
                // routed the body straight back in, four times in a row.
                bool wasFollowing = body.FollowTarget != null;
                body.FollowTarget = null;
                body.WarpTo(hop.TargetName, hop.TargetTile);
                body.Session?.SendEvent("warped", new Dictionary<string, object> { ["location"] = body.LocationName });
                yield return Result.Success($"went through to {body.LocationName}, now at {Targets.Fmt(body.Npc.TilePoint)}{(wasFollowing ? " (stopped following)" : "")}");
                yield break;
            }

            // Mine ladder / shaft.
            if (kind == "ladder" || kind == "shaft")
            {
                if (!(loc is MineShaft shaft)) { yield return Result.Fail("not in the mines"); yield break; }
                var walk = new Outcome();
                yield return Movement.WalkTo(ctx, t.Tile, true, walk);
                if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
                int next = shaft.mineLevel + (kind == "shaft" ? Game1.random.Next(3, 9) : 1);
                MineShaft target = null;
                try { target = MineShaft.GetMine("UndergroundMine" + next); } catch { }
                if (target == null) { yield return Result.Fail($"could not open mine level {next}"); yield break; }
                Vector2 entry;
                try { entry = target.mineEntrancePosition(body.Shadow); } catch { entry = new Vector2(6, 6); }
                body.WarpTo(target.Name, entry.ToPoint());
                body.Session?.SendEvent("warped", new Dictionary<string, object> { ["location"] = body.LocationName, ["mineLevel"] = next });
                yield return Result.Success($"climbed down to mine level {next}");
                yield break;
            }

            // Things on the tile.
            if (loc.objects.TryGetValue(t.TileVec, out SObject obj))
            {
                if (obj is Chest chest)
                {
                    var walk = new Outcome();
                    yield return Movement.WalkTo(ctx, t.Tile, true, walk);
                    if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
                    string listing = string.Join(", ", chest.Items.Where(i => i != null).Take(12).Select(i => $"{i.DisplayName} x{i.Stack}"));
                    yield return Result.Success(listing.Length > 0 ? $"the chest holds: {listing}. Use chest(take|put)" : "the chest is empty");
                    yield break;
                }
                if (obj.IsSpawnedObject || obj.isForage())
                {
                    var o = new Outcome();
                    yield return Tools.PickUp(ctx, t.Tile, o);
                    yield return o.Ok ? Result.Success(o.Detail) : Result.Fail(o.Detail);
                    yield break;
                }
                if (obj.bigCraftable.Value)
                {
                    var walk = new Outcome();
                    yield return Movement.WalkTo(ctx, t.Tile, true, walk);
                    if (!walk.Ok) { yield return Result.Fail(walk.Detail); yield break; }
                    if (obj.readyForHarvest.Value)
                    {
                        yield return Result.Success(Farming.EmptyMachine(body, obj) ?? "took nothing");
                        yield break;
                    }
                    if (obj.MinutesUntilReady > 0)
                    {
                        yield return Result.Success($"the {obj.DisplayName} is working: {obj.MinutesUntilReady} minutes left");
                        yield break;
                    }
                    yield return Result.Success($"the {obj.DisplayName} is empty; place(item) an input into it");
                    yield break;
                }
            }
            yield return Result.Fail($"nothing to interact with at {Targets.Fmt(t.Tile)}");
        }

        public static IEnumerable<object> Sleep(ActionContext ctx)
        {
            SeiBody body = ctx.Body;
            var travel = new Outcome();
            GameLocation house = Game1.getLocationFromName("FarmHouse");
            Point bed = new Point(9, 9);
            try { if (house is FarmHouse fh) bed = fh.GetPlayerBedSpot(); } catch { }
            body.FollowTarget = null;
            yield return Movement.Travel(ctx, "FarmHouse", bed, travel);
            if (!travel.Ok)
            {
                // Cannot get home: rest where we stand.
                body.Sleeping = true;
                yield return Result.Success($"could not get home ({travel.Detail}); resting here instead. The day ends when the player goes to bed");
                yield break;
            }
            body.Sleeping = true;
            try { body.Npc.doEmote(24); } catch { }
            yield return Result.Success("in bed at the farmhouse. The day only ends when the player goes to bed too");
        }
    }
}
