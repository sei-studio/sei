-- A bounded observation of what she can see, for the app to turn into a short snapshot for the brain. Counts and
-- the nearest few of each kind, never full lists, so the snapshot stays small on a big base.
local util = require("scripts.util")
local body = require("scripts.body")
local verbs = require("scripts.verbs")
local reflex = require("scripts.reflex")

local observe = {}

local SEE = 32          -- tiles she reports around her
local BASE = 24         -- tiles of buildings she sums up
local MAX_PROBLEMS = 6
local MAX_INV = 14
local MAX_PLACES = 6

local function top_items(tbl, n)
  local arr = {}
  for k, v in pairs(tbl) do arr[#arr + 1] = { k, v } end
  table.sort(arr, function(a, b) return a[2] > b[2] or (a[2] == b[2] and a[1] < b[1]) end)
  local out = {}
  for i = 1, math.min(n, #arr) do out[#out + 1] = arr[i] end
  return out, #arr
end

local QUIET = { working = true, normal = true, waiting_for_source_items = true, waiting_for_space_in_destination = true,
  waiting_to_launch_rocket = true, fully_charged = true, charging = true, discharging = true, recipe_not_researched = false }
-- Machines where a stopped status is worth naming (belts, poles and walls have nothing to diagnose).
local DIAG_TYPES = { "assembling-machine", "furnace", "mining-drill", "lab", "boiler", "generator", "ammo-turret",
  "electric-turret", "inserter", "rocket-silo", "burner-generator", "reactor", "agricultural-tower" }

local function resources(ch)
  local out = {}
  local found = ch.surface.find_entities_filtered { position = ch.position, radius = SEE, type = "resource" }
  local by = {}
  for _, e in pairs(found) do
    local b = by[e.name]
    local d = util.dist(e.position, ch.position)
    if not b then
      b = { n = 0, amount = 0 }
      by[e.name] = b
    end
    b.n = b.n + 1
    b.amount = b.amount + (e.amount or 0)
    if not b.d or d < b.d then b.d, b.at = d, e.position end
  end
  for name, b in pairs(by) do
    out[#out + 1] = { name = name, tiles = b.n, amount = b.amount, dist = math.floor(b.d), dir = util.bearing(ch.position, b.at), at = util.xy(b.at) }
  end
  table.sort(out, function(a, b) return a.dist < b.dist end)
  while #out > 6 do table.remove(out) end
  local trees = ch.surface.find_entities_filtered { position = ch.position, radius = 16, type = "tree" }
  local rocks = ch.surface.find_entities_filtered { position = ch.position, radius = 16, type = "simple-entity" }
  return out, #trees, #rocks
end

local function enemies(ch, owner)
  local list = ch.surface.find_entities_filtered { position = ch.position, radius = 48, type = reflex.enemy_types() }
  local by, nearest, nd = {}, nil, nil
  local nests = 0
  for _, e in pairs(list) do
    if e.force ~= ch.force and not ch.force.get_friend(e.force) and not ch.force.get_cease_fire(e.force) then
      if e.type == "unit-spawner" or e.type == "turret" then nests = nests + 1
      else by[e.name] = (by[e.name] or 0) + 1 end
      local d = util.dist(e.position, ch.position)
      if not nd or d < nd then nearest, nd = e, d end
    end
  end
  if not nearest then return nil end
  local units = {}
  for name, n in pairs(by) do units[#units + 1] = { name, n } end
  table.sort(units, function(a, b) return a[2] > b[2] end)
  return { units = units, nests = nests, nearest = nearest.name, dist = math.floor(nd), dir = util.bearing(ch.position, nearest.position),
    near_owner = owner and owner.surface == ch.surface and util.dist(owner.position, nearest.position) < 20 or false }
end

local function base(ch)
  local list = ch.surface.find_entities_filtered { position = ch.position, radius = BASE, force = ch.force }
  local counts, problems, chests, ghosts = {}, {}, {}, 0
  for _, e in pairs(list) do
    local t = e.type
    if t == "entity-ghost" then ghosts = ghosts + 1
    elseif t ~= "character" and t ~= "character-corpse" then
      counts[e.name] = (counts[e.name] or 0) + 1
      if t == "container" or t == "logistic-container" then
        if #chests < MAX_PLACES then
          local inv = e.get_inventory(defines.inventory.chest)
          local top = top_items(util.contents(inv), 3)
          local words = {}
          for _, it in ipairs(top) do words[#words + 1] = it[2] .. " " .. it[1] end
          chests[#chests + 1] = { h = verbs.remember(e), name = e.name, at = util.xy(e.position), has = #words > 0 and table.concat(words, ", ") or "empty" }
        end
      end
    end
  end
  for _, t in ipairs(DIAG_TYPES) do
    if #problems >= MAX_PROBLEMS then break end
    for _, e in pairs(ch.surface.find_entities_filtered { position = ch.position, radius = BASE, force = ch.force, type = t }) do
      local okS, st = pcall(function() return e.status end)
      local sname = okS and st and util.STATUS_NAMES[st]
      if sname and not QUIET[sname] and not (t == "inserter" and sname == "waiting_for_source_items") then
        problems[#problems + 1] = { h = verbs.remember(e), name = e.name, at = util.xy(e.position),
          status = verbs.STATUS_WORDS[sname] or sname:gsub("_", " ") }
        if #problems >= MAX_PROBLEMS then break end
      end
    end
  end
  local top, kinds = top_items(counts, 10)
  return { buildings = top, kinds = kinds, problems = problems, chests = chests, ghosts = ghosts }
end

local function inventory(ch)
  local main = util.contents(ch.get_main_inventory())
  local top, kinds = top_items(main, MAX_INV)
  local guns = {}
  local g = ch.get_inventory(defines.inventory.character_guns)
  local a = ch.get_inventory(defines.inventory.character_ammo)
  for i = 1, (g and #g or 0) do
    if g[i].valid_for_read then
      local ammo = a and a[i] and a[i].valid_for_read and (a[i].count .. " " .. a[i].name) or "no ammo"
      guns[#guns + 1] = g[i].name .. " (" .. ammo .. ")"
    end
  end
  local inv = ch.get_main_inventory()
  return { items = top, kinds = kinds, free = inv and inv.count_empty_stacks() or 0, guns = guns }
end

local function research(force)
  local cur = force.current_research
  if not cur then return { none = true } end
  return { name = cur.name, pct = math.floor((force.research_progress or 0) * 100), queue = #(force.research_queue or {}) }
end

function observe.of(c)
  local out = { name = c.name, tick = game.tick, stance = c.stance, follow = c.follow and true or false }
  if c.gone then out.gone = true return out end
  if not body.alive(c) then
    out.dead = true
    if c.dead_until then out.respawn_s = math.max(0, math.ceil((c.dead_until - game.tick) / 60)) end
    return out
  end
  local ch = c.char
  local owner = body.owner_entity(c)
  out.at = util.xy(ch.position)
  out.surface = ch.surface.name
  out.health = math.floor(ch.get_health_ratio() * 100)
  out.fighting = c.fighting and true or nil
  out.fleeing = c.fleeing and true or nil
  out.paused = c.paused and true or nil
  if c.job then out.job = { verb = c.job.verb, id = c.job.id, progress = c.job.progress } end
  if ch.crafting_queue_size > 0 then out.crafting = ch.crafting_queue_size end
  if owner then
    local same = owner.surface == ch.surface
    out.owner = { name = body.owner_name(c), surface = owner.surface.name, at = util.xy(owner.position),
      dist = same and math.floor(util.dist(owner.position, ch.position)) or nil,
      dir = same and util.bearing(ch.position, owner.position) or nil,
      vehicle = (owner.type ~= "character" and owner.type ~= "simple-entity") and owner.name or nil }
    local p = body.owner_player(c)
    if p and p.character and p.character.valid then
      out.owner.health = math.floor(p.character.get_health_ratio() * 100)
      local hand = p.cursor_stack
      if hand and hand.valid_for_read then out.owner.holding = hand.name end
      if p.selected and p.selected.valid then
        out.owner.pointing = { name = p.selected.name, h = verbs.remember(p.selected), at = util.xy(p.selected.position) }
      end
    end
  else
    out.owner = { missing = true }
  end
  out.inv = inventory(ch)
  out.res, out.trees, out.rocks = resources(ch)
  out.enemies = enemies(ch, owner)
  out.base = base(ch)
  out.research = research(ch.force)
  out.daytime = ch.surface.daytime
  out.dark = ch.surface.darkness > 0.5 or nil
  return out
end

return observe
