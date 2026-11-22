/**
 * LocalImportRow â€” Settings â†’ Account entry for the own-key import (261023).
 *
 * The import is offered on sign-in and once at boot; a player who chose "Not
 * now" (or never saw it) can bring their local companions in from here. The
 * row shows only while the local profile has something worth bringing
 * (hasImportableLeftovers: not just the untouched Sui the first-run scene
 * seeded), and re-checks after each import so it disappears once done.
 *
 * 261116: when the local companions would not fit the party, the sign-in
 * and boot offers skip the import and point here. The row then says the
 * party is full under the label and its button is off; it re-checks
 * whenever the party changes, so freeing a slot turns it back on.
 */
import React, { useEffect, useState } from 'react';
import type { PeekLocalProfileResult } from '@shared/ipc';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { hasImportableLeftovers, importBlockedByParty } from '../../lib/localImportOffer';
import { trackLocalImportPartyFull } from '../../lib/localImportTrack';
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
  const full = importBlockedByParty(peek);
  return (
    <div className={styles.row} data-local-import={full ? 'party-full' : 'ready'}>
      <span className={`${styles.label} ${styles.labelStack}`}>
        <span>{t('Companions from before you signed in')}</span>
        {full ? <span className={styles.helper}>{t('Your party is full. Free a slot to bring them over.')}</span> : null}
      </span>
      <Button kind="ghost" size="sm" onClick={onOpen} disabled={full}>
        {t('Bring over')}
      </Button>
    </div>
  );
}

export function LocalImportRow({ accountId }: { accountId: string }): React.ReactElement {
  const [peek, setPeek] = useState<PeekLocalProfileResult | null>(null);
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState(0);
  // The party as the rail and Home count it: re-check when it changes, so
  // unbinding a companion (party full, 261116) enables the row again.
  const partyKey = useDataStore((s) => s.characters.map((c) => c.id).join(','));
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);

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
  }, [accountId, checks, partyKey, addedWorldIds, addedDefaultIds]);
  // Seen with the button off: once per row mount.
  const fullSeen = React.useRef(false);
  useEffect(() => {
    if (fullSeen.current || !peek || !hasImportableLeftovers(peek) || !importBlockedByParty(peek)) return;
    fullSeen.current = true;
    trackLocalImportPartyFull('settings', peek.party);
  }, [peek]);

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
        <ImportLocalProfileModal peek={peek} existingAccount entry="settings" onDone={() => void handleDone()} />
      ) : null}
    </>
  );
}




