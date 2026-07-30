/**
 * Chat-register → spoken-register normalization (260707).
 *
 * Everything a companion says on a voice call is read aloud by TTS, but not
 * every spoken line is authored under the voice-call primer: typed-chat
 * replies, join greetings, and in-world say() lines are produced by the text
 * brain in chat register and then mirrored into the call (voice director,
 * 260707), so "lmao" and "rn" reach ElevenLabs literally and get read as
 * words. The primer handles the lines it sees; this is the deterministic
 * backstop at the synthesis boundary for the ones it doesn't.
 *
 * Applied ONLY to the text sent to TTS — chat bubbles, captions, and the
 * persona's texting tone are untouched. The list is deliberately short and
 * unambiguous: expand only tokens with one plausible spoken reading, never
 * single letters ("u") or context-dependent slang.
 */

const SPOKEN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\blmfao\b/gi, 'haha'],
  [/\blmao\b/gi, 'haha'],
  [/\blol\b/gi, 'haha'],
  [/\brn\b/gi, 'right now'],
  [/\bbrb\b/gi, 'be right back'],
  [/\bidk\b/gi, "I don't know"],
  [/\bidc\b/gi, "I don't care"],
  [/\bngl\b/gi, 'not gonna lie'],
  [/\btbh\b/gi, 'to be honest'],
  [/\bomw\b/gi, 'on my way'],
  [/\bgtg\b/gi, 'gotta go'],
  [/\bwyd\b/gi, 'what are you doing'],
  [/\bhbu\b/gi, 'how about you'],
  [/\bikr\b/gi, 'I know right'],
  [/\bnvm\b/gi, 'never mind'],
  [/\bbtw\b/gi, 'by the way'],
  [/\bimo\b/gi, 'honestly'],
  [/\bsmh\b/gi, ''],
];

/** Rewrite chat shorthand into words TTS can speak. Pure; whitespace tidied. */
export function toSpokenRegister(text: string): string {
  let out = text;
  for (const [re, spoken] of SPOKEN_REPLACEMENTS) out = out.replace(re, spoken);
  // A dropped token (smh) can leave doubled spaces or a dangling gap before
  // punctuation; collapse them so cadence stays natural.
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}

/**
 * Utterance form (260729) — the second half of the same boundary: restore the
 * sentence casing and terminal punctuation that the TEXTING register removed,
 * because to ElevenLabs those two marks are not formality, they are prosody.
 *
 * A companion line is authored as chat, where "no period at the end of a
 * sentence" is the house style (renderPunctuationDirective) and a lone period
 * is stripped from every bubble on the way out (chatService splitReply). Both
 * are right on screen and wrong in the ear: a clip whose text ends on a letter
 * is rendered with CONTINUATION prosody, so a finished thought lands with no
 * terminal pitch fall and the reply sounds cut off mid-sentence. `?` and `!`
 * survive the chat register, which is why questions always sounded finished and
 * statements never did. A lowercase opening is the same story at the other end:
 * nothing marks the first word as the start of an utterance.
 *
 * Chat bubbles, captions and the transcript keep their texting look — this runs
 * at synthesis only (voiceTts / voiceTtsStream), so it also catches speech the
 * voice-call prompt never saw: typed-chat replies mirrored onto a call and the
 * in-world bot's say() lines routed up to it.
 */

/** Sentence-final marks, plus any closers that ride after them ("hm..." / (ok?) ). */
const TERMINAL_RE = /[.!?…。！？][)\]}"'”’*»]*$/u;
/**
 * Endings that WANT a full stop: a letter, a digit, or a closer sitting after
 * one. Anything else already ends on punctuation the writer chose (a trailing
 * comma, colon or dash is a deliberate hand-off), and a stop after it would
 * read as a stumble.
 */
const NEEDS_STOP_RE = /[\p{L}\p{N})\]}"'”’*»]$/u;
/** zh/ja write the ideographic full stop; ko and the latin languages use '.'. */
function fullStopFor(language: string): string {
  return language === 'zh' || language === 'ja' ? '。' : '.';
}

/**
 * Capitalize the first letter of the clip and of any sentence that follows a
 * terminal mark inside it (the blocking reply path can bubble two sentences
 * into one clip). Leading quotes / brackets / asterisks are skipped over, and
 * caseless scripts are unaffected (toUpperCase is identity there).
 */
function restoreSentenceCase(text: string): string {
  let out = text.replace(/^([^\p{L}]*)(\p{Ll})/u, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
  out = out.replace(
    /([.!?…。！？]["'”’)\]]*\s+)([^\p{L}]*)(\p{Ll})/gu,
    (_m, boundary: string, lead: string, ch: string) => boundary + lead + ch.toUpperCase(),
  );
  return out;
}

/** Chat-register line → the form it should be READ in. Pure. */
export function toSpokenUtterance(text: string, language: string): string {
  const t = restoreSentenceCase(text.trim());
  if (!t) return t;
  if (TERMINAL_RE.test(t) || !NEEDS_STOP_RE.test(t)) return t;
  return t + fullStopFor(language);
}
