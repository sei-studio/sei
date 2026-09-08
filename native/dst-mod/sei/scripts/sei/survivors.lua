-- scripts/sei/survivors.lua: per-survivor mechanics the body has to manage,
-- as DATA. The safety layer (brains/seibrain.lua) and the perception flags
-- (sei/perception.lua) read this table instead of branching on the prefab.
--
-- MIRROR: src/shared/dstSurvivors.ts (main + renderer) and
-- src/bot/adapter/dontstarve/survivors.js (the primer). The vitest suite
-- pins the three prefab lists together; keep the keys in step.
--
-- Fields:
--   diet          "any" | "meat" | "veg"   what the eat reflex may pick
--   eatsSpoiled   spoiled food carries no penalty
--   fireImmune    fire does no damage (no fire panic)
--   wetnessDamage being wet hurts (shelter outranks work in rain)
--   frail         tiny health pool: flee earlier
--   needsCrockpot only crock pot dishes feed properly
--   souls         souls are food
--   plantFriend   cutting plants nearby costs sanity
--   noSleep       cannot use tents or bedrolls

local Survivors = {}

local function row(o)
    return {
        diet = o.diet or "any",
        eatsSpoiled = o.eatsSpoiled or false,
        fireImmune = o.fireImmune or false,
        wetnessDamage = o.wetnessDamage or false,
        frail = o.frail or false,
        needsCrockpot = o.needsCrockpot or false,
        souls = o.souls or false,
        plantFriend = o.plantFriend or false,
        noSleep = o.noSleep or false,
    }
end

Survivors.TABLE = {
    wilson = row({}),
    willow = row({ fireImmune = true }),
    wolfgang = row({}),
    wendy = row({}),
    wx78 = row({ eatsSpoiled = true, wetnessDamage = true }),
    wickerbottom = row({ noSleep = true }),
    waxwell = row({ frail = true }),
    wigfrid = row({ diet = "meat" }),
    webber = row({}),
    winona = row({}),
    wortox = row({ souls = true }),
    wormwood = row({ plantFriend = true }),
    warly = row({ needsCrockpot = true }),
    wurt = row({ diet = "veg" }),
    walter = row({}),
}

Survivors.DEFAULT = "wilson"

function Survivors.Get(prefab)
    return Survivors.TABLE[prefab] or Survivors.TABLE[Survivors.DEFAULT]
end

function Survivors.IsEligible(prefab)
    return type(prefab) == "string" and Survivors.TABLE[prefab] ~= nil
end

--- Health fraction below which the safety layer runs from hostiles.
function Survivors.FleeHealthPct(prefab)
    local s = Survivors.Get(prefab)
    if s.frail then return 0.55 end
    return 0.35
end

--- Whether a food item is acceptable for this survivor's diet. The eater
--- component already refuses what the prefab cannot eat; this only narrows
--- the reflex's own picks (a Wurt body is never handed meat by us).
function Survivors.DietAllows(prefab, item)
    local s = Survivors.Get(prefab)
    if item == nil then return false end
    if s.diet == "meat" then
        return item:HasTag("meat") or item:HasTag("preparedfood") and not item:HasTag("veggie")
    elseif s.diet == "veg" then
        return not item:HasTag("meat")
    end
    return true
end

return Survivors
