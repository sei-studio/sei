-- scripts/sei/perception.lua: what the body can see, POSTed to /obs at 3 Hz.
--
-- Encoder shape adapted from FAtiMA-DST's Perceptions() (MIT, hineios):
-- one FindEntities sweep of radius 24 excluding INLIMBO/NOCLICK/CLASSIFIED/FX,
-- per entity a handful of capability flags derived from tags, plus the
-- body's own vitals, inventory and the world clock. Ours is DELTA-COMPRESSED
-- and capped: a full frame goes out on the first tick, when the runtime asks
-- for one ({full:true} in the /obs response) and every FULL_EVERY ticks;
-- otherwise only entities that appeared, moved more than MOVE_EPS or changed
-- flags are sent, and `gone` lists the guids that left the radius. The
-- payload is cut at MAX_BYTES (Klei's QueryServer memory bug starts around
-- tens of KB; the plan budgets 8 KB).

local Net = require("sei/net")
local Util = require("sei/util")
local Survivors = require("sei/survivors")

local Perception = {}

local INTERVAL = 1 / 3
local RADIUS = 24
local MAX_ENTS = 60
local MAX_BYTES = 8192
local FULL_EVERY = 12
local MOVE_EPS = 0.75
local EXCLUDE_TAGS = { "INLIMBO", "NOCLICK", "CLASSIFIED", "FX" }

-- Tag -> flag. Order matters only for readability of the wire format.
local TAG_FLAGS = {
    { "CHOP_workable", "chop" },
    { "MINE_workable", "mine" },
    { "DIG_workable", "dig" },
    { "HAMMER_workable", "hammer" },
    { "pickable", "pick" },
    { "readyforharvest", "harvest" },
    { "stewer", "stewer" },
    { "cooker", "cooker" },
    { "cookable", "cookable" },
    { "edible", "edible" },
    { "_equippable", "equip" },
    { "_container", "container" },
    { "prototyper", "prototyper" },
    { "campfire", "fire" },
    { "fire", "burning" },
    { "hostile", "hostile" },
    { "monster", "monster" },
    { "_combat", "combat" },
    { "player", "player" },
    { "sei_companion", "companion" },
    { "tent", "sleep" },
    { "bedroll", "sleep" },
    { "BURNABLE_fuel", "fuel" },
    { "structure", "structure" },
    { "heavy", "heavy" },
    { "wall", "wall" },
    { "spider", "spider" },
    { "chest", "chest" },
}

local state = {
    inst = nil,
    task = nil,
    seq = 0,
    tick = 0,
    last = {},        -- guid -> { x, z, f }
    wantFull = true,
}

local function flagsOf(inst, v)
    local f = {}
    for _, pair in ipairs(TAG_FLAGS) do
        if v:HasTag(pair[1]) then f[#f + 1] = pair[2] end
    end
    if v.components.inventoryitem ~= nil and v.components.inventoryitem.canbepickedup and not v:HasTag("heavy") then
        f[#f + 1] = "pickup"
    end
    if inst.components.eater ~= nil and v.components.edible ~= nil then
        local ok, can = pcall(function() return inst.components.eater:CanEat(v) end)
        if ok and can and Survivors.DietAllows(inst.sei and inst.sei.prefab or nil, v) then f[#f + 1] = "eat" end
    end
    if v.components.stewer ~= nil and v.components.stewer:IsDone() then f[#f + 1] = "harvest" end
    return f
end

local function flagKey(f)
    return table.concat(f, ",")
end

local function encodeEntity(inst, v, sx, sz)
    local x, _, z = v.Transform:GetWorldPosition()
    local e = {
        g = v.GUID,
        p = v.prefab,
        x = Util.Round1(x - sx),
        z = Util.Round1(z - sz),
        f = flagsOf(inst, v),
    }
    if v:HasTag("player") and v.name ~= nil then e.n = v.name end
    if v.components.stackable ~= nil then e.q = v.components.stackable:StackSize() end
    if v.components.health ~= nil and (v:HasTag("_combat") or v:HasTag("player")) then
        e.h = Util.Round1(v.components.health:GetPercent())
    end
    if v.components.burnable ~= nil and v.components.burnable:IsBurning() then e.f[#e.f + 1] = "burning" end
    return e, x, z
end

local function encodeItem(inst, item)
    local it = { g = item.GUID, p = item.prefab, f = {} }
    if item.components.stackable ~= nil then it.q = item.components.stackable:StackSize() end
    if item:HasTag("_equippable") then it.f[#it.f + 1] = "equip" end
    if item.components.edible ~= nil and inst.components.eater ~= nil then
        local ok, can = pcall(function() return inst.components.eater:CanEat(item) end)
        if ok and can and Survivors.DietAllows(inst.sei and inst.sei.prefab or nil, item) then it.f[#it.f + 1] = "eat" end
    end
    if item:HasTag("BURNABLE_fuel") then it.f[#it.f + 1] = "fuel" end
    if item.components.tool ~= nil then it.f[#it.f + 1] = "tool" end
    if item.components.weapon ~= nil then it.f[#it.f + 1] = "weapon" end
    if item.components.armor ~= nil then it.f[#it.f + 1] = "armor" end
    if item.components.perishable ~= nil then it.s = Util.Round1(item.components.perishable:GetPercent()) end
    return it
end

local function selfBlock(inst)
    local x, _, z = inst.Transform:GetWorldPosition()
    local h, hu, sa = inst.components.health, inst.components.hunger, inst.components.sanity
    local s = {
        x = Util.Round1(x), z = Util.Round1(z),
        hp = h and Util.Round1(h.currenthealth) or 0, hpmax = h and Util.Round1(h.maxhealth) or 0,
        hunger = hu and Util.Round1(hu.current) or 0, hungermax = hu and Util.Round1(hu.max) or 0,
        sanity = sa and Util.Round1(sa.current) or 0, sanitymax = sa and Util.Round1(sa.max) or 0,
        temp = Util.Round1(inst:GetTemperature()),
        moist = Util.Round1(inst:GetMoisture()),
        freezing = inst:IsFreezing() and true or false,
        overheating = inst:IsOverheating() and true or false,
        inlight = inst.LightWatcher ~= nil and inst.LightWatcher:IsInLight() or false,
        busy = inst.sg ~= nil and inst.sg:HasStateTag("busy") or false,
        dead = h ~= nil and h:IsDead() or false,
        target = inst.components.combat ~= nil and inst.components.combat.target ~= nil and inst.components.combat.target.GUID or nil,
        follow = inst.sei ~= nil and inst.sei.follow ~= nil and inst.sei.follow:IsValid() and inst.sei.follow.GUID or nil,
        cmd = inst.sei ~= nil and inst.sei.cmd ~= nil and inst.sei.cmd.id or nil,
        inv = {},
        equip = {},
    }
    local inv = inst.components.inventory
    if inv ~= nil then
        for _, item in pairs(inv.itemslots) do
            s.inv[#s.inv + 1] = encodeItem(inst, item)
        end
        for slot, item in pairs(inv.equipslots) do
            s.equip[tostring(slot)] = encodeItem(inst, item)
        end
    end
    return s
end

local function worldBlock()
    local ws = TheWorld.state
    return {
        day = (ws.cycles or 0) + 1,
        phase = ws.phase,
        season = ws.season,
        raining = ws.israining and true or false,
        snowing = ws.issnowing and true or false,
        temp = Util.Round1(ws.temperature or 0),
        dayprogress = Util.Round1(ws.time or 0),
        caves = TheWorld:HasTag("cave") and true or false,
    }
end

local function buildFrame(inst, full)
    local sx, _, sz = inst.Transform:GetWorldPosition()
    local ents = TheSim:FindEntities(sx, 0, sz, RADIUS, nil, EXCLUDE_TAGS)
    local seen = {}
    local out = {}
    local count = 0
    for _, v in ipairs(ents) do
        if v ~= inst and v.Transform ~= nil and v.prefab ~= nil and count < MAX_ENTS then
            local e, x, z = encodeEntity(inst, v, sx, sz)
            local key = flagKey(e.f)
            seen[v.GUID] = { x = x, z = z, f = key }
            local prev = state.last[v.GUID]
            local changed = full or prev == nil or prev.f ~= key
                or math.abs(prev.x - x) > MOVE_EPS or math.abs(prev.z - z) > MOVE_EPS
            if changed then
                out[#out + 1] = e
                count = count + 1
            end
        end
    end
    local gone = {}
    for guid in pairs(state.last) do
        if seen[guid] == nil then gone[#gone + 1] = guid end
    end
    state.last = seen
    state.seq = state.seq + 1
    return {
        seq = state.seq,
        full = full and true or false,
        self = selfBlock(inst),
        ents = out,
        gone = gone,
        world = worldBlock(),
    }
end

local function tick()
    local inst = state.inst
    if inst == nil or not inst:IsValid() then return end
    if not Net.IsConfigured() then return end
    Util.Guard("perception.tick", function()
        state.tick = state.tick + 1
        local full = state.wantFull or (state.tick % FULL_EVERY == 1)
        state.wantFull = false
        local frame = buildFrame(inst, full)
        local encoded = Util.JsonEncode(frame)
        if encoded ~= nil and #encoded > MAX_BYTES then
            -- Cut the entity list until it fits; the next delta catches up.
            while #frame.ents > 0 and #encoded > MAX_BYTES do
                table.remove(frame.ents)
                encoded = Util.JsonEncode(frame)
            end
            frame.truncated = true
        end
        Net.Post("/obs", frame, function(resp, ok)
            if ok and resp ~= nil and resp.full then state.wantFull = true end
        end)
    end, Net.ReportError)
end

function Perception.Start(inst)
    Perception.Stop()
    state.inst = inst
    state.seq = 0
    state.tick = 0
    state.last = {}
    state.wantFull = true
    state.task = inst:DoPeriodicTask(INTERVAL, tick, 0.25)
end

function Perception.Stop()
    if state.task ~= nil then
        state.task:Cancel()
        state.task = nil
    end
    state.inst = nil
    state.last = {}
end

function Perception.RequestFull()
    state.wantFull = true
end

return Perception
