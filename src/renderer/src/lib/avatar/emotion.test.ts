/** classifyEmotion (260804) — bilingual lexicon over spoken lines. */
import { describe, it, expect } from 'vitest';
import { classifyEmotion, resolveEmotionExpression } from './emotion';

describe('classifyEmotion', () => {
  it('returns null for empty/neutral lines', () => {
    expect(classifyEmotion(null)).toBeNull();
    expect(classifyEmotion('')).toBeNull();
    expect(classifyEmotion('   ')).toBeNull();
    expect(classifyEmotion('I put the ore in the chest.')).toBeNull();
    expect(classifyEmotion('我把矿石放进箱子了。')).toBeNull();
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
    expect(classifyEmotion('哈哈太好了！')).toBe('happy');
    expect(classifyEmotion('呜呜，好难过')).toBe('sad');
    expect(classifyEmotion('哼，气死我了')).toBe('angry');
    expect(classifyEmotion('你真可爱')).toBe('love');
    expect(classifyEmotion('哇，是钻石！')).toBe('excited');
    expect(classifyEmotion('欸，居然是这样')).toBe('surprised');
    expect(classifyEmotion('人家会不好意思的啦')).toBe('shy');
  });

  it('does not match English keywords inside other words', () => {
    // "mad" inside "made", "sad" inside "asadero" must not fire.
    expect(classifyEmotion('I made a chest')).toBeNull();
    expect(classifyEmotion('some asadero cheese')).toBeNull();
  });

  it('开心 reads as happy, not love (bare 心 is deliberately not a keyword)', () => {
    expect(classifyEmotion('今天真开心')).toBe('happy');
  });
});

describe('resolveEmotionExpression', () => {
  // The Snow Bear Girl shape: no happy, no surprised — the two most common
  // classifications must still land on a face.
  const snowBear = {
    sad: '6 泪',
    shy: '7 害羞',
    angry: '8 生气',
    love: '9 爱心眼',
    excited: '10 星星眼',
  } as const;

  it('prefers the direct mapping', () => {
    expect(resolveEmotionExpression(snowBear, 'sad')).toBe('6 泪');
    expect(resolveEmotionExpression(snowBear, 'excited')).toBe('10 星星眼');
  });

  it('falls back for happy and surprised when unmapped', () => {
    expect(resolveEmotionExpression(snowBear, 'happy')).toBe('10 星星眼');
    expect(resolveEmotionExpression(snowBear, 'surprised')).toBe('10 星星眼');
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
