/**
 * DstSettingsSection — the Settings "Don't Starve Together" group (game
 * adapters M2, 260908): install status (game found, helper installed and
 * enabled, with the one-click add), and the discovery port the helper
 * heartbeats to. The port is written through dst:set-port (not the renderer's
 * wholesale config save) so main can rebind its listener in the same step;
 * the mod's own `port` option must match, which is why the row says so.
 */
import React, { useEffect, useState } from 'react';
import { DST_DEFAULT_PORT } from '@shared/dstIpc';
import { useT } from '../../lib/i18n';
import type { GameSettingsSectionProps } from '../../lib/gameSettingsSections';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useDstStore } from './useDstStore';
import settings from '../../screens/SettingsScreen.module.css';
import styles from './dst.module.css';

export function DstSettingsSection({ config }: GameSettingsSectionProps): React.ReactElement {
  const t = useT();
  const install = useDstStore((s) => s.install);
  const installBusy = useDstStore((s) => s.installBusy);
  const refreshInstall = useDstStore((s) => s.refreshInstall);
  const runInstall = useDstStore((s) => s.runInstall);
  const setPort = useDstStore((s) => s.setPort);
  const world = useDataStore((s) => s.worlds.dontstarve);
  const configuredPort = config?.dst_port ?? DST_DEFAULT_PORT;
  const [port, setPortText] = useState(String(configuredPort));

  useEffect(() => {
    void refreshInstall();
  }, [refreshInstall]);
  useEffect(() => {
    setPortText(String(configuredPort));
  }, [configuredPort]);

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

  const commitPort = (): void => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setPortText(String(configuredPort));
      return;
    }
    if (n !== configuredPort) void setPort(n);
  };

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
      <div className={settings.row}>
        <span className={styles.rowLabel}>{t('Discovery port')}</span>
        <input
          className={styles.portInput}
          type="number"
          min={1024}
          max={65535}
          value={port}
          aria-label={t('Discovery port')}
          onChange={(e) => setPortText(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <span className={styles.portHelper}>
          {world?.kind === 'unavailable'
            ? t('This port is in use. Pick another one and set the same port in the helper mod\'s options in the game.')
            : t('Only change this if another program uses port {port}; set the same port in the helper mod\'s options in the game.', { port: DST_DEFAULT_PORT })}
        </span>
      </div>
    </>
  );
}
