-- scripts/brains/seibrain.lua: the companion body's behaviour tree.
--
-- Skeleton adapted from FAtiMA-DST's fatimabrain.lua (MIT, hineios, 2018)
-- and DST-AICompanion's Follow / RunAway wiring (MIT, Hansae, 2024): a
-- PriorityNode whose command slot runs BufferedActions the external brain
-- asked for. The layers, top to bottom (first that wants to run wins):
--
--   1. safety   fire panic (unless fire-immune), run from hostiles below the
--               survivor's flee threshold; in the dark hold a carried light,
--               craft a torch, walk to a visible light or build a campfire
--               (sei/reflexes.lua); walk to a fire when freezing; heal when
--               hurt and safe; eat below 25% hunger (diet-aware, skips food
--               that hurts unless starving)
--   2. flee     an explicit flee command (RunAway for a few seconds)
--   3. attack   an explicit attack command, fighting back when hit, or
--               defending a player a monster is attacking (ChaseAndAttack,
--               best weapon and armor put on first)
--   4. fire     at dusk/night, feed a nearby fire running low
--   5. goto     walk to a point/entity (custom node; arrival supervised by
--               Commands.Tick)
--   6. command  DoAction over Commands.NextAction (chop/mine/pick/eat/build/
--               gather/container/light fire/give), re-issued until done
--   7. follow   trail the leader (Follow) when nothing else is running
--   8. stand    still. The brain decides; the body does not wander.
--
-- Reflexes here never wait on the LLM (plan decision 4). What they did is
-- reported through sei/events.lua so the brain can talk about it.

require("behaviours/wander")
require("behaviours/follow")
require("behaviours/runaway")
require("behaviours/chaseandattack")
require("behaviours/doaction")
require("behaviours/panic")
require("behaviours/standstill")

local Commands = require("sei/commands")
local Events = require("sei/events")
local Reflexes = require("sei/reflexes")
local Survivors = require("sei/survivors")
local Util = require("sei/util")

local RUN_AWAY_DIST = 10
local STOP_RUN_AWAY_DIST = 16
local LIGHT_SEE_DIST = 24
-- The seek-light node stops this close to a light even if the engine still
-- reads the spot as dark (a dying fire).
local LIGHT_SAFE_DIST = 1.5
local HUNGRY_PCT = 0.25
local STARVING_PCT = 0.08
local TICK_S = 0.5
local WARM_SEE_DIST = 20
local WARM_SAFE_DIST = 3
local FUEL_RADIUS = 10
local DEFEND_MARGIN = 0.1
local DEFEND_REPORT_S = 15
-- Retry gaps so a habit that cannot finish (no valid spot, no path) does not
-- spin every frame.
local LIGHT_RETRY_S = 4
-- After a dusk check that found nothing to do.
local LIGHT_IDLE_RETRY_S = 1
local HEAL_RETRY_S = 4
local FUEL_RETRY_S = 3

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

-- ── custom node: walk to a light (or a fire) ───────────────────────────────
--
-- Vanilla FindLight walks to the closest "lightsource", which for this body
-- is often its own torch (distance 0: instant success) or a light that is
-- asleep and lights nothing. This one takes the target from `pick` and stops
-- when `arrived` says so (for light: Reflexes.LitByOthers, the same test
-- NeedsLight uses).

local SeiSeekLight = Class(BehaviourNode, function(self, inst, name, pick, arrived)
    BehaviourNode._ctor(self, name)
    self.inst = inst
    self.pick = pick
    self.arrived = arrived
    self.targ = nil
    self.nextPick = 0
end)

function SeiSeekLight:Visit()
    if self.status == READY then
        self.targ = nil
        self.nextPick = 0
        self.status = RUNNING
    end
    if self.status ~= RUNNING then return end
    local now = GetTime()
    if self.targ == nil or not self.targ:IsValid() or now >= self.nextPick then
        self.targ = self.pick(self.inst)
        self.nextPick = now + 2
    end
    if self.targ == nil then
        self.status = FAILED
        return
    end
    if self.arrived(self.inst, self.targ) then
        self.inst.components.locomotor:Stop()
        self.status = SUCCESS
        return
    end
    self.inst.components.locomotor:GoToPoint(self.inst:GetPositionAdjacentTo(self.targ, 1), nil, true)
    self:Sleep(0.5)
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
    return Reflexes.NeedsLight(inst)
end

-- lightNext is the earliest time the light habit may try again. Every
-- attempt sets it, including one that returned no action (it equipped a
-- carried light, or there is nothing to do but walk to a light), so a step
-- that changes nothing cannot repeat every frame.
local function lightStep(inst)
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") then return nil end
    local now = GetTime()
    if inst.sei.lightNext ~= nil and now < inst.sei.lightNext then return nil end
    local b
    if Reflexes.NeedsLight(inst) then
        b = Reflexes.LightAction(inst, LIGHT_SEE_DIST)
        inst.sei.lightNext = now + LIGHT_RETRY_S
    else
        b = Reflexes.DuskPrep(inst, LIGHT_SEE_DIST)
        inst.sei.lightNext = now + (b ~= nil and LIGHT_RETRY_S or LIGHT_IDLE_RETRY_S)
    end
    return b
end

local function seekLightTarget(inst)
    return (Reflexes.NearestLight(inst, LIGHT_SEE_DIST))
end

local function litNow(inst, targ)
    return Reflexes.LitByOthers(inst) or Util.DistXZ(inst, targ) <= LIGHT_SAFE_DIST
end

local function warmFireTarget(inst)
    return (Reflexes.BurningFire(inst, WARM_SEE_DIST))
end

local function warmNow(inst, targ)
    return Util.DistXZ(inst, targ) <= WARM_SAFE_DIST
end

-- Night light, or getting it ready late in dusk (Reflexes.DuskPrep).
local function lightDue(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    return TheWorld.state.phase ~= "day" or TheWorld:HasTag("cave")
end

local function freezingNearFire(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    if not inst:IsFreezing() then return false end
    local fire, d = Reflexes.BurningFire(inst, WARM_SEE_DIST)
    return fire ~= nil and d > WARM_SAFE_DIST
end

local function hungry(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    return hungerPct(inst) < HUNGRY_PCT
end

local function wantsHeal(inst)
    if inst.sei == nil or inst.sei.paused then return false end
    if inst.sei.healTry ~= nil and GetTime() - inst.sei.healTry < HEAL_RETRY_S then return false end
    return Reflexes.WantsHeal(inst, hostileNear)
end

local function healStep(inst)
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") then return nil end
    inst.sei.healTry = GetTime()
    return Reflexes.HealAction(inst)
end

local function fuelStep(inst)
    if inst.sei == nil or inst.sei.paused then return nil end
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") then return nil end
    local now = GetTime()
    if inst.sei.fuelTry ~= nil and now - inst.sei.fuelTry < FUEL_RETRY_S then return nil end
    local b = Reflexes.FuelAction(inst, FUEL_RADIUS)
    if b ~= nil then inst.sei.fuelTry = now end
    return b
end

local function eatFromInventory(inst)
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") then return nil end
    local food = Reflexes.ChooseFood(inst, hungerPct(inst) < STARVING_PCT)
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
    self.lastDefendReport = 0
    self.lastDefendThreat = nil
    self.gearTarget = nil
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
            -- Keep the fires near the body burning visibly even when no
            -- real player is near (see reflexes.lua); paused too, like a
            -- player away from the keyboard.
            Reflexes.KeepFiresAwake(inst)
            if needsLight(inst) and now - self.lastDarkReport > 20 then
                self.lastDarkReport = now
                Events.Post("survival", { what = "dark", phase = TheWorld.state.phase })
            end
            if inst.sei ~= nil and not inst.sei.paused then
                Reflexes.StowDayTorch(inst)
                self:Defend(now)
                -- Gear up once per new fight target.
                local t = inst.components.combat ~= nil and inst.components.combat.target or nil
                if t ~= nil and t ~= self.gearTarget then
                    self.gearTarget = t
                    Reflexes.GearUp(inst, t)
                elseif t == nil then
                    self.gearTarget = nil
                end
            end
        end, require("sei/net").ReportError)
    end)

    local root = PriorityNode({
        -- 1. safety
        WhileNode(function() return onFire(inst) end, "OnFire", Panic(inst)),
        WhileNode(function() return shouldRunAway(inst) end, "LowHealthRunAway",
            RunAway(inst, function(guy) return guy:HasTag("_combat") and guy:HasTag("hostile") and not guy:HasTag("player") end, RUN_AWAY_DIST, STOP_RUN_AWAY_DIST)),
        IfNode(function() return lightDue(inst) end, "MakeLight", DoAction(inst, function() return lightStep(inst) end, "Light", true)),
        WhileNode(function() return needsLight(inst) end, "FindLight", SeiSeekLight(inst, "SeekLight", seekLightTarget, litNow)),
        WhileNode(function() return freezingNearFire(inst) end, "WarmUp", SeiSeekLight(inst, "SeekWarmth", warmFireTarget, warmNow)),
        IfNode(function() return wantsHeal(inst) end, "Heal", DoAction(inst, function() return healStep(inst) end, "Heal", true)),
        IfNode(function() return hungry(inst) end, "Hungry", DoAction(inst, function() return eatFromInventory(inst) end, "Eat", true)),
        -- 2. flee (explicit)
        WhileNode(function() return fleeing(inst) end, "Flee",
            RunAway(inst, function(guy) return guy:HasTag("_combat") and not guy:HasTag("player") and not guy:HasTag("companion") end, 14, 20)),
        -- 3. attack / fight back
        WhileNode(function() return attacking(inst) end, "Attack", ChaseAndAttack(inst, 20, 30)),
        -- 4. tend a fire running low (dusk/night)
        DoAction(inst, function() return fuelStep(inst) end, "Fuel", true),
        -- 5. goto
        WhileNode(function() return gotoSlot(inst) end, "GoTo", SeiGoTo(inst)),
        -- 6. the command slot
        WhileNode(function() return actionSlot(inst) end, "Command",
            DoAction(inst, function() return Commands.NextAction(inst) end, "SeiCommand", true)),
        -- 7. follow
        WhileNode(function() return followTarget(inst) ~= nil end, "Follow",
            Follow(inst, function() return followTarget(inst) end, 2, inst.sei.followDist or 4, 14, true)),
        -- 8. stand still
        StandStill(inst),
    }, 0.25)
    self.bt = BT(inst, root)
end

--- Take on a monster that is attacking a player we are with. Only with
--- fight-back on, enough health to spare, and nothing else to fight.
function SeiBrain:Defend(now)
    local inst = self.inst
    local sei = inst.sei
    if not sei.fight or fleeing(inst) or inst.components.combat == nil then return end
    if inst.components.combat.target ~= nil then return end
    if sei.cmd ~= nil and (sei.cmd.kind == "attack" or sei.cmd.kind == "goto") then return end
    if healthPct(inst) <= Survivors.FleeHealthPct(sei.prefab) + DEFEND_MARGIN then return end
    local threat = Reflexes.ThreatToPlayer(inst)
    if threat == nil then return end
    inst.components.combat:SetTarget(threat)
    if threat ~= self.lastDefendThreat or now - self.lastDefendReport > DEFEND_REPORT_S then
        self.lastDefendThreat = threat
        self.lastDefendReport = now
        local victim = threat.components.combat.target
        Events.Post("survival", { what = "defend", threat = threat.prefab, guid = threat.GUID,
            player = victim ~= nil and (victim.name or victim.prefab) or "", userid = victim ~= nil and victim.userid or "" })
    end
end

function SeiBrain:OnStop()
    Reflexes.ReleaseFires(self.inst)
    if self.tickTask ~= nil then
        self.tickTask:Cancel()
        self.tickTask = nil
    end
end

return SeiBrain
