-- scripts/sei/commands.lua: the command channel (GET /cmd long-poll) and the
-- executor the behaviour tree drives.
--
-- One request is in flight at a time. The runtime holds the response up to
-- 400 ms when it has nothing queued, so an idle body costs ~2.5 req/s and a
-- command lands within 100-400 ms of the brain issuing it (plan section 3).
-- A transport failure backs the poll off to 1 s.
--
-- Every command is either IMMEDIATE (say, stop, follow, equip, drop, fight)
-- and answered from the dispatcher, or SLOTTED: it becomes inst.sei.cmd and
-- the brain's command slot (brains/seibrain.lua) executes it through
-- Commands.NextAction, which returns the next BufferedAction for it or nil.
-- The DoAction / KeepWorking shape follows FAtiMA-DST (MIT, hineios): a work
-- action is re-issued until the target's *_workable tag drops.
--
-- Results go back as {kind:'result', id, ok, text} on /event; `text` is the
-- string the brain hands the model ("chopped 3 evergreen", "cant_reach ...").

local Net = require("sei/net")
local Util = require("sei/util")
local Speak = require("sei/speak")
local Events = require("sei/events")
local Survivors = require("sei/survivors")
local Reflexes = require("sei/reflexes")

local Commands = {}

local POLL_RETRY_S = 1
local CMD_TIMEOUT_S = 90
-- How far gather looks for loose items, plants and work targets (mod 0.3.0;
-- was 20/24, and "none left nearby" came back while a grass field sat just
-- past the edge).
local GATHER_RADIUS = 40
local LIGHTFIRE_RADIUS = 12
local GIVE_RANGE = 3
local WALK_TIMEOUT_S = 30
local WORK_ACTIONS = { CHOP = true, MINE = true, DIG = true, HAMMER = true }
local WORK_TAG = { CHOP = "CHOP_workable", MINE = "MINE_workable", DIG = "DIG_workable", HAMMER = "HAMMER_workable" }
local WORK_TOOL = { CHOP = "an axe", MINE = "a pickaxe", DIG = "a shovel", HAMMER = "a hammer" }
-- In the dark the body walks to the work with its light in hand and only
-- then decides torch or tool, by the light where it will stand.
local WORK_JUDGE_DIST = 3

--- Why a work action cannot start (Reflexes.EquipTool's reason), as the
--- result text the LLM reads.
local function noToolText(name, why)
    local verb = string.lower(name)
    if why == "dark" then
        return "too dark to " .. verb .. " here: keeping the torch in hand, nothing else lights this spot. Work next to a fire or wait for day"
    end
    return "cannot " .. verb .. " without " .. (WORK_TOOL[name] or "a tool") .. ": craft one or carry one"
end

local state = { inst = nil, since = 0, polling = false, task = nil, stopped = true }

-- ── results ─────────────────────────────────────────────────────────────────

local function result(id, ok, text)
    if id == nil then return end
    Events.Post("result", { id = id, ok = ok and true or false, text = tostring(text or "") })
end

--- Finish the slotted command (if it is the one given) with a result.
function Commands.Finish(inst, cmd, ok, text)
    if inst.sei == nil or inst.sei.cmd ~= cmd then return end
    inst.sei.cmd = nil
    inst.sei.lastResult = text
    result(cmd.id, ok, text)
end

local function cancelCurrent(inst, why)
    local cur = inst.sei and inst.sei.cmd or nil
    if cur ~= nil then
        Commands.Finish(inst, cur, false, why or "cancelled")
    end
    pcall(function() inst:ClearBufferedAction() end)
    if inst.components.locomotor ~= nil then pcall(function() inst.components.locomotor:Stop() end) end
end

-- ── helpers ─────────────────────────────────────────────────────────────────

local function invItem(inst, guid)
    local item = Util.Ent(guid)
    if item == nil then return nil end
    if item.components.inventoryitem ~= nil and item.components.inventoryitem:GetGrandOwner() == inst then return item end
    return nil
end

local function findInvItem(inst, pred)
    if inst.components.inventory == nil then return nil end
    return inst.components.inventory:FindItem(pred)
end

local function nearestWith(inst, radius, pred, canttags)
    local x, y, z = inst.Transform:GetWorldPosition()
    local ents = TheSim:FindEntities(x, y, z, radius, nil, canttags or { "INLIMBO", "NOCLICK", "CLASSIFIED", "FX" })
    local best, bestd = nil, math.huge
    for _, v in ipairs(ents) do
        if v ~= inst and pred(v) then
            local d = Util.DistXZ(inst, v)
            if d < bestd then best, bestd = v, d end
        end
    end
    return best
end

local function countOf(inst, prefab)
    if inst.components.inventory == nil then return 0 end
    local _, n = inst.components.inventory:Has(prefab, 1)
    return n or 0
end

--- Walk to `target` through a WALKTO action (the locomotor reports arrival).
--- Returns (action, arrived). A body that has not arrived by the deadline
--- finishes the command with cant_reach.
local function walkTo(inst, cmd, target, range, what)
    if Util.DistXZ(inst, target) <= range then return nil, true end
    if cmd.state.walkDeadline == nil then cmd.state.walkDeadline = GetTime() + WALK_TIMEOUT_S end
    if GetTime() > cmd.state.walkDeadline then
        Commands.Finish(inst, cmd, false, "cant_reach " .. what .. " (" .. Util.Round1(Util.DistXZ(inst, target)) .. " away)")
        return nil, false
    end
    return BufferedAction(inst, target, ACTIONS.WALKTO), false
end

local function keepWorking(name, target)
    local tag = WORK_TAG[name]
    return tag ~= nil and target ~= nil and target:IsValid() and target:HasTag(tag)
end

-- ── the executor: next BufferedAction for the slotted command ───────────────

local function actionFor(inst, cmd)
    local name = cmd.name
    local act = ACTIONS[name]
    if act == nil then
        Commands.Finish(inst, cmd, false, "unknown action " .. tostring(name))
        return nil
    end
    local target = cmd.target ~= nil and Util.Ent(cmd.target) or nil
    if cmd.target ~= nil and target == nil then
        Commands.Finish(inst, cmd, cmd.state.done == true, cmd.state.done and cmd.state.text or "target is gone")
        return nil
    end
    local invobject = cmd.invobject ~= nil and Util.Ent(cmd.invobject) or nil
    if invobject == nil and WORK_ACTIONS[name] then
        if target ~= nil and Reflexes.IsDark() and not cmd.state.started then
            local walk, arrived = walkTo(inst, cmd, target, WORK_JUDGE_DIST, target.prefab)
            if not arrived then return walk end
        end
        local why
        invobject, why = Reflexes.EquipTool(inst, act)
        if invobject == nil then
            Commands.Finish(inst, cmd, false, noToolText(name, why))
            return nil
        end
    end
    local pos = cmd.pos ~= nil and Vector3(cmd.pos.x or 0, 0, cmd.pos.z or 0) or nil
    if WORK_ACTIONS[name] and cmd.state.started and not keepWorking(name, target) then
        Commands.Finish(inst, cmd, true, string.lower(name) .. " done: " .. (target and target.prefab or "target"))
        return nil
    end
    local b = BufferedAction(inst, target, act, invobject, pos, cmd.recipe)
    cmd.state.started = true
    b:AddFailAction(function()
        if WORK_ACTIONS[name] and keepWorking(name, target) then return end
        Commands.Finish(inst, cmd, false, (cmd.state.failreason or "could not " .. string.lower(name)) .. (target and (" " .. target.prefab) or ""))
    end)
    b:AddSuccessAction(function()
        if WORK_ACTIONS[name] then
            if not keepWorking(name, target) then
                Commands.Finish(inst, cmd, true, string.lower(name) .. " done: " .. (target and target.prefab or "target"))
            end
            return
        end
        Commands.Finish(inst, cmd, true, string.lower(name) .. " done" .. (target and (": " .. target.prefab) or ""))
    end)
    return b
end

local function gatherNext(inst, cmd)
    local st = cmd.state
    if st.start == nil then
        st.start = countOf(inst, cmd.prefab)
        st.deadline = GetTime() + math.min(CMD_TIMEOUT_S, 20 + 15 * (cmd.count or 1))
    end
    local have = countOf(inst, cmd.prefab) - st.start
    if have >= (cmd.count or 1) then
        Commands.Finish(inst, cmd, true, "gathered " .. have .. " " .. cmd.prefab)
        return nil
    end
    if GetTime() > st.deadline then
        Commands.Finish(inst, cmd, have > 0, "gathered " .. have .. " of " .. (cmd.count or 1) .. " " .. cmd.prefab .. " before giving up")
        return nil
    end
    -- Loose items on the ground first, then pickable plants, then work targets
    -- whose product is what we want (a tree for logs, a boulder for rocks).
    local wantFlag = cmd.source
    local ground = nearestWith(inst, GATHER_RADIUS, function(v)
        return v.prefab == cmd.prefab and v.components.inventoryitem ~= nil and v.components.inventoryitem.canbepickedup
            and v.components.inventoryitem:GetGrandOwner() == nil and not v:HasTag("heavy")
    end)
    if ground ~= nil then return BufferedAction(inst, ground, ACTIONS.PICKUP) end
    local pick = nearestWith(inst, GATHER_RADIUS, function(v)
        return v:HasTag("pickable") and (v.prefab == cmd.prefab or (wantFlag ~= nil and v.prefab == wantFlag)
            or (v.components.pickable ~= nil and v.components.pickable.product == cmd.prefab))
    end)
    if pick ~= nil then return BufferedAction(inst, pick, ACTIONS.PICK) end
    if wantFlag ~= nil and WORK_TAG[wantFlag] ~= nil then
        local plant = inst.sei and Survivors.Get(inst.sei.prefab).plantFriend and wantFlag == "CHOP"
        if not plant then
            local w = nearestWith(inst, GATHER_RADIUS, function(v) return v:HasTag(WORK_TAG[wantFlag]) and not v:HasTag("burnt") end)
            if w ~= nil then
                if Reflexes.IsDark() and Util.DistXZ(inst, w) > WORK_JUDGE_DIST then
                    return BufferedAction(inst, w, ACTIONS.WALKTO)
                end
                local tool, why = Reflexes.EquipTool(inst, ACTIONS[wantFlag])
                if tool == nil then
                    Commands.Finish(inst, cmd, have > 0, "gathered " .. have .. " " .. cmd.prefab .. "; " .. noToolText(wantFlag, why))
                    return nil
                end
                return BufferedAction(inst, w, ACTIONS[wantFlag], tool)
            end
        end
    end
    Commands.Finish(inst, cmd, have > 0, "gathered " .. have .. " " .. cmd.prefab .. "; none left nearby")
    return nil
end

local function buildNext(inst, cmd)
    local builder = inst.components.builder
    if builder == nil then
        Commands.Finish(inst, cmd, false, "cannot build")
        return nil
    end
    local recipe = GetValidRecipe and GetValidRecipe(cmd.recipe) or nil
    if recipe == nil then
        Commands.Finish(inst, cmd, false, "no such recipe: " .. tostring(cmd.recipe))
        return nil
    end
    if not builder:KnowsRecipe(recipe) then
        if not builder:CanLearn(cmd.recipe) then
            Commands.Finish(inst, cmd, false, "this survivor cannot learn " .. cmd.recipe)
            return nil
        end
        local proto = nearestWith(inst, 24, function(v) return v:HasTag("prototyper") end)
        if proto == nil then
            Commands.Finish(inst, cmd, false, "need a science machine (or better) nearby to learn " .. cmd.recipe)
            return nil
        end
        local walk, arrived = walkTo(inst, cmd, proto, 3, proto.prefab)
        if not arrived then return walk end
        local ok = builder:UsePrototyper(proto, true)
        if not ok or not builder:KnowsRecipe(recipe) then
            Commands.Finish(inst, cmd, false, "could not learn " .. cmd.recipe .. " at " .. proto.prefab)
            return nil
        end
    end
    if not builder:HasIngredients(recipe) then
        local need = {}
        for _, ing in ipairs(recipe.ingredients or {}) do
            local _, have = inst.components.inventory:Has(ing.type, ing.amount)
            if (have or 0) < ing.amount then need[#need + 1] = ing.amount .. " " .. ing.type .. " (have " .. (have or 0) .. ")" end
        end
        Commands.Finish(inst, cmd, false, "missing ingredients for " .. cmd.recipe .. ": " .. table.concat(need, ", "))
        return nil
    end
    local pt = nil
    if recipe.placer ~= nil then
        -- A placed structure needs a clear, buildable spot (mod 0.3.0; the
        -- old random point 2.5 away often landed in a tree or on water and the
        -- build failed with no reason).
        if cmd.pos ~= nil then
            local want = Vector3(cmd.pos.x, 0, cmd.pos.z)
            local ok = TheWorld.Map.CanDeployRecipeAtPoint == nil
                or TheWorld.Map:CanDeployRecipeAtPoint(want, recipe, 0, inst)
            if ok then pt = want end
        end
        if pt == nil and cmd.state.pt ~= nil then pt = cmd.state.pt end
        if pt == nil then pt = Reflexes.PlacementPoint(inst, recipe, nil, 2, 7) end
        if pt == nil then
            Commands.Finish(inst, cmd, false, "no clear spot to place " .. cmd.recipe .. " here; move to open ground")
            return nil
        end
        cmd.state.pt = pt
    elseif cmd.pos ~= nil then
        pt = Vector3(cmd.pos.x, 0, cmd.pos.z)
    end
    local b = BufferedAction(inst, nil, ACTIONS.BUILD, nil, pt or inst:GetPosition(), cmd.recipe, recipe.build_distance)
    b:AddSuccessAction(function() Commands.Finish(inst, cmd, true, "built " .. cmd.recipe) end)
    b:AddFailAction(function() Commands.Finish(inst, cmd, false, "could not build " .. cmd.recipe .. (cmd.state.failreason and (": " .. cmd.state.failreason) or "")) end)
    return b
end

local function containerNext(inst, cmd)
    local box = Util.Ent(cmd.container)
    if box == nil or box.components.container == nil then
        Commands.Finish(inst, cmd, false, "no container there")
        return nil
    end
    local walk, arrived = walkTo(inst, cmd, box, 2.5, "the container")
    if not arrived then return walk end
    local inv, cont = inst.components.inventory, box.components.container
    local moved = 0
    local want = cmd.count or 1
    if cmd.op == "store" then
        for _ = 1, want do
            local item = inv:FindItem(function(i) return i.prefab == cmd.item end)
            if item == nil then break end
            local one = item.components.stackable ~= nil and item.components.stackable:StackSize() > 1 and item.components.stackable:Get(1) or inv:RemoveItem(item)
            if one == nil then break end
            if not cont:GiveItem(one) then
                inv:GiveItem(one)
                break
            end
            moved = moved + 1
        end
        Commands.Finish(inst, cmd, moved > 0, moved > 0 and ("stored " .. moved .. " " .. cmd.item) or ("nothing to store (no " .. cmd.item .. " in inventory or the container is full)"))
    else
        for _ = 1, want do
            local item = cont:FindItem(function(i) return i.prefab == cmd.item end)
            if item == nil then break end
            local one = item.components.stackable ~= nil and item.components.stackable:StackSize() > 1 and item.components.stackable:Get(1) or cont:RemoveItem(item)
            if one == nil then break end
            inv:GiveItem(one)
            moved = moved + 1
        end
        Commands.Finish(inst, cmd, moved > 0, moved > 0 and ("took " .. moved .. " " .. cmd.item) or ("no " .. cmd.item .. " in that container"))
    end
    return nil
end

local function lightFireNext(inst, cmd)
    local fire = nearestWith(inst, LIGHTFIRE_RADIUS, function(v) return v.components.fueled ~= nil and (v:HasTag("campfire") or v.prefab == "firepit" or v.prefab == "campfire") end)
    if fire ~= nil then
        local fuel = findInvItem(inst, function(i) return i:HasTag("BURNABLE_fuel") and fire.components.fueled:CanAcceptFuelItem(i) end)
        if fuel == nil then
            Commands.Finish(inst, cmd, false, "no fuel in inventory to feed the fire (logs, twigs, grass)")
            return nil
        end
        local b = BufferedAction(inst, fire, ACTIONS.ADDFUEL, fuel)
        b:AddSuccessAction(function() Commands.Finish(inst, cmd, true, "fed the " .. fire.prefab .. " with " .. fuel.prefab) end)
        b:AddFailAction(function() Commands.Finish(inst, cmd, false, "could not add fuel to the " .. fire.prefab) end)
        return b
    end
    cmd.kind = "build"
    cmd.recipe = cmd.recipe or "campfire"
    return buildNext(inst, cmd)
end

--- Hand items to a player (mod 0.3.0). Walks over, then moves the items
--- straight into their inventory: ACTIONS.GIVETOPLAYER needs the giver's
--- inventory to be opened by the receiver, which an ownerless body never is.
--- A receiver with no room gets the rest dropped at their feet.
local function takeOne(inv, item, n)
    if item.components.stackable ~= nil and item.components.stackable:StackSize() > n then
        return item.components.stackable:Get(n), n
    end
    local size = item.components.stackable ~= nil and item.components.stackable:StackSize() or 1
    return inv:RemoveItem(item, true), size
end

local function giveNext(inst, cmd)
    local target = nil
    if cmd.guid ~= nil then target = Util.Ent(cmd.guid) end
    if target == nil then target = Util.FindPlayer(cmd.userid, inst) end
    if target == nil then
        Commands.Finish(inst, cmd, false, "nobody to give it to")
        return nil
    end
    local inv = inst.components.inventory
    local want = math.max(1, math.floor(cmd.count or 1))
    local has = countOf(inst, cmd.item)
    local worn = nil
    if has == 0 then
        for _, it in pairs(inv.equipslots) do
            if it.prefab == cmd.item then worn = it end
        end
        if worn == nil then
            Commands.Finish(inst, cmd, false, "no " .. cmd.item .. " in inventory")
            return nil
        end
    end
    local who = target.name or target.prefab
    local walk, arrived = walkTo(inst, cmd, target, GIVE_RANGE, who)
    if not arrived then return walk end
    local given, dropped = 0, 0
    local function hand(one, n)
        local tinv = target.components.inventory
        if tinv == nil then
            one.Transform:SetPosition(target.Transform:GetWorldPosition())
            dropped = dropped + n
            return
        end
        -- A full inventory drops the item at the receiver's feet by itself.
        tinv:GiveItem(one, nil, inst:GetPosition())
        if one:IsValid() and one.components.inventoryitem ~= nil and one.components.inventoryitem.owner == nil then
            dropped = dropped + n
        else
            given = given + n
        end
    end
    if worn ~= nil then
        local slotName = worn.components.equippable ~= nil and worn.components.equippable.equipslot or nil
        local item = slotName ~= nil and inv:Unequip(slotName) or nil
        if item ~= nil then hand(item, 1) end
    else
        local left = math.min(want, has)
        while left > 0 do
            local item = inv:FindItem(function(i) return i.prefab == cmd.item end)
            if item == nil then break end
            local one, n = takeOne(inv, item, left)
            if one == nil then break end
            hand(one, n)
            left = left - n
        end
    end
    local total = given + dropped
    if total == 0 then
        Commands.Finish(inst, cmd, false, "could not hand over " .. cmd.item)
        return nil
    end
    local text = "gave " .. total .. " " .. cmd.item .. " to " .. who
    if dropped > 0 then text = text .. " (" .. dropped .. " dropped at their feet: their inventory is full)" end
    if total < want then text = text .. "; only had " .. total end
    Commands.Finish(inst, cmd, true, text)
    return nil
end

--- The command slot's getactionfn (brains/seibrain.lua). Returns a
--- BufferedAction or nil (nil also when the command just finished).
function Commands.NextAction(inst)
    local cmd = inst.sei and inst.sei.cmd or nil
    if cmd == nil then return nil end
    if inst.sg ~= nil and inst.sg:HasStateTag("busy") and cmd.kind ~= "container" then return nil end
    if cmd.state.deadline ~= nil and cmd.kind ~= "gather" and cmd.kind ~= "container" and cmd.kind ~= "give" and GetTime() > cmd.state.deadline then
        Commands.Finish(inst, cmd, false, "timeout: " .. cmd.kind .. " took too long")
        return nil
    end
    local action = nil
    Util.Guard("commands." .. tostring(cmd.kind), function()
        if cmd.kind == "action" then action = actionFor(inst, cmd)
        elseif cmd.kind == "gather" then action = gatherNext(inst, cmd)
        elseif cmd.kind == "build" then action = buildNext(inst, cmd)
        elseif cmd.kind == "container" then action = containerNext(inst, cmd)
        elseif cmd.kind == "lightfire" then action = lightFireNext(inst, cmd)
        elseif cmd.kind == "give" then action = giveNext(inst, cmd)
        end
    end, function(msg)
        Net.ReportError(msg)
        Commands.Finish(inst, cmd, false, "error: " .. tostring(msg))
    end)
    return action
end

--- Is the slotted command one the DoAction slot runs (vs goto/attack/flee,
--- which the brain runs with dedicated nodes)?
function Commands.IsActionSlot(cmd)
    return cmd ~= nil and (cmd.kind == "action" or cmd.kind == "gather" or cmd.kind == "build" or cmd.kind == "container"
        or cmd.kind == "lightfire" or cmd.kind == "give")
end

-- ── dispatch ────────────────────────────────────────────────────────────────

local function slot(inst, cmd)
    cancelCurrent(inst, "replaced by " .. tostring(cmd.kind))
    cmd.state = {}
    cmd.startedAt = GetTime()
    cmd.state.deadline = GetTime() + (cmd.timeoutS or CMD_TIMEOUT_S)
    inst.sei.cmd = cmd
end

local function dispatch(inst, cmd)
    local kind = cmd.kind
    if kind == "say" then
        Speak.Say(inst, cmd.text, cmd.announce ~= false and inst.sei.announce)
        result(cmd.id, true, "said")
    elseif kind == "stop" then
        cancelCurrent(inst, "stopped")
        inst.sei.flee = nil
        if cmd.unfollow then inst.sei.follow = nil end
        result(cmd.id, true, "stopped")
    elseif kind == "despawn" then
        result(cmd.id, true, "despawning")
        require("sei/companion").Despawn("bot stop")
    elseif kind == "pause" then
        -- 260725 play/pause: hold the body like a player away from keyboard.
        local paused = cmd.paused and true or false
        if paused and not inst.sei.paused then cancelCurrent(inst, "paused") end
        inst.sei.paused = paused
        if paused and inst.components.combat ~= nil then pcall(function() inst.components.combat:SetTarget(nil) end) end
        result(cmd.id, true, paused and "paused" or "resumed")
    elseif kind == "fight" then
        inst.sei.fight = cmd.enabled and true or false
        result(cmd.id, true, inst.sei.fight and "will fight back when hit" or "will not fight back")
    elseif kind == "follow" then
        local target = cmd.guid ~= nil and Util.Ent(cmd.guid) or Util.FindPlayer(cmd.userid, inst)
        if target == nil then
            result(cmd.id, false, "nobody to follow")
        else
            inst.sei.follow = target
            inst.sei.followDist = cmd.dist or 4
            result(cmd.id, true, "following " .. (target.name or target.prefab))
        end
    elseif kind == "unfollow" then
        inst.sei.follow = nil
        result(cmd.id, true, "stopped following")
    elseif kind == "equip" then
        local item = invItem(inst, cmd.guid)
        if item == nil then
            result(cmd.id, false, "that item is not in the inventory")
        elseif not item:HasTag("_equippable") then
            result(cmd.id, false, item.prefab .. " cannot be equipped")
        else
            local ok = inst.components.inventory:Equip(item)
            -- The habits leave an item the LLM equipped where it is
            -- (Reflexes.CommandHeld) until it equips something else.
            if ok then Reflexes.Hold(inst, item) end
            result(cmd.id, ok and true or false, ok and ("equipped " .. item.prefab) or ("could not equip " .. item.prefab))
        end
    elseif kind == "drop" then
        local item = invItem(inst, cmd.guid)
        if item == nil then
            result(cmd.id, false, "that item is not in the inventory")
        else
            inst.components.inventory:DropItem(item, true, true)
            result(cmd.id, true, "dropped " .. item.prefab)
        end
    elseif kind == "goto" then
        -- A player may be walked to by userid as well as by guid (260909):
        -- the runtime only knows guids inside the 24-unit perception sweep,
        -- and "come here" is asked most often once the body has wandered
        -- OUT of it. userid "" means the nearest player, like follow.
        local target = nil
        if cmd.guid ~= nil then
            target = Util.Ent(cmd.guid)
        elseif cmd.userid ~= nil then
            target = Util.FindPlayer(cmd.userid, inst)
        end
        if cmd.guid ~= nil and target == nil then
            result(cmd.id, false, "that target is gone")
        elseif cmd.userid ~= nil and target == nil then
            result(cmd.id, false, "nobody to walk to")
        else
            slot(inst, cmd)
            cmd.timeoutS = cmd.timeoutS or 30
            cmd.state.deadline = GetTime() + cmd.timeoutS
            cmd.targetEnt = target
        end
    elseif kind == "attack" then
        local target = Util.Ent(cmd.guid)
        if target == nil or target.components.combat == nil then
            result(cmd.id, false, "nothing to attack there")
        elseif target:HasTag("player") and not cmd.pvp then
            result(cmd.id, false, "will not attack a player")
        else
            slot(inst, cmd)
            cmd.timeoutS = 25
            cmd.state.deadline = GetTime() + cmd.timeoutS
            inst.components.combat:SetTarget(target)
        end
    elseif kind == "flee" then
        cancelCurrent(inst, "fleeing")
        inst.sei.flee = GetTime() + (cmd.seconds or 6)
        result(cmd.id, true, "running from danger")
    elseif kind == "action" or kind == "gather" or kind == "build" or kind == "container" or kind == "lightfire" or kind == "give" then
        slot(inst, cmd)
    elseif kind == "resync" then
        require("sei/perception").RequestFull()
        result(cmd.id, true, "ok")
    else
        result(cmd.id, false, "unknown command " .. tostring(kind))
    end
end

--- Periodic supervision for the non-DoAction slots (goto arrival, attack
--- outcome, flee expiry). Called from the brain's tick.
function Commands.Tick(inst)
    local sei = inst.sei
    if sei == nil then return end
    if sei.flee ~= nil and GetTime() > sei.flee then sei.flee = nil end
    local cmd = sei.cmd
    if cmd == nil then return end
    if cmd.kind == "goto" then
        local tx, tz
        if cmd.targetEnt ~= nil then
            if not cmd.targetEnt:IsValid() then Commands.Finish(inst, cmd, false, "target is gone") return end
            local _
            tx, _, tz = cmd.targetEnt.Transform:GetWorldPosition()
        else
            tx, tz = cmd.x, cmd.z
        end
        local d = Util.DistXZ(inst, tx, tz)
        if d <= (cmd.range or 2.5) then
            inst.components.locomotor:Stop()
            Commands.Finish(inst, cmd, true, "arrived (" .. Util.Round1(d) .. " away)")
            return
        end
        if GetTime() > cmd.state.deadline then
            inst.components.locomotor:Stop()
            Commands.Finish(inst, cmd, false, "cant_reach: still " .. Util.Round1(d) .. " away after " .. (cmd.timeoutS or 30) .. "s")
            return
        end
        local x, _, z = inst.Transform:GetWorldPosition()
        if cmd.state.lastX ~= nil and math.abs(cmd.state.lastX - x) < 0.05 and math.abs(cmd.state.lastZ - z) < 0.05 then
            cmd.state.still = (cmd.state.still or 0) + 1
            if cmd.state.still > 8 then
                inst.components.locomotor:Stop()
                Commands.Finish(inst, cmd, false, "cant_reach: no path (" .. Util.Round1(d) .. " away, blocked by water or walls)")
                return
            end
        else
            cmd.state.still = 0
        end
        cmd.state.lastX, cmd.state.lastZ = x, z
    elseif cmd.kind == "attack" then
        local target = Util.Ent(cmd.guid)
        if target == nil or (target.components.health ~= nil and target.components.health:IsDead()) then
            inst.components.combat:SetTarget(nil)
            Commands.Finish(inst, cmd, true, "killed " .. (cmd.label or "the target"))
        elseif GetTime() > cmd.state.deadline then
            inst.components.combat:SetTarget(nil)
            local left = Util.Round1(target.components.health and target.components.health:GetPercent() * 100 or 0)
            Commands.Finish(inst, cmd, false, "gave up the fight against " .. (target.prefab or "the target") .. " (" .. left .. "% health left)")
        elseif inst.components.combat.target ~= target and not (inst.sg ~= nil and inst.sg:HasStateTag("attack")) then
            inst.components.combat:SetTarget(target)
        end
    end
end

-- ── poll loop ───────────────────────────────────────────────────────────────

local function schedule(delay)
    if state.stopped or state.inst == nil then return end
    if state.task ~= nil then state.task:Cancel() end
    state.task = state.inst:DoTaskInTime(delay, function()
        state.task = nil
        Commands.Poll()
    end)
end

function Commands.Poll()
    if state.stopped or state.polling or state.inst == nil or not state.inst:IsValid() then return end
    if not Net.IsConfigured() then schedule(POLL_RETRY_S) return end
    state.polling = true
    Net.Get("/cmd", { since = state.since }, function(resp, ok)
        state.polling = false
        if state.stopped then return end
        if not ok or resp == nil then
            schedule(POLL_RETRY_S)
            return
        end
        for _, cmd in ipairs(resp.cmds or {}) do
            if type(cmd) == "table" then
                if cmd.seq ~= nil and cmd.seq > state.since then state.since = cmd.seq end
                Util.Guard("commands.dispatch", function() dispatch(state.inst, cmd) end, function(msg)
                    Net.ReportError(msg)
                    result(cmd.id, false, "error: " .. tostring(msg))
                end)
            end
        end
        schedule(0)
    end)
end

function Commands.Start(inst)
    Commands.Stop()
    state.inst = inst
    state.since = 0
    state.polling = false
    state.stopped = false
    schedule(0.1)
end

function Commands.Stop()
    state.stopped = true
    if state.task ~= nil then
        state.task:Cancel()
        state.task = nil
    end
    state.inst = nil
    state.polling = false
end

return Commands
