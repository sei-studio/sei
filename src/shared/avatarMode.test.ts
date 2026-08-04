/** effectiveAvatarMode (260804) — the deprecated-boolean fold. */
import { describe, it, expect } from 'vitest';
import { effectiveAvatarMode } from './characterSchema';

describe('effectiveAvatarMode', () => {
  it('absent everything means off', () => {
    expect(effectiveAvatarMode({})).toBe('off');
    expect(effectiveAvatarMode({ call_overlay_enabled: false })).toBe('off');
  });

  it("the old call-overlay toggle maps to 'activity' (its historical behavior)", () => {
    expect(effectiveAvatarMode({ call_overlay_enabled: true })).toBe('activity');
  });

  it('an explicit avatar_mode always wins over the deprecated boolean', () => {
    expect(effectiveAvatarMode({ avatar_mode: 'off', call_overlay_enabled: true })).toBe('off');
    expect(effectiveAvatarMode({ avatar_mode: 'always', call_overlay_enabled: false })).toBe(
      'always',
    );
    expect(effectiveAvatarMode({ avatar_mode: 'activity' })).toBe('activity');
  });
});
