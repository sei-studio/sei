/**
 * The saved microphone and speaker (261118). Hydrated from UserConfig
 * (audio_input_device / audio_output_device) in App.tsx, written through to
 * config on every change. The pure rules live in lib/voice/audioDevices.ts;
 * this store only owns the persisted choice, its analytics, and the quiet
 * reset when a saved device has gone.
 *
 * Analytics are shape only: whether the choice is the system default and
 * where it was made. Device ids and labels never leave the renderer (a label
 * is often a person's name: "Ana's AirPods").
 */
import { create } from 'zustand';
import type { UserConfig } from '@shared/characterSchema';
import { sei } from '../ipcClient';
import { setOutputDeviceId, setOutputGoneHandler, type AudioDeviceKind } from '../voice/audioDevices';

/** Where a device choice was made. 'gone' = the quiet reset of a missing device. */
export type DeviceChangeSource = 'settings' | 'call' | 'gone';

interface AudioDeviceState {
  /** Saved input deviceId, or null for the system default. */
  inputId: string | null;
  /** Saved output deviceId, or null for the system default. */
  outputId: string | null;
  hydrate: (cfg: Pick<UserConfig, 'audio_input_device' | 'audio_output_device'> | null | undefined) => void;
  setDevice: (kind: AudioDeviceKind, id: string | null, source: DeviceChangeSource) => void;
}

const CONFIG_KEY: Record<AudioDeviceKind, 'audio_input_device' | 'audio_output_device'> = {
  audioinput: 'audio_input_device',
  audiooutput: 'audio_output_device',
};

const EVENT: Record<AudioDeviceKind, string> = {
  audioinput: 'mic_device_changed',
  audiooutput: 'speaker_device_changed',
};

function persist(kind: AudioDeviceKind, id: string | null): void {
  // Read-modify-write of the whole renderer copy: main keeps only the
  // renderer-settable keys (saveConfigFromRenderer), so this cannot revert a
  // main-owned field.
  void sei
    .getConfig()
    .then((cfg) => sei.saveConfig({ ...cfg, [CONFIG_KEY[kind]]: id }))
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(`[sei/audio] saving ${CONFIG_KEY[kind]} failed: ${(err as Error)?.message ?? err}`);
    });
}

export const useAudioDeviceStore = create<AudioDeviceState>((set, get) => ({
  inputId: null,
  outputId: null,
  hydrate: (cfg) => {
    const inputId = cfg?.audio_input_device || null;
    const outputId = cfg?.audio_output_device || null;
    setOutputDeviceId(outputId);
    set({ inputId, outputId });
  },
  setDevice: (kind, id, source) => {
    const next = id || null;
    const field = kind === 'audioinput' ? 'inputId' : 'outputId';
    if (get()[field] === next) return;
    set({ [field]: next } as Pick<AudioDeviceState, 'inputId' | 'outputId'>);
    if (kind === 'audiooutput') setOutputDeviceId(next);
    persist(kind, next);
    try {
      sei.track(EVENT[kind], { is_default: next === null, source });
    } catch {
      /* analytics is never load-bearing */
    }
  },
}));

/** The saved mic is gone: back to the system default, no UI. */
export function resetMissingInput(): void {
  if (useAudioDeviceStore.getState().inputId === null) return;
  useAudioDeviceStore.getState().setDevice('audioinput', null, 'gone');
}

// A saved speaker that turns out to be gone resets the same way. Registered
// once at module load (the store is imported by App.tsx at boot).
setOutputGoneHandler(() => {
  if (useAudioDeviceStore.getState().outputId === null) return;
  useAudioDeviceStore.getState().setDevice('audiooutput', null, 'gone');
});
