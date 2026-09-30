/**
 * Text-driven effective language for LOCAL TTS (260908).
 *
 * The conversation language (chat_language) says what the SESSION is in; a
 * single line can still be Chinese inside an English conversation (a taught
 * phrase, a bilingual companion, a quoted lyric). The local pack pick and the
 * missing-pack notice in voice/tts.ts synthesizeLocalClip both keyed on the
 * conversation language alone, so a predominantly Chinese line in an 'en'
 * conversation was spoken by the English pack with no notice even when the
 * Chinese pack was the better fit (installed or downloadable). This helper
 * upgrades the clip's language to 'zh' when the TEXT ITSELF is predominantly
 * Chinese, so the line prefers an installed zh pack and a missing one is
 * named in the notice.
 *
 * Detection is HAN-ONLY, by decision: Han is the script the aishell3 pack can
 * actually read, and it is what separates a Chinese line from a Latin one.
 * Kana (hiragana/katakana/halfwidth katakana) can only be Japanese, which no
 * local pack speaks, so any kana in the line VETOES the zh upgrade — a
 * Japanese sentence's kanji must not route it to the Chinese voice. Hangul is
 * simply not Han and never counts. "Predominant" means either of:
 *   - Han characters are more than HAN_SHARE_THRESHOLD of the line's letters
 *     (mirrors the CJK_PIN_RATIO reasoning in voice/tts.ts: one quoted hanzi
 *     in an English line must not flip the whole clip), or
 *   - the line carries a run of HAN_RUN_MIN consecutive Han characters (a
 *     real Chinese phrase, even inside a longer English sentence — Chinese
 *     needs no spaces, so three-in-a-row is already a phrase, while loanword
 *     mentions are one or two characters).
 *
 * Pure and dependency-free so it unit-tests without the engine.
 */

/** Han ideographs (URO + Ext-A + compatibility) — matches voice/tts.ts. */
const HAN_CHAR = '一-鿿㐀-䶿豈-﫿';
const HAN_RE = new RegExp(`[${HAN_CHAR}]`, 'gu');
const HAN_RUN_MIN = 3;
const HAN_RUN_RE = new RegExp(`[${HAN_CHAR}]{${HAN_RUN_MIN},}`, 'u');
/** Kana (hiragana, katakana, katakana extensions, halfwidth katakana):
 * Japanese-only script — its presence vetoes the zh upgrade. */
const KANA_RE = /[぀-ヿㇰ-ㇿｦ-ﾟ]/u;
const LETTER_RE = /\p{L}/gu;
const HAN_SHARE_THRESHOLD = 0.3;

/**
 * The language this line should be SPOKEN in: 'zh' when the text is
 * predominantly Chinese (see the module doc for what that means), otherwise
 * the conversation language unchanged.
 */
export function detectSpokenLanguage<T extends string>(text: string, chatLanguage: T): T | 'zh' {
  if (chatLanguage === 'zh') return chatLanguage;
  if (KANA_RE.test(text)) return chatLanguage;
  const letters = text.match(LETTER_RE)?.length ?? 0;
  if (!letters) return chatLanguage;
  const han = text.match(HAN_RE)?.length ?? 0;
  if (!han) return chatLanguage;
  if (han / letters > HAN_SHARE_THRESHOLD || HAN_RUN_RE.test(text)) return 'zh';
  return chatLanguage;
}
