/**
 * SeiLink desktop host, main side: what the room host page may learn about
 * her looks (261104).
 *
 * - hostPortrait: her portrait_image as a URL the host page can load. A
 *   portrait stored on disk is served by the host's own sei-room:// handler
 *   (the host has no sei-portrait:// scheme and no profile paths).
 * - answerHostAvatarCall: the avatar bridge calls RoomAvatar's views make
 *   (SEILINK_HOST_AVATAR_METHODS), for the moved-in character ONLY. Files
 *   are named, not sent; the host reads them (avatarRelay.ts).
 */
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SeilinkHostAvatarMethod } from '../../../shared/seilinkHost';
import { SEILINK_PORTRAIT_HOST } from '../../../shared/seilinkHost';
import { SEILINK_ROOM_SCHEME } from '../../../shared/seilinkPack';

/** portraitProtocol.ts serves exactly these bare refs. */
const BARE_PORTRAIT_RE = /^[0-9a-z_-]+\.png$/i;
const URL_RE = /^(?:https?|data):/i;

export interface HostPortrait {
  url: string | null;
  /** The realpath the host may serve for `url`, when it is a sei-room://_portrait URL. */
  file: string | null;
}

export async function hostPortrait(ref: string | null | undefined, portraitPath: (uuid: string) => string): Promise<HostPortrait> {
  if (!ref) return { url: null, file: null };
  if (URL_RE.test(ref)) return { url: ref, file: null };
  // Bundled defaults ('./img/sui.png') resolve against the host page like the app's.
  if (ref.includes('/')) return { url: ref, file: null };
  if (!BARE_PORTRAIT_RE.test(ref)) return { url: null, file: null };
  try {
    const file = await realpath(portraitPath(ref.replace(/\.png$/i, '')));
    const s = await stat(file);
    if (!s.isFile()) return { url: null, file: null };
    // The bytes change in place on a new portrait: the mtime keeps the host's cache honest.
    const name = encodeURIComponent(path.basename(file));
    return { url: `${SEILINK_ROOM_SCHEME}://${SEILINK_PORTRAIT_HOST}/${name}?v=${Math.round(s.mtimeMs)}`, file };
  } catch {
    return { url: null, file: null };
  }
}

/** What answering needs, injected so the rules are testable without stores. */
export interface HostAvatarStores {
  avatarManifest(characterId: string): Promise<unknown>;
  avatarFiles(characterId: string): Promise<Array<{ path: string; file: string }>>;
  /** Her face set's pack id, or null (dev flag off, no pack). */
  facepackFor(characterId: string): Promise<string | null>;
  facepackManifest(packId: string): Promise<unknown>;
  facepackFilePath(packId: string, rel: string): Promise<string | null>;
}

/**
 * Answer one call for the moved-in character `characterId`. Anything about
 * another character, or another face set than hers, is null (or [] for
 * files), as if she had none.
 */
export async function answerHostAvatarCall(
  characterId: string,
  method: SeilinkHostAvatarMethod,
  args: unknown[],
  stores: HostAvatarStores,
): Promise<unknown> {
  const [a, b] = args;
  switch (method) {
    case 'avatarGet':
      return a === characterId ? ((await stores.avatarManifest(characterId)) ?? null) : null;
    case 'avatarModelFiles':
      return a === characterId ? stores.avatarFiles(characterId) : [];
    case 'facepackForCharacter':
      return a === characterId ? stores.facepackFor(characterId) : null;
    case 'facepackManifest': {
      if (typeof a !== 'string' || a !== (await stores.facepackFor(characterId))) return null;
      return (await stores.facepackManifest(a)) ?? null;
    }
    case 'facepackFile': {
      if (typeof a !== 'string' || typeof b !== 'string' || a !== (await stores.facepackFor(characterId))) return null;
      const file = await stores.facepackFilePath(a, b);
      return file ? { file } : null;
    }
  }
  return null;
}
