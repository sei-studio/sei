/**
 * SeiLink opened for her (261105): ask main to get her face set ready (a
 * cloud bake the first time, then a download), and follow its status for the
 * small "Preparing {name}'s look..." line. Main answers at once and works in
 * the background; RoomAvatar switches to the face set by itself when it
 * lands. Any failure is just 'idle': the fallback avatar stays, nothing shows.
 */
import { useEffect, useState } from 'react';
import type { AnimaTrigger, AnimaUiState } from '@shared/anima';
import { sei } from '../ipcClient';

export function useAnimaLook(characterId: string | null | undefined, trigger: AnimaTrigger): AnimaUiState {
  const [state, setState] = useState<AnimaUiState>('idle');
  useEffect(() => {
    setState('idle');
    if (!characterId) return;
    let dead = false;
    let off: (() => void) | undefined;
    try {
      off = sei.onSeilinkAnima?.((s) => {
        if (!dead && s.characterId === characterId) setState(s.state);
      });
    } catch {
      off = undefined;
    }
    void Promise.resolve(sei.seilinkAnimaPrepare?.(characterId, trigger))
      .then((s) => {
        if (!dead && s && s.characterId === characterId) setState(s.state);
      })
      .catch(() => {
        /* the fallback avatar stays */
      });
    return () => {
      dead = true;
      off?.();
    };
  }, [characterId, trigger]);
  return state;
}
