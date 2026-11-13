-- scripts/sei/tactics.lua: helper 0.4.0 body habits that follow-type and
-- survival mechanics need, run by the brain (brains/seibrain.lua). None of
-- them picks a goal: the model decides what to do; these only keep the body
-- with the player and alive while it does.
--
--   wormhole  the player jumps into a wormhole while she follows: she jumps
--             in after them (the game moves a player's followers through a
--             teleporter, but the body is not a game follower)
--   dodge     hit and run: when a slow-swinging creature she is fighting
--             winds up an attack on her, she steps out of reach, then the
--             fight resumes (never against bosses)
--   boss      a boss ("epic": Deerclops, Bearger, a Treeguard...) close by, or
--             going for her: she runs, unless the model told her to attack it
--   assist    follow({help:true}): while the player chops or mines, she works
--             the next tree or boulder beside them
--
-- Each reports what it did as a `survival` event (your_habits in the app;
-- boss also wakes the brain).

local Util = require("sei/util")
local Events = require("sei/events")
local Reflexes = require("sei/reflexes")
local Survivors = require("sei/survivors")

local Tactics = {}

-- Wormhole follow.
local HOLE_FOLLOW_DIST = 40   -- she follows a jump only from this close
local HOLE_KEEP_S = 25        -- and gives up after this long
local HOLE_SEARCH_DIST = 6    -- a leader who vanished this close to a hole used it
local TELEPORT_JUMP = 30      -- a one-tick move this long is a teleport

-- Dodge.
local KITE_MIN_PERIOD = 1.5   -- only creatures that swing this slowly or slower
local KITE_MAX_RANGE = 4      -- melee only; dodging a spitter does nothing
local DODGE_S = 0.9
local DODGE_STEP = 4

-- Boss.
local BOSS_NEAR = 12
local BOSS_TARGET_DIST = 20
local BOSS_SAFE = 24
local BOSS_MAX_S = 20
local BOSS_REPORT_S = 30

-- Assist.
local ASSIST_RADIUS = 10      -- around the leader
local ASSIST_KEEP_S = 5       -- the leader's last swing still counts this long
local ASSIST_LEASH = 14
local ASSIST_REPORT_S = 30
local ASSIST_ACTIONS = { CHOP = "CHOP_workable", MINE = "MINE_workable" }
local ASSIST_STATES = { chop = "CHOP", chop_start = "CHOP", mine = "MINE", mine_start = "MINE" }

local function now() return GetTime() end

local function alive(v)
    return v ~= nil and v:IsValid() and not (v.components.health ~= nil and v.components.health:IsDead())
end

-- ── wormhole follow ─────────────────────────────────────────────────────────

local function holeNear(x, z)
    local ents = TheSim:FindEntities(x, 0, z, HOLE_SEARCH_DIST, nil, { "INLIMBO" })
    for _, v in ipairs(ents) do
        if v.components.teleporter ~= nil and v.components.teleporter:IsActive() then return v end
    end
    return nil
end

--- The hole the leader is jumping into right now, from its stategraph.
local function leaderHole(f)
    local sg = f.sg
    local state = sg ~= nil and sg.currentstate ~= nil and sg.currentstate.name or nil
    if state == "jumpin" and sg.statemem.target ~= nil then return sg.statemem.target end
    if state == "jumpin_pre" then
        local ba = f.bufferedaction
        if ba ~= nil and ba.action == ACTIONS.JUMPIN then return ba.target end
    end
    return nil
end

--- Brain tick: watch the leader for a jump, and the body for its arrival.
function Tactics.Watch(inst)
    local sei = inst.sei
    local t = now()
    local x, _, z = inst.Transform:GetWorldPosition()
    -- The body's own teleport: a pending hole is done.
    if sei.myPos ~= nil and sei.hole ~= nil then
        local dx, dz = x - sei.myPos.x, z - sei.myPos.z
        if dx * dx + dz * dz > TELEPORT_JUMP * TELEPORT_JUMP then
            local f = sei.follow
            Events.Post("survival", { what = "wormhole", player = f ~= nil and f:IsValid() and (f.name or f.prefab) or "" })
            sei.hole = nil
        end
    end
    sei.myPos = { x = x, z = z }

    local f = sei.follow
    if f == nil or not f:IsValid() then
        sei.hole, sei.leaderPos = nil, nil
        return
    end
    local lx, _, lz = f.Transform:GetWorldPosition()
    local hole = leaderHole(f)
    if hole == nil and sei.leaderPos ~= nil then
        local dx, dz = lx - sei.leaderPos.x, lz - sei.leaderPos.z
        if dx * dx + dz * dz > TELEPORT_JUMP * TELEPORT_JUMP then hole = holeNear(sei.leaderPos.x, sei.leaderPos.z) end
    end
    sei.leaderPos = { x = lx, z = lz }
    if hole ~= nil and hole:IsValid() and hole.components.teleporter ~= nil
        and (sei.hole == nil or sei.hole.ent ~= hole) and Util.DistXZ(inst, hole) <= HOLE_FOLLOW_DIST then
        sei.hole = { ent = hole, untilT = t + HOLE_KEEP_S }
    end
    if sei.hole ~= nil and (t > sei.hole.untilT or not sei.hole.ent:IsValid()) then sei.hole = nil end

    Tactics.WatchLeaderWork(inst, f, t)
end

function Tactics.HoleWanted(inst)
    local sei = inst.sei
    return sei ~= nil and not sei.paused and sei.cmd == nil and sei.hole ~= nil and sei.follow ~= nil
end

function Tactics.HoleAction(inst)
    local sei = inst.sei
    local h = sei.hole
    if h == nil or not h.ent:IsValid() then return nil end
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") then return nil end
    local tp = h.ent.components.teleporter
    if tp == nil or not tp:IsActive() then
        sei.hole = nil
        return nil
    end
    return BufferedAction(inst, h.ent, ACTIONS.JUMPIN)
end

-- ── dodge (hit and run) ─────────────────────────────────────────────────────

function Tactics.Kiteable(t)
    if not alive(t) or t:HasTag("epic") or t:HasTag("player") then return false end
    local c = t.components.combat
    if c == nil then return false end
    return (c.min_attack_period or 0) >= KITE_MIN_PERIOD and (c.attackrange or 3) <= KITE_MAX_RANGE
end

--- Called when the body's fight target changes: listen for the target
--- winding up an attack on her.
function Tactics.WatchTarget(inst, target)
    local sei = inst.sei
    local w = sei.kiteWatch
    if w ~= nil then
        if w.ent == target then return end
        if w.ent:IsValid() then inst:RemoveEventCallback("newstate", w.fn, w.ent) end
        sei.kiteWatch = nil
    end
    sei.dodge = nil
    if target == nil or not Tactics.Kiteable(target) then return end
    local fn = function(ent)
        if not inst:IsValid() or inst.sei == nil or inst.sei.paused then return end
        if inst.components.health ~= nil and inst.components.health:IsDead() then return end
        local c = ent.components.combat
        if c == nil or c.target ~= inst or ent.sg == nil or not ent.sg:HasStateTag("attack") then return end
        if Util.DistXZ(inst, ent) > (c:GetHitRange() or 3) + 2.5 then return end
        inst.sei.dodge = { ent = ent, untilT = now() + DODGE_S }
        local kited = inst.sei.kited or {}
        inst.sei.kited = kited
        if not kited[ent] then
            kited[ent] = true
            Events.Post("survival", { what = "kite", threat = ent.prefab })
        end
        if inst.brain ~= nil then inst.brain:ForceUpdate() end
    end
    inst:ListenForEvent("newstate", fn, target)
    sei.kiteWatch = { ent = target, fn = fn }
end

function Tactics.Dodging(inst)
    local d = inst.sei ~= nil and inst.sei.dodge or nil
    if d == nil then return false end
    if inst.sei.paused or now() > d.untilT or not alive(d.ent) then
        inst.sei.dodge = nil
        return false
    end
    return true
end

--- The point DODGE_STEP away from the creature, straight back.
function Tactics.DodgePoint(inst)
    local d = inst.sei.dodge
    if d == nil then return nil end
    local x, _, z = inst.Transform:GetWorldPosition()
    local ex, _, ez = d.ent.Transform:GetWorldPosition()
    local dx, dz = x - ex, z - ez
    local len = math.sqrt(dx * dx + dz * dz)
    if len < 0.01 then dx, dz, len = 1, 0, 1 end
    return Vector3(x + dx / len * DODGE_STEP, 0, z + dz / len * DODGE_STEP)
end

-- ── boss ────────────────────────────────────────────────────────────────────

local function commandedAt(inst, boss)
    local cmd = inst.sei.cmd
    return cmd ~= nil and cmd.kind == "attack" and Util.Ent(cmd.guid) == boss
end

--- The boss she should be running from, or nil. Once running she keeps
--- going until BOSS_SAFE away (or BOSS_MAX_S), so she does not stop at the
--- edge of its reach.
function Tactics.BossThreat(inst)
    local sei = inst.sei
    if sei == nil or sei.paused then return nil end
    local t = now()
    local run = sei.bossRun
    if run ~= nil then
        if alive(run.ent) and not commandedAt(inst, run.ent) and t < run.untilT and Util.DistXZ(inst, run.ent) < BOSS_SAFE then
            return run.ent
        end
        sei.bossRun = nil
    end
    local x, y, z = inst.Transform:GetWorldPosition()
    local ents = TheSim:FindEntities(x, y, z, BOSS_TARGET_DIST, { "epic" }, { "INLIMBO", "player" })
    for _, v in ipairs(ents) do
        if alive(v) and not commandedAt(inst, v) then
            local d = Util.DistXZ(inst, v)
            local c = v.components.combat
            if d <= BOSS_NEAR or (c ~= nil and c.target == inst) then
                sei.bossRun = { ent = v, untilT = t + BOSS_MAX_S }
                if inst.components.combat ~= nil and inst.components.combat.target == v then
                    pcall(function() inst.components.combat:SetTarget(nil) end)
                end
                sei.bossReported = sei.bossReported or {}
                local last = sei.bossReported[v]
                if last == nil or t - last > BOSS_REPORT_S then
                    sei.bossReported[v] = t
                    Events.Post("survival", { what = "boss", threat = v.prefab, guid = v.GUID })
                end
                return v
            end
        end
    end
    return nil
end

function Tactics.IsBoss(v)
    return v ~= nil and v:IsValid() and v:HasTag("epic")
end

-- ── assist ──────────────────────────────────────────────────────────────────

--- Brain tick (via Watch): remember what the leader is chopping or mining.
function Tactics.WatchLeaderWork(inst, f, t)
    local sei = inst.sei
    if not sei.followHelp then sei.leaderWork = nil return end
    local ba = f.bufferedaction
    local act = ba ~= nil and ba.action ~= nil and ba.action.id or nil
    if act ~= nil and ASSIST_ACTIONS[act] ~= nil then
        sei.leaderWork = { action = act, target = ba.target, at = t }
        return
    end
    local state = f.sg ~= nil and f.sg.currentstate ~= nil and f.sg.currentstate.name or nil
    local fromState = state ~= nil and ASSIST_STATES[state] or nil
    if fromState ~= nil then
        local prev = sei.leaderWork
        sei.leaderWork = { action = fromState, target = prev ~= nil and prev.action == fromState and prev.target or nil, at = t }
    end
end

function Tactics.AssistWanted(inst)
    local sei = inst.sei
    if sei == nil or sei.paused or sei.cmd ~= nil or not sei.followHelp then return false end
    local f, w = sei.follow, sei.leaderWork
    if f == nil or not f:IsValid() or w == nil or now() - w.at > ASSIST_KEEP_S then return false end
    return Util.DistXZ(inst, f) <= ASSIST_LEASH
end

function Tactics.AssistAction(inst)
    local sei = inst.sei
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") then return nil end
    local f, w = sei.follow, sei.leaderWork
    if f == nil or w == nil then return nil end
    local tag = ASSIST_ACTIONS[w.action]
    if tag == nil then return nil end
    if w.action == "CHOP" and Survivors.Get(sei.prefab).plantFriend then return nil end
    local t = sei.assistTarget
    if t == nil or not t:IsValid() or not t:HasTag(tag) or t == w.target or t:HasTag("burnt") then
        t = nil
        local x, y, z = f.Transform:GetWorldPosition()
        local ents = TheSim:FindEntities(x, y, z, ASSIST_RADIUS, { tag }, { "INLIMBO", "burnt", "NOCLICK", "FX" })
        local bestd = math.huge
        for _, v in ipairs(ents) do
            if v ~= w.target then
                local d = Util.DistXZ(inst, v)
                if d < bestd then t, bestd = v, d end
            end
        end
        sei.assistTarget = t
    end
    if t == nil then return nil end
    local tool = Reflexes.EquipTool(inst, ACTIONS[w.action])
    if tool == nil then
        -- No axe or pickaxe (or it is too dark to swap the torch): just follow.
        sei.leaderWork = nil
        return nil
    end
    local last = sei.assistReported
    if last == nil or now() - last > ASSIST_REPORT_S then
        sei.assistReported = now()
        Events.Post("survival", { what = "assist", work = string.lower(w.action), player = f.name or f.prefab })
    end
    return BufferedAction(inst, t, ACTIONS[w.action], tool)
end

return Tactics
