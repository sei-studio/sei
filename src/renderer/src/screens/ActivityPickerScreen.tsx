/**
 * ActivityPickerScreen — post-onboarding "what would you like to do?" chooser.
 *
 * Shown once, right after name onboarding (OnboardingScreen navigates here on a
 * fresh onboard). Three MULTI-SELECT tiles: "Chat", "Voice call", and
 * "Minecraft" (full-bleed game art, matching the Play Together picker). The
 * user toggles any combination, then confirms with Continue:
 *   - Minecraft selected → advances to the dedicated skin-setup step (which
 *     clears skin_setup_pending and lands on home when finished/skipped).
 *   - Minecraft NOT selected → clears skin_setup_pending and lands on home.
 *     Chat and Voice call need no setup.
 *
 * A user who never picks Minecraft (or later skips skin setup) never sets up
 * Minecraft; the Play Together window's Minecraft tile then routes them through
 * the skin-setup nudge → LAN gate on first launch (attemptSummon in
 * lib/summonFlow.ts).
 */

import React, { useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { sei } from '../lib/ipcClient';
import { Button } from '../components/Button';
import { ChatIcon, PhoneIcon } from '../components/icons';
import styles from './ActivityPickerScreen.module.css';

type Activity = 'chat' | 'voice-call' | 'minecraft';

const MC_IMAGE = './img/game-minecraft.webp';

export function ActivityPickerScreen(): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const [selected, setSelected] = useState<Set<Activity>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (a: Activity): void => {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  };

  const onContinue = async (): Promise<void> => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    sei.track('activities_picked', { activities: [...selected].sort().join(',') });
    if (selected.has('minecraft')) {
      // Leave skin_setup_pending true; the skin-setup step clears it on
      // finish/skip.
      navigate({ kind: 'skin-setup' });
      return;
    }
    try {
      // No Minecraft setup needed, so clear the resume flag so a relaunch
      // doesn't drop them into skin-setup.
      const cfg = await sei.getConfig();
      await sei.saveConfig({ ...cfg, skin_setup_pending: false });
    } catch {
      /* best-effort — worst case they see skin-setup once on relaunch */
    }
    setHomeTab('home');
    navigate({ kind: 'home' });
  };

  const tileClass = (a: Activity, extra?: string): string =>
    [styles.tile, extra ?? '', selected.has(a) ? styles.tileSelected : '']
      .filter(Boolean)
      .join(' ');

  return (
    <div className={styles.root}>
      <div className={styles.inner}>
        <h1 className={styles.title}>What would you like to do with your companion?</h1>
        <p className={styles.subtitle}>Pick everything that sounds fun. You can add more later.</p>

        <div className={styles.tiles} role="group" aria-label="Activities">
          <button
            type="button"
            role="checkbox"
            aria-checked={selected.has('chat')}
            className={tileClass('chat')}
            onClick={() => toggle('chat')}
            disabled={busy}
          >
            <span className={styles.tileIcon}>
              <ChatIcon size={40} />
            </span>
            <span className={styles.tileName}>Chat</span>
            <span className={styles.tileDesc}>Talk with your companion in the app.</span>
          </button>

          <button
            type="button"
            role="checkbox"
            aria-checked={selected.has('voice-call')}
            className={tileClass('voice-call')}
            onClick={() => toggle('voice-call')}
            disabled={busy}
          >
            <span className={styles.tileIcon}>
              <PhoneIcon size={38} />
            </span>
            <span className={styles.tileName}>Voice call</span>
            <span className={styles.tileDesc}>Hop on a live call and just talk.</span>
          </button>

          <button
            type="button"
            role="checkbox"
            aria-checked={selected.has('minecraft')}
            className={tileClass('minecraft', styles.tileImage)}
            style={{ backgroundImage: `url(${MC_IMAGE})` }}
            onClick={() => toggle('minecraft')}
            disabled={busy}
          >
            <span className={styles.tileName}>Minecraft</span>
            <span className={styles.tileDesc}>Play together in your LAN world.</span>
          </button>
        </div>

        <div className={styles.actions}>
          <Button
            kind="accent"
            size="lg"
            onClick={() => void onContinue()}
            disabled={busy || selected.size === 0}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
