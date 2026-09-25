import { describe, it, expect } from 'vitest';
import {
  anyMcInstallReady,
  compareMcVersions,
  installableMcVersions,
  isMcVersionNewerThanSupported,
  mcInstallReadyVersion,
  selectTargetMcVersion,
  supportedMcRange,
} from './mcSetup';
import { supportedVersions as realSupported } from 'minecraft-protocol/src/version.js';

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
    // Per-profile truth wins when present: the mod must sit in THAT
    // version's own game dir, not anywhere on the install.
    expect(mcInstallReadyVersion({ ...base, fabric_mc_versions: ['26.1', '1.21.4'], sei_ready_versions: ['1.21.4'] }, SUPPORTED)).toBe('1.21.4');
    expect(mcInstallReadyVersion({ ...base, fabric_mc_versions: ['26.1'], sei_ready_versions: [] }, SUPPORTED)).toBeNull();
    expect(mcInstallReadyVersion({ ...base, csl_installed: false, sei_ready_versions: ['26.1'] }, SUPPORTED)).toBe('26.1');
    expect(anyMcInstallReady([{ ...base, loader: null }, { ...base, fabric_mc_versions: ['1.20.1'] }], SUPPORTED)).toBe('1.20.1');
  });

  it('the wizard target is the newest supported version, whatever the launcher last played', () => {
    expect(selectTargetMcVersion({ supported: SUPPORTED })).toBe('26.1');
    expect(selectTargetMcVersion({ supported: SUPPORTED, requested: null })).toBe('26.1');
    // The supported table is not sorted newest-last by contract; sort, do not trust order.
    expect(selectTargetMcVersion({ supported: ['26.1', '1.21.4'] })).toBe('26.1');
  });

  it('an explicit request wins only when Sei can join it', () => {
    expect(selectTargetMcVersion({ supported: SUPPORTED, requested: '1.21.4' })).toBe('1.21.4');
    expect(selectTargetMcVersion({ supported: SUPPORTED, requested: '26.2' })).toBe('26.1');
    expect(selectTargetMcVersion({ supported: SUPPORTED, requested: '1.12.2' })).toBe('26.1');
  });

  it('never targets a snapshot or a version older than Fabric supports', () => {
    expect(installableMcVersions(['1.8.9', '1.12.2', '1.16.5', '1.21.4', '26.1-snapshot-3', '26.1'])).toEqual(['26.1', '1.21.4', '1.16.5']);
    expect(selectTargetMcVersion({ supported: ['1.8.9'] })).toBeNull();
  });

  it('states the supported range from the protocol table, releases only, from the bot floor', () => {
    expect(supportedMcRange(['1.7', '1.8.8', '1.21.4', '26.1-snapshot-2', '26.1', '1.12.2'])).toEqual({ oldest: '1.8.8', newest: '26.1' });
    expect(supportedMcRange([])).toBeNull();
    // The shipped table: the ceiling is whatever minecraft-protocol says, never a hardcode.
    const r = supportedMcRange(realSupported);
    expect(r).not.toBeNull();
    expect(realSupported).toContain(r!.newest);
    expect(realSupported).toContain(r!.oldest);
  });

  it('flags a world newer than the newest supported version (the 26.2 / 26.3 case) only', () => {
    const sup = ['1.8.8', '1.21.4', '26.1'];
    expect(isMcVersionNewerThanSupported('26.2', sup)).toBe(true);
    expect(isMcVersionNewerThanSupported('26.3-snapshot-1', sup)).toBe(true);
    expect(isMcVersionNewerThanSupported('Paper 26.2', sup)).toBe(true);
    expect(isMcVersionNewerThanSupported('26.1', sup)).toBe(false);
    expect(isMcVersionNewerThanSupported('1.21.4', sup)).toBe(false);
    // Older-but-unlisted and unparseable names are left to the bot's protocol check.
    expect(isMcVersionNewerThanSupported('1.21.7', sup)).toBe(false);
    expect(isMcVersionNewerThanSupported('Forge', sup)).toBe(false);
    expect(isMcVersionNewerThanSupported(undefined, sup)).toBe(false);
  });
});
