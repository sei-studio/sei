/**
 * useGamesTip — the live state of the one-time "New games added" notice.
 *
 * Quiet register (product call 261110): the notice is a one-line NoticeLine
 * above the chat composer, and the games entry is the header's Play button.
 * Two components need the same flag (the notice shows it, Play retires it), so
 * the in-memory copy of `gamesTipDone` lives in this small store instead of in
 * one component's state. The rules themselves (what retires it, what hides
 * it, per-account storage) are unchanged; see gamesTipPref.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { gamesTipDone, dismissGamesTip, shouldShowGamesTip } from './gamesTipPref';
import { useUiStore } from './stores/useUiStore';
import { useAuthStore } from './stores/useAuthStore';
import { useTutorialStore } from './stores/useTutorialStore';
import { useFirstMomentStore } from './stores/useFirstMomentStore';
import { useSeilinkStore } from './stores/useSeilinkStore';

interface GamesTipState {
  done: boolean;
  reload: () => void;
  retire: () => void;
}

const useGamesTipStore = create<GamesTipState>((set) => ({
  done: gamesTipDone(),
  reload: () => set({ done: gamesTipDone() }),
  retire: () => {
    dismissGamesTip();
    set({ done: true });
  },
}));

/** Retire the notice ("x", or the player finding the games entry). */
export function retireGamesTip(): void {
  if (!useGamesTipStore.getState().done) useGamesTipStore.getState().retire();
}

/** Whether the notice shows now. `gameOpen`: a game surface is open below the header. */
export function useGamesTipVisible(gameOpen: boolean): boolean {
  const done = useGamesTipStore((s) => s.done);
  const onChatScreen = useUiStore((s) => s.view.kind !== 'voice-call');
  // The SeiLink sheet, editor and intro are modals too, but live in their own store.
  const modalOpen = useUiStore((s) => s.modal !== null);
  const seilinkOpen = useSeilinkStore((s) => s.flow !== null || s.intro !== null);
  const tutorialActive = useTutorialStore((s) => s.active);
  const firstMomentLive = useFirstMomentStore(
    (s) => s.status === 'armed' || s.status === 'greeting' || s.status === 'ready',
  );
  // The flag is per ACCOUNT, so a scope change has to re-read it. Switching
  // accounts does not necessarily remount the chat, and inheriting the
  // previous account's dismissal would silence the notice for someone who has
  // never seen it.
  const authScope = useAuthStore((s) => (s.state.kind === 'signed_in' ? s.state.user.id : 'local'));
  useEffect(() => {
    useGamesTipStore.getState().reload();
  }, [authScope]);
  return shouldShowGamesTip({
    done,
    onChatScreen,
    gameOpen,
    modalOpen: modalOpen || seilinkOpen,
    tutorialActive,
    firstMomentLive,
  });
}
