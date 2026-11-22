/**
 * 6-color palettes for procedural pixel portraits.
 *
 * - palette[0]  â†’ sky/background (top of sprite + sky-gradient anchor).
 * - palette[1]  â†’ sky-gradient bottom band.
 * - palette[2..5] â†’ body/head sprite tiers (deterministically picked per cell).
 *
 * Sources:
 * - First 6 palettes ported VERBATIM from the v0.1 design mockup app.jsx
 *   (`finishAddCharacter` palettes array, lines 135â€“142).
 * - Palette index 6 is the SUI default character's palette (app.jsx line 28),
 *   added so default Sui's portrait reproduces the prototype's sprite when the
 *   seed `'sui Sui'` lands on it.
 * - Palette index 7 is a curated complement (warm fall) so list length is 8 and
 *   the FNV-1a hash mod-N has a useful spread (UI-SPEC Â§PixelPortrait determinism
 *   "8â€“10 pre-curated palettes per theme").
 *
 * Dark palettes mirror the light palettes' role contract (sky/body/eyes) but
 * shift toward cooler/darker hues so the sprite reads correctly on the dark
 * window background. Same 8-element ordering as light so a given seed's index
 * remains stable across themes â€” only the colors change.
 *
 * D-14: deterministic from `id + name`. Theme switch preserves layout, swaps
 * palette (UI-SPEC Â§PixelPortrait determinism).
 */

export const PALETTES_LIGHT: string[][] = [
  // 0 â€” warm sand / earth (app.jsx)
  ['#F2D9B6', '#D9B388', '#A36F4F', '#5C3F2E', '#2E1F18', '#A8C7E6'],
  // 1 â€” moss / forest (app.jsx)
  ['#D6E8C9', '#A8C99A', '#688555', '#3F5236', '#1C2618', '#E8D6A8'],
  // 2 â€” heather / plum (app.jsx)
  ['#E8D0E0', '#C996B6', '#8E5478', '#4F2E48', '#2A1828', '#F2E8C9'],
  // 3 â€” desert / amber (app.jsx)
  ['#FFE0B0', '#D69A60', '#8B5A2B', '#3D2818', '#1A0F08', '#C9E0F2'],
  // 4 â€” teal / lagoon (app.jsx)
  ['#C9E8E0', '#8FBFB3', '#4D7E73', '#2A4A45', '#172927', '#E8D9C9'],
  // 5 â€” clay / brick (app.jsx)
  ['#E8C9C9', '#C97878', '#8B3A3A', '#4F1F1F', '#2A0F0F', '#C9D9E8'],
  // 6 â€” sui (default character â€” app.jsx line 28: ['#C9D6E8','#9DB3CE','#E6C9A8','#5A6F92','#3A4A66','#1F2A40'])
  ['#C9D6E8', '#9DB3CE', '#E6C9A8', '#5A6F92', '#3A4A66', '#1F2A40'],
  // 7 â€” autumn / russet (curated)
  ['#F3D9B1', '#E0A56A', '#B86838', '#7A3E1E', '#3D1F0E', '#C9D6E8'],
];

export const PALETTES_DARK: string[][] = [
  // 0 â€” dusk sand
  ['#3A2E22', '#594539', '#A8845E', '#D9B388', '#F0D5B0', '#7A8AA0'],
  // 1 â€” dark forest
  ['#1C2618', '#3F5236', '#688555', '#A8C99A', '#D6E8C9', '#A89368'],
  // 2 â€” twilight plum
  ['#2A1828', '#4F2E48', '#8E5478', '#C996B6', '#E8D0E0', '#A89A78'],
  // 3 â€” night desert
  ['#1A1408', '#3D2818', '#8B5A2B', '#D69A60', '#FFE0B0', '#7A8FA0'],
  // 4 â€” deep lagoon
  ['#0F1F1D', '#2A4A45', '#4D7E73', '#8FBFB3', '#C9E8E0', '#A89878'],
  // 5 â€” ember
  ['#2A0F0F', '#4F1F1F', '#8B3A3A', '#C97878', '#E8C9C9', '#7A8AA0'],
  // 6 â€” sui (dark variant â€” same family, deeper)
  ['#1F2A40', '#3A4A66', '#5A6F92', '#9DB3CE', '#C9D6E8', '#5A4A38'],
  // 7 â€” burnt autumn
  ['#3D1F0E', '#7A3E1E', '#B86838', '#E0A56A', '#F3D9B1', '#5A6F92'],
];

/**
 * FNV-1a 32-bit hash â€” same algorithm as the PixelPortrait sprite seeder
 * (matters for reproducibility across modules).
 */
function fnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pickPalette(seed: string, theme: 'light' | 'dark'): string[] {
  const list = theme === 'dark' ? PALETTES_DARK : PALETTES_LIGHT;
  const idx = fnv1a(seed) % list.length;
  return list[idx]!;
}




