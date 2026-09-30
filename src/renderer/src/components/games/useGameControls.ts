/**
 * useGameControls — the runtime controls every bot-backed game dashboard
 * shares (pause / resume, reactive / proactive, Disconnect, and the hover
 * hint), as ONE hook with no markup (260909). Each game's dashboard paints
 * its own buttons in its own game's register (Minecraft's vanilla gray,
 * Don't Starve Together's parchment, Stardew's wooden frames), so what is
 * shared is the behaviour and the copy, not the CSS.
 *
 * Store actions and IPC are the ones McDashboardPanel's controls window
 * uses: useMcDashboardStore.setPaused / setMode -> supervisor.setGamePaused /
 * setGameMode (game-agnostic), and Disconnect flips the status to idle
 * BEFORE arming the launch panel, because ChatScreen force-clears `launch`
 * while the bot is online and would swallow the other order.
 */
import { useState } from 'react';
import type { McGameMode } from '@shared/ipc';
import type { GameId } from '@shared/gameIpc';
import { sei } from '../../lib/ipcClient';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';

export type GameControlKey = 'pause' | 'reactive' | 'proactive' | 'disconnect';

/** Hover copy for the control buttons. No em dashes: user copy. */
export const GAME_CONTROL_DESCRIPTIONS: Record<GameControlKey, string> = {
  pause: 'Freezes your companion in the game. They stand still and stop thinking until you unpress it.',
  reactive: 'The AI follows simple instructions. Does not act without your command. Costs less usage.',
  proactive: 'The AI plays {game} alongside you. Can act without your command. Costs more usage.',
  disconnect: 'Your companion leaves the world. You can launch them back in whenever you want.',
};

export interface GameControls {
  paused: boolean;
  mode: McGameMode;
  setPaused: (paused: boolean) => void;
  setMode: (mode: McGameMode) => void;
  disconnect: () => void;
  /** The control under the pointer / focus, or null. */
  hint: GameControlKey | null;
  /** Spread onto a control to drive `hint`. */
  hintHandlers: (key: GameControlKey) => Record<string, () => void>;
}

export function useGameControls(characterId: string, game: GameId): GameControls {
  const controls = useMcDashboardStore((s) => s.controls[characterId]);
  const storeSetPaused = useMcDashboardStore((s) => s.setPaused);
  const storeSetMode = useMcDashboardStore((s) => s.setMode);
  const [hint, setHint] = useState<GameControlKey | null>(null);
  // Absent entry == the per-summon defaults (unpaused, proactive). Never
  // persisted; the store drops the entry when the session ends.
  const paused = controls?.paused ?? false;
  const mode: McGameMode = controls?.mode ?? 'proactive';
  return {
    paused,
    mode,
    setPaused: (next) => storeSetPaused(characterId, next),
    setMode: (next) => storeSetMode(characterId, next),
    disconnect: () => {
      useDataStore.getState().setStatus({ kind: 'idle', characterId });
      useMcDashboardStore.getState().setLaunch(characterId, game);
      void sei.stop(characterId).catch(() => {
        /* the session is already gone; the UI is correct */
      });
    },
    hint,
    hintHandlers: (key) => ({
      onMouseEnter: () => setHint(key),
      onMouseLeave: () => setHint(null),
      onFocus: () => setHint(key),
      onBlur: () => setHint(null),
    }),
  };
}
