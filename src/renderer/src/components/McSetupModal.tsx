/**
 * McSetupModal — the Minecraft setup window (260721, replaces LanModal).
 *
 * Opened from the Minecraft launch panel's "How do I set up launch?" link
 * (searching=false) and from a Launch attempt that found no open world
 * (searching=true, via summonFlow.proceedSummon). Two tabs:
 *
 *  - 'world' (default): the open-to-LAN steps with the live world-detection
 *    pill. The "searching for an open LAN world" animation appears ONLY in
 *    the launch-blocked path (searching=true); the plain help window shows
 *    the same steps without it.
 *  - 'skin': brief pointer to skin setup, with a button that opens the skin
 *    setup wizard (the same one Settings > Custom skins re-runs).
 *
 * Searching mode keeps the old LanModal auto-resume contract (D-56): it
 * watches useDataStore.lan and, when it flips to 'open', closes and resumes
 * the deferred summon through the host-compatibility gate. Closing in
 * searching mode cancels the pending summon (D-24).
 *
 * The detection pill is about an open-to-LAN world, NOT whether the companion
 * has joined; "connected" stays reserved for BotStatus.
 */

import React, { useEffect, useState } from 'react';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useWizardStore } from '../lib/stores/useWizardStore';
import { summonWithHostGate } from '../lib/summonFlow';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { StatusPill, type StatusPillTone } from './StatusPill';
import styles from './McSetupModal.module.css';

const STEPS: readonly string[] = [
  'Launch Minecraft and open your singleplayer world.',
  'Press ESC, then choose Open to LAN.',
  'Click Start LAN World.',
  'Return to Sei and press Launch.',
];

type LanKind = 'open' | 'closed' | 'unavailable';

function pillLabel(kind: LanKind): string {
  if (kind === 'open') return 'Open world detected';
  if (kind === 'unavailable') return 'Unavailable on this network';
  return 'No open world';
}

function pillTone(kind: LanKind): StatusPillTone {
  if (kind === 'open') return 'green';
  if (kind === 'unavailable') return 'muted';
  return 'red';
}

export type McSetupTab = 'world' | 'skin';

export interface McSetupModalProps {
  tab: McSetupTab;
  /** True only on the launch-blocked path (Launch pressed, no open world). */
  searching: boolean;
}

export function McSetupModal({ tab: initialTab, searching }: McSetupModalProps): React.ReactElement {
  const [tab, setTab] = useState<McSetupTab>(initialTab);
  const lan = useDataStore((s) => s.lan);
  const closeModal = useUiStore((s) => s.closeModal);
  const pendingSummonId = useUiStore((s) => s.pendingSummonId);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);
  const returnToChat = useUiStore((s) => s.pendingSummonReturnToChat);
  const setPendingSummonReturnToChat = useUiStore((s) => s.setPendingSummonReturnToChat);
  const openWizard = useWizardStore((s) => s.openWizard);

  // ── Auto-resume on open world (D-56) ────────────────────────────────────
  useEffect(() => {
    if (!searching) return;
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
    // Same host-compatibility gate as the direct summon path: a modded or
    // Lunar host shows the disclaimer modal (replacing this one) instead of
    // summoning straight away. launchSummon inside the gate owns the summon
    // call AND the chat-vs-profile navigation.
    void summonWithHostGate(id, toChat, lan.host);
  }, [
    searching,
    lan,
    pendingSummonId,
    returnToChat,
    closeModal,
    setPendingSummon,
    setPendingSummonReturnToChat,
  ]);

  // ── Dismiss (D-24): in searching mode, closing also cancels the summon. ──
  const onClose = (): void => {
    if (searching) {
      setPendingSummon(null);
      setPendingSummonReturnToChat(false);
    }
    closeModal();
  };

  const onOpenSkinSetup = (): void => {
    if (searching) {
      setPendingSummon(null);
      setPendingSummonReturnToChat(false);
    }
    closeModal();
    openWizard(true);
  };

  return (
    <ModalShell title={null} width={520} onClose={onClose} aria-label="Minecraft setup">
      <div className={styles.tabs} role="tablist" aria-label="Minecraft setup topics">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'world'}
          className={tab === 'world' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => setTab('world')}
        >
          Connecting to world
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'skin'}
          className={tab === 'skin' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => setTab('skin')}
        >
          Viewing AI skin
        </button>
      </div>

      {tab === 'world' ? (
        <>
          <StatusPill tone={pillTone(lan.kind)} label={pillLabel(lan.kind)} />
          <ol className={styles.steps}>
            {STEPS.map((step, i) => (
              <li key={i} className={styles.step}>
                <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
                <span className={styles.stepBody}>{step}</span>
              </li>
            ))}
          </ol>
          {searching ? (
            <div className={styles.searching}>
              <span className={styles.searchDots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              Searching for an open LAN world…
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className={styles.skinBody}>
            Companions have their own Minecraft skins, so they look right when they join your
            world. Seeing those skins in your game takes a quick one-time setup for your
            Minecraft install. You can also run it later from Settings under Custom skins.
          </p>
          <div>
            <Button kind="accent" size="md" onClick={onOpenSkinSetup}>
              Open skin setup
            </Button>
          </div>
        </>
      )}

      <ModalFooter>
        <Button kind="primary" size="md" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
