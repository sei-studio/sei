import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { azureSigningMode, AZURE_SIGN_VARS, listNatives, peSignatureState, unsignedNatives } from './peSignature.mjs';

/** A minimal PE header: MZ, e_lfanew, PE\0\0, COFF, optional header magic and
 * the data directories, with the security directory set to (off, size). */
function fakePe({ pe32plus = true, secOff = 0, secSize = 0, numDirs = 16 } = {}) {
  const buf = Buffer.alloc(1024);
  buf.write('MZ', 0, 'latin1');
  const pe = 0x80;
  buf.writeUInt32LE(pe, 0x3c);
  buf.writeUInt32LE(0x00004550, pe);
  const opt = pe + 24;
  buf.writeUInt16LE(pe32plus ? 0x20b : 0x10b, opt);
  const dirs = opt + (pe32plus ? 112 : 96);
  buf.writeUInt32LE(numDirs, dirs - 4);
  buf.writeUInt32LE(secOff, dirs + 32);
  buf.writeUInt32LE(secSize, dirs + 36);
  return buf;
}

describe('peSignatureState', () => {
  it('reads the security directory of PE32+ and PE32 images', () => {
    expect(peSignatureState(fakePe())).toBe('unsigned');
    expect(peSignatureState(fakePe({ secOff: 0x5000, secSize: 0x2a00 }))).toBe('signed');
    expect(peSignatureState(fakePe({ pe32plus: false }))).toBe('unsigned');
    expect(peSignatureState(fakePe({ pe32plus: false, secOff: 0x400, secSize: 0x10 }))).toBe('signed');
  });

  it('treats an image with fewer than 5 data directories as unsigned', () => {
    expect(peSignatureState(fakePe({ numDirs: 4, secOff: 1, secSize: 1 }))).toBe('unsigned');
  });

  it('says not-pe for anything that is not a PE image', () => {
    expect(peSignatureState(Buffer.from('\x7fELF........................................................................'))).toBe('not-pe');
    expect(peSignatureState(Buffer.alloc(0))).toBe('not-pe');
    const noSig = fakePe();
    noSig.writeUInt32LE(0, 0x80);
    expect(peSignatureState(noSig)).toBe('not-pe');
  });
});

describe('listNatives / unsignedNatives', () => {
  it('finds .dll and .node files at any depth and skips signed ones', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pesig-'));
    mkdirSync(path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(root, 'ffmpeg.dll'), fakePe());
    writeFileSync(path.join(root, 'd3dcompiler_47.dll'), fakePe({ secOff: 0x5000, secSize: 0x100 }));
    writeFileSync(path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'x', 'x.NODE'), fakePe());
    writeFileSync(path.join(root, 'resources', 'readme.txt'), 'hi');
    writeFileSync(path.join(root, 'resources', 'fake.dll'), 'not a dll');

    const all = listNatives(root);
    expect(all.map((n) => [n.rel, n.state])).toEqual([
      ['d3dcompiler_47.dll', 'signed'],
      ['ffmpeg.dll', 'unsigned'],
      ['resources/app.asar.unpacked/node_modules/x/x.NODE', 'unsigned'],
      ['resources/fake.dll', 'not-pe'],
    ]);
    expect(unsignedNatives(root).map((n) => n.rel)).toEqual([
      'ffmpeg.dll',
      'resources/app.asar.unpacked/node_modules/x/x.NODE',
    ]);
  });
});

describe('azureSigningMode', () => {
  it('is all or nothing', () => {
    expect(azureSigningMode({})).toBe('off');
    expect(azureSigningMode(Object.fromEntries(AZURE_SIGN_VARS.map((k) => [k, 'v'])))).toBe('on');
    expect(() => azureSigningMode({ AZURE_TENANT_ID: 't' })).toThrow(/partial/);
  });
});
