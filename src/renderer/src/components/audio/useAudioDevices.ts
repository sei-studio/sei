/**
 * The OS's microphones or speakers, kept current (261118). Re-read on the
 * `devicechange` event (a headset plugged in or out) and whenever a mic
 * stream opens (refreshAudioDevices): labels stay empty until media access is
 * granted, so the first open is what names the devices.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../lib/i18n';
import { deviceOptions, type AudioDeviceKind, type DeviceOption } from '../../lib/voice/audioDevices';

const refreshers = new Set<() => void>();

/** Re-read the device list in every mounted picker. */
export function refreshAudioDevices(): void {
  for (const fn of refreshers) fn();
}

export function useAudioDevices(kind: AudioDeviceKind): DeviceOption[] {
  const t = useT();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(() => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    md.enumerateDevices()
      .then(setDevices)
      .catch(() => {
        /* keep the last list */
      });
  }, []);
  useEffect(() => {
    refresh();
    refreshers.add(refresh);
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.addEventListener?.('devicechange', refresh);
    return () => {
      refreshers.delete(refresh);
      md?.removeEventListener?.('devicechange', refresh);
    };
  }, [refresh]);
  return useMemo(
    () =>
      deviceOptions(devices, kind, (n) =>
        kind === 'audioinput' ? t('Microphone {n}', { n }) : t('Speaker {n}', { n }),
      ),
    [devices, kind, t],
  );
}
