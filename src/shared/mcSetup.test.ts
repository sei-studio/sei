import { describe, it, expect } from 'vitest';
import { anyMcInstallReady, compareMcVersions, mcInstallReadyVersion, selectTargetMcVersion } from './mcSetup';

const SUPPORTED = ['1.20.1', '1.21.4', '1.21.11', '26.1'];

describe('mcSetup', () => {
  it('compares versions numerically, not lexically', () => {
    expect(compareMcVersions('1.21.11', '1.21.4')).toBeGreaterThan(0);
    expect(compareMcVersions('26.1', '1.21.11')).toBeGreaterThan(0);
    expect(compareMcVersions('1.21', '1.21.0')).toBe(0);
  });

  it('an install is ready only with Fabric for a supported version AND the skin mod', () => {
    const base = { loader: 'fabric' as const, csl_installed: true, compatibility: 'full' as const };
    expect(mcInstallReadyVersion({ ...base, fabric_mc_versions: ['1.21.4'] }, SUPPORTED)).toBe('1.21.4');
    expect(mcInstallReadyVersion({ ...base, fabric_mc_versions: ['1.21.4', '26.1'] }, SUPPORTED)).toBe('26.1');
    expect(mcInstallReadyVersion({ ...base, fabric_mc_versions: ['27.1'] }, SUPPORTED)).toBeNull();
    expect(mcInstallReadyVersion({ ...base, csl_installed: false, fabric_mc_versions: ['26.1'] }, SUPPORTED)).toBeNull();
    expect(mcInstallReadyVersion({ ...base, loader: null, fabric_mc_versions: [] }, SUPPORTED)).toBeNull();
    expect(mcInstallReadyVersion({ ...base, compatibility: 'limited', fabric_mc_versions: ['26.1'] }, SUPPORTED)).toBeNull();
    // A record from an older main (no versions list) keeps the old meaning.
    expect(mcInstallReadyVersion(base, SUPPORTED)).toBe('26.1');
    expect(anyMcInstallReady([{ ...base, loader: null }, { ...base, fabric_mc_versions: ['1.20.1'] }], SUPPORTED)).toBe('1.20.1');
  });

  it('keeps the player on their own version when Sei can join it', () => {
    expect(selectTargetMcVersion({ installVersion: '1.21.11', supported: SUPPORTED, verified: ['1.21.4'] })).toBe('1.21.11');
  });

  it('moves an unsupported or missing version to the newest VERIFIED supported one', () => {
    expect(selectTargetMcVersion({ installVersion: '27.1', supported: SUPPORTED, verified: ['1.21.4'] })).toBe('1.21.4');
    expect(selectTargetMcVersion({ installVersion: null, supported: SUPPORTED, verified: ['1.20.1', '1.21.4'] })).toBe('1.21.4');
    // A verified version the networking stack has since dropped is skipped.
    expect(selectTargetMcVersion({ installVersion: null, supported: SUPPORTED, verified: ['1.19.2', '1.21.4'] })).toBe('1.21.4');
  });

  it('falls back to the newest supported version when nothing verified is joinable', () => {
    expect(selectTargetMcVersion({ installVersion: null, supported: SUPPORTED, verified: ['1.19.2'] })).toBe('26.1');
  });

  it('skips versions older than Fabric supports', () => {
    expect(selectTargetMcVersion({ installVersion: '1.12.2', supported: ['1.12.2', '1.16.5'], verified: [] })).toBe('1.16.5');
    expect(selectTargetMcVersion({ installVersion: null, supported: ['1.8.9'], verified: [] })).toBeNull();
  });
});
