import { describe, it, expect } from 'vitest';
import { shapeScreenText, SCREEN_TEXT_MIN_CONFIDENCE, type OcrWord } from './screenText';

const w = (text: string, confidence = 90): OcrWord => ({ text, confidence });

describe('shapeScreenText', () => {
  it('keeps confident words in reading order', () => {
    expect(shapeScreenText([w('A'), w('Site'), w('SPIKE')], 80)).toBe('A Site SPIKE');
  });

  it('drops words the engine was not sure about', () => {
    // The single most valuable filter: OCR over a game frame emits plausible
    // nonsense at low confidence, and the model has no way to tell an artefact
    // from a word that was really on screen.
    const words = [w('VANDAL'), w('Zq', SCREEN_TEXT_MIN_CONFIDENCE - 1), w('250')];
    expect(shapeScreenText(words, 80)).toBe('VANDAL 250');
  });

  it('drops punctuation soup and stray single letters, but keeps digits', () => {
    // Measured on the Valorant clip: HUD borders and crosshairs produce these
    // at high confidence, so the confidence filter alone does not remove them.
    expect(shapeScreenText([w('|'), w('~'), w('""'), w('z'), w('4'), w('A')], 80)).toBe('4 A');
  });

  it('collapses a stuttering repeat rather than letting it fill the cap', () => {
    expect(shapeScreenText([w('KILLED'), w('KILLED'), w('killed'), w('Jett')], 80)).toBe(
      'KILLED Jett',
    );
  });

  it('caps long text and says that it did', () => {
    // The context-management case: an essay, a patch note, a wiki page. Without
    // the marker the model reads a truncated opening as the whole screen.
    const words = Array.from({ length: 200 }, (_, i) => w(`word${i}`));
    const out = shapeScreenText(words, 80);
    expect(out.startsWith('word0 word1')).toBe(true);
    expect(out).toContain('[...120 more words on screen]');
    expect(out.split(' ').slice(0, 80).every((t) => t.startsWith('word'))).toBe(true);
  });

  it('keeps the FRONT, unlike the audio transcript which keeps the tail', () => {
    // Deliberate and opposite: speech has an ordering in time so the newest
    // words matter most, while a screen is laid out top-left to bottom-right so
    // the front is the headline.
    const words = [w('headline'), w('body'), w('footnote')];
    expect(shapeScreenText(words, 1)).toBe('headline [...2 more words on screen]');
  });

  it('returns empty when nothing survives, so the tick omits the field', () => {
    expect(shapeScreenText([], 80)).toBe('');
    expect(shapeScreenText([w('|'), w('x', 10)], 80)).toBe('');
  });
});
