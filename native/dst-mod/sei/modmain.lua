-- modmain.lua: the Sei companion helper (server-only).
--
-- Inert unless the Sei desktop app answers on a discovery port: every 2 s
-- the master sim sends GET http://127.0.0.1:<port>/hello?q=<json> carrying
-- the world's session id, name, day, season, phase and players. The reply is
-- `{ok, app="sei"}` (idle) or the same plus `summon={token, botPort, name,
-- prefab, nearUserid, announce}`, and on a summon the body is spawned beside
-- that player and wired to the bot runtime on botPort (see PROTOCOL.md).
--
-- There is no port setting (260909). Sei binds the first free port in PORTS
-- and this side probes ALL of them every beat until one answers with
-- app == "sei", then sticks to it; three misses in a row send it back to
-- probing. A stranger on one of the ports never gets adopted because the
-- app field is required. Cost while Sei is closed: five refused loopback
-- connections every 2 s.
--
-- Chat capture wraps GLOBAL.Networking_Say (the 9-arg signature; the engine
-- calls it on the server for every chat line). The assignment has to happen
-- from THIS environment (mod env) onto GLOBAL, or the game keeps calling the
-- original.
--
-- Everything else lives under scripts/sei/ (loaded with require into the
-- game environment) and scripts/brains/seibrain.lua.

local GLOBAL = GLOBAL
local TheNet = GLOBAL.TheNet
local TheSim = GLOBAL.TheSim
local require = GLOBAL.require
local json = GLOBAL.json
local pcall = GLOBAL.pcall
local tostring = GLOBAL.tostring
local type = GLOBAL.type

-- MIRROR: DST_DISCOVERY_PORTS in src/shared/dstIpc.ts.
local PORTS = { 27424, 27425, 27426, 27427, 27428 }
local ANNOUNCE = GetModConfigData("announce")
if ANNOUNCE == nil then ANNOUNCE = true end
local HEARTBEAT_S = 2
local MOD_VERSION = "0.2.0"
-- A request that has not called back for this long is written off, so one
-- hung QueryServer cannot silence a port forever.
local INFLIGHT_STALE_S = 10
local MISSES_BEFORE_PROBE = 3

local function log(msg)
    print("[sei] " .. tostring(msg))
end

-- Only the master simulation runs bodies and talks to Sei. A pure client
-- (someone who joined a friend's world) does nothing here.
if not (TheNet ~= nil and TheNet:GetIsServer()) then
    log("client instance, helper idle")
    return
end

-- ── chat capture ────────────────────────────────────────────────────────────
-- Installed once, at load: Networking_Say is a plain global, so the wrapper
-- is in place before the first line is said.
local oldSay = GLOBAL.Networking_Say
GLOBAL.Networking_Say = function(guid, userid, name, prefab, message, colour, whisper, isemote, user_vanity)
    if not isemote then
        pcall(function()
            require("sei/events").OnChat(guid, userid, name, prefab, message, whisper)
        end)
    end
    return oldSay(guid, userid, name, prefab, message, colour, whisper, isemote, user_vanity)
end

-- ── heartbeat ───────────────────────────────────────────────────────────────

local activePort = nil      -- the port that last answered as Sei
local misses = 0            -- consecutive failures on activePort
local inflight = {}         -- port -> GetTime() the request left

local function helloBody()
    local TheWorld = GLOBAL.TheWorld
    local ws = TheWorld and TheWorld.state or {}
    local players = {}
    for _, p in ipairs(GLOBAL.AllPlayers or {}) do
        if p:IsValid() and not p:HasTag("sei_companion") then
            players[#players + 1] = { userid = p.userid or "", name = p.name or "", prefab = p.prefab }
        end
    end
    local Companion = require("sei/companion")
    return {
        session = TheNet.GetSessionIdentifier ~= nil and TheNet:GetSessionIdentifier() or "",
        world = TheNet.GetServerName ~= nil and TheNet:GetServerName() or "",
        day = (ws.cycles or 0) + 1,
        season = ws.season or "",
        phase = ws.phase or "",
        players = players,
        ismastersim = TheWorld ~= nil and TheWorld.ismastersim or false,
        caves = TheWorld ~= nil and TheWorld:HasTag("cave") or false,
        mod = MOD_VERSION,
        build = tostring(GLOBAL.APP_VERSION or ""),
        bot = Companion.IsLive() and Companion.inst.GUID or nil,
    }
end

local function onSummon(offer)
    local Net = require("sei/net")
    local Companion = require("sei/companion")
    if type(offer) ~= "table" or type(offer.botPort) ~= "number" or type(offer.token) ~= "string" then
        log("ignoring malformed summon offer")
        return
    end
    -- One body at a time; a second offer while one is live re-summons.
    Net.Configure(offer.botPort, offer.token)
    if offer.announce == nil then offer.announce = ANNOUNCE end
    local inst, reason = Companion.Summon(offer)
    if inst == nil then
        log("summon failed: " .. tostring(reason))
        require("sei/events").Post("spawnfailed", { reason = tostring(reason) })
    else
        log("summoned " .. tostring(offer.prefab) .. " as " .. tostring(offer.name))
    end
end

local function onHelloResult(port, result, ok, code)
    local Util = require("sei/util")
    inflight[port] = nil
    local resp = (ok and code == 200) and Util.JsonDecode(result) or nil
    if resp == nil or resp.app ~= "sei" then
        if activePort == port then
            misses = misses + 1
            if misses >= MISSES_BEFORE_PROBE then
                log("lost Sei on port " .. tostring(port) .. ", probing again")
                activePort = nil
                misses = 0
            end
        end
        return
    end
    if activePort ~= port then
        log("found Sei on port " .. tostring(port))
        activePort = port
    end
    misses = 0
    if resp.summon ~= nil then
        pcall(onSummon, resp.summon)
    end
end

local function sendHello(port, encoded)
    local now = GLOBAL.GetTime()
    if inflight[port] ~= nil and now - inflight[port] < INFLIGHT_STALE_S then return end
    inflight[port] = now
    local Util = require("sei/util")
    local url = "http://127.0.0.1:" .. tostring(port) .. "/hello?q=" .. Util.UrlEncode(encoded)
    TheSim:QueryServer(url, function(result, ok, code)
        onHelloResult(port, result, ok, code)
    end, "GET")
end

local function heartbeat()
    local Util = require("sei/util")
    local encoded = Util.JsonEncode(helloBody())
    if encoded == nil then return end
    if activePort ~= nil then
        sendHello(activePort, encoded)
    else
        for _, p in ipairs(PORTS) do
            sendHello(p, encoded)
        end
    end
end

AddSimPostInit(function()
    local TheWorld = GLOBAL.TheWorld
    if TheWorld == nil or not TheWorld.ismastersim then
        log("not the master sim, helper idle")
        return
    end
    log("helper active, probing discovery ports " .. tostring(PORTS[1]) .. "-" .. tostring(PORTS[#PORTS]))
    TheWorld:DoPeriodicTask(HEARTBEAT_S, function()
        pcall(heartbeat)
    end, 1)
    -- A world shutting down takes the body with it; drop it cleanly so the
    -- inventory lands on the ground and the runtime hears despawned.
    TheWorld:ListenForEvent("ms_shutdown", function()
        pcall(function() require("sei/companion").Despawn("world shutdown") end)
    end)
end)

-- Keep the json global referenced so a stripped build cannot drop it before
-- the first heartbeat needs it (harmless otherwise).
local _ = json
