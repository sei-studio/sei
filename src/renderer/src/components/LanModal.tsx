/**
 * LanModal — instructions to open Minecraft to LAN, with live status pill.
 *
 * Two modes:
 *  - 'info'      → opened from HomeScreen LAN pill click. Footer = [Close].
 *  - 'searching' → opened from a Summon attempt while no open world is detected
 *                  (D-24). Footer = [Cancel summon, Close]. Watches
 *                  useDataStore.lan; when it flips to 'open', auto-closes
 *                  and resumes the deferred summon (D-56).
 *
 * Header eyebrow shows the live world-DETECTION pill ("OPEN WORLD DETECTED" /
 * "NO OPEN WORLD" / "UNAVAILABLE ON THIS NETWORK") with an 8px colored dot
 * (D-22). This is about detecting an open-to-LAN world, NOT whether the
 * companion has joined — "connected" is reserved for the companion-in-game
 * status (BotStatus) shown on the character card / page.
 *
 * The prototype's manual LAN-spoof toggle is removed (D-23 / D-57). Renderer
 * never forces LAN state; only the bonjour watcher in main flips lan.kind.
 *
 * Source: 04-UI-SPEC.md §LanModal + §Character delete-gating + Copywriting
 * Contract; 04-CONTEXT.md D-22, D-23, D-24, D-54, D-55, D-56, D-57.
 */

import React, { useEffect } from 'react';
import { sei } from '../lib/ipcClient';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './LanModal.module.css';

const STEPS: readonly string[] = [
  'Launch Minecraft and open your singleplayer world.',
  'Press ESC, then choose Open to LAN.',
  'Click Start LAN World.',
  'Return to Sei and press Connect.',
];

type LanKind = 'open' | 'closed' | 'unavailable';

function pillLabel(kind: LanKind): string {
  if (kind === 'open') return 'Open world detected';
  if (kind === 'unavailable') return 'Unavailable on this network';
  return 'No open world';
}

function pillColor(kind: LanKind): string {
  if (kind === 'open') return 'var(--green)';
  if (kind === 'unavailable') return 'var(--muted)';
  return 'var(--red)';
}

export interface LanModalProps {
  mode: 'info' | 'searching';
}

export function LanModal({ mode }: LanModalProps): React.ReactElement {
  const lan = useDataStore((s) => s.lan);
  const closeModal = useUiStore((s) => s.closeModal);
  const pendingSummonId = useUiStore((s) => s.pendingSummonId);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);
  const returnToChat = useUiStore((s) => s.pendingSummonReturnToChat);
  const setPendingSummonReturnToChat = useUiStore((s) => s.setPendingSummonReturnToChat);
  const navigate = useUiStore((s) => s.navigate);

  // ── Auto-resume on connected (D-56) ────────────────────────────────────
  useEffect(() => {
    if (mode !== 'searching') return;
    if (lan.kind !== 'open') return;
    if (!pendingSummonId) {
      closeModal();
      return;
    }
    const id = pendingSummonId;
    const toChat = returnToChat;
    setPendingSummon(null);
    setPendingSummonReturnToChat(false);
    closeModal();
    sei.summon(id).catch(() => {
      // Errors surface via onStatus → BotStatus.error; the model row owns display.
    });
    // Task 6 — a chat-launched summon returns to that chat, not the profile.
    navigate(toChat ? { kind: 'chat', characterId: id } : { kind: 'character', id });
  }, [
    mode,
    lan,
    pendingSummonId,
    returnToChat,
    closeModal,
    setPendingSummon,
    setPendingSummonReturnToChat,
    navigate,
  ]);

  // ── Dismiss (D-24): in searching mode, closing also clears the pending summon.
  //    ModalShell drives Esc → onClose; the footer buttons call the same handler.
  const onClose = (): void => {
    if (mode === 'searching') {
      setPendingSummon(null);
      setPendingSummonReturnToChat(false);
    }
    closeModal();
  };

  return (
    <ModalShell
      title={null}
      width={520}
      onClose={onClose}
      aria-label="To connect a character to your world"
    >
      <div className={styles.headerEyebrow}>
        <span className={styles.headerDot} style={{ background: pillColor(lan.kind) }} />
        {pillLabel(lan.kind)}
      </div>
      <h2 id="lan-modal-title" className={styles.title}>
        To connect a character to your world
      </h2>
      <ol className={styles.steps}>
        {STEPS.map((step, i) => (
          <li key={i} className={styles.step}>
            <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <span className={styles.stepBody}>{step}</span>
          </li>
        ))}
      </ol>
      {mode === 'searching' ? (
        <div className={styles.searching}>
          <span className={styles.searchDots} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          Searching for an open LAN world…
        </div>
      ) : null}
      <ModalFooter>
        {mode === 'searching' ? (
          <Button kind="quiet" size="md" onClick={onClose}>
            Cancel
          </Button>
        ) : null}
        <Button kind="primary" size="md" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
