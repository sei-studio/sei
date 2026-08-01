/**
 * The rate → semitones conversion (260731).
 *
 * Everything else in pitchBus.ts is Web Audio graph plumbing that only means
 * anything against a real AudioContext; this is the one piece of arithmetic,
 * and it is the seam where the migration could silently mistune every voice in
 * the app. Character metadata still stores a frequency MULTIPLIER (so nothing
 * migrated), while the shifter is driven in SEMITONES — get this wrong by a
 * factor and Sui comes back as a different person.
 */
import { describe, it, expect } from 'vitest';
import { semitonesFromRate } from './pitchBus';
import {
  SUI_DEFAULT_PITCH_RATE,
  VOICE_PITCH_MAX,
  VOICE_PITCH_MIN,
} from '@shared/voicePitch';

describe('semitonesFromRate', () => {
  it('leaves an unpitched voice alone', () => {
    expect(semitonesFromRate(1)).toBe(0);
  });

  it('maps Sui to the +3.5 semitones her default was tuned as', () => {
    // SUI_DEFAULT_PITCH_RATE is documented as 2^(3.5/12); this is the round trip.
    expect(semitonesFromRate(SUI_DEFAULT_PITCH_RATE)).toBeCloseTo(3.5, 2);
  });

  it('is an octave at double and half', () => {
    expect(semitonesFromRate(2)).toBeCloseTo(12, 10);
    expect(semitonesFromRate(0.5)).toBeCloseTo(-12, 10);
  });

  it('keeps the slider inside a range a voice survives', () => {
    // The ends of the playground slider, in the unit the shifter actually
    // takes. Documented in shared/voicePitch.ts as roughly -2.8 .. +5.9.
    expect(semitonesFromRate(VOICE_PITCH_MIN)).toBeCloseTo(-2.8, 1);
    expect(semitonesFromRate(VOICE_PITCH_MAX)).toBeCloseTo(5.8, 1);
  });
});
