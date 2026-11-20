import { describe, expect, it } from 'vitest';
import { CLICK_REACT_KEYFRAMES, CLICK_REACT_MS, ClickReaction, PRESS_COVERS_CLICK_MS } from './clickReaction';

describe('ClickReaction (261119: one slight reaction per click)', () => {
  it('reacts once to a click: the press reacts, the click that follows it does not', () => {
    const r = new ClickReaction();
    expect(r.press(1_000)).toBe(true);
    // The host sends the click after the double-click time (500 ms).
    expect(r.click(1_560)).toBe(false);
  });

  it('a click with no press before it still reacts (a bridge without presses)', () => {
    const r = new ClickReaction();
    expect(r.click(1_000)).toBe(true);
    expect(r.click(1_000 + CLICK_REACT_MS + 1)).toBe(true);
  });

  it('never restarts or piles up while a reaction plays', () => {
    const r = new ClickReaction();
    expect(r.press(0)).toBe(true);
    expect(r.press(CLICK_REACT_MS - 1)).toBe(false);
    expect(r.press(CLICK_REACT_MS + 1)).toBe(true);
  });

  it('a later, separate click reacts again', () => {
    const r = new ClickReaction();
    expect(r.press(0)).toBe(true);
    expect(r.click(560)).toBe(false);
    expect(r.press(5_000)).toBe(true);
    expect(r.click(5_000 + PRESS_COVERS_CLICK_MS + 1)).toBe(true);
  });

  it('is slight: at most a 1% squash, under 300 ms', () => {
    expect(CLICK_REACT_MS).toBeLessThanOrEqual(300);
    for (const k of CLICK_REACT_KEYFRAMES) {
      const m = /scale\(([\d.]+), ([\d.]+)\)/.exec(String(k.transform));
      expect(m).not.toBeNull();
      expect(Math.abs(Number(m?.[1]) - 1)).toBeLessThanOrEqual(0.0101);
      expect(Math.abs(Number(m?.[2]) - 1)).toBeLessThanOrEqual(0.0101);
      expect(String(k.transform)).not.toContain('translate');
    }
    // Back where she started.
    expect(CLICK_REACT_KEYFRAMES[CLICK_REACT_KEYFRAMES.length - 1].transform).toBe('scale(1, 1)');
  });
});
