/**
 * A character's own Fish Audio voice (261103). The user pastes a fish.audio
 * voice link or id in the character's voice controls; main checks it with
 * the user's key (GET /model/{id}) and stores `{id, name}` SPARSELY in
 * `UserConfig.fish_voice_overrides[characterId]` (main-owned: the renderer
 * cannot write it directly). Not in character.metadata, which cloud-syncs
 * verbatim and is not editable on a default character.
 */
import { getActiveScope } from '../paths';
import { updateConfig } from '../configStore';
import { parseFishVoiceRef, type FishOverrideResult } from '../../shared/fishVoices';
import { resolveFishKey } from './fishKeyStore';
import { fetchFishVoice, fishFailureReason } from './fishTts';

export async function setFishVoiceOverride(characterId: string, input: string | null): Promise<FishOverrideResult> {
  // The scope this call started in: the lookup awaits the network, and an
  // account switch in that gap must not land the write in the next account.
  const scope = getActiveScope();
  if (input === null || !input.trim()) {
    await updateConfig((cfg) => {
      const current = cfg.fish_voice_overrides;
      if (!current || !(characterId in current)) return cfg;
      const { [characterId]: _gone, ...rest } = current;
      return { ...cfg, fish_voice_overrides: Object.keys(rest).length ? rest : undefined };
    }, { scope });
    return { ok: true, voice: null };
  }
  const id = parseFishVoiceRef(input);
  if (!id) return { ok: false, reason: 'invalid-link' };
  const key = await resolveFishKey();
  if (!key) return { ok: false, reason: 'no-key' };
  let voice: { id: string; name: string };
  try {
    voice = await fetchFishVoice(key, id);
  } catch (err) {
    return { ok: false, reason: fishFailureReason(err) ?? 'failed' };
  }
  await updateConfig(
    (cfg) => ({
      ...cfg,
      fish_voice_overrides: { ...(cfg.fish_voice_overrides ?? {}), [characterId]: { id: voice.id, name: voice.name } },
    }),
    { scope },
  );
  return { ok: true, voice };
}
