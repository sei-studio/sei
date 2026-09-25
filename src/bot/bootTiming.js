// src/bot/bootTiming.js — boot-phase timestamps for the summon diagnostics (260926).
//
// BOT_START_TIMEOUT was the top summon failure on Windows (14 people in 30
// days): the child spent ~21-24s between fork and createBot, and nothing
// said where. Each phase below is stamped once (epoch ms, same machine clock
// as main) and pushed up the port as a full snapshot, so main can attach a
// per-phase breakdown to summon_failed / character_summoned.
//
// Phases, in order (a missing one means the boot never got there):
//   process_start      performance.timeOrigin (the utilityProcess started)
//   modules_loaded     index.js's static import graph evaluated
//   init_received      the init payload arrived (main waits on continuity first)
//   pack_loader_ready  the game-pack resolve hook is registered
//   runtime_loaded     the game runtime module graph (mineflayer, ...) imported
//   booted             config parsed, init-ack sent: the ready deadline starts here
//   version_resolved   the LAN status ping answered (Minecraft)
//   create_bot         mineflayer.createBot called
//   bot_created        createBot returned (its sync setup: plugins, registry)
//   login              the server accepted the login
//   spawn              first spawn in the world (summon-ready)
//
// No dependencies, safe to import first.

const marks = {}
try {
  const origin = Number(globalThis.performance?.timeOrigin)
  if (Number.isFinite(origin) && origin > 0) marks.process_start = Math.round(origin)
} catch {}

let listener = null

/** Stamp a phase (first stamp wins) and notify the port listener. */
export function markBoot(name, at = Date.now()) {
  if (typeof name !== 'string' || !name || name in marks) return
  marks[name] = at
  try { listener?.({ ...marks }) } catch {}
}

/** A copy of every phase stamped so far. */
export function bootMarks() {
  return { ...marks }
}

/** Register the snapshot sink (index.js, once the MessagePort exists). */
export function onBootMark(fn) {
  listener = typeof fn === 'function' ? fn : null
}

/** Test-only reset. */
export function __resetBootMarks() {
  for (const k of Object.keys(marks)) delete marks[k]
  listener = null
}
