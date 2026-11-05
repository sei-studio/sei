import { describe, expect, it } from 'vitest';
import { desktopLineFace, EMOTION_FACE, isAvatarEmotion, isFaceWord } from './seilinkExpression';
import { resolveExpression } from '../bot/brain/faceExpressions.js';

describe('desktopLineFace (261105)', () => {
  it('reads the line with the call overlay lexicon when there is no tag', () => {
    expect(desktopLineFace('haha you found me')).toEqual({ emotion: 'happy', face: 'happy' });
    expect(desktopLineFace('wait, really?? you moved it?')).toEqual({ emotion: 'surprised', face: 'surprised' });
    expect(desktopLineFace('ugh, the shelf fell again')).toEqual({ emotion: 'angry', face: 'annoyed' });
    expect(desktopLineFace('stop, you are making me blush')).toEqual({ emotion: 'shy', face: 'embarrassed' });
    expect(desktopLineFace('just tidying up')).toEqual({ emotion: null, face: null });
  });

  it('a face tag wins and maps onto the Live2D emotion where one fits', () => {
    expect(desktopLineFace('haha', 'smug')).toEqual({ emotion: 'happy', face: 'smug' });
    expect(desktopLineFace('haha', 'worried')).toEqual({ emotion: 'sad', face: 'worried' });
    expect(desktopLineFace('haha', 'thinking')).toEqual({ emotion: null, face: 'thinking' });
    expect(desktopLineFace('haha', 'sleepy')).toEqual({ emotion: null, face: 'sleepy' });
  });

  it('ignores a tag that is not one plain word', () => {
    expect(desktopLineFace('haha', 'Smug!')).toEqual({ emotion: 'happy', face: 'happy' });
    expect(isFaceWord('a b')).toBe(false);
    expect(isFaceWord('../x')).toBe(false);
    expect(isAvatarEmotion('love')).toBe(true);
    expect(isAvatarEmotion('neutral')).toBe(false);
  });

  it('every lexicon emotion has a face the shared vocabulary knows', () => {
    for (const face of Object.values(EMOTION_FACE)) expect(resolveExpression(face)).toBe(face);
  });
});
