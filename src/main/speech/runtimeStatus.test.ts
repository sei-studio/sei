import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifySpeechLoadError,
  noteSpeechRuntimeFailure,
  noteSpeechRuntimeOk,
  onSpeechRuntimeFailure,
  parseSacState,
  resetSpeechRuntimeStatusForTest,
  speechRuntimeSettled,
  speechRuntimeStatus,
} from './runtimeStatus';

afterEach(() => resetSpeechRuntimeStatusForTest());

describe('classifySpeechLoadError', () => {
  const base = { platform: 'win32' as const, addonPresent: true, sac: 'unknown' as const };

  it('reads a code integrity block from the loader message', () => {
    for (const message of [
      '\\\\?\\C:\\Sei\\sherpa-onnx.node: An Application Control policy has blocked this file.',
      'Your organization used Device Guard to block this app.',
      'Error: 0x800711C7',
      'Windows cannot verify the digital signature for this file.',
    ]) {
      expect(classifySpeechLoadError({ ...base, message })).toBe('blocked_by_policy');
    }
  });

  it('says missing when the addon is not on disk', () => {
    expect(classifySpeechLoadError({ ...base, addonPresent: false, message: 'Could not find sherpa-onnx-node' })).toBe('missing');
  });

  it('infers a SAC block from a localized or dependency error when SAC is on', () => {
    const message = 'Le module spécifié est introuvable.';
    expect(classifySpeechLoadError({ ...base, message, sac: 'on' })).toBe('blocked_by_policy');
    expect(classifySpeechLoadError({ ...base, message, sac: 'off' })).toBe('load_failed');
    expect(classifySpeechLoadError({ ...base, message, sac: 'eval' })).toBe('load_failed');
    expect(classifySpeechLoadError({ ...base, platform: 'darwin', message, sac: 'on' })).toBe('load_failed');
  });
});

describe('parseSacState', () => {
  it('maps the registry value', () => {
    const q = (v: string) =>
      `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    ${v}\r\n`;
    expect(parseSacState(q('0x1'))).toBe('on');
    expect(parseSacState(q('0x2'))).toBe('eval');
    expect(parseSacState(q('0x0'))).toBe('off');
    expect(parseSacState(q('0x7'))).toBe('unknown');
    expect(parseSacState('ERROR: The system was unable to find the specified registry key or value.')).toBe('unknown');
  });
});

describe('runtime status', () => {
  it('records the first failure, refines it with the SAC state, and notifies once', async () => {
    const seen = vi.fn();
    onSpeechRuntimeFailure(seen);
    noteSpeechRuntimeFailure(
      { message: 'The specified module could not be found.', addonPresent: true },
      { platform: 'win32', readSac: async () => 'on' },
    );
    expect(speechRuntimeStatus()).toEqual({ state: 'failed', code: 'load_failed', sac: 'unknown' });
    await speechRuntimeSettled();
    expect(speechRuntimeStatus()).toEqual({ state: 'failed', code: 'blocked_by_policy', sac: 'on' });
    noteSpeechRuntimeFailure({ message: 'again', addonPresent: true }, { platform: 'win32', readSac: async () => 'off' });
    await speechRuntimeSettled();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ state: 'failed', code: 'blocked_by_policy', sac: 'on' });
  });

  it('survives a SAC read that throws', async () => {
    noteSpeechRuntimeFailure({ message: 'x', addonPresent: false }, { platform: 'win32', readSac: () => Promise.reject(new Error('no reg')) });
    expect(await speechRuntimeSettled()).toEqual({ state: 'failed', code: 'missing', sac: 'unknown' });
  });

  it('reports ok after a good load', async () => {
    expect(speechRuntimeStatus()).toEqual({ state: 'unknown' });
    noteSpeechRuntimeOk();
    expect(await speechRuntimeSettled()).toEqual({ state: 'ok' });
  });
});
