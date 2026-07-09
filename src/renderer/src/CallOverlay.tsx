/**
 * CallOverlay (260706, task 4) — the always-on-top overlay's ROOT component.
 *
 * Mounted (only) in the dedicated overlay BrowserWindow, which loads the
 * renderer bundle with `?overlay=1` (see main.tsx). It never mounts the full
 * App: it just subscribes to the main-process `voice:overlay-state` push and
 * renders one circle per call member — every companion plus the player (260707,
 * always last, same treatment) — lit while that member speaks and darkened while
 * idle. The window is transparent + click-through, so this is pure display, no
 * controls.
 */
import React, { useEffect, useState } from 'react';
import type { CallOverlayState } from '@shared/ipc';
import { sei } from './lib/ipcClient';
import { portraitSrc } from './lib/portraitSrc';
import { pickPalette } from './lib/portraitPalettes';
import { PixelPortrait } from './components/PixelPortrait';
import styles from './CallOverlay.module.css';

export function CallOverlay(): React.ReactElement | null {
  const [state, setState] = useState<CallOverlayState | null>(null);

  useEffect(() => {
    const off = sei.onVoiceOverlayState?.((s) => setState(s));
    // Main seeds the state with a push at window-reveal, but that push can land
    // BEFORE this subscription exists (React effects run after first paint) —
    // when it did, the overlay stayed blank until the next speaking change. Pull
    // the current state too; a push that already arrived wins (it is newer).
    void sei
      .voiceOverlayGetState?.()
      .then((s) => {
        if (s) setState((prev) => prev ?? s);
      })
      .catch(() => {});
    return () => off?.();
  }, []);

  if (!state || !state.enabled || state.participants.length === 0) return null;

  return (
    <div className={styles.row}>
      {state.participants.map((p) => {
        const speaking = p.speaking;
        const src = portraitSrc(p.portrait);
        // Overlay floats over arbitrary apps; the dark procedural fallback reads
        // fine on any backdrop, so a fixed dark palette is right here.
        const palette = pickPalette(p.id + p.name, 'dark');
        return (
          <div
            key={p.id}
            className={`${styles.circle} ${speaking ? styles.speaking : styles.idle}`}
            title={p.name}
          >
            {src ? (
              <img src={src} alt="" />
            ) : (
              <PixelPortrait
                seed={p.id + p.name}
                palette={palette}
                size={76}
                portraitImage={p.portrait ?? undefined}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
