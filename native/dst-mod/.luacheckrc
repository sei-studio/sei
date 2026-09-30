-- luacheck config for the Sei DST mod (native/dst-mod/sei).
-- Run: luacheck native/dst-mod/sei
std = "lua51"
max_line_length = 200
-- Klei's Lua globals the mod reads/writes (server-side API surface).
globals = {
  "GLOBAL", "Networking_Say",
}
read_globals = {
  -- mod environment
  "GetModConfigData", "AddSimPostInit", "AddPrefabPostInit", "modimport", "MODROOT",
  -- engine
  "TheSim", "TheNet", "TheWorld", "AllPlayers", "Ents", "SpawnPrefab", "GetTime",
  "Vector3", "BufferedAction", "ACTIONS", "EQUIPSLOTS", "TUNING", "STRINGS",
  "GetValidRecipe", "AllRecipes", "json", "Class", "Brain", "BT", "APP_VERSION",
  "unpack",
  -- behaviourtree
  "BehaviourNode", "PriorityNode", "SequenceNode", "WhileNode", "IfNode", "ActionNode",
  "ConditionNode", "DoAction", "Follow", "RunAway", "FindLight", "ChaseAndAttack",
  "Wander", "Panic", "StandStill", "WaitNode",
  "SUCCESS", "FAILED", "RUNNING", "READY",
}
files["sei/modmain.lua"] = {
  globals = { "GLOBAL" },
}
files["sei/modinfo.lua"] = {
  -- modinfo is a bare table of top-level assignments the engine reads.
  allow_defined_top = true,
  unused = false,
  ignore = { "131" },
}
-- Klei API arguments we accept but do not use are common (event callbacks).
unused_args = false
