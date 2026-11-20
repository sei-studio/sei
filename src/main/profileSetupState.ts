/**
 * Has the active profile been set up before? (T283)
 *
 * Onboarding is keyed on `preferred_name`. A config recovered to defaults
 * (main file and backup both unreadable, nothing left to read back) has no
 * name, and the renderer used to read that as a fresh install and send a
 * player who has companions, chats and maybe an account back through
 * onboarding. The renderer now asks this before it does:
 *
 *   - a name in the config: set up (the normal case, no disk scan);
 *   - no name, but the profile shows earlier setup (configShowsPriorSetup):
 *     set up. For an account profile the name is read back from the cloud
 *     profile first (bounded, best effort), the same backfill a sign-in does;
 *   - neither: a fresh install, or an onboarding left half way.
 *
 * Never throws: a failure reads as "no evidence", which is the old behaviour.
 */
import type { ProfileSetupState } from '../shared/ipc';
import { configShowsPriorSetup, loadConfig, updateConfig } from './configStore';
import { getActiveScope, SCOPE_LOCAL } from './paths';

/** How long the cloud name read may hold the boot route. */
export const CLOUD_NAME_TIMEOUT_MS = 5000;

/** What the cloud read answers: whose session it used, and that user's name. */
export interface CloudName {
  userId: string;
  name: string | null;
}

export interface ProfileSetupDeps {
  /** Reads the session user's cloud profile name; `expectedUserId` is the profile's account. */
  fetchCloudName?: (expectedUserId: string) => Promise<CloudName | null>;
  timeoutMs?: number;
}

async function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultFetchCloudName(expectedUserId: string): Promise<CloudName | null> {
  const { fetchMyProfile } = await import('./cloud/cloudCharacterClient');
  return await fetchMyProfile(expectedUserId);
}

export async function readProfileSetupState(deps: ProfileSetupDeps = {}): Promise<ProfileSetupState> {
  const scope = getActiveScope();
  try {
    const cfg = await loadConfig();
    const name = (cfg.preferred_name ?? '').trim();
    if (name) return { returning: true, preferredName: name };
    if (!(await configShowsPriorSetup({ scope }))) return { returning: false, preferredName: '' };
    if (scope === SCOPE_LOCAL) return { returning: true, preferredName: '' };
    const cloud = await bounded(
      (deps.fetchCloudName ?? defaultFetchCloudName)(scope),
      deps.timeoutMs ?? CLOUD_NAME_TIMEOUT_MS,
      null,
    );
    // The name is the auth SESSION user's, and the session can belong to a
    // different account than this profile for a while (261029): never write
    // another account's name here.
    if (cloud && cloud.userId !== scope) {
      console.warn('[sei] cloud profile name is for another account; not saved');
      return { returning: true, preferredName: '' };
    }
    const cloudName = cloud?.name?.trim();
    if (!cloudName || getActiveScope() !== scope) return { returning: true, preferredName: '' };
    const next = await updateConfig(
      (cur) => ((cur.preferred_name ?? '').trim() ? cur : { ...cur, preferred_name: cloudName }),
      { scope },
    );
    console.warn('[sei] config had no name after a recovery; read it back from the cloud profile');
    return { returning: true, preferredName: (next.preferred_name ?? '').trim() };
  } catch (err) {
    console.warn(`[sei] profile setup check failed: ${(err as Error).name}`);
    return { returning: false, preferredName: '' };
  }
}
