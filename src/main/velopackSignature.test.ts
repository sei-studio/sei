import { describe, expect, it } from 'vitest';
import {
  AUTHENTICODE_SCRIPT,
  authenticodeEnv,
  parseDn,
  parseSignatureRows,
  publisherMatches,
  signatureVerdict,
  type SignatureRow,
} from './velopackSignature';

const SUBJECT = 'CN=Sei Studio Inc., O=Sei Studio Inc., L=San Francisco, S=California, C=US';

function row(over: Partial<SignatureRow>): SignatureRow {
  return { name: 'file0', status: 'Valid', subject: SUBJECT, ...over };
}

describe('publisherMatches (electron-updater rule)', () => {
  it('a plain name must equal the CN exactly', () => {
    expect(publisherMatches(SUBJECT, 'Sei Studio Inc.')).toBe(true);
    expect(publisherMatches(SUBJECT, 'Sei Studio')).toBe(false);
    expect(publisherMatches(SUBJECT, 'sei studio inc.')).toBe(false);
    expect(publisherMatches('CN=Evil, O=Sei Studio Inc.', 'Sei Studio Inc.')).toBe(false);
    // the old release.yml substring check would have passed this one
    expect(publisherMatches('CN=Not Sei Studio Inc., C=US', 'Sei Studio Inc.')).toBe(false);
  });

  it('a DN must match every part it names', () => {
    expect(publisherMatches(SUBJECT, 'CN=Sei Studio Inc., O=Sei Studio Inc., C=US')).toBe(true);
    expect(publisherMatches(SUBJECT, 'CN=Sei Studio Inc., C=JP')).toBe(false);
    expect(publisherMatches('CN="Sei, Inc.", C=US', 'CN="Sei, Inc."')).toBe(true);
  });

  it('nothing matches an empty publisher or an unsigned file', () => {
    expect(publisherMatches(SUBJECT, '')).toBe(false);
    expect(publisherMatches('', 'Sei Studio Inc.')).toBe(false);
  });

  it('parses quoted, escaped and spaced DNs like builder-util-runtime', () => {
    const dn = parseDn('CN = "Sei, Inc." ,  O=Sei\\2C Studio, C=US');
    expect(dn.get('CN')).toBe('Sei, Inc.');
    expect(dn.get('O')).toBe('Sei, Studio');
    expect(dn.get('C')).toBe('US');
    expect(parseDn('Sei Studio').size).toBe(0);
  });
});

describe('parseSignatureRows', () => {
  it('reads one JSON row per file and ignores noise', () => {
    const out = [
      'WARNING: something',
      JSON.stringify({ name: 'file0', status: 'Valid', subject: SUBJECT }),
      JSON.stringify({ name: 'Sei.exe', status: 'NotSigned', subject: '' }),
      '{broken',
    ].join('\r\n');
    expect(parseSignatureRows(out)).toEqual([
      { name: 'file0', status: 'Valid', subject: SUBJECT },
      { name: 'Sei.exe', status: 'NotSigned', subject: '' },
    ]);
  });

  it('throws when the script did not run or reported an error', () => {
    expect(() => parseSignatureRows(null)).toThrow(/did not run/);
    expect(() => parseSignatureRows(JSON.stringify({ error: 'zip is corrupt' }))).toThrow(/zip is corrupt/);
  });
});

describe('signatureVerdict', () => {
  const pub = 'Sei Studio Inc.';
  const pkgRows = [row({ name: 'Sei.exe' }), row({ name: 'Squirrel.exe' })];

  it('passes a Setup and a package signed by the publisher', () => {
    expect(signatureVerdict([row({})], pub, { files: 1, package: false })).toEqual({ ok: true });
    expect(signatureVerdict(pkgRows, pub, { files: 0, package: true })).toEqual({ ok: true });
    expect(signatureVerdict([row({}), ...pkgRows], pub, { files: 1, package: true })).toEqual({ ok: true });
  });

  it('rejects unsigned, tampered or foreign-signed files', () => {
    expect(signatureVerdict([row({ status: 'NotSigned', subject: '' })], pub, { files: 1, package: false }).ok).toBe(false);
    expect(signatureVerdict([row({ status: 'HashMismatch' })], pub, { files: 1, package: false }).ok).toBe(false);
    expect(signatureVerdict([row({ subject: 'CN=Someone Else' })], pub, { files: 1, package: false }).ok).toBe(false);
    expect(signatureVerdict([pkgRows[0], row({ name: 'Squirrel.exe', status: 'UnknownError' })], pub, { files: 0, package: true }).ok).toBe(false);
  });

  it('rejects a package missing Sei.exe or Squirrel.exe, and a missing file row', () => {
    expect(signatureVerdict([pkgRows[0]], pub, { files: 0, package: true })).toEqual({ ok: false, reason: 'the package has no Squirrel.exe' });
    expect(signatureVerdict([], pub, { files: 1, package: false }).ok).toBe(false);
    expect(signatureVerdict([], pub, { files: 0, package: false }).ok).toBe(false);
  });
});

describe('AUTHENTICODE_SCRIPT', () => {
  it('takes its inputs from the environment, never from pasted text', () => {
    expect(AUTHENTICODE_SCRIPT).toContain('$env:SEI_SIG_FILES');
    expect(AUTHENTICODE_SCRIPT).toContain('$env:SEI_SIG_PACKAGE');
    expect(AUTHENTICODE_SCRIPT).toContain('-LiteralPath');
    expect(authenticodeEnv(['C:\\游戏\\Sei 测试\\a.exe', 'b.exe'], 'p.nupkg')).toEqual({
      SEI_SIG_FILES: 'C:\\游戏\\Sei 测试\\a.exe\nb.exe',
      SEI_SIG_PACKAGE: 'p.nupkg',
    });
    expect(authenticodeEnv([])).toEqual({ SEI_SIG_FILES: '', SEI_SIG_PACKAGE: '' });
  });
});
