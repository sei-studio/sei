/**
 * WatchIndicator — the persistent "Watching: <source>" pill (260720).
 *
 * Shown in the chat screen whenever the character has an ACTIVE screen-share
 * session, whether or not the watch panel itself is open, so the player can
 * always see that capture is running and stop it with one click (the consent
 * requirement; same always-visible principle as the CallMiniBar for calls).
 */

import React, { useEffect, useState } from 'react';
import { useWatchStore, isWatchActive } from '../../lib/stores/useWatchStore';
import { StopIcon } from '../icons';
import styles from './WatchIndicator.module.css';

export interface WatchIndicatorProps {
  characterId: string;
}

function fmtTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function WatchIndicator({ characterId }: WatchIndicatorProps): React.ReactElement | null {
  const active = useWatchStore((s) => isWatchActive(s, characterId));
  const session = useWatchStore((s) => s.sessions[characterId] ?? null);
  const stop = useWatchStore((s) => s.stop);
  const openPanel = useWatchStore((s) => s.openPanel);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);

  if (!active || !session) return null;

  return (
    <div className={styles.pill} role="status">
      <button
        type="button"
        className={styles.body}
        onClick={() => openPanel(characterId)}
        aria-label={`Screen share details: watching ${session.sourceName}`}
        title="Open the screen share panel"
      >
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.label}>Watching: {session.sourceName}</span>
        <span className={styles.timer}>{fmtTimer(now - session.startedAt)}</span>
      </button>
      <button
        type="button"
        className={styles.stopBtn}
        onClick={() => void stop(characterId)}
        aria-label="Stop sharing your screen"
        title="Stop sharing"
      >
        <StopIcon size={11} />
        Stop
      </button>
    </div>
  );
}
