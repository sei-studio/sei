-- scripts/sei/chores.lua: the helper 0.4.0 camp chores, slotted commands the
-- brain's command slot runs through Commands.NextAction like gather and give.
--
--   harvest   take what is ready: a crock pot, a crop, a bee box, a drying rack
--   plant     deploy an item you carry (pine cone, dug grass, sapling, fence)
--   trap      set a trap you carry, or collect a sprung one
--   dry       hang meat on a drying rack, taking finished jerky off first
--   cookpot   fill a crock pot with 4 ingredients, cook, and take the meal
--   stash     pick up loose loot nearby and put it into the chests that
--             already hold the same thing (the W.O.B.O.T. rule: like with like)
--
-- Every one of these is something the model asked for; nothing here starts on
-- its own. Each ends with a result string the model reads.

local Util = require("sei/util")

local Chores = {}

-- Commands' helpers (Finish, walkTo, nearestWith, countOf, unreachable,
-- takeOne), handed over by Chores.Init to avoid a require cycle.
local H = nil

local KINDS = { harvest = true, plant = true, trap = true, dry = true, cookpot = true, stash = true }

local CHEST_RADIUS = 24
local POT_RANGE = 2
local BOX_RANGE = 2.5
-- Rings (in units) searched for a spot an item can be deployed on.
local PLANT_RINGS = { 0, 1.5, 2.5, 3.5, 5, 6.5 }
local STASH_PICKUP_RADIUS = 8
local STASH_MAX_PICKUPS = 16
-- How long stash walks toward one chest before it gives that one up.
local STASH_WALK_S = 20

function Chores.Init(helpers) H = helpers end

function Chores.Handles(kind) return KINDS[kind] == true end

-- ── inventory bookkeeping ───────────────────────────────────────────────────

local function stackOf(item)
    return item.components.stackable ~= nil and item.components.stackable:StackSize() or 1
end

--- prefab -> count of everything the body carries (bag, hands, backpack).
function Chores.InvCounts(inst)
    local t = {}
    local inv = inst.components.inventory
    if inv == nil then return t end
    inv:ForEachItem(function(it)
        if it ~= nil and it.prefab ~= nil then t[it.prefab] = (t[it.prefab] or 0) + stackOf(it) end
    end)
    return t
end

--- {"2 meat", "1 trap"}: what went up between two InvCounts.
function Chores.Gains(before, after)
    local parts = {}
    for p, n in pairs(after) do
        local d = n - (before[p] or 0)
        if d > 0 then parts[#parts + 1] = d .. " " .. p end
    end
    table.sort(parts)
    return parts
end

local function bagItem(inst, pred)
    local inv = inst.components.inventory
    if inv == nil then return nil end
    return inv:FindItem(pred)
end

--- Move up to `n` of `prefab` from the body into a container, one at a time
--- (a full container hands the last one back). Returns how many moved.
local function moveInto(inst, cont, prefab, n)
    local inv = inst.components.inventory
    local moved = 0
    while moved < n do
        local item = inv:FindItem(function(i) return i.prefab == prefab end)
        if item == nil then break end
        local one = item.components.stackable ~= nil and item.components.stackable:StackSize() > 1
            and item.components.stackable:Get(1) or inv:RemoveItem(item)
        if one == nil then break end
        if not cont:GiveItem(one) then
            inv:GiveItem(one)
            break
        end
        moved = moved + 1
    end
    return moved
end

local function joinCounts(t)
    local parts = {}
    for p, n in pairs(t) do parts[#parts + 1] = n .. " " .. p end
    table.sort(parts)
    return table.concat(parts, ", ")
end

-- ── harvest ─────────────────────────────────────────────────────────────────

local function readyText(target)
    local stew = target.components.stewer
    if stew ~= nil and stew:IsCooking() then
        return "the " .. target.prefab .. " is still cooking (" .. math.ceil(stew:GetTimeToCook()) .. "s left)"
    end
    return "nothing to harvest on the " .. target.prefab .. " yet"
end

local function canHarvest(target)
    local c = target.components
    return (c.stewer ~= nil and c.stewer:IsDone())
        or (c.crop ~= nil and c.crop:IsReadyForHarvest())
        or (c.harvestable ~= nil and c.harvestable:CanBeHarvested())
        or (c.dryer ~= nil and c.dryer:IsDone())
end

local function harvestNext(inst, cmd)
    local st = cmd.state
    local target = Util.Ent(cmd.target)
    if target == nil then
        H.Finish(inst, cmd, false, "that is gone")
        return nil
    end
    -- A drying rack (meatrack2) keeps finished food in its slots.
    if target.components.dryingrack ~= nil and target.components.container ~= nil then
        cmd.kind, cmd.rack, cmd.items = "dry", cmd.target, {}
        return Chores.Next(inst, cmd)
    end
    if not canHarvest(target) then
        H.Finish(inst, cmd, false, readyText(target))
        return nil
    end
    if st.before == nil then st.before = Chores.InvCounts(inst) end
    local b = BufferedAction(inst, target, ACTIONS.HARVEST)
    if not b:IsValid() then
        H.Finish(inst, cmd, false, "can't harvest the " .. target.prefab .. " right now")
        return nil
    end
    b:AddSuccessAction(function()
        local got = Chores.Gains(st.before, Chores.InvCounts(inst))
        H.Finish(inst, cmd, true, "harvested the " .. target.prefab .. (#got > 0 and ("; got " .. table.concat(got, ", ")) or ""))
    end)
    b:AddFailAction(function() H.Finish(inst, cmd, false, "could not harvest the " .. target.prefab) end)
    return b
end

-- ── plant / deploy ──────────────────────────────────────────────────────────

local function deployPoint(inst, item, cx, cz)
    local dep = item.components.deployable
    for _, r in ipairs(PLANT_RINGS) do
        local steps = r == 0 and 1 or math.max(6, math.floor(r * 4))
        for i = 0, steps - 1 do
            local a = i * 2 * math.pi / steps
            local pt = Vector3(cx + r * math.cos(a), 0, cz + r * math.sin(a))
            local ok, can = pcall(function() return dep:CanDeploy(pt, nil, inst, 0) end)
            if ok and can then return pt end
        end
    end
    return nil
end

local function plantNext(inst, cmd)
    local st = cmd.state
    st.planted = st.planted or 0
    local want = math.max(1, math.floor(cmd.count or 1))
    local done = function(extra)
        H.Finish(inst, cmd, st.planted > 0, (st.planted > 0 and ("planted " .. st.planted .. " " .. cmd.item) or ("planted nothing")) .. (extra or ""))
    end
    if st.planted >= want then done() return nil end
    local item = bagItem(inst, function(i) return i.prefab == cmd.item end)
    if item == nil then
        if st.planted > 0 then done("; none left") else H.Finish(inst, cmd, false, "no " .. cmd.item .. " in inventory") end
        return nil
    end
    if item.components.deployable == nil then
        H.Finish(inst, cmd, false, cmd.item .. " is not something you can plant or place")
        return nil
    end
    if st.cx == nil then
        local x, _, z = inst.Transform:GetWorldPosition()
        st.cx = cmd.pos ~= nil and cmd.pos.x or x
        st.cz = cmd.pos ~= nil and cmd.pos.z or z
    end
    local pt = deployPoint(inst, item, st.cx, st.cz)
    if pt == nil then
        done(st.planted > 0 and "; no free spot for more here" or ": no free spot here, try open ground")
        return nil
    end
    local b = BufferedAction(inst, nil, ACTIONS.DEPLOY, item, pt)
    b:AddSuccessAction(function()
        st.planted = st.planted + 1
        if st.planted >= want then done() end
    end)
    b:AddFailAction(function()
        st.fails = (st.fails or 0) + 1
        if st.fails >= 3 then done("; the ground there would not take it") end
    end)
    return b
end

-- ── traps ───────────────────────────────────────────────────────────────────

local function trapNext(inst, cmd)
    local st = cmd.state
    if cmd.op == "collect" then
        local trap = cmd.target ~= nil and Util.Ent(cmd.target)
            or H.nearestWith(inst, CHEST_RADIUS, function(v) return v:HasTag("trapsprung") end)
        if trap == nil then
            H.Finish(inst, cmd, false, cmd.target ~= nil and "that trap is gone" or "no sprung trap nearby")
            return nil
        end
        if not trap:HasTag("trapsprung") then
            H.Finish(inst, cmd, false, "the " .. trap.prefab .. " has not caught anything yet")
            return nil
        end
        if st.before == nil then st.before = Chores.InvCounts(inst) end
        local b = BufferedAction(inst, trap, ACTIONS.CHECKTRAP)
        b:AddSuccessAction(function()
            local got = Chores.Gains(st.before, Chores.InvCounts(inst))
            H.Finish(inst, cmd, true, "collected the " .. trap.prefab .. (#got > 0 and ("; got " .. table.concat(got, ", ")) or ""))
        end)
        b:AddFailAction(function() H.Finish(inst, cmd, false, "could not collect the " .. trap.prefab) end)
        return b
    end
    -- Set: a trap is armed by putting it down (components/trap.lua OnDropped).
    local item = bagItem(inst, function(i)
        return i.components.trap ~= nil and (cmd.item == nil or i.prefab == cmd.item)
    end)
    if item == nil then
        H.Finish(inst, cmd, false, "no " .. (cmd.item or "trap") .. " in inventory to set; craft(trap) makes one")
        return nil
    end
    local x, _, z = inst.Transform:GetWorldPosition()
    local pt = cmd.pos ~= nil and Vector3(cmd.pos.x, 0, cmd.pos.z) or Vector3(x, 0, z)
    local prefab = item.prefab
    local b = BufferedAction(inst, nil, ACTIONS.DROP, item, pt)
    b:AddSuccessAction(function()
        H.Finish(inst, cmd, true, "set a " .. prefab .. " at (" .. Util.Round1(pt.x) .. ", " .. Util.Round1(pt.z) .. ")")
    end)
    b:AddFailAction(function() H.Finish(inst, cmd, false, "could not set the " .. prefab .. " there") end)
    return b
end

-- ── drying rack ─────────────────────────────────────────────────────────────

local function dryNext(inst, cmd)
    local rack = Util.Ent(cmd.rack)
    if rack == nil or rack.components.container == nil or rack.components.dryingrack == nil then
        H.Finish(inst, cmd, false, "that is not a drying rack")
        return nil
    end
    local walk, arrived = H.walkTo(inst, cmd, rack, BOX_RANGE, "the drying rack")
    if not arrived then return walk end
    local inv, cont = inst.components.inventory, rack.components.container
    -- Finished food first: whatever no longer dries (jerky, dried kelp, and
    -- anything that spoiled on the rack).
    local took = {}
    for _, item in ipairs(cont:GetAllItems()) do
        if not item:HasTag("dryable") then
            local p, n = item.prefab, stackOf(item)
            local one = cont:RemoveItem(item, true)
            if one ~= nil then
                inv:GiveItem(one)
                took[p] = (took[p] or 0) + n
            end
        end
    end
    local wanted = nil
    if type(cmd.items) == "table" and #cmd.items > 0 then
        wanted = {}
        for _, p in ipairs(cmd.items) do wanted[p] = true end
    end
    local hung = {}
    local collectOnly = type(cmd.items) == "table" and #cmd.items == 0
    while not collectOnly and not cont:IsFull() do
        local item = bagItem(inst, function(i) return i:HasTag("dryable") and (wanted == nil or wanted[i.prefab]) end)
        if item == nil then break end
        local n = moveInto(inst, cont, item.prefab, 1)
        if n == 0 then break end
        hung[item.prefab] = (hung[item.prefab] or 0) + n
    end
    local parts = {}
    if next(took) ~= nil then parts[#parts + 1] = "took " .. joinCounts(took) .. " off the rack" end
    if next(hung) ~= nil then parts[#parts + 1] = "hung " .. joinCounts(hung) .. " to dry" end
    if #parts == 0 then
        local why = collectOnly and "nothing on the rack is dry yet"
            or cont:IsFull() and "the rack is full and nothing on it is dry yet"
            or ("nothing to dry: no " .. (wanted ~= nil and table.concat(cmd.items, " or ") or "meat, morsels or fish") .. " in inventory")
        H.Finish(inst, cmd, false, why)
    else
        H.Finish(inst, cmd, true, table.concat(parts, "; "))
    end
    return nil
end

-- ── crock pot ───────────────────────────────────────────────────────────────

local function cooking() return require("cooking") end

--- The dishes `names` can make in this pot (the game picks among equal
--- matches at random, so ask a few times).
local function dishes(pot, names)
    local seen, list = {}, {}
    for _ = 1, 6 do
        local ok, product = pcall(function() return cooking().CalculateRecipe(pot.prefab, names) end)
        if ok and product ~= nil and not seen[product] then
            seen[product] = true
            list[#list + 1] = product
        end
    end
    table.sort(list)
    return list
end

local function potContents(cont)
    local t = {}
    for _, item in ipairs(cont:GetAllItems()) do t[item.prefab] = (t[item.prefab] or 0) + stackOf(item) end
    return t
end

local function cookpotNext(inst, cmd)
    local st = cmd.state
    local pot = Util.Ent(cmd.pot)
    if pot == nil or pot.components.stewer == nil or pot.components.container == nil then
        H.Finish(inst, cmd, false, "no crock pot there")
        return nil
    end
    local stew, cont = pot.components.stewer, pot.components.container
    local names = type(cmd.items) == "table" and cmd.items or {}

    if st.phase == nil then
        if stew:IsCooking() then
            H.Finish(inst, cmd, false, "the " .. pot.prefab .. " is already cooking (" .. math.ceil(stew:GetTimeToCook()) .. "s left)")
            return nil
        end
        if #names == 0 and not cont:IsFull() then
            H.Finish(inst, cmd, false, "a crock pot needs exactly 4 ingredients")
            return nil
        end
        if #names > 0 then
            if #names ~= 4 then
                H.Finish(inst, cmd, false, "a crock pot needs exactly 4 ingredients, not " .. #names)
                return nil
            end
            local need = {}
            for _, p in ipairs(names) do
                if not cooking().IsCookingIngredient(p) then
                    H.Finish(inst, cmd, false, p .. " cannot go in a crock pot")
                    return nil
                end
                need[p] = (need[p] or 0) + 1
            end
            for p, n in pairs(need) do
                local have = H.countOf(inst, p)
                if have < n then
                    H.Finish(inst, cmd, false, "you need " .. n .. " " .. p .. " and have " .. have)
                    return nil
                end
            end
            local list = dishes(pot, names)
            if cmd.preview then
                H.Finish(inst, cmd, true, "those 4 would make " .. (#list > 0 and table.concat(list, " or ") or "nothing"))
                return nil
            end
            if #list == 1 and list[1] == "wetgoop" then
                H.Finish(inst, cmd, false, "those 4 make wet goop: no recipe matches them")
                return nil
            end
        end
        st.phase = "walk"
    end

    if st.phase == "walk" then
        local walk, arrived = H.walkTo(inst, cmd, pot, POT_RANGE, "the " .. pot.prefab)
        if not arrived then return walk end
        if stew:IsDone() then
            -- Someone's finished meal is still inside: take it first.
            if st.before == nil then st.before = Chores.InvCounts(inst) end
            local b = BufferedAction(inst, pot, ACTIONS.HARVEST)
            b:AddSuccessAction(function() st.tookFirst = Chores.Gains(st.before, Chores.InvCounts(inst)) end)
            b:AddFailAction(function() H.Finish(inst, cmd, false, "could not empty the " .. pot.prefab .. " first") end)
            return b
        end
        if #names > 0 then
            if not cont:IsEmpty() then
                H.Finish(inst, cmd, false, "the " .. pot.prefab .. " already holds " .. joinCounts(potContents(cont)) .. "; cook those (no ingredients) or take them out first")
                return nil
            end
            for _, p in ipairs(names) do
                if moveInto(inst, cont, p, 1) ~= 1 then
                    -- Put back what went in so nothing is stranded in the pot.
                    for _, item in ipairs(cont:GetAllItems()) do
                        local one = cont:RemoveItem(item, true)
                        if one ~= nil then inst.components.inventory:GiveItem(one) end
                    end
                    H.Finish(inst, cmd, false, "could not put " .. p .. " into the " .. pot.prefab)
                    return nil
                end
            end
        end
        if not stew:CanCook() then
            H.Finish(inst, cmd, false, "the " .. pot.prefab .. " needs 4 ingredients to cook")
            return nil
        end
        pcall(function() cont:Close() end)
        stew:StartCooking(inst)
        if not stew:IsCooking() and not stew:IsDone() then
            H.Finish(inst, cmd, false, "the " .. pot.prefab .. " would not start cooking")
            return nil
        end
        st.phase = "cook"
        st.before = Chores.InvCounts(inst)
        return nil
    end

    if st.phase == "cook" then
        if stew:IsCooking() then return nil end
        if not stew:IsDone() then
            H.Finish(inst, cmd, false, "the " .. pot.prefab .. " was emptied before the meal was done")
            return nil
        end
        local walk, arrived = H.walkTo(inst, cmd, pot, POT_RANGE, "the " .. pot.prefab)
        if not arrived then return walk end
        local product = stew.product
        local b = BufferedAction(inst, pot, ACTIONS.HARVEST)
        b:AddSuccessAction(function()
            local got = Chores.Gains(st.before, Chores.InvCounts(inst))
            local first = st.tookFirst ~= nil and #st.tookFirst > 0 and (" (took out " .. table.concat(st.tookFirst, ", ") .. " that was in it first)") or ""
            H.Finish(inst, cmd, true, "cooked " .. tostring(product) .. " and took it" .. (#got > 0 and (": got " .. table.concat(got, ", ")) or "") .. first)
        end)
        b:AddFailAction(function() H.Finish(inst, cmd, false, tostring(product) .. " is done but you could not take it out of the " .. pot.prefab) end)
        return b
    end
    return nil
end

-- ── stash ───────────────────────────────────────────────────────────────────

local function isChest(v)
    return v.components.container ~= nil and v.components.inventoryitem == nil
        and v.components.dryingrack == nil and v.components.stewer == nil
        and (v:HasTag("chest") or v:HasTag("fridge"))
end

local function chestFor(inst, prefab)
    return H.nearestWith(inst, CHEST_RADIUS, function(v)
        if not isChest(v) or H.unreachable(inst, v) then return false end
        local cont = v.components.container
        local has = cont:FindItem(function(i) return i.prefab == prefab end)
        if has == nil then return false end
        if not cont:IsFull() then return true end
        return cont:FindItem(function(i)
            return i.prefab == prefab and i.components.stackable ~= nil and not i.components.stackable:IsFull()
        end) ~= nil
    end)
end

--- Things the body keeps on itself: what it wears or holds, tools, weapons,
--- armor and light; and its food unless the model names it.
--- Rocks, flint, twigs, logs and gems carry an edible component too (for the
--- characters that eat them), so food here is what people eat.
local PEOPLE_FOOD = { MEAT = true, VEGGIE = true, GENERIC = true, GOODIES = true, SEEDS = true }
local function isFood(item)
    local e = item.components.edible
    if e == nil then return false end
    for name in pairs(PEOPLE_FOOD) do
        if FOODTYPE[name] ~= nil and e.foodtype == FOODTYPE[name] then return true end
    end
    return false
end

local function keeps(item, named)
    if named then return false end
    return item.components.equippable ~= nil or item.components.tool ~= nil or item.components.weapon ~= nil
        or isFood(item) or item:HasTag("trap")
end

local function stashNext(inst, cmd)
    local st = cmd.state
    st.picked = st.picked or 0
    st.stored = st.stored or {}
    st.skip = st.skip or {}
    if st.cx == nil then
        local x, _, z = inst.Transform:GetWorldPosition()
        st.cx, st.cz = x, z
        st.phase = cmd.pickup ~= false and "pickup" or "store"
    end
    local inv = inst.components.inventory

    if st.phase == "pickup" then
        if st.picked < STASH_MAX_PICKUPS and not inv:IsFull() then
            local loot = nil
            local ents = TheSim:FindEntities(st.cx, 0, st.cz, STASH_PICKUP_RADIUS, { "_inventoryitem" }, { "INLIMBO", "NOCLICK", "FX", "heavy", "trap", "irreplaceable" })
            local bestd = math.huge
            for _, v in ipairs(ents) do
                local ii = v.components.inventoryitem
                if ii ~= nil and ii.canbepickedup and ii:GetGrandOwner() == nil and not H.unreachable(inst, v)
                    and (cmd.item == nil or v.prefab == cmd.item) then
                    local d = Util.DistXZ(inst, v)
                    if d < bestd then loot, bestd = v, d end
                end
            end
            if loot ~= nil then
                local b = BufferedAction(inst, loot, ACTIONS.PICKUP)
                b:AddSuccessAction(function() st.picked = st.picked + 1 end)
                return b
            end
        end
        st.phase = "store"
    end

    -- store: one (prefab, chest) pair at a time.
    if st.current == nil then
        local seen = {}
        for _, item in ipairs(inv:FindItems(function() return true end)) do
            local p = item.prefab
            local equipped = item.components.equippable ~= nil and item.components.equippable:IsEquipped()
            if not seen[p] and not st.skip[p] and not equipped and (cmd.item == nil or p == cmd.item)
                and not keeps(item, cmd.item ~= nil) then
                seen[p] = true
                local chest = chestFor(inst, p)
                if chest ~= nil then
                    st.current = { prefab = p, chest = chest }
                    break
                end
                st.skip[p] = "nochest"
            end
        end
    end
    if st.current == nil then
        local parts = {}
        if st.picked > 0 then parts[#parts + 1] = "picked up " .. st.picked .. " things" end
        if next(st.stored) ~= nil then parts[#parts + 1] = "stored " .. joinCounts(st.stored) end
        local kept = {}
        for p, why in pairs(st.skip) do if why == "nochest" then kept[#kept + 1] = p end end
        table.sort(kept)
        if #kept > 0 then parts[#parts + 1] = "kept " .. table.concat(kept, ", ") .. " (no chest nearby holds that yet)" end
        local ok = st.picked > 0 or next(st.stored) ~= nil
        if #parts == 0 then
            parts[1] = cmd.item ~= nil and ("no " .. cmd.item .. " to stash, or no chest nearby already holds it")
                or "nothing to stash: no loot nearby and nothing you carry matches a chest"
        end
        H.Finish(inst, cmd, ok, table.concat(parts, "; "))
        return nil
    end
    local cur = st.current
    -- A chest the walk supervisor found blocked (Commands.Tick marks it
    -- unreachable for stash, as for gather) or one that is gone: next pair.
    if not cur.chest:IsValid() or H.unreachable(inst, cur.chest) then
        st.skip[cur.prefab] = "unreachable"
        st.current = nil
        return nil
    end
    if Util.DistXZ(inst, cur.chest) > BOX_RANGE then
        cur.until_ = cur.until_ or (GetTime() + STASH_WALK_S)
        if GetTime() > cur.until_ then
            st.skip[cur.prefab] = "unreachable"
            st.current = nil
            return nil
        end
        return BufferedAction(inst, cur.chest, ACTIONS.WALKTO)
    end
    local n = moveInto(inst, cur.chest.components.container, cur.prefab, 999)
    if n > 0 then st.stored[cur.prefab] = (st.stored[cur.prefab] or 0) + n end
    -- Whatever did not fit stays with her; do not try that prefab again.
    st.skip[cur.prefab] = H.countOf(inst, cur.prefab) > 0 and "full" or "done"
    st.current = nil
    return nil
end

-- ── router ──────────────────────────────────────────────────────────────────

function Chores.Next(inst, cmd)
    local k = cmd.kind
    if k == "harvest" then return harvestNext(inst, cmd)
    elseif k == "plant" then return plantNext(inst, cmd)
    elseif k == "trap" then return trapNext(inst, cmd)
    elseif k == "dry" then return dryNext(inst, cmd)
    elseif k == "cookpot" then return cookpotNext(inst, cmd)
    elseif k == "stash" then return stashNext(inst, cmd)
    end
    return nil
end

return Chores
