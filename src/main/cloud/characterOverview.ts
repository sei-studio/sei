/**
 * characterOverview — the cloud facts behind a profile's Overview (product
 * call 261110: someone else's companion opens on an Overview, not on
 * settings rows).
 *
 *   - creatorName: the author's public display name (profiles.preferred_name,
 *     the same read that makes World cards say "by <name>"). Null for your
 *     own companions, built-ins (the renderer says "by Sei") and authors with
 *     no name.
 *   - addCount: how many accounts have it in their library (the World
 *     card's number, `character_library_counts`). Null when unknown, and
 *     not read at all while the counts are hidden (shared/addCounts.ts).
 *   - stardewLook: a Stardew Valley farmer look exists for it, on this
 *     device or shared through the cloud (character_game_profiles).
 *
 *   - sampleVoiceId: the curated-pool voice a sample of it plays (its
 *     assigned voice, the stand-in for someone else's own voice, or the
 *     deterministic fallback), so the renderer can play the bundled clip
 *     with no TTS call. Null for "no voice" and for an own ElevenLabs voice
 *     you may hear (that one is synthesized through voicePreview).
 *
 * Never throws: every part is best-effort and an unknown reads as null /
 * false, so the Overview just leaves that line out.
 */

import type { Character, UserConfig } from '../../shared/characterSchema';
import type { CharacterOverviewInfo } from '../../shared/ipc';
import type { GameProfileRead } from './gameProfileClient';

export interface OverviewDeps {
  getCharacter: (id: string) => Promise<Character | null>;
  loadConfig: () => Promise<UserConfig | null>;
  currentUserId: () => string | null;
  profileNames: (ids: string[]) => Promise<Map<string, string>>;
  /** Omitted (null) while the counts are hidden (shared/addCounts.ts): no read, addCount null. */
  addCounts: ((ids: string[]) => Promise<Map<string, number> | null>) | null;
  readStardewProfile: (id: string) => Promise<GameProfileRead>;
  hasLocalStardewLook: (cfg: UserConfig | null, id: string) => boolean;
  /** The pool voice a sample plays, or null (see sampleVoiceId above). */
  sampleVoiceId: (c: Character) => string | null;
}

const NONE: CharacterOverviewInfo = { creatorName: null, addCount: null, stardewLook: false, sampleVoiceId: null };

async function settle<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export async function characterOverviewInfo(id: string, deps: OverviewDeps): Promise<CharacterOverviewInfo> {
  const character = await settle(deps.getCharacter(id), null);
  if (!character) return NONE;
  const owner = character.owner ?? null;
  const foreignAuthor = !character.is_default && owner !== null && owner !== deps.currentUserId();
  const [names, counts, cloudLook, cfg] = await Promise.all([
    foreignAuthor ? settle(deps.profileNames([owner]), new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
    deps.addCounts ? settle(deps.addCounts([id]), null) : Promise.resolve(null),
    settle(deps.readStardewProfile(id), { ok: false, reason: 'error' } as GameProfileRead),
    settle(deps.loadConfig(), null),
  ]);
  const cloudHasLook = cloudLook.ok && cloudLook.profile !== null;
  return {
    creatorName: foreignAuthor && owner ? (names.get(owner) ?? null) : null,
    addCount: counts?.get(id) ?? null,
    stardewLook: cloudHasLook || deps.hasLocalStardewLook(cfg, id),
    sampleVoiceId: sampleOf(deps, character),
  };
}

function sampleOf(deps: OverviewDeps, character: Character): string | null {
  try {
    return deps.sampleVoiceId(character);
  } catch {
    return null;
  }
}
