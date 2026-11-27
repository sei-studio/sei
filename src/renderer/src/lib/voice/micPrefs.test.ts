import { describe, expect, it, vi } from 'vitest';
import {
  listMicDevices,
  micAudioConstraints,
  micDeviceIdOf,
  micGateScale,
  micSensitivityBucket,
  micSensitivityOf,
  openMicStream,
} from './micPrefs';

const stream = { id: 's' } as unknown as MediaStream;
const domErr = (name: string): Error => Object.assign(new Error(name), { name });

describe('micPrefs', () => {
  it('sensitivity 50 is the threshold earlier builds used; the ends halve or double it', () => {
    expect(micGateScale(undefined)).toBe(1);
    expect(micGateScale(50)).toBe(1);
    expect(micGateScale(0)).toBeCloseTo(2);
    expect(micGateScale(100)).toBeCloseTo(0.5);
    expect(micGateScale(75)).toBeLessThan(1);
  });

  it('clamps and rounds stored values; junk is the default', () => {
    expect(micSensitivityOf(140)).toBe(100);
    expect(micSensitivityOf(-3)).toBe(0);
    expect(micSensitivityOf(33.6)).toBe(34);
    expect(micSensitivityOf('x')).toBe(50);
    expect(micSensitivityOf(NaN)).toBe(50);
  });

  it('reports sensitivity as a bucket only', () => {
    expect(micSensitivityBucket(50)).toBe('default');
    expect(micSensitivityBucket(10)).toBe('low');
    expect(micSensitivityBucket(90)).toBe('high');
  });

  it("'' and Chromium's 'default' both mean the system default", () => {
    expect(micDeviceIdOf('')).toBeUndefined();
    expect(micDeviceIdOf('default')).toBeUndefined();
    expect(micDeviceIdOf(undefined)).toBeUndefined();
    expect(micDeviceIdOf('abc')).toBe('abc');
  });

  it('keeps the call processing flags and pins the device exactly', () => {
    expect(micAudioConstraints()).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    });
    expect(micAudioConstraints('abc').deviceId).toEqual({ exact: 'abc' });
  });

  it('opens the default with no saved device', async () => {
    const gum = vi.fn(async (_c: MediaStreamConstraints) => stream);
    await expect(openMicStream(undefined, gum)).resolves.toEqual({ stream, fellBack: false });
    expect(gum.mock.calls[0][0]).toEqual({ audio: micAudioConstraints() });
  });

  it('falls back to the default when the saved device is missing', async () => {
    for (const name of ['OverconstrainedError', 'NotFoundError']) {
      const gum = vi.fn().mockRejectedValueOnce(domErr(name)).mockResolvedValueOnce(stream);
      await expect(openMicStream('gone', gum)).resolves.toEqual({ stream, fellBack: true });
      expect(gum.mock.calls[1][0]).toEqual({ audio: micAudioConstraints() });
    }
  });

  it('a refusal or a busy device is thrown, not papered over with the default', async () => {
    for (const name of ['NotAllowedError', 'NotReadableError']) {
      const gum = vi.fn().mockRejectedValueOnce(domErr(name));
      await expect(openMicStream('usb', gum)).rejects.toMatchObject({ name });
      expect(gum).toHaveBeenCalledTimes(1);
    }
  });

  it('lists each real input once, without the default aliases or outputs', () => {
    expect(
      listMicDevices([
        { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic' },
        { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Mic' },
        { kind: 'audioinput', deviceId: 'a', label: 'Mic A' },
        { kind: 'audiooutput', deviceId: 'b', label: 'Speakers' },
        { kind: 'audioinput', deviceId: 'a', label: 'Mic A' },
        { kind: 'audioinput', deviceId: 'c', label: '' },
      ]),
    ).toEqual([
      { deviceId: 'a', label: 'Mic A' },
      { deviceId: 'c', label: '' },
    ]);
  });
});
