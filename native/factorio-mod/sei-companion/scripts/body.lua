-- The companion's body: a real `sei-companion` character (data-final-fixes.lua) with a name tag, a map marker,
-- speech, an event feed for the app, and respawn. The tag, map marker, say bubble and respawn shapes follow
-- factorio-serf scripts/agents.lua (MIT, see THIRD_PARTY_NOTICES.md).
--
-- storage.companions[cid] = {
--   cid, name, color, char, owner_index, client, feed = {}, seq, job, follow, stance, paused,
--   dead_until, deaths, kills, last_hit_tick, stats = {}
-- }
local util = require("scripts.util")
local movement = require("scripts.movement")

local body = {}

local RESPAWN_TICKS = 60 * 10
local FEED_KEEP = 120
local MAX_PER_CLIENT_PLAYER = 3

local COLORS = {
  { r = 0.50, g = 0.69, b = 1.00 }, -- Sei periwinkle
  { r = 0.95, g = 0.55, b = 0.75 },
  { r = 0.55, g = 0.85, b = 0.55 },
  { r = 0.95, g = 0.80, b = 0.35 },
}

function body.init()
  storage.companions = storage.companions or {}
  storage.by_unit = storage.by_unit or {}
  storage.test_owner = storage.test_owner or {}
end

function body.get(cid)
  return cid and storage.companions[cid] or nil
end

function body.alive(c)
  return c and c.char and c.char.valid
end

-- ---------------------------------------------------------------- feed
-- Every event the app should hear about: chat, hits, fights, deaths, finished verbs. The app polls with its cursor,
-- so a lost reply is re-delivered by the next poll.
function body.push(c, ev)
  c.seq = (c.seq or 0) + 1
  ev.seq = c.seq
  ev.tick = game.tick
  local f = c.feed
  f[#f + 1] = ev
  while #f > FEED_KEEP do table.remove(f, 1) end
end

function body.push_all(ev)
  for _, c in pairs(storage.companions) do
    local copy = {}
    for k, v in pairs(ev) do copy[k] = v end
    body.push(c, copy)
  end
end

function body.since(c, cursor)
  local out = {}
  cursor = tonumber(cursor) or 0
  for _, ev in ipairs(c.feed) do
    if ev.seq > cursor then out[#out + 1] = ev end
  end
  return out
end

-- ---------------------------------------------------------------- owner
-- Who she belongs to: the player whose app drives her. A headless test sets a stand-in entity instead
-- (sei-testkit). In a game hosted from the GUI the host's packets may arrive as player 0; then the first
-- connected player with a character is the owner.
function body.owner_player(c)
  if c.owner_index and c.owner_index > 0 then
    local p = game.get_player(c.owner_index)
    if p and p.valid and p.connected then return p end
    return nil
  end
  for _, p in pairs(game.connected_players) do
    if p.character then return p end
  end
  return nil
end

-- The owner's body (an entity with a position and surface), or nil.
function body.owner_entity(c)
  local t = storage.test_owner[c.cid]
  if t and t.valid then return t end
  local p = body.owner_player(c)
  if p and p.character and p.character.valid then return p.character end
  if p and p.vehicle and p.vehicle.valid then return p.vehicle end
  return nil
end

function body.owner_name(c)
  local t = storage.test_owner[c.cid]
  if t and t.valid then return "Tester" end
  local p = body.owner_player(c)
  return p and p.name or nil
end

-- ---------------------------------------------------------------- looks
local function draw_tag(c)
  for _, k in pairs { "tag", "map_dot", "map_tag" } do
    if c[k] and c[k].valid then c[k].destroy() end
    c[k] = nil
  end
  c.tag = rendering.draw_text {
    text = c.name, surface = c.char.surface, target = { entity = c.char, offset = { 0, -2.6 } },
    color = c.color, scale = 1.1, alignment = "center", vertical_alignment = "middle", use_rich_text = false,
  }
  -- A script character gets no player marker on the map; draw one.
  c.map_dot = rendering.draw_circle {
    radius = 0.3, filled = true, surface = c.char.surface, target = c.char, color = c.color,
    render_mode = "chart", scale_with_zoom = true,
  }
  c.map_tag = rendering.draw_text {
    text = c.name, surface = c.char.surface, target = c.char, color = c.color, scale = 1.1,
    alignment = "center", vertical_alignment = "bottom", render_mode = "chart", scale_with_zoom = true,
    use_rich_text = false,
  }
end

local function create_char(c, surface, near)
  local pos = surface.find_non_colliding_position(util.BODY, near, 32, 0.5) or near
  local char = surface.create_entity { name = util.BODY, position = pos, force = "player" }
  if not char then error("could not create the companion body", 0) end
  char.color = c.color
  c.char = char
  storage.by_unit[char.unit_number] = c.cid
  -- A script character generates no chunks of its own (serf): ask for the ground around her.
  surface.request_to_generate_chunks(pos, 2)
  draw_tag(c)
  return char
end

local STARTER = { ["iron-plate"] = 8, ["wood"] = 1, ["pistol"] = 1, ["firearm-magazine"] = 10, ["burner-mining-drill"] = 1, ["stone-furnace"] = 1 }

local function count_for_player(player_index)
  local n = 0
  for _, c in pairs(storage.companions) do
    if c.owner_index == player_index and not c.gone then n = n + 1 end
  end
  return n
end

-- spawn { name, color? } from a client. Returns the companion (an existing one with the same name and owner
-- is taken over, so a reconnecting app finds her where she stood with what she carried).
function body.spawn(req, ctx)
  local name = util.clamp_text((tostring(req.name or ""):gsub("[%c%[%]]", "")), 32)
  if name == "" then error("spawn needs a name", 0) end
  local owner_index = ctx.player_index or 0
  local cid = owner_index .. ":" .. name:lower()
  local c = storage.companions[cid]
  if c and body.alive(c) then
    c.client, c.gone = ctx.client, nil
    if not (c.tag and c.tag.valid) then draw_tag(c) end
    return c, false
  end
  if not c then
    if count_for_player(owner_index) >= MAX_PER_CLIENT_PLAYER then
      error("this player already has " .. MAX_PER_CLIENT_PLAYER .. " companions", 0)
    end
    local n = 0
    for _ in pairs(storage.companions) do n = n + 1 end
    c = {
      cid = cid, name = name, owner_index = owner_index, feed = {}, seq = 0,
      color = COLORS[(n % #COLORS) + 1],
      follow = true, stance = "defensive", deaths = 0, kills = 0, stats = {},
    }
    if type(req.color) == "table" and req.color.r then c.color = req.color end
    storage.companions[cid] = c
  end
  c.client, c.gone = ctx.client, nil
  local owner = body.owner_entity(c)
  local surface = owner and owner.surface or game.surfaces.nauvis
  local near = owner and owner.position or game.forces.player.get_spawn_position(surface)
  if c.stash_inventory then
    create_char(c, surface, near)
    body.unstash(c)
  else
    create_char(c, surface, near)
    if not c.kit_given then
      for item, n in pairs(STARTER) do
        if prototypes.item[item] then c.char.insert { name = item, count = n } end
      end
      c.kit_given = true
    end
  end
  c.dead_until = nil
  return c, true
end

-- ---------------------------------------------------------------- leaving
-- When the app stops, her things go into a script inventory and the body leaves the world; the next spawn of the
-- same name for the same player brings both back (serf's leave/join, simplified).
local STASH = { "character_main", "character_guns", "character_ammo", "character_armor", "character_trash" }

function body.stash(c)
  if not body.alive(c) then return end
  local ch = c.char
  pcall(function()
    while ch.crafting_queue_size > 0 do
      local q = ch.crafting_queue
      ch.cancel_crafting { index = q[#q].index, count = q[#q].count }
    end
  end)
  c.stash_inventory = {}
  for _, k in ipairs(STASH) do
    local inv = ch.get_inventory(defines.inventory[k])
    if inv and not inv.is_empty() then
      local box = game.create_inventory(#inv)
      for i = 1, #inv do
        if inv[i].valid_for_read then box[i].transfer_stack(inv[i]) end
      end
      c.stash_inventory[k] = box
    end
  end
end

function body.unstash(c)
  local ch = c.char
  for _, k in ipairs { "character_armor", "character_guns", "character_ammo", "character_main", "character_trash" } do
    local box = c.stash_inventory and c.stash_inventory[k]
    if box and box.valid then
      local inv = ch.get_inventory(defines.inventory[k])
      for i = 1, #box do
        local s = box[i]
        if s.valid_for_read and inv and i <= #inv then inv[i].transfer_stack(s) end
        if s.valid_for_read then
          local main = ch.get_main_inventory()
          local free = main and main.find_empty_stack(s.name)
          if free then free.transfer_stack(s) end
        end
        if s.valid_for_read then
          ch.surface.spill_item_stack { position = ch.position, stack = s, enable_looted = true }
          s.clear()
        end
      end
      box.destroy()
    end
  end
  c.stash_inventory = nil
end

local function drop_char(c)
  if c.char and c.char.valid then
    storage.by_unit[c.char.unit_number] = nil
    c.char.destroy()
  end
  for _, k in pairs { "tag", "map_dot", "map_tag", "bubble" } do
    if c[k] and c[k].valid then c[k].destroy() end
    c[k] = nil
  end
  c.char = nil
end

function body.leave(c)
  if body.alive(c) then
    body.stash(c)
    drop_char(c)
  end
  c.gone, c.job, c.move, c.dead_until = true, nil, nil, nil
end

-- ---------------------------------------------------------------- speech
function body.say(c, text)
  text = util.clamp_text((tostring(text or ""):gsub("%c", " ")), 300)
  if text == "" then return end
  local col = c.color
  game.print({ "", "[color=" .. string.format("%.2f,%.2f,%.2f", col.r, col.g, col.b) .. "]" .. c.name .. "[/color]: " .. text },
    { sound = defines.print_sound.never, skip = defines.print_skip.never })
  if body.alive(c) then
    if c.bubble and c.bubble.valid then c.bubble.destroy() end
    local short = (text:gsub("%[[^%]]*%]", ""))
    if #short > 70 then short = short:sub(1, 67) .. "..." end
    c.bubble = rendering.draw_text {
      text = short, surface = c.char.surface, target = { entity = c.char, offset = { 0, -3.6 } },
      color = { 1, 1, 1 }, scale = 0.9, alignment = "center", vertical_alignment = "middle",
      time_to_live = 60 * 6, use_rich_text = false,
    }
  end
end

-- ---------------------------------------------------------------- death
function body.on_died(e)
  local entity = e.entity
  local cid = storage.by_unit[entity.unit_number]
  if not cid then return end
  storage.by_unit[entity.unit_number] = nil
  local c = storage.companions[cid]
  if not c then return end
  local cause = e.cause and e.cause.valid and e.cause.name or nil
  for _, k in pairs { "tag", "map_dot", "map_tag", "bubble" } do
    if c[k] and c[k].valid then c[k].destroy() end
    c[k] = nil
  end
  c.char, c.job, c.move, c.fleeing, c.fighting = nil, nil, nil, nil, nil
  c.deaths = (c.deaths or 0) + 1
  c.dead_until = game.tick + RESPAWN_TICKS
  body.push(c, { t = "death", cause = cause, at = util.xy(entity.position), respawn_s = RESPAWN_TICKS / 60 })
end

-- Back beside the owner after RESPAWN_TICKS. Her things stay in the corpse where she fell.
function body.respawn_tick()
  for _, c in pairs(storage.companions) do
    if c.dead_until and not c.gone and game.tick >= c.dead_until then
      local owner = body.owner_entity(c)
      local surface = owner and owner.surface or game.surfaces.nauvis
      local near = owner and owner.position or game.forces.player.get_spawn_position(surface)
      local ok = pcall(create_char, c, surface, near)
      if ok then
        c.dead_until = nil
        body.push(c, { t = "respawned", at = util.xy(c.char.position) })
      else
        c.dead_until = game.tick + 60 * 5
      end
    end
  end
end

-- Movement of the body (follow, verbs) uses c.move; clear it.
function body.stop(c)
  c.move = nil
  if body.alive(c) then
    movement.stop(c.char)
    c.char.mining_state = { mining = false }
  end
end

return body
