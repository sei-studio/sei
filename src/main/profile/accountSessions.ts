/**
 * End every live per-account session in MAIN (260926).
 *
 * An account switch (sign-in, sign-out, swapping accounts) used to stop only
 * the game bots. A chess game, a Draw! round, a backseat screen share and a
 * voice call all kept running under the previous account's persona, memory
 * and transcript, while the renderer had already dropped that account's
 * state (scopeReset.ts) and authState had already applied the new session:
 * the old companion could talk into the new account, write the old account's
 * memory into the new profile, or bill the new account's JWT.
 *
 * profileScope.switchScopeForAuth calls this BEFORE it re-points the profile
 * scope. Each surface is ended through its existing single end choke point,
 * so the usual `_ended` event (duration_ms, reason 'account_switch') and the
 * play row are written, and they land in the OUTGOING account's files because
 * the scope has not moved yet (drainScopedWrites waits for the rows).
 *
 * Order:
 *   1. The game surfaces and the call, ended in main (their synchronous
 *      halves run back to back, so nothing interleaves between them).
 *   2. app:scope-ending to the renderer, which drops its half at once:
 *      hangs up the call, stops screen capture, clears the game mirrors.
 *   3. Every game bot (Minecraft, Stardew, DST: all are supervisor sessions).
 *   4. Wait for the closing rows, then return; the caller switches scope.
 *
 * While this runs isAccountTeardownActive() is true, which defers the
 * rolling-summary fold (see scopeBarrier.ts) and tags bot_session_ended.
 */
import { drainScopedWrites, withAccountTeardown } from './scopeBarrier';

export const ACCOUNT_SWITCH_REASON = 'account_switch' as const;

export interface AccountSessionDeps {
  /** Game bots. stop() with no id drains every session, pending ones too. */
  supervisor: { stop(characterId?: string): Promise<void> } | null;
  /** Close the renderer-driven voice calls from main (index.ts). */
  endVoiceCalls?: (reason: string) => Promise<void>;
  /** Push app:scope-ending to the renderer. */
  notifyRenderer?: () => void;
  /** Bound on the final row drain. */
  drainTimeoutMs?: number;
}

function warn(label: string, err: unknown): void {
  console.warn(`[sei] account switch: ${label} failed: ${(err as Error)?.message ?? err}`);
}

export async function endAccountSessions(deps: AccountSessionDeps): Promise<void> {
  const reason = ACCOUNT_SWITCH_REASON;
  await withAccountTeardown(async () => {
    // Load every module first so step 1 below runs without yielding between
    // surfaces. Lazy, like every other cross-service call in main: the module
    // graph and the tests never depend on these being loaded.
    const [chess, draw, backseat, chat] = await Promise.all([
      import('../chess/chessService').catch((err) => (warn('chess import', err), null)),
      import('../draw/drawService').catch((err) => (warn('draw import', err), null)),
      import('../backseat/backseatService').catch((err) => (warn('backseat import', err), null)),
      import('../chat/chatSession').catch((err) => (warn('chat import', err), null)),
    ]);

    // 1. End the surfaces. Each call starts its end synchronously; the
    //    returned promises are its closing rows.
    const ending: Promise<void>[] = [];
    const run = (label: string, fn: () => Promise<void> | void): void => {
      try {
        const p = fn();
        if (p) ending.push(p.catch((err) => warn(label, err)));
      } catch (err) {
        warn(label, err);
      }
    };
    if (chess) run('chess', () => chess.endAllChess(reason));
    if (draw) run('draw', () => draw.endAllDraw(reason));
    if (backseat) run('backseat', () => backseat.endAllBackseat(reason));
    if (deps.endVoiceCalls) run('voice calls', () => deps.endVoiceCalls!(reason));
    if (chat) run('chat sessions', () => chat.endAllChatSessions(reason));

    // 2. The renderer's half. After step 1, so its late hang-up and
    //    backseat:end reports find main's sessions already closed.
    try {
      deps.notifyRenderer?.();
    } catch (err) {
      warn('scope-ending push', err);
    }

    // 3. Game bots (every game: the supervisor owns all of them).
    if (deps.supervisor) {
      try {
        await deps.supervisor.stop();
      } catch (err) {
        warn('bot stop', err);
      }
    }

    // 4. The closing rows, including the bots' play rows, which are
    //    registered only once each process has exited.
    await Promise.all(ending);
    const drained = await drainScopedWrites(deps.drainTimeoutMs);
    if (!drained) console.warn('[sei] account switch: closing rows still in flight after the drain timeout');
  });
}
