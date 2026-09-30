/**
 * ScreenAccessGate (260929): macOS Screen Recording, before the share picker
 * lists anything.
 *
 * Without the grant macOS hands Sei the displays and Sei's own windows and
 * nothing else, so the picker used to show an empty or wallpaper-only list
 * with no word on why. The share picker now asks main first (screenAccess
 * below) and, if access is off, renders this step in its place: one line on
 * why, "Open Settings" deep-linked to Privacy & Security > Screen Recording,
 * and a poll that re-lists sources about once a second and hands back to the
 * picker the moment another app's window shows up.
 *
 * The poll re-lists instead of re-reading the status because Electron's status
 * read (CGPreflightScreenCaptureAccess) keeps saying "denied" for the life of
 * the process once it has. And macOS often will not give a running process a
 * new grant at all, so 20 seconds after the player says they turned it on
 * with nothing to show for it, the card offers "Restart Sei and continue": a
 * relaunch that reopens this picker for the same companion after boot.
 *
 * The resume flag is armed as soon as System Settings is opened, not only on
 * our restart button: macOS's own "Quit & Reopen" prompt restarts Sei too,
 * and the player should land back in the picker either way. It is cleared on
 * grant and on Cancel, and expires on its own after ten minutes.
 *
 * Nothing here runs on Windows: the share picker skips the gate there.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { openPermissionSettings, trackPermission } from '../../lib/permissions/permissionFlow';
import type { BackseatGameSelection } from '@shared/backseatGames';
import { restartOfferDue } from '../../lib/permissions/accessPoller';
import { Button } from '../Button';
import { ModalFooter } from '../ModalShell';
import { useAccessPoll } from './useAccessPoll';
import styles from './PermissionCard.module.css';

/** Is Screen Recording usable right now? macOS only; true elsewhere. */
export async function screenAccess(platform: string = sei.platform): Promise<boolean> {
  if (platform !== 'darwin') return true;
  try {
    if ((await sei.permissionsStatus('screen')) === 'granted') return true;
    return await sei.permissionsProbeScreen();
  } catch {
    // An old main without the channel: let the picker try, as before.
    return true;
  }
}

export function ScreenAccessGate({
  characterId,
  game,
  onGranted,
  onCancel,
  initialStage = 'ask',
}: {
  characterId: string;
  /** The backseat game the share came from, so a restart reopens it too. */
  game?: BackseatGameSelection;
  onGranted: () => void;
  onCancel: () => void;
  /** Screenshot harness only: start on a later stage. */
  initialStage?: 'ask' | 'waiting' | 'restart';
}): React.ReactElement {
  const t = useT();
  const [opened, setOpened] = useState(initialStage !== 'ask');
  const [confirmedAt, setConfirmedAt] = useState<number | null>(
    initialStage === 'restart' ? Date.now() - 60_000 : null,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    trackPermission('permission_prompt_shown', 'screen');
  }, []);

  // The 20-second clock only ticks once the player has said they allowed it.
  useEffect(() => {
    if (confirmedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [confirmedAt]);
  const offerRestart = restartOfferDue(confirmedAt, now);

  const granted = useCallback(() => {
    trackPermission('permission_granted', 'screen');
    void sei.permissionsClearResume().catch(() => {});
    onGranted();
  }, [onGranted]);

  // The picker already probed once before showing this, so wait one interval.
  useAccessPoll(true, () => sei.permissionsProbeScreen().catch(() => false), granted, false);

  const openSettings = (): void => {
    setOpened(true);
    void sei.permissionsArmResume({ kind: 'share-screen', characterId, ...(game ? { game } : {}) }).catch(() => {});
    void openPermissionSettings('screen');
  };

  const cancel = (): void => {
    void sei.permissionsClearResume().catch(() => {});
    onCancel();
  };

  const restart = (): void => {
    void sei.permissionsRelaunch({ kind: 'share-screen', characterId, ...(game ? { game } : {}) }).catch(() => {});
  };

  return (
    <>
      <div className={styles.body}>
        <p className={styles.why}>{t('Sei needs Screen Recording permission to see your screen.')}</p>
        <p className={styles.how}>
          {t('In System Settings, open Privacy & Security > Screen Recording and turn on Sei.')}
        </p>
        {offerRestart ? (
          <p className={styles.how}>{t('macOS sometimes needs Sei to restart before it can see the screen.')}</p>
        ) : opened ? (
          <p className={styles.waiting}>
            <span className={styles.dot} aria-hidden="true" />
            {t('Your windows show up here once access is on.')}
          </p>
        ) : null}
      </div>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={cancel}>
          {t('Cancel')}
        </Button>
        {!opened ? (
          <Button size="md" onClick={openSettings}>
            {t('Open Settings')}
          </Button>
        ) : offerRestart ? (
          <>
            <Button kind="ghost" size="md" onClick={openSettings}>
              {t('Open Settings')}
            </Button>
            <Button size="md" onClick={restart}>
              {t('Restart Sei and continue')}
            </Button>
          </>
        ) : (
          <>
            <Button kind="ghost" size="md" onClick={openSettings}>
              {t('Open Settings')}
            </Button>
            <Button
              size="md"
              disabled={confirmedAt !== null}
              onClick={() => {
                setConfirmedAt(Date.now());
                setNow(Date.now());
              }}
            >
              {confirmedAt !== null ? t('Checking...') : t('I turned it on')}
            </Button>
          </>
        )}
      </ModalFooter>
    </>
  );
}
