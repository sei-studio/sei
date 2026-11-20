import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceThumbPx, thumbScale } from './roomThumbs';

describe('thumbnail scale (261110: crisp on 150% and Retina screens)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sizes thumbnails in device px, the screen scale clamped to 1..3', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1.5 });
    expect(thumbScale()).toBe(1.5);
    expect(deviceThumbPx(150)).toBe(225);
    vi.stubGlobal('window', { devicePixelRatio: 4 });
    expect(thumbScale()).toBe(3);
    vi.stubGlobal('window', { devicePixelRatio: 0 });
    expect(thumbScale()).toBe(1);
  });
});
