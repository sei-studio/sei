/**
 * MigrateLocalCharsModal — one-shot local→cloud migration prompt (Plan 11-18, D-20).
 *
 * Lists user-created characters that exist on this machine but are NOT in the
 * signed-in user's cloud row set (the LOCAL ONLY set from Plan 11-17). Per-char
 * checkbox (default: all checked). "Upload selected" calls migration:upload
 * which sequentially mirrors each uuid via cloudCharacterClient — partial
 * failures display per-row and the user can retry.
 *
 * Mount points (two):
 *   - App.tsx auto-mount: first time a user is signed_in + ToS accepted + has
 *     local-only chars + the shown flag is unset.
 *   - SettingsScreen entry: re-openable any time from the Account panel; bypasses
 *     the shown flag (Settings opens it explicitly via state).
 *
 * On "Maybe later" or "Done": writes the shown flag via migration:shown('set')
 * so the auto-mount won't re-fire. Settings entry remains available.
 *
 * Dismissal is button-only (Esc/scrim never close via ModalShell); during an
 * in-flight upload a capture-phase listener also swallows Esc so an ancestor
 * handler can't drop the user out mid-wipe.
 *
 * After successful upload: refresh useCloudCharactersStore so the LOCAL ONLY
 * chip drops without a reload.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useCloudCharactersStore } from '../lib/stores/useCloudCharactersStore';
import styles from './MigrateLocalCharsModal.module.css';

export interface MigrateLocalCharsModalProps {
  /** Closes the modal. Caller controls mount/unmount. */
  onClose: () => void;
}

interface LocalCharRow {
  id: string;
  name: string;
  slug: string | null;
  created: string;
}

interface UploadResult {
  id: string;
  ok: boolean;
  message?: string;
}

type Phase = 'loading' | 'idle' | 'submitting' | 'results';

export function MigrateLocalCharsModal({ onClose }: MigrateLocalCharsModalProps): React.ReactElement {
  const [chars, setChars] = useState<LocalCharRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('loading');
  const [results, setResults] = useState<UploadResult[]>([]);
  // MR-02: surface a banner when migration:listLocal failed to fetch the
  // cloud library. The candidate list then includes EVERY non-default local
  // character (the filter has nothing to subtract); the banner tells the
  // user why some of these may already be in cloud.
  const [cloudListOk, setCloudListOk] = useState<boolean>(true);

  // NR-03 — honor the docblock claim that this modal is non-dismissible during
  // submitting. ModalShell installs no Esc listener (escClose is off), but an
  // ancestor might; swallow Esc via a capture-phase keydown listener while the
  // upload is in flight so a partial wipe can't be aborted.
  useEffect(() => {
    if (phase !== 'submitting') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase]);

  // Load LOCAL ONLY list on mount. The handler swallows network failures and
  // returns its best-effort set, so this resolves either way.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await sei.migrationListLocal();
        if (cancelled) return;
        setChars(r.characters);
        setCloudListOk(r.cloudListOk);
        // Default: every row checked. User can uncheck individual rows before
        // submitting. If the set is empty, the idle render shows the empty
        // state and the primary action stays disabled.
        setSelected(new Set(r.characters.map((c) => c.id)));
        setPhase('idle');
      } catch {
        if (cancelled) return;
        setChars([]);
        setSelected(new Set());
        // Treat an IPC-level failure the same as a cloud-list failure — we
        // know nothing about cloud membership, so show the banner.
        setCloudListOk(false);
        setPhase('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUpload = async (): Promise<void> => {
    setPhase('submitting');
    const r = await sei.migrationUpload(Array.from(selected));
    setResults(r.results);
    setPhase('results');
    // Refresh the cloud-id cache so successfully-uploaded chars drop their
    // LOCAL ONLY chip on Home immediately. The store handles its own errors.
    void useCloudCharactersStore.getState().refresh();
  };

  const handleDismiss = (): void => {
    // Persist the "shown" flag so the auto-mount on App.tsx doesn't re-fire
    // on the next sign-in. Best-effort — the IPC handler swallows its own
    // errors. The Settings re-open entry remains available either way.
    void sei.migrationShown('set');
    onClose();
  };

  const handleResultsDone = (): void => {
    // Same as handleDismiss — flag set + close. Distinct handler so the future
    // we could insert "scroll to results / focus an item / refresh again" hooks
    // without untangling the dismiss path.
    void sei.migrationShown('set');
    onClose();
  };

  const toggleSelected = (id: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    // Dismissal is button-only — Esc/scrim never close (escClose + scrimClose
    // omitted). The user must hit "Maybe later" or "Done" to dismiss.
    <ModalShell title="Upload local companions?" width={460} escClose={false}>
      <p className={styles.body}>
        These companions are saved on this machine only. Upload any to your cloud party to use
        them on other devices.
      </p>
      <p className={styles.body}>Memory currently cannot be transferred to other devices.</p>

      {phase === 'loading' && <p className={styles.status}>Loading…</p>}

      {phase === 'idle' && !cloudListOk && (
        <p className={styles.warnBanner}>
          Couldn&apos;t fetch your cloud party, so we can&apos;t tell which of these are already
          synced. Uploading is safe (duplicates are ignored), but some rows may already be in your
          cloud party.
        </p>
      )}

      {phase === 'idle' && (
        <>
          <ul className={styles.list}>
            {chars.map((c) => (
              <li key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={(e) => toggleSelected(c.id, e.target.checked)}
                  />
                  <span>{c.name}</span>
                </label>
              </li>
            ))}
            {chars.length === 0 && <li className={styles.empty}>No local-only companions.</li>}
          </ul>
          <ModalFooter>
            <Button kind="quiet" size="md" onClick={handleDismiss}>
              Maybe later
            </Button>
            <Button
              kind="primary"
              size="md"
              onClick={() => void handleUpload()}
              disabled={selected.size === 0}
            >
              Upload selected
            </Button>
          </ModalFooter>
        </>
      )}

      {phase === 'submitting' && <p className={styles.status}>Uploading…</p>}

      {phase === 'results' && (
        <>
          <ul className={styles.list}>
            {results.map((r) => {
              const name = chars.find((c) => c.id === r.id)?.name ?? r.id;
              return (
                <li key={r.id} className={r.ok ? styles.resultOk : styles.resultFail}>
                  {r.ok ? '✓' : '✗'} {name}
                  {!r.ok && r.message ? (
                    <span className={styles.resultMessage}>: {r.message}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <ModalFooter>
            <Button kind="primary" size="md" onClick={handleResultsDone}>
              Done
            </Button>
          </ModalFooter>
        </>
      )}
    </ModalShell>
  );
}
