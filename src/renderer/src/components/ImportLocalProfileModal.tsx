/**
 * ImportLocalProfileModal — offered once on FIRST sign-in to a fresh account
 * (260603 per-profile partitioning).
 *
 * With per-profile partitioning, signing into a brand-new account starts from
 * an empty profile. If the user built a companion while signed out (in the
 * anonymous `local` profile), this modal offers to bring it across:
 * user-created characters + their local memory + the MC username / preferred
 * name they already entered. Declining starts the account fresh (onboarding).
 *
 * Only offered on local→account first sign-in — never account→account, so
 * switching between accounts always starts fresh.
 *
 * Renders through ModalShell; dismissal is button-only (choice is required).
 */
import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import type { PeekLocalProfileResult } from '../../../shared/ipc';
import styles from './confirmModal.module.css';

export interface ImportLocalProfileModalProps {
  peek: PeekLocalProfileResult;
  /** Called after the user chooses. `didImport` = the local data was imported. */
  onDone: (didImport: boolean) => void;
}

export function ImportLocalProfileModal({ peek, onDone }: ImportLocalProfileModalProps): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);
  const count = peek.migratableCharacterIds.length;
  const charLabel = count === 1 ? 'companion' : 'companions';

  async function handleImport(): Promise<void> {
    setSubmitting(true);
    try {
      await sei.profileImportFromLocal();
    } catch {
      // Best-effort — even on partial failure we proceed; the user can still
      // continue into the account (whatever imported is now theirs).
    } finally {
      onDone(true);
    }
  }

  return (
    <ModalShell title="Bring your companion to this account?" escClose={false}>
      <p className={styles.body}>
        {count > 0
          ? `You set up ${count} ${charLabel} before signing in. Bring ${count === 1 ? 'it' : 'them'}, along with your memories together, into this account, or start fresh.`
          : `Bring your existing setup into this account, or start fresh.`}
      </p>
      {submitting ? (
        <p className={styles.status}>Importing…</p>
      ) : (
        <ModalFooter>
          <Button kind="ghost" onClick={() => onDone(false)}>
            Start fresh
          </Button>
          <Button kind="primary" onClick={() => void handleImport()}>
            Bring it over
          </Button>
        </ModalFooter>
      )}
    </ModalShell>
  );
}
