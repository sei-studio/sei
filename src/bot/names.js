// In-game name derivation, shared by the bot, main and the renderer (261027).
//
// Lives in src/bot because the bot runs from app.asar.unpacked and cannot
// import src/shared at runtime; main and the renderer import this file
// directly (types in names.d.ts). Pure: no imports, no Node or DOM APIs.
//
// Why: a character with no explicit `username` plays under its display name
// filtered to Minecraft's [A-Za-z0-9_]. The filter used to run on the raw
// name, so every accented letter was DELETED: "Sofía" joined as "Sofa",
// "Lucía" as "Luca", "Élodie" as "lodie". Shawn (msg 901): "For accents just
// replace those letters for in game". foldLatin() replaces each accented
// Latin letter with its plain one first, then the existing filter runs.

/**
 * Latin letters NFKD does not decompose into base + combining mark, mapped by
 * hand. Everything else (é, ö, ñ, ǎ, ç, ...) is handled by NFKD.
 */
const UNDECOMPOSED = {
  'ß': 'ss', 'ẞ': 'SS',
  'ø': 'o', 'Ø': 'O',
  'æ': 'ae', 'Æ': 'AE',
  'œ': 'oe', 'Œ': 'OE',
  'ł': 'l', 'Ł': 'L',
  'đ': 'd', 'Đ': 'D',
  'ð': 'd', 'Ð': 'D',
  'þ': 'th', 'Þ': 'Th',
  'ı': 'i', 'İ': 'I',
  'ħ': 'h', 'Ħ': 'H',
}
const UNDECOMPOSED_RE = /[ßẞøØæÆœŒłŁđĐðÐþÞıİħĦ]/g

// A Latin-script letter plus any combining marks that follow it (so a name
// typed in decomposed form, "Sofía", folds the same as "Sofía").
// Restricted to Script=Latin on purpose: Japanese, Chinese, Korean, Cyrillic,
// Greek and every other script pass through untouched, so their in-game
// names stay exactly what they were before this change.
const LATIN_CLUSTER_RE = /\p{Script=Latin}\p{M}*/gu

/**
 * Replace each accented Latin letter with its plain ASCII letter(s):
 * Sofía -> Sofia, Björn -> Bjorn, Łukasz -> Lukasz, Straße -> Strasse,
 * Søren -> Soren, İpek -> Ipek. Characters of other scripts, digits,
 * punctuation and spaces are returned unchanged. Does NOT filter or truncate;
 * callers apply their own game's character rule afterwards.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function foldLatin(input) {
  return String(input ?? '').replace(LATIN_CLUSTER_RE, (cluster) => {
    if (cluster.length === 1 && cluster.charCodeAt(0) < 0x80) return cluster
    return cluster
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(UNDECOMPOSED_RE, (c) => UNDECOMPOSED[c])
  })
}

/** Minecraft usernames are at most 16 characters. */
export const MC_USERNAME_MAX = 16

/**
 * The Minecraft login name derived from a display name: accents folded, then
 * filtered to [A-Za-z0-9_], cut to 16, 'Sei' when nothing is left. No
 * minimum-length padding (the runtime never had one; the 3-character floor is
 * enforced on the generated-name pool instead).
 *
 * @param {unknown} name
 * @returns {string}
 */
export function mcUsernameFromName(name) {
  const cleaned = foldLatin(name).replace(/[^A-Za-z0-9_]/g, '').slice(0, MC_USERNAME_MAX)
  return cleaned || 'Sei'
}

/**
 * The rule before 261027 (accents deleted, not folded). Kept ONLY so lookups
 * keyed by the old in-game name (the skin server) can still find a character
 * whose name changed. Never use it to pick the name a body logs in under.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function legacyMcUsernameFromName(name) {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, MC_USERNAME_MAX)
  return cleaned || 'Sei'
}

/** Stardew companion names are display names: spaces allowed, 24 chars. */
export const STARDEW_NAME_MAX = 24

/**
 * The Stardew Valley companion name from a raw name (the explicit username or
 * the display name): accents folded, filtered to [A-Za-z0-9_ -], trimmed, cut
 * to 24, 'Sei' when nothing is left. The SMAPI mod (SeiBody.SanitizeName)
 * applies the same filter again on its side, which is a no-op on this output.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function stardewNameFromRaw(raw) {
  const cleaned = foldLatin(raw).replace(/[^A-Za-z0-9_ \-]/g, '').trim().slice(0, STARDEW_NAME_MAX)
  return cleaned || 'Sei'
}
