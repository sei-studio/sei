-- scripts/sei/reflexes.lua: the body's survival habits (mod 0.3.0).
--
-- Everything a DST player does without thinking, run at frame rate by the
-- behaviour tree (brains/seibrain.lua) so it never waits on the LLM:
--
--   light     in the dark: hold a light you carry, craft a torch when you
--             can, walk to a light you can see, or build a campfire; keep
--             held lights and nearby fires awake (see the light section)
--   fire      at dusk/night, feed a nearby fire that is running low
--   torch     put the torch away in daylight (it burns fuel for nothing)
--   gear      before a fight, hold the best weapon and wear armor you carry
--   defend    a monster going for a player you are with is your fight too
--             (hostile, or it actually hit them; never shadow creatures)
--   eat       pick food that does not hurt you, soonest-to-spoil first
--   heal      patch yourself up when hurt and nothing is attacking
--   warm      when freezing, walk to a fire you can see
--
-- Each habit reports what it did through sei/events.lua (kind "survival"),
-- so the external brain can mention it. Only "defend" is meant to wake the
-- brain; the rest are notes it reads in the next snapshot.

local Events = require("sei/events")
local Survivors = require("sei/survivors")
local Util = require("sei/util")

local Reflexes = {}

local EXCLUDE = { "INLIMBO", "NOCLICK", "CLASSIFIED", "FX" }
-- Items that light the holder. The torch carries the "lighter" tag; the
-- others are matched by prefab.
local LIGHT_ITEMS = { torch = true, lantern = true, minerhat = true }
-- Fuel the fire habit prefers, most burn time per item first. Grass and
-- twigs are torch material, so they are fed only from a surplus.
local GOOD_FUEL = { "log", "charcoal", "boards", "pinecone", "twiggy_nut", "acorn", "rottenegg", "spoiled_food", "manure", "poop" }
local TORCH_SPARE = 2
local FIRE_LOW_PCT = 0.35
local DEFEND_RADIUS = 12
-- A non-hostile creature counts as a threat once it hit a player this recently.
local DEFEND_RECENT_S = 6
local HEAL_PCT = 0.4
local HEAL_SAFE_DIST = 10

-- ── small helpers ───────────────────────────────────────────────────────────

local function inv(inst) return inst.components.inventory end

local function hands(inst)
    local i = inv(inst)
    return i ~= nil and i:GetEquippedItem(EQUIPSLOTS.HANDS) or nil
end

local function countOf(inst, prefab)
    local i = inv(inst)
    if i == nil then return 0 end
    local _, n = i:Has(prefab, 1)
    return n or 0
end

local function isLightItem(item)
    if item == nil then return false end
    if item:HasTag("lighter") and item.components.fueled ~= nil then return true end
    return LIGHT_ITEMS[item.prefab] == true
end

local function hasFuelLeft(item)
    return item.components.fueled == nil or not item.components.fueled:IsEmpty()
end

--- Is the body holding (or wearing) something that lights it?
function Reflexes.HoldsLight(inst)
    local i = inv(inst)
    if i == nil then return false end
    for _, slot in pairs({ EQUIPSLOTS.HANDS, EQUIPSLOTS.HEAD }) do
        local it = i:GetEquippedItem(slot)
        if it ~= nil and isLightItem(it) and hasFuelLeft(it) then return true end
    end
    return false
end

local function nearest(inst, radius, pred, musttags)
    local x, y, z = inst.Transform:GetWorldPosition()
    local ents = TheSim:FindEntities(x, y, z, radius, musttags, EXCLUDE)
    local best, bestd = nil, math.huge
    for _, v in ipairs(ents) do
        if v ~= inst and pred(v) then
            local d = Util.DistXZ(inst, v)
            if d < bestd then best, bestd = v, d end
        end
    end
    return best, bestd
end

local function isBurningFire(v)
    return v:HasTag("campfire") and v.components.burnable ~= nil and v.components.burnable:IsBurning()
end

--- The nearest burning campfire/firepit within radius, and its distance.
function Reflexes.BurningFire(inst, radius)
    return nearest(inst, radius, isBurningFire, { "campfire" })
end

-- Night (not a full moon) or a cave: Charlie's hours.
local function dark()
    if TheWorld:HasTag("cave") then return true end
    return TheWorld.state.phase == "night" and not TheWorld.state.isfullmoon
end
Reflexes.IsDark = dark

-- ── recipes and placement ───────────────────────────────────────────────────

local function canMake(inst, name)
    local b = inst.components.builder
    local recipe = GetValidRecipe ~= nil and GetValidRecipe(name) or nil
    if b == nil or recipe == nil then return nil end
    if not b:KnowsRecipe(recipe) or not b:HasIngredients(recipe) then return nil end
    return recipe
end

--- A deployable spot for `recipe` near the body (or `around`): tries rings of
--- increasing radius so a campfire is not dropped into a tree or the ocean.
function Reflexes.PlacementPoint(inst, recipe, around, minR, maxR)
    local cx, _, cz = (around or inst).Transform:GetWorldPosition()
    local map = TheWorld.Map
    local r = minR or 2
    local rmax = maxR or 6
    while r <= rmax do
        local steps = 8
        local off = math.random() * 2 * math.pi
        for k = 0, steps - 1 do
            local ang = off + k * 2 * math.pi / steps
            local pt = Vector3(cx + r * math.cos(ang), 0, cz + r * math.sin(ang))
            local ok
            if map.CanDeployRecipeAtPoint ~= nil then
                local good, res = pcall(function() return map:CanDeployRecipeAtPoint(pt, recipe, 0, inst) end)
                ok = good and res and true or false
            else
                ok = map:IsPassableAtPoint(pt.x, 0, pt.z)
            end
            if ok then return pt end
        end
        r = r + 1
    end
    return nil
end

local function buildAction(inst, recipe, pt, onok)
    local b = BufferedAction(inst, nil, ACTIONS.BUILD, nil, pt or inst:GetPosition(), recipe.name, recipe.build_distance)
    if onok ~= nil then b:AddSuccessAction(onok) end
    return b
end

-- ── what the LLM equipped ───────────────────────────────────────────────────
--
-- An explicit equip command holds that item: the habits (stow the torch,
-- gear up, tools) leave it where it is until the LLM equips something else,
-- the item leaves the slot, or the body is in the dark with no light (the
-- one emergency allowed to override it, Reflexes.LightAction).

--- Record an item the equip command put on the body.
function Reflexes.Hold(inst, item)
    local s = inst.sei
    local eq = item ~= nil and item.components.equippable or nil
    if s == nil or eq == nil then return end
    s.hold = s.hold or {}
    s.hold[eq.equipslot] = item
end

--- The item the LLM put in `slot`, while it is still there; nil otherwise.
function Reflexes.CommandHeld(inst, slot)
    local s = inst.sei
    if s == nil or s.hold == nil then return nil end
    local it = s.hold[slot]
    if it == nil then return nil end
    local i = inv(inst)
    if i ~= nil and it:IsValid() and i:GetEquippedItem(slot) == it then return it end
    s.hold[slot] = nil
    return nil
end

-- ── light ───────────────────────────────────────────────────────────────────
--
-- One test decides "am I lit" for every habit (light, tools, gear):
-- Reflexes.LitByOthers, the engine's own light level at the body's feet
-- (TheSim:GetLightAtPoint, the value the Grue checks) with the body's held
-- lights switched off for the reading, plus hysteresis so a body standing
-- at the edge of a fire does not flip between "lit" and "dark" (and the
-- torch and the axe between hands) every tick.
--
-- Entities sleep when no real player is near, and a sleeping light lights
-- nothing (measured headless 260926: a campfire beside the body, and a torch
-- in its hand, both read 0 while asleep). Setting SetCanSleep(false) on an
-- entity that is already asleep does not wake it; setting it in the frame
-- the entity is spawned does. So:
--   - held lights: the "equip" listener (Reflexes.Attach) keeps the light
--     entities of what the body just equipped awake, in the same frame;
--   - fires: Reflexes.KeepFiresAwake respawns the fire FX of a burning fire
--     near the body whose light is asleep, awake, and lets it sleep again
--     once the body leaves or day comes.
-- Near the host everything is awake already and none of this does anything.

-- Light level thresholds, on the scale of LightWatcher (player_common.lua:
-- in light above .075, dark below .05). A light counts once it gives
-- LIT_ENTER at the body's feet and keeps counting until it drops under
-- LIT_STAY.
local LIT_ENTER = 0.2
local LIT_STAY = 0.1
-- Past this fraction of dusk the body gets its light ready.
local DUSK_PREP_AT = 0.4
-- How long a held light may leave the watcher saying "dark" before the
-- habit stops trusting it and goes to a fire.
local HELD_LIGHT_GRACE_S = 4
-- Fires within this range are kept awake at dusk/night; they sleep again
-- past FIRE_RELEASE_DIST.
local FIRE_WAKE_DIST = 24
local FIRE_RELEASE_DIST = 32

-- The light entities an equipped item carries: a torch's flame FX and their
-- light children (torchfire_common.lua), a lantern's or miner hat's _light.
local function itemLights(item)
    local out = {}
    if item == nil then return out end
    if item.fires ~= nil then
        for _, fx in ipairs(item.fires) do
            out[#out + 1] = fx
            if fx._light ~= nil then out[#out + 1] = fx._light end
        end
    end
    if item._light ~= nil then out[#out + 1] = item._light end
    return out
end

local function equippedItems(inst)
    local i = inv(inst)
    local out = {}
    if i == nil then return out end
    for _, it in pairs(i.equipslots) do out[#out + 1] = it end
    return out
end

--- Keep the light entities of an item the body just equipped awake. Must
--- run in the frame they were spawned (the "equip" event).
function Reflexes.WakeItemLights(item)
    for _, e in ipairs(itemLights(item)) do
        if e:IsValid() then e.entity:SetCanSleep(false) end
    end
end

--- Hook the body's equip event. Called once at spawn (companion.lua).
function Reflexes.Attach(inst)
    inst:ListenForEvent("equip", function(_, data)
        if data ~= nil and data.item ~= nil then Reflexes.WakeItemLights(data.item) end
    end)
end

local function fireLights(fire)
    local out = {}
    local b = fire.components.burnable
    if b == nil or b.fxchildren == nil then return out end
    for _, fx in ipairs(b.fxchildren) do
        out[#out + 1] = fx
        if fx.components.firefx ~= nil and fx.components.firefx.light ~= nil then
            out[#out + 1] = fx.components.firefx.light
        end
    end
    return out
end

local function fireLightAsleep(fire)
    for _, e in ipairs(fireLights(fire)) do
        if e:IsValid() and e.Light ~= nil and not e.entity:IsAwake() then return true end
    end
    return false
end

local function releaseFire(fire)
    if fire:IsValid() then
        for _, e in ipairs(fireLights(fire)) do
            if e:IsValid() then e.entity:SetCanSleep(true) end
        end
    end
end

--- Every brain tick: wake the burning fires near the body whose light is
--- asleep (dusk, night, caves, or the body freezing: the heat comes from
--- the same flame), let go of the ones it left behind.
function Reflexes.KeepFiresAwake(inst)
    local s = inst.sei
    if s == nil then return end
    s.wokeFires = s.wokeFires or {}
    local wanted = TheWorld:HasTag("cave") or TheWorld.state.phase ~= "day" or inst:IsFreezing()
    for fire in pairs(s.wokeFires) do
        if not fire:IsValid() or not isBurningFire(fire) or not wanted or Util.DistXZ(inst, fire) > FIRE_RELEASE_DIST then
            releaseFire(fire)
            s.wokeFires[fire] = nil
        end
    end
    if not wanted then return end
    local x, y, z = inst.Transform:GetWorldPosition()
    for _, v in ipairs(TheSim:FindEntities(x, y, z, FIRE_WAKE_DIST, { "campfire" }, EXCLUDE)) do
        if isBurningFire(v) and fireLightAsleep(v) then
            -- Respawn the flame (same level) and keep the new one awake in
            -- the frame it exists. The old one is asleep and would only be
            -- removed after its extinguish animation, which never plays.
            local old = {}
            for _, fx in ipairs(v.components.burnable.fxchildren or {}) do old[#old + 1] = fx end
            v.components.burnable:SpawnFX(true)
            for _, fx in ipairs(old) do
                if fx:IsValid() then fx:Remove() end
            end
            for _, e in ipairs(fireLights(v)) do e.entity:SetCanSleep(false) end
            s.wokeFires[v] = true
        end
    end
end

--- Let every fire this body kept awake sleep again (despawn, brain stop).
function Reflexes.ReleaseFires(inst)
    local s = inst ~= nil and inst.sei or nil
    if s == nil or s.wokeFires == nil then return end
    for fire in pairs(s.wokeFires) do releaseFire(fire) end
    s.wokeFires = {}
end

--- The engine light level at the body's feet from everything but its own
--- held lights.
function Reflexes.LightFromOthers(inst)
    local off = {}
    for _, it in ipairs(equippedItems(inst)) do
        for _, e in ipairs(itemLights(it)) do
            if e:IsValid() and e.Light ~= nil and e.Light:IsEnabled() then
                e.Light:Enable(false)
                off[#off + 1] = e
            end
        end
    end
    local x, y, z = inst.Transform:GetWorldPosition()
    local ok, v = pcall(function() return TheSim:GetLightAtPoint(x, y, z) end)
    for _, e in ipairs(off) do e.Light:Enable(true) end
    return ok and type(v) == "number" and v or 0
end

--- Is the body lit by something other than what it holds? The one "am I
--- lit" test for every habit, with hysteresis (LIT_ENTER / LIT_STAY).
--- Cached per frame.
function Reflexes.LitByOthers(inst)
    local s = inst.sei
    if s == nil then return Reflexes.LightFromOthers(inst) >= LIT_ENTER end
    local now = GetTime()
    if s.litAt == now then return s.lit == true end
    local v = Reflexes.LightFromOthers(inst)
    s.lit = v >= (s.lit and LIT_STAY or LIT_ENTER)
    s.litAt = now
    return s.lit
end

--- Holding a light at night, and the game still says the body is dark
--- after HELD_LIGHT_GRACE_S: the light is not doing its job (asleep, or
--- something vanilla does not expect); the light habit then goes to a fire.
function Reflexes.HeldLightFailing(inst)
    local s = inst.sei
    if s == nil then return false end
    if not dark() or not Reflexes.HoldsLight(inst) then
        s.heldLightAt = nil
        return false
    end
    local now = GetTime()
    s.heldLightAt = s.heldLightAt or now
    if now - s.heldLightAt <= HELD_LIGHT_GRACE_S then return false end
    return inst.LightWatcher ~= nil and not inst.LightWatcher:IsInLight()
end

--- Does the body need light right now? Night (not a full moon) or a cave,
--- not lit by anything else, and not holding a light that works.
function Reflexes.NeedsLight(inst)
    if not dark() then return false end
    if Reflexes.LitByOthers(inst) then return false end
    if Reflexes.HoldsLight(inst) then return Reflexes.HeldLightFailing(inst) end
    return true
end

--- The nearest awake, burning light that is not the body's own, within
--- radius: where the seek-light node walks.
function Reflexes.NearestLight(inst, radius)
    local x, y, z = inst.Transform:GetWorldPosition()
    local best, bestd = nil, math.huge
    for _, v in ipairs(TheSim:FindEntities(x, y, z, radius, { "lightsource" })) do
        local own = v == inst or v.entity:GetParent() == inst
        if not own and v.Light ~= nil and v.Light:IsEnabled() and v.entity:IsAwake() then
            local d = Util.DistXZ(inst, v)
            if d < bestd then best, bestd = v, d end
        end
    end
    return best, bestd
end

local function carriedLight(i)
    return i:FindItem(function(it) return isLightItem(it) and hasFuelLeft(it) and it.components.equippable ~= nil end)
end

--- The light habit's next step, or nil when it has nothing to do (the brain
--- then falls through to the seek-light node, which walks to a light it can
--- see). Order: equip a carried light, craft a torch, (walk to a light),
--- build a campfire. Only runs when NeedsLight: dark with no light is the
--- one case allowed to replace what the LLM put in the body's hands.
function Reflexes.LightAction(inst, seeDist)
    local i = inv(inst)
    if i == nil then return nil end
    -- A held light that is not doing its job: skip straight to a fire.
    local holding = Reflexes.HoldsLight(inst)
    local carried = not holding and carriedLight(i) or nil
    if carried ~= nil then
        if i:Equip(carried) then
            Events.Post("survival", { what = "light", did = "equipped", item = carried.prefab })
        end
        return nil
    end
    local torch = not holding and canMake(inst, "torch") or nil
    if torch ~= nil then
        return buildAction(inst, torch, nil, function()
            -- Equip at once: the next brain tick would, but a tick is time.
            local made = carriedLight(i)
            if made ~= nil then i:Equip(made) end
            Events.Post("survival", { what = "light", did = "crafted", item = "torch" })
        end)
    end
    if Reflexes.NearestLight(inst, seeDist) ~= nil then return nil end
    local fire = canMake(inst, "campfire") or canMake(inst, "firepit")
    if fire ~= nil then
        local pt = Reflexes.PlacementPoint(inst, fire, nil, 1.5, 4)
        if pt ~= nil then
            return buildAction(inst, fire, pt, function()
                Events.Post("survival", { what = "light", did = "built", item = fire.name })
            end)
        end
    end
    return nil
end

--- Late in dusk, get the night's light ready while there is still time: a
--- torch in the bag if none is carried, else (no torch possible, no fire in
--- sight) a campfire. Nothing when a light is already carried or a fire
--- burns within seeDist. Returns an action or nil.
function Reflexes.DuskPrep(inst, seeDist)
    if TheWorld:HasTag("cave") or TheWorld.state.phase ~= "dusk" or TheWorld.state.isfullmoon then return nil end
    if (TheWorld.state.timeinphase or 0) < DUSK_PREP_AT then return nil end
    local i = inv(inst)
    if i == nil or Reflexes.HoldsLight(inst) or carriedLight(i) ~= nil then return nil end
    local torch = canMake(inst, "torch")
    if torch ~= nil then
        return buildAction(inst, torch, nil, function()
            Events.Post("survival", { what = "light", did = "prepared", item = "torch" })
        end)
    end
    if Reflexes.NearestLight(inst, seeDist) ~= nil then return nil end
    local fire = canMake(inst, "campfire") or canMake(inst, "firepit")
    if fire ~= nil then
        local pt = Reflexes.PlacementPoint(inst, fire, nil, 1.5, 4)
        if pt ~= nil then
            return buildAction(inst, fire, pt, function()
                Events.Post("survival", { what = "light", did = "built", item = fire.name })
            end)
        end
    end
    return nil
end

--- Put a torch away while it is not needed (day, dusk, a full-moon night).
--- Crafting auto-equips into an empty hand, so this also stows the torch
--- the dusk habit makes. A torch the LLM equipped stays. Called from the
--- brain tick.
function Reflexes.StowDayTorch(inst)
    if dark() then return end
    local h = hands(inst)
    if h == nil or not h:HasTag("lighter") then return end
    if Reflexes.CommandHeld(inst, EQUIPSLOTS.HANDS) ~= nil then return end
    local i = inv(inst)
    local item = i:Unequip(EQUIPSLOTS.HANDS)
    if item ~= nil then
        i:GiveItem(item)
        Events.Post("survival", { what = "light", did = "stowed", item = item.prefab })
    end
end

-- ── fire tending ────────────────────────────────────────────────────────────

local function pickFuel(inst, fire)
    local i = inv(inst)
    local fueled = fire.components.fueled
    for _, prefab in ipairs(GOOD_FUEL) do
        local it = i:FindItem(function(x) return x.prefab == prefab and fueled:CanAcceptFuelItem(x) end)
        if it ~= nil then return it end
    end
    for _, prefab in ipairs({ "cutgrass", "twigs" }) do
        if countOf(inst, prefab) > TORCH_SPARE then
            local it = i:FindItem(function(x) return x.prefab == prefab and fueled:CanAcceptFuelItem(x) end)
            if it ~= nil then return it end
        end
    end
    return nil
end

--- Feed a nearby fire that is running low, at dusk or night.
function Reflexes.FuelAction(inst, radius)
    local phase = TheWorld.state.phase
    if phase ~= "night" and phase ~= "dusk" then return nil end
    local fire = nearest(inst, radius, function(v)
        return isBurningFire(v) and v.components.fueled ~= nil and v.components.fueled:GetPercent() < FIRE_LOW_PCT
    end, { "campfire" })
    if fire == nil then return nil end
    local fuel = pickFuel(inst, fire)
    if fuel == nil then return nil end
    local b = BufferedAction(inst, fire, ACTIONS.ADDFUEL, fuel)
    local name = fuel.prefab
    b:AddSuccessAction(function()
        Events.Post("survival", { what = "fuel", item = name, fire = fire.prefab,
            pct = Util.Round1(fire.components.fueled ~= nil and fire.components.fueled:GetPercent() or 0) })
    end)
    return b
end

-- ── gear ────────────────────────────────────────────────────────────────────

local function damageOf(item, inst, target)
    if item == nil or item.components.weapon == nil then return 0 end
    local ok, d = pcall(function() return item.components.weapon:GetDamage(inst, target) end)
    if ok and type(d) == "number" then return d end
    return 0
end

local function armorValue(item)
    if item == nil or item.components.armor == nil then return 0 end
    return item.components.armor.absorb_percent or 0
end

--- Hold the best weapon and wear armor before a fight. Keeps a torch in hand
--- in the dark (the dark kills faster than any spider), and anything the LLM
--- equipped. Returns what changed.
function Reflexes.GearUp(inst, target)
    local i = inv(inst)
    if i == nil then return nil end
    local changed = {}
    local h = hands(inst)
    local keepTorch = h ~= nil and isLightItem(h) and dark() and not Reflexes.LitByOthers(inst)
    if not keepTorch and Reflexes.CommandHeld(inst, EQUIPSLOTS.HANDS) == nil then
        local best, bestd = nil, damageOf(h, inst, target)
        for _, it in pairs(i.itemslots) do
            if it.components.weapon ~= nil and it.components.equippable ~= nil and not it:HasTag("projectile")
                and not isLightItem(it) and it.components.equippable.equipslot == EQUIPSLOTS.HANDS then
                local d = damageOf(it, inst, target)
                if d > bestd + 1 then best, bestd = it, d end
            end
        end
        if best ~= nil and i:Equip(best) then changed[#changed + 1] = best.prefab end
    end
    for _, slot in ipairs({ EQUIPSLOTS.BODY, EQUIPSLOTS.HEAD }) do
        local worn = i:GetEquippedItem(slot)
        -- Never swap out a backpack (its contents) or a hat that is not armor
        -- (warmth, light); only fill an empty slot or upgrade armor.
        if (worn == nil or worn.components.armor ~= nil) and Reflexes.CommandHeld(inst, slot) == nil then
            local best, bestv = nil, armorValue(worn)
            for _, it in pairs(i.itemslots) do
                if it.components.armor ~= nil and it.components.equippable ~= nil and it.components.equippable.equipslot == slot then
                    local v = armorValue(it)
                    if v > bestv then best, bestv = it, v end
                end
            end
            if best ~= nil and i:Equip(best) then changed[#changed + 1] = best.prefab end
        end
    end
    if #changed > 0 then
        Events.Post("survival", { what = "equip", items = changed, target = target and target.prefab or nil })
        return changed
    end
    return nil
end

--- The best tool for a work action (CHOP, MINE, DIG, HAMMER) the body
--- carries, equipped. Returns the tool in hand, or nil and why: "dark" (the
--- torch stays in hand: dark, and nothing else lights this spot; the same
--- LitByOthers test that decides NeedsLight, so the torch and the tool
--- never trade places) or "none" (no tool for it).
function Reflexes.EquipTool(inst, action)
    local i = inv(inst)
    if i == nil or action == nil then return nil, "none" end
    local h = hands(inst)
    if h ~= nil and h.components.tool ~= nil and h.components.tool:CanDoAction(action) then return h end
    local tool = i:FindItem(function(it)
        return it.components.tool ~= nil and it.components.equippable ~= nil and it.components.tool:CanDoAction(action)
    end)
    if tool == nil then return nil, "none" end
    if dark() and not Reflexes.LitByOthers(inst) and (Reflexes.HoldsLight(inst) or carriedLight(i) ~= nil) then
        return nil, "dark"
    end
    if i:Equip(tool) then return tool end
    return nil, "none"
end

-- ── defend the player ───────────────────────────────────────────────────────

local function isPlayer(v)
    return v ~= nil and v:IsValid() and v:HasTag("player") and not v:HasTag("sei_companion")
end

-- Never defend against these: shadow creatures only exist for an insane
-- player (the body cannot see or hit them), and the rest are not real fights.
local DEFEND_EXCLUDE = { "INLIMBO", "player", "companion", "wall", "structure", "shadowcreature", "shadow",
    "notarget", "noattack", "invisible", "playerghost", "FX", "NOCLICK" }

--- Did `v` hit this player within DEFEND_RECENT_S?
local function hitPlayerRecently(v, player)
    local pc = player.components.combat
    return pc ~= nil and pc.lastattacker == v and GetTime() - (pc.lastwasattackedtime or 0) < DEFEND_RECENT_S
end

--- A creature within DEFEND_RADIUS of the body that is going for a player
--- (not us) and is a real threat: a hostile monster, or one that actually hit
--- that player in the last few seconds. A pig or bunnyman that merely
--- targets the player (a village the player angered, a guard) does not pull
--- the body into the fight until it lands a hit. Nil when there is none.
function Reflexes.ThreatToPlayer(inst)
    local x, y, z = inst.Transform:GetWorldPosition()
    local ents = TheSim:FindEntities(x, y, z, DEFEND_RADIUS, { "_combat" }, DEFEND_EXCLUDE)
    local mycombat = inst.components.combat
    local best, bestd = nil, math.huge
    for _, v in ipairs(ents) do
        local c = v.components.combat
        if c ~= nil and isPlayer(c.target) and v.components.health ~= nil and not v.components.health:IsDead()
            and (v:HasTag("hostile") or hitPlayerRecently(v, c.target))
            and (mycombat == nil or mycombat:CanTarget(v)) then
            local d = Util.DistXZ(inst, v)
            if d < bestd then best, bestd = v, d end
        end
    end
    return best
end

-- ── eating ──────────────────────────────────────────────────────────────────

local function stat(item, fn, eater)
    local ok, v = pcall(function() return item.components.edible[fn](item.components.edible, eater) end)
    if ok and type(v) == "number" then return v end
    return 0
end

--- The food the body should eat now, or nil. Skips food that costs health or
--- a lot of sanity (monster meat, durian) unless starving, and eats what will
--- spoil soonest first.
function Reflexes.ChooseFood(inst, starving)
    local i, eater = inv(inst), inst.components.eater
    if i == nil or eater == nil then return nil end
    local prefab = inst.sei and inst.sei.prefab or nil
    local s = Survivors.Get(prefab)
    local best, bestScore = nil, -math.huge
    for _, it in pairs(i.itemslots) do
        if it.components.edible ~= nil and eater:CanEat(it) and Survivors.DietAllows(prefab, it) then
            local hunger = stat(it, "GetHunger", inst)
            local health = stat(it, "GetHealth", inst)
            local sanity = stat(it, "GetSanity", inst)
            local fresh = it.components.perishable ~= nil and it.components.perishable:GetPercent() or 1
            local okFresh = s.eatsSpoiled or fresh > 0.2
            local harmless = health >= 0 and sanity >= -10
            if (okFresh and harmless) or starving then
                local score = hunger + health * 0.5 + sanity * 0.5 - fresh * 10
                if s.souls and it:HasTag("soul") then score = score + 1000 end
                if s.needsCrockpot and it:HasTag("preparedfood") then score = score + 500 end
                if not harmless then score = score - 200 end
                if hunger <= 0 and not (s.souls and it:HasTag("soul")) then score = score - 100 end
                if score > bestScore then best, bestScore = it, score end
            end
        end
    end
    return best
end

-- ── healing ─────────────────────────────────────────────────────────────────

--- Should the body patch itself up now? Hurt, and nothing hostile close.
function Reflexes.WantsHeal(inst, hostileNear)
    local h = inst.components.health
    if h == nil or h:IsDead() then return false end
    local pct = h:GetPercent()
    local floor = math.max(HEAL_PCT, Survivors.FleeHealthPct(inst.sei and inst.sei.prefab or nil) + 0.05)
    if pct >= floor then return false end
    return hostileNear(inst, HEAL_SAFE_DIST) == nil
end

--- The heal step: a healing item (salve, spider gland, bandage) on yourself,
--- else a food that restores real health.
function Reflexes.HealAction(inst)
    local i = inv(inst)
    if i == nil then return nil end
    local healer = i:FindItem(function(it) return it.components.healer ~= nil end)
    if healer ~= nil then
        local name = healer.prefab
        local b = BufferedAction(inst, inst, ACTIONS.HEAL, healer)
        b:AddSuccessAction(function()
            Events.Post("survival", { what = "heal", item = name,
                healthpct = Util.Round1(inst.components.health:GetPercent()) })
        end)
        return b
    end
    local eater = inst.components.eater
    local prefab = inst.sei and inst.sei.prefab or nil
    if eater == nil then return nil end
    local best, bestv = nil, 7
    for _, it in pairs(i.itemslots) do
        if it.components.edible ~= nil and eater:CanEat(it) and Survivors.DietAllows(prefab, it) then
            local v = stat(it, "GetHealth", inst)
            if v > bestv and stat(it, "GetSanity", inst) >= -10 then best, bestv = it, v end
        end
    end
    if best == nil then return nil end
    local name = best.prefab
    local b = BufferedAction(inst, best, ACTIONS.EAT)
    b:AddSuccessAction(function()
        Events.Post("survival", { what = "heal", item = name,
            healthpct = Util.Round1(inst.components.health:GetPercent()) })
    end)
    return b
end

return Reflexes
