/**
 * useAiMoveReveal — the presentation quiet gate for the AI move (postthink).
 *
 * Main decides the AI's move, waits out a sampled "human think" delay
 * (prethink), then pushes it as `pendingAiMove` alongside any commentary.
 * This hook is the second half of the pacing: the move lands only after the
 * table has been QUIET for the settle window — the last utterance finished
 * printing (typed) or speaking (voice), and the player did not jump in. A
 * player message during the window resets it (the chat store flips `awaiting`
 * on send), and the reply turn in main may then revise the pending move
 * (a new uci re-arms this hook) or retract it entirely via wait() (the push
 * drops pendingAiMove and the hook unmounts). Moves are never re-decided.
 * Once quiet holds, the store reveals (animates) the move and acks main,
 * which commits it.
 *
 * "Commentary done" is decided per surface:
 *   - Voice call active for this character → the TTS pipeline is fully
 *     drained: no synthesis fetch in flight and nothing playing
 *     (voiceTtsDrained(), the same predicate the solo hang-up drain uses).
 *   - Typed chat → the chat store's paced reveal is idle: `awaiting` is false
 *     (send()/chatOpened keep it true between multi-bubble reply reveals, so
 *     false means the last bubble has landed).
 *
 * Both signals are polled (awaiting flips through several non-reactive pacing
 * timers; the voice drain is module state), and must hold quiet for a settle
 * window before we trust them — a state push can arrive BEFORE the commentary
 * even starts presenting, and a multi-bubble reply has short idle gaps. A
 * minimum grace covers the not-yet-started case and a hard cap guarantees the
 * game never deadlocks behind a mute companion.
 */

import { useEffect } from 'react';
import { useChessStore } from '../../lib/stores/useChessStore';
import { useChatStore } from '../../lib/stores/useChatStore';
import { voiceTtsDrained } from '../../lib/stores/useVoiceStore';
import { isVoiceCallActive } from '../../lib/voice/voiceBridge';

const POLL_MS = 200;
/** The quiet signal must hold this long before the reveal fires: the
 * "postthink" gate — x seconds after the last message of any kind finishes,
 * the move plays. Player sends and reply bubbles both reset it. */
const SETTLE_MS = 2000;
/** Never reveal sooner than this after the pending move arrives — gives the
 * commentary a beat to START presenting (push ordering is not guaranteed). */
const MIN_WAIT_MS = 900;
/** Hard cap: a mute companion (no commentary at all, or a dropped TTS clip)
 * must never stall the game forever. */
const MAX_WAIT_MS = 30_000;

/** True when the character's commentary surfaces are idle right now. */
function commentaryIdle(characterId: string): boolean {
  if (isVoiceCallActive(characterId)) return voiceTtsDrained();
  return !(useChatStore.getState().awaiting[characterId] ?? false);
}

export function useAiMoveReveal(characterId: string): void {
  const pendingUci = useChessStore((s) => s.games[characterId]?.pendingAiMove?.uci ?? null);
  const status = useChessStore((s) => s.games[characterId]?.status ?? null);

  useEffect(() => {
    if (!pendingUci || status !== 'active') return;
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
        // slide animation.
        useChessStore.getState().reveal(characterId, pendingUci);
        return;
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [characterId, pendingUci, status]);
}
