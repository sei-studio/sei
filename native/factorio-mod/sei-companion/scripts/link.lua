-- The localhost UDP link to the Sei app. Adapted from factorio-serf scripts/link.lua (MIT, Copyright (c) 2026
-- Stephen Kirby, see THIRD_PARTY_NOTICES.md): the framing, chunking, the per-machine outbox and the per-player
-- recv_udp loop with backoff.
--
-- Factorio must be started with --enable-lua-udp=<port>. Every peer calls recv_udp for the server (0) and for each
-- connected player; only the machine that owns that socket reads anything, and each packet becomes an input
-- action that every peer runs the same way (multiplayer-deterministic). Replies go back to the packet's source port
-- with for_player set, so only the sending machine actually transmits.
--
-- Framing, both directions: "SEI1 <id> <part> <parts>\n<body chunk>". Bodies are JSON.
local link = {}

local CHUNK = 60000 -- bytes of body per datagram (localhost datagrams top out near 64 KB)
local MAX_PARTS = 32
local PER_TICK = 3  -- datagrams sent per tick: a burst bigger than the app's socket buffer would be dropped
local CACHE_KEEP = 48 -- replies kept per client for retransmitted requests

function link.init()
  storage.udp_parts = storage.udp_parts or {}
  storage.reply_cache = storage.reply_cache or {}
end

-- Per machine, not game state: whether this machine's socket gets read, and what is waiting to go out. send_udp
-- is a no-op everywhere but the socket's owner, so neither ever changes game state.
local udp_down_until = 0
local outbox = {}

local function flush()
  for _ = 1, PER_TICK do
    local m = table.remove(outbox, 1)
    if not m then return end
    pcall(helpers.send_udp, m[1], m[3], m[2])
  end
end

-- Cut s into chunks of at most CHUNK bytes without splitting a UTF-8 character.
local function cut(s, i0)
  local i1 = math.min(#s, i0 + CHUNK - 1)
  while i1 < #s do
    local b = s:byte(i1 + 1)
    if b < 0x80 or b >= 0xC0 then break end
    i1 = i1 - 1
  end
  return s:sub(i0, i1), i1 + 1
end

function link.frames(id, s)
  local parts, i = {}, 1
  repeat
    local chunk
    chunk, i = cut(s, i)
    parts[#parts + 1] = chunk
  until i > #s
  local out = {}
  for n, chunk in ipairs(parts) do
    out[n] = "SEI1 " .. id .. " " .. n .. " " .. #parts .. "\n" .. chunk
  end
  return out
end

function link.send(port, player_index, id, s)
  for _, f in ipairs(link.frames(id, s)) do outbox[#outbox + 1] = { port, player_index, f } end
  flush()
end

-- Called every tick. recv_udp with no argument crashed headless 2.0.77, so always name a socket; a game started
-- without --enable-lua-udp errors here, and then we try again every 10 s.
function link.tick()
  if outbox[1] then flush() end
  if game.tick < udp_down_until then return end
  local any = pcall(helpers.recv_udp, 0)
  for _, p in pairs(game.connected_players) do
    if pcall(helpers.recv_udp, p.index) then any = true end
  end
  if not any then udp_down_until = game.tick + 600 end
end

function link.parse(payload)
  local id, i, n, body = payload:match("^SEI1 ([%w%-_]+) (%d+) (%d+)\n(.*)$")
  if not id then return nil end
  return id, tonumber(i), tonumber(n), body
end

-- Idempotent requests (reads) are answered fresh; everything else is answered from the cache when the app sends
-- the same id again, so a lost reply never runs an action twice (Factorio LLM Use's request-id rule).
local function cache_get(client, id)
  local c = storage.reply_cache[client]
  return c and c.map[id]
end

local function cache_put(client, id, reply)
  local c = storage.reply_cache[client]
  if not c then
    c = { map = {}, order = {} }
    storage.reply_cache[client] = c
  end
  if c.map[id] then return end
  c.map[id] = reply
  c.order[#c.order + 1] = id
  while #c.order > CACHE_KEEP do
    local old = table.remove(c.order, 1)
    c.map[old] = nil
  end
end

-- dispatch(body, ctx) -> reply string, cacheable boolean
function link.on_udp(e, dispatch)
  local id, i, n, body = link.parse(e.payload or "")
  if not id then return end
  if n < 1 or n > MAX_PARTS or i < 1 or i > n then return end
  local client = "p" .. e.player_index .. ":" .. e.source_port
  if n > 1 then
    local key = client .. ":" .. id
    local p = storage.udp_parts[key] or { got = 0, parts = {}, tick = game.tick }
    storage.udp_parts[key] = p
    if not p.parts[i] then p.parts[i], p.got = body, p.got + 1 end
    if p.got < n then return end
    body = table.concat(p.parts)
    storage.udp_parts[key] = nil
  end
  local cached = cache_get(client, id)
  if cached then
    link.send(e.source_port, e.player_index, id, cached)
    return
  end
  local ctx = { client = client, id = id, player_index = e.player_index, port = e.source_port, udp = true }
  local reply, cacheable = dispatch(body, ctx)
  if cacheable then cache_put(client, id, reply) end
  link.send(e.source_port, e.player_index, id, reply)
end

function link.gc()
  for key, p in pairs(storage.udp_parts) do
    if game.tick - p.tick > 60 * 60 then storage.udp_parts[key] = nil end
  end
end

-- Forget a client's cached replies (its companion left).
function link.forget(client)
  storage.reply_cache[client] = nil
end

return link
