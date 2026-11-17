/**
 * One native select for a microphone or a speaker (261118): "System default"
 * first, then every device the OS lists, by label. Used by Settings >
 * Microphone and speakers; it writes the saved choice (useAudioDeviceStore),
 * and a mic picked while a call runs moves the live capture.
 *
 * A saved device that is not plugged in right now stays selected as
 * "Disconnected device" rather than silently showing the default: the call
 * falls back and resets it on its next use (audioDevices.ts), not this list.
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { useAudioDeviceStore } from '../../lib/stores/useAudioDeviceStore';
import type { AudioDeviceKind } from '../../lib/voice/audioDevices';
import { useAudioDevices } from './useAudioDevices';

export interface AudioDeviceSelectProps {
  kind: AudioDeviceKind;
  className?: string;
  ariaLabel: string;
}

export function AudioDeviceSelect({ kind, className, ariaLabel }: AudioDeviceSelectProps): React.ReactElement {
  const t = useT();
  const savedId = useAudioDeviceStore((s) => (kind === 'audioinput' ? s.inputId : s.outputId));
  const setDevice = useAudioDeviceStore((s) => s.setDevice);
  const options = useAudioDevices(kind);
  const missing = savedId !== null && !options.some((o) => o.id === savedId);
  return (
    <select
      className={className}
      aria-label={ariaLabel}
      value={savedId ?? ''}
      onChange={(e) => setDevice(kind, e.target.value || null, 'settings')}
    >
      <option value="">{t('System default')}</option>
      {missing ? <option value={savedId}>{t('Disconnected device')}</option> : null}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
