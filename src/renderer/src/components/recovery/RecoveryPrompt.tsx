/**
 * RecoveryPrompt — in-app phantom-call recovery (260810).
 *
 * Self-mounting like NoticesInboxModal: renders null until a scan finds a
 * non-dismissed phantom-call session (a voice call left running while other
 * audio fed the mic — see src/main/recovery/phantomDetect.ts for the cadence
 * signature). Scans run:
 *   - once shortly after app mount, and
 *   - debounced after a voice call or backseat share ENDS (subscribed to the
 *     store transitions here rather than hooked inside the stores, so the
 *     concurrently-edited 1800-line useVoiceStore stays untouched).
 *
 * Flow: prompt ("Is your companion acting weird?") → Ignore dismisses the
 * shown windows for good, Begin recovery shows the session list (all
 * pre-checked) → Clean up runs recovery:repair per character, evicts the
 * repaired characters from useChatStore so the cleaned transcript shows
 * without a restart, then shows the success state.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT, uiLanguage } from '../../lib/i18n';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { useBackseatStore } from '../../lib/stores/useBackseatStore';
import { useChatStore } from '../../lib/stores/useChatStore';
import { ModalShell, ModalFooter } from '../ModalShell';
import { Button } from '../Button';
import confirmStyles from '../confirmModal.module.css';
import styles from './RecoveryPrompt.module.css';
import type { RecoveryCandidate, RecoveryWindow } from '@shared/ipc';

/** Delay after mount before the first scan (stays out of boot IO). */
const MOUNT_SCAN_DELAY_MS = 5_000;
/** Debounce after a call/share end transition before scanning. */
const END_SCAN_DEBOUNCE_MS = 3_000;

/** Views where a recovery popup must never appear (pre-app / ritual surfaces). */
const PRE_APP_VIEWS = new Set(['onboarding', 'auth-choice', 'skin-setup', 'unique-reveal']);

const keyOf = (c: RecoveryCandidate): string => `${c.characterId}:${c.startTs}`;

export function RecoveryPrompt(): React.ReactElement | null {
  const t = useT();
  const viewKind = useUiStore((s) => s.view.kind);
  const [candidates, setCandidates] = useState<RecoveryCandidate[] | null>(null);
  const [stage, setStage] = useState<'prompt' | 'list' | 'done'>('prompt');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const timerRef = useRef<number | null>(null);
  const scanningRef = useRef(false);
  const openRef = useRef(false);
  openRef.current = candidates !== null;

  const runScan = useCallback(async () => {
    if (scanningRef.current || openRef.current) return;
    // Never scan (or pop) while a surface is still live — the transcript is
    // being written and the end transition will re-trigger us anyway.
    if (useVoiceStore.getState().status !== 'idle') return;
    if (useBackseatStore.getState().sharingFor) return;
    if (PRE_APP_VIEWS.has(useUiStore.getState().view.kind as string)) return;
    scanningRef.current = true;
    try {
      const found = await sei.recoveryScan();
      if (found.length > 0 && !openRef.current) {
        const all: Record<string, boolean> = {};
        for (const c of found) all[keyOf(c)] = true;
        setChecked(all);
        setStage('prompt');
        setFailed(false);
        setCandidates(found);
      }
    } catch {
      // Scan is best-effort; a failure just means no prompt this time.
    } finally {
      scanningRef.current = false;
    }
  }, []);

  const scheduleScan = useCallback(
    (delayMs: number) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void runScan();
      }, delayMs);
    },
    [runScan],
  );

  // Mount scan + end-transition triggers.
  useEffect(() => {
    scheduleScan(MOUNT_SCAN_DELAY_MS);
    const offVoice = useVoiceStore.subscribe((s, prev) => {
      if (prev.status !== 'idle' && s.status === 'idle') scheduleScan(END_SCAN_DEBOUNCE_MS);
    });
    const offBackseat = useBackseatStore.subscribe((s, prev) => {
      if (prev.sharingFor && !s.sharingFor) scheduleScan(END_SCAN_DEBOUNCE_MS);
    });
    return () => {
      offVoice();
      offBackseat();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [scheduleScan]);

  if (candidates === null) return null;
  // A pre-app view took over after the scan (e.g. re-onboarding): stay hidden.
  if (PRE_APP_VIEWS.has(viewKind as string)) return null;

  const close = (): void => {
    setCandidates(null);
    setBusy(false);
    setFailed(false);
  };

  const ignore = (): void => {
    void sei.recoveryDismiss(candidates.map(keyOf)).catch(() => {});
    close();
  };

  const cleanUp = async (): Promise<void> => {
    const selected = candidates.filter((c) => checked[keyOf(c)]);
    if (selected.length === 0 || busy) return;
    setBusy(true);
    setFailed(false);
    // One repair call per character carrying all its selected windows, so each
    // character gets exactly one backup + one sidecar set.
    const byChar = new Map<string, RecoveryWindow[]>();
    for (const c of selected) {
      const list = byChar.get(c.characterId) ?? [];
      list.push({ start: c.startTs, end: c.endTs });
      byChar.set(c.characterId, list);
    }
    try {
      for (const [characterId, windows] of byChar) {
        await sei.recoveryRepair(characterId, windows);
      }
      // Evict the repaired characters' cached transcripts so the cleaned
      // history shows without an app restart (same path Reset memory uses).
      const chat = useChatStore.getState();
      for (const characterId of byChar.keys()) chat.evictLocal(characterId);
      void chat.loadPreviews().catch(() => {});
      setBusy(false);
      setStage('done');
    } catch {
      setBusy(false);
      setFailed(true);
    }
  };

  const fmtRow = (c: RecoveryCandidate): string => {
    const date = new Date(c.startTs).toLocaleDateString(
      uiLanguage() === 'zh' ? 'zh-CN' : 'en-US',
      { month: 'short', day: 'numeric' },
    );
    return t('{name}, {date}, {minutes} minutes, {count} messages', {
      name: c.characterName,
      date,
      minutes: Math.max(1, Math.round((c.endTs - c.startTs) / 60_000)),
      count: c.totalRows,
    });
  };

  if (stage === 'prompt') {
    return (
      <ModalShell title={t('Is your companion acting weird?')} onClose={ignore} tier="stacked">
        <p className={confirmStyles.body}>
          {t(
            'We detected an unusual amount of requests from your machine. Ignore this message if you are not experiencing any issues. If your companion is behaving strangely, it is fully recoverable. Begin recovery?',
          )}
        </p>
        <ModalFooter>
          <Button kind="quiet" size="md" onClick={ignore}>
            {t('Ignore')}
          </Button>
          <Button kind="primary" size="md" onClick={() => setStage('list')}>
            {t('Begin recovery')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  if (stage === 'done') {
    return (
      <ModalShell title={t('Is your companion acting weird?')} onClose={close} tier="stacked">
        <p className={confirmStyles.body}>
          {t('Recovery complete. A backup of everything removed was kept.')}
        </p>
        <ModalFooter>
          <Button kind="primary" size="md" onClick={close}>
            {t('Close')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  const anySelected = candidates.some((c) => checked[keyOf(c)]);
  return (
    <ModalShell
      title={t('Is your companion acting weird?')}
      onClose={busy ? undefined : close}
      escClose={!busy}
      tier="stacked"
      width={440}
    >
      <p className={confirmStyles.body}>
        {t('Select the sessions to clean up. Everything removed is backed up on this computer.')}
      </p>
      <div className={styles.list}>
        {candidates.map((c) => {
          const k = keyOf(c);
          return (
            <label key={k} className={styles.row}>
              <input
                type="checkbox"
                checked={!!checked[k]}
                disabled={busy}
                onChange={(e) => setChecked((prev) => ({ ...prev, [k]: e.target.checked }))}
              />
              <span>{fmtRow(c)}</span>
            </label>
          );
        })}
      </div>
      {failed ? (
        <p className={styles.error}>
          {t(
            'Something went wrong during cleanup. A backup was made first, so nothing is lost. Try again later.',
          )}
        </p>
      ) : null}
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={close} disabled={busy}>
          {t('Cancel')}
        </Button>
        <Button kind="primary" size="md" onClick={() => void cleanUp()} disabled={busy || !anySelected}>
          {busy ? t('Cleaning up…') : t('Clean up')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
