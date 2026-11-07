/**
 * OpenAtLoginRow (261107): Settings > Appearance "Open Sei when I log in".
 *
 * The same setting the WorldLink move-in sheet offers
 * (main/seilink/openAtLogin.ts): off by default, shown only on a packaged
 * macOS or Windows build where WorldLink runs (`supported`). Main applies it
 * to the OS login item, reads it back and answers the state it found, so the
 * switch shows what the OS took: a refused change flips back with a short
 * line, and macOS 13+ waiting for approval says where to allow it.
 *
 * Split into a stateless view and a container (no @testing-library here).
 */
import React, { useEffect, useState } from 'react';
import type { OpenAtLoginState } from '@shared/openAtLogin';
import { InfoTip } from '../InfoTip';
import { Toggle } from '../Toggle';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import styles from '../../screens/SettingsScreen.module.css';

export interface OpenAtLoginRowViewProps {
  state: OpenAtLoginState | null;
  busy: boolean;
  /** The last change did not take. */
  failed: boolean;
  onToggle: (next: boolean) => void;
}

export function OpenAtLoginRowView({ state, busy, failed, onToggle }: OpenAtLoginRowViewProps): React.ReactElement | null {
  const t = useT();
  if (!state?.supported) return null;
  const note = failed
    ? t('Could not change this setting. Try again.')
    : state.needsApproval
      ? t('Allow Sei in System Settings, under General > Login Items.')
      : null;
  return (
    <>
      <div className={[styles.row, note ? styles.rowOpen : ''].filter(Boolean).join(' ')}>
        <span className={styles.label}>
          {t('Open Sei when I log in')}
          <InfoTip
            label={t('About opening Sei at login')}
            text={t(
              'Starts Sei in the background when you log in, so the companion on your desktop is back in their room. The Sei window stays closed until you open it.',
            )}
          />
        </span>
        <Toggle aria-label={t('Open Sei when I log in')} on={state.enabled} disabled={busy} onChange={onToggle} />
      </div>
      {note ? (
        <div className={styles.inlineConfirm} role="status">
          <p className={styles.inlineConfirmText}>{note}</p>
        </div>
      ) : null}
    </>
  );
}

export function OpenAtLoginRow(): React.ReactElement | null {
  const [state, setState] = useState<OpenAtLoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let dead = false;
    void (sei.seilinkLoginItemGet?.() ?? Promise.resolve(null)).then(
      (s) => {
        if (!dead) setState(s);
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, []);
  const onToggle = (next: boolean): void => {
    if (!sei.seilinkLoginItemSet) return;
    setBusy(true);
    setFailed(false);
    void sei
      .seilinkLoginItemSet(next, 'settings')
      .then(
        (s) => {
          setState(s);
          setFailed(s.enabled !== next);
        },
        () => setFailed(true),
      )
      .finally(() => setBusy(false));
  };
  return <OpenAtLoginRowView state={state} busy={busy} failed={failed} onToggle={onToggle} />;
}
