-- Small helpers shared by every script. dist/pos/xy/walk_dir/contents are adapted from factorio-serf
-- (MIT, Copyright (c) 2026 Stephen Kirby, see THIRD_PARTY_NOTICES.md).
local util = {}

local atan2 = math.atan2 or math.atan

util.BODY = "sei-companion"

function util.dist(a, b)
  local dx, dy = (a.x or a[1]) - (b.x or b[1]), (a.y or a[2]) - (b.y or b[2])
  return math.sqrt(dx * dx + dy * dy)
end

function util.pos(p)
  if type(p) ~= "table" then return nil end
  local x, y = p.x or p[1], p.y or p[2]
  if type(x) ~= "number" or type(y) ~= "number" then return nil end
  return { x = x, y = y }
end

local function r1(v) return math.floor(v * 10 + 0.5) / 10 end
util.r1 = r1

-- Compact {x, y} for output (one decimal).
function util.xy(p) return { r1(p.x), r1(p.y) } end

-- 8-way walking direction toward (dx, dy). Factorio's y axis points south.
local OCTANTS = { [0] = "east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast" }
function util.walk_dir(dx, dy)
  local oct = math.floor((atan2(dy, dx) + math.pi / 8) / (math.pi / 4)) % 8
  return defines.direction[OCTANTS[oct]]
end

-- Compass word for the bearing from a to b ("north", "southeast", ...), for the snapshot.
local COMPASS = { [0] = "east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast" }
function util.bearing(a, b)
  local dx, dy = (b.x or b[1]) - (a.x or a[1]), (b.y or b[2]) - (a.y or a[2])
  if dx * dx + dy * dy < 0.25 then return "here" end
  local oct = math.floor((atan2(dy, dx) + math.pi / 8) / (math.pi / 4)) % 8
  return COMPASS[oct]
end

function util.parse_dir(d)
  if d == nil then return defines.direction.north end
  if type(d) == "number" then return d end
  return defines.direction[d] or defines.direction.north
end

local STATUS_NAMES = {}
for k, v in pairs(defines.entity_status) do STATUS_NAMES[v] = k end
util.STATUS_NAMES = STATUS_NAMES

-- { name = count } from a LuaInventory. Quality other than normal keeps its own key (name@quality), so a
-- legendary plate never reads as a normal one.
function util.contents(inv)
  local out = {}
  if not (inv and inv.valid) then return out end
  for _, it in pairs(inv.get_contents()) do
    local key = it.name
    if it.quality and it.quality ~= "normal" then key = it.name .. "@" .. it.quality end
    out[key] = (out[key] or 0) + it.count
  end
  return out
end

-- "iron-plate@rare" -> "iron-plate", "rare"
function util.split_quality(key)
  local name, q = tostring(key):match("^([^@]+)@(.+)$")
  if name then return name, q end
  return tostring(key), "normal"
end

-- At most n bytes, never ending inside a UTF-8 character (the JSON reply must stay valid text).
function util.clamp_text(s, n)
  s = tostring(s or "")
  if #s <= n then return s end
  local i = n
  while i > 0 do
    local b = s:byte(i + 1)
    if b < 0x80 or b >= 0xC0 then break end
    i = i - 1
  end
  return s:sub(1, i)
end

-- The trees and rocks whose mining gives `item` (serf: lichen on Vulcanus is a tree that gives carbon, not wood).
local gives = {}
function util.mined_for(item)
  if gives[item] then return gives[item] end
  local names = {}
  for name, p in pairs(prototypes.get_entity_filtered { { filter = "type", type = "tree" },
    { filter = "type", type = "simple-entity", mode = "or" } }) do
    local mp = p.mineable_properties
    for _, pr in pairs(mp and mp.minable and mp.products or {}) do
      if pr.name == item then names[#names + 1] = name break end
    end
  end
  gives[item] = names
  return names
end

-- The first item a mined entity yields.
function util.first_product(e)
  local mp = e.prototype.mineable_properties
  for _, p in pairs(mp and mp.products or {}) do
    if p.type == "item" then return p.name end
  end
end

-- An entity's handle for the brain: its unit number when it has one.
function util.handle(e)
  if e and e.valid and e.unit_number then return e.unit_number end
  return nil
end

-- A gps tag the player can click in chat.
function util.gps(p, surface)
  return string.format("[gps=%d,%d%s]", math.floor(p.x + 0.5), math.floor(p.y + 0.5),
    surface and surface.name ~= "nauvis" and ("," .. surface.name) or "")
end

return util
