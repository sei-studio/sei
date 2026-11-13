-- Composite verbs: one call from the brain does a whole job here (walk into reach, act, repeat), under normal
-- player rules: real reach, a real inventory, hand-crafting time. The mining job and the craft job follow
-- factorio-serf scripts/jobs.lua (MIT); the recursive craft check and the harvest queue follow FLE's craft_item /
-- harvest_resource (MIT). See THIRD_PARTY_NOTICES.md.
--
-- A job is { id, verb, args, deadline }. A handler is { start = fn(c, job) -> result?, tick = fn(c, job) -> result?,
-- finish = fn(c, job)? }. A result is { ok, msg, data? }; when a job ends its result goes into her feed as a
-- `result` event carrying the request id, and the app hands the msg to the brain as the tool result.
local util = require("scripts.util")
local body = require("scripts.body")
local movement = require("scripts.movement")

local verbs = {}
local H = {}

local DEFAULT_SECONDS = 300
local SECONDS = { gather = 600, tend = 420, build_ghosts = 900, craft = 600 }

local function ok(msg, data) return { ok = true, msg = msg, data = data } end
local function fail(msg, data) return { ok = false, msg = msg, data = data } end
local function at(p) local t = util.xy(p) return "(" .. math.floor(t[1] + 0.5) .. "," .. math.floor(t[2] + 0.5) .. ")" end

-- Walk until within `reach` of target. nil while walking, true on arrival, or a failure result.
local function approach(c, job, target, reach)
  local ch = c.char
  if util.dist(ch.position, target) <= reach then
    if job.move then movement.stop(ch) job.move = nil end
    return true
  end
  job.move = job.move or { goal = util.pos(target), radius = math.max(reach - 0.8, 0.5) }
  local r = movement.tick(ch, job.move)
  if r == nil then return nil end
  job.move = nil
  if r == "arrived" then
    if util.dist(ch.position, target) <= reach + 0.5 then return true end
    return fail("could not get close enough to " .. at(target))
  end
  return fail("could not walk to " .. at(target) .. ": " .. r)
end

-- Handles are unit numbers. game.get_entity_by_unit_number only finds prototypes with the get-by-unit-number flag,
-- so every entity we name to the app is remembered here, with a scan around her as the fallback.
function verbs.remember(e)
  if not (e and e.valid and e.unit_number) then return nil end
  storage.handles = storage.handles or {}
  storage.handles[e.unit_number] = e
  return e.unit_number
end

function verbs.by_handle(ch, h)
  local e = storage.handles and storage.handles[h]
  if e and e.valid then return e end
  local okG, g = pcall(game.get_entity_by_unit_number, h)
  if okG and g and g.valid then return g end
  for _, x in pairs(ch.surface.find_entities_filtered { position = ch.position, radius = 64 }) do
    if x.unit_number == h then
      verbs.remember(x)
      return x
    end
  end
end

function verbs.gc()
  local n = 0
  for h, e in pairs(storage.handles or {}) do
    if not e.valid then storage.handles[h] = nil else n = n + 1 end
  end
  if n > 2000 then storage.handles = {} end
end

-- An entity named by the brain: a unit number handle, or x,y (the building whose footprint holds the point).
local function resolve(c, args, opts)
  opts = opts or {}
  local ch = c.char
  local h = tonumber((tostring(args.target or ""):gsub("^#", "")))
  if h then
    local e = verbs.by_handle(ch, h)
    if e and e.valid and e.surface == ch.surface then return e end
    return nil, "nothing with handle #" .. h .. " near me"
  end
  local p = util.pos({ args.x, args.y })
  if not p then return nil, "give a #handle or x and y" end
  local cands = ch.surface.find_entities_filtered { position = p, radius = opts.radius or 1.5 }
  local best, bd
  for _, e in pairs(cands) do
    local t = e.type
    local skip = t == "character" or t == "character-corpse" or t == "item-entity" or t == "entity-ghost"
        or (not opts.natural and (t == "resource" or t == "tree" or t == "simple-entity"))
    if not skip then
      local bb = e.bounding_box
      local inside = p.x >= bb.left_top.x - 0.25 and p.x <= bb.right_bottom.x + 0.25
          and p.y >= bb.left_top.y - 0.25 and p.y <= bb.right_bottom.y + 0.25
      local d = util.dist(e.position, p) - (inside and 100 or 0)
      if not bd or d < bd then best, bd = e, d end
    end
  end
  if not best then return nil, "nothing there at " .. at(p) end
  verbs.remember(best)
  return best
end
verbs.resolve = resolve

local function item_proto(name)
  return name and prototypes.item[name] or nil
end

local function have(ch, name) return ch.get_item_count(name) end

-- ---------------------------------------------------------------- goto / come
H["goto"] = {
  start = function(c, job)
    local p = util.pos({ job.args.x, job.args.y })
    if not p then return fail("goto needs x and y") end
    job.goal = p
  end,
  tick = function(c, job)
    local r = approach(c, job, job.goal, 1.5)
    if r == nil then return nil end
    if r == true then return ok("arrived at " .. at(c.char.position)) end
    return r
  end,
}

H.come = {
  tick = function(c, job)
    local owner = body.owner_entity(c)
    if not owner then return fail("I cannot see the player") end
    if owner.surface ~= c.char.surface then return fail("the player is on " .. owner.surface.name .. ", I am not") end
    local r = approach(c, job, owner.position, 3)
    if r == nil then
      -- the owner keeps moving: aim at where they are now
      if job.move and util.dist(job.move.goal, owner.position) > 4 then job.move = nil end
      return nil
    end
    if r == true then return ok("next to " .. (body.owner_name(c) or "the player")) end
    return r
  end,
}

-- ---------------------------------------------------------------- gather
-- resource: an ore or item name (iron-ore, copper-ore, coal, stone, wood, ...). count: items wanted.
local function find_target(c, job)
  local ch = c.char
  local filters = {}
  local item = job.args.resource
  if prototypes.entity[item] and prototypes.entity[item].type == "resource" then
    filters[#filters + 1] = { name = item }
  end
  local natural = util.mined_for(item)
  if #natural > 0 then filters[#filters + 1] = { name = natural } end
  for _, r in ipairs { 12, 32, 64, 128 } do
    local best, bd
    for _, f in ipairs(filters) do
      f.position, f.radius = ch.position, r
      for _, e in pairs(ch.surface.find_entities_filtered(f)) do
        if e.valid and e.minable and not job.skip[e.unit_number or 0] then
          local d = util.dist(e.position, ch.position)
          if not bd or d < bd then best, bd = e, d end
        end
      end
    end
    if best then return best end
  end
end

H.gather = {
  start = function(c, job)
    local item = job.args.resource
    if not item_proto(item) then return fail("there is no item called " .. tostring(item)) end
    job.want = math.max(1, math.min(tonumber(job.args.count) or 20, 500))
    job.base = have(c.char, item)
    job.skip = {}
  end,
  tick = function(c, job)
    local ch, item = c.char, job.args.resource
    local got = have(ch, item) - job.base
    job.progress = math.max(0, got) .. "/" .. job.want .. " " .. item
    if got >= job.want then
      ch.mining_state = { mining = false }
      return ok("gathered " .. got .. " " .. item, { got = got })
    end
    local e = job.target
    if not (e and e.valid) then
      e = find_target(c, job)
      job.target, job.move, job.no_progress, job.last_progress = e, nil, 0, nil
      if not e then
        ch.mining_state = { mining = false }
        if got > 0 then return ok("gathered " .. got .. " " .. item .. ", and there is no more nearby", { got = got }) end
        return fail("no " .. item .. " to mine within 128 tiles")
      end
    end
    local reach = ch.resource_reach_distance
    local near = (e.type ~= "resource" and ch.can_reach_entity(e)) or approach(c, job, e.position, reach - 0.5)
    if near == nil then return nil end
    if type(near) == "table" then
      if e.unit_number then job.skip[e.unit_number] = true end
      job.target = nil
      job.walk_fails = (job.walk_fails or 0) + 1
      if job.walk_fails >= 4 then return fail("could not reach any " .. item .. " (" .. near.msg .. ")", { got = got }) end
      return nil
    end
    if not ch.can_insert { name = item, count = 1 } then
      ch.mining_state = { mining = false }
      return fail("my inventory is full after " .. math.max(0, got) .. " " .. item, { got = got })
    end
    ch.update_selected_entity(e.position)
    if ch.selected ~= e then ch.selected = e end
    ch.mining_state = { mining = true, position = e.position }
    local prog = ch.character_mining_progress
    if prog == job.last_progress then
      job.no_progress = job.no_progress + 1
      if job.no_progress > 240 then
        ch.mining_state = { mining = false }
        if e.unit_number then job.skip[e.unit_number] = true end
        job.target = nil
        job.stalls = (job.stalls or 0) + 1
        if job.stalls >= 3 then return fail("mining " .. item .. " is not progressing (it may need a mining drill)", { got = got }) end
      end
    else
      job.no_progress = 0
    end
    job.last_progress = prog
    return nil
  end,
  finish = function(c) if body.alive(c) then c.char.mining_state = { mining = false } end end,
}

-- ---------------------------------------------------------------- craft
local function recipe_for(force, item)
  local r = force.recipes[item]
  if r then return r end
  for _, rec in pairs(force.recipes) do
    local p = rec.products[1]
    if p and p.name == item and rec.enabled then return rec end
  end
end

local function missing_for(ch, recipe, runs)
  local out = {}
  for _, ing in pairs(recipe.ingredients) do
    if ing.type == "item" then
      local need = ing.amount * runs - have(ch, ing.name)
      if need > 0 then out[#out + 1] = need .. " " .. ing.name end
    end
  end
  return out
end

H.craft = {
  start = function(c, job)
    local ch = c.char
    local item = job.args.item
    local recipe = recipe_for(ch.force, item or "")
    if not recipe then return fail("there is no recipe for " .. tostring(item)) end
    if not recipe.enabled then return fail(recipe.name .. " is not researched yet") end
    local first = recipe.products[1]
    local per = first.amount or first.amount_min or 1
    local want = math.max(1, math.min(tonumber(job.args.count) or per, 200))
    local runs = math.max(1, math.ceil(want / per))
    local craftable = ch.get_craftable_count(recipe)
    if craftable == 0 then
      local miss = missing_for(ch, recipe, runs)
      if recipe.has_category and not (recipe.has_category("crafting") or recipe.has_category("pressing")) and #miss == 0 then
        return fail(first.name .. " cannot be made by hand (it needs a machine)")
      end
      return fail("cannot craft " .. first.name .. ": missing " .. (#miss > 0 and table.concat(miss, ", ") or "ingredients"))
    end
    local n = math.min(runs, craftable)
    local started = ch.begin_crafting { count = n, recipe = recipe, silent = true }
    if started == 0 then return fail(first.name .. " cannot be made by hand (it needs a machine)") end
    job.item = first.name
    job.goal = have(ch, first.name) + started * per
    job.made = started * per
    job.short = n < runs and (" (only " .. started * per .. " of " .. want .. ": " .. table.concat(missing_for(ch, recipe, runs), ", ") .. " short)") or ""
  end,
  tick = function(c, job)
    local ch = c.char
    local now = have(ch, job.item)
    job.progress = math.max(0, job.made - (job.goal - now)) .. "/" .. job.made .. " " .. job.item
    if ch.crafting_queue_size == 0 or now >= job.goal then
      return ok("crafted " .. job.made .. " " .. job.item .. job.short, { have = now })
    end
    local key = ch.crafting_queue_size .. ":" .. string.format("%.4f", ch.crafting_queue_progress or 0)
    if job.craft_key ~= key then job.craft_key, job.craft_since = key, game.tick
    elseif game.tick - job.craft_since > 300 then
      if ch.get_main_inventory().count_empty_stacks() == 0 then
        return fail("my inventory is full, so crafting " .. job.item .. " is stuck")
      end
      return fail("crafting " .. job.item .. " stopped")
    end
    return nil
  end,
}

-- ---------------------------------------------------------------- give / take / deposit
local function move_items(from_inv_owner, to, name, count)
  local moved = to.insert { name = name, count = count }
  if moved > 0 then from_inv_owner.remove_item { name = name, count = moved } end
  return moved
end

H.give = {
  start = function(c, job)
    local item = job.args.item
    if not item_proto(item) then return fail("there is no item called " .. tostring(item)) end
    local n = have(c.char, item)
    if n == 0 then return fail("I have no " .. item) end
    job.count = math.min(n, tonumber(job.args.count) or n)
  end,
  tick = function(c, job)
    local owner = body.owner_entity(c)
    if not owner then return fail("I cannot see the player") end
    if owner.surface ~= c.char.surface then return fail("the player is on another planet") end
    local r = approach(c, job, owner.position, math.min(c.char.reach_distance, 8))
    if r == nil then
      if job.move and util.dist(job.move.goal, owner.position) > 4 then job.move = nil end
      return nil
    end
    if r ~= true then return r end
    local target = owner
    local p = body.owner_player(c)
    if p and p.character == owner then target = p end
    local moved = move_items(c.char, target, job.args.item, job.count)
    if moved == 0 then return fail("the player's inventory is full") end
    return ok("gave " .. moved .. " " .. job.args.item .. " to " .. (body.owner_name(c) or "the player"))
  end,
}

-- The inventories a player could take from: output, chest, fuel leftovers.
local TAKE_INVS = { "chest", "furnace_result", "crafter_output", "assembling_machine_output", "burnt_result", "turret_ammo",
  "car_trunk", "cargo_wagon", "character_corpse", "logistic_container_trash" }

H.take = {
  start = function(c, job)
    local e, why = resolve(c, job.args)
    if not e then return fail(why) end
    job.e = e
  end,
  tick = function(c, job)
    local e = job.e
    if not e.valid then return fail("it is gone") end
    local r = approach(c, job, e.position, c.char.reach_distance - 0.5)
    if r == nil then return nil end
    if r ~= true then return r end
    local want_item, want = job.args.item, tonumber(job.args.count)
    local took = {}
    local total = 0
    for _, k in ipairs(TAKE_INVS) do
      local idx = defines.inventory[k]
      local inv = idx and e.get_inventory(idx)
      if inv and inv.valid then
        for key, n in pairs(util.contents(inv)) do
          local name, q = util.split_quality(key)
          if (not want_item or want_item == name) and (not want or total < want) then
            local cnt = want and math.min(n, want - total) or n
            local moved = c.char.insert { name = name, count = cnt, quality = q }
            if moved > 0 then
              inv.remove { name = name, count = moved, quality = q }
              took[#took + 1] = moved .. " " .. key
              total = total + moved
            end
          end
        end
      end
    end
    if total == 0 then
      if want_item then return fail("no " .. want_item .. " in the " .. e.name .. " (or my inventory is full)") end
      return fail("the " .. e.name .. " is empty (or my inventory is full)")
    end
    return ok("took " .. table.concat(took, ", ") .. " from the " .. e.name)
  end,
}

H.deposit = {
  start = function(c, job)
    local item = job.args.item
    if not item_proto(item) then return fail("there is no item called " .. tostring(item)) end
    local n = have(c.char, item)
    if n == 0 then return fail("I have no " .. item) end
    local e, why = resolve(c, job.args)
    if not e then return fail(why) end
    job.e, job.count = e, math.min(n, tonumber(job.args.count) or n)
  end,
  tick = function(c, job)
    local e = job.e
    if not e.valid then return fail("it is gone") end
    local r = approach(c, job, e.position, c.char.reach_distance - 0.5)
    if r == nil then return nil end
    if r ~= true then return r end
    local moved = move_items(c.char, e, job.args.item, job.count)
    if moved == 0 then return fail("the " .. e.name .. " does not take " .. job.args.item .. " (or it is full)") end
    return ok("put " .. moved .. " " .. job.args.item .. " into the " .. e.name)
  end,
}

-- ---------------------------------------------------------------- tend (fuel, ore, ammo)
local FUELS = { "coal", "solid-fuel", "wood", "rocket-fuel" }
local ORES = { "iron-ore", "copper-ore", "stone", "iron-plate" } -- iron-plate -> steel once researched
local AMMO = { "uranium-rounds-magazine", "piercing-rounds-magazine", "firearm-magazine" }
local FUEL_LOW, FUEL_ADD = 5, 10
local ORE_ADD = 20
local AMMO_LOW, AMMO_ADD, AMMO_KEEP = 10, 20, 10

local function fuel_need(e)
  local inv = e.get_fuel_inventory and e.get_fuel_inventory()
  if not inv then return false end
  local n = 0
  for _, it in pairs(inv.get_contents()) do n = n + it.count end
  return n < FUEL_LOW
end

local function source_inv(e)
  if e.type ~= "furnace" then return nil end
  return e.get_inventory(defines.inventory.crafter_input)
end

local function ammo_need(e)
  if e.type ~= "ammo-turret" then return false end
  local inv = e.get_inventory(defines.inventory.turret_ammo)
  return inv and inv.get_item_count() < AMMO_LOW
end

local function needs_work(e)
  if fuel_need(e) then return true end
  local src = source_inv(e)
  if src and src.is_empty() then return true end
  return ammo_need(e)
end

-- One entity: what she can add from her pocket. Returns a list of words and whether anything went in.
local function tend_one(c, e, notes)
  local ch = c.char
  local did = false
  if fuel_need(e) then
    local put = false
    for _, f in ipairs(FUELS) do
      if have(ch, f) > 0 then
        local n = move_items(ch, e.get_fuel_inventory(), f, math.min(FUEL_ADD, have(ch, f)))
        if n > 0 then
          notes.fuelled = (notes.fuelled or 0) + 1
          did, put = true, true
          break
        end
      end
    end
    if not put then notes.no_fuel = (notes.no_fuel or 0) + 1 end
  end
  local src = source_inv(e)
  if src and src.is_empty() then
    local put = false
    for _, o in ipairs(ORES) do
      if have(ch, o) > 0 and src.can_insert { name = o, count = 1 } then
        local n = move_items(ch, src, o, math.min(ORE_ADD, have(ch, o)))
        if n > 0 then
          notes.fed = (notes.fed or 0) + 1
          did, put = true, true
          break
        end
      end
    end
    if not put then notes.no_ore = (notes.no_ore or 0) + 1 end
  end
  if ammo_need(e) then
    local put = false
    for _, a in ipairs(AMMO) do
      local spare = have(ch, a) - AMMO_KEEP
      if spare > 0 then
        local n = move_items(ch, e.get_inventory(defines.inventory.turret_ammo), a, math.min(AMMO_ADD, spare))
        if n > 0 then
          notes.loaded = (notes.loaded or 0) + 1
          did, put = true, true
          break
        end
      end
    end
    if not put then notes.no_ammo = (notes.no_ammo or 0) + 1 end
  end
  return did
end

H.tend = {
  start = function(c, job)
    local ch = c.char
    local r = math.max(5, math.min(tonumber(job.args.radius) or 25, 60))
    local list = ch.surface.find_entities_filtered { position = ch.position, radius = r, force = ch.force,
      type = { "furnace", "boiler", "mining-drill", "inserter", "ammo-turret", "burner-generator", "assembling-machine", "reactor" } }
    local todo = {}
    for _, e in pairs(list) do
      if needs_work(e) then todo[#todo + 1] = e end
    end
    table.sort(todo, function(a, b) return util.dist(a.position, ch.position) < util.dist(b.position, ch.position) end)
    while #todo > 40 do table.remove(todo) end
    job.todo, job.i, job.notes, job.checked = todo, 1, {}, #list
    if #todo == 0 then return ok("checked " .. #list .. " machines nearby and none needed fuel, ore or ammo") end
  end,
  tick = function(c, job)
    local e = job.todo[job.i]
    if not e then
      local n = job.notes
      local parts = {}
      if n.fuelled then parts[#parts + 1] = "fuelled " .. n.fuelled end
      if n.fed then parts[#parts + 1] = "put ore into " .. n.fed .. " furnace" .. (n.fed > 1 and "s" or "") end
      if n.loaded then parts[#parts + 1] = "loaded ammo into " .. n.loaded .. " turret" .. (n.loaded > 1 and "s" or "") end
      local missing = {}
      if n.no_fuel then missing[#missing + 1] = n.no_fuel .. " still need fuel and I have none" end
      if n.no_ore then missing[#missing + 1] = n.no_ore .. " furnace" .. (n.no_ore > 1 and "s have" or " has") .. " no ore and I carry none" end
      if n.no_ammo then missing[#missing + 1] = n.no_ammo .. " turret" .. (n.no_ammo > 1 and "s are" or " is") .. " low on ammo and I have none to spare" end
      local msg = (#parts > 0 and table.concat(parts, ", ") or "added nothing") .. (#missing > 0 and ("; " .. table.concat(missing, "; ")) or "")
      return (#parts > 0 and ok or fail)(msg, n)
    end
    job.progress = (job.i - 1) .. "/" .. #job.todo .. " machines"
    if not e.valid then job.i = job.i + 1 return nil end
    local r = approach(c, job, e.position, c.char.reach_distance - 0.5)
    if r == nil then return nil end
    if r == true then tend_one(c, e, job.notes) end
    job.i = job.i + 1
    return nil
  end,
}

-- ---------------------------------------------------------------- build one entity
local function clutter_in(surface, area)
  return surface.find_entities_filtered { area = area, type = { "tree", "simple-entity", "item-entity" } }
end

H.build = {
  start = function(c, job)
    local item = item_proto(job.args.item)
    if not item then return fail("there is no item called " .. tostring(job.args.item)) end
    local ent = item.place_result
    if not ent then return fail(item.name .. " is not something you place") end
    if have(c.char, item.name) < 1 then return fail("I have no " .. item.name) end
    local p = util.pos({ job.args.x, job.args.y })
    if not p then return fail("build needs x and y") end
    local dir = util.parse_dir(job.args.direction)
    local w, h = ent.tile_width or 1, ent.tile_height or 1
    if dir == defines.direction.east or dir == defines.direction.west then w, h = h, w end
    local function grid(v, n) return n % 2 == 1 and (math.floor(v) + 0.5) or math.floor(v + 0.5) end
    job.entity, job.item, job.dir = ent.name, item.name, dir
    job.pos = { x = grid(p.x, w), y = grid(p.y, h) }
  end,
  tick = function(c, job)
    local ch = c.char
    if job.pause then
      if game.tick < job.pause then return nil end
      job.pause = nil
    end
    local r = approach(c, job, job.pos, ch.build_distance - 0.5)
    if r == nil then return nil end
    if r ~= true then return r end
    local spec = { name = job.entity, position = job.pos, direction = job.dir, force = ch.force,
      build_check_type = defines.build_check_type.manual }
    local surface = ch.surface
    if not surface.can_place_entity(spec) then
      if not job.cleared then
        job.cleared = true
        local proto = prototypes.entity[job.entity]
        local bb = proto.collision_box
        local area = { { job.pos.x + bb.left_top.x - 0.2, job.pos.y + bb.left_top.y - 0.2 },
          { job.pos.x + bb.right_bottom.x + 0.2, job.pos.y + bb.right_bottom.y + 0.2 } }
        local secs = 0
        for _, e in pairs(clutter_in(surface, area)) do
          if e.valid and e.minable then
            secs = secs + (e.prototype.mineable_properties.mining_time or 0.5) / ch.prototype.mining_speed
            ch.mine_entity(e)
          end
        end
        if secs > 0 then job.pause = game.tick + math.ceil(secs * 60) return nil end
      end
      return fail("cannot place " .. job.entity .. " at " .. at(job.pos) .. ": something is in the way or the ground is wrong")
    end
    local e = surface.create_entity { name = job.entity, position = job.pos, direction = job.dir, force = ch.force,
      raise_built = true, create_build_effect_smoke = true }
    if not e then return fail("placing " .. job.entity .. " at " .. at(job.pos) .. " failed") end
    ch.remove_item { name = job.item, count = 1 }
    verbs.remember(e)
    return ok("built " .. job.entity .. " at " .. at(e.position) .. " #" .. tostring(e.unit_number or "?"), { handle = e.unit_number })
  end,
}

-- ---------------------------------------------------------------- build the player's ghosts
local function ghost_item(g)
  for _, it in pairs(g.ghost_prototype.items_to_place_this or {}) do return it.name, it.count or 1 end
end

H.build_ghosts = {
  start = function(c, job)
    job.built, job.skip, job.radius = 0, {}, math.max(5, math.min(tonumber(job.args.radius) or 32, 96))
    local ch = c.char
    local owner = body.owner_entity(c)
    job.center = util.pos({ job.args.x, job.args.y }) or (owner and owner.surface == ch.surface and util.pos(owner.position)) or util.pos(ch.position)
    job.last_event = game.tick
  end,
  tick = function(c, job)
    local ch = c.char
    if job.pause then
      if game.tick < job.pause then return nil end
      job.pause = nil
    end
    local g = job.target
    if game.tick - job.last_event > 60 * 90 then
      if g and g.valid then job.skip[g.unit_number] = true end
      job.target, job.move, g = nil, nil, nil
      job.last_event = game.tick
    end
    if not (g and g.valid) then
      job.target, job.move = nil, nil
      local list = ch.surface.find_entities_filtered { type = "entity-ghost", force = ch.force, position = job.center, radius = job.radius }
      table.sort(list, function(x, y) return util.dist(x.position, ch.position) < util.dist(y.position, ch.position) end)
      local missing, left = {}, 0
      for _, cand in ipairs(list) do
        if not job.skip[cand.unit_number] then
          local item, n = ghost_item(cand)
          if item and have(ch, item) >= n then
            g = cand
            break
          elseif item then
            missing[item] = (missing[item] or 0) + n
            left = left + 1
          end
        end
      end
      if not g then
        if job.built == 0 and left == 0 then return fail("there are no ghosts to build within " .. job.radius .. " tiles") end
        local need = {}
        for item, n in pairs(missing) do need[#need + 1] = n .. " " .. item end
        table.sort(need)
        if left == 0 then return ok("built " .. job.built .. " ghost" .. (job.built == 1 and "" or "s") .. "; none left here", { built = job.built }) end
        local msg = "built " .. job.built .. "; " .. left .. " left that need items I do not have: " .. table.concat(need, ", ", 1, math.min(#need, 6))
        return (job.built > 0 and ok or fail)(msg, { built = job.built, left = left })
      end
      job.target = g
    end
    job.progress = job.built .. " built"
    local r = approach(c, job, g.position, ch.build_distance - 0.5)
    if r == nil then return nil end
    if type(r) == "table" then
      job.skip[g.unit_number] = true
      job.target = nil
      job.last_event = game.tick
      return nil
    end
    local item, n = ghost_item(g)
    local _, ent = g.revive { raise_revive = true }
    if not ent and g.valid and job.clear_tried ~= g.unit_number then
      job.clear_tried = g.unit_number
      local bb = g.bounding_box
      local secs = 0
      for _, e in pairs(clutter_in(ch.surface, { { bb.left_top.x, bb.left_top.y }, { bb.right_bottom.x, bb.right_bottom.y } })) do
        if e.valid and e.minable then
          secs = secs + (e.prototype.mineable_properties.mining_time or 0.5) / ch.prototype.mining_speed
          ch.mine_entity(e)
        end
      end
      if secs > 0 then job.pause = game.tick + math.ceil(secs * 60) end
      return nil
    end
    if not ent then
      job.skip[g.unit_number] = true
      job.target = nil
      return nil
    end
    if item then ch.remove_item { name = item, count = n } end
    job.built = job.built + 1
    job.target = nil
    job.last_event = game.tick
    return nil
  end,
}

-- ---------------------------------------------------------------- pick up a building
H.pickup = {
  start = function(c, job)
    local e, why = resolve(c, job.args)
    if not e then return fail(why) end
    if not e.minable then return fail("the " .. e.name .. " cannot be picked up") end
    job.e = e
  end,
  tick = function(c, job)
    local ch, e = c.char, job.e
    if not e.valid then return ok("it is already gone") end
    local r = approach(c, job, e.position, ch.reach_distance - 0.5)
    if r == nil then return nil end
    if r ~= true then return r end
    if not job.until_tick then
      local secs = (e.prototype.mineable_properties.mining_time or 0.5) / ch.prototype.mining_speed
      job.until_tick = game.tick + math.ceil(secs * 60)
      return nil
    end
    if game.tick < job.until_tick then return nil end
    local name = e.name
    if not ch.mine_entity(e) or e.valid then return fail("could not pick up the " .. name .. " (my inventory may be full)") end
    return ok("picked up the " .. name)
  end,
}

-- ---------------------------------------------------------------- research
local function trigger_words(trig)
  local t = trig.type
  local function nm(x) return type(x) == "table" and (x.name or x[1]) or tostring(x) end
  if t == "craft-item" then return "crafting " .. ((trig.count or 1) > 1 and (trig.count .. " ") or "") .. nm(trig.item) end
  if t == "mine-entity" then return "mining " .. nm(trig.entity) end
  if t == "build-entity" then return "building a " .. nm(trig.entity) end
  if t == "craft-fluid" then return "making " .. nm(trig.fluid) end
  if t == "capture-spawner" then return "capturing a spawner" end
  if t == "send-item-to-orbit" then return "launching " .. nm(trig.item) .. " to orbit" end
  if t == "create-space-platform" then return "building a space platform" end
  return t:gsub("-", " ")
end

-- What still stands before a technology, in words: "automation-science-pack (unlocked by crafting iron-gear-wheel)".
local function blockers(t, depth, seen, out)
  for name, pre in pairs(t.prerequisites) do
    if not pre.researched and not seen[name] then
      seen[name] = true
      local trig = pre.prototype.research_trigger
      if trig then out[#out + 1] = name .. " (unlocked by " .. trigger_words(trig) .. ")"
      else
        out[#out + 1] = name
        if depth < 2 then blockers(pre, depth + 1, seen, out) end
      end
    end
  end
  return out
end

H.research = {
  start = function(c, job)
    local force = c.char.force
    local t = force.technologies[job.args.tech or ""]
    if not t then return fail("there is no technology called " .. tostring(job.args.tech)) end
    if t.researched then return ok(t.name .. " is already researched") end
    local trig = t.prototype.research_trigger
    if trig then return fail(t.name .. " is not done in labs: it unlocks by " .. trigger_words(trig)) end
    local missing = blockers(t, 0, {}, {})
    if not force.add_research(t) then
      return fail("could not start " .. t.name .. (#missing > 0 and (": first needs " .. table.concat(missing, ", ", 1, math.min(#missing, 5))) or ""))
    end
    local labs = c.char.surface.count_entities_filtered { type = "lab", force = force, limit = 1 }
    return ok("started research " .. t.name .. (labs == 0 and " (there is no lab yet, so it will not progress)" or ""))
  end,
}

-- ---------------------------------------------------------------- engine
function verbs.known(verb) return H[verb] ~= nil end

local function finish(c, job, result)
  local h = H[job.verb]
  if h and h.finish then pcall(h.finish, c, job) end
  if job.move and body.alive(c) then movement.stop(c.char) end
  c.job = nil
  if c.follow_after then c.follow = true end
  c.follow_after = nil
  c.stats = c.stats or {}
  local s = c.stats[job.verb] or { ok = 0, fail = 0 }
  if result.ok then s.ok = s.ok + 1 else s.fail = s.fail + 1 end
  c.stats[job.verb] = s
  body.push(c, { t = "result", id = job.id, verb = job.verb, ok = result.ok and true or false,
    detail = util.clamp_text(result.msg or "", 400) })
end

function verbs.cancel(c, why)
  local job = c.job
  if not job then return false end
  finish(c, job, fail(why or "stopped"))
  return true
end

-- Start a job. Returns an immediate result (instant verbs, failures), or nil when it keeps running.
function verbs.start(c, id, verb, args)
  local h = H[verb]
  if not h then return fail("unknown verb " .. tostring(verb)) end
  if c.job then verbs.cancel(c, "superseded by " .. verb) end
  body.stop(c)
  local job = { id = id, verb = verb, args = args or {}, deadline = game.tick + 60 * (SECONDS[verb] or DEFAULT_SECONDS) }
  c.job = job
  if h.start then
    local ok_, r = pcall(h.start, c, job)
    if not ok_ then r = fail("error: " .. tostring(r)) end
    if r then
      if h.finish then pcall(h.finish, c, job) end
      c.job = nil
      local s = c.stats[verb] or { ok = 0, fail = 0 }
      if r.ok then s.ok = s.ok + 1 else s.fail = s.fail + 1 end
      c.stats[verb] = s
      return r
    end
  end
  if not h.tick then
    c.job = nil
    return ok("done")
  end
  return nil
end

function verbs.tick(c)
  local job = c.job
  if not job or not body.alive(c) or c.paused then return end
  if c.fleeing then return end
  if game.tick > job.deadline then
    finish(c, job, fail("ran out of time" .. (job.progress and (" at " .. job.progress) or "")))
    return
  end
  local ok_, r = pcall(H[job.verb].tick, c, job)
  if not ok_ then r = fail("error: " .. tostring(r)) end
  if r then finish(c, job, r) end
end

-- ---------------------------------------------------------------- look (instant diagnosis)
local STATUS_WORDS = {
  working = "working", normal = "working", no_fuel = "out of fuel", no_power = "no power", low_power = "low power",
  no_ingredients = "waiting for ingredients", item_ingredient_shortage = "short of ingredients",
  full_output = "output full", not_enough_space_in_output = "output full", no_recipe = "no recipe set",
  no_minable_resources = "nothing left to mine", missing_science_packs = "missing science packs",
  no_research_in_progress = "no research selected", waiting_for_source_items = "waiting for input",
  no_input_fluid = "no input fluid", disabled_by_control_behavior = "disabled by a circuit",
  disabled_by_script = "disabled", marked_for_deconstruction = "marked for deconstruction", no_ammo = "no ammo",
  not_plugged_in_electric_network = "not connected to power", full_burnt_result_output = "burnt result slot full",
}
verbs.STATUS_WORDS = STATUS_WORDS

local function list_contents(inv, max)
  local parts = {}
  for key, n in pairs(util.contents(inv)) do parts[#parts + 1] = n .. " " .. key end
  table.sort(parts)
  if #parts > (max or 6) then
    local more = #parts - (max or 6)
    while #parts > (max or 6) do table.remove(parts) end
    parts[#parts + 1] = "+" .. more .. " more"
  end
  return #parts > 0 and table.concat(parts, ", ") or "empty"
end

function verbs.describe(e)
  local parts = { e.name .. " #" .. tostring(e.unit_number or "?") .. " at " .. at(e.position) }
  local okS, st = pcall(function() return e.status end)
  if okS and st then parts[#parts + 1] = "status: " .. (STATUS_WORDS[util.STATUS_NAMES[st]] or util.STATUS_NAMES[st]) end
  local okR, r = pcall(function() return e.get_recipe and e.get_recipe() end)
  if okR and r then parts[#parts + 1] = "recipe: " .. r.name end
  if e.type == "furnace" then
    local okP, pr = pcall(function() return e.previous_recipe end)
    if okP and pr and not (okR and r) then parts[#parts + 1] = "last smelted: " .. (pr.name and pr.name.name or pr.name or "?") end
  end
  local fuel = e.get_fuel_inventory and e.get_fuel_inventory()
  if fuel then parts[#parts + 1] = "fuel: " .. list_contents(fuel) end
  for _, k in ipairs { "crafter_input", "crafter_output", "chest", "turret_ammo", "lab_input" } do
    local idx = defines.inventory[k]
    local okI, inv = pcall(e.get_inventory, idx)
    if okI and inv and inv.valid then parts[#parts + 1] = k:gsub("crafter_", ""):gsub("_", " ") .. ": " .. list_contents(inv) end
  end
  if e.is_entity_with_health and e.max_health and e.max_health > 0 and e.health < e.max_health then
    parts[#parts + 1] = "health " .. math.floor(e.health / e.max_health * 100) .. "%"
  end
  if e.last_user and e.last_user.valid then parts[#parts + 1] = "placed by " .. e.last_user.name end
  return table.concat(parts, "; ")
end

function verbs.look(c, args)
  if args.target or (args.x and args.y) then
    local e, why = resolve(c, args)
    if not e then return fail(why) end
    return ok(verbs.describe(e))
  end
  return fail("look needs a #handle or x and y")
end

return verbs
