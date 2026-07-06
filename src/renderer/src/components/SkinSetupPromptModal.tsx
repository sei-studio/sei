/**
 * SkinSetupPromptModal — one-time "run skin setup" nudge.
 *
 * Shown by attemptSummon (lib/summonFlow.ts) the FIRST time a user who has
 * never completed skin setup tries to summon a character. Appears before the
 * LAN "not connected" instruction. Skippable — summoning works without skins
 * (the character just uses a default look in-world), so this informs rather
 * than blocks. Re-runnable later from Settings → Minecraft skins setup.
 *
 *   - "Set up skins" → close + open the setup wizard (first-run, not re-entry).
 *   - "Skip for now" → resume the deferred summon via proceedSummon, which
 *     either summons (LAN connected) or opens the LAN modal (not connected).
 *
 * Esc and scrim-click both skip-and-continue (they route through proceedSummon),
 * matching the "Skip for now" affordance.
 */
import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import { useWizardStore } from '../lib/stores/useWizardStore';
import { proceedSummon } from '../lib/summonFlow';
import styles from './confirmModal.module.css';

export interface SkinSetupPromptModalProps {
  /** Character the user was trying to summon — resumed on "skip for now". */
  characterId: string;
}

export function SkinSetupPromptModal({
  characterId,
}: SkinSetupPromptModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  const openWizard = useWizardStore((s) => s.openWizard);

  const handleSkip = (): void => {
    // proceedSummon replaces this modal (LAN modal) or navigates (summon),
    // so it clears the prompt; no explicit closeModal needed. Async now
    // (it awaits a fresh LAN check) — fire-and-forget from this click handler.
    void proceedSummon(characterId);
  };

  const handleSetup = (): void => {
    closeModal();
    openWizard(false);
  };

  return (
    <ModalShell
      title="Set up your Minecraft skin first?"
      onClose={handleSkip}
      scrimClose
    >
      <p className={styles.body}>
        Skin setup lets your companions appear with their own look in your world. It takes about a
        minute and you can re-run it anytime from Settings. Connect without it and your companion
        uses a default skin.
      </p>
      <ModalFooter>
        <Button kind="ghost" size="md" onClick={handleSkip}>
          Skip for now
        </Button>
        <Button kind="primary" size="md" onClick={handleSetup}>
          Set up skins
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
