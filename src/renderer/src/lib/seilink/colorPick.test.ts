import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { frameThrottle, hexToHsv, hsvToHex, parseHex, pushRecent, readRecentColors, rememberRecentColor, RECENT_MAX } from './colorPick';

describe('colour math', () => {
  it('parses what she types', () => {
    expect(parseHex('abc')).toBe('#aabbcc');
    expect(parseHex(' #A1B2C3 ')).toBe('#a1b2c3');
    expect(parseHex('a1b2c3')).toBe('#a1b2c3');
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('red')).toBeNull();
  });

  it('round-trips hex through hsv', () => {
    for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#c27a5c', '#7fb0ff', '#424b63', '#b5c2a0']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: 120, s: 2, v: -1 })).toBe('#000000');
  });

  it('keeps the hue of a grey (the slider does not jump)', () => {
    expect(hexToHsv('#808080', 210).h).toBe(210);
    expect(hexToHsv('#808080', 210).s).toBe(0);
  });
});

describe('recent colours', () => {
  // Minimal in-memory localStorage (the node test environment has none).
  beforeEach(() => {
    const m = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
  });

  it('reads nothing when storage is blocked', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    expect(readRecentColors()).toEqual([]);
    expect(() => rememberRecentColor('#101010')).not.toThrow();
  });

  it('moves a pick to the front, without repeats, capped', () => {
    let l: string[] = [];
    for (const c of ['#111111', '#222222', '#333333', '#111111']) l = pushRecent(l, c);
    expect(l).toEqual(['#111111', '#333333', '#222222']);
    for (let i = 0; i < 10; i++) l = pushRecent(l, `#0000${i}${i}`);
    expect(l).toHaveLength(RECENT_MAX);
    expect(pushRecent(l, 'nope')).toEqual(l);
  });

  it('persists per user and survives junk', () => {
    rememberRecentColor('#ABCDEF');
    expect(readRecentColors()[0]).toBe('#abcdef');
    localStorage.setItem('sei.seilinkRecentColors', '{"x":1}');
    expect(readRecentColors()).toEqual([]);
    localStorage.setItem('sei.seilinkRecentColors', '["#123456","nope","#123456",4]');
    expect(readRecentColors()).toEqual(['#123456']);
  });
});

describe('frameThrottle', () => {
  it('sends the latest value once per frame, flush sends now', () => {
    const sent: number[] = [];
    let frame: (() => void) | null = null;
    const th = frameThrottle<number>(
      (v) => sent.push(v),
      (cb) => {
        frame = cb;
        return 1;
      },
      () => {
        frame = null;
      },
    );
    th.push(1);
    th.push(2);
    th.push(3);
    expect(sent).toEqual([]);
    (frame as unknown as () => void)();
    expect(sent).toEqual([3]);
    th.push(4);
    th.flush();
    expect(sent).toEqual([3, 4]);
    th.push(5);
    th.cancel();
    th.flush();
    expect(sent).toEqual([3, 4]);
  });
});
