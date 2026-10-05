/**
 * TraySettingsGroup — "keep Sei running in the menu bar / tray" (261005).
 *
 * Off by default. With it on, closing the window leaves Sei running behind a
 * menu bar (macOS) or system tray (Windows) icon, which is what lets the
 * companion post a "free play is back" notification when the weekly allowance
 * resets. The login item is a sub-option, only meaningful while the main
 * toggle is on (main clears it when the toggle goes off).
 *
 * Hidden entirely where main reports no support (Linux, or an older preload).
 */
import React, { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { loadTraySettings, saveTraySettings } from '../../lib/traySettings';
import { InfoTip } from '../InfoTip';
import { Toggle } from '../Toggle';
import type { TraySettingsView } from '@shared/ipc';
import styles from '../../screens/SettingsScreen.module.css';

export function TraySettingsGroup(): React.ReactElement | null {
  const t = useT();
  const [view, setView] = useState<TraySettingsView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void loadTraySettings().then((v) => {
      if (live) setView(v);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!view || !view.supported) return null;
  const isMac = sei.platform === 'darwin';

  const apply = async (args: { enabled?: boolean; openAtLogin?: boolean }): Promise<void> => {
    if (busy) return;
    setBusy(true);
    // Optimistic, so the switch moves under the pointer; main's answer wins.
    setView((v) =>
      v
        ? {
            ...v,
            ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
            ...(args.openAtLogin !== undefined ? { openAtLogin: args.openAtLogin } : {}),
            ...(args.enabled === false ? { openAtLogin: false } : {}),
          }
        : v,
    );
    const next = await saveTraySettings({ ...args, source: 'settings' });
    if (next) setView(next);
    else void loadTraySettings().then((v) => v && setView(v));
    setBusy(false);
  };

  const keepLabel = isMac ? t('Keep Sei running in the menu bar') : t('Keep Sei running in the system tray');
  return (
    <div className={styles.group}>
      <h3 className={styles.groupTitle}>{isMac ? t('Menu bar') : t('System tray')}</h3>
      <div className={styles.row}>
        <span className={styles.label}>
          {keepLabel}
          <InfoTip
            label={t('About keeping Sei running')}
            text={
              isMac
                ? t(
                    'Closing the window keeps Sei running in the menu bar, so your companion can tell you when free play is back. Quit from the menu bar icon.',
                  )
                : t(
                    'Closing the window keeps Sei running in the system tray, so your companion can tell you when free play is back. Quit from the tray icon.',
                  )
            }
          />
        </span>
        <Toggle aria-label={keepLabel} on={view.enabled} disabled={busy} onChange={(v) => void apply({ enabled: v })} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>
          {t('Start Sei when I log in')}
          <InfoTip
            label={t('About starting Sei at login')}
            text={
              isMac
                ? t('Sei opens quietly in the menu bar when you log in, without a window.')
                : t('Sei opens quietly in the system tray when you log in, without a window.')
            }
          />
        </span>
        <Toggle
          aria-label={t('Start Sei when I log in')}
          on={view.openAtLogin}
          disabled={busy || !view.enabled}
          onChange={(v) => void apply({ openAtLogin: v })}
        />
      </div>
      {view.loginNeedsApproval && (
        <p className={styles.helper}>
          {t('macOS needs your OK for this. Turn Sei on in System Settings, General, Login Items.')}
        </p>
      )}
    </div>
  );
}
