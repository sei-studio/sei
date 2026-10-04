/**
 * Roblox game titles, cleaned for display (261004).
 *
 * Roblox titles carry marketing tags: "[🎃] Adopt Me!", "[SKY ASSASSIN]
 * Jujutsu Shenanigans", "Brookhaven 🏡RP", "🎃 Dandy's World [ALPHA]". Those
 * are fine on the store page and noise on a card caption. This cleans the
 * DATA title for display; it never touches anything the model says.
 */

/** Emoji and their glue (ZWJ, variation selectors, skin tones, flags). */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu;

/** A bracketed tag at the start: [UPD], 【NEW】, (X2 EVENT)... */
const LEAD_TAG = /^\s*(?:\[[^\]]*\]|【[^】]*】|〔[^〕]*〕|\([^)]*\)|（[^）]*）|\{[^}]*\})/u;
/** A square-bracketed tag at the end: [ALPHA], [TD]. */
const TRAIL_TAG = /(?:\[[^\]]*\]|【[^】]*】|〔[^〕]*〕)\s*$/u;
/** A trailing parenthesis, only when it shouts like a tag: (UPD 5), (BETA).
 *  "(Book 2)" has lowercase letters and is part of the name. */
const TRAIL_PAREN = /[(（]([^)）]*)[)）]\s*$/u;
/** Separators left dangling once a tag is gone: "[UPD] - Game". */
const EDGE_SEP = /^[\s\-–—|:•·,~]+|[\s\-–—|:•·,~]+$/gu;

/**
 * The title without its marketing: leading/trailing bracketed tags and every
 * emoji removed, whitespace collapsed. Falls back to the trimmed raw title if
 * nothing would be left (a title that is only a tag or only emoji).
 */
export function cleanGameTitle(raw: string): string {
  let s = raw.replace(EMOJI, ' ');
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(EDGE_SEP, '').replace(LEAD_TAG, '').replace(TRAIL_TAG, '');
    const paren = TRAIL_PAREN.exec(s);
    if (paren && !/\p{Ll}/u.test(paren[1])) s = s.slice(0, paren.index);
    if (s === before) break;
  }
  s = s.replace(EDGE_SEP, '').replace(/\s+/gu, ' ').trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : raw.trim();
}
