/**
 * ClipThatRow (261123, product call 261123): Settings toggle for Clip That.
 *
 * While a screen is shared, Clip That keeps a rolling recording so the
 * companion can save the last 15 seconds as a clip in chat: the player asks
 * ("clip that"), or the companion saves a great moment on its own (the
 * save_clip tool, backseatPrompts.ts). There is no button or hotkey.
 *
 * Off by default for new and existing players, because the rolling recorders
 * were the most expensive part of a share (shared/backseatIpc.ts CLIP_*). Off,
 * no MediaRecorder runs and the companion is not offered the tool. On, the
 * player picks the clip frame rate; 120 is a ceiling (a source that gives
 * less is recorded at what it gives), so the option says nothing more.
 *
 * Stateless view; SettingsScreen owns the write (no @testing-library here).
 */
import React from 'react';
import { CLIP_FPS_OPTIONS, type ClipFps } from '@shared/backseatIpc';
import { InfoTip } from '../InfoTip';
import { Seg } from '../Seg';
import { Toggle } from '../Toggle';
import { useT } from '../../lib/i18n';
import styles from '../../screens/SettingsScreen.module.css';

/** The one tooltip line, shared with the clip card in chat. */
export const CLIP_THAT_TIP =
  'Saves the last 15 seconds of your screen share as a clip in chat. Say "clip that" while sharing, or your companion clips great moments on their own.';

export interface ClipThatRowProps {
  on: boolean;
  fps: ClipFps;
  onToggle: (next: boolean) => void;
  onFps: (next: ClipFps) => void;
}

type FpsKey = `${ClipFps}`;

export function ClipThatRow({ on, fps, onToggle, onFps }: ClipThatRowProps): React.ReactElement {
  const t = useT();
  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>
          {t('Clip That')}
          <InfoTip label={t('About Clip That')} text={t(CLIP_THAT_TIP)} />
        </span>
        <Toggle aria-label={t('Clip That')} on={on} onChange={onToggle} />
      </div>
      {on ? (
        <div className={styles.row}>
          <span className={styles.label}>{t('Clip frame rate')}</span>
          <Seg<FpsKey>
            aria-label={t('Clip frame rate')}
            options={CLIP_FPS_OPTIONS.map((n) => ({ value: `${n}` as FpsKey, label: `${n} fps` }))}
            value={`${fps}` as FpsKey}
            onChange={(next) => onFps(Number(next) as ClipFps)}
          />
        </div>
      ) : null}
    </>
  );
}
