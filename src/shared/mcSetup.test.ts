import { describe, it, expect } from 'vitest';
import {
  anyMcInstallReady,
  compareMcVersions,
  formatMcVersionList,
  installableMcVersions,
  joinableMcVersions,
  mcReleases,
  type McProtocolRow,
  isMcVersionNewerThanSupported,
  mcInstallReadyVersion,
  selectTargetMcVersion,
  supportedMcRange,
} from './mcSetup';
import { supportedVersions as realSupported } from 'minecraft-protocol/src/version.js';
import realRows from 'minecraft-data/minecraft-data/data/pc/common/protocolVersions.json';

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

  it('caps the wizard profile at WIZARD_MAX_MC even when the bot can join newer', () => {
    // 260926: the bot joins 26.2 / 26.3, but CustomSkinLoader has no verified
    // build there, so setup keeps building the 26.1 profile.
    const joinable = [...SUPPORTED, '26.2', '26.3'];
    expect(selectTargetMcVersion({ supported: joinable })).toBe('26.1');
    expect(selectTargetMcVersion({ supported: joinable, requested: '26.3' })).toBe('26.1');
    expect(installableMcVersions(joinable)[0]).toBe('26.1');
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

  // 260926: the copy lists the joinable set with its gaps, not a range.
  const ROWS: McProtocolRow[] = [
    { minecraftVersion: '1.7.10', version: 5 },
    { minecraftVersion: '1.8', version: 47 },
    { minecraftVersion: '1.8.8', version: 47 },
    { minecraftVersion: '1.8.9', version: 47 },
    { minecraftVersion: '1.9', version: 107 },
    { minecraftVersion: '1.9.4', version: 110 },
    { minecraftVersion: '1.10', version: 210 },
    { minecraftVersion: '1.10.2', version: 210 },
    { minecraftVersion: '1.11', version: 315 },
    { minecraftVersion: '1.12.2', version: 340 },
    { minecraftVersion: '1.21.5', version: 770 },
    { minecraftVersion: '26.1', version: 775 },
    { minecraftVersion: '26.1.2', version: 775 },
    { minecraftVersion: '26.2-snapshot-1', version: 1073742000 },
    { minecraftVersion: '26.2', version: 776 },
  ];
  const SUP = ['1.7', '1.8.8', '1.9.4', '1.10.2', '1.12.2', '26.1'];

  it('joinable = named in the table or speaking a supported protocol, from 1.8', () => {
    expect(joinableMcVersions(SUP, ROWS)).toEqual(['1.8', '1.8.8', '1.8.9', '1.9.4', '1.10', '1.10.2', '1.12.2', '26.1', '26.1.2']);
    expect(mcReleases(ROWS)).toEqual(['1.8', '1.8.8', '1.8.9', '1.9', '1.9.4', '1.10', '1.10.2', '1.11', '1.12.2', '1.21.5', '26.1', '26.1.2', '26.2']);
  });

  it('formats runs compactly and keeps the gaps', () => {
    expect(formatMcVersionList(joinableMcVersions(SUP, ROWS), mcReleases(ROWS))).toBe('1.8 to 1.8.9, 1.9.4 to 1.10.2, 1.12.2, 26.1, 26.1.2');
    expect(formatMcVersionList(['1.8', '1.8.9', '1.10'], ['1.8', '1.8.9', '1.9', '1.10'], (a, b) => `${a}至${b}`)).toBe('1.8, 1.8.9, 1.10');
    expect(formatMcVersionList(['1', '2', '3'], ['1', '2', '3'], (a, b) => `${a}至${b}`)).toBe('1至3');
  });

  it('with the protocol table, a world on a same-protocol patch (26.1.2) is not "too new"', () => {
    expect(isMcVersionNewerThanSupported('26.1.2', SUP)).toBe(true); // range alone gets it wrong
    expect(isMcVersionNewerThanSupported('26.1.2', SUP, ROWS)).toBe(false);
    expect(isMcVersionNewerThanSupported('26.2', SUP, ROWS)).toBe(true);
  });

  it('on the shipped tables: the list starts at 1.8, skips 1.9, and reaches the newest supported entry', () => {
    const rows = realRows as McProtocolRow[];
    const joinable = joinableMcVersions(realSupported, rows);
    expect(joinable[0]).toBe('1.8');
    expect(joinable).not.toContain('1.9');
    expect(joinable).toContain(realSupported[realSupported.length - 1]);
    const text = formatMcVersionList(joinable, mcReleases(rows));
    expect(text).toMatch(/^1\.8 to 1\.8\.9, /);
    expect(text).not.toMatch(/\u2014/);
  });
});
