-- Walking with the game's pathfinder. Adapted from factorio-serf scripts/movement.lua (MIT, Copyright (c) 2026
-- Stephen Kirby, see THIRD_PARTY_NOTICES.md): two bounding boxes, waypoint epsilon, progress-based stuck detection
-- with repaths, cutting the tree it is caught on, stepping off belts, and walking into ungenerated ground in legs.
--
-- Characters are not LuaCommandable, so there is no set_command: request_path, then steer walking_state every tick.
-- A move state m = { goal, radius } is ticked by its owner; tick returns nil while moving, "arrived", or a failure
-- string.
local util = require("scripts.util")

local movement = {}

local PATH_BOXES = { { { -0.35, -0.35 }, { 0.35, 0.35 } }, { { -0.2, -0.2 }, { 0.2, 0.2 } } }
local WAYPOINT_EPS = 0.45
local STUCK_TICKS = 45
local MAX_REPATHS = 4
local PATH_TIMEOUT = 60 * 20
local LEG = 64
local BELTS = { "transport-belt", "underground-belt", "splitter", "loader", "loader-1x1", "linked-belt", "lane-splitter" }

function movement.init()
  storage.path_results = storage.path_results or {}
end

function movement.stop(char)
  if char and char.valid then char.walking_state = { walking = false, direction = defines.direction.north } end
end

local function off_belt(surface, pos)
  local cx, cy = math.floor(pos.x), math.floor(pos.y)
  for r = 1, 3 do
    local best, bd
    for dx = -r, r do
      for dy = -r, r do
        if math.max(math.abs(dx), math.abs(dy)) == r then
          local t = { x = cx + dx + 0.5, y = cy + dy + 0.5 }
          if surface.count_entities_filtered { position = t, radius = 0.45, type = BELTS, limit = 1 } == 0 then
            local spot = surface.find_non_colliding_position(util.BODY, t, 0.4, 0.1)
            if spot and util.dist(spot, t) < 0.3 then
              local d = util.dist(spot, pos)
              if not bd or d < bd then best, bd = spot, d end
            end
          end
        end
      end
    end
    if best then return best end
  end
end

local function request(char, m)
  local proto = prototypes.entity[util.BODY] or prototypes.entity["character"]
  local attempt = m.attempt or 1
  local start = char.position
  if attempt > 1 then
    start = char.surface.find_non_colliding_position(util.BODY, start, 3, 0.25) or start
  end
  m.req = char.surface.request_path {
    bounding_box = PATH_BOXES[math.min(attempt, #PATH_BOXES)],
    collision_mask = proto.collision_mask,
    start = start,
    goal = m.goal,
    force = char.force,
    radius = math.max(m.radius - 0.3, 0.5),
    entity_to_ignore = char,
    can_open_gates = true,
    path_resolution_modifier = 0,
    pathfind_flags = { cache = false, prefer_straight_paths = true, allow_paths_through_own_entities = false },
  }
  m.req_tick = game.tick
  m.path, m.idx = nil, nil
end

function movement.on_path(e)
  storage.path_results[e.id] = { path = e.path, again = e.try_again_later, tick = game.tick }
end

function movement.gc()
  for id, r in pairs(storage.path_results) do
    if game.tick - r.tick > 600 then storage.path_results[id] = nil end
  end
end

local function generated(surface, p)
  return surface.is_chunk_generated { math.floor(p.x / 32), math.floor(p.y / 32) }
end

local function leg_toward(char, goal)
  local pos = char.position
  local dx, dy = goal.x - pos.x, goal.y - pos.y
  local d = math.sqrt(dx * dx + dy * dy)
  if d < 1 then return nil end
  local step = math.min(LEG, d)
  while step >= 8 do
    local q = { x = pos.x + dx / d * step, y = pos.y + dy / d * step }
    if generated(char.surface, q) then return q end
    step = step - 8
  end
  return nil
end

function movement.tick(char, m)
  if m.pause then
    if game.tick < m.pause then return nil end
    m.pause, m.stuck_ref = nil, nil
  end
  local pos = char.position
  local d = util.dist(pos, m.goal)
  if d <= m.radius then
    if m.final then
      m.goal, m.radius, m.final = m.final.goal, m.final.radius, nil
      m.path, m.req, m.repaths, m.attempt, m.snapped, m.stuck_ref = nil, nil, nil, nil, nil, nil
      return nil
    end
    movement.stop(char)
    return "arrived"
  end
  if not m.path and not m.req and not generated(char.surface, m.goal) then
    local leg = leg_toward(char, m.goal)
    if leg then
      m.final = { goal = m.goal, radius = m.radius }
      m.goal, m.radius, m.gen_wait = leg, 2, nil
    else
      m.gen_wait = (m.gen_wait or 0) + 1
      if m.gen_wait == 1 then char.surface.request_to_generate_chunks(pos, 3) end
      if m.gen_wait < 600 then return nil end
    end
    d = util.dist(pos, m.goal)
  end

  if not m.path then
    if d < 2.5 then
      m.path, m.idx = { { position = m.goal } }, 1
    elseif not m.req then
      request(char, m)
      return nil
    else
      local r = storage.path_results[m.req]
      if not r then
        if game.tick - m.req_tick > PATH_TIMEOUT then return "the pathfinder timed out" end
        return nil
      end
      storage.path_results[m.req] = nil
      m.req = nil
      if not r.path then
        m.path_fails = (m.path_fails or 0) + 1
        if r.again and m.path_fails < 5 then return nil end
        if not m.snapped then
          -- The goal itself may be unstandable (inside a building, on water): aim for the nearest free spot.
          m.snapped = true
          local spot = char.surface.find_non_colliding_position(util.BODY, m.goal, math.max(m.radius + 2, 6), 0.5)
          if spot and util.dist(spot, m.goal) > 0.5 then
            m.radius = math.max(0.5, m.radius - util.dist(spot, m.goal))
            m.goal = spot
            return nil
          end
        end
        m.attempt = (m.attempt or 1) + 1
        if m.attempt <= 3 then
          if m.attempt == 3 then m.radius = m.radius + 2 end
          return nil
        end
        return "no path there (water, cliffs or buildings in the way)"
      end
      m.path, m.idx = r.path, 1
    end
  end

  local wp = m.path[m.idx].position
  while m.idx < #m.path and util.dist(pos, wp) < WAYPOINT_EPS do
    m.idx = m.idx + 1
    wp = m.path[m.idx].position
  end
  local dw = util.dist(pos, wp)
  if m.idx == #m.path and dw < WAYPOINT_EPS then
    movement.stop(char)
    if d <= m.radius + 1.5 then return "arrived" end
    return string.format("the path ended %.0f tiles short", d)
  end

  char.walking_state = { walking = true, direction = util.walk_dir(wp.x - pos.x, wp.y - pos.y) }

  -- Stuck: progress along the path, not movement (a belt can carry her back and forth forever).
  local progress = m.idx * 10000 - dw
  m.stuck_ref = m.stuck_ref or { best = progress, tick = game.tick }
  if progress > m.stuck_ref.best + 0.3 then
    m.stuck_ref = { best = progress, tick = game.tick }
  elseif game.tick - m.stuck_ref.tick > STUCK_TICKS then
    m.repaths = (m.repaths or 0) + 1
    if m.repaths > MAX_REPATHS then
      movement.stop(char)
      return "stuck"
    end
    m.stuck_ref = nil
    movement.stop(char)
    if m.repaths >= 2 then
      -- Caught twice: cut the tree or rock she is caught on, as a player would, or wiggle free by a tile.
      local cut = false
      local snags = char.surface.find_entities_filtered { position = pos, radius = 1.5, type = { "tree", "simple-entity" } }
      table.sort(snags, function(a, b) return util.dist(a.position, pos) < util.dist(b.position, pos) end)
      for _, e in ipairs(snags) do
        if e.valid and e.minable and (e.type == "tree" or e.prototype.count_as_rock_for_filtered_deconstruction) then
          local secs = e.prototype.mineable_properties.mining_time / char.prototype.mining_speed
          if char.mine_entity(e) then
            cut = true
            m.pause = game.tick + math.ceil(secs * 60)
            break
          end
        end
      end
      if not cut then
        local on_belt = char.surface.count_entities_filtered { position = pos, radius = 0.4, type = BELTS, limit = 1 } > 0
        local spot = on_belt and off_belt(char.surface, pos)
          or char.surface.find_non_colliding_position(util.BODY, pos, 1.2, 0.1)
        if spot and util.dist(spot, pos) > 0.05 then char.teleport(spot) end
      end
    end
    request(char, m)
  end
  return nil
end

return movement
