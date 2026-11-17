/**
 * The call's mic menu (261118): a small panel above the mute pill with the
 * same two pickers Settings has. Picking a mic moves the live capture
 * (useVoiceStore follows useAudioDeviceStore); picking a speaker re-points
 * the call's audio. Opened by the caret next to the mute pill and by the
 * "Can't hear you?" hint; closes on Escape or a click outside the group.
 */
import React, { useEffect } from 'react';
import { useT } from '../../lib/i18n';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { AudioDeviceSelect } from './AudioDeviceSelect';
import styles from './AudioDevices.module.css';

export function MicMenu({ groupRef }: { groupRef: React.RefObject<HTMLElement | null> }): React.ReactElement | null {
  const t = useT();
  const open = useVoiceStore((s) => s.micMenuOpen);
  const setOpen = useVoiceStore((s) => s.setMicMenuOpen);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const g = groupRef.current;
      if (g && e.target instanceof Node && g.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen, groupRef]);

  if (!open) return null;
  return (
    <div className={styles.micMenu} role="dialog" aria-label={t('Microphone and speakers')}>
      <span className={styles.micMenuLabel}>{t('Microphone')}</span>
      <AudioDeviceSelect kind="audioinput" source="call" className={styles.micMenuSelect} ariaLabel={t('Microphone')} />
      <span className={styles.micMenuLabel}>{t('Speakers')}</span>
      <AudioDeviceSelect kind="audiooutput" source="call" className={styles.micMenuSelect} ariaLabel={t('Speakers')} />
    </div>
  );
}
