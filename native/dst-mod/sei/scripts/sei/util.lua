-- scripts/sei/util.lua: small helpers shared by the Sei mod modules.
-- Runs in the game's global environment (loaded with require), so the Klei
-- globals (json, TheSim, ...) are reachable directly.

local Util = {}

--- Percent-encode a string for a URL query value.
function Util.UrlEncode(s)
    s = tostring(s or "")
    s = string.gsub(s, "([^%w%-%_%.%~])", function(c)
        return string.format("%%%02X", string.byte(c))
    end)
    return s
end

--- JSON encode a table; prefers Klei's compliant encoder when it exists.
--- Returns nil on failure (never throws).
function Util.JsonEncode(tbl)
    local ok, out = pcall(function()
        if json ~= nil and json.encode_compliant ~= nil then
            return json.encode_compliant(tbl)
        end
        return json.encode(tbl)
    end)
    if ok then return out end
    return nil
end

--- JSON decode a string; nil on failure or empty input.
function Util.JsonDecode(s)
    if type(s) ~= "string" or #s == 0 then return nil end
    local ok, out = pcall(function() return json.decode(s) end)
    if ok and type(out) == "table" then return out end
    return nil
end

--- Round a number to one decimal (payload size discipline).
function Util.Round1(n)
    if type(n) ~= "number" then return 0 end
    return math.floor(n * 10 + 0.5) / 10
end

--- Look an entity up by GUID; nil when it is gone or in limbo.
function Util.Ent(guid)
    local g = tonumber(guid)
    if g == nil then return nil end
    local e = Ents[g]
    if e == nil or not e:IsValid() then return nil end
    return e
end

--- Distance in the XZ plane between two entities (or an entity and a point).
function Util.DistXZ(a, bx, bz)
    if a == nil then return math.huge end
    local ax, _, az = a.Transform:GetWorldPosition()
    if type(bx) == "table" and bx.Transform ~= nil then
        local x, _, z = bx.Transform:GetWorldPosition()
        bx, bz = x, z
    end
    if bx == nil or bz == nil then return math.huge end
    local dx, dz = ax - bx, az - bz
    return math.sqrt(dx * dx + dz * dz)
end

--- Find the nearest player entity, optionally by userid.
function Util.FindPlayer(userid, near)
    local best, bestd = nil, math.huge
    for _, p in ipairs(AllPlayers or {}) do
        if p:IsValid() and not p:HasTag("sei_companion") and (userid == nil or userid == "" or p.userid == userid) then
            local d = near ~= nil and Util.DistXZ(near, p) or 0
            if d < bestd then best, bestd = p, d end
        end
    end
    return best
end

--- Run fn in pcall; on error print + report through the given reporter.
function Util.Guard(label, fn, reporter)
    local ok, err = pcall(fn)
    if not ok then
        local msg = tostring(label) .. ": " .. tostring(err)
        print("[sei] " .. msg)
        if reporter ~= nil then pcall(reporter, msg) end
    end
    return ok
end

return Util
