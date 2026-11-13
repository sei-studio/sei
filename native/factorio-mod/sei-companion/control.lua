-- Sei Companion: an AI companion character that plays alongside you, driven by the Sei app over localhost UDP.
-- The app (the brain) decides what to do; this mod is her body: walking, reflexes (defend, retreat, keep up,
-- respawn) and the composite verbs. See README.md and PROTOCOL.md.
local util = require("scripts.util")
local link = require("scripts.link")
local movement = require("scripts.movement")
local body = require("scripts.body")
local reflex = require("scripts.reflex")
local verbs = require("scripts.verbs")
local api = require("scripts.api")
local observe = require("scripts.observe")

reflex.interrupt_job = function(c, why) verbs.cancel(c, why) end

local function init()
  link.init()
  movement.init()
  body.init()
end

script.on_init(init)
script.on_configuration_changed(init)

script.on_event(defines.events.on_tick, function()
  link.tick()
  for _, c in pairs(storage.companions) do
    if not c.gone then
      reflex.tick(c)
      verbs.tick(c)
    end
  end
  local t = game.tick
  if t % 60 == 0 then body.respawn_tick() end
  if t % 600 == 0 then
    movement.gc()
    link.gc()
    verbs.gc()
  end
end)

script.on_event(defines.events.on_udp_packet_received, function(e)
  link.on_udp(e, api.dispatch)
end)

script.on_event(defines.events.on_script_path_request_finished, movement.on_path)

script.on_event(defines.events.on_entity_died, function(e)
  local ent = e.entity
  if ent and ent.valid and ent.name == util.BODY then
    body.on_died(e)
  else
    reflex.on_kill(e)
  end
end)

script.on_event(defines.events.on_entity_damaged, reflex.on_damaged, { { filter = "name", name = util.BODY } })

script.on_event(defines.events.on_console_chat, function(e)
  if not e.player_index or not e.message then return end
  local p = game.get_player(e.player_index)
  if not p then return end
  body.push_all { t = "chat", from = p.name, player_index = p.index, text = util.clamp_text(e.message, 500) }
end)

script.on_event(defines.events.on_research_finished, function(e)
  if e.by_script then return end
  local tech = e.research
  for _, c in pairs(storage.companions) do
    if body.alive(c) and c.char.force == tech.force then body.push(c, { t = "research_finished", tech = tech.name }) end
  end
end)

script.on_event(defines.events.on_player_joined_game, function(e)
  local p = game.get_player(e.player_index)
  if p then body.push_all { t = "player_joined", name = p.name } end
end)

script.on_event(defines.events.on_player_left_game, function(e)
  local p = game.get_player(e.player_index)
  if p then body.push_all { t = "player_left", name = p.name } end
end)

-- RCON fallback: /sei <json request>. TCP is reliable, so no reply cache; replies go back with rcon.print.
commands.add_command("sei", "Sei companion bridge (JSON request).", function(cmd)
  local raw = cmd.parameter or ""
  local okJ, req = pcall(helpers.json_to_table, raw)
  local id = okJ and type(req) == "table" and req.id and tostring(req.id) or ("rcon" .. game.tick)
  local reply = api.dispatch(raw, { client = "rcon", id = id, player_index = cmd.player_index or 0, udp = false })
  if rcon then rcon.print(reply) end
  if cmd.player_index then
    local p = game.get_player(cmd.player_index)
    if p then p.print(reply) end
  end
end)

-- For the headless test harness (never needed in play): a stand-in owner entity, and a direct way to look.
remote.add_interface("sei_companion", {
  set_test_owner = function(cid, unit_number)
    local e = unit_number and game.get_entity_by_unit_number(unit_number)
    storage.test_owner[cid] = e
    return e ~= nil
  end,
  body = function(cid)
    local c = body.get(cid)
    return c and body.alive(c) and c.char or nil
  end,
  entity = function(h)
    local e = storage.handles and storage.handles[h]
    return e and e.valid and e or nil
  end,
  state = function(cid)
    local c = body.get(cid)
    if not c then return nil end
    return helpers.table_to_json { obs = observe.of(c), job = c.job and c.job.verb, follow = c.follow, stats = c.stats,
      kills = c.kills, deaths = c.deaths, unit = body.alive(c) and c.char.unit_number or nil }
  end,
  dispatch = function(raw, player_index)
    return (api.dispatch(raw, { client = "remote", id = "remote" .. game.tick, player_index = player_index or 0, udp = false }))
  end,
})
