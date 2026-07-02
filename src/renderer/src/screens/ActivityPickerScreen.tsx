/**
 * ActivityPickerScreen — post-onboarding "what would you like to do?" chooser.
 *
 * Shown once, right after name onboarding (OnboardingScreen navigates here on a
 * fresh onboard). Two tiles: "Chat" and "Minecraft".
 *   - Chat → clears skin_setup_pending and lands on home. No Minecraft setup.
 *   - Minecraft → advances to the dedicated skin-setup step (which clears the
 *     flag and lands on home when finished/skipped).
 *
 * A user who picks Chat (or later skips skin setup) never sets up Minecraft; the
 * Play Together window's Minecraft tile then routes them through the skin-setup
 * nudge → LAN gate on first launch (attemptSummon in lib/summonFlow.ts).
 */

import React, { useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { sei } from '../lib/ipcClient';
import { ChatIcon, MCBlock } from '../components/icons';
import styles from './ActivityPickerScreen.module.css';

export function ActivityPickerScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const [busy, setBusy] = useState(false);

  const onChat = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      // Chat-only: no Minecraft setup needed, so clear the resume flag so a
      // relaunch doesn't drop them into skin-setup.
      const cfg = await sei.getConfig();
      await sei.saveConfig({ ...cfg, skin_setup_pending: false });
    } catch {
      /* best-effort — worst case they see skin-setup once on relaunch */
    }
    setHomeTab('home');
    navigate({ kind: 'home' });
  };

  const onMinecraft = (): void => {
    // Leave skin_setup_pending true; the skin-setup step clears it on finish/skip.
    navigate({ kind: 'skin-setup' });
  };

  return (
    <div className={styles.root}>
      <div className={styles.inner}>
        <h1 className={styles.title}>What would you like to do with your companion?</h1>
        <p className={styles.subtitle}>You can add games later.</p>

        <div className={styles.tiles}>
          <button type="button" className={styles.tile} onClick={() => void onChat()} disabled={busy}>
            <span className={styles.tileIcon}>
              <ChatIcon size={40} />
            </span>
            <span className={styles.tileName}>Chat</span>
            <span className={styles.tileDesc}>Talk with your companion in the app.</span>
          </button>

          <button type="button" className={styles.tile} onClick={onMinecraft} disabled={busy}>
            <span className={styles.tileIcon}>
              <MCBlock size={44} />
            </span>
            <span className={styles.tileName}>Minecraft</span>
            <span className={styles.tileDesc}>Play together in your LAN world.</span>
          </button>
        </div>
      </div>
    </div>
  );
}
