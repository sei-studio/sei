/**
 * JWT delivery from main process to utilityProcess.
 *
 * Subscribes to Supabase auth events; on SIGNED_IN / TOKEN_REFRESHED /
 * INITIAL_SESSION / USER_UPDATED pushes the current access_token (JWT) to the
 * bot supervisor, which forwards to the running utilityProcess (if any) over
 * MessagePortMain. On SIGNED_OUT pushes null.
 *
 * Phase 10 wires this. Phase 13's proxy is the JWT consumer (the bot will
 * use it as a Bearer header when cloud-AI mode is selected). In Phase 10
 * the bot loop ignores the {type:'jwt'} message — that's expected; the
 * wiring is verified in plan 06's checkpoint.
 *
 * SECURITY (T-10-06-01): only `session.access_token` crosses to utilityProcess.
 * The refresh credential never leaves main — it stays in sessionStore.bin
 * behind safeStorage. The plan's verification gate greps the snake-case
 * Supabase field name (refresh- + -token, joined) against this file and
 * expects 0 matches.
 *
 * Sources:
 *   - 10-CONTEXT Claude's discretion (JWT-only crosses to utilityProcess)
 *   - 10-RESEARCH §Pitfall A4 (push on TOKEN_REFRESHED to avoid stale-JWT bot stop)
 */
import { getClient } from './supabaseClient';
import type { BotSupervisor } from '../botSupervisor';

let supervisorRef: BotSupervisor | null = null;
let subscription: { unsubscribe: () => void } | null = null;

export async function initJwtBridge(supervisor: BotSupervisor): Promise<void> {
  // BL-02: bootstrap() can run more than once on macOS (app.on('activate')
  // re-entry). Drop the prior subscription before re-binding so we don't
  // accumulate auth-event subscribers (each of which would re-fire
  // supervisor.updateJwt on every event) on each reopen.
  subscription?.unsubscribe();
  subscription = null;
  supervisorRef = supervisor;
  const supabase = getClient();

  // Push the initial token immediately so supervisor.updateJwt has a value
  // before the first summon. getSession() reads from the storage adapter
  // (sessionStore) which was wired by bootstrap before getClient() was first
  // invoked.
  const { data } = await supabase.auth.getSession();
  const initialAccessToken: string | null = data?.session?.access_token ?? null;
  supervisor.updateJwt(initialAccessToken);

  // Pitfall A4: TOKEN_REFRESHED fires whenever Supabase rotates the JWT
  // (~5 min before expiry; default JWT lifetime 1h). Without forwarding
  // here, a long-running bot would carry a stale JWT until the next sign-in.
  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    if (!supervisorRef) return;
    switch (event) {
      case 'SIGNED_IN':
      case 'TOKEN_REFRESHED':
      case 'INITIAL_SESSION':
      case 'USER_UPDATED':
        supervisorRef.updateJwt(session?.access_token ?? null);
        break;
      case 'SIGNED_OUT':
        supervisorRef.updateJwt(null);
        break;
      case 'PASSWORD_RECOVERY':
        // No-op in Phase 10 (no recovery flow shipped).
        break;
    }
  });
  subscription = sub.subscription;
}

/** TEST-ONLY: directly invoke the push path without going through Supabase. */
export function pushJwtToUtility(jwt: string | null): void {
  supervisorRef?.updateJwt(jwt);
}

/** TEST-ONLY: reset for clean test isolation. */
export function _disposeForTests(): void {
  subscription?.unsubscribe();
  subscription = null;
  supervisorRef = null;
}
