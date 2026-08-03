import { describe, it, expect } from 'vitest';
import { shapeScreenText, SCREEN_TEXT_MIN_CONFIDENCE, type OcrLine } from './screenText';

const l = (text: string, confidence = 100): OcrLine => ({ text, confidence });

describe('shapeScreenText', () => {
  it('keeps confident lines in reading order, separated so the layout survives', () => {
    // The 260803 change: these are three separate things at three places on
    // screen, and joining them with spaces invented the phrase "A Site SPIKE
    // PLANTED 1,550" that nobody ever wrote.
    expect(shapeScreenText([l('A Site'), l('SPIKE PLANTED'), l('1,550')], 80)).toBe(
      'A Site / SPIKE PLANTED / 1,550',
    );
  });

  it('drops lines the engine was not sure about', () => {
    // The single most valuable filter. Measured over 94 frames of the Valorant
    // clip, every Vision line under this bar was garbage and every line at 100
    // was real, so the bar is doing exactly one job and doing it cleanly.
    const lines = [l('VANDAL'), l('кL02 4', SCREEN_TEXT_MIN_CONFIDENCE - 1), l('250')];
    expect(shapeScreenText(lines, 80)).toBe('VANDAL / 250');
  });

  it('strips junk tokens inside a line but keeps digits', () => {
    // HUD borders and crosshairs produce these at full confidence, so the
    // confidence filter alone does not remove them.
    expect(shapeScreenText([l('| ~ z 4 A HEALTH')], 80)).toBe('4 A HEALTH');
  });

  it('drops a line that is nothing but junk', () => {
    expect(shapeScreenText([l('| ~ z'), l('SPIKE')], 80)).toBe('SPIKE');
  });

  it('collapses a stuttering repeat rather than letting it fill the cap', () => {
    expect(shapeScreenText([l('KILLED BY'), l('KILLED BY'), l('killed by'), l('Jett')], 80)).toBe(
      'KILLED BY / Jett',
    );
  });

  it('caps at whole lines and says how much it dropped', () => {
    // The context-management case: an essay, a patch note, a wiki page. Without
    // the marker the model reads a truncated opening as the whole screen.
    const lines = Array.from({ length: 40 }, (_, i) => l(`line${i} alpha beta gamma delta`));
    const out = shapeScreenText(lines, 12);
    // 12 words of budget = two whole 5-word lines, then a third would overflow,
    // so it stops rather than taking three words of it.
    expect(out).toBe(
      'line0 alpha beta gamma delta / line1 alpha beta gamma delta [...190 more words on screen]',
    );
  });

  it('cuts inside a line only when that line alone exceeds the budget', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const out = shapeScreenText([l(words)], 80);
    expect(out.startsWith('word0 word1')).toBe(true);
    expect(out).toContain('[...120 more words on screen]');
    expect(out.split(' ').slice(0, 80).every((t) => t.startsWith('word'))).toBe(true);
  });

  it('keeps the FRONT, unlike the audio transcript which keeps the tail', () => {
    // Deliberate and opposite: speech has an ordering in time so the newest
    // words matter most, while a screen is laid out top-left to bottom-right so
    // the front is the headline.
    expect(shapeScreenText([l('headline'), l('body'), l('footnote')], 1)).toBe(
      'headline [...2 more words on screen]',
    );
  });

  it('returns empty when nothing survives, so the tick omits the field', () => {
    expect(shapeScreenText([], 80)).toBe('');
    expect(shapeScreenText([l('| ~'), l('x', 10)], 80)).toBe('');
  });
});
