-- scripts/sei/events.lua: game events -> POST /event on the bot runtime.
--
-- Every handler runs inside pcall (a listener that throws would take the
-- brain down with it), and a failure is reported to /error so it lands in
-- Sei's log panel. Chat capture is installed by modmain (it has to assign
-- GLOBAL.Networking_Say from the mod environment) and calls OnChat here.
--
-- Event kinds (PROTOCOL.md): chat, attacked, death, enterdark, enterlight,
-- actionfailed, phase, spawned, spawnfailed, despawned, result.

local Net = require("sei/net")
local Util = require("sei/util")

local Events = {}

local bot = nil        -- the live companion entity
local listeners = {}   -- { {event, fn, source} }
local watches = {}     -- { {var, fn} }

local function post(kind, data)
    data = data or {}
    data.kind = kind
    data.t = GetTime()
    Net.Post("/event", data)
end
Events.Post = post

local function guard(label, fn)
    return function(...)
        local args = { ... }
        Util.Guard(label, function() fn(unpack(args)) end, Net.ReportError)
    end
end

local function labelOf(ent)
    if ent == nil or not ent.IsValid or not ent:IsValid() then return "something" end
    if ent:HasTag("player") then return ent.name or "a player" end
    return ent.prefab or "something"
end

--- Player chat captured from Networking_Say. Bot lines are skipped by guid.
function Events.OnChat(guid, userid, name, prefab, message, whisper)
    if bot ~= nil and guid == bot.GUID then return end
    if type(message) ~= "string" or #message == 0 then return end
    post("chat", {
        userid = userid or "",
        name = name or "",
        prefab = prefab or "",
        text = message,
        whisper = whisper and true or false,
    })
end

function Events.Attach(inst)
    Events.Detach()
    bot = inst
    local function listen(event, fn, source)
        local g = guard("events." .. event, fn)
        inst:ListenForEvent(event, g, source)
        table.insert(listeners, { event = event, fn = g, source = source })
    end
    local function watch(var, fn)
        local g = guard("watch." .. var, fn)
        inst:WatchWorldState(var, g)
        table.insert(watches, { var = var, fn = g })
    end

    listen("attacked", function(_, data)
        local attacker = data and data.attacker or nil
        local hp = inst.components.health
        post("attacked", {
            attacker = attacker ~= nil and attacker.GUID or nil,
            label = labelOf(attacker),
            isplayer = attacker ~= nil and attacker:HasTag("player") or false,
            damage = data and Util.Round1(data.damage or 0) or 0,
            health = hp ~= nil and Util.Round1(hp.currenthealth) or 0,
            healthpct = hp ~= nil and Util.Round1(hp:GetPercent()) or 0,
        })
    end)
    listen("death", function(_, data)
        local x, _, z = inst.Transform:GetWorldPosition()
        post("death", {
            x = Util.Round1(x), z = Util.Round1(z),
            cause = data and data.cause or nil,
            afflicter = data and data.afflicter ~= nil and labelOf(data.afflicter) or nil,
        })
    end)
    listen("enterdark", function() post("enterdark", { phase = TheWorld.state.phase }) end)
    listen("enterlight", function() post("enterlight", {}) end)
    listen("actionfailed", function(_, data)
        post("actionfailed", {
            action = data and data.action and data.action.action and data.action.action.id or nil,
            reason = data and data.reason or nil,
        })
    end)
    watch("phase", function(_, phase)
        post("phase", { phase = phase, day = (TheWorld.state.cycles or 0) + 1 })
    end)
end

function Events.Detach()
    if bot ~= nil and bot:IsValid() then
        for _, l in ipairs(listeners) do
            pcall(function() bot:RemoveEventCallback(l.event, l.fn, l.source) end)
        end
        for _, w in ipairs(watches) do
            pcall(function() bot:StopWatchingWorldState(w.var, w.fn) end)
        end
    end
    listeners = {}
    watches = {}
    bot = nil
end

return Events
