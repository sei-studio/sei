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
 * Scaffold cloned from SignOutConfirmModal (scrim + centered card + footer).
 */
import React, { useEffect } from 'react';
import { Button } from './Button';
import { useUiStore } from '../lib/stores/useUiStore';
import { useWizardStore } from '../lib/stores/useWizardStore';
import { proceedSummon } from '../lib/summonFlow';
import styles from './SignOutConfirmModal.module.css';

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
    // so it clears the prompt; no explicit closeModal needed.
    proceedSummon(characterId);
  };

  const handleSetup = (): void => {
    closeModal();
    openWizard(false);
  };

  useEffect(() => {
    // ESC = skip-and-continue, matching the click-outside affordance below.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // handleSkip closes over a stable characterId for the modal's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  const titleId = 'skin-setup-prompt-title';

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleSkip();
      }}
    >
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>
          Set up your Minecraft skin first?
        </h2>
        <p className={styles.body}>
          Skin setup lets your companions appear with their own look in your world.
          It takes about a minute and you can re-run it anytime from Settings. Summon
          without it and your companion uses a default skin.
        </p>
        <div className={styles.footer}>
          <Button kind="ghost" size="md" onClick={handleSkip}>
            Skip for now
          </Button>
          <Button kind="accent" size="md" onClick={handleSetup}>
            Set up skins
          </Button>
        </div>
      </div>
    </div>
  );
}
