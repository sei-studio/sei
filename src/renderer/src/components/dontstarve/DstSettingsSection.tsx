/**
 * DstSettingsSection — the Settings "Don't Starve Together" group (game
 * adapters M2, 260908): install status (game found, helper installed and
 * enabled, with the one-click add) and the game folder. The discovery port
 * row is GONE (260909): main binds the first free port of a fixed list and
 * the helper probes the same list, so there is nothing for the player to
 * set and nothing here to explain.
 */
import React, { useEffect } from 'react';
import { useT } from '../../lib/i18n';
import type { GameSettingsSectionProps } from '../../lib/gameSettingsSections';
import { Button } from '../Button';
import { useDstStore } from './useDstStore';
import settings from '../../screens/SettingsScreen.module.css';
import styles from './dst.module.css';

export function DstSettingsSection(_props: GameSettingsSectionProps): React.ReactElement {
  const t = useT();
  const install = useDstStore((s) => s.install);
  const installBusy = useDstStore((s) => s.installBusy);
  const refreshInstall = useDstStore((s) => s.refreshInstall);
  const runInstall = useDstStore((s) => s.runInstall);

  useEffect(() => {
    void refreshInstall();
  }, [refreshInstall]);

  const status =
    install == null
      ? t('Checking...')
      : install.kind === 'not_found'
        ? t('Game not found')
        : install.kind === 'installing'
          ? t("Adding Sei's helper...")
          : install.kind === 'error'
            ? t('Setup failed')
            : !install.modInstalled
              ? t('Game found, helper not installed')
              : install.enabled
                ? t('Helper installed (v{version})', { version: install.modVersion ?? '?' })
                : t('Helper installed, not enabled');

  return (
    <>
      <div className={settings.row}>
        <span className={styles.rowLabel}>{t('Helper mod')}</span>
        <span className={styles.rowValue}>{status}</span>
        {install?.kind === 'found' && (!install.modInstalled || !install.enabled) ? (
          <Button kind="primary" size="sm" disabled={installBusy} onClick={() => void runInstall()}>
            {install.modInstalled ? t('Enable') : t('Add')}
          </Button>
        ) : install?.kind === 'not_found' ? (
          <Button kind="quiet" size="sm" onClick={() => void refreshInstall()}>{t('Check again')}</Button>
        ) : null}
      </div>
      {install?.kind === 'found' ? (
        <div className={settings.row}>
          <span className={styles.rowLabel}>{t('Game folder')}</span>
          <span className={styles.pathValue}>{install.installPath}</span>
        </div>
      ) : null}
    </>
  );
}
