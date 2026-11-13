-- Reflexes: what runs at tick rate without the brain. Only survival and follow mechanics live here (defend herself
-- and the owner, back off when hurt, reload, keep up with the owner). Every choice about what to DO is the brain's.
local util = require("scripts.util")
local body = require("scripts.body")
local movement = require("scripts.movement")

local reflex = {}

local FLEE_BELOW = 0.35
local FLEE_UNTIL = 0.6
local FOLLOW_FAR = 6      -- start walking when the owner is farther than this
local FOLLOW_NEAR = 3     -- stop within this
local RESCUE_FAR = 40     -- a follow that keeps failing this far away ends with a short hop to the owner
local HIT_EVENT_GAP = 60 * 8
local NOAMMO_EVENT_GAP = 60 * 30

-- Enemy units and spawners near a point (biters, spitters, pentapods: anything on an enemy force).
-- Entity types that can be an enemy body; the ones this game version does not know are dropped once.
local ENEMY_TYPES
local function enemy_types()
  if ENEMY_TYPES then return ENEMY_TYPES end
  ENEMY_TYPES = {}
  for _, t in ipairs { "unit", "spider-unit", "segmented-unit", "unit-spawner", "turret" } do
    if pcall(prototypes.get_entity_filtered, { { filter = "type", type = t } }) then ENEMY_TYPES[#ENEMY_TYPES + 1] = t end
  end
  return ENEMY_TYPES
end
reflex.enemy_types = enemy_types

local function enemies_near(surface, force, pos, radius)
  return surface.find_entities_filtered { position = pos, radius = radius, type = enemy_types() }
end

local function hostile(force, e)
  return e.valid and e.force ~= force and not force.get_friend(e.force) and not force.get_cease_fire(e.force)
end

local function nearest_enemy(c, radius, extra_center, extra_radius)
  local ch = c.char
  local best, bd
  local function scan(center, r)
    for _, e in pairs(enemies_near(ch.surface, ch.force, center, r)) do
      if hostile(ch.force, e) and e.type ~= "turret" and e.type ~= "unit-spawner" then
        local d = util.dist(e.position, ch.position)
        if not bd or d < bd then best, bd = e, d end
      end
    end
  end
  scan(ch.position, radius)
  if extra_center then scan(extra_center, extra_radius) end
  return best, bd
end

-- The range of the gun in her selected slot, and whether she has ammo for it (reloading from her main inventory
-- if the ammo slot is empty).
local function armed(ch)
  local guns = ch.get_inventory(defines.inventory.character_guns)
  local ammo = ch.get_inventory(defines.inventory.character_ammo)
  if not (guns and ammo) then return nil end
  local main = ch.get_main_inventory()
  for i = 1, #guns do
    local g = guns[i]
    if g.valid_for_read then
      local a = ammo[i]
      if not a.valid_for_read and main then
        -- reload: any ammo the gun takes, from her pocket
        local cat = g.prototype.attack_parameters and g.prototype.attack_parameters.ammo_categories
        for _, it in pairs(main.get_contents()) do
          local ip = prototypes.item[it.name]
          if ip and ip.type == "ammo" then
            local ac = ip.ammo_category and ip.ammo_category.name
            local fits = not cat
            for _, cn in pairs(cat or {}) do if cn == ac then fits = true end end
            if fits then
              local st = main.find_item_stack({ name = it.name, quality = it.quality })
              if st then a.transfer_stack(st) end
              break
            end
          end
        end
      end
      if a.valid_for_read then
        ch.selected_gun_index = i
        local range = g.prototype.attack_parameters and g.prototype.attack_parameters.range or 15
        return range
      end
    end
  end
  return nil
end
reflex.armed = armed

local function stop_shooting(ch)
  ch.shooting_state = { state = defines.shooting.not_shooting, position = ch.position }
end

-- ---------------------------------------------------------------- combat + flee (every 10 ticks)
local function combat(c)
  local ch = c.char
  local owner = body.owner_entity(c)
  local ratio = ch.get_health_ratio()

  -- Flee: below the floor with an enemy close, walk to the owner (or away from the enemy) and stop fighting.
  local enemy, ed = nearest_enemy(c, 20)
  if c.fleeing then
    if ratio >= FLEE_UNTIL or not enemy then
      c.fleeing = nil
      c.move = nil
      movement.stop(ch)
      body.push(c, { t = "survival", kind = "safe", health = math.floor(ratio * 100) })
    else
      if not c.move or game.tick - (c.flee_since or 0) > 120 then
        local away
        if owner and owner.surface == ch.surface and util.dist(owner.position, enemy.position) > 8 then
          away = owner.position
        else
          local dx, dy = ch.position.x - enemy.position.x, ch.position.y - enemy.position.y
          local d = math.max(0.1, math.sqrt(dx * dx + dy * dy))
          away = { x = ch.position.x + dx / d * 20, y = ch.position.y + dy / d * 20 }
        end
        c.move = { goal = away, radius = 2, why = "flee" }
        c.flee_since = game.tick
      end
      return true
    end
  elseif enemy and ratio < FLEE_BELOW and ed < 20 then
    c.fleeing = true
    c.fighting = nil
    stop_shooting(ch)
    if c.job then reflex.interrupt_job(c, "retreating: low health") end
    c.move = nil
    body.push(c, { t = "survival", kind = "retreat", attacker = enemy.name, health = math.floor(ratio * 100) })
    return true
  end

  if c.stance == "passive" or c.paused then
    if c.fighting then c.fighting = nil stop_shooting(ch) end
    return false
  end

  -- Defend: enemies near her, or near the owner. Aggressive also goes after ones in sight.
  local reach = c.stance == "aggressive" and 30 or 18
  local target, td = nearest_enemy(c, reach, owner and owner.surface == ch.surface and owner.position or nil, 16)
  if not target then
    if c.fighting then
      c.fighting = nil
      stop_shooting(ch)
      body.push(c, { t = "fight_over", kills = c.fight_kills or 0 })
      c.fight_kills = 0
    end
    return false
  end
  local range = armed(ch)
  if not range then
    stop_shooting(ch)
    if game.tick - (c.noammo_tick or -NOAMMO_EVENT_GAP) >= NOAMMO_EVENT_GAP then
      c.noammo_tick = game.tick
      body.push(c, { t = "survival", kind = "no_ammo", attacker = target.name, health = math.floor(ratio * 100) })
    end
    return false
  end
  if not c.fighting then
    c.fighting = true
    c.fight_kills = 0
    local count = #ch.surface.find_entities_filtered { position = target.position, radius = 12, type = { "unit", "spider-unit" }, force = target.force }
    body.push(c, { t = "fight", enemy = target.name, count = count, near_owner = owner and util.dist(owner.position, target.position) < 16 or false })
  end
  if td > range - 1 then
    -- close in, but not past the owner's side for a defensive stance
    c.move = { goal = target.position, radius = math.max(2, range - 3), why = "fight" }
    stop_shooting(ch)
  else
    if c.move and c.move.why == "fight" then c.move = nil movement.stop(ch) end
    ch.shooting_state = { state = defines.shooting.shooting_enemies, position = target.position }
  end
  return true
end

-- ---------------------------------------------------------------- follow (every 10 ticks)
local function follow(c)
  if not c.follow or c.job or c.paused then return end
  local ch = c.char
  local owner = body.owner_entity(c)
  if not owner then return end
  if owner.surface ~= ch.surface then
    if not c.away_noted then
      c.away_noted = true
      body.push(c, { t = "owner_away", surface = owner.surface.name })
    end
    return
  end
  c.away_noted = nil
  local d = util.dist(owner.position, ch.position)
  if c.move and c.move.why == "follow" then
    if util.dist(c.move.goal, owner.position) > 4 then c.move = nil end
  end
  if not c.move and d > FOLLOW_FAR then
    c.move = { goal = util.pos(owner.position), radius = FOLLOW_NEAR, why = "follow" }
  end
end

-- One step of whatever move is active (every tick).
local function step(c)
  local m = c.move
  if not m then return end
  local r = movement.tick(c.char, m)
  if r == nil then return end
  c.move = nil
  if m.why == "follow" then
    if r == "arrived" then
      c.follow_fails = 0
    else
      c.follow_fails = (c.follow_fails or 0) + 1
      local owner = body.owner_entity(c)
      if owner and c.follow_fails >= 3 and owner.surface == c.char.surface
          and util.dist(owner.position, c.char.position) > RESCUE_FAR then
        -- She cannot find a way to the owner (a car outran her, water, a walled base): a short hop to their side,
        -- announced so nobody is surprised.
        local spot = owner.surface.find_non_colliding_position(util.BODY, owner.position, 8, 0.5)
        if spot and c.char.teleport(spot) then
          c.follow_fails = 0
          body.push(c, { t = "rescued", reason = r })
        end
      end
    end
  end
end

function reflex.tick(c)
  if not body.alive(c) then return end
  if game.tick % 10 == (c.phase or 0) then
    local busy = combat(c)
    if not busy and not c.fleeing then follow(c) end
  end
  -- Jobs drive their own movement; the reflex move runs only when no job holds the body or when fleeing/fighting.
  if c.fleeing or c.fighting or not c.job then step(c) end
end

-- Hits on her body: an event for the brain (throttled), the owner's hits feed the defend reflex through the scan.
function reflex.on_damaged(e)
  local ent = e.entity
  if not (ent and ent.valid and ent.unit_number) then return end
  local cid = storage.by_unit[ent.unit_number]
  if not cid then return end
  local c = storage.companions[cid]
  if not c then return end
  c.last_hit_tick = game.tick
  if game.tick - (c.hit_event_tick or -HIT_EVENT_GAP) < HIT_EVENT_GAP then return end
  c.hit_event_tick = game.tick
  local who = e.cause and e.cause.valid and e.cause.name or (e.damage_type and e.damage_type.name) or "something"
  body.push(c, { t = "hit", attacker = who, damage = math.floor(e.final_damage_amount or 0),
    health = math.floor(ent.get_health_ratio() * 100), fighting = c.fighting and true or false })
end

function reflex.on_kill(e)
  local cause = e.cause
  if not (cause and cause.valid and cause.unit_number) then return end
  local cid = storage.by_unit[cause.unit_number]
  local c = cid and storage.companions[cid]
  if not c then return end
  c.kills = (c.kills or 0) + 1
  c.fight_kills = (c.fight_kills or 0) + 1
end

-- set by control.lua (verbs owns jobs)
reflex.interrupt_job = function() end

return reflex
