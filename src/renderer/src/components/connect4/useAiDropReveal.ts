/**
 * useAiDropReveal — the presentation quiet gate for the AI's drop (postthink).
 *
 * CLONED from src/renderer/src/components/chess/useAiMoveReveal.ts with the
 * pending move keyed on a column number instead of a UCI string; the gate
 * logic (poll both commentary surfaces, settle window, min grace, hard cap)
 * is identical — prime shared-SDK material.
 *
 * Main decides the AI's drop, waits out a sampled "human think" delay
 * (prethink), then pushes it as `pendingAiMove` alongside any commentary.
 * This hook is the second half of the pacing: the disc falls only after the
 * table has been QUIET for the settle window — the last utterance finished
 * printing (typed) or speaking (voice), and the player did not jump in.
 * A player message during the window resets it, and the reply turn in main
 * may then revise the pending move (a new column re-arms this hook) or
 * retract it entirely via wait() (the push drops pendingAiMove and the hook
 * unmounts). Moves are never re-decided. Once quiet holds, the store reveals
 * (animates) the drop and acks main, which commits it.
 */

import { useEffect } from 'react';
import { useConnect4Store } from '../../lib/stores/useConnect4Store';
import { useChatStore } from '../../lib/stores/useChatStore';
import { voiceTtsDrained } from '../../lib/stores/useVoiceStore';
import { isVoiceCallActive } from '../../lib/voice/voiceBridge';

const POLL_MS = 200;
/** The quiet signal must hold this long before the reveal fires. */
const SETTLE_MS = 2000;
/** Never reveal sooner than this after the pending move arrives — gives the
 * commentary a beat to START presenting (push ordering is not guaranteed). */
const MIN_WAIT_MS = 900;
/** Hard cap: a mute companion must never stall the game forever. */
const MAX_WAIT_MS = 30_000;

/** True when the character's commentary surfaces are idle right now. */
function commentaryIdle(characterId: string): boolean {
  if (isVoiceCallActive(characterId)) return voiceTtsDrained();
  return !(useChatStore.getState().awaiting[characterId] ?? false);
}

export function useAiDropReveal(characterId: string): void {
  const pendingCol = useConnect4Store((s) => s.games[characterId]?.pendingAiMove?.col ?? null);
  const status = useConnect4Store((s) => s.games[characterId]?.status ?? null);

  useEffect(() => {
    if (pendingCol === null || status !== 'active') return;
    const startedAt = Date.now();
    let quietSince: number | null = null;
    let timer: number | null = null;

    const tick = (): void => {
      const now = Date.now();
      if (!commentaryIdle(characterId)) {
        quietSince = null;
      } else if (quietSince === null) {
        quietSince = now;
      }
      const settled = quietSince !== null && now - quietSince >= SETTLE_MS;
      const ready = settled && now - startedAt >= MIN_WAIT_MS;
      if (ready || now - startedAt >= MAX_WAIT_MS) {
        // reveal() re-checks the move is still pending (a revision or a
        // wait() retraction may have raced this tick) and acks after the
        // fall animation.
        useConnect4Store.getState().reveal(characterId, pendingCol);
        return;
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [characterId, pendingCol, status]);
}
