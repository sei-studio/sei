/**
 * T283: is the active profile set up, when its config has no name?
 *
 * Onboarding is keyed on `preferred_name`. A config recovered to defaults
 * after damage has no name, which used to read as a fresh install and send
 * the player back through onboarding. Main knows better
 * (`config:profile-state`): a recovered config, quarantined copies, a backup
 * with a name, chat transcripts or memories all mean the profile was set up,
 * and for an account it reads the name back from the cloud profile.
 *
 * Every caller that routes a nameless profile to onboarding asks this first.
 * A failed or missing bridge answers "not set up", the old behaviour.
 */
import { sei } from './ipcClient';

export interface ProfileSetUp {
  /** The profile was set up before (never onboard it). */
  setUp: boolean;
  /** The name to use: the config's, or the one main read back ('' when none). */
  name: string;
}

export async function profileSetUp(configName: string | null | undefined): Promise<ProfileSetUp> {
  const name = (configName ?? '').trim();
  if (name) return { setUp: true, name };
  try {
    const st = await sei.configProfileState?.();
    if (!st) return { setUp: false, name: '' };
    return { setUp: st.returning === true, name: (st.preferredName ?? '').trim() };
  } catch {
    return { setUp: false, name: '' };
  }
}
