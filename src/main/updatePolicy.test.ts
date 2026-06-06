/**
 * updatePolicy.test.ts — quick/260604-uoy Task 2.
 *
 * Locks in the pure policy decisions that gate the in-app updater:
 *   - deriveLevel: minor/major → optional, patch-only → mandatory, equal /
 *     downgrade / invalid → none, multi-version skip with a minor diff →
 *     optional (the skipped patch rides inside the minor).
 *   - isPatchOnlyBump: forward patch-only true; minor/major/equal/down false.
 *   - normalizeApply: 'now' passes through; everything else → 'on-restart'.
 *   - shouldShowWhatsNew: patch-only forward bump only.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveLevel,
  isPatchOnlyBump,
  normalizeApply,
  shouldShowWhatsNew,
} from './updatePolicy';

describe('deriveLevel', () => {
  it('patch-only bump → mandatory', () => {
    expect(deriveLevel('0.1.1', '0.1.2')).toBe('mandatory');
    expect(deriveLevel('0.1.1', '0.1.5')).toBe('mandatory');
    expect(deriveLevel('1.4.0', '1.4.1')).toBe('mandatory');
  });

  it('minor bump → optional', () => {
    expect(deriveLevel('0.1.1', '0.2.0')).toBe('optional');
    expect(deriveLevel('1.0.0', '1.1.0')).toBe('optional');
  });

  it('major bump → optional', () => {
    expect(deriveLevel('0.1.1', '1.0.0')).toBe('optional');
    expect(deriveLevel('1.9.9', '2.0.0')).toBe('optional');
  });

  it('multi-version skip with a minor diff → optional (skipped patch rides along)', () => {
    // On 0.1.1, latest 0.2.0 — the minor component moved, so even though a
    // patch was skipped (0.1.2), the level is optional, not mandatory.
    expect(deriveLevel('0.1.1', '0.2.0')).toBe('optional');
    // On 0.1.1, latest 0.2.3 — minor moved AND patch moved → still optional.
    expect(deriveLevel('0.1.1', '0.2.3')).toBe('optional');
  });

  it('equal version → none', () => {
    expect(deriveLevel('0.1.2', '0.1.2')).toBe('none');
    expect(deriveLevel('1.0.0', '1.0.0')).toBe('none');
  });

  it('downgrade → none (never act on an older remote version)', () => {
    expect(deriveLevel('0.2.0', '0.1.1')).toBe('none');
    expect(deriveLevel('1.0.0', '0.9.9')).toBe('none');
  });

  it('invalid / unparseable versions → none (defensive)', () => {
    expect(deriveLevel('0.1.1', 'not-a-version')).toBe('none');
    expect(deriveLevel('garbage', '0.1.2')).toBe('none');
    expect(deriveLevel('', '0.1.2')).toBe('none');
  });

  it('tolerates a leading v prefix', () => {
    expect(deriveLevel('v0.1.1', 'v0.1.2')).toBe('mandatory');
    expect(deriveLevel('v0.1.1', 'v0.2.0')).toBe('optional');
  });
});

describe('isPatchOnlyBump', () => {
  it('true for a forward patch-only bump', () => {
    expect(isPatchOnlyBump('0.1.1', '0.1.2')).toBe(true);
    expect(isPatchOnlyBump('1.4.0', '1.4.9')).toBe(true);
  });

  it('false for minor or major bumps', () => {
    expect(isPatchOnlyBump('0.1.1', '0.2.0')).toBe(false);
    expect(isPatchOnlyBump('0.1.1', '1.0.0')).toBe(false);
  });

  it('false for equal versions and downgrades', () => {
    expect(isPatchOnlyBump('0.1.2', '0.1.2')).toBe(false);
    expect(isPatchOnlyBump('0.1.2', '0.1.1')).toBe(false);
  });

  it('false for invalid versions', () => {
    expect(isPatchOnlyBump('0.1.1', 'nope')).toBe(false);
    expect(isPatchOnlyBump('', '0.1.2')).toBe(false);
  });
});

describe('normalizeApply', () => {
  it("passes 'now' through", () => {
    expect(normalizeApply('now')).toBe('now');
  });

  it("defaults to 'on-restart' for the literal", () => {
    expect(normalizeApply('on-restart')).toBe('on-restart');
  });

  it("defaults to 'on-restart' for absent / invalid / wrong-type input", () => {
    expect(normalizeApply(undefined)).toBe('on-restart');
    expect(normalizeApply(null)).toBe('on-restart');
    expect(normalizeApply('')).toBe('on-restart');
    expect(normalizeApply('NOW')).toBe('on-restart');
    expect(normalizeApply('immediately')).toBe('on-restart');
    expect(normalizeApply(42)).toBe('on-restart');
    expect(normalizeApply({})).toBe('on-restart');
  });
});

describe('shouldShowWhatsNew', () => {
  it('true only for a patch-only forward bump', () => {
    expect(shouldShowWhatsNew('0.1.1', '0.1.2')).toBe(true);
  });

  it('false for minor/major bumps (changelog was shown up front)', () => {
    expect(shouldShowWhatsNew('0.1.1', '0.2.0')).toBe(false);
    expect(shouldShowWhatsNew('0.1.1', '1.0.0')).toBe(false);
  });

  it('false when lastSeen is null (fresh install / first launch)', () => {
    expect(shouldShowWhatsNew(null, '0.1.2')).toBe(false);
  });

  it('false for equal versions and downgrades', () => {
    expect(shouldShowWhatsNew('0.1.2', '0.1.2')).toBe(false);
    expect(shouldShowWhatsNew('0.2.0', '0.1.1')).toBe(false);
  });
});
