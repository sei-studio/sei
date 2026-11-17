import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { peSignatureStateOfFile } from './lib/peSignature.mjs';
import winSignNatives, { signPlan } from './win-sign-natives.mjs';

const SEC = 0x80 + 24 + 112 + 32; // security directory of the PE32+ header below

function fakePe(signed) {
  const buf = Buffer.alloc(1024);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80);
  buf.writeUInt16LE(0x20b, 0x80 + 24);
  buf.writeUInt32LE(16, 0x80 + 24 + 108);
  if (signed) {
    buf.writeUInt32LE(0x400, SEC);
    buf.writeUInt32LE(0x10, SEC + 4);
  }
  return buf;
}

/** What Invoke-TrustedSigning does to the file, as far as the check can see. */
function fakeSign(file) {
  const buf = readFileSync(file);
  buf.writeUInt32LE(0x400, SEC);
  buf.writeUInt32LE(0x10, SEC + 4);
  writeFileSync(file, buf);
}

function appDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'winsign-'));
  const mod = path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64');
  mkdirSync(mod, { recursive: true });
  writeFileSync(path.join(root, 'ffmpeg.dll'), fakePe(false));
  writeFileSync(path.join(root, 'd3dcompiler_47.dll'), fakePe(true)); // Microsoft-signed
  writeFileSync(path.join(mod, 'sherpa-onnx-c-api.dll'), fakePe(false));
  writeFileSync(path.join(mod, 'sherpa-onnx.node'), fakePe(false));
  return root;
}

const ctx = (root, signIf, azure = { endpoint: 'x' }) => ({
  electronPlatformName: 'win32',
  appOutDir: root,
  packager: { platformSpecificBuildOptions: azure ? { azureSignOptions: azure } : {}, signIf },
});

describe('win-sign-natives afterPack hook', () => {
  it('plans by platform and signing config', () => {
    expect(signPlan({ electronPlatformName: 'darwin' })).toEqual({ kind: 'skip' });
    expect(signPlan(ctx('/x', null, null))).toEqual({ kind: 'log' });
    expect(signPlan(ctx('/x', null))).toEqual({ kind: 'sign' });
  });

  it('signs only the unsigned natives, never the Microsoft-signed ones', async () => {
    const root = appDir();
    const signIf = vi.fn(async (f) => {
      fakeSign(f);
      return true;
    });
    await winSignNatives(ctx(root, signIf));
    const signed = signIf.mock.calls.map(([f]) => path.relative(root, f).split(path.sep).join('/')).sort();
    expect(signed).toEqual([
      'ffmpeg.dll',
      'resources/app.asar.unpacked/node_modules/sherpa-onnx-win-x64/sherpa-onnx-c-api.dll',
      'resources/app.asar.unpacked/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node',
    ]);
    expect(peSignatureStateOfFile(path.join(root, 'ffmpeg.dll'))).toBe('signed');
  });

  it('only logs when signing is not configured', async () => {
    const root = appDir();
    const signIf = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await winSignNatives(ctx(root, signIf, null));
    expect(signIf).not.toHaveBeenCalled();
    expect(log.mock.calls.join('\n')).toMatch(/3 native file\(s\) ship UNSIGNED/);
    log.mockRestore();
  });

  it('fails the build when a file is still unsigned afterwards', async () => {
    const root = appDir();
    const signIf = vi.fn(async (f) => {
      if (f.endsWith('.node')) throw new Error('signing service said no');
      fakeSign(f);
      return true;
    });
    await expect(winSignNatives(ctx(root, signIf))).rejects.toThrow(/1 native file\(s\) still unsigned[\s\S]*sherpa-onnx\.node[\s\S]*said no/);
  });

  it('fails when signIf claims success but the file did not change', async () => {
    const root = appDir();
    await expect(winSignNatives(ctx(root, vi.fn(async () => true)))).rejects.toThrow(/3 native file\(s\) still unsigned/);
  });
});
