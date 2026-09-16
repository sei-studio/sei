-- scripts/brains/seibrain.lua: the companion body's behaviour tree.
--
-- Skeleton adapted from FAtiMA-DST's fatimabrain.lua (MIT, hineios, 2018)
-- and DST-AICompanion's Follow / RunAway wiring (MIT, Hansae, 2024): a
-- PriorityNode whose command slot runs BufferedActions the external brain
-- asked for. The layers, top to bottom (first that wants to run wins):
--
--   1. safety   fire panic (unless fire-immune), run from hostiles below the
--               survivor's flee threshold, find light at dusk/night when not
--               in light, eat from the inventory below 25% hunger (diet-aware)
--   2. flee     an explicit flee command (RunAway for a few seconds)
--   3. attack   an explicit attack command, or fighting back when hit and
--               fight-back is on (ChaseAndAttack)
--   4. goto     walk to a point/entity (custom node; arrival supervised by
--               Commands.Tick)
--   5. command  DoAction over Commands.NextAction (chop/mine/pick/eat/build/
--               gather/container/light fire), re-issued until done
--   6. follow   trail the leader (Follow) when nothing else is running
--   7. stand    still. The brain decides; the body does not wander.
--
-- Reflexes here never wait on the LLM (plan decision 4). What they did is
-- reported through sei/events.lua so the brain can talk about it.

require("behaviours/wander")
require("behaviours/follow")
require("behaviours/runaway")
require("behaviours/findlight")
require("behaviours/chaseandattack")
require("behaviours/doaction")
require("behaviours/panic")
require("behaviours/standstill")

local Commands = require("sei/commands")
local Events = require("sei/events")
local Survivors = require("sei/survivors")
local Util = require("sei/util")

local RUN_AWAY_DIST = 10
local STOP_RUN_AWAY_DIST = 16
local LIGHT_SEE_DIST = 24
local LIGHT_SAFE_DIST = 4
local HUNGRY_PCT = 0.25
local TICK_S = 0.5

-- ── custom node: walk to a point or entity ─────────────────────────────────

local SeiGoTo = Class(BehaviourNode, function(self, inst)
    BehaviourNode._ctor(self, "SeiGoTo")
    self.inst = inst
    self.cmd = nil
end)

function SeiGoTo:Visit()
    local cmd = self.inst.sei and self.inst.sei.cmd or nil
    if cmd == nil or cmd.kind ~= "goto" then
        self.status = SUCCESS
        self.cmd = nil
        return
    end
    if self.cmd ~= cmd then
        self.cmd = cmd
        local loco = self.inst.components.locomotor
        if cmd.targetEnt ~= nil and cmd.targetEnt:IsValid() then
            loco:GoToEntity(cmd.targetEnt, nil, true)
        else
            loco:GoToPoint(Vector3(cmd.x or 0, 0, cmd.z or 0), nil, true)
        end
    elseif cmd.targetEnt ~= nil and cmd.targetEnt:IsValid() and self.inst.components.locomotor.dest == nil then
        -- The target walked; re-path.
        self.inst.components.locomotor:GoToEntity(cmd.targetEnt, nil, true)
    end
    self.status = RUNNING
    self:Sleep(0.25)
end

-- ── predicates ──────────────────────────────────────────────────────────────

local function survivorOf(inst)
    return Survivors.Get(inst.sei and inst.sei.prefab or nil)
end

local function healthPct(inst)
    return inst.components.health ~= nil and inst.components.health:GetPercent() or 1
end

local function hungerPct(inst)
    return inst.components.hunger ~= nil and inst.components.hunger:GetPercent() or 1
end

local function hostileNear(inst, dist)
    local x, y, z = inst.Transform:GetWorldPosition()
    local ents = TheSim:FindEntities(x, y, z, dist, { "_combat", "hostile" }, { "INLIMBO", "player", "companion" })
    for _, v in ipairs(ents) do
        if v ~= inst and v.components.health ~= nil and not v.components.health:IsDead() then return v end
    end
    return nil
end

local function shouldRunAway(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    if healthPct(inst) > Survivors.FleeHealthPct(inst.sei.prefab) then return false end
    return hostileNear(inst, RUN_AWAY_DIST) ~= nil
end

local function onFire(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    if survivorOf(inst).fireImmune then return false end
    return inst.components.health ~= nil and inst.components.health.takingfiredamage
end

local function needsLight(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    local phase = TheWorld.state.phase
    if phase ~= "night" and phase ~= "dusk" then return false end
    if inst.LightWatcher ~= nil and inst.LightWatcher:IsInLight() then return false end
    -- A held light (torch, lantern) counts as light.
    local hands = inst.components.inventory ~= nil and inst.components.inventory:GetEquippedItem(EQUIPSLOTS.HANDS) or nil
    if hands ~= nil and hands.components.fueled ~= nil and hands:HasTag("lighter") then return false end
    return true
end

local function hungry(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    return hungerPct(inst) < HUNGRY_PCT
end

local function eatFromInventory(inst)
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") then return nil end
    local inv, eater = inst.components.inventory, inst.components.eater
    if inv == nil or eater == nil then return nil end
    local s = survivorOf(inst)
    local prefab = inst.sei.prefab
    local function pick(pred)
        return inv:FindItem(function(item)
            return item.components.edible ~= nil and eater:CanEat(item) and Survivors.DietAllows(prefab, item) and pred(item)
        end)
    end
    local food = nil
    if s.souls then food = pick(function(i) return i:HasTag("soul") end) end
    if food == nil and s.needsCrockpot then food = pick(function(i) return i:HasTag("preparedfood") end) end
    if food == nil then
        food = pick(function(i)
            if s.eatsSpoiled then return true end
            return i.components.perishable == nil or i.components.perishable:GetPercent() > 0.2
        end)
    end
    if food == nil and hungerPct(inst) < 0.08 then food = pick(function() return true end) end
    if food == nil then return nil end
    local b = BufferedAction(inst, food, ACTIONS.EAT)
    b:AddSuccessAction(function()
        Events.Post("survival", { what = "ate", item = food.prefab, hunger = Util.Round1(hungerPct(inst)) })
    end)
    return b
end

local function fleeing(inst)
    return inst.sei ~= nil and inst.sei.flee ~= nil and GetTime() < inst.sei.flee
end

local function attacking(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    local cmd = inst.sei.cmd
    if cmd ~= nil and cmd.kind == "attack" then return true end
    if inst.sei.fight and inst.components.combat ~= nil and inst.components.combat.target ~= nil then
        local t = inst.components.combat.target
        return t:IsValid() and not t:HasTag("player")
    end
    return false
end

local function actionSlot(inst)
    return inst.sei ~= nil and not inst.sei.paused and Commands.IsActionSlot(inst.sei.cmd)
end

local function gotoSlot(inst)
    return inst.sei ~= nil and not inst.sei.paused and inst.sei.cmd ~= nil and inst.sei.cmd.kind == "goto"
end

local function followTarget(inst)
    if inst.sei == nil or inst.sei.paused or inst.sei.cmd ~= nil then return nil end
    local f = inst.sei.follow
    if f == nil or not f:IsValid() then
        inst.sei.follow = nil
        return nil
    end
    return f
end

-- ── the brain ───────────────────────────────────────────────────────────────

local SeiBrain = Class(Brain, function(self, inst)
    Brain._ctor(self, inst)
end)

function SeiBrain:OnStart()
    local inst = self.inst
    inst.entity:SetCanSleep(false)
    if inst.sei == nil then inst.sei = { prefab = "wilson", fight = true, announce = true } end

    self.lastLowHealthReport = 0
    self.lastDarkReport = 0
    if self.tickTask ~= nil then self.tickTask:Cancel() end
    self.tickTask = inst:DoPeriodicTask(TICK_S, function()
        Util.Guard("brain.tick", function()
            Commands.Tick(inst)
            -- Report what the safety layer is doing (throttled) so the
            -- external brain can narrate it (sei:attacked kind 'reflex').
            local now = GetTime()
            if shouldRunAway(inst) and now - self.lastLowHealthReport > 12 then
                self.lastLowHealthReport = now
                local h = hostileNear(inst, RUN_AWAY_DIST)
                Events.Post("survival", { what = "retreat", threat = h and h.prefab or "hostiles", healthpct = Util.Round1(healthPct(inst)) })
            end
            if needsLight(inst) and now - self.lastDarkReport > 20 then
                self.lastDarkReport = now
                Events.Post("survival", { what = "dark", phase = TheWorld.state.phase })
            end
        end, require("sei/net").ReportError)
    end)

    local root = PriorityNode({
        -- 1. safety
        WhileNode(function() return onFire(inst) end, "OnFire", Panic(inst)),
        WhileNode(function() return shouldRunAway(inst) end, "LowHealthRunAway",
            RunAway(inst, function(guy) return guy:HasTag("_combat") and guy:HasTag("hostile") and not guy:HasTag("player") end, RUN_AWAY_DIST, STOP_RUN_AWAY_DIST)),
        WhileNode(function() return needsLight(inst) end, "FindLight", FindLight(inst, LIGHT_SEE_DIST, LIGHT_SAFE_DIST)),
        IfNode(function() return hungry(inst) end, "Hungry", DoAction(inst, function() return eatFromInventory(inst) end, "Eat", true)),
        -- 2. flee (explicit)
        WhileNode(function() return fleeing(inst) end, "Flee",
            RunAway(inst, function(guy) return guy:HasTag("_combat") and not guy:HasTag("player") and not guy:HasTag("companion") end, 14, 20)),
        -- 3. attack / fight back
        WhileNode(function() return attacking(inst) end, "Attack", ChaseAndAttack(inst, 20, 30)),
        -- 4. goto
        WhileNode(function() return gotoSlot(inst) end, "GoTo", SeiGoTo(inst)),
        -- 5. the command slot
        WhileNode(function() return actionSlot(inst) end, "Command",
            DoAction(inst, function() return Commands.NextAction(inst) end, "SeiCommand", true)),
        -- 6. follow
        WhileNode(function() return followTarget(inst) ~= nil end, "Follow",
            Follow(inst, function() return followTarget(inst) end, 2, inst.sei.followDist or 4, 14, true)),
        -- 7. stand still
        StandStill(inst),
    }, 0.25)
    self.bt = BT(inst, root)
end

function SeiBrain:OnStop()
    if self.tickTask ~= nil then
        self.tickTask:Cancel()
        self.tickTask = nil
    end
end

return SeiBrain
