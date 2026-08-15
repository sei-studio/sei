/**
 * CallInactivityPopup (260810) — "Are you still there?" for unattended calls.
 *
 * After 10 minutes with zero player activity on a live call (no dispatched
 * utterance, no typed message, no live screenshare — companion speech does
 * not count), useVoiceStore's inactivity watchdog raises this popup with a
 * 10-second countdown; at zero it hangs up through the normal endCall path.
 * The store owns every timer; this component only renders the state.
 *
 * Mounted by CallMiniBar, which lives in the App shell on EVERY view — so the
 * popup is visible and clickable no matter where the call UI is: the
 * fullscreen call view, a chess/Draw! surface, a backdrop scene, or a
 * different screen entirely. ModalShell's 'stacked' tier (1100) keeps it
 * above base-tier modals; game surfaces and scenes have no z-index anywhere
 * near it.
 *
 * "I'm here" (and ESC, which is the same decision) resets the 10-minute
 * clock. Real activity while the popup is up retracts it from the store side.
 */

import React from 'react';
import { useT } from '../../lib/i18n';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { Button } from '../Button';
import { ModalShell, ModalFooter } from '../ModalShell';

export function CallInactivityPopup(): React.ReactElement | null {
  const t = useT();
  const prompt = useVoiceStore((s) => s.inactivityPrompt);
  const seconds = useVoiceStore((s) => s.inactivitySecondsLeft);
  const confirmPresence = useVoiceStore((s) => s.confirmPresence);

  if (!prompt) return null;

  return (
    <ModalShell
      title={t('Are you still there?')}
      width={380}
      tier="stacked"
      onClose={confirmPresence}
    >
      <p>{t('This call will end in {seconds} seconds.', { seconds })}</p>
      <ModalFooter>
        <Button kind="accent" size="md" onClick={confirmPresence}>
          {t("I'm here")}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
