/** classifyEmotion (260804) â€” bilingual lexicon over spoken lines. */
import { describe, it, expect } from 'vitest';
import { classifyEmotion, resolveEmotionExpression } from './emotion';

describe('classifyEmotion', () => {
  it('returns null for empty/neutral lines', () => {
    expect(classifyEmotion(null)).toBeNull();
    expect(classifyEmotion('')).toBeNull();
    expect(classifyEmotion('   ')).toBeNull();
    expect(classifyEmotion('I put the ore in the chest.')).toBeNull();
    expect(classifyEmotion('æˆ‘æŠŠçŸ¿çŸ³æ”¾è¿›ç®±å­äº†ã€‚')).toBeNull();
  });

  it('classifies English lines', () => {
    expect(classifyEmotion('haha that was great!')).toBe('happy');
    expect(classifyEmotion("I'm so sorry about that...")).toBe('sad');
    expect(classifyEmotion('ugh, this creeper is so annoying')).toBe('angry');
    expect(classifyEmotion('you are adorable')).toBe('love');
    expect(classifyEmotion('wow, a diamond!')).toBe('excited');
    expect(classifyEmotion('wait, what just happened')).toBe('surprised');
    expect(classifyEmotion("oh no I'm blushing")).toBe('shy');
  });

  it('classifies Chinese lines', () => {
    expect(classifyEmotion('å“ˆå“ˆå¤ªå¥½äº†ï¼')).toBe('happy');
    expect(classifyEmotion('å‘œå‘œï¼Œå¥½éš¾è¿‡')).toBe('sad');
    expect(classifyEmotion('å“¼ï¼Œæ°”æ­»æˆ‘äº†')).toBe('angry');
    expect(classifyEmotion('ä½ çœŸå¯çˆ±')).toBe('love');
    expect(classifyEmotion('å“‡ï¼Œæ˜¯é’»çŸ³ï¼')).toBe('excited');
    expect(classifyEmotion('æ¬¸ï¼Œå±…ç„¶æ˜¯è¿™æ ·')).toBe('surprised');
    expect(classifyEmotion('äººå®¶ä¼šä¸å¥½æ„æ€çš„å•¦')).toBe('shy');
  });

  it('does not match English keywords inside other words', () => {
    // "mad" inside "made", "sad" inside "asadero" must not fire.
    expect(classifyEmotion('I made a chest')).toBeNull();
    expect(classifyEmotion('some asadero cheese')).toBeNull();
  });

  it('å¼€å¿ƒ reads as happy, not love (bare å¿ƒ is deliberately not a keyword)', () => {
    expect(classifyEmotion('ä»Šå¤©çœŸå¼€å¿ƒ')).toBe('happy');
  });
});

describe('resolveEmotionExpression', () => {
  // The Snow Bear Girl shape: no happy, no surprised â€” the two most common
  // classifications must still land on a face.
  const snowBear = {
    sad: '6 æ³ª',
    shy: '7 å®³ç¾ž',
    angry: '8 ç”Ÿæ°”',
    love: '9 çˆ±å¿ƒçœ¼',
    excited: '10 æ˜Ÿæ˜Ÿçœ¼',
  } as const;

  it('prefers the direct mapping', () => {
    expect(resolveEmotionExpression(snowBear, 'sad')).toBe('6 æ³ª');
    expect(resolveEmotionExpression(snowBear, 'excited')).toBe('10 æ˜Ÿæ˜Ÿçœ¼');
  });

  it('falls back for happy and surprised when unmapped', () => {
    expect(resolveEmotionExpression(snowBear, 'happy')).toBe('10 æ˜Ÿæ˜Ÿçœ¼');
    expect(resolveEmotionExpression(snowBear, 'surprised')).toBe('10 æ˜Ÿæ˜Ÿçœ¼');
  });

  it('walks the fallback chain in order', () => {
    expect(resolveEmotionExpression({ happy: 'smile' }, 'surprised')).toBe('smile');
    expect(resolveEmotionExpression({ excited: 'stars', happy: 'smile' }, 'surprised')).toBe(
      'stars',
    );
  });

  it('never fakes negative emotions', () => {
    expect(resolveEmotionExpression({ happy: 'smile', excited: 'stars' }, 'sad')).toBeNull();
    expect(resolveEmotionExpression({ happy: 'smile', excited: 'stars' }, 'angry')).toBeNull();
    expect(resolveEmotionExpression({ happy: 'smile', excited: 'stars' }, 'shy')).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(resolveEmotionExpression(undefined, 'happy')).toBeNull();
    expect(resolveEmotionExpression({}, 'happy')).toBeNull();
    expect(resolveEmotionExpression(snowBear, null)).toBeNull();
  });
});




