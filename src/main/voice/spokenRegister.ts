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
