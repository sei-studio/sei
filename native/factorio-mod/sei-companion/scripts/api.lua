-- The request handlers. One JSON request in, one JSON reply out. The same dispatch serves the UDP link and the
-- RCON fallback command (/sei <json>).
--
-- Requests: { op = "hello" | "spawn" | "poll" | "observe" | "cmd" | "cancel" | "pause" | "despawn", cid?, ... }
-- See PROTOCOL.md.
local util = require("scripts.util")
local body = require("scripts.body")
local verbs = require("scripts.verbs")
local observe = require("scripts.observe")
local movement = require("scripts.movement")

local api = {}

api.PROTOCOL = 1

local function enc(t) return helpers.table_to_json(t) end
local function err(msg) return { ok = false, error = msg } end

-- Ops that change nothing answer fresh every time; everything else is cached per request id (link.lua).
local READS = { hello = true, poll = true, observe = true, players = true }

local function companion(req, ctx)
  local cid = req.cid
  local c = body.get(cid)
  if not c then return nil, "no companion " .. tostring(cid) .. " (spawn first)" end
  -- A client can only drive the companions of its own player (the server console and tests drive player 0).
  if ctx.udp and ctx.player_index ~= 0 and c.owner_index ~= ctx.player_index then return nil, "not your companion" end
  return c
end

local INSTANT = {}

function INSTANT.say(c, args)
  local text = args.text
  if type(text) ~= "string" or text == "" then return { ok = false, msg = "say needs text" } end
  body.say(c, text)
  return { ok = true, msg = "said it" }
end

function INSTANT.follow(c)
  verbs.cancel(c, "switched to follow")
  c.follow, c.paused = true, nil
  return { ok = true, msg = "following " .. (body.owner_name(c) or "the player") }
end

function INSTANT.stay(c)
  verbs.cancel(c, "told to stay")
  c.follow = false
  body.stop(c)
  return { ok = true, msg = "staying here at " .. (body.alive(c) and ("(" .. math.floor(c.char.position.x) .. "," .. math.floor(c.char.position.y) .. ")") or "?") }
end

function INSTANT.defend(c, args)
  local s = args.stance
  if s ~= "passive" and s ~= "defensive" and s ~= "aggressive" then return { ok = false, msg = "stance is passive, defensive or aggressive" } end
  c.stance = s
  return { ok = true, msg = "stance is now " .. s }
end

function INSTANT.look(c, args)
  return verbs.look(c, args)
end

function INSTANT.stop(c)
  local had = verbs.cancel(c, "told to stop")
  body.stop(c)
  return { ok = true, msg = had and "stopped" or "nothing to stop" }
end

local OPS = {}

function OPS.hello(req, ctx)
  local players = {}
  for _, p in pairs(game.connected_players) do players[#players + 1] = { i = p.index, name = p.name } end
  return { ok = true, mod = script.active_mods["sei-companion"], game = script.active_mods["base"], protocol = api.PROTOCOL,
    tick = game.tick, player_index = ctx.player_index, players = players, multiplayer = game.is_multiplayer(),
    paused = game.tick_paused or nil, world = storage.world_id, seed = storage.seed }
end

function OPS.players()
  local players = {}
  for _, p in pairs(game.connected_players) do players[#players + 1] = { i = p.index, name = p.name } end
  return { ok = true, players = players }
end

function OPS.spawn(req, ctx)
  local okS, c, fresh = pcall(body.spawn, req, ctx)
  if not okS then return err(tostring(c)) end
  c.phase = c.phase or (game.tick % 10)
  if fresh then body.push(c, { t = "spawned", at = util.xy(c.char.position) }) end
  return { ok = true, cid = c.cid, fresh = fresh, seq = c.seq, owner = body.owner_name(c), at = util.xy(c.char.position) }
end

function OPS.poll(req, ctx)
  local c, why = companion(req, ctx)
  if not c then return err(why) end
  c.last_poll = game.tick
  return { ok = true, seq = c.seq, ev = body.since(c, req.since), alive = body.alive(c) and true or false }
end

function OPS.observe(req, ctx)
  local c, why = companion(req, ctx)
  if not c then return err(why) end
  return { ok = true, obs = observe.of(c) }
end

-- cmd { cid, verb, args }: instant verbs answer at once; job verbs answer { started = true } and later push a
-- `result` event with this request's id.
function OPS.cmd(req, ctx)
  local c, why = companion(req, ctx)
  if not c then return err(why) end
  local verb, args = req.verb, type(req.args) == "table" and req.args or {}
  if c.gone then return err("she has left the game") end
  if INSTANT[verb] then
    local r = INSTANT[verb](c, args)
    return { ok = true, done = true, success = r.ok, msg = r.msg }
  end
  if not verbs.known(verb) then return err("unknown verb " .. tostring(verb)) end
  if not body.alive(c) then
    return { ok = true, done = true, success = false, msg = "I am dead, back in " .. math.max(0, math.ceil(((c.dead_until or game.tick) - game.tick) / 60)) .. " s" }
  end
  if c.fleeing then return { ok = true, done = true, success = false, msg = "I am retreating with low health" } end
  local r = verbs.start(c, ctx.id or tostring(game.tick), verb, args)
  if r then return { ok = true, done = true, success = r.ok, msg = r.msg } end
  -- A job holds the body. If she was following, she picks it up again when the job ends (goto means "stay there").
  c.follow_after = c.follow and verb ~= "goto"
  c.follow = false
  return { ok = true, started = true, id = ctx.id }
end

function OPS.cancel(req, ctx)
  local c, why = companion(req, ctx)
  if not c then return err(why) end
  local had = verbs.cancel(c, req.reason or "cancelled")
  if body.alive(c) then movement.stop(c.char) end
  return { ok = true, cancelled = had }
end

function OPS.pause(req, ctx)
  local c, why = companion(req, ctx)
  if not c then return err(why) end
  c.paused = req.paused and true or nil
  if c.paused then body.stop(c) end
  return { ok = true, paused = c.paused or false }
end

function OPS.despawn(req, ctx)
  local c, why = companion(req, ctx)
  if not c then return err(why) end
  verbs.cancel(c, "left")
  body.leave(c)
  return { ok = true }
end

-- dispatch(body string, ctx) -> reply json, cacheable
function api.dispatch(raw, ctx)
  local okJ, req = pcall(helpers.json_to_table, raw)
  if not okJ or type(req) ~= "table" then return enc(err("bad json")), false end
  local f = OPS[req.op]
  if not f then return enc(err("unknown op " .. tostring(req.op))), false end
  local okC, reply = pcall(f, req, ctx)
  if not okC then reply = err("error: " .. tostring(reply)) end
  return enc(reply), not READS[req.op]
end

return api
