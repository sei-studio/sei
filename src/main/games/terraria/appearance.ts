/**
 * The companion's Terraria look (261113), taken from the character's stored
 * farmer look (src/main/games/stardew/appearance.ts): one LLM derivation per
 * character, cached and shared, so Terraria adds no per-summon cost. Only
 * what carries over cleanly is mapped: skin tone, hair, eye and trouser
 * colours. Hair style and clothes stay the mod's defaults (Terraria's hair
 * styles have no description list to match against).
 */
import type { StardewAppearance } from '../../../shared/stardewAppearance';

/** STARDEW_SKIN_LEGEND ids → a Terraria skin colour of the same tone. */
export const SKIN_HEX: Readonly<Record<number, string>> = Object.freeze({
  0: '#f5c8a8', 1: '#d29b6e', 2: '#e0b088', 3: '#f2cdb0', 4: '#a86b45', 5: '#8a5634',
  6: '#6b3e22', 7: '#d6a060', 8: '#9a7550', 9: '#f5c6c0', 10: '#d8d0cc', 11: '#d89c68',
  12: '#f8e6d2', 13: '#f2b0a8', 14: '#4a2a18', 15: '#c8805a', 16: '#6a8cd8', 17: '#6ab86a',
  18: '#d86060', 19: '#9a6ad0', 20: '#e8c850', 21: '#d8d8d8', 22: '#fad9c0', 23: '#fce8da',
});

const HEX = /^#[0-9a-f]{6}$/i;

/** The spawn frame's `appearance` (native/terraria-mod/PROTOCOL.md). */
export function terrariaAppearanceFrom(look: StardewAppearance): Record<string, string> {
  const out: Record<string, string> = {};
  const skin = SKIN_HEX[look.skin];
  if (skin) out.skinColor = skin;
  if (HEX.test(look.hairColor)) out.hairColor = look.hairColor.toLowerCase();
  if (HEX.test(look.eyeColor)) out.eyeColor = look.eyeColor.toLowerCase();
  if (HEX.test(look.pantsColor)) out.pantsColor = look.pantsColor.toLowerCase();
  return out;
}
