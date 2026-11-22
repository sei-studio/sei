/**
 * 261013 (T111): fill card {{user}} / {{char}} placeholders in a character's
 * persona text for the background prompts that only get the raw text (the
 * summary fold, chat memory compaction). Cards without placeholders return
 * unchanged with no lookups, so the hot path stays free. The live surfaces
 * fill through renderPersona (buildSystemBlocks) instead.
 */
import { fillPersonaPlaceholders, hasPersonaPlaceholders } from '../../bot/brain/personaPlaceholders.js';

export async function resolvePersonaText(characterId: string, text: string): Promise<string>;
export async function resolvePersonaText(characterId: string, text: string | undefined): Promise<string | undefined>;
export async function resolvePersonaText(
  characterId: string,
  text: string | undefined,
): Promise<string | undefined> {
  if (!text || !hasPersonaPlaceholders(text)) return text;
  let charName = '';
  let userName = '';
  try {
    // Dynamic imports keep this module free of the store graph (continuity and
    // memoryCompaction are imported by botSupervisor).
    const [{ getCharacter }, { loadConfig }] = await Promise.all([
      import('../characterStore'),
      import('../configStore'),
    ]);
    const [character, config] = await Promise.all([
      getCharacter(characterId).catch(() => null),
      loadConfig().catch(() => null),
    ]);
    charName = character?.name ?? '';
    userName = config?.preferred_name ?? '';
  } catch {
    /* fall back to the generic phrases */
  }
  return fillPersonaPlaceholders(text, { charName, userName });
}




