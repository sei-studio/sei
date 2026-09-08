/**
 * DstSetupBody — the Don't Starve Together body of the generic setup modal
 * (game adapters M2, 260908; registered through lib/gameSetupBodies). The
 * modal itself keeps the pending summon and auto-resumes when the world
 * opens; this body tells the player what is missing right now: the game,
 * Sei's helper, or a hosted world, with the one button that fixes it.
 */
import React, { useEffect } from 'react';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useDstStore } from './useDstStore';
import modalStyles from '../LanNotOpenModal.module.css';
import styles from './dst.module.css';

export function DstSetupBody(): React.ReactElement {
  const t = useT();
  const install = useDstStore((s) => s.install);
  const installBusy = useDstStore((s) => s.installBusy);
  const launching = useDstStore((s) => s.launching);
  const refreshInstall = useDstStore((s) => s.refreshInstall);
  const runInstall = useDstStore((s) => s.runInstall);
  const launchGame = useDstStore((s) => s.launchGame);
  const world = useDataStore((s) => s.worlds.dontstarve);

  useEffect(() => {
    void refreshInstall();
  }, [refreshInstall]);

  if (install?.kind === 'not_found') {
    return (
      <>
        <p className={modalStyles.body}>{t("We couldn't find Don't Starve Together on this computer. Install it through Steam, then check again.")}</p>
        <div className={styles.actions}>
          <Button kind="primary" size="md" onClick={() => void refreshInstall()}>{t('Check again')}</Button>
        </div>
      </>
    );
  }
  if (install?.kind === 'found' && !install.modInstalled) {
    return (
      <>
        <p className={modalStyles.body}>{t("Sei's helper is not in your game yet. It is a small server-side mod; friends who join need nothing.")}</p>
        <div className={styles.actions}>
          <Button kind="primary" size="md" disabled={installBusy} onClick={() => void runInstall()}>{t("Add Sei's helper")}</Button>
        </div>
      </>
    );
  }
  if (install?.kind === 'installing') {
    return <p className={modalStyles.body}>{t("Adding Sei's helper...")}</p>;
  }
  if (install?.kind === 'error') {
    return (
      <>
        <p className={modalStyles.body}>{t("Couldn't add Sei's helper. Make sure the game is closed, then try again.")}</p>
        <div className={styles.actions}>
          <Button kind="primary" size="md" disabled={installBusy} onClick={() => void runInstall()}>{t('Try again')}</Button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className={modalStyles.body}>
        {world?.kind === 'unavailable'
          ? t("Sei couldn't open its local port for Don't Starve Together. Change the discovery port in Settings, or close whatever is using it, and try again.")
          : t('Open Don\'t Starve Together and host a world (any slot, caves on or off). Your companion joins as soon as the world is running.')}
      </p>
      <p className={modalStyles.hint}>{t('Sei keeps looking while this window is open.')}</p>
      <div className={styles.actions}>
        <Button kind="primary" size="md" disabled={launching} onClick={() => void launchGame()}>
          {launching ? t('Opening Steam...') : t("Launch Don't Starve Together")}
        </Button>
      </div>
    </>
  );
}
