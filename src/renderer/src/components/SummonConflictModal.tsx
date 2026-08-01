/**
 * SummonConflictModal — multi-summon guard popup.
 *
 * Shown when the user tries to summon a character whose in-game Minecraft
 * username matches one that's already in the world. Two bots can't share a
 * username — the server kicks the second with `name_taken` — so we block the
 * summon and explain why. Dismiss-only (no destructive action); the user
 * resolves it by giving one persona a different in-game username on its page.
 *
 * Modeled on the IconRail "Switch to cloud?" prompt (scrim + centered panel).
 */

import React from 'react';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import styles from './SummonConflictModal.module.css';

/** Substitute {token} placeholders in a translated string with React nodes,
 * so the styled name/username spans survive translation without concatenating
 * sentence fragments. */
function richText(text: string, nodes: Record<string, React.ReactNode>): React.ReactNode[] {
  return text.split(/(\{\w+\})/g).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in nodes ? (
      <React.Fragment key={i}>{nodes[m[1]]}</React.Fragment>
    ) : (
      part
    );
  });
}

export interface SummonConflictModalProps {
  attemptedName: string;
  conflictName: string;
  username: string;
}

export function SummonConflictModal({
  attemptedName,
  conflictName,
  username,
}: SummonConflictModalProps): React.ReactElement {
  const t = useT();
  const closeModal = useUiStore((s) => s.closeModal);
  return (
    <ModalShell
      title={t('Name already in use')}
      width={420}
      scrimClose
      onClose={closeModal}
      aria-label={t('Name already in use')}
    >
      <p className={styles.body}>
        {richText(
          t(
            "{attempted} wants to join as {username}, but {conflict} is already in the world under that name. Minecraft won't let two players share a username.",
          ),
          {
            attempted: <strong>{attemptedName}</strong>,
            username: <span className={styles.username}>{username}</span>,
            conflict: <strong>{conflictName}</strong>,
          },
        )}
      </p>
      <p className={styles.hint}>
        {t(
          'Give one of them a different in-game username (on its companion page, under Skin) and try again.',
        )}
      </p>
      <ModalFooter>
        <Button kind="accent" size="md" onClick={closeModal}>
          {t('Got it')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
