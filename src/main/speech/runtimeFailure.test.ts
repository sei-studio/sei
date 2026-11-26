/**
 * Issue #59 (261127): why sherpa-onnx would not load, and what the engine
 * does with it (one diagnosis, one analytics event, a cached sentinel).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifySpeechRuntimeFailure,
  parseSmartAppControlState,
  probeSpeechRuntime,
  readSmartAppControlState,
  sherpaPlatformPackage,
} from './runtimeFailure';

const mocks = vi.hoisted(() => ({
  req: null as unknown as NodeJS.Require,
  diag: vi.fn(),
}));
vi.mock('../bundleRequire', () => ({ bundleRequire: () => mocks.req }));
vi.mock('../lazyAnalytics', () => ({ loadAnalytics: async () => ({ captureDiagnostic: mocks.diag }) }));
vi.mock('./packStore', () => ({ packReady: async () => true, packModelDir: () => '/models/x' }));

describe('classifySpeechRuntimeFailure', () => {
  const base = { platform: 'win32' as NodeJS.Platform, platformPackageFound: true, loadError: 'x', sac: 'off' as const };

  it('reads an absent platform package as missing, on any OS', () => {
    expect(classifySpeechRuntimeFailure({ ...base, platformPackageFound: false, sac: 'on' })).toBe('missing');
    expect(classifySpeechRuntimeFailure({ ...base, platform: 'darwin', platformPackageFound: false })).toBe('missing');
  });

  it('reads a failed native load under enforcing Smart App Control as os_blocked, whatever the wording', () => {
    // A blocked dependency DLL surfaces as a plain "module could not be found".
    expect(classifySpeechRuntimeFailure({ ...base, loadError: 'The specified module could not be found.', sac: 'on' })).toBe('os_blocked');
    // Localized loader text.
    expect(classifySpeechRuntimeFailure({ ...base, loadError: '指定されたモジュールが見つかりません。', sac: 'on' })).toBe('os_blocked');
  });

  it('reads the English Code Integrity messages as os_blocked without Smart App Control', () => {
    expect(classifySpeechRuntimeFailure({ ...base, loadError: 'An Application Control policy has blocked this file.' })).toBe('os_blocked');
    expect(
      classifySpeechRuntimeFailure({ ...base, loadError: 'Windows cannot verify the digital signature for this file.', sac: 'unknown' }),
    ).toBe('os_blocked');
  });

  it('keeps other failures as load_error', () => {
    expect(classifySpeechRuntimeFailure({ ...base, loadError: 'The specified module could not be found.' })).toBe('load_error');
    // The direct load worked, so the block is not what failed.
    expect(classifySpeechRuntimeFailure({ ...base, loadError: null, sac: 'on' })).toBe('load_error');
    expect(classifySpeechRuntimeFailure({ ...base, platform: 'darwin', loadError: 'code integrity', sac: 'on' })).toBe('load_error');
  });
});

describe('Smart App Control state', () => {
  it('parses reg.exe output', () => {
    const out = (v: string) =>
      `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    ${v}\r\n\r\n`;
    expect(parseSmartAppControlState(out('0x1'))).toBe('on');
    expect(parseSmartAppControlState(out('0x0'))).toBe('off');
    expect(parseSmartAppControlState(out('0x2'))).toBe('evaluation');
    expect(parseSmartAppControlState(out('0x7'))).toBe('unknown');
    expect(parseSmartAppControlState('ERROR: The system was unable to find the specified registry key or value.')).toBe('unknown');
  });

  it('is unknown off Windows without running anything', async () => {
    await expect(readSmartAppControlState('darwin')).resolves.toBe('unknown');
  });

  it('names the platform package the way addon.js does', () => {
    expect(sherpaPlatformPackage('win32', 'x64')).toBe('sherpa-onnx-win-x64');
    expect(sherpaPlatformPackage('darwin', 'arm64')).toBe('sherpa-onnx-darwin-arm64');
  });
});

/** A fake node_modules with sherpa-onnx-node and, optionally, its platform package. */
function fakeInstall(withPlatform: boolean): { req: NodeJS.Require; nodeFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'sei-sherpa-'));
  const pkg = path.join(root, 'node_modules', 'sherpa-onnx-node');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), '{}');
  const nodeFile = path.join(root, 'node_modules', 'sherpa-onnx-darwin-arm64', 'sherpa-onnx.node');
  if (withPlatform) {
    mkdirSync(path.dirname(nodeFile), { recursive: true });
    writeFileSync(nodeFile, 'not a binary');
  }
  const req = Object.assign(
    (id: string) => {
      if (id === nodeFile) throw new Error('dlopen failed: not a mach-o file');
      throw new Error(`Could not find sherpa-onnx-node. Tried ${id}`);
    },
    { resolve: (id: string) => (id === 'sherpa-onnx-node/package.json' ? path.join(pkg, 'package.json') : id) },
  ) as unknown as NodeJS.Require;
  return { req, nodeFile };
}

describe('probeSpeechRuntime', () => {
  it('finds the platform package beside sherpa-onnx-node and records the direct load error', async () => {
    const { req } = fakeInstall(true);
    const probe = await probeSpeechRuntime(req, 'darwin', 'arm64');
    expect(probe).toEqual({ platform: 'darwin', platformPackageFound: true, loadError: 'dlopen failed: not a mach-o file', sac: 'unknown' });
  });

  it('reports a missing platform package without loading anything', async () => {
    const { req } = fakeInstall(false);
    const probe = await probeSpeechRuntime(req, 'darwin', 'arm64');
    expect(probe.platformPackageFound).toBe(false);
    expect(probe.loadError).toBeNull();
  });
});

describe('engine: a failed runtime load', () => {
  beforeEach(async () => {
    mocks.diag.mockReset();
    const { _resetSherpaForTests } = await import('./engine');
    _resetSherpaForTests();
  });

  it('throws the reason in the sentinel, reports once, and does not retry the loader', async () => {
    const { req } = fakeInstall(false);
    const calls = vi.fn();
    mocks.req = Object.assign((id: string) => {
      calls(id);
      return (req as unknown as (id: string) => unknown)(id);
    }, { resolve: req.resolve }) as unknown as NodeJS.Require;
    const { synthesizeLocal, transcribeLocal } = await import('./engine');

    await expect(synthesizeLocal('hi', 'en-f')).rejects.toThrow(/^SPEECH_RUNTIME_FAILED: missing: sherpa-onnx-node load failed/);
    await expect(synthesizeLocal('again', 'en-f')).rejects.toThrow(/^SPEECH_RUNTIME_FAILED: missing:/);
    await expect(transcribeLocal(new Float32Array(16), 16000, 'en')).rejects.toThrow(/^SPEECH_RUNTIME_FAILED: missing:/);
    expect(calls.mock.calls.filter(([id]) => id === 'sherpa-onnx-node')).toHaveLength(1);
    await vi.waitFor(() => expect(mocks.diag).toHaveBeenCalledTimes(1));
    expect(mocks.diag).toHaveBeenCalledWith('speech_runtime_failed', { reason: 'missing', sac_state: 'unknown' });
  });
});
