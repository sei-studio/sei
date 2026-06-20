// src/bot/adapter/minecraft/render/skyColor.js
//
// 260611: time-of-day sky approximation for the single-frame POV render.
// prismarine-viewer hardcodes scene.background to 'lightblue' regardless of
// world time, so night renders shipped a noon sky and the model narrated
// daylight scenes at midnight. Approximate the vanilla cycle with keyframes
// over `bot.time.timeOfDay` (0..24000 ticks: 0 sunrise, 6000 noon, ~12000
// sunset starts, ~13800-22200 night, ~23200 dawn) and lerp between them.
// Deliberately coarse — the goal is "the sky reads as the right time of
// day", not shader-accurate atmospherics.
//
// Lives in its own module (no GL/canvas imports) so it is unit-testable
// under system-Node vitest — povRenderer.js dlopens natives at import time.

const SKY_KEYFRAMES = [
  [0,     [140, 180, 235]],  // early morning
  [1000,  [173, 216, 230]],  // full day (the original lightblue)
  [11000, [173, 216, 230]],  // late afternoon
  [12500, [222, 150, 110]],  // sunset orange
  [13800, [18, 22, 45]],     // dusk into night
  [22200, [18, 22, 45]],     // night
  [23200, [200, 150, 120]],  // dawn glow
  [24000, [140, 180, 235]],  // wraps to early morning
]

/**
 * Approximate sky color for a Minecraft time-of-day tick.
 *
 * @param {number} timeOfDay  0..24000 (wrapped/clamped defensively).
 * @returns {number[]} [r,g,b] 0..255. Missing/invalid input → full day.
 */
export function skyColorForTime (timeOfDay) {
  const t = Number.isFinite(timeOfDay) ? ((timeOfDay % 24000) + 24000) % 24000 : 6000
  for (let i = 1; i < SKY_KEYFRAMES.length; i++) {
    const [t1, c1] = SKY_KEYFRAMES[i]
    if (t > t1) continue
    const [t0, c0] = SKY_KEYFRAMES[i - 1]
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0)
    return [
      Math.round(c0[0] + (c1[0] - c0[0]) * f),
      Math.round(c0[1] + (c1[1] - c0[1]) * f),
      Math.round(c0[2] + (c1[2] - c0[2]) * f),
    ]
  }
  return SKY_KEYFRAMES[1][1].slice()
}
