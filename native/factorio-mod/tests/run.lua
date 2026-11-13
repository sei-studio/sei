-- Offline tests for the sei-companion mod's pure parts (framing, reply cache, geometry, text), run with any
-- stock Lua 5.1+ against small stand-ins for Factorio's globals:
--   lua native/factorio-mod/tests/run.lua
-- Prints one line per test and exits non-zero on a failure. Behaviour that needs the real game (walking, mining,
-- combat) is covered by scripts/factorio-headless-harness.mjs instead.
local here = arg and arg[0] and arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../sei-companion/?.lua;" .. package.path

-- Factorio stand-ins -------------------------------------------------------------------------------------------
defines = {
  direction = { north = 0, northeast = 2, east = 4, southeast = 6, south = 8, southwest = 10, west = 12, northwest = 14 },
  entity_status = { working = 1, no_fuel = 2, no_input_fluid = 3 },
}
storage = {}
local sent = {}
helpers = {
  send_udp = function(port, data, for_player) sent[#sent + 1] = { port = port, data = data, player = for_player } end,
  recv_udp = function() end,
}
game = { tick = 0, connected_players = {} }

local util = require("scripts.util")
local link = require("scripts.link")

-- tiny runner --------------------------------------------------------------------------------------------------
local passed, failed = 0, 0
local function test(name, fn)
  local ok, err = pcall(fn)
  if ok then passed = passed + 1 print("ok   " .. name)
  else failed = failed + 1 print("FAIL " .. name .. ": " .. tostring(err)) end
end
local function eq(a, b, what)
  if a ~= b then error((what or "value") .. ": expected " .. tostring(b) .. ", got " .. tostring(a), 2) end
end
local function valid_utf8(s)
  local i, n = 1, #s
  while i <= n do
    local c = s:byte(i)
    local len = c < 0x80 and 1 or (c >= 0xF0 and 4) or (c >= 0xE0 and 3) or (c >= 0xC0 and 2) or nil
    if not len then return false end
    for k = 1, len - 1 do
      local b = s:byte(i + k)
      if not b or b < 0x80 or b >= 0xC0 then return false end
    end
    i = i + len
  end
  return true
end

-- framing --------------------------------------------------------------------------------------------------------
test("frames a small body in one datagram", function()
  local f = link.frames("abc1", '{"op":"hello"}')
  eq(#f, 1, "parts")
  eq(f[1], 'SEI1 abc1 1 1\n{"op":"hello"}')
  local id, i, n, body = link.parse(f[1])
  eq(id, "abc1") eq(i, 1) eq(n, 1) eq(body, '{"op":"hello"}')
end)

test("splits a large body without cutting a UTF-8 character", function()
  local s = string.rep("\195\169", 70000) -- "é" x 70000 = 140000 bytes
  local f = link.frames("big", s)
  eq(#f, 3, "parts")
  local joined = {}
  for k, dg in ipairs(f) do
    local _, i, n, body = link.parse(dg)
    eq(i, k) eq(n, 3)
    if not valid_utf8(body) then error("part " .. k .. " is not valid UTF-8") end
    joined[#joined + 1] = body
  end
  eq(table.concat(joined), s, "joined body")
end)

test("rejects datagrams that are not ours", function()
  eq(link.parse("hello"), nil)
  eq(link.parse("SEI2 x 1 1\n{}"), nil)
  eq(link.parse("SEI1 bad id 1 1\n{}"), nil)
end)

-- request handling + reply cache ---------------------------------------------------------------------------------
link.init()
local function packet(id, body, port, i, n)
  return { payload = "SEI1 " .. id .. " " .. (i or 1) .. " " .. (n or 1) .. "\n" .. body, player_index = 0, source_port = port or 5000 }
end

test("answers a request to its source port with the same id", function()
  sent = {}
  link.on_udp(packet("r1", '{"op":"x"}'), function(body, ctx)
    eq(body, '{"op":"x"}') eq(ctx.id, "r1") eq(ctx.port, 5000)
    return '{"ok":true}', true
  end)
  eq(#sent, 1, "datagrams sent")
  eq(sent[1].port, 5000) eq(sent[1].player, 0)
  eq(sent[1].data, 'SEI1 r1 1 1\n{"ok":true}')
end)

test("a resent action is answered from the cache, never run twice", function()
  local runs = 0
  local d = function() runs = runs + 1 return '{"ok":true,"n":' .. runs .. '}', true end
  sent = {}
  link.on_udp(packet("act1", '{"op":"cmd"}'), d)
  link.on_udp(packet("act1", '{"op":"cmd"}'), d)
  eq(runs, 1, "dispatch runs")
  eq(sent[2].data, sent[1].data, "cached reply")
end)

test("reads are not cached and run every time", function()
  local runs = 0
  local d = function() runs = runs + 1 return '{"ok":true}', false end
  link.on_udp(packet("read1", '{"op":"poll"}'), d)
  link.on_udp(packet("read1", '{"op":"poll"}'), d)
  eq(runs, 2, "dispatch runs")
end)

test("the cache is per client port", function()
  local runs = 0
  local d = function() runs = runs + 1 return '{"ok":true}', true end
  link.on_udp(packet("same", "{}", 6001), d)
  link.on_udp(packet("same", "{}", 6002), d)
  eq(runs, 2, "dispatch runs")
end)

test("reassembles a request sent in parts, in any order", function()
  local got
  link.on_udp(packet("multi", "world", 7000, 2, 2), function(b) got = b return "{}", false end)
  eq(got, nil, "dispatched early")
  link.on_udp(packet("multi", "hello ", 7000, 1, 2), function(b) got = b return "{}", false end)
  eq(got, "hello world")
end)

test("sends at most 3 datagrams per tick and drains the rest later", function()
  sent = {}
  local big = string.rep("x", 60000 * 5)
  link.on_udp(packet("huge", "{}", 8000), function() return big, false end)
  eq(#sent, 3, "first tick")
  game.tick = game.tick + 1
  link.tick()
  eq(#sent, 5, "after the next tick")
end)

-- util -------------------------------------------------------------------------------------------------------------
test("distance and compass bearing (y points south)", function()
  eq(util.dist({ x = 0, y = 0 }, { 3, 4 }), 5)
  eq(util.bearing({ x = 0, y = 0 }, { x = 0, y = -10 }), "north")
  eq(util.bearing({ x = 0, y = 0 }, { x = 10, y = 10 }), "southeast")
  eq(util.bearing({ x = 0, y = 0 }, { x = -10, y = 0 }), "west")
  eq(util.bearing({ x = 1, y = 1 }, { x = 1.2, y = 1.1 }), "here")
end)

test("walking direction maps to Factorio's 16-way defines", function()
  eq(util.walk_dir(1, 0), defines.direction.east)
  eq(util.walk_dir(0, 1), defines.direction.south)
  eq(util.walk_dir(-1, -1), defines.direction.northwest)
end)

test("parse_dir accepts names, numbers and nothing", function()
  eq(util.parse_dir("west"), defines.direction.west)
  eq(util.parse_dir(4), 4)
  eq(util.parse_dir(nil), defines.direction.north)
  eq(util.parse_dir("sideways"), defines.direction.north)
end)

test("clamp_text never ends inside a UTF-8 character", function()
  eq(util.clamp_text("hello", 10), "hello")
  eq(util.clamp_text("hello", 3), "hel")
  local s = "ab\226\152\131cd" -- "ab☃cd": the snowman is 3 bytes
  eq(util.clamp_text(s, 3), "ab")
  eq(util.clamp_text(s, 4), "ab")
  eq(util.clamp_text(s, 5), "ab\226\152\131")
  eq(util.clamp_text(nil, 5), "")
end)

test("quality keys split back into name and quality", function()
  local n, q = util.split_quality("iron-plate@rare")
  eq(n, "iron-plate") eq(q, "rare")
  n, q = util.split_quality("coal")
  eq(n, "coal") eq(q, "normal")
end)

test("status names come from defines.entity_status", function()
  eq(util.STATUS_NAMES[2], "no_fuel")
end)

print(string.format("\n%d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
