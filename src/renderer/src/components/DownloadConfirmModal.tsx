/**
 * DownloadConfirmModal (260817, china-compat W5) — the shared "Download?
 * (XX MB)" confirm for on-demand model packs: the local TTS voice packs and
 * the SenseVoice STT model in Settings, and any future pack surface.
 *
 * The size ALWAYS comes from the caller in exact bytes (the pack registry's
 * archiveBytes, delivered over the speech:pack-status push) — never a
 * hardcoded "about NN MB" string, so registry changes can't drift the copy.
 * Renders through ModalShell like every other confirm.
 */
import React, { useState } from 'react';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

/** Whole mebibytes for user copy, floored at 1 so a tiny pack never says 0. */
export function formatMb(bytes: number): number {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

export interface DownloadConfirmModalProps {
  /** What is being downloaded, already localized (e.g. "SenseVoice"). */
  name: string;
  /** Exact archive size in bytes (from the pack registry / status push). */
  bytes: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DownloadConfirmModal({
  name,
  bytes,
  onCancel,
  onConfirm,
}: DownloadConfirmModalProps): React.ReactElement {
  const t = useT();
  const [submitted, setSubmitted] = useState(false);
  const mb = formatMb(bytes);

  return (
    <ModalShell title={t('Download {name}?', { name })} onClose={onCancel} scrimClose>
      <p className={styles.body}>
        {t(
          'This is a one-time {mb} MB download. It is stored on this device and works offline.',
          { mb },
        )}
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel} disabled={submitted}>
          {t('Cancel')}
        </Button>
        <Button
          kind="primary"
          size="md"
          disabled={submitted}
          onClick={() => {
            if (submitted) return;
            setSubmitted(true);
            onConfirm();
          }}
        >
          {t('Download ({mb} MB)', { mb })}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
