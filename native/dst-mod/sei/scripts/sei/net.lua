-- scripts/sei/net.lua: the HTTP link to the Sei bot runtime.
--
-- Everything leaves the game through TheSim:QueryServer(url, cb, method,
-- body): no headers, no content type, bodies kept small (Klei's QueryServer
-- allocates generously per request; tens of KB is where it starts to hurt).
-- The per-summon token rides the query string because that is the only
-- place a request can carry it. Localhost is the one destination the 2025
-- sandbox allows (Klei update 653007).
--
-- Request shape follows the CC0 POST handling in gyroplast's Chat
-- Announcements mod (isSuccessful and a 2xx code = success).

local Util = require("sei/util")

local Net = {}

Net.base = nil      -- "http://127.0.0.1:<botPort>"
Net.token = nil
Net.inflight = 0
Net.failures = 0    -- consecutive transport failures (the runtime dying)
-- After this many consecutive failures the runtime is presumed gone and
-- Net.onDead fires once (companion.lua despawns the body). Observations post
-- several times a second, so this is a few seconds of a dead port.
Net.DEAD_AFTER = 8
Net.dead = false
Net.onDead = nil

function Net.Configure(botPort, token)
    Net.base = "http://127.0.0.1:" .. tostring(botPort)
    Net.token = tostring(token or "")
    Net.failures = 0
    Net.dead = false
end

function Net.Reset()
    Net.base = nil
    Net.token = nil
    Net.inflight = 0
    Net.failures = 0
    Net.dead = false
end

function Net.IsConfigured()
    return Net.base ~= nil and Net.token ~= nil and #Net.token > 0
end

local function url(path, query)
    local q = "t=" .. Util.UrlEncode(Net.token or "")
    if query ~= nil then
        for k, v in pairs(query) do
            q = q .. "&" .. Util.UrlEncode(k) .. "=" .. Util.UrlEncode(v)
        end
    end
    return Net.base .. path .. "?" .. q
end

local function finish(cb, result, ok, code)
    Net.inflight = math.max(0, Net.inflight - 1)
    if ok and code ~= nil and code >= 200 and code <= 299 then
        Net.failures = 0
        if cb ~= nil then pcall(cb, Util.JsonDecode(result), true, code) end
    else
        Net.failures = Net.failures + 1
        if cb ~= nil then pcall(cb, nil, false, code) end
        if Net.failures >= Net.DEAD_AFTER and not Net.dead and Net.onDead ~= nil then
            Net.dead = true
            pcall(Net.onDead)
        end
    end
end

--- GET <base><path>?t=<token>&... ; cb(decodedJson|nil, ok, code)
function Net.Get(path, query, cb)
    if not Net.IsConfigured() then
        if cb ~= nil then pcall(cb, nil, false, 0) end
        return false
    end
    Net.inflight = Net.inflight + 1
    TheSim:QueryServer(url(path, query), function(result, ok, code)
        finish(cb, result, ok, code)
    end, "GET")
    return true
end

--- POST a table as JSON to <base><path>?t=<token> ; cb(decodedJson|nil, ok, code)
function Net.Post(path, body, cb)
    if not Net.IsConfigured() then
        if cb ~= nil then pcall(cb, nil, false, 0) end
        return false
    end
    local encoded = Util.JsonEncode(body) or "{}"
    Net.inflight = Net.inflight + 1
    TheSim:QueryServer(url(path), function(result, ok, code)
        finish(cb, result, ok, code)
    end, "POST", encoded)
    return true
end

--- Report a Lua error to the runtime (lands in Sei's log panel). Never throws.
function Net.ReportError(message)
    if not Net.IsConfigured() then return end
    pcall(Net.Post, "/error", { message = tostring(message), t = GetTime() })
end

return Net
