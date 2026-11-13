-- The companion body: a copy of the vanilla character made after every other mod has changed it, so it keeps
-- their crafting categories, reach and equipment grid. A prototype of our own means removing the mod removes
-- the bodies cleanly (no orphan characters left in a save) and lets a script tell her apart from players.
local base = data.raw["character"] and data.raw["character"]["character"]
if base then
  local body = table.deepcopy(base)
  body.name = "sei-companion"
  body.localised_name = { "entity-name.sei-companion" }
  body.localised_description = { "entity-description.sei-companion" }
  data:extend({ body })
end
