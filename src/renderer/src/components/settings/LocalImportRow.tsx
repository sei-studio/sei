/**
 * LocalImportRow — Settings → Account entry for the own-key import (261023).
 *
 * The import is offered on sign-in and once at boot; a player who chose "Not
 * now" (or never saw it) can bring their local companions in from here. The
 * row shows only while the local profile has something worth bringing
 * (hasImportableLeftovers: not just the untouched Sui the first-run scene
 * seeded), and re-checks after each import so it disappears once done.
 */
import React, { useEffect, useState } from 'react';
import type { PeekLocalProfileResult } from '@shared/ipc';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { hasImportableLeftovers } from '../../lib/localImportOffer';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useLibraryStateStore } from '../../lib/stores/useLibraryStateStore';
import { Button } from '../Button';
import { ImportLocalProfileModal } from '../ImportLocalProfileModal';
import styles from '../../screens/SettingsScreen.module.css';

/** The row itself, or nothing when there is nothing to bring. */
export function LocalImportRowView({
  peek,
  onOpen,
}: {
  peek: PeekLocalProfileResult | null;
  onOpen: () => void;
}): React.ReactElement | null {
  const t = useT();
  if (!hasImportableLeftovers(peek)) return null;
  return (
    <div className={styles.row}>
      <span className={styles.label}>{t('Companions from before you signed in')}</span>
      <Button kind="ghost" size="sm" onClick={onOpen}>
        {t('Bring over')}
      </Button>
    </div>
  );
}

export function LocalImportRow({ accountId }: { accountId: string }): React.ReactElement {
  const [peek, setPeek] = useState<PeekLocalProfileResult | null>(null);
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState(0);

  useEffect(() => {
    let cancelled = false;
    sei
      .profilePeekLocal()
      .then((p) => {
        if (!cancelled) setPeek(p);
      })
      .catch(() => {
        if (!cancelled) setPeek(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, checks]);

  async function handleDone(): Promise<void> {
    setOpen(false);
    // Answered here: the boot offer does not ask again either.
    void sei.profileImportOffered('set').catch(() => undefined);
    try { await useDataStore.getState().loadCharacters(); } catch { /* empty-state */ }
    try { await useLibraryStateStore.getState().refresh(); } catch { /* none */ }
    setChecks((n) => n + 1);
  }

  return (
    <>
      <LocalImportRowView peek={peek} onOpen={() => setOpen(true)} />
      {open && peek ? (
        <ImportLocalProfileModal peek={peek} existingAccount onDone={() => void handleDone()} />
      ) : null}
    </>
  );
}
