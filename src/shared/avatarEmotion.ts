/**
 * Spoken-line emotion classification for the avatar overlay (260804). Moved
 * to shared 261105 so main can classify a SeiLink desktop line too
 * (seilinkExpression.ts); the renderer re-exports it from lib/avatar/emotion.ts.
 *
 * Maps the line a companion is currently SAYING onto the closed AvatarEmotion
 * set so the Live2D tile can switch expressions while talking. Deliberately a
 * lexicon, not a model and not LLM-driven (v1): a model download is heavy for
 * a cosmetic signal, and LLM tags would touch every surface's prompt
 * contract. The whole decision sits behind this one function, so an LLM-tag
 * upgrade later replaces the call site's input, not the plumbing.
 *
 * Bilingual (en + zh) because those are the app's UI languages. English terms
 * match on word boundaries (so "mad" never fires inside "made"); Chinese
 * terms match by containment (no word boundaries to speak of).
 */
import type { AvatarEmotion } from './ipc';

interface Lexicon {
  emotion: AvatarEmotion;
  /** English word-boundary terms. */
  en: RegExp;
  /** Chinese substring terms. */
  zh: string[];
}

// Priority order doubles as the tie-break: the more specific/rarer signals
// (surprise, anger, affection) outrank the generic positive bucket.
const LEXICONS: Lexicon[] = [
  {
    emotion: 'surprised',
    en: /\b(what|whoa|woah|really|seriously|no way|huh|wait)\b|[?!]{2,}/i,
    zh: ['ä»€ä¹ˆ', 'çœŸçš„å—', 'å±…ç„¶', 'ç«Ÿç„¶', 'ä¸ä¼šå§', 'å•Šï¼Ÿ', 'æ¬¸'],
  },
  {
    emotion: 'angry',
    en: /\b(angry|mad|furious|annoyed|annoying|ugh|hmph|grr|hate)\b/i,
    zh: ['ç”Ÿæ°”', 'æ°”æ­»', 'è®¨åŽŒ', 'å“¼', 'çƒ¦æ­»', 'å¯æ¶'],
  },
  {
    emotion: 'sad',
    en: /\b(sad|sorry|cry|crying|miss you|unfortunately|sigh|aww no)\b/i,
    zh: ['éš¾è¿‡', 'ä¼¤å¿ƒ', 'å‘œ', 'å“­', 'å¯æƒœ', 'å¯¹ä¸èµ·', 'æŠ±æ­‰', 'å”‰'],
  },
  {
    emotion: 'love',
    en: /\b(love|adore|cute|adorable|sweet|darling|dear)\b|â¤|ðŸ’•|ðŸ’–/i,
    zh: ['çˆ±ä½ ', 'å–œæ¬¢ä½ ', 'å¯çˆ±', 'æœ€å–œæ¬¢', 'äº²äº²', 'ä¹ˆä¹ˆ'],
  },
  {
    emotion: 'shy',
    en: /\b(blush|blushing|shy|embarrassed|embarrassing|flustered)\b/i,
    zh: ['å®³ç¾ž', 'è„¸çº¢', 'ä¸å¥½æ„æ€', 'äººå®¶'],
  },
  {
    emotion: 'excited',
    en: /\b(wow|amazing|incredible|awesome|let'?s go|can'?t wait|hype|yes+)\b/i,
    zh: ['å“‡', 'å¤ªæ£’', 'åŽ‰å®³', 'å¥½è€¶', 'å†²', 'èµ°å§', 'æ¥å§', 'æœŸå¾…'],
  },
  {
    emotion: 'happy',
    en: /\b(happy|glad|yay|haha|hehe|lol|nice|great|fun|good job)\b|ðŸ˜Š|ðŸ˜„/i,
    zh: ['å¼€å¿ƒ', 'é«˜å…´', 'å“ˆå“ˆ', 'å˜¿å˜¿', 'å˜»å˜»', 'å¤ªå¥½äº†', 'ä¸é”™', 'æ£’'],
  },
];

/**
 * Which emotions may borrow a neighbor's expression when the model maps
 * nothing for them (260806). Real VTuber exports rarely ship a dedicated
 * "happy" or "surprised" face, and those are the two classifications casual
 * talk fires most, so without a fallback the feature reads as unwired: five
 * mapped expressions and a face that never changes. Only positive/high-energy
 * emotions substitute for each other; sad/angry/shy are never faked with
 * something else (a wrong negative face is worse than a neutral one).
 */
const EMOTION_FALLBACKS: Partial<Record<AvatarEmotion, AvatarEmotion[]>> = {
  happy: ['excited'],
  excited: ['happy'],
  surprised: ['excited', 'happy'],
  love: ['happy'],
};

/**
 * Resolve an emotion to the model's expression name via the manifest table,
 * trying the fallback chain when the direct mapping is absent. Null = stay on
 * (or decay to) the neutral face.
 */
export function resolveEmotionExpression(
  emotions: Partial<Record<AvatarEmotion, string>> | undefined,
  emotion: AvatarEmotion | null | undefined,
): string | null {
  if (!emotions || !emotion) return null;
  for (const candidate of [emotion, ...(EMOTION_FALLBACKS[emotion] ?? [])]) {
    const name = emotions[candidate];
    if (name) return name;
  }
  return null;
}

/**
 * Classify one spoken line, or null when nothing clearly matches (the tile
 * stays on / decays to its neutral face). First lexicon with a hit wins.
 */
export function classifyEmotion(text: string | null | undefined): AvatarEmotion | null {
  if (!text) return null;
  const line = text.trim();
  if (!line) return null;
  for (const lex of LEXICONS) {
    if (lex.en.test(line)) return lex.emotion;
    if (lex.zh.some((term) => line.includes(term))) return lex.emotion;
  }
  return null;
}




