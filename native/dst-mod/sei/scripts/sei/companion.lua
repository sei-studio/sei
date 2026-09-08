-- scripts/sei/companion.lua: spawn and despawn the companion body.
--
-- The body is a vanilla survivor prefab spawned ownerless on the master sim
-- (the FAtiMA-DST / DST-AICompanion approach, both MIT): every server-side
-- component a player has (locomotor, combat, inventory, builder, eater,
-- health, hunger, sanity, talker, ...) comes with it and no client needs the
-- mod. Klei's OnSetOwner is what normally sets inst.name / inst.userid; we
-- set the name ourselves and leave userid empty.
--
-- Despawn drops the inventory (the body is never saved, so anything it
-- carries would vanish with it) and removes the entity inside pcall: the
-- ownerless OnRemoveEntity path is one of the M3 spikes. If Remove throws,
-- the fallback parks the body far away with its brain stopped.

local Net = require("sei/net")
local Util = require("sei/util")
local Events = require("sei/events")
local Perception = require("sei/perception")
local Commands = require("sei/commands")
local Survivors = require("sei/survivors")

local Companion = {}

Companion.inst = nil

local PARK_DISTANCE = 4000

local function spawnPoint(near)
    if near ~= nil and near:IsValid() then
        local x, y, z = near.Transform:GetWorldPosition()
        local ang = math.random() * 2 * math.pi
        local px, pz = x + 2.5 * math.cos(ang), z + 2.5 * math.sin(ang)
        if TheWorld.Map:IsPassableAtPoint(px, 0, pz) then return px, y, pz end
        return x, y, z
    end
    local portal = TheSim:FindFirstEntityWithTag("multiplayer_portal")
    if portal ~= nil then return portal.Transform:GetWorldPosition() end
    return 0, 0, 0
end

--- Spawn the body per the watcher's offer. Returns the entity or nil, reason.
function Companion.Summon(offer)
    if Companion.inst ~= nil and Companion.inst:IsValid() then
        Companion.Despawn("re-summon")
    end
    local prefab = Survivors.IsEligible(offer.prefab) and offer.prefab or Survivors.DEFAULT
    local near = Util.FindPlayer(offer.nearUserid)
    local inst = SpawnPrefab(prefab)
    if inst == nil then return nil, "SpawnPrefab(" .. prefab .. ") returned nil" end
    local x, y, z = spawnPoint(near)
    inst.Transform:SetPosition(x, y, z)
    inst.name = tostring(offer.name or "Sei")
    inst:AddTag("sei_companion")
    if inst.components.skinner ~= nil then
        pcall(function() inst.components.skinner:SetSkinMode("normal_skin") end)
    end
    inst.entity:SetCanSleep(false)
    inst.persists = false
    inst.sei = {
        prefab = prefab,
        announce = offer.announce ~= false,
        cmd = nil,
        follow = near,
        followDist = 4,
        fight = true,
        flee = nil,
        paused = false,
    }
    Companion.inst = inst
    Events.Attach(inst)
    Perception.Start(inst)
    Commands.Start(inst)
    local ok, err = pcall(function()
        inst:SetBrain(require("brains/seibrain"))
        inst:RestartBrain()
    end)
    if not ok then
        Net.ReportError("SetBrain failed: " .. tostring(err))
        Companion.Despawn("brain failed")
        return nil, "brain failed: " .. tostring(err)
    end
    Events.Post("spawned", {
        guid = inst.GUID,
        prefab = prefab,
        name = inst.name,
        x = Util.Round1(x), z = Util.Round1(z),
        session = TheNet.GetSessionIdentifier ~= nil and TheNet:GetSessionIdentifier() or "",
        world = TheNet.GetServerName ~= nil and TheNet:GetServerName() or "",
        near = near ~= nil and near.userid or "",
    })
    return inst
end

--- Remove the body. Safe to call twice.
function Companion.Despawn(reason)
    local inst = Companion.inst
    Companion.inst = nil
    Commands.Stop()
    Perception.Stop()
    Events.Detach()
    if inst == nil or not inst:IsValid() then
        Net.Reset()
        return
    end
    pcall(function() inst:StopBrain() end)
    pcall(function() inst:ClearBufferedAction() end)
    if inst.components.locomotor ~= nil then pcall(function() inst.components.locomotor:Stop() end) end
    if inst.components.combat ~= nil then pcall(function() inst.components.combat:SetTarget(nil) end) end
    if inst.components.inventory ~= nil then
        pcall(function() inst.components.inventory:DropEverything() end)
    end
    -- Tell the runtime before the transport goes; the POST is async and the
    -- callback may never fire, which is fine.
    Events.Post("despawned", { reason = tostring(reason or "") })
    local ok, err = pcall(function() inst:Remove() end)
    if not ok then
        print("[sei] Remove() failed, parking the body: " .. tostring(err))
        pcall(function()
            inst.Transform:SetPosition(PARK_DISTANCE, 0, PARK_DISTANCE)
            inst:AddTag("INLIMBO")
            inst:Hide()
        end)
    end
    -- Give the despawned POST a moment on the wire before the link is dropped.
    if TheWorld ~= nil then
        TheWorld:DoTaskInTime(1, function() Net.Reset() end)
    else
        Net.Reset()
    end
end

function Companion.IsLive()
    return Companion.inst ~= nil and Companion.inst:IsValid()
end

return Companion
