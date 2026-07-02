/**
 * User profile picture persistence. Reuses the character portrait pipeline
 * verbatim (validate → atomic write → file lock) but keys a fixed `_user` slot
 * under the same per-profile portraits dir, so it is served by the existing
 * `sei-portrait://local/_user.png` protocol with no new plumbing. The path ref
 * is stored in UserConfig.profile_picture. Used as the player's avatar in chat.
 */
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { validatePortrait } from './portraitImageUtil';
import { loadConfig, saveConfig } from './configStore';
import type { UserProfile } from '../shared/ipc';

const USER_SLOT = '_user';

export async function getUserProfile(): Promise<UserProfile> {
  const cfg = await loadConfig();
  return {
    profilePicture: cfg.profile_picture ?? null,
    preferredName: cfg.preferred_name ?? '',
  };
}

export async function applyUserProfilePicture(bytes: Buffer): Promise<string> {
  // Defense-in-depth re-validate at the main-process trust boundary.
  validatePortrait(bytes);
  const target = paths.portraitPath(USER_SLOT);
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, bytes);
  });
  const ref = `${USER_SLOT}.png`;
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, profile_picture: ref });
  return ref;
}

export async function removeUserProfilePicture(): Promise<void> {
  try {
    await unlink(paths.portraitPath(USER_SLOT));
  } catch {
    /* swallow ENOENT — best-effort */
  }
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, profile_picture: null });
}
