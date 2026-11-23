// 261114 (quality pass 55): where a block or entity is, in words: "11 blocks
// southeast", "14 blocks southwest, 6 down", "right by you", plus ", by
// Alex" when it sits within NEAR_OWNER_M of the player. The snapshot puts it
// next to the coordinates of each listed block and entity, which stay for
// the tools (they take x,y,z). With only the numbers to go on she read them
// out in chat ("already got one down at 174,70,-2 lol", "found iron at
// 206,66,0"); this gives her the way a player would say it. Only the
// snapshot carries it: it is rebuilt every turn, while words in a tool
// result would go stale in the history once she moves.
// 8-way compass on the x/z offset (north = -z, east = +x, as in facing.js).
// Null without finite positions.

const COMPASS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
const NEAR_OWNER_M = 4

function dist(a, b) {
  if (!a || !b) return null
  const v = [a.x, a.y, a.z, b.x, b.y, b.z].map(Number)
  if (!v.every(Number.isFinite)) return null
  return Math.round(Math.hypot(v[0] - v[3], v[1] - v[4], v[2] - v[5]))
}

/**
 * @param {{x:number,y:number,z:number}} pos
 * @param {{x:number,y:number,z:number}} selfPos
 * @param {{pos:{x:number,y:number,z:number}, name:string}|null} [owner]
 * @returns {string|null}
 */
export function whereFromYou(pos, selfPos, owner = null) {
  const d = dist(pos, selfPos)
  if (d == null) return null
  const dx = pos.x - selfPos.x, dy = pos.y - selfPos.y, dz = pos.z - selfPos.z
  let where
  if (d <= 2) where = 'right by you'
  else if (Math.hypot(dx, dz) < 2) where = `${d} blocks ${dy > 0 ? 'above' : 'below'} you`
  else {
    const deg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360
    where = `${d} blocks ${COMPASS8[Math.round(deg / 45) % 8]}`
    if (Math.abs(dy) >= 4) where += `, ${Math.round(Math.abs(dy))} ${dy > 0 ? 'up' : 'down'}`
  }
  const od = owner?.pos ? dist(pos, owner.pos) : null
  if (d > 2 && od != null && od <= NEAR_OWNER_M && owner.name) where += `, by ${owner.name}`
  return where
}
