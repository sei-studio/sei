/**
 * Runtime profile-scope switching (260603 per-profile partitioning).
 *
 * The active profile scope (`paths.getActiveScope()`) decides which
 * `<userData>/profiles/<scope>/…` bucket every per-account store reads/writes.
 * At boot it is set from the persisted session (src/main/index.ts). This module
 * re-points it when auth state changes AT RUNTIME — sign-in, sign-out, or
 * swapping accounts — and drives the "start fresh like a new install" behavior:
 *
 *   1. Tear down the active bot (it holds the OLD scope's character + memory).
 *   2. Re-point the data scope at the new account's bucket.
 *   3. Initialize a brand-new profile (mkdir + seed the bundled default
 *      characters, idempotent per-profile) so a fresh account looks like a
 *      fresh install rather than an empty void.
 *   4. Push `app:scope-changed` so the renderer re-bootstraps (reload config +
 *      characters, route to onboarding when the new profile has no
 *      mc_username, else home).
 *
 * Wired by the Supabase auth-event subscription in src/main/auth/authState.ts.
 */
import type { BrowserWindow } from 'electron';
import { mkdir } from 'node:fs/promises';
import { paths, setActiveScope, getActiveScope, SCOPE_LOCAL } from '../paths';
import { IpcChannel, type ScopeChangedEvent } from '../../shared/ipc';
import type { BotSupervisorType } from '../botSupervisor';

let supervisorRef: BotSupervisorType | null = null;
let getMainWindowRef: () => BrowserWindow | null = () => null;

export function initProfileScope(deps: {
  supervisor: BotSupervisorType;
  getMainWindow: () => BrowserWindow | null;
}): void {
  supervisorRef = deps.supervisor;
  getMainWindowRef = deps.getMainWindow;
}

/** mkdir the active profile + seed bundled defaults (idempotent per-profile). */
async function ensureProfileInitialized(): Promise<void> {
  await mkdir(paths.profileRoot(), { recursive: true });
  try {
    const { seedDefaultCharacters } = await import('../defaultCharacters');
    await seedDefaultCharacters();
  } catch (err) {
    console.warn(`[sei] profileScope: seed defaults failed: ${(err as Error).message}`);
  }
}

/**
 * Switch the active profile scope to match the signed-in user (or `'local'`
 * when signed out). No-op when the scope is unchanged (token refresh, the
 * INITIAL_SESSION replay at boot — boot already set + seeded the scope).
 */
export async function switchScopeForAuth(userId: string | null): Promise<void> {
  const prevScope = getActiveScope();
  const nextScope = userId ?? SCOPE_LOCAL;
  if (prevScope === nextScope) return;

  const reason: ScopeChangedEvent['reason'] =
    prevScope === SCOPE_LOCAL ? 'sign-in' : nextScope === SCOPE_LOCAL ? 'sign-out' : 'switch';

  // 1. Tear down the active bot before the scope moves out from under it. On
  //    sign-out authHandlers already stopped it (D-09); stop() is a no-op when
  //    nothing is active.
  if (supervisorRef) {
    try { await supervisorRef.stop(); }
    catch (err) { console.warn(`[sei] profileScope: bot stop failed: ${(err as Error).message}`); }
  }

  // 2. Re-point every profile-scoped path at the new account's bucket.
  setActiveScope(nextScope);
  console.log(`[sei] profileScope: ${prevScope} → ${nextScope} (${reason})`);

  // 3. Initialize a brand-new profile (returning accounts / 'local' no-op here).
  await ensureProfileInitialized();

  // 3.5 Cross-device hydration (item 4). On sign-in to an existing account from
  //     a fresh device, the local profile is empty even though the account has
  //     state in the cloud. Pull it down HERE — before the scope-changed push
  //     below — so the renderer's re-bootstrap (reload config + characters) sees
  //     it and doesn't re-prompt onboarding or hide the user's own characters.
  //     Skipped for sign-out (nextScope === local). Best-effort: a network blip
  //     just defers hydration to the normal cache-on-demand path.
  if (nextScope !== SCOPE_LOCAL) {
    // (a) Display name: backfill local config from public.profiles when this
    //     device has no name yet, so onboarding doesn't re-ask for a name the
    //     account already set elsewhere.
    try {
      const { loadConfig, saveConfig } = await import('../configStore');
      const cfg = await loadConfig();
      if (!(cfg.preferred_name ?? '').trim()) {
        const { fetchMyProfileName } = await import('../cloud/cloudCharacterClient');
        const cloudName = await fetchMyProfileName();
        if (cloudName) await saveConfig({ ...cfg, preferred_name: cloudName });
      }
    } catch (err) {
      console.warn(`[sei] profileScope: cloud name backfill failed: ${(err as Error).message}`);
    }
    // (b) Own characters: eagerly cache the account's cloud characters into the
    //     local library so they appear in the IconRail immediately (not only
    //     after being opened from the World/Summons list).
    try {
      const { cacheMyCloudCharacters } = await import('../cloud/cacheOnDemand');
      await cacheMyCloudCharacters(nextScope);
    } catch (err) {
      console.warn(`[sei] profileScope: own-character hydration failed: ${(err as Error).message}`);
    }
  }

  // 4. Tell the renderer to re-bootstrap onto the new profile.
  const win = getMainWindowRef();
  if (win && !win.isDestroyed()) {
    const payload: ScopeChangedEvent = { scope: nextScope, reason };
    win.webContents.send(IpcChannel.app.scopeChanged, payload);
  }
}

/** TEST-ONLY: clear the injected supervisor / window refs. */
export function _resetForTests(): void {
  supervisorRef = null;
  getMainWindowRef = () => null;
}
