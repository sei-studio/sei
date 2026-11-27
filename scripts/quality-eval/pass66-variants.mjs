// Prompt variants for pass66-probe.mjs, applied in-process to the loaded
// promptLibrary module (its EVENT_GUIDANCE and PROACTIVENESS_DIRECTIVES
// objects are read at call time).
const IDLE_ANCHOR = 'if your heartbeat does not have it.'
const IDLE_ADD = ' If they asked you to stay close or you told them you would stay with them, that still holds on this tick: until they tell you to go, or it is day and no mobs are near them, do only what you can do right next to them, and start no gather, dig or walk that takes you away.'
const DIR_OLD = 'Go back to your goal once they are safe and feel okay, or when they tell you to go.'
const DIR_NEW = 'The same holds when you told them you would stay with them. It lasts until they tell you to go, or until it is day and no mobs are near them. Until then, work only on what you can do right next to them.'

function patchIdle(lib, from, to) {
  const orig = lib.EVENT_GUIDANCE['sei:idle']
  lib.EVENT_GUIDANCE['sei:idle'] = (...a) => {
    const s = orig(...a)
    if (!s.includes(from)) throw new Error('idle anchor missing')
    return s.replace(from, to)
  }
}
function patchDir(lib, from, to) {
  const d = lib.PROACTIVENESS_DIRECTIVES
  if (!d[2].includes(from)) throw new Error('directive anchor missing')
  d[2] = d[2].replace(from, to)
}
const IDLE_ADD2 = ' If they asked you to stay close or you told them you would stay with them, that holds until they tell you to go or it is day with no mobs near them. Until then, do only what you can do right next to them, and do not start a gather, dig or walk that takes you away.'
const IDLE_ADD3 = ' If they asked you to stay close or you told them you would stay with them, do only what you can do right next to them, and do not start a gather, dig or walk that takes you away. That ends as soon as they tell you to go, or when it is day with no mobs near them.'
const IDLE_ADD4 = ' If they asked you to stay close or you told them you would stay with them, and they have not told you to go since, do only what you can do right next to them; do not start a gather, dig or walk that takes you away until they say go or it is day with no mobs near them.'
export default {
  idle3: (lib) => patchIdle(lib, IDLE_ANCHOR, IDLE_ANCHOR + IDLE_ADD3),
  idle4: (lib) => patchIdle(lib, IDLE_ANCHOR, IDLE_ANCHOR + IDLE_ADD4),
  idle2: (lib) => patchIdle(lib, IDLE_ANCHOR, IDLE_ANCHOR + IDLE_ADD2),
  idle: (lib) => patchIdle(lib, IDLE_ANCHOR, IDLE_ANCHOR + IDLE_ADD),
  dir: (lib) => patchDir(lib, DIR_OLD, DIR_NEW),
  both: (lib) => { patchIdle(lib, IDLE_ANCHOR, IDLE_ANCHOR + IDLE_ADD); patchDir(lib, DIR_OLD, DIR_NEW) },
}
