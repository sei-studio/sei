import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saveConfig = vi.fn(async (_cfg: Record<string, unknown>) => {});
const track = vi.fn();
const fakeSei = {
  getConfig: vi.fn(async () => ({ call_captions: true, audio_input_device: 'old' })),
  saveConfig,
  track,
};
vi.mock('../ipcClient', () => ({ sei: fakeSei }));

const { useAudioDeviceStore, resetMissingInput } = await import('./useAudioDeviceStore');
const audio = await import('../voice/audioDevices');

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('useAudioDeviceStore (261118)', () => {
  beforeEach(() => {
    saveConfig.mockClear();
    track.mockClear();
    useAudioDeviceStore.getState().hydrate({ audio_input_device: null, audio_output_device: null });
  });
  afterEach(() => audio.setOutputDeviceId(null));

  it('hydrates both choices and pushes the speaker to the playback side', () => {
    useAudioDeviceStore.getState().hydrate({ audio_input_device: 'mic-1', audio_output_device: 'spk-1' });
    expect(useAudioDeviceStore.getState().inputId).toBe('mic-1');
    expect(useAudioDeviceStore.getState().outputId).toBe('spk-1');
    expect(audio.getOutputDeviceId()).toBe('spk-1');
  });

  it('persists a pick and tracks only its shape', async () => {
    useAudioDeviceStore.getState().setDevice('audioinput', 'Headset-id', 'settings');
    await flush();
    expect(saveConfig).toHaveBeenCalledWith({ call_captions: true, audio_input_device: 'Headset-id' });
    expect(track).toHaveBeenCalledWith('mic_device_changed', { is_default: false, source: 'settings' });
    // No device id or label in analytics.
    expect(JSON.stringify(track.mock.calls)).not.toContain('Headset');
  });

  it('resets a missing mic to the system default quietly, once', async () => {
    useAudioDeviceStore.getState().hydrate({ audio_input_device: 'mic-gone', audio_output_device: null });
    resetMissingInput();
    resetMissingInput();
    await flush();
    expect(useAudioDeviceStore.getState().inputId).toBeNull();
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0][0]).toMatchObject({ audio_input_device: null });
    expect(track).toHaveBeenCalledWith('mic_device_changed', { is_default: true, source: 'gone' });
  });

  it('resets a speaker the playback side found gone', async () => {
    useAudioDeviceStore.getState().hydrate({ audio_input_device: null, audio_output_device: 'spk-gone' });
    const el = {
      sinkId: '',
      setSinkId: vi.fn(async (id: string) => {
        if (id === 'spk-gone') throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
      }),
    };
    await audio.applyOutputSink(el);
    await flush();
    expect(useAudioDeviceStore.getState().outputId).toBeNull();
    expect(audio.getOutputDeviceId()).toBeNull();
    expect(track).toHaveBeenCalledWith('speaker_device_changed', { is_default: true, source: 'gone' });
  });
});
