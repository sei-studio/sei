/**
 * SkinSetupScreen — dedicated full-page onboarding step for Minecraft skin setup.
 *
 * Renders AFTER the name/API onboarding step and BEFORE home, as a sibling page
 * to "What should they call you?" (no IconRail, centered column). It drives the
 * existing setup wizard's step machine inline (reusing WizardStepMachine), so the
 * install flow is identical to the Settings "Re-run setup" path — just presented
 * as a page instead of a modal popup.
 *
 * Lifecycle:
 *   - On mount: open the wizard (seeds the store to the welcome step).
 *   - "Skip for now" (welcome step only) closes the wizard without installing.
 *   - When the wizard CLOSES by any terminal path (Finish setup / Cancel / Skip /
 *     none-found → Open settings), finalize: clear UserConfig.skin_setup_pending
 *     (so a relaunch no longer resumes here) and, unless a step already routed
 *     elsewhere, land on home with the World tab selected.
 *
 * Resumability lives in UserConfig.skin_setup_pending (set on onboarding submit,
 * cleared here) — App.tsx routes back to this page on launch while it's true.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useWizardStore } from '../lib/stores/useWizardStore';
import { WizardStepMachine } from '../components/SetupWizardModal';
import { isVoiceModelReady, prefetchVoiceModel } from '../lib/voice/modelPrefetch';
import styles from './SkinSetupScreen.module.css';

export function SkinSetupScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const openWizard = useWizardStore((s) => s.openWizard);
  const open = useWizardStore((s) => s.open);

  const startedRef = useRef(false);
  const wasOpenRef = useRef(false);
  const finalizedRef = useRef(false);

  // Voice-calls opt-in (260705): checking the box starts the ~40 MB voice-
  // recognition module download in the background — it keeps going after this
  // screen unmounts (module-scoped single-flight in modelPrefetch). Skipping
  // is fine: the first call offers the install instead (VoiceCallScreen).
  const [voiceState, setVoiceState] = useState<'idle' | 'installing' | 'ready' | 'failed'>('idle');
  const [voicePct, setVoicePct] = useState(0);
  useEffect(() => {
    let alive = true;
    void isVoiceModelReady().then((ready) => {
      if (alive && ready) setVoiceState('ready');
    });
    return () => {
      alive = false;
    };
  }, []);
  const handleVoiceOptIn = (): void => {
    if (voiceState === 'installing' || voiceState === 'ready') return;
    setVoiceState('installing');
    prefetchVoiceModel((pct) => setVoicePct(pct)).then(
      () => setVoiceState('ready'),
      () => setVoiceState('failed'),
    );
  };

  // Open the wizard once on mount (seeds the store to the welcome step).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    openWizard(false);
  }, [openWizard]);

  // Finalize when the wizard transitions open → closed. `wasOpenRef` ensures we
  // only act AFTER having observed it open, so the initial pre-openWizard render
  // (open === false) can't trip the finalize.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current || finalizedRef.current) return;
    finalizedRef.current = true;
    void (async () => {
      try {
        const cfg = await sei.getConfig();
        await sei.saveConfig({ ...cfg, skin_setup_pending: false });
      } catch {
        /* best-effort — the gate is re-read on next launch */
      }
      // Only take over navigation if a wizard step didn't already route away
      // (none-found's "Open settings" navigates to settings deliberately). Land
      // on the Home tab (which shows the welcome message).
      if (useUiStore.getState().view.kind === 'skin-setup') {
        setHomeTab('home');
        navigate({ kind: 'home' });
      }
    })();
  }, [open, navigate, setHomeTab]);

  return (
    <div className={styles.root}>
      <div className={styles.eyebrow}>Final step</div>
      <div className={styles.panel}>
        {/* The welcome step's footer carries "Set up later" (aligned with
            Begin); no separate skip row is rendered below the panel anymore. */}
        <WizardStepMachine />
      </div>

      {/* Voice-calls opt-in (260705): background voice-module download so the
          first call connects instantly instead of pausing on a 40 MB fetch. */}
      <div className={styles.voiceCard}>
        <label className={styles.voiceLabel}>
          <input
            type="checkbox"
            className={styles.voiceCheckbox}
            checked={voiceState === 'installing' || voiceState === 'ready'}
            disabled={voiceState === 'installing' || voiceState === 'ready'}
            onChange={handleVoiceOptIn}
          />
          <span>
            <span className={styles.voiceTitle}>Set up voice calls too</span>
            <span className={styles.voiceHint}>
              {voiceState === 'ready'
                ? 'Voice module installed — you can call your companion anytime.'
                : voiceState === 'installing'
                  ? `Downloading the voice module… ${voicePct}%`
                  : voiceState === 'failed'
                    ? 'Download failed — you can retry from your first call.'
                    : 'Downloads the voice-recognition module (~40 MB) in the background.'}
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
