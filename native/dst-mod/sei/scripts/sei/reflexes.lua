-- scripts/sei/reflexes.lua: the body's survival habits (mod 0.3.0).
--
-- Everything a DST player does without thinking, run at frame rate by the
-- behaviour tree (brains/seibrain.lua) so it never waits on the LLM:
--
--   light     in the dark: hold a light you carry, craft a torch when you
--             can, walk to a fire you can see, or build a campfire
--   fire      at dusk/night, feed a nearby fire that is running low
--   torch     put the torch away in daylight (it burns fuel for nothing)
--   gear      before a fight, hold the best weapon and wear armor you carry
--   defend    a monster attacking a player you are with is your fight too
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

-- ── light ───────────────────────────────────────────────────────────────────
--
-- Measured on a dedicated server with no client attached: the watcher lags
-- the world (the ambient fade after dusk takes ~8 s, a new campfire
-- registered ~8 s after it was lit) and a HELD torch never registered at
-- all (its light entity is local, not networked). Charlie strikes 5-10 s
-- after "enterdark". So these checks go by the clock and by distance to a
-- light rather than waiting for the watcher to say "dark", the torch is made
-- at dusk before it is needed, and a held light that still leaves the body
-- dark after a grace period is treated as not working.
--
-- Why a held torch can fail: its light is a separate entity, and the engine
-- only counts lights from entities that are awake. Entities sleep when no
-- real player is near (measured: a campfire built beside the body stayed
-- asleep and never lit it, while a Light on the always-awake body itself
-- registered within a frame). With the host nearby everything is awake and
-- the torch works; when the body is alone the habit mirrors the held light
-- on the body's own Light (a player prefab has one, off by default), which
-- is the same light the torch gives. If even that leaves the body dark, the
-- habit goes to a fire or builds one.

-- A light entity (a fire, a held torch, a lantern) this close counts as lit.
-- Smaller than the smallest campfire radius (2 at embers, 3 once fed).
local LIT_DIST = 2.5
-- Past this fraction of dusk the body gets its light ready.
local DUSK_PREP_AT = 0.4
-- How long a held light may leave the watcher saying "dark" before the
-- habit stops trusting it.
local HELD_LIGHT_GRACE_S = 4

--- Is a light (not the body's own) within LIT_DIST?
function Reflexes.NearLight(inst, dist)
    local x, y, z = inst.Transform:GetWorldPosition()
    for _, v in ipairs(TheSim:FindEntities(x, y, z, dist or LIT_DIST, { "lightsource" })) do
        -- Skip the body's own held light: it is parented to the body.
        -- entity:GetParent() returns the parent's inst, as in vanilla
        -- (`inst.entity:GetParent() == ThePlayer`).
        local own = v == inst or v.entity:GetParent() == inst
        if not own then return true end
    end
    return Reflexes.BurningFire(inst, dist or LIT_DIST) ~= nil
end

--- Turn the body's own Light on (torch-sized) or back off. Only ever turns
--- off a light this module turned on.
local function setBodyLight(inst, on)
    local s = inst.sei
    if inst.Light == nil or s == nil then return false end
    if on then
        inst.Light:SetIntensity(0.75)
        inst.Light:SetRadius(TUNING.TORCH_RADIUS[1])
        inst.Light:SetFalloff(TUNING.TORCH_FALLOFF[1])
        inst.Light:SetColour(180 / 255, 195 / 255, 150 / 255)
        inst.Light:Enable(true)
        s.bodyLightAt = GetTime()
    elseif s.bodyLightAt ~= nil then
        inst.Light:Enable(false)
        s.bodyLightAt = nil
    end
    return true
end

--- Called every brain tick: drop the mirrored light once it is day or the
--- body no longer holds a light (stowed, burnt out, swapped for a weapon).
function Reflexes.SyncBodyLight(inst)
    local s = inst.sei
    if s ~= nil and s.bodyLightAt ~= nil and (not dark() or not Reflexes.HoldsLight(inst)) then
        setBodyLight(inst, false)
    end
end

--- Holding a light at night, and the game still says the body is dark
--- after HELD_LIGHT_GRACE_S. The first time, mirror the held light on the
--- body (see the note above) and give that a grace period too.
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
    if inst.LightWatcher == nil or inst.LightWatcher:IsInLight() then return false end
    if s.bodyLightAt == nil then
        return not setBodyLight(inst, true)
    end
    return now - s.bodyLightAt > HELD_LIGHT_GRACE_S
end

--- Does the body need light right now? Night (not a full moon) or a cave,
--- no light close by, not holding one.
function Reflexes.NeedsLight(inst)
    if not dark() then return false end
    if Reflexes.NearLight(inst) then return false end
    if Reflexes.HoldsLight(inst) then return Reflexes.HeldLightFailing(inst) end
    return true
end

local function carriedLight(i)
    return i:FindItem(function(it) return isLightItem(it) and hasFuelLeft(it) and it.components.equippable ~= nil end)
end

--- The light habit's next step, or nil when it has nothing to do (the brain
--- then falls through to FindLight, which walks to a visible fire).
--- Order: equip a carried light, craft a torch, (walk to a fire: FindLight),
--- build a campfire.
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
    if Reflexes.BurningFire(inst, seeDist) ~= nil then return nil end
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
    if Reflexes.BurningFire(inst, seeDist) ~= nil then return nil end
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
--- the dusk habit makes. Called from the brain tick.
function Reflexes.StowDayTorch(inst)
    if dark() then return end
    local h = hands(inst)
    if h == nil or not h:HasTag("lighter") then return end
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
--- in the dark (the dark kills faster than any spider). Returns what changed.
function Reflexes.GearUp(inst, target)
    local i = inv(inst)
    if i == nil then return nil end
    local changed = {}
    local h = hands(inst)
    local keepTorch = h ~= nil and isLightItem(h) and dark() and Reflexes.BurningFire(inst, 10) == nil
    if not keepTorch then
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
        if worn == nil or worn.components.armor ~= nil then
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
--- carries, equipped. Returns the tool in hand (or nil: bare hands). Keeps a
--- lit torch in hand in the dark.
function Reflexes.EquipTool(inst, action)
    local i = inv(inst)
    if i == nil or action == nil then return nil end
    local h = hands(inst)
    if h ~= nil and h.components.tool ~= nil and h.components.tool:CanDoAction(action) then return h end
    if h ~= nil and isLightItem(h) and dark() and Reflexes.BurningFire(inst, 8) == nil then return nil end
    local tool = i:FindItem(function(it)
        return it.components.tool ~= nil and it.components.equippable ~= nil and it.components.tool:CanDoAction(action)
    end)
    if tool ~= nil and i:Equip(tool) then return tool end
    return nil
end

-- ── defend the player ───────────────────────────────────────────────────────

local function isPlayer(v)
    return v ~= nil and v:IsValid() and v:HasTag("player") and not v:HasTag("sei_companion")
end

--- A monster within DEFEND_RADIUS of the body whose current target is a
--- player (not us). Nil when there is none.
function Reflexes.ThreatToPlayer(inst)
    local x, y, z = inst.Transform:GetWorldPosition()
    local ents = TheSim:FindEntities(x, y, z, DEFEND_RADIUS, { "_combat" }, { "INLIMBO", "player", "companion", "wall", "structure" })
    local best, bestd = nil, math.huge
    for _, v in ipairs(ents) do
        local c = v.components.combat
        if c ~= nil and isPlayer(c.target) and v.components.health ~= nil and not v.components.health:IsDead() then
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
