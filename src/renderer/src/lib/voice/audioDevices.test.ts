import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetAudioDevicesForTests,
  applyOutputSink,
  deviceOptions,
  getOutputDeviceId,
  isDeviceGone,
  micConstraints,
  onOutputDeviceChange,
  openMic,
  setOutputDeviceId,
  setOutputGoneHandler,
} from './audioDevices';

const err = (name: string): Error => Object.assign(new Error(name), { name });
const fakeStream = (tag: string): MediaStream => ({ tag }) as unknown as MediaStream;

describe('deviceOptions (261118)', () => {
  const unnamed = (n: number): string => `Mic ${n}`;
  it('drops the default pseudo entry, other kinds and duplicates; keeps communications', () => {
    const list = deviceOptions(
      [
        { deviceId: 'default', kind: 'audioinput', label: 'Default - Headset' },
        { deviceId: 'communications', kind: 'audioinput', label: 'Communications - Headset' },
        { deviceId: 'a1', kind: 'audioinput', label: 'Headset' },
        { deviceId: 'a1', kind: 'audioinput', label: 'Headset' },
        { deviceId: 'o1', kind: 'audiooutput', label: 'Speakers' },
        { deviceId: 'v1', kind: 'videoinput', label: 'Cam' },
      ],
      'audioinput',
      unnamed,
    );
    expect(list).toEqual([
      { id: 'communications', label: 'Communications - Headset' },
      { id: 'a1', label: 'Headset' },
    ]);
  });
  it('names unlabeled devices (no media access yet) instead of showing blanks', () => {
    const list = deviceOptions(
      [
        { deviceId: 'x', kind: 'audioinput', label: '' },
        { deviceId: 'y', kind: 'audioinput', label: '  ' },
        { deviceId: '', kind: 'audioinput', label: 'no id' },
      ],
      'audioinput',
      unnamed,
    );
    expect(list).toEqual([
      { id: 'x', label: 'Mic 1' },
      { id: 'y', label: 'Mic 2' },
    ]);
  });
});

describe('micConstraints / isDeviceGone', () => {
  it('adds an exact deviceId only for a saved device', () => {
    const base = { echoCancellation: true };
    expect(micConstraints(base, 'abc')).toEqual({ echoCancellation: true, deviceId: { exact: 'abc' } });
    expect(micConstraints(base, null)).toEqual({ echoCancellation: true });
    expect(micConstraints(base, undefined)).toEqual({ echoCancellation: true });
    expect(base).toEqual({ echoCancellation: true });
  });
  it('treats only missing-device errors as gone', () => {
    expect(isDeviceGone(err('OverconstrainedError'))).toBe(true);
    expect(isDeviceGone(err('NotFoundError'))).toBe(true);
    expect(isDeviceGone(err('NotAllowedError'))).toBe(false);
    expect(isDeviceGone(err('NotReadableError'))).toBe(false);
    expect(isDeviceGone(null)).toBe(false);
  });
});

describe('openMic fallback (261118)', () => {
  const base = { channelCount: 1 };

  it('opens the system default when nothing is saved', async () => {
    const getUserMedia = vi.fn(async () => fakeStream('default'));
    const onDeviceGone = vi.fn();
    const r = await openMic(base, null, { getUserMedia, onDeviceGone });
    expect(r).toEqual({ stream: fakeStream('default'), fellBack: false });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1 }, video: false });
    expect(onDeviceGone).not.toHaveBeenCalled();
  });

  it('opens the saved device with an exact constraint', async () => {
    const getUserMedia = vi.fn(async () => fakeStream('picked'));
    const r = await openMic(base, 'dev-1', { getUserMedia });
    expect(r.fellBack).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, deviceId: { exact: 'dev-1' } }, video: false });
  });

  it('falls back to the default and reports the device gone when it was unplugged', async () => {
    const getUserMedia = vi
      .fn<(c: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockRejectedValueOnce(err('OverconstrainedError'))
      .mockResolvedValueOnce(fakeStream('default'));
    const onDeviceGone = vi.fn();
    const r = await openMic(base, 'gone-1', { getUserMedia, onDeviceGone });
    expect(r).toEqual({ stream: fakeStream('default'), fellBack: true });
    expect(onDeviceGone).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[1][0]).toEqual({ audio: { channelCount: 1 }, video: false });
  });

  it('never falls back on a refusal or a busy device: the real error reaches the caller', async () => {
    for (const name of ['NotAllowedError', 'NotReadableError']) {
      const getUserMedia = vi.fn(async () => {
        throw err(name);
      });
      const onDeviceGone = vi.fn();
      await expect(openMic(base, 'dev-1', { getUserMedia, onDeviceGone })).rejects.toMatchObject({ name });
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(onDeviceGone).not.toHaveBeenCalled();
    }
  });

  it('surfaces the default device failure when the fallback fails too (no mic at all)', async () => {
    const getUserMedia = vi
      .fn<(c: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockRejectedValueOnce(err('OverconstrainedError'))
      .mockRejectedValueOnce(err('NotFoundError'));
    const onDeviceGone = vi.fn();
    await expect(openMic(base, 'gone-1', { getUserMedia, onDeviceGone })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(onDeviceGone).toHaveBeenCalledTimes(1);
  });
});

describe('output sink (261118)', () => {
  beforeEach(() => _resetAudioDevicesForTests());

  const target = (impl?: (id: string) => Promise<void>) => {
    const t = {
      sinkId: '',
      setSinkId: vi.fn(async (id: string) => {
        if (impl) await impl(id);
        t.sinkId = id;
      }),
    };
    return t;
  };

  it('is a no-op on the system default and on players without setSinkId', async () => {
    const t = target();
    await applyOutputSink(t);
    expect(t.setSinkId).not.toHaveBeenCalled();
    await expect(applyOutputSink({} as never)).resolves.toBeUndefined();
    await expect(applyOutputSink(null)).resolves.toBeUndefined();
  });

  it('points a player at the saved speaker', async () => {
    setOutputDeviceId('spk-1');
    const t = target();
    await applyOutputSink(t);
    expect(t.setSinkId).toHaveBeenCalledWith('spk-1');
    expect(t.sinkId).toBe('spk-1');
  });

  it('falls back to the default and reports a gone speaker once', async () => {
    const gone = vi.fn();
    setOutputGoneHandler(gone);
    setOutputDeviceId('spk-gone');
    const t = target(async (id) => {
      if (id === 'spk-gone') throw err('NotFoundError');
    });
    await applyOutputSink(t);
    expect(t.setSinkId.mock.calls.map((c) => c[0])).toEqual(['spk-gone', '']);
    expect(t.sinkId).toBe('');
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('leaves the player alone on other sink errors and does not reset the setting', async () => {
    const gone = vi.fn();
    setOutputGoneHandler(gone);
    setOutputDeviceId('spk-1');
    const t = target(async () => {
      throw err('AbortError');
    });
    await expect(applyOutputSink(t)).resolves.toBeUndefined();
    expect(t.setSinkId).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
  });

  it('tells long-lived players when the choice changes, once per change', () => {
    const seen: (string | null)[] = [];
    const off = onOutputDeviceChange((id) => seen.push(id));
    setOutputDeviceId('a');
    setOutputDeviceId('a');
    setOutputDeviceId('');
    off();
    setOutputDeviceId('b');
    expect(seen).toEqual(['a', null]);
    expect(getOutputDeviceId()).toBe('b');
  });
});
