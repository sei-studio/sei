/**
 * Close every voice call from MAIN on an account switch (260926).
 *
 * A call is renderer-driven: the renderer times it and reports the hang-up,
 * and main posts the "You and X called for Y" row plus voice_call_ended from
 * that report. On an account switch the renderer only tears its half down
 * after it hears app:scope-ending, by which time the scope may already be the
 * next account's. So main closes the calls itself (callState, timed from the
 * renderer's connect report), writes the same row and event while the scope
 * is still the outgoing account's, and callState swallows the renderer's late
 * report. Calls the companion hung up whose report is still pending are
 * included. Resolves once every row has landed.
 */
import { closeAllCallsFromMain } from './callState';
import { trackScopedWrite } from '../profile/scopeBarrier';

export interface AccountSwitchCallDeps {
  /** Supervisor: the bot's chat mode (on a call or not). */
  setVoiceCall(characterId: string, onCall: boolean): void;
  closeOverlay(): void;
  capture(event: string, props: Record<string, unknown>): void;
  /** The call row writer (index.ts emitCallSession). */
  emitCallSession(characterId: string, connectedMs: number): Promise<void>;
}

export async function endCallsForAccountSwitch(reason: string, deps: AccountSwitchCallDeps): Promise<void> {
  const closed = closeAllCallsFromMain();
  if (closed.length === 0) return;
  try {
    deps.closeOverlay();
  } catch {
    /* the overlay is cosmetic */
  }
  const writes: Promise<void>[] = [];
  for (const { characterId, connectedMs } of closed) {
    try {
      deps.setVoiceCall(characterId, false);
    } catch {
      /* no bot for this character */
    }
    // Never connected: no row and no event, the renderer's own rule.
    if (connectedMs === null || connectedMs <= 0) continue;
    deps.capture('voice_call_ended', { character_id: characterId, duration_ms: connectedMs, reason });
    writes.push(
      trackScopedWrite(deps.emitCallSession(characterId, connectedMs)).catch((err) => {
        console.warn(`[sei] account switch: call row for ${characterId} failed: ${(err as Error).message}`);
      }),
    );
  }
  await Promise.all(writes);
}
