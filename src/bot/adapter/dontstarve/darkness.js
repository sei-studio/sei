// src/bot/adapter/dontstarve/darkness.js: telling Charlie's hit apart from a
// monster's (261104, DST quality pass 1).
//
// The grue (components/grue.lua) hits through combat:GetAttacked with NO
// attacker and stimuli "darkness", for about two thirds of a survivor's
// health every 5-11 s while she stands in the dark. Before helper 0.3.2 the
// mod posted that hit as `attacked` with label "something", so the brain read
// it as a monster: the headless eval's night summon fled (useless against the
// dark) and cancelled the twig gather that was one twig short of a torch.
//
// Helper 0.3.2+ sends `stimuli: "darkness"`. Older helpers send nothing, so a
// hit with no attacker while the observation says she is unlit at night (or
// in a cave) is read the same way: nothing else in the game hits a survivor
// through GetAttacked with no attacker in the dark.

/**
 * @param {{ attacker?: unknown, stimuli?: unknown }} p  the mod's `attacked` payload
 * @param {object} [state]  the observation state (protocol.js)
 * @returns {boolean}
 */
export function isDarknessHit(p, state) {
  if (p?.stimuli === 'darkness') return true
  if (p?.attacker != null || (typeof p?.stimuli === 'string' && p.stimuli)) return false
  const self = state?.self
  const world = state?.world
  if (!self || !world || self.inLight) return false
  return world.phase === 'night' || world.caves === true
}

function countOf(self, prefab) {
  let n = 0
  for (const it of [...(self?.inv ?? []), ...Object.values(self?.equip ?? {})]) {
    if (it?.prefab === prefab) n += it.qty ?? 1
  }
  return n
}

/**
 * What a torch still needs from what she carries (2 cutgrass + 2 twigs).
 * @returns {{ grass: number, twigs: number, haveGrass: number, haveTwigs: number }|null}
 */
export function torchShortfall(state) {
  const self = state?.self
  if (!self) return null
  const haveGrass = countOf(self, 'cutgrass')
  const haveTwigs = countOf(self, 'twigs')
  return { grass: Math.max(0, 2 - haveGrass), twigs: Math.max(0, 2 - haveTwigs), haveGrass, haveTwigs }
}
