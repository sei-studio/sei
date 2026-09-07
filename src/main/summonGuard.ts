/**
 * Auto-retry guard for summon pre-gate refusals (260828).
 *
 * Production analytics caught a retry loop: one user generated 56
 * `summon_failed` events with error_class PREFERRED_NAME_MISSING in 13 minutes
 * (one every ~14 seconds), plus 8 LOCAL_NO_API_KEY the same way. A pre-gate
 * refusal (missing name, missing API key, depleted credits, LAN closed at the
 * gate) is deterministic: nothing the app does on its own can make the next
 * attempt succeed, so every AUTOMATIC re-attempt — the chat-surface launch()
 * tool, the voice idle-nudge and companion-turn launch honors — just burns an
 * LLM round trip and another analytics event.
 *
 * This module remembers the last pre-gate refusal per character and lets the
 * automatic summon paths refuse to re-fire until either:
 *   - the USER acts (the renderer Summon button clears the block via the
 *     bot:summon IPC handler — manual retries are never blocked), or
 *   - a summon succeeds (index.ts clears on the 'online' status), or
 *   - the block ages out (AUTO_RETRY_BLOCK_MS) — the safety net for a user who
 *     fixes the underlying condition (re-runs onboarding, adds a key) without
 *     ever pressing Summon.
 *
 * Deliberately pure (no electron imports) so it is unit-testable under plain
 * vitest — same stance as diagnostics.ts.
 */

/** How long an automatic re-attempt stays blocked after a pre-gate refusal. */
export const AUTO_RETRY_BLOCK_MS = 5 * 60_000;

interface PreGateFailure {
  errorClass: string;
  at: number;
}

const lastPreGate = new Map<string, PreGateFailure>();

/**
 * Record a pre-gate refusal. Called from the onSummonFailure diagnostics wire
 * (index.ts), which the supervisor's once-per-attempt reporter guarantees fires
 * exactly once per attempt with the authoritative phase + class.
 */
export function notePreGateFailure(
  characterId: string,
  errorClass: string,
  now: number = Date.now(),
): void {
  lastPreGate.set(characterId, { errorClass, at: now });
}

/**
 * Clear the block — the user acted (pressed Summon) or a summon succeeded.
 */
export function clearSummonBlock(characterId: string): void {
  lastPreGate.delete(characterId);
}

/**
 * Should an AUTOMATIC summon for this character be refused right now?
 * Returns the blocking error class, or null when the attempt may proceed.
 */
export function blockedAutoSummon(
  characterId: string,
  now: number = Date.now(),
): string | null {
  const rec = lastPreGate.get(characterId);
  if (!rec) return null;
  if (now - rec.at >= AUTO_RETRY_BLOCK_MS) {
    lastPreGate.delete(characterId);
    return null;
  }
  return rec.errorClass;
}

/** Test seam: drop all state. */
export function resetSummonGuardForTest(): void {
  lastPreGate.clear();
}
