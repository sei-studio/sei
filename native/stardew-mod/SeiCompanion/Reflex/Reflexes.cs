using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Monsters;
using SeiCompanion.Actions;
using SeiCompanion.Body;
using SObject = StardewValley.Object;

namespace SeiCompanion.Reflex
{
    /// <summary>
    /// Per-tick body loops that never wait on the brain (the Minecraft
    /// adapter's behaviors/*: combat retaliation, survival retreat, auto-eat,
    /// bedtime). Each reports through the same event vocabulary the bot's
    /// fsmWires.js maps onto onAttacked / reflex / survival.
    ///
    /// Contact damage is SIMULATED here: monsters pick their target from
    /// location.farmers, which the shadow is deliberately never part of, so
    /// nothing in the game ever hits it. A monster whose box overlaps the
    /// companion's applies its DamageToFarmer on a per-monster cooldown.
    /// </summary>
    public sealed class Reflexes
    {
        private const int ContactCooldownMs = 1200;
        private const float RetreatBelow = 0.30f;
        private const float EatBelow = 0.20f;
        private const int EatCooldownMs = 60_000;
        private const int RetaliateCooldownMs = 600;

        private readonly SeiBody _body;
        private readonly Dictionary<Monster, long> _lastContact = new Dictionary<Monster, long>();
        private long _lastRetaliate;
        private long _lastEat;
        private long _lastRetreatEvent;
        private bool _retreating;
        private long _lastDamagedEvent;

        public Reflexes(SeiBody body)
        {
            this._body = body;
        }

        public void OnNewDay()
        {
            this._lastContact.Clear();
            this._retreating = false;
        }

        public void Tick(int tick)
        {
            if (this._body.Npc?.currentLocation == null || this._body.Sleeping)
                return;
            if (tick % 3 != 0)
                return;
            this.ContactDamage();
            if (tick % 30 == 0)
                this.AutoEat();
        }

        private void ContactDamage()
        {
            GameLocation loc = this._body.Npc.currentLocation;
            long now = Environment.TickCount64;
            Rectangle mine = this._body.Npc.GetBoundingBox();
            mine.Inflate(6, 6);
            Monster hitter = null;
            foreach (NPC c in loc.characters)
            {
                if (!(c is Monster m) || m.Health <= 0 || m.IsInvisible || m.DamageToFarmer <= 0)
                    continue;
                if (!m.GetBoundingBox().Intersects(mine))
                    continue;
                if (this._lastContact.TryGetValue(m, out long last) && now - last < ContactCooldownMs)
                    continue;
                this._lastContact[m] = now;
                hitter = m;
                break;
            }
            if (hitter == null)
                return;

            int defense = 0;
            try { defense = this._body.Shadow.buffs.Defense; } catch { }
            int damage = Math.Max(1, hitter.DamageToFarmer - defense);
            damage += Game1.random.Next(Math.Min(-1, -damage / 8), Math.Max(1, damage / 8) + 1);
            this._body.Shadow.health = Math.Max(0, this._body.Shadow.health - damage);
            try { loc.playSound("ow", this._body.Npc.Tile); } catch { }
            try { this._body.Npc.doEmote(12); } catch { }

            float ratio = this._body.Shadow.maxHealth > 0 ? (float)this._body.Shadow.health / this._body.Shadow.maxHealth : 1f;
            string label = hitter.displayName ?? hitter.Name;
            bool retaliated = false;

            if (this._body.Shadow.health <= 0)
            {
                this.KnockedOut(label);
                return;
            }

            if (ratio < RetreatBelow)
            {
                this.Retreat(hitter);
            }
            else if (!this._body.Paused && !this._body.Runner.Busy && now - this._lastRetaliate > RetaliateCooldownMs)
            {
                // Stand your ground: swing back on reflex while the brain decides.
                this._lastRetaliate = now;
                try { Combat.Swing(this._body, hitter); retaliated = true; } catch { }
            }

            // One damaged event per second at most; a sustained beating must
            // not re-fire the brain faster than it can answer.
            if (now - this._lastDamagedEvent > 1000)
            {
                this._lastDamagedEvent = now;
                this._body.Session?.SendEvent("damaged", new Dictionary<string, object>
                {
                    ["attacker"] = label,
                    ["attackerKind"] = "monster",
                    ["damage"] = damage,
                    ["health"] = this._body.Shadow.health,
                    ["maxHealth"] = this._body.Shadow.maxHealth,
                    ["retaliated"] = retaliated,
                    ["retreating"] = this._retreating,
                });
            }
        }

        private void Retreat(Monster from)
        {
            long now = Environment.TickCount64;
            SeiBody body = this._body;
            body.Runner.Abort("retreating: health is low");
            Vector2 away = body.Npc.Tile - from.Tile;
            if (away == Vector2.Zero) away = new Vector2(1, 0);
            away.Normalize();
            Vector2 goal = body.Npc.Tile + away * 5f;
            Vector2? spot = body.FreeTileNear(body.Npc.currentLocation, new Vector2((float)Math.Round(goal.X), (float)Math.Round(goal.Y)), 2);
            if (spot.HasValue)
                body.TryPath(spot.Value.ToPoint(), null);
            this._retreating = true;
            if (now - this._lastRetreatEvent > 4000)
            {
                this._lastRetreatEvent = now;
                body.Session?.SendEvent("survival", new Dictionary<string, object>
                {
                    ["kind"] = "retreat",
                    ["attacker"] = from.displayName ?? from.Name,
                    ["health"] = body.Shadow.health,
                    ["maxHealth"] = body.Shadow.maxHealth,
                });
            }
        }

        private void KnockedOut(string cause)
        {
            SeiBody body = this._body;
            body.Runner.Abort("knocked out");
            body.Background.Abort("knocked out");
            string where = body.LocationName;
            // Wake up at home with half health, like the clinic without the bill.
            body.Shadow.health = Math.Max(10, body.Shadow.maxHealth / 2);
            body.Shadow.Stamina = Math.Max(body.Shadow.Stamina, 20f);
            this._retreating = false;
            Point entry;
            try { entry = Game1.getFarm().GetMainFarmHouseEntry(); } catch { entry = new Point(64, 15); }
            body.WarpTo("Farm", entry);
            body.Session?.SendEvent("death", new Dictionary<string, object>
            {
                ["cause"] = cause,
                ["where"] = where,
                ["location"] = body.LocationName,
            });
        }

        private void AutoEat()
        {
            SeiBody body = this._body;
            if (body.Paused) return;
            long now = Environment.TickCount64;
            if (now - this._lastEat < EatCooldownMs) return;
            float ratio = body.Shadow.MaxStamina > 0 ? body.Shadow.Stamina / body.Shadow.MaxStamina : 1f;
            if (ratio >= EatBelow) return;
            SObject food = body.Shadow.Items.OfType<SObject>().Where(Items.IsEdible).OrderByDescending(o => o.Edibility).FirstOrDefault();
            if (food == null) return;
            this._lastEat = now;
            string detail = Items.EatNow(body, food);
            body.Session?.SendEvent("survival", new Dictionary<string, object>
            {
                ["kind"] = "ate",
                ["detail"] = detail,
                ["stamina"] = (int)body.Shadow.Stamina,
                ["maxStamina"] = body.Shadow.MaxStamina,
            });
        }

        /// <summary>1:50 AM: walk home and sleep before the game passes the companion out.</summary>
        public void Bedtime()
        {
            SeiBody body = this._body;
            if (body.Paused || body.Sleeping) return;
            body.Runner.Abort("bedtime");
            // Following is kept: Sleeping pauses the follow tick until morning.
            var ctx = new ActionContext(body, null, default);
            body.Background.Start(ctx, "bedtime", Interact.Sleep(ctx));
            body.Session?.SendEvent("survival", new Dictionary<string, object>
            {
                ["kind"] = "bedtime",
                ["time"] = Game1.timeOfDay,
            });
        }
    }
}
