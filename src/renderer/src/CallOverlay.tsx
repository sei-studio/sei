/**
 * CallOverlay (260706, task 4) — the always-on-top overlay's ROOT component.
 *
 * Mounted (only) in the dedicated overlay BrowserWindow, which loads the
 * renderer bundle with `?overlay=1` (see main.tsx). It never mounts the full
 * App: it just subscribes to the main-process `voice:overlay-state` push and
 * renders one circle per companion on the call, lit while that companion speaks
 * and darkened while idle. The window is transparent + click-through, so this is
 * pure display, no controls.
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
    // Seed nothing; main pushes the current state on window-ready and on change.
    const off = sei.onVoiceOverlayState?.((s) => setState(s));
    return () => off?.();
  }, []);

  if (!state || !state.enabled || state.participants.length === 0) return null;

  return (
    <div className={styles.row}>
      {state.participants.map((p) => {
        const speaking = state.speakingId === p.id;
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
                size={60}
                portraitImage={p.portrait ?? undefined}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
