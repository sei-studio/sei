-- scripts/sei/version.lua: the helper's version, reported to Sei in the
-- /hello heartbeat and the `spawned` event. The app gates prompt text and
-- tools that depend on new mod behaviour on it (src/bot/adapter/dontstarve/
-- modVersion.js). Keep in step with modinfo.lua `version` (a unit test in
-- the app checks the two match).
return "0.3.0"
